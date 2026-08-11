import { beforeEach, describe, expect, it, vi } from "vitest";

const registry = vi.hoisted(() => ({
  getById: vi.fn(),
  updateStatus: vi.fn(),
  upsertConfig: vi.fn(),
}));

const persistence = vi.hoisted(() => ({
  lock: vi.fn(),
  persistStatus: vi.fn(),
  deleteInstallation: vi.fn(),
  pauseManagedAgents: vi.fn(),
  terminalizeCreatorEdges: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => registry,
  lockPluginInstallationInTransaction: persistence.lock,
  persistPluginStatusInTransaction: persistence.persistStatus,
  deletePluginInstallationInTransaction: persistence.deleteInstallation,
}));

vi.mock("../services/plugin-managed-agents.js", () => ({
  pausePluginManagedAgentsIntoTriageInTransaction:
    persistence.pauseManagedAgents,
}));

vi.mock("../services/task-session/admission.js", () => ({
  createTaskSessionAdmissionService: () => ({}),
}));

vi.mock("../services/system-escalation-postgres.js", () => ({
  terminalizePluginCreatorEdgesInTransaction:
    persistence.terminalizeCreatorEdges,
}));

import { pluginLifecycleManager } from "../services/plugin-lifecycle.js";
import type { PluginLoader } from "../services/plugin-loader.js";

const basePlugin = {
  id: "plugin-1",
  pluginKey: "example.plugin",
  status: "ready",
  lastError: null,
  manifestJson: {
    id: "example.plugin",
    apiVersion: 1,
    version: "1.0.0",
    capabilities: [],
    entrypoints: { worker: "worker.js" },
  },
  packageName: "@example/plugin",
  source: "npm",
  packagePath: "/tmp/example-plugin",
  installOrder: 1,
  installedAt: new Date(),
  updatedAt: new Date(),
};

let currentPlugin: typeof basePlugin;
let installationDeleted: boolean;

function createLifecycle(
  loader: Partial<PluginLoader>,
  reconcileRequestedCancellations = vi.fn().mockResolvedValue(undefined),
) {
  const db = {
    transaction: vi.fn(async (operation: (tx: unknown) => Promise<unknown>) =>
      operation({}),
    ),
  };
  return pluginLifecycleManager(db as never, {
    loader: loader as PluginLoader,
    dispatchRef: async () => undefined,
    taskExecutionCancellation: {
      reconcileRequestedCancellations,
    } as never,
  });
}

