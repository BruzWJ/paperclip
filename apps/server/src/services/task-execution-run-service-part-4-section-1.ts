import {
  taskExecutionAttemptRetrySchedules,
  taskExecutionAttempts,
  taskExecutionLeases,
  taskExecutionPromptCapabilities,
  taskExecutionRefs,
  taskExecutionRunControls,
  taskExecutionRunRefs,
  taskExecutionRuns,
  type Db,
} from "@paperclipai/db";
import { and, eq, inArray } from "drizzle-orm";
import * as runContracts from "./task-execution-run-service-part-1-section-1.js";
import { projectRunEnvelope } from "./task-execution-run-service-part-2-section-1.js";
import type { TaskSessionDbTransaction } from "./task-session/event-store.js";

/** One joined current-attempt/lease/control snapshot for lease validation. */
export async function readTaskExecutionLeaseBinding(
  database: Db,
  input: runContracts.TaskExecutionRunIdentity & {
    readonly attemptId: string;
    readonly leaseId: string;
  },
): Promise<runContracts.TaskExecutionLeaseBinding | null> {
  runContracts.assertRunIdentity(input);
  runContracts.assertExactRunIdentifier(input.attemptId, "attempt id");
  runContracts.assertExactRunIdentifier(input.leaseId, "lease id");
  const rows = await database
    .select({
      run: taskExecutionRuns,
      attemptState: taskExecutionAttempts.state,
      leaseState: taskExecutionLeases.state,
      leaseGeneration: taskExecutionLeases.leaseGeneration,
      leaseExpiresAt: taskExecutionLeases.expiresAt,
      currentRefId: taskExecutionRunControls.currentRefId,
    })
    .from(taskExecutionRuns)
    .innerJoin(
      taskExecutionAttempts,
      and(
        eq(taskExecutionAttempts.id, input.attemptId),
        eq(taskExecutionAttempts.runId, taskExecutionRuns.id),
      ),
    )
    .innerJoin(
      taskExecutionLeases,
      and(
        eq(taskExecutionLeases.id, input.leaseId),
        eq(taskExecutionLeases.runId, taskExecutionRuns.id),
        eq(taskExecutionLeases.attemptId, taskExecutionAttempts.id),
      ),
    )
    .innerJoin(taskExecutionRunControls, eq(taskExecutionRunControls.runId, taskExecutionRuns.id))
    .where(
      and(
        eq(taskExecutionRuns.id, input.runId),
        eq(taskExecutionRuns.companyId, input.companyId),
        eq(taskExecutionRuns.taskId, input.taskId),
      ),
    )
    .limit(2);
  if (rows.length > 1) {
    throw new runContracts.TaskExecutionRunInvariantViolation(
      "attempt lease resolved more than one run binding",
    );
  }
  const row = rows[0];
  return row
    ? {
        run: projectRunEnvelope(row.run),
        attemptState: row.attemptState,
        leaseState: row.leaseState,
        leaseGeneration: row.leaseGeneration,
        leaseExpiresAt: row.leaseExpiresAt,
        currentRefId: row.currentRefId,
      }
    : null;
}

/**
 * Active memberships that cannot be leased now. A ref omitted from this set
 * either has no active run or is the current detached/due prompt of one.
 */
