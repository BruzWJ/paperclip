import {
  createPaperclipRunToolsMcpServer,
  executeAcpxOneShotPrompt,
  prepareAcpxRuntimeInvocation,
  type AcpPromptSettlement,
  type AcpxOneShotPromptResult,
  type NormalizedAcpSessionEvent,
} from "@paperclipai/adapter-utils/acpx-runtime";
import { RUN_TOOLS_STDIO_PROXY_SOURCE } from "@paperclipai/adapter-utils/run-tools-stdio-proxy";
import {
  AGENT_CONTEXT_GRANT_KEYS,
  agentAdapterAcpConfigurationSchema,
  type AgentAdapterAcpConfiguration,
  type TaskExecutionSessionOperation,
} from "@paperclipai/shared";
import type {
  AcpCorrelationScope,
  NativeCorrelationService,
  ProtectedAcpSessionCorrelation,
  StoredAcpSessionCorrelation,
} from "./native-correlation.js";
import type {
  AcquiredTaskExecutionTarget,
  TaskExecutionRuntimeRedactor,
  TaskExecutionTargetAcquirer,
  TaskExecutionTargetAcquisitionInput,
} from "./task-execution-provider-configuration.js";
import type { ContextDial } from "./context-dial-resolver.js";
import type { PluginBeforePromptDispatcher } from "./plugin-before-prompt-dispatcher.js";
import { localExecutionCorrelationFingerprint } from "./local-execution-correlation.js";
import type { RuntimeToolTurn } from "./runtime-interface-compiler.js";
import { logger } from "../middleware/logger.js";

const RUN_TOOLS_PROXY_FILE = "run-tools-proxy.mjs";
const RUN_TOOLS_SECRET_FILE = "run-tools.json";
const ACPX_TURN_TIMEOUT_MS = 15 * 60_000;

export interface TaskExecutionAttemptLease {
  readonly companyId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly leaseId: string;
  readonly leaseGeneration: number;
}

export class TaskExecutionPromptAuthorityLost extends Error {
  readonly code = "task_execution_prompt_authority_lost";
  readonly lease: TaskExecutionAttemptLease;
  override readonly cause: unknown;

  constructor(lease: TaskExecutionAttemptLease, cause: unknown) {
    super(`Task-execution prompt authority was lost: ${errorMessage(cause)}`);
    this.name = "TaskExecutionPromptAuthorityLost";
    this.lease = Object.freeze({ ...lease });
    this.cause = cause;
  }
}

export interface TaskExecutionPromptIdentity
  extends TaskExecutionAttemptLease {
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
  readonly taskExecutionAuthorityId: string | null;
  readonly consultExecutionId: string | null;
  readonly adapterConfigRevisionId: string;
  readonly executionWorkspaceBindingId: string;
}

export interface ResolvedTaskExecutionPrompt {
  readonly identity: TaskExecutionPromptIdentity;
  /** Compiler-owned structural role of this exact queued turn. */
  readonly turn: RuntimeToolTurn;
  /** Immutable operation frozen on this exact attempt generation. */
  readonly sessionOperation: TaskExecutionSessionOperation;
  /** Exact canonical Session message supplying this provider prompt. */
  readonly sourceMessageId: string;
  /** Global Session sequence of `sourceMessageId`; also the plugin snapshot cutoff. */
  readonly sourceMessageSeq: number;
  readonly sourceText: string;
  /** Exact effective context-access matrix compiled for this prompt. */
  readonly contextAccess: ContextDial;
  readonly carryContext: boolean;
  /** Null only for a frozen new operation; every resume pins one exact target. */
  readonly storedCorrelation: StoredAcpSessionCorrelation | null;
  /** Exact prior bootstrap prompt authorizing a cross-run base resume. */
  readonly bootstrapPredecessor: {
    readonly runId: string;
    readonly refId: string;
    readonly refOrdinal: number;
  } | null;
  /** Exact next append-only generation installed at prompt activation. */
  readonly activationCorrelationScope: AcpCorrelationScope;
  readonly effectiveContextExposureDigest: string;
  /** Current exposure with carry_context normalized true for source checks. */
  readonly carrySourceExposureDigest: string;
  readonly effectiveToolsDigest: string;
  readonly acpConfiguration: AgentAdapterAcpConfiguration;
  readonly target: TaskExecutionTargetAcquisitionInput;
  /** Exact cadence for renewing this attempt's canonical lease authority. */
  readonly leaseRenewalIntervalMs: number;
}

