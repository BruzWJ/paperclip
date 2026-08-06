import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import {
  createHostClientHandlers,
  type HostServices,
} from "@paperclipai/plugin-sdk";

const forkMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, fork: forkMock };
});

const {
  createPluginWorkerHandle,
  createPluginWorkerManager,
} = await import("../services/plugin-worker-manager.js");

const TEST_MANIFEST: PaperclipPluginManifestV1 = {
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

interface FakeChildOptions {
  crashOnInitialize?: boolean;
  exitOnShutdown?: boolean;
  ignoreSignals?: boolean;
}

class FakeChildProcess extends EventEmitter {
  readonly pid: number;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  readonly signals: NodeJS.Signals[] = [];
  private exited = false;

  constructor(
    pid: number,
    private readonly options: FakeChildOptions = {},
  ) {
    super();
    this.pid = pid;
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        for (const line of chunk.toString().split("\n")) {
          if (!line.trim()) continue;
          this.handleRequest(JSON.parse(line) as {
            id: string | number;
            method: string;
          });
        }
        callback();
      },
    });
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    if (!this.options.ignoreSignals) {
      queueMicrotask(() => this.exit(null, signal));
    }
    return true;
  }

  exit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return;
    this.exited = true;
    this.stdin.end();
    this.stdout.end();
    this.stderr.end();
    this.emit("exit", code, signal);
  }

  private handleRequest(request: { id: string | number; method: string }): void {
    if (request.method === "initialize" && this.options.crashOnInitialize) {
      queueMicrotask(() => this.exit(1, null));
      return;
    }

    if (request.method === "initialize") {
      this.respond(request.id, { supportedMethods: [] });
      return;
    }
    if (request.method === "health") {
      this.respond(request.id, { status: "ok" });
      return;
    }
    if (request.method === "shutdown") {
      this.respond(request.id, {});
      if (this.options.exitOnShutdown) {
        queueMicrotask(() => this.exit(0, null));
      }
    }
  }

  private respond(id: string | number, result: unknown): void {
    this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  }
}

function workerOptions(onTerminalCrash: () => void | Promise<void>) {
  return {
    entrypointPath: "/test/plugin-worker.cjs",
    manifest: TEST_MANIFEST,
    instanceInfo: {
      instanceId: "instance-1",
      hostVersion: "1.0.0",
    },
    apiVersion: 1,
    databaseNamespace: null,
    onTerminalCrash,
    hostHandlers: createHostClientHandlers({
      pluginId: "test.plugin",
      capabilities: [],
      services: {} as HostServices,
    }),
  };
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("plugin worker recovery invariants", () => {
  beforeEach(() => {
    forkMock.mockReset();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("retains a worker whose process is still alive after SIGKILL", async () => {
    const child = new FakeChildProcess(101, { ignoreSignals: true });
    forkMock.mockReturnValue(child as unknown as ChildProcess);
    const manager = createPluginWorkerManager();
    const handle = await manager.startWorker(
      "test.plugin",
      workerOptions(() => undefined),
    );

    vi.useFakeTimers();
    const stop = manager.stopWorker("test.plugin");
    const stopped = expect(stop).rejects.toThrow("still alive after SIGKILL");
    await vi.runAllTimersAsync();

    await stopped;
    expect(manager.getWorker("test.plugin")).toBe(handle);
    expect(handle.status).toBe("stopping");
    expect(handle.diagnostics().pid).toBe(101);
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);

    child.exit(0, "SIGKILL");
    await flushAsyncWork();
    await expect(manager.stopWorker("test.plugin")).resolves.toBeUndefined();
    expect(manager.getWorker("test.plugin")).toBeUndefined();
  });

  it("records and schedules exactly one recovery path for an exit during restart", async () => {
    const first = new FakeChildProcess(201);
    const failedRestart = new FakeChildProcess(202, { crashOnInitialize: true });
    const recovered = new FakeChildProcess(203, { exitOnShutdown: true });
    forkMock
      .mockReturnValueOnce(first as unknown as ChildProcess)
      .mockReturnValueOnce(failedRestart as unknown as ChildProcess)
      .mockReturnValueOnce(recovered as unknown as ChildProcess);
    const handle = createPluginWorkerHandle(
      "test.plugin",
      workerOptions(() => undefined),
    );
    await handle.start();

    vi.useFakeTimers();
    first.exit(1, null);
    await flushAsyncWork();
    expect(handle.diagnostics()).toMatchObject({
      status: "backoff",
      totalCrashes: 1,
      consecutiveCrashes: 1,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await flushAsyncWork();
    expect(forkMock).toHaveBeenCalledTimes(2);
    expect(handle.diagnostics()).toMatchObject({
      status: "backoff",
      totalCrashes: 2,
      consecutiveCrashes: 2,
    });

    await vi.advanceTimersByTimeAsync(1_999);
    expect(forkMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await flushAsyncWork();
    expect(forkMock).toHaveBeenCalledTimes(3);
    expect(handle.status).toBe("running");

    await vi.advanceTimersByTimeAsync(10_000);
    expect(forkMock).toHaveBeenCalledTimes(3);
    await handle.stop();
  });

  it("makes terminal crash persistence retryable and awaits it before stopping", async () => {
    let resolvePersistence: (() => void) | null = null;
    const onTerminalCrash = vi.fn()
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockImplementationOnce(() => new Promise<void>((resolve) => {
        resolvePersistence = resolve;
      }));
    const first = new FakeChildProcess(301);
    forkMock.mockReturnValueOnce(first as unknown as ChildProcess);
    let nextPid = 302;
    forkMock.mockImplementation(() => (
      new FakeChildProcess(nextPid++, { crashOnInitialize: true }) as unknown as ChildProcess
    ));
    const handle = createPluginWorkerHandle(
      "test.plugin",
      workerOptions(onTerminalCrash),
    );
    await handle.start();

    vi.useFakeTimers();
    first.exit(1, null);
    await flushAsyncWork();
    while (handle.diagnostics().consecutiveCrashes <= 10) {
      const nextRestartAt = handle.diagnostics().nextRestartAt;
      expect(nextRestartAt).not.toBeNull();
      await vi.advanceTimersByTimeAsync(nextRestartAt! - Date.now());
      await flushAsyncWork();
    }
    expect(onTerminalCrash).toHaveBeenCalledTimes(1);
    await flushAsyncWork();

    let stopSettled = false;
    const stop = handle.stop().then(() => {
      stopSettled = true;
    });
    await flushAsyncWork();
    expect(onTerminalCrash).toHaveBeenCalledTimes(2);
    expect(stopSettled).toBe(false);

    resolvePersistence?.();
    await stop;
    expect(stopSettled).toBe(true);
    expect(handle.status).toBe("stopped");

    await expect(handle.start()).rejects.toThrow("Worker activation failed");
    await flushAsyncWork();
    expect(onTerminalCrash).toHaveBeenCalledTimes(2);
    await handle.stop();
  });
});
