import { type DocumentAnnotationTarget } from "@/api/document-annotations";
import { buildDocumentAnnotationHash } from "@/lib/document-annotation-hash";
import type { DocumentActorLookups } from "./TaskDocumentUtils";
import type {
  Agent,
  DocumentAnnotationComment,
  DocumentAnnotationThreadWithComments,
} from "@paperclipai/shared";

/** ⌘/Ctrl + Enter submits the composer or reply. */
export function isSubmitShortcut(event: React.KeyboardEvent<HTMLTextAreaElement>): boolean {
  return event.key === "Enter" && (event.metaKey || event.ctrlKey);
}

export function resolveAuthor(
  comment: DocumentAnnotationComment,
  maps: DocumentActorLookups,
): {
  name: string;
  role: "board" | "agent";
  agentIcon?: Agent["icon"];
  imageUrl?: string | null;
} {
  if (comment.authorAgentId) {
    const agent = maps.agentMap?.get(comment.authorAgentId);
    return {
      name: agent?.name ?? comment.authorAgentId.slice(0, 8),
      role: "agent",
      agentIcon: agent?.icon,
    };
  }
  if (comment.authorUserId) {
    const profile = maps.userProfileMap?.get(comment.authorUserId);
    return {
      name: profile?.label ?? comment.authorUserId.slice(0, 8),
      role: "board",
      imageUrl: profile?.image ?? null,
    };
  }
  return {
    name: comment.authorType === "agent" ? "Agent" : "Board",
    role: comment.authorType === "agent" ? "agent" : "board",
  };
}

export interface OptimisticAuthor {
  id: string | null;
  name: string;
  image: string | null;
}

export function optimisticId(prefix: string): string {
  const random =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  return `${prefix}-${random}`;
}

export function buildOptimisticComment(input: {
  body: string;
  threadId: string;
  target: DocumentAnnotationTarget;
  author: OptimisticAuthor;
}): DocumentAnnotationComment {
  const now = new Date();
  return {
    id: optimisticId("optimistic-comment"),
    companyId: "",
    threadId: input.threadId,
    taskId: input.target.kind === "task" ? input.target.taskId : null,
    routineId: input.target.kind === "routine" ? input.target.routineId : null,
    documentId: "",
    body: input.body,
    authorType: "user",
    authorAgentId: null,
    authorUserId: input.author.id,
    createdByRunId: null,
    taskCommentId: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function buildOptimisticThread(input: {
  body: string;
  selectedText: string;
  target: DocumentAnnotationTarget;
  documentKey: string;
  baseRevisionId: string;
  baseRevisionNumber: number;
  normalizedStart: number;
  markdownStart: number;
  author: OptimisticAuthor;
}): DocumentAnnotationThreadWithComments {
  const id = optimisticId("optimistic-thread");
  const now = new Date();
  const comment = buildOptimisticComment({
    body: input.body,
    threadId: id,
    target: input.target,
    author: input.author,
  });
  // Only the fields the panel + overlay read need to be accurate; the optimistic
  // thread is swapped for the server copy on success. Cast through unknown so we
  // don't have to fabricate every backend-only column.
  return {
    id,
    taskId: input.target.kind === "task" ? input.target.taskId : null,
    routineId: input.target.kind === "routine" ? input.target.routineId : null,
    documentKey: input.documentKey,
    status: "open",
    anchorState: "active",
    selectedText: input.selectedText,
    normalizedStart: input.normalizedStart,
    markdownStart: input.markdownStart,
    originalRevisionId: input.baseRevisionId,
    originalRevisionNumber: input.baseRevisionNumber,
    currentRevisionId: input.baseRevisionId,
    currentRevisionNumber: input.baseRevisionNumber,
    createdByUserId: input.author.id,
    createdAt: now,
    updatedAt: now,
    comments: [comment],
  } as unknown as DocumentAnnotationThreadWithComments;
}

export function truncate(value: string, limit: number) {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 1)}…`;
}

export async function copyAnnotationLink(documentKey: string, threadId: string) {
  if (typeof window === "undefined" || !navigator.clipboard) return;
  const { pathname } = window.location;
  const hash = buildDocumentAnnotationHash({
    documentKey,
    threadId,
    commentId: null,
  });
  try {
    await navigator.clipboard.writeText(`${window.location.origin}${pathname}${hash}`);
  } catch {
    /* swallow */
  }
}
