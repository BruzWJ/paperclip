import { and, desc, eq, inArray } from "drizzle-orm";
import { type Db, agents, pluginEntities, pluginManagedResources } from "@paperclipai/db";
import { conflict, notFound } from "../errors.js";
import {
  terminateAgentToTombstoneInTransaction,
  type AgentLifecycleCancellationService,
  type AgentLifecyclePostCommit,
} from "./agents.js";
import { persistActivityLog, publishCommittedActivity, type PersistedActivityLog } from "./activity-log.js";
import {
  withdrawOpenHireApprovalForAgentInTransaction,
  type ApprovalLifecycleTransaction,
  type HireRejectionAgentTerminationInput,
} from "./approvals.js";
import type { TaskSessionDbTransaction } from "./task-session/event-store.js";
import type { RequestedAgentRunCancellations } from "./task-execution-cancellation.js";
import { lockCompanyAgentGraph } from "./agent-org-graph-lock.js";
import {
  lockPairedManagedAgentEntity,
  type PluginManagedAgentBinding,
} from "./plugin-managed-agent-binding.js";

export async function recordPluginManagedAgentTerminationInTransaction(
  tx: TaskSessionDbTransaction,
  input: {
    binding: PluginManagedAgentBinding;
    previousAgentStatus: string;
    actorUserId: string;
    event: "plugin_managed_agent_terminated_by_board" | "plugin_managed_agent_terminated_by_hire_rejection";
    sourceId: string;
    now: Date;
  },
) {
  const pairedEntity = await lockPairedManagedAgentEntity(tx, input.binding);
  const audit = {
    event: input.event,
    pluginInstallationId: input.binding.pluginId,
    pluginKey: input.binding.pluginKey,
    resourceKey: input.binding.resourceKey,
    resourceId: input.binding.resourceId,
    previousLifecycleState: input.binding.lifecycleState,
    previousAgentStatus: input.previousAgentStatus,
    actorType: "user",
    actorId: input.actorUserId,
    reason: "agent_terminated",
    sourceId: input.sourceId,
    occurredAt: input.now.toISOString(),
  };
  const terminatedBinding = await tx
    .update(pluginManagedResources)
    .set({
      lifecycleState: "terminated",
      lifecycleReason: "agent_terminated",
      terminatedAt: input.now,
      lifecycleActorType: "user",
      lifecycleActorId: input.actorUserId,
      lifecycleAudit: audit,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(pluginManagedResources.id, input.binding.id),
        inArray(pluginManagedResources.lifecycleState, ["active", "triage_paused"]),
      ),
    )
    .returning()
    .then((rows) => rows[0] ?? null);
  if (!terminatedBinding) {
    throw conflict("Plugin-managed agent termination lost its locked binding transition");
  }
  const entity = await tx
    .update(pluginEntities)
    .set({ status: "terminated", updatedAt: input.now })
    .where(
      and(
        eq(pluginEntities.id, pairedEntity.id),
        inArray(pluginEntities.status, ["active", "triage_paused"]),
      ),
    )
    .returning({ id: pluginEntities.id })
    .then((rows) => rows[0] ?? null);
  if (!entity) {
    throw conflict("Plugin-managed agent termination lost its managed-entity transition");
  }
  const activity = await persistActivityLog(tx as unknown as Db, {
    companyId: input.binding.companyId,
    actorType: "user",
    actorId: input.actorUserId,
    action: "plugin.managed_agent.terminated",
    entityType: "agent",
    entityId: input.binding.resourceId,
    details: audit,
  });
  return { terminatedBinding, activity };
}

