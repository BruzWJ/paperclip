import * as d from "./tasks-dependencies.js";

import {
  TASK_LIST_RELATED_QUERY_CHUNK_SIZE,
  type TaskActiveRunRow,
  type TaskLabelRow,
  type TaskLastActivityStat,
  type TaskReadStat,
  type TaskRow,
  type TaskUserCommentStats,
} from "./tasks-shared-part-1.js";
import {
  chunkList,
  TASK_LIST_REQUEST_MAX_BYTES,
  TASK_LOCAL_INBOX_ACTIVITY_ACTIONS,
} from "./tasks-shared-part-2-section-1.js";
import { taskRelationSortLabel } from "./tasks-shared-part-4.js";

export const taskListSelect = {
  id: d.tasks.id,
  companyId: d.tasks.companyId,
  projectId: d.tasks.projectId,
  projectWorkspaceId: d.tasks.projectWorkspaceId,
  goalId: d.tasks.goalId,
  parentId: d.tasks.parentId,
  parentOwnershipEpoch: d.tasks.parentOwnershipEpoch,
  title: d.tasks.title,
  request: d.sql<string>`
    encode(
      substring(
        convert_to(${d.tasks.request}, current_setting('server_encoding'))
        FROM 1 FOR ${TASK_LIST_REQUEST_MAX_BYTES}
      ),
      'base64'
    )
  `,
  lifecycleStatus: d.tasks.lifecycleStatus,
  boardPresentationStatus: d.tasks.boardPresentationStatus,
  disposition: d.tasks.disposition,
  workMode: d.tasks.workMode,
  priority: d.tasks.priority,
  ownerKind: d.tasks.ownerKind,
  ownerAgentId: d.tasks.ownerAgentId,
  ownerUserId: d.tasks.ownerUserId,
  ownershipEpoch: d.tasks.ownershipEpoch,
  creatorKind: d.tasks.creatorKind,
  creatorAuthorityId: d.tasks.creatorAuthorityId,
  creatorAdapterConfigRevisionId: d.tasks.creatorAdapterConfigRevisionId,
  creatorUserId: d.tasks.creatorUserId,
  creatorPluginInstallationId: d.tasks.creatorPluginInstallationId,
  creatorPluginKey: d.tasks.creatorPluginKey,
  creatorCallbackKey: d.tasks.creatorCallbackKey,
  creatorCallbackVersion: d.tasks.creatorCallbackVersion,
  creatorRoutineId: d.tasks.creatorRoutineId,
  creatorRoutineDispatchId: d.tasks.creatorRoutineDispatchId,
  creatorSystemSourceKind: d.tasks.creatorSystemSourceKind,
  creatorSystemSourceId: d.tasks.creatorSystemSourceId,
  escalatedFromAffectedTaskId: d.tasks.escalatedFromAffectedTaskId,
  escalatedFromTriggeringRunId: d.tasks.escalatedFromTriggeringRunId,
  escalatedFromReason: d.tasks.escalatedFromReason,
  affectedOwnershipEpoch: d.tasks.affectedOwnershipEpoch,
  responsibleUserId: d.tasks.responsibleUserId,
  taskNumber: d.tasks.taskNumber,
  identifier: d.tasks.identifier,
  originKind: d.tasks.originKind,
  originId: d.tasks.originId,
  originRunId: d.tasks.originRunId,
  originFingerprint: d.tasks.originFingerprint,
  requestDepth: d.tasks.requestDepth,
  billingCode: d.tasks.billingCode,
  executionPolicy: d.sql<null>`null`,
  executionState: d.sql<null>`null`,
  monitorNextCheckAt: d.tasks.monitorNextCheckAt,
  monitorLastTriggeredAt: d.tasks.monitorLastTriggeredAt,
  monitorAttemptCount: d.tasks.monitorAttemptCount,
  monitorNotes: d.tasks.monitorNotes,
  monitorScheduledBy: d.tasks.monitorScheduledBy,
  executionWorkspaceId: d.sql<string | null>`(
    select ${d.taskExecutionWorkspaceBindings.executionWorkspaceId}
    from ${d.taskExecutionWorkspaceBindings}
    where ${d.taskExecutionWorkspaceBindings.companyId} = ${d.tasks.companyId}
      and ${d.taskExecutionWorkspaceBindings.taskId} = ${d.tasks.id}
      and ${d.taskExecutionWorkspaceBindings.ownershipEpoch} = ${d.tasks.ownershipEpoch}
    limit 1
  )`,
  sourceTrust: d.tasks.sourceTrust,
  startedAt: d.tasks.startedAt,
  completedAt: d.tasks.completedAt,
  cancelledAt: d.tasks.cancelledAt,
  hiddenAt: d.tasks.hiddenAt,
  createdAt: d.tasks.createdAt,
  updatedAt: d.tasks.updatedAt,
};

