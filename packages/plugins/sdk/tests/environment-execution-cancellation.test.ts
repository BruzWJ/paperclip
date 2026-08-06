import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  definePlugin as defineSdkPlugin,
  type PluginDefinition,
} from "../src/define-plugin.js";
import {
  createEnvironmentExecutionCancellationRegistry,
} from "../src/environment-execution-control.js";
import {
  createRequest,
  isJsonRpcResponse,
  parseMessage,
  serializeMessage,
  type JsonRpcResponse,
  type PluginEnvironmentCancelExecutionParams,
  type PluginEnvironmentExecuteParams,
  type PluginEnvironmentExecuteResult,
} from "../src/protocol.js";
import { createEnvironmentTestHarness } from "../src/testing.js";
import { startWorkerRpcHost } from "../src/worker-rpc-host.js";

function definePlugin(definition: Omit<PluginDefinition, "onHealth">) {
  return defineSdkPlugin({
    ...definition,
    async onHealth() {
      return { status: "ok" };
    },
  });
}

const MANIFEST = {
  id: "paperclip.environment-execution-cancellation-test",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Environment execution cancellation test",
  description: "Test plugin",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: [],
  entrypoints: {},
} as const;

function executionParams(
  overrides: Partial<PluginEnvironmentExecuteParams> = {},
): PluginEnvironmentExecuteParams {
  return {
    driverKey: "sandbox",
    companyId: "company-1",
    environmentId: "environment-1",
    config: {},
    lease: { providerLeaseId: "lease-1" },
    executionId: "execution-1",
    command: "sh",
    args: ["-c", "sleep 30"],
    ...overrides,
  };
}

function cancelParams(
  overrides: Partial<PluginEnvironmentCancelExecutionParams> = {},
): PluginEnvironmentCancelExecutionParams {
  return {
    driverKey: "sandbox",
    companyId: "company-1",
    environmentId: "environment-1",
    config: {},
    lease: { providerLeaseId: "lease-1" },
    executionId: "execution-1",
    reason: "operator cancelled",
    ...overrides,
  };
}

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

  return {
    callWorker,
    stop() {
      worker.stop();
      hostReadline.close();
      hostToWorker.destroy();
      workerToHost.destroy();
    },
  };
}

