import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";

const chokidarMock = vi.hoisted(() => ({
  watch: vi.fn(),
}));

vi.mock("chokidar", () => ({
  default: chokidarMock,
}));

import { createPluginDevWatcher, resolvePluginWatchTargets } from "../services/plugin-dev-watcher.js";

const tempDirs: string[] = [];

const TEST_MANIFEST: PaperclipPluginManifestV1 = {
  id: "acme.example",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Example",
  description: "Example plugin",
  author: "Acme",
  categories: ["automation"],
  capabilities: [],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
};

beforeEach(() => {
  vi.useRealTimers();
  chokidarMock.watch.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempPluginDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "paperclip-plugin-watch-"));
  tempDirs.push(dir);
  return dir;
}

function writePluginPackage(pluginDir: string): void {
  mkdirSync(path.join(pluginDir, "dist", "ui"), { recursive: true });
  writeFileSync(
    path.join(pluginDir, "package.json"),
    JSON.stringify({
      name: "@acme/example",
      paperclipPlugin: {
        manifest: "./dist/manifest.js",
      },
    }),
  );
  writeFileSync(path.join(pluginDir, "dist", "manifest.js"), "export default {};\n");
  writeFileSync(path.join(pluginDir, "dist", "worker.js"), "export default {};\n");
  writeFileSync(path.join(pluginDir, "dist", "ui", "index.js"), "export default {};\n");
  writeFileSync(path.join(pluginDir, "dist", "ui", "index.css"), "body {}\n");
}

function createLifecycle() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    reloadRuntime: vi.fn().mockResolvedValue(undefined),
  });
}

function installMockFsWatcher() {
  const handlers: Record<string, (...args: unknown[]) => void> = {};
  const fakeWatcher = {
    close: vi.fn(),
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      handlers[event] = listener;
      return fakeWatcher;
    }),
  };
  chokidarMock.watch.mockReturnValue(fakeWatcher);
  return { fakeWatcher, handlers };
}

describe("resolvePluginWatchTargets", () => {
  it("watches only the worker artifact consumed by a runtime reload", () => {
    const pluginDir = makeTempPluginDir();
    writePluginPackage(pluginDir);

    const targets = resolvePluginWatchTargets(pluginDir, TEST_MANIFEST);

    expect(targets).toEqual([path.join(pluginDir, "dist", "worker.js")]);
  });

  it("rejects a worker target outside the package root", () => {
    const pluginDir = makeTempPluginDir();
    writePluginPackage(pluginDir);

    expect(() => resolvePluginWatchTargets(pluginDir, {
      ...TEST_MANIFEST,
      entrypoints: { worker: "../worker.js" },
    })).toThrow(
      "manifest.entrypoints.worker",
    );
  });
});

describe("createPluginDevWatcher", () => {
  it("starts watching local plugins announced by lifecycle events", async () => {
    const pluginDir = makeTempPluginDir();
    writePluginPackage(pluginDir);
    installMockFsWatcher();
    const lifecycle = createLifecycle();

    const devWatcher = createPluginDevWatcher(
      lifecycle as never,
      async (pluginId) => pluginId === "plugin-1"
        ? { packagePath: pluginDir, manifest: TEST_MANIFEST }
        : null,
    );

    lifecycle.emit("plugin.activated", { pluginId: "plugin-1" });

    await vi.waitFor(() => expect(chokidarMock.watch).toHaveBeenCalledTimes(1));
    const [watchedPaths] = chokidarMock.watch.mock.calls[0] ?? [];
    expect(watchedPaths).toContain(path.join(pluginDir, "dist", "worker.js"));

    await devWatcher.close();
  });

  it("does not start a late watcher after the plugin is deactivated", async () => {
    const pluginDir = makeTempPluginDir();
    writePluginPackage(pluginDir);
    installMockFsWatcher();
    const lifecycle = createLifecycle();
    let resolveSource!: (source: {
      packagePath: string;
      manifest: PaperclipPluginManifestV1;
    }) => void;
    const source = new Promise<{
      packagePath: string;
      manifest: PaperclipPluginManifestV1;
    }>((resolve) => {
      resolveSource = resolve;
    });

    const devWatcher = createPluginDevWatcher(
      lifecycle as never,
      async () => source,
    );
    lifecycle.emit("plugin.activated", { pluginId: "plugin-1" });
    lifecycle.emit("plugin.deactivated", { pluginId: "plugin-1" });
    resolveSource({ packagePath: pluginDir, manifest: TEST_MANIFEST });
    await source;
    await Promise.resolve();

    expect(chokidarMock.watch).not.toHaveBeenCalled();
    await devWatcher.close();
  });

  it("debounces watched file changes and reloads the plugin runtime", async () => {
    vi.useFakeTimers();
    const pluginDir = makeTempPluginDir();
    writePluginPackage(pluginDir);
    const { handlers } = installMockFsWatcher();
    const lifecycle = createLifecycle();

    const devWatcher = createPluginDevWatcher(
      lifecycle as never,
      async () => ({ packagePath: pluginDir, manifest: TEST_MANIFEST }),
    );
    lifecycle.emit("plugin.activated", { pluginId: "plugin-1" });
    await vi.waitFor(() => expect(chokidarMock.watch).toHaveBeenCalledTimes(1));

    handlers.all?.("change", path.join(pluginDir, "dist", "worker.js"));
    await vi.advanceTimersByTimeAsync(500);

    expect(lifecycle.reloadRuntime).toHaveBeenCalledWith("plugin-1");

    await devWatcher.close();
  });
});