describe("canonical plugin lifecycle operations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentPlugin = { ...basePlugin };
    installationDeleted = false;
    registry.getById.mockImplementation(async () =>
      installationDeleted ? null : currentPlugin,
    );
    registry.updateStatus.mockImplementation(async (_id, update) => {
      currentPlugin = { ...currentPlugin, ...update, updatedAt: new Date() };
      return currentPlugin;
    });
    registry.upsertConfig.mockImplementation(async (pluginId, configJson) => ({
      id: "config-1",
      pluginId,
      configJson,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
    persistence.lock.mockImplementation(async () => currentPlugin);
    persistence.persistStatus.mockImplementation(async (_tx, _id, update) => {
      currentPlugin = { ...currentPlugin, ...update, updatedAt: new Date() };
      return currentPlugin;
    });
    persistence.pauseManagedAgents.mockResolvedValue({ suspensionRequests: [] });
    persistence.terminalizeCreatorEdges.mockResolvedValue([]);
    persistence.deleteInstallation.mockImplementation(async () => {
      if (installationDeleted) return null;
      installationDeleted = true;
      return currentPlugin;
    });
  });

  it("does not activate a newly installed plugin that requires configuration", async () => {
    const disabledPlugin = { ...basePlugin, status: "disabled" as const };
    const loader: Partial<PluginLoader> = {
      installPlugin: vi.fn().mockResolvedValue(disabledPlugin),
      loadSingle: vi.fn(),
    };
    const lifecycle = createLifecycle(loader);

    const result = await lifecycle.install({
      source: "npm",
      packageName: "@example/plugin",
    });

    expect(result).toBe(disabledPlugin);
    expect(loader.loadSingle).not.toHaveBeenCalled();
  });

  it("serializes overlapping runtime replacements for one installation", async () => {
    let releaseFirst!: () => void;
    let markFirstEntered!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      markFirstEntered = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const prepareUpgrade = vi.fn(async () => {
      if (prepareUpgrade.mock.calls.length === 1) {
        markFirstEntered();
        await firstGate;
      }
      return {
        previousPlugin: basePlugin,
        oldManifest: basePlugin.manifestJson,
        newManifest: { ...basePlugin.manifestJson, version: "1.1.0" },
        commit: vi.fn().mockResolvedValue(undefined),
        discard: vi.fn().mockResolvedValue(undefined),
      };
    });
    const loader: Partial<PluginLoader> = {
      prepareUpgrade: prepareUpgrade as PluginLoader["prepareUpgrade"],
      unloadSingle: vi.fn().mockResolvedValue(undefined),
      cleanupInstallArtifacts: vi.fn().mockResolvedValue(undefined),
      loadSingle: vi.fn().mockResolvedValue({
        plugin: basePlugin,
        success: true,
      }),
    };
    const lifecycle = createLifecycle(loader);

    const first = lifecycle.upgrade(basePlugin.id, "1.1.0");
    await firstEntered;
    const second = lifecycle.upgrade(basePlugin.id, "1.2.0");
    await Promise.resolve();

    expect(prepareUpgrade).toHaveBeenCalledTimes(1);
    releaseFirst();
    await Promise.all([first, second]);
    expect(prepareUpgrade).toHaveBeenCalledTimes(2);
  });

  it.each(["disabled", "error"] as const)(
    "persists config without activating a %s plugin",
    async (status) => {
      currentPlugin = { ...basePlugin, status };
      const loader: Partial<PluginLoader> = {
        unloadSingle: vi.fn(),
        loadSingle: vi.fn(),
      };
      const lifecycle = createLifecycle(loader);

      const saved = await lifecycle.updateConfig(basePlugin.id, {
        endpoint: "https://service.example",
      });

      expect(saved.configJson).toEqual({ endpoint: "https://service.example" });
      expect(registry.upsertConfig).toHaveBeenCalledOnce();
      expect(loader.unloadSingle).not.toHaveBeenCalled();
      expect(loader.loadSingle).not.toHaveBeenCalled();
      expect(currentPlugin.status).toBe(status);
    },
  );

  it("retries disabled-runtime teardown without repeating the authority transition", async () => {
    const unloadSingle = vi.fn()
      .mockRejectedValueOnce(new Error("worker did not stop"))
      .mockResolvedValueOnce(undefined);
    const loader: Partial<PluginLoader> = { unloadSingle };
    const lifecycle = createLifecycle(loader);

    await expect(lifecycle.disable(basePlugin.id)).rejects.toThrow(
      "worker did not stop",
    );
    expect(currentPlugin.status).toBe("disabled");

    await expect(lifecycle.disable(basePlugin.id)).resolves.toMatchObject({
      status: "disabled",
    });

    expect(unloadSingle).toHaveBeenCalledTimes(2);
    expect(persistence.persistStatus).toHaveBeenCalledTimes(1);
    expect(persistence.pauseManagedAgents).toHaveBeenCalledTimes(1);
    expect(persistence.terminalizeCreatorEdges).toHaveBeenCalledTimes(1);
  });

  it("drains the runtime while durable recovery owns a failed post-commit notification", async () => {
    const suspensionRequest = { companyId: "company-1", requests: [] };
    persistence.pauseManagedAgents.mockResolvedValue({
      suspensionRequests: [suspensionRequest],
    });
    const reconcile = vi.fn().mockRejectedValue(
      new Error("suspension reconciliation failed"),
    );
    const unloadSingle = vi.fn().mockResolvedValue(undefined);
    const lifecycle = createLifecycle({ unloadSingle }, reconcile);

    await expect(lifecycle.disable(basePlugin.id)).resolves.toMatchObject({
      status: "disabled",
    });

    expect(currentPlugin.status).toBe("disabled");
    expect(unloadSingle).toHaveBeenCalledWith(basePlugin.id);
    expect(reconcile).toHaveBeenCalledWith(suspensionRequest);
  });

  it("finishes stale teardown before an enabled plugin regains ready authority", async () => {
    currentPlugin = { ...basePlugin, status: "disabled" };
    const unloadSingle = vi.fn()
      .mockRejectedValueOnce(new Error("binding disposal failed"))
      .mockResolvedValueOnce(undefined);
    const loadSingle = vi.fn().mockResolvedValue({
      plugin: basePlugin,
      success: true,
    });
    const loader: Partial<PluginLoader> = { unloadSingle, loadSingle };
    const lifecycle = createLifecycle(loader);

    await expect(lifecycle.enable(basePlugin.id)).rejects.toThrow(
      "binding disposal failed",
    );
    expect(currentPlugin.status).toBe("disabled");
    expect(registry.updateStatus).not.toHaveBeenCalled();
    expect(loadSingle).not.toHaveBeenCalled();

    await expect(lifecycle.enable(basePlugin.id)).resolves.toMatchObject({
      status: "ready",
    });
    expect(unloadSingle).toHaveBeenCalledTimes(2);
    expect(unloadSingle.mock.invocationCallOrder[1]).toBeLessThan(
      registry.updateStatus.mock.invocationCallOrder[0]!,
    );
    expect(registry.updateStatus.mock.invocationCallOrder[0]).toBeLessThan(
      loadSingle.mock.invocationCallOrder[0]!,
    );
  });

  it("does not persist ready-plugin config when runtime teardown fails", async () => {
    const unloadSingle = vi.fn().mockRejectedValue(
      new Error("runtime drain failed"),
    );
    const loadSingle = vi.fn();
    const loader: Partial<PluginLoader> = { unloadSingle, loadSingle };
    const lifecycle = createLifecycle(loader);

    await expect(
      lifecycle.updateConfig(basePlugin.id, { endpoint: "https://new.example" }),
    ).rejects.toThrow("runtime drain failed");

    expect(registry.upsertConfig).not.toHaveBeenCalled();
    expect(loadSingle).not.toHaveBeenCalled();
    expect(currentPlugin.status).toBe("error");
    expect(registry.updateStatus).toHaveBeenCalledWith(basePlugin.id, {
      status: "error",
      lastError: "Plugin configuration update failed: runtime drain failed",
    });
  });

  it("persists ready-plugin config only between runtime drain and activation", async () => {
    const unloadSingle = vi.fn().mockResolvedValue(undefined);
    const loadSingle = vi.fn().mockResolvedValue({
      plugin: basePlugin,
      success: true,
    });
    const loader: Partial<PluginLoader> = { unloadSingle, loadSingle };
    const lifecycle = createLifecycle(loader);

    await lifecycle.updateConfig(basePlugin.id, {
      endpoint: "https://new.example",
    });

    expect(unloadSingle.mock.invocationCallOrder[0]).toBeLessThan(
      registry.upsertConfig.mock.invocationCallOrder[0]!,
    );
    expect(registry.upsertConfig.mock.invocationCallOrder[0]).toBeLessThan(
      loadSingle.mock.invocationCallOrder[0]!,
    );
  });

  it("leaves a live disabled row when uninstall cleanup fails so retry can finish", async () => {
    const cleanupInstallArtifacts = vi.fn()
      .mockRejectedValueOnce(new Error("filesystem busy"))
      .mockResolvedValueOnce(undefined);
    const loader: Partial<PluginLoader> = {
      unloadSingle: vi.fn().mockResolvedValue(undefined),
      cleanupInstallArtifacts,
    };
    const lifecycle = createLifecycle(loader);

    await expect(lifecycle.unload(basePlugin.id)).rejects.toThrow("filesystem busy");
    expect(currentPlugin.status).toBe("disabled");

    const deleted = await lifecycle.unload(basePlugin.id);

    expect(deleted).toMatchObject({ id: basePlugin.id, status: "disabled" });
    expect(cleanupInstallArtifacts).toHaveBeenCalledTimes(2);
    expect(persistence.pauseManagedAgents).toHaveBeenCalledTimes(1);
    expect(persistence.terminalizeCreatorEdges).toHaveBeenCalledTimes(1);
    expect(persistence.persistStatus.mock.calls.map((call) => call[2].status))
      .toEqual(["disabled"]);

    await expect(lifecycle.unload(basePlugin.id)).resolves.toBeNull();
    expect(cleanupInstallArtifacts).toHaveBeenCalledTimes(2);
    expect(persistence.deleteInstallation).toHaveBeenCalledTimes(1);
  });
});
