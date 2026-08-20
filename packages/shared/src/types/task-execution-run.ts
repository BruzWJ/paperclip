export const TASK_EXECUTION_RUN_KINDS = [
  "productive",
  "consult",
] as const;

export type TaskExecutionRunKind =
  (typeof TASK_EXECUTION_RUN_KINDS)[number];

export const TASK_EXECUTION_SESSION_OPERATIONS = [
  "new",
  "resume",
] as const;

export type TaskExecutionSessionOperation =
  (typeof TASK_EXECUTION_SESSION_OPERATIONS)[number];

/**
 * Run-envelope lifecycle only. Retry, prompt settlement, and liveness are
 * deliberately owned by their separate typed records.
 */
export const TASK_EXECUTION_RUN_STATUSES = [
  "queued",
  "scheduled_retry",
  "running",
  "succeeded",
  "interrupted",
  "failed",
  "cancelled",
  "timed_out",
] as const;

export type TaskExecutionRunStatus =
  (typeof TASK_EXECUTION_RUN_STATUSES)[number];

export const TASK_EXECUTION_RUN_TERMINAL_CLASSIFICATIONS = [
  "succeeded",
  "interrupted",
  "failed",
  "cancelled",
  "timed_out",
] as const;

export type TaskExecutionRunTerminalClassification =
  (typeof TASK_EXECUTION_RUN_TERMINAL_CLASSIFICATIONS)[number];

/** Disposable process-local progress only; never a durable run record. */
export type TaskExecutionRunProgressPhase =
  | "git_sync"
  | "config_sync"
  | "adapter_startup"
  | "restore"
  | "export"
  | "finalize"
  | "run_activity";

/** Public wire projection of the closed control-plane run envelope. */
export interface TaskExecutionRunEnvelopeRecord {
  id: string;
  companyId: string;
  taskId: string;
  sessionId: string;
  executionScopeId: string;
  kind: TaskExecutionRunKind;
  status: TaskExecutionRunStatus;
  ownershipEpoch: number;
  targetAgentId: string;
  adapterConfigRevisionId: string;
  executionMode: "owner" | "consult";
  taskExecutionAuthorityId: string | null;
  consultExecutionId: string | null;
  parentRunId: string | null;
  retryOfRunId: string | null;
  currentAttemptId: string | null;
  currentLeaseId: string | null;
  cancellationIntentId: string | null;
  terminalFinalizationId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  terminalClassification: TaskExecutionRunTerminalClassification | null;
  terminalReasonCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskExecutionRunListPageRecord {
  items: TaskExecutionRunEnvelopeRecord[];
  nextCursor: string | null;
}

export const TASK_EXECUTION_PROMPT_TRANSMISSION_PHASES = [
  "not_transmitted",
  "transmitted",
] as const;

export type TaskExecutionPromptTransmissionPhase =
  (typeof TASK_EXECUTION_PROMPT_TRANSMISSION_PHASES)[number];

export const TASK_EXECUTION_PROTOCOL_SETTLEMENT_STATES = [
  "not_sent",
  "settled",
  "incomplete",
] as const;

export type TaskExecutionProtocolSettlementState =
  (typeof TASK_EXECUTION_PROTOCOL_SETTLEMENT_STATES)[number];

export const TASK_EXECUTION_PROMPT_OUTCOMES = [
  "released_unsent",
  "succeeded",
  "refused",
  "failed",
  "ambiguous",
  "cancelled",
] as const;

export type TaskExecutionPromptOutcome =
  (typeof TASK_EXECUTION_PROMPT_OUTCOMES)[number];

/** Carry correlations are either resumable or permanently superseded. */
export const TASK_EXECUTION_NATIVE_CORRELATION_STATES = [
  "eligible",
  "superseded",
] as const;

export type TaskExecutionNativeCorrelationState =
  (typeof TASK_EXECUTION_NATIVE_CORRELATION_STATES)[number];

export const TASK_EXECUTION_LANE_KINDS = ["owner", "consult"] as const;

export type TaskExecutionLaneKind =
  (typeof TASK_EXECUTION_LANE_KINDS)[number];

/** The cumulative-cost cursor retained only with one resumable ACP target. */
export const ACP_COST_CURSOR_STATES = [
  "unanchored",
  "known",
  "unavailable",
] as const;

export type AcpCostCursorState = (typeof ACP_COST_CURSOR_STATES)[number];

/** One generation exists for one canonical work-prompt setup and active prompt. */
export const TASK_EXECUTION_PROMPT_CAPABILITY_STATES = [
  "pending_setup",
  "active",
  "revoked",
] as const;

export type TaskExecutionPromptCapabilityState =
  (typeof TASK_EXECUTION_PROMPT_CAPABILITY_STATES)[number];

export const TASK_EXECUTION_FINALIZATION_ACTIONS = [
  "comment_only",
  "updates_committed",
  "no_conversational_output",
] as const;

export type TaskExecutionFinalizationAction =
  (typeof TASK_EXECUTION_FINALIZATION_ACTIONS)[number];

export interface TaskExecutionActivePromptSettlement {
  promptTransmissionPhase: TaskExecutionPromptTransmissionPhase;
  protocolSettlementState: null;
  outcome: null;
  outcomeReferenceId: null;
  accountingId: null;
  costEventId: null;
  settlementVersion: 0;
}

export interface TaskExecutionNotSentPromptSettlement {
  promptTransmissionPhase: "not_transmitted";
  protocolSettlementState: "not_sent";
  outcome: "released_unsent";
  outcomeReferenceId: string;
  accountingId: null;
  costEventId: null;
  settlementVersion: number;
}

export interface TaskExecutionSettledPromptSettlement {
  promptTransmissionPhase: "transmitted";
  protocolSettlementState: "settled";
  outcome: "succeeded" | "refused" | "failed" | "cancelled";
  outcomeReferenceId: string;
  accountingId: string;
  costEventId: string;
  settlementVersion: number;
}

export interface TaskExecutionIncompletePromptSettlement {
  promptTransmissionPhase: "transmitted";
  protocolSettlementState: "incomplete";
  outcome: "failed" | "ambiguous" | "cancelled";
  outcomeReferenceId: string;
  accountingId: null;
  costEventId: null;
  settlementVersion: number;
}

/**
 * Closed settlement matrix for a run-ref prompt. A protocol-settled prompt is
 * the only branch allowed to reference accounting and cost.
 */
export type TaskExecutionPromptSettlement =
  | TaskExecutionActivePromptSettlement
  | TaskExecutionNotSentPromptSettlement
  | TaskExecutionSettledPromptSettlement
  | TaskExecutionIncompletePromptSettlement;

export interface TaskExecutionRunLivenessFact {
  livenessState:
    | "completed"
    | "advanced"
    | "plan_only"
    | "empty_response"
    | "blocked"
    | "failed"
    | "needs_followup";
  livenessReason: string;
  continuationAttempt: number;
  lastUsefulActionAt: string | null;
  nextAction: string | null;
}