export async function terminateAgentForHireRejectionInTransaction(
  tx: ApprovalLifecycleTransaction,
  input: HireRejectionAgentTerminationInput,
  cancellation: AgentLifecycleCancellationService,
) {
  const graph = await lockCompanyAgentGraph(tx, input.companyId);
  const bindingRows = await tx
    .select()
    .from(pluginManagedResources)
    .where(
      and(
        eq(pluginManagedResources.companyId, input.companyId),
        eq(pluginManagedResources.resourceKind, "agent"),
        eq(pluginManagedResources.resourceId, input.agentId),
        inArray(pluginManagedResources.lifecycleState, ["active", "triage_paused"]),
      ),
    )
    .orderBy(desc(pluginManagedResources.updatedAt))
    .limit(2)
    .for("update");
  if (bindingRows.length > 1) {
    throw conflict("Agent has multiple active plugin-managed lifecycle bindings");
  }
  const previousAgent = graph.agents.find((candidate) => candidate.id === input.agentId);
  const termination = await terminateAgentToTombstoneInTransaction(
    tx,
    {
      companyId: input.companyId,
      agentId: input.agentId,
      sourceId: input.sourceId,
      actor: { kind: "user", userId: input.decidedByUserId },
      now: input.now,
    },
    cancellation,
  );
  const binding = bindingRows[0];
  if (termination && binding) {
    const recorded = await recordPluginManagedAgentTerminationInTransaction(tx, {
      binding,
      previousAgentStatus: previousAgent?.status ?? "missing",
      actorUserId: input.decidedByUserId,
      event: "plugin_managed_agent_terminated_by_hire_rejection",
      sourceId: input.sourceId,
      now: input.now,
    });
    termination.activities.push(recorded.activity);
  }
  return termination;
}

export async function terminatePluginManagedAgentFromBoard(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    actorUserId: string;
  },
  postCommit: AgentLifecyclePostCommit,
) {
  const committed = await db.transaction(async (tx) => {
    const now = new Date();
    const graph = await lockCompanyAgentGraph(tx, input.companyId);
    const binding = await tx
      .select()
      .from(pluginManagedResources)
      .where(
        and(
          eq(pluginManagedResources.companyId, input.companyId),
          eq(pluginManagedResources.resourceKind, "agent"),
          eq(pluginManagedResources.resourceId, input.agentId),
          inArray(pluginManagedResources.lifecycleState, ["active", "triage_paused"]),
        ),
      )
      .orderBy(desc(pluginManagedResources.updatedAt))
      .limit(1)
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!binding) {
      return {
        terminatedBinding: null,
        dispatchRefIds: [] as string[],
        cancellationRequests: [] as RequestedAgentRunCancellations[],
        suspensionRequests: [] as RequestedAgentRunCancellations[],
        activities: [] as PersistedActivityLog[],
      };
    }

    const agent = graph.agents.find((candidate) => candidate.id === input.agentId);
    if (!agent) throw notFound("Agent not found");

    const sourceId = `plugin-managed-agent-board-termination:${binding.id}:${agent.id}`;
    const withdrawn = await withdrawOpenHireApprovalForAgentInTransaction(
      tx,
      {
        companyId: input.companyId,
        agentId: input.agentId,
        decidedByUserId: input.actorUserId,
        decisionNote: "Hire rejected because the board terminated the plugin-managed agent",
        sourceId,
        now,
      },
      postCommit.taskExecutionCancellation,
    );
    const termination =
      withdrawn ??
      (await terminateAgentToTombstoneInTransaction(
        tx,
        {
          companyId: input.companyId,
          agentId: input.agentId,
          sourceId,
          actor: { kind: "user", userId: input.actorUserId },
          now,
        },
        postCommit.taskExecutionCancellation,
      ));
    if (!termination) {
      throw conflict("Plugin-managed agent termination lost its agent transition");
    }

    const recorded = await recordPluginManagedAgentTerminationInTransaction(tx, {
      binding,
      previousAgentStatus: agent.status,
      actorUserId: input.actorUserId,
      event: "plugin_managed_agent_terminated_by_board",
      sourceId,
      now,
    });
    return {
      terminatedBinding: recorded.terminatedBinding,
      dispatchRefIds: termination.dispatchRefIds,
      cancellationRequests: termination.cancellationRequests ? [termination.cancellationRequests] : [],
      suspensionRequests: termination.suspensionRequests ? [termination.suspensionRequests] : [],
      activities: [...termination.activities, recorded.activity],
    };
  });
  for (const activity of committed.activities) {
    publishCommittedActivity(activity);
  }
  for (const cancellationRequests of committed.cancellationRequests) {
    await postCommit.taskExecutionCancellation.reconcileRequestedCancellations(cancellationRequests);
  }
  for (const suspensionRequests of committed.suspensionRequests) {
    await postCommit.taskExecutionCancellation.reconcileRequestedCancellations(suspensionRequests);
  }
  for (const refId of committed.dispatchRefIds) {
    await postCommit.dispatchRef(refId);
  }
  return committed.terminatedBinding;
}