export interface TaskExecutionPromptCapabilityIdentity {
  readonly capabilityConnectionId: string;
  readonly capabilityGeneration: number;
}

export interface MintedTaskExecutionPromptCapability
  extends TaskExecutionPromptCapabilityIdentity {
  readonly endpoint: string;
  readonly bearer: string;
}

export type TaskExecutionDispatchResult =
  | {
      readonly kind: "retry";
      readonly reason: "transport_transient";
      readonly retryAt: Date;
    }
  | {
      readonly kind: "terminal";
      readonly outcome: "succeeded" | "failed" | "cancelled";
      readonly reason: string | null;
      readonly finalText?: string | null;
    };

export type TaskExecutionPromptPhase =
  | "session_setup"
  | "prompt_activation"
  | "prompt_transmission"
  | "prompt";

export type TaskExecutionPromptClosure =
  | {
      readonly kind: "settled";
      readonly settlement: AcpPromptSettlement;
    }
  | {
      readonly kind: "cancelled";
      readonly settlement: AcpPromptSettlement | null;
    }
  | {
      readonly kind: "error";
      readonly failure: "runtime";
      readonly phase: TaskExecutionPromptPhase;
      readonly promptTransmitted: boolean;
      readonly message: string;
    };

export type TaskExecutionPromptClosureDecision =
  {
    readonly kind: "dispatch";
    readonly result: TaskExecutionDispatchResult;
  };

/**
 * Narrow canonical DB transition boundary. Implementations lock and recheck
 * run/ref/segment, attempt, lease, epoch, authority, revision, workspace,
 * correlation, and capability generation in every mutating operation.
 */
export interface TaskExecutionPromptCycleRepository {
  resolve(
    lease: TaskExecutionAttemptLease,
  ): Promise<ResolvedTaskExecutionPrompt>;
  renewPromptAuthority(prompt: ResolvedTaskExecutionPrompt): Promise<void>;
  mintPendingCapability(
    prompt: ResolvedTaskExecutionPrompt,
  ): Promise<MintedTaskExecutionPromptCapability>;
  activatePrompt(input: {
    readonly prompt: ResolvedTaskExecutionPrompt;
    readonly capability: TaskExecutionPromptCapabilityIdentity;
    readonly correlation: ProtectedAcpSessionCorrelation;
  }): Promise<void>;
  beginPromptTransmission(input: {
    readonly prompt: ResolvedTaskExecutionPrompt;
    readonly capability: TaskExecutionPromptCapabilityIdentity;
  }): Promise<void>;
  closePrompt(input: {
    readonly prompt: ResolvedTaskExecutionPrompt;
    readonly capability: TaskExecutionPromptCapabilityIdentity;
    readonly outcome: TaskExecutionPromptClosure;
  }): Promise<TaskExecutionPromptClosureDecision>;
}

export interface TaskExecutionAcpEventSink {
  /** Validate and publication-redact before any durable or live projection. */
  publish(input: {
    readonly prompt: TaskExecutionPromptIdentity;
    readonly capability: TaskExecutionPromptCapabilityIdentity;
    readonly redactor: TaskExecutionRuntimeRedactor;
    readonly event: NormalizedAcpSessionEvent;
  }): Promise<void>;
}

export interface TaskExecutionAttemptExecutor {
  execute(
    lease: TaskExecutionAttemptLease,
    signal: AbortSignal,
    settle: TaskExecutionAttemptSettlement,
  ): Promise<TaskExecutionDispatchResult>;
}

export type TaskExecutionAttemptSettlement = (
  result: TaskExecutionDispatchResult,
) => Promise<void>;

export class TaskExecutionAttemptRejected extends Error {
  readonly code = "task_execution_attempt_rejected";

  constructor(message: string) {
    super(message);
    this.name = "TaskExecutionAttemptRejected";
  }
}

function exactIdentity(value: string, label: string): void {
  if (value.length === 0 || value !== value.trim()) {
    throw new TaskExecutionAttemptRejected(
      `${label} must be exact and non-empty`,
    );
  }
}

function exactDigest(value: string, label: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new TaskExecutionAttemptRejected(`${label} is not a SHA-256 digest`);
  }
}

