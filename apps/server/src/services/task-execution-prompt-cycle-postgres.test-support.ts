import {
  taskExecutionAttempts,
  taskExecutionLeases,
  taskExecutionPromptCapabilities,
  taskExecutionRefs,
  taskExecutionRunControls,
  taskExecutionRunRefs,
  taskExecutionSessions,
  tasks,
  type Db,
  type TaskExecutionAttempt,
  type TaskExecutionLease,
  type TaskExecutionRunControl,
} from "@paperclipai/db";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { TaskExecutionPromptAuthorityLost } from "./task-execution-attempt-executor.js";
import type {
  TaskExecutionPromptIdentity,
  ResolvedTaskExecutionPrompt,
} from "./task-execution-attempt-executor.js";
import {
  createPostgresTaskExecutionPromptCycleRepository,
  nextCorrelationGeneration,
  PostgresTaskExecutionPromptCycleRejected,
  resolveInitialPromptCycleInTransaction,
} from "./task-execution-prompt-cycle-postgres.js";
import type { TaskExecutionRunEnvelope } from "./task-execution-run-service.js";
import type { TaskSessionDbTransaction } from "./task-session/event-store.js";
export const timestamp = new Date("2026-07-01T00:00:00.000Z");

export function promptIdentity(): TaskExecutionPromptIdentity {
  return {
    companyId: "00000000-0000-4000-8000-000000000001",
    taskId: "00000000-0000-4000-8000-000000000002",
    sessionId: "session-1",
    runId: "00000000-0000-4000-8000-000000000003",
    attemptId: "00000000-0000-4000-8000-000000000004",
    leaseId: "00000000-0000-4000-8000-000000000005",
    leaseGeneration: 1,
    ownershipEpoch: 2,
    executionScopeId: "00000000-0000-4000-8000-000000000006",
    runBatchDigest: "a".repeat(64),
    runKind: "productive",
    refId: "00000000-0000-4000-8000-000000000007",
    refOrdinal: 0,
    attemptGeneration: 1,
    targetAgentId: "00000000-0000-4000-8000-000000000008",
    laneKind: "owner",
    taskExecutionAuthorityId: "00000000-0000-4000-8000-000000000009",
    consultExecutionId: null,
    adapterConfigRevisionId: "00000000-0000-4000-8000-000000000010",
    executionWorkspaceBindingId: "00000000-0000-4000-8000-000000000011",
  };
}

export function selectTransaction(
  rowsByTable: ReadonlyMap<unknown, readonly unknown[]>,
  selectedTables: unknown[] = [],
  lockedTables: unknown[] = [],
  clockTimestamps: readonly Date[] = [timestamp],
): TaskSessionDbTransaction {
  let clockRead = 0;
  return {
    async execute() {
      const value = clockTimestamps[Math.min(clockRead, clockTimestamps.length - 1)];
      clockRead += 1;
      return [{ timestampMs: value.getTime() }];
    },
    select() {
      let table: unknown;
      const builder = {
        from(value: unknown) {
          table = value;
          selectedTables.push(value);
          return builder;
        },
        where() {
          return builder;
        },
        innerJoin() {
          return builder;
        },
        leftJoin() {
          return builder;
        },
        orderBy() {
          return builder;
        },
        limit() {
          return builder;
        },
        for() {
          lockedTables.push(table);
          return Promise.resolve(rowsByTable.get(table) ?? []);
        },
      };
      return builder;
    },
  } as unknown as TaskSessionDbTransaction;
}

export function executionRef(overrides: Record<string, unknown> = {}): typeof taskExecutionRefs.$inferSelect {
  const identity = promptIdentity();
  return {
    id: "00000000-0000-4000-8000-000000000013",
    companyId: identity.companyId,
    taskId: identity.taskId,
    sessionId: identity.sessionId,
    ownershipEpoch: identity.ownershipEpoch,
    previousOwnershipEpoch: null,
    executionScopeId: identity.executionScopeId,
    executionLineageId: "00000000-0000-4000-8000-000000000014",
    mode: identity.laneKind,
    sourceKind: "task_request",
    sourceRecordId: identity.taskId,
    messageKind: "user",
    targetAgentId: identity.targetAgentId,
    laneOrdinal: 1,
    taskExecutionAuthorityId: identity.taskExecutionAuthorityId,
    consultExecutionId: identity.consultExecutionId,
    adapterConfigRevisionId: identity.adapterConfigRevisionId,
    contextEpoch: 0,
    counterpartTaskId: null,
    counterpartAuthorityId: null,
    counterpartOwnershipEpoch: null,
    consultCallerRefId: null,
    consultChainToken: null,
    disposition: "active",
    ...overrides,
  } as unknown as typeof taskExecutionRefs.$inferSelect;
}

