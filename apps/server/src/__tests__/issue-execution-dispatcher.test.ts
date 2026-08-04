import { describe, expect, it, vi } from "vitest";
import type { IssueExecutionRef } from "@paperclipai/shared";
import {
  IssueExecutionDispatchRejected,
  createIssueExecutionDispatcher,
  type IssueExecutionAttemptExecutor,
  type IssueExecutionDispatcherRepository,
  type IssueExecutionTargetLaneIdentity,
  type LeasedIssueExecutionRef,
} from "../services/issue-execution-dispatcher.js";

type AttemptSettlement = Parameters<
  IssueExecutionAttemptExecutor["execute"]
>[2];

async function settleResult<T extends Awaited<
  ReturnType<IssueExecutionAttemptExecutor["execute"]>
>>(settle: AttemptSettlement, result: T): Promise<T> {
  await settle({ result, materialization: null });
  return result;
}

function ref(change: Partial<IssueExecutionRef> = {}): IssueExecutionRef {
  return {
    id: "ref",
    companyId: "company",
    issueId: "issue",
    sessionId: "session",
    ownershipEpoch: 1,
    executionScopeId: "scope",
    executionLineageId: "lineage",
    mode: "owner",
    sourceKind: "issue_request",
    sourceId: "source",
    sourceRecordId: "issue",
    messageKind: "user",
    messageId: "message",
    exactMessage: "Exact request",
    deliveryIdempotencyKey: "delivery",
    targetAgentId: "agent",
    laneOrdinal: 0,
    issueExecutionAuthorityId: "authority",
    consultExecutionId: null,
    adapterConfigRevisionId: "revision",
    contextEpoch: 1,
    historyViewId: "view",
    admissionHighWaterSeq: 0,
    inputId: "input",
    admittedSeq: 1,
    promotedSeq: null,
    counterpartIssueId: null,
    counterpartAuthorityId: null,
    counterpartOwnershipEpoch: null,
    consultCallerRefId: null,
    consultChainToken: null,
    disposition: "active",
    ...change,
  };
}

