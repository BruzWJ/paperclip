import type { Db } from "@paperclipai/db";
import type { HostClientHandlers } from "@paperclipai/plugin-sdk";
import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { logger } from "../middleware/logger.js";
import { buildPluginLoaderActivation } from "./plugin-loader-activation.js";
import type { PluginLoadAllResult, PluginLoader, PluginLoadResult } from "./plugin-loader-contracts.js";
import {
  type PluginHostBinding,
  type PluginLoaderOptions,
  type PluginRuntimeServices,
} from "./plugin-loader-contracts.js";
import { buildPluginLoaderDiscovery } from "./plugin-loader-discovery.js";
import { isManagedInstallRootName, resolveManagedInstallRoot } from "./plugin-loader-runtime-lifecycle.js";
import { createPluginLoaderMethods1 } from "./plugin-loader-methods-1.js";
import { buildPluginLoaderRuntimeLifecycle } from "./plugin-loader-runtime-lifecycle.js";
import { pluginRegistryService } from "./plugin-registry.js";

export function createPluginLoaderContext(db: Db, options: PluginLoaderOptions) {
  const localPluginDir = path.resolve(options.localPluginDir);

  const migrationDb = options.migrationDb;

  const registry = pluginRegistryService(db);

  const log = logger.child({ service: "plugin-loader" });

  // Helper scopes are composed with object spreads in pluginLoader(). Keep
  // late-bound runtime services behind a shared reference so every helper
  // observes the same binding after those spreads copy the context fields.
  const runtimeServicesRef = {
    current: undefined as PluginRuntimeServices | undefined,
  };

  const activeHostBindings = new Map<
    string,
    {
      pluginKey: string;
      binding: PluginHostBinding;
      handlers: HostClientHandlers;
      revoke(): void;
    }
  >();

  return {
    db,
    options,
    localPluginDir,
    migrationDb,
    registry,
    log,
    runtimeServicesRef,
    activeHostBindings,
  };
}

export type PluginLoaderContext = ReturnType<typeof createPluginLoaderContext>;

