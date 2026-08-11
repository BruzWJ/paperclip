import type {
  CreateDocumentAnnotationCommentRequest,
  CreateDocumentAnnotationThreadRequest,
  DocumentAnnotationComment,
  DocumentAnnotationThread,
  DocumentAnnotationThreadStatus,
  DocumentAnnotationThreadWithComments,
  UpdateDocumentAnnotationThreadRequest,
} from "@paperclipai/shared";
import { api } from "./client";

export type DocumentAnnotationListFilter = "open" | "resolved" | "all";

export type DocumentAnnotationTarget =
  | { kind: "task"; taskId: string; documentKey: string }
  | { kind: "routine"; routineId: string; documentKey: "description" };

function taskTarget(taskId: string, documentKey: string): DocumentAnnotationTarget {
  return { kind: "task", taskId, documentKey };
}

function targetBasePath(target: DocumentAnnotationTarget) {
  if (target.kind === "routine") {
    return `/routines/${target.routineId}/description/annotations`;
  }
  return `/tasks/${target.taskId}/documents/${encodeURIComponent(target.documentKey)}/annotations`;
}

export const documentAnnotationsApi = {
  list: (
    taskId: string,
    key: string,
    options: { status?: DocumentAnnotationListFilter; includeComments?: boolean } = {},
  ) => documentAnnotationsApi.listForTarget(taskTarget(taskId, key), options),
  listForTarget: (
    target: DocumentAnnotationTarget,
    options: { status?: DocumentAnnotationListFilter; includeComments?: boolean } = {},
  ) => {
    const params = new URLSearchParams();
    if (options.status) params.set("status", options.status);
    if (options.includeComments) params.set("includeComments", "true");
    const qs = params.toString();
    return api.get<DocumentAnnotationThreadWithComments[]>(
      `${targetBasePath(target)}${qs ? `?${qs}` : ""}`,
    );
  },
  get: (taskId: string, key: string, threadId: string) =>
    documentAnnotationsApi.getForTarget(taskTarget(taskId, key), threadId),
  getForTarget: (target: DocumentAnnotationTarget, threadId: string) =>
    api.get<DocumentAnnotationThreadWithComments>(
      `${targetBasePath(target)}/${threadId}`,
    ),
  create: (taskId: string, key: string, data: CreateDocumentAnnotationThreadRequest) =>
    documentAnnotationsApi.createForTarget(taskTarget(taskId, key), data),
  createForTarget: (target: DocumentAnnotationTarget, data: CreateDocumentAnnotationThreadRequest) =>
    api.post<DocumentAnnotationThreadWithComments>(
      targetBasePath(target),
      data,
    ),
  addComment: (
    taskId: string,
    key: string,
    threadId: string,
    data: CreateDocumentAnnotationCommentRequest,
  ) => documentAnnotationsApi.addCommentForTarget(taskTarget(taskId, key), threadId, data),
  addCommentForTarget: (
    target: DocumentAnnotationTarget,
    threadId: string,
    data: CreateDocumentAnnotationCommentRequest,
  ) =>
    api.post<DocumentAnnotationComment>(
      `${targetBasePath(target)}/${threadId}/comments`,
      data,
    ),
  updateStatus: (
    taskId: string,
    key: string,
    threadId: string,
    status: DocumentAnnotationThreadStatus,
  ) => documentAnnotationsApi.updateStatusForTarget(taskTarget(taskId, key), threadId, status),
  updateStatusForTarget: (
    target: DocumentAnnotationTarget,
    threadId: string,
    status: DocumentAnnotationThreadStatus,
  ) => {
    const payload: UpdateDocumentAnnotationThreadRequest = { status };
    return api.patch<DocumentAnnotationThread>(
      `${targetBasePath(target)}/${threadId}`,
      payload,
    );
  },
};
