import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  derivePluginDatabaseMigrationNamespace,
  derivePluginDatabaseNamespace,
  pluginDatabaseService,
  validatePluginMigrationStatement,
  validatePluginRuntimeExecute,
  validatePluginRuntimeQuery,
} from "../services/plugin-database.js";
import { buildPluginWorkerEnv } from "../services/plugin-loader.js";
import { createMockDb } from "./helpers/mock-db.js";

const pluginId = "00000000-0000-4000-8000-000000000001";

function manifest(pluginKey = "paperclip.dbtest"): PaperclipPluginManifestV1 {
  return {
    id: pluginKey,
    apiVersion: 1,
    version: "1.0.0",
    displayName: "DB Test",
    description: "Exercises restricted plugin database access.",
    author: "Paperclip",
    categories: ["automation"],
    capabilities: [
      "database.namespace.migrate",
      "database.namespace.read",
      "database.namespace.write",
    ],
    entrypoints: { worker: "./dist/worker.js" },
    database: {
      migrationsDir: "migrations",
      coreReadTables: ["issues"],
    },
  };
}

describe("plugin database SQL validation", () => {
  it("derives a distinct physical namespace for every installation identity", () => {
    const pluginKey = "paperclip.installation-scope";
    const logical = derivePluginDatabaseMigrationNamespace(pluginKey);
    const first = derivePluginDatabaseNamespace(
      pluginKey,
      "00000000-0000-4000-8000-000000000001",
    );
    const second = derivePluginDatabaseNamespace(
      pluginKey,
      "00000000-0000-4000-8000-000000000002",
    );

    expect(first).not.toBe(second);
    expect(first).not.toBe(logical);
    expect(second).not.toBe(logical);
  });

  it("allows namespace migrations with whitelisted public foreign keys", () => {
    expect(() =>
      validatePluginMigrationStatement(
        "CREATE TABLE plugin_test.rows (id uuid PRIMARY KEY, issue_id uuid REFERENCES public.issues(id))",
        "plugin_test",
        ["issues"],
      )
    ).not.toThrow();
  });

  it("allows qualified indexes and namespace-scoped migration backfills", () => {
    expect(() =>
      validatePluginMigrationStatement(
        "CREATE INDEX IF NOT EXISTS rows_issue_idx ON plugin_test.rows (issue_id)",
        "plugin_test",
      )
    ).not.toThrow();
    expect(() =>
      validatePluginMigrationStatement(
        `WITH source_rows AS (SELECT id FROM plugin_test.rows)
         INSERT INTO plugin_test.row_copies (id)
         SELECT id FROM source_rows ON CONFLICT (id) DO NOTHING`,
        "plugin_test",
      )
    ).not.toThrow();
    expect(() =>
      validatePluginMigrationStatement(
        `UPDATE plugin_test.rows r SET copied_from_id = s.id
         FROM plugin_test.source_rows s WHERE s.id = r.id`,
        "plugin_test",
      )
    ).not.toThrow();
  });

  it("keeps migration writes scoped to the plugin namespace", () => {
    expect(() =>
      validatePluginMigrationStatement(
        "CREATE TABLE rows (id uuid PRIMARY KEY)",
        "plugin_test",
      )
    ).toThrow(/fully qualified/i);
    expect(() =>
      validatePluginMigrationStatement(
        "WITH source_rows AS (SELECT id FROM plugin_test.rows) INSERT INTO public.issues (id) SELECT id FROM source_rows",
        "plugin_test",
        ["issues"],
      )
    ).toThrow(/public/i);
    expect(() =>
      validatePluginMigrationStatement(
        "UPDATE public.issues SET title = 'bad'",
        "plugin_test",
        ["issues"],
      )
    ).toThrow(/public/i);
  });

  it("allows whitelisted runtime reads but rejects public writes", () => {
    expect(() =>
      validatePluginRuntimeQuery(
        "SELECT r.id FROM plugin_test.rows r JOIN public.issues i ON i.id = r.issue_id",
        "plugin_test",
        ["issues"],
      )
    ).not.toThrow();
    expect(() =>
      validatePluginRuntimeExecute(
        "UPDATE public.issues SET title = $1",
        "plugin_test",
      )
    ).toThrow(/namespace/i);
  });

  it("targets anonymous DO blocks without rejecting do-prefixed aliases", () => {
    expect(() =>
      validatePluginRuntimeQuery(
        "SELECT EXTRACT(DOW FROM created_at) AS do_flag FROM plugin_test.rows",
        "plugin_test",
      )
    ).not.toThrow();
    expect(() =>
      validatePluginMigrationStatement("DO $$ BEGIN END $$;", "plugin_test")
    ).toThrow(/disallowed/i);
  });
});

