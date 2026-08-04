import type {
  Approval,
  BoardIssueComment,
  BoardIssueCommentGroupPage,
  BoardIssueCommentThreadPage,
  CompactIssue,
  CommitIssueCreatorForm,
  CommitIssueOwnerForm,
  CreateIssue,
  CreateIssueUserComment,
  CreateIssueTreeHold,
  DocumentRevision,
  FeedbackTargetType,
  FeedbackTrace,
  FeedbackVote,
  Issue,
  IssueAttachment,
  IssueCostSummary,
  IssueComment,
  IssueExecutionDecision,
  IssueBoardReopenDispatch,
  IssueDocument,
  IssueLabel,
  IssueTreeControlPreview,
  IssueTreeHold,
  IssueWatchdog,
  IssueWorkProduct,
  PreviewIssueTreeControl,
  ReassignIssue,
  ReleaseIssueTreeHold,
  ReopenIssue,
  SelfAssignIssueWithdrawal,
  UpdateIssueExecutionPolicy,
  DecideIssueExecutionStage,
  UpdateIssueTitle,
  UpsertIssueWatchdog,
  UpsertIssueDocument,
} from "@paperclipai/shared";
import { api, type RequestOptions } from "./client";

type IssueExecutionRefSummary = {
  id: string;
  [key: string]: unknown;
};

export type IssueReassignmentResponse = {
  issue: Issue;
  ref: IssueExecutionRefSummary;
  retried: boolean;
};

export type IssueFormCommitResponse = {
  update: Record<string, unknown>;
  comment: IssueComment;
  delivery: Record<string, unknown>;
  ref: IssueExecutionRefSummary | null;
  retried: boolean;
};

export type IssueWithdrawalSelfAssignmentResponse = {
  issue: Issue;
  auditId: string;
  retried: boolean;
};

export type IssueReopenResponse = {
  issue: Issue;
  edge: Record<string, unknown>;
  command: Record<string, unknown>;
  dispatch: IssueBoardReopenDispatch;
  retried: boolean;
};

export type IssueUserCommentResponse = {
  comment: BoardIssueComment;
  retried: boolean;
};

export type IssueExecutionPolicyDecisionResponse = {
  issue: Issue;
  decision: IssueExecutionDecision;
  retried: boolean;
};

export type IssueListFilters = {
  attention?: "blocked";
  status?: string;
  projectId?: string;
  parentId?: string;
  ownerAgentId?: string;
  participantAgentId?: string;
  ownerUserId?: string;
  touchedByUserId?: string;
  inboxArchivedByUserId?: string;
  unreadForUserId?: string;
  labelId?: string;
  workspaceId?: string;
  executionWorkspaceId?: string;
  originKind?: string;
  originKindPrefix?: string;
  originId?: string;
  descendantOf?: string;
  includeRoutineExecutions?: boolean;
  includeBlockedBy?: boolean;
  includeBlockedInboxAttention?: boolean;
  includeLiveDescendantSummary?: boolean;
  hasPlanDocument?: boolean;
  q?: string;
  limit?: number;
  offset?: number;
  sortField?: "updated";
  sortDir?: "asc" | "desc";
};

function issueListSearchParams(filters?: IssueListFilters) {
  const params = new URLSearchParams();
  if (filters?.attention) params.set("attention", filters.attention);
  if (filters?.status) params.set("status", filters.status);
  if (filters?.projectId) params.set("projectId", filters.projectId);
  if (filters?.parentId) params.set("parentId", filters.parentId);
  if (filters?.ownerAgentId) params.set("ownerAgentId", filters.ownerAgentId);
  if (filters?.participantAgentId) params.set("participantAgentId", filters.participantAgentId);
  if (filters?.ownerUserId) params.set("ownerUserId", filters.ownerUserId);
  if (filters?.touchedByUserId) params.set("touchedByUserId", filters.touchedByUserId);
  if (filters?.inboxArchivedByUserId) params.set("inboxArchivedByUserId", filters.inboxArchivedByUserId);
  if (filters?.unreadForUserId) params.set("unreadForUserId", filters.unreadForUserId);
  if (filters?.labelId) params.set("labelId", filters.labelId);
  if (filters?.workspaceId) params.set("workspaceId", filters.workspaceId);
  if (filters?.executionWorkspaceId) params.set("executionWorkspaceId", filters.executionWorkspaceId);
  if (filters?.originKind) params.set("originKind", filters.originKind);
  if (filters?.originKindPrefix) params.set("originKindPrefix", filters.originKindPrefix);
  if (filters?.originId) params.set("originId", filters.originId);
  if (filters?.descendantOf) params.set("descendantOf", filters.descendantOf);
  if (filters?.includeRoutineExecutions) params.set("includeRoutineExecutions", "true");
  if (filters?.includeBlockedBy) params.set("includeBlockedBy", "true");
  if (filters?.includeBlockedInboxAttention) params.set("includeBlockedInboxAttention", "true");
  if (filters?.includeLiveDescendantSummary) params.set("includeLiveDescendantSummary", "true");
  if (filters?.hasPlanDocument !== undefined) {
    params.set("hasPlanDocument", filters.hasPlanDocument ? "true" : "false");
  }
  if (filters?.q) params.set("q", filters.q);
  if (filters?.limit) params.set("limit", String(filters.limit));
  if (filters?.offset !== undefined) params.set("offset", String(filters.offset));
  if (filters?.sortField) params.set("sortField", filters.sortField);
  if (filters?.sortDir) params.set("sortDir", filters.sortDir);
  return params;
}

