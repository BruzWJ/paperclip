/**
 * `reloadRuntime` reloads the complete plugin runtime so manifest changes
 * and pending migrations are applied before the replacement worker starts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const pluginRecord = {
  id: "plugin-1",
  pluginKey: "example.plugin",
  status: "ready",
  manifestJson: { id: "example.plugin", version: "1.0.0", capabilities: [] },
  packageName: "@example/plugin",
  packagePath: "/tmp/example-plugin",
};

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(),
  updateStatus: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockRegistry,
}));

import { pluginLifecycleManager } from "../services/plugin-lifecycle.js";
import type { PluginLoader } from "../services/plugin-loader.js";

describe("pluginLifecycleManager.reloadRuntime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRegistry.getById.mockResolvedValue(pluginRecord);
  });

  it("always performs one full deactivate/reactivate cycle", async () => {
    const loader: Partial<PluginLoader> = {
      loadSingle: vi.fn().mockResolvedValue({
        success: true,
        plugin: pluginRecord,
      }) as PluginLoader["loadSingle"],
      unloadSingle: vi.fn().mockResolvedValue(undefined) as PluginLoader["unloadSingle"],
    };
    const lifecycle = pluginLifecycleManager({} as never, {
      loader: loader as PluginLoader,
      dispatchRef: async () => undefined,
      taskExecutionCancellation: {} as never,
    });
    const deactivated = vi.fn();
    const activated = vi.fn();
    lifecycle.on("plugin.deactivated", deactivated);
    lifecycle.on("plugin.activated", activated);

    await lifecycle.reloadRuntime("plugin-1");

    expect(loader.unloadSingle).toHaveBeenCalledWith("plugin-1");
    expect(loader.loadSingle).toHaveBeenCalledWith("plugin-1");
    expect(deactivated).toHaveBeenCalledWith({ pluginId: "plugin-1" });
    expect(activated).toHaveBeenCalledWith({ pluginId: "plugin-1" });
  });

  it("persists one lifecycle-owned error transition when reactivation fails", async () => {
    const erroredPlugin = {
      ...pluginRecord,
      status: "error",
      lastError: "Activation failed: worker initialization failed",
    };
    mockRegistry.updateStatus.mockResolvedValue(erroredPlugin);
    const loader: Partial<PluginLoader> = {
      loadSingle: vi.fn().mockResolvedValue({
        success: false,
        plugin: pluginRecord,
        error: "worker initialization failed",
      }) as PluginLoader["loadSingle"],
      unloadSingle: vi.fn().mockResolvedValue(undefined) as PluginLoader["unloadSingle"],
    };
    const lifecycle = pluginLifecycleManager({} as never, {
      loader: loader as PluginLoader,
      dispatchRef: async () => undefined,
      taskExecutionCancellation: {} as never,
    });
    const activated = vi.fn();
    lifecycle.on("plugin.activated", activated);

    await expect(lifecycle.reloadRuntime("plugin-1")).rejects.toThrow(
      "worker initialization failed",
    );

    expect(mockRegistry.updateStatus).toHaveBeenCalledTimes(1);
    expect(mockRegistry.updateStatus).toHaveBeenCalledWith("plugin-1", {
      status: "error",
      lastError: "Activation failed: worker initialization failed",
    });
    expect(activated).not.toHaveBeenCalled();
  });

  it("persists startup activation failures without asking the loader to mutate status", async () => {
    const erroredPlugin = {
      ...pluginRecord,
      status: "error",
      lastError: "Activation failed: missing worker entrypoint",
    };
    mockRegistry.updateStatus.mockResolvedValue(erroredPlugin);
    const loader: Partial<PluginLoader> = {
      loadAll: vi.fn().mockResolvedValue({
        total: 1,
        succeeded: 0,
        failed: 1,
        results: [{
          success: false,
          plugin: pluginRecord,
          error: "missing worker entrypoint",
        }],
      }) as PluginLoader["loadAll"],
    };
    const lifecycle = pluginLifecycleManager({} as never, {
      loader: loader as PluginLoader,
      dispatchRef: async () => undefined,
      taskExecutionCancellation: {} as never,
    });

    await lifecycle.activateReadyPlugins();

    expect(mockRegistry.updateStatus).toHaveBeenCalledTimes(1);
    expect(mockRegistry.updateStatus).toHaveBeenCalledWith("plugin-1", {
      status: "error",
      lastError: "Activation failed: missing worker entrypoint",
    });
  });
});
