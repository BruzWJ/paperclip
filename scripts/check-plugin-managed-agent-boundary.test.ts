import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { pluginManagedAgentBoundaryViolations } from "./check-plugin-managed-agent-boundary.ts";

const roots = new Set<string>();

function write(root: string, path: string, content: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

function fixtureRoot(): string {
  const root = mkdtempSync(
    join(tmpdir(), "paperclip-plugin-managed-agent-gate-"),
  );
  roots.add(root);
  write(
    root,
    "packages/db/schema/plugin_managed_resources.ts",
    [
      'pgTable("plugin_managed_resources", {',
      "  pluginId: uuid().references(() => plugins.id),",
      "});",
      'uniqueIndex("plugin_managed_resources_company_plugin_resource_uq");',
      'uniqueIndex("plugin_managed_resources_active_agent_binding_uq")',
      "  .where(sql`${table.resourceKind} = 'agent' and ${table.lifecycleState} in ('active', 'triage_paused')`);",
      'index("plugin_managed_resources_lifecycle_idx");',
      'check("plugin_managed_resources_lifecycle_state_check");',
      'check("plugin_managed_resources_lifecycle_timestamp_check");',
      "",
    ].join("\n"),
  );
  write(
    root,
    "packages/db/schema/plugin_entities.ts",
    [
      'pgTable("plugin_entities", {',
      "  pluginId: uuid().references(() => plugins.id),",
      "});",
      'unique("plugin_entities_external_idx").nullsNotDistinct();',
      "",
    ].join("\n"),
  );
  write(
    root,
    "apps/server/src/services/plugin-managed-agents.ts",
    [
      'const MANAGED_AGENT_ENTITY_TYPE = "managed_agent";',
      "createRuntimeAgentConfigurationService;",
      "originalDeclarationRef; binding.pluginId; binding.pluginKey; const pluginKey = options.manifest.id;",
      "eq(pluginEntities.entityType, MANAGED_AGENT_ENTITY_TYPE);",
      "eq(pluginEntities.pluginId, options.pluginId);",
      'eq(pluginManagedResources.resourceKind, "agent");',
      "eq(pluginManagedResources.pluginId, options.pluginId);",
      'eq(pluginManagedResources.lifecycleState, "active");',
      'lifecycleState: "triage_paused";',
      'lifecycleState: "adopted";',
      'lifecycleState: "terminated";',
      'if (managedResource.lifecycleState !== "active") throw new Error("cannot be reacquired");',
      'if (existing.status !== "active") throw new Error("cannot be reacquired");',
      "",
    ].join("\n"),
  );
  write(
    root,
    "apps/server/src/services/plugin-managed-routines.ts",
    [
      'eq(pluginManagedResources.resourceKind, "agent")',
      'eq(pluginManagedResources.lifecycleState, "active")',
      "",
    ].join("\n"),
  );
  write(
    root,
    "apps/server/src/services/plugin-registry.ts",
    [
      'const HOST_MANAGED_AGENT_ENTITY_TYPE = "managed_agent";',
      "function assertGenericPluginEntityMutationAllowed(entityType: string) {",
      "  if (entityType === HOST_MANAGED_AGENT_ENTITY_TYPE) throw conflict();",
      "}",
      "upsertEntity: async (pluginId: string, input: { entityType: string }) => {",
      "  assertGenericPluginEntityMutationAllowed(input.entityType);",
      "  return db.insert(pluginEntities).values({ pluginId }).onConflictDoUpdate({});",
      "},",
      "",
    ].join("\n"),
  );
  return root;
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

test("accepts the single installation-bound managed-agent lifecycle graph", () => {
  assert.deepEqual(pluginManagedAgentBoundaryViolations(fixtureRoot()), []);
});

test("rejects a second managed-agent provenance writer", () => {
  const root = fixtureRoot();
  write(
    root,
    "apps/server/src/services/parallel-agent-binding.ts",
    'db.insert(pluginManagedResources).values({ resourceKind: "agent" });\n',
  );
  assert.ok(
    pluginManagedAgentBoundaryViolations(root).some((entry) =>
      entry.includes("outside the canonical owner"),
    ),
  );
});

test("rejects a direct lifecycle writer", () => {
  const root = fixtureRoot();
  write(
    root,
    "apps/server/src/services/parallel-lifecycle.ts",
    'db.update(pluginManagedResources).set({ lifecycleState: "adopted" });\n',
  );
  assert.ok(
    pluginManagedAgentBoundaryViolations(root).some((entry) =>
      entry.includes("lifecycle outside"),
    ),
  );
});

test("rejects an inactive routine agent reference", () => {
  const root = fixtureRoot();
  const path = "apps/server/src/services/plugin-managed-routines.ts";
  write(
    root,
    path,
    readFileSync(join(root, path), "utf8").replace(
      'eq(pluginManagedResources.lifecycleState, "active")',
      "true",
    ),
  );
  assert.ok(
    pluginManagedAgentBoundaryViolations(root).some((entry) =>
      entry.includes("lifecycleState"),
    ),
  );
});

test("rejects plugin-key lookup in place of immutable installation id", () => {
  const root = fixtureRoot();
  const path = "apps/server/src/services/plugin-managed-agents.ts";
  write(
    root,
    path,
    readFileSync(join(root, path), "utf8").replaceAll(
      "options.pluginId",
      "options.pluginKey",
    ),
  );
  assert.ok(
    pluginManagedAgentBoundaryViolations(root).some((entry) =>
      entry.includes("immutable plugin installation identity"),
    ),
  );
});

test("rejects a generic upsert without the reserved managed-agent guard", () => {
  const root = fixtureRoot();
  const path = "apps/server/src/services/plugin-registry.ts";
  write(
    root,
    path,
    readFileSync(join(root, path), "utf8").replace(
      "assertGenericPluginEntityMutationAllowed(input.entityType);",
      "",
    ),
  );
  assert.ok(
    pluginManagedAgentBoundaryViolations(root).some((entry) =>
      entry.includes("generic entity upsert does not guard"),
    ),
  );
});

test("rejects a second generic plugin-entity mutation path", () => {
  const root = fixtureRoot();
  write(
    root,
    "apps/server/src/services/plugin-registry.ts",
    `${readFileSync(join(root, "apps/server/src/services/plugin-registry.ts"), "utf8")}\ndb.delete(pluginEntities);\n`,
  );
  assert.ok(
    pluginManagedAgentBoundaryViolations(root).some((entry) =>
      entry.includes("single guarded upsert"),
    ),
  );
});

test("rejects loss of the one-live-agent-binding index", () => {
  const root = fixtureRoot();
  const path = "packages/db/schema/plugin_managed_resources.ts";
  write(
    root,
    path,
    readFileSync(join(root, path), "utf8").replace(
      'uniqueIndex("plugin_managed_resources_active_agent_binding_uq")',
      'index("plugin_managed_resources_active_agent_binding_idx")',
    ),
  );
  assert.ok(
    pluginManagedAgentBoundaryViolations(root).some((entry) =>
      entry.includes("active_agent_binding_uq"),
    ),
  );
});

test("rejects a parallel managed-agent binding table", () => {
  const root = fixtureRoot();
  write(
    root,
    "packages/db/schema/plugin_agent_bindings.ts",
    'export const rows = pgTable("plugin_agent_bindings", {});\n',
  );
  assert.ok(
    pluginManagedAgentBoundaryViolations(root).some((entry) =>
      entry.includes("parallel plugin-managed agent"),
    ),
  );
});
