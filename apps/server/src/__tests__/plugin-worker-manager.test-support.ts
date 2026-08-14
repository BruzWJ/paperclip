import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import {
  createHostClientHandlers,
  JsonRpcCallError,
  PLUGIN_RPC_ERROR_CODES,
  type HostServices,
  type HostClientHandlers,
  type HostToWorkerMethods,
} from "@paperclipai/plugin-sdk";
import {
  appendStderrExcerpt,
  createPluginWorkerHandle,
  formatWorkerFailureMessage,
} from "../services/plugin-worker-manager.js";
const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
export const DELAYED_WORKER_ENTRYPOINT = path.join(FIXTURES_DIR, "plugin-worker-delayed.cjs");
export const CONFIG_WORKER_ENTRYPOINT = path.join(FIXTURES_DIR, "plugin-worker-config.cjs");
export const INVOCATION_SCOPE_WORKER_ENTRYPOINT = path.join(
  FIXTURES_DIR,
  "plugin-worker-invocation-scope.cjs",
);
export const TERMINATED_WORKER_ENTRYPOINT = path.join(FIXTURES_DIR, "plugin-worker-terminated.cjs");
export const RPC_OPERATION_WORKER_ENTRYPOINT = path.join(FIXTURES_DIR, "plugin-worker-rpc-operation.cjs");
export const LOG_REQUEST_WORKER_ENTRYPOINT = path.join(FIXTURES_DIR, "plugin-worker-log-request.cjs");
export const MALFORMED_OUTPUT_WORKER_ENTRYPOINT = path.join(
  FIXTURES_DIR,
  "plugin-worker-malformed-output.cjs",
);

export const TEST_MANIFEST: PaperclipPluginManifestV1 = {
  id: "test.plugin",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Test plugin",
  description: "Test plugin",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: [],
  entrypoints: { worker: "dist/worker.js" },
};

export const TEST_TOOL = {
  name: "lookup",
  displayName: "Lookup",
  description: "Lookup",
  parametersSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
} as const;

export function completeHostHandlers(overrides: Partial<HostClientHandlers> = {}): HostClientHandlers {
  return {
    ...createHostClientHandlers({
      pluginKey: "test.plugin",
      capabilities: [],
      services: {} as HostServices,
    }),
    ...overrides,
  };
}

type TestWorkerOptions = Parameters<typeof createPluginWorkerHandle>[1];

export function createTestWorker(
  entrypointPath: TestWorkerOptions["entrypointPath"],
  overrides: Partial<TestWorkerOptions> = {},
) {
  return createPluginWorkerHandle("test.plugin", {
    entrypointPath,
    manifest: TEST_MANIFEST,
    instanceInfo: {
      instanceId: "instance-1",
      hostVersion: "1.0.0",
    },
    apiVersion: 1,
    databaseNamespace: null,
    onTerminalCrash: () => undefined,
    hostHandlers: completeHostHandlers(),
    ...overrides,
  });
}

export function configuredWorker(
  manifest: PaperclipPluginManifestV1 = TEST_MANIFEST,
  config: Record<string, unknown> = {},
) {
  return createTestWorker(CONFIG_WORKER_ENTRYPOINT, {
    manifest,
    hostHandlers: completeHostHandlers({
      "config.get": async () => config,
    }),
  });
}

export { path, describe, expect, it, vi, createHostClientHandlers, JsonRpcCallError };
export { PLUGIN_RPC_ERROR_CODES, appendStderrExcerpt };
export { formatWorkerFailureMessage };
export type { PaperclipPluginManifestV1, HostServices, HostToWorkerMethods };
