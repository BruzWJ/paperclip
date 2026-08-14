import {
  agentActionGrants,
  agentContextGrants,
  companyMemberships,
  plugins,
  principalPermissionGrants,
  tasks,
  type Db,
} from "@paperclipai/db";
import {
  AGENT_CONTEXT_GRANT_KEYS,
  PAPERCLIP_ACTION_KEYS,
  isCanonicalUuid,
  type AgentContextGrantKey,
  type PaperclipActionKey,
} from "@paperclipai/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import { evaluateAgentInvokability } from "./agent-invokability.js";
import { lockCompanyAgentGraph } from "./agent-org-graph-lock.js";
import { authorizationService, type AuthorizationActor } from "./authorization.js";
import { lockActivePromptCapabilityBinding } from "./prompt-capability-gateway-postgres.js";
import * as agentConfig from "./runtime-agent-configuration-part-1.js";
import { grantActorColumns } from "./runtime-agent-configuration-part-2.js";

export function assertReportsTo(
  agentId: string,
  reportsTo: string | null,
  companyAgents: readonly agentConfig.AgentRow[],
): void {
  if (!reportsTo) return;
  if (reportsTo === agentId) {
    throw new agentConfig.RuntimeAgentConfigurationInvalid("Agent cannot be its own manager");
  }
  const byId = new Map(companyAgents.map((agent) => [agent.id, agent]));
  const manager = byId.get(reportsTo);
  if (!manager || manager.status === "terminated") {
    throw new agentConfig.RuntimeAgentConfigurationInvalid(
      "reportsTo must identify a non-terminated agent in the same company",
    );
  }
  const seen = new Set<string>([agentId]);
  let cursor: agentConfig.AgentRow | undefined = manager;
  while (cursor) {
    if (seen.has(cursor.id)) {
      throw new agentConfig.RuntimeAgentConfigurationInvalid("Reporting relationship would create a cycle");
    }
    seen.add(cursor.id);
    cursor = cursor.reportsTo ? byId.get(cursor.reportsTo) : undefined;
    if (cursor?.status === "terminated") {
      throw new agentConfig.RuntimeAgentConfigurationInvalid(
        "Reporting relationship cannot traverse a terminated manager",
      );
    }
  }
}

export async function lockCompanyAndAgents(
  tx: agentConfig.RuntimeAgentConfigurationTransaction,
  companyId: string,
): Promise<{
  company: agentConfig.CompanyRow;
  agents: agentConfig.AgentRow[];
}> {
  if (!isCanonicalUuid(companyId)) {
    throw new agentConfig.RuntimeAgentConfigurationInvalid("companyId must be a UUID");
  }
  const locked = await lockCompanyAgentGraph(tx, companyId);
  const company = locked.company;
  if (!company) {
    throw new agentConfig.RuntimeAgentConfigurationInvalid("Company does not exist");
  }
  if (company.status !== "active") {
    throw new agentConfig.RuntimeAgentConfigurationDenied("Company is not active", "company_inactive");
  }
  return { company, agents: locked.agents };
}

export async function assertRunActionAuthority(
  tx: agentConfig.RuntimeAgentConfigurationTransaction,
  actor: agentConfig.InternalAgentActor,
  action: "agent_hire" | "agent_configure",
  now: Date,
  company: agentConfig.CompanyRow,
  companyAgents: readonly agentConfig.AgentRow[],
): Promise<{ responsibleUserId: string | null }> {
  const { capability } = actor;
  if (capability.companyId !== company.id) {
    throw new agentConfig.RuntimeAgentConfigurationDenied(
      "Prompt capability is bound to a different company",
      "binding_mismatch",
    );
  }

  try {
    await lockActivePromptCapabilityBinding(tx, capability, now);
  } catch {
    throw new agentConfig.RuntimeAgentConfigurationDenied(
      "Prompt capability is inactive, expired, or no longer exact",
      "prompt_capability_invalid",
    );
  }

  const task = await tx
    .select({
      companyId: tasks.companyId,
      ownerKind: tasks.ownerKind,
      ownerAgentId: tasks.ownerAgentId,
      ownershipEpoch: tasks.ownershipEpoch,
      responsibleUserId: tasks.responsibleUserId,
    })
    .from(tasks)
    .where(eq(tasks.id, capability.taskId))
    .limit(1)
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (!task || task.companyId !== capability.companyId || task.ownershipEpoch !== capability.ownershipEpoch) {
    throw new agentConfig.RuntimeAgentConfigurationDenied(
      "Task ownership epoch has changed",
      "ownership_epoch_changed",
    );
  }
  if (
    capability.executionMode === "owner" &&
    (task.ownerKind !== "agent" || task.ownerAgentId !== capability.targetAgentId)
  ) {
    throw new agentConfig.RuntimeAgentConfigurationDenied("Run no longer owns the task", "owner_changed");
  }

  const caller = companyAgents.find((candidate) => candidate.id === capability.targetAgentId);
  if (!caller) {
    throw new agentConfig.RuntimeAgentConfigurationDenied("Agent no longer exists", "agent_not_found");
  }
  const invokability = evaluateAgentInvokability(caller, [...companyAgents]);
  if (!invokability.invokable) {
    throw new agentConfig.RuntimeAgentConfigurationDenied(
      invokability.message,
      `agent_not_invokable:${invokability.reason}`,
    );
  }

  const actionRows = await tx
    .select({ id: agentActionGrants.id })
    .from(agentActionGrants)
    .where(
      and(
        eq(agentActionGrants.companyId, capability.companyId),
        eq(agentActionGrants.agentId, capability.targetAgentId),
        eq(agentActionGrants.key, action),
      ),
    )
    .for("update");
  if (actionRows.length !== 1) {
    throw new agentConfig.RuntimeAgentConfigurationDenied(
      `Current run no longer has ${action}`,
      "action_grant_missing",
    );
  }
  return { responsibleUserId: task.responsibleUserId };
}

