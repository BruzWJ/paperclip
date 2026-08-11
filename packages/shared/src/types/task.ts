import type {
  TaskCommentAuthorType,
  TaskCommentMetadataRowType,
  TaskCommentPresentationKind,
  TaskCommentPresentationTone,
  TaskExecutionMonitorClearReason,
  TaskExecutionMonitorKind,
  TaskExecutionMonitorRecoveryPolicy,
  TaskExecutionMonitorStateStatus,
  TaskExecutionDecisionOutcome,
  TaskMonitorScheduledBy,
  TaskExecutionPolicyMode,
  TaskReferenceSourceKind,
  TaskExecutionStageType,
  TaskExecutionStateStatus,
  TaskOriginKind,
  TaskPriority,
  TaskWorkMode,
  TaskStatus,
} from "../constants.js";
import type { Goal } from "./goal.js";
import type { Project } from "./project.js";
import type { TaskWorkProduct } from "./work-product.js";
import type {
  LowTrustReviewPresetPolicy,
  SourceTrustMetadata,
  TrustAuthorizationPolicy,
} from "../trust-policy.js";
import type {
  AgentVisibleTaskStatus,
  TaskDisposition,
  SystemCreatorSourceKind,
} from "../task-runtime.js";

export type { TaskWorkMode };

export interface TaskAncestorProject {
  id: string;
  name: string;
  description: string | null;
  status: string;
  goalId: string | null;
}

export interface TaskAncestorGoal {
  id: string;
  title: string;
  description: string | null;
  level: string;
  status: string;
}

export interface TaskAncestor {
  id: string;
  identifier: string | null;
  title: string | null;
  request: string;
  boardPresentationStatus: TaskStatus;
  priority: string;
  ownerAgentId: string | null;
  ownerUserId: string | null;
  projectId: string | null;
  goalId: string | null;
  project: TaskAncestorProject | null;
  goal: TaskAncestorGoal | null;
}

export interface TaskLabel {
  id: string;
  companyId: string;
  name: string;
  color: string;
  createdAt: Date;
  updatedAt: Date;
}

export type DocumentFormat = "markdown";

