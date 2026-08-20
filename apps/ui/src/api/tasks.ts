import type {
  Approval,
  BoardTaskComment,
  BoardTaskCommentGroupPage,
  BoardTaskCommentThreadPage,
  CompactTask,
  CreateTask,
  CreateTaskUserComment,
  CreateTaskTreeHold,
  DocumentRevision,
  Task,
  TaskAttachment,
  TaskCostSummary,
  TaskComment,
  TaskStatus,
  TaskExecutionDecision,
  TaskDocument,
  TaskLabel,
  TaskTreeControlPreview,
  TaskTreeHold,
  TaskWorkProduct,
  PreviewTaskTreeControl,
  ReassignTask,
  ReleaseTaskTreeHold,
  UpdateTaskExecutionPolicy,
  UpdateTaskStatus,
  DecideTaskExecutionStage,
  UpdateTaskTitle,
  UpsertTaskDocument,
} from "@paperclipai/shared";
import { api, type RequestOptions } from "./client";

type TaskExecutionRefSummary = {
  id: string;
  [key: string]: unknown;
};

export type CreateTaskLabelInput = Pick<TaskLabel, "name" | "color">;
export type TaskInboxArchiveResponse = Pick<Task, "id" | "archivedAt">;

export type TaskReassignmentResponse = {
  task: Task;
  ref: TaskExecutionRefSummary | null;
  retried: boolean;
};

export type TaskStatusUpdateResponse = {
  task: Task;
  update: Record<string, unknown>;
  comment: TaskComment;
  ref: TaskExecutionRefSummary | null;
  retried: boolean;
};

export type TaskUserCommentResponse = {
  comment: BoardTaskComment;
  retried: boolean;
};

export type TaskExecutionPolicyDecisionResponse = {
  task: Task;
  decision: TaskExecutionDecision;
  retried: boolean;
};

