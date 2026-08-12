/**
 * PluginLifecycleManager — state-machine controller for plugin status
 * transitions and worker process coordination.
 *
 * Each plugin moves through a well-defined state machine:
 *
 * ```
 *   ready ──→ disabled
 *     │           ↑
 *     └──→ error ─┘
 * ```
 *
 * Uninstall is a terminal delete operation after the disabled authority
 * fence, not a persisted lifecycle status.
 *
 * The lifecycle manager:
 *
 * 1. **Validates transitions** — Only transitions defined in
 *    `VALID_TRANSITIONS` are allowed; invalid transitions throw.
 *
 * 2. **Coordinates workers** — When a plugin moves to `ready`, its
 *    worker process is started. When it moves out of `ready`, the
 *    worker is stopped gracefully.
 *
 * 3. **Emits events** — one runtime activation/deactivation event.
 *
 * 4. **Persists state** — Status changes are written to the database
 *    through the plugin registry service.
 *
 * @see PLUGIN_SPEC.md §12 — Process Model
 * @see PLUGIN_SPEC.md §12.5 — Graceful Shutdown Policy
 */
import { EventEmitter } from "node:events";
import { realpath } from "node:fs/promises";
import type { Db } from "@paperclipai/db";
import type {
  PluginConfig,
  PluginInstallRequest,
  PluginStatus,
  PluginRecord,
} from "@paperclipai/shared";
import {
  lockPluginInstallationInTransaction,
  persistPluginStatusInTransaction,
  pluginRegistryService,
  deletePluginInstallationInTransaction,
} from "./plugin-registry.js";
import type { PluginLoadAllResult, PluginLoader } from "./plugin-loader.js";
import { badRequest, notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { pausePluginManagedAgentsIntoTriageInTransaction } from "./plugin-managed-agents.js";
import type { AgentSuspensionService } from "./agents.js";
import type { RequestedAgentRunCancellations } from "./task-execution-cancellation.js";
import {
  publishCommittedActivity,
  type PersistedActivityLog,
} from "./activity-log.js";
import { createTaskSessionAdmissionService } from "./task-session/admission.js";
import { terminalizePluginCreatorEdgesInTransaction } from "./system-escalation-postgres.js";
import { validatePluginInstanceConfig } from "./plugin-config-validator.js";

// ---------------------------------------------------------------------------
// Lifecycle state machine
// ---------------------------------------------------------------------------

/**
 * Valid state transitions for the plugin lifecycle.
 *
 *   ready → disabled        (operator disables or uninstalls plugin)
 *   ready → error           (runtime failure)
 *
 *   disabled → ready        (operator re-enables plugin)
 *
 *   error → ready           (retry / recovery)
 *   error → disabled        (uninstall first revokes authority)
 */
const VALID_TRANSITIONS: Record<PluginStatus, readonly PluginStatus[]> = {
  ready: ["disabled", "error"],
  disabled: ["ready"],
  error: ["ready", "disabled"],
};

/**
 * Check whether a transition from `from` → `to` is valid.
 */
function isValidTransition(from: PluginStatus, to: PluginStatus): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------------------
// Lifecycle events
// ---------------------------------------------------------------------------

/**
 * Events emitted by the PluginLifecycleManager.
 * Consumers can subscribe to these for routing-table updates, UI refresh
 * notifications, and observability.
 */
interface PluginLifecycleEvents {
  /** Emitted after the complete plugin runtime is online. */
  "plugin.activated": { pluginId: string };
  /** Emitted after the complete plugin runtime is offline. */
  "plugin.deactivated": { pluginId: string };
}

type LifecycleEventName = keyof PluginLifecycleEvents;
type LifecycleEventPayload<K extends LifecycleEventName> =
  PluginLifecycleEvents[K];

// ---------------------------------------------------------------------------
// PluginLifecycleManager
// ---------------------------------------------------------------------------

export interface PluginLifecycleManager {
  /** Activate every installation persisted as ready during server startup. */
  activateReadyPlugins(): Promise<PluginLoadAllResult>;

  /**
   * Install a plugin and activate it only when its empty instance config is
   * valid. Plugins requiring configuration remain disabled until enabled.
   */
  install(options: PluginInstallRequest): Promise<PluginRecord>;

  /**
   * Enable a plugin that is in `disabled` or `error` state.
   * Retries any stale teardown before transitioning → `ready`.
   */
  enable(pluginId: string): Promise<PluginRecord>;

  /**
   * Revoke a ready or errored plugin and drain its runtime. Repeating this for
   * a disabled plugin retries cleanup without repeating the authority change.
   */
  disable(pluginId: string, reason?: string): Promise<PluginRecord>;

  /**
   * Uninstall a plugin from any active state. The disabled row remains only
   * while fallible runtime/package cleanup is incomplete; successful cleanup
   * deletes the installation and every installation-owned operational row.
   * A repeated uninstall after successful deletion is a no-op.
   */
  unload(pluginId: string): Promise<PluginRecord | null>;

  /**
   * Mark a plugin as errored (e.g. worker crash, health-check failure).
   * Transitions → `error` and drains the runtime. Repeating from `error`
   * updates the failure and retries cleanup.
   */
  markError(pluginId: string, error: string): Promise<PluginRecord>;

  /**
   * Upgrade a plugin to a newer version.
   * The loader validates the candidate while the old runtime remains active.
   * This manager drains that runtime before committing the replacement
   * installation and activating it. Capability escalation is rejected without
   * disturbing the old runtime.
   */
  upgrade(pluginId: string, version?: string): Promise<PluginRecord>;

  /**
   * Reload the complete runtime for a ready plugin.
   *
   * Unloads and re-loads host bindings, migrations, jobs, and the worker while
   * the persisted plugin remains in `ready`. This is used by the dev watcher.
   *
   * @param pluginId - The UUID of the plugin to reload
   * @throws if the runtime graph is not bound or the plugin is not ready
   */
  reloadRuntime(pluginId: string): Promise<void>;

  /** Persist instance config and reload only an already-ready runtime. */
  updateConfig(
    pluginId: string,
    configJson: Record<string, unknown>,
  ): Promise<PluginConfig>;

  /**
   * Subscribe to lifecycle events.
   */
  on<K extends LifecycleEventName>(
    event: K,
    listener: (payload: LifecycleEventPayload<K>) => void,
  ): void;

  /**
   * Unsubscribe from lifecycle events.
   */
  off<K extends LifecycleEventName>(
    event: K,
    listener: (payload: LifecycleEventPayload<K>) => void,
  ): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Options for constructing a PluginLifecycleManager.
 */
interface PluginLifecycleManagerOptions {
  /** The single configured loader that owns this installation lifecycle. */
  loader: PluginLoader;

  /** Prepares and notifies each committed causal execution ref. */
  dispatchRef(refId: string): Promise<void>;

  /** Canonical transaction owner of triage fencing and run suspension. */
  taskExecutionCancellation: AgentSuspensionService;
}

/**
 * Create a PluginLifecycleManager.
 *
 * This service orchestrates plugin state transitions on top of the
 * `pluginRegistryService` (which handles raw DB persistence).  It enforces
 * the lifecycle state machine, emits events for downstream consumers
 * (routing tables, UI, observability), and delegates complete runtime
 * activation/deactivation to the bound loader.
 *
 * Usage:
 * ```ts
 * const lifecycle = pluginLifecycleManager(db, {
 *   loader,
 *   dispatchRef,
 *   taskExecutionCancellation,
 * });
 * lifecycle.on("plugin.activated", ({ pluginId }) => { ... });
 * await lifecycle.install(installOptions);
 * ```
 *
 * @see PLUGIN_SPEC.md §21.3 — `plugins.status` column
 * @see PLUGIN_SPEC.md §12 — Process Model
 */
export function pluginLifecycleManager(
  db: Db,
  options: PluginLifecycleManagerOptions,
): PluginLifecycleManager {
  const pluginLoaderInstance = options.loader;
  const dispatchRef = options.dispatchRef;
  const taskExecutionCancellation = options.taskExecutionCancellation;

  const registry = pluginRegistryService(db);
  const canonicalSessions = createTaskSessionAdmissionService(db);
  const emitter = new EventEmitter();

  const log = logger.child({ service: "plugin-lifecycle" });
  const operationTails = new Map<string, Promise<void>>();

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  async function serializeLifecycleOperation<T>(
    identity: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = operationTails.get(identity) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    operationTails.set(identity, settled);
    try {
      return await result;
    } finally {
      if (operationTails.get(identity) === settled) {
        operationTails.delete(identity);
      }
    }
  }

  async function installIdentity(
    options: PluginInstallRequest,
  ): Promise<string> {
    if (options.source === "npm") {
      return `install:npm:${options.packageName}`;
    }
    return `install:local:${await realpath(options.path)}`;
  }

  function pluginIdentity(pluginId: string): string {
    return `plugin:${pluginId}`;
  }

  async function requirePlugin(pluginId: string): Promise<PluginRecord> {
    const plugin = await registry.getById(pluginId);
    if (!plugin) throw notFound(`Plugin not found: ${pluginId}`);
    return plugin;
  }

  function assertTransition(plugin: PluginRecord, to: PluginStatus): void {
    if (!isValidTransition(plugin.status, to)) {
      throw badRequest(
        `Invalid lifecycle transition: ${plugin.status} → ${to} for plugin ${plugin.pluginKey}`,
      );
    }
  }

  async function transition(
    pluginId: string,
    to: PluginStatus,
    lastError: string | null = null,
    existingPlugin?: PluginRecord,
  ): Promise<PluginRecord> {
    const plugin = existingPlugin ?? (await requirePlugin(pluginId));
    assertTransition(plugin, to);

    const previousStatus = plugin.status;

    const updated = await registry.updateStatus(pluginId, {
      status: to,
      lastError,
    });

    if (!updated)
      throw notFound(`Plugin not found after status update: ${pluginId}`);
    const result = updated;

    log.info(
      { pluginId, pluginKey: result.pluginKey, from: previousStatus, to },
      `plugin lifecycle: ${previousStatus} → ${to}`,
    );

    return result;
  }

  async function commitDisabledTransition(
    pluginId: string,
    options: {
      lastError: string | null;
      managedAgentReason: string;
      terminalReason: "plugin_disabled" | "plugin_uninstalled";
    },
  ): Promise<{
    previousStatus: PluginStatus;
    plugin: PluginRecord;
    suspensionRequests: RequestedAgentRunCancellations[];
    dispatchRefIds: string[];
    activities: PersistedActivityLog[];
  } | null> {
    const committed = await db.transaction(async (tx) => {
      // Global lock order for plugin-originated work is installation first,
      // then managed bindings/agents, then creator edges/deliveries.
      const locked = await lockPluginInstallationInTransaction(tx, pluginId);
      if (!locked) return null;
      const plugin = locked;
      if (plugin.status === "disabled") {
        return {
          previousStatus: plugin.status,
          plugin,
          suspensionRequests: [],
          dispatchRefIds: [],
          activities: [],
        };
      }
      assertTransition(plugin, "disabled");
      const now = new Date();

      const managedAgentTransition =
        await pausePluginManagedAgentsIntoTriageInTransaction(
          tx,
          {
            pluginId,
            pluginKey: plugin.pluginKey,
            reason: options.managedAgentReason,
            actorType: "system",
            actorId: pluginId,
          },
          taskExecutionCancellation,
          now,
        );
      const pluginEscalations =
        await terminalizePluginCreatorEdgesInTransaction(
          tx,
          canonicalSessions,
          {
            pluginInstallationId: pluginId,
            reason: options.terminalReason,
            sourceId: `${options.terminalReason.replaceAll("_", "-")}:${pluginId}`,
            now,
          },
        );
      const updated = await persistPluginStatusInTransaction(
        tx,
        pluginId,
        {
          status: "disabled",
          lastError: options.lastError,
        },
        now,
      );
      if (!updated) {
        throw notFound(`Plugin not found after status update: ${pluginId}`);
      }
      return {
        previousStatus: plugin.status,
        plugin: updated,
        suspensionRequests: managedAgentTransition.suspensionRequests,
        dispatchRefIds: pluginEscalations.flatMap((escalation) =>
          escalation.dispatchRefId ? [escalation.dispatchRefId] : [],
        ),
        activities: managedAgentTransition.activities,
      };
    });
    for (const activity of committed?.activities ?? []) {
      publishCommittedActivity(activity);
    }
    return committed;
  }

  async function finishDisabledTransition(
    committed: NonNullable<
      Awaited<ReturnType<typeof commitDisabledTransition>>
    >,
  ): Promise<void> {
    let teardownFailure: { error: unknown } | null = null;
    const deferredRecoveryErrors: unknown[] = [];

    // unloadSingle revokes the host binding synchronously before its first
    // fallible drain step. Always begin that fence before post-commit effects.
    try {
      await deactivatePluginRuntime(committed.plugin.id);
    } catch (error) {
      teardownFailure = { error };
    }

    for (const suspensionRequests of committed.suspensionRequests) {
      try {
        await taskExecutionCancellation.reconcileRequestedCancellations(
          suspensionRequests,
        );
      } catch (error) {
        deferredRecoveryErrors.push(error);
      }
    }
    for (const refId of committed.dispatchRefIds) {
      try {
        await dispatchRef(refId);
      } catch (error) {
        deferredRecoveryErrors.push(error);
      }
    }

    if (deferredRecoveryErrors.length > 0) {
      // Cancellation intents and execution refs were committed before these
      // notifications. The instance recovery loop reconciles both durable
      // queues at startup and on scheduler ticks; do not pretend replaying the
      // plugin lifecycle transition owns their delivery retry.
      log.warn(
        {
          pluginId: committed.plugin.id,
          errors: deferredRecoveryErrors.map(errorMessage),
        },
        "plugin lifecycle: deferred durable post-commit reconciliation",
      );
    }
    if (teardownFailure) throw teardownFailure.error;
  }

  function emitDomain(
    event: LifecycleEventName,
    payload: PluginLifecycleEvents[LifecycleEventName],
  ): void {
    emitter.emit(event, payload);
  }

  async function activateReadyPlugin(pluginId: string): Promise<void> {
    const loadResult = await pluginLoaderInstance.loadSingle(pluginId);
    if (!loadResult.success) {
      const message = loadResult.error;
      await transition(pluginId, "error", `Activation failed: ${message}`);
      throw new Error(message);
    }
    emitDomain("plugin.activated", {
      pluginId,
    });
  }

  async function deactivatePluginRuntime(pluginId: string): Promise<void> {
    await pluginLoaderInstance.unloadSingle(pluginId);
    emitDomain("plugin.deactivated", { pluginId });
  }

  function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  async function persistReadyRuntimeFailure(
    plugin: PluginRecord,
    operation: string,
    cause: unknown,
  ): Promise<never> {
    const failure = cause instanceof Error ? cause : new Error(String(cause));
    try {
      await transition(
        plugin.id,
        "error",
        `${operation} failed: ${failure.message}`,
        plugin,
      );
    } catch (statusError) {
      throw new AggregateError(
        [failure, statusError],
        `${operation} failed and the error status could not be persisted: ${failure.message}`,
      );
    }
    throw failure;
  }

  /**
   * Replace one ready runtime without ever leaving a durable ready row bound
   * to a known-stale runtime. Teardown is the authority fence; only after it
   * succeeds may the durable replacement mutation run.
   */
  async function replaceReadyRuntime<T>(
    plugin: PluginRecord,
    operation: string,
    replace: () => Promise<T>,
  ): Promise<T> {
    try {
      await deactivatePluginRuntime(plugin.id);
    } catch (error) {
      return persistReadyRuntimeFailure(plugin, operation, error);
    }

    let result: T;
    try {
      result = await replace();
    } catch (error) {
      return persistReadyRuntimeFailure(plugin, operation, error);
    }

    await activateReadyPlugin(plugin.id);
    return result;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  return {
    async activateReadyPlugins(): Promise<PluginLoadAllResult> {
      const result = await pluginLoaderInstance.loadAll();
      for (const loaded of result.results) {
        if (!loaded.success) {
          const message = loaded.error;
          await transition(
            loaded.plugin.id,
            "error",
            `Activation failed: ${message}`,
            loaded.plugin,
          );
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
        const installed =
          await pluginLoaderInstance.installPlugin(installOptions);
        return serializeLifecycleOperation(
          pluginIdentity(installed.id),
          async () => {
            if (installed.status === "disabled") return installed;
            if (installed.status !== "ready") {
              throw new Error(
                `New plugin installation has invalid status '${installed.status}'`,
              );
            }
            await activateReadyPlugin(installed.id);
            return installed;
          },
        );
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
          managedAgentReason: reason?.trim()
            ? `plugin_disabled: ${reason.trim()}`
            : "plugin_disabled",
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

        const deleted = await db.transaction((tx) =>
          deletePluginInstallationInTransaction(tx, pluginId),
        );
        if (!deleted) return null;

        log.info(
          { pluginId, pluginKey: deleted.pluginKey },
          "plugin lifecycle: installation deleted",
        );

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
              await pluginLoaderInstance.cleanupInstallArtifacts(
                prepared.previousPlugin,
              );
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

    // -- reloadRuntime ----------------------------------------------------
    async reloadRuntime(pluginId: string): Promise<void> {
      return serializeLifecycleOperation(pluginIdentity(pluginId), async () => {
        const plugin = await requirePlugin(pluginId);
        if (plugin.status !== "ready") {
          throw badRequest(
            `Cannot reload runtime for plugin in status '${plugin.status}'. ` +
              `Plugin must be in 'ready' status.`,
          );
        }

        log.info(
          { pluginId, pluginKey: plugin.pluginKey },
          "plugin lifecycle: reloading complete plugin runtime",
        );

        await replaceReadyRuntime(
          plugin,
          "Plugin runtime restart",
          async () => undefined,
        );

        log.info(
          { pluginId, pluginKey: plugin.pluginKey },
          "plugin lifecycle: plugin reloaded",
        );
      });
    },

    // -- updateConfig -----------------------------------------------------
    async updateConfig(
      pluginId: string,
      configJson: Record<string, unknown>,
    ): Promise<PluginConfig> {
      return serializeLifecycleOperation(pluginIdentity(pluginId), async () => {
        const plugin = await requirePlugin(pluginId);
        const validation = validatePluginInstanceConfig(
          configJson,
          plugin.manifestJson.instanceConfigSchema,
        );
        if (!validation.valid) {
          throw badRequest(
            "Configuration does not match the plugin's instanceConfigSchema",
            validation.errors,
          );
        }

        if (plugin.status !== "ready") {
          return registry.upsertConfig(pluginId, configJson);
        }

        return replaceReadyRuntime(plugin, "Plugin configuration update", () =>
          registry.upsertConfig(pluginId, configJson),
        );
      });
    },

    // -- Event subscriptions ----------------------------------------------
    on(event, listener) {
      emitter.on(event, listener);
    },

    off(event, listener) {
      emitter.off(event, listener);
    },
  };
}
