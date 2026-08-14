import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  type Db,
  documentAnnotationComments,
  documents,
  taskComments,
  taskDocuments,
  taskReferenceMentions,
  tasks,
} from "@paperclipai/db";
import {
  type TaskReferenceSource,
  type TaskReferenceSourceKind,
  type TaskRelatedWorkItem,
  type TaskRelatedWorkSummary,
  type TaskRelationTaskSummary,
  extractTaskReferenceMatches,
} from "@paperclipai/shared";
import { notFound } from "../errors.js";

export type TaskReferenceTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

const SOURCE_KIND_ORDER: Record<TaskReferenceSourceKind, number> = {
  title: 0,
  request: 1,
  document: 2,
  comment: 3,
};

function sourceLabel(kind: TaskReferenceSourceKind, documentKey: string | null): string {
  if (kind === "document") return documentKey?.trim() || "document";
  return kind;
}

function sourceWhere(input: {
  companyId?: string;
  sourceTaskId?: string;
  sourceKind: TaskReferenceSourceKind;
  sourceRecordId?: string | null;
}) {
  const conditions = [eq(taskReferenceMentions.sourceKind, input.sourceKind)];
  if (input.companyId) conditions.push(eq(taskReferenceMentions.companyId, input.companyId));
  if (input.sourceTaskId) conditions.push(eq(taskReferenceMentions.sourceTaskId, input.sourceTaskId));
  if (input.sourceRecordId) {
    conditions.push(eq(taskReferenceMentions.sourceRecordId, input.sourceRecordId));
  } else {
    conditions.push(isNull(taskReferenceMentions.sourceRecordId));
  }
  return and(...conditions);
}

function toTaskSummary(row: {
  relatedTaskId: string;
  relatedTaskNumber: number;
  relatedTaskIdentifier: string;
  relatedTaskTitle: string | null;
  relatedTaskBoardPresentationStatus: TaskRelationTaskSummary["boardPresentationStatus"];
  relatedTaskPriority: TaskRelationTaskSummary["priority"];
  relatedTaskOwnerAgentId: string | null;
  relatedTaskOwnerUserId: string | null;
}): TaskRelationTaskSummary {
  return {
    id: row.relatedTaskId,
    taskNumber: row.relatedTaskNumber,
    identifier: row.relatedTaskIdentifier,
    title: row.relatedTaskTitle,
    boardPresentationStatus: row.relatedTaskBoardPresentationStatus,
    priority: row.relatedTaskPriority,
    ownerAgentId: row.relatedTaskOwnerAgentId,
    ownerUserId: row.relatedTaskOwnerUserId,
  };
}

function sortSources(a: TaskReferenceSource, b: TaskReferenceSource) {
  const orderDelta = SOURCE_KIND_ORDER[a.kind] - SOURCE_KIND_ORDER[b.kind];
  if (orderDelta !== 0) return orderDelta;
  const labelDelta = a.label.localeCompare(b.label);
  if (labelDelta !== 0) return labelDelta;
  return (a.sourceRecordId ?? "").localeCompare(b.sourceRecordId ?? "");
}

function sortRelatedWork(a: TaskRelatedWorkItem, b: TaskRelatedWorkItem) {
  if (b.mentionCount !== a.mentionCount) return b.mentionCount - a.mentionCount;
  const leftLabel = a.task.title ?? a.task.identifier;
  const rightLabel = b.task.title ?? b.task.identifier;
  return leftLabel.localeCompare(rightLabel);
}

function emptySummary(): TaskRelatedWorkSummary {
  return {
    outbound: [],
    inbound: [],
  };
}

function diffTaskSummaries(
  before: TaskRelatedWorkSummary,
  after: TaskRelatedWorkSummary,
): {
  addedReferencedTasks: TaskRelationTaskSummary[];
  removedReferencedTasks: TaskRelationTaskSummary[];
  currentReferencedTasks: TaskRelationTaskSummary[];
} {
  const beforeById = new Map(before.outbound.map((item) => [item.task.id, item.task]));
  const afterById = new Map(after.outbound.map((item) => [item.task.id, item.task]));

  return {
    addedReferencedTasks: after.outbound.map((item) => item.task).filter((task) => !beforeById.has(task.id)),
    removedReferencedTasks: before.outbound
      .map((item) => item.task)
      .filter((task) => !afterById.has(task.id)),
    currentReferencedTasks: after.outbound.map((item) => item.task),
  };
}

