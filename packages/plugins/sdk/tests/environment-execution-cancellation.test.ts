import { execFile, spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";

import { describe, expect, it, vi } from "vitest";

import { definePlugin } from "../src/define-plugin.js";
import {
  buildCancelEnvironmentShellCommand,
  createEnvironmentExecutionCancellationRegistry,
  wrapCancellableEnvironmentShellCommand,
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

const execFileAsync = promisify(execFile);

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

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

function waitForExit(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
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

  it("cancels one shell process group without stopping a concurrent command", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-exact-cancel-"));
    const cancelledOutput = path.join(root, "cancelled-command-finished");
    const preservedOutput = path.join(root, "preserved-command-finished");
    const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
    const cancelledId = "cancelled-execution";
    const preservedId = "preserved-execution";
    const cancelledControl = `/tmp/.paperclip-execution-${Buffer.from(cancelledId).toString("hex")}/pid`;
    const cancelled = spawn(
      "sh",
      [
        "-c",
        wrapCancellableEnvironmentShellCommand(
          cancelledId,
          `sleep 2; printf cancelled > ${quote(cancelledOutput)}`,
        ),
      ],
      { stdio: "ignore" },
    );
    const preserved = spawn(
      "sh",
      [
        "-c",
        wrapCancellableEnvironmentShellCommand(
          preservedId,
          `sleep 0.25; printf preserved > ${quote(preservedOutput)}`,
        ),
      ],
      { stdio: "ignore" },
    );
    const cancelledExit = waitForExit(cancelled);
    const preservedExit = waitForExit(preserved);

    try {
      await waitFor(
        async () => access(cancelledControl).then(() => true, () => false),
        "cancellable command did not publish its exact process identity",
      );
      await execFileAsync("sh", [
        "-c",
        buildCancelEnvironmentShellCommand(cancelledId),
      ]);
      await expect(cancelledExit).resolves.not.toBe(0);
      await expect(preservedExit).resolves.toBe(0);
      await expect(access(cancelledOutput)).rejects.toThrow();
      await expect(readFile(preservedOutput, "utf8")).resolves.toBe("preserved");
    } finally {
      cancelled.kill("SIGKILL");
      preserved.kill("SIGKILL");
      await rm(root, { recursive: true, force: true });
    }
  }, 10_000);

  it("fails environment-driver conformance when execution has no exact cancellation hook", () => {
    expect(() =>
      createEnvironmentTestHarness({
        manifest: MANIFEST,
        environmentDriver: {
          driverKey: "legacy-sandbox",
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
        config: {},
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
