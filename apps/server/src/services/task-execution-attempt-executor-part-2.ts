import { type AcpxOneShotPromptResult } from "@paperclipai/adapter-utils/acpx-runtime";

import { AGENT_CONTEXT_GRANT_KEYS } from "@paperclipai/shared";

import type { AcquiredTaskExecutionTarget } from "./task-execution-provider-configuration.js";

import { localExecutionCorrelationFingerprint } from "./local-execution-correlation.js";

import {
  type MintedTaskExecutionPromptCapability,
  type ResolvedTaskExecutionPrompt,
  type TaskExecutionAttemptLease,
  type TaskExecutionPromptClosure,
  type TaskExecutionPromptPhase,
  TaskExecutionAttemptRejected,
  TaskExecutionPromptAuthorityLost,
  canonicalAcpConfiguration,
  errorMessage,
  exactDigest,
  exactIdentity,
  sameCorrelationLogicalKey,
  sameStringSequence,
} from "./task-execution-attempt-executor-part-1.js";

export { errorMessage };

export function validatePrompt(prompt: ResolvedTaskExecutionPrompt): void {
  const identity = prompt.identity;
  for (const [label, value] of [
    ["company id", identity.companyId],
    ["task id", identity.taskId],
    ["Session id", identity.sessionId],
    ["execution scope id", identity.executionScopeId],
    ["run id", identity.runId],
    ["attempt id", identity.attemptId],
    ["lease id", identity.leaseId],
    ["ref id", identity.refId],
    ["target agent id", identity.targetAgentId],
    ["adapter revision id", identity.adapterConfigRevisionId],
    ["workspace binding id", identity.executionWorkspaceBindingId],
    ["source message id", prompt.sourceMessageId],
  ] as const) {
    exactIdentity(value, label);
  }
  exactDigest(identity.runBatchDigest, "run batch digest");
  exactDigest(prompt.effectiveContextExposureDigest, "effective context exposure digest");
  exactDigest(prompt.carrySourceExposureDigest, "carry source exposure digest");
  exactDigest(prompt.effectiveToolsDigest, "effective tools digest");
  if (
    prompt.sourceText.length === 0 ||
    (prompt.turn !== "bootstrap" && prompt.turn !== "work") ||
    !Number.isSafeInteger(prompt.sourceMessageSeq) ||
    prompt.sourceMessageSeq < 0 ||
    AGENT_CONTEXT_GRANT_KEYS.some((key) => typeof prompt.contextAccess[key] !== "boolean") ||
    identity.ownershipEpoch < 1 ||
    identity.leaseGeneration < 1 ||
    identity.attemptGeneration < 1 ||
    identity.refOrdinal < 0 ||
    identity.segmentOrdinal < 0 ||
    !Number.isSafeInteger(prompt.leaseRenewalIntervalMs) ||
    prompt.leaseRenewalIntervalMs < 1 ||
    (identity.promptKind === "base" && identity.segmentOrdinal !== 0) ||
    (identity.promptKind === "steering" && identity.segmentOrdinal < 1) ||
    identity.runKind !== (identity.laneKind === "owner" ? "productive" : "consult") ||
    (identity.laneKind === "owner"
      ? !identity.taskExecutionAuthorityId || identity.consultExecutionId !== null
      : identity.taskExecutionAuthorityId !== null || !identity.consultExecutionId)
  ) {
    throw new TaskExecutionAttemptRejected("resolved ACP prompt has an invalid canonical identity");
  }
  const scope = prompt.activationCorrelationScope;
  if (
    scope.companyId !== identity.companyId ||
    scope.taskId !== identity.taskId ||
    scope.ownershipEpoch !== identity.ownershipEpoch ||
    scope.targetAgentId !== identity.targetAgentId ||
    scope.adapterConfigIdentity !== identity.adapterConfigRevisionId ||
    scope.workspaceIdentity !== identity.executionWorkspaceBindingId ||
    scope.targetFingerprint !== localExecutionCorrelationFingerprint(identity.adapterConfigRevisionId) ||
    (prompt.carryContext
      ? scope.purpose !== "carry" ||
        scope.laneKind !== identity.laneKind ||
        scope.authorizedContextExposureDigest !== prompt.effectiveContextExposureDigest
      : scope.purpose !== "active_run_steering" ||
        scope.runId !== identity.runId ||
        scope.currentRefId !== identity.refId ||
        scope.currentRefOrdinal !== identity.refOrdinal ||
        scope.currentSegmentOrdinal !== identity.segmentOrdinal)
  ) {
    throw new TaskExecutionAttemptRejected("ACP correlation activation scope crossed the resolved prompt");
  }
  if (
    prompt.target.companyId !== identity.companyId ||
    prompt.target.taskId !== identity.taskId ||
    prompt.target.runId !== identity.runId ||
    prompt.target.targetAgentId !== identity.targetAgentId ||
    prompt.target.adapterConfigRevisionId !== identity.adapterConfigRevisionId ||
    prompt.target.executionWorkspaceBindingId !== identity.executionWorkspaceBindingId ||
    canonicalAcpConfiguration(prompt.target.acpConfiguration) !==
      canonicalAcpConfiguration(prompt.acpConfiguration)
  ) {
    throw new TaskExecutionAttemptRejected("execution target input crossed the canonical prompt");
  }
  const storedScope = prompt.storedCorrelation?.scope;
  const storedScopeMatchesPrompt =
    storedScope === undefined ||
    (storedScope.companyId === identity.companyId &&
      storedScope.taskId === identity.taskId &&
      storedScope.ownershipEpoch === identity.ownershipEpoch &&
      storedScope.targetAgentId === identity.targetAgentId &&
      storedScope.adapterConfigIdentity === identity.adapterConfigRevisionId &&
      storedScope.workspaceIdentity === identity.executionWorkspaceBindingId &&
      storedScope.targetFingerprint === scope.targetFingerprint &&
      (identity.promptKind === "base"
        ? prompt.bootstrapPredecessor === null
          ? storedScope.purpose === "carry" &&
            sameCorrelationLogicalKey(storedScope, scope) &&
            storedScope.correlationGeneration + 1 === scope.correlationGeneration
          : storedScope.purpose === "carry" ||
            (storedScope.runId === prompt.bootstrapPredecessor.runId &&
              storedScope.currentRefId === prompt.bootstrapPredecessor.refId &&
              storedScope.currentRefOrdinal === prompt.bootstrapPredecessor.refOrdinal &&
              storedScope.currentSegmentOrdinal === 0)
        : storedScope.purpose === "carry"
          ? storedScope.laneKind === identity.laneKind &&
            storedScope.authorizedContextExposureDigest === prompt.carrySourceExposureDigest &&
            (scope.purpose !== "carry" ||
              storedScope.correlationGeneration + 1 === scope.correlationGeneration)
          : storedScope.runId === identity.runId &&
            storedScope.currentRefId === identity.refId &&
            storedScope.currentRefOrdinal === identity.refOrdinal &&
            storedScope.currentSegmentOrdinal === identity.segmentOrdinal - 1 &&
            (scope.purpose !== "active_run_steering" ||
              storedScope.correlationGeneration + 1 === scope.correlationGeneration)));
  if (!storedScopeMatchesPrompt) {
    throw new TaskExecutionAttemptRejected(
      "stored ACP correlation crossed the canonical prompt or generation",
    );
  }
  const bootstrapPredecessor = prompt.bootstrapPredecessor;
  if (
    bootstrapPredecessor !== null &&
    (identity.promptKind !== "base" ||
      prompt.sessionOperation !== "resume" ||
      prompt.storedCorrelation === null ||
      bootstrapPredecessor.runId.length === 0 ||
      bootstrapPredecessor.refId.length === 0 ||
      !Number.isSafeInteger(bootstrapPredecessor.refOrdinal) ||
      bootstrapPredecessor.refOrdinal < 0)
  ) {
    throw new TaskExecutionAttemptRejected("bootstrap predecessor proof crossed the resolved prompt");
  }
  const operation = prompt.sessionOperation;
  const operationIsValid =
    (operation === "new" &&
      identity.promptKind === "base" &&
      bootstrapPredecessor === null &&
      prompt.storedCorrelation === null) ||
    (operation === "resume" &&
      ((prompt.carryContext && prompt.storedCorrelation?.scope.purpose === "carry") ||
        bootstrapPredecessor !== null)) ||
    (operation === "steer_resume" && identity.promptKind === "steering" && prompt.storedCorrelation !== null);
  if (!operationIsValid) {
    throw new TaskExecutionAttemptRejected(
      "ACP session operation crossed carry policy or stored correlation",
    );
  }
}

