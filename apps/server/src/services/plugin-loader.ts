/**
 * PluginLoader — explicit installation and runtime activation of plugins.
 *
 * This service is the entry point for the plugin system's I/O boundary:
 *
 * 1. **Installation** — `installPlugin()` downloads from npm (or reads a
 *    local path), validates the manifest, checks capability consistency,
 *    and persists the install record.
 *
 * 2. **Runtime activation** — `activatePlugin()` wires up a loaded plugin
 *    with all runtime services: resolves its entrypoint, builds
 *    capability-gated host binding, spawns a worker process, and syncs job
 *    declarations.
 *
 * 3. **Shutdown** — `shutdownAll()` gracefully stops all active workers
 *    and unregisters runtime hooks.
 *
 * @see PLUGIN_SPEC.md §10 — Package Contract
 * @see PLUGIN_SPEC.md §12 — Process Model
 */
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
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
import { logger } from "../middleware/logger.js";
import { parsePluginManifest } from "./plugin-manifest-validator.js";
import {
  installPluginInTransaction,
  lockPluginInstallationInTransaction,
  lockPluginRegistryClaimsInTransaction,
  pluginRegistryService,
} from "./plugin-registry.js";
import type { PluginWorkerManager, WorkerStartOptions } from "./plugin-worker-manager.js";
import type { PluginJobScheduler } from "./plugin-job-scheduler.js";
import type { PluginJobStore } from "./plugin-job-store.js";
import type { PluginLifecycleManager } from "./plugin-lifecycle.js";
import { pluginDatabaseService } from "./plugin-database.js";
import { validatePluginInstanceConfig } from "./plugin-config-validator.js";
import { isPathContained, resolvePluginPath } from "./plugin-paths.js";

