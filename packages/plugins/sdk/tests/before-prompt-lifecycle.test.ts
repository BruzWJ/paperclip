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
  id: "paperclip.before-prompt-lifecycle-test",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Before Prompt Lifecycle Test",
  description: "Test plugin",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: ["runtime.prompt.observe"],
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

describe("before-prompt lifecycle negotiation", () => {
  const input = {
    companyId: "company-a",
    taskId: "task-a",
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
      read_task_comments: false,
      read_task_agent_run: false,
      list_sub_tasks: false,
      read_sub_task_comments: false,
      read_sub_task_agent_run: false,
      list_company_tasks: false,
      read_company_task_comments: false,
      read_company_task_agent_run: false,
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
