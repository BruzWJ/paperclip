import type { PluginConfig, PluginInstallRequest, PluginStatus, PluginRecord } from "@paperclipai/shared";
import type { PluginLoadAllResult, PluginLoader } from "./plugin-loader.js";
import type { AgentSuspensionService } from "./agents.js";

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
export const VALID_TRANSITIONS: Record<PluginStatus, readonly PluginStatus[]> = {
  ready: ["disabled", "error"],
  disabled: ["ready"],
  error: ["ready", "disabled"],
};

/**
 * Check whether a transition from `from` → `to` is valid.
 */
export function isValidTransition(from: PluginStatus, to: PluginStatus): boolean {
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
export interface PluginLifecycleEvents {
  /** Emitted after the complete plugin runtime is online. */
  "plugin.activated": { pluginId: string };
  /** Emitted after the complete plugin runtime is offline. */
  "plugin.deactivated": { pluginId: string };
}

export type LifecycleEventName = keyof PluginLifecycleEvents;

export type LifecycleEventPayload<K extends LifecycleEventName> = PluginLifecycleEvents[K];

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
  updateConfig(pluginId: string, configJson: Record<string, unknown>): Promise<PluginConfig>;

  /**
   * Subscribe to lifecycle events.
   */
  on<K extends LifecycleEventName>(event: K, listener: (payload: LifecycleEventPayload<K>) => void): void;

  /**
   * Unsubscribe from lifecycle events.
   */
  off<K extends LifecycleEventName>(event: K, listener: (payload: LifecycleEventPayload<K>) => void): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Options for constructing a PluginLifecycleManager.
 */
export interface PluginLifecycleManagerOptions {
  /** The single configured loader that owns this installation lifecycle. */
  loader: PluginLoader;

  /** Prepares and notifies each committed causal execution ref. */
  dispatchRef(refId: string): Promise<void>;

  /** Canonical transaction owner of triage fencing and run suspension. */
  taskExecutionCancellation: AgentSuspensionService;
}
