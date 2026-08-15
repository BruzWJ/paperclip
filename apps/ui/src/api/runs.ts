import type {
  CostEvent,
  TaskExecutionPromptOutcome,
  TaskExecutionPromptTransmissionPhase,
  TaskExecutionProtocolSettlementState,
  TaskExecutionRunEnvelopeRecord,
  TaskExecutionRunKind,
  TaskExecutionRunListPageRecord,
  TaskExecutionRunLivenessFact,
  TaskExecutionRunStatus,
  TaskExecutionSessionOperation,
} from "@paperclipai/shared";
import { api, type RequestOptions } from "./client";

export const ACTIVE_TASK_EXECUTION_RUN_STATUSES = [
  "queued",
  "scheduled_retry",
  "running",
] as const satisfies readonly TaskExecutionRunStatus[];

export function isTaskExecutionRunActive(run: Pick<TaskExecutionRunEnvelopeRecord, "status">): boolean {
  return ACTIVE_TASK_EXECUTION_RUN_STATUSES.includes(
    run.status as (typeof ACTIVE_TASK_EXECUTION_RUN_STATUSES)[number],
  );
}

export interface TaskExecutionRunListFilters {
  agentId?: string;
  status?: readonly TaskExecutionRunStatus[];
  cursor?: string | null;
  limit?: number;
}

export interface TaskExecutionRunDetailCursors {
  messageCursor?: string | null;
  eventCursor?: string | null;
}

export interface BoundedRunRecords<T> {
  items: T[];
  truncated: boolean;
  nextCursor?: string | null;
}

/** JSON wire projection of the canonical prompt cost fact. */
export type TaskExecutionCostEventRecord = Omit<CostEvent, "occurredAt" | "createdAt"> & {
  occurredAt: string;
  createdAt: string;
};

export interface TaskExecutionRunControlRecord {
  runId: string;
  currentRefId: string | null;
  currentOrdinal: number | null;
  currentSegmentOrdinal: number | null;
}

interface TaskExecutionPromptRecord {
  companyId: string;
  taskId: string;
  sessionId: string;
  runId: string;
  refId: string;
  refOrdinal: number;
  attemptId: string | null;
  capabilityConnectionId: string | null;
  capabilityGeneration: number | null;
  promptTransmissionPhase: TaskExecutionPromptTransmissionPhase;
  outcome: TaskExecutionPromptOutcome | null;
  outcomeReferenceId: string | null;
  protocolSettlementState: TaskExecutionProtocolSettlementState | null;
  accountingId: string | null;
  costEventId: string | null;
  settlementVersion: number;
  settledAt: string | null;
  createdAt: string;
}

export interface TaskExecutionRunRefRecord extends TaskExecutionPromptRecord {
  admissionOrder: number;
  batchDigest: string;
  inputId: string | null;
}

export interface TaskExecutionPromptSegmentRecord extends TaskExecutionPromptRecord {
  segmentOrdinal: number;
  sourceCommentId: string;
  sourceRefId: string | null;
  sourceMessageId: string;
  sourceInputId: string | null;
  resumeSourceCorrelationId: string;
  targetSessionGeneration: number | null;
  cancellationIntentId: string | null;
  steeringState: "requested" | "sent" | "protocol_settled" | "rebound" | "resumed";
  terminalSessionMessageId: string | null;
  resumedAt: string | null;
}

