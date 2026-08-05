import {
  createPaperclipRunToolsMcpServer,
  executeAcpxOneShotPrompt,
  prepareAcpxRuntimeInvocation,
  type AcpPromptClosureOutcome,
  type AcpPromptExecutionPhase,
  type AcpPromptExecutionResult,
  type AcpPromptSettlement,
  type AcpSessionConfigSelection,
  type AcpxRuntimeMcpServer,
  type NormalizedAcpSessionEvent,
} from "@paperclipai/adapter-utils/acp-subprocess";
import { RUN_TOOLS_STDIO_PROXY_SOURCE } from "@paperclipai/adapter-utils/run-tools-stdio-proxy";
import type { LocalProcessSandboxOptions } from "@paperclipai/adapter-utils/local-process-sandbox";
import type { SelectedCompanySkillLaunchChannel } from "@paperclipai/adapter-utils/selected-company-skills";
import {
  agentAdapterAcpConfigurationSchema,
  type AgentAdapterAcpConfiguration,
  type IssueExecutionSessionOperation,
} from "@paperclipai/shared";
import type {
  AcpCorrelationScope,
  NativeCorrelationService,
  ProtectedAcpSessionCorrelation,
  StoredAcpSessionCorrelation,
} from "./native-correlation.js";
import type {
  AcquiredIssueExecutionTarget,
  IssueExecutionRuntimeRedactor,
  IssueExecutionTargetAcquirer,
  IssueExecutionTargetAcquisitionInput,
} from "./issue-execution-provider-configuration.js";
import type {
  ReapedCompanySkillMaterialization,
} from "./company-skill-materialization-lifecycle.js";

const RUN_TOOLS_PROXY_FILE = "run-tools-proxy.mjs";
const RUN_TOOLS_SECRET_FILE = "run-tools.json";

export interface IssueExecutionAttemptLease {
  readonly companyId: string;
  readonly issueId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly leaseId: string;
  readonly leaseGeneration: number;
}

export class IssueExecutionPromptAuthorityLost extends Error {
  readonly code = "issue_execution_prompt_authority_lost";
  readonly lease: IssueExecutionAttemptLease;
  override readonly cause: unknown;

  constructor(lease: IssueExecutionAttemptLease, cause: unknown) {
    super(`Issue-execution prompt authority was lost: ${errorMessage(cause)}`);
    this.name = "IssueExecutionPromptAuthorityLost";
    this.lease = Object.freeze({ ...lease });
    this.cause = cause;
  }
}

export interface IssueExecutionPromptIdentity
  extends IssueExecutionAttemptLease {
  readonly sessionId: string;
  readonly ownershipEpoch: number;
  readonly executionScopeId: string;
  readonly runBatchDigest: string;
  readonly runKind: "productive" | "consult";
  readonly promptKind: "base" | "steering";
  readonly refId: string;
  readonly refOrdinal: number;
  /** Base prompts use zero; persisted positive segments are steering. */
  readonly segmentOrdinal: number;
  readonly attemptGeneration: number;
  readonly targetAgentId: string;
  readonly laneKind: "owner" | "consult";
  readonly issueExecutionAuthorityId: string | null;
  readonly consultExecutionId: string | null;
  readonly adapterConfigRevisionId: string;
  readonly executionWorkspaceBindingId: string;
}

export interface ResolvedIssueExecutionPrompt {
  readonly identity: IssueExecutionPromptIdentity;
  /** Immutable operation frozen on this exact attempt generation. */
  readonly sessionOperation: IssueExecutionSessionOperation;
  readonly sourceText: string;
  readonly carryContext: boolean;
  /** Null only for a frozen new operation; every resume pins one exact target. */
  readonly storedCorrelation: StoredAcpSessionCorrelation | null;
  /** Exact next append-only generation installed at prompt activation. */
  readonly activationCorrelationScope: AcpCorrelationScope;
  readonly effectiveContextExposureDigest: string;
  /** Current exposure with carry_context normalized true for source checks. */
  readonly carrySourceExposureDigest: string;
  readonly effectiveToolsDigest: string;
  readonly acpConfiguration: AgentAdapterAcpConfiguration;
  /** Exact historical revision pins and immutable version inventories. */
  readonly companySkills: SelectedCompanySkillLaunchChannel;
  readonly target: IssueExecutionTargetAcquisitionInput;
  readonly timeoutSec?: number | null;
  readonly runtimeRootDir?: string | null;
  readonly localProcessSandbox?: LocalProcessSandboxOptions | null;
  /** Exact cadence for renewing this attempt's canonical lease authority. */
  readonly leaseRenewalIntervalMs: number;
}

export interface IssueExecutionPromptCapabilityIdentity {
  readonly capabilityConnectionId: string;
  readonly capabilityGeneration: number;
}

export interface MintedIssueExecutionPromptCapability
  extends IssueExecutionPromptCapabilityIdentity {
  readonly endpoint: string;
  readonly bearer: string;
}

export type IssueExecutionDispatchResult =
  | {
      readonly kind: "retry";
      readonly reason:
        | "process_loss"
        | "transport_transient"
        | "provider_quota"
        | "target_not_found_new_session";
      readonly retryAt: Date;
    }
  | {
      readonly kind: "terminal";
      readonly outcome: "succeeded" | "failed" | "cancelled";
      readonly reason: string | null;
      readonly finalText?: string | null;
    };

export type IssueExecutionPromptClosure =
  | {
      readonly kind: "settled";
      readonly settlement: AcpPromptSettlement;
      readonly cancellationNotificationFailed: boolean;
    }
  | { readonly kind: "target_not_found" }
  | {
      readonly kind: "error";
      readonly failure: "authentication_required" | "runtime";
      readonly phase: AcpPromptExecutionPhase;
      readonly promptTransmitted: boolean;
      readonly message: string;
    };

export type IssueExecutionPromptClosureDecision =
  {
    readonly kind: "dispatch";
    readonly result: IssueExecutionDispatchResult;
  };

export type IssueExecutionSubprocessObservation = {
  readonly resultKind: AcpPromptExecutionResult["kind"];
  readonly phase: AcpPromptExecutionPhase | null;
  readonly promptTransmitted: boolean;
  readonly closureFailed: boolean;
  readonly teardown:
    | { readonly kind: "not_started" }
    | {
        readonly kind: "reaped";
        readonly exitCode: number | null;
        readonly signal: NodeJS.Signals | null;
      }
    | { readonly kind: "failed"; readonly message: string };
  /** Bounded target-redacted diagnostics; never assistant output. */
  readonly stderr: string;
};

