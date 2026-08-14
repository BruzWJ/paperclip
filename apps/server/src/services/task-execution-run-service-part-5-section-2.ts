import { taskExecutionAttempts, taskExecutionLeases, taskExecutionRuns } from "@paperclipai/db";
import { and, eq, isNull } from "drizzle-orm";
import {
  type DetachTaskExecutionRunAttemptInput,
  type TaskExecutionRunEnvelope,
  TaskExecutionRunInvariantViolation,
  assertDate,
  assertExactRunIdentifier,
  assertRunIdentity,
} from "./task-execution-run-service-part-1-section-1.js";
import { projectRunEnvelope } from "./task-execution-run-service-part-2-section-1.js";
import type { TaskSessionDbTransaction } from "./task-session/event-store.js";

export async function detachTaskExecutionRunAttemptInTransaction(
  transaction: TaskSessionDbTransaction,
  input: DetachTaskExecutionRunAttemptInput,
): Promise<TaskExecutionRunEnvelope> {
  assertRunIdentity(input);
  assertExactRunIdentifier(input.expectedAttemptId, "expected attempt id");
  assertExactRunIdentifier(input.expectedLeaseId, "expected lease id");
  assertDate(input.at, "attempt detachment time");
  const attempts = await transaction
    .select({ state: taskExecutionAttempts.state })
    .from(taskExecutionAttempts)
    .where(
      and(
        eq(taskExecutionAttempts.id, input.expectedAttemptId),
        eq(taskExecutionAttempts.companyId, input.companyId),
        eq(taskExecutionAttempts.taskId, input.taskId),
        eq(taskExecutionAttempts.runId, input.runId),
      ),
    )
    .limit(1)
    .for("update");
  const leases = await transaction
    .select({
      attemptId: taskExecutionLeases.attemptId,
      state: taskExecutionLeases.state,
    })
    .from(taskExecutionLeases)
    .where(
      and(
        eq(taskExecutionLeases.id, input.expectedLeaseId),
        eq(taskExecutionLeases.companyId, input.companyId),
        eq(taskExecutionLeases.taskId, input.taskId),
        eq(taskExecutionLeases.runId, input.runId),
      ),
    )
    .limit(1)
    .for("update");
  if (
    !attempts[0] ||
    !leases[0] ||
    !["settled", "failed", "cancelled"].includes(attempts[0].state) ||
    leases[0].attemptId !== input.expectedAttemptId ||
    leases[0].state === "active"
  ) {
    throw new TaskExecutionRunInvariantViolation(
      "run attempt detachment requires its exact terminal attempt and released lease",
    );
  }
  const changed = await transaction
    .update(taskExecutionRuns)
    .set({
      currentAttemptId: null,
      currentLeaseId: null,
      updatedAt: input.at,
    })
    .where(
      and(
        eq(taskExecutionRuns.id, input.runId),
        eq(taskExecutionRuns.companyId, input.companyId),
        eq(taskExecutionRuns.taskId, input.taskId),
        eq(taskExecutionRuns.status, "running"),
        eq(taskExecutionRuns.currentAttemptId, input.expectedAttemptId),
        eq(taskExecutionRuns.currentLeaseId, input.expectedLeaseId),
        isNull(taskExecutionRuns.cancellationIntentId),
        isNull(taskExecutionRuns.terminalFinalizationId),
        isNull(taskExecutionRuns.finishedAt),
      ),
    )
    .returning();
  if (!changed[0]) {
    throw new TaskExecutionRunInvariantViolation("run cannot detach a stale or cancellation-bound attempt");
  }
  return projectRunEnvelope(changed[0]);
}
