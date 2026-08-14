import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Db } from "@paperclipai/db";
import type {
  DeploymentExposure,
  PaperclipPluginManifestV1,
  PluginInstallRequest,
  PluginInstallSource,
  PluginRecord,
} from "@paperclipai/shared";
import type { HostClientHandlers } from "@paperclipai/plugin-sdk";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import type { PluginJobScheduler } from "./plugin-job-scheduler.js";
import type { PluginJobStore } from "./plugin-job-store.js";
import type { PluginLifecycleManager } from "./plugin-lifecycle.js";
import { validatePluginInstanceConfig } from "./plugin-config-validator.js";

export const execFileAsync = promisify(execFile);

export function buildPluginWorkerEnv(input: {
  instanceInfo: { deploymentExposure: DeploymentExposure };
}): Record<string, string> {
  return {
    PAPERCLIP_DEPLOYMENT_EXPOSURE: input.instanceInfo.deploymentExposure,
  };
}

// ---------------------------------------------------------------------------
// Resolved install package
// ---------------------------------------------------------------------------

/**
 * A requested plugin package after its manifest has been loaded and validated.
 */
export interface ResolvedPluginPackage {
  /** Absolute path to the root of the npm package directory. */
  packagePath: string;
  /** The npm package name as declared in package.json. */
  packageName: string;
  /** Semver version from package.json. */
  version: string;
  /** How the explicit install request resolved this package. */
  source: PluginInstallSource;
  /** The parsed and validated manifest. */
  manifest: PaperclipPluginManifestV1;
  /** Isolated host-managed root, or null for an operator-owned local path. */
  managedInstallRoot: string | null;
}

export type ParsedSemver = {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
};

export function assertPluginConfigCompatible(
  config: Record<string, unknown>,
  schema: PaperclipPluginManifestV1["instanceConfigSchema"],
): void {
  if (!validatePluginInstanceConfig(config, schema).valid) {
    throw new Error("Stored plugin configuration does not match the installed manifest");
  }
}

// ---------------------------------------------------------------------------
// Loader options
// ---------------------------------------------------------------------------

/**
 * Options for the plugin loader service.
 */
export interface PluginLoaderOptions {
  /** Instance-scoped root for immutable host-managed npm installations. */
  localPluginDir: string;

  /** Explicit Postgres authority used for plugin DDL migrations. */
  migrationDb: Db;
}

// ---------------------------------------------------------------------------
// Install options
// ---------------------------------------------------------------------------

/**
 * Options for installing a single plugin package.
 */
export interface PluginUpgradeOptions {
  /** Target npm version. Local-source upgrades always reload their source path. */
  version?: string;
}

/**
 * Fully validated upgrade candidate that has not changed durable installation
 * authority yet. Exactly one terminal operation is allowed: `commit()` makes
 * the candidate canonical, while `discard()` removes its unreferenced managed
 * package tree.
 */
