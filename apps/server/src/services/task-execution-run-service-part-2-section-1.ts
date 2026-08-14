import {
  taskComments,
  taskExecutionPromptSegments,
  taskExecutionRuns,
  taskSessionEvents,
  type Db,
} from "@paperclipai/db";
import { TASK_EXECUTION_RUN_STATUSES, type TaskExecutionRunStatus } from "@paperclipai/shared";
import { and, asc, eq, gt, isNotNull } from "drizzle-orm";
import { createHash } from "node:crypto";
import {
  type ResumedAgentSteeringLivenessSearch,
  type ResumedAgentSteeringLivenessSource,
  type TaskExecutionRunEnvelope,
  type TaskExecutionRunIdentity,
  RUN_STATUS_FILTER_VALUES,
  TERMINAL_RUN_STATUSES,
  TaskExecutionRunInvariantViolation,
  assertDate,
  assertExactRunIdentifier,
  assertRunIdentity,
} from "./task-execution-run-service-part-1-section-1.js";
import type { TaskSessionDbTransaction } from "./task-session/event-store.js";

export function assertRunStatusFilter(statuses: readonly TaskExecutionRunStatus[] | undefined): void {
  if (statuses === undefined) return;
  if (
    !Array.isArray(statuses) ||
    statuses.length === 0 ||
    statuses.length > TASK_EXECUTION_RUN_STATUSES.length ||
    new Set(statuses).size !== statuses.length ||
    statuses.some((status) => typeof status !== "string" || !RUN_STATUS_FILTER_VALUES.has(status))
  ) {
    throw new TaskExecutionRunInvariantViolation("run status filter must contain unique closed run statuses");
  }
}

export function assertRunEnvelopeInvariant(run: TaskExecutionRunEnvelope): void {
  assertRunIdentity(run);
  for (const [label, value] of [
    ["session id", run.sessionId],
    ["execution scope id", run.executionScopeId],
    ["adapter config revision id", run.adapterConfigRevisionId],
    ["execution workspace binding id", run.executionWorkspaceBindingId],
  ] as const) {
    assertExactRunIdentifier(value, label);
  }
  if (!Number.isSafeInteger(run.ownershipEpoch) || run.ownershipEpoch < 1) {
    throw new TaskExecutionRunInvariantViolation("run ownership epoch must be a positive integer");
  }
  const productiveShape =
    run.kind === "productive" &&
    run.executionMode === "owner" &&
    run.taskExecutionAuthorityId !== null &&
    run.consultExecutionId === null &&
    run.parentRunId === null;
  const consultShape =
    run.kind === "consult" &&
    run.executionMode === "consult" &&
    run.taskExecutionAuthorityId === null &&
    run.consultExecutionId !== null &&
    run.parentRunId !== null;
  if (!productiveShape && !consultShape) {
    throw new TaskExecutionRunInvariantViolation("run kind provenance is not canonical");
  }
  if ((run.currentAttemptId === null) !== (run.currentLeaseId === null)) {
    throw new TaskExecutionRunInvariantViolation("run attempt and lease pointers must be paired");
  }
  if (run.cancellationIntentId !== null && (run.currentAttemptId === null || run.currentLeaseId === null)) {
    throw new TaskExecutionRunInvariantViolation(
      "run cancellation pointer requires the exact current attempt and lease",
    );
  }
  const terminal = TERMINAL_RUN_STATUSES.has(run.status);
  if (
    terminal !==
    (run.finishedAt !== null &&
      run.terminalFinalizationId !== null &&
      run.terminalClassification === run.status &&
      run.terminalReasonCode !== null)
  ) {
    throw new TaskExecutionRunInvariantViolation("run terminal envelope is incomplete");
  }
  if (
    terminal &&
    (run.currentAttemptId !== null || run.currentLeaseId !== null || run.cancellationIntentId !== null)
  ) {
    throw new TaskExecutionRunInvariantViolation("terminal run retains an active control pointer");
  }
  if (
    !terminal &&
    (run.finishedAt !== null ||
      run.terminalFinalizationId !== null ||
      run.terminalClassification !== null ||
      run.terminalReasonCode !== null)
  ) {
    throw new TaskExecutionRunInvariantViolation("active run contains terminal facts");
  }
  if (run.status === "running" && run.startedAt === null) {
    throw new TaskExecutionRunInvariantViolation("running run requires its start time");
  }
  assertDate(run.createdAt, "run creation time");
  assertDate(run.updatedAt, "run update time");
  if (run.updatedAt < run.createdAt) {
    throw new TaskExecutionRunInvariantViolation("run update time predates creation");
  }
}

