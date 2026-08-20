import "./task-execution-attempt-executor.test-suite-01-runs-the-blocking-plugin-barrier.js";
import * as t from "./task-execution-attempt-executor.test-support.js";
const { describe, it, createHarness, executeAttempt, expect, vi, deferred } = t;
const { TaskExecutionPromptAuthorityLost, lease } = t;
import { storedCorrelation, resolvedPrompt } from "./task-execution-attempt-executor.test-fixtures.js";
import { subscribeLiveEvents } from "../services/live-events.js";
import type { LiveEvent } from "@paperclipai/shared";

describe("canonical productive/consult ACP attempt executor", () => {
  it("preserves ACPX setup and durable closure failures after fencing closure first", async () => {
    const prompt = resolvedPrompt({ carryContext: false });
    const setupFailure = "ACPX setup failed";
    const closureFailure = new Error("capability closure rejected");
    const harness = createHarness({
      prompt,
      prepareFailureMessage: setupFailure,
      closePromptFailure: closureFailure,
    });

    const failure = await executeAttempt(harness, prompt).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors[0]).toEqual(expect.objectContaining({ message: setupFailure }));
    expect((failure as AggregateError).errors[1]).toBe(closureFailure);
    expect(harness.order).toEqual(["mint:1", "close:error:1", "release:true"]);
  });

  it("publishes the committed run-stream projection after the durable ACP projection", async () => {
    const prompt = resolvedPrompt({ carryContext: false });
    const harness = createHarness({ prompt });
    const liveEvents: LiveEvent[] = [];
    const unsubscribe = subscribeLiveEvents((event) => liveEvents.push(event));
    try {
      await executeAttempt(harness, prompt);
    } finally {
      unsubscribe();
    }

    expect(liveEvents).toEqual([
      {
        companyId: "company-1",
        type: "run.stream",
        payload: {
          kind: "part.upsert",
          runId: "run-1",
          message: {
            id: "assistant-attempt-1",
            seq: 10,
            modelStateSeq: 12,
            type: "assistant",
            data: { id: "assistant-attempt-1", type: "assistant", content: [] },
            timeCreated: "2026-01-01T00:00:00.000Z",
            timeUpdated: "2026-01-01T00:00:01.000Z",
          },
          part: { id: "text-1", type: "text", text: "done" },
        },
      },
    ]);
  });

  it("fences an already-aborted request before an ACPX provider turn", async () => {
    const prompt = resolvedPrompt({ carryContext: false });
    const harness = createHarness({ prompt });
    const controller = new AbortController();
    controller.abort(new Error("cancelled before ACPX turn"));

    await expect(executeAttempt(harness, prompt, async () => {}, controller.signal)).resolves.toMatchObject({
      kind: "terminal",
      outcome: "failed",
    });

    expect(harness.disposeCalls).toEqual([1]);
    expect(harness.order).toEqual(["mint:1", "dispose:1", "close:error:1", "release:true"]);
  });

  it("closes capability authority after an ACPX invocation fails after transmission", async () => {
    const prompt = resolvedPrompt({ carryContext: false });
    const harness = createHarness({
      prompt,
      executePromptFailureAfterTransmission: new Error("unexpected runtime throw"),
    });

    await expect(executeAttempt(harness, prompt)).resolves.toMatchObject({
      kind: "terminal",
      outcome: "failed",
    });

    expect(harness.closures).toEqual([
      expect.objectContaining({
        kind: "error",
        phase: "prompt",
        promptTransmitted: true,
      }),
    ]);
    expect(harness.order).toEqual([
      "mint:1",
      "activate:1",
      "transmit:1",
      "dispose:1",
      "close:error:1",
      "release:true",
    ]);
  });

  it("rejects a stored correlation from a different immutable prompt scope", async () => {
    const stored = storedCorrelation();
    const prompt = resolvedPrompt({
      carryContext: true,
      stored: {
        ...stored,
        scope: { ...stored.scope, taskId: "task-2" },
      },
    });
    const harness = createHarness({ prompt });

    await expect(executeAttempt(harness, prompt)).rejects.toThrow(
      "stored ACP correlation crossed the canonical prompt or generation",
    );
    expect(harness.starts).toEqual([]);
  });

  it("rejects a non-successor generation for an otherwise matching correlation", async () => {
    const prompt = resolvedPrompt({
      carryContext: true,
      stored: storedCorrelation({ generation: 1 }),
      activationGeneration: 3,
    });
    const harness = createHarness({ prompt });

    await expect(executeAttempt(harness, prompt)).rejects.toThrow(
      "stored ACP correlation crossed the canonical prompt or generation",
    );
    expect(harness.starts).toEqual([]);
  });

  it.each(["owner", "consult"] as const)(
    "renews %s prompt authority immediately and again immediately before settlement",
    async (laneKind) => {
      vi.useFakeTimers();
      try {
        const prompt = resolvedPrompt({
          carryContext: false,
          laneKind,
          leaseRenewalIntervalMs: 100,
        });
        const harness = createHarness({ prompt });

        await expect(executeAttempt(harness, prompt)).resolves.toMatchObject({
          kind: "terminal",
          outcome: "succeeded",
        });

        expect(harness.renewedPrompts).toEqual([prompt, prompt]);
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(harness.renewedPrompts).toHaveLength(2);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each(["owner", "consult"] as const)(
    "periodically renews a quiet long-running %s prompt and cleans up its timer",
    async (laneKind) => {
      vi.useFakeTimers();
      try {
        const gate = deferred();
        const prompt = resolvedPrompt({
          carryContext: false,
          laneKind,
          leaseRenewalIntervalMs: 100,
        });
        const harness = createHarness({
          prompt,
          executePromptGate: gate.promise,
        });
        const execution = executeAttempt(harness, prompt);

        await harness.executionStarted;
        expect(harness.renewedPrompts).toEqual([prompt]);

        await vi.advanceTimersByTimeAsync(250);
        expect(harness.renewedPrompts).toEqual([prompt, prompt, prompt]);

        gate.resolve();
        await expect(execution).resolves.toMatchObject({
          kind: "terminal",
          outcome: "succeeded",
        });
        expect(harness.renewedPrompts).toEqual([prompt, prompt, prompt, prompt]);
        expect(vi.getTimerCount()).toBe(0);

        await vi.advanceTimersByTimeAsync(1_000);
        expect(harness.renewedPrompts).toHaveLength(4);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("fails before target acquisition when the immediate authority renewal is rejected", async () => {
    vi.useFakeTimers();
    try {
      const prompt = resolvedPrompt({
        carryContext: false,
        leaseRenewalIntervalMs: 100,
      });
      const authorityFailure = new Error("prompt authority expired");
      const harness = createHarness({
        prompt,
        renewPromptAuthority() {
          throw new TaskExecutionPromptAuthorityLost(lease(prompt), authorityFailure);
        },
      });

      await expect(executeAttempt(harness, prompt)).rejects.toMatchObject({
        code: "task_execution_prompt_authority_lost",
        lease: lease(prompt),
        cause: authorityFailure,
      });
      expect(harness.renewedPrompts).toEqual([prompt]);
      expect(harness.launches).toEqual([]);
      expect(harness.order).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not classify a generic renewal transport failure as recoverable authority loss", async () => {
    vi.useFakeTimers();
    try {
      const prompt = resolvedPrompt({
        carryContext: false,
        leaseRenewalIntervalMs: 100,
      });
      const databaseFailure = new Error("database transport unavailable");
      const harness = createHarness({
        prompt,
        renewPromptAuthority() {
          throw databaseFailure;
        },
      });

      await expect(executeAttempt(harness, prompt)).rejects.toBe(databaseFailure);
      expect(harness.renewedPrompts).toEqual([prompt]);
      expect(harness.launches).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed when the final pre-settlement authority renewal is rejected", async () => {
    vi.useFakeTimers();
    try {
      const prompt = resolvedPrompt({
        carryContext: false,
        leaseRenewalIntervalMs: 100,
      });
      const settle = vi.fn(async () => undefined);
      const harness = createHarness({
        prompt,
        renewPromptAuthority(call) {
          if (call === 2) throw new Error("final authority fence lost");
        },
      });

      await expect(executeAttempt(harness, prompt, settle)).rejects.toThrow("final authority fence lost");
      expect(harness.renewedPrompts).toEqual([prompt, prompt]);
      expect(settle).not.toHaveBeenCalled();
      expect(harness.order.at(-1)).toBe("release:true");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles the durable aborted closure when a final exact renewal recovers from periodic failure", async () => {
    vi.useFakeTimers();
    try {
      const gate = deferred();
      const prompt = resolvedPrompt({
        carryContext: false,
        laneKind: "consult",
        leaseRenewalIntervalMs: 100,
      });
      const settle = vi.fn(async () => undefined);
      const harness = createHarness({
        prompt,
        executePromptGate: gate.promise,
        renewPromptAuthority(call) {
          if (call === 2) throw new Error("periodic authority fence lost");
        },
      });
      const execution = executeAttempt(harness, prompt, settle);

      await harness.executionStarted;
      await vi.advanceTimersByTimeAsync(100);
      await expect(execution).resolves.toEqual({
        kind: "terminal",
        outcome: "failed",
        reason: "ACP execution failed during session_setup",
      });

      expect(harness.renewedPrompts).toEqual([prompt, prompt, prompt]);
      expect(settle).toHaveBeenCalledOnce();
      expect(settle).toHaveBeenCalledWith({
        kind: "terminal",
        outcome: "failed",
        reason: "ACP execution failed during session_setup",
      });
      expect(harness.order.at(-1)).toBe("release:true");
      expect(vi.getTimerCount()).toBe(0);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(harness.renewedPrompts).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not settle an aborted closure when its fresh final authority fence is also lost", async () => {
    vi.useFakeTimers();
    try {
      const gate = deferred();
      const prompt = resolvedPrompt({
        carryContext: false,
        laneKind: "consult",
        leaseRenewalIntervalMs: 100,
      });
      const settle = vi.fn(async () => undefined);
      const harness = createHarness({
        prompt,
        executePromptGate: gate.promise,
        renewPromptAuthority(call) {
          if (call === 2) throw new Error("periodic authority fence lost");
          if (call === 3) throw new Error("final authority fence lost");
        },
      });
      const execution = executeAttempt(harness, prompt, settle);
      const rejection = expect(execution).rejects.toThrow("final authority fence lost");

      await harness.executionStarted;
      await vi.advanceTimersByTimeAsync(100);
      await rejection;

      expect(harness.renewedPrompts).toEqual([prompt, prompt, prompt]);
      expect(settle).not.toHaveBeenCalled();
      expect(harness.order.at(-1)).toBe("release:true");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
