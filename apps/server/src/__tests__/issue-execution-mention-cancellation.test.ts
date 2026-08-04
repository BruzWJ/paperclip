import { describe, expect, it, vi } from "vitest";
import type { IssueExecutionRef } from "@paperclipai/shared";
import {
  createIssueExecutionMentionExecutor,
  IssueExecutionAttemptRejected,
  IssueExecutionPromptAuthorityLost,
} from "../services/issue-execution-attempt-executor.js";
import type {
  LeasedIssueExecutionConsultRun,
  LeasedIssueExecutionRef,
} from "../services/issue-execution-dispatcher.js";
import type {
  RuntimeMentionExecutionInput,
} from "../services/runtime-issue-action-port.js";

function consultRef(
  change: Partial<IssueExecutionRef> = {},
): IssueExecutionRef {
  return {
    id: "consult-ref",
    companyId: "company",
    issueId: "issue",
    sessionId: "session",
    ownershipEpoch: 3,
    previousOwnershipEpoch: null,
    executionScopeId: "scope",
    executionLineageId: "lineage",
    mode: "consult",
    sourceKind: "human_comment_mention",
    sourceId: "source",
    sourceRecordId: "record",
    messageKind: "user",
    messageId: "message",
    exactMessage: "Ask the specialist",
    deliveryIdempotencyKey: "delivery",
    targetAgentId: "specialist",
    laneOrdinal: 0,
    issueExecutionAuthorityId: null,
    consultExecutionId: "consult",
    adapterConfigRevisionId: "revision",
    contextEpoch: 1,
    historyViewId: "view",
    admissionHighWaterSeq: 4,
    inputId: "input",
    admittedSeq: 5,
    promotedSeq: 6,
    counterpartIssueId: null,
    counterpartAuthorityId: null,
    counterpartOwnershipEpoch: null,
    consultCallerRefId: "caller-ref",
    consultChainToken: "chain",
    disposition: "active",
    ...change,
  };
}

function input(
  ref = consultRef(),
): RuntimeMentionExecutionInput {
  return {
    companyId: ref.companyId,
    issueId: ref.issueId,
    sessionId: ref.sessionId,
    ownershipEpoch: ref.ownershipEpoch,
    consultExecutionId: ref.consultExecutionId!,
    sourceRunId: "caller-run",
    sourceRefId: ref.consultCallerRefId!,
    targetAgentId: ref.targetAgentId,
    adapterConfigRevisionId: ref.adapterConfigRevisionId,
    chainToken: ref.consultChainToken!,
    ref,
  };
}

function lease(ref = consultRef()): LeasedIssueExecutionRef {
  const leased = {
    ref,
    companyId: ref.companyId,
    issueId: ref.issueId,
    runId: "consult-run",
    attemptId: "consult-attempt",
    promptKind: "base",
    sessionOperation: "new",
    refOrdinal: 0,
    segmentOrdinal: 0,
    leaseId: "consult-lease",
    leaseGeneration: 7,
    attemptNumber: 2,
  };
  return {
    ...leased,
    batch: [{
      ref,
      leaseGeneration: leased.leaseGeneration,
      attemptNumber: leased.attemptNumber,
    }],
  };
}

function consultRun(
  currentLease: LeasedIssueExecutionRef,
  change: Partial<LeasedIssueExecutionConsultRun> = {},
): LeasedIssueExecutionConsultRun {
  return {
    companyId: currentLease.companyId,
    issueId: currentLease.issueId,
    runId: currentLease.runId,
    sessionId: currentLease.ref.sessionId,
    executionScopeId: currentLease.ref.executionScopeId,
    kind: "consult",
    ownershipEpoch: currentLease.ref.ownershipEpoch,
    targetAgentId: currentLease.ref.targetAgentId,
    adapterConfigRevisionId: currentLease.ref.adapterConfigRevisionId,
    executionWorkspaceBindingId: "workspace",
    executionMode: "consult",
    issueExecutionAuthorityId: null,
    consultExecutionId: currentLease.ref.consultExecutionId!,
    parentRunId: "caller-run",
    retryOfRunId: null,
    currentAttemptId: currentLease.attemptId,
    currentLeaseId: currentLease.leaseId,
    ...change,
  };
}