export function waitForLeaseRenewalInterval(intervalMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, intervalMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function validateLeaseResolution(
  lease: TaskExecutionAttemptLease,
  prompt: ResolvedTaskExecutionPrompt,
): void {
  const identity = prompt.identity;
  if (
    lease.companyId !== identity.companyId ||
    lease.taskId !== identity.taskId ||
    lease.runId !== identity.runId ||
    lease.attemptId !== identity.attemptId ||
    lease.leaseId !== identity.leaseId ||
    lease.leaseGeneration !== identity.leaseGeneration
  ) {
    throw new TaskExecutionAttemptRejected("prompt resolver returned a different attempt lease");
  }
}

export function exactCapability(capability: MintedTaskExecutionPromptCapability): void {
  exactIdentity(capability.capabilityConnectionId, "capability connection id");
  exactIdentity(capability.endpoint, "capability endpoint");
  exactIdentity(capability.bearer, "capability bearer");
  if (capability.capabilityGeneration < 1) {
    throw new TaskExecutionAttemptRejected("capability generation must be positive");
  }
  let endpoint: URL;
  try {
    endpoint = new URL(capability.endpoint);
  } catch {
    throw new TaskExecutionAttemptRejected("capability endpoint must be an absolute URL");
  }
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new TaskExecutionAttemptRejected("capability endpoint must use HTTP transport");
  }
}

