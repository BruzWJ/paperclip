import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  computeTaskExecutionRunBatchDigest,
  createTaskExecutionRunInTransaction,
  createTaskExecutionRunService,
  TaskExecutionRunInvariantViolation,
  transitionTaskExecutionRunStatusInTransaction,
  type TaskExecutionRunService,
} from "./task-execution-run-service.js";
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

export interface TaskExecutionRunServiceFixture {
  service: TaskExecutionRunService;
}

export function fixture(): TaskExecutionRunServiceFixture {
  return {
    service: createTaskExecutionRunService({
      database: {} as never,
      taskSessionStore: {} as never,
    }),
  };
}

export { describe, expect, it, vi, PgDialect, computeTaskExecutionRunBatchDigest };
export { createTaskExecutionRunInTransaction, createTaskExecutionRunService };
export { TaskExecutionRunInvariantViolation };
export { transitionTaskExecutionRunStatusInTransaction, createMockDb };
