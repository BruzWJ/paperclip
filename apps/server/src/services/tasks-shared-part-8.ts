import * as d from "./tasks-dependencies.js";

import type { TaskFilters } from "./tasks-shared-part-1.js";
import {
  type CanonicalTaskListRow,
  type CanonicalTaskWithLabelsAndRun,
  type TaskRow,
  TASK_LIST_RELATED_QUERY_CHUNK_SIZE,
} from "./tasks-shared-part-1.js";
import {
  chunkList,
  decodeDatabaseTextPreview,
  escapeLikePattern,
  inboxVisibleForUserCondition,
  participatedByAgentCondition,
  TASK_LIST_REQUEST_MAX_CHARS,
  taskCanonicalLastActivityAtExpr,
  touchedByUserCondition,
  unreadForUserCondition,
} from "./tasks-shared-part-2-section-1.js";
import {
  deriveTaskUserContext,
  latestTaskActivityAt,
  lowTrustBoundaryTaskCondition,
  nonPluginOperationTaskCondition,
  shouldIncludePluginOperationTasks,
  withTaskLabels,
} from "./tasks-shared-part-3-section-1.js";
import { activeRunMapForTasks, liveDescendantCountMapForTasks } from "./tasks-shared-part-4.js";
import { listTaskBlockerAttentionMap } from "./tasks-shared-part-5.js";
import {
  BLOCKED_INBOX_TERMINAL_STATUSES,
  blockedByMapForTasks,
  hasPlanDocumentCondition,
  lastActivityStatsForTasks,
  taskListSelect,
  userCommentStatsForTasks,
  userReadStatsForTasks,
  withActiveRuns,
} from "./tasks-shared-part-6-section-1.js";
import {
  blockedInboxResponseRequest,
  blockedInboxSearchText,
  compareBlockedInboxRows,
  listTaskBlockedInboxAttentionMap,
  taskOwnerAgentFilter,
} from "./tasks-shared-part-7-section-1.js";
export async function blockedInboxTaskConditions(dbOrTx: any, companyId: string, filters?: TaskFilters) {
  const conditions = [
    d.eq(d.tasks.companyId, companyId),
    d.visibleTaskCondition(),
    d.notInArray(d.tasks.boardPresentationStatus, [...BLOCKED_INBOX_TERMINAL_STATUSES]),
  ];
  const touchedByUserId = filters?.touchedByUserId;
  const inboxArchivedByUserId = filters?.inboxArchivedByUserId;
  const unreadForUserId = filters?.unreadForUserId;
  const contextUserId = unreadForUserId ?? touchedByUserId ?? inboxArchivedByUserId;

  if (filters?.descendantOf) {
    conditions.push(d.sql<boolean>`
      ${d.tasks.id} IN (
        WITH RECURSIVE descendants(id) AS (
          SELECT ${d.tasks.id}
          FROM ${d.tasks}
          WHERE ${d.tasks.companyId} = ${companyId}
            AND ${d.tasks.parentId} = ${filters.descendantOf}
          UNION
          SELECT ${d.tasks.id}
          FROM ${d.tasks}
          JOIN descendants ON ${d.tasks.parentId} = descendants.id
          WHERE ${d.tasks.companyId} = ${companyId}
        )
        SELECT id FROM descendants
      )
    `);
  }
  const lowTrustCondition = lowTrustBoundaryTaskCondition(companyId, filters?.lowTrustBoundary);
  if (lowTrustCondition) conditions.push(lowTrustCondition);
  const statuses = filters?.status ?? [];
  if (statuses.length > 0) {
    conditions.push(
      statuses.length === 1
        ? d.eq(d.tasks.boardPresentationStatus, statuses[0]!)
        : d.inArray(d.tasks.boardPresentationStatus, statuses),
    );
  }
  const ownerAgentFilter = taskOwnerAgentFilter(filters?.ownerAgentId);
  if (ownerAgentFilter === null) {
    conditions.push(d.isNull(d.tasks.ownerAgentId));
  } else if (ownerAgentFilter) {
    conditions.push(d.eq(d.tasks.ownerAgentId, ownerAgentFilter));
  }
  if (filters?.participantAgentId)
    conditions.push(participatedByAgentCondition(companyId, filters.participantAgentId));
  if (filters?.ownerUserId) conditions.push(d.eq(d.tasks.ownerUserId, filters.ownerUserId));
  if (touchedByUserId) conditions.push(touchedByUserCondition(companyId, touchedByUserId));
  if (inboxArchivedByUserId) conditions.push(inboxVisibleForUserCondition(companyId, inboxArchivedByUserId));
  if (unreadForUserId) conditions.push(unreadForUserCondition(companyId, unreadForUserId));
  if (filters?.projectId) conditions.push(d.eq(d.tasks.projectId, filters.projectId));
  if (filters?.parentId) conditions.push(d.eq(d.tasks.parentId, filters.parentId));
  if (filters?.originKind) conditions.push(d.eq(d.tasks.originKind, filters.originKind));
  if (filters?.originId) conditions.push(d.eq(d.tasks.originId, filters.originId));
  if (filters?.hasPlanDocument !== undefined) {
    conditions.push(hasPlanDocumentCondition(companyId, filters.hasPlanDocument));
  }
  if (!shouldIncludePluginOperationTasks(filters)) conditions.push(nonPluginOperationTaskCondition());
  if (filters?.labelId) {
    const labeledTaskIds = await dbOrTx
      .select({ taskId: d.taskLabels.taskId })
      .from(d.taskLabels)
      .where(d.and(d.eq(d.taskLabels.companyId, companyId), d.eq(d.taskLabels.labelId, filters.labelId)));
    if (labeledTaskIds.length === 0) return { conditions: [d.sql<boolean>`false`], contextUserId };
    conditions.push(
      d.inArray(
        d.tasks.id,
        labeledTaskIds.map((row: { taskId: string }) => row.taskId),
      ),
    );
  }
  if (filters?.excludeRoutineExecutions && !filters?.originKind && !filters?.originId) {
    conditions.push(d.ne(d.tasks.originKind, "routine_execution"));
  }

  return { conditions, contextUserId };
}
export async function listBlockedInboxTasks(
  dbOrTx: any,
  companyId: string,
  filters?: TaskFilters,
): Promise<
  Array<
    CanonicalTaskWithLabelsAndRun & {
      blockedBy?: d.TaskRelationTaskSummary[];
      blockerAttention?: d.TaskBlockerAttention;
      blockedInboxAttention: d.TaskBlockedInboxAttention;
      liveDescendantCount?: number;
      lastActivityAt: Date;
      myLastTouchAt?: Date | null;
      lastExternalCommentAt?: Date | null;
      isUnreadForMe?: boolean;
    }
  >
