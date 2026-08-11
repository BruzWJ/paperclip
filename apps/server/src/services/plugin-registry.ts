import { asc, eq, sql, and } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  plugins,
  pluginConfig,
  pluginCompanySettings,
  pluginDatabaseNamespaces,
  pluginEntities,
  pluginWebhookDeliveries,
} from "@paperclipai/db";
import type {
  PaperclipPluginManifestV1,
  PluginStatus,
  PluginCompanySettings,
  PluginInstallSource,
} from "@paperclipai/shared";
import type { WorkerToHostMethods } from "@paperclipai/plugin-sdk";
import { conflict, notFound } from "../errors.js";
import type { TaskSessionDbTransaction } from "./task-session/event-store.js";
import { lockPluginCompanySettingScopeInTransaction } from "./plugin-authorization-locks.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HOST_MANAGED_AGENT_ENTITY_TYPE = "managed_agent";

type PluginEntityQuery = WorkerToHostMethods["entities.list"][0];
type PluginEntityUpsertStorageInput = WorkerToHostMethods["entities.upsert"][0] & {
  companyId: string | null;
};

interface PluginRegistryInstallInput {
  packageName: string;
  packagePath: string;
  source: PluginInstallSource;
  status: Extract<PluginStatus, "ready" | "disabled">;
}

const PLUGIN_REGISTRY_ADVISORY_LOCK_ID = 1_347_179_847;

type PluginUiRouteClaim = {
  namespace: "company" | "company-settings";
  routePath: string;
};

