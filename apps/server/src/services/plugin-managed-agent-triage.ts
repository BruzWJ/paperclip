import { and, asc, eq, ne } from "drizzle-orm";
import { type Db, agents, pluginEntities, pluginManagedResources } from "@paperclipai/db";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { conflict } from "../errors.js";
import type { AgentSuspensionService } from "./agents.js";
import { persistActivityLog, type PersistedActivityLog } from "./activity-log.js";
import type { TaskSessionDbTransaction } from "./task-session/event-store.js";
import type { RequestedAgentRunCancellations } from "./task-execution-cancellation.js";
import { lockCompanyAgentGraph } from "./agent-org-graph-lock.js";
import {
  lockPairedManagedAgentEntity,
  type PausePluginManagedAgentsIntoTriageInput,
  type PausePluginManagedAgentsIntoTriageResult,
} from "./plugin-managed-agent-binding.js";

/**
 * Transaction-capable form used by the plugin lifecycle owner so the plugin
 * tombstone, managed-agent triage, and creator-edge terminalization commit as
 * one database invariant. The caller must lock the plugin installation first.
 */
export async function pausePluginManagedAgentsIntoTriageInTransaction(
  tx: TaskSessionDbTransaction,
  input: PausePluginManagedAgentsIntoTriageInput,
  suspension: AgentSuspensionService,
  now = new Date(),
): Promise<PausePluginManagedAgentsIntoTriageResult> {
  if (input.actorType === "user" && !input.actorId) {
    throw conflict("Board triage requires the exact authenticated user actor");
  }
  const candidateCompanies = await tx
    .select({ companyId: pluginManagedResources.companyId })
    .from(pluginManagedResources)
    .where(
      and(
        eq(pluginManagedResources.pluginId, input.pluginId),
        eq(pluginManagedResources.resourceKind, "agent"),
        eq(pluginManagedResources.lifecycleState, "active"),
      ),
    )
    .orderBy(asc(pluginManagedResources.companyId));
  const lockedGraphs = new Map<string, Awaited<ReturnType<typeof lockCompanyAgentGraph>>>();
  for (const companyId of [...new Set(candidateCompanies.map((row) => row.companyId))]) {
    lockedGraphs.set(companyId, await lockCompanyAgentGraph(tx, companyId));
  }
  const bindings = await tx
    .select()
    .from(pluginManagedResources)
    .where(
      and(
        eq(pluginManagedResources.pluginId, input.pluginId),
        eq(pluginManagedResources.resourceKind, "agent"),
        eq(pluginManagedResources.lifecycleState, "active"),
      ),
    )
    .orderBy(
      asc(pluginManagedResources.companyId),
      asc(pluginManagedResources.resourceId),
      asc(pluginManagedResources.id),
    )
    .for("update");
  const triagePausedAgentIds: string[] = [];
  const suspensionRequests: RequestedAgentRunCancellations[] = [];
  const activities: PersistedActivityLog[] = [];

  for (const binding of bindings) {
    if (binding.pluginKey !== input.pluginKey) {
      throw conflict("Plugin-managed binding crossed its immutable plugin installation key");
    }
    const lockedGraph = lockedGraphs.get(binding.companyId);
    if (!lockedGraph) {
      throw conflict("Plugin-managed agent binding changed companies during lifecycle locking");
    }
    const agent = lockedGraph.agents.find((candidate) => candidate.id === binding.resourceId);
    if (!agent || agent.status === "terminated") {
      throw conflict("Active plugin-managed binding has no live agent target to move into board triage");
    }
    const pairedEntity = await lockPairedManagedAgentEntity(tx, binding);
    const actorType = input.actorType ?? "system";
    const actorId = input.actorId ?? input.pluginId;
    const audit = {
      event: "plugin_managed_agent_moved_to_board_triage",
      pluginInstallationId: input.pluginId,
      pluginKey: input.pluginKey,
      resourceKey: binding.resourceKey,
      resourceId: binding.resourceId,
      previousAgentStatus: agent.status,
      previousPauseReason: agent.pauseReason,
      reason: input.reason,
      actorType,
      actorId,
      occurredAt: now.toISOString(),
    };

    const pausedAgent = await tx
      .update(agents)
      .set({
        status: "paused",
        pauseReason: "system",
        pausedAt: now,
        errorReason: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(agents.id, agent.id),
          eq(agents.companyId, binding.companyId),
          ne(agents.status, "terminated"),
        ),
      )
      .returning({ id: agents.id })
      .then((rows) => rows[0] ?? null);
    if (!pausedAgent) {
      throw conflict("Plugin-managed agent triage lost its locked agent transition");
    }
    const pausedResource = await tx
      .update(pluginManagedResources)
      .set({
        lifecycleState: "triage_paused",
        lifecycleReason: input.reason,
        triagePausedAt: now,
        lifecycleActorType: actorType,
        lifecycleActorId: actorId,
        lifecycleAudit: audit,
        updatedAt: now,
      })
      .where(
        and(eq(pluginManagedResources.id, binding.id), eq(pluginManagedResources.lifecycleState, "active")),
      )
      .returning({ id: pluginManagedResources.id })
      .then((rows) => rows[0] ?? null);
    if (!pausedResource) {
      throw conflict("Plugin-managed agent triage lost its locked binding transition");
    }
    const pausedEntity = await tx
      .update(pluginEntities)
      .set({
        status: "triage_paused",
        updatedAt: now,
      })
      .where(and(eq(pluginEntities.id, pairedEntity.id), eq(pluginEntities.status, "active")))
      .returning({ id: pluginEntities.id })
      .then((rows) => rows[0] ?? null);
    if (!pausedEntity) {
      throw conflict("Plugin-managed agent triage lost its managed-entity transition");
    }
    activities.push(
      await persistActivityLog(tx as unknown as Db, {
        companyId: binding.companyId,
        actorType,
        actorId,
        action: "plugin.managed_agent.moved_to_board_triage",
        entityType: "agent",
        entityId: agent.id,
        details: audit,
      }),
    );
    triagePausedAgentIds.push(agent.id);
  }

  const pausedByCompany = new Map<string, string[]>();
  for (const binding of bindings) {
    if (!triagePausedAgentIds.includes(binding.resourceId)) continue;
    const agentIds = pausedByCompany.get(binding.companyId) ?? [];
    agentIds.push(binding.resourceId);
    pausedByCompany.set(binding.companyId, agentIds);
  }
  for (const [companyId, agentIds] of pausedByCompany) {
    suspensionRequests.push(
      await suspension.requestAgentSuspensionsInTransaction(tx, {
        companyId,
        agentIds,
        reason: input.reason,
        actor:
          input.actorType === "user" && input.actorId
            ? { kind: "user", userId: input.actorId }
            : { kind: "system" },
        now,
      }),
    );
  }

  return {
    triagePausedAgentIds,
    suspensionRequests,
    activities,
  };
}

export interface PluginManagedAgentServiceOptions {
  pluginId: string;
  manifest: PaperclipPluginManifestV1;
}

export function bindingExternalId(companyId: string, agentKey: string) {
  return `managed:agent:${companyId}:${agentKey}`;
}

export function managedEntityAgentId(entity: typeof pluginEntities.$inferSelect): string | null {
  if (!entity.data || typeof entity.data !== "object" || Array.isArray(entity.data)) {
    return null;
  }
  const agentId = (entity.data as Record<string, unknown>).agentId;
  return typeof agentId === "string" ? agentId : null;
}

export function managedEntityPluginKey(entity: typeof pluginEntities.$inferSelect): string | null {
  if (!entity.data || typeof entity.data !== "object" || Array.isArray(entity.data)) {
    return null;
  }
  const pluginKey = (entity.data as Record<string, unknown>).pluginKey;
  return typeof pluginKey === "string" ? pluginKey : null;
}