export function projectRunEnvelope(row: typeof taskExecutionRuns.$inferSelect): TaskExecutionRunEnvelope {
  const run: TaskExecutionRunEnvelope = {
    companyId: row.companyId,
    taskId: row.taskId,
    runId: row.id,
    sessionId: row.sessionId,
    executionScopeId: row.executionScopeId,
    kind: row.kind,
    status: row.status,
    ownershipEpoch: row.ownershipEpoch,
    targetAgentId: row.targetAgentId,
    adapterConfigRevisionId: row.adapterConfigRevisionId,
    executionWorkspaceBindingId: row.executionWorkspaceBindingId,
    executionMode: row.executionMode,
    taskExecutionAuthorityId: row.taskExecutionAuthorityId,
    consultExecutionId: row.consultExecutionId,
    parentRunId: row.parentRunId,
    retryOfRunId: row.retryOfRunId,
    currentAttemptId: row.currentAttemptId,
    currentLeaseId: row.currentLeaseId,
    cancellationIntentId: row.cancellationIntentId,
    terminalFinalizationId: row.terminalFinalizationId,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    terminalClassification: row.terminalClassification,
    terminalReasonCode: row.terminalReasonCode,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  assertRunEnvelopeInvariant(run);
  return run;
}

/**
 * Shared select/join base for the two steering-liveness lookups below. The
 * caller chains its own where/orderBy/limit/for tail.
 */
export function steeringLivenessBaseQuery(transaction: TaskSessionDbTransaction) {
  return transaction
    .select({
      companyId: taskExecutionRuns.companyId,
      taskId: taskExecutionRuns.taskId,
      ownershipEpoch: taskExecutionRuns.ownershipEpoch,
      runId: taskExecutionPromptSegments.runId,
      refId: taskExecutionPromptSegments.refId,
      segmentOrdinal: taskExecutionPromptSegments.segmentOrdinal,
      committedAt: taskExecutionPromptSegments.resumedAt,
    })
    .from(taskExecutionPromptSegments)
    .innerJoin(
      taskExecutionRuns,
      and(
        eq(taskExecutionRuns.companyId, taskExecutionPromptSegments.companyId),
        eq(taskExecutionRuns.taskId, taskExecutionPromptSegments.taskId),
        eq(taskExecutionRuns.id, taskExecutionPromptSegments.runId),
      ),
    )
    .innerJoin(taskComments, eq(taskComments.id, taskExecutionPromptSegments.sourceCommentId))
    .innerJoin(
      taskSessionEvents,
      and(
        eq(taskSessionEvents.companyId, taskComments.companyId),
        eq(taskSessionEvents.taskId, taskComments.taskId),
        eq(taskSessionEvents.sessionId, taskComments.sessionId),
        eq(taskSessionEvents.sourceId, taskComments.canonicalSourceId),
      ),
    )
    .$dynamic();
}

export async function listResumedAgentSteeringLivenessActionsInTransaction(
  transaction: TaskSessionDbTransaction,
  input: ResumedAgentSteeringLivenessSearch,
): Promise<readonly ResumedAgentSteeringLivenessSource[]> {
  assertExactRunIdentifier(input.companyId, "steering liveness company id");
  assertExactRunIdentifier(input.taskId, "steering liveness task id");
  if (!Number.isSafeInteger(input.ownershipEpoch) || input.ownershipEpoch < 1) {
    throw new TaskExecutionRunInvariantViolation("steering liveness ownership epoch must be positive");
  }
  if ("sourceRunId" in input) {
    assertExactRunIdentifier(input.sourceRunId, "steering source run id");
  } else if (!(input.committedAfter instanceof Date) || !Number.isFinite(input.committedAfter.getTime())) {
    throw new TaskExecutionRunInvariantViolation("steering liveness admission time is invalid");
  }
  const rows = await steeringLivenessBaseQuery(transaction)
    .where(
      and(
        eq(taskExecutionPromptSegments.companyId, input.companyId),
        eq(taskExecutionPromptSegments.taskId, input.taskId),
        eq(taskExecutionRuns.ownershipEpoch, input.ownershipEpoch),
        isNotNull(taskExecutionPromptSegments.resumedAt),
        "sourceRunId" in input
          ? eq(taskComments.runId, input.sourceRunId)
          : gt(taskExecutionPromptSegments.resumedAt, input.committedAfter),
        eq(taskComments.authorType, "agent"),
      ),
    )
    .orderBy(
      asc(taskExecutionPromptSegments.resumedAt),
      asc(taskExecutionPromptSegments.runId),
      asc(taskExecutionPromptSegments.segmentOrdinal),
    );
  return Object.freeze(
    rows.flatMap((row) =>
      row.committedAt
        ? [
            Object.freeze({
              companyId: row.companyId,
              taskId: row.taskId,
              ownershipEpoch: row.ownershipEpoch,
              runId: row.runId,
              refId: row.refId,
              segmentOrdinal: row.segmentOrdinal,
              committedAt: row.committedAt,
            }),
          ]
        : [],
    ),
  );
}

/**
 * Stable text-free digest of the exact locked batch. Only immutable identities
 * and admission order/version participate; prompt bytes never do.
 */
export function computeTaskExecutionRunBatchDigest(
  members: readonly {
    readonly refId: string;
    readonly messageKind: "user" | "synthetic";
    readonly sourceMessageId: string;
    readonly admissionOrder: number;
    readonly admissionVersion: number;
  }[],
): string {
  if (members.length === 0) {
    throw new TaskExecutionRunInvariantViolation("productive and consult runs require a non-empty ref batch");
  }
  const hash = createHash("sha256");
  hash.update("paperclip.task-execution-run-batch/v2\n", "utf8");
  const seen = new Set<string>();
  let previousAdmissionOrder = -1;
  members.forEach((member, refOrdinal) => {
    assertExactRunIdentifier(member.refId, "run ref id");
    assertExactRunIdentifier(member.sourceMessageId, "run ref source message id");
    if (member.messageKind !== "user" && member.messageKind !== "synthetic") {
      throw new TaskExecutionRunInvariantViolation("run ref batch contains an invalid source message kind");
    }
    if (seen.has(member.refId)) {
      throw new TaskExecutionRunInvariantViolation("run ref batch contains a duplicate identity");
    }
    seen.add(member.refId);
    if (
      !Number.isSafeInteger(member.admissionOrder) ||
      member.admissionOrder < 0 ||
      member.admissionOrder <= previousAdmissionOrder ||
      !Number.isSafeInteger(member.admissionVersion) ||
      member.admissionVersion < 0
    ) {
      throw new TaskExecutionRunInvariantViolation("run ref batch admission order/version is invalid");
    }
    previousAdmissionOrder = member.admissionOrder;
    hash.update(
      `${refOrdinal}\0${member.refId}\0${member.messageKind}\0${member.sourceMessageId}\0${member.admissionOrder}\0${member.admissionVersion}\n`,
      "utf8",
    );
  });
  return hash.digest("hex");
}

export async function selectExactRunRow(
  database: Db | TaskSessionDbTransaction,
  input: TaskExecutionRunIdentity,
  lock: boolean,
): Promise<typeof taskExecutionRuns.$inferSelect | null> {
  assertRunIdentity(input);
  const base = database
    .select()
    .from(taskExecutionRuns)
    .where(
      and(
        eq(taskExecutionRuns.id, input.runId),
        eq(taskExecutionRuns.companyId, input.companyId),
        eq(taskExecutionRuns.taskId, input.taskId),
      ),
    )
    .limit(1);
  const rows = lock ? await base.for("update") : await base;
  return rows[0] ?? null;
}

export async function readTaskExecutionRun(
  database: Db | TaskSessionDbTransaction,
  input: TaskExecutionRunIdentity,
): Promise<TaskExecutionRunEnvelope | null> {
  const row = await selectExactRunRow(database, input, false);
  return row ? projectRunEnvelope(row) : null;
}
