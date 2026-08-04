import { asc, eq, isNull, ne, sql, and } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  plugins,
  pluginConfig,
  pluginCompanySettings,
  pluginDatabaseNamespaces,
  pluginEntities,
  pluginJobs,
  pluginJobRuns,
  pluginMigrations,
  pluginState,
  pluginWebhookDeliveries,
} from "@paperclipai/db";
import type {
  PaperclipPluginManifestV1,
  PluginStatus,
  InstallPlugin,
  UpdatePluginStatus,
  UpsertPluginConfig,
  PatchPluginConfig,
  PluginCompanySettings,
  PluginEntityRecord,
  PluginEntityQuery,
  PluginJobRecord,
  PluginJobRunRecord,
  PluginWebhookDeliveryRecord,
  PluginJobStatus,
  PluginJobRunStatus,
  PluginJobRunTrigger,
  PluginWebhookDeliveryStatus,
} from "@paperclipai/shared";
import { conflict, notFound } from "../errors.js";
import type { IssueSessionDbTransaction } from "./issue-session/event-store.js";
import { lockPluginCompanySettingScopeInTransaction } from "./plugin-authorization-locks.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HOST_MANAGED_AGENT_ENTITY_TYPE = "managed_agent";

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

function quotePersistedNamespace(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`Persisted plugin database namespace is invalid: ${value}`);
  }
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

