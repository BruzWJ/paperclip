export const ISSUE_EXECUTION_RUN_KINDS = [
  "productive",
  "consult",
] as const;

export type IssueExecutionRunKind =
  (typeof ISSUE_EXECUTION_RUN_KINDS)[number];

export const ISSUE_EXECUTION_SESSION_OPERATIONS = [
  "new",
  "resume",
  "steer_resume",
] as const;

export type IssueExecutionSessionOperation =
  (typeof ISSUE_EXECUTION_SESSION_OPERATIONS)[number];

/**
 * Run-envelope lifecycle only. Retry, prompt settlement, and liveness are
 * deliberately owned by their separate typed records.
 */
export const ISSUE_EXECUTION_RUN_STATUSES = [
  "queued",
  "scheduled_retry",
  "running",
  "succeeded",
  "interrupted",
  "failed",
  "cancelled",
  "timed_out",
] as const;

export type IssueExecutionRunStatus =
  (typeof ISSUE_EXECUTION_RUN_STATUSES)[number];

export const ISSUE_EXECUTION_RUN_TERMINAL_CLASSIFICATIONS = [
  "succeeded",
  "interrupted",
  "failed",
  "cancelled",
  "timed_out",
] as const;

export type IssueExecutionRunTerminalClassification =
  (typeof ISSUE_EXECUTION_RUN_TERMINAL_CLASSIFICATIONS)[number];

/** Disposable process-local progress only; never a durable run record. */
export type IssueExecutionRunProgressPhase =
  | "git_sync"
  | "config_sync"
  | "adapter_startup"
  | "restore"
  | "export"
  | "finalize"
  | "run_activity";