const execFileAsync = promisify(execFile);

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
interface ResolvedPluginPackage {
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

type ParsedSemver = {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
};

function assertPluginConfigCompatible(
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
interface PluginLoaderOptions {
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
interface PreparedPluginUpgrade {
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
  buildHostBinding: (
    pluginId: string,
    manifest: PaperclipPluginManifestV1,
  ) => PluginHostBinding;
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
interface PluginHostBinding {
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
type PluginLoadResult =
  | { plugin: PluginRecord; success: true }
  | { plugin: PluginRecord; success: false; error: string };

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
  prepareUpgrade(
    pluginId: string,
    options: PluginUpgradeOptions,
  ): Promise<PreparedPluginUpgrade>;

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read and parse the required package.json from a directory path.
 */
async function readPackageJson(
  dir: string,
): Promise<Record<string, unknown>> {
  const pkgPath = path.join(dir, "package.json");
  let raw: string;
  try {
    raw = await readFile(pkgPath, "utf-8");
  } catch (err) {
    throw new Error(`Unable to read plugin package.json at ${pkgPath}: ${String(err)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Malformed plugin package.json at ${pkgPath}: ${String(err)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Plugin package.json must contain a JSON object: ${pkgPath}`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Resolve the manifest entrypoint from a package.json and package root.
 *
 * The spec defines a "paperclipPlugin" key in package.json with a "manifest"
 * subkey pointing to the manifest module.  This helper resolves the path.
 *
 * @see PLUGIN_SPEC.md §10 — Package Contract
 */
function resolveManifestPath(
  packageRoot: string,
  pkgJson: Record<string, unknown>,
): string {
  const paperclipPlugin = pkgJson["paperclipPlugin"];
  if (
    paperclipPlugin === null
    || typeof paperclipPlugin !== "object"
    || Array.isArray(paperclipPlugin)
  ) {
    throw new Error("package.json must declare paperclipPlugin.manifest");
  }

  const manifestRelPath = (paperclipPlugin as Record<string, unknown>)["manifest"];
  if (typeof manifestRelPath !== "string" || manifestRelPath.trim().length === 0) {
    throw new Error("package.json must declare paperclipPlugin.manifest");
  }

  return resolvePluginPath(packageRoot, manifestRelPath, {
    label: "paperclipPlugin.manifest",
    kind: "file",
  });
}

function parseSemver(version: string): ParsedSemver | null {
  const match = version.match(
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/,
  );
  if (!match) return null;

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function compareIdentifiers(left: string, right: string): number {
  const leftIsNumeric = /^\d+$/.test(left);
  const rightIsNumeric = /^\d+$/.test(right);

  if (leftIsNumeric && rightIsNumeric) {
    return Number(left) - Number(right);
  }

  if (leftIsNumeric) return -1;
  if (rightIsNumeric) return 1;
  return left.localeCompare(right);
}

function compareSemver(left: string, right: string): number {
  const leftParsed = parseSemver(left);
  const rightParsed = parseSemver(right);

  if (!leftParsed || !rightParsed) {
    throw new Error(`Invalid semver comparison: '${left}' vs '${right}'`);
  }

  const coreOrder = (
    ["major", "minor", "patch"] as const
  ).map((key) => leftParsed[key] - rightParsed[key]).find((delta) => delta !== 0);
  if (coreOrder) {
    return coreOrder;
  }

  if (leftParsed.prerelease.length === 0 && rightParsed.prerelease.length === 0) {
    return 0;
  }
  if (leftParsed.prerelease.length === 0) return 1;
  if (rightParsed.prerelease.length === 0) return -1;

  const maxLength = Math.max(leftParsed.prerelease.length, rightParsed.prerelease.length);
  for (let index = 0; index < maxLength; index += 1) {
    const leftId = leftParsed.prerelease[index];
    const rightId = rightParsed.prerelease[index];
    if (leftId === undefined) return -1;
    if (rightId === undefined) return 1;

    const diff = compareIdentifiers(leftId, rightId);
    if (diff !== 0) return diff;
  }

  return 0;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a PluginLoader service.
 *
 * The loader is responsible for explicit plugin installation and runtime
 * activation. It reads the requested package from a local path or npm,
 * validates its manifest, registers it in the database, and initialises worker
 * processes and job schedules through the required runtime service graph.
 *
 * Usage:
 * ```ts
 * const loader = pluginLoader(db, loaderOpts);
 * loader.bindRuntimeServices({
 *   workerManager,
 *   jobScheduler,
 *   jobStore,
 *   lifecycleManager,
 *   buildHostBinding: (pluginId, manifest) => ({
 *     handlers: { ... },
 *     async dispose() {},
 *   }),
 *   instanceInfo: { instanceId: "inst-1", hostVersion: "1.0.0" },
 * });
 *
 * const plugin = await loader.installPlugin({
 *   source: "npm",
 *   packageName: "paperclip-plugin-linear",
 *   version: "^1.0.0",
 * });
 *
 * // Load all ready plugins at startup
 * const loadResult = await loader.loadAll();
 * console.log(`Loaded ${loadResult.succeeded}/${loadResult.total} plugins`);
 *
 * // Load a single plugin after install
 * const singleResult = await loader.loadSingle(pluginId);
 *
 * // Shutdown all plugin workers on server exit
 * await loader.shutdownAll();
 * ```
 *
 * @see PLUGIN_SPEC.md §8.1 — On-Disk Layout
 * @see PLUGIN_SPEC.md §8.3 — Install Process
 * @see PLUGIN_SPEC.md §12 — Process Model
 */
export function pluginLoader(
  db: Db,
  options: PluginLoaderOptions,
): PluginLoader {
  const localPluginDir = path.resolve(options.localPluginDir);
  const migrationDb = options.migrationDb;

  const registry = pluginRegistryService(db);
  const log = logger.child({ service: "plugin-loader" });
  let runtimeServices: PluginRuntimeServices | undefined;
  const activeHostBindings = new Map<string, {
    pluginKey: string;
    binding: PluginHostBinding;
    handlers: HostClientHandlers;
    revoke(): void;
  }>();

  function createRevocableHostBinding(
    pluginId: string,
    pluginKey: string,
    binding: PluginHostBinding,
  ) {
    let revoked = false;
    const handlers = Object.fromEntries(
      Object.entries(binding.handlers).map(([method, handler]) => {
        const invoke = handler as unknown as (
          ...args: unknown[]
        ) => Promise<unknown>;
        return [
          method,
          async (...args: unknown[]) => {
            if (revoked) {
              throw new Error(
                `Plugin host binding is revoked: ${pluginId} (${pluginKey})`,
              );
            }
            return invoke(...args);
          },
        ];
      }),
    ) as HostClientHandlers;

    return {
      pluginKey,
      binding,
      handlers,
      revoke() {
        revoked = true;
      },
    };
  }

  function requireRuntimeServices(operation: string): PluginRuntimeServices {
    if (!runtimeServices) {
      throw new Error(
        `Cannot ${operation}: PluginRuntimeServices have not been bound. `
          + "Call bindRuntimeServices() before runtime activation.",
      );
    }
    return runtimeServices;
  }

  async function disposeHostBinding(pluginId: string): Promise<void> {
    const active = activeHostBindings.get(pluginId);
    if (!active) return;
    await active.binding.dispose();
    activeHostBindings.delete(pluginId);
  }

  async function unloadPluginRuntime(pluginId: string): Promise<void> {
    const services = requireRuntimeServices("unload plugin runtime");
    const activeBinding = activeHostBindings.get(pluginId);
    const pluginKey = activeBinding?.pluginKey;
    const errors: unknown[] = [];
    let unregisterAttempt: Promise<void> | null = null;

    // unregisterPlugin closes job admission synchronously, then waits for
    // already-admitted executions through their terminal DB writes before it
    // cancels residual rows. Start that fence before stopping the worker, but
    // attach a rejection handler immediately and do not await it yet.
    try {
      unregisterAttempt = services.jobScheduler.unregisterPlugin(pluginId);
      void unregisterAttempt.catch(() => undefined);
    } catch (err) {
      errors.push(err);
    }

    try {
      if (services.workerManager.getWorker(pluginId)) {
        await services.workerManager.stopWorker(pluginId);
      }
    } catch (err) {
      errors.push(err);
    }

    // The binding remains available while accepted worker handlers drain.
    // Once the bounded stop attempt finishes, revoke synchronously before
    // awaiting scheduler teardown or disposing the binding, including on
    // forced failure.
    activeBinding?.revoke();

    if (unregisterAttempt) {
      try {
        await unregisterAttempt;
      } catch (err) {
        errors.push(err);
      }
    }
    try {
      await disposeHostBinding(pluginId);
    } catch (err) {
      errors.push(err);
    }

    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        `Failed to completely unload plugin runtime ${pluginId}`,
      );
    }
    log.info({ pluginId, pluginKey }, "plugin-loader: plugin runtime unloaded");
  }

  async function updateManifestWithCompatibleConfig(
    pluginId: string,
    manifest: PaperclipPluginManifestV1,
    update: { packageName: string; packagePath: string },
  ): Promise<void> {
    await db.transaction(async (tx) => {
      const locked = await lockPluginInstallationInTransaction(tx, pluginId);
      if (!locked) {
        throw new Error(`Plugin installation is unavailable: ${pluginId}`);
      }
      await lockPluginRegistryClaimsInTransaction(tx, manifest, pluginId);
      const txDb = tx as unknown as Db;
      const txRegistry = pluginRegistryService(txDb);
      const configRow = await txRegistry.getConfig(pluginId);
      assertPluginConfigCompatible(
        configRow?.configJson ?? {},
        manifest.instanceConfigSchema,
      );
      await txRegistry.update(pluginId, {
        packageName: update.packageName,
        packagePath: update.packagePath,
        manifest,
      });
    });
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Fetch a plugin from npm or local path, then parse and validate its manifest.
   *
   * This internal helper encapsulates the core plugin retrieval and validation
   * logic used by both install and upgrade operations. It handles:
   * 1. Resolving the package from npm or local filesystem.
   * 2. Installing the package via npm if necessary.
   * 3. Reading and parsing the plugin manifest.
   * 4. Validating API version compatibility.
   * 5. Validating manifest capabilities.
   *
   * @param installOptions - Options specifying the package to fetch.
   * @returns The resolved package and validated manifest.
   */
  async function fetchAndValidate(
    installOptions: PluginInstallRequest,
  ): Promise<ResolvedPluginPackage> {
    const hostVersion = requireRuntimeServices("validate plugin package").instanceInfo.hostVersion;
    let managedInstallRoot: string | null = null;

    try {
      let resolvedPackagePath: string;

      if (installOptions.source === "local") {
        if (!path.isAbsolute(installOptions.path)) {
          throw new Error("Local plugin path must be absolute");
        }
        if (!existsSync(installOptions.path)) {
          throw new Error(`Local plugin path does not exist: ${installOptions.path}`);
        }
        resolvedPackagePath = realpathSync(installOptions.path);
      } else {
        const spec = installOptions.version
          ? `${installOptions.packageName}@${installOptions.version}`
          : installOptions.packageName;
        await mkdir(localPluginDir, { recursive: true });
        managedInstallRoot = await mkdtemp(path.join(localPluginDir, "install-"));

        log.info(
          { spec, installRoot: managedInstallRoot },
          "plugin-loader: fetching plugin from npm",
        );

        try {
          // A candidate gets its own immutable dependency tree. It cannot
          // alter any installed plugin before validation and persistence.
          await execFileAsync(
            "npm",
            ["install", "--prefix", managedInstallRoot, "--save", "--ignore-scripts", "--", spec],
            { timeout: 120_000 },
          );
        } catch (err) {
          throw new Error(`npm install failed for ${spec}: ${String(err)}`);
        }

        resolvedPackagePath = resolveManagedInstallPackageDir(
          managedInstallRoot,
          installOptions.packageName,
        );
        if (!existsSync(resolvedPackagePath)) {
          throw new Error(
            `Package directory not found after installation: ${resolvedPackagePath}`,
          );
        }
        resolvedPackagePath = realpathSync(resolvedPackagePath);
      }

      const pkgJson = await readPackageJson(resolvedPackagePath);
      const declaredPackageName = pkgJson["name"];
      const declaredPackageVersion = pkgJson["version"];
      if (typeof declaredPackageName !== "string" || declaredPackageName.trim().length === 0) {
        throw new Error(`Plugin package.json must declare a nonblank name: ${resolvedPackagePath}`);
      }
      if (
        installOptions.source === "npm"
        && declaredPackageName !== installOptions.packageName
      ) {
        throw new Error(
          `Requested package name '${installOptions.packageName}' does not match package.json name '${declaredPackageName}'`,
        );
      }
      if (typeof declaredPackageVersion !== "string" || !parseSemver(declaredPackageVersion)) {
        throw new Error(`Plugin package.json must declare a valid semver version: ${resolvedPackagePath}`);
      }

      const manifestPath = resolveManifestPath(resolvedPackagePath, pkgJson);
      const manifest = await loadManifestFromPath(manifestPath);
      if (manifest.version !== declaredPackageVersion) {
        throw new Error(
          `Plugin manifest version '${manifest.version}' does not match package.json version '${declaredPackageVersion}'`,
        );
      }

      if (installOptions.source === "local") {
        log.info(
          { path: resolvedPackagePath, packageName: declaredPackageName },
          "plugin-loader: fetching plugin from local path",
        );
      }

      const minimumHostVersion = manifest.minimumHostVersion;
      if (minimumHostVersion && compareSemver(hostVersion, minimumHostVersion) < 0) {
        throw new Error(
          `Plugin ${manifest.id} requires host version ${minimumHostVersion} or newer, ` +
            `but this server is running ${hostVersion}`,
        );
      }

      return {
        packagePath: resolvedPackagePath,
        packageName: declaredPackageName,
        version: declaredPackageVersion,
        source: installOptions.source,
        manifest,
        managedInstallRoot,
      };
    } catch (err) {
      if (managedInstallRoot) {
        await rm(managedInstallRoot, { recursive: true, force: true }).catch((cleanupError) => {
          log.warn(
            { installRoot: managedInstallRoot, err: cleanupError },
            "plugin-loader: failed to discard rejected npm candidate",
          );
        });
      }
      throw err;
    }
  }

  /**
   * Attempt to load and validate a plugin manifest from a resolved path.
   * Returns the manifest on success or throws with a descriptive error.
   */
  async function loadManifestFromPath(
    manifestPath: string,
  ): Promise<PaperclipPluginManifestV1> {
    let raw: unknown;

    try {
      // Dynamic import works for both .js (ESM) and .cjs (CJS) manifests
      const manifestUrl = pathToFileURL(manifestPath);
      const manifestStat = await stat(manifestPath);
      manifestUrl.searchParams.set("mtime", String(Math.trunc(manifestStat.mtimeMs)));
      const mod = await import(manifestUrl.href) as Record<string, unknown>;
      if (!("default" in mod)) {
        throw new Error("Manifest module must provide a default export");
      }
      raw = mod["default"];
    } catch (err) {
      throw new Error(
        `Failed to load manifest module at ${manifestPath}: ${String(err)}`,
      );
    }

    return parsePluginManifest(raw);
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  return {
    // -----------------------------------------------------------------------
    // installPlugin
    // -----------------------------------------------------------------------

    async installPlugin(installOptions: PluginInstallRequest): Promise<PluginRecord> {
      const resolved = await fetchAndValidate(installOptions);
      const manifest = resolved.manifest;
      const initialStatus = validatePluginInstanceConfig(
        {},
        manifest.instanceConfigSchema,
      ).valid
        ? "ready"
        : "disabled";

      let plugin: PluginRecord;
      try {
        // Only a fully validated package becomes canonical. The registry row
        // and plugin-owned migrations commit together; a rejected candidate's
        // isolated npm tree is discarded below.
        const installDb = manifest.database ? migrationDb : db;
        plugin = await installDb.transaction(async (tx) => {
          const txDb = tx as unknown as Db;
          const installed = await installPluginInTransaction(
            tx,
            {
              packageName: resolved.packageName,
              packagePath: resolved.packagePath,
              source: resolved.source,
              status: initialStatus,
            },
            manifest,
          );

          if (!installed) {
            throw new Error(`Plugin install did not return a registry row: ${manifest.id}`);
          }

          if (manifest.database) {
            await pluginDatabaseService(txDb).applyMigrations(
              installed.id,
              manifest,
              resolved.packagePath,
              { persistFailure: false },
            );
          }
          return installed;
        });
      } catch (err) {
        if (resolved.managedInstallRoot) {
          await rm(resolved.managedInstallRoot, { recursive: true, force: true }).catch((cleanupError) => {
            log.warn(
              { installRoot: resolved.managedInstallRoot, err: cleanupError },
              "plugin-loader: failed to discard uncommitted npm installation",
            );
          });
        }
        throw err;
      }

      log.info(
        {
          pluginId: manifest.id,
          packageName: resolved.packageName,
          version: resolved.version,
          capabilities: manifest.capabilities,
          status: plugin.status,
        },
        "plugin-loader: plugin installed successfully",
      );

      return plugin;
    },

    // -----------------------------------------------------------------------
    // prepareUpgrade
    // -----------------------------------------------------------------------

    /**
     * Prepare an already-installed plugin upgrade without changing its
     * authoritative registry row.
     *
     * This method:
     * 1. Fetches and validates the new plugin package using `fetchAndValidate`.
     * 2. Ensures the new manifest ID matches the existing plugin ID for safety.
     * 3. Returns one candidate that can be committed only after runtime drain.
     *
     * @param pluginId - The UUID of the plugin to upgrade.
     * @param upgradeOptions - Optional target version for managed npm installs.
     * @returns The old and new manifests, along with the resolved package.
     * @throws {Error} If the plugin is not found or if the new manifest ID differs.
     */
    async prepareUpgrade(
      pluginId: string,
      upgradeOptions: PluginUpgradeOptions,
    ): Promise<PreparedPluginUpgrade> {
      const plugin = await registry.getById(pluginId);
      if (!plugin) throw new Error(`Plugin not found: ${pluginId}`);
      const previousPlugin = plugin;

      if (!path.isAbsolute(plugin.packagePath)) {
        throw new Error(`Plugin installation package root is not absolute: ${pluginId}`);
      }
      if (!existsSync(plugin.packagePath)) {
        throw new Error(`Plugin package root does not exist: ${plugin.packagePath}`);
      }
      const persistedPackageRoot = realpathSync(plugin.packagePath);
      const oldManifest = plugin.manifestJson;
      if (plugin.source === "local" && upgradeOptions.version !== undefined) {
        throw new Error("A target version cannot be specified for a local-source plugin upgrade");
      }

      log.info(
        {
          pluginId,
          packageName: plugin.packageName,
          version: upgradeOptions.version,
          source: plugin.source,
        },
        "plugin-loader: upgrading plugin",
      );

      let candidate: ResolvedPluginPackage | null = null;
      try {
        candidate = await fetchAndValidate(plugin.source === "npm"
          ? {
              source: "npm",
              packageName: plugin.packageName,
              version: upgradeOptions.version,
            }
          : {
              source: "local",
              path: persistedPackageRoot,
            });
        const newManifest = candidate.manifest;

        if (newManifest.id !== oldManifest.id) {
          throw new Error(
            `Upgrade failed: new manifest ID '${newManifest.id}' does not match existing plugin ID '${oldManifest.id}'`,
          );
        }

        const oldCaps = new Set(oldManifest.capabilities);
        const escalated = newManifest.capabilities.filter((capability) =>
          !oldCaps.has(capability)
        );
        if (escalated.length > 0) {
          log.warn(
            { pluginId, escalated, oldVersion: oldManifest.version, newVersion: newManifest.version },
            "plugin-loader: upgrade rejected capability escalation",
          );
          throw new Error(
            `Upgrade for "${pluginId}" introduces unsupported capability escalation: ${escalated.join(", ")}`,
          );
        }

        let disposition: "prepared" | "committed" | "discarded" = "prepared";
        return {
          previousPlugin,
          oldManifest,
          newManifest,
          async commit() {
            if (disposition !== "prepared") {
              throw new Error(
                `Plugin upgrade candidate is already ${disposition}: ${pluginId}`,
              );
            }
            await updateManifestWithCompatibleConfig(pluginId, newManifest, {
              packageName: candidate!.packageName,
              packagePath: candidate!.packagePath,
            });
            disposition = "committed";
          },
          async discard() {
            if (disposition === "discarded") return;
            if (disposition !== "prepared") {
              throw new Error(
                `Committed plugin upgrade candidate cannot be discarded: ${pluginId}`,
              );
            }
            if (candidate!.managedInstallRoot) {
              await rm(candidate!.managedInstallRoot, {
                recursive: true,
                force: true,
              });
            }
            disposition = "discarded";
          },
        };
      } catch (error) {
        if (candidate?.managedInstallRoot) {
          await rm(candidate.managedInstallRoot, { recursive: true, force: true }).catch((cleanupError) => {
            log.warn(
              { installRoot: candidate?.managedInstallRoot, err: cleanupError },
              "plugin-loader: failed to discard rejected upgrade candidate",
            );
          });
        }
        throw error;
      }
    },

    // -----------------------------------------------------------------------
    // cleanupInstallArtifacts
    // -----------------------------------------------------------------------

    async cleanupInstallArtifacts(plugin: PluginRecord): Promise<void> {
      if (plugin.source === "local") {
        return;
      }
      const installRoot = resolveManagedInstallRoot(
        localPluginDir,
        plugin.packagePath,
        plugin.packageName,
      );
      await rm(installRoot, { recursive: true, force: true });
    },

    // -----------------------------------------------------------------------
    // bindRuntimeServices
    // -----------------------------------------------------------------------

    bindRuntimeServices(services: PluginRuntimeServices): void {
      if (runtimeServices !== undefined) {
        throw new Error("Plugin runtime services are already bound");
      }
      runtimeServices = services;
    },

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
        log.warn(
          { cancelledRuns },
          "plugin-loader: cancelled interrupted plugin job runs",
        );
      }

      const failedDeliveries = await registry.failInterruptedWebhookDeliveries(
        "Paperclip restarted before webhook delivery completed",
      );
      if (failedDeliveries > 0) {
        log.warn(
          { failedDeliveries },
          "plugin-loader: failed interrupted webhook deliveries",
        );
      }

      // Crash-safe reconciliation: install candidates are immutable roots and
      // only registry-referenced roots are live. A crash before persistence or
      // after uninstall cleanup therefore leaves a safely removable orphan.
      if (existsSync(localPluginDir)) {
        const livePlugins = await registry.list();
        const referencedRoots = new Set(
          livePlugins
            .filter((plugin) => plugin.source === "npm")
            .map((plugin) => resolveManagedInstallRoot(
              localPluginDir,
              plugin.packagePath,
              plugin.packageName,
            )),
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

      log.info(
        { count: readyPlugins.length },
        "plugin-loader: found ready plugins to load",
      );

      const loadResults = await Promise.all(
        readyPlugins.map((plugin) => activatePlugin(plugin))
      );

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
          `Cannot load plugin in status '${plugin.status}'. ` +
            `Plugin must be in 'ready' status.`,
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
  };

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

    const {
      workerManager,
      jobScheduler,
      jobStore,
      lifecycleManager,
      buildHostBinding,
      instanceInfo,
    } = requireRuntimeServices("activate plugin");

    try {
      log.info(
        { pluginId, pluginKey, version: manifest.version },
        "plugin-loader: activating plugin",
      );

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
      assertPluginConfigCompatible(
        configRow?.configJson ?? {},
        manifest.instanceConfigSchema,
      );

      // ------------------------------------------------------------------
      // 3. Apply restricted database migrations before worker startup
      // ------------------------------------------------------------------
      let databaseNamespace: string | null = null;
      if (manifest.database) {
        const namespace = await pluginDatabaseService(migrationDb)
          .applyMigrations(pluginId, manifest, packageRoot);
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
          const detail = stderrExcerpt.trim()
            ? `; stderr: ${stderrExcerpt.trim()}`
            : "";
          await lifecycleManager.markError(
            pluginId,
            `Worker restart budget exhausted (${exit})${detail}`,
          );
        },
        env: buildPluginWorkerEnv({ instanceInfo }),
      };

      await workerManager.startWorker(pluginId, workerOptions);
      log.info(
        { pluginId, pluginKey },
        "plugin-loader: worker started",
      );

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
        log.debug(
          { pluginId, pluginKey },
          "plugin-loader: empty job declarations synced",
        );
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

      log.error(
        { pluginId, pluginKey, err: errorMessage },
        "plugin-loader: failed to activate plugin",
      );

      let failure = errorMessage;
      try {
        await unloadPluginRuntime(pluginId);
      } catch (cleanupErr) {
        const cleanupMessage = cleanupErr instanceof Error
          ? cleanupErr.message
          : String(cleanupErr);
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
}

// ---------------------------------------------------------------------------
// Worker entrypoint resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the absolute path to a plugin's worker entrypoint from its manifest.
 *
 * The manifest `entrypoints.worker` field is relative to the package root.
 *
 * @see PLUGIN_SPEC.md §10 — Package Contract
 */
function resolveWorkerEntrypoint(
  plugin: PluginRecord,
  packageRoot: string,
): string {
  return resolvePluginPath(
    packageRoot,
    plugin.manifestJson.entrypoints.worker,
    {
      label: `Worker entrypoint for plugin "${plugin.pluginKey}"`,
      kind: "file",
    },
  );
}

function resolvePluginPackageRoot(plugin: PluginRecord): string {
  if (!path.isAbsolute(plugin.packagePath)) {
    throw new Error(
      `Plugin installation package root is not absolute: ${plugin.pluginKey}`,
    );
  }
  if (!existsSync(plugin.packagePath)) {
    throw new Error(
      `Canonical package root not found for plugin "${plugin.pluginKey}": ${plugin.packagePath}`,
    );
  }
  return realpathSync(plugin.packagePath);
}

function resolveManagedInstallPackageDir(localPluginDir: string, packageName: string): string {
  const nodeModulesDir = path.resolve(localPluginDir, "node_modules");
  const segments = packageName.split("/");
  const validSegments = packageName.startsWith("@")
    ? segments.length === 2
      && segments[0]!.length > 1
      && segments[1]!.length > 0
    : segments.length === 1 && segments[0]!.length > 0;
  if (!validSegments || segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error(`Invalid plugin package name: ${packageName}`);
  }

  const packageDir = path.resolve(nodeModulesDir, ...segments);
  if (!isPathContained(nodeModulesDir, packageDir) || packageDir === nodeModulesDir) {
    throw new Error(`Invalid plugin package name: ${packageName}`);
  }
  return packageDir;
}

function isManagedInstallRootName(name: string): boolean {
  return /^install-[A-Za-z0-9_-]+$/.test(name);
}

function resolveManagedInstallRoot(
  localPluginDir: string,
  packagePath: string,
  packageName: string,
): string {
  if (!path.isAbsolute(packagePath)) {
    throw new Error(`Managed plugin package root is not absolute: ${packagePath}`);
  }

  const managedRoot = path.resolve(localPluginDir);
  const relativePackagePath = path.relative(managedRoot, path.resolve(packagePath));
  const segments = relativePackagePath.split(path.sep);
  const installRootName = segments[0];
  if (
    !installRootName
    || !isManagedInstallRootName(installRootName)
    || segments[1] !== "node_modules"
  ) {
    throw new Error(`Managed plugin package root is outside the canonical install layout: ${packagePath}`);
  }

  const installRoot = path.resolve(managedRoot, installRootName);
  const expectedPackagePath = resolveManagedInstallPackageDir(installRoot, packageName);
  if (path.resolve(packagePath) !== expectedPackagePath) {
    throw new Error(`Managed plugin package root does not match its installation record: ${packagePath}`);
  }
  return installRoot;
}
