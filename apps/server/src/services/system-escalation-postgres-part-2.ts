import {
  agentAdapterConfigRevisions,
  taskCreatorEdgeReceivability,
  taskExecutionAuthorities,
  taskSessionContextEpochs,
  taskSessions,
  tasks,
  type systemEscalationIdentities,
} from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import * as escalationCore from "./system-escalation-postgres-part-1.js";
import { type TaskSessionAdmissionService } from "./task-session/admission.js";
import type { TaskSessionDbTransaction } from "./task-session/event-store.js";

export async function appendEscalationNudge(
  sessions: TaskSessionAdmissionService,
  tx: TaskSessionDbTransaction,
  input: escalationCore.EnsureSystemEscalationInput,
  identity: typeof systemEscalationIdentities.$inferSelect,
  escalationTask: escalationCore.TaskRow,
): Promise<string | null> {
  const sessionState = await tx
    .select({
      session: taskSessions,
      contextGeneration: taskSessionContextEpochs.generation,
    })
    .from(taskSessions)
    .innerJoin(
      taskSessionContextEpochs,
      and(
        eq(taskSessionContextEpochs.companyId, taskSessions.companyId),
        eq(taskSessionContextEpochs.taskId, taskSessions.taskId),
        eq(taskSessionContextEpochs.sessionId, taskSessions.id),
      ),
    )
    .where(and(eq(taskSessions.companyId, input.companyId), eq(taskSessions.taskId, escalationTask.id)))
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (!sessionState) {
    throw new escalationCore.PostgresSystemEscalationConflict(
      "Historical escalation identity is missing its canonical Session",
      "escalation_session_missing",
    );
  }
  const { session, contextGeneration } = sessionState;
  const reason = escalationCore.terminalReason(
    (identity.immutableSource.reason as string | undefined) ?? null,
  );
  const exactText = `System ${input.systemSource} nudge: the escalation for ${identity.affectedTaskId} remains active (${reason}).`;
  const sourceKey = `${identity.id}:${input.causalSourceId}`;

  if (
    escalationTask.hiddenAt === null &&
    escalationTask.ownerKind === "agent" &&
    escalationTask.ownerAgentId &&
    escalationTask.ownershipEpoch &&
    escalationTask.lifecycleStatus &&
    escalationCore.NONTERMINAL_STATUSES.has(escalationTask.lifecycleStatus)
  ) {
    const companyAgents = await escalationCore.loadCompanyAgents(tx, input.companyId);
    const currentOwner = escalationCore.liveAgent(escalationTask.ownerAgentId, companyAgents);
    if (currentOwner?.currentAdapterConfigRevisionId) {
      const [revision, authority] = await Promise.all([
        tx
          .select({ id: agentAdapterConfigRevisions.id })
          .from(agentAdapterConfigRevisions)
          .where(
            and(
              eq(agentAdapterConfigRevisions.companyId, input.companyId),
              eq(agentAdapterConfigRevisions.agentId, currentOwner.id),
              eq(agentAdapterConfigRevisions.id, currentOwner.currentAdapterConfigRevisionId),
            ),
          )
          .limit(1)
          .then((rows) => rows[0] ?? null),
        tx
          .select()
          .from(taskExecutionAuthorities)
          .where(
            and(
              eq(taskExecutionAuthorities.companyId, input.companyId),
              eq(taskExecutionAuthorities.taskId, escalationTask.id),
              eq(taskExecutionAuthorities.ownershipEpoch, escalationTask.ownershipEpoch),
              eq(taskExecutionAuthorities.agentId, currentOwner.id),
              eq(taskExecutionAuthorities.state, "current"),
            ),
          )
          .for("update")
          .then((rows) => rows[0] ?? null),
      ]);
      if (revision && authority) {
        const admitted = await sessions.admitExecutionSource(
          {
            companyId: input.companyId,
            taskId: escalationTask.id,
            sessionId: session.id,
            ownershipEpoch: escalationTask.ownershipEpoch,
            targetAgentId: currentOwner.id,
            taskExecutionAuthorityId: authority.id,
            consultExecutionId: null,
            adapterConfigRevisionId: revision.id,
            contextEpoch: contextGeneration,
            mode: "owner",
            sourceKind: "system_nudge",
            actor: {
              kind: "system",
              sourceKind: input.systemSource,
              sourceId: input.causalSourceId,
            },
            immutableSourceKey: sourceKey,
            sourceRecordId: input.causalSourceId,
            exactText,
            comment: {
              author: escalationCore.sourceAuthor(input.systemSource),
              producingRun: null,
            },
            idempotencyKey: sourceKey,
          },
          tx,
        );
        return admitted.retried ? null : (admitted.ref?.id ?? null);
      }
    }
  }

  await sessions.appendNonDispatchControlNotice(
    {
      companyId: input.companyId,
      taskId: escalationTask.id,
      sessionId: session.id,
      sourceKind: "system_escalation_nudge",
      immutableSourceKey: sourceKey,
      sourceRecordId: input.causalSourceId,
      exactText,
      comment: {
        author: escalationCore.sourceAuthor(input.systemSource),
        producingRun: null,
      },
      allowTerminal: true,
    },
    tx,
  );
  return null;
}

