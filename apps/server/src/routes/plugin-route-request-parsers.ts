import {
  pluginBridgeRequestSchema,
  pluginCatalogInstallRequestSchema,
  pluginConfigRequestSchema,
  pluginInstallRequestSchema,
  pluginLocalFolderPathRequestSchema,
  type PaperclipPluginManifestV1,
} from "@paperclipai/shared";
import { badRequest } from "../errors.js";
import { validatePluginInstanceConfig } from "../services/plugin-config-validator.js";

export function parsePluginRequest<T>(
  result:
    | { success: true; data: T }
    | {
        success: false;
        error: {
          errors: Array<{ path: (string | number)[]; message: string }>;
        };
      },
  message: string,
): T {
  if (result.success) return result.data;
  throw badRequest(
    message,
    result.error.errors.map((detail) => ({
      path: detail.path,
      message: detail.message,
    })),
  );
}

export function parsePluginInstallRequest(body: unknown) {
  return parsePluginRequest(pluginInstallRequestSchema.safeParse(body), "Invalid plugin install request");
}

export function parsePluginCatalogInstallRequest(body: unknown) {
  return parsePluginRequest(
    pluginCatalogInstallRequestSchema.safeParse(body),
    "Invalid plugin catalog install request",
  );
}

export function parsePluginBridgeRequest(body: unknown) {
  return parsePluginRequest(pluginBridgeRequestSchema.safeParse(body ?? {}), "Invalid plugin bridge request");
}

export function parseLocalFolderPathInput(body: unknown): { path: string } {
  return parsePluginRequest(
    pluginLocalFolderPathRequestSchema.safeParse(body),
    "Invalid plugin local-folder path request",
  );
}

export type PluginConfigRequestResult =
  | { ok: true; configJson: Record<string, unknown> }
  | {
      ok: false;
      response: {
        error: string;
        fieldErrors?: ReturnType<typeof validatePluginInstanceConfig>["errors"];
      };
    };

export function parsePluginConfigRequest(
  body: unknown,
  schema: PaperclipPluginManifestV1["instanceConfigSchema"],
): PluginConfigRequestResult {
  const parsed = pluginConfigRequestSchema.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      response: {
        error: 'Request must contain exactly one object field: "configJson"',
      },
    };
  }
  const { configJson } = parsed.data;
  const validation = validatePluginInstanceConfig(configJson, schema);
  return validation.valid
    ? { ok: true, configJson }
    : {
        ok: false,
        response: {
          error: "Configuration does not match the plugin's instanceConfigSchema",
          fieldErrors: validation.errors,
        },
      };
}