export async function lockAuthorizationRows(
  tx: agentConfig.RuntimeAgentConfigurationTransaction,
  companyId: string,
  actor: AuthorizationActor,
): Promise<void> {
  if (actor.type === "agent" && actor.agentId) {
    await tx
      .select({ id: principalPermissionGrants.id })
      .from(principalPermissionGrants)
      .where(
        and(
          eq(principalPermissionGrants.companyId, companyId),
          eq(principalPermissionGrants.principalType, "agent"),
          eq(principalPermissionGrants.principalAgentId, actor.agentId),
          inArray(principalPermissionGrants.permissionKey, ["agents:configure", "agents:suggest-changes"]),
        ),
      )
      .for("update");
    await tx
      .select({ id: companyMemberships.id })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "agent"),
          eq(companyMemberships.principalAgentId, actor.agentId),
        ),
      )
      .for("update");
  } else if (actor.type === "board" && actor.userId) {
    await tx
      .select({ id: principalPermissionGrants.id })
      .from(principalPermissionGrants)
      .where(
        and(
          eq(principalPermissionGrants.companyId, companyId),
          eq(principalPermissionGrants.principalType, "user"),
          eq(principalPermissionGrants.principalUserId, actor.userId),
          inArray(principalPermissionGrants.permissionKey, [
            "agents:create",
            "agents:configure",
            "agents:suggest-changes",
          ]),
        ),
      )
      .for("update");
    await tx
      .select({ id: companyMemberships.id })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalUserId, actor.userId),
        ),
      )
      .for("update");
  }
}

export async function assertBoardAuthority(
  tx: agentConfig.RuntimeAgentConfigurationTransaction,
  actor: agentConfig.RuntimeAgentConfigurationBoardActor,
  companyId: string,
  operation: "create" | "update",
  targetAgentId: string | null,
): Promise<void> {
  await lockAuthorizationRows(tx, companyId, actor.authorization);
  const decision = await authorizationService(tx as unknown as Db).decide({
    actor: actor.authorization,
    action: operation === "create" ? "agents:create" : "agent_config:update",
    resource:
      operation === "create"
        ? { type: "company", companyId }
        : { type: "agent", companyId, agentId: targetAgentId },
    scope:
      operation === "update"
        ? {
            requiresChangeGrant: true,
            targetAgentId,
          }
        : undefined,
  });
  if (!decision.allowed) {
    throw new agentConfig.RuntimeAgentConfigurationDenied(decision.explanation, decision.reason);
  }
}

