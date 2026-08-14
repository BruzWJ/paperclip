import { asc, eq, and } from "drizzle-orm";
import {
  pluginCompanySettings,
  pluginConfig,
  pluginEntities,
  pluginWebhookDeliveries,
  plugins,
  type Db,
} from "@paperclipai/db";
import {
  isCanonicalUuid,
  type PaperclipPluginManifestV1,
  type PluginStatus,
  type PluginCompanySettings,
} from "@paperclipai/shared";
import { conflict, notFound } from "../errors.js";
import { lockPluginCompanySettingScopeInTransaction } from "./plugin-authorization-locks.js";
import {
  assertGenericPluginEntityMutationAllowed,
  lockPluginInstallationInTransaction,
  persistPluginStatusInTransaction,
  type PluginEntityQuery,
  type PluginEntityUpsertStorageInput,
  type UpdatePluginStatus,
} from "./plugin-registry-transactions.js";

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
    if (!isCanonicalUuid(id)) return null;
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
    list: () => db.select().from(plugins).orderBy(asc(plugins.installOrder)),

    /** List plugins filtered by status. */
    listByStatus: (status: PluginStatus) =>
      db.select().from(plugins).where(eq(plugins.status, status)).orderBy(asc(plugins.installOrder)),

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

      const setClause: Partial<typeof plugins.$inferInsert> & {
        updatedAt: Date;
      } = {
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
        throw conflict(`Plugin status '${input.status}' requires the atomic lifecycle transition`);
      }
      return db.transaction(async (tx) => {
        const plugin = await lockPluginInstallationInTransaction(tx, id);
        if (!plugin) throw notFound("Plugin not found");
        return persistPluginStatusInTransaction(tx, id, input, new Date());
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
        .where(
          and(eq(pluginCompanySettings.pluginId, pluginId), eq(pluginCompanySettings.companyId, companyId)),
        )
        .then((rows) => rows[0] ?? null),

    /** Create or replace company-scoped plugin settings. */
    upsertCompanySettings: async (
      pluginId: string,
      companyId: string,
      input: { settingsJson: Record<string, unknown> },
    ): Promise<PluginCompanySettings> =>
      db.transaction(async (tx) => {
        const scope = await lockPluginCompanySettingScopeInTransaction(tx, {
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
            .where(eq(pluginCompanySettings.id, scope.companySetting.id))
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
    upsertEntity: async (pluginId: string, input: PluginEntityUpsertStorageInput) => {
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