function canonicalAcpConfiguration(
  value: AgentAdapterAcpConfiguration,
): string {
  try {
    return JSON.stringify(agentAdapterAcpConfigurationSchema.parse(value));
  } catch {
    throw new TaskExecutionAttemptRejected(
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
    left.taskId !== right.taskId ||
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

function validatePrompt(prompt: ResolvedTaskExecutionPrompt): void {
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
    (prompt.turn !== "bootstrap" && prompt.turn !== "work") ||
    !Number.isSafeInteger(prompt.sourceMessageSeq) ||
    prompt.sourceMessageSeq < 0 ||
    AGENT_CONTEXT_GRANT_KEYS.some(
      (key) => typeof prompt.contextAccess[key] !== "boolean",
    ) ||
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
      ? !identity.taskExecutionAuthorityId || identity.consultExecutionId !== null
      : identity.taskExecutionAuthorityId !== null || !identity.consultExecutionId)
  ) {
    throw new TaskExecutionAttemptRejected(
      "resolved ACP prompt has an invalid canonical identity",
    );
  }
  const scope = prompt.activationCorrelationScope;
  if (
    scope.companyId !== identity.companyId ||
    scope.taskId !== identity.taskId ||
    scope.ownershipEpoch !== identity.ownershipEpoch ||
    scope.targetAgentId !== identity.targetAgentId ||
    scope.adapterConfigIdentity !== identity.adapterConfigRevisionId ||
    scope.workspaceIdentity !== identity.executionWorkspaceBindingId ||
    scope.targetFingerprint !==
      localExecutionCorrelationFingerprint(identity.adapterConfigRevisionId) ||
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
    throw new TaskExecutionAttemptRejected(
      "ACP correlation activation scope crossed the resolved prompt",
    );
  }
  if (
    prompt.target.companyId !== identity.companyId ||
    prompt.target.taskId !== identity.taskId ||
    prompt.target.runId !== identity.runId ||
    prompt.target.targetAgentId !== identity.targetAgentId ||
    prompt.target.adapterConfigRevisionId !== identity.adapterConfigRevisionId ||
    prompt.target.executionWorkspaceBindingId !==
      identity.executionWorkspaceBindingId ||
    canonicalAcpConfiguration(prompt.target.acpConfiguration) !==
      canonicalAcpConfiguration(prompt.acpConfiguration)
  ) {
    throw new TaskExecutionAttemptRejected(
      "execution target input crossed the canonical prompt",
    );
  }
  const storedScope = prompt.storedCorrelation?.scope;
  const storedScopeMatchesPrompt = storedScope === undefined ||
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
              storedScope.currentRefOrdinal ===
                prompt.bootstrapPredecessor.refOrdinal &&
              storedScope.currentSegmentOrdinal === 0)
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
    throw new TaskExecutionAttemptRejected(
      "bootstrap predecessor proof crossed the resolved prompt",
    );
  }
  const operation = prompt.sessionOperation;
  const operationIsValid =
    (operation === "new" &&
      identity.promptKind === "base" &&
      bootstrapPredecessor === null &&
      prompt.storedCorrelation === null) ||
    (operation === "resume" &&
      ((prompt.carryContext &&
        prompt.storedCorrelation?.scope.purpose === "carry") ||
        bootstrapPredecessor !== null)) ||
    (operation === "steer_resume" &&
      identity.promptKind === "steering" &&
      prompt.storedCorrelation !== null);
  if (!operationIsValid) {
    throw new TaskExecutionAttemptRejected(
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
    throw new TaskExecutionAttemptRejected(
      "prompt resolver returned a different attempt lease",
    );
  }
}

function exactCapability(
  capability: MintedTaskExecutionPromptCapability,
): void {
  exactIdentity(capability.capabilityConnectionId, "capability connection id");
  exactIdentity(capability.endpoint, "capability endpoint");
  exactIdentity(capability.bearer, "capability bearer");
  if (capability.capabilityGeneration < 1) {
    throw new TaskExecutionAttemptRejected(
      "capability generation must be positive",
    );
  }
  let endpoint: URL;
  try {
    endpoint = new URL(capability.endpoint);
  } catch {
    throw new TaskExecutionAttemptRejected(
      "capability endpoint must be an absolute URL",
    );
  }
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new TaskExecutionAttemptRejected(
      "capability endpoint must use HTTP transport",
    );
  }
}

