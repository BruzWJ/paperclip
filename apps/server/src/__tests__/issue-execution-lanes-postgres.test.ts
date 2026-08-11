import { describe, expect, it, vi } from "vitest";
import type { IssueExecutionRef } from "@paperclipai/shared";
import {
  createIssueExecutionDispatcher,
  type IssueExecutionDispatcherRepository,
  type IssueExecutionTargetLaneIdentity,
  type LeasedIssueExecutionRef,
} from "../services/issue-execution-dispatcher.js";
import {
  classifyExpiredPromptClosure,
  createPostgresIssueExecutionDispatcherRepository,
  PostgresIssueExecutionDispatchRejected,
  projectPersistedIssueExecutionRef,
} from "../services/issue-execution-dispatcher-postgres.js";
import { createMockDb } from "./helpers/mock-db.js";

const mocks = vi.hoisted(() => ({
  readAvailability: vi.fn(),
}));

vi.mock("../services/issue-execution-run-service.js", async (importActual) => ({
  ...(await importActual<typeof import("../services/issue-execution-run-service.js")>()),
  readActiveIssueExecutionRefRunAvailability: mocks.readAvailability,
}));

const now = new Date("2026-07-26T18:00:00.000Z");

function persistedRef(overrides: Record<string, unknown> = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000801",
    companyId: "00000000-0000-4000-8000-000000000802",
    issueId: "00000000-0000-4000-8000-000000000803",
    sessionId: "ses_exact_session",
    ownershipEpoch: 3,
    previousOwnershipEpoch: 2,
    executionScopeId: "scope-1",
    executionLineageId: "lineage-1",
    mode: "owner",
    sourceKind: "issue_request",
    sourceId: "source-1",
    sourceRecordId: "record-1",
    messageKind: "user",
    sourceMessageId: "message-1",
    exactMessage: "Exact persisted bytes",
    deliveryIdempotencyKey: "delivery-1",
    targetAgentId: "00000000-0000-4000-8000-000000000804",
    laneOrdinal: 7,
    issueExecutionAuthorityId: "00000000-0000-4000-8000-000000000805",
    consultExecutionId: null,
    adapterConfigRevisionId: "00000000-0000-4000-8000-000000000806",
    contextEpoch: 2,
    historyViewId: "00000000-0000-4000-8000-000000000807",
    admissionHighWaterSeq: 19,
    inputId: "00000000-0000-4000-8000-000000000808",
    admittedSeq: 20,
    promotedSeq: 21,
    counterpartIssueId: null,
    counterpartAuthorityId: null,
    counterpartOwnershipEpoch: null,
    consultCallerRefId: null,
    consultChainToken: null,
    disposition: "active",
    ...overrides,
  };
}

function owner(overrides: Record<string, unknown> = {}) {
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

function capability(
  revocationReason: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    state: "revoked",
    revocationReason,
    revokedAt: now,
    activatedAt: null,
    targetSessionCorrelationId: null,
    ...overrides,
  } as never;
}