describe("environment exact execution cancellation", () => {
  it("matches the full scope, coalesces concurrent cancellation, and makes stale cancellation a no-op", async () => {
    const registry = createEnvironmentExecutionCancellationRegistry();
    let finishExecution!: () => void;
    const blocked = new Promise<void>((resolve) => {
      finishExecution = resolve;
    });
    const cancel = vi.fn(async () => {
      finishExecution();
    });
    const execute = registry.execute(executionParams(), {
      cancel,
      execute: async () => {
        await blocked;
        return "finished";
      },
    });

    await expect(
      registry.cancel(cancelParams({ companyId: "other-company" })),
    ).resolves.toEqual({ executionId: "execution-1", cancelled: false });
    await expect(
      registry.cancel(cancelParams({ environmentId: "other-environment" })),
    ).resolves.toEqual({ executionId: "execution-1", cancelled: false });
    await expect(
      registry.cancel(cancelParams({ lease: { providerLeaseId: "other-lease" } })),
    ).resolves.toEqual({ executionId: "execution-1", cancelled: false });
    await expect(
      registry.cancel(cancelParams({ executionId: "stale-execution" })),
    ).resolves.toEqual({ executionId: "stale-execution", cancelled: false });

    let finishOtherExecution!: () => void;
    const otherBlocked = new Promise<void>((resolve) => {
      finishOtherExecution = resolve;
    });
    const otherCancel = vi.fn(async () => {
      finishOtherExecution();
    });
    const otherExecute = registry.execute(
      executionParams({ companyId: "other-company" }),
      {
        cancel: otherCancel,
        execute: async () => {
          await otherBlocked;
          return "other-finished";
        },
      },
    );

    const [first, concurrent, other] = await Promise.all([
      registry.cancel(cancelParams()),
      registry.cancel(cancelParams()),
      registry.cancel(cancelParams({ companyId: "other-company" })),
    ]);
    expect(first).toEqual({ executionId: "execution-1", cancelled: true });
    expect(concurrent).toEqual({ executionId: "execution-1", cancelled: true });
    expect(other).toEqual({ executionId: "execution-1", cancelled: true });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith("operator cancelled");
    expect(otherCancel).toHaveBeenCalledTimes(1);
    await expect(execute).resolves.toBe("finished");
    await expect(otherExecute).resolves.toBe("other-finished");
    await expect(registry.cancel(cancelParams())).resolves.toEqual({
      executionId: "execution-1",
      cancelled: false,
    });
  });

  it("uses an exact provider reconnect callback after worker-local registry loss", async () => {
    const restartedRegistry =
      createEnvironmentExecutionCancellationRegistry();
    const reconnectAndCancel = vi.fn(
      async (reason: string) => {
        expect(reason).toBe("operator cancelled");
        return true;
      },
    );

    await expect(
      restartedRegistry.cancel(
        cancelParams(),
        reconnectAndCancel,
      ),
    ).resolves.toEqual({
      executionId: "execution-1",
      cancelled: true,
    });
    expect(reconnectAndCancel).toHaveBeenCalledTimes(1);

    await expect(
      restartedRegistry.cancel(
        cancelParams({ executionId: "already-absent" }),
        async () => false,
      ),
    ).resolves.toEqual({
      executionId: "already-absent",
      cancelled: false,
    });
  });

  it("fails environment-driver conformance when execution has no exact cancellation hook", () => {
    expect(() =>
      createEnvironmentTestHarness({
        manifest: MANIFEST,
        environmentDriver: {
          driverKey: "sandbox-without-cancellation",
          async onExecute(): Promise<PluginEnvironmentExecuteResult> {
            return {
              exitCode: 0,
              timedOut: false,
              stdout: "",
              stderr: "",
            };
          },
        },
      }),
    ).toThrow("exact command cancellation is required for execution conformance");
  });

  it("handles execute and exact cancel RPCs concurrently in one plugin worker", async () => {
    let started!: () => void;
    let finish!: () => void;
    const executionStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const executionFinished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const seen: string[] = [];
    const worker = startTestWorker(
      definePlugin({
        async setup() {},
        async onEnvironmentExecute(params): Promise<PluginEnvironmentExecuteResult> {
          seen.push(`execute:${params.executionId}`);
          started();
          await executionFinished;
          return {
            exitCode: 130,
            timedOut: false,
            stdout: "",
            stderr: "",
          };
        },
        async onEnvironmentCancelExecution(params) {
          seen.push(`cancel:${params.executionId}:${params.reason}`);
          finish();
          return { executionId: params.executionId, cancelled: true };
        },
      }),
    );

    try {
      const initialized = await worker.callWorker<{
        ok: boolean;
        supportedMethods: string[];
      }>("initialize", {
        manifest: MANIFEST,
        instanceInfo: { instanceId: "test", hostVersion: "0.0.0" },
        apiVersion: 1,
        databaseNamespace: null,
      });
      expect(initialized.supportedMethods).toContain("environmentExecute");
      expect(initialized.supportedMethods).toContain("environmentCancelExecution");

      const execution = worker.callWorker<PluginEnvironmentExecuteResult>(
        "environmentExecute",
        executionParams(),
      );
      await executionStarted;
      const cancelled = await worker.callWorker(
        "environmentCancelExecution",
        cancelParams(),
      );
      expect(cancelled).toEqual({ executionId: "execution-1", cancelled: true });
      await expect(execution).resolves.toMatchObject({ exitCode: 130 });
      expect(seen).toEqual([
        "execute:execution-1",
        "cancel:execution-1:operator cancelled",
      ]);
    } finally {
      finish();
      worker.stop();
    }
  });
});
