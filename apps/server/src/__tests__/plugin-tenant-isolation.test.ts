import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  pluginCompanySettings,
  pluginConfig,
  pluginDatabaseNamespaces,
  pluginEntities,
  pluginJobs,
  pluginJobRuns,
  pluginLogs,
  pluginManagedResources,
  pluginMigrations,
  pluginState,
  pluginWebhookDeliveries,
  plugins,
} from "@paperclipai/db";
import {
  buildHostServices,
  flushPluginLogBuffer,
} from "../services/plugin-host-services.js";
import {
  pluginRegistryService,
  purgePluginOperationalDataInTransaction,
} from "../services/plugin-registry.js";
import { createMockDb } from "./helpers/mock-db.js";

const schemaUrls = [
  new URL("../../../../packages/db/schema/plugin_entities.ts", import.meta.url),
  new URL("../../../../packages/db/schema/plugin_logs.ts", import.meta.url),
  new URL("../../../../packages/db/schema/plugin_jobs.ts", import.meta.url),
  new URL("../../../../packages/db/schema/plugin_webhooks.ts", import.meta.url),
];
const registryUrl = new URL("../services/plugin-registry.ts", import.meta.url);
const migrationsDirectory = fileURLToPath(
  new URL("../../../../packages/db/migrations/", import.meta.url),
);

async function readGeneratedMigrationSql(): Promise<string> {
  const names = (await readdir(migrationsDirectory))
    .filter((name) => /^\d+_.+\.sql$/.test(name))
    .sort();
  return (await Promise.all(
    names.map((name) => readFile(path.join(migrationsDirectory, name), "utf8")),
  )).join("\n");
}

const pluginId = "00000000-0000-4000-8000-000000000100";
const companyA = "00000000-0000-4000-8000-000000000101";
const companyB = "00000000-0000-4000-8000-000000000102";
const now = new Date("2026-01-02T03:04:05.000Z");

function normalized(source: string) {
  return source.replaceAll(/\s+/g, " ").trim();
}

function entityInput(companyId: string | null) {
  return {
    companyId,
    entityType: "ticket",
    scopeKind: companyId === null ? "instance" as const : "company" as const,
    scopeId: companyId,
    externalId: "external-ticket-1",
    title: "External ticket",
    status: "active",
    data: { source: "fixture" },
  };
}

