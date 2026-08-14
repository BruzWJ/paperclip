import * as d from "./tasks-dependencies.js";

import {
  TASK_LIST_REQUEST_MAX_CHARS,
  activeInboxArchiveFields,
  activeRunMapForTasks,
  blockedByMapForTasks,
  countBlockedInboxTasks,
  decodeDatabaseTextPreview,
  deriveTaskUserContext,
  escapeLikePattern,
  hasPlanDocumentCondition,
  inboxArchiveRowsForTasks,
  inboxVisibleForUserCondition,
  lastActivityStatsForTasks,
  latestTaskActivityAt,
  listBlockedInboxTasks,
  listTaskBlockedInboxAttentionMap,
  listTaskBlockerAttentionMap,
  liveDescendantCountMapForTasks,
  lowTrustBoundaryTaskCondition,
  nonPluginOperationTaskCondition,
  participatedByAgentCondition,
  shouldIncludePluginOperationTasks,
  taskListOrderBy,
  taskListSelect,
  taskOwnerAgentFilter,
  taskServiceContext,
  touchedByUserCondition,
  unreadForUserCondition,
  userCommentStatsForTasks,
  userReadStatsForTasks,
  withActiveRuns,
  withTaskLabels,
} from "./tasks-shared.js";
import type { CanonicalTaskListRow, TaskFilters } from "./tasks-shared-part-1.js";

