/**
 * @fileoverview Validates plugin instance configuration against its JSON Schema.
 *
 * Uses Ajv to validate `configJson` values against the `instanceConfigSchema`
 * declared in a plugin's manifest. This ensures that invalid configuration is
 * rejected at the API boundary, not discovered later at worker startup.
 *
 * @module apps/server/services/plugin-config-validator
 */

import { createRequire } from "node:module";
import { Ajv, type ErrorObject } from "ajv";
import type { FormatsPlugin } from "ajv-formats";
import type { JsonSchema } from "@paperclipai/shared";

const addFormats: FormatsPlugin = createRequire(import.meta.url)("ajv-formats");

interface ConfigValidationResult {
  valid: boolean;
  errors?: { field: string; message: string }[];
}

function compileJsonSchema(schema: JsonSchema) {
  const ajv = new Ajv({ allErrors: true });
  addFormats(ajv);
  // Environment and runtime tool schemas may use Paperclip's secret-ref format.
  // Plugin instance schemas reject it during manifest validation.
  ajv.addFormat("secret-ref", { validate: () => true });
  return ajv.compile(schema);
}

/** Fail immediately when a manifest-declared input schema cannot be compiled. */
export function assertJsonSchemaCompiles(schema: JsonSchema): void {
  compileJsonSchema(schema);
}

/** Validate one JSON value against a manifest-admitted JSON Schema. */
export function validateJsonSchemaValue(
  value: unknown,
  schema: JsonSchema,
): ConfigValidationResult {
  const validate = compileJsonSchema(schema);
  const valid = validate(value);

  if (valid) {
    return { valid: true };
  }

  const errors = (validate.errors ?? []).map((err: ErrorObject) => ({
    field: err.instancePath || "/",
    message: err.message ?? "validation failed",
  }));

  return { valid: false, errors };
}

/** Validate instance config against the manifest's sole configuration schema. */
export function validatePluginInstanceConfig(
  configJson: Record<string, unknown>,
  schema: JsonSchema | undefined,
): ConfigValidationResult {
  if (!schema || Object.keys(schema).length === 0) {
    return { valid: true };
  }
  return validateJsonSchemaValue(configJson, schema);
}