export function withActiveRuns<T extends Pick<TaskRow, "id">>(
  taskRows: T[],
  runMap: Map<string, TaskActiveRunRow>,
): Array<T & { activeRun: TaskActiveRunRow | null }> {
  return taskRows.map((row) => ({
    ...row,
    activeRun: runMap.get(row.id) ?? null,
  }));
}

export async function userCommentStatsForTasks(
  dbOrTx: any,
  companyId: string,
  userId: string,
  taskIds: string[],
): Promise<TaskUserCommentStats[]> {
  const stats: TaskUserCommentStats[] = [];
  for (const taskIdChunk of chunkList(taskIds, TASK_LIST_RELATED_QUERY_CHUNK_SIZE)) {
    const rows = await dbOrTx
      .select({
        taskId: d.taskComments.taskId,
        myLastCommentAt: d.sql<Date | null>`
          MAX(CASE WHEN ${d.taskComments.authorUserId} = ${userId} THEN ${d.taskComments.createdAt} END)
        `,
        lastExternalCommentAt: d.sql<Date | null>`
          MAX(
            CASE
              WHEN ${d.taskComments.authorUserId} IS NULL OR ${d.taskComments.authorUserId} <> ${userId}
              THEN ${d.taskComments.createdAt}
            END
          )
        `,
      })
      .from(d.taskComments)
      .where(d.and(d.eq(d.taskComments.companyId, companyId), d.inArray(d.taskComments.taskId, taskIdChunk)))
      .groupBy(d.taskComments.taskId);
    stats.push(...rows);
  }
  return stats;
}

export async function userReadStatsForTasks(
  dbOrTx: any,
  companyId: string,
  userId: string,
  taskIds: string[],
): Promise<TaskReadStat[]> {
  const stats: TaskReadStat[] = [];
  for (const taskIdChunk of chunkList(taskIds, TASK_LIST_RELATED_QUERY_CHUNK_SIZE)) {
    const rows = await dbOrTx
      .select({
        taskId: d.taskReadStates.taskId,
        myLastReadAt: d.taskReadStates.lastReadAt,
      })
      .from(d.taskReadStates)
      .where(
        d.and(
          d.eq(d.taskReadStates.companyId, companyId),
          d.eq(d.taskReadStates.userId, userId),
          d.inArray(d.taskReadStates.taskId, taskIdChunk),
        ),
      );
    stats.push(...rows);
  }
  return stats;
}

export async function lastActivityStatsForTasks(
  dbOrTx: any,
  companyId: string,
  taskIds: string[],
): Promise<TaskLastActivityStat[]> {
  const byTaskId = new Map<string, TaskLastActivityStat>();
  for (const taskIdChunk of chunkList(taskIds, TASK_LIST_RELATED_QUERY_CHUNK_SIZE)) {
    const [commentRows, logRows] = await Promise.all([
      dbOrTx
        .select({
          taskId: d.taskComments.taskId,
          latestCommentAt: d.sql<Date | null>`MAX(${d.taskComments.createdAt})`,
        })
        .from(d.taskComments)
        .where(
          d.and(d.eq(d.taskComments.companyId, companyId), d.inArray(d.taskComments.taskId, taskIdChunk)),
        )
        .groupBy(d.taskComments.taskId),
      dbOrTx
        .select({
          taskId: d.activityLog.entityId,
          latestLogAt: d.sql<Date | null>`MAX(${d.activityLog.createdAt})`,
        })
        .from(d.activityLog)
        .where(
          d.and(
            d.eq(d.activityLog.companyId, companyId),
            d.eq(d.activityLog.entityType, "task"),
            d.inArray(d.activityLog.entityId, taskIdChunk),
            d.sql`${d.activityLog.action} NOT IN (${d.sql.join(
              TASK_LOCAL_INBOX_ACTIVITY_ACTIONS.map((action) => d.sql`${action}`),
              d.sql`, `,
            )})`,
          ),
        )
        .groupBy(d.activityLog.entityId),
    ]);

    for (const row of commentRows) {
      byTaskId.set(row.taskId, {
        taskId: row.taskId,
        latestCommentAt: row.latestCommentAt,
        latestLogAt: null,
      });
    }
    for (const row of logRows) {
      const existing = byTaskId.get(row.taskId);
      if (existing) existing.latestLogAt = row.latestLogAt;
      else {
        byTaskId.set(row.taskId, {
          taskId: row.taskId,
          latestCommentAt: null,
          latestLogAt: row.latestLogAt,
        });
      }
    }
  }
  return [...byTaskId.values()];
}

