import * as d from "./tasks-dependencies.js";

import {
  TASK_LIST_RELATED_QUERY_CHUNK_SIZE,
  type TaskFilters,
  type TaskLabelEnrichment,
  type TaskLabelRow,
  type TaskRow,
  type TaskUserContextInput,
} from "./tasks-shared-part-1.js";
import { chunkList, taskCanonicalLastActivityAtExpr } from "./tasks-shared-part-2-section-1.js";

export function nonPluginOperationTaskCondition() {
  return d.sql<boolean>`NOT (
    ${d.tasks.originKind} LIKE 'plugin:%:operation'
    OR ${d.tasks.originKind} LIKE 'plugin:%:operation:%'
  )`;
}

export function shouldIncludePluginOperationTasks(filters: TaskFilters | undefined) {
  return Boolean(filters?.originKind || filters?.originId || filters?.projectId);
}

export function deriveTaskUserContext(
  task: TaskUserContextInput,
  userId: string,
  stats:
    | {
        myLastCommentAt: Date | string | null;
        myLastReadAt: Date | string | null;
        lastExternalCommentAt: Date | string | null;
      }
    | null
    | undefined,
) {
  const normalizeDate = (value: Date | string | null | undefined) => {
    if (!value) return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  };

  const myLastCommentAt = normalizeDate(stats?.myLastCommentAt);
  const myLastReadAt = normalizeDate(stats?.myLastReadAt);
  const createdTouchAt = task.creatorUserId === userId ? normalizeDate(task.createdAt) : null;
  const ownedTouchAt = task.ownerUserId === userId ? normalizeDate(task.updatedAt) : null;
  const myLastTouchAt =
    [myLastCommentAt, myLastReadAt, createdTouchAt, ownedTouchAt]
      .filter((value): value is Date => value instanceof Date)
      .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  const lastExternalCommentAt = normalizeDate(stats?.lastExternalCommentAt);
  const isUnreadForMe = Boolean(
    myLastTouchAt && lastExternalCommentAt && lastExternalCommentAt.getTime() > myLastTouchAt.getTime(),
  );

  return {
    myLastTouchAt,
    lastExternalCommentAt,
    isUnreadForMe,
  };
}

export function latestTaskActivityAt(...values: Array<Date | string | null | undefined>): Date | null {
  const normalized = values
    .map((value) => {
      if (!value) return null;
      if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    })
    .filter((value): value is Date => value instanceof Date)
    .sort((a, b) => b.getTime() - a.getTime());
  return normalized[0] ?? null;
}

export type InboxArchiveAttributionRow = {
  taskId: string;
  archivedAt: Date;
  archivedByActorType: "user" | "agent";
  archivedByAgentId: string | null;
  archivedByRunId: string | null;
};

export async function inboxArchiveRowsForTasks(
  dbOrTx: d.Db,
  companyId: string,
  userId: string,
  taskIds: string[],
): Promise<InboxArchiveAttributionRow[]> {
  if (taskIds.length === 0) return [];
  return dbOrTx
    .select({
      taskId: d.taskInboxArchives.taskId,
      archivedAt: d.taskInboxArchives.archivedAt,
      archivedByActorType: d.taskInboxArchives.archivedByActorType,
      archivedByAgentId: d.taskInboxArchives.archivedByAgentId,
      archivedByRunId: d.taskInboxArchives.archivedByRunId,
    })
    .from(d.taskInboxArchives)
    .where(
      d.and(
        d.eq(d.taskInboxArchives.companyId, companyId),
        d.eq(d.taskInboxArchives.userId, userId),
        d.inArray(d.taskInboxArchives.taskId, taskIds),
      ),
    );
}

export function activeInboxArchiveFields(
  archive: InboxArchiveAttributionRow | undefined,
  lastActivityAt: Date,
) {
  if (!archive || archive.archivedAt.getTime() < lastActivityAt.getTime()) return {};
  return {
    archivedAt: archive.archivedAt,
    archivedByActorType: archive.archivedByActorType,
    archivedByAgentId: archive.archivedByAgentId,
    archivedByRunId: archive.archivedByRunId,
  };
}

export function taskListOrderBy(
  companyId: string,
  {
    hasSearch,
    priorityOrder,
    searchOrder,
    sortField,
    sortDir,
  }: {
    hasSearch: boolean;
    priorityOrder: d.SQL;
    searchOrder: d.SQL;
    sortField?: TaskFilters["sortField"];
    sortDir?: TaskFilters["sortDir"];
  },
) {
  const canonicalLastActivityAt = taskCanonicalLastActivityAtExpr(companyId);
  if (sortField === "updated") {
    const activityOrder =
      sortDir === "asc" ? d.asc(canonicalLastActivityAt) : d.desc(canonicalLastActivityAt);
    const updatedOrder = sortDir === "asc" ? d.asc(d.tasks.updatedAt) : d.desc(d.tasks.updatedAt);
    const idOrder = sortDir === "asc" ? d.asc(d.tasks.id) : d.desc(d.tasks.id);
    return hasSearch
      ? [d.asc(searchOrder), activityOrder, updatedOrder, idOrder]
      : [activityOrder, updatedOrder, idOrder];
  }

  return [
    hasSearch ? d.asc(searchOrder) : d.asc(priorityOrder),
    d.asc(priorityOrder),
    d.desc(canonicalLastActivityAt),
    d.desc(d.tasks.updatedAt),
    d.desc(d.tasks.id),
  ];
}

