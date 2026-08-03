import { describe, expect, it, vi } from "vitest";
import {
  ACP_SESSION_CORRELATION_ENVELOPE_VERSION,
  ACP_SESSION_CORRELATION_KIND,
  createAcpSessionCorrelation,
  resolveApprovedAcpLaunch,
  type AcpPromptExecutionInput,
  type AcpPromptExecutionResult,
  type AcpSubprocess,
  type AcpSubprocessLaunch,
} from "@paperclipai/adapter-utils/acp-subprocess";
import {
  selectedCompanySkillMaterializationKey,
} from "@paperclipai/adapter-utils/selected-company-skills";
import {
  createIssueExecutionAttemptExecutor,
  IssueExecutionPromptAuthorityLost,
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

const launchProfile = resolveApprovedAcpLaunch("codex");
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
      contractVersion: "acp-subprocess/v1",
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
        contractVersion: "acp-subprocess/v1",
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
    teardown: {
      kind: "reaped",
      processExit: { exitCode: 0, signal: null },
    },
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
  exerciseSubprocessStart?: boolean;
  subprocessPid?: number;
  recordSubprocessStartedFailure?: Error;
  executePromptFailureAfterStart?: Error;
  closePromptFailure?: Error;
  terminateFailure?: Error;
  emulateAcpSpawnFailureClosure?: boolean;
}) {
  const order: string[] = [];
  const starts: AcpPromptExecutionInput["request"]["start"][] = [];
  const messages: string[] = [];
  const launches: AcpSubprocessLaunch[] = [];
  const invocationFileSets: Array<readonly { fileName: string; contents: string }[]> = [];
  const companySkillChannels: unknown[] = [];
  const protectedValues: ProtectedAcpSessionCorrelation[] = [];
  const closures: IssueExecutionPromptClosure[] = [];
  const observations: IssueExecutionSubprocessObservation[] = [];
  const teardownCapabilities: unknown[] = [];
  const eventBoundaries: unknown[] = [];
  const renewedPrompts: ResolvedIssueExecutionPrompt[] = [];
  const spawnCalls: number[] = [];
  const terminateCalls: number[] = [];
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
    async recordSubprocessStarted() {
      order.push(`process:${capabilityGeneration}`);
      if (input.recordSubprocessStartedFailure) {
        throw input.recordSubprocessStartedFailure;
      }
    },
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
      const materialization =
        targetInput.companySkills.channel === "isolated_skills_home"
          ? selectedCompanySkillMaterializationKey({
              identity: targetInput.companySkills.identity,
              entries: targetInput.companySkills.entries,
            })
          : null;
      return {
        targetCwd: targetInput.targetCwd,
        targetAdditionalDirectories: targetInput.targetAdditionalDirectories,
        targetNodeExecutable: "/target/bin/node",
        targetNativeExecutable: "/target/bin/codex",
        targetFrontendEntrypoint: "/runtime/codex-acp-1.1.7.mjs",
        invocationFilePaths: {
          "run-tools-proxy.mjs": "/runtime/run-tools-proxy.mjs",
          "run-tools.json": "/runtime/run-tools.json",
        },
        selectedCompanySkillMaterialization: materialization
          ? {
              materializationKey: materialization.materializationKey,
              async collectExact(expectedMaterializationKey: string) {
                expect(expectedMaterializationKey).toBe(
                  materialization.materializationKey,
                );
                return {
                  materializationKey: materialization.materializationKey,
                  outcome: "collected" as const,
                };
              },
            }
          : null,
        async startSubprocess() {
          spawnCalls.push(capabilityGeneration);
          const subprocess = {
            child: { pid: input.subprocessPid },
            stream: {},
            stderr: () => "",
            exited: Promise.resolve({ exitCode: 0, signal: null }),
            cancel() {},
            closeAndReap: async () => ({ exitCode: 0, signal: null }),
            async terminateAndReap() {
              order.push(`terminate:${capabilityGeneration}`);
              terminateCalls.push(capabilityGeneration);
              if (input.terminateFailure) throw input.terminateFailure;
              return { exitCode: null, signal: "SIGTERM" as const };
            },
            closeInput() {},
          } as unknown as AcpSubprocess;
          return subprocess;
        },
        async disposeBeforeStart() {
          order.push(`dispose:${capabilityGeneration}`);
          disposeCalls.push(capabilityGeneration);
        },
      };
    },
    async executePrompt(execution) {
      executionCount += 1;
      executionStarted.resolve();
      launches.push(execution.launch);
      starts.push(execution.request.start);
      messages.push(execution.request.message);
      if (input.executePromptGate) {
        await waitForGateOrAbort(input.executePromptGate, execution.signal);
      }
      if (input.exerciseSubprocessStart) {
        try {
          await execution.startSubprocess(execution.launch, {
            redactStderr: execution.redactStderr,
          });
        } catch (cause) {
          if (!input.emulateAcpSpawnFailureClosure) throw cause;
          let closureError: unknown | null = null;
          try {
            await execution.closePrompt({
              kind: "error",
              failure: "runtime",
              phase: "spawn",
              promptTransmitted: false,
              cause,
            });
          } catch (error) {
            closureError = error;
          }
          return {
            kind: "error",
            failure: "runtime",
            phase: "spawn",
            promptTransmitted: false,
            cause,
            closureError,
            teardown: { kind: "not_started" },
            stderr: "",
          };
        }
        if (input.executePromptFailureAfterStart) {
          throw input.executePromptFailureAfterStart;
        }
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
    spawnCalls,
    terminateCalls,
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
    expect(harness.launches[0]!.mcpServers).toEqual([
      {
        name: "paperclip",
        command: "/target/bin/node",
        args: [
          "/runtime/run-tools-proxy.mjs",
          "/runtime/run-tools.json",
        ],
        env: [],
      },
    ]);
    expect(JSON.stringify(harness.launches[0]!.mcpServers)).not.toContain(
      process.execPath,
    );
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

  it.each(["owner", "consult"] as const)(
    "passes the exact immutable isolated skills-home selection through the %s settlement",
    async (laneKind) => {
      const base = resolvedPrompt({ carryContext: false, laneKind });
      const pin = {
        key: "company/example/review",
        versionId: "00000000-0000-4000-8000-000000000099",
      } as const;
      const acpConfiguration = {
        ...base.acpConfiguration,
        companySkillPins: [pin],
        skillChannel: "isolated_skills_home" as const,
      };
      const companySkills = {
        channel: "isolated_skills_home" as const,
        identity: {
          companyId: base.identity.companyId,
          agentId: base.identity.targetAgentId,
          executionTargetIdentity: targetFingerprint,
          adapterConfigRevisionId:
            base.identity.adapterConfigRevisionId,
        },
        entries: [{
          ...pin,
          runtimeName: "review--0a1b2c3d4e",
          files: [{
            path: "SKILL.md",
            kind: "skill" as const,
            content: "# Review\n",
          }],
        }],
      } as const;
      const prompt: ResolvedIssueExecutionPrompt = {
        ...base,
        acpConfiguration,
        companySkills,
        target: {
          ...base.target,
          acpConfiguration,
        },
      };
      const harness = createHarness({ prompt });
      let collectionKey: string | null = null;

      await expect(
        executeAttempt(harness, prompt, async ({ materialization }) => {
          collectionKey = materialization?.materializationKey ?? null;
        }),
      ).resolves.toMatchObject({ kind: "terminal", outcome: "succeeded" });
      expect(harness.companySkillChannels).toEqual([companySkills]);
      expect(collectionKey).toBe(
        selectedCompanySkillMaterializationKey({
          identity: companySkills.identity,
          entries: companySkills.entries,
        }).materializationKey,
      );
    },
  );

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

  it("closes a -32002 resume as one attempt and requests an immediate successor", async () => {
    const prompt = resolvedPrompt({
      carryContext: true,
      stored: storedCorrelation({ purpose: "carry" }),
    });
    const harness = createHarness({
      prompt,
      targetNotFoundOnFirstResume: true,
    });

    await expect(
      executeAttempt(harness, prompt),
    ).resolves.toEqual({
      kind: "retry",
      reason: "target_not_found_new_session",
      retryAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    expect(harness.starts).toEqual([
      { kind: "resume", sessionId: "opaque-resume-session" },
    ]);
    expect(harness.messages).toEqual([prompt.sourceText]);
    expect(harness.invocationFileSets).toHaveLength(1);
    expect(harness.order).toContain("close:target_not_found:1");
    expect(harness.order).not.toContain("mint:2");
    expect(harness.order.at(-1)).toBe("release:false");
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
        phase: "spawn",
        promptTransmitted: false,
        message: "ACP execution failed during spawn",
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

  it("closes, terminates, and reaps a spawned subprocess with an invalid PID", async () => {
    const prompt = resolvedPrompt({ carryContext: false });
    const harness = createHarness({
      prompt,
      exerciseSubprocessStart: true,
    });

    await expect(executeAttempt(harness, prompt)).resolves.toMatchObject({
      kind: "terminal",
      outcome: "failed",
    });

    expect(harness.spawnCalls).toEqual([1]);
    expect(harness.terminateCalls).toEqual([1]);
    expect(harness.order).toEqual([
      "mint:1",
      "close:error:1",
      "terminate:1",
      "teardown:1",
      "release:true",
    ]);
    expect(harness.observations).toEqual([
      expect.objectContaining({
        promptTransmitted: false,
        teardown: {
          kind: "reaped",
          exitCode: null,
          signal: "SIGTERM",
        },
      }),
    ]);
  });

  it("preserves startup, closure, and reap failures after fencing closure first", async () => {
    const prompt = resolvedPrompt({ carryContext: false });
    const startFailure = new Error("process fact rejected");
    const closureFailure = new Error("capability closure rejected");
    const teardownFailure = new Error("subprocess reap rejected");
    const harness = createHarness({
      prompt,
      exerciseSubprocessStart: true,
      subprocessPid: 321,
      recordSubprocessStartedFailure: startFailure,
      closePromptFailure: closureFailure,
      terminateFailure: teardownFailure,
      emulateAcpSpawnFailureClosure: true,
    });

    const failure = await executeAttempt(harness, prompt).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors[0]).toBe(startFailure);
    expect((failure as AggregateError).errors[1]).toEqual(
      expect.objectContaining({
        errors: [closureFailure, closureFailure],
      }),
    );
    expect((failure as AggregateError).errors[2]).toBe(teardownFailure);
    expect(harness.order).toEqual([
      "mint:1",
      "process:1",
      "close:error:1",
      "terminate:1",
      "close:error:1",
      "teardown:1",
      "release:true",
    ]);
  });

  it("fences an already-aborted request before subprocess spawn", async () => {
    const prompt = resolvedPrompt({ carryContext: false });
    const harness = createHarness({
      prompt,
      exerciseSubprocessStart: true,
      subprocessPid: 321,
    });
    const controller = new AbortController();
    controller.abort(new Error("cancelled before spawn"));

    await expect(
      executeAttempt(harness, prompt, async () => {}, controller.signal),
    ).resolves.toMatchObject({ kind: "terminal", outcome: "failed" });

    expect(harness.spawnCalls).toEqual([]);
    expect(harness.terminateCalls).toEqual([]);
    expect(harness.disposeCalls).toEqual([1]);
    expect(harness.order).toEqual([
      "mint:1",
      "close:error:1",
      "dispose:1",
      "teardown:1",
      "release:true",
    ]);
  });

  it("closes capability authority before terminating an unexpectedly failing subprocess", async () => {
    const prompt = resolvedPrompt({ carryContext: false });
    const harness = createHarness({
      prompt,
      exerciseSubprocessStart: true,
      subprocessPid: 321,
      executePromptFailureAfterStart: new Error("unexpected runtime throw"),
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
      "process:1",
      "close:error:1",
      "terminate:1",
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
        reason: "ACP execution failed during spawn",
      });

      expect(harness.renewedPrompts).toEqual([prompt, prompt, prompt]);
      expect(settle).toHaveBeenCalledOnce();
      expect(settle).toHaveBeenCalledWith({
        result: {
          kind: "terminal",
          outcome: "failed",
          reason: "ACP execution failed during spawn",
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
