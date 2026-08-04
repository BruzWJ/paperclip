import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

const llmWikiPluginKey = "paperclipai.plugin-llm-wiki";
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

  it("keeps the bundled LLM Wiki schema as one direct canonical baseline", async () => {
    const repoRoot = path.resolve(import.meta.dirname, "../../../../");
    const migrationsRoot = path.join(
      repoRoot,
      "packages",
      "plugins",
      "plugin-llm-wiki",
      "migrations",
    );
    expect((await readdir(migrationsRoot)).sort()).toEqual(["001_llm_wiki.sql"]);

    const baselineSql = await readFile(
      path.join(migrationsRoot, "001_llm_wiki.sql"),
      "utf8",
    );
    expect(baselineSql).not.toMatch(/\bALTER\s+TABLE\b|\bRENAME\b|\bWITH\s+wiki_pairs\b/i);
    expect(baselineSql).not.toMatch(
      /\bwiki_query_sessions\b|\bwiki_query_audit\b|\bagent_session_id\b|\bfiled_outputs\b|\bhidden_issue_id\b|\bdraft(?:_[a-z0-9_]+)?\b/i,
    );

    const namespace = derivePluginDatabaseMigrationNamespace(
      llmWikiPluginKey,
      "llm_wiki",
    );
    const statements = baselineSql
      .split(";")
      .map((statement) => statement.trim())
      .filter(Boolean);
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      expect(() =>
        validatePluginMigrationStatement(statement, namespace, [
          "companies",
          "issues",
          "projects",
          "agents",
        ])
      ).not.toThrow();
    }
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
  const instanceInfo = { deploymentExposure: "public" };

  it("does not pass host provider keys to environment driver plugins", () => {
    const env = buildPluginWorkerEnv({
      manifest: { capabilities: ["environment.drivers.register"] },
      instanceInfo,
      processEnv: {
        ANTHROPIC_API_KEY: "anthropic-token",
        OPENAI_API_KEY: "openai-token",
        GEMINI_API_KEY: " ",
        AWS_SECRET_ACCESS_KEY: "aws-secret",
      },
    });

    expect(env).toEqual({ PAPERCLIP_DEPLOYMENT_EXPOSURE: "public" });
  });

  it("passes Kubernetes discovery vars to environment driver plugins", () => {
    const env = buildPluginWorkerEnv({
      manifest: { capabilities: ["environment.drivers.register"] },
      instanceInfo,
      processEnv: {
        KUBERNETES_SERVICE_HOST: "10.0.0.1",
        KUBERNETES_SERVICE_PORT: "443",
        KUBERNETES_SERVICE_PORT_HTTPS: " ",
        AWS_SECRET_ACCESS_KEY: "aws-secret",
      },
    });

    expect(env).toEqual({
      PAPERCLIP_DEPLOYMENT_EXPOSURE: "public",
      KUBERNETES_SERVICE_HOST: "10.0.0.1",
      KUBERNETES_SERVICE_PORT: "443",
    });
  });

  it("does not pass provider keys to non-environment plugins", () => {
    const env = buildPluginWorkerEnv({
      manifest: { capabilities: ["ui.slots.register"] },
      instanceInfo,
      processEnv: { OPENAI_API_KEY: "openai-token" },
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