export interface TaskDocumentSummary {
  id: string;
  companyId: string;
  taskId: string;
  key: string;
  title: string | null;
  format: DocumentFormat;
  latestRevisionId: string | null;
  latestRevisionNumber: number;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  updatedByAgentId: string | null;
  updatedByUserId: string | null;
  lockedAt: Date | null;
  lockedByAgentId: string | null;
  lockedByUserId: string | null;
  sourceTrust?: SourceTrustMetadata | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TaskDocument extends TaskDocumentSummary {
  body: string;
}

export interface DocumentRevision {
  id: string;
  companyId: string;
  documentId: string;
  taskId: string;
  key: string;
  revisionNumber: number;
  title: string | null;
  format: DocumentFormat;
  body: string;
  changeSummary: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: Date;
}

export interface TaskRelationTaskSummary {
  id: string;
  identifier: string | null;
  title: string | null;
  boardPresentationStatus: TaskStatus;
  priority: TaskPriority;
  ownerAgentId: string | null;
  ownerUserId: string | null;
  terminalBlockers?: TaskRelationTaskSummary[];
}

export type TaskBlockerDiagnosticFlag =
  | "done_but_blocking"
  | "cancelled_blocker_in_set";

export interface TaskBlockerDiagnosticTaskSummary {
  id: string;
  identifier: string | null;
  title: string | null;
  boardPresentationStatus: TaskStatus;
  priority: TaskPriority;
  ownerAgentId: string | null;
  ownerUserId: string | null;
}

export interface TaskBlockerDiagnosticNode extends TaskBlockerDiagnosticTaskSummary {
  isUnresolved: boolean;
  isDependencyReady: boolean;
  flags: TaskBlockerDiagnosticFlag[];
}

export interface TaskBlockerDiagnosticsReadiness {
  allBlockersDone: boolean;
  isDependencyReady: boolean;
  unresolvedBlockerCount: number;
}

export interface TaskBlockerDiagnosticsResponse {
  task: TaskBlockerDiagnosticTaskSummary;
  diagnosis: string | null;
  readiness: TaskBlockerDiagnosticsReadiness | null;
  blockers: TaskBlockerDiagnosticNode[];
  omittedUnauthorizedBlockerCount: number | null;
  truncated: boolean;
  caps: {
    maxBlockers: number;
  };
}

export interface TaskSubtreeDiagnosticNode {
  task: TaskBlockerDiagnosticTaskSummary;
  parentId: string | null;
  depth: number;
  diagnosis: string | null;
  likelyReason: string | null;
  blockers: TaskBlockerDiagnosticNode[];
  blockerReadiness: TaskBlockerDiagnosticsReadiness | null;
  omittedUnauthorizedBlockerCount: number | null;
  truncated: boolean;
  truncatedSections: {
    blockers: boolean;
  };
}

export type TaskSubtreeDiagnosticEdge =
  | {
    kind: "parent";
    fromTaskId: string;
    toTaskId: string;
    timestamp: string | null;
  }
  | {
    kind: "blocks";
    fromTaskId: string;
    toTaskId: string;
    timestamp: string | null;
  };

export interface TaskSubtreeDiagnosticsResponse {
  task: TaskBlockerDiagnosticTaskSummary;
  diagnosis: string | null;
  likelyReason: string | null;
  nodes: TaskSubtreeDiagnosticNode[];
  edges: TaskSubtreeDiagnosticEdge[];
  nodeCount: number;
  omittedUnauthorizedNodeCount: number | null;
  truncated: boolean;
  truncatedSections: {
    nodes: boolean;
    depth: boolean;
    blockers: boolean;
  };
  caps: {
    maxDepth: number;
    maxNodes: number;
    maxBlockersPerNode: number;
  };
}

export type TaskBlockerAttentionState = "none" | "covered" | "stalled" | "needs_attention";

export type TaskBlockerAttentionReason =
  | "active_child"
  | "active_dependency"
  | "stalled_review"
  | "attention_required"
  | null;

export interface TaskBlockerAttention {
  state: TaskBlockerAttentionState;
  reason: TaskBlockerAttentionReason;
  unresolvedBlockerCount: number;
  coveredBlockerCount: number;
  stalledBlockerCount: number;
  attentionBlockerCount: number;
  sampleBlockerIdentifier: string | null;
  sampleStalledBlockerIdentifier: string | null;
}

export type TaskInboxAttentionKind = "blocked";

export type TaskBlockedInboxState =
  | "needs_attention"
  | "awaiting_decision"
  | "external_wait";

export type TaskBlockedInboxSeverity = "critical" | "high" | "medium" | "low";

export type TaskBlockedInboxReason =
  | "blocked_chain_stalled"
  | "pending_board_decision"
  | "pending_user_decision"
  | "external_owner_action";

export type TaskBlockedInboxOwnerType = "agent" | "user" | "board" | "external" | "unknown";

export interface TaskBlockedInboxTaskRef {
  id: string;
  identifier: string | null;
  title: string | null;
  boardPresentationStatus: TaskStatus;
  priority: TaskPriority;
  ownerAgentId: string | null;
  ownerUserId: string | null;
}

export interface TaskBlockedInboxOwner {
  type: TaskBlockedInboxOwnerType;
  agentId: string | null;
  userId: string | null;
  label: string | null;
}

export interface TaskBlockedInboxAction {
  label: string;
  detail: string | null;
}

export interface TaskBlockedInboxAttention {
  kind: TaskInboxAttentionKind;
  state: TaskBlockedInboxState;
  reason: TaskBlockedInboxReason;
  severity: TaskBlockedInboxSeverity;
  stoppedSinceAt: string | null;
  owner: TaskBlockedInboxOwner;
  action: TaskBlockedInboxAction;
  sourceTask: TaskBlockedInboxTaskRef | null;
  leafTask: TaskBlockedInboxTaskRef | null;
  approvalId: string | null;
  sampleTaskIdentifier: string | null;
  redaction: {
    externalDetailsRedacted: boolean;
    secretFieldsOmitted: true;
  };
}

export interface TaskRelation {
  id: string;
  companyId: string;
  taskId: string;
  relatedTaskId: string;
  type: "blocks";
  relatedTask: TaskRelationTaskSummary;
}

export interface TaskReferenceSource {
  kind: TaskReferenceSourceKind;
  sourceRecordId: string | null;
  label: string;
  matchedText: string | null;
}

export interface TaskRelatedWorkItem {
  task: TaskRelationTaskSummary;
  mentionCount: number;
  sources: TaskReferenceSource[];
}

export interface TaskRelatedWorkSummary {
  outbound: TaskRelatedWorkItem[];
  inbound: TaskRelatedWorkItem[];
}

export interface TaskExecutionStagePrincipal {
  type: "agent" | "user";
  agentId?: string | null;
  userId?: string | null;
}

export interface TaskExecutionStageParticipant extends TaskExecutionStagePrincipal {
  id: string;
}

export interface TaskExecutionStage {
  id: string;
  type: TaskExecutionStageType;
  approvalsNeeded: 1;
  participants: TaskExecutionStageParticipant[];
}

export interface TaskExecutionMonitorPolicy {
  nextCheckAt: string;
  notes: string | null;
  scheduledBy: TaskMonitorScheduledBy;
  kind?: TaskExecutionMonitorKind | null;
  serviceName?: string | null;
  externalRef?: string | null;
  timeoutAt?: string | null;
  maxAttempts?: number | null;
  recoveryPolicy?: TaskExecutionMonitorRecoveryPolicy | null;
}

export interface TaskExecutionPolicy {
  mode: TaskExecutionPolicyMode;
  commentRequired: boolean;
  stages: TaskExecutionStage[];
  monitor?: TaskExecutionMonitorPolicy | null;
  reviewPreset?: LowTrustReviewPresetPolicy;
  authorizationPolicy?: TrustAuthorizationPolicy;
}

export interface TaskReviewRequest {
  instructions: string;
}

export interface TaskExecutionMonitorState {
  status: TaskExecutionMonitorStateStatus;
  nextCheckAt: string | null;
  lastTriggeredAt: string | null;
  attemptCount: number;
  notes: string | null;
  scheduledBy: TaskMonitorScheduledBy | null;
  kind?: TaskExecutionMonitorKind | null;
  serviceName?: string | null;
  externalRef?: string | null;
  timeoutAt?: string | null;
  maxAttempts?: number | null;
  recoveryPolicy?: TaskExecutionMonitorRecoveryPolicy | null;
  clearedAt: string | null;
  clearReason: TaskExecutionMonitorClearReason | null;
}

export interface TaskExecutionState {
  status: TaskExecutionStateStatus;
  currentStageId: string | null;
  currentStageIndex: number | null;
  currentStageType: TaskExecutionStageType | null;
  currentParticipant: TaskExecutionStagePrincipal | null;
  returnOwner: TaskExecutionStagePrincipal | null;
  reviewRequest: TaskReviewRequest | null;
  completedStageIds: string[];
  lastDecisionId: string | null;
  lastDecisionOutcome: TaskExecutionDecisionOutcome | null;
  monitor?: TaskExecutionMonitorState | null;
}

export interface TaskExecutionDecision {
  id: string;
  companyId: string;
  taskId: string;
  stageId: string;
  stageType: TaskExecutionStageType;
  actorAgentId: string | null;
  actorUserId: string | null;
  outcome: TaskExecutionDecisionOutcome;
  body: string;
  createdByRunId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface TaskBase {
  id: string;
  companyId: string;
  projectId: string | null;
  projectWorkspaceId: string | null;
  goalId: string | null;
  parentId: string | null;
  ancestors?: TaskAncestor[];
  title: string | null;
  request: string;
  lifecycleStatus: AgentVisibleTaskStatus;
  boardPresentationStatus: TaskStatus;
  disposition?: TaskDisposition | null;
  workMode: TaskWorkMode;
  priority: TaskPriority;
  ownershipEpoch: number;
  escalatedFromAffectedTaskId?: string | null;
  escalatedFromTriggeringRunId?: string | null;
  escalatedFromReason?: string | null;
  affectedOwnershipEpoch?: number | null;
  responsibleUserId: string | null;
  taskNumber: number | null;
  identifier: string | null;
  originKind?: TaskOriginKind;
  originId?: string | null;
  originRunId?: string | null;
  originFingerprint?: string | null;
  requestDepth: number;
  billingCode: string | null;
  executionPolicy?: TaskExecutionPolicy | null;
  executionState?: TaskExecutionState | null;
  monitorNextCheckAt?: Date | null;
  monitorLastTriggeredAt?: Date | null;
  monitorAttemptCount?: number;
  monitorNotes?: string | null;
  monitorScheduledBy?: TaskMonitorScheduledBy | null;
  startedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  hiddenAt: Date | null;
  sourceTrust?: SourceTrustMetadata | null;
  labelIds?: string[];
  labels?: TaskLabel[];
  blockedBy?: TaskRelationTaskSummary[];
  blocks?: TaskRelationTaskSummary[];
  blockerAttention?: TaskBlockerAttention;
  blockedInboxAttention?: TaskBlockedInboxAttention | null;
  liveDescendantCount?: number;
  relatedWork?: TaskRelatedWorkSummary;
  referencedTaskIdentifiers?: string[];
  planDocument?: TaskDocument | null;
  documentSummaries?: TaskDocumentSummary[];
  project?: Project | null;
  goal?: Goal | null;
  workProducts?: TaskWorkProduct[];
  mentionedProjects?: Project[];
  myLastTouchAt?: Date | null;
  lastExternalCommentAt?: Date | null;
  lastActivityAt?: Date | null;
  isUnreadForMe?: boolean;
  archivedAt?: Date | null;
  archivedByActorType?: "user" | "agent" | null;
  archivedByAgentId?: string | null;
  archivedByRunId?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Post-fence ordinary task aggregate. */
type CanonicalTaskOwner =
  | {
      ownerKind: "agent";
      ownerAgentId: string;
      ownerUserId: null;
      ownerAssignmentSource: null;
    }
  | {
      ownerKind: "user";
      ownerAgentId: null;
      ownerUserId: string;
      ownerAssignmentSource: "user_creator_withdrawal" | null;
    }
  | {
      ownerKind: "board";
      ownerAgentId: null;
      ownerUserId: null;
      ownerAssignmentSource: null;
    };

type CanonicalTaskCreator =
  | {
      creatorKind: "agent-execution";
      creatorAuthorityId: string;
      creatorAdapterConfigRevisionId: string;
      creatorUserId: null;
      creatorPluginInstallationId: null;
      creatorPluginKey: null;
      creatorCallbackKey: null;
      creatorCallbackVersion: null;
      creatorRoutineId: null;
      creatorRoutineDispatchId: null;
      creatorSystemSourceKind: null;
      creatorSystemSourceId: null;
    }
  | {
      creatorKind: "user/board";
      creatorAuthorityId: null;
      creatorAdapterConfigRevisionId: null;
      creatorUserId: string | null;
      creatorPluginInstallationId: null;
      creatorPluginKey: null;
      creatorCallbackKey: null;
      creatorCallbackVersion: null;
      creatorRoutineId: null;
      creatorRoutineDispatchId: null;
      creatorSystemSourceKind: null;
      creatorSystemSourceId: null;
    }
  | {
      creatorKind: "plugin";
      creatorAuthorityId: null;
      creatorAdapterConfigRevisionId: null;
      creatorUserId: null;
      creatorPluginInstallationId: string;
      creatorPluginKey: string;
      creatorCallbackKey: string;
      creatorCallbackVersion: string;
      creatorRoutineId: null;
      creatorRoutineDispatchId: null;
      creatorSystemSourceKind: null;
      creatorSystemSourceId: null;
    }
  | {
      creatorKind: "routine";
      creatorAuthorityId: null;
      creatorAdapterConfigRevisionId: null;
      creatorUserId: null;
      creatorPluginInstallationId: null;
      creatorPluginKey: null;
      creatorCallbackKey: null;
      creatorCallbackVersion: null;
      creatorRoutineId: string;
      creatorRoutineDispatchId: string;
      creatorSystemSourceKind: null;
      creatorSystemSourceId: null;
    }
  | {
      creatorKind: "system";
      creatorAuthorityId: null;
      creatorAdapterConfigRevisionId: null;
      creatorUserId: null;
      creatorPluginInstallationId: null;
      creatorPluginKey: null;
      creatorCallbackKey: null;
      creatorCallbackVersion: null;
      creatorRoutineId: null;
      creatorRoutineDispatchId: null;
      creatorSystemSourceKind: SystemCreatorSourceKind;
      creatorSystemSourceId: string;
    };

export type Task = TaskBase & CanonicalTaskOwner & CanonicalTaskCreator;
export type CanonicalTask = Task;

export type CompactTask = Pick<
  Task,
  | "id"
  | "companyId"
  | "projectId"
  | "projectWorkspaceId"
  | "goalId"
  | "parentId"
  | "title"
  | "request"
  | "boardPresentationStatus"
  | "lifecycleStatus"
  | "disposition"
  | "workMode"
  | "priority"
  | "ownerKind"
  | "ownerAgentId"
  | "ownerUserId"
  | "ownerAssignmentSource"
  | "ownershipEpoch"
  | "creatorKind"
  | "creatorAuthorityId"
  | "creatorAdapterConfigRevisionId"
  | "creatorUserId"
  | "creatorPluginInstallationId"
  | "creatorPluginKey"
  | "creatorCallbackKey"
  | "creatorCallbackVersion"
  | "creatorRoutineId"
  | "creatorRoutineDispatchId"
  | "creatorSystemSourceKind"
  | "creatorSystemSourceId"
  | "taskNumber"
  | "identifier"
  | "originKind"
  | "originId"
  | "originRunId"
  | "requestDepth"
  | "billingCode"
  | "startedAt"
  | "completedAt"
  | "cancelledAt"
  | "createdAt"
  | "updatedAt"
> & {
  labelIds?: string[];
  labels?: TaskLabel[];
  blockedBy?: TaskRelationTaskSummary[];
  blockerAttention?: TaskBlockerAttention;
  blockedInboxAttention?: TaskBlockedInboxAttention | null;
  liveDescendantCount?: number;
  myLastTouchAt?: Date | null;
  lastExternalCommentAt?: Date | null;
  lastActivityAt?: Date | null;
  isUnreadForMe?: boolean;
  archivedAt?: Date | null;
  archivedByActorType?: "user" | "agent" | null;
  archivedByAgentId?: string | null;
  archivedByRunId?: string | null;
};

export type TaskCommentCanonicalSourceKind =
  | "task_request"
  | "human_comment"
  | "harness_delivery"
  | "system_control"
  | "run_output"
  | "run_progress"
  | "task_update"
  | "plugin_withdrawal";

export interface TaskComment {
  id: string;
  companyId: string;
  taskId: string;
  authorType: TaskCommentAuthorType;
  authorAgentId: string | null;
  authorUserId: string | null;
  authorPluginInstallationId: string | null;
  authorPluginKey: string | null;
  runId: string | null;
  sessionId: string;
  canonicalSourceKind: TaskCommentCanonicalSourceKind;
  canonicalSourceId: string;
  canonicalMessageId: string;
  admittedEventSeq: number;
  promotedEventSeq: number | null;
  projectedEventSeq: number;
  replyToCommentId: string | null;
  replyToProjectedEventSeq: number | null;
  threadRootCommentId: string | null;
  threadRootProjectedEventSeq: number | null;
  body: string;
  presentation: TaskCommentPresentation | null;
  metadata: TaskCommentMetadata | null;
  sourceTrust?: SourceTrustMetadata | null;
  followUpRequested?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Board-safe author projection. Plugin installation ids and every Session or
 * provider-native selector intentionally stay server-side.
 */
export interface BoardTaskCommentAuthor {
  type: TaskCommentAuthorType;
  label: string;
  agentId: string | null;
  userId: string | null;
  pluginKey: string | null;
}

/** Display-only reply context; none of these fields is a selector. */
export interface BoardTaskCommentParentReference {
  authorLabel: string;
  excerpt: string;
}

export type BoardTaskCommentRunState = "queued" | "working" | "terminal";

/**
 * Closed board projection of a persisted task comment. Storage correlation
 * tuples (`sessionId`, root ids/sequences, source ids, and producing run ids)
 * are deliberately absent.
 */
export interface BoardTaskComment {
  id: string;
  author: BoardTaskCommentAuthor;
  body: string;
  presentation: TaskCommentPresentation | null;
  metadata: TaskCommentMetadata | null;
  sourceTrust: SourceTrustMetadata | null;
  runState: BoardTaskCommentRunState | null;
  canonicalSequence: number;
  immediateParentDisplayReference: BoardTaskCommentParentReference | null;
  createdAt: Date;
  updatedAt: Date;
}

export type BoardTaskRunSegmentPart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | {
      type: "tool";
      name: string;
      status: "pending" | "running" | "completed" | "error";
    };

/** Read-only projection of one canonical Session assistant message. */
export interface BoardTaskRunSegmentEntry {
  kind: "run_segment";
  id: string;
  author: BoardTaskCommentAuthor;
  parts: BoardTaskRunSegmentPart[];
  status: "working" | "complete" | "error";
  canonicalSequence: number;
  immediateParentDisplayReference: BoardTaskCommentParentReference | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface BoardTaskCommentEntry extends BoardTaskComment {
  kind: "comment";
}

export type BoardTaskThreadEntry =
  | BoardTaskCommentEntry
  | BoardTaskRunSegmentEntry;

export interface BoardTaskCommentGroup {
  root: BoardTaskComment;
  replyCount: number;
  runSegmentCount: number;
  entries: BoardTaskThreadEntry[];
  entriesNextCursor: string | null;
}

export interface BoardTaskCommentGroupPage {
  groups: BoardTaskCommentGroup[];
  nextCursor: string | null;
}

export interface BoardTaskCommentThreadPage {
  entries: BoardTaskThreadEntry[];
  nextCursor: string | null;
}

interface TaskCommentMetadataRowBase {
  type: TaskCommentMetadataRowType;
  label?: string | null;
}

export interface TaskCommentMetadataTextRow extends TaskCommentMetadataRowBase {
  type: "text";
  text: string;
}

export interface TaskCommentMetadataCodeRow extends TaskCommentMetadataRowBase {
  type: "code";
  code: string;
  language?: string | null;
}

export interface TaskCommentMetadataKeyValueRow extends TaskCommentMetadataRowBase {
  type: "key_value";
  label: string;
  value: string;
}

export interface TaskCommentMetadataTaskLinkRow extends TaskCommentMetadataRowBase {
  type: "task_link";
  taskId?: string | null;
  identifier?: string | null;
  title?: string | null;
}

export interface TaskCommentMetadataAgentLinkRow extends TaskCommentMetadataRowBase {
  type: "agent_link";
  agentId: string;
  name?: string | null;
}

export interface TaskCommentMetadataRunLinkRow extends TaskCommentMetadataRowBase {
  type: "run_link";
  runId: string;
  title?: string | null;
}

export type TaskCommentMetadataRow =
  | TaskCommentMetadataTextRow
  | TaskCommentMetadataCodeRow
  | TaskCommentMetadataKeyValueRow
  | TaskCommentMetadataTaskLinkRow
  | TaskCommentMetadataAgentLinkRow
  | TaskCommentMetadataRunLinkRow;

export interface TaskCommentMetadataSection {
  title?: string | null;
  rows: TaskCommentMetadataRow[];
}

export interface TaskCommentMetadata {
  version: 1;
  sourceRunId?: string | null;
  sections: TaskCommentMetadataSection[];
}

export interface TaskCommentPresentation {
  kind: TaskCommentPresentationKind;
  tone: TaskCommentPresentationTone;
  title?: string | null;
  detailsDefaultOpen: boolean;
}

export interface TaskAttachment {
  id: string;
  companyId: string;
  taskId: string;
  taskCommentId: string | null;
  assetId: string;
  provider: string;
  objectKey: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  originalFilename: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
  contentPath: string;
  openPath?: string;
  downloadPath?: string;
}