async function replaceSourceMentionsInTx(
  transaction: TaskReferenceTransaction,
  input: {
    companyId: string;
    sourceTaskId: string;
    sourceKind: TaskReferenceSourceKind;
    sourceRecordId: string | null;
    documentKey: string | null;
    text: string | null | undefined;
  },
) {
  const matches = extractTaskReferenceMatches(input.text ?? "");
  const taskIds = matches.map((match) => match.taskId);
  const resolvedTargets =
    taskIds.length > 0
      ? await transaction
          .select({
            id: tasks.id,
          })
          .from(tasks)
          .where(and(eq(tasks.companyId, input.companyId), inArray(tasks.id, taskIds)))
      : [];
  const resolvedTargetIds = new Set(resolvedTargets.map((row) => row.id));

  await transaction.delete(taskReferenceMentions).where(sourceWhere(input));
  if (matches.length === 0) return;

  const seenTargetIds = new Set<string>();
  const values = matches.flatMap((match) => {
    const targetTaskId = match.taskId;
    if (
      !resolvedTargetIds.has(targetTaskId) ||
      targetTaskId === input.sourceTaskId ||
      seenTargetIds.has(targetTaskId)
    ) {
      return [];
    }
    seenTargetIds.add(targetTaskId);
    return [
      {
        companyId: input.companyId,
        sourceTaskId: input.sourceTaskId,
        targetTaskId,
        sourceKind: input.sourceKind,
        sourceRecordId: input.sourceRecordId,
        documentKey: input.documentKey,
        matchedText: match.matchedText,
      },
    ];
  });
  if (values.length > 0) {
    await transaction.insert(taskReferenceMentions).values(values);
  }
}

/**
 * Canonical comment-reference projection. The transaction is mandatory so a
 * source comment and every reference derived from its current body become
 * visible—or roll back—together.
 */
export async function syncComment(commentId: string, transaction: TaskReferenceTransaction) {
  const comment = await transaction
    .select({
      id: taskComments.id,
      companyId: taskComments.companyId,
      taskId: taskComments.taskId,
      body: taskComments.body,
    })
    .from(taskComments)
    .where(eq(taskComments.id, commentId))
    .then((rows) => rows[0] ?? null);
  if (!comment) throw notFound("Task comment not found");

  await replaceSourceMentionsInTx(transaction, {
    companyId: comment.companyId,
    sourceTaskId: comment.taskId,
    sourceKind: "comment",
    sourceRecordId: comment.id,
    documentKey: null,
    text: comment.body,
  });
}

/**
 * Canonical task title/request reference projection. The transaction is
 * mandatory so task creation/title change and its reference rows commit as
 * one source aggregate.
 */
export async function syncTask(taskId: string, transaction: TaskReferenceTransaction) {
  const task = await transaction
    .select({
      id: tasks.id,
      companyId: tasks.companyId,
      title: tasks.title,
      request: tasks.request,
    })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .then((rows) => rows[0] ?? null);
  if (!task) throw notFound("Task not found");

  await replaceSourceMentionsInTx(transaction, {
    companyId: task.companyId,
    sourceTaskId: task.id,
    sourceKind: "title",
    sourceRecordId: null,
    documentKey: null,
    text: task.title,
  });
  await replaceSourceMentionsInTx(transaction, {
    companyId: task.companyId,
    sourceTaskId: task.id,
    sourceKind: "request",
    sourceRecordId: null,
    documentKey: null,
    text: task.request,
  });
}

export async function syncAnnotationComment(commentId: string, transaction: TaskReferenceTransaction) {
  const comment = await transaction
    .select({
      id: documentAnnotationComments.id,
      companyId: documentAnnotationComments.companyId,
      taskId: documentAnnotationComments.taskId,
      body: documentAnnotationComments.body,
    })
    .from(documentAnnotationComments)
    .where(eq(documentAnnotationComments.id, commentId))
    .then((rows) => rows[0] ?? null);
  if (!comment?.taskId) {
    throw notFound("Task-scoped document annotation comment not found");
  }

  await replaceSourceMentionsInTx(transaction, {
    companyId: comment.companyId,
    sourceTaskId: comment.taskId,
    sourceKind: "comment",
    sourceRecordId: comment.id,
    documentKey: null,
    text: comment.body,
  });
}

export async function syncDocument(documentId: string, transaction: TaskReferenceTransaction) {
  const document = await transaction
    .select({
      documentId: documents.id,
      companyId: documents.companyId,
      taskId: taskDocuments.taskId,
      key: taskDocuments.key,
      body: documents.latestBody,
    })
    .from(taskDocuments)
    .innerJoin(documents, eq(taskDocuments.documentId, documents.id))
    .where(eq(documents.id, documentId))
    .then((rows) => rows[0] ?? null);

  if (!document) {
    throw notFound("Task document not found");
  }

  await replaceSourceMentionsInTx(transaction, {
    companyId: document.companyId,
    sourceTaskId: document.taskId,
    sourceKind: "document",
    sourceRecordId: document.documentId,
    documentKey: document.key,
    text: document.body,
  });
}

export async function deleteDocumentSource(documentId: string, transaction: TaskReferenceTransaction) {
  await transaction
    .delete(taskReferenceMentions)
    .where(
      and(
        eq(taskReferenceMentions.sourceKind, "document"),
        eq(taskReferenceMentions.sourceRecordId, documentId),
      ),
    );
}