> {
  const { conditions, contextUserId } = await blockedInboxTaskConditions(dbOrTx, companyId, filters);

  const rows: CanonicalTaskListRow[] = (
    await dbOrTx
      .select(taskListSelect)
      .from(d.tasks)
      .where(d.and(...conditions))
      .orderBy(
        d.desc(taskCanonicalLastActivityAtExpr(companyId)),
        d.desc(d.tasks.updatedAt),
        d.desc(d.tasks.id),
      )
  ).map((row: CanonicalTaskListRow) => ({
    ...row,
    request: decodeDatabaseTextPreview(row.request, TASK_LIST_REQUEST_MAX_CHARS),
  }));
  const withLabels = await withTaskLabels(dbOrTx, rows);
  const withRuns = withActiveRuns(withLabels, await activeRunMapForTasks(dbOrTx, withLabels));
  if (withRuns.length === 0) return [];

  const taskIds = withRuns.map((row) => row.id);
  const includeLiveDescendantSummary = filters?.includeLiveDescendantSummary === true;
  const [
    statsRows,
    readRows,
    lastActivityRows,
    blockedByMap,
    blockerAttentionByTaskId,
    blockedInboxAttentionByTaskId,
    liveDescendantCountByTaskId,
  ] = await Promise.all([
    contextUserId ? userCommentStatsForTasks(dbOrTx, companyId, contextUserId, taskIds) : Promise.resolve([]),
    contextUserId ? userReadStatsForTasks(dbOrTx, companyId, contextUserId, taskIds) : Promise.resolve([]),
    lastActivityStatsForTasks(dbOrTx, companyId, taskIds),
    blockedByMapForTasks(dbOrTx, companyId, taskIds),
    listTaskBlockerAttentionMap(dbOrTx, companyId, withRuns),
    listTaskBlockedInboxAttentionMap(dbOrTx, companyId, withRuns),
    includeLiveDescendantSummary
      ? liveDescendantCountMapForTasks(dbOrTx, companyId, taskIds)
      : Promise.resolve(new Map<string, number>()),
  ]);

  const rawSearchInput = filters?.q ?? "";
  const rawSearch = rawSearchInput.toLowerCase();
  const commentSearchMatchTaskIds = new Set<string>();
  if (rawSearchInput) {
    const containsPattern = `%${escapeLikePattern(rawSearchInput)}%`;
    for (const taskIdChunk of chunkList(taskIds, TASK_LIST_RELATED_QUERY_CHUNK_SIZE)) {
      const rows = await dbOrTx
        .select({ taskId: d.taskComments.taskId })
        .from(d.taskComments)
        .where(
          d.and(
            d.eq(d.taskComments.companyId, companyId),
            d.inArray(d.taskComments.taskId, taskIdChunk),
            d.sql<boolean>`${d.taskComments.body} ILIKE ${containsPattern} ESCAPE '\\'`,
          ),
        );
      for (const row of rows as Array<{ taskId: string }>) commentSearchMatchTaskIds.add(row.taskId);
    }
  }
  const statsByTaskId = new Map(statsRows.map((row) => [row.taskId, row]));
  const readByTaskId = new Map(readRows.map((row) => [row.taskId, row.myLastReadAt]));
  const lastActivityByTaskId = new Map(lastActivityRows.map((row) => [row.taskId, row]));

  const enriched = withRuns
    .flatMap((row) => {
      const blockedInboxAttention = blockedInboxAttentionByTaskId.get(row.id);
      if (!blockedInboxAttention) return [];
      if (
        rawSearch &&
        !blockedInboxSearchText(blockedInboxAttention, row).includes(rawSearch) &&
        !commentSearchMatchTaskIds.has(row.id)
      )
        return [];

      const activity = lastActivityByTaskId.get(row.id);
      const lastActivityAt =
        latestTaskActivityAt(
          row.updatedAt,
          activity?.latestCommentAt ?? null,
          activity?.latestLogAt ?? null,
        ) ?? row.updatedAt;
      return [
        {
          ...row,
          request: blockedInboxResponseRequest(blockedInboxAttention, row),
          blockedBy: blockedByMap.get(row.id) ?? [],
          lastActivityAt,
          ...(blockerAttentionByTaskId.has(row.id)
            ? { blockerAttention: blockerAttentionByTaskId.get(row.id) }
            : {}),
          blockedInboxAttention,
          ...(includeLiveDescendantSummary
            ? {
                liveDescendantCount: liveDescendantCountByTaskId.get(row.id) ?? 0,
              }
            : {}),
          ...(contextUserId
            ? deriveTaskUserContext(row, contextUserId, {
                myLastCommentAt: statsByTaskId.get(row.id)?.myLastCommentAt ?? null,
                myLastReadAt: readByTaskId.get(row.id) ?? null,
                lastExternalCommentAt: statsByTaskId.get(row.id)?.lastExternalCommentAt ?? null,
              })
            : {}),
        },
      ];
    })
    .sort(compareBlockedInboxRows);

  const offset =
    typeof filters?.offset === "number" && Number.isFinite(filters.offset)
      ? Math.max(0, Math.floor(filters.offset))
      : 0;
  const limit =
    typeof filters?.limit === "number" && Number.isFinite(filters.limit)
      ? Math.max(1, Math.floor(filters.limit))
      : undefined;
  return limit === undefined ? enriched.slice(offset) : enriched.slice(offset, offset + limit);
}

