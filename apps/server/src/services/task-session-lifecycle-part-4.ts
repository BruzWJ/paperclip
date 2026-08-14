import {
  activityLog,
  agents,
  approvalComments,
  approvals,
  assets,
  companies,
  companyLogos,
  companyMemberships,
  companySecrets,
  companySessionLifecycleOperations,
  costEvents,
  documentRevisions,
  documents,
  financeEvents,
  goals,
  invites,
  joinRequests,
  localExecutionLeases,
  pluginWithdrawalOperations,
  principalPermissionGrants,
  projects,
  routineRevisions,
  routineRuns,
  routineTriggers,
  routines,
  runtimeAgentConfigurationAudits,
  systemEscalationIdentities,
  taskCommentProjectionSources,
  taskComments,
  taskConsultExecutions,
  taskCreatorEdgeReceivability,
  taskExecutionAttemptRetrySchedules,
  taskExecutionAttempts,
  taskExecutionAuthorities,
  taskExecutionCancellationIntents,
  taskExecutionFinalizationPromptDependencies,
  taskExecutionFinalizationUpdateDependencies,
  taskExecutionHistoryViewMessages,
  taskExecutionLanes,
  taskExecutionLeases,
  taskExecutionPromptCapabilities,
  taskExecutionRefs,
  taskExecutionSessions,
  taskExecutionWorkspaceBindings,
  taskInboxArchives,
  taskReadStates,
  taskSessions,
  taskUpdates,
  tasks,
} from "@paperclipai/db";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { purgeCompanyTaskExecutionRunsInTransaction } from "./task-execution-run-service.js";
import * as lifecycle from "./task-session-lifecycle-part-1.js";
import { TaskSessionInvariantError, TaskSessionLifecycleConflict } from "./task-session/store.js";

