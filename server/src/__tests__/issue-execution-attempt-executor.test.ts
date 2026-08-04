import { describe, expect, it, vi } from "vitest";
import {
  ACP_SESSION_CORRELATION_ENVELOPE_VERSION,
  ACP_SESSION_CORRELATION_KIND,
  createAcpSessionCorrelation,
  type AcpPromptExecutionResult,
} from "@paperclipai/adapter-utils/acp-subprocess";
import {
  createIssueExecutionAttemptExecutor,
  executeAcpxRuntimePrompt,
  IssueExecutionPromptAuthorityLost,
  type AcpxRuntimePromptExecutionInput,
  type IssueExecutionPromptClosure,
  type IssueExecutionPromptCycleRepository,
  type IssueExecutionSubprocessObservation,
  type ResolvedIssueExecutionPrompt,
} from "../services/issue-execution-attempt-executor.js";
import {
  createNativeCorrelationService,
  type AcpCorrelationScope,
  type ProtectedAcpSessionCorrelation,
  type StoredAcpSessionCorrelation,
} from "../services/native-correlation.js";

const acpxFixture = vi.hoisted(() =>
  Object.freeze({
    agentName: "fixture-agent",
    executeAcpxOneShotPrompt: vi.fn(),
  }),
);

vi.mock("@paperclipai/adapter-utils/acp-subprocess", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@paperclipai/adapter-utils/acp-subprocess")
  >();
  return {
    ...actual,
    executeAcpxOneShotPrompt: acpxFixture.executeAcpxOneShotPrompt,
  };
});

const launchProfile = Object.freeze({ registryName: acpxFixture.agentName });
const digest = "a".repeat(64);
const toolsDigest = "b".repeat(64);
const targetFingerprint = "c".repeat(64);