/**
 * Narrow canonical DB transition boundary. Implementations lock and recheck
 * run/ref/segment, attempt, lease, epoch, authority, revision, workspace,
 * correlation, and capability generation in every mutating operation.
 */
export interface IssueExecutionPromptCycleRepository {
  resolve(
    lease: IssueExecutionAttemptLease,
  ): Promise<ResolvedIssueExecutionPrompt>;
  renewPromptAuthority(prompt: ResolvedIssueExecutionPrompt): Promise<void>;
  mintPendingCapability(
    prompt: ResolvedIssueExecutionPrompt,
  ): Promise<MintedIssueExecutionPromptCapability>;
  activatePrompt(input: {
    readonly prompt: ResolvedIssueExecutionPrompt;
    readonly capability: IssueExecutionPromptCapabilityIdentity;
    readonly correlation: ProtectedAcpSessionCorrelation;
  }): Promise<void>;
  beginPromptTransmission(input: {
    readonly prompt: ResolvedIssueExecutionPrompt;
    readonly capability: IssueExecutionPromptCapabilityIdentity;
  }): Promise<void>;
  recordSubprocessStarted(input: {
    readonly prompt: ResolvedIssueExecutionPrompt;
    readonly capability: IssueExecutionPromptCapabilityIdentity;
    readonly processId: number;
    readonly processGroupId: number;
    readonly supervisorLocator: string;
  }): Promise<void>;
  closePrompt(input: {
    readonly prompt: ResolvedIssueExecutionPrompt;
    readonly capability: IssueExecutionPromptCapabilityIdentity;
    readonly outcome: IssueExecutionPromptClosure;
  }): Promise<IssueExecutionPromptClosureDecision>;
  recordSubprocessTeardown(input: {
    readonly prompt: ResolvedIssueExecutionPrompt;
    readonly capability: IssueExecutionPromptCapabilityIdentity;
    readonly observation: IssueExecutionSubprocessObservation;
  }): Promise<void>;
  recordProtocolViolation(input: {
    readonly prompt: ResolvedIssueExecutionPrompt;
    readonly capability: IssueExecutionPromptCapabilityIdentity;
    readonly message: string;
  }): Promise<void>;
}

export interface IssueExecutionAcpEventSink {
  /** Validate and publication-redact before any durable or live projection. */
  publish(input: {
    readonly prompt: IssueExecutionPromptIdentity;
    readonly capability: IssueExecutionPromptCapabilityIdentity;
    readonly redactor: IssueExecutionRuntimeRedactor;
    readonly event: Exclude<NormalizedAcpSessionEvent, { kind: "user_message_echo" }>;
  }): Promise<void>;
}

export interface IssueExecutionAttemptExecutor {
  execute(
    lease: IssueExecutionAttemptLease,
    signal: AbortSignal,
    settle: IssueExecutionAttemptSettlement,
  ): Promise<IssueExecutionDispatchResult>;
}

export interface IssueExecutionAttemptSettlementInput {
  readonly result: IssueExecutionDispatchResult;
  readonly materialization: ReapedCompanySkillMaterialization | null;
}

export type IssueExecutionAttemptSettlement = (
  input: IssueExecutionAttemptSettlementInput,
) => Promise<void>;

export class IssueExecutionAttemptRejected extends Error {
  readonly code = "issue_execution_attempt_rejected";

  constructor(message: string) {
    super(message);
    this.name = "IssueExecutionAttemptRejected";
  }
}

/**
 * The worker delegates the provider lifecycle to ACPX. This intentionally
 * retains the established Paperclip closure shape so durable prompt authority
 * and accounting remain unchanged while Paperclip no longer speaks raw ACP
 * to a provider frontend itself.
 */
/**
 * The only production provider invocation shape. It contains ACPX runtime
 * inputs and durable Paperclip fences, never an argv, subprocess, or raw ACP
 * starter.
 */
export interface AcpxRuntimePromptExecutionInput {
  readonly cwd: string;
  /** ACPX configuration scope; the session itself still uses `cwd`. */
  readonly registryCwd?: string;
  readonly agentName: string;
  readonly configSelections: readonly AcpSessionConfigSelection[];
  readonly mcpServers: readonly AcpxRuntimeMcpServer[];
  readonly timeoutMs?: number;
  readonly request: {
    readonly start: { readonly kind: "new" } | {
      readonly kind: "resume";
      readonly sessionId: string;
    };
    readonly message: string;
  };
  readonly signal: AbortSignal;
  readonly redactStderr: (chunk: string) => string;
  readonly activatePrompt: (input: {
    readonly sessionId: string;
  }) => Promise<void>;
  readonly beginPromptTransmission: (input: {
    readonly sessionId: string;
  }) => Promise<void>;
  readonly releasePreparedResources: () => Promise<void>;
  readonly closePrompt: (outcome: AcpPromptClosureOutcome) => Promise<void>;
  readonly onSessionEvent: (
    event: NormalizedAcpSessionEvent,
  ) => Promise<void> | void;
  readonly validatePromptEvents?: () => Promise<void> | void;
  readonly onProtocolViolation?: (error: Error) => Promise<void> | void;
}

type ExecutePrompt = (
  input: AcpxRuntimePromptExecutionInput,
) => Promise<AcpPromptExecutionResult>;
type PrepareTarget = typeof prepareAcpxRuntimeInvocation;

function exactIdentity(value: string, label: string): void {
  if (value.length === 0 || value !== value.trim()) {
    throw new IssueExecutionAttemptRejected(
      `${label} must be exact and non-empty`,
    );
  }
}

function exactDigest(value: string, label: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new IssueExecutionAttemptRejected(`${label} is not a SHA-256 digest`);
  }
}

function canonicalAcpConfiguration(
  value: AgentAdapterAcpConfiguration,
): string {
  try {
    return JSON.stringify(agentAdapterAcpConfigurationSchema.parse(value));
  } catch {
    throw new IssueExecutionAttemptRejected(
      "resolved ACP configuration is not canonical",
    );
  }
}

