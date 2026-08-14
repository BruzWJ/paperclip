import { describe, expect, it, vi } from "vitest";
import {
  ACP_SESSION_CORRELATION_ENVELOPE_VERSION,
  ACP_SESSION_CORRELATION_KIND,
  createAcpSessionCorrelation,
  type AcpxOneShotPromptInput,
  type AcpxOneShotPromptResult,
} from "@paperclipai/adapter-utils/acpx-runtime";
import {
  createTaskExecutionAttemptExecutor as createTaskExecutionAttemptExecutorImport,
  TaskExecutionPromptAuthorityLost as TaskExecutionPromptAuthorityLostImport,
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
export const createTaskExecutionAttemptExecutor = createTaskExecutionAttemptExecutorImport;
export const TaskExecutionPromptAuthorityLost = TaskExecutionPromptAuthorityLostImport;
const hoistedAcpxFixture = vi.hoisted(() =>
  Object.freeze({
    agentName: "fixture-agent",
    executeAcpxOneShotPrompt: vi.fn(),
    prepareAcpxRuntimeInvocation: vi.fn(),
  }),
);
export const acpxFixture = hoistedAcpxFixture;

vi.mock("@paperclipai/adapter-utils/acpx-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/acpx-runtime")>();
  return {
    ...actual,
    executeAcpxOneShotPrompt: hoistedAcpxFixture.executeAcpxOneShotPrompt,
    prepareAcpxRuntimeInvocation: hoistedAcpxFixture.prepareAcpxRuntimeInvocation,
  };
});

export function deferred() {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export function waitForGateOrAbort(gate: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
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

export function settledResult(): AcpxOneShotPromptResult {
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

export function createHarness(input: {
  prompt: ResolvedTaskExecutionPrompt;
  resumeFailureBeforeTransmission?: Error;
  nativeCancellation?: "with_occupancy" | "without_occupancy";
  prepareFailureMessage?: string;
  targetRedactor?: (value: string) => string;
  executePromptGate?: Promise<void>;
  renewPromptAuthority?: (call: number, prompt: ResolvedTaskExecutionPrompt) => Promise<void> | void;
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
  const invocationFileSets: Array<readonly { fileName: string; contents: string }[]> = [];
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

  acpxFixture.prepareAcpxRuntimeInvocation.mockImplementation(async (targetInput) => {
    invocationFileSets.push(targetInput.invocationFiles ?? []);
    if (input.prepareFailureMessage) throw new Error(input.prepareFailureMessage);
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
  });
  acpxFixture.executeAcpxOneShotPrompt.mockImplementation(async (execution) => {
    executionStarted.resolve();
    launches.push(execution);
    starts.push(execution.start);
    if (execution.signal?.aborted) throw execution.signal.reason;
    if (input.executePromptGate) {
      await waitForGateOrAbort(input.executePromptGate, execution.signal);
    }
    if (input.resumeFailureBeforeTransmission && execution.start.kind === "resume") {
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
    if (input.executePromptFailureAfterTransmission) throw input.executePromptFailureAfterTransmission;
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

export function lease(prompt: ResolvedTaskExecutionPrompt) {
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

export function executeAttempt(
  harness: ReturnType<typeof createHarness>,
  prompt: ResolvedTaskExecutionPrompt,
  settle: Parameters<ReturnType<typeof createHarness>["executor"]["execute"]>[2] = async () => {},
  signal: AbortSignal = new AbortController().signal,
) {
  return harness.executor.execute(lease(prompt), signal, settle);
}

export { describe, expect, it, vi, ACP_SESSION_CORRELATION_ENVELOPE_VERSION };
export { ACP_SESSION_CORRELATION_KIND, createAcpSessionCorrelation };
export { createNativeCorrelationService, localExecutionCorrelationFingerprint };
export type { AcpxOneShotPromptInput, AcpxOneShotPromptResult };
export type { TaskExecutionPromptClosure, TaskExecutionPromptCycleRepository };
export type { ResolvedTaskExecutionPrompt, AcpCorrelationScope };
export type { ProtectedAcpSessionCorrelation, StoredAcpSessionCorrelation };
export type { PluginBeforePromptDispatcher };
