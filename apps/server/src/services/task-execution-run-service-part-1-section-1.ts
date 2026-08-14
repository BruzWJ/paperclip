import {
  TaskExecutionAttempt,
  TaskExecutionAttemptRetrySchedule,
  TaskExecutionCancellationIntent,
  TaskExecutionFinalization,
  TaskExecutionFinalizationPromptDependency,
  TaskExecutionFinalizationUpdateDependency,
  TaskExecutionLease,
  TaskExecutionPromptSegment,
  TaskExecutionRunControl,
  TaskExecutionRunLivenessFactRow,
  TaskExecutionRunRef,
  acpPromptAccounting,
  costEvents,
} from "@paperclipai/db";
import {
  TASK_EXECUTION_RUN_STATUSES,
  type TaskExecutionRunKind,
  type TaskExecutionRunStatus,
  type TaskExecutionRunTerminalClassification,
} from "@paperclipai/shared";
import type { TaskSessionReadProjection } from "./task-session/store.js";

export interface TaskExecutionRunIdentity {
  readonly companyId: string;
  readonly taskId: string;
  readonly runId: string;
}

export interface TaskExecutionLeaseBinding {
  readonly run: TaskExecutionRunEnvelope;
  readonly attemptState: TaskExecutionAttempt["state"];
  readonly leaseState: TaskExecutionLease["state"];
  readonly leaseGeneration: number;
  readonly leaseExpiresAt: Date;
  readonly currentRefId: string | null;
}

export function assertPageLimit(limit: number, maximum: number, label: string): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) {
    throw new TaskExecutionRunInvariantViolation(`${label} must be an integer between 1 and ${maximum}`);
  }
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

export interface CreateTaskExecutionRunCommon {
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
    "agent-switched" | "model-switched" | "user" | "synthetic" | "system" | "shell" | "assistant";
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
  readonly accounting: BoundedTaskExecutionRunRecords<typeof acpPromptAccounting.$inferSelect>;
  readonly costs: BoundedTaskExecutionRunRecords<typeof costEvents.$inferSelect>;
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

export const MAX_RUN_LIST_PAGE_SIZE = 200;

export const MAX_RUN_DETAIL_OWNER_ROWS = 500;

export const RUN_STATUS_FILTER_VALUES = new Set<string>(TASK_EXECUTION_RUN_STATUSES);

export const TERMINAL_RUN_STATUSES = new Set<TaskExecutionRunStatus>([
  "succeeded",
  "interrupted",
  "failed",
  "cancelled",
  "timed_out",
]);

export function assertExactRunIdentifier(value: string, label: string): void {
  if (value.length === 0 || value !== value.trim()) {
    throw new TaskExecutionRunInvariantViolation(`${label} must be exact and non-empty`);
  }
}

export function assertRunIdentity(input: TaskExecutionRunIdentity): void {
  assertExactRunIdentifier(input.companyId, "company id");
  assertExactRunIdentifier(input.taskId, "task id");
  assertExactRunIdentifier(input.runId, "run id");
}

export function assertDate(value: Date, label: string): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TaskExecutionRunInvariantViolation(`${label} must be a date`);
  }
}
