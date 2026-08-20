import { describe, expect, it, vi } from "vitest";
import type { TaskExecutionRef } from "@paperclipai/shared";
import {
  createTaskExecutionDispatcher as createTaskExecutionDispatcherImport,
  type TaskExecutionDispatcherRepository,
  type TaskExecutionTargetLaneIdentity,
  type LeasedTaskExecutionRef,
} from "../services/task-execution-dispatcher.js";
import {
  classifyExpiredPromptClosure as classifyExpiredPromptClosureImport,
  createPostgresTaskExecutionDispatcherRepository as createPostgresTaskExecutionDispatcherRepositoryImport,
  PostgresTaskExecutionDispatchRejected as PostgresTaskExecutionDispatchRejectedImport,
  projectPersistedTaskExecutionRef as projectPersistedTaskExecutionRefImport,
} from "../services/task-execution-dispatcher-postgres.js";
import { createMockDb as createMockDbImport } from "./helpers/mock-db.js";

export const createTaskExecutionDispatcher = createTaskExecutionDispatcherImport;
export const classifyExpiredPromptClosure = classifyExpiredPromptClosureImport;
export const createPostgresTaskExecutionDispatcherRepository =
  createPostgresTaskExecutionDispatcherRepositoryImport;
export const PostgresTaskExecutionDispatchRejected = PostgresTaskExecutionDispatchRejectedImport;
export const projectPersistedTaskExecutionRef = projectPersistedTaskExecutionRefImport;
export const createMockDb = createMockDbImport;
const hoistedMocks = vi.hoisted(() => ({
  readAvailability: vi.fn(),
}));
export const mocks = hoistedMocks;

vi.mock("../services/task-execution-run-service-part-3-section-1.js", async (importActual) => ({
  ...(await importActual<typeof import("../services/task-execution-run-service-part-3-section-1.js")>()),
  readActiveTaskExecutionRefRunAvailability: hoistedMocks.readAvailability,
}));

export const now = new Date("2026-07-26T18:00:00.000Z");

export function persistedRef(overrides: Record<string, unknown> = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000801",
    companyId: "00000000-0000-4000-8000-000000000802",
    taskId: "00000000-0000-4000-8000-000000000803",
    sessionId: "ses_exact_session",
    ownershipEpoch: 3,
    previousOwnershipEpoch: 2,
    executionScopeId: "scope-1",
    executionLineageId: "lineage-1",
    mode: "owner",
    sourceKind: "task_request",
    sourceId: "source-1",
    sourceRecordId: "record-1",
    messageKind: "user",
    sourceMessageId: "message-1",
    exactMessage: "Exact persisted bytes",
    deliveryIdempotencyKey: "delivery-1",
    targetAgentId: "00000000-0000-4000-8000-000000000804",
    laneOrdinal: 7,
    taskExecutionAuthorityId: "00000000-0000-4000-8000-000000000805",
    consultExecutionId: null,
    adapterConfigRevisionId: "00000000-0000-4000-8000-000000000806",
    contextEpoch: 2,
    historyViewId: "00000000-0000-4000-8000-000000000807",
    admissionHighWaterSeq: 19,
    inputId: "00000000-0000-4000-8000-000000000808",
    admittedSeq: 20,
    promotedSeq: 21,
    counterpartTaskId: null,
    counterpartAuthorityId: null,
    counterpartOwnershipEpoch: null,
    consultCallerRefId: null,
    consultChainToken: null,
    disposition: "active",
    ...overrides,
  };
}

export function owner(overrides: Record<string, unknown> = {}) {
  return {
    promptTransmissionPhase: "not_transmitted",
    outcome: null,
    outcomeReferenceId: null,
    protocolSettlementState: null,
    accountingId: null,
    costEventId: null,
    settlementVersion: 0,
    settledAt: null,
    ...overrides,
  } as never;
}

export function capability(revocationReason: string, overrides: Record<string, unknown> = {}) {
  return {
    state: "revoked",
    revocationReason,
    revokedAt: now,
    activatedAt: null,
    targetSessionCorrelationId: null,
    ...overrides,
  } as never;
}

export function repositoryOptions(db: ReturnType<typeof createMockDb>["db"]) {
  return {
    database: db,
    runService: {
      createRun: vi.fn(),
      lockRun: vi.fn(),
      transitionRunStatus: vi.fn(),
      attachAttempt: vi.fn(),
      detachAttempt: vi.fn(),
      detachCancellation: vi.fn(),
    } as never,
    compiler: { resolve: vi.fn() } as never,
    finalizer: {
      finalize: vi.fn(),
      finalizeInTransaction: vi.fn(async () => ({ autoCaptureRefId: null })),
    } as never,
    now: () => now,
    idFactory: () => "00000000-0000-4000-8000-000000000809",
    leaseTtlMs: 60_000,
    pluginDomainEvents: { publish: async () => undefined },
  };
}

