import type { Db } from "@paperclipai/db";
import { agents, companies } from "@paperclipai/db";
import {
  AGENT_CONTEXT_GRANT_KEYS,
  AGENT_MENTION_REACH_GRANT_KEYS,
  PAPERCLIP_ACTION_KEYS,
  type Agent,
  type PluginManagedAgentDeclaration,
} from "@paperclipai/shared";
import { and, eq } from "drizzle-orm";
import { conflict, notFound } from "../errors.js";
import { persistActivityLog, publishCommittedActivity, type PersistedActivityLog } from "./activity-log.js";
import { agentService } from "./agents.js";
import { buildPluginManagedAgentsPluginManagedAgentResolution } from "./plugin-managed-agent-resolution.js";
import {
  managedEntityAgentId,
  managedEntityPluginKey,
  type PluginManagedAgentServiceOptions,
} from "./plugin-managed-agent-triage.js";
import {
  createRuntimeAgentConfigurationService,
  RuntimeAgentConfigurationDenied,
} from "./runtime-agent-configuration.js";

export function createPluginManagedAgentsContext(db: Db, options: PluginManagedAgentServiceOptions) {
  const pluginKey = options.manifest.id;

  const agentSvc = agentService(db);

  const runtimeAgents = createRuntimeAgentConfigurationService(db, {
    assertPluginAuthority: async (_tx, input) => {
      if (
        input.actor.pluginInstallationId !== options.pluginId ||
        input.actor.actorId !== pluginKey ||
        !options.manifest.capabilities.includes("agents.managed")
      ) {
        throw new RuntimeAgentConfigurationDenied(
          "Plugin does not hold the exact managed-agent creation authority",
          "plugin_managed_agent_authority_missing",
        );
      }
    },
  });

  return { db, options, pluginKey, agentSvc, runtimeAgents };
}

export type PluginManagedAgentsContext = ReturnType<typeof createPluginManagedAgentsContext>;

export function buildPluginManagedAgentsPluginManagedAgentCreation(
  scope: PluginManagedAgentsContext & ReturnType<typeof buildPluginManagedAgentsPluginManagedAgentResolution>,
) {
  const {
    db,
    options,
    pluginKey,
    agentSvc,
    runtimeAgents,
    declarationFor,
    getBinding,
    getManagedResourceBinding,
    upsertBinding,
    resolution,
  } = scope;

  async function createManagedAgent(companyId: string, declaration: PluginManagedAgentDeclaration) {
    const committed = await db.transaction(async (tx) => {
      const activities: PersistedActivityLog[] = [];
      const company = await tx
        .select()
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0] ?? null);
      if (!company) throw notFound("Company not found");

      const createdResult = await runtimeAgents.createInTransaction({
        transaction: tx,
        companyId,
        actor: {
          kind: "plugin",
          actorId: pluginKey,
          pluginInstallationId: options.pluginId,
        },
        source: "plugin_control",
        idempotencyKey: `plugin_managed_agent:${options.pluginId}:${companyId}:${declaration.agentKey}`,
        configuration: {
          name: declaration.displayName,
          title: declaration.title ?? null,
          capabilities: declaration.capabilities ?? null,
          reportsTo: null,
          contextGrants: Object.fromEntries(AGENT_CONTEXT_GRANT_KEYS.map((key) => [key, false])),
          actionGrants: Object.fromEntries(PAPERCLIP_ACTION_KEYS.map((key) => [key, false])),
          mentionReachGrants: Object.fromEntries(AGENT_MENTION_REACH_GRANT_KEYS.map((key) => [key, false])),
        },
      });
      const created = await tx
        .select()
        .from(agents)
        .where(and(eq(agents.id, createdResult.agentId), eq(agents.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!created) {
        throw notFound("Managed agent was not persisted");
      }
      const existingBinding = await getManagedResourceBinding(
        companyId,
        declaration.agentKey,
        tx as unknown as Db,
      );
      if (createdResult.retried !== Boolean(existingBinding)) {
        throw conflict("Managed-agent creation idempotency disagrees with its canonical binding");
      }
      const approvalId = createdResult.approvalId;
      if (approvalId && !createdResult.retried) {
        activities.push(
          await persistActivityLog(tx as unknown as Db, {
            companyId,
            actorType: "plugin",
            actorId: options.pluginId,
            action: "approval.created",
            entityType: "approval",
            entityId: approvalId,
            details: {
              type: "hire_agent",
              linkedAgentId: created.id,
              runtimeAgentConfigurationAuditId: createdResult.auditId,
              sourcePluginKey: pluginKey,
              managedResourceKey: declaration.agentKey,
            },
          }),
        );
      }
      await upsertBinding(
        companyId,
        declaration,
        created.id,
        {
          approvalId,
          runtimeAgentConfigurationAuditId: createdResult.auditId,
        },
        tx as unknown as Db,
      );
      if (!createdResult.retried) {
        activities.push(
          await persistActivityLog(tx as unknown as Db, {
            companyId,
            actorType: "plugin",
            actorId: options.pluginId,
            action: "plugin.managed_agent.created",
            entityType: "agent",
            entityId: created.id,
            details: {
              sourcePluginKey: pluginKey,
              managedResourceKey: declaration.agentKey,
              runtimeAgentConfigurationAuditId: createdResult.auditId,
              requiresApproval: company.requireBoardApprovalForNewAgents,
              approvalId,
            },
          }),
        );
      }
      return {
        agentId: created.id,
        approvalId,
        activities,
        status: createdResult.retried ? ("resolved" as const) : ("created" as const),
      };
    });
    for (const activity of committed.activities) {
      publishCommittedActivity(activity);
    }
    const created = await agentSvc.getById(committed.agentId);
    if (!created) {
      throw notFound("Managed agent was not persisted");
    }
    return resolution(companyId, declaration, created as Agent, committed.status, committed.approvalId);
  }

  async function get(agentKey: string, companyId: string) {
    const declaration = declarationFor(agentKey);
    const [binding, entity] = await Promise.all([
      getManagedResourceBinding(companyId, agentKey),
      getBinding(companyId, agentKey),
    ]);
    if (!binding && !entity) {
      return resolution(companyId, declaration, null, "missing");
    }
    if (!binding || !entity) {
      throw conflict("Plugin-managed agent provenance lost its canonical resource/entity pair");
    }
    if (
      entity.status !== binding.lifecycleState ||
      entity.scopeKind !== "company" ||
      entity.scopeId !== companyId ||
      binding.pluginKey !== pluginKey ||
      managedEntityPluginKey(entity) !== pluginKey ||
      managedEntityAgentId(entity) !== binding.resourceId
    ) {
      throw conflict("Plugin-managed agent resource/entity pair disagrees on lifecycle or identity");
    }
    if (binding.lifecycleState !== "active") {
      return resolution(companyId, declaration, null, "missing");
    }
    const agent = await agentSvc.getById(binding.resourceId);
    if (!agent || agent.companyId !== companyId || agent.status === "terminated") {
      throw conflict("Active plugin-managed binding does not resolve to its live canonical agent");
    }
    return resolution(companyId, declaration, agent as Agent, "resolved");
  }

  return { createManagedAgent, get };
}

