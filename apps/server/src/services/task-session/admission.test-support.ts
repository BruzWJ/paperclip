import { describe, expect, it } from "vitest";
import type { TaskSessionDbTransaction } from "./event-store.js";
import {
  isExactTaskUpdateCrossTaskProducer,
  previousOwnershipEpochForDispatchSource,
  reserveTaskExecutionLaneOrdinalInTransaction,
  resolveDispatchingExecutionBatchMessageKinds,
  resolveTaskCommentReplyProjection,
  v2MessageKindForExecutionSource,
  type TaskSessionExecutionSource,
} from "./admission.js";
export const scope = {
  companyId: "11111111-1111-4111-8111-111111111111",
  taskId: "22222222-2222-4222-8222-222222222222",
  sessionId: "ses_reply_projection",
};

export function transactionReturning(rows: unknown[]): TaskSessionDbTransaction {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => ({
            for: async () => rows,
          }),
        }),
      }),
    }),
  } as unknown as TaskSessionDbTransaction;
}

export function laneReservationTransaction(input: {
  nextOrdinal: number | null;
  capture: {
    values?: Record<string, unknown>;
    targetNames?: string[];
    set?: Record<string, unknown>;
    setWhere?: unknown;
  };
}): TaskSessionDbTransaction {
  return {
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        input.capture.values = values;
        return {
          onConflictDoUpdate: (conflict: {
            target: Array<{ name: string }>;
            set: Record<string, unknown>;
            setWhere?: unknown;
          }) => {
            input.capture.targetNames = conflict.target.map((column) => column.name);
            input.capture.set = conflict.set;
            input.capture.setWhere = conflict.setWhere;
            return {
              returning: async () => (input.nextOrdinal === null ? [] : [{ nextOrdinal: input.nextOrdinal }]),
            };
          },
        };
      },
    }),
  } as unknown as TaskSessionDbTransaction;
}
export type LaneReservationTransactionInput = Parameters<typeof laneReservationTransaction>[0];

export const creatorParentTaskId = "33333333-3333-4333-8333-333333333333";
export const creatorAuthorityId = "44444444-4444-4444-8444-444444444444";
export const creatorAgentId = "55555555-5555-4555-8555-555555555555";
export const childAuthorityId = "66666666-6666-4666-8666-666666666666";
export const creatorRunId = "77777777-7777-4777-8777-777777777777";
export const creatorRevisionId = "88888888-8888-4888-8888-888888888888";
export const creatorRunScopeId = "99999999-9999-4999-8999-999999999999";
export const creatorWorkspaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const creatorAttemptId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const creatorLeaseId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

export function sequentialSelectTransaction(responses: readonly unknown[][]): TaskSessionDbTransaction {
  let next = 0;
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(responses[next++] ?? []),
        }),
      }),
    }),
  } as unknown as TaskSessionDbTransaction;
}

export function exactCreatorProducerRun(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-08-06T12:00:00.000Z");
  return {
    id: creatorRunId,
    companyId: scope.companyId,
    taskId: creatorParentTaskId,
    sessionId: "ses_parent_creator",
    executionScopeId: creatorRunScopeId,
    kind: "productive",
    status: "running",
    ownershipEpoch: 3,
    targetAgentId: creatorAgentId,
    adapterConfigRevisionId: creatorRevisionId,
    executionWorkspaceBindingId: creatorWorkspaceId,
    executionMode: "owner",
    taskExecutionAuthorityId: creatorAuthorityId,
    consultExecutionId: null,
    parentRunId: null,
    retryOfRunId: null,
    currentAttemptId: creatorAttemptId,
    currentLeaseId: creatorLeaseId,
    cancellationIntentId: null,
    terminalFinalizationId: null,
    startedAt: now,
    finishedAt: null,
    terminalClassification: null,
    terminalReasonCode: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export const exactCreatorUpdateScope = {
  companyId: scope.companyId,
  taskId: scope.taskId,
  sessionId: scope.sessionId,
  sourceKind: "task_update",
  actor: {
    kind: "agent-execution",
    agentId: creatorAgentId,
    authorityId: creatorAuthorityId,
  },
  counterpartTaskId: creatorParentTaskId,
  counterpartAuthorityId: creatorAuthorityId,
  counterpartOwnershipEpoch: 3,
  mode: "owner",
  taskExecutionAuthorityId: childAuthorityId,
  consultExecutionId: null,
} as const;

export const exactCreatorUpdateComment = {
  author: { kind: "agent", agentId: creatorAgentId },
  producingRun: {
    runId: creatorRunId,
    adapterConfigRevisionId: creatorRevisionId,
  },
} as const;

export function exactCreatorChild(overrides: Record<string, unknown> = {}) {
  return {
    parentId: creatorParentTaskId,
    parentOwnershipEpoch: 3,
    creatorKind: "agent-execution",
    creatorAuthorityId,
    creatorAdapterConfigRevisionId: creatorRevisionId,
    ...overrides,
  };
}

export { describe, expect, it, isExactTaskUpdateCrossTaskProducer };
export { previousOwnershipEpochForDispatchSource };
export { reserveTaskExecutionLaneOrdinalInTransaction };
export { resolveDispatchingExecutionBatchMessageKinds };
export { resolveTaskCommentReplyProjection, v2MessageKindForExecutionSource };
export type { TaskSessionDbTransaction, TaskSessionExecutionSource };
