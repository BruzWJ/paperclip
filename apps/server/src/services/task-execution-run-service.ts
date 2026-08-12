import type {
  TaskExecutionAttemptCancellationSignal,
  TaskExecutionTargetLaneIdentity,
} from "./task-execution-dispatcher.js";
import { createHash } from "node:crypto";
import {
  acpPromptAccounting,
  activityLog,
  agentAdapterConfigRevisions,
  agents,
  costEvents,
  taskExecutionAttempts,
  taskExecutionAttemptRetrySchedules,
  taskExecutionAuthorities,
  taskExecutionCancellationIntents,
  taskExecutionFinalizationPromptDependencies,
  taskExecutionFinalizationUpdateDependencies,
  taskExecutionFinalizations,
  taskExecutionLeases,
  taskExecutionPromptCapabilities,
  taskExecutionPromptSegments,
  taskExecutionRefs,
  taskExecutionRunControls,
  taskExecutionRunLivenessFacts,
  taskExecutionRunRefs,
  taskExecutionRuns,
  taskExecutionWorkspaceBindings,
  taskComments,
  taskCommentProjectionSources,
  taskSessionEvents,
  tasks,
  type Db,
  type TaskExecutionAttempt,
  type TaskExecutionAttemptRetrySchedule,
  type TaskExecutionCancellationIntent,
  type TaskExecutionFinalization,
  type TaskExecutionFinalizationPromptDependency,
  type TaskExecutionFinalizationUpdateDependency,
  type TaskExecutionLease,
  type TaskExecutionPromptSegment,
  type TaskExecutionRunControl,
  type TaskExecutionRunLivenessFactRow,
  type TaskExecutionRunRef,
} from "@paperclipai/db";
import {
  isCanonicalUuid,
  TASK_EXECUTION_RUN_STATUSES,
  type TaskExecutionRunKind,
  type TaskExecutionRunStatus,
  type TaskExecutionRunTerminalClassification,
} from "@paperclipai/shared";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";
import type { TaskSessionDbTransaction } from "./task-session/event-store.js";
import { redactTaskSessionPublicationValue } from "./task-session/publication.js";
import type {
  TaskSessionReadProjection,
  TaskSessionStore,
} from "./task-session/store.js";
import type {
  TaskExecutionSteeringResult,
  TaskExecutionSteeringResultBroker,
} from "./task-execution-steering-results.js";
import { isTaskExecutionRefDeliveryEligible } from "./task-execution-ref-delivery.js";

export interface TaskExecutionRunIdentity {
  readonly companyId: string;
  readonly taskId: string;
  readonly runId: string;
}

/**
 * Exact persisted run/runtime scope used by initialize-only readiness. The run
 * service owns this projection so no consumer can read the canonical run table
 * through a parallel query path.
 */
export interface TaskExecutionRuntimeReadinessBinding extends TaskExecutionRunIdentity {
  readonly runKind: TaskExecutionRunKind;
  readonly runStatus: TaskExecutionRunStatus;
  readonly agentId: string;
  readonly currentAdapterConfigRevisionId: string | null;
  readonly adapterConfigRevisionId: string;
  readonly executionWorkspaceBindingId: string;
  readonly absoluteCwd: string | null;
  readonly acpConfiguration: unknown;
}

export interface ResumedAgentSteeringLivenessSource {
  readonly companyId: string;
  readonly taskId: string;
  readonly ownershipEpoch: number;
  readonly runId: string;
  readonly refId: string;
  readonly segmentOrdinal: number;
  readonly committedAt: Date;
}

export type ResumedAgentSteeringLivenessSearch =
  | {
      readonly companyId: string;
      readonly taskId: string;
      readonly ownershipEpoch: number;
      readonly sourceRunId: string;
    }
  | {
      readonly companyId: string;
      readonly taskId: string;
      readonly ownershipEpoch: number;
      readonly committedAfter: Date;
    };

export interface PurgeCompanyTaskExecutionRunsInput {
  readonly companyId: string;
}

export interface PurgedCompanyTaskExecutionRuns {
  readonly companyId: string;
  readonly deletedRunCount: number;
}

/**
 * The exact active productive/consult envelope exposed to steering. Prompt
 * membership and settlement remain in their dedicated run-ref/control rows.
 */
export interface SteerableTaskExecutionRun extends TaskExecutionRunIdentity {
  readonly sessionId: string;
  readonly executionScopeId: string;
  readonly kind: "productive" | "consult";
  readonly status: "running";
  readonly ownershipEpoch: number;
  readonly targetAgentId: string;
  readonly adapterConfigRevisionId: string;
  readonly executionWorkspaceBindingId: string;
  readonly executionMode: "owner" | "consult";
  readonly taskExecutionAuthorityId: string | null;
  readonly consultExecutionId: string | null;
  readonly currentAttemptId: string;
  readonly currentLeaseId: string;
  readonly cancellationIntentId: string | null;
  readonly terminalFinalizationId: null;
  readonly startedAt: Date;
  readonly finishedAt: null;
}

export interface ReboundSteerableTaskExecutionRun extends Omit<
  SteerableTaskExecutionRun,
  "currentAttemptId" | "currentLeaseId" | "cancellationIntentId"
> {
  readonly currentAttemptId: null;
  readonly currentLeaseId: null;
  readonly cancellationIntentId: null;
}

export class TaskExecutionRunInvariantViolation extends Error {
  readonly code = "task_execution_run_invariant_violation";

  constructor(message: string) {
    super(message);
    this.name = "TaskExecutionRunInvariantViolation";
  }
}

/**
 * The closed run-envelope projection. It deliberately contains no prompt,
 * transcript, result, usage, settlement, activity, or workspace-operation
 * payload; those facts remain in their typed owners below the joined reader.
 */
export interface TaskExecutionRunEnvelope extends TaskExecutionRunIdentity {
  readonly sessionId: string;
  readonly executionScopeId: string;
  readonly kind: TaskExecutionRunKind;
  readonly status: TaskExecutionRunStatus;
  readonly ownershipEpoch: number;
  readonly targetAgentId: string;
  readonly adapterConfigRevisionId: string;
  readonly executionWorkspaceBindingId: string;
  readonly executionMode: "owner" | "consult";
  readonly taskExecutionAuthorityId: string | null;
  readonly consultExecutionId: string | null;
  readonly parentRunId: string | null;
  readonly retryOfRunId: string | null;
  readonly currentAttemptId: string | null;
  readonly currentLeaseId: string | null;
  readonly cancellationIntentId: string | null;
  readonly terminalFinalizationId: string | null;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
  readonly terminalClassification: TaskExecutionRunTerminalClassification | null;
  readonly terminalReasonCode: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface CreateTaskExecutionRunCommon {
  readonly companyId: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly executionScopeId: string;
  readonly ownershipEpoch: number;
  readonly adapterConfigRevisionId: string;
  readonly executionWorkspaceBindingId: string;
  readonly retryOfRunId?: string | null;
  readonly at: Date;
}

export type CreateTaskExecutionRunInput =
  | (CreateTaskExecutionRunCommon & {
      readonly kind: "productive";
      readonly targetAgentId: string;
      readonly taskExecutionAuthorityId: string;
      readonly orderedRefIds: readonly string[];
    })
  | (CreateTaskExecutionRunCommon & {
      readonly kind: "consult";
      readonly targetAgentId: string;
      readonly consultExecutionId: string;
      readonly parentRunId: string;
      readonly orderedRefIds: readonly string[];
    });

export interface CreatedTaskExecutionRun {
  readonly run: TaskExecutionRunEnvelope;
  readonly refs: readonly TaskExecutionRunRef[];
  readonly batchDigest: string | null;
}

export type TransitionTaskExecutionRunStatusInput =
  | (TaskExecutionRunIdentity & {
      readonly expectedStatus: "queued" | "scheduled_retry";
      readonly status: "running";
      readonly startedAt: Date;
      readonly at: Date;
    })
  | (TaskExecutionRunIdentity & {
      readonly expectedStatus: "queued" | "running";
      readonly status: "scheduled_retry";
      readonly at: Date;
    })
  | (TaskExecutionRunIdentity & {
      readonly expectedStatus: "scheduled_retry";
      readonly status: "queued";
      readonly at: Date;
    });

export interface AttachTaskExecutionRunAttemptInput extends TaskExecutionRunIdentity {
  readonly attemptId: string;
  readonly leaseId: string;
  readonly at: Date;
}

export interface DetachTaskExecutionRunAttemptInput extends TaskExecutionRunIdentity {
  readonly expectedAttemptId: string;
  readonly expectedLeaseId: string;
  readonly at: Date;
}

export interface AttachTaskExecutionRunCancellationInput extends TaskExecutionRunIdentity {
  readonly expectedAttemptId: string;
  readonly expectedLeaseId: string;
  readonly cancellationIntentId: string;
  readonly at: Date;
}

export interface DetachTaskExecutionRunCancellationInput extends TaskExecutionRunIdentity {
  readonly expectedCancellationIntentId: string;
  readonly at: Date;
}

/** Finalization attachment and the terminal lifecycle transition are atomic. */
export interface AttachTaskExecutionRunFinalizationInput extends TaskExecutionRunIdentity {
  readonly expectedStatus: "queued" | "scheduled_retry" | "running";
  readonly finalizationId: string;
  readonly status: TaskExecutionRunTerminalClassification;
  readonly terminalReasonCode: string;
  readonly finishedAt: Date;
  readonly at: Date;
}

export interface TaskExecutionRunListCursor {
  /** Exact PostgreSQL timestamptz text; JavaScript Date loses microseconds. */
  readonly createdAt: string;
  readonly runId: string;
}

export interface TaskExecutionRunListPage {
  readonly items: readonly TaskExecutionRunEnvelope[];
  readonly nextCursor: TaskExecutionRunListCursor | null;
}

export interface BoundedTaskExecutionRunRecords<T> {
  readonly items: readonly T[];
  readonly truncated: boolean;
  readonly nextCursor?: string | null;
}

export interface RedactedTaskExecutionSessionEvent {
  readonly id: string;
  readonly seq: number;
  readonly type: string;
  readonly data: Record<string, unknown>;
  readonly createdAt: Date;
}

export interface RedactedTaskExecutionSessionMessage {
  readonly id: string;
  readonly seq: number;
  readonly modelStateSeq: number;
  readonly type:
    | "agent-switched"
    | "model-switched"
    | "user"
    | "synthetic"
    | "system"
    | "shell"
    | "assistant";
  readonly data: Record<string, unknown>;
  readonly timeCreated: Date;
  readonly timeUpdated: Date;
}

export interface RedactedTaskExecutionActivity {
  readonly id: string;
  readonly actorType: string;
  readonly actorId: string;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly agentId: string | null;
  readonly responsibleUserId: string | null;
  readonly details: Record<string, unknown> | null;
  readonly createdAt: Date;
}

export interface TaskExecutionRunOutputCommentLink {
  readonly commentId: string;
  readonly messageId: string;
  readonly sourceKind: "run_output" | "run_progress" | "task_update";
  readonly projectedEventSeq: number;
}

export interface TaskExecutionJoinedFinalization {
  readonly record: TaskExecutionFinalization;
  readonly promptDependencies: BoundedTaskExecutionRunRecords<TaskExecutionFinalizationPromptDependency>;
  readonly updateDependencies: BoundedTaskExecutionRunRecords<TaskExecutionFinalizationUpdateDependency>;
  readonly liveness: TaskExecutionRunLivenessFactRow | null;
}

export interface JoinedTaskExecutionRunDetail {
  readonly run: TaskExecutionRunEnvelope;
  readonly control: TaskExecutionRunControl | null;
  readonly refs: BoundedTaskExecutionRunRecords<TaskExecutionRunRef>;
  readonly segments: BoundedTaskExecutionRunRecords<TaskExecutionPromptSegment>;
  readonly sessionEvents: BoundedTaskExecutionRunRecords<RedactedTaskExecutionSessionEvent>;
  readonly sessionMessages: BoundedTaskExecutionRunRecords<RedactedTaskExecutionSessionMessage>;
  readonly attempts: BoundedTaskExecutionRunRecords<TaskExecutionAttempt>;
  readonly retrySchedules: BoundedTaskExecutionRunRecords<TaskExecutionAttemptRetrySchedule>;
  readonly leases: BoundedTaskExecutionRunRecords<TaskExecutionLease>;
  readonly cancellations: BoundedTaskExecutionRunRecords<TaskExecutionCancellationIntent>;
  readonly accounting: BoundedTaskExecutionRunRecords<
    typeof acpPromptAccounting.$inferSelect
  >;
  readonly costs: BoundedTaskExecutionRunRecords<
    typeof costEvents.$inferSelect
  >;
  readonly activity: BoundedTaskExecutionRunRecords<RedactedTaskExecutionActivity>;
  readonly outputComments: BoundedTaskExecutionRunRecords<TaskExecutionRunOutputCommentLink>;
  readonly finalization: TaskExecutionJoinedFinalization | null;
}

export interface ReadJoinedTaskExecutionRunDetailInput extends TaskExecutionRunIdentity {
  readonly limit: number;
  readonly sessionProjection?: TaskSessionReadProjection;
  readonly sessionEventCursor?: string | null;
  readonly sessionMessageCursor?: string | null;
}

const MAX_RUN_LIST_PAGE_SIZE = 200;
const MAX_RUN_DETAIL_OWNER_ROWS = 500;
const RUN_STATUS_FILTER_VALUES = new Set<string>(TASK_EXECUTION_RUN_STATUSES);
const TERMINAL_RUN_STATUSES = new Set<TaskExecutionRunStatus>([
  "succeeded",
  "interrupted",
  "failed",
  "cancelled",
  "timed_out",
]);

function assertExactRunIdentifier(value: string, label: string): void {
  if (value.length === 0 || value !== value.trim()) {
    throw new TaskExecutionRunInvariantViolation(
      `${label} must be exact and non-empty`,
    );
  }
}

function assertRunIdentity(input: TaskExecutionRunIdentity): void {
  assertExactRunIdentifier(input.companyId, "company id");
  assertExactRunIdentifier(input.taskId, "task id");
  assertExactRunIdentifier(input.runId, "run id");
}

function assertDate(value: Date, label: string): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TaskExecutionRunInvariantViolation(`${label} must be a date`);
  }
}

function assertPageLimit(limit: number, maximum: number, label: string): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) {
    throw new TaskExecutionRunInvariantViolation(
      `${label} must be an integer between 1 and ${maximum}`,
    );
  }
}

function assertRunStatusFilter(
  statuses: readonly TaskExecutionRunStatus[] | undefined,
): void {
  if (statuses === undefined) return;
  if (
    !Array.isArray(statuses) ||
    statuses.length === 0 ||
    statuses.length > TASK_EXECUTION_RUN_STATUSES.length ||
    new Set(statuses).size !== statuses.length ||
    statuses.some(
      (status) =>
        typeof status !== "string" || !RUN_STATUS_FILTER_VALUES.has(status),
    )
  ) {
    throw new TaskExecutionRunInvariantViolation(
      "run status filter must contain unique closed run statuses",
    );
  }
}