export function expiredAuthorityCancellationFixture(
  overrides: {
    leaseExpiresAt?: Date;
    cancellationAttemptId?: string;
  } = {},
) {
  const ref = persistedRef({
    laneOrdinal: 6,
    previousOwnershipEpoch: null,
  });
  const nextRef = persistedRef({
    id: "00000000-0000-4000-8000-000000000821",
    laneOrdinal: 7,
    previousOwnershipEpoch: null,
  });
  const runId = "00000000-0000-4000-8000-000000000811";
  const attemptId = "00000000-0000-4000-8000-000000000812";
  const leaseId = "00000000-0000-4000-8000-000000000813";
  const cancellationId = "00000000-0000-4000-8000-000000000814";
  const capabilityConnectionId = "00000000-0000-4000-8000-000000000815";
  const workspaceId = "00000000-0000-4000-8000-000000000816";
  const createdAt = new Date(now.getTime() - 60_000);
  const updatedAt = new Date(now.getTime() - 30_000);
  const taskIdentity = { companyId: ref.companyId, taskId: ref.taskId };
  const runIdentity = { ...taskIdentity, runId };
  const run = {
    ...taskIdentity,
    id: runId,
    sessionId: ref.sessionId,
    executionScopeId: ref.executionScopeId,
    kind: "productive",
    status: "running",
    ownershipEpoch: ref.ownershipEpoch,
    targetAgentId: ref.targetAgentId,
    adapterConfigRevisionId: ref.adapterConfigRevisionId,
    executionWorkspaceBindingId: workspaceId,
    executionMode: "owner",
    taskExecutionAuthorityId: ref.taskExecutionAuthorityId,
    consultExecutionId: null,
    parentRunId: null,
    retryOfRunId: null,
    currentAttemptId: attemptId,
    currentLeaseId: leaseId,
    cancellationIntentId: cancellationId,
    terminalFinalizationId: null,
    startedAt: createdAt,
    finishedAt: null,
    terminalClassification: null,
    terminalReasonCode: null,
    createdAt,
    updatedAt,
  };
  const attempt = {
    ...runIdentity,
    id: attemptId,
    sessionId: ref.sessionId,
    runKind: "productive",
    sessionOperation: "resume",
    refId: ref.id,
    refOrdinal: 0,
    attemptGeneration: 1,
    state: "running",
    startedAt: createdAt,
    finishedAt: null,
    createdAt,
  };
  const lease = {
    ...runIdentity,
    id: leaseId,
    attemptId,
    leaseGeneration: 1,
    workerId: "worker-old",
    state: "active",
    acquiredAt: createdAt,
    renewedAt: updatedAt,
    expiresAt: overrides.leaseExpiresAt ?? new Date(now.getTime() - 1),
    releasedAt: null,
    createdAt,
  };
  const cancellation = {
    ...runIdentity,
    id: cancellationId,
    attemptId: overrides.cancellationAttemptId ?? attemptId,
    leaseId,
    reasonKind: "authority",
    actorKind: "system",
    actorUserId: null,
    actorAgentId: null,
    state: "acknowledged",
    requestedAt: new Date(now.getTime() - 20_000),
    acknowledgedAt: new Date(now.getTime() - 19_000),
    nativeCancellationSettledAt: null,
    completedAt: null,
    failedAt: null,
    failureCode: null,
    createdAt: new Date(now.getTime() - 20_000),
  };
  const runRef = {
    ...runIdentity,
    sessionId: ref.sessionId,
    refId: ref.id,
    refOrdinal: 0,
    admissionOrder: ref.laneOrdinal,
    batchDigest: "batch-digest",
    inputId: ref.inputId,
    promptTransmissionPhase: "transmitted",
    outcome: null,
    outcomeReferenceId: null,
    protocolSettlementState: null,
    accountingId: null,
    costEventId: null,
    settlementVersion: 0,
    attemptId,
    capabilityConnectionId,
    capabilityGeneration: 1,
    settledAt: null,
    createdAt,
  };
  const capability = {
    ...runIdentity,
    capabilityConnectionId,
    capabilityGeneration: 1,
    runBatchDigest: runRef.batchDigest,
    refId: ref.id,
    refOrdinal: 0,
    attemptId,
    leaseId,
    leaseGeneration: 1,
    workerProcessIdentity: "worker-process",
    ownershipEpoch: ref.ownershipEpoch,
    targetAgentId: ref.targetAgentId,
    laneKind: "owner",
    executionMode: "owner",
    taskExecutionAuthorityId: ref.taskExecutionAuthorityId,
    consultExecutionId: null,
    adapterConfigIdentity: ref.adapterConfigRevisionId,
    workspaceIdentity: workspaceId,
    targetSessionCorrelationId: null,
    effectiveContextExposureDigest: "context-digest",
    effectiveToolsDigest: "tools-digest",
    bearerHash: "bearer-hash",
    ingressHighWater: -1,
    classificationHighWater: -1,
    state: "active",
    expiresAt: new Date(now.getTime() - 10_000),
    activatedAt: new Date(now.getTime() - 50_000),
    revocationReason: null,
    revokedAt: null,
    createdAt,
  };
  return {
    ref,
    nextRef,
    run,
    attempt,
    lease,
    cancellation,
    runRef,
    capability,
    lane: {
      ...taskIdentity,
      ownershipEpoch: ref.ownershipEpoch,
      targetAgentId: ref.targetAgentId,
      nextOrdinal: 8,
      activeOrdinal: ref.laneOrdinal,
      activeLeaseGeneration: 1,
      activeLeaseId: leaseId,
      createdAt,
      updatedAt,
    },
    control: {
      runId,
      currentRefId: ref.id,
      currentOrdinal: 0,
    },
  };
}