export interface PreparedPluginUpgrade {
  readonly previousPlugin: PluginRecord;
  readonly oldManifest: PaperclipPluginManifestV1;
  readonly newManifest: PaperclipPluginManifestV1;
  commit(): Promise<void>;
  discard(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Runtime options — services needed for initializing loaded plugins
// ---------------------------------------------------------------------------

/**
 * Runtime services passed to the loader for plugin initialization.
 *
 * Once bound, the loader can fully activate plugins (spawn workers, bind
 * host services, and sync jobs). Runtime operations fail closed before this
 * complete graph is bound.
 *
 * @see PLUGIN_SPEC.md §8.3 — Install Process
 * @see PLUGIN_SPEC.md §12 — Process Model
 */
export interface PluginRuntimeServices {
  /** Worker process manager for spawning and managing plugin workers. */
  workerManager: PluginWorkerManager;
  /** Job scheduler for registering plugin cron jobs. */
  jobScheduler: PluginJobScheduler;
  /** Job store for syncing manifest job declarations to the DB. */
  jobStore: PluginJobStore;
  /** Lifecycle manager for state transitions after activation failures. */
  lifecycleManager: PluginLifecycleManager;
  /**
   * Factory that creates one activation-scoped host binding for a plugin.
   *
   * Its handlers service worker→host calls; its disposer releases every
   * resource created with that exact activation.
   */
  buildHostBinding: (pluginId: string, manifest: PaperclipPluginManifestV1) => PluginHostBinding;
  /**
   * Host instance information passed to the worker during initialization.
   * Includes the instance ID and host version.
   */
  instanceInfo: {
    instanceId: string;
    hostVersion: string;
    deploymentExposure: DeploymentExposure;
  };
}

/** One activation-scoped worker-to-host RPC surface and its exact cleanup. */
export interface PluginHostBinding {
  handlers: HostClientHandlers;
  dispose(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Load results
// ---------------------------------------------------------------------------

/**
 * Result of activating (loading) a single plugin at runtime.
 *
 * Contains the plugin record, activation status, and any error that
 * occurred during the process.
 */
export type PluginLoadResult =
  { plugin: PluginRecord; success: true } | { plugin: PluginRecord; success: false; error: string };

/**
 * Result of activating all ready plugins at server startup.
 */
export interface PluginLoadAllResult {
  /** Total number of plugins that were attempted. */
  total: number;
  /** Number of plugins successfully activated. */
  succeeded: number;
  /** Number of plugins that failed to activate. */
  failed: number;
  /** Per-plugin results. */
  results: PluginLoadResult[];
}

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export interface PluginLoader {
  /**
   * Install a plugin package and register it in the database.
   *
   * Follows the install process described in PLUGIN_SPEC.md §8.3:
   * 1. Resolve npm package / local path.
   * 2. Install into the plugin directory (npm install).
   * 3. Read and validate plugin manifest.
   * 4. Reject incompatible plugin API versions.
   * 5. Validate manifest capabilities.
   * 6. Persist install record in Postgres.
   * 7. Return the persisted installation record.
   *
   * Worker spawning and lifecycle management are handled by the caller
   * (pluginLifecycleManager and the server startup orchestration).
   *
   * @see PLUGIN_SPEC.md §8.3 — Install Process
   */
  installPlugin(options: PluginInstallRequest): Promise<PluginRecord>;

  /**
   * Resolve and validate an upgrade without changing the durable installation.
   * The lifecycle manager first prepares the candidate, then fences and drains
   * the old runtime before revoking it and committing the replacement manifest.
   *
   * @see PLUGIN_SPEC.md §25.3 — Upgrade Lifecycle
   */
  prepareUpgrade(pluginId: string, options: PluginUpgradeOptions): Promise<PreparedPluginUpgrade>;

  /**
   * Remove runtime-managed on-disk install artifacts for a plugin.
   *
   * This only cleans files under the managed local plugin directory. Local-path
   * source checkouts outside that directory are intentionally left alone.
   */
  cleanupInstallArtifacts(plugin: PluginRecord): Promise<void>;

  // -----------------------------------------------------------------------
  // Runtime initialization (requires PluginRuntimeServices)
  // -----------------------------------------------------------------------

  /**
   * Bind the complete runtime service graph exactly once.
   *
   * The server creates the loader first so the lifecycle manager can own that
   * exact instance, then completes the lifecycle/dispatcher graph and binds it
   * here before exposing any plugin operation.
   */
  bindRuntimeServices(services: PluginRuntimeServices): void;

  /**
   * Load and activate all plugins that are in `ready` status.
   *
   * This is the main server-startup orchestration method. For each plugin
   * that is persisted as `ready`, it:
   * 1. Resolves the worker entrypoint from the manifest.
   * 2. Spawns the worker process via the worker manager.
   * 3. Syncs job declarations from the manifest to the `plugin_jobs` table.
   * 4. Registers the plugin with the job scheduler.
   *
   * Activation failures are returned to the lifecycle manager, which owns the
   * persisted `ready` → `error` transition. One failure does not prevent the
   * remaining ready plugins from being attempted.
   *
   * **Requires** `PluginRuntimeServices` to have been bound.
   * Throws if runtime services are not available.
   *
   * @returns Aggregated results for all attempted plugin loads.
   *
   * @see PLUGIN_SPEC.md §8.4 — Server-Start Plugin Loading
   * @see PLUGIN_SPEC.md §12 — Process Model
   */
  loadAll(): Promise<PluginLoadAllResult>;

  /**
   * Activate a single plugin that is in `ready` status.
   *
   * Used after a fresh install (POST /api/plugins/install) or after
   * enabling a previously disabled plugin. Performs the same subsystem
   * registration as `loadAll()` but for a single plugin.
   *
   * **Requires** `PluginRuntimeServices` to have been bound.
   *
   * @param pluginId - UUID of the plugin to activate
   * @returns The activation result for this plugin
   *
   * @see PLUGIN_SPEC.md §8.3 — Install Process
   */
  loadSingle(pluginId: string): Promise<PluginLoadResult>;

  /**
   * Deactivate a single plugin — fence job admission, drain and stop its
   * worker, finish job unregistration, and dispose the exact host binding
   * created for the activation.
   *
   * Used during plugin disable, uninstall, and before upgrade. Does NOT
   * change the plugin's status in the database — that is the caller's
   * responsibility (via the lifecycle manager).
   *
   * **Requires** `PluginRuntimeServices` to have been provided at construction.
   *
   * @param pluginId - UUID of the plugin to deactivate
   * @see PLUGIN_SPEC.md §8.5 — Uninstall Process
   */
  unloadSingle(pluginId: string): Promise<void>;

  /**
   * Stop all managed plugin workers. Called during server shutdown.
   *
   * Stops the job scheduler and then stops all workers via the worker
   * manager. Does NOT change plugin statuses in the database — plugins
   * remain in `ready` so they are restarted on next boot.
   *
   * **Requires** `PluginRuntimeServices` to have been provided at construction.
   */
  shutdownAll(): Promise<void>;
}
