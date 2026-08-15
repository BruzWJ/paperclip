import type { DocumentAnnotationTarget } from "@/api/document-annotations";
import type { DocumentRevision, Task, TaskDocument } from "@paperclipai/shared";
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { ApiError } from "@/api/client";
import { tasksApi } from "@/api/tasks";
import type { DocumentActorLookups } from "@/routes/_authenticated/$companyId/-document-annotations/-DocumentActorLookups";
import { queryKeys } from "@/lib/queryKeys";
import { type DocumentFrameHeaderRevisionActor } from "./-DocumentFrameHeader";
import { FoldCurtain } from "../../../../../../components/patterns/FoldCurtain";
import { MarkdownBody } from "../../../-markdown/-MarkdownBody";

export type DraftState = {
  key: string;
  title: string;
  body: string;
  baseRevisionId: string | null;
  isNew: boolean;
};

export type DocumentConflictState = {
  key: string;
  serverDocument: TaskDocument;
  localDraft: DraftState;
  showRemote: boolean;
};

export type DocumentSubjectConfig = {
  id: string;
  detailQueryKey: QueryKey;
  documentsQueryKey: QueryKey;
  idleDocumentRevisionsQueryKey: QueryKey;
  documentRevisionsQueryKey: (key: string) => QueryKey;
  listDocuments: () => Promise<TaskDocument[]>;
  listDocumentRevisions: (key: string) => Promise<DocumentRevision[]>;
  getDocument: (key: string) => Promise<TaskDocument>;
  upsertDocument: (
    key: string,
    data: {
      title: string | null;
      format: "markdown";
      body: string;
      baseRevisionId: string | null;
    },
  ) => Promise<TaskDocument>;
  deleteDocument: (key: string) => Promise<unknown>;
  restoreDocumentRevision: (key: string, revisionId: string) => Promise<TaskDocument>;
  setDocumentLock: (key: string, locked: boolean) => Promise<TaskDocument>;
  syncDetailCache: (queryClient: QueryClient, document: TaskDocument) => void;
  annotationTarget: (documentKey: string) => DocumentAnnotationTarget;
};

export const DOCUMENT_AUTOSAVE_DEBOUNCE_MS = 900;

const getFoldedDocumentsStorageKey = (taskId: string) => `paperclip:task-document-folds:${taskId}`;

export function loadFoldedDocumentKeys(taskId: string) {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(getFoldedDocumentsStorageKey(taskId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

export function saveFoldedDocumentKeys(taskId: string, keys: string[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(getFoldedDocumentsStorageKey(taskId), JSON.stringify(keys));
}

export function renderFoldableBody(body: string, className?: string) {
  return (
    <FoldCurtain>
      <MarkdownBody className={className} softBreaks={false}>
        {body}
      </MarkdownBody>
    </FoldCurtain>
  );
}

export function isPlanKey(key: string) {
  return key === "plan";
}

export function compareTaskDocuments(
  left: Pick<TaskDocument, "key" | "updatedAt">,
  right: Pick<TaskDocument, "key" | "updatedAt">,
) {
  if (left.key === "plan" && right.key !== "plan") return -1;
  if (left.key !== "plan" && right.key === "plan") return 1;
  return new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
}

export function titlesMatchKey(title: string | null | undefined, key: string) {
  return title === key;
}

export function isDocumentConflictError(error: unknown) {
  return error instanceof ApiError && error.status === 409;
}

export function isLockedDocumentError(error: unknown) {
  return error instanceof ApiError && error.status === 409 && error.message === "Document is locked";
}

export function downloadDocumentFile(key: string, body: string) {
  const blob = new Blob([body], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${key}.md`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function getRevisionActor(
  revision: DocumentRevision,
  maps: DocumentActorLookups,
): DocumentFrameHeaderRevisionActor {
  if (revision.createdByAgentId) {
    const agent = maps.agentMap?.get(revision.createdByAgentId);
    return {
      kind: "agent",
      name: agent?.name ?? revision.createdByAgentId.slice(0, 8),
      agentIcon: agent?.icon ?? null,
    };
  }
  if (revision.createdByUserId) {
    const profile = maps.userProfileMap?.get(revision.createdByUserId);
    return {
      kind: "user",
      name: profile?.label ?? revision.createdByUserId.slice(0, 8),
      imageUrl: profile?.image ?? null,
    };
  }
  return { kind: "system", name: "System" };
}

export function documentHasUnsavedChanges(doc: TaskDocument, draft: DraftState | null) {
  if (!draft || draft.isNew || draft.key !== doc.key) return false;
  return draft.body !== doc.body || (doc.title ?? "") !== draft.title;
}

function toDocumentSummary(document: TaskDocument) {
  return {
    id: document.id,
    companyId: document.companyId,
    taskId: document.taskId,
    key: document.key,
    title: document.title,
    format: document.format,
    latestRevisionId: document.latestRevisionId,
    latestRevisionNumber: document.latestRevisionNumber,
    createdByAgentId: document.createdByAgentId,
    createdByUserId: document.createdByUserId,
    updatedByAgentId: document.updatedByAgentId,
    updatedByUserId: document.updatedByUserId,
    lockedAt: document.lockedAt,
    lockedByAgentId: document.lockedByAgentId,
    lockedByUserId: document.lockedByUserId,
    sourceTrust: document.sourceTrust,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
  };
}

export function makeTaskDocumentSubject(task: Task): DocumentSubjectConfig {
  return {
    id: task.id,
    detailQueryKey: queryKeys.tasks.detail(task.id),
    documentsQueryKey: queryKeys.tasks.documents(task.id),
    idleDocumentRevisionsQueryKey: ["tasks", "document-revisions", task.id, "__idle__"],
    documentRevisionsQueryKey: (key) => queryKeys.tasks.documentRevisions(task.id, key),
    listDocuments: () => tasksApi.listDocuments(task.id),
    listDocumentRevisions: (key) => tasksApi.listDocumentRevisions(task.id, key),
    getDocument: (key) => tasksApi.getDocument(task.id, key),
    upsertDocument: (key, data) => tasksApi.upsertDocument(task.id, key, data),
    deleteDocument: (key) => tasksApi.deleteDocument(task.id, key),
    restoreDocumentRevision: (key, revisionId) => tasksApi.restoreDocumentRevision(task.id, key, revisionId),
    setDocumentLock: (key, locked) =>
      locked ? tasksApi.lockDocument(task.id, key) : tasksApi.unlockDocument(task.id, key),
    syncDetailCache: (queryClient, document) => {
      queryClient.setQueryData<Task | undefined>(queryKeys.tasks.detail(task.id), (current) => {
        if (!current) return current;
        const nextSummaries = (() => {
          const summary = toDocumentSummary(document);
          const existingIndex = (current.documentSummaries ?? []).findIndex(
            (entry) => entry.key === document.key,
          );
          if (existingIndex === -1) return [...(current.documentSummaries ?? []), summary];
          return (current.documentSummaries ?? []).map((entry, index) =>
            index === existingIndex ? summary : entry,
          );
        })();
        return {
          ...current,
          planDocument: document.key === "plan" ? document : (current.planDocument ?? null),
          documentSummaries: nextSummaries,
        };
      });
    },
    annotationTarget: (documentKey) => ({
      kind: "task",
      taskId: task.id,
      documentKey,
    }),
  };
}
