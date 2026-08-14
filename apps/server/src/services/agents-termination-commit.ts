import {
  type Db,
  agents,
  taskCreatorEdgeReceivability,
  taskExecutionAuthorities,
  taskSessions,
  taskUpdates,
  tasks,
} from "@paperclipai/db";
import { and, eq, inArray, ne } from "drizzle-orm";
import { conflict } from "../errors.js";
import { type PersistedActivityLog, persistActivityLog } from "./activity-log.js";
import { listCompanyAgentGraphDescendants, lockCompanyAgentGraph } from "./agent-org-graph-lock.js";
import { admitCounterpartTaskUpdate, lockTaskMentionRecipient } from "./runtime-task-action-port.js";
import { terminalizeAgentCreatorEdgesInTransaction } from "./system-escalation-postgres.js";
import type {
  RequestedAgentRunCancellations,
  TaskExecutionCancellationActor,
  TaskExecutionCancellationService,
} from "./task-execution-cancellation.js";
import { createTaskSessionAdmissionService } from "./task-session/admission.js";
import { deterministicUuid as lifecycleUuid } from "./deterministic-uuid.js";
export type AgentLifecycleTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface AgentTerminationCommit {
  tombstone: typeof agents.$inferSelect;
  dispatchRefIds: string[];
  cancellationRequests: RequestedAgentRunCancellations | null;
  suspensionRequests: RequestedAgentRunCancellations | null;
  activities: PersistedActivityLog[];
}

export type AgentLifecycleCancellationService = Pick<
  TaskExecutionCancellationService,
  | "requestAgentCancellationsInTransaction"
  | "reconcileRequestedCancellations"
  | "requestAgentSuspensionsInTransaction"
>;

export type AgentSuspensionService = Pick<
  TaskExecutionCancellationService,
  "requestAgentSuspensionsInTransaction" | "reconcileRequestedCancellations"
>;

export interface AgentSuspensionPostCommit {
  taskExecutionCancellation: AgentSuspensionService;
  actor: AgentTerminationActor;
}

export type AgentTerminationActor = Extract<
  TaskExecutionCancellationActor,
  { readonly kind: "system" } | { readonly kind: "user" }
>;

export interface AgentLifecyclePostCommit {
  taskExecutionCancellation: AgentLifecycleCancellationService;
  dispatchRef(refId: string): Promise<void>;
}

export interface AgentTerminationPostCommit extends AgentLifecyclePostCommit {
  actor: AgentTerminationActor;
}

