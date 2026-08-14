import { and, eq, type SQL } from "drizzle-orm";
import {
  type Db,
  documentAnnotationAnchorSnapshots,
  documentAnnotationComments,
  documentAnnotationThreads,
} from "@paperclipai/db";
import {
  anchorSnapshotToSelector,
  remapDocumentAnchor,
  type DocumentAnnotationAnchorSnapshot,
  type DocumentAnnotationThread,
} from "@paperclipai/shared";
import { taskReferenceService } from "./task-references.js";

export function createDocumentAnnotationsContext(db: Db) {
  const taskReferences = taskReferenceService(db);

  return { db, taskReferences };
}

export type DocumentAnnotationsContext = ReturnType<typeof createDocumentAnnotationsContext>;

export type ActorInput = {
  actorType: "agent" | "user";
  actorId: string;
  agentId?: string | null;
  userId?: string | null;
  runId?: string | null;
};

export type AnnotationDocumentRow = {
  companyId: string;
  documentId: string;
  documentKey: string;
  latestBody: string;
  latestRevisionId: string | null;
  latestRevisionNumber: number;
};

export type AnnotationTarget = { kind: "task"; taskId: string } | { kind: "routine"; routineId: string };

export type ListThreadsOptions = {
  status?: "open" | "resolved" | "all";
  includeComments?: boolean;
};

export type RemapDocumentInput = {
  key: string;
  documentId: string;
  nextRevisionId: string | null;
  nextRevisionNumber: number;
  nextBody: string;
};

export const threadSelect = {
  id: documentAnnotationThreads.id,
  companyId: documentAnnotationThreads.companyId,
  taskId: documentAnnotationThreads.taskId,
  routineId: documentAnnotationThreads.routineId,
  documentId: documentAnnotationThreads.documentId,
  documentKey: documentAnnotationThreads.documentKey,
  status: documentAnnotationThreads.status,
  anchorState: documentAnnotationThreads.anchorState,
  anchorConfidence: documentAnnotationThreads.anchorConfidence,
  originalRevisionId: documentAnnotationThreads.originalRevisionId,
  originalRevisionNumber: documentAnnotationThreads.originalRevisionNumber,
  currentRevisionId: documentAnnotationThreads.currentRevisionId,
  currentRevisionNumber: documentAnnotationThreads.currentRevisionNumber,
  selectedText: documentAnnotationThreads.selectedText,
  prefixText: documentAnnotationThreads.prefixText,
  suffixText: documentAnnotationThreads.suffixText,
  normalizedStart: documentAnnotationThreads.normalizedStart,
  normalizedEnd: documentAnnotationThreads.normalizedEnd,
  markdownStart: documentAnnotationThreads.markdownStart,
  markdownEnd: documentAnnotationThreads.markdownEnd,
  anchorSelector: documentAnnotationThreads.anchorSelector,
  createdByAgentId: documentAnnotationThreads.createdByAgentId,
  createdByUserId: documentAnnotationThreads.createdByUserId,
  resolvedByAgentId: documentAnnotationThreads.resolvedByAgentId,
  resolvedByUserId: documentAnnotationThreads.resolvedByUserId,
  resolvedAt: documentAnnotationThreads.resolvedAt,
  createdAt: documentAnnotationThreads.createdAt,
  updatedAt: documentAnnotationThreads.updatedAt,
};

export const commentSelect = {
  id: documentAnnotationComments.id,
  companyId: documentAnnotationComments.companyId,
  threadId: documentAnnotationComments.threadId,
  taskId: documentAnnotationComments.taskId,
  routineId: documentAnnotationComments.routineId,
  documentId: documentAnnotationComments.documentId,
  body: documentAnnotationComments.body,
  authorType: documentAnnotationComments.authorType,
  authorAgentId: documentAnnotationComments.authorAgentId,
  authorUserId: documentAnnotationComments.authorUserId,
  createdByRunId: documentAnnotationComments.createdByRunId,
  taskCommentId: documentAnnotationComments.taskCommentId,
  createdAt: documentAnnotationComments.createdAt,
  updatedAt: documentAnnotationComments.updatedAt,
};

export function snapshotFromThread(
  thread: Pick<
    DocumentAnnotationThread,
    | "selectedText"
    | "prefixText"
    | "suffixText"
    | "normalizedStart"
    | "normalizedEnd"
    | "markdownStart"
    | "markdownEnd"
  >,
): DocumentAnnotationAnchorSnapshot {
  return {
    selectedText: thread.selectedText,
    prefixText: thread.prefixText,
    suffixText: thread.suffixText,
    normalizedStart: thread.normalizedStart,
    normalizedEnd: thread.normalizedEnd,
    markdownStart: thread.markdownStart,
    markdownEnd: thread.markdownEnd,
  };
}

export type DocumentAnnotationTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export async function remapOpenThreadsForScope(
  tx: DocumentAnnotationTx,
  scopeCondition: SQL,
  input: {
    documentId: string;
    nextRevisionId: string | null;
    nextRevisionNumber: number;
    nextBody: string;
  },
) {
  const threads: DocumentAnnotationThread[] = await tx
    .select(threadSelect)
    .from(documentAnnotationThreads)
    .where(
      and(
        scopeCondition,
        eq(documentAnnotationThreads.documentId, input.documentId),
        eq(documentAnnotationThreads.status, "open"),
      ),
    );
  const changed = [];
  const now = new Date();

  for (const thread of threads) {
    if (thread.currentRevisionId === input.nextRevisionId) continue;
    const previousAnchor = snapshotFromThread(thread);
    const remap = remapDocumentAnchor({
      previousAnchor,
      nextMarkdown: input.nextBody,
    });
    const nextAnchor = remap.anchor;
    const nextSelector = nextAnchor ? anchorSnapshotToSelector(nextAnchor) : thread.anchorSelector;
    const [updated] = await tx
      .update(documentAnnotationThreads)
      .set({
        currentRevisionId: input.nextRevisionId,
        currentRevisionNumber: input.nextRevisionNumber,
        anchorState: remap.anchorState,
        anchorConfidence: remap.confidence,
        ...(nextAnchor
          ? {
              selectedText: nextAnchor.selectedText,
              prefixText: nextAnchor.prefixText,
              suffixText: nextAnchor.suffixText,
              normalizedStart: nextAnchor.normalizedStart,
              normalizedEnd: nextAnchor.normalizedEnd,
              markdownStart: nextAnchor.markdownStart,
              markdownEnd: nextAnchor.markdownEnd,
            }
          : {}),
        anchorSelector: nextSelector,
        updatedAt: now,
      })
      .where(eq(documentAnnotationThreads.id, thread.id))
      .returning(threadSelect);
    const [snapshot] = await tx
      .insert(documentAnnotationAnchorSnapshots)
      .values({
        companyId: thread.companyId,
        threadId: thread.id,
        documentId: thread.documentId,
        fromRevisionId: thread.currentRevisionId,
        fromRevisionNumber: thread.currentRevisionNumber,
        toRevisionId: input.nextRevisionId,
        toRevisionNumber: input.nextRevisionNumber,
        previousAnchor,
        nextAnchor,
        anchorState: remap.anchorState,
        anchorConfidence: remap.confidence,
        failureReason: remap.anchor ? null : remap.reason,
        createdAt: now,
      })
      .returning();
    changed.push({ thread: updated, snapshot });
  }

  return changed;
}
