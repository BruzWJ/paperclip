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

function targetBasePath(target: DocumentAnnotationTarget) {
  if (target.kind === "routine") {
    return `/routines/${target.routineId}/description/annotations`;
  }
  return `/tasks/${target.taskId}/documents/${encodeURIComponent(target.documentKey)}/annotations`;
}

export const documentAnnotationsApi = {
  list: (
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
  create: (target: DocumentAnnotationTarget, data: CreateDocumentAnnotationThreadRequest) =>
    api.post<DocumentAnnotationThreadWithComments>(
      targetBasePath(target),
      data,
    ),
  addComment: (
    target: DocumentAnnotationTarget,
    threadId: string,
    data: CreateDocumentAnnotationCommentRequest,
  ) =>
    api.post<DocumentAnnotationComment>(
      `${targetBasePath(target)}/${threadId}/comments`,
      data,
    ),
  updateStatus: (
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