export { lifecycleUuid };
export async function admitOwnedTaskTerminationRecoveryInTransaction(
  tx: AgentLifecycleTransaction,
  input: {
    companyId: string;
    agentId: string;
    agentName: string;
    sourceId: string;
    now: Date;
  },
): Promise<string[]> {
  const sessions = createTaskSessionAdmissionService(tx as unknown as Db);
  const ownedTasks = await tx
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.companyId, input.companyId),
        eq(tasks.ownerKind, "agent"),
        eq(tasks.ownerAgentId, input.agentId),
        eq(tasks.lifecycleStatus, "open"),
      ),
    )
    .orderBy(tasks.id)
    .for("update");
  if (ownedTasks.length === 0) return [];

  const dispatchRefIds: string[] = [];
  for (const task of ownedTasks) {
    if (!task.ownershipEpoch) {
      throw new Error(`Owned task ${task.id} has no current ownership epoch`);
    }
    const session = await tx
      .select()
      .from(taskSessions)
      .where(and(eq(taskSessions.companyId, input.companyId), eq(taskSessions.taskId, task.id)))
      .for("update")
      .then((rows) => rows[0] ?? null);
    const authority = await tx
      .select()
      .from(taskExecutionAuthorities)
      .where(
        and(
          eq(taskExecutionAuthorities.companyId, input.companyId),
          eq(taskExecutionAuthorities.taskId, task.id),
          eq(taskExecutionAuthorities.ownershipEpoch, task.ownershipEpoch),
          eq(taskExecutionAuthorities.agentId, input.agentId),
          eq(taskExecutionAuthorities.state, "current"),
        ),
      )
      .for("update")
      .then((rows) => rows[0] ?? null);
    const edge = await tx
      .select()
      .from(taskCreatorEdgeReceivability)
      .where(
        and(
          eq(taskCreatorEdgeReceivability.companyId, input.companyId),
          eq(taskCreatorEdgeReceivability.taskId, task.id),
          eq(taskCreatorEdgeReceivability.ownershipEpoch, task.ownershipEpoch),
        ),
      )
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!session || !authority || !edge) {
      throw new Error(`Owned task ${task.id} is missing its canonical recovery graph`);
    }
    const recoveryKey = `${input.sourceId}:owned-task:${task.id}:${task.ownershipEpoch}`;
    const exactText = `Agent ${input.agentName} was terminated. This task is blocked because its owner is no longer executable.`;
    const blockedTask = await tx
      .update(tasks)
      .set({
        lifecycleStatus: "blocked",
        boardPresentationStatus: "blocked",
        disposition: null,
        completedAt: null,
        cancelledAt: null,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(tasks.id, task.id),
          eq(tasks.companyId, input.companyId),
          eq(tasks.ownershipEpoch, task.ownershipEpoch),
          eq(tasks.lifecycleStatus, "open"),
        ),
      )
      .returning({ id: tasks.id })
      .then((rows) => rows[0] ?? null);
    if (!blockedTask) {
      throw conflict(`Owned task ${task.id} lost its locked termination-recovery transition`);
    }
    const updateId = lifecycleUuid("agent-termination-recovery-update", recoveryKey);
    const targetTaskId = task.parentId ?? task.id;
    const admission = await admitCounterpartTaskUpdate(sessions, tx as never, {
      companyId: input.companyId,
      target: await lockTaskMentionRecipient(tx as never, input.companyId, targetTaskId),
      actor: {
        kind: "system",
        sourceKind: "agent_termination",
        sourceId: input.sourceId,
      },
      comment: {
        author: { kind: "system", source: "recovery" },
        producingRun: null,
      },
      sourceAgentTarget: {
        taskId: task.id,
        agentId: input.agentId,
      },
      sourceKind: "task_update",
      immutableSourceKey: recoveryKey,
      sourceRecordId: updateId,
      message: exactText,
    });
    if (!admission.comment) {
      throw new Error(`Owned task ${task.id} termination recovery has no canonical comment`);
    }
    const update = await tx
      .insert(taskUpdates)
      .values({
        id: updateId,
        companyId: input.companyId,
        taskId: task.id,
        sessionId: session.id,
        ownershipEpoch: task.ownershipEpoch,
        form: "owner",
        sourceKind: "system",
        sourceAuthorityId: authority.id,
        sourceIdentity: {
          sourceKind: "agent_termination",
          sourceId: input.sourceId,
          terminatedAgentId: input.agentId,
        },
        runId: null,
        gatewayInvocationId: recoveryKey,
        runSequence: 0,
        message: exactText,
        status: "blocked",
        disposition: null,
        commentId: admission.comment.id,
        creatorEdgeId: edge.id,
        createdAt: input.now,
      })
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!update) {
      throw new Error(`Owned task ${task.id} termination update was not persisted`);
    }
    if (admission.ref) dispatchRefIds.push(admission.ref.id);
  }
  return dispatchRefIds;
}
/**
 * Canonical in-transaction agent termination. Callers that must atomically
 * couple another control-plane transition (for example hire rejection) use
 * this exact implementation rather than replaying configuration or deleting
 * the agent.
 */
