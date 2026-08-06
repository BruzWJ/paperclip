import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const registry = vi.hoisted(() => ({
  getById: vi.fn(),
  getConfig: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({
  lockPluginInstallationInTransaction: vi.fn(),
  pluginRegistryService: () => registry,
}));

import {
  pluginLoader,
  type PluginRuntimeServices,
} from "../services/plugin-loader.js";
import type { HostClientHandlers } from "@paperclipai/plugin-sdk";

const loaderDb = {} as never;
const loaderOptions = {
  localPluginDir: path.join(os.tmpdir(), "paperclip-plugin-loader-binding-test"),
  migrationDb: loaderDb,
};
const tempRoots: string[] = [];

function runtimeServices() {
  const stop = vi.fn();
  const stopAll = vi.fn().mockResolvedValue(undefined);
  const stopWorker = vi.fn().mockResolvedValue(undefined);
  const startWorker = vi.fn().mockResolvedValue(undefined);
  const getWorker = vi.fn();
  const unregisterPlugin = vi.fn().mockResolvedValue(undefined);
  const registerPlugin = vi.fn().mockResolvedValue(undefined);
  const syncJobDeclarations = vi.fn().mockResolvedValue(undefined);
  const buildHostBinding = vi.fn();
  const services = {
    workerManager: {
      stopAll,
      stopWorker,
      startWorker,
      getWorker,
    },
    jobScheduler: {
      stop,
      registerPlugin,
      unregisterPlugin,
    },
    jobStore: {
      syncJobDeclarations,
    },
    lifecycleManager: {},
    buildHostBinding,
    instanceInfo: {
      instanceId: "instance-1",
      hostVersion: "1.0.0",
      deploymentExposure: "private",
    },
  } as unknown as PluginRuntimeServices;

  return {
    services,
    stop,
    stopAll,
    stopWorker,
    startWorker,
    getWorker,
    unregisterPlugin,
    registerPlugin,
    syncJobDeclarations,
    buildHostBinding,
  };
}

describe("pluginLoader runtime binding", () => {
  afterEach(async () => {
    vi.clearAllMocks();
    await Promise.all(
      tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("keeps the loader unbound until the runtime graph is explicitly bound", async () => {
    const loader = pluginLoader(loaderDb, loaderOptions);

    await expect(loader.loadAll()).rejects.toThrow(
      "Call bindRuntimeServices() before runtime activation",
    );

    const runtime = runtimeServices();
    loader.bindRuntimeServices(runtime.services);

    await loader.shutdownAll();
    expect(runtime.stop).toHaveBeenCalledTimes(1);
    expect(runtime.stopAll).toHaveBeenCalledTimes(1);
  });

  it("rejects replacing the bound runtime graph", () => {
    const loader = pluginLoader(loaderDb, loaderOptions);
    const first = runtimeServices();
    const replacement = runtimeServices();

    loader.bindRuntimeServices(first.services);

    expect(() => loader.bindRuntimeServices(replacement.services)).toThrow(
      "Plugin runtime services are already bound",
    );
  });

  it("fences job admission before stopping a worker in crash backoff", async () => {
    const loader = pluginLoader(loaderDb, loaderOptions);
    const runtime = runtimeServices();
    const order: string[] = [];
    runtime.getWorker.mockReturnValue({ status: "backoff" });
    runtime.stopWorker.mockImplementation(async () => {
      order.push("stop-worker");
    });
    runtime.unregisterPlugin.mockImplementation(async () => {
      order.push("unregister-jobs");
    });
    loader.bindRuntimeServices(runtime.services);

    await loader.unloadSingle("plugin-1");

    expect(runtime.unregisterPlugin).toHaveBeenCalledWith("plugin-1");
    expect(runtime.stopWorker).toHaveBeenCalledWith("plugin-1");
    expect(order).toEqual(["unregister-jobs", "stop-worker"]);
  });

  it("surfaces unload failures after attempting every cleanup step", async () => {
    const loader = pluginLoader(loaderDb, loaderOptions);
    const runtime = runtimeServices();
    runtime.getWorker.mockReturnValue({ status: "running" });
    runtime.stopWorker.mockRejectedValueOnce(new Error("worker failed"));
    loader.bindRuntimeServices(runtime.services);

    await expect(loader.unloadSingle("plugin-1")).rejects.toThrow(
      "Failed to completely unload plugin runtime",
    );
    expect(runtime.stopWorker).toHaveBeenCalledWith("plugin-1");
    expect(runtime.unregisterPlugin).toHaveBeenCalledWith("plugin-1");
  });

  it("keeps host calls available through worker drain then revokes the binding", async () => {
    const packagePath = await mkdtemp(path.join(os.tmpdir(), "paperclip-plugin-runtime-"));
    tempRoots.push(packagePath);
    await writeFile(path.join(packagePath, "worker.js"), "export default {};\n");

    const plugin = {
      id: "plugin-1",
      pluginKey: "paperclip.runtime-test",
      packageName: "@paperclip/runtime-test",
      source: "local",
      packagePath,
      manifestJson: {
        id: "paperclip.runtime-test",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Runtime Test",
        description: "Tests host authority revocation.",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: [],
        entrypoints: { worker: "worker.js" },
      },
      status: "ready",
      installOrder: 1,
      lastError: null,
      installedAt: new Date(),
      updatedAt: new Date(),
    };
    registry.getById.mockResolvedValue(plugin);
    registry.getConfig.mockResolvedValue(null);

    const configGet = vi.fn().mockResolvedValue({ enabled: true });
    const dispose = vi.fn().mockResolvedValue(undefined);
    const loader = pluginLoader(loaderDb, loaderOptions);
    const runtime = runtimeServices();
    runtime.buildHostBinding.mockReturnValue({
      handlers: { "config.get": configGet } as unknown as HostClientHandlers,
      dispose,
    });
    runtime.getWorker.mockReturnValue({ status: "running" });
    loader.bindRuntimeServices(runtime.services);

    await expect(loader.loadSingle(plugin.id)).resolves.toMatchObject({
      success: true,
    });
    expect(runtime.syncJobDeclarations).toHaveBeenCalledWith(plugin.id, []);
    expect(runtime.registerPlugin).not.toHaveBeenCalled();
    const workerOptions = runtime.startWorker.mock.calls[0]![1];
    const handlers = workerOptions.hostHandlers as HostClientHandlers;
    await expect(handlers["config.get"]({})).resolves.toEqual({ enabled: true });

    const teardownOrder: string[] = [];
    let releaseUnregister!: () => void;
    const unregisterGate = new Promise<void>((resolve) => {
      releaseUnregister = resolve;
    });
    runtime.unregisterPlugin.mockImplementationOnce(async () => {
      teardownOrder.push("fence-jobs");
      await unregisterGate;
      teardownOrder.push("unregister-jobs");
      throw new Error("scheduler teardown failed");
    });
    runtime.stopWorker.mockImplementationOnce(async () => {
      teardownOrder.push("stop-worker");
      await expect(handlers["config.get"]({})).resolves.toEqual({ enabled: true });
      releaseUnregister();
    });
    await expect(loader.unloadSingle(plugin.id)).rejects.toThrow(
      "Failed to completely unload plugin runtime",
    );

    await expect(handlers["config.get"]({})).rejects.toThrow(
      "Plugin host binding is revoked",
    );
    expect(teardownOrder).toEqual([
      "fence-jobs",
      "stop-worker",
      "unregister-jobs",
    ]);
    expect(configGet).toHaveBeenCalledTimes(2);
    expect(runtime.stopWorker).toHaveBeenCalledWith(plugin.id);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("does not finish shutdown until the activation-scoped host binding is disposed", async () => {
    const packagePath = await mkdtemp(path.join(os.tmpdir(), "paperclip-plugin-runtime-"));
    tempRoots.push(packagePath);
    await writeFile(path.join(packagePath, "worker.js"), "export default {};\n");

    registry.getById.mockResolvedValue({
      id: "plugin-1",
      pluginKey: "paperclip.runtime-test",
      packageName: "@paperclip/runtime-test",
      source: "local",
      packagePath,
      manifestJson: {
        id: "paperclip.runtime-test",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Runtime Test",
        description: "Tests activation-scoped cleanup.",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: [],
        entrypoints: { worker: "worker.js" },
      },
      status: "ready",
      installOrder: 1,
      lastError: null,
      installedAt: new Date(),
      updatedAt: new Date(),
    });
    registry.getConfig.mockResolvedValue(null);

    let signalDisposeStarted!: () => void;
    const disposeStarted = new Promise<void>((resolve) => {
      signalDisposeStarted = resolve;
    });
    let releaseDispose!: () => void;
    const dispose = vi.fn(() => new Promise<void>((resolve) => {
      signalDisposeStarted();
      releaseDispose = resolve;
    }));

    const loader = pluginLoader(loaderDb, loaderOptions);
    const runtime = runtimeServices();
    runtime.buildHostBinding.mockReturnValue({ handlers: {}, dispose });
    loader.bindRuntimeServices(runtime.services);

    await expect(loader.loadSingle("plugin-1")).resolves.toMatchObject({ success: true });

    let shutdownFinished = false;
    const shutdown = loader.shutdownAll().then(() => {
      shutdownFinished = true;
    });
    await disposeStarted;

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(shutdownFinished).toBe(false);

    releaseDispose();
    await shutdown;
    expect(shutdownFinished).toBe(true);
  });
});
