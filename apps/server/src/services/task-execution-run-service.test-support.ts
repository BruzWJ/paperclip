import { describe, expect, it, vi, type Mocked } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  computeTaskExecutionRunBatchDigest,
  createTaskExecutionRunInTransaction,
  createTaskExecutionRunService,
  TaskExecutionRunInvariantViolation,
  TaskExecutionSteeringRejected,
  transitionTaskExecutionRunStatusInTransaction,
  type TaskExecutionSteeringCancellationSettlement,
  type PendingTaskExecutionSteeringForSource,
  type RecoverableTaskExecutionSteeringSource,
  type RequestedTaskExecutionSteering,
  type TaskExecutionRunService,
  type TaskExecutionSteeringCancellationPort,
  type TaskExecutionSteeringRepository,
  type TaskExecutionSteeringResumePort,
} from "./task-execution-run-service.js";
import type { TaskExecutionSteeringResultBroker } from "./task-execution-steering-results.js";
import { createMockDb } from "../__tests__/helpers/mock-db.js";
export const runTime = new Date("2026-08-01T12:00:00.000Z");

export function persistedRunRow(change: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "retry-source",
    companyId: "company",
    taskId: "task",
    sessionId: "session",
    executionScopeId: "scope",
    kind: "productive",
    status: "failed",
    ownershipEpoch: 1,
    targetAgentId: "agent",
    adapterConfigRevisionId: "revision",
    executionWorkspaceBindingId: "workspace",
    executionMode: "owner",
    taskExecutionAuthorityId: "authority",
    consultExecutionId: null,
    parentRunId: null,
    retryOfRunId: null,
    currentAttemptId: null,
    currentLeaseId: null,
    cancellationIntentId: null,
    terminalFinalizationId: "finalization",
    startedAt: runTime,
    finishedAt: runTime,
    terminalClassification: "failed",
    terminalReasonCode: "worker_loss_before_prompt",
    createdAt: runTime,
    updatedAt: runTime,
    ...change,
  };
}

export function runSelectionTransaction(rows: readonly Record<string, unknown>[]) {
  let ordinal = 0;
  const select = vi.fn(() => ({
    from: () => ({
      where: () => ({
        limit: () => ({
          for: async () => {
            const row = rows[ordinal];
            ordinal += 1;
            return row ? [row] : [];
          },
        }),
      }),
    }),
  }));
  return { transaction: { select } as never, select };
}

export const requested: RequestedTaskExecutionSteering = Object.freeze({
  companyId: "company",
  taskId: "task",
  ownershipEpoch: 3,
  runId: "run",
  targetAgentId: "agent",
  refId: "ref",
  refOrdinal: 2,
  interruptedSegmentOrdinal: 0,
  segmentOrdinal: 1,
  sourceCommentId: "comment",
  sourceMessageId: "input",
  sourceInputId: "input",
  cancellationIntentId: "cancel",
  cancellation: Object.freeze({
    companyId: "company",
    taskId: "task",
    sessionId: "session",
    executionScopeId: "scope",
    refId: "ref",
    runId: "run",
    attemptId: "attempt",
    leaseGeneration: 4,
  }),
});

export const steeringSource: RecoverableTaskExecutionSteeringSource = Object.freeze({
  companyId: requested.companyId,
  taskId: requested.taskId,
  sourceCommentId: requested.sourceCommentId,
});

export interface TaskExecutionRunServiceFixture {
  order: string[];
  repository: Mocked<TaskExecutionSteeringRepository>;
  cancellation: Mocked<TaskExecutionSteeringCancellationPort>;
  resume: Mocked<TaskExecutionSteeringResumePort>;
  steeringResults: Mocked<Pick<TaskExecutionSteeringResultBroker, "rebind" | "publish">>;
  service: TaskExecutionRunService;
}

export function fixture(): TaskExecutionRunServiceFixture {
  const order: string[] = [];
  const repository: Mocked<TaskExecutionSteeringRepository> = {
    requestInTransaction: vi.fn(async () => requested),
    recordCancellationSignal: vi.fn(async () => {
      order.push("signal_recorded");
    }),
    awaitCancellationSettlement: vi.fn(async (): Promise<TaskExecutionSteeringCancellationSettlement> => {
      order.push("settled");
      return {
        kind: "settled" as const,
        cancellationIntentId: requested.cancellationIntentId,
      };
    }),
    markAmbiguous: vi.fn(async () => {
      order.push("ambiguous");
    }),
    rebindAfterCancellation: vi.fn(async () => {
      order.push("rebound");
      return {
        companyId: requested.companyId,
        taskId: requested.taskId,
        ownershipEpoch: requested.ownershipEpoch,
        runId: requested.runId,
        targetAgentId: requested.targetAgentId,
        refId: requested.refId,
        refOrdinal: requested.refOrdinal,
        segmentOrdinal: requested.segmentOrdinal,
      };
    }),
    markResumeReady: vi.fn(async () => {
      order.push("resume_ready");
    }),
    findPendingForSource: vi.fn(async (): Promise<PendingTaskExecutionSteeringForSource> => ({
      kind: "requested" as const,
      request: requested,
    })),
    listRecoverableSources: vi.fn(async (): Promise<readonly RecoverableTaskExecutionSteeringSource[]> => []),
  };
  const cancellation: Mocked<TaskExecutionSteeringCancellationPort> = {
    signalAttemptCancellation: vi.fn(() => {
      order.push("cancel");
      return true;
    }),
  };
  const resume: Mocked<TaskExecutionSteeringResumePort> = {
    resumeSteering: vi.fn(async () => {
      order.push("resume");
    }),
  };
  const steeringResults: Mocked<Pick<TaskExecutionSteeringResultBroker, "rebind" | "publish">> = {
    rebind: vi.fn(),
    publish: vi.fn(),
  };
  return {
    order,
    repository,
    cancellation,
    resume,
    steeringResults,
    service: createTaskExecutionRunService({
      database: {} as never,
      taskSessionStore: {} as never,
      repository,
      cancellation,
      resume,
      steeringResults,
    }),
  };
}

export { describe, expect, it, vi, PgDialect, computeTaskExecutionRunBatchDigest };
export { createTaskExecutionRunInTransaction, createTaskExecutionRunService };
export { TaskExecutionRunInvariantViolation, TaskExecutionSteeringRejected };
export { transitionTaskExecutionRunStatusInTransaction, createMockDb };
export type { TaskExecutionSteeringCancellationSettlement };
export type { PendingTaskExecutionSteeringForSource };
export type { RecoverableTaskExecutionSteeringSource, RequestedTaskExecutionSteering };