function correlationScope(input: {
  carryContext: boolean;
  generation?: number;
  currentSegmentOrdinal?: number;
  laneKind?: "owner" | "consult";
}): AcpCorrelationScope {
  const common = {
    companyId: "company-1",
    issueId: "issue-1",
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
  promptKind?: "base" | "steering";
  stored?: StoredAcpSessionCorrelation | null;
  sessionOperation?: ResolvedIssueExecutionPrompt["sessionOperation"];
  laneKind?: "owner" | "consult";
  leaseRenewalIntervalMs?: number;
}): ResolvedIssueExecutionPrompt {
  const promptKind = input.promptKind ?? "base";
  const laneKind = input.laneKind ?? "owner";
  const stored = input.stored ?? null;
  const sessionOperation = input.sessionOperation ??
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
      issueId: "issue-1",
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
      issueExecutionAuthorityId: laneKind === "owner" ? "authority-1" : null,
      consultExecutionId: laneKind === "consult" ? "consult-1" : null,
      adapterConfigRevisionId: "revision-1",
      executionWorkspaceBindingId: "workspace-1",
    },
    sessionOperation,
    sourceText: "exact source message",
    carryContext: input.carryContext,
    storedCorrelation: stored,
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
        id: "model",
        label: "Model 1",
        value: "model-1",
        limits: {
          contextTokenLimit: 200_000,
          outputTokenLimit: 16_000,
        },
      },
      executionTargetSelector: {
        defaultEnvironmentId: "00000000-0000-4000-8000-000000000001",
        executionTargetDriver: "local",
        executionTargetDigest: targetFingerprint,
      },
      workspaceSelector: { kind: "issue_execution_workspace" },
      companySkillPins: [],
      skillChannel: "operator_native",
    },
    companySkills: { channel: "operator_native" },
    target: {
      companyId: "company-1",
      issueId: "issue-1",
      runId: "run-1",
      targetAgentId: "agent-1",
      adapterConfigRevisionId: "revision-1",
      executionWorkspaceBindingId: "workspace-1",
      acpConfiguration: {
        contractVersion: "acpx-runtime/v1",
        launchProfile,
        sessionConfigSelections: [{ configId: "model", value: "model-1" }],
        model: {
          id: "model",
          label: "Model 1",
          value: "model-1",
          limits: {
            contextTokenLimit: 200_000,
            outputTokenLimit: 16_000,
          },
        },
        executionTargetSelector: {
          defaultEnvironmentId: "00000000-0000-4000-8000-000000000001",
          executionTargetDriver: "local",
          executionTargetDigest: targetFingerprint,
        },
        workspaceSelector: { kind: "issue_execution_workspace" },
        companySkillPins: [],
        skillChannel: "operator_native",
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

function settledResult(
  closureError: unknown | null = null,
  stderr = "",
): AcpPromptExecutionResult {
  return {
    kind: "settled",
    sessionId: "opaque-acp-session",
    settlement: {
      kind: "protocol_settled",
      stopReason: "end_turn",
      occupancy: { used: 42, size: 200_000, cost: null },
    },
    cancellationNotificationError: null,
    closureError,
    teardown: { kind: "not_started" },
    stderr,
  };
}

function createHarness(input: {
  prompt: ResolvedIssueExecutionPrompt;
  targetNotFoundOnFirstResume?: boolean;
  occupancySize?: number;
  prepareFailureMessage?: string;
  resultStderr?: string;
  authenticationRequired?: boolean;
  targetRedactor?: (value: string) => string;
  executePromptGate?: Promise<void>;
  renewPromptAuthority?: (
    call: number,
    prompt: ResolvedIssueExecutionPrompt,
  ) => Promise<void> | void;
  executePromptFailureAfterTransmission?: Error;
  closePromptFailure?: Error;
}) {
  const order: string[] = [];
  const starts: AcpxRuntimePromptExecutionInput["request"]["start"][] = [];
  const messages: string[] = [];
  const launches: AcpxRuntimePromptExecutionInput[] = [];
  const invocationFileSets: Array<readonly { fileName: string; contents: string }[]> = [];
  const companySkillChannels: unknown[] = [];
  const protectedValues: ProtectedAcpSessionCorrelation[] = [];
  const closures: IssueExecutionPromptClosure[] = [];
  const observations: IssueExecutionSubprocessObservation[] = [];
  const teardownCapabilities: unknown[] = [];
  const eventBoundaries: unknown[] = [];
  const renewedPrompts: ResolvedIssueExecutionPrompt[] = [];
  const disposeCalls: number[] = [];
  const executionStarted = deferred();
  let capabilityGeneration = 0;
  let executionCount = 0;

  const repository: IssueExecutionPromptCycleRepository = {
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
    async recordSubprocessStarted() {},
    async closePrompt({ outcome }) {
      closures.push(outcome);
      order.push(`close:${outcome.kind}:${capabilityGeneration}`);
      if (input.closePromptFailure) throw input.closePromptFailure;
      return outcome.kind === "target_not_found"
        ? {
            kind: "dispatch",
            result: {
              kind: "retry",
              reason: "target_not_found_new_session",
              retryAt: new Date("2026-01-01T00:00:00.000Z"),
            },
          }
        : {
            kind: "dispatch",
            result: outcome.kind === "settled"
              ? { kind: "terminal", outcome: "succeeded", reason: null }
              : { kind: "terminal", outcome: "failed", reason: outcome.message },
          };
    },
    async recordSubprocessTeardown({ capability, observation }) {
      teardownCapabilities.push(capability);
      observations.push(observation);
      order.push(`teardown:${capabilityGeneration}`);
    },
    async recordProtocolViolation({ message }) {
      order.push(`violation:${message}`);
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

  const executor = createIssueExecutionAttemptExecutor({
    repository,
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
            environmentId:
              input.prompt.acpConfiguration.executionTargetSelector.defaultEnvironmentId,
            leaseId: "environment-lease-1",
          },
          hostCwd: "/workspace",
          targetCwd: "/workspace",
          targetAdditionalDirectories: [],
          redactor: {
            redactText: input.targetRedactor ?? ((value: string) => value),
          },
          async release(failed = false) {
            order.push(`release:${failed}`);
          },
        };
      },
    },
    async prepareTarget(targetInput) {
      invocationFileSets.push(targetInput.invocationFiles ?? []);
      companySkillChannels.push(targetInput.companySkills);
      if (input.prepareFailureMessage) {
        throw new Error(input.prepareFailureMessage);
      }
      return {
        targetCwd: targetInput.targetCwd,
        targetNodeExecutable: "/target/bin/node",
        invocationFilePaths: {
          "run-tools-proxy.mjs": "/runtime/run-tools-proxy.mjs",
          "run-tools.json": "/runtime/run-tools.json",
        },
        selectedCompanySkillMaterialization: null,
        async disposeBeforeStart() {
          order.push(`dispose:${capabilityGeneration}`);
          disposeCalls.push(capabilityGeneration);
        },
      };
    },
    async executePrompt(execution) {
      executionCount += 1;
      executionStarted.resolve();
      launches.push(execution);
      starts.push(execution.request.start);
      messages.push(execution.request.message);
      if (execution.signal.aborted) throw execution.signal.reason;
      if (input.executePromptGate) {
        await waitForGateOrAbort(input.executePromptGate, execution.signal);
      }
      if (input.authenticationRequired) {
        const cause = new Error("provider details must not persist");
        await execution.closePrompt({
          kind: "error",
          failure: "authentication_required",
          phase: "session_setup",
          promptTransmitted: false,
          cause,
        });
        return {
          kind: "error",
          failure: "authentication_required",
          phase: "session_setup",
          promptTransmitted: false,
          cause,
          closureError: null,
          teardown: { kind: "not_started" },
          stderr: "",
        };
      }
      if (
        input.targetNotFoundOnFirstResume &&
        executionCount === 1 &&
        execution.request.start.kind === "resume"
      ) {
        await execution.closePrompt({ kind: "target_not_found" });
        return {
          kind: "target_not_found",
          closureError: null,
          teardown: { kind: "not_started" },
          stderr: "",
        };
      }
      await execution.activatePrompt({ sessionId: "opaque-acp-session" });
      await execution.beginPromptTransmission({ sessionId: "opaque-acp-session" });
      if (input.executePromptFailureAfterTransmission) {
        throw input.executePromptFailureAfterTransmission;
      }
      await execution.onSessionEvent({
        kind: "message_chunk",
        channel: "assistant",
        content: { type: "text", text: "done" },
      });
      await execution.closePrompt({
        kind: "settled",
        sessionId: "opaque-acp-session",
        settlement: {
          kind: "protocol_settled",
          stopReason: "end_turn",
          occupancy: {
            used: 42,
            size: input.occupancySize ?? 200_000,
            cost: null,
          },
        },
        cancellationNotificationError: null,
      });
      const result = settledResult(null, input.resultStderr);
      return input.occupancySize === undefined
        ? result
        : {
            ...result,
            settlement: {
              ...result.settlement,
              occupancy: {
                ...result.settlement.occupancy,
                size: input.occupancySize,
              },
            },
          };
    },
  });

  return {
    executor,
    order,
    starts,
    messages,
    launches,
    invocationFileSets,
    companySkillChannels,
    protectedValues,
    closures,
    observations,
    teardownCapabilities,
    eventBoundaries,
    renewedPrompts,
    disposeCalls,
    executionStarted: executionStarted.promise,
  };
}