export function taskServicePart1(db: d.Db) {
  const context = taskServiceContext(db);

  return {
    list: async (companyId: string, filters?: TaskFilters) => {
      if (filters?.attention === "blocked") {
        return listBlockedInboxTasks(db, companyId, {
          ...filters,
          includeBlockedBy: true,
          includeBlockedInboxAttention: true,
        });
      }

      const conditions = [d.eq(d.tasks.companyId, companyId), d.visibleTaskCondition()];
      const ownerAgentFilter = taskOwnerAgentFilter(filters?.ownerAgentId);
      const limit =
        typeof filters?.limit === "number" && Number.isFinite(filters.limit)
          ? Math.max(1, Math.floor(filters.limit))
          : undefined;
      const offset =
        typeof filters?.offset === "number" && Number.isFinite(filters.offset)
          ? Math.max(0, Math.floor(filters.offset))
          : 0;
      const touchedByUserId = filters?.touchedByUserId;
      const inboxArchivedByUserId = filters?.inboxArchivedByUserId;
      const unreadForUserId = filters?.unreadForUserId;
      const contextUserId = unreadForUserId ?? touchedByUserId ?? inboxArchivedByUserId;
      const includeBlockedBy = filters?.includeBlockedBy === true;
      const includeBlockedInboxAttention = filters?.includeBlockedInboxAttention === true;
      const includeLiveDescendantSummary = filters?.includeLiveDescendantSummary === true;
      const rawSearch = filters?.q ?? "";
      const hasSearch = rawSearch.length > 0;
      const escapedSearch = hasSearch ? escapeLikePattern(rawSearch) : "";
      const startsWithPattern = `${escapedSearch}%`;
      const containsPattern = `%${escapedSearch}%`;
      const titleStartsWithMatch = d.sql<boolean>`${d.tasks.title} ILIKE ${startsWithPattern} ESCAPE '\\'`;
      const titleContainsMatch = d.sql<boolean>`${d.tasks.title} ILIKE ${containsPattern} ESCAPE '\\'`;
      const identifierStartsWithMatch = d.sql<boolean>`${d.tasks.identifier} ILIKE ${startsWithPattern} ESCAPE '\\'`;
      const identifierContainsMatch = d.sql<boolean>`${d.tasks.identifier} ILIKE ${containsPattern} ESCAPE '\\'`;
      const requestContainsMatch = d.sql<boolean>`${d.tasks.request} ILIKE ${containsPattern} ESCAPE '\\'`;
      const commentContainsMatch = d.sql<boolean>`
        EXISTS (
          SELECT 1
          FROM ${d.taskComments}
          WHERE ${d.taskComments.taskId} = ${d.tasks.id}
            AND ${d.taskComments.companyId} = ${companyId}
            AND ${d.taskComments.body} ILIKE ${containsPattern} ESCAPE '\\'
        )
      `;
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
      if (statuses.length === 1) {
        conditions.push(d.eq(d.tasks.boardPresentationStatus, statuses[0]));
      } else if (statuses.length > 1) {
        conditions.push(d.inArray(d.tasks.boardPresentationStatus, statuses));
      }
      if (ownerAgentFilter === null) {
        conditions.push(d.isNull(d.tasks.ownerAgentId));
      } else if (ownerAgentFilter) {
        conditions.push(d.eq(d.tasks.ownerAgentId, ownerAgentFilter));
      }
      if (filters?.participantAgentId) {
        conditions.push(participatedByAgentCondition(companyId, filters.participantAgentId));
      }
      if (filters?.ownerUserId) {
        conditions.push(d.eq(d.tasks.ownerUserId, filters.ownerUserId));
      }
      if (touchedByUserId) {
        conditions.push(touchedByUserCondition(companyId, touchedByUserId));
      }
      if (inboxArchivedByUserId) {
        conditions.push(inboxVisibleForUserCondition(companyId, inboxArchivedByUserId));
      }
      if (unreadForUserId) {
        conditions.push(unreadForUserCondition(companyId, unreadForUserId));
      }
      if (filters?.projectId) conditions.push(d.eq(d.tasks.projectId, filters.projectId));
      if (filters?.parentId) conditions.push(d.eq(d.tasks.parentId, filters.parentId));
      if (filters?.originKind) conditions.push(d.eq(d.tasks.originKind, filters.originKind));
      if (filters?.originId) conditions.push(d.eq(d.tasks.originId, filters.originId));
      if (filters?.hasPlanDocument !== undefined) {
        conditions.push(hasPlanDocumentCondition(companyId, filters.hasPlanDocument));
      }
      if (!shouldIncludePluginOperationTasks(filters)) {
        conditions.push(nonPluginOperationTaskCondition());
      }
      if (filters?.labelId) {
        const labeledTaskIds = await db
          .select({ taskId: d.taskLabels.taskId })
          .from(d.taskLabels)
          .where(d.and(d.eq(d.taskLabels.companyId, companyId), d.eq(d.taskLabels.labelId, filters.labelId)));
        if (labeledTaskIds.length === 0) return [];
        conditions.push(
          d.inArray(
            d.tasks.id,
            labeledTaskIds.map((row) => row.taskId),
          ),
        );
      }
      if (hasSearch) {
        conditions.push(
          d.or(titleContainsMatch, identifierContainsMatch, requestContainsMatch, commentContainsMatch)!,
        );
      }
      if (filters?.excludeRoutineExecutions && !filters?.originKind && !filters?.originId) {
        conditions.push(d.ne(d.tasks.originKind, "routine_execution"));
      }
      const priorityOrder = d.sql`CASE ${d.tasks.priority} WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END`;
      const searchOrder = d.sql<number>`
        CASE
          WHEN ${titleStartsWithMatch} THEN 0
          WHEN ${titleContainsMatch} THEN 1
          WHEN ${identifierStartsWithMatch} THEN 2
          WHEN ${identifierContainsMatch} THEN 3
          WHEN ${commentContainsMatch} THEN 4
          WHEN ${requestContainsMatch} THEN 5
          ELSE 6
        END
      `;
      const baseQuery = db
        .select(taskListSelect)
        .from(d.tasks)
        .where(d.and(...conditions))
        .orderBy(
          ...taskListOrderBy(companyId, {
            hasSearch,
            priorityOrder,
            searchOrder,
            sortField: filters?.sortField,
            sortDir: filters?.sortDir,
          }),
        );
      const pageQuery =
        offset > 0
          ? limit === undefined
            ? baseQuery.offset(offset)
            : baseQuery.limit(limit).offset(offset)
          : limit === undefined
            ? baseQuery
            : baseQuery.limit(limit);
      const rows: CanonicalTaskListRow[] = (await pageQuery).map((row) => ({
        ...row,
        request: decodeDatabaseTextPreview(row.request, TASK_LIST_REQUEST_MAX_CHARS),
      }));
      const withLabels = await withTaskLabels(db, rows);
      const runMap = await activeRunMapForTasks(db, withLabels);
      const withRuns = withActiveRuns(withLabels, runMap);
      if (withRuns.length === 0) {
        return withRuns;
      }

      const taskIds = withRuns.map((row) => row.id);
      const [statsRows, readRows, lastActivityRows, archiveRows, blockedByMap, liveDescendantCountByTaskId] =
        await Promise.all([
          contextUserId
            ? userCommentStatsForTasks(db, companyId, contextUserId, taskIds)
            : Promise.resolve([]),
          contextUserId ? userReadStatsForTasks(db, companyId, contextUserId, taskIds) : Promise.resolve([]),
          lastActivityStatsForTasks(db, companyId, taskIds),
          contextUserId
            ? inboxArchiveRowsForTasks(db, companyId, contextUserId, taskIds)
            : Promise.resolve([]),
          includeBlockedBy
            ? blockedByMapForTasks(db, companyId, taskIds)
            : Promise.resolve(new Map<string, d.TaskRelationTaskSummary[]>()),
          includeLiveDescendantSummary
            ? liveDescendantCountMapForTasks(db, companyId, taskIds)
            : Promise.resolve(new Map<string, number>()),
        ]);
      const statsByTaskId = new Map(statsRows.map((row) => [row.taskId, row]));
      const lastActivityByTaskId = new Map(lastActivityRows.map((row) => [row.taskId, row]));
      const archiveByTaskId = new Map(archiveRows.map((row) => [row.taskId, row]));
      const [blockerAttentionByTaskId, blockedInboxAttentionByTaskId] = await Promise.all([
        listTaskBlockerAttentionMap(db, companyId, withRuns),
        includeBlockedInboxAttention
          ? listTaskBlockedInboxAttentionMap(db, companyId, withRuns)
          : Promise.resolve(new Map<string, d.TaskBlockedInboxAttention>()),
      ]);

      if (!contextUserId) {
        return withRuns.map((row) => {
          const activity = lastActivityByTaskId.get(row.id);
          const lastActivityAt =
            latestTaskActivityAt(
              row.updatedAt,
              activity?.latestCommentAt ?? null,
              activity?.latestLogAt ?? null,
            ) ?? row.updatedAt;
          return {
            ...row,
            ...(includeBlockedBy ? { blockedBy: blockedByMap.get(row.id) ?? [] } : {}),
            lastActivityAt,
            ...(blockerAttentionByTaskId.has(row.id)
              ? { blockerAttention: blockerAttentionByTaskId.get(row.id) }
              : {}),
            ...(includeBlockedInboxAttention
              ? {
                  blockedInboxAttention: blockedInboxAttentionByTaskId.get(row.id) ?? null,
                }
              : {}),
            ...(includeLiveDescendantSummary
              ? {
                  liveDescendantCount: liveDescendantCountByTaskId.get(row.id) ?? 0,
                }
              : {}),
          };
        });
      }

      const readByTaskId = new Map(readRows.map((row) => [row.taskId, row.myLastReadAt]));

      return withRuns.map((row) => {
        const activity = lastActivityByTaskId.get(row.id);
        const lastActivityAt =
          latestTaskActivityAt(
            row.updatedAt,
            activity?.latestCommentAt ?? null,
            activity?.latestLogAt ?? null,
          ) ?? row.updatedAt;
        return {
          ...row,
          ...activeInboxArchiveFields(archiveByTaskId.get(row.id), lastActivityAt),
          ...(includeBlockedBy ? { blockedBy: blockedByMap.get(row.id) ?? [] } : {}),
          lastActivityAt,
          ...(blockerAttentionByTaskId.has(row.id)
            ? { blockerAttention: blockerAttentionByTaskId.get(row.id) }
            : {}),
          ...(includeBlockedInboxAttention
            ? {
                blockedInboxAttention: blockedInboxAttentionByTaskId.get(row.id) ?? null,
              }
            : {}),
          ...(includeLiveDescendantSummary
            ? {
                liveDescendantCount: liveDescendantCountByTaskId.get(row.id) ?? 0,
              }
            : {}),
          ...deriveTaskUserContext(row, contextUserId, {
            myLastCommentAt: statsByTaskId.get(row.id)?.myLastCommentAt ?? null,
            myLastReadAt: readByTaskId.get(row.id) ?? null,
            lastExternalCommentAt: statsByTaskId.get(row.id)?.lastExternalCommentAt ?? null,
          }),
        };
      });
    },
    count: async (companyId: string, filters?: TaskFilters) => {
      if (filters?.attention === "blocked") {
        return countBlockedInboxTasks(db, companyId, filters);
      }

      const conditions = [d.eq(d.tasks.companyId, companyId), d.visibleTaskCondition()];
      const statuses = filters?.status ?? [];
      if (statuses.length === 1) conditions.push(d.eq(d.tasks.boardPresentationStatus, statuses[0]!));
      else if (statuses.length > 1) conditions.push(d.inArray(d.tasks.boardPresentationStatus, statuses));
      const ownerAgentFilter = taskOwnerAgentFilter(filters?.ownerAgentId);
      if (ownerAgentFilter === null) {
        conditions.push(d.isNull(d.tasks.ownerAgentId));
      } else if (ownerAgentFilter) {
        conditions.push(d.eq(d.tasks.ownerAgentId, ownerAgentFilter));
      }
      if (filters?.ownerUserId) conditions.push(d.eq(d.tasks.ownerUserId, filters.ownerUserId));
      if (filters?.projectId) conditions.push(d.eq(d.tasks.projectId, filters.projectId));
      if (filters?.parentId) conditions.push(d.eq(d.tasks.parentId, filters.parentId));
      if (filters?.originKind) conditions.push(d.eq(d.tasks.originKind, filters.originKind));
      if (filters?.originId) conditions.push(d.eq(d.tasks.originId, filters.originId));
      if (filters?.hasPlanDocument !== undefined) {
        conditions.push(hasPlanDocumentCondition(companyId, filters.hasPlanDocument));
      }
      if (!shouldIncludePluginOperationTasks(filters)) conditions.push(nonPluginOperationTaskCondition());
      const [row] = await db
        .select({ count: d.sql<number>`count(*)` })
        .from(d.tasks)
        .where(d.and(...conditions));
      return Number(row?.count ?? 0);
    },
    markRead: async (companyId: string, taskId: string, userId: string, readAt: Date = new Date()) => {
      const now = new Date();
      const [row] = await db
        .insert(d.taskReadStates)
        .values({
          companyId,
          taskId,
          userId,
          lastReadAt: readAt,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [d.taskReadStates.companyId, d.taskReadStates.taskId, d.taskReadStates.userId],
          set: {
            lastReadAt: readAt,
            updatedAt: now,
          },
        })
        .returning();
      return row;
    },
    markUnread: async (companyId: string, taskId: string, userId: string) => {
      const deleted = await db
        .delete(d.taskReadStates)
        .where(
          d.and(
            d.eq(d.taskReadStates.companyId, companyId),
            d.eq(d.taskReadStates.taskId, taskId),
            d.eq(d.taskReadStates.userId, userId),
          ),
        )
        .returning();
      return deleted.length > 0;
    },
  };
}