export interface TaskExecutionSessionEventRecord {
  id: string;
  seq: number;
  type: string;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface TaskExecutionSessionMessageRecord {
  id: string;
  seq: number;
  modelStateSeq: number;
  type: "agent-switched" | "model-switched" | "user" | "synthetic" | "system" | "shell" | "assistant";
  data: Record<string, unknown>;
  timeCreated: string;
  timeUpdated: string;
}

export interface TaskExecutionAttemptRecord {
  id: string;
  companyId: string;
  taskId: string;
  sessionId: string;
  runId: string;
  runKind: TaskExecutionRunKind;
  promptKind: "base" | "steering";
  sessionOperation: TaskExecutionSessionOperation;
  refId: string | null;
  refOrdinal: number | null;
  segmentOrdinal: number | null;
  steeringSegmentOrdinal: number | null;
  attemptGeneration: number;
  state: "pending" | "leased" | "running" | "settled" | "failed" | "cancelled";
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export interface TaskExecutionAttemptRetryScheduleRecord {
  id: string;
  companyId: string;
  taskId: string;
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

export interface TaskExecutionLeaseRecord {
  id: string;
  companyId: string;
  taskId: string;
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

export interface TaskExecutionCancellationRecord {
  id: string;
  companyId: string;
  taskId: string;
  runId: string;
  attemptId: string;
  leaseId: string | null;
  reasonKind: "lifecycle" | "authority" | "timeout" | "lease_expired" | "steering";
  actorKind: "system" | "user" | "agent";
  actorUserId: string | null;
  actorAgentId: string | null;
  state: "requested" | "acknowledged" | "completed" | "failed";
  requestedAt: string;
  acknowledgedAt: string | null;
  nativeCancellationSettledAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  failureCode: string | null;
  createdAt: string;
}

export interface AcpPromptAccountingRecord {
  id: string;
  companyId: string;
  taskId: string;
  sessionId: string;
  agentId: string;
  runId: string;
  runKind: TaskExecutionRunKind;
  promptKind: "base" | "steering";
  refId: string | null;
  runOrdinal: number | null;
  segmentOrdinal: number | null;
  attemptId: string;
  adapterConfigRevisionId: string;
  selectedModelId: string | null;
  contextTokenLimit: number;
  contextUsedTokens: number;
  contextWindowTokens: number;
  promptSettlementReferenceId: string;
  terminalUsageReference: string;
  terminalStopReference: string;
  settledAt: string;
  createdAt: string;
}

export interface TaskExecutionRunOutputCommentLink {
  commentId: string;
  messageId: string;
  sourceKind: "run_output" | "run_progress" | "task_update";
  projectedEventSeq: number;
}

export interface TaskExecutionActivityRecord {
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

export interface TaskExecutionFinalizationRecord {
  id: string;
  companyId: string;
  runId: string;
  finalizationIdentityDigest: string;
  action: "comment_only" | "updates_committed" | "no_conversational_output";
  terminalSessionEventId: string | null;
  terminalSessionMessageId: string | null;
  progressCommentId: string | null;
  gatewayCapabilityConnectionId: string | null;
  gatewayCapabilityGeneration: number | null;
  runLivenessFactId: string | null;
  finalizedAt: string;
  createdAt: string;
}

export interface TaskExecutionFinalizationPromptDependencyRecord {
  companyId: string;
  taskId: string;
  runId: string;
  finalizationId: string;
  dependencyOrdinal: number;
  promptKind: "base" | "steering";
  refId: string | null;
  refOrdinal: number | null;
  segmentOrdinal: number | null;
  protocolSettlementState: TaskExecutionProtocolSettlementState;
  settlementVersion: number;
  accountingId: string | null;
  costEventId: string | null;
}

export interface TaskExecutionFinalizationUpdateDependencyRecord {
  companyId: string;
  runId: string;
  finalizationId: string;
  dependencyOrdinal: number;
  taskUpdateId: string;
}

export interface TaskExecutionJoinedFinalization {
  record: TaskExecutionFinalizationRecord;
  promptDependencies: BoundedRunRecords<TaskExecutionFinalizationPromptDependencyRecord>;
  updateDependencies: BoundedRunRecords<TaskExecutionFinalizationUpdateDependencyRecord>;
  liveness: (TaskExecutionRunLivenessFact & { id: string; runId: string }) | null;
}

export interface TaskExecutionRunJoinedDetail {
  run: TaskExecutionRunEnvelopeRecord;
  control: TaskExecutionRunControlRecord | null;
  refs: BoundedRunRecords<TaskExecutionRunRefRecord>;
  segments: BoundedRunRecords<TaskExecutionPromptSegmentRecord>;
  sessionEvents: BoundedRunRecords<TaskExecutionSessionEventRecord>;
  sessionMessages: BoundedRunRecords<TaskExecutionSessionMessageRecord>;
  attempts: BoundedRunRecords<TaskExecutionAttemptRecord>;
  retrySchedules: BoundedRunRecords<TaskExecutionAttemptRetryScheduleRecord>;
  leases: BoundedRunRecords<TaskExecutionLeaseRecord>;
  cancellations: BoundedRunRecords<TaskExecutionCancellationRecord>;
  accounting: BoundedRunRecords<AcpPromptAccountingRecord>;
  costs: BoundedRunRecords<TaskExecutionCostEventRecord>;
  activity: BoundedRunRecords<TaskExecutionActivityRecord>;
  outputComments: BoundedRunRecords<TaskExecutionRunOutputCommentLink>;
  finalization: TaskExecutionJoinedFinalization | null;
}

function runListQuery(filters: TaskExecutionRunListFilters = {}): string {
  const searchParams = new URLSearchParams();
  if (filters.agentId) searchParams.set("agentId", filters.agentId);
  for (const status of filters.status ?? []) searchParams.append("status", status);
  if (filters.cursor) searchParams.set("cursor", filters.cursor);
  if (filters.limit !== undefined) searchParams.set("limit", String(filters.limit));
  const query = searchParams.toString();
  return query ? `?${query}` : "";
}

export const runsApi = {
  listForCompany: (companyId: string, filters: TaskExecutionRunListFilters = {}) =>
    api.get<TaskExecutionRunListPageRecord>(`/companies/${companyId}/runs${runListQuery(filters)}`),
  listForTask: (taskId: string, filters: Omit<TaskExecutionRunListFilters, "agentId"> = {}) =>
    api.get<TaskExecutionRunListPageRecord>(`/tasks/${taskId}/runs${runListQuery(filters)}`),
  get: (
    runId: string,
    limit = 200,
    options?: RequestOptions,
    cursors: TaskExecutionRunDetailCursors = {},
  ) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (cursors.messageCursor) params.set("messageCursor", cursors.messageCursor);
    if (cursors.eventCursor) params.set("eventCursor", cursors.eventCursor);
    return api.get<TaskExecutionRunJoinedDetail>(`/runs/${runId}?${params.toString()}`, options);
  },
};