describe("buildPluginWorkerEnv", () => {
  it("passes only generic host metadata", () => {
    const env = buildPluginWorkerEnv({
      instanceInfo: { deploymentExposure: "public" },
    });
    expect(env).toEqual({ PAPERCLIP_DEPLOYMENT_EXPOSURE: "public" });
  });
});

describe("plugin database service without a database process", () => {
  const packageRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      packageRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  async function createMigrationPackage(
    files: Readonly<Record<string, string>>,
  ): Promise<string> {
    const packageRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-plugin-db-"));
    packageRoots.push(packageRoot);
    const migrationsDir = path.join(packageRoot, "migrations");
    await mkdir(migrationsDir, { recursive: true });
    await Promise.all(
      Object.entries(files).map(([name, source]) =>
        writeFile(path.join(migrationsDir, name), source, "utf8")
      ),
    );
    return packageRoot;
  }

  function namespaceRow(pluginManifest: PaperclipPluginManifestV1) {
    return {
      pluginId,
      pluginKey: pluginManifest.id,
      namespaceName: derivePluginDatabaseNamespace(pluginManifest.id, pluginId),
      namespaceMode: "schema",
      status: "active",
    };
  }

  it("applies ordered migration files through the production validator", async () => {
    const pluginManifest = manifest();
    const logicalNamespace = derivePluginDatabaseMigrationNamespace(pluginManifest.id);
    const packageRoot = await createMigrationPackage({
      "002_rows.sql": `CREATE TABLE ${logicalNamespace}.derived_rows (id uuid PRIMARY KEY);`,
      "001_rows.sql": `CREATE TABLE ${logicalNamespace}.source_rows (id uuid PRIMARY KEY);`,
    });
    const harness = createMockDb({
      execute: [[], [], [], []],
      insert: [[namespaceRow(pluginManifest)], [], []],
      select: [[], []],
    });

    const result = await pluginDatabaseService(harness.db).applyMigrations(
      pluginId,
      pluginManifest,
      packageRoot,
    );

    expect(result).toMatchObject(namespaceRow(pluginManifest));
    expect(harness.remaining("execute")).toBe(0);
    expect(harness.remaining("insert")).toBe(0);
    expect(harness.remaining("select")).toBe(0);
    expect(harness.calls.filter((call) => call.operation === "execute"))
      .toHaveLength(4);
  });

  it("rejects an altered checksum before executing migration SQL", async () => {
    const pluginManifest = manifest();
    const logicalNamespace = derivePluginDatabaseMigrationNamespace(pluginManifest.id);
    const source = `CREATE TABLE ${logicalNamespace}.rows (id uuid PRIMARY KEY);`;
    const packageRoot = await createMigrationPackage({ "001_rows.sql": source });
    const harness = createMockDb({
      execute: [[], []],
      insert: [[namespaceRow(pluginManifest)]],
      select: [[{
        status: "applied",
        checksum: createHash("sha256").update(`${source} changed`).digest("hex"),
      }]],
    });

    await expect(
      pluginDatabaseService(harness.db).applyMigrations(
        pluginId,
        pluginManifest,
        packageRoot,
      ),
    ).rejects.toThrow(/checksum mismatch/i);

    expect(harness.calls.filter((call) => call.operation === "execute"))
      .toHaveLength(2);
    expect(harness.calls.filter((call) => call.operation === "update"))
      .toHaveLength(0);
  });

  it("records migration validation failure without a live database", async () => {
    const pluginManifest = manifest("paperclip.escape");
    const packageRoot = await createMigrationPackage({
      "001_escape.sql": "CREATE TABLE public.plugin_escape (id uuid PRIMARY KEY);",
    });
    const harness = createMockDb({
      execute: [[], []],
      insert: [[namespaceRow(pluginManifest)], []],
      select: [[]],
      update: [[]],
    });

    await expect(
      pluginDatabaseService(harness.db).applyMigrations(
        pluginId,
        pluginManifest,
        packageRoot,
      ),
    ).rejects.toThrow(/public/i);

    expect(harness.remaining("insert")).toBe(0);
    expect(harness.remaining("update")).toBe(0);
    expect(harness.calls.filter((call) => call.operation === "execute"))
      .toHaveLength(2);
  });

  it("can leave failure persistence to a surrounding install transaction", async () => {
    const pluginManifest = manifest("paperclip.install-transaction");
    const packageRoot = await createMigrationPackage({
      "001_escape.sql": "CREATE TABLE public.plugin_escape (id uuid PRIMARY KEY);",
    });
    const harness = createMockDb({
      execute: [[], []],
      insert: [[namespaceRow(pluginManifest)]],
      select: [[]],
    });

    await expect(
      pluginDatabaseService(harness.db).applyMigrations(
        pluginId,
        pluginManifest,
        packageRoot,
        { persistFailure: false },
      ),
    ).rejects.toThrow(/public/i);

    expect(harness.calls.filter((call) => call.operation === "update"))
      .toHaveLength(0);
    expect(harness.calls.filter((call) => call.method === "insert"))
      .toHaveLength(1);
  });

  it("returns canonical runtime query rows for an active ready plugin", async () => {
    const pluginManifest = manifest();
    const namespace = namespaceRow(pluginManifest);
    const harness = createMockDb({
      select: [
        [{ manifestJson: pluginManifest }],
        [{ namespace }],
      ],
      execute: [[{ id: "row-1", title: "Allowed" }]],
    });

    const rows = await pluginDatabaseService(harness.db).query(
      pluginId,
      `SELECT r.id, i.title FROM ${namespace.namespaceName}.rows r JOIN public.issues i ON i.id = r.issue_id`,
    );

    expect(rows).toEqual([{ id: "row-1", title: "Allowed" }]);
    expect(harness.remaining("select")).toBe(0);
    expect(harness.remaining("execute")).toBe(0);
  });

  it("rejects runtime writes to public core tables before execution", async () => {
    const pluginManifest = manifest();
    const namespace = namespaceRow(pluginManifest);
    const harness = createMockDb({ select: [[{ namespace }]] });

    await expect(
      pluginDatabaseService(harness.db).execute(
        pluginId,
        "UPDATE public.issues SET title = $1",
        ["bad"],
      ),
    ).rejects.toThrow(/plugin namespace/i);

    expect(harness.calls.filter((call) => call.operation === "execute"))
      .toHaveLength(0);
  });

  it("rejects runtime access when the plugin namespace is not active", async () => {
    const harness = createMockDb({ select: [[]] });

    await expect(
      pluginDatabaseService(harness.db).execute(
        pluginId,
        "DELETE FROM plugin_missing.rows WHERE id = $1",
        ["row-1"],
      ),
    ).rejects.toThrow("Plugin database namespace is not active");

    expect(harness.calls.filter((call) => call.operation === "execute"))
      .toHaveLength(0);
  });
});