export function buildPluginManagedAgentsPluginManagedAgentReconciliation(
  scope: PluginManagedAgentsContext &
    ReturnType<typeof buildPluginManagedAgentsPluginManagedAgentResolution> &
    ReturnType<typeof buildPluginManagedAgentsPluginManagedAgentCreation>,
) {
  const {
    db,
    declarationFor,
    getManagedResourceBinding,
    upsertBinding,
    resolution,
    createManagedAgent,
    get,
  } = scope;

  async function reconcile(agentKey: string, companyId: string) {
    const declaration = declarationFor(agentKey);
    const lifecycleBinding = await getManagedResourceBinding(companyId, agentKey);
    if (lifecycleBinding && lifecycleBinding.lifecycleState !== "active") {
      return resolution(companyId, declaration, null, "missing");
    }
    const current = await get(agentKey, companyId);
    if (current.agent) {
      await db.transaction((tx) =>
        upsertBinding(companyId, declaration, current.agent!.id, {}, tx as unknown as Db),
      );
      return current;
    }
    return createManagedAgent(companyId, declaration);
  }

  async function reset(agentKey: string, companyId: string) {
    // A managed declaration is provenance, not an authority source. The
    // retained reset RPC validates the active binding but cannot restore
    // declaration defaults over ordinary board-managed agent state.
    return reconcile(agentKey, companyId);
  }

  return { reconcile, reset };
}

export function createPluginManagedAgentsMethods1(
  scope: PluginManagedAgentsContext &
    ReturnType<typeof buildPluginManagedAgentsPluginManagedAgentResolution> &
    ReturnType<typeof buildPluginManagedAgentsPluginManagedAgentCreation> &
    ReturnType<typeof buildPluginManagedAgentsPluginManagedAgentReconciliation>,
) {
  const { get, reconcile, reset } = scope;

  return {
    get,

    reconcile,

    reset,
  };
}

export {
  adoptPluginManagedAgentFromBoard,
  getPluginManagedAgentBinding,
} from "./plugin-managed-agent-binding.js";

export {
  terminateAgentForHireRejectionInTransaction,
  terminatePluginManagedAgentFromBoard,
} from "./plugin-managed-agent-termination.js";

export { pausePluginManagedAgentsIntoTriageInTransaction } from "./plugin-managed-agent-triage.js";

export function pluginManagedAgentService(db: Db, options: PluginManagedAgentServiceOptions) {
  const context = createPluginManagedAgentsContext(db, options);
  const helpers1 = buildPluginManagedAgentsPluginManagedAgentResolution(context);
  const scope1 = { ...context, ...helpers1 };
  const helpers2 = buildPluginManagedAgentsPluginManagedAgentCreation(scope1);
  const scope2 = { ...scope1, ...helpers2 };
  const helpers3 = buildPluginManagedAgentsPluginManagedAgentReconciliation(scope2);
  const scope3 = { ...scope2, ...helpers3 };
  const scope = scope3;
  const methods1 = createPluginManagedAgentsMethods1(scope);
  return { ...methods1 };
}