export async function loadLockedAffectedScope(
  tx: TaskSessionDbTransaction,
  input: escalationCore.EnsureSystemEscalationInput,
) {
  const affected = await tx
    .select()
    .from(tasks)
    .where(and(eq(tasks.companyId, input.companyId), eq(tasks.id, input.affectedTaskId)))
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (
    !affected ||
    affected.ownershipEpoch !== input.affectedOwnershipEpoch ||
    !affected.lifecycleStatus ||
    !escalationCore.NONTERMINAL_STATUSES.has(affected.lifecycleStatus)
  ) {
    throw new escalationCore.PostgresSystemEscalationConflict(
      "System escalation requires the current nonterminal affected task epoch",
      "affected_task_not_current_nonterminal",
    );
  }
  if (affected.creatorKind === "system" || affected.escalatedFromAffectedTaskId !== null) {
    throw new escalationCore.PostgresSystemEscalationConflict(
      "A system escalation cannot itself be escalated",
      "system_escalation_recursion",
    );
  }
  const edges = await tx
    .select()
    .from(taskCreatorEdgeReceivability)
    .where(
      and(
        eq(taskCreatorEdgeReceivability.companyId, input.companyId),
        eq(taskCreatorEdgeReceivability.taskId, input.affectedTaskId),
        eq(taskCreatorEdgeReceivability.ownershipEpoch, input.affectedOwnershipEpoch),
      ),
    )
    .for("update");
  const edge = edges[0] ?? null;
  if (
    !edge ||
    edge.id !== input.terminalCreatorEdgeId ||
    edge.state !== "terminal" ||
    edge.endpointKind === "user/board" ||
    edge.endpointKind === "system"
  ) {
    throw new escalationCore.PostgresSystemEscalationConflict(
      "System escalation requires the locked terminal creator edge",
      "terminal_creator_edge_not_current",
    );
  }
  escalationCore.terminalReason(edge.terminalReason);
  const affectedSession = await tx
    .select()
    .from(taskSessions)
    .where(
      and(
        eq(taskSessions.companyId, input.companyId),
        eq(taskSessions.taskId, affected.id),
        eq(taskSessions.id, edge.sessionId),
      ),
    )
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (
    !affectedSession ||
    affectedSession.integrityState !== "ready" ||
    affectedSession.timeArchived !== null ||
    affectedSession.purgeFencedAt !== null
  ) {
    throw new escalationCore.PostgresSystemEscalationConflict(
      "Affected task Session is lifecycle-fenced",
      "affected_session_not_ready",
    );
  }
  return { affected, edge, affectedSession };
}
