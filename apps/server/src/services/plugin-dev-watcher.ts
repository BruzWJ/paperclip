/**
 * PluginDevWatcher — watches local-path plugin directories for file changes
 * and triggers complete runtime reloads so plugin authors get a fast rebuild-and-reload
 * cycle without manually restarting the server.
 *
 * Only installations whose persisted source is `local` are passed to this
 * watcher.
 *
 * Uses chokidar rather than raw fs.watch so we get a production-grade watcher
 * backend across platforms and avoid exhausting file descriptors as quickly in
 * large dev workspaces.
 *
 * @see PLUGIN_SPEC.md §27.2 — Local Development Workflow
 */
import chokidar, { type FSWatcher } from "chokidar";
import path from "node:path";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import type { PluginLifecycleManager } from "./plugin-lifecycle.js";
import { resolvePluginPath } from "./plugin-paths.js";

const log = logger.child({ service: "plugin-dev-watcher" });

/** Debounce interval for file changes (ms). */
const DEBOUNCE_MS = 500;

interface PluginDevWatcher {
  /** Stop all watchers and clean up. */
  close(): Promise<void>;
}

interface PluginDevWatchSource {
  packagePath: string;
  manifest: PaperclipPluginManifestV1;
}

type ResolveLocalPluginSource = (
  pluginId: string,
) => Promise<PluginDevWatchSource | null>;

export function resolvePluginWatchTargets(
  packagePath: string,
  manifest: PaperclipPluginManifestV1,
): string[] {
  return [resolvePluginPath(
    packagePath,
    manifest.entrypoints.worker,
    { label: "manifest.entrypoints.worker", kind: "file" },
  )];
}

/**
 * Create a PluginDevWatcher that monitors local plugin directories and
 * reloads plugin runtimes on file changes.
 */
export function createPluginDevWatcher(
  lifecycle: PluginLifecycleManager,
  resolveLocalPluginSource: ResolveLocalPluginSource,
): PluginDevWatcher {
  const watchers = new Map<string, FSWatcher>();
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const activePluginIds = new Set<string>();
  let closed = false;
  log.info("plugin-dev-watcher: initialized");

  function watchPlugin(pluginId: string, source: PluginDevWatchSource): void {
    if (closed) return;
    // Don't double-watch
    if (watchers.has(pluginId)) return;

    const absPath = path.resolve(source.packagePath);

    try {
      const watcherTargets = resolvePluginWatchTargets(absPath, source.manifest);
      const watcher = chokidar.watch(
        watcherTargets,
        {
          ignoreInitial: true,
          awaitWriteFinish: {
            stabilityThreshold: 200,
            pollInterval: 100,
          },
          followSymlinks: false,
        },
      );

      watcher.on("all", (_eventName, changedPath) => {
        const relativePath = path.relative(absPath, changedPath);

        const existing = debounceTimers.get(pluginId);
        if (existing) clearTimeout(existing);

        debounceTimers.set(
          pluginId,
          setTimeout(() => {
            debounceTimers.delete(pluginId);
            log.info(
              { pluginId, changedFile: relativePath || path.basename(changedPath) },
              "plugin-dev-watcher: file change detected, reloading plugin runtime",
            );

            lifecycle.reloadRuntime(pluginId).catch((err) => {
              log.warn(
                {
                  pluginId,
                  err: err instanceof Error ? err.message : String(err),
                },
                "plugin-dev-watcher: failed to reload plugin runtime after file change",
              );
            });
          }, DEBOUNCE_MS),
        );
      });

      watcher.on("error", (err) => {
        log.warn(
          {
            pluginId,
            packagePath: absPath,
            err: err instanceof Error ? err.message : String(err),
          },
          "plugin-dev-watcher: watcher error, stopping watch for this plugin",
        );
        void unwatchPlugin(pluginId);
      });

      watchers.set(pluginId, watcher);
      log.info(
        {
          pluginId,
          packagePath: absPath,
          watchTargets: watcherTargets,
        },
        "plugin-dev-watcher: watching local plugin for changes",
      );
    } catch (err) {
      log.warn(
        {
          pluginId,
          packagePath: absPath,
          err: err instanceof Error ? err.message : String(err),
        },
        "plugin-dev-watcher: failed to start file watcher",
      );
    }
  }

  async function unwatchPlugin(pluginId: string): Promise<void> {
    const pluginWatcher = watchers.get(pluginId);
    if (pluginWatcher) {
      watchers.delete(pluginId);
      await pluginWatcher.close();
    }
    const timer = debounceTimers.get(pluginId);
    if (timer) {
      clearTimeout(timer);
      debounceTimers.delete(pluginId);
    }
  }

  async function close(): Promise<void> {
    closed = true;
    activePluginIds.clear();
    lifecycle.off("plugin.activated", handlePluginActivated);
    lifecycle.off("plugin.deactivated", handlePluginDeactivated);

    await Promise.all([...watchers.keys()].map(unwatchPlugin));
  }

  async function watchLocalPluginById(pluginId: string): Promise<void> {
    try {
      const source = await resolveLocalPluginSource(pluginId);
      if (closed || !activePluginIds.has(pluginId)) return;
      if (!source) {
        log.debug(
          { pluginId },
          "plugin-dev-watcher: plugin is not a local-path install, skipping watch",
        );
        return;
      }
      watchPlugin(pluginId, source);
    } catch (err) {
      log.warn(
        {
          pluginId,
          err: err instanceof Error ? err.message : String(err),
        },
        "plugin-dev-watcher: failed to resolve plugin package path",
      );
    }
  }

  function handlePluginActivated(payload: { pluginId: string }): void {
    activePluginIds.add(payload.pluginId);
    void watchLocalPluginById(payload.pluginId);
  }

  function handlePluginDeactivated(payload: { pluginId: string }): void {
    activePluginIds.delete(payload.pluginId);
    void unwatchPlugin(payload.pluginId);
  }

  lifecycle.on("plugin.activated", handlePluginActivated);
  lifecycle.on("plugin.deactivated", handlePluginDeactivated);

  return {
    close,
  };
}