export async function readBlockedActiveTaskExecutionRefIds(
  database: Db,
  input: { readonly now: Date },
): Promise<readonly string[]> {
  runContracts.assertDate(input.now, "dispatch discovery time");
  const rows = await database
    .select({
      refId: taskExecutionRunRefs.refId,
      status: taskExecutionRuns.status,
      currentAttemptId: taskExecutionRuns.currentAttemptId,
      currentLeaseId: taskExecutionRuns.currentLeaseId,
      cancellationIntentId: taskExecutionRuns.cancellationIntentId,
      currentRefId: taskExecutionRunControls.currentRefId,
      leaseExpiresAt: taskExecutionLeases.expiresAt,
      retryAt: taskExecutionAttemptRetrySchedules.retryAt,
    })
    .from(taskExecutionRunRefs)
    .innerJoin(
      taskExecutionRuns,
      and(
        eq(taskExecutionRuns.id, taskExecutionRunRefs.runId),
        eq(taskExecutionRuns.companyId, taskExecutionRunRefs.companyId),
        eq(taskExecutionRuns.taskId, taskExecutionRunRefs.taskId),
      ),
    )
    .innerJoin(taskExecutionRunControls, eq(taskExecutionRunControls.runId, taskExecutionRuns.id))
    .leftJoin(taskExecutionLeases, eq(taskExecutionLeases.id, taskExecutionRuns.currentLeaseId))
    .leftJoin(
      taskExecutionAttemptRetrySchedules,
      and(
        eq(taskExecutionAttemptRetrySchedules.runId, taskExecutionRuns.id),
        eq(taskExecutionAttemptRetrySchedules.state, "scheduled"),
      ),
    )
    .where(inArray(taskExecutionRuns.status, ["queued", "running", "scheduled_retry"]));
  const blocked = new Set<string>();
  for (const row of rows) {
    const detached =
      row.currentAttemptId === null && row.currentLeaseId === null && row.cancellationIntentId === null;
    const expired =
      row.currentAttemptId !== null &&
      row.currentLeaseId !== null &&
      row.cancellationIntentId === null &&
      row.leaseExpiresAt !== null &&
      row.leaseExpiresAt <= input.now;
    const due =
      row.status === "queued" ||
      row.status === "running" ||
      (row.status === "scheduled_retry" && row.retryAt !== null && row.retryAt <= input.now);
    if (row.currentRefId !== row.refId || (!detached && !expired) || !due) {
      blocked.add(row.refId);
    }
  }
  return Object.freeze([...blocked]);
}

/**
 * Revoke prompt capabilities through the run owner when a session boundary
 * moves or reverts. Projectors never join the run root themselves.
 */
export async function revokeTaskExecutionPromptCapabilitiesForSessionInTransaction(
  transaction: TaskSessionDbTransaction,
  input: {
    readonly companyId: string;
    readonly taskId: string;
    readonly sessionId: string;
    readonly reason: "session_moved" | "session_revert";
    readonly at: Date;
  },
): Promise<readonly string[]> {
  for (const [label, value] of [
    ["company id", input.companyId],
    ["task id", input.taskId],
    ["session id", input.sessionId],
  ] as const) {
    runContracts.assertExactRunIdentifier(value, label);
  }
  runContracts.assertDate(input.at, "prompt capability revocation time");
  const runRows = await transaction
    .select({ runId: taskExecutionRuns.id })
    .from(taskExecutionRuns)
    .where(
      and(
        eq(taskExecutionRuns.companyId, input.companyId),
        eq(taskExecutionRuns.taskId, input.taskId),
        eq(taskExecutionRuns.sessionId, input.sessionId),
      ),
    );
  const runIds = runRows.map((row) => row.runId);
  if (runIds.length === 0) return Object.freeze([]);

  const revertedRefIds =
    input.reason === "session_revert"
      ? await transaction
          .select({ refId: taskExecutionRefs.id })
          .from(taskExecutionRefs)
          .where(
            and(
              eq(taskExecutionRefs.companyId, input.companyId),
              eq(taskExecutionRefs.taskId, input.taskId),
              eq(taskExecutionRefs.sessionId, input.sessionId),
              eq(taskExecutionRefs.disposition, "invalidated"),
              eq(taskExecutionRefs.invalidationReason, "session_revert"),
            ),
          )
          .then((rows) => rows.map((row) => row.refId))
      : null;
  if (revertedRefIds !== null && revertedRefIds.length === 0) {
    return Object.freeze([]);
  }
  const revoked = await transaction
    .update(taskExecutionPromptCapabilities)
    .set({
      state: "revoked",
      revocationReason: input.reason,
      revokedAt: input.at,
    })
    .where(
      and(
        eq(taskExecutionPromptCapabilities.companyId, input.companyId),
        eq(taskExecutionPromptCapabilities.taskId, input.taskId),
        inArray(taskExecutionPromptCapabilities.runId, runIds),
        inArray(taskExecutionPromptCapabilities.state, ["pending_setup", "active"]),
        revertedRefIds === null ? undefined : inArray(taskExecutionPromptCapabilities.refId, revertedRefIds),
      ),
    )
    .returning({
      capabilityConnectionId: taskExecutionPromptCapabilities.capabilityConnectionId,
    });
  return Object.freeze([...new Set(revoked.map((row) => row.capabilityConnectionId))]);
}

/**
 * Sole company-scoped deletion owner for the canonical run roots. The
 * lifecycle caller must first fence dispatch, settle every attempt, and
 * remove the typed run-child owners; remaining restrictors fail the enclosing
 * transaction instead of being bypassed here.
 */
