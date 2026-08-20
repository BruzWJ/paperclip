import { type TaskExecutionRunStatus } from "@paperclipai/shared";
import type * as runContracts from "./task-execution-run-service-part-1-section-1.js";
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
}
