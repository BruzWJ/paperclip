import { describe, expect, it, vi } from "vitest";
import {
  pluginLoader,
  type PluginRuntimeServices,
} from "../services/plugin-loader.js";

function runtimeServices() {
  const stop = vi.fn();
  const stopAll = vi.fn().mockResolvedValue(undefined);
  const services = {
    workerManager: {
      stopAll,
    },
    eventBus: {},
    jobScheduler: {
      stop,
    },
    jobStore: {},
    toolDispatcher: {},
    lifecycleManager: {},
    buildHostHandlers: vi.fn(),
    instanceInfo: {
      instanceId: "instance-1",
      hostVersion: "1.0.0",
      deploymentExposure: "private",
    },
  } as unknown as PluginRuntimeServices;

  return { services, stop, stopAll };
}

describe("pluginLoader runtime binding", () => {
  it("keeps the loader unbound until the runtime graph is explicitly bound", async () => {
    const loader = pluginLoader({} as never);

    expect(loader.hasRuntimeServices()).toBe(false);
    await expect(loader.loadAll()).rejects.toThrow(
      "Call bindRuntimeServices() before runtime activation",
    );

    const runtime = runtimeServices();
    loader.bindRuntimeServices(runtime.services);

    expect(loader.hasRuntimeServices()).toBe(true);
    await loader.shutdownAll();
    expect(runtime.stop).toHaveBeenCalledTimes(1);
    expect(runtime.stopAll).toHaveBeenCalledTimes(1);
  });

  it("rejects replacing the bound runtime graph", () => {
    const loader = pluginLoader({} as never);
    const first = runtimeServices();
    const replacement = runtimeServices();

    loader.bindRuntimeServices(first.services);

    expect(() => loader.bindRuntimeServices(replacement.services)).toThrow(
      "Plugin runtime services are already bound",
    );
  });
});
