import type {
  CostEvent,
  IssueExecutionPromptOutcome,
  IssueExecutionPromptTransmissionPhase,
  IssueExecutionProtocolSettlementState,
  IssueExecutionRunEnvelopeRecord,
  IssueExecutionRunKind,
  IssueExecutionRunListPageRecord,
  IssueExecutionRunLivenessFact,
  IssueExecutionRunStatus,
  IssueExecutionSessionOperation,
  IssueExecutionWatchdogDecisionInput,
  IssueExecutionWatchdogDecisionRecord,
  WorkspaceOperation,
} from "@paperclipai/shared";
import { api } from "./client";

export const ACTIVE_ISSUE_EXECUTION_RUN_STATUSES = [
  "queued",
  "scheduled_retry",
  "running",
] as const satisfies readonly IssueExecutionRunStatus[];

export function isIssueExecutionRunActive(
  run: Pick<IssueExecutionRunEnvelopeRecord, "status">,
): boolean {
  return ACTIVE_ISSUE_EXECUTION_RUN_STATUSES.includes(
    run.status as (typeof ACTIVE_ISSUE_EXECUTION_RUN_STATUSES)[number],
  );
}

export interface IssueExecutionRunListFilters {
  agentId?: string;
  status?: readonly IssueExecutionRunStatus[];
  cursor?: string | null;
  limit?: number;
}

export interface BoundedRunRecords<T> {
  items: T[];
  truncated: boolean;
}

export interface IssueExecutionRunControlRecord {
  runId: string;
  currentRefId: string | null;
  currentOrdinal: number | null;
  currentSegmentOrdinal: number | null;
}

interface IssueExecutionPromptRecord {
  companyId: string;
  issueId: string;
  sessionId: string;
  runId: string;
  refId: string;
  refOrdinal: number;
  inputId: string;
  attemptId: string | null;
  capabilityConnectionId: string | null;
  capabilityGeneration: number | null;
  promptTransmissionPhase: IssueExecutionPromptTransmissionPhase;
  outcome: IssueExecutionPromptOutcome | null;
  outcomeReferenceId: string | null;
  protocolSettlementState: IssueExecutionProtocolSettlementState | null;
  accountingId: string | null;
  costEventId: string | null;
  settlementVersion: number;
  settledAt: string | null;
  createdAt: string;
}

export interface IssueExecutionRunRefRecord extends IssueExecutionPromptRecord {
  admissionOrder: number;
  batchDigest: string;
}

export interface IssueExecutionPromptSegmentRecord
  extends IssueExecutionPromptRecord {
  segmentOrdinal: number;
  sourceCommentId: string;
  sourceRefId: string | null;
  cancellationIntentId: string | null;
  steeringState: "requested" | "sent" | "protocol_settled" | "rebound" | "resumed";
}

export interface IssueExecutionCompactionSettlementRecord {
  id: string;
  promptTransmissionPhase: IssueExecutionPromptTransmissionPhase | null;
  protocolSettlementState: IssueExecutionProtocolSettlementState | null;
  promptSettlementReferenceId: string | null;
  accountingId: string | null;
  costEventId: string | null;
  settlementVersion: number;
  settledAt: string | null;
}