function pluginUiRouteClaims(
  manifest: PaperclipPluginManifestV1,
): PluginUiRouteClaim[] {
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

interface UpdatePluginStatus {
  status: PluginStatus;
  lastError?: string | null;
}

function assertGenericPluginEntityMutationAllowed(entityType: string): void {
  if (entityType === HOST_MANAGED_AGENT_ENTITY_TYPE) {
    throw conflict(
      "Plugin-managed agent provenance is owned by the managed-agent lifecycle service",
      { code: "plugin_managed_agent_generic_entity_mutation_denied" },
    );
  }
}

/**
 * Detect if a Postgres error is a unique-constraint violation on the
 * `plugins_plugin_key_idx` unique index.
 */
function isPluginKeyConflict(error: unknown): boolean {
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
    if (
      err.code === "23505" &&
      constraint === "plugins_plugin_key_idx"
    ) {
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
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(${PLUGIN_REGISTRY_ADVISORY_LOCK_ID}::bigint)`,
  );
  const installations = await tx.select().from(plugins);
  const requestedClaims = pluginUiRouteClaims(manifest);

  for (const installation of installations) {
    if (installation.id === excludePluginId) {
      continue;
    }
    const installedClaims = pluginUiRouteClaims(installation.manifestJson);
    const conflictClaim = requestedClaims.find((requested) =>
      installedClaims.some((installed) =>
        installed.namespace === requested.namespace
        && installed.routePath === requested.routePath
      )
    );
    if (conflictClaim) {
      const scope = conflictClaim.namespace === "company"
        ? "company page"
        : "company settings page";
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
  if (installations.some((installation) =>
    installation.pluginKey === manifest.id
  )) {
    throw conflict(`Plugin already installed: ${manifest.id}`);
  }

  const installOrder = installations.reduce(
    (highest, installation) => Math.max(highest, installation.installOrder),
    0,
  ) + 1;

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

function quotePersistedNamespace(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`Persisted plugin database namespace is invalid: ${value}`);
  }
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

export async function lockPluginInstallationInTransaction(
  tx: TaskSessionDbTransaction,
  id: string,
) {
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
      sql.raw(
        `DROP SCHEMA IF EXISTS ${quotePersistedNamespace(namespace.namespaceName)} CASCADE`,
      ),
    );
  }

  return tx
    .delete(plugins)
    .where(eq(plugins.id, pluginId))
    .returning()
    .then((rows) => rows[0] ?? null);
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * PluginRegistry – CRUD operations for the `plugins` and `plugin_config`
 * tables.  Follows the same factory-function pattern used by the rest of
 * the Paperclip service layer.
 *
 * This is the lowest-level persistence layer for plugins. Higher-level
 * concerns such as lifecycle state-machine enforcement and worker-to-host
 * capability gating are handled by the lifecycle manager and the SDK host
 * client handlers respectively.
 *
 * @see PLUGIN_SPEC.md §21.3 — Required Tables
 */
export function pluginRegistryService(db: Db) {
  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  async function getById(id: string) {
    return db
      .select()
      .from(plugins)
      .where(eq(plugins.id, id))
      .then((rows) => rows[0] ?? null);
  }

  async function getByKey(pluginKey: string) {
    return db
      .select()
      .from(plugins)
      .where(eq(plugins.pluginKey, pluginKey))
      .then((rows) => rows[0] ?? null);
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  return {
    /**
     * Mark webhook deliveries left pending by a terminated server process as
     * failed. Delivery execution is not resumable and is never retried here.
     */
    failInterruptedWebhookDeliveries: async (reason: string): Promise<number> => {
      const rows = await db
        .update(pluginWebhookDeliveries)
        .set({
          status: "failed",
          error: reason,
          durationMs: null,
          finishedAt: new Date(),
        })
        .where(eq(pluginWebhookDeliveries.status, "pending"))
        .returning({ id: pluginWebhookDeliveries.id });
      return rows.length;
    },

    // ----- Read -----------------------------------------------------------

    /** List all live plugin installations ordered by install order. */
    list: () =>
      db
        .select()
        .from(plugins)
        .orderBy(asc(plugins.installOrder)),

    /** List plugins filtered by status. */
    listByStatus: (status: PluginStatus) =>
      db
        .select()
        .from(plugins)
        .where(eq(plugins.status, status))
        .orderBy(asc(plugins.installOrder)),

    /** Get a live plugin installation by primary key. */
    getById,

    /** Get the live installation for a `pluginKey`. */
    getByKey,

    // ----- Update ---------------------------------------------------------

    /**
     * Update a plugin's package location and authoritative manifest snapshot.
     * The plugin must already exist.
     */
    update: async (
      id: string,
      data: {
        packageName?: string;
        packagePath?: string;
        manifest?: PaperclipPluginManifestV1;
      },
    ) => {
      const plugin = await getById(id);
      if (!plugin) throw notFound("Plugin not found");

      const setClause: Partial<typeof plugins.$inferInsert> & { updatedAt: Date } = {
        updatedAt: new Date(),
      };
      if (data.packageName !== undefined) setClause.packageName = data.packageName;
      if (data.packagePath !== undefined) setClause.packagePath = data.packagePath;
      if (data.manifest !== undefined) {
        setClause.manifestJson = data.manifest;
      }

      return db
        .update(plugins)
        .set(setClause)
        .where(eq(plugins.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
    },

    // ----- Status ---------------------------------------------------------

    /** Update a plugin's lifecycle status and optional error message. */
    updateStatus: async (id: string, input: UpdatePluginStatus) => {
      if (input.status === "disabled") {
        throw conflict(
          `Plugin status '${input.status}' requires the atomic lifecycle transition`,
        );
      }
      return db.transaction(async (tx) => {
        const plugin = await lockPluginInstallationInTransaction(tx, id);
        if (!plugin) throw notFound("Plugin not found");
        return persistPluginStatusInTransaction(
          tx,
          id,
          input,
          new Date(),
        );
      });
    },

    // ----- Config ---------------------------------------------------------

    /** Retrieve an installed plugin's instance-scoped configuration. */
    getConfig: (pluginId: string) =>
      db
        .select()
        .from(pluginConfig)
        .where(eq(pluginConfig.pluginId, pluginId))
        .then((rows) => rows[0] ?? null),

    /** Create or replace an installed plugin's instance configuration. */
    upsertConfig: async (pluginId: string, configJson: Record<string, unknown>) => {
      const [config] = await db
        .insert(pluginConfig)
        .values({ pluginId, configJson })
        .onConflictDoUpdate({
          target: pluginConfig.pluginId,
          set: { configJson, updatedAt: new Date() },
        })
        .returning();
      if (!config) {
        throw new Error("Plugin configuration upsert returned no record");
      }
      return config;
    },

    // ----- Company settings ----------------------------------------------

    /** Retrieve company-scoped plugin settings. */
    getCompanySettings: (pluginId: string, companyId: string): Promise<PluginCompanySettings | null> =>
      db
        .select()
        .from(pluginCompanySettings)
        .where(and(
          eq(pluginCompanySettings.pluginId, pluginId),
          eq(pluginCompanySettings.companyId, companyId),
        ))
        .then((rows) => rows[0] ?? null),

    /** Create or replace company-scoped plugin settings. */
    upsertCompanySettings: async (
      pluginId: string,
      companyId: string,
      input: { settingsJson: Record<string, unknown> },
    ): Promise<PluginCompanySettings> =>
      db.transaction(async (tx) => {
        const scope =
          await lockPluginCompanySettingScopeInTransaction(tx, {
            pluginInstallationId: pluginId,
            companyId,
          });
        if (!scope.installation) {
          throw notFound("Plugin not found");
        }
        if (!scope.company) {
          throw notFound("Company not found");
        }

        const now = new Date();
        if (scope.companySetting) {
          const [updated] = await tx
            .update(pluginCompanySettings)
            .set({
              settingsJson: input.settingsJson,
              updatedAt: now,
            })
            .where(
              eq(
                pluginCompanySettings.id,
                scope.companySetting.id,
              ),
            )
            .returning();
          if (!updated) {
            throw new Error("Plugin company settings update returned no record");
          }
          return updated;
        }

        const [created] = await tx
          .insert(pluginCompanySettings)
          .values({
            pluginId,
            companyId,
            settingsJson: input.settingsJson,
          })
          .returning();
        if (!created) {
          throw new Error("Plugin company settings insert returned no record");
        }
        return created;
      }),

    // ----- Entities -------------------------------------------------------

    /**
     * List persistent entity mappings owned by a specific plugin, with filtering and pagination.
     *
     * @param pluginId - The UUID of the plugin.
     * @param query - Optional filters (type, externalId) and pagination (limit, offset).
     * @returns A list of matching `PluginEntityRecord` objects.
     */
    listEntities: (pluginId: string, query?: PluginEntityQuery) => {
      const conditions = [eq(pluginEntities.pluginId, pluginId)];
      if (query?.entityType) conditions.push(eq(pluginEntities.entityType, query.entityType));
      if (query?.scopeKind) conditions.push(eq(pluginEntities.scopeKind, query.scopeKind));
      if (query?.scopeId !== undefined) conditions.push(eq(pluginEntities.scopeId, query.scopeId));
      if (query?.externalId !== undefined) conditions.push(eq(pluginEntities.externalId, query.externalId));

      return db
        .select()
        .from(pluginEntities)
        .where(and(...conditions))
        .orderBy(asc(pluginEntities.createdAt))
        .limit(query?.limit ?? 100)
        .offset(query?.offset ?? 0);
    },

    /**
     * Create or update a persistent mapping between a Paperclip object and an
     * external entity.
     *
     * @param pluginId - The UUID of the plugin.
     * @param input - The entity data to persist.
     * @returns The newly created or updated `PluginEntityRecord`.
     */
    upsertEntity: async (
      pluginId: string,
      input: PluginEntityUpsertStorageInput,
    ) => {
      assertGenericPluginEntityMutationAllowed(input.entityType);
      const [entity] = await db
        .insert(pluginEntities)
        .values({
          pluginId,
          companyId: input.companyId,
          entityType: input.entityType,
          scopeKind: input.scopeKind,
          scopeId: input.scopeId ?? null,
          externalId: input.externalId ?? null,
          title: input.title ?? null,
          status: input.status ?? null,
          data: input.data,
        })
        .onConflictDoUpdate({
          target: [
            pluginEntities.companyId,
            pluginEntities.pluginId,
            pluginEntities.entityType,
            pluginEntities.scopeKind,
            pluginEntities.scopeId,
            pluginEntities.externalId,
          ],
          set: {
            title: input.title ?? null,
            status: input.status ?? null,
            data: input.data,
            updatedAt: new Date(),
          },
        })
        .returning();
      if (!entity) {
        throw new Error("Plugin entity upsert returned no record");
      }
      return entity;
    },

  };
}
