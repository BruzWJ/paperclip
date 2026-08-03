import {
  ACP_SUBPROCESS_CONTRACT_VERSION,
  createPaperclipRunToolsMcpServer,
  executeAcpSubprocessPrompt,
  prepareAcpExecutionTargetSubprocess,
  resolveApprovedAcpLaunch,
  sameApprovedAcpLaunch,
  type AcpPromptClosureOutcome,
  type AcpPromptExecutionPhase,
  type AcpPromptExecutionResult,
  type AcpPromptSettlement,
  type AcpSubprocess,
  type AcpSubprocessLaunch,
  type NormalizedAcpSessionEvent,
} from "@paperclipai/adapter-utils/acp-subprocess";
import { RUN_TOOLS_STDIO_PROXY_SOURCE } from "@paperclipai/adapter-utils/run-tools-stdio-proxy";
import type { LocalProcessSandboxOptions } from "@paperclipai/adapter-utils/local-process-sandbox";
import {
  selectedCompanySkillMaterializationKey,
  type SelectedCompanySkillLaunchChannel,
} from "@paperclipai/adapter-utils/selected-company-skills";
import {
  agentAdapterAcpConfigurationSchema,
  type AgentAdapterAcpConfiguration,
  type IssueExecutionRef,
  type IssueExecutionSessionOperation,
} from "@paperclipai/shared";
import type {
  IssueExecutionAttemptCancellationSignal,
  IssueExecutionLaneSettlement,
  LeasedIssueExecutionConsultRun,
  LeasedIssueExecutionRef,
} from "./issue-execution-dispatcher.js";
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
import type {
  IssueExecutionSteeringResultBroker,
  IssueExecutionSteeringResultIdentity,
} from "./issue-execution-steering-results.js";

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
  /** Null is a typed local target_not_found, never an implicit new session. */
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
        | "target_not_found_recovery";
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

export interface IssueExecutionTargetNotFoundRecovery {
  /**
   * Persists the authorized true-carry recovery selection, runs compaction
   * only when that selection requires it, and returns the one complete text
   * block for the replacement session. It is never called for false carry.
   */
  prepareReplacementPrompt(
    prompt: ResolvedIssueExecutionPrompt,
  ): Promise<string>;
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

export interface IssueExecutionMentionInput {
  readonly companyId: string;
  readonly issueId: string;
  readonly sessionId: string;
  readonly ownershipEpoch: number;
  readonly consultExecutionId: string;
  readonly sourceRunId: string;
  readonly sourceRefId: string;
  readonly targetAgentId: string;
  readonly adapterConfigRevisionId: string;
  readonly chainToken: string;
  readonly ref: IssueExecutionRef;
}

export interface IssueExecutionMentionResult {
  readonly runId: string;
  readonly response: string;
}

export interface IssueExecutionConsultLeaseRepository {
  leasePersistedConsultRef(input: {
    readonly refId: string;
    readonly workerId: string;
  }): Promise<
    | { readonly kind: "queued" }
    | {
        readonly kind: "leased";
        readonly lease: LeasedIssueExecutionRef;
        readonly run: LeasedIssueExecutionConsultRun;
      }
  >;
  recoverConsultAfterAuthorityLoss(input: {
    readonly lease: LeasedIssueExecutionRef;
    readonly workerId: string;
  }): Promise<
    | { readonly kind: "not_recoverable" }
    | { readonly kind: "scheduled"; readonly retryAt: Date }
    | {
        readonly kind: "leased";
        readonly lease: LeasedIssueExecutionRef;
        readonly run: LeasedIssueExecutionConsultRun;
      }
    | {
        readonly kind: "terminal";
        readonly runId: string;
        readonly outcome: "succeeded" | "failed" | "cancelled";
        readonly reason: string | null;
        readonly finalText: string;
      }
  >;
  markRetryable(input: {
    readonly lease: LeasedIssueExecutionRef;
    readonly reason: Extract<IssueExecutionDispatchResult, { kind: "retry" }>["reason"];
    readonly retryAt: Date;
    readonly materialization: ReapedCompanySkillMaterialization | null;
  }): Promise<void>;
  markTerminal(input: {
    readonly lease: LeasedIssueExecutionRef;
    readonly outcome: Extract<IssueExecutionDispatchResult, { kind: "terminal" }>["outcome"];
    readonly reason: string | null;
    readonly finishedAt: Date;
    readonly materialization: ReapedCompanySkillMaterialization | null;
  }): Promise<IssueExecutionLaneSettlement>;
}

type IssueExecutionConsultLeaseAcquisition = Awaited<
  ReturnType<IssueExecutionConsultLeaseRepository["leasePersistedConsultRef"]>
>;

type IssueExecutionConsultAuthorityLossRecovery = Awaited<
  ReturnType<
    IssueExecutionConsultLeaseRepository["recoverConsultAfterAuthorityLoss"]
  >
>;

export interface IssueExecutionScopeCancellationSignal {
  readonly companyId: string;
  readonly issueId: string;
  readonly sessionId: string;
  readonly executionScopeId: string;
  readonly ownershipEpoch: number;
  readonly mode: "owner" | "consult";
  readonly authorityId: string | null;
  readonly consultExecutionId: string | null;
  readonly reason: string;
}

export class IssueExecutionAttemptRejected extends Error {
  readonly code = "issue_execution_attempt_rejected";

