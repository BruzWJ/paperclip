import {
  pluginManifestV1Schema,
  type JsonSchema,
  type PaperclipPluginManifestV1,
} from "@paperclipai/shared";
import { badRequest } from "../errors.js";
import { assertJsonSchemaCompiles } from "./plugin-config-validator.js";

interface ManifestValidationDetail {
  path: (string | number)[];
  message: string;
}

function rejectInvalidManifest(details: ManifestValidationDetail[]): never {
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
  ];
}

/** Parse the one manifest contract accepted by this host. */
export function parsePluginManifest(input: unknown): PaperclipPluginManifestV1 {
  const result = pluginManifestV1Schema.safeParse(input);
  if (!result.success) {
    rejectInvalidManifest(result.error.errors.map((detail) => ({
      path: detail.path,
      message: detail.message,
    })));
  }

  const schemaDiagnostics: ManifestValidationDetail[] = [];
  for (const declaration of declaredInputSchemas(result.data)) {
    try {
      assertJsonSchemaCompiles(declaration.schema);
    } catch (error) {
      schemaDiagnostics.push({
        path: declaration.path,
        message: `JSON Schema does not compile: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  if (schemaDiagnostics.length > 0) rejectInvalidManifest(schemaDiagnostics);
  return result.data;
}
