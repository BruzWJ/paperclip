import * as d from "./tasks-dependencies.js";

import { ALL_TASK_STATUSES } from "./tasks-shared-part-1.js";

export type TaskBlockerDiagnosticsTaskRow = {
  id: string;
  companyId: string;
  projectId: string | null;
  parentId: string | null;
  taskNumber: number;
  identifier: string;
  title: string | null;
  boardPresentationStatus: (typeof ALL_TASK_STATUSES)[number];
  priority: string;
  ownerAgentId: string | null;
  ownerUserId: string | null;
};

export type TaskSubtreeDiagnosticsTaskRow = TaskBlockerDiagnosticsTaskRow & {
  depth: number;
  createdAt: Date;
  updatedAt: Date;
};

export type TaskSubtreeDiagnosticsBlockerRow = TaskBlockerDiagnosticsTaskRow & {
  blockedTaskId: string;
  relationCreatedAt: Date;
};

export type TaskSubtreeDiagnosticsBlockerResultRow = TaskSubtreeDiagnosticsBlockerRow & {
  rowNumber: number | string;
};

export type TaskDependencyReadiness = {
  taskId: string;
  blockerTaskIds: string[];
  unresolvedBlockerTaskIds: string[];
  unresolvedBlockerCount: number;
  allBlockersDone: boolean;
  isDependencyReady: boolean;
};

export const TASK_LIST_REQUEST_MAX_CHARS = 1200;

export const TASK_LIST_REQUEST_MAX_BYTES = TASK_LIST_REQUEST_MAX_CHARS * 4;

export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

export function chunkList<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

export function truncateByCodePoint(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return Array.from(value).slice(0, maxChars).join("");
}

export function decodeDatabaseTextPreview(value: string, maxChars: number): string {
  return truncateByCodePoint(d.Buffer.from(value, "base64").toString("utf8"), maxChars);
}

export function createTaskDependencyReadiness(taskId: string): TaskDependencyReadiness {
  return {
    taskId,
    blockerTaskIds: [],
    unresolvedBlockerTaskIds: [],
    unresolvedBlockerCount: 0,
    allBlockersDone: true,
    isDependencyReady: true,
  };
}

export async function listTaskDependencyReadinessMap(
  dbOrTx: Pick<d.Db, "select">,
  companyId: string,
  taskIds: string[],
) {
  const uniqueTaskIds = [...new Set(taskIds.filter(Boolean))];
  const readinessMap = new Map<string, TaskDependencyReadiness>();
  for (const taskId of uniqueTaskIds) {
    readinessMap.set(taskId, createTaskDependencyReadiness(taskId));
  }
  if (uniqueTaskIds.length === 0) return readinessMap;

  const blockerRows = await dbOrTx
    .select({
      taskId: d.taskRelations.relatedTaskId,
      blockerTaskId: d.taskRelations.taskId,
      blockerStatus: d.tasks.boardPresentationStatus,
    })
    .from(d.taskRelations)
    .innerJoin(d.tasks, d.eq(d.taskRelations.taskId, d.tasks.id))
    .where(
      d.and(
        d.eq(d.taskRelations.companyId, companyId),
        d.eq(d.taskRelations.type, "blocks"),
        d.inArray(d.taskRelations.relatedTaskId, uniqueTaskIds),
      ),
    );

  for (const row of blockerRows) {
    const current = readinessMap.get(row.taskId) ?? createTaskDependencyReadiness(row.taskId);
    current.blockerTaskIds.push(row.blockerTaskId);
    // Only done blockers resolve dependents; cancelled blockers stay unresolved
    // until an operator removes or replaces the blocker relationship explicitly.
    if (row.blockerStatus !== "done") {
      current.unresolvedBlockerTaskIds.push(row.blockerTaskId);
      current.unresolvedBlockerCount += 1;
      current.allBlockersDone = false;
      current.isDependencyReady = false;
    }
    readinessMap.set(row.taskId, current);
  }

  return readinessMap;
}

