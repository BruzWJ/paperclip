import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertNoGateViolations,
  listRepositoryTextFiles,
  requireFileTokens,
} from "./static-removal-gate-utils.ts";

const MANAGED_AGENT_OWNER =
  "apps/server/src/services/plugin-managed-agents.ts";
const GENERIC_ENTITY_OWNER = "apps/server/src/services/plugin-registry.ts";
const ROUTINE_RESOLVER = "apps/server/src/services/plugin-managed-routines.ts";
const MANAGED_RESOURCE_SCHEMA =
  "packages/db/schema/plugin_managed_resources.ts";
const ENTITY_SCHEMA = "packages/db/schema/plugin_entities.ts";

function read(repositoryRoot: string, path: string): string | null {
  const absolute = resolve(repositoryRoot, path);
  return existsSync(absolute) ? readFileSync(absolute, "utf8") : null;
}

function normalizedRelative(repositoryRoot: string, absolute: string): string {
  return relative(repositoryRoot, absolute).replaceAll("\\", "/");
}

function containsAgentBindingWrite(source: string): boolean {
  return [
    /\.(?:insert|update|delete)\(pluginManagedResources\)[\s\S]{0,1800}?resourceKind\s*:\s*["']agent["']/,
    /\.(?:insert|update|delete)\(pluginManagedResources\)[\s\S]{0,1800}?eq\(pluginManagedResources\.resourceKind,\s*["']agent["']\)/,
    /\.(?:insert|update|delete)\(pluginEntities\)[\s\S]{0,1800}?(?:entityType\s*:\s*["']managed_agent["']|MANAGED_AGENT_ENTITY_TYPE)/,
  ].some((pattern) => pattern.test(source));
}

function containsManagedLifecycleWrite(source: string): boolean {
  return (
    /\.update\(pluginManagedResources\)[\s\S]{0,1000}?lifecycleState\s*:/.test(
      source,
    ) ||
    /\.update\(pluginEntities\)[\s\S]{0,1000}?status\s*:\s*["'](?:active|triage_paused|adopted|terminated)["']/.test(
      source,
    )
  );
}

function parallelAgentBindingTables(
  repositoryRoot: string,
): string[] {
  const violations: string[] = [];
  for (const absolute of listRepositoryTextFiles(repositoryRoot, [
    "packages/db/schema",
  ])) {
    const path = normalizedRelative(repositoryRoot, absolute);
    const source = readFileSync(absolute, "utf8");
    for (const match of source.matchAll(/pgTable\(\s*["']([^"']+)["']/g)) {
      const tableName = match[1]!;
      if (
        tableName !== "plugin_managed_resources" &&
        tableName !== "plugin_entities" &&
        /plugin.*agent|agent.*plugin/i.test(tableName)
      ) {
        violations.push(
          `${path}: parallel plugin-managed agent binding/provenance table ${tableName}`,
        );
      }
    }
  }
  return violations;
}

/**
 * Proves that plugin-managed agents remain ordinary agents with one immutable
 * installation-bound provenance/lifecycle owner. Generic plugin entity CRUD
 * cannot mutate the reserved provenance rows and only active bindings resolve.
 */
export function pluginManagedAgentBoundaryViolations(
  repositoryRoot: string,
): string[] {
  const violations: string[] = [
    ...requireFileTokens(repositoryRoot, MANAGED_AGENT_OWNER, [
      'const MANAGED_AGENT_ENTITY_TYPE = "managed_agent"',
      'eq(pluginEntities.entityType, MANAGED_AGENT_ENTITY_TYPE)',
      'eq(pluginManagedResources.resourceKind, "agent")',
      'eq(pluginManagedResources.lifecycleState, "active")',
      'lifecycleState: "triage_paused"',
      'lifecycleState: "adopted"',
      'lifecycleState: "terminated"',
      "binding.pluginId",
      "binding.pluginKey",
      "options.pluginId",
      "const pluginKey = options.manifest.id",
      "originalDeclarationRef",
      "cannot be reacquired",
      "createRuntimeAgentConfigurationService",
    ]),
    ...requireFileTokens(repositoryRoot, MANAGED_RESOURCE_SCHEMA, [
      '"plugin_managed_resources"',
      ".references(() => plugins.id",
      '"plugin_managed_resources_company_plugin_resource_uq"',
      '"plugin_managed_resources_active_agent_binding_uq"',
      "table.resourceKind} = 'agent'",
      "table.lifecycleState} in ('active', 'triage_paused')",
      '"plugin_managed_resources_lifecycle_idx"',
      '"plugin_managed_resources_lifecycle_state_check"',
      '"plugin_managed_resources_lifecycle_timestamp_check"',
    ]),
    ...requireFileTokens(repositoryRoot, ENTITY_SCHEMA, [
      '"plugin_entities"',
      ".references(() => plugins.id",
      '"plugin_entities_external_idx"',
      ".nullsNotDistinct()",
    ]),
    ...requireFileTokens(repositoryRoot, ROUTINE_RESOLVER, [
      'eq(pluginManagedResources.resourceKind, "agent")',
      'eq(pluginManagedResources.lifecycleState, "active")',
    ]),
    ...requireFileTokens(repositoryRoot, GENERIC_ENTITY_OWNER, [
      'const HOST_MANAGED_AGENT_ENTITY_TYPE = "managed_agent"',
      "function assertGenericPluginEntityMutationAllowed",
      "if (entityType === HOST_MANAGED_AGENT_ENTITY_TYPE)",
      "throw conflict(",
      "upsertEntity: async (",
      "assertGenericPluginEntityMutationAllowed(input.entityType)",
      ".insert(pluginEntities)",
      ".onConflictDoUpdate({",
    ]),
    ...parallelAgentBindingTables(repositoryRoot),
  ];

  for (const absolute of listRepositoryTextFiles(repositoryRoot, [
    "apps/server/src/services",
  ])) {
    const path = normalizedRelative(repositoryRoot, absolute);
    if (/\.(?:test|spec)\.tsx?$/.test(path)) continue;
    const source = readFileSync(absolute, "utf8");
    if (
      path !== MANAGED_AGENT_OWNER &&
      path !== GENERIC_ENTITY_OWNER &&
      containsAgentBindingWrite(source)
    ) {
      violations.push(
        `${path}: writes plugin-managed agent binding/provenance outside the canonical owner`,
      );
    }
    if (
      path !== MANAGED_AGENT_OWNER &&
      path !== GENERIC_ENTITY_OWNER &&
      containsManagedLifecycleWrite(source)
    ) {
      violations.push(
        `${path}: writes plugin-managed agent lifecycle outside the canonical owner`,
      );
    }
  }

  const owner = read(repositoryRoot, MANAGED_AGENT_OWNER);
  if (owner !== null) {
    if (
      !/managedResource\.lifecycleState\s*!==\s*["']active["'][\s\S]{0,300}?cannot be reacquired/.test(
        owner,
      ) ||
      !/existing\.status\s*!==\s*["']active["'][\s\S]{0,300}?cannot be reacquired/.test(
        owner,
      )
    ) {
      violations.push(
        `${MANAGED_AGENT_OWNER}: adopted/terminated bindings can be reclaimed`,
      );
    }
    if (
      !/eq\(pluginEntities\.pluginId,\s*options\.pluginId\)/.test(owner) ||
      !/eq\(pluginManagedResources\.pluginId,\s*options\.pluginId\)/.test(
        owner,
      )
    ) {
      violations.push(
        `${MANAGED_AGENT_OWNER}: lookup is not bound to immutable plugin installation identity`,
      );
    }
  }

  const registry = read(repositoryRoot, GENERIC_ENTITY_OWNER);
  if (registry !== null) {
    const entityMutations = registry.match(
      /\.(?:insert|update|delete)\(pluginEntities\)/g,
    ) ?? [];
    if (
      entityMutations.length !== 1 ||
      entityMutations[0] !== ".insert(pluginEntities)"
    ) {
      violations.push(
        `${GENERIC_ENTITY_OWNER}: generic entity mutation surface is not the single guarded upsert`,
      );
    }
    if (
      !/function assertGenericPluginEntityMutationAllowed[\s\S]{0,300}?if \(entityType === HOST_MANAGED_AGENT_ENTITY_TYPE\)[\s\S]{0,300}?throw conflict\(/.test(
        registry,
      )
    ) {
      violations.push(
        `${GENERIC_ENTITY_OWNER}: reserved managed-agent entity guard is not fail-closed`,
      );
    }
    if (
      !/upsertEntity:\s*async\s*\([\s\S]{0,500}?assertGenericPluginEntityMutationAllowed\(input\.entityType\);[\s\S]{0,1200}?\.insert\(pluginEntities\)[\s\S]{0,1200}?\.onConflictDoUpdate\(\{/.test(
        registry,
      )
    ) {
      violations.push(
        `${GENERIC_ENTITY_OWNER}: generic entity upsert does not guard reserved managed-agent rows before mutation`,
      );
    }
  }

  return [...new Set(violations)].sort();
}

export function assertPluginManagedAgentBoundary(repositoryRoot: string): void {
  assertNoGateViolations(
    "Plugin-managed agent boundary check",
    pluginManagedAgentBoundaryViolations(repositoryRoot),
  );
}

const invokedPath = process.argv[1];
if (
  invokedPath &&
  pathToFileURL(resolve(invokedPath)).href === import.meta.url
) {
  try {
    assertPluginManagedAgentBoundary(resolve(import.meta.dirname, ".."));
    console.log("Plugin-managed agent boundary check passed.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