/** Public wire projection of the closed control-plane run envelope. */
export interface IssueExecutionRunEnvelopeRecord {
  id: string;
  companyId: string;
  issueId: string;
  sessionId: string;
  executionScopeId: string;
  kind: IssueExecutionRunKind;
  status: IssueExecutionRunStatus;
  ownershipEpoch: number;
  targetAgentId: string;
  adapterConfigRevisionId: string;
  executionMode: "owner" | "consult";
  issueExecutionAuthorityId: string | null;
  consultExecutionId: string | null;
  parentRunId: string | null;
  retryOfRunId: string | null;
  currentAttemptId: string | null;
  currentLeaseId: string | null;
  cancellationIntentId: string | null;
  terminalFinalizationId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  terminalClassification: IssueExecutionRunTerminalClassification | null;
  terminalReasonCode: string | null;
  processExitCode: number | null;
  processSignal: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IssueExecutionRunListPageRecord {
  items: IssueExecutionRunEnvelopeRecord[];
  nextCursor: string | null;
}

export const ISSUE_EXECUTION_WATCHDOG_DECISIONS = [
  "snooze",
  "continue",
  "dismissed_false_positive",
] as const;

export type IssueExecutionWatchdogDecision =
  (typeof ISSUE_EXECUTION_WATCHDOG_DECISIONS)[number];

export interface IssueExecutionWatchdogDecisionInput {
  decision: IssueExecutionWatchdogDecision;
  evaluationIssueId?: string | null;
  reason?: string | null;
  snoozedUntil?: string | null;
}

export interface IssueExecutionWatchdogDecisionRecord {
  id: string;
  companyId: string;
  runId: string;
  evaluationIssueId: string | null;
  decision: IssueExecutionWatchdogDecision;
  snoozedUntil: string | null;
  reason: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdByRunId: string | null;
  createdAt: string;
}

export const ISSUE_EXECUTION_PROMPT_TRANSMISSION_PHASES = [
  "not_transmitted",
  "transmitted",
] as const;

export type IssueExecutionPromptTransmissionPhase =
  (typeof ISSUE_EXECUTION_PROMPT_TRANSMISSION_PHASES)[number];

export const ISSUE_EXECUTION_PROTOCOL_SETTLEMENT_STATES = [
  "not_sent",
  "settled",
  "incomplete",
] as const;

export type IssueExecutionProtocolSettlementState =
  (typeof ISSUE_EXECUTION_PROTOCOL_SETTLEMENT_STATES)[number];

export const ISSUE_EXECUTION_PROMPT_OUTCOMES = [
  "released_unsent",
  "succeeded",
  "refused",
  "failed",
  "ambiguous",
  "cancelled",
] as const;

export type IssueExecutionPromptOutcome =
  (typeof ISSUE_EXECUTION_PROMPT_OUTCOMES)[number];

export const ISSUE_EXECUTION_STEERING_STATES = [
  "requested",
  "sent",
  "protocol_settled",
  "rebound",
  "resumed",
] as const;

export type IssueExecutionSteeringState =
  (typeof ISSUE_EXECUTION_STEERING_STATES)[number];

/** Closed purpose of Paperclip's encrypted ACP target correlation. */
export const ISSUE_EXECUTION_NATIVE_CORRELATION_PURPOSES = [
  "carry",
  "active_run_steering",
] as const;

export type IssueExecutionNativeCorrelationPurpose =
  (typeof ISSUE_EXECUTION_NATIVE_CORRELATION_PURPOSES)[number];

/**
 * Purpose-checked state: carry rows may be eligible, steering rows may be
 * current, and either purpose may be permanently superseded.
 */
export const ISSUE_EXECUTION_NATIVE_CORRELATION_STATES = [
  "eligible",
  "current",
  "superseded",
] as const;

export type IssueExecutionNativeCorrelationState =
  (typeof ISSUE_EXECUTION_NATIVE_CORRELATION_STATES)[number];

export const ISSUE_EXECUTION_LANE_KINDS = ["owner", "consult"] as const;

export type IssueExecutionLaneKind =
  (typeof ISSUE_EXECUTION_LANE_KINDS)[number];

/** The cumulative-cost cursor retained only with one resumable ACP target. */
export const ACP_COST_CURSOR_STATES = [
  "unanchored",
  "known",
  "unavailable",
] as const;

export type AcpCostCursorState = (typeof ACP_COST_CURSOR_STATES)[number];

/** One generation exists for one canonical work-prompt setup and active prompt. */
export const ISSUE_EXECUTION_PROMPT_CAPABILITY_STATES = [
  "pending_setup",
  "active",
  "revoked",
] as const;

export type IssueExecutionPromptCapabilityState =
  (typeof ISSUE_EXECUTION_PROMPT_CAPABILITY_STATES)[number];

export const ISSUE_EXECUTION_FINALIZATION_ACTIONS = [
  "comment_only",
  "updates_committed",
  "no_conversational_output",
] as const;

export type IssueExecutionFinalizationAction =
  (typeof ISSUE_EXECUTION_FINALIZATION_ACTIONS)[number];

export interface IssueExecutionActivePromptSettlement {
  promptTransmissionPhase: IssueExecutionPromptTransmissionPhase;
  protocolSettlementState: null;
  outcome: null;
  outcomeReferenceId: null;
  accountingId: null;
  costEventId: null;
  settlementVersion: 0;
}

export interface IssueExecutionNotSentPromptSettlement {
  promptTransmissionPhase: "not_transmitted";
  protocolSettlementState: "not_sent";
  outcome: "released_unsent";
  outcomeReferenceId: string;
  accountingId: null;
  costEventId: null;
  settlementVersion: number;
}

export interface IssueExecutionSettledPromptSettlement {
  promptTransmissionPhase: "transmitted";
  protocolSettlementState: "settled";
  outcome: "succeeded" | "refused" | "failed" | "cancelled";
  outcomeReferenceId: string;
  accountingId: string;
  costEventId: string;
  settlementVersion: number;
}

export interface IssueExecutionIncompletePromptSettlement {
  promptTransmissionPhase: "transmitted";
  protocolSettlementState: "incomplete";
  outcome: "failed" | "ambiguous" | "cancelled";
  outcomeReferenceId: string;
  accountingId: null;
  costEventId: null;
  settlementVersion: number;
}

/**
 * Closed settlement matrix shared by base run-ref prompts and positive
 * steering segments. A protocol-settled prompt is the only branch allowed to
 * reference accounting and cost.
 */
export type IssueExecutionPromptSettlement =
  | IssueExecutionActivePromptSettlement
  | IssueExecutionNotSentPromptSettlement
  | IssueExecutionSettledPromptSettlement
  | IssueExecutionIncompletePromptSettlement;

export interface IssueExecutionRunLivenessFact {
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