function sameStringSequence(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function sameCorrelationLogicalKey(
  left: AcpCorrelationScope,
  right: AcpCorrelationScope,
): boolean {
  if (
    left.purpose !== right.purpose ||
    left.companyId !== right.companyId ||
    left.issueId !== right.issueId ||
    left.ownershipEpoch !== right.ownershipEpoch ||
    left.targetAgentId !== right.targetAgentId ||
    left.adapterConfigIdentity !== right.adapterConfigIdentity ||
    left.workspaceIdentity !== right.workspaceIdentity ||
    left.targetFingerprint !== right.targetFingerprint
  ) {
    return false;
  }
  if (left.purpose === "carry" && right.purpose === "carry") {
    return left.laneKind === right.laneKind &&
      left.authorizedContextExposureDigest ===
        right.authorizedContextExposureDigest;
  }
  return left.purpose === "active_run_steering" &&
    right.purpose === "active_run_steering" &&
    left.runId === right.runId;
}

function validatePrompt(prompt: ResolvedIssueExecutionPrompt): void {
  const identity = prompt.identity;
  if (
    prompt.acpConfiguration.skillChannel !== "operator_native" ||
    prompt.companySkills.channel !== "operator_native"
  ) {
    throw new IssueExecutionAttemptRejected(
      "ACPX public runtime requires operator_native skills; isolated_skills_home is not supported",
    );
  }
  for (const [label, value] of [
    ["company id", identity.companyId],
    ["issue id", identity.issueId],
    ["Session id", identity.sessionId],
    ["execution scope id", identity.executionScopeId],
    ["run id", identity.runId],
    ["attempt id", identity.attemptId],
    ["lease id", identity.leaseId],
    ["ref id", identity.refId],
    ["target agent id", identity.targetAgentId],
    ["adapter revision id", identity.adapterConfigRevisionId],
    ["workspace binding id", identity.executionWorkspaceBindingId],
  ] as const) {
    exactIdentity(value, label);
  }
  exactDigest(identity.runBatchDigest, "run batch digest");
  exactDigest(
    prompt.effectiveContextExposureDigest,
    "effective context exposure digest",
  );
  exactDigest(
    prompt.carrySourceExposureDigest,
    "carry source exposure digest",
  );
  exactDigest(prompt.effectiveToolsDigest, "effective tools digest");
  if (
    prompt.sourceText.length === 0 ||
    identity.ownershipEpoch < 1 ||
    identity.leaseGeneration < 1 ||
    identity.attemptGeneration < 1 ||
    identity.refOrdinal < 0 ||
    identity.segmentOrdinal < 0 ||
    !Number.isSafeInteger(prompt.leaseRenewalIntervalMs) ||
    prompt.leaseRenewalIntervalMs < 1 ||
    (identity.promptKind === "base" && identity.segmentOrdinal !== 0) ||
    (identity.promptKind === "steering" && identity.segmentOrdinal < 1) ||
    identity.runKind !==
      (identity.laneKind === "owner" ? "productive" : "consult") ||
    (identity.laneKind === "owner"
      ? !identity.issueExecutionAuthorityId || identity.consultExecutionId !== null
      : identity.issueExecutionAuthorityId !== null || !identity.consultExecutionId)
  ) {
    throw new IssueExecutionAttemptRejected(
      "resolved ACP prompt has an invalid canonical identity",
    );
  }
  const scope = prompt.activationCorrelationScope;
  if (
    scope.companyId !== identity.companyId ||
    scope.issueId !== identity.issueId ||
    scope.ownershipEpoch !== identity.ownershipEpoch ||
    scope.targetAgentId !== identity.targetAgentId ||
    scope.adapterConfigIdentity !== identity.adapterConfigRevisionId ||
    scope.workspaceIdentity !== identity.executionWorkspaceBindingId ||
    scope.targetFingerprint !==
      prompt.acpConfiguration.executionTargetSelector.executionTargetDigest ||
    (prompt.carryContext
      ? scope.purpose !== "carry" ||
        scope.laneKind !== identity.laneKind ||
        scope.authorizedContextExposureDigest !==
          prompt.effectiveContextExposureDigest
      : scope.purpose !== "active_run_steering" ||
        scope.runId !== identity.runId ||
        scope.currentRefId !== identity.refId ||
        scope.currentRefOrdinal !== identity.refOrdinal ||
        scope.currentSegmentOrdinal !== identity.segmentOrdinal)
  ) {
    throw new IssueExecutionAttemptRejected(
      "ACP correlation activation scope crossed the resolved prompt",
    );
  }
  if (
    prompt.target.companyId !== identity.companyId ||
    prompt.target.issueId !== identity.issueId ||
    prompt.target.runId !== identity.runId ||
    prompt.target.targetAgentId !== identity.targetAgentId ||
    prompt.target.adapterConfigRevisionId !== identity.adapterConfigRevisionId ||
    prompt.target.executionWorkspaceBindingId !==
      identity.executionWorkspaceBindingId ||
    canonicalAcpConfiguration(prompt.target.acpConfiguration) !==
      canonicalAcpConfiguration(prompt.acpConfiguration)
  ) {
    throw new IssueExecutionAttemptRejected(
      "execution target input crossed the canonical prompt",
    );
  }
  const storedScope = prompt.storedCorrelation?.scope;
  const storedScopeMatchesPrompt = storedScope === undefined ||
    (storedScope.companyId === identity.companyId &&
      storedScope.issueId === identity.issueId &&
      storedScope.ownershipEpoch === identity.ownershipEpoch &&
      storedScope.targetAgentId === identity.targetAgentId &&
      storedScope.adapterConfigIdentity === identity.adapterConfigRevisionId &&
      storedScope.workspaceIdentity === identity.executionWorkspaceBindingId &&
      storedScope.targetFingerprint === scope.targetFingerprint &&
      (identity.promptKind === "base"
        ? storedScope.purpose === "carry" &&
          sameCorrelationLogicalKey(storedScope, scope) &&
          storedScope.correlationGeneration + 1 === scope.correlationGeneration
        : storedScope.purpose === "carry"
          ? storedScope.laneKind === identity.laneKind &&
            storedScope.authorizedContextExposureDigest ===
              prompt.carrySourceExposureDigest &&
            (scope.purpose !== "carry" ||
              storedScope.correlationGeneration + 1 ===
                scope.correlationGeneration)
          : storedScope.runId === identity.runId &&
            storedScope.currentRefId === identity.refId &&
            storedScope.currentRefOrdinal === identity.refOrdinal &&
            storedScope.currentSegmentOrdinal === identity.segmentOrdinal - 1 &&
            (scope.purpose !== "active_run_steering" ||
              storedScope.correlationGeneration + 1 ===
                scope.correlationGeneration)));
  if (!storedScopeMatchesPrompt) {
    throw new IssueExecutionAttemptRejected(
      "stored ACP correlation crossed the canonical prompt or generation",
    );
  }
  const operation = prompt.sessionOperation;
  const operationIsValid =
    (operation === "new" &&
      prompt.storedCorrelation === null) ||
    (operation === "resume" &&
      prompt.carryContext &&
      prompt.storedCorrelation?.scope.purpose === "carry") ||
    (operation === "steer_resume" &&
      identity.promptKind === "steering" &&
      prompt.storedCorrelation !== null);
  if (!operationIsValid) {
    throw new IssueExecutionAttemptRejected(
      "ACP session operation crossed carry policy or stored correlation",
    );
  }
}

function waitForLeaseRenewalInterval(
  intervalMs: number,
  signal: AbortSignal,
): Promise<boolean> {
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

function validateLeaseResolution(
  lease: IssueExecutionAttemptLease,
  prompt: ResolvedIssueExecutionPrompt,
): void {
  const identity = prompt.identity;
  if (
    lease.companyId !== identity.companyId ||
    lease.issueId !== identity.issueId ||
    lease.runId !== identity.runId ||
    lease.attemptId !== identity.attemptId ||
    lease.leaseId !== identity.leaseId ||
    lease.leaseGeneration !== identity.leaseGeneration
  ) {
    throw new IssueExecutionAttemptRejected(
      "prompt resolver returned a different attempt lease",
    );
  }
}

function exactCapability(
  capability: MintedIssueExecutionPromptCapability,
): void {
  exactIdentity(capability.capabilityConnectionId, "capability connection id");
  exactIdentity(capability.endpoint, "capability endpoint");
  exactIdentity(capability.bearer, "capability bearer");
  if (capability.capabilityGeneration < 1) {
    throw new IssueExecutionAttemptRejected(
      "capability generation must be positive",
    );
  }
  let endpoint: URL;
  try {
    endpoint = new URL(capability.endpoint);
  } catch {
    throw new IssueExecutionAttemptRejected(
      "capability endpoint must be an absolute URL",
    );
  }
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new IssueExecutionAttemptRejected(
      "capability endpoint must use HTTP transport",
    );
  }
}

function runToolsSecret(
  capability: MintedIssueExecutionPromptCapability,
): string {
  return JSON.stringify({
    bearer: capability.bearer,
    endpoint: capability.endpoint,
    kind: "paperclip.run-tools/v1",
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function findPromptAuthorityLoss(
  error: unknown,
  seen = new Set<unknown>(),
): IssueExecutionPromptAuthorityLost | null {
  if (error instanceof IssueExecutionPromptAuthorityLost) return error;
  if (
    error === null ||
    (typeof error !== "object" && typeof error !== "function") ||
    seen.has(error)
  ) {
    return null;
  }
  seen.add(error);
  if (error instanceof AggregateError) {
    for (const nested of error.errors) {
      const authorityLoss = findPromptAuthorityLoss(nested, seen);
      if (authorityLoss) return authorityLoss;
    }
  }
  return error instanceof Error
    ? findPromptAuthorityLoss(error.cause, seen)
    : null;
}

function canonicalClosure(
  outcome: AcpPromptClosureOutcome,
  prompt: ResolvedIssueExecutionPrompt,
): IssueExecutionPromptClosure {
  if (outcome.kind === "target_not_found") return outcome;
  if (outcome.kind === "error") {
    const authenticationRequired =
      outcome.failure === "authentication_required";
    return {
      kind: "error",
      failure: authenticationRequired
        ? "authentication_required"
        : "runtime",
      phase: outcome.phase,
      promptTransmitted: outcome.promptTransmitted,
      message: authenticationRequired
        ? "The configured ACP CLI requires its native login; authenticate that CLI outside Paperclip and retry"
        : `ACP execution failed during ${outcome.phase}`,
    };
  }
  const knownContextLimit =
    prompt.acpConfiguration.model?.limits?.contextTokenLimit;
  if (
    knownContextLimit !== undefined &&
    outcome.settlement.occupancy.size !== knownContextLimit
  ) {
    return {
      kind: "error",
      failure: "runtime",
      phase: "prompt",
      promptTransmitted: true,
      message: "ACP terminal occupancy size differs from the immutable model revision",
    };
  }
  return {
    kind: "settled",
    settlement: outcome.settlement,
    cancellationNotificationFailed:
      outcome.cancellationNotificationError !== null,
  };
}

function replaceExact(value: string, secret: string): string {
  return secret.length === 0
    ? value
    : value.split(secret).join("[REDACTED]");
}

function createRuntimeRedactor(input: {
  readonly targetRedactor: (value: string) => string;
  readonly capability: MintedIssueExecutionPromptCapability;
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

function subprocessObservation(
  result: AcpPromptExecutionResult,
  redactText: (value: string) => string,
): IssueExecutionSubprocessObservation {
  const teardown = result.teardown.kind === "reaped"
    ? {
        kind: "reaped" as const,
        exitCode: result.teardown.processExit.exitCode,
        signal: result.teardown.processExit.signal,
      }
    : result.teardown.kind === "failed"
      ? {
          kind: "failed" as const,
          message: "ACP subprocess teardown failed",
        }
      : { kind: "not_started" as const };
  return {
    resultKind: result.kind,
    phase: result.kind === "error" ? result.phase : null,
    promptTransmitted:
      result.kind === "settled" ||
      (result.kind === "error" && result.promptTransmitted),
    closureFailed: result.closureError !== null,
    teardown,
    stderr: redactText(result.stderr),
  };
}

function failedExecutionResult(input: {
  readonly cause: unknown;
  readonly phase: AcpPromptExecutionPhase;
  readonly promptTransmitted: boolean;
  readonly closureError: unknown | null;
  readonly teardown: AcpPromptExecutionResult["teardown"];
}): AcpPromptExecutionResult {
  return {
    kind: "error",
    failure: "runtime",
    phase: input.phase,
    promptTransmitted: input.promptTransmitted,
    cause: input.cause,
    closureError: input.closureError,
    teardown: input.teardown,
    stderr: "",
  };
}

function acpxRuntimeConfigSelections(
  selections: readonly AcpSessionConfigSelection[],
) {
  return Object.freeze(
    selections.map((selection) =>
      Object.freeze({
        configId: selection.configId,
        // ACPX's public runtime exposes one canonical string setter. Boolean
        // form values remain useful UI state, but the immutable runtime
        // invocation is always the exact textual value ACPX accepts.
        value:
          typeof selection.value === "boolean"
            ? String(selection.value)
            : selection.value,
      }),
    ),
  );
}

function acpxRuntimeTimeoutMs(
  timeoutSec: number | null | undefined,
): number | undefined {
  if (
    typeof timeoutSec !== "number" ||
    !Number.isFinite(timeoutSec) ||
    timeoutSec <= 0
  ) {
    return undefined;
  }
  const milliseconds = Math.ceil(timeoutSec * 1_000);
  return Number.isSafeInteger(milliseconds) && milliseconds > 0
    ? milliseconds
    : undefined;
}

function acpxRuntimePhase(
  phase: "session_setup" | "configuration" | "prompt_activation" | "prompt_transmission" | "prompt",
): AcpPromptExecutionPhase {
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

function redactAcpxRuntimeError(
  cause: unknown,
  redact: (value: string) => string,
): Error {
  const raw = errorMessage(cause);
  try {
    const redacted = redact(raw);
    return new Error(
      typeof redacted === "string"
        ? redacted
        : "[ACPX runtime redaction failed]",
    );
  } catch {
    return new Error("[ACPX runtime redaction failed]");
  }
}

/**
 * Executes exactly one prompt through ACPX's public runtime. ACPX owns the
 * provider CLI process, session setup, configuration setters, prompt
 * invocation, cancellation, and cleanup; Paperclip retains only durable
 * activation and closure fences.
 */
export async function executeAcpxRuntimePrompt(
  input: AcpxRuntimePromptExecutionInput,
): Promise<AcpPromptExecutionResult> {
  let outcome: AcpPromptClosureOutcome;
  let teardownFailure: Error | null = null;
  try {
    const result = await executeAcpxOneShotPrompt({
      cwd: input.cwd,
      ...(input.registryCwd === undefined
        ? {}
        : { registryCwd: input.registryCwd }),
      agentName: input.agentName,
      start: input.request.start,
      message: input.request.message,
      configSelections: acpxRuntimeConfigSelections(input.configSelections),
      // Paperclip approval gates are settled before the run reaches this
      // worker. ACPX therefore receives the non-interactive execution policy,
      // rather than a provider-specific Paperclip permission shim.
      permissionMode: "approve-all",
      nonInteractivePermissions: "fail",
      mcpServers: input.mcpServers,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
      activatePrompt: input.activatePrompt,
      beginPromptTransmission: input.beginPromptTransmission,
      onSessionEvent: input.onSessionEvent,
    });
    if (!result.cleanup.stateRemoved || result.cleanup.errors.length > 0) {
      teardownFailure = new Error(
        "ACPX one-shot runtime cleanup did not complete",
      );
    }

    if (!result.cleanup.stateRemoved) {
      outcome = {
        kind: "error",
        failure: "runtime",
        phase: result.kind === "error"
          ? acpxRuntimePhase(result.phase)
          : "prompt",
        promptTransmitted:
          result.kind === "error"
            ? result.promptTransmitted
            : true,
        cause: new Error(
          "ACPX temporary runtime state could not be removed after the prompt",
        ),
      };
    } else if (result.kind === "completed" || result.kind === "cancelled") {
      if (!result.settlement) {
        outcome = {
          kind: "error",
          failure: "runtime",
          phase: "prompt",
          promptTransmitted: true,
          cause: new Error(
            "ACPX prompt ended without an exact terminal stop reason and usage occupancy",
          ),
        };
      } else {
        try {
          await input.validatePromptEvents?.();
          outcome = {
            kind: "settled",
            sessionId: result.sessionId,
            settlement: result.settlement,
            cancellationNotificationError: null,
          };
        } catch (cause) {
          await input.onProtocolViolation?.(
            redactAcpxRuntimeError(cause, input.redactStderr),
          );
          outcome = {
            kind: "error",
            failure: "runtime",
            phase: "prompt",
            promptTransmitted: true,
            cause: redactAcpxRuntimeError(cause, input.redactStderr),
          };
        }
      }
    } else if (result.kind === "failed") {
      outcome = {
        kind: "error",
        failure: "runtime",
        phase: "prompt",
        promptTransmitted: true,
        cause: redactAcpxRuntimeError(result.turnResult.error, input.redactStderr),
      };
    } else {
      outcome = {
        kind: "error",
        failure: "runtime",
        phase: acpxRuntimePhase(result.phase),
        promptTransmitted: result.promptTransmitted,
        cause: redactAcpxRuntimeError(result.cause, input.redactStderr),
      };
    }
  } catch (cause) {
    outcome = {
      kind: "error",
      failure: "runtime",
      phase: "session_setup",
      promptTransmitted: false,
      cause: redactAcpxRuntimeError(cause, input.redactStderr),
    };
  }

  try {
    await input.releasePreparedResources?.();
  } catch (cause) {
    const cleanupFailure = redactAcpxRuntimeError(cause, input.redactStderr);
    teardownFailure = cleanupFailure;
    const promptTransmitted =
      outcome.kind === "settled" ||
      (outcome.kind === "error" && outcome.promptTransmitted);
    outcome = {
      kind: "error",
      failure: "runtime",
      phase: promptTransmitted ? "prompt" : "session_setup",
      promptTransmitted,
      cause: cleanupFailure,
    };
  }

  let closureError: unknown | null = null;
  try {
    await input.closePrompt(outcome);
  } catch (cause) {
    closureError = cause;
  }
  return {
    ...outcome,
    closureError,
    // ACPX internally owns and closes its provider subprocess. Paperclip
    // intentionally retains no PID or ACPX runtime record to reap.
    teardown: teardownFailure
      ? { kind: "failed", cause: teardownFailure }
      : { kind: "not_started" },
    stderr: "",
  };
}

function verifyEchoChunk(input: {
  readonly event: Extract<
    NormalizedAcpSessionEvent,
    { kind: "user_message_echo" }
  >;
  readonly expected: string;
  readonly observed: string;
}): string {
  const content = input.event.content;
  if (content.type !== "text") {
    throw new IssueExecutionAttemptRejected(
      "ACP user-message echo contained a non-text block",
    );
  }
  const observed = input.observed + content.text;
  if (!input.expected.startsWith(observed)) {
    throw new IssueExecutionAttemptRejected(
      "ACP user-message echo differs from the exact request",
    );
  }
  return observed;
}

function requireCompleteEcho(observed: string, expected: string): void {
  if (observed.length > 0 && observed !== expected) {
    throw new IssueExecutionAttemptRejected(
      "ACP user-message echo ended before the exact request was verified",
    );
  }
}

function assertTargetMatchesPrompt(
  prompt: ResolvedIssueExecutionPrompt,
  target: AcquiredIssueExecutionTarget,
): void {
  if (
    target.adapterConfigRevisionId !== prompt.identity.adapterConfigRevisionId ||
    canonicalAcpConfiguration(target.acpConfiguration) !==
      canonicalAcpConfiguration(prompt.acpConfiguration) ||
    target.executionTarget.environmentId !==
      prompt.acpConfiguration.executionTargetSelector.defaultEnvironmentId ||
    target.hostCwd !== prompt.target.hostCwd ||
    !sameStringSequence(
      target.targetAdditionalDirectories,
      prompt.target.targetAdditionalDirectories,
    ) ||
    (target.executionTarget.kind === "local"
      ? target.targetCwd !== prompt.target.localWorkspaceCwd
      : target.targetCwd !== target.executionTarget.remoteCwd)
  ) {
    throw new IssueExecutionAttemptRejected(
      "acquired execution target differs from the immutable ACP revision",
    );
  }
}

export function createIssueExecutionAttemptExecutor(options: {
  readonly repository: IssueExecutionPromptCycleRepository;
  readonly targetAcquirer: IssueExecutionTargetAcquirer;
  readonly sessionCorrelations: Pick<
    NativeCorrelationService,
    "resolveStart" | "protectSession"
  >;
  readonly events: IssueExecutionAcpEventSink;
  readonly executePrompt?: ExecutePrompt;
  readonly prepareTarget?: PrepareTarget;
}): IssueExecutionAttemptExecutor {
  const executePrompt = options.executePrompt ?? executeAcpxRuntimePrompt;
  const prepareTarget = options.prepareTarget ?? prepareAcpxRuntimeInvocation;

  function collectionCandidate(
    _prompt: ResolvedIssueExecutionPrompt,
    _prepared: Awaited<ReturnType<PrepareTarget>> | null,
    _teardown: AcpPromptExecutionResult["teardown"],
  ): ReapedCompanySkillMaterialization | null {
    // ACPX's public local runtime has no generic isolated-skills-home or
    // additional-directory contract. Incompatible revisions are rejected at
    // admission; a successful ACPX invocation never creates a Paperclip skill
    // materialization to collect.
    return null;
  }

  async function runCycle(input: {
    readonly prompt: ResolvedIssueExecutionPrompt;
    readonly target: AcquiredIssueExecutionTarget;
    readonly start: { readonly kind: "new" } | {
      readonly kind: "resume";
      readonly sessionId: string;
    };
    readonly message: string;
    readonly signal: AbortSignal;
  }): Promise<{
    readonly result: AcpPromptExecutionResult;
    readonly decision: IssueExecutionPromptClosureDecision;
    readonly materialization: ReapedCompanySkillMaterialization | null;
  }> {
    const capability =
      await options.repository.mintPendingCapability(input.prompt);
    exactCapability(capability);
    const capabilityIdentity: IssueExecutionPromptCapabilityIdentity =
      Object.freeze({
        capabilityConnectionId: capability.capabilityConnectionId,
        capabilityGeneration: capability.capabilityGeneration,
      });
    let activatedSessionId: string | null = null;
    const redactRuntimeText = createRuntimeRedactor({
      targetRedactor: input.target.redactor.redactText,
      capability,
      resumeSessionId:
        input.start.kind === "resume" ? input.start.sessionId : null,
      activatedSessionId: () => activatedSessionId,
    });
    let prepared:
      | Awaited<ReturnType<PrepareTarget>>
      | null = null;
    let promptTransmissionRecorded = false;
    let preparedResourcesReleased = false;
    let decision: IssueExecutionPromptClosureDecision | null = null;
    let unexpectedClosureAttempted = false;
    let unexpectedClosureError: unknown | null = null;

    async function closeUnexpectedCapability(
      phase: AcpPromptExecutionPhase,
      promptTransmitted: boolean,
    ): Promise<void> {
      if (decision !== null || unexpectedClosureAttempted) return;
      unexpectedClosureAttempted = true;
      try {
        decision = await options.repository.closePrompt({
          prompt: input.prompt,
          capability: capabilityIdentity,
          outcome: {
            kind: "error",
            failure: "runtime",
            phase,
            promptTransmitted,
            message: `ACP execution failed during ${phase}`,
          },
        });
      } catch (error) {
        unexpectedClosureError = error;
      }
    }

    async function releasePreparedResources(): Promise<void> {
      if (!prepared || preparedResourcesReleased) return;
      preparedResourcesReleased = true;
      await prepared.disposeBeforeStart();
    }

    async function closeUnexpectedFailure(
      cause: unknown,
    ): Promise<{
      readonly result: AcpPromptExecutionResult;
      readonly decision: IssueExecutionPromptClosureDecision;
      readonly materialization: ReapedCompanySkillMaterialization | null;
    }> {
      // ACPX owns its subprocess, so the durable transmission fence is the
      // sole authority for whether an external prompt may have been sent.
      const promptTransmitted = promptTransmissionRecorded;
      const phase: AcpPromptExecutionPhase = promptTransmitted
        ? "prompt"
        : "session_setup";
      let cleanupError: unknown | null = null;
      try {
        await closeUnexpectedCapability(phase, promptTransmitted);
      } finally {
        try {
          await releasePreparedResources();
        } catch (error) {
          cleanupError = error;
        }
      }
      const result = failedExecutionResult({
        cause,
        phase,
        promptTransmitted,
        closureError: unexpectedClosureError,
        teardown: cleanupError === null
          ? { kind: "not_started" }
          : { kind: "failed", cause: cleanupError },
      });
      let teardownRecordError: unknown | null = null;
      try {
        await options.repository.recordSubprocessTeardown({
          prompt: input.prompt,
          capability: capabilityIdentity,
          observation: subprocessObservation(result, redactRuntimeText),
        });
      } catch (error) {
        teardownRecordError = error;
      }
      if (
        unexpectedClosureError !== null ||
        decision === null ||
        result.teardown.kind === "failed" ||
        teardownRecordError !== null
      ) {
        const failures: unknown[] = [
          cause,
          unexpectedClosureError,
          result.teardown.kind === "failed" ? result.teardown.cause : null,
          teardownRecordError,
        ].filter((failure) => failure !== null && failure !== undefined);
        throw new AggregateError(
          failures,
          "canonical prompt closure or subprocess teardown did not commit",
        );
      }
      return {
        result,
        decision,
        materialization: collectionCandidate(
          input.prompt,
          prepared,
          result.teardown,
        ),
      };
    }

    try {
      if (input.target.targetAdditionalDirectories.length > 0) {
        throw new IssueExecutionAttemptRejected(
          "ACPX public runtime does not support Paperclip-managed additional directories",
        );
      }
      prepared = await prepareTarget({
        target: input.target.executionTarget,
        targetCwd: input.target.targetCwd,
        companySkills: input.prompt.companySkills,
        invocationFiles: [
          {
            fileName: RUN_TOOLS_PROXY_FILE,
            contents: RUN_TOOLS_STDIO_PROXY_SOURCE,
          },
          {
            fileName: RUN_TOOLS_SECRET_FILE,
            contents: runToolsSecret(capability),
          },
        ],
      });
      const proxyEntrypoint =
        prepared.invocationFilePaths[RUN_TOOLS_PROXY_FILE];
      const secretFile =
        prepared.invocationFilePaths[RUN_TOOLS_SECRET_FILE];
      if (!proxyEntrypoint || !secretFile) {
        throw new IssueExecutionAttemptRejected(
          "execution target omitted request-scoped run-tools files",
        );
      }
      let echoedText = "";
      let result: AcpPromptExecutionResult;
      const timeoutMs = acpxRuntimeTimeoutMs(input.prompt.timeoutSec);
      try {
        result = await executePrompt({
          cwd: prepared.targetCwd,
          registryCwd: process.cwd(),
          agentName: input.prompt.acpConfiguration.launchProfile.registryName,
          configSelections:
            input.prompt.acpConfiguration.sessionConfigSelections,
          mcpServers: Object.freeze([
            createPaperclipRunToolsMcpServer({
              nodeExecutable: prepared.targetNodeExecutable,
              proxyEntrypoint,
              secretFile,
            }),
          ]),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
          request: {
            start: input.start,
            message: input.message,
          },
          signal: input.signal,
          redactStderr: redactRuntimeText,
          async activatePrompt({ sessionId }) {
            activatedSessionId = sessionId;
            const protectedCorrelation =
              await options.sessionCorrelations.protectSession({
                sessionId,
                scope: input.prompt.activationCorrelationScope,
              });
            await options.repository.activatePrompt({
              prompt: input.prompt,
              capability: capabilityIdentity,
              correlation: protectedCorrelation,
            });
          },
          beginPromptTransmission: () =>
            options.repository
              .beginPromptTransmission({
                prompt: input.prompt,
                capability: capabilityIdentity,
              })
              .then(() => {
                // ACPX owns the opaque provider process, so there is no
                // Paperclip child-PID fact. This fence is the authoritative
                // proof that a provider prompt may have been transmitted.
                promptTransmissionRecorded = true;
              }),
          releasePreparedResources,
          async closePrompt(outcome) {
            if (decision !== null) return;
            decision = await options.repository.closePrompt({
              prompt: input.prompt,
              capability: capabilityIdentity,
              outcome: canonicalClosure(
                outcome,
                input.prompt,
              ),
            });
            if (unexpectedClosureAttempted) {
              unexpectedClosureError = null;
            }
          },
          async onSessionEvent(event) {
            if (event.kind === "user_message_echo") {
              echoedText = verifyEchoChunk({
                event,
                expected: input.message,
                observed: echoedText,
              });
              return;
            }
            await options.events.publish({
              prompt: input.prompt.identity,
              capability: capabilityIdentity,
              redactor: input.target.redactor,
              event,
            });
          },
          async validatePromptEvents() {
            try {
              requireCompleteEcho(echoedText, input.message);
            } catch (error) {
              await options.repository.recordProtocolViolation({
                prompt: input.prompt,
                capability: capabilityIdentity,
                message: redactRuntimeText(errorMessage(error)),
              });
              throw error;
            }
          },
          onProtocolViolation: () =>
            options.repository.recordProtocolViolation({
              prompt: input.prompt,
              capability: capabilityIdentity,
              message: "ACP protocol violation",
            }),
        });
      } catch (cause) {
        return closeUnexpectedFailure(cause);
      }
      let teardownRecordError: unknown | null = null;
      try {
        await options.repository.recordSubprocessTeardown({
          prompt: input.prompt,
          capability: capabilityIdentity,
          observation: subprocessObservation(result, redactRuntimeText),
        });
      } catch (error) {
        teardownRecordError = error;
      }
      if (
        result.closureError !== null ||
        decision === null ||
        result.teardown.kind === "failed" ||
        teardownRecordError !== null
      ) {
        const failures: unknown[] = [
          result.kind === "error" ? result.cause : null,
          result.closureError,
          result.teardown.kind === "failed" ? result.teardown.cause : null,
          teardownRecordError,
          decision === null && result.closureError === null
            ? new IssueExecutionAttemptRejected(
                "canonical prompt closure returned no decision",
              )
            : null,
        ].filter((failure) => failure !== null && failure !== undefined);
        throw new AggregateError(
          failures,
          "canonical prompt closure or subprocess teardown did not commit",
        );
      }
      return {
        result,
        decision,
        materialization: collectionCandidate(
          input.prompt,
          prepared,
          result.teardown,
        ),
      };
    } catch (cause) {
      if (unexpectedClosureAttempted || decision !== null) throw cause;
      return closeUnexpectedFailure(cause);
    }
  }

  return {
    async execute(lease, signal, settle) {
      const prompt = await options.repository.resolve(lease);
      validateLeaseResolution(lease, prompt);
      validatePrompt(prompt);
      await options.repository.renewPromptAuthority(prompt);

      const executionController = new AbortController();
      const renewalStopController = new AbortController();
      const propagateCancellation = () => {
        if (!executionController.signal.aborted) {
          executionController.abort(signal.reason);
        }
      };
      if (signal.aborted) propagateCancellation();
      else signal.addEventListener("abort", propagateCancellation, { once: true });

      let renewalFailure: unknown;
      let renewalFailed = false;
      let renewalAuthorityLoss: IssueExecutionPromptAuthorityLost | null = null;
      let renewalStopped = false;
      const renewalLoop = (async () => {
        while (
          await waitForLeaseRenewalInterval(
            prompt.leaseRenewalIntervalMs,
            renewalStopController.signal,
          )
        ) {
          try {
            await options.repository.renewPromptAuthority(prompt);
          } catch (error) {
            renewalFailed = true;
            renewalFailure = error;
            if (error instanceof IssueExecutionPromptAuthorityLost) {
              renewalAuthorityLoss = error;
            }
            if (!executionController.signal.aborted) {
              executionController.abort(error);
            }
            return;
          }
        }
      })();

      const stopRenewal = async (renewForSettlement: boolean) => {
        if (!renewalStopped) {
          renewalStopped = true;
          renewalStopController.abort();
          await renewalLoop;
        }
        if (renewForSettlement) {
          try {
            await options.repository.renewPromptAuthority(prompt);
          } catch (error) {
            renewalFailed = true;
            renewalFailure = error;
            if (error instanceof IssueExecutionPromptAuthorityLost) {
              renewalAuthorityLoss = error;
            }
            throw error;
          }
          // A successfully closed prompt plus this fresh exact DB fence is the
          // canonical proof that a transient periodic-renewal failure did not
          // lose authority. The provider was still aborted immediately; only
          // its already-durable closure decision may now settle.
          renewalFailed = false;
          renewalFailure = undefined;
          renewalAuthorityLoss = null;
          return;
        }
        if (renewalFailed) throw renewalFailure;
      };

      let operationFailed = false;
      let operationFailure: unknown;
      let dispatchResult: IssueExecutionDispatchResult | null = null;
      try {
        const target = await options.targetAcquirer.acquire(prompt.target);
        assertTargetMatchesPrompt(prompt, target);
        let targetFailed = true;
        let targetReleased = false;
        const releaseTarget = async (): Promise<void> => {
          if (targetReleased) return;
          targetReleased = true;
          await target.release(targetFailed);
        };
        try {
          if (renewalFailed) throw renewalFailure;
          let start:
            | { readonly kind: "new" }
            | { readonly kind: "resume"; readonly sessionId: string };
          let message: string;
          if (prompt.sessionOperation === "new") {
            start = { kind: "new" };
            message = prompt.sourceText;
          } else {
            const resolvedStart = await options.sessionCorrelations.resolveStart({
              promptKind: prompt.identity.promptKind,
              carryContext: prompt.carryContext,
              stored: prompt.storedCorrelation,
            });
            if (resolvedStart.kind !== "resume") {
              throw new IssueExecutionAttemptRejected(
                "frozen ACP resume operation did not resolve one exact correlation",
              );
            }
            start = resolvedStart.start;
            message = prompt.sourceText;
          }
          if (renewalFailed) throw renewalFailure;

          const cycle = await runCycle({
            prompt,
            target,
            start,
            message,
            signal: executionController.signal,
          });
          if (
            cycle.decision.result.kind === "retry" &&
            cycle.decision.result.reason === "target_not_found_new_session"
          ) {
            throw new IssueExecutionAttemptRejected(
              "ACPX runtime never emits a target_not_found successor transition",
            );
          }
          const failed =
            (cycle.decision.result.kind === "terminal" &&
              cycle.decision.result.outcome === "failed") ||
            cycle.decision.result.kind === "retry";
          await stopRenewal(true);
          targetFailed = failed;
          // runCycle returns only after ACPX's public close boundary and the
          // disposable runtime-state cleanup. Paperclip owns no provider PID
          // or legacy process fact. Release the Paperclip-owned execution
          // target before terminal settlement can publish a durable handoff.
          await releaseTarget();
          await settle({
            result: cycle.decision.result,
            materialization: cycle.materialization,
          });
          dispatchResult = cycle.decision.result;
        } finally {
          await releaseTarget();
        }
      } catch (error) {
        operationFailed = true;
        operationFailure = error;
      } finally {
        await stopRenewal(false).catch((error) => {
          if (!renewalFailed) {
            renewalFailed = true;
            renewalFailure = error;
          }
        });
        signal.removeEventListener("abort", propagateCancellation);
      }
      const authorityLoss = renewalAuthorityLoss ??
        (operationFailed ? findPromptAuthorityLoss(operationFailure) : null);
      if (authorityLoss) {
        const failures = [operationFailed ? operationFailure : null, renewalFailure]
          .filter((failure, index, values) =>
            failure !== null &&
            failure !== undefined &&
            values.indexOf(failure) === index
          );
        const cause = failures.length > 1
          ? new AggregateError(
              failures,
              "prompt authority loss coincided with execution cleanup failure",
            )
          : failures[0] ?? authorityLoss.cause;
        throw new IssueExecutionPromptAuthorityLost(lease, cause);
      }
      if (renewalFailed) {
        if (operationFailed && operationFailure !== renewalFailure) {
          throw new AggregateError(
            [operationFailure, renewalFailure],
            "prompt renewal and execution cleanup both failed",
          );
        }
        throw renewalFailure;
      }
      if (operationFailed) throw operationFailure;
      if (dispatchResult === null) {
        throw new IssueExecutionAttemptRejected(
          "issue execution attempt returned no canonical dispatch result",
        );
      }
      return dispatchResult;
    },
  };
}
