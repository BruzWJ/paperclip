import { type Db, plugins, pluginState } from "@paperclipai/db";
import type { HostToWorkerMethods, WorkerToHostMethods } from "@paperclipai/plugin-sdk";
import { isCanonicalUuid, type PluginStateScopeKind } from "@paperclipai/shared";
import { and, eq, isNull } from "drizzle-orm";
import { notFound } from "../errors.js";
import { companyService } from "./companies.js";
import { agentService } from "./agents.js";
import { projectService } from "./projects.js";
import { taskService } from "./tasks.js";
import { goalService } from "./goals.js";
import { pluginRegistryService } from "./plugin-registry.js";
import { pluginDatabaseService } from "./plugin-database.js";
import { pluginManagedAgentService } from "./plugin-managed-agents.js";
import { pluginManagedRoutineService } from "./plugin-managed-routines.js";
import type { PluginEventBus } from "./plugin-event-bus.js";
import { accessService } from "./access.js";
import { authorizationService } from "./authorization.js";
import { type PluginHostServicesOptions } from "./plugin-host-contracts.js";

import type { buildPluginHostServicesPluginHostAuthorizationPolicy } from "./plugin-host-contracts.js";
import type { buildPluginHostServicesPluginHostEntityTools } from "./plugin-host-entity-tools.js";
import type { buildPluginHostServicesPluginHostScopeActivity } from "./plugin-host-scope-activity.js";

type SetPluginState = WorkerToHostMethods["state.set"][0];

const DEFAULT_STATE_NAMESPACE = "default";

function pluginStateScopeConditions(
  pluginId: string,
  scopeKind: PluginStateScopeKind,
  scopeId: string | undefined | null,
  namespace: string,
  stateKey: string,
) {
  const conditions = [
    eq(pluginState.pluginId, pluginId),
    eq(pluginState.scopeKind, scopeKind),
    eq(pluginState.namespace, namespace),
    eq(pluginState.stateKey, stateKey),
  ];
  conditions.push(
    scopeId != null && scopeId !== "" ? eq(pluginState.scopeId, scopeId) : isNull(pluginState.scopeId),
  );
  return and(...conditions);
}

/** Installation-scoped state persistence used by the plugin host bridge. */
function pluginStateStore(db: Db) {
  async function assertPluginReady(pluginId: string): Promise<void> {
    const rows = await db
      .select({ id: plugins.id, status: plugins.status })
      .from(plugins)
      .where(and(eq(plugins.id, pluginId), eq(plugins.status, "ready")));
    if (rows.length === 0) {
      throw notFound(`Ready plugin installation not found: ${pluginId}`);
    }
  }

  return {
    get: async (
      pluginId: string,
      scopeKind: PluginStateScopeKind,
      stateKey: string,
      { scopeId, namespace = DEFAULT_STATE_NAMESPACE }: { scopeId?: string; namespace?: string } = {},
    ): Promise<unknown> => {
      await assertPluginReady(pluginId);
      const rows = await db
        .select()
        .from(pluginState)
        .where(pluginStateScopeConditions(pluginId, scopeKind, scopeId, namespace, stateKey));
      return rows[0]?.valueJson ?? null;
    },

    set: async (pluginId: string, input: SetPluginState): Promise<void> => {
      await assertPluginReady(pluginId);
      const namespace = input.namespace ?? DEFAULT_STATE_NAMESPACE;
      const scopeId = input.scopeId ?? null;
      await db
        .insert(pluginState)
        .values({
          pluginId,
          scopeKind: input.scopeKind,
          scopeId,
          namespace,
          stateKey: input.stateKey,
          valueJson: input.value,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [
            pluginState.pluginId,
            pluginState.scopeKind,
            pluginState.scopeId,
            pluginState.namespace,
            pluginState.stateKey,
          ],
          set: { valueJson: input.value, updatedAt: new Date() },
        });
    },

    delete: async (
      pluginId: string,
      scopeKind: PluginStateScopeKind,
      stateKey: string,
      { scopeId, namespace = DEFAULT_STATE_NAMESPACE }: { scopeId?: string; namespace?: string } = {},
    ): Promise<void> => {
      await assertPluginReady(pluginId);
      await db
        .delete(pluginState)
        .where(pluginStateScopeConditions(pluginId, scopeKind, scopeId, namespace, stateKey));
    },
  };
}

export type PluginHostServicesScope = PluginHostServicesContext &
  ReturnType<typeof buildPluginHostServicesPluginHostEntityTools> &
  ReturnType<typeof buildPluginHostServicesPluginHostScopeActivity> &
  ReturnType<typeof buildPluginHostServicesPluginHostAuthorizationPolicy>;

export function createPluginHostServicesContext(
  db: Db,
  pluginId: string,
  eventBus: PluginEventBus,
  deliverEvent: (params: HostToWorkerMethods["onEvent"][0]) => Promise<void>,
  options: PluginHostServicesOptions,
) {
  if (!isCanonicalUuid(pluginId)) {
    throw new Error("pluginId must be an exact canonical UUID");
  }

  const pluginKey = options.manifest.id;

  if (pluginKey.length === 0 || pluginKey !== pluginKey.trim()) {
    throw new Error("pluginKey must be an exact non-empty string");
  }

  const registry = pluginRegistryService(db);

  const stateStore = pluginStateStore(db);

  const pluginDb = pluginDatabaseService(db);

  const companies = companyService(db);

  const agents = agentService(db);

  const managedAgents = pluginManagedAgentService(db, {
    pluginId,
    manifest: options.manifest,
  });

  const managedRoutines = pluginManagedRoutineService(db, {
    pluginId,
    manifest: options.manifest,
    ordinaryTasks: options.ordinaryTasks,
    secretsRuntime: options.secretsRuntime,
  });

  const registeredCreatorCallbacks = new Set<string>();

  const projects = projectService(db);

  const tasks = taskService(db);

  const goals = goalService(db);

  const access = accessService(db);

  const authorization = authorizationService(db);

  const scopedBus = eventBus.forPlugin(pluginKey);

  const pluginTaskRuntime = options.pluginTaskControlPlane;

  return {
    db,
    pluginId,
    eventBus,
    deliverEvent,
    options,
    pluginKey,
    registry,
    stateStore,
    pluginDb,
    companies,
    agents,
    managedAgents,
    managedRoutines,
    registeredCreatorCallbacks,
    projects,
    tasks,
    goals,
    access,
    authorization,
    scopedBus,
    pluginTaskRuntime,
  };
}

export type PluginHostServicesContext = ReturnType<typeof createPluginHostServicesContext>;
