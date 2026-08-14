import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { type Db, pluginDatabaseNamespaces, pluginMigrations, plugins } from "@paperclipai/db";
import type { PaperclipPluginManifestV1, PluginMigrationRecord } from "@paperclipai/shared";
import * as databaseValidation from "./plugin-database-validation.js";

export type PluginDatabaseClient = Pick<Db, "select" | "insert" | "update" | "execute">;

export type PluginDatabaseRootClient = PluginDatabaseClient & Partial<Pick<Db, "transaction">>;

export interface ApplyPluginMigrationsOptions {
  /**
   * Persist failed migration ledger rows. Fresh install uses false because the
   * caller owns a larger transaction and must roll back the plugin row and
   * namespace together.
   */
  persistFailure?: boolean;
}

export function pluginDatabaseService(db: PluginDatabaseRootClient) {
  async function getPluginRecord(pluginId: string) {
    const rows = await db.select().from(plugins).where(eq(plugins.id, pluginId)).limit(1);
    const plugin = rows[0];
    if (!plugin) throw new Error(`Plugin not found: ${pluginId}`);
    return plugin;
  }

  async function ensureNamespaceWithClient(
    client: PluginDatabaseClient,
    pluginId: string,
    manifest: PaperclipPluginManifestV1,
  ) {
    if (!manifest.database) return null;
    const namespaceName = databaseValidation.derivePluginDatabaseNamespace(
      manifest.id,
      pluginId,
      manifest.database.namespaceSlug,
    );
    await client.execute(
      sql.raw(`CREATE SCHEMA IF NOT EXISTS ${databaseValidation.quoteIdentifier(namespaceName)}`),
    );
    const rows = await client
      .insert(pluginDatabaseNamespaces)
      .values({
        pluginId,
        pluginKey: manifest.id,
        namespaceName,
        status: "active",
      })
      .onConflictDoUpdate({
        target: pluginDatabaseNamespaces.pluginId,
        set: {
          pluginKey: manifest.id,
          namespaceName,
          status: "active",
          updatedAt: new Date(),
        },
      })
      .returning();
    return rows[0] ?? null;
  }

  async function ensureNamespace(pluginId: string, manifest: PaperclipPluginManifestV1) {
    return ensureNamespaceWithClient(db, pluginId, manifest);
  }

  async function getRuntimeNamespace(pluginId: string) {
    const namespace = await db
      .select({ namespace: pluginDatabaseNamespaces })
      .from(pluginDatabaseNamespaces)
      .innerJoin(plugins, and(eq(plugins.id, pluginDatabaseNamespaces.pluginId), eq(plugins.status, "ready")))
      .where(
        and(eq(pluginDatabaseNamespaces.pluginId, pluginId), eq(pluginDatabaseNamespaces.status, "active")),
      )
      .limit(1)
      .then((rows) => rows[0]?.namespace ?? null);
    if (!namespace) {
      throw new Error("Plugin database namespace is not active");
    }
    return namespace.namespaceName;
  }

  async function recordMigrationFailure(
    client: PluginDatabaseClient,
    input: {
      pluginId: string;
      pluginKey: string;
      namespaceName: string;
      migrationKey: string;
      checksum: string;
      pluginVersion: string;
      error: unknown;
    },
  ): Promise<void> {
    const message = input.error instanceof Error ? input.error.message : String(input.error);
    await client
      .insert(pluginMigrations)
      .values({
        pluginId: input.pluginId,
        pluginKey: input.pluginKey,
        namespaceName: input.namespaceName,
        migrationKey: input.migrationKey,
        checksum: input.checksum,
        pluginVersion: input.pluginVersion,
        status: "failed",
        errorMessage: message,
      })
      .onConflictDoUpdate({
        target: [pluginMigrations.pluginId, pluginMigrations.migrationKey],
        set: {
          checksum: input.checksum,
          pluginVersion: input.pluginVersion,
          status: "failed",
          errorMessage: message,
          startedAt: new Date(),
          appliedAt: null,
        },
      });
    await client
      .update(pluginDatabaseNamespaces)
      .set({ status: "migration_failed", updatedAt: new Date() })
      .where(eq(pluginDatabaseNamespaces.pluginId, input.pluginId));
  }

  return {
    async applyMigrations(
      pluginId: string,
      manifest: PaperclipPluginManifestV1,
      packageRoot: string,
      options: ApplyPluginMigrationsOptions = {},
    ) {
      if (!manifest.database) return null;
      const namespace = await ensureNamespace(pluginId, manifest);
      if (!namespace) {
        throw new Error("Plugin database namespace creation returned no namespace");
      }

      const migrationDir = databaseValidation.resolveMigrationsDir(
        packageRoot,
        manifest.database.migrationsDir,
      );
      const migrationFiles = await databaseValidation.listSqlMigrationFiles(migrationDir);
      const coreReadTables = manifest.database.coreReadTables ?? [];
      const migrationNamespace = databaseValidation.derivePluginDatabaseMigrationNamespace(
        manifest.id,
        manifest.database.namespaceSlug,
      );
      const lockKey = Number.parseInt(createHash("sha256").update(pluginId).digest("hex").slice(0, 12), 16);
      const persistFailure = options.persistFailure ?? true;

      const applyWithClient = async (client: PluginDatabaseClient) => {
        await client.execute(sql`SELECT pg_advisory_xact_lock(${lockKey})`);
        for (const migrationKey of migrationFiles) {
          const content = await readFile(path.join(migrationDir, migrationKey), "utf8");
          const checksum = createHash("sha256").update(content).digest("hex");
          const existingRows = await client
            .select()
            .from(pluginMigrations)
            .where(
              and(eq(pluginMigrations.pluginId, pluginId), eq(pluginMigrations.migrationKey, migrationKey)),
            )
            .limit(1);
          const existing = existingRows[0] as PluginMigrationRecord | undefined;
          if (existing?.status === "applied") {
            if (existing.checksum !== checksum) {
              throw new Error(`Plugin migration checksum mismatch for ${migrationKey}`);
            }
            continue;
          }

          const statements = databaseValidation.splitSqlStatements(content);
          try {
            if (statements.length === 0) {
              throw new Error(`Plugin migration ${migrationKey} is empty`);
            }
            for (const sourceStatement of statements) {
              const statement = databaseValidation.compilePluginMigrationNamespace(
                sourceStatement,
                migrationNamespace,
                namespace.namespaceName,
              );
              databaseValidation.validatePluginMigrationStatement(
                statement,
                namespace.namespaceName,
                coreReadTables,
              );
              await client.execute(sql.raw(statement));
            }
            await client
              .insert(pluginMigrations)
              .values({
                pluginId,
                pluginKey: manifest.id,
                namespaceName: namespace.namespaceName,
                migrationKey,
                checksum,
                pluginVersion: manifest.version,
                status: "applied",
                appliedAt: new Date(),
              })
              .onConflictDoUpdate({
                target: [pluginMigrations.pluginId, pluginMigrations.migrationKey],
                set: {
                  checksum,
                  pluginVersion: manifest.version,
                  status: "applied",
                  errorMessage: null,
                  startedAt: new Date(),
                  appliedAt: new Date(),
                },
              });
          } catch (error) {
            if (persistFailure) {
              await recordMigrationFailure(db, {
                pluginId,
                pluginKey: manifest.id,
                namespaceName: namespace.namespaceName,
                migrationKey,
                checksum,
                pluginVersion: manifest.version,
                error,
              });
            }
            throw error;
          }
        }
      };

      if (typeof db.transaction === "function") {
        await db.transaction(async (tx) => applyWithClient(tx as PluginDatabaseClient));
      } else {
        await applyWithClient(db);
      }

      return namespace;
    },

    getRuntimeNamespace,

    async query<T = Record<string, unknown>>(
      pluginId: string,
      statement: string,
      params?: unknown[],
    ): Promise<T[]> {
      const plugin = await getPluginRecord(pluginId);
      const namespace = await getRuntimeNamespace(pluginId);
      databaseValidation.validatePluginRuntimeQuery(
        statement,
        namespace,
        plugin.manifestJson.database?.coreReadTables ?? [],
      );
      const result = await db.execute(databaseValidation.bindSql(statement, params));
      return Array.from(result as Iterable<T>);
    },

    async execute(pluginId: string, statement: string, params?: unknown[]): Promise<{ rowCount: number }> {
      const namespace = await getRuntimeNamespace(pluginId);
      databaseValidation.validatePluginRuntimeExecute(statement, namespace);
      const result = await db.execute(databaseValidation.bindSql(statement, params));
      return {
        rowCount: Number((result as { count?: number | string }).count ?? 0),
      };
    },
  };
}
