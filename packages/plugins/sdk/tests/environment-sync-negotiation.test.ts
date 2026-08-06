import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  definePlugin as defineSdkPlugin,
  type PluginDefinition,
} from "../src/define-plugin.js";
import {
  createRequest,
  isJsonRpcResponse,
  parseMessage,
  PLUGIN_RPC_ERROR_CODES,
  serializeMessage,
  type InitializeParams,
  type JsonRpcResponse,
  type PluginEnvironmentSyncParams,
  type PluginEnvironmentSyncResult,
} from "../src/protocol.js";
import { startWorkerRpcHost } from "../src/worker-rpc-host.js";
import type {
  PluginBeforePromptInput,
  PluginBeforePromptResult,
} from "../src/types.js";

function definePlugin(definition: Omit<PluginDefinition, "onHealth">) {
  return defineSdkPlugin({
    ...definition,
    async onHealth() {
      return { status: "ok" };
    },
  });
}

const MANIFEST = {
  id: "paperclip.sync-negotiation-test",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Sync Negotiation Test",
  description: "Test plugin",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: ["environment.drivers.register"],
  entrypoints: { worker: "dist/worker.js" },
} as const;

const INITIALIZE_PARAMS: InitializeParams = {
  manifest: MANIFEST,
  instanceInfo: { instanceId: "test", hostVersion: "0.0.0" },
  apiVersion: 1,
  databaseNamespace: null,
};

function startTestWorker(plugin: ReturnType<typeof definePlugin>) {
  const hostToWorker = new PassThrough();
  const workerToHost = new PassThrough();
  const hostReadline = createInterface({ input: workerToHost });
  const pending = new Map<string, (response: JsonRpcResponse) => void>();
  let nextRequestId = 1;

  hostReadline.on("line", (line) => {
    const message = parseMessage(line);
    if (!isJsonRpcResponse(message)) return;
    pending.get(String(message.id))?.(message);
    pending.delete(String(message.id));
  });

  const worker = startWorkerRpcHost({ plugin, stdin: hostToWorker, stdout: workerToHost });

  function callWorker<T = unknown>(method: string, params: unknown): Promise<T> {
    const id = `host-${nextRequestId++}`;
    const result = new Promise<T>((resolve, reject) => {
      pending.set(id, (response) => {
        if ("error" in response && response.error) {
          reject(Object.assign(new Error(response.error.message), { code: response.error.code }));
          return;
        }
        resolve((response as { result?: T }).result as T);
      });
    });
    hostToWorker.write(serializeMessage(createRequest(method, params, id)));
    return result;
  }

  function stop() {
    worker.stop();
    hostReadline.close();
    hostToWorker.destroy();
    workerToHost.destroy();
  }

  return { callWorker, stop };
}