export async function resolveBootstrapCycle(outcome: "succeeded" | "failed") {
  const predecessor = executionRef({
    id: "00000000-0000-4000-8000-000000000015",
    ownershipEpoch: 1,
    messageKind: "synthetic",
    laneOrdinal: 0,
    disposition: "terminal",
  });
  const current = executionRef({ ownershipEpoch: 1 });
  const runId = "00000000-0000-4000-8000-000000000016";
  const correlation =
    outcome === "succeeded"
      ? {
          state: "eligible",
          laneKind: "owner",
          authorizedContextExposureDigest: "a".repeat(64),
        }
      : null;
  const transaction = selectTransaction(
    new Map<unknown, readonly unknown[]>([
      [taskExecutionRefs, [predecessor, current]],
      [
        taskExecutionRunRefs,
        [
          {
            runId,
            refOrdinal: 0,
            outcome,
            protocolSettlementState: outcome === "succeeded" ? "settled" : "incomplete",
            correlation,
          },
        ],
      ],
    ]),
  );
  return {
    runId,
    predecessor,
    correlation,
    result: await resolveInitialPromptCycleInTransaction(transaction, {
      currentRef: current,
      executionWorkspaceBindingId: promptIdentity().executionWorkspaceBindingId,
    }),
  };
}

export interface CapturedUpdate {
  readonly table: unknown;
  values?: unknown;
  where?: unknown;
}

