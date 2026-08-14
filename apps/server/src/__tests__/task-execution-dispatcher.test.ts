import "./task-execution-dispatcher.test-suite-01-runs-only-the-exact-persisted.js";
import * as t from "./task-execution-dispatcher.test-support.js";
const { describe, it, harness, ref, vi, createTaskExecutionDispatcher, expect } = t;
const { settleResult } = t;

describe("task execution dispatcher", () => {
  it("treats running and settled refs as idempotent notification success", async () => {
    for (const [leaseState, outcome] of [
      ["leased", "running"],
      ["completed", "settled"],
      ["failed", "settled"],
    ] as const) {
      const current = harness(
        ref({
          disposition: leaseState === "leased" ? "active" : "terminal",
        }),
        leaseState,
      );
      const execute = vi.fn();
      const dispatcher = createTaskExecutionDispatcher({
        repository: current.repository,
        executor: { execute },
        steeringResults: { publish: vi.fn() },
        workerId: "worker",
      });
      await expect(dispatcher.notifyPersistedRef("ref")).resolves.toBe(outcome);
      expect(execute).not.toHaveBeenCalled();
    }
  });

  it("rejects an invalidated ref instead of treating it as delivered", async () => {
    const invalidated = harness(ref({ disposition: "invalidated" }));
    const dispatcher = createTaskExecutionDispatcher({
      repository: invalidated.repository,
      executor: { execute: vi.fn() },
      steeringResults: { publish: vi.fn() },
      workerId: "worker",
    });
    await expect(dispatcher.notifyPersistedRef("ref")).rejects.toThrow(/Invalidated refs/);
  });

  it("reconciles expired leases before waking each recovered ref", async () => {
    const recoveredOwner = ref({ id: "recovered-owner" });
    const recoveredConsult = ref({
      id: "recovered-consult",
      mode: "consult",
      targetAgentId: "consult-agent",
      taskExecutionAuthorityId: null,
      consultExecutionId: "consult-execution",
      consultCallerRefId: "caller-ref",
      consultChainToken: "consult-chain",
    });
    const current = harness(recoveredOwner);
    const recoveredAt = new Date("2026-08-01T12:00:00.000Z");
    const recoverExpiredLeases = vi.fn(async () => ({
      refIds: [recoveredConsult.id],
    }));
    const listDispatchableRefIds = vi.fn(async () => [recoveredConsult.id, recoveredOwner.id]);
    const leaseNextRef = vi.fn(async () => null);
    const persisted = new Map([
      [recoveredOwner.id, recoveredOwner],
      [recoveredConsult.id, recoveredConsult],
    ]);
    const repository: testSupport.TaskExecutionDispatcherRepository = {
      ...current.repository,
      recoverExpiredLeases,
      listDispatchableRefIds,
      async resolveLaneForPersistedRef(refId) {
        const value = persisted.get(refId);
        if (!value) return null;
        return {
          lane: {
            companyId: value.companyId,
            taskId: value.taskId,
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
      leaseNextRef,
    };
    const dispatcher = createTaskExecutionDispatcher({
      repository,
      executor: { execute: vi.fn() },
      steeringResults: { publish: vi.fn() },
      workerId: "worker",
      now: () => recoveredAt,
    });

    await expect(dispatcher.reconcilePersistedRefs(2)).resolves.toEqual({
      discovered: 2,
      notified: 2,
      refIds: [recoveredConsult.id, recoveredOwner.id],
    });
    await dispatcher.shutdown();

    expect(recoverExpiredLeases).toHaveBeenCalledOnce();
    expect(recoverExpiredLeases).toHaveBeenCalledWith({
      now: recoveredAt,
      limit: 2,
    });
    expect(listDispatchableRefIds).toHaveBeenCalledWith({
      now: recoveredAt,
      limit: 2,
    });
    expect(leaseNextRef).toHaveBeenCalledTimes(2);
    expect(leaseNextRef.mock.calls.map(([input]) => input.lane.targetAgentId)).toEqual(
      expect.arrayContaining([recoveredConsult.targetAgentId, recoveredOwner.targetAgentId]),
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
    const dispatcher = createTaskExecutionDispatcher({
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
    await expect(dispatcher.notifyPersistedRef("ref")).resolves.toBe("notified");
    await entered;
    await expect(dispatcher.notifyPersistedRef("ref")).resolves.toBe("already_scheduled");
    release();
    await dispatcher.shutdown();
  });

  it("coalesces one target lane while distinct targets in the same Session overlap", async () => {
    const firstRef = ref({
      id: "ref-a",
      targetAgentId: "agent-a",
    });
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
    const repository: testSupport.TaskExecutionDispatcherRepository = {
      ...first.repository,
      async resolveLaneForPersistedRef(refId) {
        const value = persisted.get(refId);
        if (!value) return null;
        return {
          // Fresh structural values prove object identity is not the key.
          lane: {
            companyId: value.companyId,
            taskId: value.taskId,
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
      async leaseNextRef(input: { lane: testSupport.TaskExecutionTargetLaneIdentity }) {
        const lease = available.get(input.lane.targetAgentId) ?? null;
        available.delete(input.lane.targetAgentId);
        return lease;
      },
      markRetryable: vi.fn(),
      markTerminal: vi.fn(async () => ({
        laneReleased: true,
      })),
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
    const dispatcher = createTaskExecutionDispatcher({
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

    await expect(dispatcher.notifyPersistedRef(firstRef.id)).resolves.toBe("notified");
    await firstEntered;
    await expect(dispatcher.notifyPersistedRef(firstRef.id)).resolves.toBe("already_scheduled");
    await expect(dispatcher.notifyPersistedRef(secondRef.id)).resolves.toBe("notified");
    await secondEntered;

    release.get(firstRef.targetAgentId)?.();
    release.get(secondRef.targetAgentId)?.();
    await dispatcher.shutdown();
  });
});