export async function failCompanyCancellationIntentInTx(
  tx: lifecycle.CompanySessionLifecycleTx,
  input: {
    readonly intentId: string;
    readonly failureCode: string;
    readonly now?: Date;
  },
): Promise<lifecycle.PostgresCancellationIntent> {
  const failureCode = input.failureCode.trim();
  if (failureCode.length < 1 || failureCode.length > 200) {
    throw new TaskSessionLifecycleConflict("Cancellation failure code must contain 1 to 200 characters");
  }
  const now = input.now ?? new Date();
  const initial = await tx
    .select()
    .from(taskExecutionCancellationIntents)
    .where(eq(taskExecutionCancellationIntents.id, input.intentId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!initial) {
    throw new TaskSessionInvariantError(`Cancellation intent ${input.intentId} does not exist`);
  }
  await lifecycle.lockCompanySessionLifecycle(tx, initial.companyId);
  const failed = await tx
    .update(taskExecutionCancellationIntents)
    .set({ state: "failed", failedAt: now, failureCode })
    .where(
      and(
        eq(taskExecutionCancellationIntents.id, input.intentId),
        eq(taskExecutionCancellationIntents.state, "acknowledged"),
      ),
    )
    .returning()
    .then((rows) => rows[0] ?? null);
  if (!failed) {
    throw new TaskSessionLifecycleConflict("Only an acknowledged cancellation intent may fail", {
      intentId: input.intentId,
    });
  }
  const operation = await lifecycle.activeOperationForIntent(tx, failed);
  if (operation) {
    await lifecycle.refreshLifecycleOperationAfterCancellationInTx(tx, operation, now);
  }
  return failed;
}

/**
 * The one hard-delete exception to the closed run-service mutation surface.
 * Every gate is checked before the first DELETE and PostgreSQL rolls the whole
 * company-scoped transaction back on any ownership/FK invariant failure.
 */
export async function purgeCompanySessionGraphInTx(
  tx: lifecycle.CompanySessionLifecycleTx,
  input: {
    readonly companyId: string;
    readonly lifecycleOperationId: string;
    readonly now?: Date;
  },
): Promise<{
  readonly companyId: string;
  readonly generation: number;
  readonly purged: true;
}> {
  await lifecycle.lockCompanySessionLifecycle(tx, input.companyId);
  const company = await tx
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.id, input.companyId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!company) {
    throw new TaskSessionLifecycleConflict("Company purge cannot resolve its fenced company", input);
  }
  const operation = await tx
    .select()
    .from(companySessionLifecycleOperations)
    .where(
      and(
        eq(companySessionLifecycleOperations.companyId, input.companyId),
        eq(companySessionLifecycleOperations.id, input.lifecycleOperationId),
      ),
    )
    .limit(1)
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (!operation || operation.operation !== "hard_delete" || operation.status !== "purge_ready") {
    throw new TaskSessionLifecycleConflict("Company purge requires its purge-ready hard-delete operation", {
      ...input,
      operation: operation?.operation ?? null,
      status: operation?.status ?? null,
    });
  }
  const snapshot = lifecycle.parseLifecycleSnapshot(operation);
  const intents = await lifecycle.operationIntents(tx, operation);
  const uncompletedIntent = intents.find((intent) => intent.state !== "completed");

  const [
    activeAttempt,
    activeLease,
    liveCapability,
    liveNativeSession,
    activeRef,
    activeConsult,
    scheduledRetry,
    activeLane,
    activeLocalRunLease,
  ] = await Promise.all([
    tx
      .select({ id: taskExecutionAttempts.id })
      .from(taskExecutionAttempts)
      .where(
        and(
          eq(taskExecutionAttempts.companyId, input.companyId),
          inArray(taskExecutionAttempts.state, [...lifecycle.ACTIVE_ATTEMPT_STATES]),
        ),
      )
      .limit(1),
    tx
      .select({ id: taskExecutionLeases.id })
      .from(taskExecutionLeases)
      .where(and(eq(taskExecutionLeases.companyId, input.companyId), eq(taskExecutionLeases.state, "active")))
      .limit(1),
    tx
      .select({
        id: taskExecutionPromptCapabilities.capabilityConnectionId,
      })
      .from(taskExecutionPromptCapabilities)
      .where(
        and(
          eq(taskExecutionPromptCapabilities.companyId, input.companyId),
          inArray(taskExecutionPromptCapabilities.state, [...lifecycle.LIVE_CAPABILITY_STATES]),
        ),
      )
      .limit(1),
    tx
      .select({ id: taskExecutionSessions.id })
      .from(taskExecutionSessions)
      .where(
        and(
          eq(taskExecutionSessions.companyId, input.companyId),
          inArray(taskExecutionSessions.state, [...lifecycle.LIVE_NATIVE_SESSION_STATES]),
        ),
      )
      .limit(1),
    tx
      .select({ id: taskExecutionRefs.id })
      .from(taskExecutionRefs)
      .where(
        and(eq(taskExecutionRefs.companyId, input.companyId), eq(taskExecutionRefs.disposition, "active")),
      )
      .limit(1),
    tx
      .select({ id: taskConsultExecutions.id })
      .from(taskConsultExecutions)
      .where(
        and(eq(taskConsultExecutions.companyId, input.companyId), eq(taskConsultExecutions.state, "active")),
      )
      .limit(1),
    tx
      .select({ id: taskExecutionAttemptRetrySchedules.id })
      .from(taskExecutionAttemptRetrySchedules)
      .where(
        and(
          eq(taskExecutionAttemptRetrySchedules.companyId, input.companyId),
          eq(taskExecutionAttemptRetrySchedules.state, "scheduled"),
        ),
      )
      .limit(1),
    tx
      .select({ leaseId: taskExecutionLanes.activeLeaseId })
      .from(taskExecutionLanes)
      .where(
        and(eq(taskExecutionLanes.companyId, input.companyId), isNotNull(taskExecutionLanes.activeOrdinal)),
      )
      .limit(1),
    tx
      .select({ id: localExecutionLeases.id })
      .from(localExecutionLeases)
      .where(
        and(eq(localExecutionLeases.companyId, input.companyId), eq(localExecutionLeases.status, "active")),
      )
      .limit(1),
  ]);
  if (
    uncompletedIntent ||
    activeAttempt[0] ||
    activeLease[0] ||
    liveCapability[0] ||
    liveNativeSession[0] ||
    activeRef[0] ||
    activeConsult[0] ||
    scheduledRetry[0] ||
    activeLane[0] ||
    activeLocalRunLease[0]
  ) {
    throw new TaskSessionLifecycleConflict("Company Session graph purge is not cancellation-safe", {
      companyId: input.companyId,
      lifecycleOperationId: operation.id,
      uncompletedIntentId: uncompletedIntent?.id ?? null,
      activeAttemptId: activeAttempt[0]?.id ?? null,
      activeLeaseId: activeLease[0]?.id ?? null,
      liveCapabilityId: liveCapability[0]?.id ?? null,
      liveNativeSessionId: liveNativeSession[0]?.id ?? null,
      activeRefId: activeRef[0]?.id ?? null,
      activeConsultId: activeConsult[0]?.id ?? null,
      scheduledRetryId: scheduledRetry[0]?.id ?? null,
      activeLaneLeaseId: activeLane[0]?.leaseId ?? null,
      activeLocalRunLeaseId: activeLocalRunLease[0]?.id ?? null,
    });
  }

  const sessions = await lifecycle.lockSessionsParentFirst(tx, input.companyId);
  const parentById = new Map(sessions.map((session) => [session.id, session.parentSessionId] as const));

  // External run restrictors are removed before the canonical run roots.
  await tx
    .delete(taskExecutionFinalizationUpdateDependencies)
    .where(eq(taskExecutionFinalizationUpdateDependencies.companyId, input.companyId));
  await tx
    .delete(taskExecutionFinalizationPromptDependencies)
    .where(eq(taskExecutionFinalizationPromptDependencies.companyId, input.companyId));
  await tx
    .delete(taskExecutionCancellationIntents)
    .where(eq(taskExecutionCancellationIntents.companyId, input.companyId));
  await tx.delete(taskExecutionLeases).where(eq(taskExecutionLeases.companyId, input.companyId));
  await tx
    .delete(taskExecutionAttemptRetrySchedules)
    .where(eq(taskExecutionAttemptRetrySchedules.companyId, input.companyId));
  await tx.delete(taskExecutionAttempts).where(eq(taskExecutionAttempts.companyId, input.companyId));
  await tx
    .delete(taskCommentProjectionSources)
    .where(eq(taskCommentProjectionSources.companyId, input.companyId));
  await purgeCompanyTaskExecutionRunsInTransaction(tx, {
    companyId: input.companyId,
  });

  // Native correlations and Session projections no longer restrict a run.
  await tx.delete(taskExecutionSessions).where(eq(taskExecutionSessions.companyId, input.companyId));
  await tx
    .delete(taskExecutionHistoryViewMessages)
    .where(eq(taskExecutionHistoryViewMessages.companyId, input.companyId));
  for (const sessionId of [...snapshot.sessionIds].sort(
    (left, right) =>
      lifecycle.sessionDepth(right, parentById) - lifecycle.sessionDepth(left, parentById) ||
      left.localeCompare(right),
  )) {
    await tx
      .delete(taskSessions)
      .where(and(eq(taskSessions.companyId, input.companyId), eq(taskSessions.id, sessionId)));
  }

  await tx.delete(activityLog).where(eq(activityLog.companyId, input.companyId));
  await tx.delete(financeEvents).where(eq(financeEvents.companyId, input.companyId));
  await tx.delete(costEvents).where(eq(costEvents.companyId, input.companyId));
  await tx
    .delete(pluginWithdrawalOperations)
    .where(eq(pluginWithdrawalOperations.companyId, input.companyId));
  await tx.delete(taskUpdates).where(eq(taskUpdates.companyId, input.companyId));
  await tx.delete(taskReadStates).where(eq(taskReadStates.companyId, input.companyId));
  await tx.delete(taskInboxArchives).where(eq(taskInboxArchives.companyId, input.companyId));
  await tx.delete(approvalComments).where(eq(approvalComments.companyId, input.companyId));
  await tx.delete(approvals).where(eq(approvals.companyId, input.companyId));
  await tx.delete(documentRevisions).where(eq(documentRevisions.companyId, input.companyId));
  await tx.delete(taskComments).where(eq(taskComments.companyId, input.companyId));
  await tx
    .delete(systemEscalationIdentities)
    .where(eq(systemEscalationIdentities.companyId, input.companyId));
  await tx
    .delete(taskCreatorEdgeReceivability)
    .where(eq(taskCreatorEdgeReceivability.companyId, input.companyId));
  await tx.delete(taskExecutionAuthorities).where(eq(taskExecutionAuthorities.companyId, input.companyId));
  await tx
    .delete(taskExecutionWorkspaceBindings)
    .where(eq(taskExecutionWorkspaceBindings.companyId, input.companyId));
  await tx.delete(companySecrets).where(eq(companySecrets.companyId, input.companyId));
  await tx.delete(joinRequests).where(eq(joinRequests.companyId, input.companyId));
  await tx.delete(invites).where(eq(invites.companyId, input.companyId));
  await tx.delete(principalPermissionGrants).where(eq(principalPermissionGrants.companyId, input.companyId));
  await tx.delete(companyMemberships).where(eq(companyMemberships.companyId, input.companyId));
  await tx.delete(routineRuns).where(eq(routineRuns.companyId, input.companyId));
  await tx.delete(routineTriggers).where(eq(routineTriggers.companyId, input.companyId));
  await tx.delete(routineRevisions).where(eq(routineRevisions.companyId, input.companyId));
  await tx.delete(routines).where(eq(routines.companyId, input.companyId));
  await tx.delete(documents).where(eq(documents.companyId, input.companyId));
  await tx.delete(tasks).where(eq(tasks.companyId, input.companyId));
  await tx.delete(companyLogos).where(eq(companyLogos.companyId, input.companyId));
  await tx.delete(assets).where(eq(assets.companyId, input.companyId));
  await tx.delete(goals).where(eq(goals.companyId, input.companyId));
  await tx.delete(projects).where(eq(projects.companyId, input.companyId));
  await tx
    .delete(runtimeAgentConfigurationAudits)
    .where(eq(runtimeAgentConfigurationAudits.companyId, input.companyId));
  await tx
    .update(agents)
    .set({
      currentAdapterConfigRevisionId: null,
      reportsTo: null,
    })
    .where(eq(agents.companyId, input.companyId));
  await tx.delete(agents).where(eq(agents.companyId, input.companyId));
  await tx
    .delete(companySessionLifecycleOperations)
    .where(eq(companySessionLifecycleOperations.companyId, input.companyId));
  const deleted = await tx
    .delete(companies)
    .where(eq(companies.id, input.companyId))
    .returning({ id: companies.id });
  if (!deleted[0]) {
    throw new TaskSessionInvariantError(`Fenced company ${input.companyId} disappeared during purge`);
  }
  return {
    companyId: input.companyId,
    generation: operation.generation,
    purged: true,
  };
}
