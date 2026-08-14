import { and, desc, eq } from "drizzle-orm";
import { type Db, agents, pluginEntities, pluginManagedResources } from "@paperclipai/db";
import { conflict, notFound } from "../errors.js";
import { persistActivityLog, publishCommittedActivity, type PersistedActivityLog } from "./activity-log.js";
import type { TaskSessionDbTransaction } from "./task-session/event-store.js";
import type { RequestedAgentRunCancellations } from "./task-execution-cancellation.js";
import { lockCompanyAgentGraph } from "./agent-org-graph-lock.js";
import {
  bindingExternalId,
  managedEntityAgentId,
  managedEntityPluginKey,
} from "./plugin-managed-agent-triage.js";

export const MANAGED_AGENT_ENTITY_TYPE = "managed_agent";

export type PluginManagedAgentBinding = typeof pluginManagedResources.$inferSelect;

export async function lockPairedManagedAgentEntity(
  tx: TaskSessionDbTransaction,
  binding: PluginManagedAgentBinding,
) {
  const rows = await tx
    .select()
    .from(pluginEntities)
    .where(
      and(
        eq(pluginEntities.pluginId, binding.pluginId),
        eq(pluginEntities.companyId, binding.companyId),
        eq(pluginEntities.entityType, MANAGED_AGENT_ENTITY_TYPE),
        eq(pluginEntities.externalId, bindingExternalId(binding.companyId, binding.resourceKey)),
      ),
    )
    .limit(2)
    .for("update");
  if (rows.length !== 1) {
    throw conflict("Plugin-managed agent binding lost its unique paired entity");
  }
  const entity = rows[0]!;
  if (
    entity.status !== binding.lifecycleState ||
    entity.scopeKind !== "company" ||
    entity.scopeId !== binding.companyId ||
    binding.pluginKey !== managedEntityPluginKey(entity) ||
    binding.resourceId !== managedEntityAgentId(entity)
  ) {
    throw conflict("Plugin-managed agent binding and entity disagree on lifecycle or identity");
  }
  return entity;
}

export interface PausePluginManagedAgentsIntoTriageInput {
  pluginId: string;
  pluginKey: string;
  reason: string;
  actorType?: "system" | "user";
  actorId?: string | null;
}

export interface PausePluginManagedAgentsIntoTriageResult {
  triagePausedAgentIds: string[];
  suspensionRequests: RequestedAgentRunCancellations[];
  activities: PersistedActivityLog[];
}

export async function getPluginManagedAgentBinding(db: Db, input: { companyId: string; agentId: string }) {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(pluginManagedResources)
      .where(
        and(
          eq(pluginManagedResources.companyId, input.companyId),
          eq(pluginManagedResources.resourceKind, "agent"),
          eq(pluginManagedResources.resourceId, input.agentId),
        ),
      )
      .orderBy(desc(pluginManagedResources.updatedAt))
      .limit(2)
      .for("share");
    if (rows.length > 1) {
      throw conflict("Agent has multiple plugin-managed lifecycle bindings");
    }
    const binding = rows[0] ?? null;
    if (binding) {
      await lockPairedManagedAgentEntity(tx, binding);
    }
    return binding;
  });
}

export async function adoptPluginManagedAgentFromBoard(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    actorUserId: string;
  },
) {
  const committed = await db.transaction(async (tx) => {
    const now = new Date();
    const graph = await lockCompanyAgentGraph(tx, input.companyId);
    const bindingRows = await tx
      .select()
      .from(pluginManagedResources)
      .where(
        and(
          eq(pluginManagedResources.companyId, input.companyId),
          eq(pluginManagedResources.resourceKind, "agent"),
          eq(pluginManagedResources.resourceId, input.agentId),
        ),
      )
      .orderBy(desc(pluginManagedResources.updatedAt))
      .limit(2)
      .for("update");
    if (bindingRows.length > 1) {
      throw conflict("Agent has multiple active plugin-managed lifecycle bindings");
    }
    const binding = bindingRows[0] ?? null;
    if (!binding) throw notFound("Plugin-managed agent binding not found");
    if (binding.lifecycleState !== "triage_paused") {
      throw conflict("Only a plugin-managed agent in board triage can be adopted", {
        code: "plugin_managed_agent_not_in_triage",
        lifecycleState: binding.lifecycleState,
      });
    }
    const pairedEntity = await lockPairedManagedAgentEntity(tx, binding);

    const agent = graph.agents.find((candidate) => candidate.id === input.agentId);
    if (!agent || agent.status === "terminated") {
      throw conflict("Plugin-managed agent can no longer be adopted", {
        code: "plugin_managed_agent_not_adoptable",
      });
    }
    if (agent.status !== "paused") {
      throw conflict("Plugin-managed agent must remain paused during adoption", {
        code: "plugin_managed_agent_triage_state_conflict",
      });
    }

    const audit = {
      event: "plugin_managed_agent_adopted",
      pluginInstallationId: binding.pluginId,
      pluginKey: binding.pluginKey,
      resourceKey: binding.resourceKey,
      resourceId: binding.resourceId,
      previousLifecycleState: binding.lifecycleState,
      previousAgentStatus: agent.status,
      actorType: "user",
      actorId: input.actorUserId,
      occurredAt: now.toISOString(),
    };
    const adopted = await tx
      .update(pluginManagedResources)
      .set({
        lifecycleState: "adopted",
        lifecycleReason: "board_adopted",
        adoptedAt: now,
        lifecycleActorType: "user",
        lifecycleActorId: input.actorUserId,
        lifecycleAudit: audit,
        updatedAt: now,
      })
      .where(
        and(
          eq(pluginManagedResources.id, binding.id),
          eq(pluginManagedResources.lifecycleState, "triage_paused"),
        ),
      )
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!adopted) {
      throw conflict("Plugin-managed agent adoption lost its locked transition");
    }
    const adoptedEntity = await tx
      .update(pluginEntities)
      .set({ status: "adopted", updatedAt: now })
      .where(and(eq(pluginEntities.id, pairedEntity.id), eq(pluginEntities.status, "triage_paused")))
      .returning({ id: pluginEntities.id })
      .then((rows) => rows[0] ?? null);
    if (!adoptedEntity) {
      throw conflict("Plugin-managed agent adoption lost its managed-entity transition");
    }
    const activity = await persistActivityLog(tx as unknown as Db, {
      companyId: binding.companyId,
      actorType: "user",
      actorId: input.actorUserId,
      action: "plugin.managed_agent.adopted",
      entityType: "agent",
      entityId: binding.resourceId,
      details: audit,
    });
    return { adopted, activity };
  });
  publishCommittedActivity(committed.activity);
  return committed.adopted;
}