describe("environment sync verb negotiation", () => {
  it("advertises environmentSyncIn/environmentSyncOut only when the hooks are defined", async () => {
    const withHooks = startTestWorker(
      definePlugin({
        async setup() {},
        async onEnvironmentSyncIn(): Promise<PluginEnvironmentSyncResult> {
          return { operations: [] };
        },
        async onEnvironmentSyncOut(): Promise<PluginEnvironmentSyncResult> {
          return { operations: [] };
        },
      }),
    );
    try {
      const result = await withHooks.callWorker<{ supportedMethods: string[] }>(
        "initialize",
        INITIALIZE_PARAMS,
      );
      expect(result.supportedMethods).toContain("environmentSyncIn");
      expect(result.supportedMethods).toContain("environmentSyncOut");
    } finally {
      withHooks.stop();
    }

    const withoutHooks = startTestWorker(definePlugin({ async setup() {} }));
    try {
      const result = await withoutHooks.callWorker<{ supportedMethods: string[] }>(
        "initialize",
        INITIALIZE_PARAMS,
      );
      expect(result.supportedMethods).not.toContain("environmentSyncIn");
      expect(result.supportedMethods).not.toContain("environmentSyncOut");
    } finally {
      withoutHooks.stop();
    }
  });

  it("routes environmentSyncIn/environmentSyncOut to the hooks when defined", async () => {
    const seen: string[] = [];
    const worker = startTestWorker(
      definePlugin({
        async setup() {},
        async onEnvironmentSyncIn(params): Promise<PluginEnvironmentSyncResult> {
          seen.push("in");
          return {
            operations: params.operations.map((op) => ({
              operationId: op.operationId,
              filesTransferred: op.files.length,
              bytesTransferred: 0,
            })),
          };
        },
        async onEnvironmentSyncOut(params): Promise<PluginEnvironmentSyncResult> {
          seen.push("out");
          return {
            operations: params.operations.map((op) => ({
              operationId: op.operationId,
              filesTransferred: op.files.length,
              bytesTransferred: 0,
            })),
          };
        },
      }),
    );
    try {
      await worker.callWorker("initialize", INITIALIZE_PARAMS);
      const baseParams = {
        driverKey: "sandbox",
        companyId: "company",
        environmentId: "env",
        config: {},
        lease: { providerLeaseId: "lease-1" },
      };
      const inParams: PluginEnvironmentSyncParams = {
        ...baseParams,
        operations: [
          { operationId: "op-a", files: [{ sourcePath: "/host/a", targetPath: "/remote/a", kind: "file" }] },
        ],
      };
      const inResult = await worker.callWorker<PluginEnvironmentSyncResult>("environmentSyncIn", inParams);
      expect(inResult.operations[0]).toMatchObject({ operationId: "op-a", filesTransferred: 1 });

      const outParams: PluginEnvironmentSyncParams = {
        ...baseParams,
        operations: [
          { operationId: "op-b", files: [{ sourcePath: "/remote/b", targetPath: "/host/b", kind: "directory" }] },
        ],
      };
      const outResult = await worker.callWorker<PluginEnvironmentSyncResult>("environmentSyncOut", outParams);
      expect(outResult.operations[0]).toMatchObject({ operationId: "op-b", filesTransferred: 1 });
      expect(seen).toEqual(["in", "out"]);
    } finally {
      worker.stop();
    }
  });

  it("throws METHOD_NOT_IMPLEMENTED when the sync hooks are absent", async () => {
    const worker = startTestWorker(definePlugin({ async setup() {} }));
    try {
      await worker.callWorker("initialize", INITIALIZE_PARAMS);
      const params = {
        driverKey: "sandbox",
        companyId: "company",
        environmentId: "env",
        config: {},
        lease: { providerLeaseId: "lease-1" },
        operations: [],
      };
      await expect(worker.callWorker("environmentSyncIn", params)).rejects.toMatchObject({
        code: PLUGIN_RPC_ERROR_CODES.METHOD_NOT_IMPLEMENTED,
      });
      await expect(worker.callWorker("environmentSyncOut", params)).rejects.toMatchObject({
        code: PLUGIN_RPC_ERROR_CODES.METHOD_NOT_IMPLEMENTED,
      });
    } finally {
      worker.stop();
    }
  });
});

describe("before-prompt lifecycle negotiation", () => {
  const input = {
    companyId: "company-a",
    issueId: "issue-a",
    sessionId: "session-a",
    runId: "run-a",
    agentId: "agent-a",
    projectId: null,
    sourceText: "Canonical source",
    promptKind: "base",
    sessionOperation: "new",
    refId: "ref-a",
    refOrdinal: 0,
    segmentOrdinal: 0,
    sourceMessageId: "msg_source",
    sourceMessageSeq: 9,
    contextAccess: {
      carry_context: false,
      read_issue_comments: false,
      read_issue_agent_run: false,
      list_sub_issues: false,
      read_sub_issue_comments: false,
      read_sub_issue_agent_run: false,
      list_company_issues: false,
      read_company_issue_comments: false,
      read_company_issue_agent_run: false,
    },
    snapshotHighWaterSeq: 9,
  } satisfies PluginBeforePromptInput;

  it("advertises and dispatches one exact prompt contribution", async () => {
    const worker = startTestWorker(definePlugin({
      async setup() {},
      async onBeforePrompt() {
        return { prependText: "Plugin prelude" };
      },
    }));
    try {
      const initialized = await worker.callWorker<{
        ok: boolean;
        supportedMethods: string[];
      }>("initialize", INITIALIZE_PARAMS);
      expect(initialized.supportedMethods).toContain("beforePrompt");

      await expect(worker.callWorker<PluginBeforePromptResult>(
        "beforePrompt",
        input,
      )).resolves.toEqual({ prependText: "Plugin prelude" });
    } finally {
      worker.stop();
    }
  });

  it("does not advertise the lifecycle when the hook is absent", async () => {
    const worker = startTestWorker(definePlugin({ async setup() {} }));
    try {
      const initialized = await worker.callWorker<{
        ok: boolean;
        supportedMethods: string[];
      }>("initialize", INITIALIZE_PARAMS);
      expect(initialized.supportedMethods).not.toContain("beforePrompt");
      await expect(worker.callWorker("beforePrompt", input)).rejects.toMatchObject({
        code: PLUGIN_RPC_ERROR_CODES.METHOD_NOT_IMPLEMENTED,
      });
    } finally {
      worker.stop();
    }
  });
});
