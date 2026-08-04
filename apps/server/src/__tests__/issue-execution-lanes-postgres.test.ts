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

function attempt(sessionOperation = "new") {
  return { sessionOperation } as never;
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
    } as never,
    compiler: { resolve: vi.fn() } as never,
    finalizer: {
      finalize: vi.fn(),
      finalizeInTransaction: vi.fn(),
      consumeFinalizationOutboxForRun: vi.fn(),
    } as never,
    now: () => now,
    idFactory: () => "00000000-0000-4000-8000-000000000809",
    leaseTtlMs: 60_000,
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

  it("reuses exact target-not-found and pre-send retry decisions", () => {
    expect(classifyExpiredPromptClosure({
      owner: owner(),
      capability: capability("target_not_found"),
      attempt: attempt("resume"),
    })).toEqual({
      kind: "retry",
      reason: "target_not_found_new_session",
      retryAt: now,
    });
    expect(classifyExpiredPromptClosure({
      owner: owner(),
      capability: capability("pre_send_retry"),
      attempt: attempt("new"),
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
      attempt: attempt(),
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
      attempt: attempt(),
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
      attempt: attempt(),
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
      attempt: attempt(),
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
      attempt: attempt(),
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
        return { ownerRefIds: [], releasedConsultRefIds: [] };
      },
      async listDispatchableOwnerRefIds() {
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
      async leaseNextOwnerRef(input: { lane: IssueExecutionTargetLaneIdentity }) {
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