export async function countBlockedInboxTasks(
  dbOrTx: any,
  companyId: string,
  filters?: TaskFilters,
): Promise<number> {
  const { conditions } = await blockedInboxTaskConditions(dbOrTx, companyId, filters);
  const rawRows = (await dbOrTx
    .select()
    .from(d.tasks)
    .where(d.and(...conditions))) as TaskRow[];
  if (rawRows.length === 0) return 0;
  const rows = await withTaskLabels(dbOrTx, rawRows);

  const blockedInboxAttentionByTaskId = await listTaskBlockedInboxAttentionMap(dbOrTx, companyId, rows);
  const rawSearchInput = filters?.q ?? "";
  const rawSearch = rawSearchInput.toLowerCase();
  const commentSearchMatchTaskIds = new Set<string>();
  if (rawSearchInput) {
    const taskIds = rows.map((row) => row.id);
    const containsPattern = `%${escapeLikePattern(rawSearchInput)}%`;
    for (const taskIdChunk of chunkList(taskIds, TASK_LIST_RELATED_QUERY_CHUNK_SIZE)) {
      const commentRows = await dbOrTx
        .select({ taskId: d.taskComments.taskId })
        .from(d.taskComments)
        .where(
          d.and(
            d.eq(d.taskComments.companyId, companyId),
            d.inArray(d.taskComments.taskId, taskIdChunk),
            d.sql<boolean>`${d.taskComments.body} ILIKE ${containsPattern} ESCAPE '\\'`,
          ),
        );
      for (const row of commentRows as Array<{ taskId: string }>) commentSearchMatchTaskIds.add(row.taskId);
    }
  }

  return rows.reduce((count: number, row) => {
    const attention = blockedInboxAttentionByTaskId.get(row.id);
    if (!attention) return count;
    if (
      rawSearch &&
      !blockedInboxSearchText(attention, row).includes(rawSearch) &&
      !commentSearchMatchTaskIds.has(row.id)
    )
      return count;
    return count + 1;
  }, 0);
}

export type TaskCommentRow = typeof d.taskComments.$inferSelect;
export type BoardAuthorLabels = {
  agents: Map<string, string>;
  users: Map<string, string>;
};

export function taskServiceContext(db: d.Db) {
  const instanceSettings = d.instanceSettingsService(db);
  return { db, instanceSettings };
}