function harness(
  value = ref(),
  leaseState:
    | "available"
    | "leased"
    | "retryable"
    | "completed"
    | "failed" = "available",
  leaseExpiresAt: Date | null =
    leaseState === "leased"
      ? new Date("2999-01-01T00:00:00.000Z")
      : null,
) {
  const lease: LeasedIssueExecutionRef = {
    ref: value,
    companyId: value.companyId,
    issueId: value.issueId,
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
  const terminal = vi.fn(async () => ({ laneReleased: true }));
  const repository: IssueExecutionDispatcherRepository = {
    async recoverExpiredLeases() {
      return { ownerRefIds: [], releasedConsultRefIds: [] };
    },
    async listDispatchableOwnerRefIds() {
      return [];
    },
    async resolveLaneForPersistedRef(refId) {
      return refId === value.id
        ? {
            lane: {
              companyId: value.companyId,
              issueId: value.issueId,
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
    async leaseNextOwnerRef() {
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

describe("issue execution dispatcher", () => {
  it("runs only the exact persisted ref and terminalizes its lease", async () => {
    const { repository, terminal } = harness();
    const execute = vi.fn(async (
      lease: LeasedIssueExecutionRef,
      _signal: AbortSignal,
      settle: AttemptSettlement,
    ) => {
      expect(lease.ref.exactMessage).toBe("Exact request");
      return settleResult(settle, {
        kind: "terminal" as const,
        outcome: "succeeded" as const,
        reason: null,
      });
    });
    const dispatcher = createIssueExecutionDispatcher({
      repository,
      executor: { execute },
      steeringResults: { publish: vi.fn() },
      workerId: "worker",
    });
    await dispatcher.runPersistedRef("ref");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(terminal).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "succeeded" }),
    );
  });

  it("executes an ordered creator-update batch once without rewriting its sources", async () => {
    const first = ref({
      sourceKind: "creator_update",
      sourceId: "source-1",
      sourceRecordId: "delivery-1",
      messageKind: "synthetic",
      messageId: "message-1",
      exactMessage: "First committed update",
      deliveryIdempotencyKey: "delivery-key-1",
      inputId: null,
      admittedSeq: null,
    });
    const second = ref({
      id: "ref-2",
      sourceKind: "creator_update",
      sourceId: "source-2",
      sourceRecordId: "delivery-2",
      messageKind: "synthetic",
      messageId: "message-2",
      exactMessage: "Second committed update",
      deliveryIdempotencyKey: "delivery-key-2",
      historyViewId: "view-2",
      laneOrdinal: 1,
      inputId: null,
      admittedSeq: null,
    });
    const current = harness(first);
    current.lease.batch = [
      {
        ref: first,
        leaseGeneration: 1,
        attemptNumber: 1,
      },
      {
        ref: second,
        leaseGeneration: 1,
        attemptNumber: 1,
      },
    ];
    const execute = vi.fn(
      async (
        lease: LeasedIssueExecutionRef,
        _signal: AbortSignal,
        settle: AttemptSettlement,
      ) => {
        expect(
          lease.batch?.map((member) => ({
            refId: member.ref.id,
            sourceRecordId: member.ref.sourceRecordId,
            exactMessage: member.ref.exactMessage,
          })),
        ).toEqual([
          {
            refId: "ref",
            sourceRecordId: "delivery-1",
            exactMessage: "First committed update",
          },
          {
            refId: "ref-2",
            sourceRecordId: "delivery-2",
            exactMessage: "Second committed update",
          },
        ]);
        return settleResult(settle, {
          kind: "terminal" as const,
          outcome: "succeeded" as const,
          reason: null,
        });
      },
    );
    const dispatcher = createIssueExecutionDispatcher({
      repository: current.repository,
      executor: { execute },
      steeringResults: { publish: vi.fn() },
      workerId: "worker",
    });

    await dispatcher.runPersistedRef(first.id);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(current.terminal).toHaveBeenCalledTimes(1);
    expect(
      current.terminal.mock.calls[0]?.[0].lease.batch?.map(
        (member) => member.ref.id,
      ),
    ).toEqual(["ref", "ref-2"]);
  });

  it("signals only an exact active attempt and accepts a non-primary creator-batch member", async () => {
    const first = ref({
      sourceKind: "creator_update",
      messageKind: "synthetic",
    });
    const second = ref({
      id: "ref-2",
      sourceKind: "creator_update",
      messageKind: "synthetic",
      historyViewId: "view-2",
    });
    const current = harness(first);
    current.lease.batch = [
      {
        ref: first,
        leaseGeneration: 1,
        attemptNumber: 1,
      },
      {
        ref: second,
        leaseGeneration: 3,
        attemptNumber: 1,
      },
    ];
    let activeSignal: AbortSignal | null = null;
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const dispatcher = createIssueExecutionDispatcher({
      repository: current.repository,
      executor: {
        execute(_lease, signal, settle) {
          activeSignal = signal;
          markEntered();
          return new Promise((resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                const result = {
                  kind: "terminal",
                  outcome: "cancelled",
                  reason: "exact cancellation",
                } as const;
                void settleResult(settle, result).then(resolve, reject);
              },
              { once: true },
            );
          });
        },
      },
      steeringResults: { publish: vi.fn() },
      workerId: "worker",
    });
    const running = dispatcher.runPersistedRef(first.id);
    await entered;
    const exact = {
      companyId: first.companyId,
      issueId: first.issueId,
      sessionId: first.sessionId,
      executionScopeId: first.executionScopeId,
      refId: second.id,
      runId: current.lease.runId,
      attemptId: current.lease.attemptId,
      leaseGeneration: 3,
    };
    for (const mismatch of [
      { ...exact, companyId: "other-company" },
      { ...exact, issueId: "other-issue" },
      { ...exact, sessionId: "other-session" },
      { ...exact, executionScopeId: "other-scope" },
      { ...exact, refId: "other-ref" },
      { ...exact, runId: "other-run" },
      { ...exact, attemptId: "other-attempt" },
      { ...exact, leaseGeneration: 4 },
    ]) {
      expect(
        dispatcher.signalAttemptCancellation(mismatch),
      ).toBe(false);
      expect(activeSignal?.aborted).toBe(false);
    }
    expect(dispatcher.signalAttemptCancellation(exact)).toBe(true);
    expect(activeSignal?.aborted).toBe(true);
    await running;
    expect(current.terminal).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "cancelled" }),
    );
  });

  it("cannot apply a stale attempt signal to a later attempt in the same Session", async () => {
    const first = harness(ref({ id: "ref-1" }));
    const secondRef = ref({
      id: "ref-2",
      executionScopeId: "scope-2",
      executionLineageId: "lineage-2",
      historyViewId: "view-2",
    });
    const secondLease: LeasedIssueExecutionRef = {
      ref: secondRef,
      companyId: secondRef.companyId,
      issueId: secondRef.issueId,
      runId: "run-2",
      attemptId: "attempt-2",
      promptKind: "base",
      sessionOperation: "new",
      refOrdinal: 0,
      segmentOrdinal: 0,
      leaseId: "lease-2",
      leaseGeneration: 2,
      attemptNumber: 1,
      batch: [{ ref: secondRef, leaseGeneration: 2, attemptNumber: 1 }],
    };
    const queue = [first.lease, secondLease];
    let secondSignal: AbortSignal | null = null;
    let markSecondEntered!: () => void;
    const secondEntered = new Promise<void>((resolve) => {
      markSecondEntered = resolve;
    });
    let releaseSecond!: () => void;
    const secondReleased = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const repository: IssueExecutionDispatcherRepository = {
      ...first.repository,
      async leaseNextOwnerRef() {
        return queue.shift() ?? null;
      },
    };
    const dispatcher = createIssueExecutionDispatcher({
      repository,
      executor: {
        async execute(lease, signal, settle) {
          if (lease.leaseId === secondLease.leaseId) {
            secondSignal = signal;
            markSecondEntered();
            await secondReleased;
          }
          return settleResult(settle, {
            kind: "terminal",
            outcome: "succeeded",
            reason: null,
          });
        },
      },
      steeringResults: { publish: vi.fn() },
      workerId: "worker",
    });
    const running = dispatcher.runPersistedRef(first.lease.ref.id);
    await secondEntered;
    expect(
      dispatcher.signalAttemptCancellation({
        companyId: first.lease.ref.companyId,
        issueId: first.lease.ref.issueId,
        sessionId: first.lease.ref.sessionId,
        executionScopeId: first.lease.ref.executionScopeId,
        refId: first.lease.ref.id,
        runId: first.lease.runId,
        attemptId: first.lease.attemptId,
        leaseGeneration: first.lease.leaseGeneration,
      }),
    ).toBe(false);
    expect(secondSignal?.aborted).toBe(false);
    releaseSecond();
    await running;
  });

  it("rejects a repository batch that crosses execution scopes", async () => {
    const current = harness(
      ref({
        sourceKind: "creator_update",
        messageKind: "synthetic",
      }),
    );
    current.lease.batch = [
      {
        ref: current.lease.ref,
        leaseGeneration: 1,
        attemptNumber: 1,
      },
      {
        ref: ref({
          id: "ref-2",
          executionScopeId: "other-scope",
          sourceKind: "creator_update",
          messageKind: "synthetic",
        }),
        leaseGeneration: 1,
        attemptNumber: 1,
      },
    ];
    const execute = vi.fn();
    const dispatcher = createIssueExecutionDispatcher({
      repository: current.repository,
      executor: { execute },
      steeringResults: { publish: vi.fn() },
      workerId: "worker",
    });

    await expect(
      dispatcher.runPersistedRef("ref"),
    ).rejects.toThrow(/outside one active owner execution batch/);
    expect(execute).not.toHaveBeenCalled();
    expect(current.terminal).not.toHaveBeenCalled();
  });

  it("records a retry against the same lease without synthesizing a source", async () => {
    const { repository, retryable, terminal } = harness();
    const dispatcher = createIssueExecutionDispatcher({
      repository,
      executor: {
        async execute(_lease, _signal, settle) {
          return settleResult(settle, {
            kind: "retry",
            reason: "transport_transient",
            retryAt: new Date("2026-07-25T01:00:00.000Z"),
          });
        },
      },
      steeringResults: { publish: vi.fn() },
      workerId: "worker",
    });
    await dispatcher.runPersistedRef("ref");
    expect(retryable).toHaveBeenCalledWith(
      expect.objectContaining({
        lease: expect.objectContaining({ ref: expect.objectContaining({ id: "ref" }) }),
        reason: "transport_transient",
      }),
    );
    expect(terminal).not.toHaveBeenCalled();
  });

  it("rejects unknown and consult refs at the top-level queue", async () => {
    const owner = harness();
    const dispatcher = createIssueExecutionDispatcher({
      repository: owner.repository,
      executor: { execute: vi.fn() },
      steeringResults: { publish: vi.fn() },
      workerId: "worker",
    });
    await expect(dispatcher.runPersistedRef("unknown")).rejects.toBeInstanceOf(
      IssueExecutionDispatchRejected,
    );

    const consult = harness(
      ref({
        mode: "consult",
        issueExecutionAuthorityId: null,
        consultExecutionId: "consult",
        consultCallerRefId: "caller",
        consultChainToken: "chain",
      }),
    );
    const consultDispatcher = createIssueExecutionDispatcher({
      repository: consult.repository,
      executor: { execute: vi.fn() },
      steeringResults: { publish: vi.fn() },
      workerId: "worker",
    });
    await expect(
      consultDispatcher.runPersistedRef("ref"),
    ).rejects.toThrow(/synchronously/);
  });

  it("treats running and settled refs as idempotent notification success", async () => {
    for (const [leaseState, outcome] of [
      ["leased", "running"],
      ["completed", "settled"],
      ["failed", "settled"],
    ] as const) {
      const current = harness(
        ref({
          disposition:
            leaseState === "leased" ? "active" : "terminal",
        }),
        leaseState,
      );
      const execute = vi.fn();
      const dispatcher = createIssueExecutionDispatcher({
        repository: current.repository,
        executor: { execute },
        steeringResults: { publish: vi.fn() },
        workerId: "worker",
      });
      await expect(
        dispatcher.notifyPersistedRef("ref"),
      ).resolves.toBe(outcome);
      expect(execute).not.toHaveBeenCalled();
    }
  });

  it("rejects an invalidated ref instead of treating it as delivered", async () => {
    const invalidated = harness(
      ref({ disposition: "invalidated" }),
    );
    const dispatcher = createIssueExecutionDispatcher({
      repository: invalidated.repository,
      executor: { execute: vi.fn() },
      steeringResults: { publish: vi.fn() },
      workerId: "worker",
    });
    await expect(
      dispatcher.notifyPersistedRef("ref"),
    ).rejects.toThrow(/Invalidated refs/);
  });

  it("wakes the exact owner lane only after a persisted consult is settled", async () => {
    const owner = ref({ id: "owner-successor" });
    const current = harness(owner);
    const consult = ref({
      id: "settled-consult",
      mode: "consult",
      disposition: "terminal",
      issueExecutionAuthorityId: null,
      consultExecutionId: "consult-execution",
      consultCallerRefId: "caller-ref",
      consultChainToken: "consult-chain",
    });
    let completeExecution!: () => void;
    const executionCompleted = new Promise<void>((resolve) => {
      completeExecution = resolve;
    });
    const repository: IssueExecutionDispatcherRepository = {
      ...current.repository,
      async resolveLaneForPersistedRef(refId) {
        if (refId !== consult.id) return null;
        return {
          lane: {
            companyId: consult.companyId,
            issueId: consult.issueId,
            sessionId: consult.sessionId,
            ownershipEpoch: consult.ownershipEpoch,
            targetAgentId: consult.targetAgentId,
          },
          mode: consult.mode,
          disposition: consult.disposition,
          leaseState: "completed",
          leaseExpiresAt: null,
        };
      },
    };
    const execute = vi.fn(async (
      leased: LeasedIssueExecutionRef,
      _signal: AbortSignal,
      settle: AttemptSettlement,
    ) => {
      expect(leased.ref.id).toBe(owner.id);
      const result = await settleResult(settle, {
        kind: "terminal" as const,
        outcome: "succeeded" as const,
        reason: null,
      });
      completeExecution();
      return result;
    });
    const dispatcher = createIssueExecutionDispatcher({
      repository,
      executor: { execute },
      steeringResults: { publish: vi.fn() },
      workerId: "worker",
    });

    await dispatcher.notifyReleasedConsultRef(consult.id);
    await executionCompleted;

    expect(execute).toHaveBeenCalledOnce();
    await dispatcher.shutdown();
  });

  it("rejects released-lane notification before the consult is terminal and settled", async () => {
    const consult = harness(
      ref({
        mode: "consult",
        issueExecutionAuthorityId: null,
        consultExecutionId: "consult-execution",
        consultCallerRefId: "caller-ref",
        consultChainToken: "consult-chain",
      }),
      "leased",
    );
    const dispatcher = createIssueExecutionDispatcher({
      repository: consult.repository,
      executor: { execute: vi.fn() },
      steeringResults: { publish: vi.fn() },
      workerId: "worker",
    });

    await expect(
      dispatcher.notifyReleasedConsultRef("ref"),
    ).rejects.toThrow(/terminal and settled/);
  });

  it("reconciles expired leases before waking each recovered owner and released consult lane", async () => {
    const recoveredOwner = ref({ id: "recovered-owner" });
    const discoveredOwner = ref({
      id: "discovered-owner",
      targetAgentId: "discovered-agent",
      executionScopeId: "discovered-scope",
      executionLineageId: "discovered-lineage",
      historyViewId: "discovered-view",
    });
    const releasedConsult = ref({
      id: "released-consult",
      mode: "consult",
      disposition: "terminal",
      targetAgentId: "consult-agent",
      issueExecutionAuthorityId: null,
      consultExecutionId: "consult-execution",
      consultCallerRefId: "caller-ref",
      consultChainToken: "consult-chain",
    });
    const current = harness(recoveredOwner);
    const recoveredAt = new Date("2026-08-01T12:00:00.000Z");
    const recoverExpiredLeases = vi.fn(async () => ({
      ownerRefIds: [recoveredOwner.id],
      releasedConsultRefIds: [releasedConsult.id],
    }));
    const listDispatchableOwnerRefIds = vi.fn(async () => [
      recoveredOwner.id,
      discoveredOwner.id,
    ]);
    const leaseNextOwnerRef = vi.fn(async () => null);
    const persisted = new Map([
      [recoveredOwner.id, recoveredOwner],
      [discoveredOwner.id, discoveredOwner],
      [releasedConsult.id, releasedConsult],
    ]);
    const repository: IssueExecutionDispatcherRepository = {
      ...current.repository,
      recoverExpiredLeases,
      listDispatchableOwnerRefIds,
      async resolveLaneForPersistedRef(refId) {
        const value = persisted.get(refId);
        if (!value) return null;
        return {
          lane: {
            companyId: value.companyId,
            issueId: value.issueId,
            sessionId: value.sessionId,
            ownershipEpoch: value.ownershipEpoch,
            targetAgentId: value.targetAgentId,
          },
          mode: value.mode,
          disposition: value.disposition,
          leaseState:
            value.mode === "consult" ? "completed" : "available",
          leaseExpiresAt: null,
        };
      },
      leaseNextOwnerRef,
    };
    const dispatcher = createIssueExecutionDispatcher({
      repository,
      executor: { execute: vi.fn() },
      steeringResults: { publish: vi.fn() },
      workerId: "worker",
      now: () => recoveredAt,
    });

    await expect(dispatcher.reconcilePersistedRefs(2)).resolves.toEqual({
      discovered: 2,
      notified: 2,
      refIds: [recoveredOwner.id, discoveredOwner.id],
    });
    await dispatcher.shutdown();

    expect(recoverExpiredLeases).toHaveBeenCalledOnce();
    expect(recoverExpiredLeases).toHaveBeenCalledWith({
      now: recoveredAt,
      limit: 2,
    });
    expect(listDispatchableOwnerRefIds).toHaveBeenCalledWith({
      now: recoveredAt,
      limit: 2,
    });
    expect(leaseNextOwnerRef).toHaveBeenCalledTimes(3);
    expect(
      leaseNextOwnerRef.mock.calls.map(([input]) => input.lane.targetAgentId),
    ).toEqual(
      expect.arrayContaining([
        releasedConsult.targetAgentId,
        recoveredOwner.targetAgentId,
        discoveredOwner.targetAgentId,
      ]),
    );
  });

  it("coalesces a duplicate notification into the active target-lane drain", async () => {
    const current = harness();
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const dispatcher = createIssueExecutionDispatcher({
      repository: current.repository,
      executor: {
        async execute(_lease, _signal, settle) {
          markEntered();
          await released;
          return settleResult(settle, {
            kind: "terminal",
            outcome: "succeeded",
            reason: null,
          });
        },
      },
      steeringResults: { publish: vi.fn() },
      workerId: "worker",
    });
    await expect(
      dispatcher.notifyPersistedRef("ref"),
    ).resolves.toBe("notified");
    await entered;
    await expect(
      dispatcher.notifyPersistedRef("ref"),
    ).resolves.toBe("already_scheduled");
    release();
    await dispatcher.shutdown();
  });

  it("coalesces one target lane while distinct targets in the same Session overlap", async () => {
    const firstRef = ref({ id: "ref-a", targetAgentId: "agent-a" });
    const secondRef = ref({
      id: "ref-b",
      targetAgentId: "agent-b",
      executionScopeId: "scope-b",
      executionLineageId: "lineage-b",
      historyViewId: "view-b",
    });
    const first = harness(firstRef);
    const second = harness(secondRef);
    second.lease.runId = "run-b";
    second.lease.attemptId = "attempt-b";
    second.lease.leaseId = "lease-b";
    const available = new Map([
      [firstRef.targetAgentId, first.lease],
      [secondRef.targetAgentId, second.lease],
    ]);
    const persisted = new Map([
      [firstRef.id, firstRef],
      [secondRef.id, secondRef],
    ]);
    const repository: IssueExecutionDispatcherRepository = {
      ...first.repository,
      async resolveLaneForPersistedRef(refId) {
        const value = persisted.get(refId);
        if (!value) return null;
        return {
          // Fresh structural values prove object identity is not the key.
          lane: {
            companyId: value.companyId,
            issueId: value.issueId,
            sessionId: value.sessionId,
            ownershipEpoch: value.ownershipEpoch,
            targetAgentId: value.targetAgentId,
          },
          mode: value.mode,
          disposition: value.disposition,
          leaseState: "available",
          leaseExpiresAt: null,
        };
      },
      async leaseNextOwnerRef(input: {
        lane: IssueExecutionTargetLaneIdentity;
      }) {
        const lease = available.get(input.lane.targetAgentId) ?? null;
        available.delete(input.lane.targetAgentId);
        return lease;
      },
      markRetryable: vi.fn(),
      markTerminal: vi.fn(async () => ({ laneReleased: true })),
    };
    const entered = new Map<string, () => void>();
    const released = new Map<string, Promise<void>>();
    const release = new Map<string, () => void>();
    const firstEntered = new Promise<void>((resolve) => {
      entered.set(firstRef.targetAgentId, resolve);
    });
    const secondEntered = new Promise<void>((resolve) => {
      entered.set(secondRef.targetAgentId, resolve);
    });
    for (const agentId of [firstRef.targetAgentId, secondRef.targetAgentId]) {
      released.set(
        agentId,
        new Promise<void>((resolve) => {
          release.set(agentId, resolve);
        }),
      );
    }
    const dispatcher = createIssueExecutionDispatcher({
      repository,
      executor: {
        async execute(lease, _signal, settle) {
          entered.get(lease.ref.targetAgentId)?.();
          await released.get(lease.ref.targetAgentId);
          return settleResult(settle, {
            kind: "terminal",
            outcome: "succeeded",
            reason: null,
          });
        },
      },
      steeringResults: { publish: vi.fn() },
      workerId: "worker",
    });

    await expect(dispatcher.notifyPersistedRef(firstRef.id)).resolves.toBe(
      "notified",
    );
    await firstEntered;
    await expect(dispatcher.notifyPersistedRef(firstRef.id)).resolves.toBe(
      "already_scheduled",
    );
    await expect(dispatcher.notifyPersistedRef(secondRef.id)).resolves.toBe(
      "notified",
    );
    await secondEntered;

    release.get(firstRef.targetAgentId)?.();
    release.get(secondRef.targetAgentId)?.();
    await dispatcher.shutdown();
  });
});
