import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { plugins } from "@paperclipai/db";
import { buildHostServices } from "../services/plugin-host-services.js";
import {
  deletePluginInstallationInTransaction,
  pluginRegistryService,
} from "../services/plugin-registry.js";
import { createMockDb } from "./helpers/mock-db.js";
import {
  createPluginHostServicesTestOptions,
  createPluginManifestFake,
  noopPluginEventDelivery,
} from "./helpers/plugin-host-services.js";

const schemaUrls = [
  new URL("../../../../packages/db/schema/plugin_entities.ts", import.meta.url),
  new URL("../../../../packages/db/schema/plugin_logs.ts", import.meta.url),
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
    const [entitiesSource, logsSource] = await Promise.all(
      schemaUrls.map(async (url) => normalized(await readFile(url, "utf8"))),
    );

    for (const source of [entitiesSource, logsSource]) {
      expect(source).toContain(
        'companyId: uuid("company_id").references(() => companies.id, { onDelete: "cascade" })',
      );
    }
    expect(entitiesSource).toContain(
      'unique("plugin_entities_external_idx") .on( table.companyId, table.pluginId, table.entityType, table.scopeKind, table.scopeId, table.externalId, ) .nullsNotDistinct()',
    );
    expect(entitiesSource).toContain(
      'companyIdx: index("plugin_entities_company_idx").on(table.companyId)',
    );
    expect(logsSource).toContain(
      'companyIdx: index("plugin_logs_company_idx").on(table.companyId)',
    );
  });

  it("emits the PostgreSQL tenant constraints into generated migrations", async () => {
    const migrations = normalized(await readGeneratedMigrationSql());

    expect(migrations).toContain(
      'CONSTRAINT "plugin_entities_external_idx" UNIQUE NULLS NOT DISTINCT("company_id","plugin_id","entity_type","scope_kind","scope_id","external_id")',
    );
    for (const constraint of [
      "plugin_entities_company_id_companies_id_fk",
      "plugin_logs_company_id_companies_id_fk",
    ]) {
      expect(migrations).toContain(
        `CONSTRAINT "${constraint}" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade`,
      );
    }
  });

  it("uses the exact scoped identity as the atomic entity upsert target", async () => {
    const source = normalized(await readFile(registryUrl, "utf8"));

    expect(source).toContain(
      "target: [ pluginEntities.companyId, pluginEntities.pluginId, pluginEntities.entityType, pluginEntities.scopeKind, pluginEntities.scopeId, pluginEntities.externalId, ]",
    );
  });

  it("atomically updates the exact tenant-and-scope entity identity", async () => {
    const updated = entityRow(companyA, { title: "Updated ticket" });
    const harness = createMockDb({
      insert: [[updated]],
    });

    await expect(pluginRegistryService(harness.db).upsertEntity(pluginId, {
      ...entityInput(companyA),
      title: "Updated ticket",
    })).resolves.toEqual(updated);

    expect(harness.calls.find((call) =>
      call.operation === "insert" && call.method === "onConflictDoUpdate"
    )?.args[0]).toMatchObject({
      target: expect.any(Array),
      set: {
        title: "Updated ticket",
        status: "active",
        data: { source: "fixture" },
        updatedAt: expect.any(Date),
      },
    });
    expect(harness.remaining("insert")).toBe(0);
  });

  it("persists the same external identity independently for each company and for instance scope", async () => {
    const createdA = entityRow(companyA);
    const createdB = entityRow(companyB);
    const createdInstance = entityRow(null);
    const harness = createMockDb({
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
    expect(harness.remaining("insert")).toBe(0);
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

  it("durably writes each plugin log with its exact company or explicit instance scope", async () => {
    const harness = createMockDb({ insert: [[], []] });
    const host = buildHostServices(
      harness.db,
      pluginId,
      createEventBusStub(),
      noopPluginEventDelivery,
      createPluginHostServicesTestOptions({
        manifest: createPluginManifestFake({
          id: "paperclip.tenant-isolation-test",
        }),
      }),
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
    await host.dispose();

    expect(harness.calls.filter((call) =>
      call.operation === "insert" && call.method === "values"
    ).map((call) => call.args[0])).toEqual([
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
  });

  it("deletes the installation after dropping its namespace", async () => {
    const harness = createMockDb({
      select: [
        [{ id: pluginId, status: "disabled" }],
        [{ namespaceName: "plugin_fixture" }],
      ],
      execute: [undefined],
      delete: [[{ id: pluginId }]],
    });

    await expect(
      deletePluginInstallationInTransaction(harness.db as never, pluginId),
    ).resolves.toEqual({ id: pluginId });

    expect(harness.calls.filter((call) => call.operation === "execute")).toHaveLength(1);
    const deletedTables = harness.calls
      .filter((call) => call.operation === "delete" && call.method === "delete")
      .map((call) => call.args[0]);
    expect(deletedTables).toEqual([plugins]);
    expect(harness.remaining("select")).toBe(0);
    expect(harness.remaining("execute")).toBe(0);
    expect(harness.remaining("delete")).toBe(0);
  });
});