export async function assertPluginAuthority(
  tx: agentConfig.RuntimeAgentConfigurationTransaction,
  actor: agentConfig.RuntimeAgentConfigurationPluginActor,
  operation: "create" | "update",
  targetAgentId: string | null,
  changedKeys: readonly string[],
  options: agentConfig.RuntimeAgentConfigurationServiceOptions,
): Promise<void> {
  await tx.execute(
    sql`select ${plugins.id} from ${plugins} where ${plugins.id} = ${actor.pluginInstallationId} for update`,
  );
  const plugin = await tx
    .select({ status: plugins.status })
    .from(plugins)
    .where(eq(plugins.id, actor.pluginInstallationId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!plugin || plugin.status !== "ready") {
    throw new agentConfig.RuntimeAgentConfigurationDenied(
      "Plugin installation is not ready",
      "plugin_inactive",
    );
  }
  if (!options.assertPluginAuthority) {
    throw new agentConfig.RuntimeAgentConfigurationDenied(
      "Plugin runtime-agent configuration authority is not installed",
      "plugin_authority_unavailable",
    );
  }
  await options.assertPluginAuthority(tx, {
    actor,
    operation,
    targetAgentId,
    changedKeys,
  });
}

export async function assertAgentConfigureAuthority(
  tx: agentConfig.RuntimeAgentConfigurationTransaction,
  actor: agentConfig.InternalAgentActor,
  responsibleUserId: string | null,
  targetAgentId: string,
  changedKeys: readonly string[],
  requiresProtectedGrant: boolean,
  displayedDiff: string,
  options: agentConfig.RuntimeAgentConfigurationServiceOptions,
): Promise<void> {
  const authorizationActor: AuthorizationActor = {
    type: "agent",
    agentId: actor.actorId,
    companyId: actor.capability.companyId,
    runId: actor.capability.runId,
    source: "internal",
    onBehalfOfUserId: responsibleUserId,
  };
  await lockAuthorizationRows(tx, actor.capability.companyId, authorizationActor);
  const authz = authorizationService(tx as unknown as Db);
  const input = {
    actor: authorizationActor,
    action: "agent_config:update" as const,
    resource: {
      type: "agent" as const,
      companyId: actor.capability.companyId,
      agentId: targetAgentId,
    },
  };
  let decision = await authz.decide({
    ...input,
    scope: {
      requiresChangeGrant: requiresProtectedGrant,
      targetAgentId,
    },
  });
  if (!decision.allowed && decision.reason === "deny_missing_consent" && requiresProtectedGrant) {
    if (!options.assertConsentedChange) {
      throw new agentConfig.RuntimeAgentConfigurationDenied(decision.explanation, decision.reason);
    }
    try {
      await options.assertConsentedChange(tx, {
        capability: actor.capability,
        targetAgentId,
        changedKeys,
        displayedDiff,
      });
    } catch (error) {
      if (error instanceof agentConfig.RuntimeAgentConfigurationDenied) {
        throw error;
      }
      throw new agentConfig.RuntimeAgentConfigurationConsentRequired(
        error instanceof Error ? error.message : "Accepted change consent is unavailable",
        targetAgentId,
        displayedDiff,
      );
    }
    decision = await authz.decide({
      ...input,
      scope: {
        requiresChangeGrant: true,
        consentedChange: true,
        targetAgentId,
      },
    });
  }
  if (!decision.allowed) {
    throw new agentConfig.RuntimeAgentConfigurationDenied(decision.explanation, decision.reason);
  }
}

export async function replaceContextGrants(
  tx: agentConfig.RuntimeAgentConfigurationTransaction,
  companyId: string,
  agentId: string,
  values: agentConfig.SparseGrantMap<AgentContextGrantKey>,
  actor: agentConfig.InternalActor,
  now: Date,
): Promise<void> {
  await tx
    .delete(agentContextGrants)
    .where(and(eq(agentContextGrants.companyId, companyId), eq(agentContextGrants.agentId, agentId)));
  const keys = AGENT_CONTEXT_GRANT_KEYS.filter((key) => values[key] === true);
  if (keys.length > 0) {
    const provenance = grantActorColumns(actor);
    await tx.insert(agentContextGrants).values(
      keys.map((key) => ({
        companyId,
        agentId,
        key,
        ...provenance,
        createdAt: now,
      })),
    );
  }
}

export async function replaceActionGrants(
  tx: agentConfig.RuntimeAgentConfigurationTransaction,
  companyId: string,
  agentId: string,
  values: agentConfig.SparseGrantMap<PaperclipActionKey>,
  actor: agentConfig.InternalActor,
  now: Date,
): Promise<void> {
  await tx
    .delete(agentActionGrants)
    .where(and(eq(agentActionGrants.companyId, companyId), eq(agentActionGrants.agentId, agentId)));
  const keys = PAPERCLIP_ACTION_KEYS.filter((key) => values[key] === true);
  if (keys.length > 0) {
    const provenance = grantActorColumns(actor);
    await tx.insert(agentActionGrants).values(
      keys.map((key) => ({
        companyId,
        agentId,
        key,
        ...provenance,
        createdAt: now,
      })),
    );
  }
}