export function deferredRows() {
  let resolve!: (rows: readonly unknown[]) => void;
  const promise = new Promise<readonly unknown[]>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
export type DeferredRows = ReturnType<typeof deferredRows>;

export function renewalTransaction(input: {
  rowsByTable: ReadonlyMap<unknown, readonly unknown[]>;
  returningByTable?: ReadonlyMap<unknown, readonly unknown[]>;
  clockTimestamps?: readonly Date[];
}) {
  const selectedTables: unknown[] = [];
  const lockedTables: unknown[] = [];
  const updates: CapturedUpdate[] = [];
  const transaction = selectTransaction(
    input.rowsByTable,
    selectedTables,
    lockedTables,
    input.clockTimestamps,
  );
  const update = vi.fn((table: unknown) => {
    const update: CapturedUpdate = { table };
    updates.push(update);
    const builder = {
      set(values: unknown) {
        update.values = values;
        return builder;
      },
      where(where: unknown) {
        update.where = where;
        return builder;
      },
      returning() {
        return Promise.resolve(input.returningByTable?.get(table) ?? []);
      },
    };
    return builder;
  });
  const completedTransaction = Object.assign(transaction, {
    update,
  }) as unknown as TaskSessionDbTransaction;
  return {
    transaction: completedTransaction,
    selectedTables,
    lockedTables,
    updates,
  };
}

export function runEnvelope(identity: TaskExecutionPromptIdentity): TaskExecutionRunEnvelope {
  return {
    companyId: identity.companyId,
    taskId: identity.taskId,
    runId: identity.runId,
    sessionId: identity.sessionId,
    executionScopeId: identity.executionScopeId,
    kind: identity.runKind,
    status: "running",
    ownershipEpoch: identity.ownershipEpoch,
    targetAgentId: identity.targetAgentId,
    adapterConfigRevisionId: identity.adapterConfigRevisionId,
    executionWorkspaceBindingId: identity.executionWorkspaceBindingId,
    executionMode: identity.laneKind,
    taskExecutionAuthorityId: identity.taskExecutionAuthorityId,
    consultExecutionId: identity.consultExecutionId,
    parentRunId: null,
    retryOfRunId: null,
    currentAttemptId: identity.attemptId,
    currentLeaseId: identity.leaseId,
    cancellationIntentId: null,
    terminalFinalizationId: null,
    startedAt: timestamp,
    finishedAt: null,
    terminalClassification: null,
    terminalReasonCode: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function attemptRow(identity: TaskExecutionPromptIdentity): TaskExecutionAttempt {
  return {
    id: identity.attemptId,
    companyId: identity.companyId,
    taskId: identity.taskId,
    sessionId: identity.sessionId,
    runId: identity.runId,
    runKind: identity.runKind,
    sessionOperation: "new",
    refId: identity.refId,
    refOrdinal: identity.refOrdinal,
    attemptGeneration: identity.attemptGeneration,
    state: "running",
    startedAt: timestamp,
    finishedAt: null,
    createdAt: timestamp,
  };
}

export function leaseRow(identity: TaskExecutionPromptIdentity): TaskExecutionLease {
  return {
    id: identity.leaseId,
    companyId: identity.companyId,
    taskId: identity.taskId,
    runId: identity.runId,
    attemptId: identity.attemptId,
    leaseGeneration: identity.leaseGeneration,
    workerId: "worker-1",
    state: "active",
    acquiredAt: timestamp,
    renewedAt: null,
    expiresAt: new Date("2026-07-01T00:01:00.000Z"),
    releasedAt: null,
    createdAt: timestamp,
  };
}

export function controlRow(identity: TaskExecutionPromptIdentity): TaskExecutionRunControl {
  return {
    runId: identity.runId,
    currentRefId: identity.refId,
    currentOrdinal: identity.refOrdinal,
  };
}

export function liveCapabilityRow(
  identity: TaskExecutionPromptIdentity,
  expiresAt = new Date("2026-07-01T00:00:30.000Z"),
) {
  return {
    companyId: identity.companyId,
    taskId: identity.taskId,
    runId: identity.runId,
    runBatchDigest: identity.runBatchDigest,
    refId: identity.refId,
    refOrdinal: identity.refOrdinal,
    attemptId: identity.attemptId,
    leaseId: identity.leaseId,
    leaseGeneration: identity.leaseGeneration,
    capabilityConnectionId: "00000000-0000-4000-8000-000000000012",
    capabilityGeneration: 1,
    state: "active",
    expiresAt,
  } as const;
}

export function renewalRepository(input: {
  identity: TaskExecutionPromptIdentity;
  lease?: TaskExecutionLease;
  capability?: ReturnType<typeof liveCapabilityRow>;
  leaseReturning?: readonly unknown[];
  capabilityReturning?: readonly unknown[];
  clockTimestamps?: readonly Date[];
}) {
  const lease = input.lease ?? leaseRow(input.identity);
  const capability = input.capability ?? liveCapabilityRow(input.identity);
  const runtime = renewalTransaction({
    rowsByTable: new Map<unknown, readonly unknown[]>([
      [taskExecutionAttempts, [attemptRow(input.identity)]],
      [taskExecutionLeases, [lease]],
      [taskExecutionRunControls, [controlRow(input.identity)]],
      [taskExecutionPromptCapabilities, [capability]],
    ]),
    returningByTable: new Map<unknown, readonly unknown[]>([
      [taskExecutionLeases, input.leaseReturning ?? [{ id: input.identity.leaseId }]],
      [
        taskExecutionPromptCapabilities,
        input.capabilityReturning ?? [
          {
            capabilityConnectionId: capability.capabilityConnectionId,
          },
        ],
      ],
    ]),
    clockTimestamps: input.clockTimestamps,
  });
  const database = {
    transaction: vi.fn(async (work: (tx: TaskSessionDbTransaction) => unknown) => work(runtime.transaction)),
  } as unknown as Db;
  return {
    ...runtime,
    capability,
    repository: createPostgresTaskExecutionPromptCycleRepository({
      database,
      runService: {
        lockRun: vi.fn(async () => runEnvelope(input.identity)),
      },
      compiler: {
        resolve: vi.fn(() => {
          throw new Error("authority renewal must not compile an interface");
        }),
      },
      capabilityEndpoint: "http://127.0.0.1:3210/",
      leaseTtlMs: 120_000,
      capabilityTtlMs: 30_000,
    }),
  };
}

export { taskExecutionAttempts, taskExecutionLeases };
export { taskExecutionPromptCapabilities, taskExecutionRefs, taskExecutionRunControls };
export { taskExecutionRunRefs, taskExecutionSessions, tasks, PgDialect, describe };
export { expect, it, vi, TaskExecutionPromptAuthorityLost };
export { createPostgresTaskExecutionPromptCycleRepository, nextCorrelationGeneration };
export { PostgresTaskExecutionPromptCycleRejected };
export { resolveInitialPromptCycleInTransaction };
export type { Db, TaskExecutionAttempt, TaskExecutionLease, TaskExecutionRunControl };
export type { TaskExecutionPromptIdentity, ResolvedTaskExecutionPrompt };
export type { TaskExecutionRunEnvelope, TaskSessionDbTransaction };
