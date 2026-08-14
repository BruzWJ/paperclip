import {
  type AcpPromptSettlement,
  type NormalizedAcpSessionEvent,
} from "@paperclipai/adapter-utils/acpx-runtime";

import {
  agentAdapterAcpConfigurationSchema,
  type AgentAdapterAcpConfiguration,
  type TaskExecutionSessionOperation,
} from "@paperclipai/shared";

import type {
  AcpCorrelationScope,
  ProtectedAcpSessionCorrelation,
  StoredAcpSessionCorrelation,
} from "./native-correlation.js";

import type {
  TaskExecutionRuntimeRedactor,
  TaskExecutionTargetAcquisitionInput,
} from "./task-execution-provider-configuration.js";

import type { ContextDial } from "./context-dial-resolver.js";

import type { RuntimeToolTurn } from "./runtime-interface-compiler.js";

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const RUN_TOOLS_PROXY_FILE = "run-tools-proxy.mjs";

export const RUN_TOOLS_SECRET_FILE = "run-tools.json";

export const ACPX_TURN_TIMEOUT_MS = 15 * 60_000;

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

export interface TaskExecutionPromptIdentity extends TaskExecutionAttemptLease {
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

export interface MintedTaskExecutionPromptCapability extends TaskExecutionPromptCapabilityIdentity {
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
  "session_setup" | "prompt_activation" | "prompt_transmission" | "prompt";

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

export type TaskExecutionPromptClosureDecision = {
  readonly kind: "dispatch";
  readonly result: TaskExecutionDispatchResult;
};

/**
 * Narrow canonical DB transition boundary. Implementations lock and recheck
 * run/ref/segment, attempt, lease, epoch, authority, revision, workspace,
 * correlation, and capability generation in every mutating operation.
 */
export interface TaskExecutionPromptCycleRepository {
  resolve(lease: TaskExecutionAttemptLease): Promise<ResolvedTaskExecutionPrompt>;
  renewPromptAuthority(prompt: ResolvedTaskExecutionPrompt): Promise<void>;
  mintPendingCapability(prompt: ResolvedTaskExecutionPrompt): Promise<MintedTaskExecutionPromptCapability>;
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

export type TaskExecutionAttemptSettlement = (result: TaskExecutionDispatchResult) => Promise<void>;

export class TaskExecutionAttemptRejected extends Error {
  readonly code = "task_execution_attempt_rejected";

  constructor(message: string) {
    super(message);
    this.name = "TaskExecutionAttemptRejected";
  }
}

export function exactIdentity(value: string, label: string): void {
  if (value.length === 0 || value !== value.trim()) {
    throw new TaskExecutionAttemptRejected(`${label} must be exact and non-empty`);
  }
}

export function exactDigest(value: string, label: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new TaskExecutionAttemptRejected(`${label} is not a SHA-256 digest`);
  }
}

export function canonicalAcpConfiguration(value: AgentAdapterAcpConfiguration): string {
  try {
    return JSON.stringify(agentAdapterAcpConfigurationSchema.parse(value));
  } catch {
    throw new TaskExecutionAttemptRejected("resolved ACP configuration is not canonical");
  }
}

export function sameStringSequence(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function sameCorrelationLogicalKey(left: AcpCorrelationScope, right: AcpCorrelationScope): boolean {
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
    return (
      left.laneKind === right.laneKind &&
      left.authorizedContextExposureDigest === right.authorizedContextExposureDigest
    );
  }
  return (
    left.purpose === "active_run_steering" &&
    right.purpose === "active_run_steering" &&
    left.runId === right.runId
  );
}