  constructor(message: string) {
    super(message);
    this.name = "IssueExecutionAttemptRejected";
  }
}

type ExecutePrompt = typeof executeAcpSubprocessPrompt;
type PrepareTarget = typeof prepareAcpExecutionTargetSubprocess;

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
    prompt.companySkills.channel !==
      prompt.acpConfiguration.skillChannel ||
    (prompt.companySkills.channel === "isolated_skills_home" &&
      (prompt.companySkills.identity.companyId !== identity.companyId ||
        prompt.companySkills.identity.agentId !== identity.targetAgentId ||
        prompt.companySkills.identity.adapterConfigRevisionId !==
          identity.adapterConfigRevisionId ||
        prompt.companySkills.identity.executionTargetIdentity !==
          prompt.acpConfiguration.executionTargetSelector
            .executionTargetDigest))
  ) {
    throw new IssueExecutionAttemptRejected(
      "selected company skill channel crossed the immutable ACP revision",
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
      !prompt.carryContext &&
      prompt.storedCorrelation === null) ||
    (operation === "resume" &&
      prompt.carryContext &&
      prompt.storedCorrelation?.scope.purpose === "carry") ||
    (operation === "recovery_new" &&
      prompt.carryContext &&
      prompt.storedCorrelation === null) ||
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

function exactLaunch(
  configuration: AgentAdapterAcpConfiguration,
): AcpSubprocessLaunch["launch"] {
  const approved = resolveApprovedAcpLaunch(
    configuration.launchProfile.registryName,
  );
  const configured = configuration.launchProfile;
  if (!sameApprovedAcpLaunch(configured, approved)) {
    throw new IssueExecutionAttemptRejected(
      "immutable ACP launch profile differs from the approved registry launch",
    );
  }
  return approved;
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
  if (
    outcome.settlement.occupancy.size !==
    prompt.acpConfiguration.model.limits.contextTokenLimit
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

function assertRecoveryText(
  prompt: ResolvedIssueExecutionPrompt,
  value: string,
): string {
  if (
    value.length === 0 ||
    !value.endsWith(prompt.sourceText)
  ) {
    throw new IssueExecutionAttemptRejected(
      "true-carry recovery did not preserve the exact source message suffix",
    );
  }
  return value;
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
  readonly recovery: IssueExecutionTargetNotFoundRecovery;
  readonly events: IssueExecutionAcpEventSink;
  readonly executePrompt?: ExecutePrompt;
  readonly prepareTarget?: PrepareTarget;
}): IssueExecutionAttemptExecutor {
  const executePrompt = options.executePrompt ?? executeAcpSubprocessPrompt;
  const prepareTarget =
    options.prepareTarget ?? prepareAcpExecutionTargetSubprocess;

  function collectionCandidate(
    prompt: ResolvedIssueExecutionPrompt,
    prepared: Awaited<ReturnType<PrepareTarget>> | null,
    teardown: AcpPromptExecutionResult["teardown"],
  ): ReapedCompanySkillMaterialization | null {
    const targetCollection =
      prepared?.selectedCompanySkillMaterialization ?? null;
    if (!targetCollection || teardown.kind === "failed") return null;
    if (prompt.companySkills.channel !== "isolated_skills_home") {
      throw new IssueExecutionAttemptRejected(
        "operator_native produced a selected-skill materialization",
      );
    }
    const expected = selectedCompanySkillMaterializationKey({
      identity: prompt.companySkills.identity,
      entries: prompt.companySkills.entries,
    });
    if (targetCollection.materializationKey !== expected.materializationKey) {
      throw new IssueExecutionAttemptRejected(
        "prepared selected-skill materialization crossed its complete key",
      );
    }
    return Object.freeze({
      identity: prompt.companySkills.identity,
      materializationKey: expected.materializationKey,
      collectExact: targetCollection.collectExact,
    });
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
    let startedSubprocess: AcpSubprocess | null = null;
    let subprocessLaunchAttempted = false;
    let subprocessFactRecorded = false;
    let retainedTeardown: AcpPromptExecutionResult["teardown"] | null = null;
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

    async function reapRetainedSubprocess(): Promise<
      AcpPromptExecutionResult["teardown"]
    > {
      if (retainedTeardown) return retainedTeardown;
      if (startedSubprocess) {
        const subprocess = startedSubprocess;
        startedSubprocess = null;
        try {
          retainedTeardown = {
            kind: "reaped",
            processExit: await subprocess.terminateAndReap(),
          };
        } catch (cause) {
          retainedTeardown = { kind: "failed", cause };
        }
        return retainedTeardown;
      }
      if (prepared && !subprocessLaunchAttempted) {
        try {
          await prepared.disposeBeforeStart();
        } catch (cause) {
          retainedTeardown = { kind: "failed", cause };
          return retainedTeardown;
        }
      }
      retainedTeardown = { kind: "not_started" };
      return retainedTeardown;
    }

    async function closeUnexpectedFailure(
      cause: unknown,
    ): Promise<{
      readonly result: AcpPromptExecutionResult;
      readonly decision: IssueExecutionPromptClosureDecision;
      readonly materialization: ReapedCompanySkillMaterialization | null;
    }> {
      // An unexpected throw after process start has unknown wire progress. Mark
      // it conservatively post-send so the DB owner cannot replay the prompt.
      const promptTransmitted = subprocessFactRecorded;
      const phase: AcpPromptExecutionPhase = promptTransmitted
        ? "prompt"
        : "spawn";
      try {
        await closeUnexpectedCapability(phase, promptTransmitted);
      } finally {
        await reapRetainedSubprocess();
      }
      const result = failedExecutionResult({
        cause,
        phase,
        promptTransmitted,
        closureError: unexpectedClosureError,
        teardown: retainedTeardown ?? { kind: "not_started" },
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
      const approvedLaunch = exactLaunch(input.prompt.acpConfiguration);
      prepared = await prepareTarget({
        runId: input.prompt.identity.runId,
        target: input.target.executionTarget,
        sourceLaunch: approvedLaunch,
        hostCwd: input.target.hostCwd,
        targetCwd: input.target.targetCwd,
        targetAdditionalDirectories:
          input.target.targetAdditionalDirectories,
        companySkills: input.prompt.companySkills,
        runtimeRootDir: input.prompt.runtimeRootDir,
        timeoutSec: input.prompt.timeoutSec,
        localProcessSandbox: input.prompt.localProcessSandbox,
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
      const launch: AcpSubprocessLaunch = {
        version: ACP_SUBPROCESS_CONTRACT_VERSION,
        launch: approvedLaunch,
        cwd: prepared.targetCwd,
        additionalDirectories: prepared.targetAdditionalDirectories,
        environment: Object.freeze({}),
        mcpServers: Object.freeze([
          createPaperclipRunToolsMcpServer({
            nodeExecutable: prepared.targetNodeExecutable,
            proxyEntrypoint,
            secretFile,
          }),
        ]),
        configOptions:
          input.prompt.acpConfiguration.sessionConfigSelections,
      };
      let echoedText = "";
      let result: AcpPromptExecutionResult;
      try {
        result = await executePrompt({
          launch,
          request: {
            start: input.start,
            message: input.message,
          },
          async startSubprocess(subprocessLaunch, subprocessOptions) {
            if (input.signal.aborted) {
              throw input.signal.reason ?? new IssueExecutionAttemptRejected(
                "ACP subprocess launch was cancelled before spawn",
              );
            }
            subprocessLaunchAttempted = true;
            const subprocess = await prepared!.startSubprocess(
              subprocessLaunch,
              subprocessOptions,
            );
            startedSubprocess = subprocess;
            try {
              const processId = subprocess.child.pid;
              if (!Number.isSafeInteger(processId) || Number(processId) < 1) {
                throw new IssueExecutionAttemptRejected(
                  "ACP subprocess did not expose a valid supervised process identity",
                );
              }
              await options.repository.recordSubprocessStarted({
                prompt: input.prompt,
                capability: capabilityIdentity,
                processId: Number(processId),
                processGroupId: Number(processId),
                supervisorLocator:
                  `paperclip-worker/${input.prompt.identity.attemptId}/${processId}`,
              });
              subprocessFactRecorded = true;
              return subprocess;
            } catch (cause) {
              try {
                await closeUnexpectedCapability("spawn", false);
              } finally {
                await reapRetainedSubprocess();
              }
              throw cause;
            }
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
            options.repository.beginPromptTransmission({
              prompt: input.prompt,
              capability: capabilityIdentity,
            }),
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
        if (unexpectedClosureError !== null && result.closureError !== null) {
          result = {
            ...result,
            closureError: new AggregateError(
              [unexpectedClosureError, result.closureError],
              "prompt capability closure failed before and after subprocess reap",
            ),
          };
        }
        if (retainedTeardown) {
          result = { ...result, teardown: retainedTeardown };
        }
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
      if (
        unexpectedClosureAttempted ||
        decision !== null ||
        startedSubprocess !== null
      ) throw cause;
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
        try {
          if (renewalFailed) throw renewalFailure;
          let start:
            | { readonly kind: "new" }
            | { readonly kind: "resume"; readonly sessionId: string };
          let message: string;
          if (
            prompt.sessionOperation === "new" ||
            prompt.sessionOperation === "recovery_new"
          ) {
            start = { kind: "new" };
            message =
              prompt.sessionOperation === "recovery_new" && prompt.carryContext
              ? assertRecoveryText(
                  prompt,
                  await options.recovery.prepareReplacementPrompt(prompt),
                )
              : prompt.sourceText;
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
          if (cycle.result.kind === "target_not_found") {
            if (
              start.kind !== "resume" ||
              (prompt.sessionOperation !== "resume" &&
                prompt.sessionOperation !== "steer_resume") ||
              cycle.decision.result.kind !== "retry" ||
              cycle.decision.result.reason !== "target_not_found_recovery"
            ) {
              throw new IssueExecutionAttemptRejected(
                "ACP target_not_found did not close as an exact successor-attempt transition",
              );
            }
            await stopRenewal(true);
            await settle({
              result: cycle.decision.result,
              materialization: cycle.materialization,
            });
            targetFailed = false;
            dispatchResult = cycle.decision.result;
          } else {
            if (
              cycle.decision.result.kind === "retry" &&
              cycle.decision.result.reason === "target_not_found_recovery"
            ) {
              throw new IssueExecutionAttemptRejected(
                "target_not_found recovery was requested without exact ACP target_not_found",
              );
            }
            const failed =
              (cycle.decision.result.kind === "terminal" &&
                cycle.decision.result.outcome === "failed") ||
              cycle.decision.result.kind === "retry";
            await stopRenewal(true);
            await settle({
              result: cycle.decision.result,
              materialization: cycle.materialization,
            });
            targetFailed = failed;
            dispatchResult = cycle.decision.result;
          }
        } finally {
          await target.release(targetFailed);
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

function mentionLeaseMatchesAttemptCancellation(
  lease: LeasedIssueExecutionRef,
  input: IssueExecutionAttemptCancellationSignal,
): boolean {
  if (
    input.attemptId === null ||
    input.attemptId !== lease.attemptId ||
    input.runId !== lease.runId ||
    input.companyId !== lease.ref.companyId ||
    input.issueId !== lease.ref.issueId ||
    input.sessionId !== lease.ref.sessionId ||
    input.executionScopeId !== lease.ref.executionScopeId
  ) {
    return false;
  }
  return lease.batch.some(
    (member) =>
      member.ref.id === input.refId &&
      member.leaseGeneration === input.leaseGeneration,
  );
}

function assertMentionLease(
  input: IssueExecutionMentionInput,
  lease: LeasedIssueExecutionRef,
): void {
  if (
    lease.ref.id !== input.ref.id ||
    lease.ref.companyId !== input.companyId ||
    lease.ref.issueId !== input.issueId ||
    lease.ref.sessionId !== input.sessionId ||
    lease.ref.ownershipEpoch !== input.ownershipEpoch ||
    lease.ref.previousOwnershipEpoch !== input.ref.previousOwnershipEpoch ||
    lease.ref.executionScopeId !== input.ref.executionScopeId ||
    lease.ref.executionLineageId !== input.ref.executionLineageId ||
    lease.ref.mode !== "consult" ||
    lease.ref.sourceKind !== input.ref.sourceKind ||
    lease.ref.sourceId !== input.ref.sourceId ||
    lease.ref.sourceRecordId !== input.ref.sourceRecordId ||
    lease.ref.messageKind !== input.ref.messageKind ||
    lease.ref.messageId !== input.ref.messageId ||
    lease.ref.exactMessage !== input.ref.exactMessage ||
    lease.ref.deliveryIdempotencyKey !== input.ref.deliveryIdempotencyKey ||
    lease.ref.disposition !== "active" ||
    lease.ref.consultExecutionId !== input.consultExecutionId ||
    lease.ref.consultCallerRefId !== input.sourceRefId ||
    lease.ref.targetAgentId !== input.targetAgentId ||
    lease.ref.laneOrdinal !== input.ref.laneOrdinal ||
    lease.ref.issueExecutionAuthorityId !== null ||
    lease.ref.adapterConfigRevisionId !== input.adapterConfigRevisionId ||
    lease.ref.contextEpoch !== input.ref.contextEpoch ||
    lease.ref.historyViewId !== input.ref.historyViewId ||
    lease.ref.admissionHighWaterSeq !== input.ref.admissionHighWaterSeq ||
    lease.ref.inputId !== input.ref.inputId ||
    lease.ref.admittedSeq !== input.ref.admittedSeq ||
    lease.ref.promotedSeq !== input.ref.promotedSeq ||
    lease.ref.counterpartIssueId !== input.ref.counterpartIssueId ||
    lease.ref.counterpartAuthorityId !== input.ref.counterpartAuthorityId ||
    lease.ref.counterpartOwnershipEpoch !==
      input.ref.counterpartOwnershipEpoch ||
    lease.ref.consultChainToken !== input.chainToken ||
    !lease.runId ||
    !lease.attemptId ||
    !lease.leaseId ||
    lease.leaseGeneration < 1 ||
    lease.attemptNumber < 1
  ) {
    throw new IssueExecutionAttemptRejected(
      "Consult repository leased a different canonical mention",
    );
  }
}

function authorityLossMatchesLease(
  loss: IssueExecutionPromptAuthorityLost,
  lease: LeasedIssueExecutionRef,
): boolean {
  return loss.lease.companyId === lease.companyId &&
    loss.lease.issueId === lease.issueId &&
    loss.lease.runId === lease.runId &&
    loss.lease.attemptId === lease.attemptId &&
    loss.lease.leaseId === lease.leaseId &&
    loss.lease.leaseGeneration === lease.leaseGeneration;
}

function consultMembership(lease: LeasedIssueExecutionRef): readonly string[] {
  const members = lease.batch;
  if (
    members.length === 0 ||
    members[0]?.ref.id !== lease.ref.id ||
    members.some(
      (member) =>
        member.leaseGeneration !== lease.leaseGeneration ||
        member.attemptNumber !== lease.attemptNumber,
    )
  ) {
    throw new IssueExecutionAttemptRejected(
      "Consult lease lost its first canonical run member",
    );
  }
  return Object.freeze(members.map(({ ref }) => ref.id));
}

function sameMembership(
  prior: readonly string[],
  next: readonly string[],
): boolean {
  return prior.length === next.length &&
    prior.every((refId, index) => next[index] === refId);
}

function sameConsultRunScope(
  prior: LeasedIssueExecutionConsultRun,
  next: LeasedIssueExecutionConsultRun,
): boolean {
  return prior.companyId === next.companyId &&
    prior.issueId === next.issueId &&
    prior.sessionId === next.sessionId &&
    prior.executionScopeId === next.executionScopeId &&
    prior.kind === "consult" &&
    next.kind === "consult" &&
    prior.ownershipEpoch === next.ownershipEpoch &&
    prior.targetAgentId === next.targetAgentId &&
    prior.adapterConfigRevisionId === next.adapterConfigRevisionId &&
    prior.executionWorkspaceBindingId === next.executionWorkspaceBindingId &&
    prior.executionMode === "consult" &&
    next.executionMode === "consult" &&
    prior.issueExecutionAuthorityId === null &&
    next.issueExecutionAuthorityId === null &&
    prior.consultExecutionId === next.consultExecutionId &&
    prior.parentRunId === next.parentRunId;
}

function assertConsultRunBinding(
  input: IssueExecutionMentionInput,
  lease: LeasedIssueExecutionRef,
  run: LeasedIssueExecutionConsultRun,
): void {
  if (
    run.runId !== lease.runId ||
    run.companyId !== input.companyId ||
    run.issueId !== input.issueId ||
    run.sessionId !== input.sessionId ||
    run.executionScopeId !== input.ref.executionScopeId ||
    run.kind !== "consult" ||
    run.ownershipEpoch !== input.ownershipEpoch ||
    run.targetAgentId !== input.targetAgentId ||
    run.adapterConfigRevisionId !== input.adapterConfigRevisionId ||
    run.executionMode !== "consult" ||
    run.issueExecutionAuthorityId !== null ||
    run.consultExecutionId !== input.consultExecutionId ||
    run.parentRunId !== input.sourceRunId ||
    run.currentAttemptId !== lease.attemptId ||
    run.currentLeaseId !== lease.leaseId
  ) {
    throw new IssueExecutionAttemptRejected(
      "Consult lease crossed its canonical run projection",
    );
  }
}

function waitForMentionRetry(
  retryAt: Date,
  signal: AbortSignal,
): Promise<void> {
  if (Number.isNaN(retryAt.getTime())) {
    throw new IssueExecutionAttemptRejected(
      "Consult retry time is invalid",
    );
  }
  if (signal.aborted) {
    throw new IssueExecutionAttemptRejected(
      "Synchronous consult was cancelled",
    );
  }
  const delay = Math.max(0, retryAt.getTime() - Date.now());
  if (delay === 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delay);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(
        new IssueExecutionAttemptRejected(
          "Synchronous consult was cancelled",
        ),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Executes a no-selector mention synchronously while retaining the same
 * durable consult ref across retries. Cancellation is fenced either to the
 * exact active attempt or to the exact consult execution scope; no Session-
 * wide or target-agent-wide interrupt is exposed.
 */
export function createIssueExecutionMentionExecutor(options: {
  readonly workerId: string;
  readonly repository: IssueExecutionConsultLeaseRepository;
  readonly executor: IssueExecutionAttemptExecutor;
  readonly steeringResults: Pick<IssueExecutionSteeringResultBroker, "publish">;
  readonly notifyReleasedConsultRef: (refId: string) => Promise<void>;
  readonly now?: () => Date;
}) {
  if (!options.workerId) {
    throw new IssueExecutionAttemptRejected(
      "Mention executor worker identity is required",
    );
  }
  const now = options.now ?? (() => new Date());
  const active = new Set<{
    readonly input: IssueExecutionMentionInput;
    controller: AbortController | null;
    lease: LeasedIssueExecutionRef | null;
    runId: string | null;
    refOrdinal: number | null;
    segmentOrdinal: number | null;
    operation: Promise<IssueExecutionMentionResult> | null;
    stopped: boolean;
    steeringCancellationRequested: boolean;
    steeringResumeReady: boolean;
    steeringResumeWaiter: (() => void) | null;
  }>();
  let shuttingDown = false;

  return {
    async executeMention(
      input: IssueExecutionMentionInput,
    ): Promise<IssueExecutionMentionResult> {
      if (shuttingDown) {
        throw new IssueExecutionAttemptRejected(
          "Mention executor is shutting down",
        );
      }
      if (
        input.ref.mode !== "consult" ||
        input.ref.id.length === 0 ||
        input.ref.companyId !== input.companyId ||
        input.ref.issueId !== input.issueId ||
        input.ref.sessionId !== input.sessionId ||
        input.ref.ownershipEpoch !== input.ownershipEpoch ||
        input.ref.consultExecutionId !== input.consultExecutionId ||
        input.ref.consultCallerRefId !== input.sourceRefId ||
        input.ref.targetAgentId !== input.targetAgentId ||
        input.ref.adapterConfigRevisionId !== input.adapterConfigRevisionId ||
        input.ref.consultChainToken !== input.chainToken
      ) {
        throw new IssueExecutionAttemptRejected(
          "Mention input does not match its canonical consult ref",
        );
      }
      const state = {
        input,
        controller: null as AbortController | null,
        lease: null as LeasedIssueExecutionRef | null,
        runId: null as string | null,
        continuityRun: null as LeasedIssueExecutionConsultRun | null,
        continuityLease: null as LeasedIssueExecutionRef | null,
        refOrdinal: null as number | null,
        segmentOrdinal: null as number | null,
        operation: null as Promise<IssueExecutionMentionResult> | null,
        stopped: false,
        steeringCancellationRequested: false,
        steeringResumeReady: false,
        steeringResumeWaiter: null as (() => void) | null,
      };
      const operation = (async () => {
        let recoveredLease:
          | {
              readonly kind: "leased";
              readonly lease: LeasedIssueExecutionRef;
              readonly run: LeasedIssueExecutionConsultRun;
            }
          | null = null;
        while (!state.stopped) {
          const controller = new AbortController();
          state.controller = controller;
          const acquisition: IssueExecutionConsultLeaseAcquisition =
            recoveredLease ??
            (await options.repository.leasePersistedConsultRef({
              refId: input.ref.id,
              workerId: options.workerId,
            }));
          recoveredLease = null;
          if (acquisition.kind === "queued") {
            await waitForMentionRetry(
              new Date(now().getTime() + 25),
              controller.signal,
            );
            continue;
          }
          const leased: Extract<
            IssueExecutionConsultLeaseAcquisition,
            { readonly kind: "leased" }
          > = acquisition;
          assertMentionLease(input, leased.lease);
          assertConsultRunBinding(input, leased.lease, leased.run);
          const nextMembership = consultMembership(leased.lease);
          if (state.continuityRun === null || state.continuityLease === null) {
            if (leased.run.retryOfRunId !== null) {
              throw new IssueExecutionAttemptRejected(
                "Initial consult lease unexpectedly entered a retry lineage",
              );
            }
          } else if (state.continuityRun.runId === leased.run.runId) {
            if (
              !sameConsultRunScope(state.continuityRun, leased.run) ||
              state.continuityRun.retryOfRunId !== leased.run.retryOfRunId ||
              !sameMembership(
                consultMembership(state.continuityLease),
                nextMembership,
              ) ||
              state.refOrdinal !== leased.lease.refOrdinal ||
              state.segmentOrdinal === null ||
              leased.lease.segmentOrdinal < state.segmentOrdinal ||
              leased.lease.segmentOrdinal > state.segmentOrdinal + 1
            ) {
              throw new IssueExecutionAttemptRejected(
                "Consult continuation crossed its canonical run member",
              );
            }
          } else if (
            leased.run.retryOfRunId !== state.continuityRun.runId ||
            !sameConsultRunScope(state.continuityRun, leased.run) ||
            !sameMembership(
              consultMembership(state.continuityLease),
              nextMembership,
            ) ||
            leased.lease.refOrdinal !== 0 ||
            leased.lease.segmentOrdinal !== 0 ||
            leased.lease.promptKind !== state.continuityLease.promptKind ||
            leased.lease.sessionOperation !==
              state.continuityLease.sessionOperation
          ) {
            throw new IssueExecutionAttemptRejected(
              "Consult continuation crossed its exact retry lineage",
            );
          }
          state.runId = leased.run.runId;
          state.continuityRun = leased.run;
          state.continuityLease = leased.lease;
          state.refOrdinal = leased.lease.refOrdinal;
          state.segmentOrdinal = leased.lease.segmentOrdinal;
          state.lease = leased.lease;
          let releasedConsultRefId: string | null = null;
          let result: IssueExecutionDispatchResult | undefined;
          let executionError: unknown;
          let executionFailed = false;
          try {
            result = await options.executor.execute(
              {
                companyId: leased.lease.ref.companyId,
                issueId: leased.lease.ref.issueId,
                runId: leased.lease.runId,
                attemptId: leased.lease.attemptId,
                leaseId: leased.lease.leaseId,
                leaseGeneration: leased.lease.leaseGeneration,
              },
              controller.signal,
              async ({ result: settled, materialization }) => {
                if (settled.kind === "retry") {
                  await options.repository.markRetryable({
                    lease: leased.lease,
                    reason: settled.reason,
                    retryAt: settled.retryAt,
                    materialization,
                  });
                  return;
                }
                const settlement =
                  await options.repository.markTerminal({
                    lease: leased.lease,
                    outcome: settled.outcome,
                    reason: settled.reason,
                    finishedAt: now(),
                    materialization,
                  });
                if (settlement.laneReleased) {
                  releasedConsultRefId = leased.lease.ref.id;
                }
              },
            );
          } catch (error) {
            executionFailed = true;
            executionError = error;
          }
          if (releasedConsultRefId !== null) {
            try {
              await options.notifyReleasedConsultRef(
                releasedConsultRefId,
              );
            } catch (notificationError) {
              if (!executionFailed) throw notificationError;
            }
          }
          if (executionFailed) {
            if (
              !(executionError instanceof IssueExecutionPromptAuthorityLost) ||
              !authorityLossMatchesLease(executionError, leased.lease) ||
              state.stopped ||
              state.steeringCancellationRequested
            ) {
              throw executionError;
            }
            let recovery: IssueExecutionConsultAuthorityLossRecovery;
            const recoverExact = async (): Promise<IssueExecutionConsultAuthorityLossRecovery> => {
              try {
                return await options.repository.recoverConsultAfterAuthorityLoss({
                  lease: leased.lease,
                  workerId: options.workerId,
                });
              } catch (recoveryError) {
                throw new AggregateError(
                  [executionError, recoveryError],
                  "exact consult authority-loss recovery failed",
                );
              }
            };
            recovery = await recoverExact();
            if (recovery.kind === "scheduled") {
              await waitForMentionRetry(recovery.retryAt, controller.signal);
              recovery = await recoverExact();
              if (recovery.kind === "scheduled") {
                throw new IssueExecutionAttemptRejected(
                  "Exact consult authority-loss recovery remained scheduled after its durable due time",
                );
              }
            }
            if (recovery.kind === "not_recoverable") {
              throw executionError;
            }
            state.lease = null;
            state.controller = null;
            if (recovery.kind === "leased") {
              recoveredLease = recovery;
              continue;
            }
            if (recovery.runId !== leased.run.runId) {
              throw new IssueExecutionAttemptRejected(
                "Consult terminal recovery crossed its canonical run",
              );
            }
            await options.notifyReleasedConsultRef(leased.lease.ref.id);
            if (leased.lease.promptKind === "steering") {
              options.steeringResults.publish({
                companyId: leased.lease.companyId,
                issueId: leased.lease.issueId,
                runId: recovery.runId,
                refId: leased.lease.ref.id,
                refOrdinal: leased.lease.refOrdinal,
                segmentOrdinal: leased.lease.segmentOrdinal,
                outcome: recovery.outcome,
                response: recovery.finalText,
                reason: recovery.reason,
              });
            }
            if (recovery.outcome !== "succeeded") {
              throw new IssueExecutionAttemptRejected(
                recovery.reason ??
                  `Synchronous consult ended with ${recovery.outcome}`,
              );
            }
            return {
              runId: recovery.runId,
              response: recovery.finalText,
            };
          }
          if (!result) {
            throw new IssueExecutionAttemptRejected(
              "Consult execution returned no settlement result",
            );
          }
          if (
            leased.lease.promptKind === "steering" &&
            result.kind === "terminal"
          ) {
            options.steeringResults.publish({
              companyId: leased.lease.companyId,
              issueId: leased.lease.issueId,
              runId: leased.lease.runId,
              refId: leased.lease.ref.id,
              refOrdinal: leased.lease.refOrdinal,
              segmentOrdinal: leased.lease.segmentOrdinal,
              outcome: result.outcome,
              response: result.finalText ?? "",
              reason: result.reason,
            });
          }
          if (result.kind === "retry") {
            state.lease = null;
            await waitForMentionRetry(
              result.retryAt,
              controller.signal,
            );
            continue;
          }
          state.lease = null;
          state.controller = null;
          if (
            result.outcome === "cancelled" &&
            state.steeringCancellationRequested &&
            !state.stopped
          ) {
            if (!state.steeringResumeReady) {
              await new Promise<void>((resolve) => {
                state.steeringResumeWaiter = resolve;
              });
            }
            state.steeringResumeWaiter = null;
            if (state.stopped) break;
            state.steeringResumeReady = false;
            state.steeringCancellationRequested = false;
            continue;
          }
          if (result.outcome !== "succeeded") {
            throw new IssueExecutionAttemptRejected(
              result.reason ??
                `Synchronous consult ended with ${result.outcome}`,
            );
          }
          return {
            runId: leased.run.runId,
            response: result.finalText ?? "",
          };
        }
        throw new IssueExecutionAttemptRejected(
          "Synchronous consult was cancelled",
        );
      })();
      state.operation = operation;
      active.add(state);
      try {
        return await operation;
      } finally {
        state.stopped = true;
        state.controller = null;
        state.steeringResumeWaiter?.();
        active.delete(state);
      }
    },

    signalAttemptCancellation(
      input: IssueExecutionAttemptCancellationSignal,
    ): boolean {
      for (const state of active) {
        if (
          state.lease &&
          mentionLeaseMatchesAttemptCancellation(state.lease, input)
        ) {
          state.steeringCancellationRequested = true;
          state.controller?.abort("issue_execution_attempt_cancelled");
          return true;
        }
      }
      return false;
    },

    notifySteeringResumed(
      input: IssueExecutionSteeringResultIdentity,
    ): boolean {
      for (const state of active) {
        if (
          !state.steeringCancellationRequested ||
          state.input.companyId !== input.companyId ||
          state.input.issueId !== input.issueId ||
          state.input.ref.id !== input.refId ||
          state.runId !== input.runId ||
          state.refOrdinal !== input.refOrdinal ||
          state.segmentOrdinal === null ||
          input.segmentOrdinal !== state.segmentOrdinal + 1
        ) {
          continue;
        }
        state.steeringResumeReady = true;
        state.steeringResumeWaiter?.();
        return true;
      }
      return false;
    },

    signalExecutionScopeCancellation(
      input: IssueExecutionScopeCancellationSignal,
    ): boolean {
      if (
        input.mode !== "consult" ||
        input.authorityId !== null ||
        input.consultExecutionId === null
      ) {
        return false;
      }
      for (const state of active) {
        const ref = state.input.ref;
        if (
          state.input.companyId === input.companyId &&
          state.input.issueId === input.issueId &&
          state.input.sessionId === input.sessionId &&
          state.input.ownershipEpoch === input.ownershipEpoch &&
          state.input.consultExecutionId === input.consultExecutionId &&
          ref.executionScopeId === input.executionScopeId
        ) {
          state.stopped = true;
          state.controller?.abort(input.reason);
          state.steeringResumeWaiter?.();
          return true;
        }
      }
      return false;
    },

    async shutdown(): Promise<void> {
      shuttingDown = true;
      for (const state of active) {
        state.stopped = true;
        state.controller?.abort("paperclip_worker_shutdown");
        state.steeringResumeWaiter?.();
      }
      await Promise.allSettled(
        [...active]
          .map((state) => state.operation)
          .filter(
            (operation): operation is Promise<IssueExecutionMentionResult> =>
              operation !== null,
          ),
      );
    },
  };
}

export type IssueExecutionMentionExecutor = ReturnType<
  typeof createIssueExecutionMentionExecutor
>;