export async function lockPluginInstallationInTransaction(
  tx: IssueSessionDbTransaction,
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
  tx: IssueSessionDbTransaction,
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
 * Purge only operational data owned by one installation. Historical identity,
 * issue provenance, callback/withdrawal delivery records, comments, logs,
 * entities, managed-resource bindings, and audit rows deliberately remain.
 */
export async function purgePluginOperationalDataInTransaction(
  tx: IssueSessionDbTransaction,
  pluginId: string,
): Promise<void> {
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

  await tx
    .delete(pluginMigrations)
    .where(eq(pluginMigrations.pluginId, pluginId));
  await tx
    .delete(pluginDatabaseNamespaces)
    .where(eq(pluginDatabaseNamespaces.pluginId, pluginId));
  await tx
    .delete(pluginJobRuns)
    .where(eq(pluginJobRuns.pluginId, pluginId));
  await tx
    .delete(pluginJobs)
    .where(eq(pluginJobs.pluginId, pluginId));
  await tx
    .delete(pluginWebhookDeliveries)
    .where(eq(pluginWebhookDeliveries.pluginId, pluginId));
  await tx
    .delete(pluginState)
    .where(eq(pluginState.pluginId, pluginId));
  await tx
    .delete(pluginCompanySettings)
    .where(eq(pluginCompanySettings.pluginId, pluginId));
  await tx
    .delete(pluginConfig)
    .where(eq(pluginConfig.pluginId, pluginId));
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
 * concerns such as lifecycle state-machine enforcement and capability
 * gating are handled by {@link pluginLifecycleManager} and
 * {@link pluginCapabilityValidator} respectively.
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
      .where(
        and(
          eq(plugins.id, id),
          ne(plugins.status, "uninstalled"),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  async function getByKey(pluginKey: string) {
    return db
      .select()
      .from(plugins)
      .where(
        and(
          eq(plugins.pluginKey, pluginKey),
          ne(plugins.status, "uninstalled"),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  async function nextInstallOrder(): Promise<number> {
    const result = await db
      .select({ maxOrder: sql<number>`coalesce(max(${plugins.installOrder}), 0)` })
      .from(plugins);
    return (result[0]?.maxOrder ?? 0) + 1;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  return {
    // ----- Read -----------------------------------------------------------

    /** List all live plugin installations ordered by install order. */
    list: () =>
      db
        .select()
        .from(plugins)
        .where(ne(plugins.status, "uninstalled"))
        .orderBy(asc(plugins.installOrder)),

    /**
     * List installed plugins (excludes terminal installation tombstones).
     * Use for Plugin Manager and default API list so uninstalled plugins do not appear.
     */
    listInstalled: () =>
      db
        .select()
        .from(plugins)
        .where(ne(plugins.status, "uninstalled"))
        .orderBy(asc(plugins.installOrder)),

    /** List plugins filtered by status. */
    listByStatus: (status: PluginStatus) =>
      db
        .select()
        .from(plugins)
        .where(
          and(
            eq(plugins.status, status),
            ne(plugins.status, "uninstalled"),
          ),
        )
        .orderBy(asc(plugins.installOrder)),

    /** Get a live plugin installation by primary key. */
    getById,

    /** Get the live installation for a `pluginKey`. */
    getByKey,

    // ----- Install / Register --------------------------------------------

    /**
     * Register (install) a new plugin.
     *
     * The caller is expected to have already resolved and validated the
     * manifest from the package.  This method persists the plugin row and
     * assigns the next install order.
     */
    install: async (input: InstallPlugin, manifest: PaperclipPluginManifestV1) => {
      const existing = await getByKey(manifest.id);
      if (existing) {
        throw conflict(`Plugin already installed: ${manifest.id}`);
      }

      const installOrder = await nextInstallOrder();

      try {
        const rows = await db
          .insert(plugins)
          .values({
            pluginKey: manifest.id,
            packageName: input.packageName,
            version: manifest.version,
            apiVersion: manifest.apiVersion,
            categories: manifest.categories,
            manifestJson: manifest,
            status: "installed" as PluginStatus,
            installOrder,
            packagePath: input.packagePath ?? null,
          })
          .returning();
        return rows[0];
      } catch (error) {
        if (isPluginKeyConflict(error)) {
          throw conflict(`Plugin already installed: ${manifest.id}`);
        }
        throw error;
      }
    },

    // ----- Update ---------------------------------------------------------

    /**
     * Update a plugin's manifest and version (e.g. on upgrade).
     * The plugin must already exist.
     */
    update: async (
      id: string,
      data: {
        packageName?: string;
        version?: string;
        manifest?: PaperclipPluginManifestV1;
      },
    ) => {
      const plugin = await getById(id);
      if (!plugin) throw notFound("Plugin not found");

      const setClause: Partial<typeof plugins.$inferInsert> & { updatedAt: Date } = {
        updatedAt: new Date(),
      };
      if (data.packageName !== undefined) setClause.packageName = data.packageName;
      if (data.version !== undefined) setClause.version = data.version;
      if (data.manifest !== undefined) {
        setClause.manifestJson = data.manifest;
        setClause.apiVersion = data.manifest.apiVersion;
        setClause.categories = data.manifest.categories;
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
      if (
        input.status === "disabled" ||
        input.status === "uninstalled"
      ) {
        throw conflict(
          `Plugin status '${input.status}' requires the atomic lifecycle transition`,
        );
      }
      return db.transaction(async (tx) => {
        const plugin = await lockPluginInstallationInTransaction(tx, id);
        if (!plugin) throw notFound("Plugin not found");
        if (plugin.status === "uninstalled") {
          throw conflict(
            "Uninstalled plugin installation tombstones are immutable",
          );
        }
        return persistPluginStatusInTransaction(
          tx,
          id,
          input,
          new Date(),
        );
      });
    },

    // ----- Config ---------------------------------------------------------

    /** Retrieve a plugin's company-scoped configuration. */
    getConfig: (pluginId: string, companyId: string) =>
      db
        .select()
        .from(pluginConfig)
        .where(and(eq(pluginConfig.pluginId, pluginId), eq(pluginConfig.companyId, companyId)))
        .then((rows) => rows[0] ?? null),

    /**
     * Create or fully replace a plugin's company-scoped configuration.
     * If a config row already exists for the plugin/company pair it is replaced;
     * otherwise a new row is inserted.
     */
    upsertConfig: async (pluginId: string, companyId: string, input: UpsertPluginConfig) => {
      const plugin = await getById(pluginId);
      if (!plugin) throw notFound("Plugin not found");

      const existing = await db
        .select()
        .from(pluginConfig)
        .where(and(eq(pluginConfig.pluginId, pluginId), eq(pluginConfig.companyId, companyId)))
        .then((rows) => rows[0] ?? null);

      if (existing) {
        return db
          .update(pluginConfig)
          .set({
            configJson: input.configJson,
            lastError: null,
            updatedAt: new Date(),
          })
          .where(and(eq(pluginConfig.pluginId, pluginId), eq(pluginConfig.companyId, companyId)))
          .returning()
          .then((rows) => rows[0]);
      }

      return db
        .insert(pluginConfig)
        .values({
          pluginId,
          companyId,
          configJson: input.configJson,
        })
        .returning()
        .then((rows) => rows[0]);
    },

    /**
     * Partially update a plugin's company-scoped configuration via shallow merge.
     * If no config row exists yet one is created with the supplied values.
     */
    patchConfig: async (pluginId: string, companyId: string, input: PatchPluginConfig) => {
      const plugin = await getById(pluginId);
      if (!plugin) throw notFound("Plugin not found");

      const existing = await db
        .select()
        .from(pluginConfig)
        .where(and(eq(pluginConfig.pluginId, pluginId), eq(pluginConfig.companyId, companyId)))
        .then((rows) => rows[0] ?? null);

      if (existing) {
        const merged = { ...existing.configJson, ...input.configJson };
        return db
          .update(pluginConfig)
          .set({
            configJson: merged,
            lastError: null,
            updatedAt: new Date(),
          })
          .where(and(eq(pluginConfig.pluginId, pluginId), eq(pluginConfig.companyId, companyId)))
          .returning()
          .then((rows) => rows[0]);
      }

      return db
        .insert(pluginConfig)
        .values({
          pluginId,
          companyId,
          configJson: input.configJson,
        })
        .returning()
        .then((rows) => rows[0]);
    },

    /**
     * Record an error against a plugin's config (e.g. validation failure
     * against the plugin's instanceConfigSchema).
     */
    setConfigError: async (pluginId: string, companyId: string, lastError: string | null) => {
      const rows = await db
        .update(pluginConfig)
        .set({ lastError, updatedAt: new Date() })
        .where(and(eq(pluginConfig.pluginId, pluginId), eq(pluginConfig.companyId, companyId)))
        .returning();

      if (rows.length === 0) throw notFound("Plugin config not found");
      return rows[0];
    },

    /** Delete a plugin's config row. */
    deleteConfig: async (pluginId: string, companyId: string) => {
      const rows = await db
        .delete(pluginConfig)
        .where(and(eq(pluginConfig.pluginId, pluginId), eq(pluginConfig.companyId, companyId)))
        .returning();

      return rows[0] ?? null;
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
        .then((rows) => rows[0] ?? null) as Promise<PluginCompanySettings | null>,

    /** Create or replace company-scoped plugin settings. */
    upsertCompanySettings: async (
      pluginId: string,
      companyId: string,
      input: { enabled?: boolean; settingsJson: Record<string, unknown>; lastError?: string | null },
    ): Promise<PluginCompanySettings> =>
      db.transaction(async (tx) => {
        const scope =
          await lockPluginCompanySettingScopeInTransaction(tx, {
            pluginInstallationId: pluginId,
            companyId,
          });
        if (
          !scope.installation ||
          scope.installation.status === "uninstalled"
        ) {
          throw notFound("Plugin not found");
        }
        if (!scope.company) {
          throw notFound("Company not found");
        }

        const now = new Date();
        if (scope.companySetting) {
          return tx
            .update(pluginCompanySettings)
            .set({
              enabled:
                input.enabled ?? scope.companySetting.enabled,
              settingsJson: input.settingsJson,
              lastError: input.lastError ?? null,
              updatedAt: now,
            })
            .where(
              eq(
                pluginCompanySettings.id,
                scope.companySetting.id,
              ),
            )
            .returning()
            .then((rows) => rows[0]) as Promise<PluginCompanySettings>;
        }

        return tx
          .insert(pluginCompanySettings)
          .values({
            pluginId,
            companyId,
            enabled: input.enabled ?? true,
            settingsJson: input.settingsJson,
            lastError: input.lastError ?? null,
          })
          .returning()
          .then((rows) => rows[0]) as Promise<PluginCompanySettings>;
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
      if (query?.externalId) conditions.push(eq(pluginEntities.externalId, query.externalId));

      return db
        .select()
        .from(pluginEntities)
        .where(and(...conditions))
        .orderBy(asc(pluginEntities.createdAt))
        .limit(query?.limit ?? 100)
        .offset(query?.offset ?? 0);
    },

    /**
     * Look up a plugin-owned entity mapping by its external identifier.
     *
     * Scope matches `plugin_entities_external_idx` (NULLS NOT DISTINCT):
     * pass the owning `companyId` (or `null` for instance-scope) to retrieve
     * the row that belongs to that tenant. Two companies can share the same
     * `(pluginId, entityType, externalId)` tuple — omitting `companyId` would
     * return the first matched row regardless of tenant, which is unsafe.
     *
     * @param pluginId - The UUID of the plugin.
     * @param entityType - The type of entity (e.g., 'project', 'issue').
     * @param externalId - The identifier in the external system.
     * @param companyId - Tenant scope; `null` for instance-scope entities.
     * @returns The matching `PluginEntityRecord` or null.
     */
    getEntityByExternalId: (
      pluginId: string,
      entityType: string,
      externalId: string,
      companyId: string | null,
    ) => {
      const companyIdPredicate =
        companyId == null
          ? isNull(pluginEntities.companyId)
          : eq(pluginEntities.companyId, companyId);
      return db
        .select()
        .from(pluginEntities)
        .where(
          and(
            companyIdPredicate,
            eq(pluginEntities.pluginId, pluginId),
            eq(pluginEntities.entityType, entityType),
            eq(pluginEntities.externalId, externalId),
          ),
        )
        .then((rows) => rows[0] ?? null);
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
      input: Omit<typeof pluginEntities.$inferInsert, "id" | "pluginId" | "createdAt" | "updatedAt">,
    ) => {
      assertGenericPluginEntityMutationAllowed(input.entityType);
      // Drizzle doesn't support pg-specific onConflictDoUpdate easily in the insert() call
      // with complex where clauses, so we do it manually.
      // Match the per-tenant uniqueness of `plugin_entities_external_idx`
      // (companyId, pluginId, entityType, externalId) with NULLS NOT DISTINCT
      // semantics: two companies (and instance-scope NULLs across each other)
      // may share the same (pluginId, entityType, externalId) tuple, so the
      // lookup MUST scope by companyId — `isNull` for instance-scope, `eq`
      // otherwise — to avoid returning and overwriting another tenant's row.
      const companyIdPredicate =
        input.companyId == null
          ? isNull(pluginEntities.companyId)
          : eq(pluginEntities.companyId, input.companyId);
      const existing = await db
        .select()
        .from(pluginEntities)
        .where(
          and(
            companyIdPredicate,
            eq(pluginEntities.pluginId, pluginId),
            eq(pluginEntities.entityType, input.entityType),
            eq(pluginEntities.externalId, input.externalId ?? ""),
          ),
        )
        .then((rows) => rows[0] ?? null);

      if (existing) {
        return db
          .update(pluginEntities)
          .set({
            ...input,
            updatedAt: new Date(),
          })
          .where(eq(pluginEntities.id, existing.id))
          .returning()
          .then((rows) => rows[0]);
      }

      return db
        .insert(pluginEntities)
        .values({
          ...input,
          pluginId,
        } as any)
        .returning()
        .then((rows) => rows[0]);
    },

    /**
     * Delete a specific plugin-owned entity mapping by its internal UUID.
     *
     * @param id - The UUID of the entity record.
     * @returns The deleted record, or null if not found.
     */
    deleteEntity: async (id: string) => {
      const entity = await db
        .select({ entityType: pluginEntities.entityType })
        .from(pluginEntities)
        .where(eq(pluginEntities.id, id))
        .then((rows) => rows[0] ?? null);
      if (!entity) return null;
      assertGenericPluginEntityMutationAllowed(entity.entityType);
      const rows = await db
        .delete(pluginEntities)
        .where(
          and(
            eq(pluginEntities.id, id),
            ne(pluginEntities.entityType, HOST_MANAGED_AGENT_ENTITY_TYPE),
          ),
        )
        .returning();
      return rows[0] ?? null;
    },

    // ----- Jobs -----------------------------------------------------------

    /**
     * List all scheduled jobs registered for a specific plugin.
     *
     * @param pluginId - The UUID of the plugin.
     * @returns A list of `PluginJobRecord` objects.
     */
    listJobs: (pluginId: string) =>
      db
        .select()
        .from(pluginJobs)
        .where(eq(pluginJobs.pluginId, pluginId))
        .orderBy(asc(pluginJobs.jobKey)),

    /**
     * Look up a plugin job by its unique job key.
     *
     * @param pluginId - The UUID of the plugin.
     * @param jobKey - The key defined in the plugin manifest.
     * @returns The matching `PluginJobRecord` or null.
     */
    getJobByKey: (pluginId: string, jobKey: string) =>
      db
        .select()
        .from(pluginJobs)
        .where(and(eq(pluginJobs.pluginId, pluginId), eq(pluginJobs.jobKey, jobKey)))
        .then((rows) => rows[0] ?? null),

    /**
     * Register or update a scheduled job for a plugin.
     *
     * @param pluginId - The UUID of the plugin.
     * @param jobKey - The unique key for the job.
     * @param input - The schedule (cron) and optional status.
     * @returns The updated or created `PluginJobRecord`.
     */
    upsertJob: async (
      pluginId: string,
      jobKey: string,
      input: { schedule: string; status?: PluginJobStatus },
    ) => {
      const existing = await db
        .select()
        .from(pluginJobs)
        .where(and(eq(pluginJobs.pluginId, pluginId), eq(pluginJobs.jobKey, jobKey)))
        .then((rows) => rows[0] ?? null);

      if (existing) {
        return db
          .update(pluginJobs)
          .set({
            schedule: input.schedule,
            status: input.status ?? existing.status,
            updatedAt: new Date(),
          })
          .where(eq(pluginJobs.id, existing.id))
          .returning()
          .then((rows) => rows[0]);
      }

      return db
        .insert(pluginJobs)
        .values({
          pluginId,
          jobKey,
          schedule: input.schedule,
          status: input.status ?? "active",
        })
        .returning()
        .then((rows) => rows[0]);
    },

    /**
     * Record the start of a specific job execution.
     *
     * Pass the owning `companyId` so `plugin_job_runs.company_id` is populated
     * and the row participates in the `ON DELETE CASCADE` from `companies`.
     * `null` is the explicit instance-scope marker (cron jobs without a tenant);
     * those rows survive company deletes but are still attributable.
     *
     * @param pluginId - The UUID of the plugin.
     * @param jobId - The UUID of the parent job record.
     * @param trigger - What triggered this run (e.g., 'schedule', 'manual').
     * @param companyId - Tenant scope; `null` for instance-scope runs.
     * @returns The newly created `PluginJobRunRecord` in 'pending' status.
     */
    createJobRun: async (
      pluginId: string,
      jobId: string,
      trigger: PluginJobRunTrigger,
      companyId: string | null,
    ) => {
      return db
        .insert(pluginJobRuns)
        .values({
          pluginId,
          jobId,
          companyId,
          trigger,
          status: "pending",
        })
        .returning()
        .then((rows) => rows[0]);
    },

    /**
     * Update the status, duration, and logs of a job execution record.
     *
     * @param runId - The UUID of the job run.
     * @param input - The update fields (status, error, duration, etc.).
     * @returns The updated `PluginJobRunRecord`.
     */
    updateJobRun: async (
      runId: string,
      input: {
        status: PluginJobRunStatus;
        durationMs?: number;
        error?: string;
        logs?: string[];
        startedAt?: Date;
        finishedAt?: Date;
      },
    ) => {
      return db
        .update(pluginJobRuns)
        .set(input)
        .where(eq(pluginJobRuns.id, runId))
        .returning()
        .then((rows) => rows[0] ?? null);
    },

    // ----- Webhooks -------------------------------------------------------

    /**
     * Create a record for an incoming webhook delivery.
     *
     * Pass the owning `companyId` so `plugin_webhook_deliveries.company_id` is
     * populated and the row participates in the `ON DELETE CASCADE` from
     * `companies`. `null` is the explicit instance-scope marker (public
     * webhooks without a tenant); those rows survive company deletes but are
     * still attributable.
     *
     * @param pluginId - The UUID of the receiving plugin.
     * @param webhookKey - The endpoint key defined in the manifest.
     * @param companyId - Tenant scope; `null` for instance-scope deliveries.
     * @param input - The payload, headers, and optional external ID.
     * @returns The newly created `PluginWebhookDeliveryRecord` in 'pending' status.
     */
    createWebhookDelivery: async (
      pluginId: string,
      webhookKey: string,
      companyId: string | null,
      input: {
        externalId?: string;
        payload: Record<string, unknown>;
        headers?: Record<string, string>;
      },
    ) => {
      return db
        .insert(pluginWebhookDeliveries)
        .values({
          pluginId,
          webhookKey,
          companyId,
          externalId: input.externalId,
          payload: input.payload,
          headers: input.headers ?? {},
          status: "pending",
        })
        .returning()
        .then((rows) => rows[0]);
    },

    /**
     * Update the status and processing metrics of a webhook delivery.
     *
     * @param deliveryId - The UUID of the delivery record.
     * @param input - The update fields (status, error, duration, etc.).
     * @returns The updated `PluginWebhookDeliveryRecord`.
     */
    updateWebhookDelivery: async (
      deliveryId: string,
      input: {
        status: PluginWebhookDeliveryStatus;
        durationMs?: number;
        error?: string;
        startedAt?: Date;
        finishedAt?: Date;
      },
    ) => {
      return db
        .update(pluginWebhookDeliveries)
        .set(input)
        .where(eq(pluginWebhookDeliveries.id, deliveryId))
        .returning()
        .then((rows) => rows[0] ?? null);
    },
  };
}