export type ExpiredAuthorityCancellationState = ReturnType<typeof expiredAuthorityCancellationFixture>;

export function expiredRecoverySelects(state: ExpiredAuthorityCancellationState, terminal = false) {
  const rows = [
    [{ leaseId: state.lease.id, runId: state.run.id, ref: state.ref }],
    [{ id: state.ref.companyId }],
    [{ id: state.ref.taskId }],
    [{ id: state.ref.sessionId }],
    [state.lane],
    [{ run: state.run }],
    [state.cancellation],
    [state.control],
    [{ row: state.runRef, ref: state.ref }],
    [state.attempt],
    [state.lease],
  ];
  return terminal ? [...rows, [state.capability], [], [state.nextRef]] : rows;
}

export function expiredRecoveryUpdates(state: ExpiredAuthorityCancellationState) {
  return [
    [{ capabilityConnectionId: state.capability.capabilityConnectionId }],
    [{ runId: state.run.id }],
    [{ id: state.attempt.id }],
    [{ id: state.lease.id }],
    [{ id: state.cancellation.id }],
    [{ id: state.ref.id }],
    [{ id: state.ref.historyViewId }],
    [{ runId: state.run.id }],
    [{ companyId: state.ref.companyId }],
  ];
}

export function expiredRecoveryHarness(
  overrides: Parameters<typeof expiredAuthorityCancellationFixture>[0] = {},
  terminal = false,
) {
  const state = expiredAuthorityCancellationFixture(overrides);
  const harness = createMockDb({
    select: expiredRecoverySelects(state, terminal),
    ...(terminal ? { update: expiredRecoveryUpdates(state) } : {}),
  });
  const options = repositoryOptions(harness.db);
  return {
    state,
    harness,
    options,
    repository: createPostgresTaskExecutionDispatcherRepository(options),
  };
}

export function domainRef(input: {
  id: string;
  targetAgentId: string;
  executionScopeId?: string;
}): TaskExecutionRef {
  return {
    id: input.id,
    companyId: "company",
    taskId: "task",
    sessionId: "session",
    ownershipEpoch: 1,
    executionScopeId: input.executionScopeId ?? `scope-${input.id}`,
    executionLineageId: `lineage-${input.id}`,
    mode: "owner",
    sourceKind: "task_request",
    sourceId: input.id,
    sourceRecordId: input.id,
    messageKind: "user",
    messageId: `message-${input.id}`,
    exactMessage: input.id,
    deliveryIdempotencyKey: `delivery-${input.id}`,
    targetAgentId: input.targetAgentId,
    laneOrdinal: 0,
    taskExecutionAuthorityId: `authority-${input.id}`,
    consultExecutionId: null,
    adapterConfigRevisionId: `revision-${input.id}`,
    contextEpoch: 1,
    historyViewId: `view-${input.id}`,
    admissionHighWaterSeq: 0,
    inputId: `input-${input.id}`,
    admittedSeq: 1,
    promotedSeq: null,
    counterpartTaskId: null,
    counterpartAuthorityId: null,
    counterpartOwnershipEpoch: null,
    consultCallerRefId: null,
    consultChainToken: null,
    disposition: "active",
  };
}

export function lease(ref: TaskExecutionRef): LeasedTaskExecutionRef {
  return {
    ref,
    companyId: ref.companyId,
    taskId: ref.taskId,
    runId: `run-${ref.id}`,
    attemptId: `attempt-${ref.id}`,
    sessionOperation: "new",
    refOrdinal: 0,
    leaseId: `lease-${ref.id}`,
    leaseGeneration: 1,
    attemptNumber: 1,
    batch: [{ ref, leaseGeneration: 1, attemptNumber: 1 }],
  };
}

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export { describe, expect, it, vi };
export type { TaskExecutionRef, TaskExecutionDispatcherRepository };
export type { TaskExecutionTargetLaneIdentity, LeasedTaskExecutionRef };