export async function labelMapForTasks(dbOrTx: any, taskIds: string[]): Promise<Map<string, TaskLabelRow[]>> {
  const map = new Map<string, TaskLabelRow[]>();
  if (taskIds.length === 0) return map;
  for (const taskIdChunk of chunkList(taskIds, TASK_LIST_RELATED_QUERY_CHUNK_SIZE)) {
    const rows = await dbOrTx
      .select({
        taskId: d.taskLabels.taskId,
        label: d.labels,
      })
      .from(d.taskLabels)
      .innerJoin(d.labels, d.eq(d.taskLabels.labelId, d.labels.id))
      .where(d.inArray(d.taskLabels.taskId, taskIdChunk))
      .orderBy(d.asc(d.labels.name), d.asc(d.labels.id));

    for (const row of rows) {
      const existing = map.get(row.taskId);
      if (existing) existing.push(row.label);
      else map.set(row.taskId, [row.label]);
    }
  }
  return map;
}

export async function withTaskLabels<
  T extends Pick<TaskRow, "id" | "companyId" | "ownershipEpoch" | "boardPresentationStatus">,
>(dbOrTx: any, rows: T[]): Promise<Array<T & TaskLabelEnrichment>> {
  if (rows.length === 0) return [];
  const taskIds = rows.map((row) => row.id);
  const [labelsByTaskId, workspaceBindings] = await Promise.all([
    labelMapForTasks(dbOrTx, taskIds),
    dbOrTx
      .select({
        companyId: d.taskExecutionWorkspaceBindings.companyId,
        taskId: d.taskExecutionWorkspaceBindings.taskId,
        ownershipEpoch: d.taskExecutionWorkspaceBindings.ownershipEpoch,
        executionWorkspaceId: d.taskExecutionWorkspaceBindings.executionWorkspaceId,
      })
      .from(d.taskExecutionWorkspaceBindings)
      .where(d.inArray(d.taskExecutionWorkspaceBindings.taskId, taskIds)),
  ]);
  const taskScopeById = new Map(
    rows.map((row) => [row.id, { companyId: row.companyId, ownershipEpoch: row.ownershipEpoch }]),
  );
  const currentBindingByTaskId = new Map<string, string>();
  for (const binding of workspaceBindings as Array<{
    companyId: string;
    taskId: string;
    ownershipEpoch: number;
    executionWorkspaceId: string;
  }>) {
    const scope = taskScopeById.get(binding.taskId);
    if (scope?.companyId === binding.companyId && scope.ownershipEpoch === binding.ownershipEpoch) {
      currentBindingByTaskId.set(binding.taskId, binding.executionWorkspaceId);
    }
  }
  return rows.map((row) => {
    const taskLabels = labelsByTaskId.get(row.id) ?? [];
    return {
      ...row,
      executionWorkspaceId: currentBindingByTaskId.get(row.id) ?? null,
      labels: taskLabels,
      labelIds: taskLabels.map((label) => label.id),
    };
  });
}

export const BLOCKER_ATTENTION_PENDING_APPROVAL_STATUSES = ["pending", "revision_requested"];

export const BLOCKER_ATTENTION_CHILD_TERMINAL_STATUSES = [
  "done",
  "cancelled",
] as const satisfies readonly d.TaskStatus[];

export function lowTrustBoundaryTaskCondition(
  companyId: string,
  boundary: (d.LowTrustBoundary & { companyId: string }) | null | undefined,
) {
  if (!boundary || boundary.companyId !== companyId) return null;
  const clauses: d.SQL[] = [];
  const taskIds = [...new Set(boundary.taskIds ?? [])];
  const projectIds = [...new Set(boundary.projectIds ?? [])];
  if (taskIds.length > 0) clauses.push(d.inArray(d.tasks.id, taskIds));
  if (projectIds.length > 0) clauses.push(d.inArray(d.tasks.projectId, projectIds));
  if (boundary.rootTaskId) {
    clauses.push(d.sql<boolean>`
      ${d.tasks.id} IN (
        WITH RECURSIVE descendants(id) AS (
          SELECT ${d.tasks.id}
          FROM ${d.tasks}
          WHERE ${d.tasks.companyId} = ${companyId}
            AND ${d.tasks.id} = ${boundary.rootTaskId}
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
  if (clauses.length === 0) return d.sql<boolean>`false`;
  return d.or(...clauses);
}

export const BLOCKER_ATTENTION_MAX_DEPTH = 8;

export const BLOCKER_ATTENTION_MAX_NODES = 2000;

export const BLOCKER_ATTENTION_INVOKABLE_AGENT_STATUSES = new Set(["idle", "error"]);

export type TaskBlockerAttentionNode = {
  id: string;
  companyId: string;
  parentId: string | null;
  identifier: string;
  title: string | null;
  boardPresentationStatus: string;
  ownerAgentId: string | null;
  ownerUserId: string | null;
};

export type TaskBlockerAttentionInputNode = Pick<
  TaskRow,
  | "id"
  | "companyId"
  | "parentId"
  | "identifier"
  | "title"
  | "boardPresentationStatus"
  | "ownerAgentId"
  | "ownerUserId"
>;

export type TaskBlockerAttentionEdge = {
  taskId: string;
  blockerTaskId: string;
};

export type TaskBlockerAttentionQueryRow = TaskBlockerAttentionNode & {
  taskId: string | null;
  blockerTaskId: string;
};

export type TaskBlockerAttentionAgentRow = {
  id: string;
  companyId: string;
  status: string;
};
