import { and, desc, eq, sql } from "drizzle-orm";
import { documentAnnotationComments, documentAnnotationThreads, documents } from "@paperclipai/db";
import {
  verifyDocumentAnchorSelector,
  type CreateDocumentAnnotationComment,
  type CreateDocumentAnnotationThread,
  type DocumentAnnotationComment,
  type DocumentAnnotationThread,
  type UpdateDocumentAnnotationThread,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import * as annotationCore from "./document-annotation-foundation.js";
import { buildDocumentAnnotationsDocumentAnnotationQueries } from "./document-annotation-queries.js";

export function buildDocumentAnnotationsDocumentAnnotationMutations(
  scope: annotationCore.DocumentAnnotationsContext &
    ReturnType<typeof buildDocumentAnnotationsDocumentAnnotationQueries>,
) {
  const {
    db,
    taskReferences,
    documentLink,
    getDocument,
    requireThread,
    commentsForThreads,
    assertLinkedTaskComment,
  } = scope;

  async function listThreads(
    target: annotationCore.AnnotationTarget,
    key: string,
    options: annotationCore.ListThreadsOptions,
  ) {
    const document = await getDocument(target, key);
    if (!document) throw notFound("Document not found");

    const conditions =
      target.kind === "task"
        ? [
            eq(documentAnnotationThreads.taskId, target.taskId),
            eq(documentAnnotationThreads.documentId, document.documentId),
          ]
        : [
            eq(documentAnnotationThreads.companyId, document.companyId),
            eq(documentAnnotationThreads.routineId, target.routineId),
            eq(documentAnnotationThreads.documentId, document.documentId),
          ];
    if (options.status && options.status !== "all") {
      conditions.push(eq(documentAnnotationThreads.status, options.status));
    }

    const threads: DocumentAnnotationThread[] = await db
      .select(annotationCore.threadSelect)
      .from(documentAnnotationThreads)
      .where(and(...conditions))
      .orderBy(desc(documentAnnotationThreads.updatedAt), desc(documentAnnotationThreads.id));
    if (!options.includeComments) return threads;

    const comments = await commentsForThreads(threads.map((thread) => thread.id));
    const commentsByThread = new Map<string, DocumentAnnotationComment[]>();
    for (const comment of comments) {
      const existing = commentsByThread.get(comment.threadId) ?? [];
      existing.push(comment);
      commentsByThread.set(comment.threadId, existing);
    }
    return threads.map((thread) => ({
      ...thread,
      comments: commentsByThread.get(thread.id) ?? [],
    }));
  }

  async function lockDocument(
    tx: annotationCore.DocumentAnnotationTx,
    target: annotationCore.AnnotationTarget,
    key: string,
  ) {
    const link = documentLink(target);
    await tx.execute(sql`
      select ${documents.id}
      from ${link.table}
      inner join ${documents} on ${link.documentIdColumn} = ${documents.id}
      where ${and(eq(link.ownerColumn, link.ownerId), eq(link.keyColumn, key))}
      for update of ${documents}
    `);
  }

  async function insertComment(
    tx: annotationCore.DocumentAnnotationTx,
    target: annotationCore.AnnotationTarget,
    thread: DocumentAnnotationThread,
    body: string,
    actor: annotationCore.ActorInput,
    taskCommentId: string | null,
    now: Date,
  ) {
    const targetValues =
      target.kind === "task" ? { taskId: thread.taskId } : { taskId: null, routineId: thread.routineId };
    const [comment] = await tx
      .insert(documentAnnotationComments)
      .values({
        companyId: thread.companyId,
        threadId: thread.id,
        ...targetValues,
        documentId: thread.documentId,
        body,
        authorType: actor.actorType,
        authorAgentId: actor.agentId ?? null,
        authorUserId: actor.userId ?? null,
        createdByRunId: actor.runId ?? null,
        taskCommentId,
        createdAt: now,
        updatedAt: now,
      })
      .returning(annotationCore.commentSelect);
    if (target.kind === "task") {
      await taskReferences.syncAnnotationComment(comment.id, tx);
    }
    return comment;
  }

  async function createThreadForTarget(
    target: annotationCore.AnnotationTarget,
    key: string,
    input: CreateDocumentAnnotationThread,
    actor: annotationCore.ActorInput,
  ) {
    return db.transaction(async (tx) => {
      await lockDocument(tx, target, key);
      const document = await getDocument(target, key, tx);
      if (!document) throw notFound("Document not found");
      if (
        input.baseRevisionId !== document.latestRevisionId ||
        input.baseRevisionNumber !== document.latestRevisionNumber
      ) {
        throw conflict("Annotation anchor requires the current document revision", {
          currentRevisionId: document.latestRevisionId,
          currentRevisionNumber: document.latestRevisionNumber,
        });
      }

      const verification = verifyDocumentAnchorSelector({
        markdown: document.latestBody,
        selector: input.selector,
      });
      if (!verification.ok || !verification.anchor) {
        throw unprocessable("Annotation anchor does not match the current document revision", {
          reason: verification.reason,
        });
      }

      const now = new Date();
      const linkedTaskComment =
        target.kind === "task" ? await assertLinkedTaskComment(target.taskId, input.taskCommentId, tx) : null;
      const targetValues =
        target.kind === "task" ? { taskId: target.taskId } : { taskId: null, routineId: target.routineId };
      const [thread] = await tx
        .insert(documentAnnotationThreads)
        .values({
          companyId: document.companyId,
          ...targetValues,
          documentId: document.documentId,
          documentKey: document.documentKey,
          status: "open",
          anchorState: "active",
          anchorConfidence: "exact",
          originalRevisionId: document.latestRevisionId,
          originalRevisionNumber: document.latestRevisionNumber,
          currentRevisionId: document.latestRevisionId,
          currentRevisionNumber: document.latestRevisionNumber,
          selectedText: verification.anchor.selectedText,
          prefixText: verification.anchor.prefixText,
          suffixText: verification.anchor.suffixText,
          normalizedStart: verification.anchor.normalizedStart,
          normalizedEnd: verification.anchor.normalizedEnd,
          markdownStart: verification.anchor.markdownStart,
          markdownEnd: verification.anchor.markdownEnd,
          anchorSelector: input.selector,
          createdByAgentId: actor.agentId ?? null,
          createdByUserId: actor.userId ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .returning(annotationCore.threadSelect);
      const comment = await insertComment(
        tx,
        target,
        thread,
        input.body,
        actor,
        linkedTaskComment?.id ?? null,
        now,
      );
      return { ...thread, comments: [comment] };
    });
  }

  async function addCommentForTarget(
    target: annotationCore.AnnotationTarget,
    key: string,
    threadId: string,
    input: CreateDocumentAnnotationComment,
    actor: annotationCore.ActorInput,
  ) {
    return db.transaction(async (tx) => {
      const thread = await requireThread(target, key, threadId, tx);
      const now = new Date();
      const linkedTaskComment =
        target.kind === "task" ? await assertLinkedTaskComment(target.taskId, input.taskCommentId, tx) : null;
      const comment = await insertComment(
        tx,
        target,
        thread,
        input.body,
        actor,
        linkedTaskComment?.id ?? null,
        now,
      );
      await tx
        .update(documentAnnotationThreads)
        .set({ updatedAt: now })
        .where(eq(documentAnnotationThreads.id, thread.id));
      return comment;
    });
  }

  async function updateThreadForTarget(
    target: annotationCore.AnnotationTarget,
    key: string,
    threadId: string,
    input: UpdateDocumentAnnotationThread,
    actor: annotationCore.ActorInput,
  ) {
    return db.transaction(async (tx) => {
      const thread = await requireThread(target, key, threadId, tx);
      if (!input.status || input.status === thread.status) return thread;

      const now = new Date();
      const [updated] = await tx
        .update(documentAnnotationThreads)
        .set(
          input.status === "resolved"
            ? {
                status: "resolved",
                resolvedByAgentId: actor.agentId ?? null,
                resolvedByUserId: actor.userId ?? null,
                resolvedAt: now,
                updatedAt: now,
              }
            : {
                status: "open",
                resolvedByAgentId: null,
                resolvedByUserId: null,
                resolvedAt: null,
                updatedAt: now,
              },
        )
        .where(eq(documentAnnotationThreads.id, thread.id))
        .returning(annotationCore.threadSelect);
      return updated;
    });
  }

  async function remapOpenThreads(
    target: annotationCore.AnnotationTarget,
    input: annotationCore.RemapDocumentInput,
  ) {
    const scopeCondition =
      target.kind === "task"
        ? eq(documentAnnotationThreads.taskId, target.taskId)
        : eq(documentAnnotationThreads.routineId, target.routineId);
    return db.transaction(async (tx) => annotationCore.remapOpenThreadsForScope(tx, scopeCondition, input));
  }

  return {
    listThreads,
    lockDocument,
    insertComment,
    createThreadForTarget,
    addCommentForTarget,
    updateThreadForTarget,
    remapOpenThreads,
  };
}
