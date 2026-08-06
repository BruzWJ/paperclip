import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  definePlugin as defineSdkPlugin,
  type PluginDefinition,
} from "../src/define-plugin.js";
import {
  createHostClientHandlers,
  type HostServices,
} from "../src/host-client-factory.js";
import {
  createRequest,
  createErrorResponse,
  createSuccessResponse,
  isJsonRpcRequest,
  isJsonRpcResponse,
  parseMessage,
  JSONRPC_ERROR_CODES,
  PLUGIN_RPC_ERROR_CODES,
  serializeMessage,
  type JsonRpcResponse,
  type PluginInvocationContext,
} from "../src/protocol.js";
import { startWorkerRpcHost } from "../src/worker-rpc-host.js";

function definePlugin(definition: Omit<PluginDefinition, "onHealth">) {
  return defineSdkPlugin({
    ...definition,
    async onHealth() {
      return { status: "ok" };
    },
  });
}

describe("worker RPC transport", () => {
  it("rejects id-less JSON-RPC envelopes", () => {
    expect(() => parseMessage(JSON.stringify({
      jsonrpc: "2.0",
      method: "onEvent",
      params: {},
    }))).toThrow("Message must be a JSON-RPC request or response");
  });

  it("ignores blank input then sends one parse error and stops on malformed host input", async () => {
    const hostToWorker = new PassThrough();
    const workerToHost = new PassThrough();
    const hostReadline = createInterface({ input: workerToHost });
    const outputMessages: JsonRpcResponse[] = [];
    let resolveFirstOutput: ((response: JsonRpcResponse) => void) | null = null;
    const firstOutput = new Promise<JsonRpcResponse>((resolve) => {
      resolveFirstOutput = resolve;
    });
    const worker = startWorkerRpcHost({
      plugin: definePlugin({ async setup() {} }),
      stdin: hostToWorker,
      stdout: workerToHost,
    });

    hostReadline.on("line", (line) => {
      const message = parseMessage(line);
      if (!isJsonRpcResponse(message)) return;
      outputMessages.push(message);
      resolveFirstOutput?.(message);
    });

    try {
      hostToWorker.write("\n");
      await new Promise((resolve) => setImmediate(resolve));
      expect(worker.running).toBe(true);
      expect(outputMessages).toEqual([]);

      hostToWorker.write('{"jsonrpc":"2.0","method":"onEvent","params":{}}\n');
      await expect(firstOutput).resolves.toMatchObject({
        id: null,
        error: {
          code: JSONRPC_ERROR_CODES.PARSE_ERROR,
          message: expect.stringContaining("request or response"),
        },
      });
      expect(worker.running).toBe(false);

      hostToWorker.write("not-json\n");
      await new Promise((resolve) => setImmediate(resolve));
      expect(outputMessages).toHaveLength(1);
    } finally {
      worker.stop();
      hostReadline.close();
      hostToWorker.destroy();
      workerToHost.destroy();
    }
  });

  it("awaits the host acknowledgement for plugin logs", async () => {
    const hostToWorker = new PassThrough();
    const workerToHost = new PassThrough();
    const hostReadline = createInterface({ input: workerToHost });
    let resolveLogRequest: ((request: ReturnType<typeof createRequest>) => void) | null = null;
    const logRequestPromise = new Promise<ReturnType<typeof createRequest>>((resolve) => {
      resolveLogRequest = resolve;
    });
    let initializeSettled = false;

    const plugin = definePlugin({
      async setup(ctx) {
        await ctx.logger.info("Plugin initialized", { phase: "setup" });
      },
    });
    const worker = startWorkerRpcHost({
      plugin,
      stdin: hostToWorker,
      stdout: workerToHost,
    });

    const initializeResponse = new Promise<JsonRpcResponse>((resolve) => {
      hostReadline.on("line", (line) => {
        const message = parseMessage(line);
        if (isJsonRpcResponse(message)) {
          if (message.id === "initialize-1") resolve(message);
          return;
        }
        if (message.method === "log") resolveLogRequest?.(message);
      });
    });

    try {
      hostToWorker.write(serializeMessage(createRequest("initialize", {
        manifest: {
          id: "paperclip.logger-ack-test",
          apiVersion: 1,
          version: "1.0.0",
          displayName: "Logger acknowledgement test",
          description: "Logger acknowledgement test",
          author: "Paperclip",
          categories: ["automation"],
          capabilities: [],
          entrypoints: { worker: "dist/worker.js" },
        },
        instanceInfo: { instanceId: "test", hostVersion: "0.0.0" },
        apiVersion: 1,
        databaseNamespace: null,
      }, "initialize-1")));
      void initializeResponse.then(
        () => {
          initializeSettled = true;
        },
        () => undefined,
      );

      const logRequest = await logRequestPromise;
      expect(logRequest).toMatchObject({
        id: expect.any(Number),
        method: "log",
        params: {
          level: "info",
          message: "Plugin initialized",
          meta: { phase: "setup" },
        },
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(initializeSettled).toBe(false);

      hostToWorker.write(serializeMessage(createSuccessResponse(logRequest.id, null)));
      await expect(initializeResponse).resolves.toMatchObject({
        id: "initialize-1",
        result: { supportedMethods: [] },
      });
    } finally {
      worker.stop();
      hostReadline.close();
      hostToWorker.destroy();
      workerToHost.destroy();
    }
  });

  it("drains accepted work, rejects new intake, then runs shutdown once", async () => {
    const hostToWorker = new PassThrough();
    const workerToHost = new PassThrough();
    const hostReadline = createInterface({ input: workerToHost });
    const pending = new Map<string, (response: JsonRpcResponse) => void>();
    let nextRequestId = 1;
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    let releaseRequest!: () => void;
    const requestGate = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    const order: string[] = [];
    let callHostDuringDrain!: () => Promise<void>;
    const onShutdown = vi.fn(async () => {
      order.push("shutdown");
    });
    const worker = startWorkerRpcHost({
      plugin: definePlugin({
        async setup(ctx) {
          callHostDuringDrain = () => ctx.logger.info("finishing accepted work");
        },
        async onBeforePrompt() {
          order.push("request:start");
          signalStarted();
          await requestGate;
          await callHostDuringDrain();
          order.push("request:end");
          return null;
        },
        onShutdown,
      }),
      stdin: hostToWorker,
      stdout: workerToHost,
    });

    hostReadline.on("line", (line) => {
      const message = parseMessage(line);
      if (isJsonRpcResponse(message)) {
        pending.get(String(message.id))?.(message);
        pending.delete(String(message.id));
        return;
      }
      expect(message.method).toBe("log");
      order.push("host-call");
      hostToWorker.write(serializeMessage(createSuccessResponse(message.id, null)));
    });

    function callWorker(method: string, params: unknown): Promise<unknown> {
      const id = `drain-${nextRequestId++}`;
      const response = new Promise<unknown>((resolve, reject) => {
        pending.set(id, (message) => {
          if ("error" in message && message.error) {
            reject(Object.assign(new Error(message.error.message), {
              code: message.error.code,
            }));
            return;
          }
          resolve((message as { result?: unknown }).result);
        });
      });
      hostToWorker.write(serializeMessage(createRequest(method, params, id)));
      return response;
    }

    try {
      await callWorker("initialize", {
        manifest: {
          id: "paperclip.worker-drain-test",
          apiVersion: 1,
          version: "1.0.0",
          displayName: "Worker drain test",
          description: "Worker drain test",
          author: "Paperclip",
          categories: ["automation"],
          capabilities: ["runtime.prompt.observe"],
          entrypoints: { worker: "dist/worker.js" },
        },
        instanceInfo: { instanceId: "test", hostVersion: "0.0.0" },
        apiVersion: 1,
        databaseNamespace: null,
      });

      const activeRequest = callWorker("beforePrompt", {});
      await started;
      const shutdown = callWorker("shutdown", {});

      await expect(callWorker("health", {})).rejects.toMatchObject({
        code: PLUGIN_RPC_ERROR_CODES.WORKER_UNAVAILABLE,
        message: "Worker RPC host is draining",
      });
      expect(onShutdown).not.toHaveBeenCalled();

      releaseRequest();
      await expect(activeRequest).resolves.toBeNull();
      await expect(shutdown).resolves.toBeNull();
      expect(order).toEqual([
        "request:start",
        "host-call",
        "request:end",
        "shutdown",
      ]);
      expect(onShutdown).toHaveBeenCalledOnce();

      await new Promise((resolve) => setImmediate(resolve));
      expect(worker.running).toBe(false);
    } finally {
      releaseRequest();
      worker.stop();
      hostReadline.close();
      hostToWorker.destroy();
      workerToHost.destroy();
    }
  });
});

describe("worker declaration and handler agreement", () => {
  const declaredTool = {
    name: "inspect",
    displayName: "Inspect",
    description: "Inspect the current run.",
    parametersSchema: { type: "object", properties: {} },
  } as const;

  function startInitializationClient(
    plugin: Parameters<typeof startWorkerRpcHost>[0]["plugin"],
  ) {
    const hostToWorker = new PassThrough();
    const workerToHost = new PassThrough();
    const hostReadline = createInterface({ input: workerToHost });
    const pending = new Map<string, (response: JsonRpcResponse) => void>();
    const worker = startWorkerRpcHost({
      plugin,
      stdin: hostToWorker,
      stdout: workerToHost,
    });
    let nextRequestId = 1;

    hostReadline.on("line", (line) => {
      const message = parseMessage(line);
      if (!isJsonRpcResponse(message)) return;
      pending.get(String(message.id))?.(message);
      pending.delete(String(message.id));
    });

    function callWorker(method: string, params: unknown) {
      const id = `${method}-${nextRequestId++}`;
      const result = new Promise<unknown>((resolve, reject) => {
        pending.set(id, (response) => {
          if ("error" in response && response.error) {
            reject(new Error(response.error.message));
            return;
          }
          resolve((response as { result?: unknown }).result);
        });
      });
      hostToWorker.write(serializeMessage(createRequest(method, params, id)));
      return result;
    }

    return {
      callWorker,
      callInitialize(
        tools: readonly (typeof declaredTool)[],
        manifestOverrides: Record<string, unknown> = {},
      ) {
        return callWorker("initialize", {
          manifest: {
            id: "paperclip.tool-registration-test",
            apiVersion: 1,
            version: "1.0.0",
            displayName: "Tool registration test",
            description: "Verifies exact manifest and handler agreement.",
            author: "Paperclip",
            categories: ["automation"],
            capabilities: ["agent.tools.register"],
            entrypoints: { worker: "dist/worker.js" },
            ...(tools.length > 0 ? { tools: [...tools] } : {}),
            ...manifestOverrides,
          },
          instanceInfo: { instanceId: "test", hostVersion: "0.0.0" },
          apiVersion: 1,
          databaseNamespace: null,
        });
      },
      stop() {
        worker.stop();
        hostReadline.close();
        hostToWorker.destroy();
        workerToHost.destroy();
      },
    };
  }

  it("dispatches health through the required plugin hook", async () => {
    const onHealth = vi.fn(async () => ({
      status: "degraded" as const,
      message: "provider unavailable",
    }));
    const client = startInitializationClient(defineSdkPlugin({
      async setup() {},
      onHealth,
    }));
    try {
      await client.callInitialize([], { capabilities: [] });
      await expect(client.callWorker("health", {})).resolves.toEqual({
        status: "degraded",
        message: "provider unavailable",
      });
      expect(onHealth).toHaveBeenCalledOnce();
    } finally {
      client.stop();
    }
  });

  it("rejects a manifest tool without a registered handler", async () => {
    const client = startInitializationClient(definePlugin({ async setup() {} }));
    try {
      await expect(client.callInitialize([declaredTool])).rejects.toThrow(
        "missing handlers: inspect",
      );
    } finally {
      client.stop();
    }
  });

  it("rejects a handler that is absent from the manifest", async () => {
    const client = startInitializationClient(definePlugin({
      async setup(ctx) {
        ctx.tools.register("inspect", async () => ({ ok: true, content: "ok" }));
      },
    }));
    try {
      await expect(client.callInitialize([])).rejects.toThrow(
        'Tool handler "inspect" is not declared in manifest.tools',
      );
    } finally {
      client.stop();
    }
  });

  it("rejects duplicate handler registration", async () => {
    const client = startInitializationClient(definePlugin({
      async setup(ctx) {
        ctx.tools.register("inspect", async () => ({ ok: true, content: "first" }));
        ctx.tools.register("inspect", async () => ({ ok: true, content: "second" }));
      },
    }));
    try {
      await expect(client.callInitialize([declaredTool])).rejects.toThrow(
        'Tool handler "inspect" is registered more than once',
      );
    } finally {
      client.stop();
    }
  });

  it("rejects a manifest job without a registered handler", async () => {
    const client = startInitializationClient(definePlugin({ async setup() {} }));
    try {
      await expect(client.callInitialize([], {
        capabilities: ["jobs.schedule"],
        jobs: [{ jobKey: "sync", displayName: "Sync" }],
      })).rejects.toThrow("missing handlers: sync");
    } finally {
      client.stop();
    }
  });

  it("rejects a job handler that is absent from the manifest", async () => {
    const client = startInitializationClient(definePlugin({
      async setup(ctx) {
        ctx.jobs.register("sync", async () => {});
      },
    }));
    try {
      await expect(client.callInitialize([], {
        capabilities: ["jobs.schedule"],
      })).rejects.toThrow('Job handler "sync" is not declared in manifest.jobs');
    } finally {
      client.stop();
    }
  });

  it("rejects duplicate job handler registration", async () => {
    const client = startInitializationClient(definePlugin({
      async setup(ctx) {
        ctx.jobs.register("sync", async () => {});
        ctx.jobs.register("sync", async () => {});
      },
    }));
    try {
      await expect(client.callInitialize([], {
        capabilities: ["jobs.schedule"],
        jobs: [{ jobKey: "sync", displayName: "Sync" }],
      })).rejects.toThrow('Job handler "sync" is registered more than once');
    } finally {
      client.stop();
    }
  });

  it("rejects duplicate data and action handler keys", async () => {
    const duplicateData = startInitializationClient(definePlugin({
      async setup(ctx) {
        ctx.data.register("summary", async () => ({}));
        ctx.data.register("summary", async () => ({}));
      },
    }));
    try {
      await expect(duplicateData.callInitialize([])).rejects.toThrow(
        'Data handler "summary" is registered more than once',
      );
    } finally {
      duplicateData.stop();
    }

    const duplicateAction = startInitializationClient(definePlugin({
      async setup(ctx) {
        ctx.actions.register("sync", async () => ({}));
        ctx.actions.register("sync", async () => ({}));
      },
    }));
    try {
      await expect(duplicateAction.callInitialize([])).rejects.toThrow(
        'Action handler "sync" is registered more than once',
      );
    } finally {
      duplicateAction.stop();
    }
  });

  it("rejects webhook declarations without onWebhook", async () => {
    const client = startInitializationClient(definePlugin({ async setup() {} }));
    try {
      await expect(client.callInitialize([], {
        webhooks: [{ endpointKey: "events", displayName: "Events" }],
      })).rejects.toThrow(
        "manifest.webhooks and the onWebhook handler must either both be present or both be absent",
      );
    } finally {
      client.stop();
    }
  });

  it("rejects onWebhook without webhook declarations", async () => {
    const client = startInitializationClient(definePlugin({
      async setup() {},
      async onWebhook() {},
    }));
    try {
      await expect(client.callInitialize([])).rejects.toThrow(
        "manifest.webhooks and the onWebhook handler must either both be present or both be absent",
      );
    } finally {
      client.stop();
    }
  });

  it("rejects API route declarations without onApiRequest", async () => {
    const client = startInitializationClient(definePlugin({ async setup() {} }));
    try {
      await expect(client.callInitialize([], {
        apiRoutes: [{
          routeKey: "summary",
          method: "GET",
          path: "/summary",
          companyResolution: { from: "query", key: "companyId" },
        }],
      })).rejects.toThrow(
        "manifest.apiRoutes and the onApiRequest handler must either both be present or both be absent",
      );
    } finally {
      client.stop();
    }
  });

  it("rejects onApiRequest without API route declarations", async () => {
    const client = startInitializationClient(definePlugin({
      async setup() {},
      async onApiRequest() {
        return { status: 200 };
      },
    }));
    try {
      await expect(client.callInitialize([])).rejects.toThrow(
        "manifest.apiRoutes and the onApiRequest handler must either both be present or both be absent",
      );
    } finally {
      client.stop();
    }
  });

  it("advertises the exact optional methods implemented after initialization", async () => {
    const client = startInitializationClient(definePlugin({
      async setup(ctx) {
        ctx.jobs.register("sync", async () => {});
        ctx.data.register("summary", async () => ({}));
        ctx.actions.register("sync", async () => ({}));
        ctx.tools.register("inspect", async () => ({ ok: true, content: "ok" }));
      },
      async onWebhook() {},
      async onApiRequest() {
        return { status: 200 };
      },
    }));
    try {
      await expect(client.callInitialize([declaredTool], {
        capabilities: [
          "jobs.schedule",
          "webhooks.receive",
          "api.routes.register",
          "agent.tools.register",
        ],
        jobs: [{ jobKey: "sync", displayName: "Sync" }],
        webhooks: [{ endpointKey: "events", displayName: "Events" }],
        apiRoutes: [{
          routeKey: "summary",
          method: "GET",
          path: "/summary",
          companyResolution: { from: "query", key: "companyId" },
        }],
      })).resolves.toEqual({
        supportedMethods: [
          "runJob",
          "handleWebhook",
          "handleApiRequest",
          "getData",
          "performAction",
          "executeTool",
        ],
      });
    } finally {
      client.stop();
    }
  });
});

describe("worker performAction context", () => {
  it("rejects invalid actors and exposes company authority only through the decoded actor", async () => {
    const hostToWorker = new PassThrough();
    const workerToHost = new PassThrough();
    const hostReadline = createInterface({ input: workerToHost });
    const pending = new Map<string, (response: JsonRpcResponse) => void>();
    const inspect = vi.fn(async (params: Record<string, unknown>, context: unknown) => ({
      paramsCompanyId: params.companyId,
      actor: (context as { actor: unknown }).actor,
    }));
    let nextRequestId = 1;
    const plugin = definePlugin({
      async setup(ctx) {
        ctx.actions.register("inspect", inspect);
      },
    });
    const worker = startWorkerRpcHost({
      plugin,
      stdin: hostToWorker,
      stdout: workerToHost,
    });

    function callWorker(method: string, params: unknown) {
      const id = `host-${nextRequestId++}`;
      const result = new Promise<unknown>((resolve, reject) => {
        pending.set(id, (response) => {
          if ("error" in response && response.error) {
            reject(Object.assign(
              new Error(response.error.message),
              { code: response.error.code },
            ));
            return;
          }
          resolve((response as { result?: unknown }).result);
        });
      });
      hostToWorker.write(serializeMessage(createRequest(method, params, id)));
      return result;
    }

    hostReadline.on("line", (line) => {
      const message = parseMessage(line);
      if (!isJsonRpcResponse(message)) return;
      pending.get(String(message.id))?.(message);
      pending.delete(String(message.id));
    });

    try {
      await expect(callWorker("initialize", {
        manifest: {
          id: "paperclip.test-worker-context",
          apiVersion: 1,
          version: "1.0.0",
          displayName: "Worker Context Test",
          description: "Test plugin",
          author: "Paperclip",
          categories: ["automation"],
          capabilities: [],
          entrypoints: {},
        },
        instanceInfo: { instanceId: "test", hostVersion: "0.0.0" },
        apiVersion: 1,
        databaseNamespace: null,
      })).resolves.toEqual({ supportedMethods: ["performAction"] });

      const invalidActors: unknown[] = [
        undefined,
        null,
        {},
        { type: "system" },
        { type: "system", companyId: "" },
        { type: "system", companyId: null, userId: "mixed" },
        { type: "user", companyId: "company-a", userId: " " },
        {
          type: "user",
          companyId: "company-a",
          userId: "user-a",
          agentId: "mixed",
        },
        {
          type: "agent",
          companyId: "company-a",
          agentId: "agent-a",
          runId: "",
        },
        {
          type: "agent",
          companyId: "company-a",
          agentId: "agent-a",
          runId: "run-a",
          userId: "mixed",
        },
      ];
      for (const actorContext of invalidActors) {
        await expect(callWorker("performAction", {
          key: "inspect",
          params: {},
          ...(actorContext === undefined ? {} : { actorContext }),
        })).rejects.toMatchObject({
          code: JSONRPC_ERROR_CODES.INVALID_PARAMS,
          message: expect.stringContaining("actorContext"),
        });
      }
      expect(inspect).not.toHaveBeenCalled();

      await expect(callWorker("performAction", {
        key: "inspect",
        params: { companyId: "spoofed-company" },
        actorContext: {
          type: "system",
          companyId: null,
        },
      })).resolves.toEqual({
        paramsCompanyId: "spoofed-company",
        actor: {
          type: "system",
          companyId: null,
        },
      });
      expect(inspect).toHaveBeenCalledTimes(1);
    } finally {
      worker.stop();
      hostReadline.close();
      hostToWorker.destroy();
      workerToHost.destroy();
    }
  });
});

describe("worker invocation scope propagation", () => {
  it("keeps overlapping company scopes local to each getData invocation", async () => {
    const hostToWorker = new PassThrough();
    const workerToHost = new PassThrough();
    const hostReadline = createInterface({ input: workerToHost });
    const pending = new Map<string, (response: JsonRpcResponse) => void>();
    const nestedInvocationIds: string[] = [];
    const invocationCompanies = new Map([
      ["invocation-a", "company-a"],
      ["invocation-b", "company-b"],
    ]);
    let releaseCompanyA: (() => void) | null = null;
    let nextRequestId = 1;

    const plugin = definePlugin({
      async setup(ctx) {
        ctx.data.register("probe", async (params) => {
          if (params.label === "a") {
            await new Promise<void>((resolve) => {
              releaseCompanyA = resolve;
            });
          }
          const company = await ctx.companies.get(String(params.requestedCompanyId));
          return { label: params.label, company };
        });
      },
    });

    const worker = startWorkerRpcHost({
      plugin,
      stdin: hostToWorker,
      stdout: workerToHost,
    });

    function callWorker(method: string, params: unknown, invocation?: PluginInvocationContext) {
      const id = `host-${nextRequestId++}`;
      const request = {
        ...createRequest(method, params, id),
        ...(invocation ? { paperclipInvocation: invocation } : {}),
      };
      const result = new Promise<unknown>((resolve, reject) => {
        pending.set(id, (response) => {
          if ("error" in response && response.error) {
            reject(new Error(response.error.message));
            return;
          }
          resolve((response as { result?: unknown }).result);
        });
      });
      hostToWorker.write(serializeMessage(request));
      return result;
    }

    hostReadline.on("line", (line) => {
      const message = parseMessage(line);
      if (isJsonRpcResponse(message)) {
        pending.get(String(message.id))?.(message);
        pending.delete(String(message.id));
        return;
      }

      if (!isJsonRpcRequest(message)) return;
      if (message.method !== "companies.get") return;

      const invocationId = (message as { paperclipInvocationId?: string }).paperclipInvocationId ?? "";
      const requestedCompanyId = (message.params as { companyId?: string }).companyId;
      const allowedCompanyId = invocationCompanies.get(invocationId);
      nestedInvocationIds.push(invocationId);
      if (requestedCompanyId !== allowedCompanyId) {
        hostToWorker.write(serializeMessage(createErrorResponse(
          message.id,
          PLUGIN_RPC_ERROR_CODES.CAPABILITY_DENIED,
          `requested company "${requestedCompanyId}" but invocation "${invocationId}" is scoped to "${allowedCompanyId}"`,
        )));
        return;
      }

      hostToWorker.write(serializeMessage(createSuccessResponse(message.id, {
        id: requestedCompanyId,
      })));

      if (invocationId === "invocation-b") {
        releaseCompanyA?.();
      }
    });

    try {
      await callWorker("initialize", {
        manifest: {
          id: "paperclip.scope-test",
          apiVersion: 1,
          version: "1.0.0",
          displayName: "Scope test",
          description: "Scope test",
          author: "Paperclip",
          categories: ["automation"],
          capabilities: ["companies.read"],
          entrypoints: { worker: "dist/worker.js" },
        },
        instanceInfo: { instanceId: "test", hostVersion: "0.0.0" },
        apiVersion: 1,
        databaseNamespace: null,
      });

      const companyARequest = callWorker(
        "getData",
        {
          key: "probe",
          companyId: "company-a",
          params: { label: "a", requestedCompanyId: "company-b" },
        },
        { id: "invocation-a", scope: { companyId: "company-a" } },
      );
      const companyAExpectation = expect(companyARequest).rejects.toThrow(
        /requested company "company-b"/,
      );
      const companyBRequest = callWorker(
        "getData",
        {
          key: "probe",
          companyId: "company-b",
          params: { label: "b", requestedCompanyId: "company-b" },
        },
        { id: "invocation-b", scope: { companyId: "company-b" } },
      );

      await expect(companyBRequest).resolves.toEqual({
        label: "b",
        company: { id: "company-b" },
      });
      await companyAExpectation;

      expect(nestedInvocationIds).toEqual(["invocation-b", "invocation-a"]);
    } finally {
      worker.stop();
      hostReadline.close();
      hostToWorker.destroy();
      workerToHost.destroy();
    }
  });

  it("keeps the exact beforePrompt scope on nested canonical-record reads", async () => {
    const hostToWorker = new PassThrough();
    const workerToHost = new PassThrough();
    const hostReadline = createInterface({ input: workerToHost });
    const pending = new Map<string, (response: JsonRpcResponse) => void>();
    const nestedCalls: Array<{
      method: string;
      params: unknown;
      invocationId: string | undefined;
      invocationScope: PluginInvocationContext["scope"] | null;
    }> = [];
    let nextRequestId = 1;

    const sessionResult = {
      session: {
        companyId: "company-a",
        issueId: "issue-a",
        sessionId: "session-a",
        parentSessionId: null,
        projectId: "project-a",
        createdAt: "2026-08-06T12:00:00.000Z",
      },
      snapshotHighWaterSeq: 37,
      messages: { items: [], nextCursor: null },
      events: { items: [], nextCursor: null },
    };
    const commentsResult = {
      items: [{
        id: "comment-a",
        issueId: "issue-a",
        body: "Pinned issue context.",
        author: { kind: "board" as const },
        runId: null,
        sequence: 36,
        createdAt: "2026-08-06T11:59:00.000Z",
      }],
      nextCursor: null,
    };
    const readSession = vi.fn(async () => sessionResult);
    const readIssueComments = vi.fn(async () => commentsResult);
    const handlers = createHostClientHandlers({
      pluginId: "paperclip.before-prompt-records-test",
      capabilities: ["runtime.records.read"],
      services: {
        runtimeRecords: { readSession, readIssueComments },
      } as unknown as HostServices,
    });

    let records:
      | Parameters<PluginDefinition["setup"]>[0]["runtime"]["records"]
      | null = null;
    const plugin = definePlugin({
      async setup(ctx) {
        records = ctx.runtime.records;
      },
      async onBeforePrompt(input) {
        if (!records) throw new Error("Runtime records client was not initialized");
        const session = await records.readSession({
          companyId: input.companyId,
          sessionId: input.sessionId,
          snapshotHighWaterSeq: input.snapshotHighWaterSeq,
          messages: { afterSeq: -1, limit: 50 },
          events: { afterSeq: -1, limit: 50 },
        });
        const comments = await records.readIssueComments({
          companyId: input.companyId,
          issueId: input.issueId,
          limit: 50,
        });
        return {
          prependText: `${session.session.sessionId}:${session.snapshotHighWaterSeq}:${comments.items[0]?.id}`,
        };
      },
    });
    const worker = startWorkerRpcHost({
      plugin,
      stdin: hostToWorker,
      stdout: workerToHost,
    });

    function callWorker(
      method: string,
      params: unknown,
      invocation?: PluginInvocationContext,
    ) {
      const id = `host-${nextRequestId++}`;
      const result = new Promise<unknown>((resolve, reject) => {
        pending.set(id, (response) => {
          if ("error" in response && response.error) {
            reject(new Error(response.error.message));
            return;
          }
          resolve((response as { result?: unknown }).result);
        });
      });
      hostToWorker.write(serializeMessage({
        ...createRequest(method, params, id),
        ...(invocation ? { paperclipInvocation: invocation } : {}),
      }));
      return result;
    }

    const invocation = {
      id: "invocation-before-prompt",
      scope: {
        companyId: "company-a",
        canonicalSession: {
          issueId: "issue-a",
          sessionId: "session-a",
          snapshotHighWaterSeq: 37,
        },
      },
    } satisfies PluginInvocationContext;

    hostReadline.on("line", (line) => {
      const message = parseMessage(line);
      if (isJsonRpcResponse(message)) {
        pending.get(String(message.id))?.(message);
        pending.delete(String(message.id));
        return;
      }
      if (!isJsonRpcRequest(message)) return;

      const invocationScope = message.paperclipInvocationId === invocation.id
        ? invocation.scope
        : null;
      nestedCalls.push({
        method: message.method,
        params: message.params,
        invocationId: message.paperclipInvocationId,
        invocationScope,
      });
      const handler = (
        handlers as Record<
          string,
          (params: unknown, context: unknown) => Promise<unknown>
        >
      )[message.method];
      if (!handler) {
        hostToWorker.write(serializeMessage(createErrorResponse(
          message.id,
          PLUGIN_RPC_ERROR_CODES.METHOD_NOT_FOUND,
          `No host handler for "${message.method}"`,
        )));
        return;
      }
      const context = invocationScope
        ? { invocationScope }
        : { invalidInvocationScope: true };
      void handler(message.params, context).then(
        (result) => {
          hostToWorker.write(serializeMessage(createSuccessResponse(message.id, result)));
        },
        (error: unknown) => {
          const code = typeof (error as { code?: unknown })?.code === "number"
            ? (error as { code: number }).code
            : PLUGIN_RPC_ERROR_CODES.UNKNOWN;
          hostToWorker.write(serializeMessage(createErrorResponse(
            message.id,
            code,
            error instanceof Error ? error.message : String(error),
          )));
        },
      );
    });

    const beforePromptInput = {
      companyId: "company-a",
      issueId: "issue-a",
      sessionId: "session-a",
      runId: "run-a",
      agentId: "agent-a",
      projectId: "project-a",
      sourceText: "Canonical source",
      promptKind: "base",
      sessionOperation: "new",
      refId: "ref-a",
      refOrdinal: 0,
      segmentOrdinal: 0,
      sourceMessageId: "message-a",
      sourceMessageSeq: 37,
      contextAccess: {
        carry_context: false,
        read_issue_comments: true,
        read_issue_agent_run: false,
        list_sub_issues: false,
        read_sub_issue_comments: false,
        read_sub_issue_agent_run: false,
        list_company_issues: false,
        read_company_issue_comments: false,
        read_company_issue_agent_run: false,
      },
      snapshotHighWaterSeq: 37,
    } as const;

    try {
      await callWorker("initialize", {
        manifest: {
          id: "paperclip.before-prompt-records-test",
          apiVersion: 1,
          version: "1.0.0",
          displayName: "Before-prompt records test",
          description: "Before-prompt records test",
          author: "Paperclip",
          categories: ["automation"],
          capabilities: ["runtime.prompt.observe", "runtime.records.read"],
          entrypoints: { worker: "dist/worker.js" },
        },
        instanceInfo: { instanceId: "test", hostVersion: "0.0.0" },
        apiVersion: 1,
        databaseNamespace: null,
      });

      await expect(callWorker(
        "beforePrompt",
        beforePromptInput,
        invocation,
      )).resolves.toEqual({
        prependText: "session-a:37:comment-a",
      });

      expect(nestedCalls).toEqual([
        {
          method: "runtime.records.readSession",
          params: {
            companyId: "company-a",
            sessionId: "session-a",
            snapshotHighWaterSeq: 37,
            messages: { afterSeq: -1, limit: 50 },
            events: { afterSeq: -1, limit: 50 },
          },
          invocationId: "invocation-before-prompt",
          invocationScope: invocation.scope,
        },
        {
          method: "runtime.records.readIssueComments",
          params: {
            companyId: "company-a",
            issueId: "issue-a",
            limit: 50,
          },
          invocationId: "invocation-before-prompt",
          invocationScope: invocation.scope,
        },
      ]);
      expect(readSession).toHaveBeenCalledOnce();
      expect(readSession).toHaveBeenCalledWith(nestedCalls[0]?.params);
      expect(readIssueComments).toHaveBeenCalledOnce();
      expect(readIssueComments).toHaveBeenCalledWith(nestedCalls[1]?.params);
    } finally {
      worker.stop();
      hostReadline.close();
      hostToWorker.destroy();
      workerToHost.destroy();
    }
  });
});

describe("worker plugin run-context bridge", () => {
  it("blocks captured installation issue APIs during executeTool while run issues use the exact opaque handle", async () => {
    const hostToWorker = new PassThrough();
    const workerToHost = new PassThrough();
    const hostReadline = createInterface({ input: workerToHost });
    const pending = new Map<string, (response: JsonRpcResponse) => void>();
    const nestedCalls: Array<{
      method: string;
      params: unknown;
      invocationId: string | undefined;
    }> = [];
    let nextRequestId = 1;
    const ordinaryIssueList = vi.fn(async () => []);
    const readIssueComments = vi.fn(async () => ({
      items: [{ id: "comment-a", body: "Dial-authorized comment." }],
      nextCursor: null,
    }));
    const handlers = createHostClientHandlers({
      pluginId: "paperclip.run-context-test",
      capabilities: ["issues.read"],
      services: {
        issues: { list: ordinaryIssueList },
        runIssues: { readIssueComments },
      } as unknown as HostServices,
    });
    const plugin = definePlugin({
      async setup(ctx) {
        ctx.tools.register(
          "inspect",
          async (_params, runContext) => {
            let ordinaryIssueError: { code: number | null; message: string } | null = null;
            try {
              await ctx.issues.list({ companyId: "company-a" });
            } catch (error) {
              ordinaryIssueError = {
                code: typeof (error as { code?: unknown })?.code === "number"
                  ? (error as { code: number }).code
                  : null,
                message: error instanceof Error ? error.message : String(error),
              };
            }
            const comments = await runContext.issues.readIssueComments();
            return {
              ok: true,
              content: "ok",
              data: {
                contextKeys: Object.keys(runContext).sort(),
                handle: runContext.handle,
                ordinaryIssueError,
                comments,
              },
            };
          },
        );
      },
    });
    const worker = startWorkerRpcHost({
      plugin,
      stdin: hostToWorker,
      stdout: workerToHost,
    });

    function callWorker(
      method: string,
      params: unknown,
      invocation?: PluginInvocationContext,
    ) {
      const id = `host-${nextRequestId++}`;
      const result = new Promise<unknown>((resolve, reject) => {
        pending.set(id, (response) => {
          if ("error" in response && response.error) {
            reject(new Error(response.error.message));
            return;
          }
          resolve((response as { result?: unknown }).result);
        });
      });
      hostToWorker.write(serializeMessage({
        ...createRequest(method, params, id),
        ...(invocation ? { paperclipInvocation: invocation } : {}),
      }));
      return result;
    }

    hostReadline.on("line", (line) => {
      const message = parseMessage(line);
      if (isJsonRpcResponse(message)) {
        pending.get(String(message.id))?.(message);
        pending.delete(String(message.id));
        return;
      }
      if (!isJsonRpcRequest(message)) return;
      nestedCalls.push({
        method: message.method,
        params: message.params,
        invocationId: message.paperclipInvocationId,
      });
      const handler = (
        handlers as Record<
          string,
          (params: unknown, context: unknown) => Promise<unknown>
        >
      )[message.method];
      if (!handler) {
        hostToWorker.write(serializeMessage(createErrorResponse(
          message.id,
          PLUGIN_RPC_ERROR_CODES.METHOD_NOT_FOUND,
          `No host handler for "${message.method}"`,
        )));
        return;
      }
      const context = message.paperclipInvocationId === "invocation-run"
        ? {
          invocationScope: {
            companyId: "company-a",
            pluginRunContextHandle: "pc_plugin_ctx_v1_exact",
          },
        }
        : { invalidInvocationScope: true };
      void handler(message.params, context).then(
        (result) => {
          hostToWorker.write(serializeMessage(createSuccessResponse(message.id, result)));
        },
        (error: unknown) => {
          const code = typeof (error as { code?: unknown })?.code === "number"
            ? (error as { code: number }).code
            : PLUGIN_RPC_ERROR_CODES.UNKNOWN;
          hostToWorker.write(serializeMessage(createErrorResponse(
            message.id,
            code,
            error instanceof Error ? error.message : String(error),
          )));
        },
      );
    });

    try {
      await callWorker("initialize", {
        manifest: {
          id: "paperclip.run-context-test",
          apiVersion: 1,
          version: "1.0.0",
          displayName: "Run context test",
          description: "Run context test",
          author: "Paperclip",
          categories: ["automation"],
          capabilities: ["agent.tools.register", "issues.read"],
          entrypoints: { worker: "dist/worker.js" },
          tools: [{
            name: "inspect",
            displayName: "Inspect",
            description: "Inspect",
            parametersSchema: { type: "object", properties: {} },
          }],
        },
        instanceInfo: { instanceId: "test", hostVersion: "0.0.0" },
        apiVersion: 1,
        databaseNamespace: null,
      });

      await expect(callWorker(
        "executeTool",
        {
          toolName: "inspect",
          parameters: {},
          runContextHandle: "pc_plugin_ctx_v1_exact",
        },
        {
          id: "invocation-run",
          scope: {
            companyId: "company-a",
            pluginRunContextHandle: "pc_plugin_ctx_v1_exact",
          },
        },
      )).resolves.toEqual({
        ok: true,
        content: "ok",
        data: {
          contextKeys: ["handle", "issueReach", "issues", "resolve"],
          handle: "pc_plugin_ctx_v1_exact",
          ordinaryIssueError: {
            code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED,
            message: expect.stringContaining(
              "installation issue control plane is unavailable while serving an agent run",
            ),
          },
          comments: {
            items: [{ id: "comment-a", body: "Dial-authorized comment." }],
            nextCursor: null,
          },
        },
      });
      expect(nestedCalls).toContainEqual({
        method: "issues.list",
        params: { companyId: "company-a" },
        invocationId: "invocation-run",
      });
      expect(nestedCalls).toContainEqual({
        method: "run.issues.readIssueComments",
        params: { runContextHandle: "pc_plugin_ctx_v1_exact" },
        invocationId: "invocation-run",
      });
      expect(ordinaryIssueList).not.toHaveBeenCalled();
      expect(readIssueComments).toHaveBeenCalledOnce();
      expect(readIssueComments).toHaveBeenCalledWith({
        runContextHandle: "pc_plugin_ctx_v1_exact",
      });
    } finally {
      worker.stop();
      hostReadline.close();
      hostToWorker.destroy();
      workerToHost.destroy();
    }
  });
});

describe("worker issue mutation bridge", () => {
  it("replays each exact mutation request after a lost response without supplying an operation identity", async () => {
    const hostToWorker = new PassThrough();
    const workerToHost = new PassThrough();
    const hostReadline = createInterface({ input: workerToHost });
    const pending = new Map<string, (response: JsonRpcResponse) => void>();
    const hostCalls: Array<{ id: unknown; method: string; params: unknown; line: string }> = [];
    const mutationAttempts = new Map<string, number>();
    let nextRequestId = 1;
    const plugin = definePlugin({
      async setup(ctx) {
        ctx.data.register("mutations", async () => {
          const created = await ctx.issues.create({
            companyId: "company-1",
            request: "Create exact plugin work.",
            ownerAgentId: "agent-1",
            callbackKey: "creator",
            callbackVersion: "1",
          });
          const messaged = await ctx.issues.update(
            "issue-1",
            { kind: "message", message: "One creator message." },
            "company-1",
          );
          const reassigned = await ctx.issues.update(
            "issue-1",
            { kind: "reassign", ownerAgentId: "agent-2" },
            "company-1",
          );
          const withdrawn = await ctx.issues.withdraw(
            "issue-1",
            "The plugin no longer needs this work.",
            "company-1",
          );
          return { created, messaged, reassigned, withdrawn };
        });
      },
    });
    const worker = startWorkerRpcHost({
      plugin,
      stdin: hostToWorker,
      stdout: workerToHost,
      rpcTimeoutMs: 20,
    });

    function callWorker(method: string, params: unknown) {
      const id = `host-${nextRequestId++}`;
      const result = new Promise<unknown>((resolve, reject) => {
        pending.set(id, (response) => {
          if ("error" in response && response.error) {
            reject(new Error(response.error.message));
            return;
          }
          resolve((response as { result?: unknown }).result);
        });
      });
      hostToWorker.write(serializeMessage(createRequest(method, params, id)));
      return result;
    }

    hostReadline.on("line", (line) => {
      const message = parseMessage(line);
      if (isJsonRpcResponse(message)) {
        pending.get(String(message.id))?.(message);
        pending.delete(String(message.id));
        return;
      }
      if (!isJsonRpcRequest(message)) return;
      hostCalls.push({
        id: message.id,
        method: message.method,
        params: message.params,
        line,
      });
      const updateKind = message.method === "issues.update"
        ? (message.params as { input: { kind: string } }).input.kind
        : "";
      const mutationKey = `${message.method}:${updateKind}`;
      const attempt = (mutationAttempts.get(mutationKey) ?? 0) + 1;
      mutationAttempts.set(mutationKey, attempt);
      if (attempt === 1) return;
      if (message.method === "issues.withdraw") {
        hostToWorker.write(serializeMessage(createSuccessResponse(message.id, {
          operationId: "host-operation-1",
          issue: { id: "issue-1", status: "cancelled" },
          retried: true,
        })));
        return;
      }
      hostToWorker.write(serializeMessage(createSuccessResponse(message.id, {
        id: "issue-1",
        companyId: "company-1",
      })));
    });

    try {
      await callWorker("initialize", {
        manifest: {
          id: "paperclip.withdraw-test",
          apiVersion: 1,
          version: "1.0.0",
          displayName: "Withdrawal test",
          description: "Withdrawal test",
          author: "Paperclip",
          categories: ["automation"],
          capabilities: ["issues.withdraw"],
          entrypoints: { worker: "dist/worker.js" },
        },
        instanceInfo: { instanceId: "test", hostVersion: "0.0.0" },
        apiVersion: 1,
        databaseNamespace: null,
      });

      await expect(callWorker("getData", {
        key: "mutations",
        params: {},
      })).resolves.toMatchObject({
        created: { id: "issue-1" },
        messaged: { id: "issue-1" },
        reassigned: { id: "issue-1" },
        withdrawn: {
          operationId: "host-operation-1",
          retried: true,
        },
      });
      expect(hostCalls).toHaveLength(8);
      for (let index = 0; index < hostCalls.length; index += 2) {
        expect(hostCalls[index + 1]).toEqual(hostCalls[index]);
      }
      const withdrawal = hostCalls.find(
        ({ method }) => method === "issues.withdraw",
      );
      expect(withdrawal).toMatchObject({
        params: {
          issueId: "issue-1",
          companyId: "company-1",
          message: "The plugin no longer needs this work.",
        },
      });
      expect(withdrawal?.params).not.toHaveProperty("operationId");
    } finally {
      worker.stop();
      hostReadline.close();
      hostToWorker.destroy();
      workerToHost.destroy();
    }
  });
});
