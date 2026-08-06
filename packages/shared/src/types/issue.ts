import type {
  IssueCommentAuthorType,
  IssueCommentMetadataRowType,
  IssueCommentPresentationKind,
  IssueCommentPresentationTone,
  IssueExecutionMonitorClearReason,
  IssueExecutionMonitorKind,
  IssueExecutionMonitorRecoveryPolicy,
  IssueExecutionMonitorStateStatus,
  IssueExecutionDecisionOutcome,
  IssueMonitorScheduledBy,
  IssueExecutionPolicyMode,
  IssueReferenceSourceKind,
  IssueExecutionStageType,
  IssueExecutionStateStatus,
  IssueOriginKind,
  IssuePriority,
  IssueWorkMode,
  IssueStatus,
} from "../constants.js";
import type { Goal } from "./goal.js";
import type { Project, ProjectWorkspace } from "./project.js";
import type { ExecutionWorkspace, IssueExecutionWorkspaceSettings } from "./workspace-runtime.js";
import type { IssueWorkProduct } from "./work-product.js";
import type {
  LowTrustReviewPresetPolicy,
  SourceTrustMetadata,
  TrustAuthorizationPolicy,
} from "../trust-policy.js";
import type {
  AgentVisibleIssueStatus,
  ContextAccess,
  IssueDisposition,
  SystemCreatorSourceKind,
} from "../issue-runtime.js";

export type { IssueWorkMode };

export interface IssueAncestorProject {
  id: string;
  name: string;
  description: string | null;
  status: string;
  goalId: string | null;
  workspaces: ProjectWorkspace[];
  primaryWorkspace: ProjectWorkspace | null;
}

export interface IssueAncestorGoal {
  id: string;
  title: string;
  description: string | null;
  level: string;
  status: string;
}

export interface IssueAncestor {
  id: string;
  identifier: string | null;
  title: string | null;
  request: string;
  boardPresentationStatus: IssueStatus;
  priority: string;
  ownerAgentId: string | null;
  ownerUserId: string | null;
  projectId: string | null;
  goalId: string | null;
  project: IssueAncestorProject | null;
  goal: IssueAncestorGoal | null;
}

export interface IssueLabel {
  id: string;
  companyId: string;
  name: string;
  color: string;
  createdAt: Date;
  updatedAt: Date;
}

export type DocumentFormat = "markdown";

