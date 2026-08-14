import type { PluginRecord } from "@paperclipai/shared";
import type { WorkerStartOptions } from "./plugin-worker-manager.js";
import { pluginDatabaseService } from "./plugin-database.js";
import {
  assertPluginConfigCompatible,
  buildPluginWorkerEnv,
  type PluginLoadResult,
} from "./plugin-loader-contracts.js";
import { resolvePluginPackageRoot, resolveWorkerEntrypoint } from "./plugin-loader-runtime-lifecycle.js";
import { type PluginLoaderContext } from "./plugin-loader.js";
import { buildPluginLoaderRuntimeLifecycle } from "./plugin-loader-runtime-lifecycle.js";
import { buildPluginLoaderDiscovery } from "./plugin-loader-discovery.js";

export function buildPluginLoaderActivation(
  scope: PluginLoaderContext &
    ReturnType<typeof buildPluginLoaderRuntimeLifecycle> &
    ReturnType<typeof buildPluginLoaderDiscovery>,
) {
  const {
    migrationDb,
    registry,
    log,
    activeHostBindings,
    createRevocableHostBinding,
    requireRuntimeServices,
    unloadPluginRuntime,
  } = scope;

  // -------------------------------------------------------------------------
  // Internal: activatePlugin — shared logic for loadAll and loadSingle
  // -------------------------------------------------------------------------

  /**
   * Activate a single plugin: bind its host RPC surface, spawn its worker,
   * and sync jobs. Agent-tool declarations remain canonical in the persisted
   * manifest and are compiled directly for each prompt-capability operation.
   *
   * This is the core orchestration logic shared by `loadAll()` and `loadSingle()`.
   * Failures are caught, fully cleaned up, and returned to the lifecycle
   * manager, which owns the single persisted status transition.
   */
  async function activatePlugin(plugin: PluginRecord): Promise<PluginLoadResult> {
    const pluginId = plugin.id;
    const pluginKey = plugin.pluginKey;
    const manifest = plugin.manifestJson;

    const { workerManager, jobScheduler, jobStore, lifecycleManager, buildHostBinding, instanceInfo } =
      requireRuntimeServices("activate plugin");

    try {
      log.info({ pluginId, pluginKey, version: manifest.version }, "plugin-loader: activating plugin");

      // ------------------------------------------------------------------
      // 1. Resolve worker entrypoint
      // ------------------------------------------------------------------
      const packageRoot = resolvePluginPackageRoot(plugin);
      const workerEntrypoint = resolveWorkerEntrypoint(plugin, packageRoot);

      // ------------------------------------------------------------------
      // 2. Validate the persisted configuration before any plugin-owned
      // activation work. A missing row is the canonical empty config.
      // ------------------------------------------------------------------
      const configRow = await registry.getConfig(pluginId);
      assertPluginConfigCompatible(configRow?.configJson ?? {}, manifest.instanceConfigSchema);

      // ------------------------------------------------------------------
      // 3. Apply restricted database migrations before worker startup
      // ------------------------------------------------------------------
      let databaseNamespace: string | null = null;
      if (manifest.database) {
        const namespace = await pluginDatabaseService(migrationDb).applyMigrations(
          pluginId,
          manifest,
          packageRoot,
        );
        if (!namespace) {
          throw new Error("Plugin database migration returned no namespace");
        }
        databaseNamespace = namespace.namespaceName;
      }

      // ------------------------------------------------------------------
      // 4. Build the activation-scoped host binding for this plugin
      // ------------------------------------------------------------------
      if (activeHostBindings.has(pluginId)) {
        throw new Error(`Plugin runtime is already active: ${pluginId}`);
      }
      const hostBinding = createRevocableHostBinding(
        pluginId,
        pluginKey,
        buildHostBinding(pluginId, manifest),
      );
      activeHostBindings.set(pluginId, hostBinding);

      // ------------------------------------------------------------------
      // 5. Spawn worker process
      // ------------------------------------------------------------------
      const workerOptions: WorkerStartOptions = {
        entrypointPath: workerEntrypoint,
        manifest,
        instanceInfo,
        apiVersion: manifest.apiVersion,
        databaseNamespace,
        hostHandlers: hostBinding.handlers,
        onTerminalCrash: async ({ code, signal, stderrExcerpt }) => {
          const exit = `code=${code}, signal=${signal}`;
          const detail = stderrExcerpt.trim() ? `; stderr: ${stderrExcerpt.trim()}` : "";
          await lifecycleManager.markError(pluginId, `Worker restart budget exhausted (${exit})${detail}`);
        },
        env: buildPluginWorkerEnv({ instanceInfo }),
      };

      await workerManager.startWorker(pluginId, workerOptions);
      log.info({ pluginId, pluginKey }, "plugin-loader: worker started");

      // ------------------------------------------------------------------
      // 6. Sync job declarations and register with scheduler
      // ------------------------------------------------------------------
      const jobDeclarations = manifest.jobs ?? [];
      await jobStore.syncJobDeclarations(pluginId, jobDeclarations);
      if (jobDeclarations.length > 0) {
        await jobScheduler.registerPlugin(pluginId);

        log.info(
          { pluginId, pluginKey, jobs: jobDeclarations.length },
          "plugin-loader: job declarations synced and plugin registered with scheduler",
        );
      } else {
        log.debug({ pluginId, pluginKey }, "plugin-loader: empty job declarations synced");
      }

      // ------------------------------------------------------------------
      // Done — plugin fully activated
      // ------------------------------------------------------------------
      log.info(
        {
          pluginId,
          pluginKey,
          version: manifest.version,
        },
        "plugin-loader: plugin activated successfully",
      );

      return { plugin, success: true };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);

      log.error({ pluginId, pluginKey, err: errorMessage }, "plugin-loader: failed to activate plugin");

      let failure = errorMessage;
      try {
        await unloadPluginRuntime(pluginId);
      } catch (cleanupErr) {
        const cleanupMessage = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
        failure = `${errorMessage}; activation cleanup failed: ${cleanupMessage}`;
        log.error(
          {
            pluginId,
            err: cleanupMessage,
          },
          "plugin-loader: failed to clean partial runtime after activation failure",
        );
      }

      return {
        plugin,
        success: false,
        error: failure,
      };
    }
  }

  return { activatePlugin };
}
