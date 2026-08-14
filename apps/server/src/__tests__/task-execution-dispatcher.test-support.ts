import { describe, expect, it, vi } from "vitest";
import type { TaskExecutionRef } from "@paperclipai/shared";
import {
  TaskExecutionDispatchRejected,
  createTaskExecutionDispatcher,
  type TaskExecutionAttemptExecutor,
  type TaskExecutionDispatcherRepository,
  type TaskExecutionTargetLaneIdentity,
  type LeasedTaskExecutionRef,
} from "../services/task-execution-dispatcher.js";
export type AttemptSettlement = Parameters<TaskExecutionAttemptExecutor["execute"]>[2];

export async function settleResult<T extends Awaited<ReturnType<TaskExecutionAttemptExecutor["execute"]>>>(
  settle: AttemptSettlement,
  result: T,
): Promise<T> {
  await settle(result);
  return result;
}

export function ref(change: Partial<TaskExecutionRef> = {}): TaskExecutionRef {
  return {
    id: "ref",
    companyId: "company",
    taskId: "task",
    sessionId: "session",
    ownershipEpoch: 1,
    executionScopeId: "scope",
    executionLineageId: "lineage",
    mode: "owner",
    sourceKind: "task_request",
    sourceId: "source",
    sourceRecordId: "task",
    messageKind: "user",
    messageId: "message",
    exactMessage: "Exact request",
    deliveryIdempotencyKey: "delivery",
    targetAgentId: "agent",
    laneOrdinal: 0,
    taskExecutionAuthorityId: "authority",
    consultExecutionId: null,
    adapterConfigRevisionId: "revision",
    contextEpoch: 1,
    historyViewId: "view",
    admissionHighWaterSeq: 0,
    inputId: "input",
    admittedSeq: 1,
    promotedSeq: null,
    counterpartTaskId: null,
    counterpartAuthorityId: null,
    counterpartOwnershipEpoch: null,
    consultCallerRefId: null,
    consultChainToken: null,
    disposition: "active",
    ...change,
  };
}

export function harness(
  value = ref(),
  leaseState: "available" | "leased" | "retryable" | "completed" | "failed" = "available",
  leaseExpiresAt: Date | null = leaseState === "leased" ? new Date("2999-01-01T00:00:00.000Z") : null,
) {
  const lease: LeasedTaskExecutionRef = {
    ref: value,
    companyId: value.companyId,
    taskId: value.taskId,
    runId: "run",
    attemptId: "attempt",
    promptKind: "base",
    sessionOperation: "new",
    refOrdinal: 0,
    segmentOrdinal: 0,
    leaseId: "lease",
    leaseGeneration: 1,
    attemptNumber: 1,
    batch: [{ ref: value, leaseGeneration: 1, attemptNumber: 1 }],
  };
  let available = true;
  const retryable = vi.fn();
  const terminal = vi.fn(async () => ({
    laneReleased: true,
  }));
  const repository: TaskExecutionDispatcherRepository = {
    async recoverExpiredLeases() {
      return { refIds: [] };
    },
    async listDispatchableRefIds() {
      return [];
    },
    async resolveLaneForPersistedRef(refId) {
      return refId === value.id
        ? {
            lane: {
              companyId: value.companyId,
              taskId: value.taskId,
              sessionId: value.sessionId,
              ownershipEpoch: value.ownershipEpoch,
              targetAgentId: value.targetAgentId,
            },
            mode: value.mode,
            disposition: value.disposition,
            leaseState,
            leaseExpiresAt,
          }
        : null;
    },
    async leaseNextRef() {
      if (!available) return null;
      available = false;
      return lease;
    },
    async assertLeaseCurrent() {},
    markRetryable: retryable,
    markTerminal: terminal,
  };
  return { lease, repository, retryable, terminal };
}

export { describe, expect, it, vi, TaskExecutionDispatchRejected };
export { createTaskExecutionDispatcher };
export type { TaskExecutionRef, TaskExecutionAttemptExecutor };
export type { TaskExecutionDispatcherRepository, TaskExecutionTargetLaneIdentity };
export type { LeasedTaskExecutionRef };