export type TaskListFilters = {
  attention?: "blocked";
  status?: readonly TaskStatus[];
  projectId?: string;
  parentId?: string;
  ownerAgentId?: string;
  participantAgentId?: string;
  ownerUserId?: string;
  touchedByUserId?: string;
  inboxArchivedByUserId?: string;
  unreadForUserId?: string;
  labelId?: string;
  originKind?: string;
  originId?: string;
  descendantOf?: string;
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

function taskListSearchParams(filters?: TaskListFilters) {
  const params = new URLSearchParams();
  if (filters?.attention) params.set("attention", filters.attention);
  for (const status of filters?.status ?? []) params.append("status", status);
  if (filters?.projectId) params.set("projectId", filters.projectId);
  if (filters?.parentId) params.set("parentId", filters.parentId);
  if (filters?.ownerAgentId) params.set("ownerAgentId", filters.ownerAgentId);
  if (filters?.participantAgentId) params.set("participantAgentId", filters.participantAgentId);
  if (filters?.ownerUserId) params.set("ownerUserId", filters.ownerUserId);
  if (filters?.touchedByUserId) params.set("touchedByUserId", filters.touchedByUserId);
  if (filters?.inboxArchivedByUserId) params.set("inboxArchivedByUserId", filters.inboxArchivedByUserId);
  if (filters?.unreadForUserId) params.set("unreadForUserId", filters.unreadForUserId);
  if (filters?.labelId) params.set("labelId", filters.labelId);
  if (filters?.originKind) params.set("originKind", filters.originKind);
  if (filters?.originId) params.set("originId", filters.originId);
  if (filters?.descendantOf) params.set("descendantOf", filters.descendantOf);
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

export const tasksApi = {
  list: (companyId: string, filters?: TaskListFilters, options?: RequestOptions) => {
    const params = taskListSearchParams(filters);
    const qs = params.toString();
    const path = `/companies/${companyId}/tasks${qs ? `?${qs}` : ""}`;
    return options ? api.get<Task[]>(path, options) : api.get<Task[]>(path);
  },
  listCompact: (companyId: string, filters?: TaskListFilters, options?: RequestOptions) => {
    const params = taskListSearchParams(filters);
    params.set("view", "compact");
    const path = `/companies/${companyId}/tasks?${params.toString()}`;
    return options ? api.get<CompactTask[]>(path, options) : api.get<CompactTask[]>(path);
  },
  listLabels: (companyId: string) => api.get<TaskLabel[]>(`/companies/${companyId}/labels`),
  createLabel: (companyId: string, data: CreateTaskLabelInput) =>
    api.post<TaskLabel>(`/companies/${companyId}/labels`, data),
  get: (taskId: string, options?: RequestOptions) =>
    options
      ? api.get<Task>(`/tasks/${encodeURIComponent(taskId)}`, options)
      : api.get<Task>(`/tasks/${encodeURIComponent(taskId)}`),
  getByNumber: (companyId: string, taskNumber: number, options?: RequestOptions) => {
    const path = `/companies/${encodeURIComponent(companyId)}/tasks/${taskNumber}`;
    return options ? api.get<Task>(path, options) : api.get<Task>(path);
  },
  markRead: (id: string) => api.post<{ id: string; lastReadAt: Date }>(`/tasks/${id}/read`, {}),
  markUnread: (id: string) => api.delete<{ id: string; removed: boolean }>(`/tasks/${id}/read`),
  archiveFromInbox: (id: string) => api.post<TaskInboxArchiveResponse>(`/tasks/${id}/inbox-archive`, {}),
  unarchiveFromInbox: (id: string) =>
    api.delete<TaskInboxArchiveResponse | { ok: true }>(`/tasks/${id}/inbox-archive`),
  create: (companyId: string, data: CreateTask) => api.post<Task>(`/companies/${companyId}/tasks`, data),
  updateTitle: (id: string, data: UpdateTaskTitle) => api.patch<Task>(`/tasks/${id}`, data),
  updateExecutionPolicy: (id: string, data: UpdateTaskExecutionPolicy) =>
    api.put<Task>(`/tasks/${id}/execution-policy`, data),
  decideExecutionStage: (id: string, data: DecideTaskExecutionStage) =>
    api.post<TaskExecutionPolicyDecisionResponse>(`/tasks/${id}/execution-policy/decisions`, data),
  boardReassign: (id: string, data: ReassignTask) =>
    api.post<TaskReassignmentResponse>(`/tasks/${id}/reassign`, data),
  updateStatus: (id: string, data: UpdateTaskStatus) =>
    api.post<TaskStatusUpdateResponse>(`/tasks/${id}/status-update`, data),
  previewTreeControl: (id: string, data: PreviewTaskTreeControl) =>
    api.post<TaskTreeControlPreview>(`/tasks/${id}/tree-control/preview`, data),
  createTreeHold: (id: string, data: CreateTaskTreeHold) =>
    api.post<{ hold: TaskTreeHold; preview: TaskTreeControlPreview }>(`/tasks/${id}/tree-holds`, data),
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
    return api.get<TaskTreeHold[]>(`/tasks/${id}/tree-holds${qs ? `?${qs}` : ""}`);
  },
  getTreeControlState: (id: string) =>
    api.get<{
      activePauseHold: {
        holdId: string;
        rootTaskId: string;
        taskId: string;
        isRoot: boolean;
        mode: "pause";
        reason: string | null;
        releasePolicy: {
          strategy: "manual" | "after_active_runs_finish";
          note?: string | null;
        } | null;
      } | null;
    }>(`/tasks/${id}/tree-control/state`),
  releaseTreeHold: (id: string, holdId: string, data: ReleaseTaskTreeHold) =>
    api.post<TaskTreeHold>(`/tasks/${id}/tree-holds/${holdId}/release`, data),
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
    return api.get<BoardTaskCommentGroupPage>(`/tasks/${id}/comments${qs ? `?${qs}` : ""}`);
  },
  getCommentThread: (id: string, rootCommentId: string, filters?: { cursor?: string; limit?: number }) => {
    const params = new URLSearchParams();
    if (filters?.cursor) params.set("cursor", filters.cursor);
    if (filters?.limit) params.set("limit", String(filters.limit));
    const qs = params.toString();
    return api.get<BoardTaskCommentThreadPage>(
      `/tasks/${id}/comments/${rootCommentId}/thread${qs ? `?${qs}` : ""}`,
    );
  },
  getCostSummary: (id: string, options: { excludeRoot?: boolean } = {}) => {
    const qs = options.excludeRoot ? "?excludeRoot=true" : "";
    return api.get<TaskCostSummary>(`/tasks/${id}/cost-summary${qs}`);
  },
  addComment: (id: string, data: CreateTaskUserComment) =>
    api.post<TaskUserCommentResponse>(`/tasks/${id}/comments`, data),
  listDocuments: (id: string, options?: { includeSystem?: boolean }) =>
    api.get<TaskDocument[]>(`/tasks/${id}/documents${options?.includeSystem ? "?includeSystem=true" : ""}`),
  getDocument: (id: string, key: string) =>
    api.get<TaskDocument>(`/tasks/${id}/documents/${encodeURIComponent(key)}`),
  upsertDocument: (id: string, key: string, data: UpsertTaskDocument) =>
    api.put<TaskDocument>(`/tasks/${id}/documents/${encodeURIComponent(key)}`, data),
  lockDocument: (id: string, key: string) =>
    api.post<TaskDocument>(`/tasks/${id}/documents/${encodeURIComponent(key)}/lock`, {}),
  unlockDocument: (id: string, key: string) =>
    api.post<TaskDocument>(`/tasks/${id}/documents/${encodeURIComponent(key)}/unlock`, {}),
  listDocumentRevisions: (id: string, key: string) =>
    api.get<DocumentRevision[]>(`/tasks/${id}/documents/${encodeURIComponent(key)}/revisions`),
  restoreDocumentRevision: (id: string, key: string, revisionId: string) =>
    api.post<TaskDocument>(
      `/tasks/${id}/documents/${encodeURIComponent(key)}/revisions/${revisionId}/restore`,
      {},
    ),
  deleteDocument: (id: string, key: string) =>
    api.delete<{ ok: true }>(`/tasks/${id}/documents/${encodeURIComponent(key)}`),
  listAttachments: (id: string) => api.get<TaskAttachment[]>(`/tasks/${id}/attachments`),
  uploadAttachment: (companyId: string, taskId: string, file: File, taskCommentId?: string | null) => {
    const form = new FormData();
    form.append("file", file);
    if (taskCommentId) {
      form.append("taskCommentId", taskCommentId);
    }
    return api.postForm<TaskAttachment>(`/companies/${companyId}/tasks/${taskId}/attachments`, form);
  },
  deleteAttachment: (id: string) => api.delete<{ ok: true }>(`/attachments/${id}`),
  listApprovals: (id: string) => api.get<Approval[]>(`/tasks/${id}/approvals`),
  listWorkProducts: (id: string) => api.get<TaskWorkProduct[]>(`/tasks/${id}/work-products`),
};
