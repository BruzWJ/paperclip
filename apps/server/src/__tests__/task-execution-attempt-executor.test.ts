import { describe, expect, it, vi } from "vitest";
import {
  ACP_SESSION_CORRELATION_ENVELOPE_VERSION,
  ACP_SESSION_CORRELATION_KIND,
  createAcpSessionCorrelation,
  type AcpxOneShotPromptInput,
  type AcpxOneShotPromptResult,
} from "@paperclipai/adapter-utils/acpx-runtime";
import {
  createTaskExecutionAttemptExecutor,
  TaskExecutionPromptAuthorityLost,
  type TaskExecutionPromptClosure,
  type TaskExecutionPromptCycleRepository,
  type ResolvedTaskExecutionPrompt,
} from "../services/task-execution-attempt-executor.js";
import {
  createNativeCorrelationService,
  type AcpCorrelationScope,
  type ProtectedAcpSessionCorrelation,
  type StoredAcpSessionCorrelation,
} from "../services/native-correlation.js";
import type { PluginBeforePromptDispatcher } from "../services/plugin-before-prompt-dispatcher.js";
import { localExecutionCorrelationFingerprint } from "../services/local-execution-correlation.js";

const acpxFixture = vi.hoisted(() =>
  Object.freeze({
    agentName: "fixture-agent",
    executeAcpxOneShotPrompt: vi.fn(),
    prepareAcpxRuntimeInvocation: vi.fn(),
  }),
);

vi.mock("@paperclipai/adapter-utils/acpx-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@paperclipai/adapter-utils/acpx-runtime")
    >();
  return {
    ...actual,
    executeAcpxOneShotPrompt: acpxFixture.executeAcpxOneShotPrompt,
    prepareAcpxRuntimeInvocation: acpxFixture.prepareAcpxRuntimeInvocation,
  };
});

const launchProfile = Object.freeze({ registryName: acpxFixture.agentName });
const digest = "a".repeat(64);
const toolsDigest = "b".repeat(64);
const targetFingerprint = localExecutionCorrelationFingerprint("revision-1");

function correlationScope(input: {
  carryContext: boolean;
  generation?: number;
  currentSegmentOrdinal?: number;
  laneKind?: "owner" | "consult";
}): AcpCorrelationScope {
  const common = {
    companyId: "company-1",
    taskId: "task-1",
    ownershipEpoch: 1,
    targetAgentId: "agent-1",
    adapterConfigIdentity: "revision-1",
    workspaceIdentity: "workspace-1",
    targetFingerprint,
    correlationGeneration: input.generation ?? 2,
  } as const;
  return input.carryContext
    ? {
        ...common,
        purpose: "carry",
        laneKind: input.laneKind ?? "owner",
        authorizedContextExposureDigest: digest,
      }
    : {
        ...common,
        purpose: "active_run_steering",
        runId: "run-1",
        currentRefId: "ref-1",
        currentRefOrdinal: 0,
        currentSegmentOrdinal: input.currentSegmentOrdinal ?? 0,
      };
}

function storedCorrelation(input: {
  purpose: "carry" | "active_run_steering";
  generation?: number;
  laneKind?: "owner" | "consult";
}): StoredAcpSessionCorrelation {
  const scope = correlationScope({
    carryContext: input.purpose === "carry",
    generation: input.generation ?? 1,
    laneKind: input.laneKind,
  });
  return {
    id: "correlation-1",
    state: input.purpose === "carry" ? "eligible" : "current",
    scope,
    envelopeVersion: ACP_SESSION_CORRELATION_ENVELOPE_VERSION,
    codecKind: ACP_SESSION_CORRELATION_KIND,
    ciphertext: "pcnc.v1.nonce.tag.ciphertext",
    digest: "d".repeat(64),
  };
}