function entityRow(companyId: string | null, overrides: Record<string, unknown> = {}) {
  return {
    id: companyId === companyA ? "entity-a" : companyId === companyB ? "entity-b" : "entity-instance",
    pluginId,
    ...entityInput(companyId),
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createEventBusStub() {
  return {
    forPlugin() {
      return { emit: vi.fn(), subscribe: vi.fn(), clear: vi.fn() };
    },
  } as never;
}

describe("plugin tenant isolation", () => {
  it("defines nullable company cascade ownership and per-tenant entity uniqueness in the Drizzle schemas", async () => {
    const [entitiesSource, logsSource, jobsSource, webhooksSource] = await Promise.all(
      schemaUrls.map(async (url) => normalized(await readFile(url, "utf8"))),
    );

    for (const source of [entitiesSource, logsSource, jobsSource, webhooksSource]) {
      expect(source).toContain(
        'companyId: uuid("company_id").references(() => companies.id, { onDelete: "cascade" })',
      );
    }
    expect(entitiesSource).toContain(
      'unique("plugin_entities_external_idx") .on( table.companyId, table.pluginId, table.entityType, table.externalId, ) .nullsNotDistinct()',
    );
    expect(entitiesSource).toContain(
      'companyIdx: index("plugin_entities_company_idx").on(table.companyId)',
    );
    expect(logsSource).toContain(
      'companyIdx: index("plugin_logs_company_idx").on(table.companyId)',
    );
    expect(jobsSource).toContain(
      'companyIdx: index("plugin_job_runs_company_idx").on(table.companyId)',
    );
    expect(webhooksSource).toContain(
      'companyIdx: index("plugin_webhook_deliveries_company_idx").on(table.companyId)',
    );
  });

  it("emits the PostgreSQL tenant constraints into generated migrations", async () => {
    const migrations = normalized(await readGeneratedMigrationSql());

    expect(migrations).toContain(
      'CONSTRAINT "plugin_entities_external_idx" UNIQUE NULLS NOT DISTINCT("company_id","plugin_id","entity_type","external_id")',
    );
    for (const constraint of [
      "plugin_entities_company_id_companies_id_fk",
      "plugin_job_runs_company_id_companies_id_fk",
      "plugin_logs_company_id_companies_id_fk",
      "plugin_webhook_deliveries_company_id_companies_id_fk",
    ]) {
      expect(migrations).toContain(
        `CONSTRAINT "${constraint}" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade`,
      );
    }
  });

  it("uses the exact nullable tenant predicate for entity reads and upserts", async () => {
    const source = normalized(await readFile(registryUrl, "utf8"));

    expect(source).toContain(
      "const companyIdPredicate = companyId == null ? isNull(pluginEntities.companyId) : eq(pluginEntities.companyId, companyId)",
    );
    expect(source).toContain(
      "const companyIdPredicate = input.companyId == null ? isNull(pluginEntities.companyId) : eq(pluginEntities.companyId, input.companyId)",
    );
  });

  it("updates only the entity returned from the tenant-scoped lookup", async () => {
    const existing = entityRow(companyA);
    const updated = entityRow(companyA, { title: "Updated ticket" });
    const harness = createMockDb({
      select: [[existing]],
      update: [[updated]],
    });

    await expect(pluginRegistryService(harness.db).upsertEntity(pluginId, {
      ...entityInput(companyA),
      title: "Updated ticket",
    })).resolves.toEqual(updated);

    expect(harness.calls.find((call) =>
      call.operation === "update" && call.method === "set"
    )?.args[0]).toMatchObject({
      companyId: companyA,
      externalId: "external-ticket-1",
      title: "Updated ticket",
      updatedAt: expect.any(Date),
    });
    expect(harness.calls.filter((call) => call.operation === "insert")).toEqual([]);
    expect(harness.remaining("select")).toBe(0);
    expect(harness.remaining("update")).toBe(0);
  });

  it("persists the same external identity independently for each company and for instance scope", async () => {
    const createdA = entityRow(companyA);
    const createdB = entityRow(companyB);
    const createdInstance = entityRow(null);
    const harness = createMockDb({
      select: [[], [], []],
      insert: [[createdA], [createdB], [createdInstance]],
    });
    const registry = pluginRegistryService(harness.db);

    await expect(registry.upsertEntity(pluginId, entityInput(companyA))).resolves.toEqual(createdA);
    await expect(registry.upsertEntity(pluginId, entityInput(companyB))).resolves.toEqual(createdB);
    await expect(registry.upsertEntity(pluginId, entityInput(null))).resolves.toEqual(createdInstance);

    const insertedValues = harness.calls
      .filter((call) => call.operation === "insert" && call.method === "values")
      .map((call) => call.args[0]);
    expect(insertedValues).toEqual([
      expect.objectContaining({ pluginId, companyId: companyA }),
      expect.objectContaining({ pluginId, companyId: companyB }),
      expect.objectContaining({ pluginId, companyId: null }),
    ]);
    expect(harness.remaining("select")).toBe(0);
    expect(harness.remaining("insert")).toBe(0);
  });

  it("returns only the row produced by the explicitly scoped entity lookup", async () => {
    const rowA = entityRow(companyA);
    const rowB = entityRow(companyB);
    const instanceRow = entityRow(null);
    const harness = createMockDb({ select: [[rowA], [rowB], [instanceRow]] });
    const registry = pluginRegistryService(harness.db);

    await expect(registry.getEntityByExternalId(
      pluginId,
      "ticket",
      "external-ticket-1",
      companyA,
    )).resolves.toEqual(rowA);
    await expect(registry.getEntityByExternalId(
      pluginId,
      "ticket",
      "external-ticket-1",
      companyB,
    )).resolves.toEqual(rowB);
    await expect(registry.getEntityByExternalId(
      pluginId,
      "ticket",
      "external-ticket-1",
      null,
    )).resolves.toEqual(instanceRow);
    expect(harness.remaining("select")).toBe(0);
  });

  it("rejects generic writes to host-owned managed-agent provenance before persistence", async () => {
    const harness = createMockDb();

    await expect(pluginRegistryService(harness.db).upsertEntity(pluginId, {
      ...entityInput(companyA),
      entityType: "managed_agent",
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "plugin_managed_agent_generic_entity_mutation_denied" },
    });
    expect(harness.calls).toEqual([]);
  });

  it("persists company and instance scope on job runs and webhook deliveries", async () => {
    const jobId = "00000000-0000-4000-8000-000000000103";
    const rows = [
      { id: "run-a", pluginId, jobId, companyId: companyA, trigger: "manual", status: "pending" },
      { id: "run-instance", pluginId, jobId, companyId: null, trigger: "scheduled", status: "pending" },
      { id: "webhook-a", pluginId, webhookKey: "issues", companyId: companyA, status: "pending" },
      { id: "webhook-instance", pluginId, webhookKey: "issues", companyId: null, status: "pending" },
    ];
    const harness = createMockDb({ insert: rows.map((row) => [row]) });
    const registry = pluginRegistryService(harness.db);

    await registry.createJobRun(pluginId, jobId, "manual", companyA);
    await registry.createJobRun(pluginId, jobId, "scheduled", null);
    await registry.createWebhookDelivery(pluginId, "issues", companyA, {
      externalId: "delivery-a",
      payload: { tenant: "A" },
    });
    await registry.createWebhookDelivery(pluginId, "issues", null, {
      payload: { tenant: "instance" },
    });

    const insertedValues = harness.calls
      .filter((call) => call.operation === "insert" && call.method === "values")
      .map((call) => call.args[0]);
    expect(insertedValues).toEqual([
      { pluginId, jobId, companyId: companyA, trigger: "manual", status: "pending" },
      { pluginId, jobId, companyId: null, trigger: "scheduled", status: "pending" },
      {
        pluginId,
        webhookKey: "issues",
        companyId: companyA,
        externalId: "delivery-a",
        payload: { tenant: "A" },
        headers: {},
        status: "pending",
      },
      {
        pluginId,
        webhookKey: "issues",
        companyId: null,
        externalId: undefined,
        payload: { tenant: "instance" },
        headers: {},
        status: "pending",
      },
    ]);
    expect(harness.remaining("insert")).toBe(0);
  });

  it("buffers plugin logs with their exact company or explicit instance scope", async () => {
    const harness = createMockDb({ insert: [[]] });
    const host = buildHostServices(
      harness.db,
      pluginId,
      "paperclip.tenant-isolation-test",
      createEventBusStub(),
      undefined,
      {
        ordinaryIssues: {} as never,
        pluginIssueControlPlane: {} as never,
        issueExecutionCancellation: {} as never,
      },
    );

    await host.logger.log({
      level: "info",
      message: "tenant log",
      companyId: companyA,
    });
    await host.logger.log({
      level: "debug",
      message: "instance log",
      companyId: null,
    });
    await flushPluginLogBuffer();

    expect(harness.calls.find((call) =>
      call.operation === "insert" && call.method === "values"
    )?.args[0]).toEqual([
      expect.objectContaining({
        pluginId,
        companyId: companyA,
        level: "info",
        message: "tenant log",
      }),
      expect.objectContaining({
        pluginId,
        companyId: null,
        level: "debug",
        message: "instance log",
      }),
    ]);
    expect(harness.remaining("insert")).toBe(0);
    host.dispose();
  });

  it("purges only operational plugin data and retains identity and provenance tables", async () => {
    const harness = createMockDb({
      select: [[{ namespaceName: "paperclip_plugin_fixture" }]],
      execute: [undefined],
      delete: Array.from({ length: 8 }, () => []),
    });

    await purgePluginOperationalDataInTransaction(harness.db as never, pluginId);

    expect(harness.calls.filter((call) => call.operation === "execute")).toHaveLength(1);
    const deletedTables = harness.calls
      .filter((call) => call.operation === "delete" && call.method === "delete")
      .map((call) => call.args[0]);
    expect(deletedTables).toEqual([
      pluginMigrations,
      pluginDatabaseNamespaces,
      pluginJobRuns,
      pluginJobs,
      pluginWebhookDeliveries,
      pluginState,
      pluginCompanySettings,
      pluginConfig,
    ]);
    expect(deletedTables).not.toContain(plugins);
    expect(deletedTables).not.toContain(pluginLogs);
    expect(deletedTables).not.toContain(pluginEntities);
    expect(deletedTables).not.toContain(pluginManagedResources);
    expect(harness.remaining("select")).toBe(0);
    expect(harness.remaining("execute")).toBe(0);
    expect(harness.remaining("delete")).toBe(0);
  });
});