function lease(prompt: ResolvedIssueExecutionPrompt) {
  const identity = prompt.identity;
  return {
    companyId: identity.companyId,
    issueId: identity.issueId,
    runId: identity.runId,
    attemptId: identity.attemptId,
    leaseId: identity.leaseId,
    leaseGeneration: identity.leaseGeneration,
  };
}

function executeAttempt(
  harness: ReturnType<typeof createHarness>,
  prompt: ResolvedIssueExecutionPrompt,
  settle: Parameters<
    ReturnType<typeof createHarness>["executor"]["execute"]
  >[2] = async () => {},
  signal: AbortSignal = new AbortController().signal,
) {
  return harness.executor.execute(
    lease(prompt),
    signal,
    settle,
  );
}

describe("canonical productive/consult ACP attempt executor", () => {
  it("delegates the actual provider turn and generic reasoning configuration to ACPX", async () => {
    const trace: string[] = [];
    const closePrompt = vi.fn(async (
      outcome: Parameters<AcpxRuntimePromptExecutionInput["closePrompt"]>[0],
    ) => {
      trace.push(`close:${outcome.kind}`);
    });
    acpxFixture.executeAcpxOneShotPrompt.mockReset();
    acpxFixture.executeAcpxOneShotPrompt.mockImplementation(async (input: {
      readonly configSelections: readonly { configId: string; value: string }[];
      readonly start: { kind: "new" } | { kind: "resume"; sessionId: string };
      readonly permissionMode: string;
      readonly nonInteractivePermissions: string;
      readonly activatePrompt?: (value: { sessionId: string }) => Promise<void>;
      readonly beginPromptTransmission?: (value: { sessionId: string }) => Promise<void>;
    }) => {
      expect(input.start).toEqual({ kind: "resume", sessionId: "provider-session-1" });
      expect(input.permissionMode).toBe("approve-all");
      expect(input.nonInteractivePermissions).toBe("fail");
      expect(input.configSelections).toEqual([
        { configId: "fast_mode", value: "true" },
        { configId: "model", value: "gpt-5.6" },
        { configId: "reasoning_effort", value: "high" },
      ]);
      await input.activatePrompt?.({ sessionId: "provider-session-2" });
      await input.beginPromptTransmission?.({ sessionId: "provider-session-2" });
      return {
        kind: "completed" as const,
        sessionId: "provider-session-2",
        turnResult: { status: "completed" as const, stopReason: "end_turn" as const },
        settlement: {
          kind: "protocol_settled" as const,
          stopReason: "end_turn" as const,
          occupancy: { used: 12, size: 128, cost: null },
        },
        cleanup: { stateRemoved: true, errors: [] },
      };
    });
    const result = await executeAcpxRuntimePrompt({
      cwd: "/workspace",
      registryCwd: process.cwd(),
      agentName: acpxFixture.agentName,
      configSelections: [
        { configId: "fast_mode", value: true },
        { configId: "model", value: "gpt-5.6" },
        { configId: "reasoning_effort", value: "high" },
      ],
      mcpServers: [],
      request: {
        start: { kind: "resume", sessionId: "provider-session-1" },
        message: "Use the selected reasoning effort",
      },
      signal: new AbortController().signal,
      activatePrompt: async ({ sessionId }) => {
        trace.push(`activate:${sessionId}`);
      },
      beginPromptTransmission: async ({ sessionId }) => {
        trace.push(`transmit:${sessionId}`);
      },
      releasePreparedResources: async () => {
        trace.push("release-prepared");
      },
      closePrompt: closePrompt as AcpxRuntimePromptExecutionInput["closePrompt"],
      redactStderr: (value) => value,
      onSessionEvent: async () => {},
      validatePromptEvents: async () => {
        trace.push("validate-events");
      },
    });

    expect(trace).toEqual([
      "activate:provider-session-2",
      "transmit:provider-session-2",
      "validate-events",
      "release-prepared",
      "close:settled",
    ]);
    expect(result).toMatchObject({
      kind: "settled",
      sessionId: "provider-session-2",
      teardown: { kind: "not_started" },
      stderr: "",
    });
  });

  it("fails the durable attempt if ACPX cannot remove its private runtime state", async () => {
    const closePrompt = vi.fn(async () => {});
    acpxFixture.executeAcpxOneShotPrompt.mockReset();
    acpxFixture.executeAcpxOneShotPrompt.mockResolvedValue({
      kind: "completed",
      sessionId: "provider-session-2",
      turnResult: { status: "completed", stopReason: "end_turn" },
      settlement: {
        kind: "protocol_settled",
        stopReason: "end_turn",
        occupancy: { used: 12, size: 128, cost: null },
      },
      cleanup: { stateRemoved: false, errors: [new Error("remove failed")] },
    });

    const result = await executeAcpxRuntimePrompt({
      cwd: "/workspace",
      agentName: acpxFixture.agentName,
      configSelections: [],
      mcpServers: [],
      request: { start: { kind: "new" }, message: "do the work" },
      signal: new AbortController().signal,
      activatePrompt: async () => {},
      beginPromptTransmission: async () => {},
      releasePreparedResources: async () => {},
      closePrompt,
      redactStderr: (value) => value,
      onSessionEvent: async () => {},
    });

    expect(result).toMatchObject({
      kind: "error",
      phase: "prompt",
      promptTransmitted: true,
      teardown: { kind: "not_started" },
    });
    expect(closePrompt).toHaveBeenCalledWith(expect.objectContaining({
      kind: "error",
      promptTransmitted: true,
    }));
  });

  it("uses exact-message session/new and steering-only retention for false carry", async () => {
    const prompt = resolvedPrompt({ carryContext: false });
    const harness = createHarness({ prompt });

    await expect(
      executeAttempt(harness, prompt),
    ).resolves.toEqual({ kind: "terminal", outcome: "succeeded", reason: null });

    expect(harness.starts).toEqual([{ kind: "new" }]);
    expect(harness.companySkillChannels).toEqual([
      { channel: "operator_native" },
    ]);
    expect(harness.messages).toEqual([prompt.sourceText]);
    expect(harness.launches[0]).toMatchObject({
      cwd: "/workspace",
      agentName: acpxFixture.agentName,
      configSelections: [{ configId: "model", value: "model-1" }],
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
      "close:settled:1",
      "teardown:1",
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

  it("rejects a legacy isolated skills-home revision before invoking ACPX", async () => {
    const base = resolvedPrompt({ carryContext: false });
    const acpConfiguration = {
      ...base.acpConfiguration,
      skillChannel: "isolated_skills_home" as const,
    };
    const prompt: ResolvedIssueExecutionPrompt = {
      ...base,
      acpConfiguration,
      companySkills: {
        channel: "isolated_skills_home",
        identity: {
          companyId: base.identity.companyId,
          agentId: base.identity.targetAgentId,
          executionTargetIdentity: targetFingerprint,
          adapterConfigRevisionId: base.identity.adapterConfigRevisionId,
        },
        entries: [],
      },
      target: { ...base.target, acpConfiguration },
    };
    const harness = createHarness({ prompt });

    await expect(executeAttempt(harness, prompt)).rejects.toThrow(
      "operator_native skills",
    );
    expect(harness.launches).toEqual([]);
    expect(harness.order).toEqual([]);
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
      expect(prompt.activationCorrelationScope.purpose).toBe(destinationPurpose);
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

  it("starts a new session with the exact source when a true-carry mapping is missing", async () => {
    const prompt = resolvedPrompt({ carryContext: true, stored: null });
    const harness = createHarness({ prompt });

    await executeAttempt(harness, prompt);

    expect(harness.starts).toEqual([{ kind: "new" }]);
    expect(harness.messages).toEqual([prompt.sourceText]);
    expect(harness.invocationFileSets).toHaveLength(1);
  });

  it("rejects a target-not-found successor that ACPX cannot emit", async () => {
    const prompt = resolvedPrompt({
      carryContext: true,
      stored: storedCorrelation({ purpose: "carry" }),
    });
    const harness = createHarness({
      prompt,
      targetNotFoundOnFirstResume: true,
    });

    await expect(executeAttempt(harness, prompt)).rejects.toThrow(
      "ACPX runtime never emits a target_not_found successor transition",
    );

    expect(harness.starts).toEqual([
      { kind: "resume", sessionId: "opaque-resume-session" },
    ]);
    expect(harness.messages).toEqual([prompt.sourceText]);
    expect(harness.invocationFileSets).toHaveLength(1);
    expect(harness.order).toContain("close:target_not_found:1");
    expect(harness.order).not.toContain("mint:2");
    expect(harness.order.at(-1)).toBe("release:true");
  });

  it("runs the target-not-found successor in exactly one new ACP lifecycle", async () => {
    const prompt = resolvedPrompt({
      carryContext: true,
      stored: null,
      sessionOperation: "new",
    });
    const harness = createHarness({ prompt });

    await executeAttempt(harness, prompt);

    expect(harness.starts).toEqual([{ kind: "new" }]);
    expect(harness.messages).toEqual([prompt.sourceText]);
    expect(harness.invocationFileSets).toHaveLength(1);
  });

  it("uses exact-new when false-carry steering lost its active target", async () => {
    const prompt = resolvedPrompt({
      carryContext: false,
      promptKind: "steering",
      stored: null,
    });
    const harness = createHarness({ prompt });

    await executeAttempt(harness, prompt);

    expect(harness.starts).toEqual([{ kind: "new" }]);
    expect(harness.messages).toEqual([prompt.sourceText]);
  });

  it("uses exact-new when true-carry steering lost its pinned source", async () => {
    const prompt = resolvedPrompt({
      carryContext: true,
      promptKind: "steering",
      stored: null,
    });
    const harness = createHarness({ prompt });

    await executeAttempt(harness, prompt);

    expect(prompt.sessionOperation).toBe("new");
    expect(harness.starts).toEqual([{ kind: "new" }]);
    expect(harness.messages).toEqual([prompt.sourceText]);
  });

  it("rejects a terminal occupancy size that differs from the immutable revision", async () => {
    const prompt = resolvedPrompt({ carryContext: false });
    const harness = createHarness({ prompt, occupancySize: 199_999 });

    await expect(
      executeAttempt(harness, prompt),
    ).resolves.toMatchObject({ kind: "terminal", outcome: "failed" });
    expect(harness.closures).toEqual([
      expect.objectContaining({
        kind: "error",
        phase: "prompt",
        promptTransmitted: true,
      }),
    ]);
  });

  it("closes a pre-start failure and redacts the capability before persistence", async () => {
    const prompt = resolvedPrompt({ carryContext: false });
    const harness = createHarness({
      prompt,
      prepareFailureMessage: "prepare exposed secret-bearer-1",
    });

    await expect(
      executeAttempt(harness, prompt),
    ).resolves.toMatchObject({ kind: "terminal", outcome: "failed" });

    expect(harness.closures).toEqual([
      {
        kind: "error",
        failure: "runtime",
        phase: "session_setup",
        promptTransmitted: false,
        message: "ACP execution failed during session_setup",
      },
    ]);
    expect(harness.observations).toEqual([
      expect.objectContaining({
        resultKind: "error",
        promptTransmitted: false,
        teardown: { kind: "not_started" },
      }),
    ]);
    expect(JSON.stringify(harness.observations)).not.toContain(
      "secret-bearer-1",
    );
    expect(harness.order).toEqual([
      "mint:1",
      "close:error:1",
      "teardown:1",
      "release:true",
    ]);
  });

  it("never records a Paperclip provider PID when ACPX owns the provider process", async () => {
    const prompt = resolvedPrompt({ carryContext: false });
    const harness = createHarness({ prompt });

    await expect(executeAttempt(harness, prompt)).resolves.toMatchObject({
      kind: "terminal",
      outcome: "succeeded",
    });

    expect(harness.observations).toEqual([
      expect.objectContaining({
        resultKind: "settled",
        teardown: { kind: "not_started" },
      }),
    ]);
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
    expect(harness.order).toEqual([
      "mint:1",
      "close:error:1",
      "teardown:1",
      "release:true",
    ]);
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
      "close:error:1",
      "dispose:1",
      "teardown:1",
      "release:true",
    ]);
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
      "close:error:1",
      "dispose:1",
      "teardown:1",
      "release:true",
    ]);
  });

  it("never passes an opaque ACP session id or bearer to teardown storage", async () => {
    const prompt = resolvedPrompt({ carryContext: false });
    const harness = createHarness({
      prompt,
      resultStderr: "opaque-acp-session secret-bearer-1",
    });

    await executeAttempt(harness, prompt);

    expect(harness.observations).toEqual([
      expect.objectContaining({
        resultKind: "settled",
        stderr: "[REDACTED] [REDACTED]",
      }),
    ]);
    const persisted = JSON.stringify(harness.observations);
    expect(persisted).not.toContain("opaque-acp-session");
    expect(persisted).not.toContain("secret-bearer-1");
    expect(harness.teardownCapabilities).toEqual([
      {
        capabilityConnectionId: "capability-1",
        capabilityGeneration: 1,
      },
    ]);
  });

  it("rejects a stored correlation from a different immutable prompt scope", async () => {
    const stored = storedCorrelation({ purpose: "carry" });
    const prompt = resolvedPrompt({
      carryContext: true,
      stored: {
        ...stored,
        scope: { ...stored.scope, issueId: "issue-2" },
      },
    });
    const harness = createHarness({ prompt });

    await expect(
      executeAttempt(harness, prompt),
    ).rejects.toThrow(
      "stored ACP correlation crossed the canonical prompt or generation",
    );
    expect(harness.starts).toEqual([]);
  });

  it("classifies native CLI authentication without persisting provider details", async () => {
    const prompt = resolvedPrompt({ carryContext: false });
    const harness = createHarness({ prompt, authenticationRequired: true });

    await expect(
      executeAttempt(harness, prompt),
    ).resolves.toMatchObject({ kind: "terminal", outcome: "failed" });

    expect(harness.closures).toEqual([
      {
        kind: "error",
        failure: "authentication_required",
        phase: "session_setup",
        promptTransmitted: false,
        message:
          "The configured ACP CLI requires its native login; authenticate that CLI outside Paperclip and retry",
      },
    ]);
    expect(JSON.stringify(harness.closures)).not.toContain(
      "provider details must not persist",
    );
    expect(JSON.stringify(harness.closures)).not.toContain("must-not-persist");
  });

  it("fails closed when the execution-target redactor throws", async () => {
    const prompt = resolvedPrompt({ carryContext: false });
    const harness = createHarness({
      prompt,
      resultStderr: "provider-native-secret",
      targetRedactor() {
        throw new Error("redactor unavailable");
      },
    });

    await expect(
      executeAttempt(harness, prompt),
    ).resolves.toEqual({
      kind: "terminal",
      outcome: "succeeded",
      reason: null,
    });
    expect(harness.observations).toEqual([
      expect.objectContaining({
        stderr: "[ACP runtime redaction failed]",
      }),
    ]);
    expect(JSON.stringify(harness.observations)).not.toContain(
      "provider-native-secret",
    );
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
          throw new IssueExecutionPromptAuthorityLost(
            lease(prompt),
            authorityFailure,
          );
        },
      });

      await expect(executeAttempt(harness, prompt)).rejects.toMatchObject({
        code: "issue_execution_prompt_authority_lost",
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
        result: {
          kind: "terminal",
          outcome: "failed",
          reason: "ACP execution failed during session_setup",
        },
        materialization: null,
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