export function runToolsSecret(capability: MintedTaskExecutionPromptCapability): string {
  return JSON.stringify({
    bearer: capability.bearer,
    endpoint: capability.endpoint,
    kind: "paperclip.run-tools/v1",
  });
}

export function findPromptAuthorityLoss(
  error: unknown,
  seen = new Set<unknown>(),
): TaskExecutionPromptAuthorityLost | null {
  if (error instanceof TaskExecutionPromptAuthorityLost) return error;
  if (error === null || (typeof error !== "object" && typeof error !== "function") || seen.has(error)) {
    return null;
  }
  seen.add(error);
  if (error instanceof AggregateError) {
    for (const nested of error.errors) {
      const authorityLoss = findPromptAuthorityLoss(nested, seen);
      if (authorityLoss) return authorityLoss;
    }
  }
  return error instanceof Error ? findPromptAuthorityLoss(error.cause, seen) : null;
}

export function canonicalClosure(result: AcpxOneShotPromptResult): TaskExecutionPromptClosure {
  if (result.kind === "error") {
    const phase = acpxRuntimePhase(result.phase);
    return {
      kind: "error",
      failure: "runtime",
      phase,
      promptTransmitted: result.promptTransmitted,
      message: `ACP execution failed during ${phase}`,
    };
  }
  const settlement = result.settlement;
  if (settlement === null) {
    return { kind: "cancelled", settlement: null };
  }
  return result.kind === "completed" ? { kind: "settled", settlement } : { kind: "cancelled", settlement };
}

export function replaceExact(value: string, secret: string): string {
  return secret.length === 0 ? value : value.split(secret).join("[REDACTED]");
}

export function createRuntimeRedactor(input: {
  readonly targetRedactor: (value: string) => string;
  readonly capability: MintedTaskExecutionPromptCapability;
  readonly resumeSessionId: string | null;
  readonly activatedSessionId: () => string | null;
}): (value: string) => string {
  return (value) => {
    let redacted: string;
    try {
      redacted = input.targetRedactor(value);
    } catch {
      return "[ACP runtime redaction failed]";
    }
    if (typeof redacted !== "string") {
      return "[ACP runtime redaction failed]";
    }
    redacted = replaceExact(redacted, input.capability.bearer);
    if (input.resumeSessionId) {
      redacted = replaceExact(redacted, input.resumeSessionId);
    }
    const activatedSessionId = input.activatedSessionId();
    if (activatedSessionId) {
      redacted = replaceExact(redacted, activatedSessionId);
    }
    return redacted;
  };
}

export function acpxRuntimePhase(
  phase: "session_setup" | "configuration" | "prompt_activation" | "prompt_transmission" | "prompt",
): TaskExecutionPromptPhase {
  switch (phase) {
    case "prompt_activation":
    case "prompt_transmission":
    case "prompt":
      return phase;
    case "session_setup":
    case "configuration":
      return "session_setup";
  }
}

export function redactAcpxRuntimeError(cause: unknown, redact: (value: string) => string): Error {
  const raw = errorMessage(cause);
  try {
    const redacted = redact(raw);
    return new Error(typeof redacted === "string" ? redacted : "[ACPX runtime redaction failed]");
  } catch {
    return new Error("[ACPX runtime redaction failed]");
  }
}

export function assertTargetMatchesPrompt(
  prompt: ResolvedTaskExecutionPrompt,
  target: AcquiredTaskExecutionTarget,
): void {
  if (
    target.adapterConfigRevisionId !== prompt.identity.adapterConfigRevisionId ||
    canonicalAcpConfiguration(target.acpConfiguration) !==
      canonicalAcpConfiguration(prompt.acpConfiguration) ||
    target.executionTarget.kind !== "local" ||
    target.hostCwd !== prompt.target.hostCwd ||
    !sameStringSequence(target.targetAdditionalDirectories, prompt.target.targetAdditionalDirectories) ||
    target.targetCwd !== prompt.target.localWorkspaceCwd
  ) {
    throw new TaskExecutionAttemptRejected(
      "acquired execution target differs from the immutable ACP revision",
    );
  }
}
