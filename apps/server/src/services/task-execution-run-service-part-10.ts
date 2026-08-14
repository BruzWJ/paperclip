import { type TaskExecutionRunStatus } from "@paperclipai/shared";
import type * as runContracts from "./task-execution-run-service-part-1-section-1.js";
import type {
  ContinuedPendingTaskExecutionSteering,
  ReboundTaskExecutionSteering,
  RequestTaskExecutionSteeringInput,
  RequestedTaskExecutionSteering,
} from "./task-execution-run-service-part-9.js";
import type { TaskSessionDbTransaction } from "./task-session/event-store.js";

export interface TaskExecutionRunService {
  createRun(
    transaction: TaskSessionDbTransaction,
    input: runContracts.CreateTaskExecutionRunInput,
  ): Promise<runContracts.CreatedTaskExecutionRun>;
  lockRun(
    transaction: TaskSessionDbTransaction,
    input: runContracts.TaskExecutionRunIdentity,
  ): Promise<runContracts.TaskExecutionRunEnvelope>;
  readRun(
    input: runContracts.TaskExecutionRunIdentity,
  ): Promise<runContracts.TaskExecutionRunEnvelope | null>;
  lockActiveRunsForAgentsInTransaction(
    transaction: TaskSessionDbTransaction,
    input: {
      readonly companyId: string;
      readonly agentIds: readonly string[];
    },
  ): Promise<readonly runContracts.TaskExecutionRunEnvelope[]>;
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
  ): Promise<readonly runContracts.TaskExecutionRunEnvelope[]>;
  lockActiveAgentRunsForTaskEpochInTransaction(
    transaction: TaskSessionDbTransaction,
    input: {
      readonly companyId: string;
      readonly taskId: string;
      readonly ownershipEpoch: number;
    },
  ): Promise<readonly runContracts.TaskExecutionRunEnvelope[]>;
  lockActiveRunsForBudgetScopeInTransaction(
    transaction: TaskSessionDbTransaction,
    input: {
      readonly companyId: string;
      readonly scopeType: "company" | "project" | "agent";
      readonly scopeId: string;
    },
  ): Promise<readonly runContracts.TaskExecutionRunEnvelope[]>;
  listResumedAgentSteeringLivenessActionsInTransaction(
    transaction: TaskSessionDbTransaction,
    input: runContracts.ResumedAgentSteeringLivenessSearch,
  ): Promise<readonly runContracts.ResumedAgentSteeringLivenessSource[]>;
  transitionRunStatus(
    transaction: TaskSessionDbTransaction,
    input: runContracts.TransitionTaskExecutionRunStatusInput,
  ): Promise<runContracts.TaskExecutionRunEnvelope>;
  attachAttempt(
    transaction: TaskSessionDbTransaction,
    input: runContracts.AttachTaskExecutionRunAttemptInput,
  ): Promise<runContracts.TaskExecutionRunEnvelope>;
  detachAttempt(
    transaction: TaskSessionDbTransaction,
    input: runContracts.DetachTaskExecutionRunAttemptInput,
  ): Promise<runContracts.TaskExecutionRunEnvelope>;
  attachCancellation(
    transaction: TaskSessionDbTransaction,
    input: runContracts.AttachTaskExecutionRunCancellationInput,
  ): Promise<runContracts.TaskExecutionRunEnvelope>;
  detachCancellation(
    transaction: TaskSessionDbTransaction,
    input: runContracts.DetachTaskExecutionRunCancellationInput,
  ): Promise<runContracts.TaskExecutionRunEnvelope>;
  attachFinalization(
    transaction: TaskSessionDbTransaction,
    input: runContracts.AttachTaskExecutionRunFinalizationInput,
  ): Promise<runContracts.TaskExecutionRunEnvelope>;
  listForTask(input: {
    readonly companyId: string;
    readonly taskId: string;
    readonly statuses?: readonly TaskExecutionRunStatus[];
    readonly cursor?: runContracts.TaskExecutionRunListCursor | null;
    readonly limit: number;
  }): Promise<runContracts.TaskExecutionRunListPage>;
  listForAgent(input: {
    readonly companyId: string;
    readonly targetAgentId: string;
    readonly statuses?: readonly TaskExecutionRunStatus[];
    readonly cursor?: runContracts.TaskExecutionRunListCursor | null;
    readonly limit: number;
  }): Promise<runContracts.TaskExecutionRunListPage>;
  listForActivity(input: {
    readonly companyId: string;
    readonly statuses?: readonly TaskExecutionRunStatus[];
    readonly cursor?: runContracts.TaskExecutionRunListCursor | null;
    readonly limit: number;
  }): Promise<runContracts.TaskExecutionRunListPage>;
  listForWorkTimeline(input: {
    readonly companyId: string;
    readonly taskId: string;
    readonly statuses?: readonly TaskExecutionRunStatus[];
    readonly cursor?: runContracts.TaskExecutionRunListCursor | null;
    readonly limit: number;
  }): Promise<runContracts.TaskExecutionRunListPage>;
  readJoinedRunDetail(
    input: runContracts.ReadJoinedTaskExecutionRunDetailInput,
  ): Promise<runContracts.JoinedTaskExecutionRunDetail | null>;
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
      "invalid_request" | "cancellation_ambiguous" | "rebound_identity_mismatch" | "persisted_ambiguous",
  ) {
    super(message);
    this.name = "TaskExecutionSteeringRejected";
  }
}

export function exactIdentity(value: string, label: string): void {
  if (value.length === 0 || value !== value.trim()) {
    throw new TaskExecutionSteeringRejected(`${label} must be exact and non-empty`, "invalid_request");
  }
}

export function validateRequest(input: RequestTaskExecutionSteeringInput): void {
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
    throw new TaskExecutionSteeringRejected("ownership epoch must be a positive integer", "invalid_request");
  }
  if (input.exactMessage.length === 0) {
    throw new TaskExecutionSteeringRejected("steering message must be non-empty", "invalid_request");
  }
  exactIdentity(
    input.actor.kind === "user" ? input.actor.userId : input.actor.agentId,
    `${input.actor.kind} actor id`,
  );
}

export function sameReboundIdentity(
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