function repositoryOptions(db: ReturnType<typeof createMockDb>["db"]) {
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

function expiredAuthorityCancellationFixture(overrides: {
  leaseExpiresAt?: Date;
  cancellationAttemptId?: string;
} = {}) {
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
  const capabilityConnectionId =
    "00000000-0000-4000-8000-000000000815";
  const workspaceId = "00000000-0000-4000-8000-000000000816";
  const createdAt = new Date(now.getTime() - 60_000);
  const updatedAt = new Date(now.getTime() - 30_000);
  const issueIdentity = { companyId: ref.companyId, issueId: ref.issueId };
  const runIdentity = { ...issueIdentity, runId };
  const run = {
    ...issueIdentity,
    id: runId, sessionId: ref.sessionId,
    executionScopeId: ref.executionScopeId,
    kind: "productive", status: "running",
    ownershipEpoch: ref.ownershipEpoch, targetAgentId: ref.targetAgentId,
    adapterConfigRevisionId: ref.adapterConfigRevisionId,
    executionWorkspaceBindingId: workspaceId, executionMode: "owner",
    issueExecutionAuthorityId: ref.issueExecutionAuthorityId,
    consultExecutionId: null, parentRunId: null, retryOfRunId: null,
    currentAttemptId: attemptId, currentLeaseId: leaseId,
    cancellationIntentId: cancellationId, terminalFinalizationId: null,
    startedAt: createdAt, finishedAt: null,
    terminalClassification: null, terminalReasonCode: null,
    createdAt, updatedAt,
  };
  const attempt = {
    ...runIdentity,
    id: attemptId, sessionId: ref.sessionId,
    runKind: "productive", promptKind: "base", sessionOperation: "resume",
    refId: ref.id, refOrdinal: 0, segmentOrdinal: 0,
    steeringSegmentOrdinal: null, attemptGeneration: 1,
    state: "running", startedAt: createdAt, finishedAt: null, createdAt,
  };
  const lease = {
    ...runIdentity,
    id: leaseId, attemptId, leaseGeneration: 1,
    workerId: "worker-old", state: "active",
    acquiredAt: createdAt, renewedAt: updatedAt,
    expiresAt: overrides.leaseExpiresAt ?? new Date(now.getTime() - 1),
    releasedAt: null, createdAt,
  };
  const cancellation = {
    ...runIdentity,
    id: cancellationId,
    attemptId: overrides.cancellationAttemptId ?? attemptId,
    leaseId, reasonKind: "authority", actorKind: "system",
    actorUserId: null, actorAgentId: null, state: "acknowledged",
    requestedAt: new Date(now.getTime() - 20_000),
    acknowledgedAt: new Date(now.getTime() - 19_000),
    nativeCancellationSettledAt: null, completedAt: null,
    failedAt: null, failureCode: null,
    createdAt: new Date(now.getTime() - 20_000),
  };
  const runRef = {
    ...runIdentity,
    sessionId: ref.sessionId, refId: ref.id, refOrdinal: 0,
    admissionOrder: ref.laneOrdinal, batchDigest: "batch-digest",
    inputId: ref.inputId, promptTransmissionPhase: "transmitted",
    outcome: null, outcomeReferenceId: null, protocolSettlementState: null,
    accountingId: null, costEventId: null, settlementVersion: 0,
    attemptId, capabilityConnectionId, capabilityGeneration: 1,
    settledAt: null, createdAt,
  };
  const capability = {
    ...runIdentity,
    capabilityConnectionId, capabilityGeneration: 1,
    runBatchDigest: runRef.batchDigest,
    refId: ref.id, refOrdinal: 0, segmentOrdinal: 0,
    attemptId, leaseId, leaseGeneration: 1,
    workerProcessIdentity: "worker-process",
    ownershipEpoch: ref.ownershipEpoch, targetAgentId: ref.targetAgentId,
    laneKind: "owner", executionMode: "owner",
    issueExecutionAuthorityId: ref.issueExecutionAuthorityId,
    consultExecutionId: null, adapterConfigIdentity: ref.adapterConfigRevisionId,
    workspaceIdentity: workspaceId, targetSessionCorrelationId: null,
    effectiveContextExposureDigest: "context-digest", effectiveToolsDigest: "tools-digest",
    bearerHash: "bearer-hash", ingressHighWater: -1,
    classificationHighWater: -1, state: "active",
    expiresAt: new Date(now.getTime() - 10_000),
    activatedAt: new Date(now.getTime() - 50_000),
    revocationReason: null, revokedAt: null, createdAt,
  };
  return {
    ref, nextRef, run, attempt, lease, cancellation, runRef, capability,
    lane: {
      ...issueIdentity,
      ownershipEpoch: ref.ownershipEpoch, targetAgentId: ref.targetAgentId,
      nextOrdinal: 8, activeOrdinal: ref.laneOrdinal,
      activeLeaseGeneration: 1, activeLeaseId: leaseId,
      createdAt, updatedAt,
    },
    control: { runId, currentRefId: ref.id, currentOrdinal: 0, currentSegmentOrdinal: 0 },
  };
}

type ExpiredAuthorityCancellationState = ReturnType<typeof expiredAuthorityCancellationFixture>;

function expiredRecoverySelects(
  state: ExpiredAuthorityCancellationState,
  terminal = false,
) {
  const rows = [
    [{ leaseId: state.lease.id, runId: state.run.id, ref: state.ref }],
    [{ id: state.ref.companyId }],
    [{ id: state.ref.issueId }],
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

function expiredRecoveryUpdates(state: ExpiredAuthorityCancellationState) {
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

function expiredRecoveryHarness(
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
    repository: createPostgresIssueExecutionDispatcherRepository(options),
  };
}

function domainRef(input: {
  id: string;
  targetAgentId: string;
  executionScopeId?: string;
}): IssueExecutionRef {
  return {
    id: input.id,
    companyId: "company",
    issueId: "issue",
    sessionId: "session",
    ownershipEpoch: 1,
    executionScopeId: input.executionScopeId ?? `scope-${input.id}`,
    executionLineageId: `lineage-${input.id}`,
    mode: "owner",
    sourceKind: "issue_request",
    sourceId: input.id,
    sourceRecordId: input.id,
    messageKind: "user",
    messageId: `message-${input.id}`,
    exactMessage: input.id,
    deliveryIdempotencyKey: `delivery-${input.id}`,
    targetAgentId: input.targetAgentId,
    laneOrdinal: 0,
    issueExecutionAuthorityId: `authority-${input.id}`,
    consultExecutionId: null,
    adapterConfigRevisionId: `revision-${input.id}`,
    contextEpoch: 1,
    historyViewId: `view-${input.id}`,
    admissionHighWaterSeq: 0,
    inputId: `input-${input.id}`,
    admittedSeq: 1,
    promotedSeq: null,
    counterpartIssueId: null,
    counterpartAuthorityId: null,
    counterpartOwnershipEpoch: null,
    consultCallerRefId: null,
    consultChainToken: null,
    disposition: "active",
  };
}

function lease(ref: IssueExecutionRef): LeasedIssueExecutionRef {
  return {
    ref,
    companyId: ref.companyId,
    issueId: ref.issueId,
    runId: `run-${ref.id}`,
    attemptId: `attempt-${ref.id}`,
    promptKind: "base",
    sessionOperation: "new",
    refOrdinal: 0,
    segmentOrdinal: 0,
    leaseId: `lease-${ref.id}`,
    leaseGeneration: 1,
    attemptNumber: 1,
    batch: [{ ref, leaseGeneration: 1, attemptNumber: 1 }],
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("issue-execution target lanes", () => {
  it("projects one canonical persisted ref without aliases or reconstructed message data", () => {
    const row = persistedRef();

    expect(projectPersistedIssueExecutionRef(row as never)).toEqual({
      id: row.id,
      companyId: row.companyId,
      issueId: row.issueId,
      sessionId: row.sessionId,
      ownershipEpoch: 3,
      previousOwnershipEpoch: 2,
      executionScopeId: "scope-1",
      executionLineageId: "lineage-1",
      mode: "owner",
      sourceKind: "issue_request",
      sourceId: "source-1",
      sourceRecordId: "record-1",
      messageKind: "user",
      messageId: "message-1",
      exactMessage: "Exact persisted bytes",
      deliveryIdempotencyKey: "delivery-1",
      targetAgentId: row.targetAgentId,
      laneOrdinal: 7,
      issueExecutionAuthorityId: row.issueExecutionAuthorityId,
      consultExecutionId: null,
      adapterConfigRevisionId: row.adapterConfigRevisionId,
      contextEpoch: 2,
      historyViewId: row.historyViewId,
      admissionHighWaterSeq: 19,
      inputId: row.inputId,
      admittedSeq: 20,
      promotedSeq: 21,
      counterpartIssueId: null,
      counterpartAuthorityId: null,
      counterpartOwnershipEpoch: null,
      consultCallerRefId: null,
      consultChainToken: null,
      disposition: "active",
    });
  });

  it("preserves the one fresh-session pre-send retry", () => {
    expect(classifyExpiredPromptClosure({
      owner: owner(),
      capability: capability("pre_send_retry"),
    })).toEqual({
      kind: "retry",
      reason: "transport_transient",
      retryAt: new Date(now.getTime() + 1_000),
    });
  });

  it("terminalizes durable not-sent and transmitted-incomplete closures without replay", () => {
    expect(classifyExpiredPromptClosure({
      owner: owner({
        outcome: "released_unsent",
        protocolSettlementState: "not_sent",
      }),
      capability: capability("pre_send_failure"),
    })).toEqual({
      kind: "terminal",
      outcome: "failed",
      reason: "pre_send_failure",
      protocolSettled: false,
    });
    expect(classifyExpiredPromptClosure({
      owner: owner({
        promptTransmissionPhase: "transmitted",
        outcome: "failed",
        protocolSettlementState: "incomplete",
      }),
      capability: capability("prompt_failed_incomplete", {
        activatedAt: new Date(now.getTime() - 1),
      }),
    })).toEqual({
      kind: "terminal",
      outcome: "failed",
      reason: "prompt_failed_incomplete",
      protocolSettled: false,
    });
    expect(classifyExpiredPromptClosure({
      owner: owner({
        promptTransmissionPhase: "transmitted",
        outcome: "cancelled",
        protocolSettlementState: "incomplete",
      }),
      capability: capability("prompt_cancelled_incomplete", {
        activatedAt: new Date(now.getTime() - 1),
      }),
    })).toEqual({
      kind: "terminal",
      outcome: "cancelled",
      reason: "prompt_cancelled_incomplete",
      protocolSettled: false,
    });
  });

  it("accepts only exact protocol-settled outcomes", () => {
    expect(classifyExpiredPromptClosure({
      owner: owner({
        promptTransmissionPhase: "transmitted",
        outcome: "refused",
        protocolSettlementState: "settled",
      }),
      capability: capability("protocol_settled", {
        activatedAt: new Date(now.getTime() - 1),
        targetSessionCorrelationId: "correlation",
      }),
    })).toEqual({
      kind: "terminal",
      outcome: "succeeded",
      reason: "protocol_settled",
      protocolSettled: true,
    });
    expect(() => classifyExpiredPromptClosure({
      owner: owner({
        promptTransmissionPhase: "transmitted",
        outcome: "ambiguous",
        protocolSettlementState: "incomplete",
      }),
      capability: capability("protocol_settled"),
    })).toThrow(PostgresIssueExecutionDispatchRejected);
  });

  it("resolves a persisted lane and its retry due time from explicit repository boundaries", async () => {
    const row = persistedRef();
    const retryAt = new Date("2026-07-26T18:01:00.000Z");
    const harness = createMockDb({ select: [[row]] });
    mocks.readAvailability.mockResolvedValueOnce({
      run: { status: "scheduled_retry", currentLeaseId: null },
      leaseExpiresAt: null,
      retryAt,
    });
    const repository = createPostgresIssueExecutionDispatcherRepository(
      repositoryOptions(harness.db),
    );

    await expect(repository.resolveLaneForPersistedRef(row.id)).resolves.toEqual({
      lane: {
        companyId: row.companyId,
        issueId: row.issueId,
        sessionId: row.sessionId,
        ownershipEpoch: row.ownershipEpoch,
        targetAgentId: row.targetAgentId,
      },
      mode: "owner",
      disposition: "active",
      leaseState: "retryable",
      leaseExpiresAt: retryAt,
    });
    expect(mocks.readAvailability).toHaveBeenCalledWith(harness.db, {
      refId: row.id,
    });
    expect(harness.remaining("select")).toBe(0);
  });

  it("derives terminal lease state only from an exact persisted settlement", async () => {
    const row = persistedRef({ disposition: "terminal" });
    const harness = createMockDb({
      select: [[row], [{ outcome: "succeeded" }]],
    });
    mocks.readAvailability.mockResolvedValueOnce(null);
    const repository = createPostgresIssueExecutionDispatcherRepository(
      repositoryOptions(harness.db),
    );

    await expect(repository.resolveLaneForPersistedRef(row.id)).resolves.toMatchObject({
      disposition: "terminal",
      leaseState: "completed",
      leaseExpiresAt: null,
    });
    expect(harness.remaining("select")).toBe(0);
  });

  it("atomically closes an expired minted authority cancellation and releases the next FIFO ref", async () => {
    const { state, harness, options, repository } = expiredRecoveryHarness({}, true);

    await expect(repository.recoverExpiredLeases({ now, limit: 1 }))
      .resolves.toEqual({ refIds: [state.nextRef.id] });

    expect(options.runService.detachCancellation).toHaveBeenCalledWith(
      harness.db,
      expect.objectContaining({
        runId: state.run.id,
        expectedCancellationIntentId: state.cancellation.id,
      }),
    );
    expect(options.runService.detachAttempt).toHaveBeenCalledWith(
      harness.db,
      expect.objectContaining({
        runId: state.run.id,
        expectedAttemptId: state.attempt.id,
        expectedLeaseId: state.lease.id,
      }),
    );
    expect(options.finalizer.finalizeInTransaction).toHaveBeenCalledWith(
      harness.db,
      expect.objectContaining({
        runId: state.run.id,
        status: "cancelled",
        terminalReasonCode: "authority_cancellation",
      }),
    );
    const updatedValues = harness.calls
      .filter((call) => call.operation === "update" && call.method === "set")
      .map((call) => call.args[0]);
    expect(updatedValues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        state: "revoked",
        revocationReason: "lease_expired",
      }),
      expect.objectContaining({
        outcome: "ambiguous",
        protocolSettlementState: "incomplete",
      }),
      expect.objectContaining({ state: "cancelled", finishedAt: now }),
      expect.objectContaining({ state: "revoked", releasedAt: now }),
      expect.objectContaining({ state: "completed", completedAt: now }),
      expect.objectContaining({
        activeOrdinal: null,
        activeLeaseGeneration: null,
        activeLeaseId: null,
      }),
    ]));
    expect(harness.calls.some((call) => call.operation === "insert")).toBe(false);
    expect(harness.remaining("select")).toBe(0);
    expect(harness.remaining("update")).toBe(0);
  });

  it.each([
    {
      name: "does not touch a cancellation-bound run before its exact lease expires",
      overrides: { leaseExpiresAt: new Date(now.getTime() + 1) },
      error: null,
    },
    {
      name: "rejects an expired cancellation whose attempt identity crossed the current run",
      overrides: {
        cancellationAttemptId: "00000000-0000-4000-8000-000000000899",
      },
      error: "expired authority crossed its canonical prompt identity",
    },
  ])("$name", async ({ overrides, error }) => {
    const { harness, options, repository } = expiredRecoveryHarness(overrides);
    const recovery = expect(repository.recoverExpiredLeases({ now, limit: 1 }));
    if (error === null) await recovery.resolves.toEqual({ refIds: [] });
    else await recovery.rejects.toThrow(error);
    expect(options.runService.detachCancellation).not.toHaveBeenCalled();
    expect(options.runService.detachAttempt).not.toHaveBeenCalled();
    expect(options.finalizer.finalizeInTransaction).not.toHaveBeenCalled();
    expect(harness.calls.some((call) => call.operation === "update")).toBe(false);
    expect(harness.remaining("select")).toBe(0);
  });

  it("serializes one target FIFO while a distinct target lane overlaps", async () => {
    const a1 = domainRef({ id: "a1", targetAgentId: "agent-a", executionScopeId: "scope-a" });
    const a2 = domainRef({ id: "a2", targetAgentId: "agent-a", executionScopeId: "scope-a" });
    const b1 = domainRef({ id: "b1", targetAgentId: "agent-b", executionScopeId: "scope-b" });
    const queues = new Map<string, LeasedIssueExecutionRef[]>([
      ["agent-a", [lease(a1), lease(a2)]],
      ["agent-b", [lease(b1)]],
    ]);
    const refs = new Map([[a1.id, a1], [a2.id, a2], [b1.id, b1]]);
    const starts: string[] = [];
    const activeTargets = new Set<string>();
    let maxActive = 0;
    const enteredA1 = deferred();
    const enteredA2 = deferred();
    const enteredB1 = deferred();
    const releaseA1 = deferred();
    const releaseB1 = deferred();
    const repository: IssueExecutionDispatcherRepository = {
      async recoverExpiredLeases() {
        return { refIds: [] };
      },
      async listDispatchableRefIds() {
        return [];
      },
      async resolveLaneForPersistedRef(refId) {
        const ref = refs.get(refId);
        return ref
          ? {
              lane: {
                companyId: ref.companyId,
                issueId: ref.issueId,
                sessionId: ref.sessionId,
                ownershipEpoch: ref.ownershipEpoch,
                targetAgentId: ref.targetAgentId,
              },
              mode: ref.mode,
              disposition: ref.disposition,
              leaseState: "available" as const,
              leaseExpiresAt: null,
            }
          : null;
      },
      async leaseNextRef(input: { lane: IssueExecutionTargetLaneIdentity }) {
        return queues.get(input.lane.targetAgentId)?.shift() ?? null;
      },
      async assertLeaseCurrent() {},
      async markRetryable() {},
      async markTerminal() {
        return { laneReleased: true };
      },
    };
    const dispatcher = createIssueExecutionDispatcher({
      repository,
      workerId: "worker",
      steeringResults: { publish: vi.fn() },
      executor: {
        async execute(current, _signal, settle) {
          const target = current.ref.targetAgentId;
          expect(activeTargets.has(target)).toBe(false);
          activeTargets.add(target);
          maxActive = Math.max(maxActive, activeTargets.size);
          starts.push(current.ref.id);
          if (current.ref.id === "a1") {
            enteredA1.resolve();
            await releaseA1.promise;
          } else if (current.ref.id === "a2") {
            enteredA2.resolve();
          } else {
            enteredB1.resolve();
            await releaseB1.promise;
          }
          await settle({
            result: { kind: "terminal", outcome: "succeeded", reason: null },
            materialization: null,
          });
          activeTargets.delete(target);
          return { kind: "terminal", outcome: "succeeded", reason: null };
        },
      },
    });

    await expect(dispatcher.notifyPersistedRef(a1.id)).resolves.toBe("notified");
    await enteredA1.promise;
    await expect(dispatcher.notifyPersistedRef(a2.id)).resolves.toBe("already_scheduled");
    await expect(dispatcher.notifyPersistedRef(b1.id)).resolves.toBe("notified");
    await enteredB1.promise;
    releaseA1.resolve();
    await enteredA2.promise;
    releaseB1.resolve();
    await dispatcher.shutdown();

    expect(starts).toEqual(["a1", "b1", "a2"]);
    expect(maxActive).toBe(2);
  });

  it("rejects invalid lease timing and inexact ref identities before querying", async () => {
    const harness = createMockDb();
    expect(() => createPostgresIssueExecutionDispatcherRepository({
      ...repositoryOptions(harness.db),
      leaseTtlMs: 999,
    })).toThrow(PostgresIssueExecutionDispatchRejected);
    const repository = createPostgresIssueExecutionDispatcherRepository(
      repositoryOptions(harness.db),
    );
    await expect(repository.resolveLaneForPersistedRef(" padded ")).rejects.toBeInstanceOf(
      PostgresIssueExecutionDispatchRejected,
    );
    expect(harness.calls).toEqual([]);
  });
});
