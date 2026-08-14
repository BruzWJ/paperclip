import * as t from "./task-execution-lanes-postgres.test-support.js";
const { describe, it, persistedRef, expect, projectPersistedTaskExecutionRef } = t;
const { classifyExpiredPromptClosure, owner, capability, now } = t;
const { PostgresTaskExecutionDispatchRejected, createMockDb, mocks } = t;
const { createPostgresTaskExecutionDispatcherRepository, repositoryOptions } = t;
const { expiredRecoveryHarness, domainRef, lease, deferred } = t;
const { createTaskExecutionDispatcher, vi } = t;

describe("task-execution target lanes", () => {
  it("projects one canonical persisted ref without aliases or reconstructed message data", () => {
    const row = persistedRef();

    expect(projectPersistedTaskExecutionRef(row as never)).toEqual({
      id: row.id,
      companyId: row.companyId,
      taskId: row.taskId,
      sessionId: row.sessionId,
      ownershipEpoch: 3,
      previousOwnershipEpoch: 2,
      executionScopeId: "scope-1",
      executionLineageId: "lineage-1",
      mode: "owner",
      sourceKind: "task_request",
      sourceId: "source-1",
      sourceRecordId: "record-1",
      messageKind: "user",
      messageId: "message-1",
      exactMessage: "Exact persisted bytes",
      deliveryIdempotencyKey: "delivery-1",
      targetAgentId: row.targetAgentId,
      laneOrdinal: 7,
      taskExecutionAuthorityId: row.taskExecutionAuthorityId,
      consultExecutionId: null,
      adapterConfigRevisionId: row.adapterConfigRevisionId,
      contextEpoch: 2,
      historyViewId: row.historyViewId,
      admissionHighWaterSeq: 19,
      inputId: row.inputId,
      admittedSeq: 20,
      promotedSeq: 21,
      counterpartTaskId: null,
      counterpartAuthorityId: null,
      counterpartOwnershipEpoch: null,
      consultCallerRefId: null,
      consultChainToken: null,
      disposition: "active",
    });
  });

  it("preserves the one fresh-session pre-send retry", () => {
    expect(
      classifyExpiredPromptClosure({
        owner: owner(),
        capability: capability("pre_send_retry"),
      }),
    ).toEqual({
      kind: "retry",
      reason: "transport_transient",
      retryAt: new Date(now.getTime() + 1_000),
    });
  });

  it("terminalizes durable not-sent and transmitted-incomplete closures without replay", () => {
    expect(
      classifyExpiredPromptClosure({
        owner: owner({
          outcome: "released_unsent",
          protocolSettlementState: "not_sent",
        }),
        capability: capability("pre_send_failure"),
      }),
    ).toEqual({
      kind: "terminal",
      outcome: "failed",
      reason: "pre_send_failure",
      protocolSettled: false,
    });
    expect(
      classifyExpiredPromptClosure({
        owner: owner({
          promptTransmissionPhase: "transmitted",
          outcome: "failed",
          protocolSettlementState: "incomplete",
        }),
        capability: capability("prompt_failed_incomplete", {
          activatedAt: new Date(now.getTime() - 1),
        }),
      }),
    ).toEqual({
      kind: "terminal",
      outcome: "failed",
      reason: "prompt_failed_incomplete",
      protocolSettled: false,
    });
    expect(
      classifyExpiredPromptClosure({
        owner: owner({
          promptTransmissionPhase: "transmitted",
          outcome: "cancelled",
          protocolSettlementState: "incomplete",
        }),
        capability: capability("prompt_cancelled_incomplete", {
          activatedAt: new Date(now.getTime() - 1),
        }),
      }),
    ).toEqual({
      kind: "terminal",
      outcome: "cancelled",
      reason: "prompt_cancelled_incomplete",
      protocolSettled: false,
    });
  });

  it("accepts only exact protocol-settled outcomes", () => {
    expect(
      classifyExpiredPromptClosure({
        owner: owner({
          promptTransmissionPhase: "transmitted",
          outcome: "refused",
          protocolSettlementState: "settled",
        }),
        capability: capability("protocol_settled", {
          activatedAt: new Date(now.getTime() - 1),
          targetSessionCorrelationId: "correlation",
        }),
      }),
    ).toEqual({
      kind: "terminal",
      outcome: "succeeded",
      reason: "protocol_settled",
      protocolSettled: true,
    });
    expect(() =>
      classifyExpiredPromptClosure({
        owner: owner({
          promptTransmissionPhase: "transmitted",
          outcome: "ambiguous",
          protocolSettlementState: "incomplete",
        }),
        capability: capability("protocol_settled"),
      }),
    ).toThrow(PostgresTaskExecutionDispatchRejected);
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
    const repository = createPostgresTaskExecutionDispatcherRepository(repositoryOptions(harness.db));

    await expect(repository.resolveLaneForPersistedRef(row.id)).resolves.toEqual({
      lane: {
        companyId: row.companyId,
        taskId: row.taskId,
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
    const repository = createPostgresTaskExecutionDispatcherRepository(repositoryOptions(harness.db));

    await expect(repository.resolveLaneForPersistedRef(row.id)).resolves.toMatchObject({
      disposition: "terminal",
      leaseState: "completed",
      leaseExpiresAt: null,
    });
    expect(harness.remaining("select")).toBe(0);
  });

  it("atomically closes an expired minted authority cancellation and releases the next FIFO ref", async () => {
    const { state, harness, options, repository } = expiredRecoveryHarness({}, true);

    await expect(repository.recoverExpiredLeases({ now, limit: 1 })).resolves.toEqual({
      refIds: [state.nextRef.id],
    });

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
    expect(updatedValues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          state: "revoked",
          revocationReason: "lease_expired",
        }),
        expect.objectContaining({
          outcome: "ambiguous",
          protocolSettlementState: "incomplete",
        }),
        expect.objectContaining({
          state: "cancelled",
          finishedAt: now,
        }),
        expect.objectContaining({
          state: "revoked",
          releasedAt: now,
        }),
        expect.objectContaining({
          state: "completed",
          completedAt: now,
        }),
        expect.objectContaining({
          activeOrdinal: null,
          activeLeaseGeneration: null,
          activeLeaseId: null,
        }),
      ]),
    );
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
    const a1 = domainRef({
      id: "a1",
      targetAgentId: "agent-a",
      executionScopeId: "scope-a",
    });
    const a2 = domainRef({
      id: "a2",
      targetAgentId: "agent-a",
      executionScopeId: "scope-a",
    });
    const b1 = domainRef({
      id: "b1",
      targetAgentId: "agent-b",
      executionScopeId: "scope-b",
    });
    const queues = new Map<string, testSupport.LeasedTaskExecutionRef[]>([
      ["agent-a", [lease(a1), lease(a2)]],
      ["agent-b", [lease(b1)]],
    ]);
    const refs = new Map([
      [a1.id, a1],
      [a2.id, a2],
      [b1.id, b1],
    ]);
    const starts: string[] = [];
    const activeTargets = new Set<string>();
    let maxActive = 0;
    const enteredA1 = deferred();
    const enteredA2 = deferred();
    const enteredB1 = deferred();
    const releaseA1 = deferred();
    const releaseB1 = deferred();
    const repository: testSupport.TaskExecutionDispatcherRepository = {
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
                taskId: ref.taskId,
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
      async leaseNextRef(input: { lane: testSupport.TaskExecutionTargetLaneIdentity }) {
        return queues.get(input.lane.targetAgentId)?.shift() ?? null;
      },
      async assertLeaseCurrent() {},
      async markRetryable() {},
      async markTerminal() {
        return { laneReleased: true };
      },
    };
    const dispatcher = createTaskExecutionDispatcher({
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
    expect(() =>
      createPostgresTaskExecutionDispatcherRepository({
        ...repositoryOptions(harness.db),
        leaseTtlMs: 999,
      }),
    ).toThrow(PostgresTaskExecutionDispatchRejected);
    const repository = createPostgresTaskExecutionDispatcherRepository(repositoryOptions(harness.db));
    await expect(repository.resolveLaneForPersistedRef(" padded ")).rejects.toBeInstanceOf(
      PostgresTaskExecutionDispatchRejected,
    );
    expect(harness.calls).toEqual([]);
  });
});