export interface IssueExecutionSessionEventRecord {
  id: string;
  seq: number;
  type: string;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface IssueExecutionSessionMessageRecord {
  id: string;
  seq: number;
  modelStateSeq: number;
  type:
    | "agent-switched"
    | "model-switched"
    | "user"
    | "synthetic"
    | "system"
    | "shell"
    | "assistant"
    | "compaction";
  data: Record<string, unknown>;
  timeCreated: string;
  timeUpdated: string;
}

export interface IssueExecutionAttemptRecord {
  id: string;
  companyId: string;
  issueId: string;
  sessionId: string;
  runId: string;
  runKind: IssueExecutionRunKind;
  promptKind: "base" | "steering" | "compaction";
  sessionOperation: IssueExecutionSessionOperation;
  refId: string | null;
  refOrdinal: number | null;
  segmentOrdinal: number | null;
  compactionControlId: string | null;
  attemptGeneration: number;
  state: "pending" | "leased" | "running" | "settled" | "failed" | "cancelled";
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export interface IssueExecutionAttemptRetryScheduleRecord {
  id: string;
  companyId: string;
  issueId: string;
  runId: string;
  predecessorAttemptId: string;
  reasonCode: string;
  retryAt: string;
  state: "scheduled" | "claimed" | "cancelled";
  successorAttemptId: string | null;
  claimedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
}

export interface IssueExecutionLeaseRecord {
  id: string;
  companyId: string;
  issueId: string;
  runId: string;
  attemptId: string;
  leaseGeneration: number;
  workerId: string;
  state: "active" | "released" | "expired" | "revoked";
  acquiredAt: string;
  renewedAt: string | null;
  expiresAt: string;
  releasedAt: string | null;
  createdAt: string;
}

export interface IssueExecutionProcessFactRecord {
  id: string;
  companyId: string;
  issueId: string;
  runId: string;
  attemptId: string;
  leaseId: string;
  processId: number;
  processGroupId: number;
  supervisorLocator: string;
  state: "starting" | "running" | "exited" | "terminated" | "lost";
  startedAt: string;
  settledAt: string | null;
  exitCode: number | null;
  exitSignal: string | null;
  createdAt: string;
}

export interface IssueExecutionCancellationRecord {
  id: string;
  companyId: string;
  issueId: string;
  runId: string;
  attemptId: string;
  leaseId: string | null;
  processFactId: string | null;
  reasonKind: "lifecycle" | "authority" | "timeout" | "lease_expired" | "process_policy" | "steering";
  actorKind: "system" | "user" | "agent";
  actorUserId: string | null;
  actorAgentId: string | null;
  state: "requested" | "acknowledged" | "completed" | "failed";
  requestedAt: string;
  acknowledgedAt: string | null;
  sessionCancelSentAt: string | null;
  processTerminationRequestedAt: string | null;
  processTerminatedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  failureCode: string | null;
  createdAt: string;
}

export interface AcpPromptAccountingRecord {
  id: string;
  companyId: string;
  issueId: string;
  agentId: string;
  runId: string;
  runKind: IssueExecutionRunKind;
  promptKind: "base" | "steering" | "compaction";
  refId: string | null;
  runOrdinal: number | null;
  segmentOrdinal: number | null;
  compactionControlId: string | null;
  contextUsedTokens: number;
  contextWindowTokens: number;
  createdAt: string;
}

export interface IssueExecutionToolInvocationRecord {
  id: string;
  toolName: string;
  riskLevel: string | null;
  policyDecision: string | null;
  approvalState: string;
  status: string;
  argumentsHash: string | null;
  argumentsSummary: unknown;
  resultHash: string | null;
  resultSummary: unknown;
  resultSizeBytes: number | null;
  errorCode: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IssueExecutionToolEventRecord {
  id: string;
  eventType: string;
  toolName: string | null;
  decision: string | null;
  reasonCode: string | null;
  outcome: string;
  latencyMs: number | null;
  argumentsSummary: unknown;
  requestHash: string | null;
  requestSummary: unknown;
  resultHash: string | null;
  resultSummary: unknown;
  resultSizeBytes: number | null;
  errorCode: string | null;
  createdAt: string;
}

export interface IssueExecutionActivityRecord {
  id: string;
  actorType: string;
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  agentId: string | null;
  responsibleUserId: string | null;
  details: Record<string, unknown> | null;
  createdAt: string;
}

export interface IssueExecutionFinalizationRecord {
  id: string;
  companyId: string;
  issueId: string;
  runId: string;
  action: "comment_only" | "updates_committed" | "no_conversational_output";
  terminalSessionEventId: string | null;
  terminalSessionMessageId: string | null;
  progressCommentId: string | null;
  createdAt: string;
}

export interface IssueExecutionFinalizationPromptDependencyRecord {
  companyId: string;
  issueId: string;
  runId: string;
  finalizationId: string;
  dependencyOrdinal: number;
  promptKind: "base" | "steering" | "compaction";
  refId: string | null;
  refOrdinal: number | null;
  segmentOrdinal: number | null;
  compactionControlId: string | null;
  protocolSettlementState: IssueExecutionProtocolSettlementState;
  settlementVersion: number;
  accountingId: string | null;
  costEventId: string | null;
}

export interface IssueExecutionFinalizationUpdateDependencyRecord {
  companyId: string;
  runId: string;
  finalizationId: string;
  dependencyOrdinal: number;
  issueUpdateId: string;
}

export interface IssueExecutionFinalizationDeliveryDependencyRecord
  extends IssueExecutionFinalizationUpdateDependencyRecord {
  creatorDeliveryId: string;
}

export interface IssueExecutionJoinedFinalization {
  record: IssueExecutionFinalizationRecord;
  promptDependencies: BoundedRunRecords<IssueExecutionFinalizationPromptDependencyRecord>;
  updateDependencies: BoundedRunRecords<IssueExecutionFinalizationUpdateDependencyRecord>;
  deliveryDependencies: BoundedRunRecords<IssueExecutionFinalizationDeliveryDependencyRecord>;
  liveness: (IssueExecutionRunLivenessFact & { id: string; runId: string }) | null;
}

export interface IssueExecutionRunJoinedDetail {
  run: IssueExecutionRunEnvelopeRecord;
  control: IssueExecutionRunControlRecord | null;
  refs: BoundedRunRecords<IssueExecutionRunRefRecord>;
  segments: BoundedRunRecords<IssueExecutionPromptSegmentRecord>;
  compactionSettlement: IssueExecutionCompactionSettlementRecord | null;
  sessionEvents: BoundedRunRecords<IssueExecutionSessionEventRecord>;
  sessionMessages: BoundedRunRecords<IssueExecutionSessionMessageRecord>;
  attempts: BoundedRunRecords<IssueExecutionAttemptRecord>;
  retrySchedules: BoundedRunRecords<IssueExecutionAttemptRetryScheduleRecord>;
  leases: BoundedRunRecords<IssueExecutionLeaseRecord>;
  processFacts: BoundedRunRecords<IssueExecutionProcessFactRecord>;
  cancellations: BoundedRunRecords<IssueExecutionCancellationRecord>;
  accounting: BoundedRunRecords<AcpPromptAccountingRecord>;
  costs: BoundedRunRecords<CostEvent>;
  toolInvocations: BoundedRunRecords<IssueExecutionToolInvocationRecord>;
  toolEvents: BoundedRunRecords<IssueExecutionToolEventRecord>;
  activity: BoundedRunRecords<IssueExecutionActivityRecord>;
  workspaceOperations: BoundedRunRecords<WorkspaceOperation>;
  watchdogDecisions: BoundedRunRecords<IssueExecutionWatchdogDecisionRecord>;
  finalization: IssueExecutionJoinedFinalization | null;
}

export interface WatchdogDecisionInput
  extends IssueExecutionWatchdogDecisionInput {
  runId: string;
}

function runListQuery(filters: IssueExecutionRunListFilters = {}): string {
  const searchParams = new URLSearchParams();
  if (filters.agentId) searchParams.set("agentId", filters.agentId);
  if (filters.status?.length) searchParams.set("status", filters.status.join(","));
  if (filters.cursor) searchParams.set("cursor", filters.cursor);
  if (filters.limit !== undefined) searchParams.set("limit", String(filters.limit));
  const query = searchParams.toString();
  return query ? `?${query}` : "";
}

export const runsApi = {
  listForCompany: (
    companyId: string,
    filters: IssueExecutionRunListFilters = {},
  ) =>
    api.get<IssueExecutionRunListPageRecord>(
      `/companies/${companyId}/runs${runListQuery(filters)}`,
    ),
  listForIssue: (
    issueId: string,
    filters: Omit<IssueExecutionRunListFilters, "agentId"> = {},
  ) =>
    api.get<IssueExecutionRunListPageRecord>(
      `/issues/${issueId}/runs${runListQuery(filters)}`,
    ),
  get: (runId: string, limit = 200) =>
    api.get<IssueExecutionRunJoinedDetail>(
      `/runs/${runId}?limit=${encodeURIComponent(String(limit))}`,
    ),
  recordWatchdogDecision: (input: WatchdogDecisionInput) =>
    api.post<IssueExecutionWatchdogDecisionRecord>(
      `/runs/${input.runId}/watchdog-decisions`,
      {
        decision: input.decision,
        evaluationIssueId: input.evaluationIssueId ?? null,
        reason: input.reason ?? null,
        snoozedUntil: input.snoozedUntil ?? null,
      },
    ),
};