export async function listUnresolvedBlockerTaskIds(
  dbOrTx: Pick<d.Db, "select">,
  companyId: string,
  blockerTaskIds: string[],
) {
  const uniqueBlockerTaskIds = [...new Set(blockerTaskIds.filter(Boolean))];
  if (uniqueBlockerTaskIds.length === 0) return [];
  return dbOrTx
    .select({ id: d.tasks.id })
    .from(d.tasks)
    .where(
      d.and(
        d.eq(d.tasks.companyId, companyId),
        d.inArray(d.tasks.id, uniqueBlockerTaskIds),
        // Cancelled blockers intentionally remain unresolved until the relation changes.
        d.ne(d.tasks.boardPresentationStatus, "done"),
      ),
    )
    .then((rows) => rows.map((row) => row.id));
}

export function touchedByUserCondition(companyId: string, userId: string) {
  return d.sql<boolean>`
    (
      ${d.tasks.creatorUserId} = ${userId}
      OR ${d.tasks.ownerUserId} = ${userId}
      OR EXISTS (
        SELECT 1
        FROM ${d.taskReadStates}
        WHERE ${d.taskReadStates.taskId} = ${d.tasks.id}
          AND ${d.taskReadStates.companyId} = ${companyId}
          AND ${d.taskReadStates.userId} = ${userId}
      )
      OR EXISTS (
        SELECT 1
        FROM ${d.taskComments}
        WHERE ${d.taskComments.taskId} = ${d.tasks.id}
          AND ${d.taskComments.companyId} = ${companyId}
          AND ${d.taskComments.authorUserId} = ${userId}
      )
    )
  `;
}

export function participatedByAgentCondition(companyId: string, agentId: string) {
  return d.sql<boolean>`
    (
      (
        ${d.tasks.creatorKind} = 'agent-execution'
        AND ${d.tasks.creatorAuthorityId} = ${agentId}
      )
      OR ${d.tasks.ownerAgentId} = ${agentId}
      OR EXISTS (
        SELECT 1
        FROM ${d.taskComments}
        WHERE ${d.taskComments.taskId} = ${d.tasks.id}
          AND ${d.taskComments.companyId} = ${companyId}
          AND ${d.taskComments.authorAgentId} = ${agentId}
      )
      OR EXISTS (
        SELECT 1
        FROM ${d.activityLog}
        WHERE ${d.activityLog.companyId} = ${companyId}
          AND ${d.activityLog.entityType} = 'task'
          AND ${d.activityLog.entityId} = ${d.tasks.id}::text
          AND ${d.activityLog.agentId} = ${agentId}
      )
    )
  `;
}

export function myLastCommentAtExpr(companyId: string, userId: string) {
  return d.sql<Date | null>`
    (
      SELECT MAX(${d.taskComments.createdAt})
      FROM ${d.taskComments}
      WHERE ${d.taskComments.taskId} = ${d.tasks.id}
        AND ${d.taskComments.companyId} = ${companyId}
        AND ${d.taskComments.authorUserId} = ${userId}
    )
  `;
}

export function myLastReadAtExpr(companyId: string, userId: string) {
  return d.sql<Date | null>`
    (
      SELECT MAX(${d.taskReadStates.lastReadAt})
      FROM ${d.taskReadStates}
      WHERE ${d.taskReadStates.taskId} = ${d.tasks.id}
        AND ${d.taskReadStates.companyId} = ${companyId}
        AND ${d.taskReadStates.userId} = ${userId}
    )
  `;
}

export function myLastTouchAtExpr(companyId: string, userId: string) {
  const myLastCommentAt = myLastCommentAtExpr(companyId, userId);
  const myLastReadAt = myLastReadAtExpr(companyId, userId);
  return d.sql<Date | null>`
    GREATEST(
      COALESCE(${myLastCommentAt}, to_timestamp(0)),
      COALESCE(${myLastReadAt}, to_timestamp(0)),
      COALESCE(CASE WHEN ${d.tasks.creatorUserId} = ${userId} THEN ${d.tasks.createdAt} ELSE NULL END, to_timestamp(0)),
      COALESCE(CASE WHEN ${d.tasks.ownerUserId} = ${userId} THEN ${d.tasks.createdAt} ELSE NULL END, to_timestamp(0))
    )
  `;
}

