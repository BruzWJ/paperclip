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
  isCanonicalUuid,
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

type AnnotationDocumentRow = {
  companyId: string;
  documentId: string;
  documentKey: string;
  latestBody: string;
  latestRevisionId: string | null;
  latestRevisionNumber: number;
};

type AnnotationTarget =
  { kind: "task"; taskId: string } | { kind: "routine"; routineId: string };

type ListThreadsOptions = {
  status?: "open" | "resolved" | "all";
  includeComments?: boolean;
};

type RemapDocumentInput = {
  key: string;
  documentId: string;
  nextRevisionId: string | null;
  nextRevisionNumber: number;
  nextBody: string;
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

function snapshotFromThread(
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
    const nextSelector = nextAnchor
      ? anchorSnapshotToSelector(nextAnchor)
      : thread.anchorSelector;
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

  function documentLink(target: AnnotationTarget) {
    return target.kind === "task"
      ? {
          table: taskDocuments,
          ownerColumn: taskDocuments.taskId,
          ownerId: target.taskId,
          keyColumn: taskDocuments.key,
          documentIdColumn: taskDocuments.documentId,
          companyCondition: null,
        }
      : {
          table: routineDocuments,
          ownerColumn: routineDocuments.routineId,
          ownerId: target.routineId,
          keyColumn: routineDocuments.key,
          documentIdColumn: routineDocuments.documentId,
          companyCondition: eq(routineDocuments.companyId, documents.companyId),
        };
  }

  async function getDocument(
    target: AnnotationTarget,
    key: string,
    dbOrTx: any = db,
  ): Promise<AnnotationDocumentRow | null> {
    const link = documentLink(target);
    const conditions = [
      eq(link.ownerColumn, link.ownerId),
      eq(link.keyColumn, key),
    ];
    if (link.companyCondition) conditions.push(link.companyCondition);
    return dbOrTx
      .select({
        companyId: documents.companyId,
        documentId: documents.id,
        documentKey: link.keyColumn,
        latestBody: documents.latestBody,
        latestRevisionId: documents.latestRevisionId,
        latestRevisionNumber: documents.latestRevisionNumber,
      })
      .from(link.table)
      .innerJoin(documents, eq(link.documentIdColumn, documents.id))
      .where(and(...conditions))
      .then((rows: AnnotationDocumentRow[]) => rows[0] ?? null);
  }

  async function findThread(
    target: AnnotationTarget,
    documentKey: string,
    threadId: string,
    dbOrTx: any = db,
  ): Promise<{
    documentFound: boolean;
    thread: DocumentAnnotationThread | null;
  }> {
    if (!isCanonicalUuid(threadId)) {
      if (target.kind === "routine") {
        const document = await getDocument(target, documentKey, dbOrTx);
        if (!document) return { documentFound: false, thread: null };
      }
      return { documentFound: true, thread: null };
    }

    let targetConditions: SQL[];
    if (target.kind === "task") {
      targetConditions = [
        eq(documentAnnotationThreads.taskId, target.taskId),
        eq(documentAnnotationThreads.documentKey, documentKey),
      ];
    } else {
      const document = await getDocument(target, documentKey, dbOrTx);
      if (!document) return { documentFound: false, thread: null };
      targetConditions = [
        eq(documentAnnotationThreads.companyId, document.companyId),
        eq(documentAnnotationThreads.routineId, target.routineId),
        eq(documentAnnotationThreads.documentId, document.documentId),
        eq(documentAnnotationThreads.documentKey, documentKey),
      ];
    }
    const thread = await dbOrTx
      .select(threadSelect)
      .from(documentAnnotationThreads)
      .where(
        and(eq(documentAnnotationThreads.id, threadId), ...targetConditions),
      )
      .then((rows: DocumentAnnotationThread[]) => rows[0] ?? null);
    return { documentFound: true, thread };
  }

  async function requireThread(
    target: AnnotationTarget,
    documentKey: string,
    threadId: string,
    dbOrTx: any = db,
  ): Promise<DocumentAnnotationThread> {
    const result = await findThread(target, documentKey, threadId, dbOrTx);
    if (!result.documentFound) throw notFound("Document not found");
    if (!result.thread) throw notFound("Annotation thread not found");
    return result.thread;
  }

  async function commentsForThreads(
    threadIds: string[],
    dbOrTx: any = db,
  ): Promise<DocumentAnnotationComment[]> {
    if (threadIds.length === 0) return [];
    return dbOrTx
      .select(commentSelect)
      .from(documentAnnotationComments)
      .where(inArray(documentAnnotationComments.threadId, threadIds))
      .orderBy(
        asc(documentAnnotationComments.createdAt),
        asc(documentAnnotationComments.id),
      );
  }

  async function assertLinkedTaskComment(
    taskId: string,
    commentId: string | null | undefined,
    dbOrTx: any = db,
  ) {
    if (!commentId) return null;
    if (!isCanonicalUuid(commentId)) {
      throw unprocessable("Linked task comment must belong to this task");
    }
    const comment = await dbOrTx
      .select({
        id: taskComments.id,
        companyId: taskComments.companyId,
        taskId: taskComments.taskId,
      })
      .from(taskComments)
      .where(eq(taskComments.id, commentId))
      .then(
        (rows: Array<{ id: string; companyId: string; taskId: string }>) =>
          rows[0] ?? null,
      );
    if (!comment || comment.taskId !== taskId) {
      throw unprocessable("Linked task comment must belong to this task");
    }
    return comment;
  }

  async function listThreads(
    target: AnnotationTarget,
    key: string,
    options: ListThreadsOptions,
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
      .select(threadSelect)
      .from(documentAnnotationThreads)
      .where(and(...conditions))
      .orderBy(
        desc(documentAnnotationThreads.updatedAt),
        desc(documentAnnotationThreads.id),
      );
    if (!options.includeComments) return threads;

    const comments = await commentsForThreads(
      threads.map((thread) => thread.id),
    );
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
    tx: DocumentAnnotationTx,
    target: AnnotationTarget,
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
    tx: DocumentAnnotationTx,
    target: AnnotationTarget,
    thread: DocumentAnnotationThread,
    body: string,
    actor: ActorInput,
    taskCommentId: string | null,
    now: Date,
  ) {
    const targetValues =
      target.kind === "task"
        ? { taskId: thread.taskId }
        : { taskId: null, routineId: thread.routineId };
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
      .returning(commentSelect);
    if (target.kind === "task") {
      await taskReferences.syncAnnotationComment(comment.id, tx);
    }
    return comment;
  }

  async function createThreadForTarget(
    target: AnnotationTarget,
    key: string,
    input: CreateDocumentAnnotationThread,
    actor: ActorInput,
  ) {
    return db.transaction(async (tx) => {
      await lockDocument(tx, target, key);
      const document = await getDocument(target, key, tx);
      if (!document) throw notFound("Document not found");
      if (
        input.baseRevisionId !== document.latestRevisionId ||
        input.baseRevisionNumber !== document.latestRevisionNumber
      ) {
        throw conflict(
          "Annotation anchor requires the current document revision",
          {
            currentRevisionId: document.latestRevisionId,
            currentRevisionNumber: document.latestRevisionNumber,
          },
        );
      }

      const verification = verifyDocumentAnchorSelector({
        markdown: document.latestBody,
        selector: input.selector,
      });
      if (!verification.ok || !verification.anchor) {
        throw unprocessable(
          "Annotation anchor does not match the current document revision",
          {
            reason: verification.reason,
          },
        );
      }

      const now = new Date();
      const linkedTaskComment =
        target.kind === "task"
          ? await assertLinkedTaskComment(
              target.taskId,
              input.taskCommentId,
              tx,
            )
          : null;
      const targetValues =
        target.kind === "task"
          ? { taskId: target.taskId }
          : { taskId: null, routineId: target.routineId };
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
        .returning(threadSelect);
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
    target: AnnotationTarget,
    key: string,
    threadId: string,
    input: CreateDocumentAnnotationComment,
    actor: ActorInput,
  ) {
    return db.transaction(async (tx) => {
      const thread = await requireThread(target, key, threadId, tx);
      const now = new Date();
      const linkedTaskComment =
        target.kind === "task"
          ? await assertLinkedTaskComment(
              target.taskId,
              input.taskCommentId,
              tx,
            )
          : null;
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
    target: AnnotationTarget,
    key: string,
    threadId: string,
    input: UpdateDocumentAnnotationThread,
    actor: ActorInput,
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
        .returning(threadSelect);
      return updated;
    });
  }

  async function remapOpenThreads(
    target: AnnotationTarget,
    input: RemapDocumentInput,
  ) {
    const scopeCondition =
      target.kind === "task"
        ? eq(documentAnnotationThreads.taskId, target.taskId)
        : eq(documentAnnotationThreads.routineId, target.routineId);
    return db.transaction(async (tx) =>
      remapOpenThreadsForScope(tx, scopeCondition, input),
    );
  }

  return {
    listThreadsForTaskDocument: async (
      taskId: string,
      key: string,
      options: ListThreadsOptions = {},
    ) => listThreads({ kind: "task", taskId }, key, options),

    listThreadsForRoutineDocument: async (
      routineId: string,
      key: string,
      options: ListThreadsOptions = {},
    ) => listThreads({ kind: "routine", routineId }, key, options),

    getThreadForTaskDocument: async (
      taskId: string,
      key: string,
      threadId: string,
    ) => {
      const { thread } = await findThread(
        { kind: "task", taskId },
        key,
        threadId,
      );
      if (!thread) return null;
      const comments = await commentsForThreads([thread.id]);
      return { ...thread, comments };
    },

    getThreadForRoutineDocument: async (
      routineId: string,
      key: string,
      threadId: string,
    ) => {
      const { thread } = await findThread(
        { kind: "routine", routineId },
        key,
        threadId,
      );
      if (!thread) return null;
      const comments = await commentsForThreads([thread.id]);
      return { ...thread, comments };
    },

    createThread: async (
      taskId: string,
      key: string,
      input: CreateDocumentAnnotationThread,
      actor: ActorInput,
    ) => createThreadForTarget({ kind: "task", taskId }, key, input, actor),

    createRoutineThread: async (
      routineId: string,
      key: string,
      input: CreateDocumentAnnotationThread,
      actor: ActorInput,
    ) =>
      createThreadForTarget({ kind: "routine", routineId }, key, input, actor),

    addComment: async (
      taskId: string,
      key: string,
      threadId: string,
      input: CreateDocumentAnnotationComment,
      actor: ActorInput,
    ) =>
      addCommentForTarget(
        { kind: "task", taskId },
        key,
        threadId,
        input,
        actor,
      ),

    addRoutineComment: async (
      routineId: string,
      key: string,
      threadId: string,
      input: CreateDocumentAnnotationComment,
      actor: ActorInput,
    ) =>
      addCommentForTarget(
        { kind: "routine", routineId },
        key,
        threadId,
        input,
        actor,
      ),

    updateThread: async (
      taskId: string,
      key: string,
      threadId: string,
      input: UpdateDocumentAnnotationThread,
      actor: ActorInput,
    ) =>
      updateThreadForTarget(
        { kind: "task", taskId },
        key,
        threadId,
        input,
        actor,
      ),

    updateRoutineThread: async (
      routineId: string,
      key: string,
      threadId: string,
      input: UpdateDocumentAnnotationThread,
      actor: ActorInput,
    ) =>
      updateThreadForTarget(
        { kind: "routine", routineId },
        key,
        threadId,
        input,
        actor,
      ),

    remapOpenThreadsForDocument: async (
      input: RemapDocumentInput & { taskId: string },
    ) => remapOpenThreads({ kind: "task", taskId: input.taskId }, input),

    remapOpenThreadsForRoutineDocument: async (
      input: RemapDocumentInput & { routineId: string },
    ) =>
      remapOpenThreads({ kind: "routine", routineId: input.routineId }, input),

    selectorToAnchorSnapshot,
  };
}