function runToolsSecret(
  capability: MintedTaskExecutionPromptCapability,
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
): TaskExecutionPromptAuthorityLost | null {
  if (error instanceof TaskExecutionPromptAuthorityLost) return error;
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
  result: AcpxOneShotPromptResult,
): TaskExecutionPromptClosure {
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
  return result.kind === "completed"
    ? { kind: "settled", settlement }
    : { kind: "cancelled", settlement };
}

function replaceExact(value: string, secret: string): string {
  return secret.length === 0
    ? value
    : value.split(secret).join("[REDACTED]");
}

function createRuntimeRedactor(input: {
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

function acpxRuntimePhase(
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

function assertTargetMatchesPrompt(
  prompt: ResolvedTaskExecutionPrompt,
  target: AcquiredTaskExecutionTarget,
): void {
  if (
    target.adapterConfigRevisionId !== prompt.identity.adapterConfigRevisionId ||
    canonicalAcpConfiguration(target.acpConfiguration) !==
      canonicalAcpConfiguration(prompt.acpConfiguration) ||
    target.executionTarget.kind !== "local" ||
    target.hostCwd !== prompt.target.hostCwd ||
    !sameStringSequence(
      target.targetAdditionalDirectories,
      prompt.target.targetAdditionalDirectories,
    ) ||
    target.targetCwd !== prompt.target.localWorkspaceCwd
  ) {
    throw new TaskExecutionAttemptRejected(
      "acquired execution target differs from the immutable ACP revision",
    );
  }
}

export function createTaskExecutionAttemptExecutor(options: {
  readonly repository: TaskExecutionPromptCycleRepository;
  readonly beforePrompt: PluginBeforePromptDispatcher;
  readonly targetAcquirer: TaskExecutionTargetAcquirer;
  readonly sessionCorrelations: Pick<
    NativeCorrelationService,
    "resolveResume" | "protectSession"
  >;
  readonly events: TaskExecutionAcpEventSink;
}): TaskExecutionAttemptExecutor {
  async function composeWorkPrompt(
    prompt: ResolvedTaskExecutionPrompt,
  ): Promise<string> {
    return options.beforePrompt.dispatch({
      companyId: prompt.identity.companyId,
      taskId: prompt.identity.taskId,
      sessionId: prompt.identity.sessionId,
      runId: prompt.identity.runId,
      agentId: prompt.identity.targetAgentId,
      sourceText: prompt.sourceText,
      promptKind: prompt.identity.promptKind,
      sessionOperation: prompt.sessionOperation,
      refId: prompt.identity.refId,
      refOrdinal: prompt.identity.refOrdinal,
      segmentOrdinal: prompt.identity.segmentOrdinal,
      sourceMessageId: prompt.sourceMessageId,
      sourceMessageSeq: prompt.sourceMessageSeq,
      contextAccess: prompt.contextAccess,
    });
  }

  async function runCycle(input: {
    readonly prompt: ResolvedTaskExecutionPrompt;
    readonly target: AcquiredTaskExecutionTarget;
    readonly start: { readonly kind: "new" } | {
      readonly kind: "resume";
      readonly sessionId: string;
    };
    readonly message: string;
    readonly signal: AbortSignal;
  }): Promise<TaskExecutionPromptClosureDecision> {
    const capability =
      await options.repository.mintPendingCapability(input.prompt);
    exactCapability(capability);
    const capabilityIdentity: TaskExecutionPromptCapabilityIdentity =
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
      | Awaited<ReturnType<typeof prepareAcpxRuntimeInvocation>>
      | null = null;
    let promptTransmissionRecorded = false;
    let result: AcpxOneShotPromptResult;
    try {
      if (input.target.targetAdditionalDirectories.length > 0) {
        throw new TaskExecutionAttemptRejected(
          "ACPX public runtime does not support Paperclip-managed additional directories",
        );
      }
      prepared = await prepareAcpxRuntimeInvocation({
        target: input.target.executionTarget,
        targetCwd: input.target.targetCwd,
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
        throw new TaskExecutionAttemptRejected(
          "execution target omitted request-scoped run-tools files",
        );
      }
      result = await executeAcpxOneShotPrompt({
        cwd: prepared.targetCwd,
        registryCwd: process.cwd(),
        agentName: input.prompt.acpConfiguration.launchProfile.registryName,
        start: input.start,
        message: input.message,
        configSelections:
          input.prompt.acpConfiguration.sessionConfigSelections,
        // Board approval gates are already settled for this exact execution.
        permissionMode: "approve-all",
        nonInteractivePermissions: "fail",
        mcpServers: Object.freeze([
          createPaperclipRunToolsMcpServer({
            nodeExecutable: prepared.targetNodeExecutable,
            proxyEntrypoint,
            secretFile,
          }),
        ]),
        timeoutMs: ACPX_TURN_TIMEOUT_MS,
        signal: input.signal,
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
              promptTransmissionRecorded = true;
            }),
        async onSessionEvent(event) {
          try {
            await options.events.publish({
              prompt: input.prompt.identity,
              capability: capabilityIdentity,
              redactor: input.target.redactor,
              event,
            });
          } catch (error) {
            logger.error({
              err: error,
              runId: input.prompt.identity.runId,
              refId: input.prompt.identity.refId,
              attemptId: input.prompt.identity.attemptId,
              eventKind: event.kind,
            }, "task-execution ACP event projection failed");
            throw error;
          }
        },
      });
    } catch (cause) {
      result = {
        kind: "error",
        phase: promptTransmissionRecorded ? "prompt" : "session_setup",
        promptTransmitted: promptTransmissionRecorded,
        cause,
      };
    }
    if (result.kind === "error") {
      result = {
        ...result,
        cause: redactAcpxRuntimeError(result.cause, redactRuntimeText),
      };
    }
    if (prepared) {
      try {
        await prepared.cleanup();
      } catch (cause) {
        const cleanupFailure = redactAcpxRuntimeError(cause, redactRuntimeText);
        const priorFailure = result.kind === "error" ? result.cause : null;
        const promptTransmitted = promptTransmissionRecorded ||
          result.kind !== "error" || result.promptTransmitted;
        result = {
          kind: "error",
          phase: promptTransmitted ? "prompt" : "session_setup",
          promptTransmitted,
          cause: priorFailure === null
            ? cleanupFailure
            : new AggregateError(
                [priorFailure, cleanupFailure],
                "ACPX execution and request-file cleanup both failed",
              ),
        };
      }
    }
    try {
      return await options.repository.closePrompt({
        prompt: input.prompt,
        capability: capabilityIdentity,
        outcome: canonicalClosure(result),
      });
    } catch (closureError) {
      throw new AggregateError(
        result.kind === "error"
          ? [result.cause, closureError]
          : [closureError],
        "canonical prompt closure did not commit",
      );
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
      let renewalAuthorityLoss: TaskExecutionPromptAuthorityLost | null = null;
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
            if (error instanceof TaskExecutionPromptAuthorityLost) {
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
            if (error instanceof TaskExecutionPromptAuthorityLost) {
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
      let dispatchResult: TaskExecutionDispatchResult | null = null;
      try {
        let outboundMessage = prompt.sourceText;
        if (!executionController.signal.aborted) {
          outboundMessage = await composeWorkPrompt(prompt);
        }
        if (renewalFailed) throw renewalFailure;
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
          if (prompt.sessionOperation === "new") {
            start = { kind: "new" };
          } else {
            const resolvedStart = await options.sessionCorrelations.resolveResume({
              promptKind: prompt.identity.promptKind,
              carryContext: prompt.carryContext,
              bootstrapHandoff: prompt.bootstrapPredecessor !== null,
              stored: prompt.storedCorrelation,
            });
            start = resolvedStart.start;
          }
          if (renewalFailed) throw renewalFailure;

          const decision = await runCycle({
            prompt,
            target,
            start,
            message: outboundMessage,
            signal: executionController.signal,
          });
          const failed =
            (decision.result.kind === "terminal" &&
              decision.result.outcome === "failed") ||
            decision.result.kind === "retry";
          await stopRenewal(true);
          targetFailed = failed;
          // ACPX has closed and its disposable state is gone; release the
          // Paperclip execution target before settling the durable run.
          await releaseTarget();
          await settle(decision.result);
          dispatchResult = decision.result;
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
        throw new TaskExecutionPromptAuthorityLost(lease, cause);
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
        throw new TaskExecutionAttemptRejected(
          "task execution attempt returned no canonical dispatch result",
        );
      }
      return dispatchResult;
    },
  };
}