export async function blockedByMapForTasks(
  dbOrTx: any,
  companyId: string,
  taskIds: string[],
): Promise<Map<string, d.TaskRelationTaskSummary[]>> {
  const map = new Map<string, d.TaskRelationTaskSummary[]>();
  const uniqueTaskIds = [...new Set(taskIds)];
  if (uniqueTaskIds.length === 0) return map;

  for (const taskId of uniqueTaskIds) {
    map.set(taskId, []);
  }

  for (const taskIdChunk of chunkList(uniqueTaskIds, TASK_LIST_RELATED_QUERY_CHUNK_SIZE)) {
    const rows = await dbOrTx
      .select({
        currentTaskId: d.taskRelations.relatedTaskId,
        relatedId: d.tasks.id,
        taskNumber: d.tasks.taskNumber,
        identifier: d.tasks.identifier,
        title: d.tasks.title,
        boardPresentationStatus: d.tasks.boardPresentationStatus,
        priority: d.tasks.priority,
        ownerAgentId: d.tasks.ownerAgentId,
        ownerUserId: d.tasks.ownerUserId,
      })
      .from(d.taskRelations)
      .innerJoin(d.tasks, d.eq(d.taskRelations.taskId, d.tasks.id))
      .where(
        d.and(
          d.eq(d.taskRelations.companyId, companyId),
          d.eq(d.taskRelations.type, "blocks"),
          d.inArray(d.taskRelations.relatedTaskId, taskIdChunk),
        ),
      );

    for (const row of rows) {
      const blockedBy = map.get(row.currentTaskId);
      if (!blockedBy) continue;
      blockedBy.push({
        id: row.relatedId,
        taskNumber: row.taskNumber,
        identifier: row.identifier,
        title: row.title,
        boardPresentationStatus:
          row.boardPresentationStatus as d.TaskRelationTaskSummary["boardPresentationStatus"],
        priority: row.priority as d.TaskRelationTaskSummary["priority"],
        ownerAgentId: row.ownerAgentId,
        ownerUserId: row.ownerUserId,
      });
    }
  }

  for (const blockedBy of map.values()) {
    blockedBy.sort((a, b) => taskRelationSortLabel(a).localeCompare(taskRelationSortLabel(b)));
  }

  return map;
}

export const BLOCKED_INBOX_TERMINAL_STATUSES = ["done", "cancelled"] as const;

export const BLOCKED_INBOX_PENDING_APPROVAL_STATUSES = ["pending", "revision_requested"] as const;

export type BlockedInboxTaskRow = TaskRow & {
  labels?: TaskLabelRow[];
  labelIds?: string[];
};

export type BlockedInboxApprovalRow = {
  approvalId: string;
  taskId: string;
  createdAt: Date;
};

export function taskRef(
  row:
    | Pick<
        TaskRow,
        | "id"
        | "taskNumber"
        | "identifier"
        | "title"
        | "boardPresentationStatus"
        | "priority"
        | "ownerAgentId"
        | "ownerUserId"
      >
    | null
    | undefined,
): d.TaskBlockedInboxTaskRef | null {
  if (!row) return null;
  return {
    id: row.id,
    taskNumber: row.taskNumber,
    identifier: row.identifier,
    title: row.title,
    boardPresentationStatus: row.boardPresentationStatus,
    priority: row.priority as d.TaskBlockedInboxTaskRef["priority"],
    ownerAgentId: row.ownerAgentId,
    ownerUserId: row.ownerUserId,
  };
}

export function hasPlanDocumentCondition(companyId: string, hasPlanDocument: boolean): d.SQL {
  const existsPlanDocument = d.sql<boolean>`
    EXISTS (
      SELECT 1
      FROM ${d.taskDocuments}
      WHERE ${d.taskDocuments.companyId} = ${companyId}
        AND ${d.taskDocuments.taskId} = ${d.tasks.id}
        AND ${d.taskDocuments.key} = 'plan'
    )
  `;
  return hasPlanDocument ? existsPlanDocument : d.sql<boolean>`NOT ${existsPlanDocument}`;
}

export function isoDate(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