function leasedAcquisition(
  currentLease: LeasedIssueExecutionRef,
  runChange: Partial<LeasedIssueExecutionConsultRun> = {},
) {
  return {
    kind: "leased" as const,
    lease: currentLease,
    run: consultRun(currentLease, runChange),
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function noAuthorityLossRecovery() {
  return vi.fn(async () => ({ kind: "not_recoverable" as const }));
}

describe("nested mention cancellation", () => {
  it("keeps the consult call open across exact-run steering and returns the resumed response", async () => {
    const baseLease = lease();
    const steeringLease: LeasedIssueExecutionRef = {
      ...baseLease,
      attemptId: "steering-attempt",
      promptKind: "steering",
      sessionOperation: "steer_resume",
      segmentOrdinal: 1,
      leaseId: "steering-lease",
      leaseGeneration: 8,
      attemptNumber: 3,
      batch: [{
        ref: baseLease.ref,
        leaseGeneration: 8,
        attemptNumber: 3,
      }],
    };
    const baseEntered = deferred();
    const publish = vi.fn();
    const repository = {
      leasePersistedConsultRef: vi
        .fn()
        .mockResolvedValueOnce(leasedAcquisition(baseLease))
        .mockResolvedValueOnce(leasedAcquisition(steeringLease)),
      recoverConsultAfterAuthorityLoss: noAuthorityLossRecovery(),
      markRetryable: vi.fn(),
      markTerminal: vi.fn().mockResolvedValue({ laneReleased: false }),
    };
    let executionNumber = 0;
    const mentionExecutor = createIssueExecutionMentionExecutor({
      workerId: "worker",
      repository: repository as never,
      steeringResults: { publish },
      notifyReleasedConsultRef: vi.fn(),
      executor: {
        execute: vi.fn(async (_selection, signal, settle) => {
          executionNumber += 1;
          if (executionNumber === 1) {
            baseEntered.resolve();
            await new Promise<void>((resolve) => {
              signal.addEventListener("abort", () => resolve(), {
                once: true,
              });
            });
            const cancelled = {
              kind: "terminal" as const,
              outcome: "cancelled" as const,
              reason: "steered",
              finalText: "interrupted",
            };
            await settle({ result: cancelled, materialization: null });
            return cancelled;
          }
          const succeeded = {
            kind: "terminal" as const,
            outcome: "succeeded" as const,
            reason: null,
            finalText: "resumed answer",
          };
          await settle({ result: succeeded, materialization: null });
          return succeeded;
        }),
      },
    });

    const execution = mentionExecutor.executeMention(input());
    await baseEntered.promise;
    expect(
      mentionExecutor.signalAttemptCancellation({
        companyId: "company",
        issueId: "issue",
        sessionId: "session",
        executionScopeId: "scope",
        refId: "consult-ref",
        runId: "consult-run",
        attemptId: "consult-attempt",
        leaseGeneration: 7,
      }),
    ).toBe(true);
    expect(
      mentionExecutor.notifySteeringResumed({
        companyId: "company",
        issueId: "issue",
        runId: "consult-run",
        refId: "consult-ref",
        refOrdinal: 0,
        segmentOrdinal: 1,
      }),
    ).toBe(true);

    await expect(execution).resolves.toEqual({
      runId: "consult-run",
      response: "resumed answer",
    });
    expect(repository.leasePersistedConsultRef).toHaveBeenCalledTimes(2);
    expect(repository.markTerminal).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledWith({
      companyId: "company",
      issueId: "issue",
      runId: "consult-run",
      refId: "consult-ref",
      refOrdinal: 0,
      segmentOrdinal: 1,
      outcome: "succeeded",
      response: "resumed answer",
      reason: null,
    });
  });

  it("aborts only the exact active consult lease", async () => {
    const currentLease = lease();
    const entered = deferred();
    const repository = {
      leasePersistedConsultRef: vi.fn(async () =>
        leasedAcquisition(currentLease)),
      recoverConsultAfterAuthorityLoss: noAuthorityLossRecovery(),
      markRetryable: vi.fn(),
      markTerminal: vi.fn().mockResolvedValue({ laneReleased: false }),
    };
    const executor =
      createIssueExecutionMentionExecutor({
        workerId: "worker",
        repository: repository as never,
        steeringResults: { publish: vi.fn() },
        notifyReleasedConsultRef: vi.fn(),
        executor: {
          execute: vi.fn(async (_lease, signal) => {
            entered.resolve();
            await new Promise<void>((_resolve, reject) => {
              signal.addEventListener(
                "abort",
                () =>
                  reject(
                    new IssueExecutionAttemptRejected(
                      "Synchronous consult was cancelled",
                    ),
                  ),
                { once: true },
              );
            });
            throw new Error("unreachable");
          }),
        },
      });

    const execution = executor.executeMention(input());
    await entered.promise;

    expect(
      executor.signalAttemptCancellation({
        companyId: "company",
        issueId: "issue",
        sessionId: "session",
        executionScopeId: "scope",
        refId: "consult-ref",
        runId: "different-run",
        attemptId: "consult-attempt",
        leaseGeneration: 7,
      }),
    ).toBe(false);
    expect(
      executor.signalAttemptCancellation({
        companyId: "company",
        issueId: "issue",
        sessionId: "session",
        executionScopeId: "scope",
        refId: "consult-ref",
        runId: "consult-run",
        attemptId: "consult-attempt",
        leaseGeneration: 7,
      }),
    ).toBe(true);

    await expect(execution).rejects.toThrow(
      "Synchronous consult was cancelled",
    );
    expect(repository.markTerminal).not.toHaveBeenCalled();
  });

  it("does not recover authority loss caused while exact steering cancellation owns the attempt", async () => {
    const currentLease = lease();
    const entered = deferred();
    const authorityLoss = new IssueExecutionPromptAuthorityLost(
      {
        companyId: currentLease.companyId,
        issueId: currentLease.issueId,
        runId: currentLease.runId,
        attemptId: currentLease.attemptId,
        leaseId: currentLease.leaseId,
        leaseGeneration: currentLease.leaseGeneration,
      },
      new Error("authority expired during steering cancellation"),
    );
    const repository = {
      leasePersistedConsultRef: vi.fn(async () =>
        leasedAcquisition(currentLease)),
      recoverConsultAfterAuthorityLoss: noAuthorityLossRecovery(),
      markRetryable: vi.fn(),
      markTerminal: vi.fn().mockResolvedValue({ laneReleased: false }),
    };
    const executor = createIssueExecutionMentionExecutor({
      workerId: "worker",
      repository,
      steeringResults: { publish: vi.fn() },
      notifyReleasedConsultRef: vi.fn(),
      executor: {
        execute: vi.fn(async (_lease, signal) => {
          entered.resolve();
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
          throw authorityLoss;
        }),
      },
    });

    const execution = executor.executeMention(input());
    await entered.promise;
    expect(
      executor.signalAttemptCancellation({
        companyId: "company",
        issueId: "issue",
        sessionId: "session",
        executionScopeId: "scope",
        refId: "consult-ref",
        runId: "consult-run",
        attemptId: "consult-attempt",
        leaseGeneration: 7,
      }),
    ).toBe(true);

    await expect(execution).rejects.toBe(authorityLoss);
    expect(repository.recoverConsultAfterAuthorityLoss).not.toHaveBeenCalled();
  });

  it("aborts the exact consult while it waits for a persisted retry", async () => {
    const currentLease = lease();
    const retryPersisted = deferred();
    const repository = {
      leasePersistedConsultRef: vi.fn(async () =>
        leasedAcquisition(currentLease)),
      recoverConsultAfterAuthorityLoss: noAuthorityLossRecovery(),
      markRetryable: vi.fn(async () => {
        retryPersisted.resolve();
      }),
      markTerminal: vi.fn().mockResolvedValue({ laneReleased: false }),
    };
    const executor =
      createIssueExecutionMentionExecutor({
        workerId: "worker",
        repository: repository as never,
        steeringResults: { publish: vi.fn() },
        notifyReleasedConsultRef: vi.fn(),
        executor: {
          execute: vi.fn(async (_lease, _signal, settle) => {
            const result = {
              kind: "retry" as const,
              reason: "transport_transient" as const,
              retryAt: new Date(Date.now() + 60_000),
            };
            await settle({ result, materialization: null });
            return result;
          }),
        },
      });

    const execution = executor.executeMention(input());
    await retryPersisted.promise;

    expect(
      executor.signalExecutionScopeCancellation({
        companyId: "company",
        issueId: "issue",
        sessionId: "session",
        executionScopeId: "scope",
        ownershipEpoch: 4,
        mode: "consult",
        authorityId: null,
        consultExecutionId: "consult",
        reason: "fresh_session_reset",
      }),
    ).toBe(false);
    expect(
      executor.signalExecutionScopeCancellation({
        companyId: "company",
        issueId: "issue",
        sessionId: "session",
        executionScopeId: "scope",
        ownershipEpoch: 3,
        mode: "consult",
        authorityId: null,
        consultExecutionId: "consult",
        reason: "fresh_session_reset",
      }),
    ).toBe(true);

    await expect(execution).rejects.toThrow(
      "Synchronous consult was cancelled",
    );
    expect(repository.markTerminal).not.toHaveBeenCalled();
  });

  it("adopts only the exact pre-send consult retry successor", async () => {
    const firstLease: LeasedIssueExecutionRef = {
      ...lease(),
      refOrdinal: 2,
    };
    const successorLease: LeasedIssueExecutionRef = {
      ...firstLease,
      runId: "consult-retry-run",
      attemptId: "consult-retry-attempt",
      leaseId: "consult-retry-lease",
      leaseGeneration: 8,
      attemptNumber: 3,
      refOrdinal: 0,
      segmentOrdinal: 0,
      sessionOperation: firstLease.sessionOperation,
      batch: [{
        ref: firstLease.ref,
        leaseGeneration: 8,
        attemptNumber: 3,
      }],
    };
    const repository = {
      leasePersistedConsultRef: vi
        .fn()
        .mockResolvedValueOnce(leasedAcquisition(firstLease)),
      recoverConsultAfterAuthorityLoss: vi.fn(async () =>
        leasedAcquisition(successorLease, {
            retryOfRunId: firstLease.runId,
          })),
      markRetryable: vi.fn(),
      markTerminal: vi.fn().mockResolvedValue({ laneReleased: false }),
    };
    let executionNumber = 0;
    const execute = vi.fn(async (_lease, _signal, settle) => {
      executionNumber += 1;
      if (executionNumber === 1) {
        throw new IssueExecutionPromptAuthorityLost(
          {
            companyId: firstLease.companyId,
            issueId: firstLease.issueId,
            runId: firstLease.runId,
            attemptId: firstLease.attemptId,
            leaseId: firstLease.leaseId,
            leaseGeneration: firstLease.leaseGeneration,
          },
          new Error("expired consult lease"),
        );
      }
      const result = {
        kind: "terminal" as const,
        outcome: "succeeded" as const,
        reason: null,
        finalText: "recovered consult",
      };
      await settle({ result, materialization: null });
      return result;
    });
    const executor = createIssueExecutionMentionExecutor({
      workerId: "worker",
      repository,
      steeringResults: { publish: vi.fn() },
      notifyReleasedConsultRef: vi.fn(),
      executor: { execute },
    });

    await expect(executor.executeMention(input())).resolves.toEqual({
      runId: "consult-retry-run",
      response: "recovered consult",
    });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(repository.leasePersistedConsultRef).toHaveBeenCalledOnce();
    expect(repository.recoverConsultAfterAuthorityLoss).toHaveBeenCalledWith({
      lease: firstLease,
      workerId: "worker",
    });
    expect(repository.markRetryable).not.toHaveBeenCalled();
    expect(repository.markTerminal).toHaveBeenCalledOnce();
  });

  it("waits once for an exact durable retry schedule before adopting its successor", async () => {
    vi.useFakeTimers();
    try {
      const firstLease = lease();
      const successorLease: LeasedIssueExecutionRef = {
        ...firstLease,
        runId: "scheduled-consult-retry-run",
        attemptId: "scheduled-consult-retry-attempt",
        leaseId: "scheduled-consult-retry-lease",
        leaseGeneration: 8,
        attemptNumber: 3,
        batch: [{
          ref: firstLease.ref,
          leaseGeneration: 8,
          attemptNumber: 3,
        }],
      };
      const scheduleObserved = deferred();
      const repository = {
        leasePersistedConsultRef: vi.fn(async () =>
          leasedAcquisition(firstLease)),
        recoverConsultAfterAuthorityLoss: vi
          .fn()
          .mockImplementationOnce(async () => {
            scheduleObserved.resolve();
            return {
              kind: "scheduled" as const,
              retryAt: new Date(Date.now() + 100),
            };
          })
          .mockResolvedValueOnce(
            leasedAcquisition(successorLease, {
              retryOfRunId: firstLease.runId,
            }),
          ),
        markRetryable: vi.fn(),
        markTerminal: vi.fn().mockResolvedValue({ laneReleased: false }),
      };
      let executionNumber = 0;
      const execute = vi.fn(async (_lease, _signal, settle) => {
        executionNumber += 1;
        if (executionNumber === 1) {
          throw new IssueExecutionPromptAuthorityLost(
            {
              companyId: firstLease.companyId,
              issueId: firstLease.issueId,
              runId: firstLease.runId,
              attemptId: firstLease.attemptId,
              leaseId: firstLease.leaseId,
              leaseGeneration: firstLease.leaseGeneration,
            },
            new Error("expired consult lease"),
          );
        }
        const result = {
          kind: "terminal" as const,
          outcome: "succeeded" as const,
          reason: null,
          finalText: "scheduled recovery",
        };
        await settle({ result, materialization: null });
        return result;
      });
      const executor = createIssueExecutionMentionExecutor({
        workerId: "worker",
        repository,
        steeringResults: { publish: vi.fn() },
        notifyReleasedConsultRef: vi.fn(),
        executor: { execute },
      });

      const result = executor.executeMention(input());
      await scheduleObserved.promise;
      expect(execute).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(100);
      await expect(result).resolves.toEqual({
        runId: "scheduled-consult-retry-run",
        response: "scheduled recovery",
      });
      expect(repository.recoverConsultAfterAuthorityLoss).toHaveBeenCalledTimes(
        2,
      );
      expect(repository.leasePersistedConsultRef).toHaveBeenCalledOnce();
      expect(execute).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a changed consult run without the exact direct retry lineage", async () => {
    const firstLease = lease();
    const unrelatedLease: LeasedIssueExecutionRef = {
      ...firstLease,
      runId: "unrelated-consult-run",
      attemptId: "unrelated-attempt",
      leaseId: "unrelated-lease",
      leaseGeneration: 8,
      attemptNumber: 3,
      batch: [{
        ref: firstLease.ref,
        leaseGeneration: 8,
        attemptNumber: 3,
      }],
    };
    const repository = {
      leasePersistedConsultRef: vi
        .fn()
        .mockResolvedValueOnce(leasedAcquisition(firstLease)),
      recoverConsultAfterAuthorityLoss: vi.fn(async () =>
        leasedAcquisition(unrelatedLease, {
            retryOfRunId: "different-predecessor",
          })),
      markRetryable: vi.fn(),
      markTerminal: vi.fn().mockResolvedValue({ laneReleased: false }),
    };
    const execute = vi.fn(async () => {
      throw new IssueExecutionPromptAuthorityLost(
        {
          companyId: firstLease.companyId,
          issueId: firstLease.issueId,
          runId: firstLease.runId,
          attemptId: firstLease.attemptId,
          leaseId: firstLease.leaseId,
          leaseGeneration: firstLease.leaseGeneration,
        },
        new Error("expired consult lease"),
      );
    });
    const executor = createIssueExecutionMentionExecutor({
      workerId: "worker",
      repository,
      steeringResults: { publish: vi.fn() },
      notifyReleasedConsultRef: vi.fn(),
      executor: { execute },
    });

    await expect(executor.executeMention(input())).rejects.toThrow(
      "Consult continuation crossed its exact retry lineage",
    );
    expect(execute).toHaveBeenCalledOnce();
  });

  it("rejects a direct consult retry whose session operation changed", async () => {
    const firstLease = lease();
    const changedOperationLease: LeasedIssueExecutionRef = {
      ...firstLease,
      runId: "changed-operation-run",
      attemptId: "changed-operation-attempt",
      leaseId: "changed-operation-lease",
      leaseGeneration: 8,
      attemptNumber: 3,
      refOrdinal: 0,
      segmentOrdinal: 0,
      sessionOperation: "resume",
      batch: [{
        ref: firstLease.ref,
        leaseGeneration: 8,
        attemptNumber: 3,
      }],
    };
    const repository = {
      leasePersistedConsultRef: vi.fn(async () =>
        leasedAcquisition(firstLease)),
      recoverConsultAfterAuthorityLoss: vi.fn(async () =>
        leasedAcquisition(changedOperationLease, {
          retryOfRunId: firstLease.runId,
        })),
      markRetryable: vi.fn(),
      markTerminal: vi.fn().mockResolvedValue({ laneReleased: false }),
    };
    const execute = vi.fn(async () => {
      throw new IssueExecutionPromptAuthorityLost(
        {
          companyId: firstLease.companyId,
          issueId: firstLease.issueId,
          runId: firstLease.runId,
          attemptId: firstLease.attemptId,
          leaseId: firstLease.leaseId,
          leaseGeneration: firstLease.leaseGeneration,
        },
        new Error("expired consult lease"),
      );
    });
    const executor = createIssueExecutionMentionExecutor({
      workerId: "worker",
      repository,
      steeringResults: { publish: vi.fn() },
      notifyReleasedConsultRef: vi.fn(),
      executor: { execute },
    });

    await expect(executor.executeMention(input())).rejects.toThrow(
      "Consult continuation crossed its exact retry lineage",
    );
    expect(execute).toHaveBeenCalledOnce();
  });

  it("consumes one exact durable terminal consult after authority loss without another ACP attempt", async () => {
    const currentLease = lease();
    const notifyReleasedConsultRef = vi.fn(async () => undefined);
    const repository = {
      leasePersistedConsultRef: vi.fn(async () =>
        leasedAcquisition(currentLease)),
      recoverConsultAfterAuthorityLoss: vi.fn(async () => ({
        kind: "terminal" as const,
        runId: currentLease.runId,
        outcome: "succeeded" as const,
        reason: "end_turn",
        finalText: "durably closed consult",
      })),
      markRetryable: vi.fn(),
      markTerminal: vi.fn().mockResolvedValue({ laneReleased: false }),
    };
    const execute = vi.fn(async () => {
      throw new IssueExecutionPromptAuthorityLost(
        {
          companyId: currentLease.companyId,
          issueId: currentLease.issueId,
          runId: currentLease.runId,
          attemptId: currentLease.attemptId,
          leaseId: currentLease.leaseId,
          leaseGeneration: currentLease.leaseGeneration,
        },
        new Error("final authority fence lost"),
      );
    });
    const executor = createIssueExecutionMentionExecutor({
      workerId: "worker",
      repository,
      steeringResults: { publish: vi.fn() },
      notifyReleasedConsultRef,
      executor: { execute },
    });

    await expect(executor.executeMention(input())).resolves.toEqual({
      runId: "consult-run",
      response: "durably closed consult",
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(repository.recoverConsultAfterAuthorityLoss).toHaveBeenCalledOnce();
    expect(repository.markTerminal).not.toHaveBeenCalled();
    expect(notifyReleasedConsultRef).toHaveBeenCalledWith("consult-ref");
  });

  it("does not poll or retry when exact consult authority loss is not recoverable", async () => {
    const currentLease = lease();
    const authorityLoss = new IssueExecutionPromptAuthorityLost(
      {
        companyId: currentLease.companyId,
        issueId: currentLease.issueId,
        runId: currentLease.runId,
        attemptId: currentLease.attemptId,
        leaseId: currentLease.leaseId,
        leaseGeneration: currentLease.leaseGeneration,
      },
      new Error("transient database failure"),
    );
    const repository = {
      leasePersistedConsultRef: vi.fn(async () =>
        leasedAcquisition(currentLease)),
      recoverConsultAfterAuthorityLoss: noAuthorityLossRecovery(),
      markRetryable: vi.fn(),
      markTerminal: vi.fn().mockResolvedValue({ laneReleased: false }),
    };
    const execute = vi.fn(async () => {
      throw authorityLoss;
    });
    const executor = createIssueExecutionMentionExecutor({
      workerId: "worker",
      repository,
      steeringResults: { publish: vi.fn() },
      notifyReleasedConsultRef: vi.fn(),
      executor: { execute },
    });

    await expect(executor.executeMention(input())).rejects.toBe(authorityLoss);
    expect(repository.leasePersistedConsultRef).toHaveBeenCalledOnce();
    expect(repository.recoverConsultAfterAuthorityLoss).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
  });

  it("waits abortably on durable queued lane truth before leasing", async () => {
    const currentLease = lease();
    const repository = {
      leasePersistedConsultRef: vi
        .fn()
        .mockResolvedValueOnce({ kind: "queued" as const })
        .mockResolvedValueOnce(leasedAcquisition(currentLease)),
      recoverConsultAfterAuthorityLoss: noAuthorityLossRecovery(),
      markRetryable: vi.fn(),
      markTerminal: vi.fn().mockResolvedValue({ laneReleased: false }),
    };
    const execute = vi.fn(async (_lease, _signal, settle) => {
      const result = {
        kind: "terminal" as const,
        outcome: "succeeded" as const,
        reason: null,
        finalText: "durably promoted",
      };
      await settle({ result, materialization: null });
      return result;
    });
    const executor = createIssueExecutionMentionExecutor({
      workerId: "worker",
      repository,
      steeringResults: { publish: vi.fn() },
      notifyReleasedConsultRef: vi.fn(),
      executor: { execute },
    });

    await expect(executor.executeMention(input())).resolves.toEqual({
      runId: "consult-run",
      response: "durably promoted",
    });
    expect(repository.leasePersistedConsultRef).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("notifies the released consult lane only after executor teardown", async () => {
    const currentLease = lease();
    const terminalPersisted = deferred();
    const allowTeardown = deferred();
    const notifyReleasedConsultRef = vi.fn(async () => undefined);
    const repository = {
      leasePersistedConsultRef: vi.fn(async () =>
        leasedAcquisition(currentLease)),
      recoverConsultAfterAuthorityLoss: noAuthorityLossRecovery(),
      markRetryable: vi.fn(),
      markTerminal: vi.fn(async () => {
        terminalPersisted.resolve();
        return { laneReleased: true };
      }),
    };
    const executor = createIssueExecutionMentionExecutor({
      workerId: "worker",
      repository,
      steeringResults: { publish: vi.fn() },
      notifyReleasedConsultRef,
      executor: {
        async execute(_lease, _signal, settle) {
          const result = {
            kind: "terminal" as const,
            outcome: "succeeded" as const,
            reason: null,
            finalText: "consulted",
          };
          await settle({ result, materialization: null });
          await allowTeardown.promise;
          return result;
        },
      },
    });

    const execution = executor.executeMention(input());
    await terminalPersisted.promise;
    expect(notifyReleasedConsultRef).not.toHaveBeenCalled();

    allowTeardown.resolve();
    await expect(execution).resolves.toEqual({
      runId: "consult-run",
      response: "consulted",
    });
    expect(notifyReleasedConsultRef).toHaveBeenCalledOnce();
    expect(notifyReleasedConsultRef).toHaveBeenCalledWith("consult-ref");
  });

  it("preserves an executor teardown error when released-lane notification also fails", async () => {
    const currentLease = lease();
    const notifyReleasedConsultRef = vi.fn(async () => {
      throw new Error("lane notification failed");
    });
    const executor = createIssueExecutionMentionExecutor({
      workerId: "worker",
      repository: {
        leasePersistedConsultRef: vi.fn(async () =>
          leasedAcquisition(currentLease)),
        recoverConsultAfterAuthorityLoss: noAuthorityLossRecovery(),
        markRetryable: vi.fn(),
        markTerminal: vi.fn(async () => ({ laneReleased: true })),
      },
      steeringResults: { publish: vi.fn() },
      notifyReleasedConsultRef,
      executor: {
        async execute(_lease, _signal, settle) {
          const result = {
            kind: "terminal" as const,
            outcome: "succeeded" as const,
            reason: null,
          };
          await settle({ result, materialization: null });
          throw new Error("target teardown failed");
        },
      },
    });

    await expect(executor.executeMention(input())).rejects.toThrow(
      "target teardown failed",
    );
    expect(notifyReleasedConsultRef).toHaveBeenCalledWith("consult-ref");
  });
});
