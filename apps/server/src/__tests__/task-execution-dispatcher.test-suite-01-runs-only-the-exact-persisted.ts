import * as t from "./task-execution-dispatcher.test-support.js";
const { describe, it, harness, vi, expect, settleResult } = t;
const { createTaskExecutionDispatcher, ref, TaskExecutionDispatchRejected } = t;

describe("task execution dispatcher", () => {
  it("runs only the exact persisted ref and terminalizes its lease", async () => {
    const { repository, terminal } = harness();
    const execute = vi.fn(
      async (
        lease: testSupport.LeasedTaskExecutionRef,
        _signal: AbortSignal,
        settle: testSupport.AttemptSettlement,
      ) => {
        expect(lease.ref.exactMessage).toBe("Exact request");
        return settleResult(settle, {
          kind: "terminal" as const,
          outcome: "succeeded" as const,
          reason: null,
        });
      },
    );
    const dispatcher = createTaskExecutionDispatcher({
      repository,
      executor: { execute },
      steeringResults: { publish: vi.fn() },
      workerId: "worker",
    });
    await dispatcher.runPersistedRef("ref");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(terminal).toHaveBeenCalledWith(expect.objectContaining({ outcome: "succeeded" }));
  });

  it("executes an ordered creator-update batch once without rewriting its sources", async () => {
    const first = ref({
      sourceKind: "task_update",
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
      sourceKind: "task_update",
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
        lease: testSupport.LeasedTaskExecutionRef,
        _signal: AbortSignal,
        settle: testSupport.AttemptSettlement,
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
    const dispatcher = createTaskExecutionDispatcher({
      repository: current.repository,
      executor: { execute },
      steeringResults: { publish: vi.fn() },
      workerId: "worker",
    });

    await dispatcher.runPersistedRef(first.id);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(current.terminal).toHaveBeenCalledTimes(1);
    expect(current.terminal.mock.calls[0]?.[0].lease.batch?.map((member) => member.ref.id)).toEqual([
      "ref",
      "ref-2",
    ]);
  });

  it("signals only an exact active attempt and accepts a non-primary creator-batch member", async () => {
    const first = ref({
      sourceKind: "task_update",
      messageKind: "synthetic",
    });
    const second = ref({
      id: "ref-2",
      sourceKind: "task_update",
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
    const dispatcher = createTaskExecutionDispatcher({
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
      taskId: first.taskId,
      sessionId: first.sessionId,
      executionScopeId: first.executionScopeId,
      refId: second.id,
      runId: current.lease.runId,
      attemptId: current.lease.attemptId,
      leaseGeneration: 3,
    };
    for (const mismatch of [
      { ...exact, companyId: "other-company" },
      { ...exact, taskId: "other-task" },
      { ...exact, sessionId: "other-session" },
      { ...exact, executionScopeId: "other-scope" },
      { ...exact, refId: "other-ref" },
      { ...exact, runId: "other-run" },
      { ...exact, attemptId: "other-attempt" },
      { ...exact, leaseGeneration: 4 },
    ]) {
      expect(dispatcher.signalAttemptCancellation(mismatch)).toBe(false);
      expect(activeSignal?.aborted).toBe(false);
    }
    expect(dispatcher.signalAttemptCancellation(exact)).toBe(true);
    expect(activeSignal?.aborted).toBe(true);
    await running;
    expect(current.terminal).toHaveBeenCalledWith(expect.objectContaining({ outcome: "cancelled" }));
  });

  it("cannot apply a stale attempt signal to a later attempt in the same Session", async () => {
    const first = harness(ref({ id: "ref-1" }));
    const secondRef = ref({
      id: "ref-2",
      executionScopeId: "scope-2",
      executionLineageId: "lineage-2",
      historyViewId: "view-2",
    });
    const secondLease: testSupport.LeasedTaskExecutionRef = {
      ref: secondRef,
      companyId: secondRef.companyId,
      taskId: secondRef.taskId,
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
    const repository: testSupport.TaskExecutionDispatcherRepository = {
      ...first.repository,
      async leaseNextRef() {
        return queue.shift() ?? null;
      },
    };
    const dispatcher = createTaskExecutionDispatcher({
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
        taskId: first.lease.ref.taskId,
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
        sourceKind: "task_update",
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
          sourceKind: "task_update",
          messageKind: "synthetic",
        }),
        leaseGeneration: 1,
        attemptNumber: 1,
      },
    ];
    const execute = vi.fn();
    const dispatcher = createTaskExecutionDispatcher({
      repository: current.repository,
      executor: { execute },
      steeringResults: { publish: vi.fn() },
      workerId: "worker",
    });

    await expect(dispatcher.runPersistedRef("ref")).rejects.toThrow(/outside one active execution batch/);
    expect(execute).not.toHaveBeenCalled();
    expect(current.terminal).not.toHaveBeenCalled();
  });

  it("records a retry against the same lease without synthesizing a source", async () => {
    const { repository, retryable, terminal } = harness();
    const dispatcher = createTaskExecutionDispatcher({
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
        lease: expect.objectContaining({
          ref: expect.objectContaining({ id: "ref" }),
        }),
        reason: "transport_transient",
      }),
    );
    expect(terminal).not.toHaveBeenCalled();
  });

  it("rejects unknown refs and dispatches a persisted consult", async () => {
    const owner = harness();
    const dispatcher = createTaskExecutionDispatcher({
      repository: owner.repository,
      executor: { execute: vi.fn() },
      steeringResults: { publish: vi.fn() },
      workerId: "worker",
    });
    await expect(dispatcher.runPersistedRef("unknown")).rejects.toBeInstanceOf(TaskExecutionDispatchRejected);

    const consult = harness(
      ref({
        mode: "consult",
        taskExecutionAuthorityId: null,
        consultExecutionId: "consult",
        consultCallerRefId: "caller",
        consultChainToken: "chain",
      }),
    );
    const executeConsult = vi.fn(
      async (
        _lease: testSupport.LeasedTaskExecutionRef,
        _signal: AbortSignal,
        settle: testSupport.AttemptSettlement,
      ) =>
        settleResult(settle, {
          kind: "terminal" as const,
          outcome: "succeeded" as const,
          reason: null,
        }),
    );
    const consultDispatcher = createTaskExecutionDispatcher({
      repository: consult.repository,
      executor: { execute: executeConsult },
      steeringResults: { publish: vi.fn() },
      workerId: "worker",
    });
    await consultDispatcher.runPersistedRef("ref");
    expect(executeConsult).toHaveBeenCalledOnce();
  });
});
