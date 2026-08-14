import type { PluginInstallRequest, PluginRecord } from "@paperclipai/shared";
import { deletePluginInstallationInTransaction } from "./plugin-registry.js";
import type { PluginLoadAllResult } from "./plugin-loader.js";
import { badRequest, notFound } from "../errors.js";
import { type PluginLifecycleManager } from "./plugin-lifecycle-contracts.js";
import { type PluginLifecycleContext } from "./plugin-lifecycle.js";
import { buildPluginLifecycleTransitions } from "./plugin-lifecycle-transitions.js";
import { buildPluginLifecycleRuntimeTransition } from "./plugin-lifecycle-runtime-transition.js";

export function createPluginLifecycleMethods1(
  scope: PluginLifecycleContext &
    ReturnType<typeof buildPluginLifecycleTransitions> &
    ReturnType<typeof buildPluginLifecycleRuntimeTransition>,
) {
  const {
    db,
    pluginLoaderInstance,
    registry,
    log,
    serializeLifecycleOperation,
    installIdentity,
    pluginIdentity,
    requirePlugin,
    transition,
    commitDisabledTransition,
    finishDisabledTransition,
    emitDomain,
    activateReadyPlugin,
    deactivatePluginRuntime,
    errorMessage,
    replaceReadyRuntime,
  } = scope;

  return {
    async activateReadyPlugins(): Promise<PluginLoadAllResult> {
      const result = await pluginLoaderInstance.loadAll();
      for (const loaded of result.results) {
        if (!loaded.success) {
          const message = loaded.error;
          await transition(loaded.plugin.id, "error", `Activation failed: ${message}`, loaded.plugin);
          continue;
        }
        emitDomain("plugin.activated", {
          pluginId: loaded.plugin.id,
        });
      }
      return result;
    },

    // -- install ----------------------------------------------------------
    async install(installOptions: PluginInstallRequest): Promise<PluginRecord> {
      const sourceIdentity = await installIdentity(installOptions);
      return serializeLifecycleOperation(sourceIdentity, async () => {
        const installed = await pluginLoaderInstance.installPlugin(installOptions);
        return serializeLifecycleOperation(pluginIdentity(installed.id), async () => {
          if (installed.status === "disabled") return installed;
          if (installed.status !== "ready") {
            throw new Error(`New plugin installation has invalid status '${installed.status}'`);
          }
          await activateReadyPlugin(installed.id);
          return installed;
        });
      });
    },

    // -- enable -----------------------------------------------------------
    /**
     * enable — Re-enables a plugin that is disabled or errored.
     *
     * Transitions the plugin to 'ready' and starts its complete runtime.
     *
     * @param pluginId - The UUID of the plugin to enable.
     * @returns The updated plugin record.
     */
    async enable(pluginId: string): Promise<PluginRecord> {
      return serializeLifecycleOperation(pluginIdentity(pluginId), async () => {
        const plugin = await requirePlugin(pluginId);

        if (plugin.status !== "disabled" && plugin.status !== "error") {
          throw badRequest(
            `Cannot enable plugin in status '${plugin.status}'. ` +
              `Plugin must be in 'disabled' or 'error' status to be enabled.`,
          );
        }

        // A prior disable/error cleanup may have failed after authority was
        // revoked. Retry that teardown before exposing ready authority. This
        // is not a deactivation event: the durable plugin was already non-ready.
        await pluginLoaderInstance.unloadSingle(pluginId);
        const result = await transition(pluginId, "ready", null, plugin);
        await activateReadyPlugin(pluginId);
        return result;
      });
    },

    // -- disable ----------------------------------------------------------
    async disable(pluginId: string, reason?: string): Promise<PluginRecord> {
      return serializeLifecycleOperation(pluginIdentity(pluginId), async () => {
        const plugin = await requirePlugin(pluginId);

        // Disabled is a retryable cleanup state. The authority transition is
        // committed once; repeating disable only finishes failed teardown.
        if (plugin.status === "disabled") {
          await deactivatePluginRuntime(pluginId);
          return plugin;
        }

        if (plugin.status !== "ready" && plugin.status !== "error") {
          throw badRequest(
            `Cannot disable plugin in status '${plugin.status}'. ` +
              `Plugin must be in 'ready', 'error', or 'disabled' status to be disabled.`,
          );
        }

        const transitionResult = await commitDisabledTransition(pluginId, {
          lastError: null,
          managedAgentReason: reason?.trim() ? `plugin_disabled: ${reason.trim()}` : "plugin_disabled",
          terminalReason: "plugin_disabled",
        });
        if (!transitionResult) throw notFound(`Plugin not found: ${pluginId}`);
        const result = transitionResult.plugin;
        await finishDisabledTransition(transitionResult);
        log.info(
          {
            pluginId,
            pluginKey: result.pluginKey,
            from: transitionResult.previousStatus,
            to: "disabled",
          },
          `plugin lifecycle: ${transitionResult.previousStatus} → disabled`,
        );
        return result;
      });
    },

    // -- unload -----------------------------------------------------------
    async unload(pluginId: string): Promise<PluginRecord | null> {
      return serializeLifecycleOperation(pluginIdentity(pluginId), async () => {
        let plugin = await registry.getById(pluginId);
        if (!plugin) return null;

        // Revoke every runtime and managed-resource authority before cleanup.
        // The live disabled row remains addressable if cleanup fails, so the
        // exact same uninstall operation can be retried.
        if (plugin.status !== "disabled") {
          const disabled = await commitDisabledTransition(pluginId, {
            lastError: null,
            managedAgentReason: "plugin_uninstalled",
            terminalReason: "plugin_uninstalled",
          });
          if (!disabled) return null;
          plugin = disabled.plugin;
          await finishDisabledTransition(disabled);
        } else {
          await deactivatePluginRuntime(pluginId);
        }

        await pluginLoaderInstance.cleanupInstallArtifacts(plugin);

        const deleted = await db.transaction((tx) => deletePluginInstallationInTransaction(tx, pluginId));
        if (!deleted) return null;

        log.info({ pluginId, pluginKey: deleted.pluginKey }, "plugin lifecycle: installation deleted");

        return deleted;
      });
    },

    // -- markError --------------------------------------------------------
    async markError(pluginId: string, error: string): Promise<PluginRecord> {
      return serializeLifecycleOperation(pluginIdentity(pluginId), async () => {
        const plugin = await requirePlugin(pluginId);
        let result: PluginRecord;
        if (plugin.status === "error") {
          const updated = await registry.updateStatus(pluginId, {
            status: "error",
            lastError: error,
          });
          if (!updated) {
            throw notFound(`Plugin not found after status update: ${pluginId}`);
          }
          result = updated;
        } else {
          result = await transition(pluginId, "error", error, plugin);
        }
        await deactivatePluginRuntime(pluginId);
        return result;
      });
    },

    // -- upgrade ----------------------------------------------------------
    /**
     * Upgrade a plugin to a newer version by performing a package update and
     * replacing its complete runtime.
     *
     * The candidate is fetched and checked for capability escalation while the
     * old runtime remains active. A rejected candidate therefore cannot strand
     * a ready installation offline. The old runtime is then revoked and fully
     * drained before the replacement manifest becomes durable.
     *
     * @param pluginId - The UUID of the plugin to upgrade.
     * @param version - Optional target version specifier.
     * @returns The updated `PluginRecord`.
     * @throws {BadRequest} If the plugin is not ready.
     */
    async upgrade(pluginId: string, version?: string): Promise<PluginRecord> {
      return serializeLifecycleOperation(pluginIdentity(pluginId), async () => {
        const plugin = await requirePlugin(pluginId);

        if (plugin.status !== "ready") {
          throw badRequest(
            `Cannot upgrade plugin in status '${plugin.status}'. ` +
              `Plugin must be in 'ready' status to be upgraded.`,
          );
        }

        log.info(
          { pluginId, pluginKey: plugin.pluginKey, targetVersion: version },
          "plugin lifecycle: upgrade requested",
        );

        const prepared = await pluginLoaderInstance.prepareUpgrade(pluginId, {
          version,
        });
        let committed = false;
        try {
          await replaceReadyRuntime(plugin, "Plugin upgrade", async () => {
            await prepared.commit();
            committed = true;
            log.info(
              {
                pluginId,
                pluginKey: plugin.pluginKey,
                oldVersion: prepared.oldManifest.version,
                newVersion: prepared.newManifest.version,
              },
              "plugin lifecycle: package upgrade committed after runtime drain",
            );

            try {
              await pluginLoaderInstance.cleanupInstallArtifacts(prepared.previousPlugin);
            } catch (err) {
              // The registry now points at the immutable replacement tree.
              // Startup reconciliation removes the old unreferenced tree.
              log.warn(
                {
                  pluginId,
                  installRoot: prepared.previousPlugin.packagePath,
                  err,
                },
                "plugin lifecycle: deferred old package cleanup",
              );
            }
          });
        } catch (error) {
          if (!committed) {
            try {
              await prepared.discard();
            } catch (discardError) {
              throw new AggregateError(
                [error, discardError],
                `Plugin upgrade failed and its candidate could not be discarded: ${errorMessage(error)}`,
              );
            }
          }
          throw error;
        }
        return requirePlugin(pluginId);
      });
    },
  } satisfies Pick<
    PluginLifecycleManager,
    "activateReadyPlugins" | "install" | "enable" | "disable" | "unload" | "markError" | "upgrade"
  >;
}
