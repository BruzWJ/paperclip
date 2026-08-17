import {
  agentActionGrants,
  agentContextGrants,
  companyMemberships,
  plugins,
  principalPermissionGrants,
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
import { lockCompanyAgentGraph } from "./agent-org-graph-lock.js";
import { authorizationService } from "./authorization.js";
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

async function lockBoardAuthorizationRows(
  tx: agentConfig.RuntimeAgentConfigurationTransaction,
  companyId: string,
  actor: agentConfig.RuntimeAgentConfigurationBoardActor["authorization"],
): Promise<void> {
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

export async function assertBoardAuthority(
  tx: agentConfig.RuntimeAgentConfigurationTransaction,
  actor: agentConfig.RuntimeAgentConfigurationBoardActor,
  companyId: string,
  operation: "create" | "update",
  targetAgentId: string | null,
): Promise<void> {
  await lockBoardAuthorizationRows(tx, companyId, actor.authorization);
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