export interface IssueDocumentSummary {
  id: string;
  companyId: string;
  issueId: string;
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

export interface IssueDocument extends IssueDocumentSummary {
  body: string;
}

export interface DocumentRevision {
  id: string;
  companyId: string;
  documentId: string;
  issueId: string;
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

export interface IssueRelationIssueSummary {
  id: string;
  identifier: string | null;
  title: string | null;
  boardPresentationStatus: IssueStatus;
  priority: IssuePriority;
  ownerAgentId: string | null;
  ownerUserId: string | null;
  terminalBlockers?: IssueRelationIssueSummary[];
}

export type IssueBlockerDiagnosticFlag =
  | "done_but_blocking"
  | "cancelled_blocker_in_set"
  | "workspace_finalize_pending";

export interface IssueBlockerDiagnosticIssueSummary {
  id: string;
  identifier: string | null;
  title: string | null;
  boardPresentationStatus: IssueStatus;
  priority: IssuePriority;
  ownerAgentId: string | null;
  ownerUserId: string | null;
}

export interface IssueBlockerDiagnosticNode extends IssueBlockerDiagnosticIssueSummary {
  isUnresolved: boolean;
  isDependencyReady: boolean;
  isPendingFinalize: boolean;
  flags: IssueBlockerDiagnosticFlag[];
}

export interface IssueBlockerDiagnosticsReadiness {
  allBlockersDone: boolean;
  isDependencyReady: boolean;
  unresolvedBlockerCount: number;
  pendingFinalizeBlockerCount: number;
}

export interface IssueBlockerDiagnosticsResponse {
  issue: IssueBlockerDiagnosticIssueSummary;
  diagnosis: string | null;
  readiness: IssueBlockerDiagnosticsReadiness | null;
  blockers: IssueBlockerDiagnosticNode[];
  omittedUnauthorizedBlockerCount: number | null;
  truncated: boolean;
  caps: {
    maxBlockers: number;
  };
}

export interface IssueSubtreeDiagnosticNode {
  issue: IssueBlockerDiagnosticIssueSummary;
  parentId: string | null;
  depth: number;
  diagnosis: string | null;
  likelyReason: string | null;
  blockers: IssueBlockerDiagnosticNode[];
  blockerReadiness: IssueBlockerDiagnosticsReadiness | null;
  omittedUnauthorizedBlockerCount: number | null;
  truncated: boolean;
  truncatedSections: {
    blockers: boolean;
  };
}

export type IssueSubtreeDiagnosticEdge =
  | {
    kind: "parent";
    fromIssueId: string;
    toIssueId: string;
    timestamp: string | null;
  }
  | {
    kind: "blocks";
    fromIssueId: string;
    toIssueId: string;
    timestamp: string | null;
  };

export interface IssueSubtreeDiagnosticsResponse {
  issue: IssueBlockerDiagnosticIssueSummary;
  diagnosis: string | null;
  likelyReason: string | null;
  nodes: IssueSubtreeDiagnosticNode[];
  edges: IssueSubtreeDiagnosticEdge[];
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

export type IssueBlockerAttentionState = "none" | "covered" | "stalled" | "needs_attention";

export type IssueBlockerAttentionReason =
  | "active_child"
  | "active_dependency"
  | "stalled_review"
  | "attention_required"
  | null;

export interface IssueBlockerAttention {
  state: IssueBlockerAttentionState;
  reason: IssueBlockerAttentionReason;
  unresolvedBlockerCount: number;
  coveredBlockerCount: number;
  stalledBlockerCount: number;
  attentionBlockerCount: number;
  sampleBlockerIdentifier: string | null;
  sampleStalledBlockerIdentifier: string | null;
}

export type IssueInboxAttentionKind = "blocked";

export type IssueBlockedInboxState =
  | "needs_attention"
  | "awaiting_decision"
  | "external_wait";

export type IssueBlockedInboxSeverity = "critical" | "high" | "medium" | "low";

export type IssueBlockedInboxReason =
  | "blocked_chain_stalled"
  | "pending_board_decision"
  | "pending_user_decision"
  | "external_owner_action";

export type IssueBlockedInboxOwnerType = "agent" | "user" | "board" | "external" | "unknown";

export interface IssueBlockedInboxIssueRef {
  id: string;
  identifier: string | null;
  title: string | null;
  boardPresentationStatus: IssueStatus;
  priority: IssuePriority;
  ownerAgentId: string | null;
  ownerUserId: string | null;
}

export interface IssueBlockedInboxOwner {
  type: IssueBlockedInboxOwnerType;
  agentId: string | null;
  userId: string | null;
  label: string | null;
}

export interface IssueBlockedInboxAction {
  label: string;
  detail: string | null;
}

export interface IssueBlockedInboxAttention {
  kind: IssueInboxAttentionKind;
  state: IssueBlockedInboxState;
  reason: IssueBlockedInboxReason;
  severity: IssueBlockedInboxSeverity;
  stoppedSinceAt: string | null;
  owner: IssueBlockedInboxOwner;
  action: IssueBlockedInboxAction;
  sourceIssue: IssueBlockedInboxIssueRef | null;
  leafIssue: IssueBlockedInboxIssueRef | null;
  approvalId: string | null;
  sampleIssueIdentifier: string | null;
  redaction: {
    externalDetailsRedacted: boolean;
    secretFieldsOmitted: true;
  };
}

export interface IssueRelation {
  id: string;
  companyId: string;
  issueId: string;
  relatedIssueId: string;
  type: "blocks";
  relatedIssue: IssueRelationIssueSummary;
}

export interface IssueReferenceSource {
  kind: IssueReferenceSourceKind;
  sourceRecordId: string | null;
  label: string;
  matchedText: string | null;
}

export interface IssueRelatedWorkItem {
  issue: IssueRelationIssueSummary;
  mentionCount: number;
  sources: IssueReferenceSource[];
}

export interface IssueRelatedWorkSummary {
  outbound: IssueRelatedWorkItem[];
  inbound: IssueRelatedWorkItem[];
}

export interface IssueExecutionStagePrincipal {
  type: "agent" | "user";
  agentId?: string | null;
  userId?: string | null;
}

export interface IssueExecutionStageParticipant extends IssueExecutionStagePrincipal {
  id: string;
}

export interface IssueExecutionStage {
  id: string;
  type: IssueExecutionStageType;
  approvalsNeeded: 1;
  participants: IssueExecutionStageParticipant[];
}

export interface IssueExecutionMonitorPolicy {
  nextCheckAt: string;
  notes: string | null;
  scheduledBy: IssueMonitorScheduledBy;
  kind?: IssueExecutionMonitorKind | null;
  serviceName?: string | null;
  externalRef?: string | null;
  timeoutAt?: string | null;
  maxAttempts?: number | null;
  recoveryPolicy?: IssueExecutionMonitorRecoveryPolicy | null;
}

export interface IssueExecutionPolicy {
  mode: IssueExecutionPolicyMode;
  commentRequired: boolean;
  stages: IssueExecutionStage[];
  monitor?: IssueExecutionMonitorPolicy | null;
  reviewPreset?: LowTrustReviewPresetPolicy;
  authorizationPolicy?: TrustAuthorizationPolicy;
}

export interface IssueExecutionMonitorState {
  status: IssueExecutionMonitorStateStatus;
  nextCheckAt: string | null;
  lastTriggeredAt: string | null;
  attemptCount: number;
  notes: string | null;
  scheduledBy: IssueMonitorScheduledBy | null;
  kind?: IssueExecutionMonitorKind | null;
  serviceName?: string | null;
  externalRef?: string | null;
  timeoutAt?: string | null;
  maxAttempts?: number | null;
  recoveryPolicy?: IssueExecutionMonitorRecoveryPolicy | null;
  clearedAt: string | null;
  clearReason: IssueExecutionMonitorClearReason | null;
}

export interface IssueReviewRequest {
  instructions: string;
}

export interface IssueExecutionState {
  status: IssueExecutionStateStatus;
  currentStageId: string | null;
  currentStageIndex: number | null;
  currentStageType: IssueExecutionStageType | null;
  currentParticipant: IssueExecutionStagePrincipal | null;
  returnOwner: IssueExecutionStagePrincipal | null;
  reviewRequest: IssueReviewRequest | null;
  completedStageIds: string[];
  lastDecisionId: string | null;
  lastDecisionOutcome: IssueExecutionDecisionOutcome | null;
  monitor?: IssueExecutionMonitorState | null;
}

export interface IssueExecutionDecision {
  id: string;
  companyId: string;
  issueId: string;
  stageId: string;
  stageType: IssueExecutionStageType;
  actorAgentId: string | null;
  actorUserId: string | null;
  outcome: IssueExecutionDecisionOutcome;
  body: string;
  createdByRunId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type IssueWatchdogStatus = "active" | "disabled";

export interface IssueWatchdog {
  id: string;
  companyId: string;
  issueId: string;
  status: IssueWatchdogStatus;
  lastObservedFingerprint: string | null;
  lastTriggeredAt: Date | null;
  triggerCount: number;
  createdAt: Date;
  updatedAt: Date;
}

interface IssueBase {
  id: string;
  companyId: string;
  projectId: string | null;
  projectWorkspaceId: string | null;
  goalId: string | null;
  parentId: string | null;
  ancestors?: IssueAncestor[];
  title: string | null;
  request: string;
  lifecycleStatus: AgentVisibleIssueStatus;
  boardPresentationStatus: IssueStatus;
  disposition?: IssueDisposition | null;
  workMode: IssueWorkMode;
  priority: IssuePriority;
  ownershipEpoch: number;
  contextAccessMask?: ContextAccess | null;
  escalatedFromAffectedIssueId?: string | null;
  escalatedFromTriggeringRunId?: string | null;
  escalatedFromReason?: string | null;
  affectedOwnershipEpoch?: number | null;
  responsibleUserId: string | null;
  issueNumber: number | null;
  identifier: string | null;
  originKind?: IssueOriginKind;
  originId?: string | null;
  originRunId?: string | null;
  originFingerprint?: string | null;
  requestDepth: number;
  billingCode: string | null;
  executionPolicy?: IssueExecutionPolicy | null;
  executionState?: IssueExecutionState | null;
  monitorNextCheckAt?: Date | null;
  monitorLastTriggeredAt?: Date | null;
  monitorAttemptCount?: number;
  monitorNotes?: string | null;
  monitorScheduledBy?: IssueMonitorScheduledBy | null;
  executionWorkspacePreference: string | null;
  executionWorkspaceSettings: IssueExecutionWorkspaceSettings | null;
  startedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  hiddenAt: Date | null;
  sourceTrust?: SourceTrustMetadata | null;
  labelIds?: string[];
  labels?: IssueLabel[];
  blockedBy?: IssueRelationIssueSummary[];
  blocks?: IssueRelationIssueSummary[];
  blockerAttention?: IssueBlockerAttention;
  blockedInboxAttention?: IssueBlockedInboxAttention | null;
  watchdog?: IssueWatchdog | null;
  liveDescendantCount?: number;
  relatedWork?: IssueRelatedWorkSummary;
  referencedIssueIdentifiers?: string[];
  planDocument?: IssueDocument | null;
  documentSummaries?: IssueDocumentSummary[];
  project?: Project | null;
  goal?: Goal | null;
  currentExecutionWorkspace?: ExecutionWorkspace | null;
  workProducts?: IssueWorkProduct[];
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

/** Post-fence ordinary issue aggregate. */
type CanonicalIssueOwner =
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

type CanonicalIssueCreator =
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

export type Issue = IssueBase & CanonicalIssueOwner & CanonicalIssueCreator;
export type CanonicalIssue = Issue;

export type CompactIssue = Pick<
  Issue,
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
  | "issueNumber"
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
  labels?: IssueLabel[];
  blockedBy?: IssueRelationIssueSummary[];
  blockerAttention?: IssueBlockerAttention;
  blockedInboxAttention?: IssueBlockedInboxAttention | null;
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

export type IssueCommentCanonicalSourceKind =
  | "issue_request"
  | "human_comment"
  | "harness_delivery"
  | "system_control"
  | "run_output"
  | "run_progress"
  | "issue_update"
  | "plugin_withdrawal";

export interface IssueComment {
  id: string;
  companyId: string;
  issueId: string;
  authorType: IssueCommentAuthorType;
  authorAgentId: string | null;
  authorUserId: string | null;
  authorPluginInstallationId: string | null;
  authorPluginKey: string | null;
  runId: string | null;
  sessionId: string;
  canonicalSourceKind: IssueCommentCanonicalSourceKind;
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
  presentation: IssueCommentPresentation | null;
  metadata: IssueCommentMetadata | null;
  sourceTrust?: SourceTrustMetadata | null;
  followUpRequested?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Board-safe author projection. Plugin installation ids and every Session or
 * provider-native selector intentionally stay server-side.
 */
export interface BoardIssueCommentAuthor {
  type: IssueCommentAuthorType;
  label: string;
  agentId: string | null;
  userId: string | null;
  pluginKey: string | null;
}

/** Display-only reply context; none of these fields is a selector. */
export interface BoardIssueCommentParentReference {
  authorLabel: string;
  excerpt: string;
}

export type BoardIssueCommentRunState = "queued" | "working" | "terminal";

/**
 * Closed board projection of a persisted issue comment. Storage correlation
 * tuples (`sessionId`, root ids/sequences, source ids, and producing run ids)
 * are deliberately absent.
 */
export interface BoardIssueComment {
  id: string;
  author: BoardIssueCommentAuthor;
  body: string;
  presentation: IssueCommentPresentation | null;
  metadata: IssueCommentMetadata | null;
  sourceTrust: SourceTrustMetadata | null;
  runState: BoardIssueCommentRunState | null;
  canonicalSequence: number;
  immediateParentDisplayReference: BoardIssueCommentParentReference | null;
  createdAt: Date;
  updatedAt: Date;
}

export type BoardIssueRunSegmentPart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | {
      type: "tool";
      name: string;
      status: "pending" | "running" | "completed" | "error";
    };

/** Read-only projection of one canonical Session assistant message. */
export interface BoardIssueRunSegmentEntry {
  kind: "run_segment";
  id: string;
  author: BoardIssueCommentAuthor;
  parts: BoardIssueRunSegmentPart[];
  status: "working" | "complete" | "error";
  canonicalSequence: number;
  immediateParentDisplayReference: BoardIssueCommentParentReference | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface BoardIssueCommentEntry extends BoardIssueComment {
  kind: "comment";
}

export type BoardIssueThreadEntry =
  | BoardIssueCommentEntry
  | BoardIssueRunSegmentEntry;

export interface BoardIssueCommentGroup {
  root: BoardIssueComment;
  replyCount: number;
  runSegmentCount: number;
  entries: BoardIssueThreadEntry[];
  entriesNextCursor: string | null;
}

export interface BoardIssueCommentGroupPage {
  groups: BoardIssueCommentGroup[];
  nextCursor: string | null;
}

export interface BoardIssueCommentThreadPage {
  entries: BoardIssueThreadEntry[];
  nextCursor: string | null;
}

interface IssueCommentMetadataRowBase {
  type: IssueCommentMetadataRowType;
  label?: string | null;
}

export interface IssueCommentMetadataTextRow extends IssueCommentMetadataRowBase {
  type: "text";
  text: string;
}

export interface IssueCommentMetadataCodeRow extends IssueCommentMetadataRowBase {
  type: "code";
  code: string;
  language?: string | null;
}

export interface IssueCommentMetadataKeyValueRow extends IssueCommentMetadataRowBase {
  type: "key_value";
  label: string;
  value: string;
}

export interface IssueCommentMetadataIssueLinkRow extends IssueCommentMetadataRowBase {
  type: "issue_link";
  issueId?: string | null;
  identifier?: string | null;
  title?: string | null;
}

export interface IssueCommentMetadataAgentLinkRow extends IssueCommentMetadataRowBase {
  type: "agent_link";
  agentId: string;
  name?: string | null;
}

export interface IssueCommentMetadataRunLinkRow extends IssueCommentMetadataRowBase {
  type: "run_link";
  runId: string;
  title?: string | null;
}

export type IssueCommentMetadataRow =
  | IssueCommentMetadataTextRow
  | IssueCommentMetadataCodeRow
  | IssueCommentMetadataKeyValueRow
  | IssueCommentMetadataIssueLinkRow
  | IssueCommentMetadataAgentLinkRow
  | IssueCommentMetadataRunLinkRow;

export interface IssueCommentMetadataSection {
  title?: string | null;
  rows: IssueCommentMetadataRow[];
}

export interface IssueCommentMetadata {
  version: 1;
  sourceRunId?: string | null;
  sections: IssueCommentMetadataSection[];
}

export interface IssueCommentPresentation {
  kind: IssueCommentPresentationKind;
  tone: IssueCommentPresentationTone;
  title?: string | null;
  detailsDefaultOpen: boolean;
}

export interface IssueAttachment {
  id: string;
  companyId: string;
  issueId: string;
  issueCommentId: string | null;
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
