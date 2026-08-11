import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  documentAnnotationAnchorSnapshots,
  documentAnnotationComments,
  documentAnnotationThreads,
  documents,
  taskComments,
  taskDocuments,
  routineDocuments,
} from "@paperclipai/db";
import {
  anchorSnapshotToSelector,
  remapDocumentAnchor,
  selectorToAnchorSnapshot,
  verifyDocumentAnchorSelector,
  type DocumentAnnotationAnchorSnapshot,
  type DocumentAnnotationComment,
  type DocumentAnnotationThread,
  CreateDocumentAnnotationComment,
  CreateDocumentAnnotationThread,
  UpdateDocumentAnnotationThread,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { taskReferenceService } from "./task-references.js";

type ActorInput = {
  actorType: "agent" | "user";
  actorId: string;
  agentId?: string | null;
  userId?: string | null;
  runId?: string | null;
};

type TaskDocumentRow = {
  taskId: string;
  companyId: string;
  documentId: string;
  documentKey: string;
  latestBody: string;
  latestRevisionId: string | null;
  latestRevisionNumber: number;
};

type RoutineDocumentRow = {
  routineId: string;
  companyId: string;
  documentId: string;
  documentKey: string;
  latestBody: string;
  latestRevisionId: string | null;
  latestRevisionNumber: number;
};

const threadSelect = {
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

const commentSelect = {
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

function snapshotFromThread(thread: Pick<DocumentAnnotationThread, "selectedText" | "prefixText" | "suffixText" | "normalizedStart" | "normalizedEnd" | "markdownStart" | "markdownEnd">): DocumentAnnotationAnchorSnapshot {
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

type DocumentAnnotationTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

async function remapOpenThreadsForScope(
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
    .where(and(
      scopeCondition,
      eq(documentAnnotationThreads.documentId, input.documentId),
      eq(documentAnnotationThreads.status, "open"),
    ));
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

export function documentAnnotationService(db: Db) {
  const taskReferences = taskReferenceService(db);

  async function getTaskDocument(taskId: string, key: string, dbOrTx: any = db): Promise<TaskDocumentRow | null> {
    return dbOrTx
      .select({
        taskId: taskDocuments.taskId,
        companyId: documents.companyId,
        documentId: documents.id,
        documentKey: taskDocuments.key,
        latestBody: documents.latestBody,
        latestRevisionId: documents.latestRevisionId,
        latestRevisionNumber: documents.latestRevisionNumber,
      })
      .from(taskDocuments)
      .innerJoin(documents, eq(taskDocuments.documentId, documents.id))
      .where(and(eq(taskDocuments.taskId, taskId), eq(taskDocuments.key, key)))
      .then((rows: TaskDocumentRow[]) => rows[0] ?? null);
  }

  async function getRoutineDocument(
    routineId: string,
    key: string,
    dbOrTx: any = db,
  ): Promise<RoutineDocumentRow | null> {
    return dbOrTx
      .select({
        routineId: routineDocuments.routineId,
        companyId: documents.companyId,
        documentId: documents.id,
        documentKey: routineDocuments.key,
        latestBody: documents.latestBody,
        latestRevisionId: documents.latestRevisionId,
        latestRevisionNumber: documents.latestRevisionNumber,
      })
      .from(routineDocuments)
      .innerJoin(documents, eq(routineDocuments.documentId, documents.id))
      .where(and(
        eq(routineDocuments.routineId, routineId),
        eq(routineDocuments.key, key),
        eq(routineDocuments.companyId, documents.companyId),
      ))
      .then((rows: RoutineDocumentRow[]) => rows[0] ?? null);
  }

  async function getThreadForTask(
    taskId: string,
    documentKey: string,
    threadId: string,
    dbOrTx: any = db,
  ): Promise<DocumentAnnotationThread | null> {
    return dbOrTx
      .select(threadSelect)
      .from(documentAnnotationThreads)
      .where(and(
        eq(documentAnnotationThreads.id, threadId),
        eq(documentAnnotationThreads.taskId, taskId),
        eq(documentAnnotationThreads.documentKey, documentKey),
      ))
      .then((rows: DocumentAnnotationThread[]) => rows[0] ?? null);
  }

  async function getThreadForRoutine(
    routineId: string,
    documentKey: string,
    threadId: string,
    companyId: string,
    documentId: string,
    dbOrTx: any = db,
  ): Promise<DocumentAnnotationThread | null> {
    return dbOrTx
      .select(threadSelect)
      .from(documentAnnotationThreads)
      .where(and(
        eq(documentAnnotationThreads.id, threadId),
        eq(documentAnnotationThreads.companyId, companyId),
        eq(documentAnnotationThreads.routineId, routineId),
        eq(documentAnnotationThreads.documentId, documentId),
        eq(documentAnnotationThreads.documentKey, documentKey),
      ))
      .then((rows: DocumentAnnotationThread[]) => rows[0] ?? null);
  }

  async function commentsForThreads(threadIds: string[], dbOrTx: any = db): Promise<DocumentAnnotationComment[]> {
    if (threadIds.length === 0) return [];
    return dbOrTx
      .select(commentSelect)
      .from(documentAnnotationComments)
      .where(inArray(documentAnnotationComments.threadId, threadIds))
      .orderBy(asc(documentAnnotationComments.createdAt), asc(documentAnnotationComments.id));
  }

  async function assertLinkedTaskComment(
    taskId: string,
    commentId: string | null | undefined,
    dbOrTx: any = db,
  ) {
    if (!commentId) return null;
    const comment = await dbOrTx
      .select({
        id: taskComments.id,
        companyId: taskComments.companyId,
        taskId: taskComments.taskId,
      })
      .from(taskComments)
      .where(eq(taskComments.id, commentId))
      .then((rows: Array<{ id: string; companyId: string; taskId: string }>) => rows[0] ?? null);
    if (!comment || comment.taskId !== taskId) {
      throw unprocessable("Linked task comment must belong to this task");
    }
    return comment;
  }

  return {
    listThreadsForTaskDocument: async (
      taskId: string,
      key: string,
      options: { status?: "open" | "resolved" | "all"; includeComments?: boolean } = {},
    ) => {
      const doc = await getTaskDocument(taskId, key);
      if (!doc) throw notFound("Document not found");
      const conditions = [
        eq(documentAnnotationThreads.taskId, taskId),
        eq(documentAnnotationThreads.documentId, doc.documentId),
      ];
      if (options.status && options.status !== "all") {
        conditions.push(eq(documentAnnotationThreads.status, options.status));
      }
      const threads: DocumentAnnotationThread[] = await db
        .select(threadSelect)
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
    },

    listThreadsForRoutineDocument: async (
      routineId: string,
      key: string,
      options: { status?: "open" | "resolved" | "all"; includeComments?: boolean } = {},
    ) => {
      const doc = await getRoutineDocument(routineId, key);
      if (!doc) throw notFound("Document not found");
      const conditions = [
        eq(documentAnnotationThreads.companyId, doc.companyId),
        eq(documentAnnotationThreads.routineId, routineId),
        eq(documentAnnotationThreads.documentId, doc.documentId),
      ];
      if (options.status && options.status !== "all") {
        conditions.push(eq(documentAnnotationThreads.status, options.status));
      }
      const threads: DocumentAnnotationThread[] = await db
        .select(threadSelect)
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
    },

    getThreadForTaskDocument: async (taskId: string, key: string, threadId: string) => {
      const thread = await getThreadForTask(taskId, key, threadId);
      if (!thread) return null;
      const comments = await commentsForThreads([thread.id]);
      return { ...thread, comments };
    },

    getThreadForRoutineDocument: async (routineId: string, key: string, threadId: string) => {
      const doc = await getRoutineDocument(routineId, key);
      if (!doc) return null;
      const thread = await getThreadForRoutine(routineId, key, threadId, doc.companyId, doc.documentId);
      if (!thread) return null;
      const comments = await commentsForThreads([thread.id]);
      return { ...thread, comments };
    },

    createThread: async (
      taskId: string,
      key: string,
      input: CreateDocumentAnnotationThread,
      actor: ActorInput,
    ) => db.transaction(async (tx) => {
      await tx.execute(sql`
        select ${documents.id}
        from ${taskDocuments}
        inner join ${documents} on ${taskDocuments.documentId} = ${documents.id}
        where ${and(eq(taskDocuments.taskId, taskId), eq(taskDocuments.key, key))}
        for update of ${documents}
      `);
      const doc = await getTaskDocument(taskId, key, tx);
      if (!doc) throw notFound("Document not found");
      if (
        input.baseRevisionId !== doc.latestRevisionId
        || input.baseRevisionNumber !== doc.latestRevisionNumber
      ) {
        throw conflict("Annotation anchor requires the current document revision", {
          currentRevisionId: doc.latestRevisionId,
          currentRevisionNumber: doc.latestRevisionNumber,
        });
      }

      const verification = verifyDocumentAnchorSelector({
        markdown: doc.latestBody,
        selector: input.selector,
      });
      if (!verification.ok || !verification.anchor) {
        throw unprocessable("Annotation anchor does not match the current document revision", {
          reason: verification.reason,
        });
      }

      const now = new Date();
      const linkedTaskComment = await assertLinkedTaskComment(taskId, input.taskCommentId, tx);
      const [thread] = await tx
        .insert(documentAnnotationThreads)
        .values({
          companyId: doc.companyId,
          taskId,
          documentId: doc.documentId,
          documentKey: doc.documentKey,
          status: "open",
          anchorState: "active",
          anchorConfidence: "exact",
          originalRevisionId: doc.latestRevisionId,
          originalRevisionNumber: doc.latestRevisionNumber,
          currentRevisionId: doc.latestRevisionId,
          currentRevisionNumber: doc.latestRevisionNumber,
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
        .returning(threadSelect);

      const [comment] = await tx
        .insert(documentAnnotationComments)
        .values({
          companyId: doc.companyId,
          threadId: thread.id,
          taskId,
          documentId: doc.documentId,
          body: input.body,
          authorType: actor.actorType,
          authorAgentId: actor.agentId ?? null,
          authorUserId: actor.userId ?? null,
          createdByRunId: actor.runId ?? null,
          taskCommentId: linkedTaskComment?.id ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .returning(commentSelect);
      await taskReferences.syncAnnotationComment(comment.id, tx);

      return { ...thread, comments: [comment] };
    }),

    createRoutineThread: async (
      routineId: string,
      key: string,
      input: CreateDocumentAnnotationThread,
      actor: ActorInput,
    ) => db.transaction(async (tx) => {
      await tx.execute(sql`
        select ${documents.id}
        from ${routineDocuments}
        inner join ${documents} on ${routineDocuments.documentId} = ${documents.id}
        where ${and(eq(routineDocuments.routineId, routineId), eq(routineDocuments.key, key))}
        for update of ${documents}
      `);
      const doc = await getRoutineDocument(routineId, key, tx);
      if (!doc) throw notFound("Document not found");
      if (
        input.baseRevisionId !== doc.latestRevisionId
        || input.baseRevisionNumber !== doc.latestRevisionNumber
      ) {
        throw conflict("Annotation anchor requires the current document revision", {
          currentRevisionId: doc.latestRevisionId,
          currentRevisionNumber: doc.latestRevisionNumber,
        });
      }

      const verification = verifyDocumentAnchorSelector({
        markdown: doc.latestBody,
        selector: input.selector,
      });
      if (!verification.ok || !verification.anchor) {
        throw unprocessable("Annotation anchor does not match the current document revision", {
          reason: verification.reason,
        });
      }

      const now = new Date();
      const [thread] = await tx
        .insert(documentAnnotationThreads)
        .values({
          companyId: doc.companyId,
          taskId: null,
          routineId,
          documentId: doc.documentId,
          documentKey: doc.documentKey,
          status: "open",
          anchorState: "active",
          anchorConfidence: "exact",
          originalRevisionId: doc.latestRevisionId,
          originalRevisionNumber: doc.latestRevisionNumber,
          currentRevisionId: doc.latestRevisionId,
          currentRevisionNumber: doc.latestRevisionNumber,
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
        .returning(threadSelect);

      const [comment] = await tx
        .insert(documentAnnotationComments)
        .values({
          companyId: doc.companyId,
          threadId: thread.id,
          taskId: null,
          routineId,
          documentId: doc.documentId,
          body: input.body,
          authorType: actor.actorType,
          authorAgentId: actor.agentId ?? null,
          authorUserId: actor.userId ?? null,
          createdByRunId: actor.runId ?? null,
          taskCommentId: null,
          createdAt: now,
          updatedAt: now,
        })
        .returning(commentSelect);

      return { ...thread, comments: [comment] };
    }),

    addComment: async (
      taskId: string,
      key: string,
      threadId: string,
      input: CreateDocumentAnnotationComment,
      actor: ActorInput,
    ) => db.transaction(async (tx) => {
      const thread = await getThreadForTask(taskId, key, threadId, tx);
      if (!thread) throw notFound("Annotation thread not found");
      const now = new Date();
      const linkedTaskComment = await assertLinkedTaskComment(taskId, input.taskCommentId, tx);
      const [comment] = await tx
        .insert(documentAnnotationComments)
        .values({
          companyId: thread.companyId,
          threadId: thread.id,
          taskId: thread.taskId,
          documentId: thread.documentId,
          body: input.body,
          authorType: actor.actorType,
          authorAgentId: actor.agentId ?? null,
          authorUserId: actor.userId ?? null,
          createdByRunId: actor.runId ?? null,
          taskCommentId: linkedTaskComment?.id ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .returning(commentSelect);
      await taskReferences.syncAnnotationComment(comment.id, tx);
      await tx
        .update(documentAnnotationThreads)
        .set({ updatedAt: now })
        .where(eq(documentAnnotationThreads.id, thread.id));
      return comment;
    }),

    addRoutineComment: async (
      routineId: string,
      key: string,
      threadId: string,
      input: CreateDocumentAnnotationComment,
      actor: ActorInput,
    ) => db.transaction(async (tx) => {
      const doc = await getRoutineDocument(routineId, key, tx);
      if (!doc) throw notFound("Document not found");
      const thread = await getThreadForRoutine(routineId, key, threadId, doc.companyId, doc.documentId, tx);
      if (!thread) throw notFound("Annotation thread not found");
      const now = new Date();
      const [comment] = await tx
        .insert(documentAnnotationComments)
        .values({
          companyId: thread.companyId,
          threadId: thread.id,
          taskId: null,
          routineId: thread.routineId,
          documentId: thread.documentId,
          body: input.body,
          authorType: actor.actorType,
          authorAgentId: actor.agentId ?? null,
          authorUserId: actor.userId ?? null,
          createdByRunId: actor.runId ?? null,
          taskCommentId: null,
          createdAt: now,
          updatedAt: now,
        })
        .returning(commentSelect);
      await tx
        .update(documentAnnotationThreads)
        .set({ updatedAt: now })
        .where(eq(documentAnnotationThreads.id, thread.id));
      return comment;
    }),

    updateThread: async (
      taskId: string,
      key: string,
      threadId: string,
      input: UpdateDocumentAnnotationThread,
      actor: ActorInput,
    ) => db.transaction(async (tx) => {
      const thread = await getThreadForTask(taskId, key, threadId, tx);
      if (!thread) throw notFound("Annotation thread not found");
      if (!input.status || input.status === thread.status) return thread;

      const now = new Date();
      const [updated] = await tx
        .update(documentAnnotationThreads)
        .set(input.status === "resolved"
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
          })
        .where(eq(documentAnnotationThreads.id, thread.id))
        .returning(threadSelect);
      return updated;
    }),

    updateRoutineThread: async (
      routineId: string,
      key: string,
      threadId: string,
      input: UpdateDocumentAnnotationThread,
      actor: ActorInput,
    ) => db.transaction(async (tx) => {
      const doc = await getRoutineDocument(routineId, key, tx);
      if (!doc) throw notFound("Document not found");
      const thread = await getThreadForRoutine(routineId, key, threadId, doc.companyId, doc.documentId, tx);
      if (!thread) throw notFound("Annotation thread not found");
      if (!input.status || input.status === thread.status) return thread;

      const now = new Date();
      const [updated] = await tx
        .update(documentAnnotationThreads)
        .set(input.status === "resolved"
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
          })
        .where(eq(documentAnnotationThreads.id, thread.id))
        .returning(threadSelect);
      return updated;
    }),

    remapOpenThreadsForDocument: async (input: {
      taskId: string;
      key: string;
      documentId: string;
      nextRevisionId: string | null;
      nextRevisionNumber: number;
      nextBody: string;
    }) => db.transaction(async (tx) =>
      remapOpenThreadsForScope(tx, eq(documentAnnotationThreads.taskId, input.taskId), input)),

    remapOpenThreadsForRoutineDocument: async (input: {
      routineId: string;
      key: string;
      documentId: string;
      nextRevisionId: string | null;
      nextRevisionNumber: number;
      nextBody: string;
    }) => db.transaction(async (tx) =>
      remapOpenThreadsForScope(tx, eq(documentAnnotationThreads.routineId, input.routineId), input)),

    selectorToAnchorSnapshot,
  };
}
