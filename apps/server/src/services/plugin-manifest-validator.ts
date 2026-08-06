import {
  pluginManifestV1Schema,
  type JsonSchema,
  type PaperclipPluginManifestV1,
} from "@paperclipai/shared";
import { badRequest } from "../errors.js";
import { assertJsonSchemaCompiles } from "./plugin-config-validator.js";

interface ManifestValidationIssue {
  path: (string | number)[];
  message: string;
}

function rejectInvalidManifest(details: ManifestValidationIssue[]): never {
  const summary = details
    .map(({ path, message }) => path.length > 0 ? `${path.join(".")}: ${message}` : message)
    .join("; ");
  throw badRequest(`Invalid plugin manifest: ${summary}`, details);
}

function declaredInputSchemas(manifest: PaperclipPluginManifestV1): Array<{
  path: (string | number)[];
  schema: JsonSchema;
}> {
  return [
    ...(manifest.instanceConfigSchema
      ? [{ path: ["instanceConfigSchema"], schema: manifest.instanceConfigSchema }]
      : []),
    ...(manifest.tools ?? []).map((tool, index) => ({
      path: ["tools", index, "parametersSchema"],
      schema: tool.parametersSchema,
    })),
    ...(manifest.environmentDrivers ?? []).map((driver, index) => ({
      path: ["environmentDrivers", index, "configSchema"],
      schema: driver.configSchema,
    })),
  ];
}

/** Parse the one manifest contract accepted by this host. */
export function parsePluginManifest(input: unknown): PaperclipPluginManifestV1 {
  const result = pluginManifestV1Schema.safeParse(input);
  if (!result.success) {
    rejectInvalidManifest(result.error.errors.map((issue) => ({
      path: issue.path,
      message: issue.message,
    })));
  }

  const schemaIssues: ManifestValidationIssue[] = [];
  for (const declaration of declaredInputSchemas(result.data)) {
    try {
      assertJsonSchemaCompiles(declaration.schema);
    } catch (error) {
      schemaIssues.push({
        path: declaration.path,
        message: `JSON Schema does not compile: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  if (schemaIssues.length > 0) rejectInvalidManifest(schemaIssues);
  return result.data;
}
