import { existsSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import type { Db } from "@paperclipai/db";
import type { PluginInstallRequest, PluginRecord } from "@paperclipai/shared";
import { installPluginInTransaction } from "./plugin-registry.js";
import { pluginDatabaseService } from "./plugin-database.js";
import { validatePluginInstanceConfig } from "./plugin-config-validator.js";
import {
  type PluginLoader,
  type PluginRuntimeServices,
  type PluginUpgradeOptions,
  type PreparedPluginUpgrade,
  type ResolvedPluginPackage,
} from "./plugin-loader-contracts.js";
import { resolveManagedInstallRoot } from "./plugin-loader-runtime-lifecycle.js";
import { type PluginLoaderContext } from "./plugin-loader.js";
import { buildPluginLoaderRuntimeLifecycle } from "./plugin-loader-runtime-lifecycle.js";
import { buildPluginLoaderDiscovery } from "./plugin-loader-discovery.js";
import { buildPluginLoaderActivation } from "./plugin-loader-activation.js";

export function createPluginLoaderMethods1(
  scope: PluginLoaderContext &
    ReturnType<typeof buildPluginLoaderRuntimeLifecycle> &
    ReturnType<typeof buildPluginLoaderDiscovery> &
    ReturnType<typeof buildPluginLoaderActivation>,
) {
  const {
    db,
    localPluginDir,
    migrationDb,
    registry,
    log,
    updateManifestWithCompatibleConfig,
    fetchAndValidate,
  } = scope;

  return {
    // -----------------------------------------------------------------------
    // installPlugin
    // -----------------------------------------------------------------------

    async installPlugin(installOptions: PluginInstallRequest): Promise<PluginRecord> {
      const resolved = await fetchAndValidate(installOptions);
      const manifest = resolved.manifest;
      const initialStatus = validatePluginInstanceConfig({}, manifest.instanceConfigSchema).valid
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
            await pluginDatabaseService(txDb).applyMigrations(installed.id, manifest, resolved.packagePath, {
              persistFailure: false,
            });
          }
          return installed;
        });
      } catch (err) {
        if (resolved.managedInstallRoot) {
          await rm(resolved.managedInstallRoot, {
            recursive: true,
            force: true,
          }).catch((cleanupError) => {
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
        candidate = await fetchAndValidate(
          plugin.source === "npm"
            ? {
                source: "npm",
                packageName: plugin.packageName,
                version: upgradeOptions.version,
              }
            : {
                source: "local",
                path: persistedPackageRoot,
              },
        );
        const newManifest = candidate.manifest;

        if (newManifest.id !== oldManifest.id) {
          throw new Error(
            `Upgrade failed: new manifest ID '${newManifest.id}' does not match existing plugin ID '${oldManifest.id}'`,
          );
        }

        const oldCaps = new Set(oldManifest.capabilities);
        const escalated = newManifest.capabilities.filter((capability) => !oldCaps.has(capability));
        if (escalated.length > 0) {
          log.warn(
            {
              pluginId,
              escalated,
              oldVersion: oldManifest.version,
              newVersion: newManifest.version,
            },
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
              throw new Error(`Plugin upgrade candidate is already ${disposition}: ${pluginId}`);
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
              throw new Error(`Committed plugin upgrade candidate cannot be discarded: ${pluginId}`);
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
          await rm(candidate.managedInstallRoot, {
            recursive: true,
            force: true,
          }).catch((cleanupError) => {
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
      const installRoot = resolveManagedInstallRoot(localPluginDir, plugin.packagePath, plugin.packageName);
      await rm(installRoot, { recursive: true, force: true });
    },

    // -----------------------------------------------------------------------
    // bindRuntimeServices
    // -----------------------------------------------------------------------

    bindRuntimeServices(services: PluginRuntimeServices): void {
      if (scope.runtimeServicesRef.current !== undefined) {
        throw new Error("Plugin runtime services are already bound");
      }
      scope.runtimeServicesRef.current = services;
    },
  } satisfies Pick<
    PluginLoader,
    "installPlugin" | "prepareUpgrade" | "cleanupInstallArtifacts" | "bindRuntimeServices"
  >;
}
