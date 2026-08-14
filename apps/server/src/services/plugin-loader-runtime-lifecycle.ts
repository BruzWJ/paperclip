import type { Db } from "@paperclipai/db";
import type { PaperclipPluginManifestV1, PluginRecord } from "@paperclipai/shared";
import type { HostClientHandlers } from "@paperclipai/plugin-sdk";
import {
  lockPluginInstallationInTransaction,
  lockPluginRegistryClaimsInTransaction,
  pluginRegistryService,
} from "./plugin-registry.js";
import {
  assertPluginConfigCompatible,
  type PluginHostBinding,
  type PluginRuntimeServices,
} from "./plugin-loader-contracts.js";
import type { PluginLoaderContext } from "./plugin-loader.js";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { isPathContained, resolvePluginPath } from "./plugin-paths.js";

export function buildPluginLoaderRuntimeLifecycle(scope: PluginLoaderContext) {
  const { db, log, activeHostBindings } = scope;

  function createRevocableHostBinding(pluginId: string, pluginKey: string, binding: PluginHostBinding) {
    let revoked = false;
    const handlers = Object.fromEntries(
      Object.entries(binding.handlers).map(([method, handler]) => {
        const invoke = handler as unknown as (...args: unknown[]) => Promise<unknown>;
        return [
          method,
          async (...args: unknown[]) => {
            if (revoked) {
              throw new Error(`Plugin host binding is revoked: ${pluginId} (${pluginKey})`);
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
    if (!scope.runtimeServicesRef.current) {
      throw new Error(
        `Cannot ${operation}: PluginRuntimeServices have not been bound. ` +
          "Call bindRuntimeServices() before runtime activation.",
      );
    }
    return scope.runtimeServicesRef.current;
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
      throw new AggregateError(errors, `Failed to completely unload plugin runtime ${pluginId}`);
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
      assertPluginConfigCompatible(configRow?.configJson ?? {}, manifest.instanceConfigSchema);
      await txRegistry.update(pluginId, {
        packageName: update.packageName,
        packagePath: update.packagePath,
        manifest,
      });
    });
  }

  return {
    createRevocableHostBinding,
    requireRuntimeServices,
    disposeHostBinding,
    unloadPluginRuntime,
    updateManifestWithCompatibleConfig,
  };
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
export function resolveWorkerEntrypoint(plugin: PluginRecord, packageRoot: string): string {
  return resolvePluginPath(packageRoot, plugin.manifestJson.entrypoints.worker, {
    label: `Worker entrypoint for plugin "${plugin.pluginKey}"`,
    kind: "file",
  });
}

export function resolvePluginPackageRoot(plugin: PluginRecord): string {
  if (!path.isAbsolute(plugin.packagePath)) {
    throw new Error(`Plugin installation package root is not absolute: ${plugin.pluginKey}`);
  }
  if (!existsSync(plugin.packagePath)) {
    throw new Error(
      `Canonical package root not found for plugin "${plugin.pluginKey}": ${plugin.packagePath}`,
    );
  }
  return realpathSync(plugin.packagePath);
}

export function resolveManagedInstallPackageDir(localPluginDir: string, packageName: string): string {
  const nodeModulesDir = path.resolve(localPluginDir, "node_modules");
  const segments = packageName.split("/");
  const validSegments = packageName.startsWith("@")
    ? segments.length === 2 && segments[0]!.length > 1 && segments[1]!.length > 0
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

export function isManagedInstallRootName(name: string): boolean {
  return /^install-[A-Za-z0-9_-]+$/.test(name);
}

export function resolveManagedInstallRoot(
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
  if (!installRootName || !isManagedInstallRootName(installRootName) || segments[1] !== "node_modules") {
    throw new Error(`Managed plugin package root is outside the canonical install layout: ${packagePath}`);
  }

  const installRoot = path.resolve(managedRoot, installRootName);
  const expectedPackagePath = resolveManagedInstallPackageDir(installRoot, packageName);
  if (path.resolve(packagePath) !== expectedPackagePath) {
    throw new Error(`Managed plugin package root does not match its installation record: ${packagePath}`);
  }
  return installRoot;
}