export async function deleteCommentSource(commentId: string, transaction: TaskReferenceTransaction) {
  await transaction
    .delete(taskReferenceMentions)
    .where(
      and(
        eq(taskReferenceMentions.sourceKind, "comment"),
        eq(taskReferenceMentions.sourceRecordId, commentId),
      ),
    );
}

export function taskReferenceService(db: Db) {
  async function taskById(taskId: string, dbOrTx: any = db) {
    return dbOrTx
      .select({
        id: tasks.id,
        companyId: tasks.companyId,
        title: tasks.title,
        request: tasks.request,
      })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .then(
        (
          rows: Array<{
            id: string;
            companyId: string;
            title: string | null;
            request: string | null;
          }>,
        ) => rows[0] ?? null,
      );
  }

  async function listTaskReferenceSummary(taskId: string, dbOrTx: any = db): Promise<TaskRelatedWorkSummary> {
    const task = await taskById(taskId, dbOrTx);
    if (!task) throw notFound("Task not found");

    const [outboundRows, inboundRows] = await Promise.all([
      dbOrTx
        .select({
          relatedTaskId: tasks.id,
          relatedTaskNumber: tasks.taskNumber,
          relatedTaskIdentifier: tasks.identifier,
          relatedTaskTitle: tasks.title,
          relatedTaskBoardPresentationStatus: tasks.boardPresentationStatus,
          relatedTaskPriority: tasks.priority,
          relatedTaskOwnerAgentId: tasks.ownerAgentId,
          relatedTaskOwnerUserId: tasks.ownerUserId,
          sourceKind: taskReferenceMentions.sourceKind,
          sourceRecordId: taskReferenceMentions.sourceRecordId,
          documentKey: taskReferenceMentions.documentKey,
          matchedText: taskReferenceMentions.matchedText,
        })
        .from(taskReferenceMentions)
        .innerJoin(tasks, eq(taskReferenceMentions.targetTaskId, tasks.id))
        .where(
          and(
            eq(taskReferenceMentions.companyId, task.companyId),
            eq(taskReferenceMentions.sourceTaskId, taskId),
          ),
        ),
      dbOrTx
        .select({
          relatedTaskId: tasks.id,
          relatedTaskNumber: tasks.taskNumber,
          relatedTaskIdentifier: tasks.identifier,
          relatedTaskTitle: tasks.title,
          relatedTaskBoardPresentationStatus: tasks.boardPresentationStatus,
          relatedTaskPriority: tasks.priority,
          relatedTaskOwnerAgentId: tasks.ownerAgentId,
          relatedTaskOwnerUserId: tasks.ownerUserId,
          sourceKind: taskReferenceMentions.sourceKind,
          sourceRecordId: taskReferenceMentions.sourceRecordId,
          documentKey: taskReferenceMentions.documentKey,
          matchedText: taskReferenceMentions.matchedText,
        })
        .from(taskReferenceMentions)
        .innerJoin(tasks, eq(taskReferenceMentions.sourceTaskId, tasks.id))
        .where(
          and(
            eq(taskReferenceMentions.companyId, task.companyId),
            eq(taskReferenceMentions.targetTaskId, taskId),
          ),
        ),
    ]);

    const mapRows = (
      rows: Array<{
        relatedTaskId: string;
        relatedTaskNumber: number;
        relatedTaskIdentifier: string;
        relatedTaskTitle: string | null;
        relatedTaskBoardPresentationStatus: TaskRelationTaskSummary["boardPresentationStatus"];
        relatedTaskPriority: TaskRelationTaskSummary["priority"];
        relatedTaskOwnerAgentId: string | null;
        relatedTaskOwnerUserId: string | null;
        sourceKind: TaskReferenceSourceKind;
        sourceRecordId: string | null;
        documentKey: string | null;
        matchedText: string | null;
      }>,
    ) => {
      const grouped = new Map<string, TaskRelatedWorkItem>();
      for (const row of rows) {
        const existing = grouped.get(row.relatedTaskId) ?? {
          task: toTaskSummary(row),
          mentionCount: 0,
          sources: [],
        };
        existing.mentionCount += 1;
        existing.sources.push({
          kind: row.sourceKind,
          sourceRecordId: row.sourceRecordId,
          label: sourceLabel(row.sourceKind, row.documentKey),
          matchedText: row.matchedText,
        });
        grouped.set(row.relatedTaskId, existing);
      }

      return [...grouped.values()]
        .map((item) => ({
          ...item,
          sources: [...item.sources].sort(sortSources),
        }))
        .sort(sortRelatedWork);
    };

    return {
      outbound: mapRows(outboundRows),
      inbound: mapRows(inboundRows),
    };
  }

  return {
    syncTask,
    syncComment,
    syncAnnotationComment,
    syncDocument,
    deleteDocumentSource,
    deleteCommentSource,
    listTaskReferenceSummary,
    diffTaskReferenceSummary: diffTaskSummaries,
    emptySummary,
  };
}