export async function purgeCompanyTaskExecutionRunsInTransaction(
  transaction: TaskSessionDbTransaction,
  input: runContracts.PurgeCompanyTaskExecutionRunsInput,
): Promise<runContracts.PurgedCompanyTaskExecutionRuns> {
  runContracts.assertExactRunIdentifier(input.companyId, "company id");
  const deleted = await transaction
    .delete(taskExecutionRuns)
    .where(eq(taskExecutionRuns.companyId, input.companyId))
    .returning({ runId: taskExecutionRuns.id });
  return {
    companyId: input.companyId,
    deletedRunCount: deleted.length,
  };
}

export function assertCreationInput(input: runContracts.CreateTaskExecutionRunInput): void {
  for (const [label, value] of [
    ["company id", input.companyId],
    ["task id", input.taskId],
    ["session id", input.sessionId],
    ["execution scope id", input.executionScopeId],
    ["adapter config revision id", input.adapterConfigRevisionId],
    ["execution workspace binding id", input.executionWorkspaceBindingId],
  ] as const) {
    runContracts.assertExactRunIdentifier(value, label);
  }
  runContracts.assertDate(input.at, "run creation time");
  if (!Number.isSafeInteger(input.ownershipEpoch) || input.ownershipEpoch < 1) {
    throw new runContracts.TaskExecutionRunInvariantViolation(
      "run ownership epoch must be a positive integer",
    );
  }
  if (input.retryOfRunId) {
    runContracts.assertExactRunIdentifier(input.retryOfRunId, "retry run id");
  }
  runContracts.assertExactRunIdentifier(input.targetAgentId, "target agent id");
  if (input.kind === "productive") {
    runContracts.assertExactRunIdentifier(input.taskExecutionAuthorityId, "task execution authority id");
  } else {
    runContracts.assertExactRunIdentifier(input.consultExecutionId, "consult execution id");
    runContracts.assertExactRunIdentifier(input.parentRunId, "consult parent run id");
  }
  if (input.orderedRefIds.length === 0) {
    throw new runContracts.TaskExecutionRunInvariantViolation(
      "productive and consult runs require a non-empty ref batch",
    );
  }
  const seen = new Set<string>();
  for (const refId of input.orderedRefIds) {
    runContracts.assertExactRunIdentifier(refId, "run ref id");
    if (seen.has(refId)) {
      throw new runContracts.TaskExecutionRunInvariantViolation(
        "run ref batch contains a duplicate identity",
      );
    }
    seen.add(refId);
  }
}

export function assertRelatedRunScope(
  related: runContracts.TaskExecutionRunEnvelope,
  input: runContracts.CreateTaskExecutionRunInput,
  relation: "parent" | "retry",
): void {
  const sameTaskEpoch =
    related.companyId === input.companyId &&
    related.taskId === input.taskId &&
    related.sessionId === input.sessionId &&
    related.ownershipEpoch === input.ownershipEpoch;
  if (!sameTaskEpoch) {
    throw new runContracts.TaskExecutionRunInvariantViolation(
      `${relation} run does not belong to the exact task session epoch`,
    );
  }
  if (relation === "retry") {
    const sameBranch =
      input.kind === "productive"
        ? related.taskExecutionAuthorityId === input.taskExecutionAuthorityId &&
          related.consultExecutionId === null &&
          related.parentRunId === null
        : related.taskExecutionAuthorityId === null &&
          related.consultExecutionId === input.consultExecutionId &&
          related.parentRunId === input.parentRunId;
    if (
      related.executionScopeId !== input.executionScopeId ||
      related.adapterConfigRevisionId !== input.adapterConfigRevisionId ||
      related.executionWorkspaceBindingId !== input.executionWorkspaceBindingId ||
      related.kind !== input.kind ||
      related.targetAgentId !== input.targetAgentId ||
      related.executionMode !== (input.kind === "productive" ? "owner" : "consult") ||
      !sameBranch ||
      !runContracts.TERMINAL_RUN_STATUSES.has(related.status)
    ) {
      throw new runContracts.TaskExecutionRunInvariantViolation(
        "retry run is not a terminal run of the exact same kind and scope",
      );
    }
    return;
  }
  if (
    (related.kind !== "productive" && related.kind !== "consult") ||
    runContracts.TERMINAL_RUN_STATUSES.has(related.status)
  ) {
    throw new runContracts.TaskExecutionRunInvariantViolation(
      `${relation} run must be an active productive or consult run`,
    );
  }
}
