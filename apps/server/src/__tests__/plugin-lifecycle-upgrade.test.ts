import { beforeEach, describe, expect, it, vi } from "vitest";

const pluginRecord = {
  id: "plugin-1",
  pluginKey: "example.plugin",
  status: "ready",
  manifestJson: {
    id: "example.plugin",
    version: "1.0.0",
    capabilities: [],
  },
  packageName: "@example/plugin",
  source: "local",
  packagePath: "/tmp/example-plugin",
};

const upgradedRecord = {
  ...pluginRecord,
  manifestJson: {
    ...pluginRecord.manifestJson,
    version: "1.1.0",
  },
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

function createLifecycle(loader: Partial<PluginLoader>) {
  return pluginLifecycleManager({} as never, {
    loader: loader as PluginLoader,
    dispatchRef: async () => undefined,
    issueExecutionCancellation: {} as never,
  });
}

describe("pluginLifecycleManager.upgrade", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRegistry.getById.mockResolvedValue(pluginRecord);
    mockRegistry.updateStatus.mockResolvedValue(upgradedRecord);
  });

  it("leaves the ready runtime untouched when candidate validation rejects", async () => {
    const loader: Partial<PluginLoader> = {
      prepareUpgrade: vi.fn().mockRejectedValue(
        new Error("introduces new capabilities that require approval"),
      ) as PluginLoader["prepareUpgrade"],
      unloadSingle: vi.fn() as PluginLoader["unloadSingle"],
      loadSingle: vi.fn() as PluginLoader["loadSingle"],
    };
    const lifecycle = createLifecycle(loader);

    await expect(lifecycle.upgrade("plugin-1", "1.1.0")).rejects.toThrow(
      "introduces new capabilities",
    );

    expect(loader.unloadSingle).not.toHaveBeenCalled();
    expect(loader.loadSingle).not.toHaveBeenCalled();
    expect(mockRegistry.updateStatus).not.toHaveBeenCalled();
  });

  it("replaces the runtime only after a compatible candidate commits", async () => {
    mockRegistry.getById
      .mockResolvedValueOnce(pluginRecord)
      .mockResolvedValue(upgradedRecord);
    const commit = vi.fn().mockResolvedValue(undefined);
    const loader: Partial<PluginLoader> = {
      prepareUpgrade: vi.fn().mockResolvedValue({
        previousPlugin: pluginRecord,
        oldManifest: pluginRecord.manifestJson,
        newManifest: upgradedRecord.manifestJson,
        commit,
        discard: vi.fn().mockResolvedValue(undefined),
      }) as PluginLoader["prepareUpgrade"],
      unloadSingle: vi.fn().mockResolvedValue(undefined) as PluginLoader["unloadSingle"],
      cleanupInstallArtifacts: vi.fn().mockResolvedValue(undefined) as PluginLoader["cleanupInstallArtifacts"],
      loadSingle: vi.fn().mockResolvedValue({
        plugin: upgradedRecord,
        success: true,
      }) as PluginLoader["loadSingle"],
    };
    const lifecycle = createLifecycle(loader);

    const result = await lifecycle.upgrade("plugin-1", "1.1.0");

    expect(result).toBe(upgradedRecord);
    expect(vi.mocked(loader.prepareUpgrade!).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(loader.unloadSingle!).mock.invocationCallOrder[0]!,
    );
    expect(vi.mocked(loader.unloadSingle!).mock.invocationCallOrder[0]).toBeLessThan(
      commit.mock.invocationCallOrder[0]!,
    );
    expect(commit.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(loader.loadSingle!).mock.invocationCallOrder[0]!,
    );
    expect(loader.unloadSingle).toHaveBeenCalledWith("plugin-1");
    expect(loader.cleanupInstallArtifacts).toHaveBeenCalledWith(pluginRecord);
    expect(loader.loadSingle).toHaveBeenCalledWith("plugin-1");
  });

  it("discards the candidate and records error authority when teardown fails", async () => {
    const commit = vi.fn();
    const discard = vi.fn().mockResolvedValue(undefined);
    const loader: Partial<PluginLoader> = {
      prepareUpgrade: vi.fn().mockResolvedValue({
        previousPlugin: pluginRecord,
        oldManifest: pluginRecord.manifestJson,
        newManifest: upgradedRecord.manifestJson,
        commit,
        discard,
      }) as PluginLoader["prepareUpgrade"],
      unloadSingle: vi.fn().mockRejectedValue(
        new Error("worker teardown failed"),
      ) as PluginLoader["unloadSingle"],
      cleanupInstallArtifacts: vi.fn(),
      loadSingle: vi.fn(),
    };
    const lifecycle = createLifecycle(loader);

    await expect(lifecycle.upgrade("plugin-1", "1.1.0")).rejects.toThrow(
      "worker teardown failed",
    );

    expect(commit).not.toHaveBeenCalled();
    expect(discard).toHaveBeenCalledOnce();
    expect(loader.cleanupInstallArtifacts).not.toHaveBeenCalled();
    expect(loader.loadSingle).not.toHaveBeenCalled();
    expect(mockRegistry.updateStatus).toHaveBeenCalledWith("plugin-1", {
      status: "error",
      lastError: "Plugin upgrade failed: worker teardown failed",
    });
  });

  it("discards an uncommitted candidate when durable replacement fails", async () => {
    const commit = vi.fn().mockRejectedValue(new Error("registry commit failed"));
    const discard = vi.fn().mockResolvedValue(undefined);
    const loader: Partial<PluginLoader> = {
      prepareUpgrade: vi.fn().mockResolvedValue({
        previousPlugin: pluginRecord,
        oldManifest: pluginRecord.manifestJson,
        newManifest: upgradedRecord.manifestJson,
        commit,
        discard,
      }) as PluginLoader["prepareUpgrade"],
      unloadSingle: vi.fn().mockResolvedValue(undefined),
      cleanupInstallArtifacts: vi.fn(),
      loadSingle: vi.fn(),
    };
    const lifecycle = createLifecycle(loader);

    await expect(lifecycle.upgrade("plugin-1", "1.1.0")).rejects.toThrow(
      "registry commit failed",
    );

    expect(discard).toHaveBeenCalledOnce();
    expect(loader.cleanupInstallArtifacts).not.toHaveBeenCalled();
    expect(loader.loadSingle).not.toHaveBeenCalled();
    expect(mockRegistry.updateStatus).toHaveBeenCalledWith("plugin-1", {
      status: "error",
      lastError: "Plugin upgrade failed: registry commit failed",
    });
  });
});