function assertRunEnvelopeInvariant(run: TaskExecutionRunEnvelope): void {
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
    throw new TaskExecutionRunInvariantViolation(
      "run ownership epoch must be a positive integer",
    );
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
    throw new TaskExecutionRunInvariantViolation(
      "run kind provenance is not canonical",
    );
  }
  if ((run.currentAttemptId === null) !== (run.currentLeaseId === null)) {
    throw new TaskExecutionRunInvariantViolation(
      "run attempt and lease pointers must be paired",
    );
  }
  if (
    run.cancellationIntentId !== null &&
    (run.currentAttemptId === null || run.currentLeaseId === null)
  ) {
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
    throw new TaskExecutionRunInvariantViolation(
      "run terminal envelope is incomplete",
    );
  }
  if (
    terminal &&
    (run.currentAttemptId !== null ||
      run.currentLeaseId !== null ||
      run.cancellationIntentId !== null)
  ) {
    throw new TaskExecutionRunInvariantViolation(
      "terminal run retains an active control pointer",
    );
  }
  if (
    !terminal &&
    (run.finishedAt !== null ||
      run.terminalFinalizationId !== null ||
      run.terminalClassification !== null ||
      run.terminalReasonCode !== null)
  ) {
    throw new TaskExecutionRunInvariantViolation(
      "active run contains terminal facts",
    );
  }
  if (run.status === "running" && run.startedAt === null) {
    throw new TaskExecutionRunInvariantViolation(
      "running run requires its start time",
    );
  }
  assertDate(run.createdAt, "run creation time");
  assertDate(run.updatedAt, "run update time");
  if (run.updatedAt < run.createdAt) {
    throw new TaskExecutionRunInvariantViolation(
      "run update time predates creation",
    );
  }
}