function resolvedPrompt(input: {
  carryContext: boolean;
  turn?: ResolvedTaskExecutionPrompt["turn"];
  promptKind?: "base" | "steering";
  stored?: StoredAcpSessionCorrelation | null;
  sessionOperation?: ResolvedTaskExecutionPrompt["sessionOperation"];
  bootstrapPredecessor?: ResolvedTaskExecutionPrompt["bootstrapPredecessor"];
  laneKind?: "owner" | "consult";
  leaseRenewalIntervalMs?: number;
}): ResolvedTaskExecutionPrompt {
  const promptKind = input.promptKind ?? "base";
  const laneKind = input.laneKind ?? "owner";
  const stored = input.stored ?? null;
  const sessionOperation =
    input.sessionOperation ??
    (promptKind === "steering" && stored
      ? "steer_resume"
      : input.carryContext
        ? stored
          ? "resume"
          : "new"
        : "new");
  return {
    identity: {
      companyId: "company-1",
      taskId: "task-1",
      sessionId: "paperclip-session-1",
      ownershipEpoch: 1,
      executionScopeId: "authority-1",
      runId: "run-1",
      runBatchDigest: digest,
      runKind: laneKind === "owner" ? "productive" : "consult",
      promptKind,
      refId: "ref-1",
      refOrdinal: 0,
      segmentOrdinal: promptKind === "base" ? 0 : 1,
      attemptId: "attempt-1",
      attemptGeneration: 1,
      leaseId: "lease-1",
      leaseGeneration: 1,
      targetAgentId: "agent-1",
      laneKind,
      taskExecutionAuthorityId: laneKind === "owner" ? "authority-1" : null,
      consultExecutionId: laneKind === "consult" ? "consult-1" : null,
      adapterConfigRevisionId: "revision-1",
      executionWorkspaceBindingId: "workspace-1",
    },
    turn: input.turn ?? "work",
    sessionOperation,
    sourceMessageId: "source-message-1",
    sourceMessageSeq: 7,
    sourceText: "exact source message",
    contextAccess: {
      carry_context: input.carryContext,
      read_task_comments: true,
      read_task_agent_run: true,
      list_sub_tasks: true,
      read_sub_task_comments: true,
      read_sub_task_agent_run: true,
      list_company_tasks: true,
      read_company_task_comments: true,
      read_company_task_agent_run: true,
    },
    carryContext: input.carryContext,
    storedCorrelation: stored,
    bootstrapPredecessor: input.bootstrapPredecessor ?? null,
    activationCorrelationScope: correlationScope({
      carryContext: input.carryContext,
      currentSegmentOrdinal: promptKind === "base" ? 0 : 1,
      laneKind,
    }),
    effectiveContextExposureDigest: digest,
    carrySourceExposureDigest: digest,
    effectiveToolsDigest: toolsDigest,
    acpConfiguration: {
      contractVersion: "acpx-runtime/v1",
      launchProfile,
      sessionConfigSelections: [{ configId: "model", value: "model-1" }],
      model: {
        value: "model-1",
        label: "Model 1",
      },
    },
    target: {
      companyId: "company-1",
      taskId: "task-1",
      runId: "run-1",
      targetAgentId: "agent-1",
      adapterConfigRevisionId: "revision-1",
      executionWorkspaceBindingId: "workspace-1",
      acpConfiguration: {
        contractVersion: "acpx-runtime/v1",
        launchProfile,
        sessionConfigSelections: [{ configId: "model", value: "model-1" }],
        model: {
          value: "model-1",
          label: "Model 1",
        },
      },
      hostCwd: "/workspace",
      localWorkspaceCwd: "/workspace",
      targetAdditionalDirectories: [],
    },
    leaseRenewalIntervalMs: input.leaseRenewalIntervalMs ?? 60_000,
  };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function waitForGateOrAbort(
  gate: Promise<void>,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!signal) return gate;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(signal.reason);
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    gate.then(
      () => {
        cleanup();
        resolve();
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function settledResult(): AcpxOneShotPromptResult {
  return {
    kind: "completed",
    sessionId: "opaque-acp-session",
    settlement: {
      kind: "protocol_settled",
      stopReason: "end_turn",
      occupancy: { used: 42, size: 200_000, cost: null },
    },
  };
}

function createHarness(input: {
  prompt: ResolvedTaskExecutionPrompt;
  resumeFailureBeforeTransmission?: Error;
  nativeCancellation?: "with_occupancy" | "without_occupancy";
  prepareFailureMessage?: string;
  targetRedactor?: (value: string) => string;
  executePromptGate?: Promise<void>;
  renewPromptAuthority?: (
    call: number,
    prompt: ResolvedTaskExecutionPrompt,
  ) => Promise<void> | void;
  beforePrompt?: PluginBeforePromptDispatcher["dispatch"];
  executePromptFailureAfterTransmission?: Error;
  closePromptFailure?: Error;
  cleanupFailure?: Error;
  targetReleaseFailure?: Error;
}) {
  const order: string[] = [];
  const starts: AcpxOneShotPromptInput["start"][] = [];
  const messages: string[] = [];
  const launches: AcpxOneShotPromptInput[] = [];
  const invocationFileSets: Array<
    readonly { fileName: string; contents: string }[]
  > = [];
  const protectedValues: ProtectedAcpSessionCorrelation[] = [];
  const closures: TaskExecutionPromptClosure[] = [];
  const eventBoundaries: unknown[] = [];
  const renewedPrompts: ResolvedTaskExecutionPrompt[] = [];
  const disposeCalls: number[] = [];
  const executionStarted = deferred();
  let capabilityGeneration = 0;

  const repository: TaskExecutionPromptCycleRepository = {
    async resolve() {
      return input.prompt;
    },
    async renewPromptAuthority(prompt) {
      renewedPrompts.push(prompt);
      await input.renewPromptAuthority?.(renewedPrompts.length, prompt);
    },
    async mintPendingCapability() {
      capabilityGeneration += 1;
      order.push(`mint:${capabilityGeneration}`);
      return {
        capabilityConnectionId: `capability-${capabilityGeneration}`,
        capabilityGeneration,
        endpoint: "http://127.0.0.1:4400/run-tools",
        bearer: `secret-bearer-${capabilityGeneration}`,
      };
    },
    async activatePrompt({ correlation }) {
      order.push(`activate:${capabilityGeneration}`);
      protectedValues.push(correlation);
    },
    async beginPromptTransmission() {
      order.push(`transmit:${capabilityGeneration}`);
    },
    async closePrompt({ outcome }) {
      closures.push(outcome);
      order.push(`close:${outcome.kind}:${capabilityGeneration}`);
      if (input.closePromptFailure) throw input.closePromptFailure;
      return {
        kind: "dispatch",
        result:
          outcome.kind === "settled"
            ? { kind: "terminal", outcome: "succeeded", reason: null }
            : outcome.kind === "cancelled"
              ? { kind: "terminal", outcome: "cancelled", reason: "cancelled" }
              : {
                  kind: "terminal",
                  outcome: "failed",
                  reason: outcome.message,
                },
      };
    },
  };

  const sessionCorrelations = createNativeCorrelationService({
    protector: {
      async seal(_correlation, scope) {
        const protectedValue = {
          envelopeVersion: ACP_SESSION_CORRELATION_ENVELOPE_VERSION,
          codecKind: ACP_SESSION_CORRELATION_KIND,
          ciphertext: `pcnc.v1.encrypted.${scope.correlationGeneration}`,
          digest: "e".repeat(64),
        } as const;
        return protectedValue;
      },
      async open() {
        return createAcpSessionCorrelation("opaque-resume-session");
      },
    },
  });

  acpxFixture.prepareAcpxRuntimeInvocation.mockImplementation(
    async (targetInput) => {
      invocationFileSets.push(targetInput.invocationFiles ?? []);
      if (input.prepareFailureMessage)
        throw new Error(input.prepareFailureMessage);
      return {
        targetCwd: targetInput.targetCwd,
        targetNodeExecutable: "/target/bin/node",
        invocationFilePaths: {
          "run-tools-proxy.mjs": "/runtime/run-tools-proxy.mjs",
          "run-tools.json": "/runtime/run-tools.json",
        },
        async cleanup() {
          order.push(`dispose:${capabilityGeneration}`);
          disposeCalls.push(capabilityGeneration);
        },
      };
    },
  );
  acpxFixture.executeAcpxOneShotPrompt.mockImplementation(async (execution) => {
    executionStarted.resolve();
    launches.push(execution);
    starts.push(execution.start);
    if (execution.signal?.aborted) throw execution.signal.reason;
    if (input.executePromptGate) {
      await waitForGateOrAbort(input.executePromptGate, execution.signal);
    }
    if (
      input.resumeFailureBeforeTransmission &&
      execution.start.kind === "resume"
    ) {
      return {
        kind: "error" as const,
        phase: "session_setup" as const,
        promptTransmitted: false,
        cause: input.resumeFailureBeforeTransmission,
      };
    }
    await execution.activatePrompt?.({ sessionId: "opaque-acp-session" });
    await execution.beginPromptTransmission?.({
      sessionId: "opaque-acp-session",
    });
    messages.push(execution.message);
    if (input.nativeCancellation) {
      const settlement =
        input.nativeCancellation === "with_occupancy"
          ? {
              kind: "protocol_settled" as const,
              stopReason: "cancelled" as const,
              occupancy: { used: 42, size: 200_000, cost: null },
            }
          : null;
      return {
        kind: "cancelled" as const,
        sessionId: "opaque-acp-session",
        settlement,
      };
    }
    if (input.executePromptFailureAfterTransmission)
      throw input.executePromptFailureAfterTransmission;
    await execution.onSessionEvent?.({
      kind: "message_chunk",
      channel: "assistant",
      content: { type: "text", text: "done" },
    });
    return input.cleanupFailure
      ? {
          kind: "error" as const,
          phase: "prompt" as const,
          promptTransmitted: true,
          cause: input.cleanupFailure,
        }
      : settledResult();
  });

  const executor = createTaskExecutionAttemptExecutor({
    repository,
    beforePrompt: {
      async dispatch(promptInput) {
        if (!input.beforePrompt) return promptInput.sourceText;
        order.push("beforePrompt");
        return input.beforePrompt(promptInput);
      },
    },
    sessionCorrelations,
    events: {
      async publish({ prompt, capability, event }) {
        eventBoundaries.push({ prompt, capability });
        order.push(`event:${event.kind}`);
      },
    },
    targetAcquirer: {
      async acquire() {
        return {
          adapterConfigRevisionId: "revision-1",
          acpConfiguration: input.prompt.acpConfiguration,
          executionTarget: {
            kind: "local",
            leaseId: "local-run-lease-1",
          },
          hostCwd: "/workspace",
          targetCwd: "/workspace",
          targetAdditionalDirectories: [],
          redactor: {
            redactText: input.targetRedactor ?? ((value: string) => value),
          },
          async release(failed = false) {
            order.push(`release:${failed}`);
            if (input.targetReleaseFailure) throw input.targetReleaseFailure;
          },
        };
      },
    },
  });

  return {
    executor,
    order,
    starts,
    messages,
    launches,
    invocationFileSets,
    protectedValues,
    closures,
    eventBoundaries,
    renewedPrompts,
    disposeCalls,
    executionStarted: executionStarted.promise,
  };
}

function lease(prompt: ResolvedTaskExecutionPrompt) {
  const identity = prompt.identity;
  return {
    companyId: identity.companyId,
    taskId: identity.taskId,
    runId: identity.runId,
    attemptId: identity.attemptId,
    leaseId: identity.leaseId,
    leaseGeneration: identity.leaseGeneration,
  };
}

function executeAttempt(
  harness: ReturnType<typeof createHarness>,
  prompt: ResolvedTaskExecutionPrompt,
  settle: Parameters<
    ReturnType<typeof createHarness>["executor"]["execute"]
  >[2] = async () => {},
  signal: AbortSignal = new AbortController().signal,
) {
  return harness.executor.execute(lease(prompt), signal, settle);
}

describe("canonical productive/consult ACP attempt executor", () => {
  it("runs the blocking plugin barrier before capability mint and sends its outbound composition", async () => {
    const prompt = resolvedPrompt({ carryContext: false });
    const beforePrompt = vi.fn(
      async (
        input: Parameters<PluginBeforePromptDispatcher["dispatch"]>[0],
      ) => {
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
    expect(harness.order.indexOf("beforePrompt")).toBeLessThan(
      harness.order.indexOf("mint:1"),
    );
    expect(harness.messages).toEqual([
      `Plugin prelude\n\n${prompt.sourceText}`,
    ]);
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
    expect(prompt.activationCorrelationScope.purpose).toBe(
      "active_run_steering",
    );
    expect(harness.order).toEqual([
      "mint:1",
      "activate:1",
      "transmit:1",
      "event:message_chunk",
      "dispose:1",
      "close:settled:1",
      "release:false",
    ]);
    const secretFile = harness.invocationFileSets[0]!.find(
      ({ fileName }) => fileName === "run-tools.json",
    );
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
    expect(JSON.stringify(harness.eventBoundaries)).not.toContain(
      "secret-bearer-1",
    );
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
      stored: storedCorrelation({ purpose: "carry" }),
    });
    const harness = createHarness({ prompt });

    await executeAttempt(harness, prompt);

    expect(harness.starts).toEqual([
      { kind: "resume", sessionId: "opaque-resume-session" },
    ]);
    expect(harness.messages).toEqual([prompt.sourceText]);
    expect(prompt.activationCorrelationScope.purpose).toBe("carry");
  });

  it("resumes the exact bootstrap predecessor before false-carry work", async () => {
    const prompt = resolvedPrompt({
      carryContext: false,
      sessionOperation: "resume",
      stored: storedCorrelation({ purpose: "active_run_steering" }),
      bootstrapPredecessor: { runId: "run-1", refId: "ref-1", refOrdinal: 0 },
    });
    const harness = createHarness({ prompt });
    await executeAttempt(harness, prompt);
    expect(harness.starts).toEqual([
      { kind: "resume", sessionId: "opaque-resume-session" },
    ]);
    expect(harness.messages).toEqual([prompt.sourceText]);
  });

  it.each([
    ["owner", "carry", false, "active_run_steering"],
    ["consult", "carry", false, "active_run_steering"],
    ["owner", "active_run_steering", true, "carry"],
    ["consult", "active_run_steering", true, "carry"],
  ] as const)(
    "resumes the pinned %s steering source across %s carry transition",
    async (laneKind, sourcePurpose, carryContext, destinationPurpose) => {
      const prompt = resolvedPrompt({
        carryContext,
        promptKind: "steering",
        laneKind,
        stored: storedCorrelation({ purpose: sourcePurpose, laneKind }),
      });
      const harness = createHarness({ prompt });

      await executeAttempt(harness, prompt);

      expect(prompt.sessionOperation).toBe("steer_resume");
      expect(harness.starts).toEqual([
        { kind: "resume", sessionId: "opaque-resume-session" },
      ]);
      expect(harness.messages).toEqual([prompt.sourceText]);
      expect(prompt.activationCorrelationScope.purpose).toBe(
        destinationPurpose,
      );
    },
  );

  it("rejects a steering source that crossed the run-pinned adapter revision", async () => {
    const original = storedCorrelation({ purpose: "active_run_steering" });
    const prompt = resolvedPrompt({
      carryContext: false,
      promptKind: "steering",
      stored: {
        ...original,
        scope: {
          ...original.scope,
          adapterConfigIdentity: "revision-2",
        },
      },
    });
    const harness = createHarness({ prompt });

    await expect(executeAttempt(harness, prompt)).rejects.toThrow(
      "stored ACP correlation crossed the canonical prompt or generation",
    );
    expect(harness.starts).toEqual([]);
    expect(harness.order).toEqual([]);
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
      stored: storedCorrelation({ purpose: "carry" }),
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

    expect(harness.starts).toEqual([
      { kind: "resume", sessionId: "opaque-resume-session" },
    ]);
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

  it("rejects false-carry steering that lost its active target", async () => {
    const prompt = resolvedPrompt({
      carryContext: false,
      promptKind: "steering",
      stored: null,
    });
    const harness = createHarness({ prompt });

    await expect(executeAttempt(harness, prompt)).rejects.toThrow(
      "ACP session operation crossed carry policy or stored correlation",
    );
    expect(harness.starts).toEqual([]);
  });

  it("rejects true-carry steering that lost its pinned source", async () => {
    const prompt = resolvedPrompt({
      carryContext: true,
      promptKind: "steering",
      stored: null,
    });
    const harness = createHarness({ prompt });

    await expect(executeAttempt(harness, prompt)).rejects.toThrow(
      "ACP session operation crossed carry policy or stored correlation",
    );
    expect(harness.starts).toEqual([]);
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

    await expect(
      executeAttempt(harness, prompt, settle),
    ).resolves.toMatchObject({
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

    await expect(
      executeAttempt(harness, prompt, settle),
    ).resolves.toMatchObject({
      kind: "terminal",
      outcome: "succeeded",
    });

    expect(harness.order.slice(-2)).toEqual(["release:false", "settle"]);
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it("does not settle when execution-target release fails", async () => {
    const prompt = resolvedPrompt({ carryContext: false });
    const targetReleaseFailure = new Error("target release failed");
    const harness = createHarness({ prompt, targetReleaseFailure });
    const settle = vi.fn();

    await expect(executeAttempt(harness, prompt, settle)).rejects.toBe(
      targetReleaseFailure,
    );

    expect(settle).not.toHaveBeenCalled();
    expect(harness.order.at(-1)).toBe("release:false");
  });

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
    expect((failure as AggregateError).errors[0]).toEqual(
      expect.objectContaining({ message: setupFailure }),
    );
    expect((failure as AggregateError).errors[1]).toBe(closureFailure);
    expect(harness.order).toEqual(["mint:1", "close:error:1", "release:true"]);
  });

  it("fences an already-aborted request before an ACPX provider turn", async () => {
    const prompt = resolvedPrompt({ carryContext: false });
    const harness = createHarness({ prompt });
    const controller = new AbortController();
    controller.abort(new Error("cancelled before ACPX turn"));

    await expect(
      executeAttempt(harness, prompt, async () => {}, controller.signal),
    ).resolves.toMatchObject({ kind: "terminal", outcome: "failed" });

    expect(harness.disposeCalls).toEqual([1]);
    expect(harness.order).toEqual([
      "mint:1",
      "dispose:1",
      "close:error:1",
      "release:true",
    ]);
  });

  it("closes capability authority after an ACPX invocation fails after transmission", async () => {
    const prompt = resolvedPrompt({ carryContext: false });
    const harness = createHarness({
      prompt,
      executePromptFailureAfterTransmission: new Error(
        "unexpected runtime throw",
      ),
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
    const stored = storedCorrelation({ purpose: "carry" });
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
        expect(harness.renewedPrompts).toEqual([
          prompt,
          prompt,
          prompt,
          prompt,
        ]);
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
          throw new TaskExecutionPromptAuthorityLost(
            lease(prompt),
            authorityFailure,
          );
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

      await expect(executeAttempt(harness, prompt)).rejects.toBe(
        databaseFailure,
      );
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

      await expect(executeAttempt(harness, prompt, settle)).rejects.toThrow(
        "final authority fence lost",
      );
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
      const rejection = expect(execution).rejects.toThrow(
        "final authority fence lost",
      );

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
