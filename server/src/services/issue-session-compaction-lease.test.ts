import { describe, expect, it, vi } from "vitest";
import {
  decideSessionCompactionTerminalRecovery,
  runSessionCompactionWithLeaseRenewal,
} from "./issue-session-compaction-postgres.js";

describe("recovery compaction lease maintenance", () => {
  it("awaits aborted provider teardown and preserves the lease-fence failure", async () => {
    let markWorkStarted!: () => void;
    const workStarted = new Promise<void>((resolve) => {
      markWorkStarted = resolve;
    });
    let markAbortObserved!: () => void;
    const abortObserved = new Promise<void>((resolve) => {
      markAbortObserved = resolve;
    });
    let releaseTeardown!: () => void;
    const teardown = new Promise<void>((resolve) => {
      releaseTeardown = resolve;
    });
    const controller = new AbortController();
    const renew = vi.fn(async () => {
      throw new Error("database unavailable");
    });
    const result = runSessionCompactionWithLeaseRenewal({
      intervalMs: 1,
      controller,
      renew,
      async work() {
        markWorkStarted();
        if (!controller.signal.aborted) {
          await new Promise<void>((resolve) => {
            controller.signal.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
        }
        markAbortObserved();
        await teardown;
        throw new Error("provider teardown completed");
      },
    });
    let completed = false;
    let observedError: unknown;
    const completion = result.then(
      () => {
        completed = true;
      },
      (error: unknown) => {
        completed = true;
        observedError = error;
      },
    );

    await workStarted;
    await abortObserved;
    await Promise.resolve();
    expect(controller.signal.aborted).toBe(true);
    expect(completed).toBe(false);

    releaseTeardown();
    await completion;
    expect(renew).toHaveBeenCalledOnce();
    expect(observedError).toMatchObject({
      code: "session_compaction_attempt_fence_lost",
      message: "Recovery compaction lease renewal failed closed",
    });
  });

  it("lets an in-flight renewal failure override completed work", async () => {
    let markRenewalStarted!: () => void;
    const renewalStarted = new Promise<void>((resolve) => {
      markRenewalStarted = resolve;
    });
    let rejectRenewal!: (error: Error) => void;
    const controller = new AbortController();
    const result = runSessionCompactionWithLeaseRenewal({
      intervalMs: 1,
      controller,
      renew() {
        markRenewalStarted();
        return new Promise<void>((_resolve, reject) => {
          rejectRenewal = reject;
        });
      },
      async work() {
        await renewalStarted;
        return "provider-finished";
      },
    });
    let completed = false;
    void result.finally(() => {
      completed = true;
    }).catch(() => undefined);

    await renewalStarted;
    await Promise.resolve();
    expect(completed).toBe(false);

    rejectRenewal(new Error("renewal compare-and-set failed"));
    await expect(result).rejects.toMatchObject({
      code: "session_compaction_attempt_fence_lost",
      message: "Recovery compaction lease renewal failed closed",
    });
    expect(controller.signal.aborted).toBe(true);
  });
});

describe("recovery compaction terminal restart decisions", () => {
  const at = new Date("2026-08-01T12:00:00.000Z");

  it("leaves an unexpired exact attempt and lease with its live worker", () => {
    expect(
      decideSessionCompactionTerminalRecovery({
        protocolSettlementState: "settled",
        effectKind: "checkpoint",
        failureKind: null,
        attachedAttempt: {
          state: "running",
          leaseState: "active",
          expiresAt: new Date(at.getTime() + 1),
        },
        at,
      }),
    ).toEqual({ kind: "live" });
  });

  it("finalizes an expired checkpoint generation without replaying work", () => {
    expect(
      decideSessionCompactionTerminalRecovery({
        protocolSettlementState: "settled",
        effectKind: "checkpoint",
        failureKind: null,
        attachedAttempt: {
          state: "running",
          leaseState: "active",
          expiresAt: at,
        },
        at,
      }),
    ).toEqual({
      kind: "finalize",
      attemptTerminalState: "settled",
      runStatus: "succeeded",
      terminalReasonCode: "recovery_compaction_completed",
      expireAttachedAttempt: true,
    });
  });

  it("finalizes an expired incomplete failure as failed", () => {
    expect(
      decideSessionCompactionTerminalRecovery({
        protocolSettlementState: "incomplete",
        effectKind: "failed-compaction",
        failureKind: "provider_stream_interrupted",
        attachedAttempt: {
          state: "running",
          leaseState: "active",
          expiresAt: new Date(at.getTime() - 1),
        },
        at,
      }),
    ).toEqual({
      kind: "finalize",
      attemptTerminalState: "failed",
      runStatus: "failed",
      terminalReasonCode: "provider_stream_interrupted",
      expireAttachedAttempt: true,
    });
  });

  it("finalizes a detached not-sent terminal failure", () => {
    expect(
      decideSessionCompactionTerminalRecovery({
        protocolSettlementState: "not_sent",
        effectKind: null,
        failureKind: "budget_hard_stop",
        attachedAttempt: null,
        at,
      }),
    ).toEqual({
      kind: "finalize",
      attemptTerminalState: "failed",
      runStatus: "failed",
      terminalReasonCode: "budget_hard_stop",
      expireAttachedAttempt: false,
    });
  });

  it("rejects a checkpoint whose prompt was not protocol-settled", () => {
    expect(() =>
      decideSessionCompactionTerminalRecovery({
        protocolSettlementState: "incomplete",
        effectKind: "checkpoint",
        failureKind: null,
        attachedAttempt: null,
        at,
      }),
    ).toThrow("does not own a protocol-settled prompt");
  });
});