function projectRunEnvelope(
  row: typeof taskExecutionRuns.$inferSelect,
): TaskExecutionRunEnvelope {
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
function steeringLivenessBaseQuery(transaction: TaskSessionDbTransaction) {
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
    .innerJoin(
      taskComments,
      eq(taskComments.id, taskExecutionPromptSegments.sourceCommentId),
    )
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

async function listResumedAgentSteeringLivenessActionsInTransaction(
  transaction: TaskSessionDbTransaction,
  input: ResumedAgentSteeringLivenessSearch,
): Promise<readonly ResumedAgentSteeringLivenessSource[]> {
  assertExactRunIdentifier(input.companyId, "steering liveness company id");
  assertExactRunIdentifier(input.taskId, "steering liveness task id");
  if (!Number.isSafeInteger(input.ownershipEpoch) || input.ownershipEpoch < 1) {
    throw new TaskExecutionRunInvariantViolation(
      "steering liveness ownership epoch must be positive",
    );
  }
  if ("sourceRunId" in input) {
    assertExactRunIdentifier(input.sourceRunId, "steering source run id");
  } else if (
    !(input.committedAfter instanceof Date) ||
    !Number.isFinite(input.committedAfter.getTime())
  ) {
    throw new TaskExecutionRunInvariantViolation(
      "steering liveness admission time is invalid",
    );
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
    throw new TaskExecutionRunInvariantViolation(
      "productive and consult runs require a non-empty ref batch",
    );
  }
  const hash = createHash("sha256");
  hash.update("paperclip.task-execution-run-batch/v2\n", "utf8");
  const seen = new Set<string>();
  let previousAdmissionOrder = -1;
  members.forEach((member, refOrdinal) => {
    assertExactRunIdentifier(member.refId, "run ref id");
    assertExactRunIdentifier(
      member.sourceMessageId,
      "run ref source message id",
    );
    if (member.messageKind !== "user" && member.messageKind !== "synthetic") {
      throw new TaskExecutionRunInvariantViolation(
        "run ref batch contains an invalid source message kind",
      );
    }
    if (seen.has(member.refId)) {
      throw new TaskExecutionRunInvariantViolation(
        "run ref batch contains a duplicate identity",
      );
    }
    seen.add(member.refId);
    if (
      !Number.isSafeInteger(member.admissionOrder) ||
      member.admissionOrder < 0 ||
      member.admissionOrder <= previousAdmissionOrder ||
      !Number.isSafeInteger(member.admissionVersion) ||
      member.admissionVersion < 0
    ) {
      throw new TaskExecutionRunInvariantViolation(
        "run ref batch admission order/version is invalid",
      );
    }
    previousAdmissionOrder = member.admissionOrder;
    hash.update(
      `${refOrdinal}\0${member.refId}\0${member.messageKind}\0${member.sourceMessageId}\0${member.admissionOrder}\0${member.admissionVersion}\n`,
      "utf8",
    );
  });
  return hash.digest("hex");
}

async function selectExactRunRow(
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

export async function readTaskExecutionRuntimeReadinessBinding(
  database: Db | TaskSessionDbTransaction,
  input: TaskExecutionRunIdentity,
): Promise<TaskExecutionRuntimeReadinessBinding | null> {
  assertRunIdentity(input);
  const rows = await database
    .select({
      companyId: taskExecutionRuns.companyId,
      taskId: taskExecutionRuns.taskId,
      runId: taskExecutionRuns.id,
      runKind: taskExecutionRuns.kind,
      runStatus: taskExecutionRuns.status,
      targetAgentId: taskExecutionRuns.targetAgentId,
      adapterConfigRevisionId: taskExecutionRuns.adapterConfigRevisionId,
      executionWorkspaceBindingId:
        taskExecutionRuns.executionWorkspaceBindingId,
      currentAdapterConfigRevisionId: agents.currentAdapterConfigRevisionId,
      revisionId: agentAdapterConfigRevisions.id,
      acpConfiguration: agentAdapterConfigRevisions.acpConfiguration,
      bindingId: taskExecutionWorkspaceBindings.id,
      bindingAbsoluteCwd: taskExecutionWorkspaceBindings.absoluteCwd,
    })
    .from(taskExecutionRuns)
    .leftJoin(
      agents,
      and(
        eq(agents.companyId, taskExecutionRuns.companyId),
        eq(agents.id, taskExecutionRuns.targetAgentId),
      ),
    )
    .leftJoin(
      agentAdapterConfigRevisions,
      and(
        eq(agentAdapterConfigRevisions.companyId, taskExecutionRuns.companyId),
        eq(
          agentAdapterConfigRevisions.agentId,
          taskExecutionRuns.targetAgentId,
        ),
        eq(
          agentAdapterConfigRevisions.id,
          taskExecutionRuns.adapterConfigRevisionId,
        ),
      ),
    )
    .leftJoin(
      taskExecutionWorkspaceBindings,
      and(
        eq(
          taskExecutionWorkspaceBindings.companyId,
          taskExecutionRuns.companyId,
        ),
        eq(taskExecutionWorkspaceBindings.taskId, taskExecutionRuns.taskId),
        eq(
          taskExecutionWorkspaceBindings.sessionId,
          taskExecutionRuns.sessionId,
        ),
        eq(
          taskExecutionWorkspaceBindings.ownershipEpoch,
          taskExecutionRuns.ownershipEpoch,
        ),
        eq(
          taskExecutionWorkspaceBindings.id,
          taskExecutionRuns.executionWorkspaceBindingId,
        ),
      ),
    )
    .where(
      and(
        eq(taskExecutionRuns.companyId, input.companyId),
        eq(taskExecutionRuns.taskId, input.taskId),
        eq(taskExecutionRuns.id, input.runId),
      ),
    )
    .limit(2);
  if (rows.length > 1) {
    throw new TaskExecutionRunInvariantViolation(
      "runtime-readiness run identity resolved more than once",
    );
  }
  const row = rows[0];
  if (!row) return null;
  if (!row.revisionId || !row.executionWorkspaceBindingId) {
    throw new TaskExecutionRunInvariantViolation(
      "task-execution run violates the persisted runtime-readiness scope invariant",
    );
  }
  return Object.freeze({
    companyId: row.companyId,
    taskId: row.taskId,
    runId: row.runId,
    runKind: row.runKind,
    runStatus: row.runStatus,
    agentId: row.targetAgentId,
    currentAdapterConfigRevisionId: row.currentAdapterConfigRevisionId,
    adapterConfigRevisionId: row.adapterConfigRevisionId,
    executionWorkspaceBindingId: row.executionWorkspaceBindingId,
    absoluteCwd:
      row.bindingId === row.executionWorkspaceBindingId
        ? row.bindingAbsoluteCwd
        : null,
    acpConfiguration: row.acpConfiguration,
  });
}

/**
 * Resolve the complete canonical identity behind a URL/tool run selector.
 * Every subsequent read or mutation must use the returned company/task/id
 * tuple; no caller receives an arbitrary run-row query surface.
 */
export async function resolveTaskExecutionRunIdentityById(
  database: Db | TaskSessionDbTransaction,
  runId: string,
): Promise<TaskExecutionRunIdentity | null> {
  if (!isCanonicalUuid(runId)) return null;
  const rows = await database
    .select({
      companyId: taskExecutionRuns.companyId,
      taskId: taskExecutionRuns.taskId,
      runId: taskExecutionRuns.id,
    })
    .from(taskExecutionRuns)
    .where(eq(taskExecutionRuns.id, runId))
    .limit(2);
  if (rows.length > 1) {
    throw new TaskExecutionRunInvariantViolation(
      "run selector resolved more than one canonical identity",
    );
  }
  return rows[0] ?? null;
}

export async function lockTaskExecutionRunInTransaction(
  transaction: TaskSessionDbTransaction,
  input: TaskExecutionRunIdentity,
): Promise<TaskExecutionRunEnvelope> {
  const run = await lockTaskExecutionRunIfPresentInTransaction(
    transaction,
    input,
  );
  if (!run) {
    throw new TaskExecutionRunInvariantViolation(
      "selected task-execution run does not exist in the exact scope",
    );
  }
  return run;
}

/** Optional exact lock for callers whose domain result distinguishes absence. */
export async function lockTaskExecutionRunIfPresentInTransaction(
  transaction: TaskSessionDbTransaction,
  input: TaskExecutionRunIdentity,
): Promise<TaskExecutionRunEnvelope | null> {
  const row = await selectExactRunRow(transaction, input, true);
  return row ? projectRunEnvelope(row) : null;
}

/**
 * Correlated terminal-finalization predicate for a source run whose exact
 * company, task, and run columns are already selected by a caller. Dispatch
 * discovery keeps one atomic SQL selection, while this service remains the
 * sole owner of the canonical run table and its terminal invariant.
 */
export function terminalFinalizedTaskExecutionRunExistsSql(
  companyId: SQLWrapper,
  taskId: SQLWrapper,
  runId: SQLWrapper,
): SQL<boolean> {
  return sql<boolean>`exists (
    select 1
    from ${taskExecutionRuns}
    where ${taskExecutionRuns.companyId} = ${companyId}
      and ${taskExecutionRuns.taskId} = ${taskId}
      and ${taskExecutionRuns.id} = ${runId}
      and ${taskExecutionRuns.terminalFinalizationId} is not null
  )`;
}

/**
 * Resolve every active run currently owning one exact execution ref. The run
 * root remains opaque to the input/admission owners; only canonical envelopes
 * cross this boundary.
 */
export async function lockActiveTaskExecutionRunsForRefInTransaction(
  transaction: TaskSessionDbTransaction,
  input: {
    readonly companyId: string;
    readonly taskId: string;
    readonly sessionId: string;
    readonly refId: string;
  },
): Promise<readonly TaskExecutionRunEnvelope[]> {
  for (const [label, value] of [
    ["company id", input.companyId],
    ["task id", input.taskId],
    ["session id", input.sessionId],
    ["execution ref id", input.refId],
  ] as const) {
    assertExactRunIdentifier(value, label);
  }
  const rows = await transaction
    .select({ run: taskExecutionRuns })
    .from(taskExecutionRunRefs)
    .innerJoin(
      taskExecutionRuns,
      and(
        eq(taskExecutionRuns.id, taskExecutionRunRefs.runId),
        eq(taskExecutionRuns.companyId, taskExecutionRunRefs.companyId),
        eq(taskExecutionRuns.taskId, taskExecutionRunRefs.taskId),
      ),
    )
    .where(
      and(
        eq(taskExecutionRunRefs.companyId, input.companyId),
        eq(taskExecutionRunRefs.taskId, input.taskId),
        eq(taskExecutionRunRefs.sessionId, input.sessionId),
        eq(taskExecutionRunRefs.refId, input.refId),
        inArray(taskExecutionRuns.status, [
          "queued",
          "running",
          "scheduled_retry",
        ]),
      ),
    )
    .orderBy(asc(taskExecutionRuns.createdAt), asc(taskExecutionRuns.id))
    .limit(2)
    .for("update", { of: taskExecutionRuns });
  return Object.freeze(rows.map((row) => projectRunEnvelope(row.run)));
}

export interface LockedTaskExecutionRunRefMembership {
  readonly run: TaskExecutionRunEnvelope;
  readonly refOrdinal: number;
  readonly currentRefId: string | null;
  readonly currentOrdinal: number | null;
}

/**
 * Locks one exact run/member/control tuple without exposing the canonical run
 * table to consult-chain consumers.
 */
export async function lockTaskExecutionRunRefMembershipInTransaction(
  transaction: TaskSessionDbTransaction,
  input: TaskExecutionRunIdentity & { readonly refId: string },
): Promise<LockedTaskExecutionRunRefMembership | null> {
  assertRunIdentity(input);
  assertExactRunIdentifier(input.refId, "execution ref id");
  const rows = await transaction
    .select({
      run: taskExecutionRuns,
      refOrdinal: taskExecutionRunRefs.refOrdinal,
      currentRefId: taskExecutionRunControls.currentRefId,
      currentOrdinal: taskExecutionRunControls.currentOrdinal,
    })
    .from(taskExecutionRuns)
    .innerJoin(
      taskExecutionRunRefs,
      and(
        eq(taskExecutionRunRefs.runId, taskExecutionRuns.id),
        eq(taskExecutionRunRefs.companyId, taskExecutionRuns.companyId),
        eq(taskExecutionRunRefs.taskId, taskExecutionRuns.taskId),
      ),
    )
    .innerJoin(
      taskExecutionRunControls,
      eq(taskExecutionRunControls.runId, taskExecutionRuns.id),
    )
    .where(
      and(
        eq(taskExecutionRuns.id, input.runId),
        eq(taskExecutionRuns.companyId, input.companyId),
        eq(taskExecutionRuns.taskId, input.taskId),
        eq(taskExecutionRunRefs.refId, input.refId),
      ),
    )
    .limit(2)
    .for("update");
  if (rows.length > 1) {
    throw new TaskExecutionRunInvariantViolation(
      "task-execution run has ambiguous execution-ref membership",
    );
  }
  const row = rows[0];
  if (!row) return null;
  const run = projectRunEnvelope(row.run);
  assertRunEnvelopeInvariant(run);
  return Object.freeze({
    run,
    refOrdinal: row.refOrdinal,
    currentRefId: row.currentRefId,
    currentOrdinal: row.currentOrdinal,
  });
}

/** Active run membership used to exclude refs already owned by a run. */
export async function readOccupiedTaskExecutionRefIds(
  database: Db | TaskSessionDbTransaction,
  input: {
    readonly companyId?: string;
    readonly taskId?: string;
    readonly sessionId?: string;
    readonly ownershipEpoch?: number;
    readonly targetAgentId?: string;
    readonly refIds?: readonly string[];
  },
): Promise<readonly string[]> {
  for (const [label, value] of [
    ["company id", input.companyId],
    ["task id", input.taskId],
    ["session id", input.sessionId],
    ["target agent id", input.targetAgentId],
  ] as const) {
    if (value !== undefined) assertExactRunIdentifier(value, label);
  }
  if (
    input.ownershipEpoch !== undefined &&
    (!Number.isSafeInteger(input.ownershipEpoch) || input.ownershipEpoch < 1)
  ) {
    throw new TaskExecutionRunInvariantViolation(
      "ownership epoch must be a positive integer",
    );
  }
  const refIds =
    input.refIds === undefined ? undefined : [...new Set(input.refIds)];
  if (refIds !== undefined) {
    for (const refId of refIds) {
      assertExactRunIdentifier(refId, "execution ref id");
    }
    if (refIds.length === 0) return Object.freeze([]);
  }
  const rows = await database
    .select({ refId: taskExecutionRunRefs.refId })
    .from(taskExecutionRunRefs)
    .innerJoin(
      taskExecutionRuns,
      and(
        eq(taskExecutionRuns.id, taskExecutionRunRefs.runId),
        eq(taskExecutionRuns.companyId, taskExecutionRunRefs.companyId),
        eq(taskExecutionRuns.taskId, taskExecutionRunRefs.taskId),
      ),
    )
    .where(
      and(
        input.companyId === undefined
          ? undefined
          : eq(taskExecutionRunRefs.companyId, input.companyId),
        input.taskId === undefined
          ? undefined
          : eq(taskExecutionRunRefs.taskId, input.taskId),
        input.sessionId === undefined
          ? undefined
          : eq(taskExecutionRunRefs.sessionId, input.sessionId),
        input.ownershipEpoch === undefined
          ? undefined
          : eq(taskExecutionRuns.ownershipEpoch, input.ownershipEpoch),
        input.targetAgentId === undefined
          ? undefined
          : eq(taskExecutionRuns.targetAgentId, input.targetAgentId),
        refIds === undefined
          ? undefined
          : inArray(taskExecutionRunRefs.refId, refIds),
        inArray(taskExecutionRuns.status, [
          "queued",
          "running",
          "scheduled_retry",
        ]),
      ),
    );
  return Object.freeze([...new Set(rows.map((row) => row.refId))]);
}

/** Lock the one active productive/consult run for an exact target lane. */
export async function lockActiveProductiveRunForLaneInTransaction(
  transaction: TaskSessionDbTransaction,
  input: TaskExecutionTargetLaneIdentity,
): Promise<TaskExecutionRunEnvelope | null> {
  for (const [label, value] of [
    ["company id", input.companyId],
    ["task id", input.taskId],
    ["session id", input.sessionId],
    ["target agent id", input.targetAgentId],
  ] as const) {
    assertExactRunIdentifier(value, label);
  }
  if (!Number.isSafeInteger(input.ownershipEpoch) || input.ownershipEpoch < 1) {
    throw new TaskExecutionRunInvariantViolation(
      "ownership epoch must be a positive integer",
    );
  }
  const rows = await transaction
    .select({ run: taskExecutionRuns })
    .from(taskExecutionRuns)
    .where(
      and(
        eq(taskExecutionRuns.companyId, input.companyId),
        eq(taskExecutionRuns.taskId, input.taskId),
        eq(taskExecutionRuns.sessionId, input.sessionId),
        eq(taskExecutionRuns.ownershipEpoch, input.ownershipEpoch),
        eq(taskExecutionRuns.targetAgentId, input.targetAgentId),
        inArray(taskExecutionRuns.status, [
          "queued",
          "running",
          "scheduled_retry",
        ]),
        inArray(taskExecutionRuns.kind, ["productive", "consult"]),
      ),
    )
    .orderBy(asc(taskExecutionRuns.createdAt), asc(taskExecutionRuns.id))
    .limit(2)
    .for("update", { of: taskExecutionRuns });
  if (rows.length > 1) {
    throw new TaskExecutionRunInvariantViolation(
      "target lane has more than one active productive/consult run",
    );
  }
  return rows[0] ? projectRunEnvelope(rows[0].run) : null;
}

export interface ActiveTaskExecutionRefRunAvailability {
  readonly run: TaskExecutionRunEnvelope;
  readonly leaseExpiresAt: Date | null;
  readonly retryAt: Date | null;
}

/** Resolve the one active run lifecycle currently attached to a persisted ref. */
export async function readActiveTaskExecutionRefRunAvailability(
  database: Db,
  input: { readonly refId: string },
): Promise<ActiveTaskExecutionRefRunAvailability | null> {
  assertExactRunIdentifier(input.refId, "execution ref id");
  const rows = await database
    .select({
      run: taskExecutionRuns,
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
    .leftJoin(
      taskExecutionLeases,
      eq(taskExecutionLeases.id, taskExecutionRuns.currentLeaseId),
    )
    .leftJoin(
      taskExecutionAttemptRetrySchedules,
      and(
        eq(taskExecutionAttemptRetrySchedules.runId, taskExecutionRuns.id),
        eq(taskExecutionAttemptRetrySchedules.state, "scheduled"),
      ),
    )
    .where(
      and(
        eq(taskExecutionRunRefs.refId, input.refId),
        inArray(taskExecutionRuns.status, [
          "queued",
          "running",
          "scheduled_retry",
        ]),
      ),
    )
    .orderBy(desc(taskExecutionRuns.createdAt))
    .limit(2);
  if (rows.length > 1) {
    throw new TaskExecutionRunInvariantViolation(
      "execution ref belongs to multiple active run lifecycles",
    );
  }
  const row = rows[0];
  return row
    ? {
        run: projectRunEnvelope(row.run),
        leaseExpiresAt: row.leaseExpiresAt,
        retryAt: row.retryAt,
      }
    : null;
}

export interface TaskExecutionLeaseBinding {
  readonly run: TaskExecutionRunEnvelope;
  readonly attemptState: typeof taskExecutionAttempts.$inferSelect.state;
  readonly leaseState: typeof taskExecutionLeases.$inferSelect.state;
  readonly leaseGeneration: number;
  readonly leaseExpiresAt: Date;
  readonly currentRefId: string | null;
}

/** One joined current-attempt/lease/control snapshot for lease validation. */
export async function readTaskExecutionLeaseBinding(
  database: Db,
  input: TaskExecutionRunIdentity & {
    readonly attemptId: string;
    readonly leaseId: string;
  },
): Promise<TaskExecutionLeaseBinding | null> {
  assertRunIdentity(input);
  assertExactRunIdentifier(input.attemptId, "attempt id");
  assertExactRunIdentifier(input.leaseId, "lease id");
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
    .innerJoin(
      taskExecutionRunControls,
      eq(taskExecutionRunControls.runId, taskExecutionRuns.id),
    )
    .where(
      and(
        eq(taskExecutionRuns.id, input.runId),
        eq(taskExecutionRuns.companyId, input.companyId),
        eq(taskExecutionRuns.taskId, input.taskId),
      ),
    )
    .limit(2);
  if (rows.length > 1) {
    throw new TaskExecutionRunInvariantViolation(
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
  assertDate(input.now, "dispatch discovery time");
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
    .innerJoin(
      taskExecutionRunControls,
      eq(taskExecutionRunControls.runId, taskExecutionRuns.id),
    )
    .leftJoin(
      taskExecutionLeases,
      eq(taskExecutionLeases.id, taskExecutionRuns.currentLeaseId),
    )
    .leftJoin(
      taskExecutionAttemptRetrySchedules,
      and(
        eq(taskExecutionAttemptRetrySchedules.runId, taskExecutionRuns.id),
        eq(taskExecutionAttemptRetrySchedules.state, "scheduled"),
      ),
    )
    .where(
      inArray(taskExecutionRuns.status, [
        "queued",
        "running",
        "scheduled_retry",
      ]),
    );
  const blocked = new Set<string>();
  for (const row of rows) {
    const detached =
      row.currentAttemptId === null &&
      row.currentLeaseId === null &&
      row.cancellationIntentId === null;
    const expired =
      row.currentAttemptId !== null &&
      row.currentLeaseId !== null &&
      row.cancellationIntentId === null &&
      row.leaseExpiresAt !== null &&
      row.leaseExpiresAt <= input.now;
    const due =
      row.status === "queued" ||
      row.status === "running" ||
      (row.status === "scheduled_retry" &&
        row.retryAt !== null &&
        row.retryAt <= input.now);
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
    assertExactRunIdentifier(value, label);
  }
  assertDate(input.at, "prompt capability revocation time");
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
        inArray(taskExecutionPromptCapabilities.state, [
          "pending_setup",
          "active",
        ]),
        revertedRefIds === null
          ? undefined
          : inArray(taskExecutionPromptCapabilities.refId, revertedRefIds),
      ),
    )
    .returning({
      capabilityConnectionId:
        taskExecutionPromptCapabilities.capabilityConnectionId,
    });
  return Object.freeze([
    ...new Set(revoked.map((row) => row.capabilityConnectionId)),
  ]);
}

/**
 * Sole company-scoped deletion owner for the canonical run roots. The
 * lifecycle caller must first fence dispatch, settle every attempt, and
 * remove the typed run-child owners; remaining restrictors fail the enclosing
 * transaction instead of being bypassed here.
 */
export async function purgeCompanyTaskExecutionRunsInTransaction(
  transaction: TaskSessionDbTransaction,
  input: PurgeCompanyTaskExecutionRunsInput,
): Promise<PurgedCompanyTaskExecutionRuns> {
  assertExactRunIdentifier(input.companyId, "company id");
  const deleted = await transaction
    .delete(taskExecutionRuns)
    .where(eq(taskExecutionRuns.companyId, input.companyId))
    .returning({ runId: taskExecutionRuns.id });
  return {
    companyId: input.companyId,
    deletedRunCount: deleted.length,
  };
}

function assertCreationInput(input: CreateTaskExecutionRunInput): void {
  for (const [label, value] of [
    ["company id", input.companyId],
    ["task id", input.taskId],
    ["session id", input.sessionId],
    ["execution scope id", input.executionScopeId],
    ["adapter config revision id", input.adapterConfigRevisionId],
    ["execution workspace binding id", input.executionWorkspaceBindingId],
  ] as const) {
    assertExactRunIdentifier(value, label);
  }
  assertDate(input.at, "run creation time");
  if (!Number.isSafeInteger(input.ownershipEpoch) || input.ownershipEpoch < 1) {
    throw new TaskExecutionRunInvariantViolation(
      "run ownership epoch must be a positive integer",
    );
  }
  if (input.retryOfRunId) {
    assertExactRunIdentifier(input.retryOfRunId, "retry run id");
  }
  assertExactRunIdentifier(input.targetAgentId, "target agent id");
  if (input.kind === "productive") {
    assertExactRunIdentifier(
      input.taskExecutionAuthorityId,
      "task execution authority id",
    );
  } else {
    assertExactRunIdentifier(input.consultExecutionId, "consult execution id");
    assertExactRunIdentifier(input.parentRunId, "consult parent run id");
  }
  if (input.orderedRefIds.length === 0) {
    throw new TaskExecutionRunInvariantViolation(
      "productive and consult runs require a non-empty ref batch",
    );
  }
  const seen = new Set<string>();
  for (const refId of input.orderedRefIds) {
    assertExactRunIdentifier(refId, "run ref id");
    if (seen.has(refId)) {
      throw new TaskExecutionRunInvariantViolation(
        "run ref batch contains a duplicate identity",
      );
    }
    seen.add(refId);
  }
}

function assertRelatedRunScope(
  related: TaskExecutionRunEnvelope,
  input: CreateTaskExecutionRunInput,
  relation: "parent" | "retry",
): void {
  const sameTaskEpoch =
    related.companyId === input.companyId &&
    related.taskId === input.taskId &&
    related.sessionId === input.sessionId &&
    related.ownershipEpoch === input.ownershipEpoch;
  if (!sameTaskEpoch) {
    throw new TaskExecutionRunInvariantViolation(
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
      related.executionWorkspaceBindingId !==
        input.executionWorkspaceBindingId ||
      related.kind !== input.kind ||
      related.targetAgentId !== input.targetAgentId ||
      related.executionMode !==
        (input.kind === "productive" ? "owner" : "consult") ||
      !sameBranch ||
      !TERMINAL_RUN_STATUSES.has(related.status)
    ) {
      throw new TaskExecutionRunInvariantViolation(
        "retry run is not a terminal run of the exact same kind and scope",
      );
    }
    return;
  }
  if (
    (related.kind !== "productive" && related.kind !== "consult") ||
    TERMINAL_RUN_STATUSES.has(related.status)
  ) {
    throw new TaskExecutionRunInvariantViolation(
      `${relation} run must be an active productive or consult run`,
    );
  }
}

/**
 * Creates the envelope and the complete productive/consult membership under
 * one caller-owned transaction. The caller must already hold the lane
 * admission fence; this function locks every named ref before deriving order.
 */
export async function createTaskExecutionRunInTransaction(
  transaction: TaskSessionDbTransaction,
  input: CreateTaskExecutionRunInput,
): Promise<CreatedTaskExecutionRun> {
  assertCreationInput(input);

  if (input.kind === "consult") {
    const parent = await selectExactRunRow(
      transaction,
      {
        companyId: input.companyId,
        taskId: input.taskId,
        runId: input.parentRunId,
      },
      true,
    );
    if (!parent) {
      throw new TaskExecutionRunInvariantViolation(
        "consult parent run does not exist",
      );
    }
    assertRelatedRunScope(projectRunEnvelope(parent), input, "parent");
  }
  if (input.retryOfRunId) {
    const retry = await selectExactRunRow(
      transaction,
      {
        companyId: input.companyId,
        taskId: input.taskId,
        runId: input.retryOfRunId,
      },
      true,
    );
    if (!retry) {
      throw new TaskExecutionRunInvariantViolation(
        "retry source run does not exist",
      );
    }
    assertRelatedRunScope(projectRunEnvelope(retry), input, "retry");
    const existingSuccessor = await transaction
      .select({ id: taskExecutionRuns.id })
      .from(taskExecutionRuns)
      .where(
        and(
          eq(taskExecutionRuns.companyId, input.companyId),
          eq(taskExecutionRuns.taskId, input.taskId),
          eq(taskExecutionRuns.retryOfRunId, input.retryOfRunId),
        ),
      )
      .limit(1)
      .for("update");
    if (existingSuccessor.length > 0) {
      throw new TaskExecutionRunInvariantViolation(
        "retry source run already owns its exact successor",
      );
    }
  }

  let lockedRefs: (typeof taskExecutionRefs.$inferSelect)[] = [];
  let batchDigest: string | null = null;
  {
    const rows = await transaction
      .select()
      .from(taskExecutionRefs)
      .where(
        and(
          eq(taskExecutionRefs.companyId, input.companyId),
          eq(taskExecutionRefs.taskId, input.taskId),
          eq(taskExecutionRefs.sessionId, input.sessionId),
          inArray(taskExecutionRefs.id, [...input.orderedRefIds]),
        ),
      )
      .for("update");
    const byId = new Map(rows.map((row) => [row.id, row]));
    lockedRefs = input.orderedRefIds.map((refId) => {
      const ref = byId.get(refId);
      if (!ref) {
        throw new TaskExecutionRunInvariantViolation(
          "run ref batch contains an identity outside the exact Session scope",
        );
      }
      return ref;
    });
    if (rows.length !== lockedRefs.length) {
      throw new TaskExecutionRunInvariantViolation(
        "run ref batch did not lock one exact row per identity",
      );
    }
    for (const ref of lockedRefs) {
      const correctBranch =
        input.kind === "productive"
          ? ref.mode === "owner" &&
            ref.taskExecutionAuthorityId === input.taskExecutionAuthorityId &&
            ref.consultExecutionId === null
          : ref.mode === "consult" &&
            ref.taskExecutionAuthorityId === null &&
            ref.consultExecutionId === input.consultExecutionId;
      if (
        !correctBranch ||
        ref.disposition !== "active" ||
        ref.ownershipEpoch !== input.ownershipEpoch ||
        ref.executionScopeId !== input.executionScopeId ||
        ref.targetAgentId !== input.targetAgentId ||
        ref.adapterConfigRevisionId !== input.adapterConfigRevisionId ||
        !isTaskExecutionRefDeliveryEligible(ref, "dispatch")
      ) {
        throw new TaskExecutionRunInvariantViolation(
          "run ref batch crossed its locked execution identity or admission state",
        );
      }
    }
    batchDigest = computeTaskExecutionRunBatchDigest(
      lockedRefs.map((ref) => ({
        refId: ref.id,
        messageKind: ref.messageKind,
        sourceMessageId: ref.sourceMessageId,
        admissionOrder: ref.laneOrdinal,
        admissionVersion: ref.admissionHighWaterSeq + 1,
      })),
    );
  }

  const insertedRuns = await transaction
    .insert(taskExecutionRuns)
    .values({
      companyId: input.companyId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      executionScopeId: input.executionScopeId,
      kind: input.kind,
      status: "queued",
      ownershipEpoch: input.ownershipEpoch,
      targetAgentId: input.targetAgentId,
      adapterConfigRevisionId: input.adapterConfigRevisionId,
      executionWorkspaceBindingId: input.executionWorkspaceBindingId,
      executionMode: input.kind === "productive" ? "owner" : "consult",
      taskExecutionAuthorityId:
        input.kind === "productive" ? input.taskExecutionAuthorityId : null,
      consultExecutionId:
        input.kind === "consult" ? input.consultExecutionId : null,
      parentRunId: input.kind === "consult" ? input.parentRunId : null,
      retryOfRunId: input.retryOfRunId ?? null,
      createdAt: input.at,
      updatedAt: input.at,
    })
    .returning();
  const insertedRun = insertedRuns[0];
  if (!insertedRun) {
    throw new TaskExecutionRunInvariantViolation(
      "run creation did not return the canonical envelope",
    );
  }

  const insertedRefs = await transaction
    .insert(taskExecutionRunRefs)
    .values(
      lockedRefs.map((ref, refOrdinal) => ({
        companyId: input.companyId,
        taskId: input.taskId,
        sessionId: input.sessionId,
        runId: insertedRun.id,
        refId: ref.id,
        refOrdinal,
        admissionOrder: ref.laneOrdinal,
        batchDigest: batchDigest!,
        inputId: ref.inputId,
        createdAt: input.at,
      })),
    )
    .returning();
  if (insertedRefs.length !== lockedRefs.length) {
    throw new TaskExecutionRunInvariantViolation(
      "run creation did not persist its complete immutable ref batch",
    );
  }
  await transaction.insert(taskExecutionRunControls).values({
    runId: insertedRun.id,
    currentRefId: null,
    currentOrdinal: null,
    currentSegmentOrdinal: null,
  });
  return {
    run: projectRunEnvelope(insertedRun),
    refs: insertedRefs,
    batchDigest,
  };
}

export async function transitionTaskExecutionRunStatusInTransaction(
  transaction: TaskSessionDbTransaction,
  input: TransitionTaskExecutionRunStatusInput,
): Promise<TaskExecutionRunEnvelope> {
  assertRunIdentity(input);
  assertDate(input.at, "run transition time");
  if (input.status === "running") {
    assertDate(input.startedAt, "run start time");
    if (input.startedAt > input.at) {
      throw new TaskExecutionRunInvariantViolation(
        "run start time cannot follow its running transition",
      );
    }
  }
  const predicates = [
    eq(taskExecutionRuns.id, input.runId),
    eq(taskExecutionRuns.companyId, input.companyId),
    eq(taskExecutionRuns.taskId, input.taskId),
    eq(taskExecutionRuns.status, input.expectedStatus),
    isNull(taskExecutionRuns.terminalFinalizationId),
    isNull(taskExecutionRuns.finishedAt),
  ];
  if (input.status === "running") {
    predicates.push(
      input.startedAt.getTime() === input.at.getTime()
        ? or(
            isNull(taskExecutionRuns.startedAt),
            eq(taskExecutionRuns.startedAt, input.startedAt),
          )!
        : eq(taskExecutionRuns.startedAt, input.startedAt),
    );
  }
  if (input.status !== "running") {
    predicates.push(
      isNull(taskExecutionRuns.currentAttemptId),
      isNull(taskExecutionRuns.currentLeaseId),
      isNull(taskExecutionRuns.cancellationIntentId),
    );
  }
  const changed = await transaction
    .update(taskExecutionRuns)
    .set({
      status: input.status,
      ...(input.status === "running" ? { startedAt: input.startedAt } : {}),
      updatedAt: input.at,
    })
    .where(and(...predicates))
    .returning();
  if (!changed[0]) {
    throw new TaskExecutionRunInvariantViolation(
      `run cannot transition from ${input.expectedStatus} to ${input.status}`,
    );
  }
  return projectRunEnvelope(changed[0]);
}

export async function attachTaskExecutionRunAttemptInTransaction(
  transaction: TaskSessionDbTransaction,
  input: AttachTaskExecutionRunAttemptInput,
): Promise<TaskExecutionRunEnvelope> {
  assertRunIdentity(input);
  assertExactRunIdentifier(input.attemptId, "attempt id");
  assertExactRunIdentifier(input.leaseId, "lease id");
  assertDate(input.at, "attempt attachment time");
  const attempts = await transaction
    .select({
      id: taskExecutionAttempts.id,
      state: taskExecutionAttempts.state,
    })
    .from(taskExecutionAttempts)
    .where(
      and(
        eq(taskExecutionAttempts.id, input.attemptId),
        eq(taskExecutionAttempts.companyId, input.companyId),
        eq(taskExecutionAttempts.taskId, input.taskId),
        eq(taskExecutionAttempts.runId, input.runId),
      ),
    )
    .limit(1)
    .for("update");
  const leases = await transaction
    .select({
      id: taskExecutionLeases.id,
      attemptId: taskExecutionLeases.attemptId,
      state: taskExecutionLeases.state,
    })
    .from(taskExecutionLeases)
    .where(
      and(
        eq(taskExecutionLeases.id, input.leaseId),
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
    !["leased", "running"].includes(attempts[0].state) ||
    leases[0].attemptId !== input.attemptId ||
    leases[0].state !== "active"
  ) {
    throw new TaskExecutionRunInvariantViolation(
      "run attempt attachment does not target one exact active attempt/lease pair",
    );
  }
  const changed = await transaction
    .update(taskExecutionRuns)
    .set({
      currentAttemptId: input.attemptId,
      currentLeaseId: input.leaseId,
      updatedAt: input.at,
    })
    .where(
      and(
        eq(taskExecutionRuns.id, input.runId),
        eq(taskExecutionRuns.companyId, input.companyId),
        eq(taskExecutionRuns.taskId, input.taskId),
        eq(taskExecutionRuns.status, "running"),
        isNull(taskExecutionRuns.currentAttemptId),
        isNull(taskExecutionRuns.currentLeaseId),
        isNull(taskExecutionRuns.cancellationIntentId),
        isNull(taskExecutionRuns.terminalFinalizationId),
        isNull(taskExecutionRuns.finishedAt),
      ),
    )
    .returning();
  if (!changed[0]) {
    throw new TaskExecutionRunInvariantViolation(
      "run cannot attach the selected attempt and lease",
    );
  }
  return projectRunEnvelope(changed[0]);
}

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
    throw new TaskExecutionRunInvariantViolation(
      "run cannot detach a stale or cancellation-bound attempt",
    );
  }
  return projectRunEnvelope(changed[0]);
}

export async function attachTaskExecutionRunCancellationInTransaction(
  transaction: TaskSessionDbTransaction,
  input: AttachTaskExecutionRunCancellationInput,
): Promise<TaskExecutionRunEnvelope> {
  assertRunIdentity(input);
  assertExactRunIdentifier(input.expectedAttemptId, "expected attempt id");
  assertExactRunIdentifier(input.expectedLeaseId, "expected lease id");
  assertExactRunIdentifier(
    input.cancellationIntentId,
    "cancellation intent id",
  );
  assertDate(input.at, "cancellation attachment time");
  const cancellations = await transaction
    .select({
      attemptId: taskExecutionCancellationIntents.attemptId,
      leaseId: taskExecutionCancellationIntents.leaseId,
      state: taskExecutionCancellationIntents.state,
    })
    .from(taskExecutionCancellationIntents)
    .where(
      and(
        eq(taskExecutionCancellationIntents.id, input.cancellationIntentId),
        eq(taskExecutionCancellationIntents.companyId, input.companyId),
        eq(taskExecutionCancellationIntents.taskId, input.taskId),
        eq(taskExecutionCancellationIntents.runId, input.runId),
      ),
    )
    .limit(1)
    .for("update");
  if (
    !cancellations[0] ||
    cancellations[0].attemptId !== input.expectedAttemptId ||
    cancellations[0].leaseId !== input.expectedLeaseId ||
    cancellations[0].state !== "requested"
  ) {
    throw new TaskExecutionRunInvariantViolation(
      "run cancellation attachment does not target its exact requested attempt/lease intent",
    );
  }
  const changed = await transaction
    .update(taskExecutionRuns)
    .set({
      cancellationIntentId: input.cancellationIntentId,
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
    throw new TaskExecutionRunInvariantViolation(
      "run cannot attach the selected cancellation intent",
    );
  }
  return projectRunEnvelope(changed[0]);
}

export async function detachTaskExecutionRunCancellationInTransaction(
  transaction: TaskSessionDbTransaction,
  input: DetachTaskExecutionRunCancellationInput,
): Promise<TaskExecutionRunEnvelope> {
  assertRunIdentity(input);
  assertExactRunIdentifier(
    input.expectedCancellationIntentId,
    "expected cancellation intent id",
  );
  assertDate(input.at, "cancellation detachment time");
  const cancellations = await transaction
    .select({ state: taskExecutionCancellationIntents.state })
    .from(taskExecutionCancellationIntents)
    .where(
      and(
        eq(
          taskExecutionCancellationIntents.id,
          input.expectedCancellationIntentId,
        ),
        eq(taskExecutionCancellationIntents.companyId, input.companyId),
        eq(taskExecutionCancellationIntents.taskId, input.taskId),
        eq(taskExecutionCancellationIntents.runId, input.runId),
      ),
    )
    .limit(1)
    .for("update");
  if (!cancellations[0] || cancellations[0].state !== "completed") {
    throw new TaskExecutionRunInvariantViolation(
      "run cancellation detachment requires its exact completed intent",
    );
  }
  const changed = await transaction
    .update(taskExecutionRuns)
    .set({ cancellationIntentId: null, updatedAt: input.at })
    .where(
      and(
        eq(taskExecutionRuns.id, input.runId),
        eq(taskExecutionRuns.companyId, input.companyId),
        eq(taskExecutionRuns.taskId, input.taskId),
        eq(taskExecutionRuns.status, "running"),
        eq(
          taskExecutionRuns.cancellationIntentId,
          input.expectedCancellationIntentId,
        ),
        isNull(taskExecutionRuns.terminalFinalizationId),
        isNull(taskExecutionRuns.finishedAt),
      ),
    )
    .returning();
  if (!changed[0]) {
    throw new TaskExecutionRunInvariantViolation(
      "run cannot detach a stale cancellation intent",
    );
  }
  return projectRunEnvelope(changed[0]);
}

export async function attachTaskExecutionRunFinalizationInTransaction(
  transaction: TaskSessionDbTransaction,
  input: AttachTaskExecutionRunFinalizationInput,
): Promise<TaskExecutionRunEnvelope> {
  assertRunIdentity(input);
  assertExactRunIdentifier(input.finalizationId, "finalization id");
  assertDate(input.finishedAt, "run finish time");
  assertDate(input.at, "finalization attachment time");
  if (
    input.at < input.finishedAt ||
    input.terminalReasonCode.length < 1 ||
    input.terminalReasonCode.length > 200 ||
    input.terminalReasonCode !== input.terminalReasonCode.trim()
  ) {
    throw new TaskExecutionRunInvariantViolation(
      "run terminal reason or time is invalid",
    );
  }
  const finalizations = await transaction
    .select({
      id: taskExecutionFinalizations.id,
      finalizedAt: taskExecutionFinalizations.finalizedAt,
    })
    .from(taskExecutionFinalizations)
    .where(
      and(
        eq(taskExecutionFinalizations.id, input.finalizationId),
        eq(taskExecutionFinalizations.companyId, input.companyId),
        eq(taskExecutionFinalizations.runId, input.runId),
      ),
    )
    .limit(1)
    .for("update");
  if (!finalizations[0] || finalizations[0].finalizedAt > input.at) {
    throw new TaskExecutionRunInvariantViolation(
      "terminal run requires its exact already-persisted finalization",
    );
  }
  const changed = await transaction
    .update(taskExecutionRuns)
    .set({
      status: input.status,
      terminalFinalizationId: input.finalizationId,
      finishedAt: input.finishedAt,
      terminalClassification: input.status,
      terminalReasonCode: input.terminalReasonCode,
      updatedAt: input.at,
    })
    .where(
      and(
        eq(taskExecutionRuns.id, input.runId),
        eq(taskExecutionRuns.companyId, input.companyId),
        eq(taskExecutionRuns.taskId, input.taskId),
        eq(taskExecutionRuns.status, input.expectedStatus),
        isNull(taskExecutionRuns.currentAttemptId),
        isNull(taskExecutionRuns.currentLeaseId),
        isNull(taskExecutionRuns.cancellationIntentId),
        isNull(taskExecutionRuns.terminalFinalizationId),
        isNull(taskExecutionRuns.finishedAt),
      ),
    )
    .returning();
  if (!changed[0]) {
    throw new TaskExecutionRunInvariantViolation(
      "run finalization lost its exact active lifecycle fence",
    );
  }
  return projectRunEnvelope(changed[0]);
}

function runListCursorPredicate(cursor: TaskExecutionRunListCursor) {
  if (
    cursor.createdAt.length === 0 ||
    cursor.createdAt !== cursor.createdAt.trim() ||
    !Number.isFinite(new Date(cursor.createdAt).getTime())
  ) {
    throw new TaskExecutionRunInvariantViolation(
      "run list cursor time must be an exact valid timestamp",
    );
  }
  assertExactRunIdentifier(cursor.runId, "run list cursor id");
  return sql`(${taskExecutionRuns.createdAt}, ${taskExecutionRuns.id}) < (${cursor.createdAt}::timestamptz, ${cursor.runId}::uuid)`;
}

async function listTaskExecutionRunPage(
  database: Db,
  input: {
    readonly predicates: readonly ReturnType<typeof eq>[];
    readonly statuses?: readonly TaskExecutionRunStatus[];
    readonly cursor?: TaskExecutionRunListCursor | null;
    readonly limit: number;
  },
): Promise<TaskExecutionRunListPage> {
  assertPageLimit(input.limit, MAX_RUN_LIST_PAGE_SIZE, "run list limit");
  assertRunStatusFilter(input.statuses);
  const rows = await database
    .select({
      run: taskExecutionRuns,
      exactCreatedAt: sql<string>`${taskExecutionRuns.createdAt}::text`,
    })
    .from(taskExecutionRuns)
    .where(
      and(
        ...input.predicates,
        ...(input.statuses
          ? [inArray(taskExecutionRuns.status, [...input.statuses])]
          : []),
        ...(input.cursor ? [runListCursorPredicate(input.cursor)] : []),
      ),
    )
    .orderBy(desc(taskExecutionRuns.createdAt), desc(taskExecutionRuns.id))
    .limit(input.limit + 1);
  const hasMore = rows.length > input.limit;
  const selected = rows.slice(0, input.limit);
  const items = selected.map((row) => projectRunEnvelope(row.run));
  const last = hasMore ? selected[selected.length - 1] : undefined;
  return {
    items,
    nextCursor: last
      ? { createdAt: last.exactCreatedAt, runId: last.run.id }
      : null,
  };
}

export async function listTaskExecutionRunsForTask(
  database: Db,
  input: {
    readonly companyId: string;
    readonly taskId: string;
    readonly statuses?: readonly TaskExecutionRunStatus[];
    readonly cursor?: TaskExecutionRunListCursor | null;
    readonly limit: number;
  },
): Promise<TaskExecutionRunListPage> {
  assertExactRunIdentifier(input.companyId, "company id");
  assertExactRunIdentifier(input.taskId, "task id");
  return listTaskExecutionRunPage(database, {
    predicates: [
      eq(taskExecutionRuns.companyId, input.companyId),
      eq(taskExecutionRuns.taskId, input.taskId),
    ],
    statuses: input.statuses,
    cursor: input.cursor,
    limit: input.limit,
  });
}

export async function listTaskExecutionRunsForAgent(
  database: Db,
  input: {
    readonly companyId: string;
    readonly targetAgentId: string;
    readonly statuses?: readonly TaskExecutionRunStatus[];
    readonly cursor?: TaskExecutionRunListCursor | null;
    readonly limit: number;
  },
): Promise<TaskExecutionRunListPage> {
  assertExactRunIdentifier(input.companyId, "company id");
  assertExactRunIdentifier(input.targetAgentId, "target agent id");
  return listTaskExecutionRunPage(database, {
    predicates: [
      eq(taskExecutionRuns.companyId, input.companyId),
      eq(taskExecutionRuns.targetAgentId, input.targetAgentId),
    ],
    statuses: input.statuses,
    cursor: input.cursor,
    limit: input.limit,
  });
}

/** Company activity consumes the same envelope bytes as every other list. */
export async function listTaskExecutionRunsForActivity(
  database: Db,
  input: {
    readonly companyId: string;
    readonly statuses?: readonly TaskExecutionRunStatus[];
    readonly cursor?: TaskExecutionRunListCursor | null;
    readonly limit: number;
  },
): Promise<TaskExecutionRunListPage> {
  assertExactRunIdentifier(input.companyId, "company id");
  return listTaskExecutionRunPage(database, {
    predicates: [eq(taskExecutionRuns.companyId, input.companyId)],
    statuses: input.statuses,
    cursor: input.cursor,
    limit: input.limit,
  });
}

/** Work timeline is deliberately task-scoped rather than a polymorphic list. */
export async function listTaskExecutionRunsForWorkTimeline(
  database: Db,
  input: {
    readonly companyId: string;
    readonly taskId: string;
    readonly statuses?: readonly TaskExecutionRunStatus[];
    readonly cursor?: TaskExecutionRunListCursor | null;
    readonly limit: number;
  },
): Promise<TaskExecutionRunListPage> {
  return listTaskExecutionRunsForTask(database, input);
}

/** Distinct task roots currently owning an active productive owner run. */
export async function listLiveOwnerTaskIds(
  database: Db | TaskSessionDbTransaction,
  input: { readonly companyId: string },
): Promise<readonly string[]> {
  assertExactRunIdentifier(input.companyId, "company id");
  const rows = await database
    .selectDistinct({ taskId: taskExecutionRuns.taskId })
    .from(taskExecutionRuns)
    .where(
      and(
        eq(taskExecutionRuns.companyId, input.companyId),
        eq(taskExecutionRuns.kind, "productive"),
        eq(taskExecutionRuns.executionMode, "owner"),
        inArray(taskExecutionRuns.status, [
          "queued",
          "scheduled_retry",
          "running",
        ]),
      ),
    );
  return Object.freeze(rows.map((row) => row.taskId));
}

export interface ProductiveRunLinkage {
  readonly runId: string;
  readonly runStatus: "running";
  readonly companyId: string;
  readonly agentId: string;
  readonly refId: string;
  readonly taskId: string;
  readonly projectId: string | null;
  readonly routineId: string | null;
  readonly sessionId: string;
  readonly ownershipEpoch: number;
  readonly mode: "owner" | "consult";
  readonly sourceKind: typeof taskExecutionRefs.$inferSelect.sourceKind;
  readonly sourceRecordId: string;
  readonly adapterConfigRevisionId: string;
  readonly taskExecutionAuthorityId: string | null;
  readonly consultExecutionId: string | null;
  readonly taskExecutionPolicy: Record<string, unknown> | null;
}

export interface CurrentTaskOwnerRunLinkage extends ProductiveRunLinkage {
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
  readonly createdAt: Date;
}

function currentProductivePromptPredicate(now: Date) {
  return and(
    eq(taskExecutionRuns.kind, "productive"),
    eq(taskExecutionRuns.status, "running"),
    eq(taskExecutionAttempts.state, "running"),
    eq(taskExecutionLeases.state, "active"),
    gt(taskExecutionLeases.expiresAt, now),
    eq(taskExecutionRefs.disposition, "active"),
    isNull(taskExecutionRunRefs.protocolSettlementState),
  );
}

const productiveRunLinkageSelection = {
  runId: taskExecutionRuns.id,
  runStatus: taskExecutionRuns.status,
  companyId: taskExecutionRuns.companyId,
  agentId: taskExecutionRefs.targetAgentId,
  refId: taskExecutionRefs.id,
  taskId: taskExecutionRefs.taskId,
  projectId: tasks.projectId,
  routineId: tasks.creatorRoutineId,
  sessionId: taskExecutionRefs.sessionId,
  ownershipEpoch: taskExecutionRefs.ownershipEpoch,
  mode: taskExecutionRefs.mode,
  sourceKind: taskExecutionRefs.sourceKind,
  sourceRecordId: taskExecutionRefs.sourceRecordId,
  adapterConfigRevisionId: taskExecutionRefs.adapterConfigRevisionId,
  taskExecutionAuthorityId: taskExecutionRefs.taskExecutionAuthorityId,
  consultExecutionId: taskExecutionRefs.consultExecutionId,
  taskExecutionPolicy: tasks.executionPolicy,
} as const;

function currentRunAttemptJoinPredicate() {
  return and(
    eq(taskExecutionAttempts.companyId, taskExecutionRuns.companyId),
    eq(taskExecutionAttempts.taskId, taskExecutionRuns.taskId),
    eq(taskExecutionAttempts.runId, taskExecutionRuns.id),
    eq(taskExecutionAttempts.id, taskExecutionRuns.currentAttemptId),
  );
}

function currentRunLeaseJoinPredicate() {
  return and(
    eq(taskExecutionLeases.companyId, taskExecutionRuns.companyId),
    eq(taskExecutionLeases.taskId, taskExecutionRuns.taskId),
    eq(taskExecutionLeases.runId, taskExecutionRuns.id),
    eq(taskExecutionLeases.attemptId, taskExecutionAttempts.id),
    eq(taskExecutionLeases.id, taskExecutionRuns.currentLeaseId),
  );
}

function currentRunRefJoinPredicate(...scopePredicates: readonly SQLWrapper[]) {
  return and(
    eq(taskExecutionRefs.companyId, taskExecutionAttempts.companyId),
    eq(taskExecutionRefs.taskId, taskExecutionAttempts.taskId),
    eq(taskExecutionRefs.id, taskExecutionAttempts.refId),
    ...scopePredicates,
  );
}

function currentRunRefMembershipJoinPredicate() {
  return and(
    eq(taskExecutionRunRefs.companyId, taskExecutionRuns.companyId),
    eq(taskExecutionRunRefs.taskId, taskExecutionRuns.taskId),
    eq(taskExecutionRunRefs.runId, taskExecutionRuns.id),
    eq(taskExecutionRunRefs.refId, taskExecutionAttempts.refId),
    eq(taskExecutionRunRefs.refOrdinal, taskExecutionAttempts.refOrdinal),
  );
}

/** Resolve one active productive run through its exact prompt and lease. */
export async function resolveProductiveRunLinkage(
  database: Db,
  input: {
    readonly runId: string;
    readonly companyId?: string | null;
    readonly agentId?: string | null;
  },
): Promise<ProductiveRunLinkage | null> {
  assertExactRunIdentifier(input.runId, "run id");
  if (input.companyId) assertExactRunIdentifier(input.companyId, "company id");
  if (input.agentId) assertExactRunIdentifier(input.agentId, "agent id");
  const predicates = [
    eq(taskExecutionRuns.id, input.runId),
    currentProductivePromptPredicate(new Date()),
    ...(input.companyId
      ? [eq(taskExecutionRuns.companyId, input.companyId)]
      : []),
    ...(input.agentId
      ? [eq(taskExecutionRefs.targetAgentId, input.agentId)]
      : []),
  ];
  return database
    .select(productiveRunLinkageSelection)
    .from(taskExecutionRuns)
    .innerJoin(taskExecutionAttempts, currentRunAttemptJoinPredicate())
    .innerJoin(taskExecutionLeases, currentRunLeaseJoinPredicate())
    .innerJoin(
      taskExecutionRefs,
      currentRunRefJoinPredicate(
        eq(taskExecutionRefs.targetAgentId, taskExecutionRuns.targetAgentId),
      ),
    )
    .innerJoin(taskExecutionRunRefs, currentRunRefMembershipJoinPredicate())
    .innerJoin(
      tasks,
      and(
        eq(tasks.id, taskExecutionRuns.taskId),
        eq(tasks.companyId, taskExecutionRuns.companyId),
      ),
    )
    .where(and(...predicates))
    .limit(1)
    .then((rows) => rows[0] ?? null) as Promise<ProductiveRunLinkage | null>;
}

/** Resolve each task's exact current owner prompt, never an historical run. */
export async function resolveCurrentTaskOwnerRunLinkages(
  database: Db,
  input: { readonly companyId: string; readonly taskIds: readonly string[] },
): Promise<Map<string, CurrentTaskOwnerRunLinkage>> {
  assertExactRunIdentifier(input.companyId, "company id");
  const taskIds = [...new Set(input.taskIds)];
  for (const taskId of taskIds) assertExactRunIdentifier(taskId, "task id");
  if (taskIds.length === 0) return new Map();
  const rows = await database
    .select({
      ...productiveRunLinkageSelection,
      startedAt: taskExecutionRuns.startedAt,
      finishedAt: taskExecutionRuns.finishedAt,
      createdAt: taskExecutionRuns.createdAt,
    })
    .from(tasks)
    .innerJoin(
      taskExecutionRuns,
      and(
        eq(taskExecutionRuns.companyId, tasks.companyId),
        eq(taskExecutionRuns.taskId, tasks.id),
        eq(taskExecutionRuns.ownershipEpoch, tasks.ownershipEpoch),
        eq(taskExecutionRuns.targetAgentId, tasks.ownerAgentId),
        eq(taskExecutionRuns.executionMode, "owner"),
      ),
    )
    .innerJoin(taskExecutionAttempts, currentRunAttemptJoinPredicate())
    .innerJoin(taskExecutionLeases, currentRunLeaseJoinPredicate())
    .innerJoin(
      taskExecutionRefs,
      currentRunRefJoinPredicate(
        eq(taskExecutionRefs.ownershipEpoch, tasks.ownershipEpoch),
        eq(taskExecutionRefs.targetAgentId, tasks.ownerAgentId),
        eq(taskExecutionRefs.mode, "owner"),
      ),
    )
    .innerJoin(taskExecutionRunRefs, currentRunRefMembershipJoinPredicate())
    .innerJoin(
      taskExecutionAuthorities,
      and(
        eq(
          taskExecutionAuthorities.id,
          taskExecutionRefs.taskExecutionAuthorityId,
        ),
        eq(taskExecutionAuthorities.companyId, taskExecutionRefs.companyId),
        eq(taskExecutionAuthorities.taskId, taskExecutionRefs.taskId),
        eq(
          taskExecutionAuthorities.ownershipEpoch,
          taskExecutionRefs.ownershipEpoch,
        ),
        eq(taskExecutionAuthorities.agentId, taskExecutionRefs.targetAgentId),
        eq(taskExecutionAuthorities.state, "current"),
      ),
    )
    .where(
      and(
        eq(tasks.companyId, input.companyId),
        eq(tasks.ownerKind, "agent"),
        inArray(tasks.id, taskIds),
        currentProductivePromptPredicate(new Date()),
      ),
    );
  const byTaskId = new Map<string, CurrentTaskOwnerRunLinkage>();
  for (const row of rows as CurrentTaskOwnerRunLinkage[]) {
    const previous = byTaskId.get(row.taskId);
    if (!previous || row.createdAt > previous.createdAt) {
      byTaskId.set(row.taskId, row);
    }
  }
  return byTaskId;
}

export async function resolveCurrentTaskOwnerRunLinkage(
  database: Db,
  input: {
    readonly companyId: string;
    readonly taskId: string;
    readonly agentId?: string | null;
    readonly runId?: string | null;
  },
): Promise<CurrentTaskOwnerRunLinkage | null> {
  const linkage =
    (
      await resolveCurrentTaskOwnerRunLinkages(database, {
        companyId: input.companyId,
        taskIds: [input.taskId],
      })
    ).get(input.taskId) ?? null;
  if (input.agentId && linkage?.agentId !== input.agentId) return null;
  if (input.runId && linkage?.runId !== input.runId) return null;
  return linkage;
}

function boundedRecords<T>(
  rows: readonly T[],
  limit: number,
): BoundedTaskExecutionRunRecords<T> {
  return {
    items: rows.slice(0, limit),
    truncated: rows.length > limit,
  };
}

function assertJoinedRunShape(input: {
  readonly run: TaskExecutionRunEnvelope;
  readonly controlRows: readonly TaskExecutionRunControl[];
  readonly refRows: readonly TaskExecutionRunRef[];
  readonly refsTruncated: boolean;
}): void {
  if (input.controlRows.length > 1) {
    throw new TaskExecutionRunInvariantViolation(
      "run joined detail found duplicate singular control owners",
    );
  }
  if (input.controlRows.length !== 1 || input.refRows.length === 0) {
    throw new TaskExecutionRunInvariantViolation(
      "productive or consult run is missing its control or non-empty ref batch",
    );
  }
  const digest = input.refRows[0]!.batchDigest;
  input.refRows.forEach((ref, index) => {
    if (ref.refOrdinal !== index || ref.batchDigest !== digest) {
      throw new TaskExecutionRunInvariantViolation(
        "run ref projection is non-contiguous or crosses batch digests",
      );
    }
  });
  if (!input.refsTruncated) {
    const uniqueRefs = new Set(input.refRows.map((ref) => ref.refId));
    if (uniqueRefs.size !== input.refRows.length) {
      throw new TaskExecutionRunInvariantViolation(
        "run ref projection contains duplicate members",
      );
    }
  }
}

/**
 * One bounded canonical join for REST, activity, and audit
 * projections. The caller owns authorization; this reader owns identical DB
 * bytes and structural redaction for every authorized consumer.
 */
async function readJoinedTaskExecutionRunDetail(
  database: Db,
  taskSessionStore: TaskSessionStore,
  input: ReadJoinedTaskExecutionRunDetailInput,
): Promise<JoinedTaskExecutionRunDetail | null> {
  assertRunIdentity(input);
  assertPageLimit(
    input.limit,
    MAX_RUN_DETAIL_OWNER_ROWS,
    "run detail owner limit",
  );
  const run = await readTaskExecutionRun(database, input);
  if (!run) return null;

  const [
    controlRows,
    refRows,
    segmentRows,
    sessionEventPage,
    sessionMessagePage,
    attemptRows,
    retryScheduleRows,
    leaseRows,
    cancellationRows,
    accountingRows,
    costRows,
    activityRows,
    outputCommentRows,
    finalizationRows,
  ] = await Promise.all([
    database
      .select()
      .from(taskExecutionRunControls)
      .where(eq(taskExecutionRunControls.runId, input.runId))
      .limit(2),
    database
      .select()
      .from(taskExecutionRunRefs)
      .where(
        and(
          eq(taskExecutionRunRefs.companyId, input.companyId),
          eq(taskExecutionRunRefs.taskId, input.taskId),
          eq(taskExecutionRunRefs.runId, input.runId),
        ),
      )
      .orderBy(asc(taskExecutionRunRefs.refOrdinal))
      .limit(input.limit + 1),
    database
      .select()
      .from(taskExecutionPromptSegments)
      .where(
        and(
          eq(taskExecutionPromptSegments.companyId, input.companyId),
          eq(taskExecutionPromptSegments.taskId, input.taskId),
          eq(taskExecutionPromptSegments.runId, input.runId),
        ),
      )
      .orderBy(
        asc(taskExecutionPromptSegments.refOrdinal),
        asc(taskExecutionPromptSegments.segmentOrdinal),
      )
      .limit(input.limit + 1),
    taskSessionStore.pageEvents(
      {
        companyId: input.companyId,
        taskId: input.taskId,
        sessionId: run.sessionId,
        runId: input.runId,
        direction: "asc",
        projection: input.sessionProjection ?? "audit",
      },
      { cursor: input.sessionEventCursor, limit: input.limit },
    ),
    taskSessionStore.pageMessages(
      {
        companyId: input.companyId,
        taskId: input.taskId,
        sessionId: run.sessionId,
        runId: input.runId,
        direction: "asc",
        projection: input.sessionProjection ?? "audit",
      },
      { cursor: input.sessionMessageCursor, limit: input.limit },
    ),
    database
      .select()
      .from(taskExecutionAttempts)
      .where(
        and(
          eq(taskExecutionAttempts.companyId, input.companyId),
          eq(taskExecutionAttempts.taskId, input.taskId),
          eq(taskExecutionAttempts.runId, input.runId),
        ),
      )
      .orderBy(
        asc(taskExecutionAttempts.createdAt),
        asc(taskExecutionAttempts.id),
      )
      .limit(input.limit + 1),
    database
      .select()
      .from(taskExecutionAttemptRetrySchedules)
      .where(
        and(
          eq(taskExecutionAttemptRetrySchedules.companyId, input.companyId),
          eq(taskExecutionAttemptRetrySchedules.taskId, input.taskId),
          eq(taskExecutionAttemptRetrySchedules.runId, input.runId),
        ),
      )
      .orderBy(
        asc(taskExecutionAttemptRetrySchedules.createdAt),
        asc(taskExecutionAttemptRetrySchedules.id),
      )
      .limit(input.limit + 1),
    database
      .select()
      .from(taskExecutionLeases)
      .where(
        and(
          eq(taskExecutionLeases.companyId, input.companyId),
          eq(taskExecutionLeases.taskId, input.taskId),
          eq(taskExecutionLeases.runId, input.runId),
        ),
      )
      .orderBy(asc(taskExecutionLeases.createdAt), asc(taskExecutionLeases.id))
      .limit(input.limit + 1),
    database
      .select()
      .from(taskExecutionCancellationIntents)
      .where(
        and(
          eq(taskExecutionCancellationIntents.companyId, input.companyId),
          eq(taskExecutionCancellationIntents.taskId, input.taskId),
          eq(taskExecutionCancellationIntents.runId, input.runId),
        ),
      )
      .orderBy(
        asc(taskExecutionCancellationIntents.createdAt),
        asc(taskExecutionCancellationIntents.id),
      )
      .limit(input.limit + 1),
    database
      .select()
      .from(acpPromptAccounting)
      .where(
        and(
          eq(acpPromptAccounting.companyId, input.companyId),
          eq(acpPromptAccounting.taskId, input.taskId),
          eq(acpPromptAccounting.runId, input.runId),
        ),
      )
      .orderBy(asc(acpPromptAccounting.createdAt), asc(acpPromptAccounting.id))
      .limit(input.limit + 1),
    database
      .select()
      .from(costEvents)
      .where(
        and(
          eq(costEvents.companyId, input.companyId),
          eq(costEvents.taskId, input.taskId),
          eq(costEvents.runId, input.runId),
        ),
      )
      .orderBy(asc(costEvents.createdAt), asc(costEvents.id))
      .limit(input.limit + 1),
    database
      .select({
        id: activityLog.id,
        actorType: activityLog.actorType,
        actorId: activityLog.actorId,
        action: activityLog.action,
        entityType: activityLog.entityType,
        entityId: activityLog.entityId,
        agentId: activityLog.agentId,
        responsibleUserId: activityLog.responsibleUserId,
        details: activityLog.details,
        createdAt: activityLog.createdAt,
      })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, input.companyId),
          eq(activityLog.runId, input.runId),
        ),
      )
      .orderBy(asc(activityLog.createdAt), asc(activityLog.id))
      .limit(input.limit + 1),
    database
      .select({
        commentId: taskCommentProjectionSources.commentId,
        messageId: taskCommentProjectionSources.messageId,
        sourceKind: taskCommentProjectionSources.sourceKind,
        projectedEventSeq: taskCommentProjectionSources.projectedEventSeq,
      })
      .from(taskCommentProjectionSources)
      .where(
        and(
          eq(taskCommentProjectionSources.companyId, input.companyId),
          eq(taskCommentProjectionSources.taskId, input.taskId),
          eq(taskCommentProjectionSources.runId, input.runId),
          inArray(taskCommentProjectionSources.sourceKind, [
            "run_output",
            "run_progress",
            "task_update",
          ]),
        ),
      )
      .orderBy(
        asc(taskCommentProjectionSources.projectedEventSeq),
        asc(taskCommentProjectionSources.commentId),
      )
      .limit(input.limit + 1),
    database
      .select()
      .from(taskExecutionFinalizations)
      .where(
        and(
          eq(taskExecutionFinalizations.companyId, input.companyId),
          eq(taskExecutionFinalizations.runId, input.runId),
        ),
      )
      .limit(2),
  ]);

  if (finalizationRows.length > 1) {
    throw new TaskExecutionRunInvariantViolation(
      "run joined detail found duplicate finalizations",
    );
  }
  const finalization = finalizationRows[0] ?? null;
  const [promptDependencies, updateDependencies, liveness] = finalization
    ? await Promise.all([
        database
          .select()
          .from(taskExecutionFinalizationPromptDependencies)
          .where(
            eq(
              taskExecutionFinalizationPromptDependencies.finalizationId,
              finalization.id,
            ),
          )
          .orderBy(
            asc(taskExecutionFinalizationPromptDependencies.dependencyOrdinal),
          )
          .limit(input.limit + 1),
        database
          .select()
          .from(taskExecutionFinalizationUpdateDependencies)
          .where(
            eq(
              taskExecutionFinalizationUpdateDependencies.finalizationId,
              finalization.id,
            ),
          )
          .orderBy(
            asc(taskExecutionFinalizationUpdateDependencies.dependencyOrdinal),
          )
          .limit(input.limit + 1),
        database
          .select()
          .from(taskExecutionRunLivenessFacts)
          .where(
            and(
              eq(taskExecutionRunLivenessFacts.companyId, input.companyId),
              eq(taskExecutionRunLivenessFacts.runId, input.runId),
            ),
          )
          .limit(2),
      ])
    : ([[], [], []] as const);
  if (liveness.length > 1) {
    throw new TaskExecutionRunInvariantViolation(
      "run joined detail found duplicate liveness facts",
    );
  }
  const terminal = TERMINAL_RUN_STATUSES.has(run.status);
  if (
    terminal !==
    (finalization !== null && finalization.id === run.terminalFinalizationId)
  ) {
    throw new TaskExecutionRunInvariantViolation(
      "run joined detail does not match its terminal finalization",
    );
  }
  if (finalization) {
    if (run.kind !== "productive") {
      if (finalization.runLivenessFactId !== null || liveness.length !== 0) {
        throw new TaskExecutionRunInvariantViolation(
          "nonproductive finalization cannot carry productive-run liveness",
        );
      }
    } else {
      const livenessFact = liveness[0] ?? null;
      if (
        finalization.runLivenessFactId === null ||
        !livenessFact ||
        livenessFact.id !== finalization.runLivenessFactId ||
        livenessFact.runId !== run.runId ||
        livenessFact.companyId !== run.companyId
      ) {
        throw new TaskExecutionRunInvariantViolation(
          "productive run finalization is missing its exact liveness fact",
        );
      }
    }
  }

  const refs = boundedRecords(refRows, input.limit);
  assertJoinedRunShape({
    run,
    controlRows,
    refRows: refs.items,
    refsTruncated: refs.truncated,
  });
  const redactedEvents = sessionEventPage.items.map(({ row }) => ({
    id: row.id,
    seq: row.seq,
    type: row.type,
    data: redactTaskSessionPublicationValue(row.data) as unknown as Record<
      string,
      unknown
    >,
    createdAt: row.createdAt,
  }));
  const redactedMessages = sessionMessagePage.items.map(({ row }) => ({
    id: row.id,
    seq: row.seq,
    modelStateSeq: row.modelStateSeq,
    type: row.type,
    data: redactTaskSessionPublicationValue(row.data) as unknown as Record<
      string,
      unknown
    >,
    timeCreated: row.timeCreated,
    timeUpdated: row.timeUpdated,
  }));
  const redactedActivity = activityRows.map((row) =>
    redactTaskSessionPublicationValue(row),
  );
  return {
    run,
    control: controlRows[0] ?? null,
    refs,
    segments: boundedRecords(segmentRows, input.limit),
    sessionEvents: {
      items: redactedEvents,
      truncated: sessionEventPage.nextCursor !== null,
      nextCursor: sessionEventPage.nextCursor,
    },
    sessionMessages: {
      items: redactedMessages,
      truncated: sessionMessagePage.nextCursor !== null,
      nextCursor: sessionMessagePage.nextCursor,
    },
    attempts: boundedRecords(attemptRows, input.limit),
    retrySchedules: boundedRecords(retryScheduleRows, input.limit),
    leases: boundedRecords(leaseRows, input.limit),
    cancellations: boundedRecords(cancellationRows, input.limit),
    accounting: boundedRecords(accountingRows, input.limit),
    costs: boundedRecords(costRows, input.limit),
    activity: boundedRecords(redactedActivity, input.limit),
    outputComments: boundedRecords(
      outputCommentRows.map((row) => ({
        commentId: row.commentId,
        messageId: row.messageId,
        sourceKind:
          row.sourceKind as TaskExecutionRunOutputCommentLink["sourceKind"],
        projectedEventSeq: Number(row.projectedEventSeq),
      })),
      input.limit,
    ),
    finalization: finalization
      ? {
          record: finalization,
          promptDependencies: boundedRecords(promptDependencies, input.limit),
          updateDependencies: boundedRecords(updateDependencies, input.limit),
          liveness: liveness[0] ?? null,
        }
      : null,
  };
}

/**
 * Lock and validate the sole run envelope before P14 locks its prompt-specific
 * control/attempt/lease/capability/correlation graph. No caller may query the
 * run table to reproduce this decision.
 */
export async function lockSteerableRunInTransaction(
  transaction: TaskSessionDbTransaction,
  input: TaskExecutionRunIdentity & {
    readonly ownershipEpoch: number;
    readonly targetAgentId: string;
  },
): Promise<SteerableTaskExecutionRun> {
  const rows = await transaction
    .select()
    .from(taskExecutionRuns)
    .where(
      and(
        eq(taskExecutionRuns.id, input.runId),
        eq(taskExecutionRuns.companyId, input.companyId),
        eq(taskExecutionRuns.taskId, input.taskId),
      ),
    )
    .limit(1)
    .for("update");
  const run = rows[0];
  if (
    !run ||
    run.status !== "running" ||
    run.ownershipEpoch !== input.ownershipEpoch ||
    run.targetAgentId !== input.targetAgentId ||
    run.currentAttemptId === null ||
    run.currentLeaseId === null ||
    run.terminalFinalizationId !== null ||
    run.startedAt === null ||
    run.finishedAt !== null ||
    (run.kind === "productive" &&
      (run.executionMode !== "owner" ||
        run.taskExecutionAuthorityId === null ||
        run.consultExecutionId !== null)) ||
    (run.kind === "consult" &&
      (run.executionMode !== "consult" ||
        run.taskExecutionAuthorityId !== null ||
        run.consultExecutionId === null))
  ) {
    throw new TaskExecutionRunInvariantViolation(
      "Selected run is not the exact active steerable task execution",
    );
  }
  return {
    companyId: run.companyId,
    taskId: run.taskId,
    runId: run.id,
    sessionId: run.sessionId,
    executionScopeId: run.executionScopeId,
    kind: run.kind,
    status: run.status,
    ownershipEpoch: run.ownershipEpoch,
    targetAgentId: run.targetAgentId,
    adapterConfigRevisionId: run.adapterConfigRevisionId,
    executionWorkspaceBindingId: run.executionWorkspaceBindingId,
    executionMode: run.executionMode,
    taskExecutionAuthorityId: run.taskExecutionAuthorityId,
    consultExecutionId: run.consultExecutionId,
    currentAttemptId: run.currentAttemptId,
    currentLeaseId: run.currentLeaseId,
    cancellationIntentId: run.cancellationIntentId,
    terminalFinalizationId: null,
    startedAt: run.startedAt,
    finishedAt: null,
  };
}

/** Attach the exact P14 cancellation intent without taking ownership of it. */
export async function attachSteeringCancellationInTransaction(
  transaction: TaskSessionDbTransaction,
  input: TaskExecutionRunIdentity & {
    readonly expectedAttemptId: string;
    readonly expectedLeaseId: string;
    readonly cancellationIntentId: string;
    readonly at: Date;
  },
): Promise<void> {
  const changed = await transaction
    .update(taskExecutionRuns)
    .set({
      cancellationIntentId: input.cancellationIntentId,
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
    .returning({ id: taskExecutionRuns.id });
  if (!changed[0]) {
    throw new TaskExecutionRunInvariantViolation(
      "Steering cancellation lost the exact active run attempt",
    );
  }
}

/**
 * Clear only the settled P14 attempt and its exact cancellation pointer
 * before the positive steering segment is rebound to a new attempt.
 */
export async function clearSteeringCancellationAndAttemptInTransaction(
  transaction: TaskSessionDbTransaction,
  input: TaskExecutionRunIdentity & {
    readonly cancellationIntentId: string;
    readonly expectedAttemptId: string;
    readonly expectedLeaseId: string;
    readonly at: Date;
  },
): Promise<void> {
  const changed = await transaction
    .update(taskExecutionRuns)
    .set({
      currentAttemptId: null,
      currentLeaseId: null,
      cancellationIntentId: null,
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
        eq(taskExecutionRuns.cancellationIntentId, input.cancellationIntentId),
        isNull(taskExecutionRuns.terminalFinalizationId),
        isNull(taskExecutionRuns.finishedAt),
      ),
    )
    .returning({ id: taskExecutionRuns.id });
  if (!changed[0]) {
    throw new TaskExecutionRunInvariantViolation(
      "Steering rebound lost the exact cancelled run attempt",
    );
  }
}

/**
 * Re-lock the same active envelope after the cancellation transaction has
 * settled and detached its old prompt attempt. This is the final lifecycle
 * fence before a persisted positive segment becomes resumable.
 */
export async function lockReboundSteeringRunInTransaction(
  transaction: TaskSessionDbTransaction,
  input: TaskExecutionRunIdentity & {
    readonly ownershipEpoch: number;
    readonly targetAgentId: string;
  },
): Promise<ReboundSteerableTaskExecutionRun> {
  const rows = await transaction
    .select()
    .from(taskExecutionRuns)
    .where(
      and(
        eq(taskExecutionRuns.id, input.runId),
        eq(taskExecutionRuns.companyId, input.companyId),
        eq(taskExecutionRuns.taskId, input.taskId),
      ),
    )
    .limit(1)
    .for("update");
  const run = rows[0];
  if (
    !run ||
    run.status !== "running" ||
    run.ownershipEpoch !== input.ownershipEpoch ||
    run.targetAgentId !== input.targetAgentId ||
    run.currentAttemptId !== null ||
    run.currentLeaseId !== null ||
    run.cancellationIntentId !== null ||
    run.terminalFinalizationId !== null ||
    run.startedAt === null ||
    run.finishedAt !== null ||
    (run.kind === "productive" &&
      (run.executionMode !== "owner" ||
        run.taskExecutionAuthorityId === null ||
        run.consultExecutionId !== null)) ||
    (run.kind === "consult" &&
      (run.executionMode !== "consult" ||
        run.taskExecutionAuthorityId !== null ||
        run.consultExecutionId === null))
  ) {
    throw new TaskExecutionRunInvariantViolation(
      "Steering segment cannot resume against the selected run lifecycle",
    );
  }
  return {
    companyId: run.companyId,
    taskId: run.taskId,
    runId: run.id,
    sessionId: run.sessionId,
    executionScopeId: run.executionScopeId,
    kind: run.kind,
    status: run.status,
    ownershipEpoch: run.ownershipEpoch,
    targetAgentId: run.targetAgentId,
    adapterConfigRevisionId: run.adapterConfigRevisionId,
    executionWorkspaceBindingId: run.executionWorkspaceBindingId,
    executionMode: run.executionMode,
    taskExecutionAuthorityId: run.taskExecutionAuthorityId,
    consultExecutionId: run.consultExecutionId,
    currentAttemptId: null,
    currentLeaseId: null,
    cancellationIntentId: null,
    terminalFinalizationId: null,
    startedAt: run.startedAt,
    finishedAt: null,
  };
}

export type TaskExecutionSteeringActor =
  | { readonly kind: "user"; readonly userId: string }
  | { readonly kind: "agent"; readonly agentId: string };

/**
 * The sole selector-bearing continuation request. There is intentionally no
 * Session id, target ACP id, alias, or fallback selector in this contract.
 */
export interface RequestTaskExecutionSteeringInput {
  readonly companyId: string;
  readonly taskId: string;
  readonly ownershipEpoch: number;
  readonly runId: string;
  readonly targetAgentId: string;
  readonly exactMessage: string;
  readonly sourceCommentId: string;
  readonly sourceMessageId: string;
  readonly sourceInputId: string | null;
  readonly actor: TaskExecutionSteeringActor;
}

export interface RequestedTaskExecutionSteering {
  readonly companyId: string;
  readonly taskId: string;
  readonly ownershipEpoch: number;
  readonly runId: string;
  readonly targetAgentId: string;
  readonly refId: string;
  readonly refOrdinal: number;
  readonly interruptedSegmentOrdinal: number;
  readonly segmentOrdinal: number;
  readonly sourceCommentId: string;
  readonly sourceMessageId: string;
  readonly sourceInputId: string | null;
  readonly cancellationIntentId: string;
  readonly cancellation: TaskExecutionAttemptCancellationSignal;
}

export interface ReboundTaskExecutionSteering {
  readonly companyId: string;
  readonly taskId: string;
  readonly ownershipEpoch: number;
  readonly runId: string;
  readonly targetAgentId: string;
  readonly refId: string;
  readonly refOrdinal: number;
  readonly segmentOrdinal: number;
}

export type TaskExecutionSteeringCancellationSettlement =
  | {
      readonly kind: "settled";
      readonly cancellationIntentId: string;
    }
  | {
      /** The exact old prompt is still open; durable recovery may retry. */
      readonly kind: "pending";
      readonly cancellationIntentId: string;
    }
  | {
      readonly kind: "ambiguous";
      readonly cancellationIntentId: string;
      readonly reason: string;
    };

export type PendingTaskExecutionSteeringForSource =
  | {
      readonly kind: "requested";
      readonly request: RequestedTaskExecutionSteering;
    }
  | {
      readonly kind: "rebound";
      readonly rebound: ReboundTaskExecutionSteering;
    }
  | { readonly kind: "resumed" }
  | {
      readonly kind: "terminal";
      readonly result: TaskExecutionSteeringResult;
    }
  | { readonly kind: "ambiguous"; readonly reason: string };

export type ContinuedPendingTaskExecutionSteering =
  | {
      readonly kind: "continued_requested";
      readonly rebound: ReboundTaskExecutionSteering;
    }
  | {
      readonly kind: "continued_rebound";
      readonly rebound: ReboundTaskExecutionSteering;
    }
  | {
      readonly kind: "already_resumed";
    }
  | {
      readonly kind: "already_settled";
      readonly result: TaskExecutionSteeringResult;
    }
  | {
      /** The source remains durably requested and will be retried by recovery. */
      readonly kind: "still_pending";
    };

export interface RecoverableTaskExecutionSteeringSource {
  readonly companyId: string;
  readonly taskId: string;
  readonly sourceCommentId: string;
}

/**
 * Transactional DB owner for P14. `requestInTransaction` locks the exact run,
 * current run-control tuple, prompt, attempt/lease, capability, and steering
 * correlation; appends one positive segment; revokes the old capability; and
 * persists the exact-attempt steering cancellation intent in the caller's
 * comment transaction.
 */
export interface TaskExecutionSteeringRepository {
  requestInTransaction(
    transaction: TaskSessionDbTransaction,
    input: RequestTaskExecutionSteeringInput,
  ): Promise<RequestedTaskExecutionSteering>;
  recordCancellationSignal(input: {
    readonly request: RequestedTaskExecutionSteering;
    readonly delivered: boolean;
  }): Promise<void>;
  awaitCancellationSettlement(
    request: RequestedTaskExecutionSteering,
  ): Promise<TaskExecutionSteeringCancellationSettlement>;
  markAmbiguous(input: {
    readonly request: RequestedTaskExecutionSteering;
    readonly reason: string;
  }): Promise<void>;
  rebindAfterCancellation(
    request: RequestedTaskExecutionSteering,
  ): Promise<ReboundTaskExecutionSteering>;
  markResumeReady(rebound: ReboundTaskExecutionSteering): Promise<void>;
  findPendingForSource(input: {
    readonly companyId: string;
    readonly taskId: string;
    readonly sourceCommentId: string;
  }): Promise<PendingTaskExecutionSteeringForSource>;
  listRecoverableSources(
    limit: number,
  ): Promise<readonly RecoverableTaskExecutionSteeringSource[]>;
}

export interface TaskExecutionSteeringCancellationPort {
  /** Abort only the exact fenced attempt. False may mean natural settlement won. */
  signalAttemptCancellation(
    input: TaskExecutionAttemptCancellationSignal,
  ): boolean;
}

export interface TaskExecutionSteeringResumePort {
  /**
   * Schedule the persisted positive segment on the same Paperclip run. The
   * attempt executor resolves native resume or new-session launch from canonical state.
   */
  resumeSteering(input: ReboundTaskExecutionSteering): Promise<void>;
}

export interface TaskExecutionRunService {
  createRun(
    transaction: TaskSessionDbTransaction,
    input: CreateTaskExecutionRunInput,
  ): Promise<CreatedTaskExecutionRun>;
  lockRun(
    transaction: TaskSessionDbTransaction,
    input: TaskExecutionRunIdentity,
  ): Promise<TaskExecutionRunEnvelope>;
  readRun(
    input: TaskExecutionRunIdentity,
  ): Promise<TaskExecutionRunEnvelope | null>;
  lockActiveRunsForAgentsInTransaction(
    transaction: TaskSessionDbTransaction,
    input: {
      readonly companyId: string;
      readonly agentIds: readonly string[];
    },
  ): Promise<readonly TaskExecutionRunEnvelope[]>;
  lockActiveRunsForScopeInTransaction(
    transaction: TaskSessionDbTransaction,
    input:
      | {
          readonly companyId: string;
          readonly taskId: string;
          readonly ownershipEpoch: number;
        }
      | {
          readonly companyId: string;
          readonly taskId: string;
          readonly refIds: readonly string[];
        },
  ): Promise<readonly TaskExecutionRunEnvelope[]>;
  lockActiveAgentRunsForTaskEpochInTransaction(
    transaction: TaskSessionDbTransaction,
    input: {
      readonly companyId: string;
      readonly taskId: string;
      readonly ownershipEpoch: number;
    },
  ): Promise<readonly TaskExecutionRunEnvelope[]>;
  lockActiveRunsForBudgetScopeInTransaction(
    transaction: TaskSessionDbTransaction,
    input: {
      readonly companyId: string;
      readonly scopeType: "company" | "project" | "agent";
      readonly scopeId: string;
    },
  ): Promise<readonly TaskExecutionRunEnvelope[]>;
  listResumedAgentSteeringLivenessActionsInTransaction(
    transaction: TaskSessionDbTransaction,
    input: ResumedAgentSteeringLivenessSearch,
  ): Promise<readonly ResumedAgentSteeringLivenessSource[]>;
  transitionRunStatus(
    transaction: TaskSessionDbTransaction,
    input: TransitionTaskExecutionRunStatusInput,
  ): Promise<TaskExecutionRunEnvelope>;
  attachAttempt(
    transaction: TaskSessionDbTransaction,
    input: AttachTaskExecutionRunAttemptInput,
  ): Promise<TaskExecutionRunEnvelope>;
  detachAttempt(
    transaction: TaskSessionDbTransaction,
    input: DetachTaskExecutionRunAttemptInput,
  ): Promise<TaskExecutionRunEnvelope>;
  attachCancellation(
    transaction: TaskSessionDbTransaction,
    input: AttachTaskExecutionRunCancellationInput,
  ): Promise<TaskExecutionRunEnvelope>;
  detachCancellation(
    transaction: TaskSessionDbTransaction,
    input: DetachTaskExecutionRunCancellationInput,
  ): Promise<TaskExecutionRunEnvelope>;
  attachFinalization(
    transaction: TaskSessionDbTransaction,
    input: AttachTaskExecutionRunFinalizationInput,
  ): Promise<TaskExecutionRunEnvelope>;
  listForTask(input: {
    readonly companyId: string;
    readonly taskId: string;
    readonly statuses?: readonly TaskExecutionRunStatus[];
    readonly cursor?: TaskExecutionRunListCursor | null;
    readonly limit: number;
  }): Promise<TaskExecutionRunListPage>;
  listForAgent(input: {
    readonly companyId: string;
    readonly targetAgentId: string;
    readonly statuses?: readonly TaskExecutionRunStatus[];
    readonly cursor?: TaskExecutionRunListCursor | null;
    readonly limit: number;
  }): Promise<TaskExecutionRunListPage>;
  listForActivity(input: {
    readonly companyId: string;
    readonly statuses?: readonly TaskExecutionRunStatus[];
    readonly cursor?: TaskExecutionRunListCursor | null;
    readonly limit: number;
  }): Promise<TaskExecutionRunListPage>;
  listForWorkTimeline(input: {
    readonly companyId: string;
    readonly taskId: string;
    readonly statuses?: readonly TaskExecutionRunStatus[];
    readonly cursor?: TaskExecutionRunListCursor | null;
    readonly limit: number;
  }): Promise<TaskExecutionRunListPage>;
  readJoinedRunDetail(
    input: ReadJoinedTaskExecutionRunDetailInput,
  ): Promise<JoinedTaskExecutionRunDetail | null>;
  requestSteeringInTransaction(
    transaction: TaskSessionDbTransaction,
    input: RequestTaskExecutionSteeringInput,
  ): Promise<RequestedTaskExecutionSteering>;
  continuePendingSteeringForSource(input: {
    readonly companyId: string;
    readonly taskId: string;
    readonly sourceCommentId: string;
  }): Promise<ContinuedPendingTaskExecutionSteering>;
  reconcilePendingSteering(limit?: number): Promise<{
    readonly discovered: number;
    readonly continued: number;
    readonly pending: number;
    readonly sourceCommentIds: readonly string[];
  }>;
}

export class TaskExecutionSteeringRejected extends Error {
  readonly code = "task_execution_steering_rejected";

  constructor(
    message: string,
    readonly reason:
      | "invalid_request"
      | "cancellation_ambiguous"
      | "rebound_identity_mismatch"
      | "persisted_ambiguous",
  ) {
    super(message);
    this.name = "TaskExecutionSteeringRejected";
  }
}

function exactIdentity(value: string, label: string): void {
  if (value.length === 0 || value !== value.trim()) {
    throw new TaskExecutionSteeringRejected(
      `${label} must be exact and non-empty`,
      "invalid_request",
    );
  }
}

function validateRequest(input: RequestTaskExecutionSteeringInput): void {
  for (const [label, value] of [
    ["company id", input.companyId],
    ["task id", input.taskId],
    ["run id", input.runId],
    ["target agent id", input.targetAgentId],
    ["source comment id", input.sourceCommentId],
    ["source message id", input.sourceMessageId],
  ] as const) {
    exactIdentity(value, label);
  }
  if (input.actor.kind === "user") {
    if (input.sourceInputId === null) {
      throw new TaskExecutionSteeringRejected(
        "human steering requires its exact source input",
        "invalid_request",
      );
    }
    exactIdentity(input.sourceInputId, "source input id");
    if (input.sourceInputId !== input.sourceMessageId) {
      throw new TaskExecutionSteeringRejected(
        "human steering source message and input must be identical",
        "invalid_request",
      );
    }
  } else if (input.sourceInputId !== null) {
    throw new TaskExecutionSteeringRejected(
      "agent steering is a synthetic Session message and has no source input",
      "invalid_request",
    );
  }
  if (input.ownershipEpoch < 1 || !Number.isSafeInteger(input.ownershipEpoch)) {
    throw new TaskExecutionSteeringRejected(
      "ownership epoch must be a positive integer",
      "invalid_request",
    );
  }
  if (input.exactMessage.length === 0) {
    throw new TaskExecutionSteeringRejected(
      "steering message must be non-empty",
      "invalid_request",
    );
  }
  exactIdentity(
    input.actor.kind === "user" ? input.actor.userId : input.actor.agentId,
    `${input.actor.kind} actor id`,
  );
}

function sameReboundIdentity(
  request: RequestedTaskExecutionSteering,
  rebound: ReboundTaskExecutionSteering,
): boolean {
  return (
    request.companyId === rebound.companyId &&
    request.taskId === rebound.taskId &&
    request.ownershipEpoch === rebound.ownershipEpoch &&
    request.runId === rebound.runId &&
    request.targetAgentId === rebound.targetAgentId &&
    request.refId === rebound.refId &&
    request.refOrdinal === rebound.refOrdinal &&
    request.segmentOrdinal === rebound.segmentOrdinal
  );
}

/**
 * Canonical P14 orchestration. The comment/source and requested segment commit
 * first; the worker then signals the exact in-memory attempt, waits for the
 * old prompt's unambiguous protocol settlement, rebinds the
 * positive segment, and only then schedules its ACP continuation. It never
 * creates another Paperclip run and never builds context itself.
 */
export function createTaskExecutionRunService(options: {
  readonly database: Db;
  readonly taskSessionStore: TaskSessionStore;
  readonly repository: TaskExecutionSteeringRepository;
  readonly cancellation: TaskExecutionSteeringCancellationPort;
  readonly resume: TaskExecutionSteeringResumePort;
  readonly steeringResults: Pick<
    TaskExecutionSteeringResultBroker,
    "rebind" | "publish"
  >;
}): TaskExecutionRunService {
  async function continueRequestedSteering(
    request: RequestedTaskExecutionSteering,
  ): Promise<ReboundTaskExecutionSteering | null> {
    const continuationIdentity = {
      companyId: request.companyId,
      taskId: request.taskId,
      runId: request.runId,
      refId: request.refId,
      refOrdinal: request.refOrdinal,
      segmentOrdinal: request.segmentOrdinal,
    } as const;
    if (request.interruptedSegmentOrdinal > 0) {
      options.steeringResults.rebind(
        {
          ...continuationIdentity,
          segmentOrdinal: request.interruptedSegmentOrdinal,
        },
        continuationIdentity,
      );
    }
    // A false signal is not itself failure: the old prompt may have settled
    // naturally between the transaction and the post-commit signal.
    const delivered = options.cancellation.signalAttemptCancellation(
      request.cancellation,
    );
    await options.repository.recordCancellationSignal({
      request,
      delivered,
    });
    const settlement =
      await options.repository.awaitCancellationSettlement(request);
    if (settlement.kind === "pending") return null;
    if (settlement.kind === "ambiguous") {
      await options.repository.markAmbiguous({
        request,
        reason: settlement.reason,
      });
      throw new TaskExecutionSteeringRejected(
        "The selected run's current prompt did not settle unambiguously",
        "cancellation_ambiguous",
      );
    }
    const rebound = await options.repository.rebindAfterCancellation(request);
    if (!sameReboundIdentity(request, rebound)) {
      await options.repository.markAmbiguous({
        request,
        reason: "steering rebound crossed the requested run segment",
      });
      throw new TaskExecutionSteeringRejected(
        "Steering rebound crossed the requested run segment",
        "rebound_identity_mismatch",
      );
    }
    await options.repository.markResumeReady(rebound);
    await options.resume.resumeSteering(rebound);
    return rebound;
  }

  function publishContinuationFailure(
    identity: {
      readonly companyId: string;
      readonly taskId: string;
      readonly runId: string;
      readonly refId: string;
      readonly refOrdinal: number;
      readonly segmentOrdinal: number;
    },
    error: unknown,
  ): void {
    options.steeringResults.publish({
      companyId: identity.companyId,
      taskId: identity.taskId,
      runId: identity.runId,
      refId: identity.refId,
      refOrdinal: identity.refOrdinal,
      segmentOrdinal: identity.segmentOrdinal,
      outcome: "failed",
      response: "",
      reason:
        error instanceof Error ? error.message : "Steering continuation failed",
    });
  }

  async function continueReboundForSource(
    source: RecoverableTaskExecutionSteeringSource,
    rebound: ReboundTaskExecutionSteering,
  ): Promise<ContinuedPendingTaskExecutionSteering> {
    try {
      await options.repository.markResumeReady(rebound);
    } catch (error) {
      const latest = await options.repository.findPendingForSource(source);
      if (latest.kind === "resumed") return { kind: "already_resumed" };
      if (latest.kind === "terminal") {
        return { kind: "already_settled", result: latest.result };
      }
      throw error;
    }
    await options.resume.resumeSteering(rebound);
    return { kind: "continued_rebound", rebound };
  }

  async function readConvergedSteeringSource(
    source: RecoverableTaskExecutionSteeringSource,
  ): Promise<ContinuedPendingTaskExecutionSteering | null> {
    const latest = await options.repository.findPendingForSource(source);
    if (latest.kind === "resumed") return { kind: "already_resumed" };
    if (latest.kind === "terminal") {
      return { kind: "already_settled", result: latest.result };
    }
    if (latest.kind === "rebound") {
      return continueReboundForSource(source, latest.rebound);
    }
    if (latest.kind === "ambiguous") {
      throw new TaskExecutionSteeringRejected(
        latest.reason,
        "persisted_ambiguous",
      );
    }
    return null;
  }

  const service: TaskExecutionRunService = {
    createRun(transaction, input) {
      return createTaskExecutionRunInTransaction(transaction, input);
    },

    lockRun(transaction, input) {
      return lockTaskExecutionRunInTransaction(transaction, input);
    },

    readRun(input) {
      return readTaskExecutionRun(options.database, input);
    },

    async lockActiveRunsForAgentsInTransaction(transaction, input) {
      assertExactRunIdentifier(input.companyId, "company id");
      const agentIds = [...new Set(input.agentIds)];
      for (const agentId of agentIds) {
        assertExactRunIdentifier(agentId, "target agent id");
      }
      if (agentIds.length === 0) return Object.freeze([]);
      const rows = await transaction
        .select()
        .from(taskExecutionRuns)
        .where(
          and(
            eq(taskExecutionRuns.companyId, input.companyId),
            inArray(taskExecutionRuns.targetAgentId, agentIds),
            inArray(taskExecutionRuns.status, [
              "queued",
              "running",
              "scheduled_retry",
            ]),
          ),
        )
        .orderBy(asc(taskExecutionRuns.createdAt), asc(taskExecutionRuns.id))
        .for("update");
      const runs = rows.map(projectRunEnvelope);
      for (const run of runs) assertRunEnvelopeInvariant(run);
      return Object.freeze(runs);
    },

    async lockActiveRunsForScopeInTransaction(transaction, input) {
      assertExactRunIdentifier(input.companyId, "company id");
      assertExactRunIdentifier(input.taskId, "task id");
      const byEpoch = "ownershipEpoch" in input;
      if (
        byEpoch &&
        (!Number.isSafeInteger(input.ownershipEpoch) ||
          input.ownershipEpoch < 1)
      ) {
        throw new TaskExecutionRunInvariantViolation(
          "ownership epoch must be a positive integer",
        );
      }
      const refIds = byEpoch ? [] : [...new Set(input.refIds)];
      for (const refId of refIds) {
        assertExactRunIdentifier(refId, "execution ref id");
      }
      if (!byEpoch && refIds.length === 0) return Object.freeze([]);
      const rows = await transaction
        .select()
        .from(taskExecutionRuns)
        .where(
          and(
            eq(taskExecutionRuns.companyId, input.companyId),
            eq(taskExecutionRuns.taskId, input.taskId),
            inArray(taskExecutionRuns.status, [
              "queued",
              "running",
              "scheduled_retry",
            ]),
            byEpoch
              ? eq(taskExecutionRuns.ownershipEpoch, input.ownershipEpoch)
              : sql`exists (
                  select 1
                  from ${taskExecutionRunRefs}
                  where ${taskExecutionRunRefs.companyId} = ${taskExecutionRuns.companyId}
                    and ${taskExecutionRunRefs.taskId} = ${taskExecutionRuns.taskId}
                    and ${taskExecutionRunRefs.runId} = ${taskExecutionRuns.id}
                    and ${inArray(taskExecutionRunRefs.refId, refIds)}
                )`,
          ),
        )
        .orderBy(asc(taskExecutionRuns.createdAt), asc(taskExecutionRuns.id))
        .for("update");
      const runs = rows.map(projectRunEnvelope);
      for (const run of runs) assertRunEnvelopeInvariant(run);
      return Object.freeze(runs);
    },

    async lockActiveAgentRunsForTaskEpochInTransaction(transaction, input) {
      assertExactRunIdentifier(input.companyId, "company id");
      assertExactRunIdentifier(input.taskId, "task id");
      if (
        !Number.isSafeInteger(input.ownershipEpoch) ||
        input.ownershipEpoch < 1
      ) {
        throw new TaskExecutionRunInvariantViolation(
          "ownership epoch must be a positive integer",
        );
      }
      const rows = await transaction
        .select()
        .from(taskExecutionRuns)
        .where(
          and(
            eq(taskExecutionRuns.companyId, input.companyId),
            eq(taskExecutionRuns.taskId, input.taskId),
            eq(taskExecutionRuns.ownershipEpoch, input.ownershipEpoch),
            inArray(taskExecutionRuns.kind, ["productive", "consult"]),
            inArray(taskExecutionRuns.status, [
              "queued",
              "scheduled_retry",
              "running",
            ]),
          ),
        )
        .orderBy(asc(taskExecutionRuns.createdAt), asc(taskExecutionRuns.id))
        .for("update");
      const runs = rows.map(projectRunEnvelope);
      for (const run of runs) assertRunEnvelopeInvariant(run);
      return Object.freeze(runs);
    },

    async lockActiveRunsForBudgetScopeInTransaction(transaction, input) {
      assertExactRunIdentifier(input.companyId, "company id");
      assertExactRunIdentifier(input.scopeId, "budget scope id");
      if (input.scopeType === "company" && input.scopeId !== input.companyId) {
        throw new TaskExecutionRunInvariantViolation(
          "company budget scope must target its exact company",
        );
      }
      const rows = await transaction
        .select()
        .from(taskExecutionRuns)
        .where(
          and(
            eq(taskExecutionRuns.companyId, input.companyId),
            inArray(taskExecutionRuns.status, [
              "queued",
              "running",
              "scheduled_retry",
            ]),
            input.scopeType === "company"
              ? undefined
              : input.scopeType === "project"
                ? sql`exists (
                    select 1
                    from ${tasks}
                    where ${tasks.companyId} = ${taskExecutionRuns.companyId}
                      and ${tasks.id} = ${taskExecutionRuns.taskId}
                      and ${tasks.projectId} = ${input.scopeId}
                  )`
                : eq(taskExecutionRuns.targetAgentId, input.scopeId),
          ),
        )
        .orderBy(asc(taskExecutionRuns.createdAt), asc(taskExecutionRuns.id))
        .for("update");
      return Object.freeze(rows.map(projectRunEnvelope));
    },

    listResumedAgentSteeringLivenessActionsInTransaction,

    transitionRunStatus(transaction, input) {
      return transitionTaskExecutionRunStatusInTransaction(transaction, input);
    },

    attachAttempt(transaction, input) {
      return attachTaskExecutionRunAttemptInTransaction(transaction, input);
    },

    detachAttempt(transaction, input) {
      return detachTaskExecutionRunAttemptInTransaction(transaction, input);
    },

    attachCancellation(transaction, input) {
      return attachTaskExecutionRunCancellationInTransaction(
        transaction,
        input,
      );
    },

    detachCancellation(transaction, input) {
      return detachTaskExecutionRunCancellationInTransaction(
        transaction,
        input,
      );
    },

    attachFinalization(transaction, input) {
      return attachTaskExecutionRunFinalizationInTransaction(
        transaction,
        input,
      );
    },

    listForTask(input) {
      return listTaskExecutionRunsForTask(options.database, input);
    },

    listForAgent(input) {
      return listTaskExecutionRunsForAgent(options.database, input);
    },

    listForActivity(input) {
      return listTaskExecutionRunsForActivity(options.database, input);
    },

    listForWorkTimeline(input) {
      return listTaskExecutionRunsForWorkTimeline(options.database, input);
    },

    readJoinedRunDetail(input) {
      return readJoinedTaskExecutionRunDetail(
        options.database,
        options.taskSessionStore,
        input,
      );
    },

    async requestSteeringInTransaction(transaction, input) {
      validateRequest(input);
      return options.repository.requestInTransaction(transaction, input);
    },

    async continuePendingSteeringForSource(input) {
      exactIdentity(input.companyId, "company id");
      exactIdentity(input.taskId, "task id");
      exactIdentity(input.sourceCommentId, "source comment id");
      const pending = await options.repository.findPendingForSource(input);
      if (pending.kind === "resumed") {
        return { kind: "already_resumed" };
      }
      if (pending.kind === "terminal") {
        return { kind: "already_settled", result: pending.result };
      }
      if (pending.kind === "ambiguous") {
        throw new TaskExecutionSteeringRejected(
          pending.reason,
          "persisted_ambiguous",
        );
      }
      if (pending.kind === "requested") {
        try {
          const rebound = await continueRequestedSteering(pending.request);
          return rebound === null
            ? { kind: "still_pending" }
            : { kind: "continued_requested", rebound };
        } catch (error) {
          let failure: unknown = error;
          if (
            error instanceof TaskExecutionRunInvariantViolation ||
            error instanceof TaskExecutionSteeringRejected
          ) {
            try {
              const converged = await readConvergedSteeringSource(input);
              if (converged !== null) return converged;
            } catch (convergenceError) {
              failure = convergenceError;
            }
          }
          publishContinuationFailure(pending.request, failure);
          throw failure;
        }
      }
      // A persisted rebound has already crossed cancellation settlement.
      // Re-run the exact lifecycle fence idempotently before
      // scheduling only that same-run segment.
      try {
        return await continueReboundForSource(input, pending.rebound);
      } catch (error) {
        publishContinuationFailure(pending.rebound, error);
        throw error;
      }
    },

    async reconcilePendingSteering(limit = 100) {
      const boundedLimit = Math.max(1, Math.min(1_000, Math.trunc(limit)));
      const sources =
        await options.repository.listRecoverableSources(boundedLimit);
      let continued = 0;
      let pending = 0;
      for (const source of sources) {
        const result = await service.continuePendingSteeringForSource(source);
        if (result.kind === "still_pending") pending += 1;
        else continued += 1;
      }
      return Object.freeze({
        discovered: sources.length,
        continued,
        pending,
        sourceCommentIds: Object.freeze(
          sources.map((source) => source.sourceCommentId),
        ),
      });
    },
  };
  return Object.freeze(service);
}
