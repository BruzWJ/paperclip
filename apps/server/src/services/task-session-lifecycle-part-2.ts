import {
  companies,
  companySessionLifecycleOperations,
  taskConsultExecutions,
  taskExecutionAttemptRetrySchedules,
  taskExecutionAttempts,
  taskExecutionCancellationIntents,
  taskExecutionHistoryViews,
  taskExecutionLeases,
  taskExecutionPromptCapabilities,
  taskExecutionRefs,
  taskExecutionRunRefs,
  taskExecutionSessions,
  taskSessionInputDispositions,
  taskSessions,
} from "@paperclipai/db";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  attachTaskExecutionRunCancellationInTransaction,
  lockTaskExecutionRunInTransaction,
} from "./task-execution-run-service.js";
import * as lifecycle from "./task-session-lifecycle-part-1.js";
import { TaskSessionInvariantError, TaskSessionLifecycleConflict } from "./task-session/store.js";

export async function fenceCompanySessionGraphInTx(
  tx: lifecycle.CompanySessionLifecycleTx,
  input: {
    readonly companyId: string;
    readonly lifecycleOperationId: string;
    readonly operation: "archive" | "hard_delete";
    readonly now: Date;
    readonly fenceToken: string;
    readonly actor?: lifecycle.CompanySessionLifecycleActor;
  },
): Promise<lifecycle.CompanySessionLifecycleBeginResult | null> {
  await lifecycle.lockCompanySessionLifecycle(tx, input.companyId);
  const company = await tx
    .select()
    .from(companies)
    .where(eq(companies.id, input.companyId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!company) return null;

  const existing = await lifecycle.latestLifecycleOperation(tx, input.companyId, input.operation);
  if (
    existing &&
    (company.sessionIntegrityState === "archive_fenced" ||
      existing.status !== "completed" ||
      input.operation === "hard_delete")
  ) {
    return {
      operation: existing,
      intents: await lifecycle.operationIntents(tx, existing),
      runs: lifecycle.parseLifecycleSnapshot(existing).runs,
      created: false,
    };
  }

  const otherActive = await tx
    .select({ id: companySessionLifecycleOperations.id })
    .from(companySessionLifecycleOperations)
    .where(
      and(
        eq(companySessionLifecycleOperations.companyId, input.companyId),
        inArray(companySessionLifecycleOperations.status, ["fenced", "cancelling", "purge_ready"]),
      ),
    )
    .limit(1);
  if (otherActive[0]) {
    throw new TaskSessionLifecycleConflict("A company Session lifecycle operation is already active", {
      companyId: input.companyId,
      operationId: otherActive[0].id,
    });
  }

  const sessions = await lifecycle.lockSessionsParentFirst(tx, input.companyId);
  const attempts = await tx
    .select()
    .from(taskExecutionAttempts)
    .where(
      and(
        eq(taskExecutionAttempts.companyId, input.companyId),
        inArray(taskExecutionAttempts.state, [...lifecycle.ACTIVE_ATTEMPT_STATES]),
      ),
    )
    .orderBy(asc(taskExecutionAttempts.id))
    .for("update");
  const attemptIds = attempts.map((attempt) => attempt.id);
  const leases = attemptIds.length
    ? await tx
        .select()
        .from(taskExecutionLeases)
        .where(inArray(taskExecutionLeases.attemptId, attemptIds))
        .orderBy(asc(taskExecutionLeases.id))
        .for("update")
    : [];
  const existingIntents = attemptIds.length
    ? await tx
        .select()
        .from(taskExecutionCancellationIntents)
        .where(inArray(taskExecutionCancellationIntents.attemptId, attemptIds))
        .orderBy(asc(taskExecutionCancellationIntents.id))
        .for("update")
    : [];
  const leaseByAttempt = new Map(leases.map((lease) => [lease.attemptId, lease] as const));
  const intentByAttempt = new Map(existingIntents.map((intent) => [intent.attemptId, intent] as const));
  const actor = lifecycle.lifecycleActor(input.actor);

  const openRunRefs = await tx
    .select({
      companyId: taskExecutionRunRefs.companyId,
      taskId: taskExecutionRunRefs.taskId,
      runId: taskExecutionRunRefs.runId,
    })
    .from(taskExecutionRunRefs)
    .where(
      and(
        eq(taskExecutionRunRefs.companyId, input.companyId),
        isNull(taskExecutionRunRefs.protocolSettlementState),
      ),
    );
  const candidateRunIdentities = new Map<string, lifecycle.CompanySessionLifecycleRun>();
  for (const identity of [
    ...attempts.map((attempt) => ({
      companyId: attempt.companyId,
      taskId: attempt.taskId,
      runId: attempt.runId,
    })),
    ...openRunRefs,
  ]) {
    candidateRunIdentities.set(identity.runId, identity);
  }
  const activeRuns: lifecycle.CompanySessionLifecycleRun[] = [];
  for (const identity of [...candidateRunIdentities.values()].sort((left, right) =>
    left.runId.localeCompare(right.runId),
  )) {
    const run = await lockTaskExecutionRunInTransaction(tx, identity);
    if (["queued", "scheduled_retry", "running"].includes(run.status)) {
      activeRuns.push(identity);
    }
  }

  const pendingInserts: Array<typeof taskExecutionCancellationIntents.$inferInsert> = [];
  const attemptSnapshots: lifecycle.LifecycleAttemptSnapshot[] = [];
  for (const attempt of attempts) {
    const run = await lockTaskExecutionRunInTransaction(tx, {
      companyId: attempt.companyId,
      taskId: attempt.taskId,
      runId: attempt.runId,
    });
    if (run.sessionId !== attempt.sessionId || run.kind !== attempt.runKind) {
      throw new TaskSessionLifecycleConflict("Lifecycle cancellation crossed the exact run/attempt scope", {
        runId: run.runId,
        attemptId: attempt.id,
      });
    }
    const lease = leaseByAttempt.get(attempt.id) ?? null;
    if (attempt.state !== "pending" && (!lease || lease.state !== "active")) {
      throw new TaskSessionLifecycleConflict("A leased or running attempt requires its exact active lease", {
        runId: attempt.runId,
        attemptId: attempt.id,
      });
    }
    const existingIntent = intentByAttempt.get(attempt.id) ?? null;
    if (existingIntent && !["requested", "acknowledged"].includes(existingIntent.state)) {
      throw new TaskSessionLifecycleConflict("An active attempt has a terminal cancellation intent", {
        attemptId: attempt.id,
        intentId: existingIntent.id,
      });
    }
    const intentId = existingIntent?.id ?? randomUUID();
    if (!existingIntent) {
      pendingInserts.push({
        id: intentId,
        companyId: attempt.companyId,
        taskId: attempt.taskId,
        runId: attempt.runId,
        attemptId: attempt.id,
        leaseId: lease?.id ?? null,
        reasonKind: "lifecycle",
        ...actor,
        state: "requested",
        requestedAt: input.now,
        createdAt: input.now,
      });
    }
    attemptSnapshots.push({
      intentId,
      companyId: attempt.companyId,
      taskId: attempt.taskId,
      sessionId: attempt.sessionId,
      runId: attempt.runId,
      attemptId: attempt.id,
      leaseId: lease?.id ?? null,
    });
  }

  const previousOperations = await tx
    .select({
      generation: companySessionLifecycleOperations.generation,
    })
    .from(companySessionLifecycleOperations)
    .where(eq(companySessionLifecycleOperations.companyId, input.companyId));
  const generation =
    Math.max(
      company.sessionLifecycleGeneration,
      ...previousOperations.map((operation) => operation.generation),
    ) + 1;
  const initialStatus =
    attemptSnapshots.length > 0
      ? "cancelling"
      : input.operation === "hard_delete"
        ? "purge_ready"
        : activeRuns.length > 0
          ? "fenced"
          : "completed";
  const snapshot: lifecycle.LifecycleGraphSnapshot = {
    version: lifecycle.LIFECYCLE_SNAPSHOT_VERSION,
    sessionIds: sessions.map((session) => session.id),
    taskIds: [...new Set(sessions.map((session) => session.taskId))],
    runs: activeRuns,
    attempts: attemptSnapshots,
  };
  const insertedOperation = await tx
    .insert(companySessionLifecycleOperations)
    .values({
      id: input.lifecycleOperationId,
      companyId: input.companyId,
      generation,
      operation: input.operation,
      status: initialStatus,
      fenceToken: input.fenceToken,
      sessionGraphSnapshot: snapshot,
      requestedByAgentId: input.actor?.requestedByAgentId ?? null,
      requestedByUserId: input.actor?.requestedByUserId ?? null,
      fencedAt: input.now,
      cancellingAt: attemptSnapshots.length ? input.now : null,
      purgeReadyAt: initialStatus === "purge_ready" ? input.now : null,
      completedAt: initialStatus === "completed" ? input.now : null,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning()
    .then((rows) => rows[0]);
  if (!insertedOperation) {
    throw new TaskSessionInvariantError("Company Session lifecycle operation was not persisted");
  }
  if (pendingInserts.length > 0) {
    await tx.insert(taskExecutionCancellationIntents).values(pendingInserts);
  }

  for (const attempt of attemptSnapshots) {
    if (!attempt.leaseId) continue;
    const run = await lockTaskExecutionRunInTransaction(tx, {
      companyId: attempt.companyId,
      taskId: attempt.taskId,
      runId: attempt.runId,
    });
    if (run.cancellationIntentId === attempt.intentId) continue;
    if (
      run.status === "running" &&
      run.currentAttemptId === attempt.attemptId &&
      run.currentLeaseId === attempt.leaseId &&
      run.cancellationIntentId === null
    ) {
      await attachTaskExecutionRunCancellationInTransaction(tx, {
        companyId: attempt.companyId,
        taskId: attempt.taskId,
        runId: attempt.runId,
        expectedAttemptId: attempt.attemptId,
        expectedLeaseId: attempt.leaseId,
        cancellationIntentId: attempt.intentId,
        at: input.now,
      });
      continue;
    }
    if (run.cancellationIntentId !== null) {
      throw new TaskSessionLifecycleConflict(
        "Lifecycle cancellation found another run cancellation pointer",
        { runId: run.runId, cancellationIntentId: run.cancellationIntentId },
      );
    }
  }

  const invalidationReason = input.operation === "hard_delete" ? "company_hard_delete" : "company_archive";
  await tx
    .update(companies)
    .set({
      status: "archived",
      sessionIntegrityState: input.operation === "hard_delete" ? "hard_delete_fenced" : "archive_fenced",
      sessionIntegrityReadyAt: null,
      sessionLifecycleGeneration: generation,
      hardDeleteFencedAt: input.operation === "hard_delete" ? input.now : null,
      updatedAt: input.now,
    })
    .where(eq(companies.id, input.companyId));
  await tx
    .update(taskSessions)
    .set({
      integrityState: input.operation === "hard_delete" ? "purge_fenced" : "archived",
      refAdmittableAt: null,
      timeArchived: input.now,
      purgeFencedAt: input.operation === "hard_delete" ? input.now : null,
      timeUpdated: input.now,
    })
    .where(eq(taskSessions.companyId, input.companyId));
  await tx
    .update(taskExecutionRefs)
    .set({
      disposition: "invalidated",
      invalidationReason,
      updatedAt: input.now,
    })
    .where(
      and(eq(taskExecutionRefs.companyId, input.companyId), eq(taskExecutionRefs.disposition, "active")),
    );
  await tx
    .update(taskSessionInputDispositions)
    .set({
      state: "invalidated",
      invalidationReason,
      invalidatedAt: input.now,
      invalidatedBySourceKind: "company_lifecycle",
      invalidatedBySourceId: input.lifecycleOperationId,
    })
    .where(
      and(
        eq(taskSessionInputDispositions.companyId, input.companyId),
        eq(taskSessionInputDispositions.state, "active"),
      ),
    );
  await tx
    .update(taskExecutionHistoryViews)
    .set({
      state: "invalidated",
      invalidationReason,
      invalidatedAt: input.now,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(taskExecutionHistoryViews.companyId, input.companyId),
        inArray(taskExecutionHistoryViews.state, ["empty", "preparing", "current"]),
      ),
    );
  await tx
    .update(taskExecutionSessions)
    .set({
      state: "superseded",
      supersessionReason: invalidationReason,
      supersededAt: input.now,
    })
    .where(
      and(
        eq(taskExecutionSessions.companyId, input.companyId),
        inArray(taskExecutionSessions.state, [...lifecycle.LIVE_NATIVE_SESSION_STATES]),
      ),
    );
  await tx
    .update(taskExecutionPromptCapabilities)
    .set({
      state: "revoked",
      revocationReason: invalidationReason,
      revokedAt: input.now,
    })
    .where(
      and(
        eq(taskExecutionPromptCapabilities.companyId, input.companyId),
        inArray(taskExecutionPromptCapabilities.state, [...lifecycle.LIVE_CAPABILITY_STATES]),
      ),
    );
  await tx
    .update(taskExecutionLeases)
    .set({ state: "revoked", releasedAt: input.now })
    .where(and(eq(taskExecutionLeases.companyId, input.companyId), eq(taskExecutionLeases.state, "active")));
  await tx
    .update(taskExecutionAttemptRetrySchedules)
    .set({ state: "cancelled", cancelledAt: input.now })
    .where(
      and(
        eq(taskExecutionAttemptRetrySchedules.companyId, input.companyId),
        eq(taskExecutionAttemptRetrySchedules.state, "scheduled"),
      ),
    );
  await tx
    .update(taskConsultExecutions)
    .set({
      state: "cancelled",
      closeReason: invalidationReason,
      closedAt: input.now,
    })
    .where(
      and(eq(taskConsultExecutions.companyId, input.companyId), eq(taskConsultExecutions.state, "active")),
    );

  return {
    operation: insertedOperation,
    intents: await lifecycle.operationIntents(tx, insertedOperation),
    runs: activeRuns,
    created: true,
  };
}

export async function archiveCompanySessionGraphInTx(
  tx: lifecycle.CompanySessionLifecycleTx,
  companyId: string,
  lifecycleOperationId: string,
  options: {
    readonly now?: Date;
    readonly fenceToken?: string;
    readonly actor?: lifecycle.CompanySessionLifecycleActor;
  } = {},
): Promise<lifecycle.CompanySessionLifecycleBeginResult | null> {
  return fenceCompanySessionGraphInTx(tx, {
    companyId,
    lifecycleOperationId,
    operation: "archive",
    now: options.now ?? new Date(),
    fenceToken: options.fenceToken ?? randomUUID(),
    actor: options.actor,
  });
}