export async function terminateAgentToTombstoneInTransaction(
  tx: AgentLifecycleTransaction,
  input: {
    companyId?: string;
    agentId: string;
    sourceId: string;
    actor: AgentTerminationActor;
    now: Date;
  },
  cancellation: AgentLifecycleCancellationService,
): Promise<AgentTerminationCommit | null> {
  const companyId =
    input.companyId ??
    (await tx
      .select({ companyId: agents.companyId })
      .from(agents)
      .where(eq(agents.id, input.agentId))
      .then((rows) => rows[0]?.companyId ?? null));
  if (!companyId) return null;

  const locked = await lockCompanyAgentGraph(tx, companyId);
  if (!locked.company) return null;
  const existing = locked.agents.find(
    (candidate) =>
      candidate.id === input.agentId && (!input.companyId || candidate.companyId === input.companyId),
  );
  if (!existing) return null;
  if (existing.status === "terminated") {
    return {
      tombstone: existing,
      dispatchRefIds: [],
      cancellationRequests: null,
      suspensionRequests: null,
      activities: [],
    };
  }

  const descendants = listCompanyAgentGraphDescendants(existing.id, locked.agents);
  const nonTerminatedDescendantIds = descendants
    .filter((descendant) => descendant.status !== "terminated")
    .map((descendant) => descendant.id);

  const tombstone = await tx
    .update(agents)
    .set({
      status: "terminated",
      pauseReason: null,
      pausedAt: null,
      errorReason: null,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(agents.id, existing.id),
        eq(agents.companyId, existing.companyId),
        ne(agents.status, "terminated"),
      ),
    )
    .returning()
    .then((rows) => rows[0] ?? null);
  if (!tombstone) {
    throw conflict("Agent termination lost its locked tombstone transition");
  }

  if (nonTerminatedDescendantIds.length > 0) {
    const pausedDescendants = await tx
      .update(agents)
      .set({
        status: "paused",
        pauseReason: "system",
        pausedAt: input.now,
        errorReason: null,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(agents.companyId, existing.companyId),
          inArray(agents.id, nonTerminatedDescendantIds),
          ne(agents.status, "terminated"),
        ),
      )
      .returning({ id: agents.id });
    const pausedDescendantIds = new Set(pausedDescendants.map((descendant) => descendant.id));
    if (
      pausedDescendantIds.size !== nonTerminatedDescendantIds.length ||
      nonTerminatedDescendantIds.some((descendantId) => !pausedDescendantIds.has(descendantId))
    ) {
      throw conflict("Agent termination lost a locked descendant pause transition");
    }
  }

  const escalations = await terminalizeAgentCreatorEdgesInTransaction(
    tx,
    createTaskSessionAdmissionService(tx as unknown as Db),
    {
      companyId: tombstone.companyId,
      agentId: tombstone.id,
      sourceId: input.sourceId,
      now: input.now,
    },
  );
  const cancellationRequests = await cancellation.requestAgentCancellationsInTransaction(tx, {
    companyId: existing.companyId,
    agentIds: [existing.id],
    reason: "Cancelled because the agent was terminated",
    actor: input.actor,
    now: input.now,
  });
  const suspensionRequests =
    nonTerminatedDescendantIds.length > 0
      ? await cancellation.requestAgentSuspensionsInTransaction(tx, {
          companyId: existing.companyId,
          agentIds: nonTerminatedDescendantIds,
          reason: "Suspended because the reporting chain contains a terminated agent",
          actor: input.actor,
          now: input.now,
        })
      : null;
  const recoveryDispatchRefIds = await admitOwnedTaskTerminationRecoveryInTransaction(tx, {
    companyId: existing.companyId,
    agentId: existing.id,
    agentName: existing.name,
    sourceId: input.sourceId,
    now: input.now,
  });
  const dispatchRefIds = [
    ...escalations.flatMap((escalation) => (escalation.dispatchRefId ? [escalation.dispatchRefId] : [])),
    ...recoveryDispatchRefIds,
  ];
  const activity = await persistActivityLog(tx as unknown as Db, {
    companyId: existing.companyId,
    actorType: input.actor.kind,
    actorId: input.actor.kind === "user" ? input.actor.userId : input.sourceId,
    action: "agent.terminated",
    entityType: "agent",
    entityId: existing.id,
    details: {
      sourceId: input.sourceId,
      descendantPausedAgentIds: nonTerminatedDescendantIds,
      cancellationRequestedRunIds: cancellationRequests.requests.map((request) => request.runId),
      suspensionRequestedRunIds: suspensionRequests?.requests.map((request) => request.runId) ?? [],
      fencedExecutionRefIds: cancellationRequests.fence.refIds,
      fencedTargetCorrelationIds: cancellationRequests.fence.correlationIds,
      suspendedExecutionRefIds: suspensionRequests?.fence.refIds ?? [],
      supersededDescendantCorrelationIds: suspensionRequests?.fence.correlationIds ?? [],
      dispatchRefIds,
    },
  });
  return {
    tombstone,
    dispatchRefIds,
    cancellationRequests,
    suspensionRequests,
    activities: [activity],
  };
}