export function createPluginLoaderMethods2(
  scope: PluginLoaderContext &
    ReturnType<typeof buildPluginLoaderRuntimeLifecycle> &
    ReturnType<typeof buildPluginLoaderDiscovery> &
    ReturnType<typeof buildPluginLoaderActivation>,
) {
  const {
    localPluginDir,
    registry,
    log,
    activeHostBindings,
    requireRuntimeServices,
    disposeHostBinding,
    unloadPluginRuntime,
    activatePlugin,
  } = scope;

  return {
    // -----------------------------------------------------------------------
    // loadAll
    // -----------------------------------------------------------------------

    /**
     * loadAll — Loads and activates all plugins that are currently in 'ready' status.
     *
     * This method is typically called during server startup. It fetches all ready
     * plugins from the registry and activates them in parallel. Each activation
     * returns its own success/failure result after complete partial cleanup.
     *
     * @returns A promise that resolves with summary statistics of the load operation.
     */
    async loadAll(): Promise<PluginLoadAllResult> {
      const services = requireRuntimeServices("loadAll");

      log.info("plugin-loader: loading all ready plugins");

      const cancelledRuns = await services.jobStore.cancelAllNonTerminalRuns(
        "Paperclip restarted before plugin job completed",
      );
      if (cancelledRuns > 0) {
        log.warn({ cancelledRuns }, "plugin-loader: cancelled interrupted plugin job runs");
      }

      const failedDeliveries = await registry.failInterruptedWebhookDeliveries(
        "Paperclip restarted before webhook delivery completed",
      );
      if (failedDeliveries > 0) {
        log.warn({ failedDeliveries }, "plugin-loader: failed interrupted webhook deliveries");
      }

      // Crash-safe reconciliation: install candidates are immutable roots and
      // only registry-referenced roots are live. A crash before persistence or
      // after uninstall cleanup therefore leaves a safely removable orphan.
      if (existsSync(localPluginDir)) {
        const livePlugins = await registry.list();
        const referencedRoots = new Set(
          livePlugins
            .filter((plugin) => plugin.source === "npm")
            .map((plugin) =>
              resolveManagedInstallRoot(localPluginDir, plugin.packagePath, plugin.packageName),
            ),
        );
        const entries = await readdir(localPluginDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory() || !isManagedInstallRootName(entry.name)) continue;
          const installRoot = path.resolve(localPluginDir, entry.name);
          if (!referencedRoots.has(installRoot)) {
            await rm(installRoot, { recursive: true, force: true });
          }
        }
      }

      // Fetch all plugins in ready status, ordered by installOrder
      const readyPlugins = await registry.listByStatus("ready");

      if (readyPlugins.length === 0) {
        log.info("plugin-loader: no ready plugins to load");
        return { total: 0, succeeded: 0, failed: 0, results: [] };
      }

      log.info({ count: readyPlugins.length }, "plugin-loader: found ready plugins to load");

      const loadResults = await Promise.all(readyPlugins.map((plugin) => activatePlugin(plugin)));

      const succeeded = loadResults.filter((r) => r.success).length;
      const failed = loadResults.filter((r) => !r.success).length;

      log.info(
        {
          total: readyPlugins.length,
          succeeded,
          failed,
        },
        "plugin-loader: loadAll complete",
      );

      return {
        total: readyPlugins.length,
        succeeded,
        failed,
        results: loadResults,
      };
    },

    // -----------------------------------------------------------------------
    // loadSingle
    // -----------------------------------------------------------------------

    /**
     * loadSingle — Loads and activates a single plugin by its ID.
     *
     * This method retrieves the plugin from the registry, ensures it's in a valid
     * state, and then calls activatePlugin to start its worker and register its
     * capabilities (tools, jobs, etc.).
     *
     * @param pluginId - The UUID of the plugin to load.
     * @returns A promise that resolves with the result of the activation.
     */
    async loadSingle(pluginId: string): Promise<PluginLoadResult> {
      requireRuntimeServices("loadSingle");

      const plugin = await registry.getById(pluginId);
      if (!plugin) {
        throw new Error(`Plugin not found: ${pluginId}`);
      }

      if (plugin.status !== "ready") {
        throw new Error(
          `Cannot load plugin in status '${plugin.status}'. ` + `Plugin must be in 'ready' status.`,
        );
      }

      return activatePlugin(plugin);
    },

    // -----------------------------------------------------------------------
    // unloadSingle
    // -----------------------------------------------------------------------

    async unloadSingle(pluginId: string): Promise<void> {
      await unloadPluginRuntime(pluginId);
    },

    // -----------------------------------------------------------------------
    // shutdownAll
    // -----------------------------------------------------------------------

    async shutdownAll(): Promise<void> {
      const services = requireRuntimeServices("shutdownAll");

      log.info("plugin-loader: shutting down all plugins");

      const errors: unknown[] = [];

      try {
        services.jobScheduler.stop();
      } catch (err) {
        errors.push(err);
      }

      try {
        await services.workerManager.stopAll();
      } catch (err) {
        errors.push(err);
      }

      // Let already-accepted handlers use their activation-scoped host
      // services through the bounded worker drain, then fence every binding
      // before disposing it. stopAll attempts every worker before returning.
      for (const active of activeHostBindings.values()) {
        active.revoke();
      }

      for (const pluginId of [...activeHostBindings.keys()]) {
        try {
          await disposeHostBinding(pluginId);
        } catch (err) {
          errors.push(err);
        }
      }

      if (errors.length > 0) {
        throw new AggregateError(errors, "Failed to completely shut down plugin runtimes");
      }

      log.info("plugin-loader: all plugins shut down");
    },
  } satisfies Pick<PluginLoader, "loadAll" | "loadSingle" | "unloadSingle" | "shutdownAll">;
}

export {
  buildPluginWorkerEnv,
  type PluginLoadAllResult,
  type PluginLoader,
  type PluginRuntimeServices,
  type PluginUpgradeOptions,
} from "./plugin-loader-contracts.js";

export function pluginLoader(db: Db, options: PluginLoaderOptions): PluginLoader {
  const context = createPluginLoaderContext(db, options);
  const helpers1 = buildPluginLoaderRuntimeLifecycle(context);
  const scope1 = { ...context, ...helpers1 };
  const helpers2 = buildPluginLoaderDiscovery(scope1);
  const scope2 = { ...scope1, ...helpers2 };
  const helpers3 = buildPluginLoaderActivation(scope2);
  const scope3 = { ...scope2, ...helpers3 };
  const scope = scope3;
  const methods1 = createPluginLoaderMethods1(scope);
  const methods2 = createPluginLoaderMethods2(scope);
  return { ...methods1, ...methods2 };
}
