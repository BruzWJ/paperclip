import { and, asc, eq, inArray, type SQL } from "drizzle-orm";
import {
  documentAnnotationComments,
  documentAnnotationThreads,
  documents,
  routineDocuments,
  taskComments,
  taskDocuments,
} from "@paperclipai/db";
import {
  isCanonicalUuid,
  type DocumentAnnotationComment,
  type DocumentAnnotationThread,
} from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";
import {
  type AnnotationDocumentRow,
  type AnnotationTarget,
  commentSelect,
  threadSelect,
  type DocumentAnnotationsContext,
} from "./document-annotation-foundation.js";

export function buildDocumentAnnotationsDocumentAnnotationQueries(scope: DocumentAnnotationsContext) {
  const { db } = scope;

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
    const conditions = [eq(link.ownerColumn, link.ownerId), eq(link.keyColumn, key)];
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
      .where(and(eq(documentAnnotationThreads.id, threadId), ...targetConditions))
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
      .orderBy(asc(documentAnnotationComments.createdAt), asc(documentAnnotationComments.id));
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
      .then((rows: Array<{ id: string; companyId: string; taskId: string }>) => rows[0] ?? null);
    if (!comment || comment.taskId !== taskId) {
      throw unprocessable("Linked task comment must belong to this task");
    }
    return comment;
  }

  return {
    documentLink,
    getDocument,
    findThread,
    requireThread,
    commentsForThreads,
    assertLinkedTaskComment,
  };
}
