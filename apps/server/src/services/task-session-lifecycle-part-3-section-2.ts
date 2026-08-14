import {
  taskExecutionAttempts,
  taskExecutionCancellationIntents,
  taskExecutionLeases,
  taskExecutionPromptCapabilities,
} from "@paperclipai/db";
import { and, eq, sql } from "drizzle-orm";
import {
  detachTaskExecutionRunAttemptInTransaction,
  detachTaskExecutionRunCancellationInTransaction,
  lockTaskExecutionRunInTransaction,
} from "./task-execution-run-service.js";
import {
  type CompanySessionLifecycleTx,
  type PostgresCancellationIntent,
  type PostgresLifecycleOperation,
  ACTIVE_ATTEMPT_STATES,
  activeOperationForIntent,
  lockCompanySessionLifecycle,
} from "./task-session-lifecycle-part-1.js";
import { TaskSessionInvariantError, TaskSessionLifecycleConflict } from "./task-session/store.js";

export async function reconcileCompanyCancellationIntentInTx(
  tx: CompanySessionLifecycleTx,
  input: {
    readonly intentId: string;
    readonly now?: Date;
  },
): Promise<{
  readonly intent: PostgresCancellationIntent;
  readonly operation: PostgresLifecycleOperation | null;
} | null> {
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
  await lockCompanySessionLifecycle(tx, initial.companyId);
  const intent = await tx
    .select()
    .from(taskExecutionCancellationIntents)
    .where(eq(taskExecutionCancellationIntents.id, input.intentId))
    .limit(1)
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (!intent) {
    throw new TaskSessionInvariantError(`Cancellation intent ${input.intentId} disappeared while locking`);
  }
  if (intent.state === "completed") {
    return {
      intent,
      operation: await activeOperationForIntent(tx, intent),
    };
  }
  if (intent.state !== "acknowledged") {
    throw new TaskSessionLifecycleConflict("Cancellation completion requires an acknowledged intent", {
      intentId: intent.id,
      state: intent.state,
    });
  }
  const run = await lockTaskExecutionRunInTransaction(tx, {
    companyId: intent.companyId,
    taskId: intent.taskId,
    runId: intent.runId,
  });
  const attempt = await tx
    .select()
    .from(taskExecutionAttempts)
    .where(
      and(
        eq(taskExecutionAttempts.id, intent.attemptId),
        eq(taskExecutionAttempts.companyId, intent.companyId),
        eq(taskExecutionAttempts.taskId, intent.taskId),
        eq(taskExecutionAttempts.runId, intent.runId),
      ),
    )
    .limit(1)
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (!attempt) {
    throw new TaskSessionInvariantError(`Cancellation intent ${intent.id} lost attempt ${intent.attemptId}`);
  }
  if (attempt.state === "running" && intent.nativeCancellationSettledAt === null) {
    if (
      !intent.leaseId ||
      run.status !== "running" ||
      run.cancellationIntentId !== intent.id ||
      run.currentAttemptId !== intent.attemptId ||
      run.currentLeaseId !== intent.leaseId
    ) {
      throw new TaskSessionLifecycleConflict("Cancellation crossed the current run authority", {
        intentId: intent.id,
        runId: intent.runId,
      });
    }
    const lease = await tx
      .select({
        id: taskExecutionLeases.id,
        state: taskExecutionLeases.state,
        expiredAtDatabaseClock: sql<boolean>`${taskExecutionLeases.expiresAt} <= clock_timestamp()`,
      })
      .from(taskExecutionLeases)
      .where(
        and(
          eq(taskExecutionLeases.id, intent.leaseId),
          eq(taskExecutionLeases.companyId, intent.companyId),
          eq(taskExecutionLeases.taskId, intent.taskId),
          eq(taskExecutionLeases.runId, intent.runId),
          eq(taskExecutionLeases.attemptId, intent.attemptId),
        ),
      )
      .limit(1)
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!lease) {
      throw new TaskSessionInvariantError(`Cancellation intent ${intent.id} lost lease ${intent.leaseId}`);
    }
    if (lease.state !== "active") {
      throw new TaskSessionLifecycleConflict("Cancellation lease is no longer active", {
        intentId: intent.id,
        leaseId: lease.id,
      });
    }
    if (!lease.expiredAtDatabaseClock) return null;
    const capability = await tx
      .select({
        capabilityConnectionId: taskExecutionPromptCapabilities.capabilityConnectionId,
      })
      .from(taskExecutionPromptCapabilities)
      .where(
        and(
          eq(taskExecutionPromptCapabilities.companyId, intent.companyId),
          eq(taskExecutionPromptCapabilities.taskId, intent.taskId),
          eq(taskExecutionPromptCapabilities.runId, intent.runId),
          eq(taskExecutionPromptCapabilities.attemptId, intent.attemptId),
          eq(taskExecutionPromptCapabilities.leaseId, intent.leaseId),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    // Capability mint owns this same run lock and precedes every ACPX call.
    if (capability) return null;
  }
  if (intent.leaseId) {
    await tx
      .update(taskExecutionLeases)
      .set({ state: "revoked", releasedAt: now })
      .where(
        and(
          eq(taskExecutionLeases.id, intent.leaseId),
          eq(taskExecutionLeases.attemptId, intent.attemptId),
          eq(taskExecutionLeases.state, "active"),
        ),
      );
  }
  if (ACTIVE_ATTEMPT_STATES.includes(attempt.state as (typeof ACTIVE_ATTEMPT_STATES)[number])) {
    await tx
      .update(taskExecutionAttempts)
      .set({ state: "cancelled", finishedAt: now })
      .where(eq(taskExecutionAttempts.id, attempt.id));
  }
  const completed = await tx
    .update(taskExecutionCancellationIntents)
    .set({
      state: "completed",
      completedAt: now,
      failedAt: null,
      failureCode: null,
    })
    .where(eq(taskExecutionCancellationIntents.id, intent.id))
    .returning()
    .then((rows) => rows[0]);
  if (!completed) {
    throw new TaskSessionInvariantError(`Cancellation intent ${intent.id} was not completed`);
  }

  const detachedRun =
    run.cancellationIntentId === intent.id
      ? await detachTaskExecutionRunCancellationInTransaction(tx, {
          companyId: intent.companyId,
          taskId: intent.taskId,
          runId: intent.runId,
          expectedCancellationIntentId: intent.id,
          at: now,
        })
      : run;
  if (run.cancellationIntentId !== null && run.cancellationIntentId !== intent.id) {
    throw new TaskSessionLifecycleConflict(
      "Cancellation completion crossed another run cancellation pointer",
      { runId: run.runId, cancellationIntentId: run.cancellationIntentId },
    );
  }
  if (
    intent.leaseId &&
    detachedRun.currentAttemptId === intent.attemptId &&
    detachedRun.currentLeaseId === intent.leaseId
  ) {
    await detachTaskExecutionRunAttemptInTransaction(tx, {
      companyId: intent.companyId,
      taskId: intent.taskId,
      runId: intent.runId,
      expectedAttemptId: intent.attemptId,
      expectedLeaseId: intent.leaseId,
      at: now,
    });
  } else if (
    detachedRun.currentAttemptId === intent.attemptId ||
    detachedRun.currentLeaseId === intent.leaseId
  ) {
    throw new TaskSessionLifecycleConflict("Cancellation completion found a partial run attempt pointer", {
      runId: detachedRun.runId,
      attemptId: intent.attemptId,
    });
  }

  return {
    intent: completed,
    operation: await activeOperationForIntent(tx, completed),
  };
}