export const issuesApi = {
  list: (
    companyId: string,
    filters?: IssueListFilters,
    options?: RequestOptions,
  ) => {
    const params = issueListSearchParams(filters);
    const qs = params.toString();
    const path = `/companies/${companyId}/issues${qs ? `?${qs}` : ""}`;
    return options ? api.get<Issue[]>(path, options) : api.get<Issue[]>(path);
  },
  listCompact: (companyId: string, filters?: IssueListFilters, options?: RequestOptions) => {
    const params = issueListSearchParams(filters);
    params.set("view", "compact");
    const path = `/companies/${companyId}/issues?${params.toString()}`;
    return options ? api.get<CompactIssue[]>(path, options) : api.get<CompactIssue[]>(path);
  },
  count: (
    companyId: string,
    filters: {
      attention: "blocked";
      status?: string;
      ownerAgentId?: string;
      ownerUserId?: string;
      projectId?: string;
      labelId?: string;
      q?: string;
    },
  ) => {
    const params = new URLSearchParams();
    params.set("attention", filters.attention);
    if (filters.status) params.set("status", filters.status);
    if (filters.ownerAgentId) params.set("ownerAgentId", filters.ownerAgentId);
    if (filters.ownerUserId) params.set("ownerUserId", filters.ownerUserId);
    if (filters.projectId) params.set("projectId", filters.projectId);
    if (filters.labelId) params.set("labelId", filters.labelId);
    if (filters.q) params.set("q", filters.q);
    return api.get<{ count: number }>(`/companies/${companyId}/issues/count?${params.toString()}`);
  },
  listLabels: (companyId: string) => api.get<IssueLabel[]>(`/companies/${companyId}/labels`),
  createLabel: (companyId: string, data: { name: string; color: string }) =>
    api.post<IssueLabel>(`/companies/${companyId}/labels`, data),
  deleteLabel: (id: string) => api.delete<IssueLabel>(`/labels/${id}`),
  get: (id: string, options?: RequestOptions) => options
    ? api.get<Issue>(`/issues/${id}`, options)
    : api.get<Issue>(`/issues/${id}`),
  getWatchdog: (id: string) => api.get<IssueWatchdog | null>(`/issues/${id}/watchdog`),
  upsertWatchdog: (id: string, data: UpsertIssueWatchdog) =>
    api.put<IssueWatchdog>(`/issues/${id}/watchdog`, data),
  deleteWatchdog: (id: string) => api.delete<{ ok: true }>(`/issues/${id}/watchdog`),
  markRead: (id: string) => api.post<{ id: string; lastReadAt: Date }>(`/issues/${id}/read`, {}),
  markUnread: (id: string) => api.delete<{ id: string; removed: boolean }>(`/issues/${id}/read`),
  archiveFromInbox: (id: string) =>
    api.post<{ id: string; archivedAt: Date }>(`/issues/${id}/inbox-archive`, {}),
  unarchiveFromInbox: (id: string) =>
    api.delete<{ id: string; archivedAt: Date } | { ok: true }>(`/issues/${id}/inbox-archive`),
  create: (companyId: string, data: CreateIssue) =>
    api.post<Issue>(`/companies/${companyId}/issues`, data),
  updateTitle: (id: string, data: UpdateIssueTitle) =>
    api.patch<Issue>(`/issues/${id}`, data),
  updateExecutionPolicy: (
    id: string,
    data: UpdateIssueExecutionPolicy,
  ) =>
    api.put<Issue>(`/issues/${id}/execution-policy`, data),
  decideExecutionStage: (
    id: string,
    data: DecideIssueExecutionStage,
  ) =>
    api.post<IssueExecutionPolicyDecisionResponse>(
      `/issues/${id}/execution-policy/decisions`,
      data,
    ),
  reassign: (id: string, data: ReassignIssue) =>
    api.post<IssueReassignmentResponse>(`/issues/${id}/reassign`, data),
  creatorReassign: (id: string, data: ReassignIssue) =>
    api.post<IssueReassignmentResponse>(
      `/issues/${id}/creator-reassign`,
      data,
    ),
  commitCreatorFormUpdate: (data: CommitIssueCreatorForm) =>
    api.post<IssueFormCommitResponse>(
      "/issue-creator-form-updates",
      data,
    ),
  commitOwnerFormUpdate: (data: CommitIssueOwnerForm) =>
    api.post<IssueFormCommitResponse>(
      "/issue-owner-form-updates",
      data,
    ),
  selfAssignForWithdrawal: (
    id: string,
    data: SelfAssignIssueWithdrawal,
  ) =>
    api.post<IssueWithdrawalSelfAssignmentResponse>(
      `/issues/${id}/withdrawal-self-assignment`,
      data,
    ),
  reopen: (id: string, data: ReopenIssue) =>
    api.post<IssueReopenResponse>(`/issues/${id}/reopen`, data),
  previewTreeControl: (id: string, data: PreviewIssueTreeControl) =>
    api.post<IssueTreeControlPreview>(`/issues/${id}/tree-control/preview`, data),
  createTreeHold: (id: string, data: CreateIssueTreeHold) =>
    api.post<{ hold: IssueTreeHold; preview: IssueTreeControlPreview }>(`/issues/${id}/tree-holds`, data),
  getTreeHold: (id: string, holdId: string) =>
    api.get<IssueTreeHold>(`/issues/${id}/tree-holds/${holdId}`),
  listTreeHolds: (
    id: string,
    filters?: {
      status?: "active" | "released";
      mode?: "pause" | "resume" | "cancel" | "restore";
      includeMembers?: boolean;
    },
  ) => {
    const params = new URLSearchParams();
    if (filters?.status) params.set("status", filters.status);
    if (filters?.mode) params.set("mode", filters.mode);
    if (filters?.includeMembers) params.set("includeMembers", "true");
    const qs = params.toString();
    return api.get<IssueTreeHold[]>(`/issues/${id}/tree-holds${qs ? `?${qs}` : ""}`);
  },
  getTreeControlState: (id: string) =>
    api.get<{
      activePauseHold: {
        holdId: string;
        rootIssueId: string;
        issueId: string;
        isRoot: boolean;
        mode: "pause";
        reason: string | null;
        releasePolicy: { strategy: "manual" | "after_active_runs_finish"; note?: string | null } | null;
      } | null;
    }>(`/issues/${id}/tree-control/state`),
  releaseTreeHold: (id: string, holdId: string, data: ReleaseIssueTreeHold) =>
    api.post<IssueTreeHold>(`/issues/${id}/tree-holds/${holdId}/release`, data),
  checkMonitorNow: (id: string) => api.post<{ ok: true }>(`/issues/${id}/monitor/check-now`, {}),
  listComments: (
    id: string,
    filters?: {
      cursor?: string;
      limit?: number;
      entryLimit?: number;
    },
  ) => {
    const params = new URLSearchParams();
    if (filters?.cursor) params.set("cursor", filters.cursor);
    if (filters?.limit) params.set("limit", String(filters.limit));
    if (filters?.entryLimit) params.set("entryLimit", String(filters.entryLimit));
    const qs = params.toString();
    return api.get<BoardIssueCommentGroupPage>(`/issues/${id}/comments${qs ? `?${qs}` : ""}`);
  },
  getComment: (id: string, commentId: string) =>
    api.get<BoardIssueComment>(`/issues/${id}/comments/${commentId}`),
  getCommentThread: (
    id: string,
    rootCommentId: string,
    filters?: { cursor?: string; limit?: number },
  ) => {
    const params = new URLSearchParams();
    if (filters?.cursor) params.set("cursor", filters.cursor);
    if (filters?.limit) params.set("limit", String(filters.limit));
    const qs = params.toString();
    return api.get<BoardIssueCommentThreadPage>(
      `/issues/${id}/comments/${rootCommentId}/thread${qs ? `?${qs}` : ""}`,
    );
  },
  listFeedbackVotes: (id: string) => api.get<FeedbackVote[]>(`/issues/${id}/feedback-votes`),
  getCostSummary: (id: string, options: { excludeRoot?: boolean } = {}) => {
    const qs = options.excludeRoot ? "?excludeRoot=true" : "";
    return api.get<IssueCostSummary>(`/issues/${id}/cost-summary${qs}`);
  },
  listFeedbackTraces: (id: string, filters?: Record<string, string | boolean | undefined>) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters ?? {})) {
      if (value === undefined) continue;
      params.set(key, String(value));
    }
    const qs = params.toString();
    return api.get<FeedbackTrace[]>(`/issues/${id}/feedback-traces${qs ? `?${qs}` : ""}`);
  },
  upsertFeedbackVote: (
    id: string,
    data: {
      targetType: FeedbackTargetType;
      targetId: string;
      vote: "up" | "down";
      reason?: string;
      allowSharing?: boolean;
    },
  ) => api.post<FeedbackVote>(`/issues/${id}/feedback-votes`, data),
  addComment: (id: string, data: CreateIssueUserComment) =>
    api.post<IssueUserCommentResponse>(`/issues/${id}/comments`, data),
  listDocuments: (id: string, options?: { includeSystem?: boolean }) =>
    api.get<IssueDocument[]>(
      `/issues/${id}/documents${options?.includeSystem ? "?includeSystem=true" : ""}`,
    ),
  getDocument: (id: string, key: string) => api.get<IssueDocument>(`/issues/${id}/documents/${encodeURIComponent(key)}`),
  upsertDocument: (id: string, key: string, data: UpsertIssueDocument) =>
    api.put<IssueDocument>(`/issues/${id}/documents/${encodeURIComponent(key)}`, data),
  lockDocument: (id: string, key: string) =>
    api.post<IssueDocument>(`/issues/${id}/documents/${encodeURIComponent(key)}/lock`, {}),
  unlockDocument: (id: string, key: string) =>
    api.post<IssueDocument>(`/issues/${id}/documents/${encodeURIComponent(key)}/unlock`, {}),
  listDocumentRevisions: (id: string, key: string) =>
    api.get<DocumentRevision[]>(`/issues/${id}/documents/${encodeURIComponent(key)}/revisions`),
  restoreDocumentRevision: (id: string, key: string, revisionId: string) =>
    api.post<IssueDocument>(`/issues/${id}/documents/${encodeURIComponent(key)}/revisions/${revisionId}/restore`, {}),
  deleteDocument: (id: string, key: string) =>
    api.delete<{ ok: true }>(`/issues/${id}/documents/${encodeURIComponent(key)}`),
  listAttachments: (id: string) => api.get<IssueAttachment[]>(`/issues/${id}/attachments`),
  uploadAttachment: (
    companyId: string,
    issueId: string,
    file: File,
    issueCommentId?: string | null,
  ) => {
    const form = new FormData();
    form.append("file", file);
    if (issueCommentId) {
      form.append("issueCommentId", issueCommentId);
    }
    return api.postForm<IssueAttachment>(`/companies/${companyId}/issues/${issueId}/attachments`, form);
  },
  deleteAttachment: (id: string) => api.delete<{ ok: true }>(`/attachments/${id}`),
  listApprovals: (id: string) => api.get<Approval[]>(`/issues/${id}/approvals`),
  linkApproval: (id: string, approvalId: string) =>
    api.post<Approval[]>(`/issues/${id}/approvals`, { approvalId }),
  unlinkApproval: (id: string, approvalId: string) =>
    api.delete<{ ok: true }>(`/issues/${id}/approvals/${approvalId}`),
  listWorkProducts: (id: string) => api.get<IssueWorkProduct[]>(`/issues/${id}/work-products`),
  createWorkProduct: (id: string, data: Record<string, unknown>) =>
    api.post<IssueWorkProduct>(`/issues/${id}/work-products`, data),
  updateWorkProduct: (id: string, data: Record<string, unknown>) =>
    api.patch<IssueWorkProduct>(`/work-products/${id}`, data),
  deleteWorkProduct: (id: string) => api.delete<IssueWorkProduct>(`/work-products/${id}`),
};
