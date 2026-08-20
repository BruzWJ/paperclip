import * as t from "./task-execution-attempt-executor.test-support.js";
const { describe, it, vi, expect, createHarness, executeAttempt, acpxFixture } = t;
import { storedCorrelation, resolvedPrompt } from "./task-execution-attempt-executor.test-fixtures.js";

describe("canonical productive/consult ACP attempt executor", () => {
  it("runs the blocking plugin barrier before capability mint and sends its outbound composition", async () => {
    const prompt = resolvedPrompt({ carryContext: false });
    const beforePrompt = vi.fn(
      async (input: Parameters<testSupport.PluginBeforePromptDispatcher["dispatch"]>[0]) => {
        expect(input).toMatchObject({
          companyId: prompt.identity.companyId,
          taskId: prompt.identity.taskId,
          sessionId: prompt.identity.sessionId,
          runId: prompt.identity.runId,
          agentId: prompt.identity.targetAgentId,
          sourceMessageId: prompt.sourceMessageId,
          sourceMessageSeq: prompt.sourceMessageSeq,
          sourceText: prompt.sourceText,
          contextAccess: prompt.contextAccess,
        });
        return `Plugin prelude\n\n${input.sourceText}`;
      },
    );
    const harness = createHarness({ prompt, beforePrompt });

    await expect(executeAttempt(harness, prompt)).resolves.toMatchObject({
      kind: "terminal",
      outcome: "succeeded",
    });

    expect(beforePrompt).toHaveBeenCalledOnce();
    expect(harness.order.indexOf("beforePrompt")).toBeLessThan(harness.order.indexOf("mint:1"));
    expect(harness.messages).toEqual([`Plugin prelude\n\n${prompt.sourceText}`]);
    expect(harness.launches[0]?.mcpServers).toEqual([
      {
        name: "paperclip",
        command: "/target/bin/node",
        args: ["/runtime/run-tools-proxy.mjs", "/runtime/run-tools.json"],
        env: [],
      },
    ]);
    expect(harness.renewedPrompts.length).toBeGreaterThanOrEqual(2);
  });

  it("fails closed before target acquisition when a before-prompt hook fails", async () => {
    const prompt = resolvedPrompt({ carryContext: false });
    const hookFailure = new Error("plugin synchronization failed");
    const harness = createHarness({
      prompt,
      beforePrompt: async () => {
        throw hookFailure;
      },
    });

    await expect(executeAttempt(harness, prompt)).rejects.toBe(hookFailure);
    expect(harness.order).toEqual(["beforePrompt"]);
    expect(harness.launches).toEqual([]);
    expect(harness.closures).toEqual([]);
  });

  it("uses exact-message new for a proven initial false-carry start", async () => {
    const prompt = resolvedPrompt({ carryContext: false });
    const harness = createHarness({ prompt });

    await expect(executeAttempt(harness, prompt)).resolves.toEqual({
      kind: "terminal",
      outcome: "succeeded",
      reason: null,
    });

    expect(harness.starts).toEqual([{ kind: "new" }]);
    expect(harness.messages).toEqual([prompt.sourceText]);
    expect(harness.launches[0]).toMatchObject({
      cwd: "/workspace",
      agentName: acpxFixture.agentName,
      configSelections: [{ configId: "model", value: "model-1" }],
      permissionMode: "approve-all",
      nonInteractivePermissions: "fail",
    });
    expect(harness.launches[0]!.mcpServers).toHaveLength(1);
    expect(harness.launches[0]!.mcpServers[0]).toMatchObject({
      name: "paperclip",
    });
    expect(harness.protectedValues).toHaveLength(1);
    expect(prompt.activationCorrelationScope.laneKind).toBe("owner");
    expect(harness.order).toEqual([
      "mint:1",
      "activate:1",
      "transmit:1",
      "event:message_chunk",
      "dispose:1",
      "close:settled:1",
      "release:false",
    ]);
    const secretFile = harness.invocationFileSets[0]!.find(({ fileName }) => fileName === "run-tools.json");
    expect(secretFile?.contents).toContain("secret-bearer-1");
    expect(harness.eventBoundaries).toEqual([
      {
        prompt: prompt.identity,
        capability: {
          capabilityConnectionId: "capability-1",
          capabilityGeneration: 1,
        },
      },
    ]);
    expect(JSON.stringify(harness.eventBoundaries)).not.toContain("secret-bearer-1");
  });

  it.each([
    ["new", resolvedPrompt({ carryContext: false, readOnly: true }), [{ kind: "new" }]],
    [
      "resumed",
      resolvedPrompt({
        carryContext: true,
        readOnly: true,
        stored: storedCorrelation(),
      }),
      [{ kind: "resume", sessionId: "opaque-resume-session" }],
    ],
  ] as const)("applies response-only access to each %s turn", async (_label, prompt, starts) => {
    const beforePrompt = vi.fn(async () => "Plugin text that must not run");
    const harness = createHarness({ prompt, beforePrompt });

    await expect(executeAttempt(harness, prompt)).resolves.toMatchObject({
      kind: "terminal",
      outcome: "succeeded",
    });

    expect(harness.starts).toEqual(starts);
    expect(harness.messages[0]).toContain("[Paperclip access: response-only for this turn");
    expect(harness.messages[0]).toContain("expires after this response");
    expect(harness.messages[0]).toContain(prompt.sourceText);
    expect(harness.messages[0]).not.toContain("done or cancelled");
    expect(harness.launches[0]).toMatchObject({
      permissionMode: "approve-reads",
      nonInteractivePermissions: "deny",
    });
    expect(beforePrompt).not.toHaveBeenCalled();
    expect(harness.order).not.toContain("beforePrompt");
  });

  it("allows an exact frozen new operation without a correlation", async () => {
    const prompt = resolvedPrompt({
      carryContext: true,
      stored: null,
    });
    const harness = createHarness({ prompt });

    await executeAttempt(harness, prompt);

    expect(harness.starts).toEqual([{ kind: "new" }]);
    expect(harness.messages).toEqual([prompt.sourceText]);
  });

  it("resumes an exact eligible true-carry correlation without Paperclip history", async () => {
    const prompt = resolvedPrompt({
      carryContext: true,
      stored: storedCorrelation(),
    });
    const harness = createHarness({ prompt });

    await executeAttempt(harness, prompt);

    expect(harness.starts).toEqual([{ kind: "resume", sessionId: "opaque-resume-session" }]);
    expect(harness.messages).toEqual([prompt.sourceText]);
    expect(prompt.activationCorrelationScope.laneKind).toBe("owner");
  });

  it("resumes the exact bootstrap predecessor before false-carry work", async () => {
    const prompt = resolvedPrompt({
      carryContext: false,
      sessionOperation: "resume",
      stored: storedCorrelation(),
      bootstrapPredecessor: {
        runId: "run-1",
        refId: "ref-1",
        refOrdinal: 0,
      },
    });
    const harness = createHarness({ prompt });
    await executeAttempt(harness, prompt);
    expect(harness.starts).toEqual([{ kind: "resume", sessionId: "opaque-resume-session" }]);
    expect(harness.messages).toEqual([prompt.sourceText]);
  });

  it("rejects a later true-carry prompt whose mapping is missing", async () => {
    const prompt = resolvedPrompt({
      carryContext: true,
      stored: null,
      sessionOperation: "resume",
    });
    const harness = createHarness({ prompt });

    await expect(executeAttempt(harness, prompt)).rejects.toThrow(
      "ACP session operation crossed carry policy or stored correlation",
    );
    expect(harness.starts).toEqual([]);
    expect(harness.invocationFileSets).toHaveLength(0);
  });

  it("fails a frozen resume setup without retrying or starting a new session", async () => {
    const prompt = resolvedPrompt({
      carryContext: true,
      stored: storedCorrelation(),
    });
    const harness = createHarness({
      prompt,
      resumeFailureBeforeTransmission: new Error("resume setup failed"),
    });

    await expect(executeAttempt(harness, prompt)).resolves.toEqual({
      kind: "terminal",
      outcome: "failed",
      reason: "ACP execution failed during session_setup",
    });

    expect(harness.starts).toEqual([{ kind: "resume", sessionId: "opaque-resume-session" }]);
    expect(harness.messages).toEqual([]);
    expect(harness.invocationFileSets).toHaveLength(1);
    expect(harness.order).toContain("close:error:1");
    expect(harness.order).not.toContain("mint:2");
    expect(harness.order.at(-1)).toBe("release:true");
  });

  it("persists ACPX-native cancellation through the typed closure", async () => {
    const prompt = resolvedPrompt({ carryContext: false });
    const harness = createHarness({
      prompt,
      nativeCancellation: "without_occupancy",
    });
    await expect(executeAttempt(harness, prompt)).resolves.toEqual({
      kind: "terminal",
      outcome: "cancelled",
      reason: "cancelled",
    });
    expect(harness.closures).toEqual([{ kind: "cancelled", settlement: null }]);
    expect(harness.starts).toEqual([{ kind: "new" }]);
    expect(harness.order).toContain("close:cancelled:1");
    const accounted = createHarness({
      prompt,
      nativeCancellation: "with_occupancy",
    });
    await executeAttempt(accounted, prompt);
    expect(accounted.closures).toMatchObject([
      {
        kind: "cancelled",
        settlement: {
          stopReason: "cancelled",
          occupancy: { used: 42, size: 200_000, cost: null },
        },
      },
    ]);
  });

  it("closes a pre-start failure and redacts the capability before persistence", async () => {
    const prompt = resolvedPrompt({ carryContext: false });
    const harness = createHarness({
      prompt,
      prepareFailureMessage: "prepare exposed secret-bearer-1",
    });

    await expect(executeAttempt(harness, prompt)).resolves.toMatchObject({
      kind: "terminal",
      outcome: "failed",
    });

    expect(harness.closures).toEqual([
      {
        kind: "error",
        failure: "runtime",
        phase: "session_setup",
        promptTransmitted: false,
        message: "ACP execution failed during session_setup",
      },
    ]);
    expect(harness.order).toEqual(["mint:1", "close:error:1", "release:true"]);
  });

  it("terminalizes failed ACPX cleanup through the same closure path", async () => {
    const prompt = resolvedPrompt({ carryContext: false });
    const cleanupFailure = new Error("ACPX cleanup failed");
    const harness = createHarness({ prompt, cleanupFailure });
    const settle = vi.fn();

    await expect(executeAttempt(harness, prompt, settle)).resolves.toMatchObject({
      kind: "terminal",
      outcome: "failed",
    });
    expect(settle).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "terminal",
        outcome: "failed",
      }),
    );
    expect(harness.order).toEqual([
      "mint:1",
      "activate:1",
      "transmit:1",
      "event:message_chunk",
      "dispose:1",
      "close:error:1",
      "release:true",
    ]);
  });

  it("releases the execution target before terminal settlement", async () => {
    const prompt = resolvedPrompt({ carryContext: false });
    const harness = createHarness({ prompt });
    const settle = vi.fn(async () => {
      harness.order.push("settle");
    });

    await expect(executeAttempt(harness, prompt, settle)).resolves.toMatchObject({
      kind: "terminal",
      outcome: "succeeded",
    });

    expect(harness.order.slice(-2)).toEqual(["release:false", "settle"]);
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it("does not settle when execution-target release fails", async () => {
    const prompt = resolvedPrompt({ carryContext: false });
    const targetReleaseFailure = new Error("target release failed");
    const harness = createHarness({
      prompt,
      targetReleaseFailure,
    });
    const settle = vi.fn();

    await expect(executeAttempt(harness, prompt, settle)).rejects.toBe(targetReleaseFailure);

    expect(settle).not.toHaveBeenCalled();
    expect(harness.order.at(-1)).toBe("release:false");
  });
});