export const TASK_LOCAL_INBOX_ACTIVITY_ACTIONS = [
  "task.read_marked",
  "task.read_unmarked",
  "task.inbox_archived",
  "task.inbox_unarchived",
] as const;

export function taskLatestCommentAtExpr(companyId: string) {
  return d.sql<Date | null>`
    (
      SELECT MAX(${d.taskComments.createdAt})
      FROM ${d.taskComments}
      WHERE ${d.taskComments.taskId} = ${d.tasks.id}
        AND ${d.taskComments.companyId} = ${companyId}
    )
  `;
}

export function taskLatestLogAtExpr(companyId: string) {
  return d.sql<Date | null>`
    (
      SELECT MAX(${d.activityLog.createdAt})
      FROM ${d.activityLog}
      WHERE ${d.activityLog.companyId} = ${companyId}
        AND ${d.activityLog.entityType} = 'task'
        AND ${d.activityLog.entityId} = ${d.tasks.id}::text
        AND ${d.activityLog.action} NOT IN (${d.sql.join(
          TASK_LOCAL_INBOX_ACTIVITY_ACTIONS.map((action) => d.sql`${action}`),
          d.sql`, `,
        )})
    )
  `;
}

export function taskCanonicalLastActivityAtExpr(companyId: string) {
  const latestCommentAt = taskLatestCommentAtExpr(companyId);
  const latestLogAt = taskLatestLogAtExpr(companyId);
  return d.sql<Date>`
    GREATEST(
      ${d.tasks.updatedAt},
      COALESCE(${latestCommentAt}, to_timestamp(0)),
      COALESCE(${latestLogAt}, to_timestamp(0))
    )
  `;
}

export function unreadForUserCondition(companyId: string, userId: string) {
  const touchedCondition = touchedByUserCondition(companyId, userId);
  const myLastTouchAt = myLastTouchAtExpr(companyId, userId);
  return d.sql<boolean>`
    (
      ${touchedCondition}
      AND EXISTS (
        SELECT 1
        FROM ${d.taskComments}
        WHERE ${d.taskComments.taskId} = ${d.tasks.id}
          AND ${d.taskComments.companyId} = ${companyId}
          AND (
            ${d.taskComments.authorUserId} IS NULL
            OR ${d.taskComments.authorUserId} <> ${userId}
          )
          AND ${d.taskComments.createdAt} > ${myLastTouchAt}
      )
    )
  `;
}

export function inboxVisibleForUserCondition(companyId: string, userId: string) {
  return d.sql<boolean>`
    NOT EXISTS (
      SELECT 1
      FROM ${d.taskInboxArchives}
      WHERE ${d.taskInboxArchives.taskId} = ${d.tasks.id}
        AND ${d.taskInboxArchives.companyId} = ${companyId}
        AND ${d.taskInboxArchives.userId} = ${userId}
        AND NOT (
          EXISTS (
            SELECT 1
            FROM ${d.activityLog}
            WHERE ${d.activityLog.companyId} = ${companyId}
              AND ${d.activityLog.entityType} = 'task'
              AND ${d.activityLog.entityId} = ${d.tasks.id}::text
              AND ${d.activityLog.action} = 'task.updated'
              AND ${d.activityLog.createdAt} > ${d.taskInboxArchives.archivedAt}
              AND ${d.activityLog.details}->>'status' IN ('in_review', 'blocked', 'done')
              AND ${d.activityLog.details}->'_previous'->>'status'
                IS DISTINCT FROM ${d.activityLog.details}->>'status'
          )
          OR EXISTS (
            SELECT 1
            FROM ${d.taskComments}
            WHERE ${d.taskComments.taskId} = ${d.tasks.id}
              AND ${d.taskComments.companyId} = ${companyId}
              AND ${d.taskComments.createdAt} > ${d.taskInboxArchives.archivedAt}
              AND (
                (
                  ${d.taskComments.authorType} = 'user'
                  AND
                  ${d.taskComments.authorUserId} IS NOT NULL
                  AND ${d.taskComments.authorUserId} <> ${userId}
                )
                OR POSITION(${`](user://${userId})`} IN ${d.taskComments.body}) > 0
              )
          )
        )
    )
  `;
}
