import { asc, eq, sql } from "drizzle-orm";
import { plugins, pluginDatabaseNamespaces } from "@paperclipai/db";
import {
  type PaperclipPluginManifestV1,
  type PluginStatus,
  type PluginInstallSource,
} from "@paperclipai/shared";
import type { WorkerToHostMethods } from "@paperclipai/plugin-sdk";
import { conflict } from "../errors.js";
import type { TaskSessionDbTransaction } from "./task-session/event-store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const HOST_MANAGED_AGENT_ENTITY_TYPE = "managed_agent";

export type PluginEntityQuery = WorkerToHostMethods["entities.list"][0];

export type PluginEntityUpsertStorageInput = WorkerToHostMethods["entities.upsert"][0] & {
  companyId: string | null;
};

export interface PluginRegistryInstallInput {
  packageName: string;
  packagePath: string;
  source: PluginInstallSource;
  status: Extract<PluginStatus, "ready" | "disabled">;
}

export const PLUGIN_REGISTRY_ADVISORY_LOCK_ID = 1_347_179_847;

export type PluginUiRouteClaim = {
  namespace: "company" | "company-settings";
  routePath: string;
};

export function pluginUiRouteClaims(manifest: PaperclipPluginManifestV1): PluginUiRouteClaim[] {
  const claims: PluginUiRouteClaim[] = [];
  for (const slot of manifest.ui?.slots ?? []) {
    if (slot.type === "page" && slot.routePath) {
      claims.push({ namespace: "company", routePath: slot.routePath });
    }
    if (slot.type === "companySettingsPage" && slot.routePath) {
      claims.push({ namespace: "company-settings", routePath: slot.routePath });
    }
  }
  return claims;
}

export interface UpdatePluginStatus {
  status: PluginStatus;
  lastError?: string | null;
}

export function assertGenericPluginEntityMutationAllowed(entityType: string): void {
  if (entityType === HOST_MANAGED_AGENT_ENTITY_TYPE) {
    throw conflict("Plugin-managed agent provenance is owned by the managed-agent lifecycle service", {
      code: "plugin_managed_agent_generic_entity_mutation_denied",
    });
  }
}

/**
 * Detect if a Postgres error is a unique-constraint violation on the
 * `plugins_plugin_key_idx` unique index.
 */
export function isPluginKeyConflict(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null) return false;
    const err = current as {
      code?: string;
      constraint?: string;
      constraint_name?: string;
      cause?: unknown;
    };
    const constraint = err.constraint ?? err.constraint_name;
    if (err.code === "23505" && constraint === "plugins_plugin_key_idx") {
      return true;
    }
    current = err.cause;
  }
  return false;
}

/**
 * Serialize and validate the instance-wide claims owned by a plugin manifest.
 * Every install and manifest replacement must call this inside its transaction.
 */
export async function lockPluginRegistryClaimsInTransaction(
  tx: TaskSessionDbTransaction,
  manifest: PaperclipPluginManifestV1,
  excludePluginId?: string,
) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${PLUGIN_REGISTRY_ADVISORY_LOCK_ID}::bigint)`);
  const installations = await tx.select().from(plugins);
  const requestedClaims = pluginUiRouteClaims(manifest);

  for (const installation of installations) {
    if (installation.id === excludePluginId) {
      continue;
    }
    const installedClaims = pluginUiRouteClaims(installation.manifestJson);
    const conflictClaim = requestedClaims.find((requested) =>
      installedClaims.some(
        (installed) =>
          installed.namespace === requested.namespace && installed.routePath === requested.routePath,
      ),
    );
    if (conflictClaim) {
      const scope = conflictClaim.namespace === "company" ? "company page" : "company settings page";
      throw conflict(
        `Plugin ${manifest.id} ${scope} routePath "${conflictClaim.routePath}" conflicts with installed plugin ${installation.pluginKey}`,
      );
    }
  }

  return installations;
}

/** Persist one validated installation while holding the registry claim lock. */
export async function installPluginInTransaction(
  tx: TaskSessionDbTransaction,
  input: PluginRegistryInstallInput,
  manifest: PaperclipPluginManifestV1,
) {
  const installations = await lockPluginRegistryClaimsInTransaction(tx, manifest);
  if (installations.some((installation) => installation.pluginKey === manifest.id)) {
    throw conflict(`Plugin already installed: ${manifest.id}`);
  }

  const installOrder =
    installations.reduce((highest, installation) => Math.max(highest, installation.installOrder), 0) + 1;

  try {
    return await tx
      .insert(plugins)
      .values({
        pluginKey: manifest.id,
        packageName: input.packageName,
        source: input.source,
        manifestJson: manifest,
        status: input.status,
        installOrder,
        packagePath: input.packagePath,
      })
      .returning()
      .then((rows) => rows[0]);
  } catch (error) {
    if (isPluginKeyConflict(error)) {
      throw conflict(`Plugin already installed: ${manifest.id}`);
    }
    throw error;
  }
}

export function quotePersistedNamespace(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`Persisted plugin database namespace is invalid: ${value}`);
  }
  return `"${value.replaceAll('"', '""')}"`;
}

export async function lockPluginInstallationInTransaction(tx: TaskSessionDbTransaction, id: string) {
  return tx
    .select()
    .from(plugins)
    .where(eq(plugins.id, id))
    .for("update")
    .then((rows) => rows[0] ?? null);
}

export async function persistPluginStatusInTransaction(
  tx: TaskSessionDbTransaction,
  id: string,
  input: UpdatePluginStatus,
  now: Date,
) {
  return tx
    .update(plugins)
    .set({
      status: input.status,
      lastError: input.lastError ?? null,
      updatedAt: now,
    })
    .where(eq(plugins.id, id))
    .returning()
    .then((rows) => rows[0] ?? null);
}

/**
 * Delete one installation after its runtime and durable authority have been
 * fenced. The installation-owned namespace is physical state outside normal
 * row cascading, so it is dropped explicitly. The installation row then owns
 * deletion of all operational data, including ephemeral run-context handles,
 * through foreign-key cascades. Historical task/run audit rows retain their
 * immutable plugin key or call identity with no installation FK.
 */
export async function deletePluginInstallationInTransaction(
  tx: TaskSessionDbTransaction,
  pluginId: string,
): Promise<typeof plugins.$inferSelect | null> {
  const installation = await lockPluginInstallationInTransaction(tx, pluginId);
  if (!installation) return null;
  if (installation.status !== "disabled") {
    throw conflict("Plugin installation must be disabled before deletion");
  }

  const namespaces = await tx
    .select()
    .from(pluginDatabaseNamespaces)
    .where(eq(pluginDatabaseNamespaces.pluginId, pluginId))
    .orderBy(asc(pluginDatabaseNamespaces.namespaceName))
    .for("update");

  for (const namespace of namespaces) {
    await tx.execute(
      sql.raw(`DROP SCHEMA IF EXISTS ${quotePersistedNamespace(namespace.namespaceName)} CASCADE`),
    );
  }

  return tx
    .delete(plugins)
    .where(eq(plugins.id, pluginId))
    .returning()
    .then((rows) => rows[0] ?? null);
}
