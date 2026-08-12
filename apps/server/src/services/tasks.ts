import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  ne,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agents,
  approvals,
  assets,
  taskApprovals,
  taskAttachments,
  taskExecutionWorkspaceBindings,
  taskInboxArchives,
  taskLabels,
  taskRelations,
  taskComments,
  taskCommentProjectionSources,
  taskSessionMessages,
  taskDocuments,
  taskReadStates,
  tasks,
  labels,
  goals,
  projects,
  authUsers,
} from "@paperclipai/db";
import type {
  BoardTaskComment,
  BoardTaskCommentAuthor,
  BoardTaskCommentGroupPage,
  BoardTaskCommentParentReference,
  BoardTaskCommentRunState,
  BoardTaskCommentThreadPage,
  BoardTaskRunSegmentEntry,
  BoardTaskRunSegmentPart,
  BoardTaskThreadEntry,
  TaskCommentAuthorType,
  TaskCommentMetadata,
  TaskCommentPresentation,
  TaskBlockerAttention,
  TaskBlockedInboxAttention,
  TaskBlockedInboxTaskRef,
  TaskExecutionRunStatus,
  TaskRelationTaskSummary,
  TaskStatus,
  LowTrustBoundary,
} from "@paperclipai/shared";
import {
  clampTaskRequestDepth,
  extractAgentMentionIds,
  extractProjectMentionIds,
  taskCommentMetadataSchema,
  taskCommentPresentationSchema,
  isCanonicalUuid,
  isCanonicalTaskNumber,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { instanceSettingsService } from "./instance-settings.js";
import { redactCurrentUserText } from "../log-redaction.js";
import { resolveNextTaskGoalId } from "./task-goal-fallback.js";
import { syncTask } from "./task-references.js";
import { getDefaultCompanyGoal } from "./goals.js";
import {
  InvokableTaskOwnerRejected,
  resolveInvokableTaskOwnerFromDb,
} from "./agent-invokability.js";
import { visibleTaskCondition } from "./task-visibility.js";
import { resolveCurrentTaskOwnerRunLinkages } from "./productive-run-linkage.js";
import {
  listLiveOwnerTaskIds,
  readTaskExecutionRun,
  resolveTaskExecutionRunIdentityById,
} from "./task-execution-run-service.js";

const ALL_TASK_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "cancelled",
] as const satisfies readonly TaskStatus[];
const MAX_TASK_COMMENT_PAGE_LIMIT = 500;
const DEFAULT_BOARD_COMMENT_ROOT_LIMIT = 100;
const DEFAULT_BOARD_COMMENT_ENTRY_LIMIT = 100;

type BoardCommentCursor = {
  version: 1;
  kind: "roots" | "thread";
  taskId: string;
  rootCommentId: string | null;
  sequence: number;
  id: string;
};

function encodeBoardCommentCursor(cursor: BoardCommentCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeBoardCommentCursor(
  encoded: string | null | undefined,
  expected: Pick<BoardCommentCursor, "kind" | "taskId" | "rootCommentId">,
): BoardCommentCursor | null {
  if (!encoded) return null;
  let value: unknown;
  try {
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.toString("base64url") !== encoded) {
      throw new Error("Non-canonical base64url");
    }
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw unprocessable("Invalid task comment cursor");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw unprocessable("Invalid task comment cursor");
  }
  const candidate = value as Partial<BoardCommentCursor>;
  if (
    Object.keys(candidate).sort().join(",") !==
      "id,kind,rootCommentId,sequence,taskId,version" ||
    candidate.version !== 1 ||
    candidate.kind !== expected.kind ||
    candidate.taskId !== expected.taskId ||
    candidate.rootCommentId !== expected.rootCommentId ||
    !Number.isSafeInteger(candidate.sequence) ||
    Number(candidate.sequence) < 0 ||
    typeof candidate.id !== "string" ||
    !isCanonicalUuid(candidate.id)
  ) {
    throw unprocessable("Task comment cursor does not belong to this view");
  }
  return candidate as BoardCommentCursor;
}

function boundedBoardCommentPageSize(
  requested: number | null | undefined,
  fallback: number,
): number {
  if (requested == null) return fallback;
  if (
    !Number.isSafeInteger(requested) ||
    requested < 1 ||
    requested > MAX_TASK_COMMENT_PAGE_LIMIT
  ) {
    throw unprocessable(
      `Task comment page limit must be between 1 and ${MAX_TASK_COMMENT_PAGE_LIMIT}`,
    );
  }
  return requested;
}

function boardRunState(
  status: TaskExecutionRunStatus | null | undefined,
): BoardTaskCommentRunState | null {
  if (status === "queued" || status === "scheduled_retry") return "queued";
  if (status === "running") return "working";
  return status ? "terminal" : null;
}

function compareCanonicalEntry(
  left: { canonicalSequence: number; id: string },
  right: { canonicalSequence: number; id: string },
): number {
  return (
    left.canonicalSequence - right.canonicalSequence ||
    left.id.localeCompare(right.id)
  );
}

function isAfterBoardCommentCursor(
  entry: { canonicalSequence: number; id: string },
  cursor: BoardCommentCursor | null,
): boolean {
  if (!cursor) return true;
  return (
    entry.canonicalSequence > cursor.sequence ||
    (entry.canonicalSequence === cursor.sequence && entry.id > cursor.id)
  );
}
export const TASK_LIST_DEFAULT_LIMIT = 500;
export const TASK_LIST_MAX_LIMIT = 1000;
export const TASK_BLOCKER_DIAGNOSTICS_MAX_BLOCKERS = 100;
export const TASK_SUBTREE_DIAGNOSTICS_MAX_DEPTH = 8;
export const TASK_SUBTREE_DIAGNOSTICS_MAX_NODES = 100;
export const TASK_SUBTREE_DIAGNOSTICS_MAX_BLOCKERS_PER_NODE = 20;
const TASK_LIST_RELATED_QUERY_CHUNK_SIZE = 500;
function assertTransition(from: string, to: string) {
  if (from === to) return;
  if (!(ALL_TASK_STATUSES as readonly string[]).includes(to)) {
    throw conflict(`Unknown task status: ${to}`);
  }
}

function applyStatusSideEffects(
  status: string | undefined,
  patch: Partial<typeof tasks.$inferInsert>,
): Partial<typeof tasks.$inferInsert> {
  if (!status) return patch;

  if (status === "in_progress" && !patch.startedAt) {
    patch.startedAt = new Date();
  }
  if (status === "done") {
    patch.completedAt = new Date();
  }
  if (status === "cancelled") {
    patch.cancelledAt = new Date();
  }
  return patch;
}

export function parseStatusFilter(input: unknown): TaskStatus[] {
  if (input === undefined) return [];
  const entries = Array.isArray(input) ? [...input] : [input];
  if (
    entries.length === 0 ||
    entries.some(
      (status) =>
        typeof status !== "string" ||
        !(ALL_TASK_STATUSES as readonly string[]).includes(status),
    ) ||
    new Set(entries).size !== entries.length
  ) {
    throw unprocessable(
      "status must contain unique canonical task status values",
    );
  }
  return entries as TaskStatus[];
}

export interface TaskFilters {
  attention?: "blocked";
  status?: readonly TaskStatus[];
  ownerAgentId?: string | null;
  participantAgentId?: string;
  ownerUserId?: string;
  touchedByUserId?: string;
  inboxArchivedByUserId?: string;
  unreadForUserId?: string;
  projectId?: string;
  parentId?: string;
  descendantOf?: string;
  labelId?: string;
  originKind?: string;
  originId?: string;
  excludeRoutineExecutions?: boolean;
  includeBlockedBy?: boolean;
  includeBlockedInboxAttention?: boolean;
  includeLiveDescendantSummary?: boolean;
  hasPlanDocument?: boolean;
  lowTrustBoundary?: LowTrustBoundary & { companyId: string };
  q?: string;
  limit?: number;
  offset?: number;
  sortField?: "updated";
  sortDir?: "asc" | "desc";
}

type TaskRow = typeof tasks.$inferSelect;
type TaskControlStateUpdate = Partial<
  Omit<
    typeof tasks.$inferInsert,
    | "id"
    | "companyId"
    | "parentId"
    | "parentOwnershipEpoch"
    | "request"
    | "title"
    | "ownerKind"
    | "ownerAgentId"
    | "ownerUserId"
    | "ownerAssignmentSource"
    | "ownershipEpoch"
    | "creatorKind"
    | "creatorAuthorityId"
    | "creatorAdapterConfigRevisionId"
    | "creatorUserId"
    | "creatorPluginInstallationId"
    | "creatorPluginKey"
    | "creatorCallbackKey"
    | "creatorCallbackVersion"
    | "creatorRoutineId"
    | "creatorRoutineDispatchId"
    | "creatorSystemSourceKind"
    | "creatorSystemSourceId"
    | "lifecycleStatus"
    | "disposition"
    | "completedAt"
    | "cancelledAt"
    | "createdAt"
  >
> & {
  labelIds?: string[];
  blockedByTaskIds?: string[];
  actorAgentId?: string | null;
  actorUserId?: string | null;
};
type TaskLabelRow = typeof labels.$inferSelect;
type TaskActiveRunRow = {
  id: string;
  status: string;
  agentId: string;
  sourceKind: string;
  sourceRecordId: string;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
};
type TaskLabelEnrichment = {
  labels: TaskLabelRow[];
  labelIds: string[];
};
type CanonicalTaskListRow = TaskRow;
type CanonicalTaskWithLabels = CanonicalTaskListRow & TaskLabelEnrichment;
type CanonicalTaskWithLabelsAndRun = CanonicalTaskWithLabels & {
  activeRun: TaskActiveRunRow | null;
};
type TaskUserCommentStats = {
  taskId: string;
  myLastCommentAt: Date | null;
  lastExternalCommentAt: Date | null;
};
type TaskReadStat = {
  taskId: string;
  myLastReadAt: Date | null;
};
type TaskLastActivityStat = {
  taskId: string;
  latestCommentAt: Date | null;
  latestLogAt: Date | null;
};

type TaskUserContextInput = {
  creatorUserId: string | null;
  ownerUserId: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};
type DbReader = Pick<Db, "select">;
type TaskRelationSummaryMap = {
  blockedBy: TaskRelationTaskSummary[];
  blocks: TaskRelationTaskSummary[];
};
type TaskBlockerDiagnosticsTaskRow = {
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
type TaskSubtreeDiagnosticsTaskRow = TaskBlockerDiagnosticsTaskRow & {
  depth: number;
  createdAt: Date;
  updatedAt: Date;
};
type TaskSubtreeDiagnosticsBlockerRow = TaskBlockerDiagnosticsTaskRow & {
  blockedTaskId: string;
  relationCreatedAt: Date;
};
type TaskSubtreeDiagnosticsBlockerResultRow =
  TaskSubtreeDiagnosticsBlockerRow & {
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
const TASK_LIST_REQUEST_MAX_CHARS = 1200;
const TASK_LIST_REQUEST_MAX_BYTES = TASK_LIST_REQUEST_MAX_CHARS * 4;

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function chunkList<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function truncateByCodePoint(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return Array.from(value).slice(0, maxChars).join("");
}

function decodeDatabaseTextPreview(value: string, maxChars: number): string {
  return truncateByCodePoint(
    Buffer.from(value, "base64").toString("utf8"),
    maxChars,
  );
}

function createTaskDependencyReadiness(
  taskId: string,
): TaskDependencyReadiness {
  return {
    taskId,
    blockerTaskIds: [],
    unresolvedBlockerTaskIds: [],
    unresolvedBlockerCount: 0,
    allBlockersDone: true,
    isDependencyReady: true,
  };
}

async function listTaskDependencyReadinessMap(
  dbOrTx: Pick<Db, "select">,
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
      taskId: taskRelations.relatedTaskId,
      blockerTaskId: taskRelations.taskId,
      blockerStatus: tasks.boardPresentationStatus,
    })
    .from(taskRelations)
    .innerJoin(tasks, eq(taskRelations.taskId, tasks.id))
    .where(
      and(
        eq(taskRelations.companyId, companyId),
        eq(taskRelations.type, "blocks"),
        inArray(taskRelations.relatedTaskId, uniqueTaskIds),
      ),
    );

  for (const row of blockerRows) {
    const current =
      readinessMap.get(row.taskId) ?? createTaskDependencyReadiness(row.taskId);
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

async function listUnresolvedBlockerTaskIds(
  dbOrTx: Pick<Db, "select">,
  companyId: string,
  blockerTaskIds: string[],
) {
  const uniqueBlockerTaskIds = [...new Set(blockerTaskIds.filter(Boolean))];
  if (uniqueBlockerTaskIds.length === 0) return [];
  return dbOrTx
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.companyId, companyId),
        inArray(tasks.id, uniqueBlockerTaskIds),
        // Cancelled blockers intentionally remain unresolved until the relation changes.
        ne(tasks.boardPresentationStatus, "done"),
      ),
    )
    .then((rows) => rows.map((row) => row.id));
}

function touchedByUserCondition(companyId: string, userId: string) {
  return sql<boolean>`
    (
      ${tasks.creatorUserId} = ${userId}
      OR ${tasks.ownerUserId} = ${userId}
      OR EXISTS (
        SELECT 1
        FROM ${taskReadStates}
        WHERE ${taskReadStates.taskId} = ${tasks.id}
          AND ${taskReadStates.companyId} = ${companyId}
          AND ${taskReadStates.userId} = ${userId}
      )
      OR EXISTS (
        SELECT 1
        FROM ${taskComments}
        WHERE ${taskComments.taskId} = ${tasks.id}
          AND ${taskComments.companyId} = ${companyId}
          AND ${taskComments.authorUserId} = ${userId}
      )
    )
  `;
}

function participatedByAgentCondition(companyId: string, agentId: string) {
  return sql<boolean>`
    (
      (
        ${tasks.creatorKind} = 'agent-execution'
        AND ${tasks.creatorAuthorityId} = ${agentId}
      )
      OR ${tasks.ownerAgentId} = ${agentId}
      OR EXISTS (
        SELECT 1
        FROM ${taskComments}
        WHERE ${taskComments.taskId} = ${tasks.id}
          AND ${taskComments.companyId} = ${companyId}
          AND ${taskComments.authorAgentId} = ${agentId}
      )
      OR EXISTS (
        SELECT 1
        FROM ${activityLog}
        WHERE ${activityLog.companyId} = ${companyId}
          AND ${activityLog.entityType} = 'task'
          AND ${activityLog.entityId} = ${tasks.id}::text
          AND ${activityLog.agentId} = ${agentId}
      )
    )
  `;
}

function myLastCommentAtExpr(companyId: string, userId: string) {
  return sql<Date | null>`
    (
      SELECT MAX(${taskComments.createdAt})
      FROM ${taskComments}
      WHERE ${taskComments.taskId} = ${tasks.id}
        AND ${taskComments.companyId} = ${companyId}
        AND ${taskComments.authorUserId} = ${userId}
    )
  `;
}

function myLastReadAtExpr(companyId: string, userId: string) {
  return sql<Date | null>`
    (
      SELECT MAX(${taskReadStates.lastReadAt})
      FROM ${taskReadStates}
      WHERE ${taskReadStates.taskId} = ${tasks.id}
        AND ${taskReadStates.companyId} = ${companyId}
        AND ${taskReadStates.userId} = ${userId}
    )
  `;
}

function myLastTouchAtExpr(companyId: string, userId: string) {
  const myLastCommentAt = myLastCommentAtExpr(companyId, userId);
  const myLastReadAt = myLastReadAtExpr(companyId, userId);
  return sql<Date | null>`
    GREATEST(
      COALESCE(${myLastCommentAt}, to_timestamp(0)),
      COALESCE(${myLastReadAt}, to_timestamp(0)),
      COALESCE(CASE WHEN ${tasks.creatorUserId} = ${userId} THEN ${tasks.createdAt} ELSE NULL END, to_timestamp(0)),
      COALESCE(CASE WHEN ${tasks.ownerUserId} = ${userId} THEN ${tasks.createdAt} ELSE NULL END, to_timestamp(0))
    )
  `;
}

const TASK_LOCAL_INBOX_ACTIVITY_ACTIONS = [
  "task.read_marked",
  "task.read_unmarked",
  "task.inbox_archived",
  "task.inbox_unarchived",
] as const;

function taskLatestCommentAtExpr(companyId: string) {
  return sql<Date | null>`
    (
      SELECT MAX(${taskComments.createdAt})
      FROM ${taskComments}
      WHERE ${taskComments.taskId} = ${tasks.id}
        AND ${taskComments.companyId} = ${companyId}
    )
  `;
}

function taskLatestLogAtExpr(companyId: string) {
  return sql<Date | null>`
    (
      SELECT MAX(${activityLog.createdAt})
      FROM ${activityLog}
      WHERE ${activityLog.companyId} = ${companyId}
        AND ${activityLog.entityType} = 'task'
        AND ${activityLog.entityId} = ${tasks.id}::text
        AND ${activityLog.action} NOT IN (${sql.join(
          TASK_LOCAL_INBOX_ACTIVITY_ACTIONS.map((action) => sql`${action}`),
          sql`, `,
        )})
    )
  `;
}

function taskCanonicalLastActivityAtExpr(companyId: string) {
  const latestCommentAt = taskLatestCommentAtExpr(companyId);
  const latestLogAt = taskLatestLogAtExpr(companyId);
  return sql<Date>`
    GREATEST(
      ${tasks.updatedAt},
      COALESCE(${latestCommentAt}, to_timestamp(0)),
      COALESCE(${latestLogAt}, to_timestamp(0))
    )
  `;
}

function unreadForUserCondition(companyId: string, userId: string) {
  const touchedCondition = touchedByUserCondition(companyId, userId);
  const myLastTouchAt = myLastTouchAtExpr(companyId, userId);
  return sql<boolean>`
    (
      ${touchedCondition}
      AND EXISTS (
        SELECT 1
        FROM ${taskComments}
        WHERE ${taskComments.taskId} = ${tasks.id}
          AND ${taskComments.companyId} = ${companyId}
          AND (
            ${taskComments.authorUserId} IS NULL
            OR ${taskComments.authorUserId} <> ${userId}
          )
          AND ${taskComments.createdAt} > ${myLastTouchAt}
      )
    )
  `;
}

function inboxVisibleForUserCondition(companyId: string, userId: string) {
  return sql<boolean>`
    NOT EXISTS (
      SELECT 1
      FROM ${taskInboxArchives}
      WHERE ${taskInboxArchives.taskId} = ${tasks.id}
        AND ${taskInboxArchives.companyId} = ${companyId}
        AND ${taskInboxArchives.userId} = ${userId}
        AND NOT (
          EXISTS (
            SELECT 1
            FROM ${activityLog}
            WHERE ${activityLog.companyId} = ${companyId}
              AND ${activityLog.entityType} = 'task'
              AND ${activityLog.entityId} = ${tasks.id}::text
              AND ${activityLog.action} = 'task.updated'
              AND ${activityLog.createdAt} > ${taskInboxArchives.archivedAt}
              AND ${activityLog.details}->>'status' IN ('in_review', 'blocked', 'done')
              AND ${activityLog.details}->'_previous'->>'status'
                IS DISTINCT FROM ${activityLog.details}->>'status'
          )
          OR EXISTS (
            SELECT 1
            FROM ${taskComments}
            WHERE ${taskComments.taskId} = ${tasks.id}
              AND ${taskComments.companyId} = ${companyId}
              AND ${taskComments.createdAt} > ${taskInboxArchives.archivedAt}
              AND (
                (
                  ${taskComments.authorType} = 'user'
                  AND
                  ${taskComments.authorUserId} IS NOT NULL
                  AND ${taskComments.authorUserId} <> ${userId}
                )
                OR POSITION(${`](user://${userId})`} IN ${taskComments.body}) > 0
              )
          )
        )
    )
  `;
}

function nonPluginOperationTaskCondition() {
  return sql<boolean>`NOT (
    ${tasks.originKind} LIKE 'plugin:%:operation'
    OR ${tasks.originKind} LIKE 'plugin:%:operation:%'
  )`;
}

function shouldIncludePluginOperationTasks(filters: TaskFilters | undefined) {
  return Boolean(
    filters?.originKind ||
    filters?.originId ||
    filters?.projectId,
  );
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
    if (value instanceof Date)
      return Number.isNaN(value.getTime()) ? null : value;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  };

  const myLastCommentAt = normalizeDate(stats?.myLastCommentAt);
  const myLastReadAt = normalizeDate(stats?.myLastReadAt);
  const createdTouchAt =
    task.creatorUserId === userId ? normalizeDate(task.createdAt) : null;
  const ownedTouchAt =
    task.ownerUserId === userId ? normalizeDate(task.updatedAt) : null;
  const myLastTouchAt =
    [myLastCommentAt, myLastReadAt, createdTouchAt, ownedTouchAt]
      .filter((value): value is Date => value instanceof Date)
      .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  const lastExternalCommentAt = normalizeDate(stats?.lastExternalCommentAt);
  const isUnreadForMe = Boolean(
    myLastTouchAt &&
    lastExternalCommentAt &&
    lastExternalCommentAt.getTime() > myLastTouchAt.getTime(),
  );

  return {
    myLastTouchAt,
    lastExternalCommentAt,
    isUnreadForMe,
  };
}

function latestTaskActivityAt(
  ...values: Array<Date | string | null | undefined>
): Date | null {
  const normalized = values
    .map((value) => {
      if (!value) return null;
      if (value instanceof Date)
        return Number.isNaN(value.getTime()) ? null : value;
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    })
    .filter((value): value is Date => value instanceof Date)
    .sort((a, b) => b.getTime() - a.getTime());
  return normalized[0] ?? null;
}

type InboxArchiveAttributionRow = {
  taskId: string;
  archivedAt: Date;
  archivedByActorType: "user" | "agent";
  archivedByAgentId: string | null;
  archivedByRunId: string | null;
};

async function inboxArchiveRowsForTasks(
  dbOrTx: Db,
  companyId: string,
  userId: string,
  taskIds: string[],
): Promise<InboxArchiveAttributionRow[]> {
  if (taskIds.length === 0) return [];
  return dbOrTx
    .select({
      taskId: taskInboxArchives.taskId,
      archivedAt: taskInboxArchives.archivedAt,
      archivedByActorType: taskInboxArchives.archivedByActorType,
      archivedByAgentId: taskInboxArchives.archivedByAgentId,
      archivedByRunId: taskInboxArchives.archivedByRunId,
    })
    .from(taskInboxArchives)
    .where(
      and(
        eq(taskInboxArchives.companyId, companyId),
        eq(taskInboxArchives.userId, userId),
        inArray(taskInboxArchives.taskId, taskIds),
      ),
    );
}

function activeInboxArchiveFields(
  archive: InboxArchiveAttributionRow | undefined,
  lastActivityAt: Date,
) {
  if (!archive || archive.archivedAt.getTime() < lastActivityAt.getTime())
    return {};
  return {
    archivedAt: archive.archivedAt,
    archivedByActorType: archive.archivedByActorType,
    archivedByAgentId: archive.archivedByAgentId,
    archivedByRunId: archive.archivedByRunId,
  };
}

function taskListOrderBy(
  companyId: string,
  {
    hasSearch,
    priorityOrder,
    searchOrder,
    sortField,
    sortDir,
  }: {
    hasSearch: boolean;
    priorityOrder: SQL;
    searchOrder: SQL;
    sortField?: TaskFilters["sortField"];
    sortDir?: TaskFilters["sortDir"];
  },
) {
  const canonicalLastActivityAt = taskCanonicalLastActivityAtExpr(companyId);
  if (sortField === "updated") {
    const activityOrder =
      sortDir === "asc"
        ? asc(canonicalLastActivityAt)
        : desc(canonicalLastActivityAt);
    const updatedOrder =
      sortDir === "asc" ? asc(tasks.updatedAt) : desc(tasks.updatedAt);
    const idOrder = sortDir === "asc" ? asc(tasks.id) : desc(tasks.id);
    return hasSearch
      ? [asc(searchOrder), activityOrder, updatedOrder, idOrder]
      : [activityOrder, updatedOrder, idOrder];
  }

  return [
    hasSearch ? asc(searchOrder) : asc(priorityOrder),
    asc(priorityOrder),
    desc(canonicalLastActivityAt),
    desc(tasks.updatedAt),
    desc(tasks.id),
  ];
}

async function labelMapForTasks(
  dbOrTx: any,
  taskIds: string[],
): Promise<Map<string, TaskLabelRow[]>> {
  const map = new Map<string, TaskLabelRow[]>();
  if (taskIds.length === 0) return map;
  for (const taskIdChunk of chunkList(
    taskIds,
    TASK_LIST_RELATED_QUERY_CHUNK_SIZE,
  )) {
    const rows = await dbOrTx
      .select({
        taskId: taskLabels.taskId,
        label: labels,
      })
      .from(taskLabels)
      .innerJoin(labels, eq(taskLabels.labelId, labels.id))
      .where(inArray(taskLabels.taskId, taskIdChunk))
      .orderBy(asc(labels.name), asc(labels.id));

    for (const row of rows) {
      const existing = map.get(row.taskId);
      if (existing) existing.push(row.label);
      else map.set(row.taskId, [row.label]);
    }
  }
  return map;
}

async function withTaskLabels<
  T extends Pick<
    TaskRow,
    "id" | "companyId" | "ownershipEpoch" | "boardPresentationStatus"
  >,
>(dbOrTx: any, rows: T[]): Promise<Array<T & TaskLabelEnrichment>> {
  if (rows.length === 0) return [];
  const taskIds = rows.map((row) => row.id);
  const [labelsByTaskId, workspaceBindings] = await Promise.all([
    labelMapForTasks(dbOrTx, taskIds),
    dbOrTx
      .select({
        companyId: taskExecutionWorkspaceBindings.companyId,
        taskId: taskExecutionWorkspaceBindings.taskId,
        ownershipEpoch: taskExecutionWorkspaceBindings.ownershipEpoch,
        executionWorkspaceId:
          taskExecutionWorkspaceBindings.executionWorkspaceId,
      })
      .from(taskExecutionWorkspaceBindings)
      .where(inArray(taskExecutionWorkspaceBindings.taskId, taskIds)),
  ]);
  const taskScopeById = new Map(
    rows.map((row) => [
      row.id,
      { companyId: row.companyId, ownershipEpoch: row.ownershipEpoch },
    ]),
  );
  const currentBindingByTaskId = new Map<string, string>();
  for (const binding of workspaceBindings as Array<{
    companyId: string;
    taskId: string;
    ownershipEpoch: number;
    executionWorkspaceId: string;
  }>) {
    const scope = taskScopeById.get(binding.taskId);
    if (
      scope?.companyId === binding.companyId &&
      scope.ownershipEpoch === binding.ownershipEpoch
    ) {
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

const BLOCKER_ATTENTION_PENDING_APPROVAL_STATUSES = [
  "pending",
  "revision_requested",
];
const BLOCKER_ATTENTION_CHILD_TERMINAL_STATUSES = [
  "done",
  "cancelled",
] as const satisfies readonly TaskStatus[];

function lowTrustBoundaryTaskCondition(
  companyId: string,
  boundary: (LowTrustBoundary & { companyId: string }) | null | undefined,
) {
  if (!boundary || boundary.companyId !== companyId) return null;
  const clauses: SQL[] = [];
  const taskIds = [...new Set(boundary.taskIds ?? [])];
  const projectIds = [...new Set(boundary.projectIds ?? [])];
  if (taskIds.length > 0) clauses.push(inArray(tasks.id, taskIds));
  if (projectIds.length > 0) clauses.push(inArray(tasks.projectId, projectIds));
  if (boundary.rootTaskId) {
    clauses.push(sql<boolean>`
      ${tasks.id} IN (
        WITH RECURSIVE descendants(id) AS (
          SELECT ${tasks.id}
          FROM ${tasks}
          WHERE ${tasks.companyId} = ${companyId}
            AND ${tasks.id} = ${boundary.rootTaskId}
          UNION
          SELECT ${tasks.id}
          FROM ${tasks}
          JOIN descendants ON ${tasks.parentId} = descendants.id
          WHERE ${tasks.companyId} = ${companyId}
        )
        SELECT id FROM descendants
      )
    `);
  }
  if (clauses.length === 0) return sql<boolean>`false`;
  return or(...clauses);
}

const BLOCKER_ATTENTION_MAX_DEPTH = 8;
const BLOCKER_ATTENTION_MAX_NODES = 2000;
const BLOCKER_ATTENTION_INVOKABLE_AGENT_STATUSES = new Set(["idle", "error"]);

type TaskBlockerAttentionNode = {
  id: string;
  companyId: string;
  parentId: string | null;
  identifier: string;
  title: string | null;
  boardPresentationStatus: string;
  ownerAgentId: string | null;
  ownerUserId: string | null;
};
type TaskBlockerAttentionInputNode = Pick<
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

type TaskBlockerAttentionEdge = {
  taskId: string;
  blockerTaskId: string;
};
type TaskBlockerAttentionQueryRow = TaskBlockerAttentionNode & {
  taskId: string | null;
  blockerTaskId: string;
};
type TaskBlockerAttentionAgentRow = {
  id: string;
  companyId: string;
  status: string;
};

async function activeRunMapForTasks<
  T extends Pick<TaskRow, "id" | "companyId">,
>(dbOrTx: any, taskRows: T[]): Promise<Map<string, TaskActiveRunRow>> {
  const map = new Map<string, TaskActiveRunRow>();
  const taskIdsByCompany = new Map<string, string[]>();
  for (const row of taskRows) {
    const ids = taskIdsByCompany.get(row.companyId) ?? [];
    ids.push(row.id);
    taskIdsByCompany.set(row.companyId, ids);
  }

  for (const [companyId, taskIds] of taskIdsByCompany) {
    for (const taskIdChunk of chunkList(
      [...new Set(taskIds)],
      TASK_LIST_RELATED_QUERY_CHUNK_SIZE,
    )) {
      const linkages = await resolveCurrentTaskOwnerRunLinkages(dbOrTx as Db, {
        companyId,
        taskIds: taskIdChunk,
      });
      for (const [taskId, linkage] of linkages) {
        map.set(taskId, {
          id: linkage.runId,
          status: linkage.runStatus,
          agentId: linkage.agentId,
          sourceKind: linkage.sourceKind,
          sourceRecordId: linkage.sourceRecordId,
          startedAt: linkage.startedAt,
          finishedAt: linkage.finishedAt,
          createdAt: linkage.createdAt,
        });
      }
    }
  }
  return map;
}

async function liveDescendantCountMapForTasks(
  dbOrTx: any,
  companyId: string,
  taskIds: string[],
): Promise<Map<string, number>> {
  const uniqueTaskIds = [...new Set(taskIds)];
  const map = new Map<string, number>();
  if (uniqueTaskIds.length === 0) return map;
  const liveRunTaskIds = await listLiveOwnerTaskIds(dbOrTx as Db, {
    companyId,
  });
  if (liveRunTaskIds.length === 0) return map;
  const liveRunTaskRows = liveRunTaskIds.map(
    (taskId) => sql`(${taskId}::uuid)`,
  );

  for (const taskIdChunk of chunkList(
    uniqueTaskIds,
    TASK_LIST_RELATED_QUERY_CHUNK_SIZE,
  )) {
    const targetRows = taskIdChunk.map((taskId) => sql`(${taskId}::uuid)`);
    const rows = await dbOrTx.execute(sql<{
      taskId: string;
      liveDescendantCount: number;
    }>`
      WITH RECURSIVE
        target_tasks(task_id) AS (
          VALUES ${sql.join(targetRows, sql`, `)}
        ),
        live_run_tasks(task_id) AS (
          VALUES ${sql.join(liveRunTaskRows, sql`, `)}
        ),
        live_tasks(live_task_id, parent_id) AS (
          SELECT DISTINCT live_task.id, live_task.parent_id
          FROM live_run_tasks live_run
          JOIN tasks live_task ON live_task.id = live_run.task_id
          WHERE live_task.company_id = ${companyId}
            AND live_task.hidden_at IS NULL
        ),
        live_ancestors(live_task_id, ancestor_id, next_parent_id, visited_task_ids) AS (
          SELECT live_tasks.live_task_id, parent.id, parent.parent_id, ARRAY[live_tasks.live_task_id, parent.id]
          FROM live_tasks
          JOIN tasks parent ON parent.id = live_tasks.parent_id
          WHERE parent.company_id = ${companyId}
            AND parent.hidden_at IS NULL
          UNION ALL
          SELECT
            live_ancestors.live_task_id,
            parent.id,
            parent.parent_id,
            live_ancestors.visited_task_ids || parent.id
          FROM live_ancestors
          JOIN tasks parent ON parent.id = live_ancestors.next_parent_id
          WHERE parent.company_id = ${companyId}
            AND parent.hidden_at IS NULL
            AND NOT parent.id = ANY(live_ancestors.visited_task_ids)
        )
      SELECT
        live_ancestors.ancestor_id::text AS "taskId",
        count(DISTINCT live_ancestors.live_task_id)::int AS "liveDescendantCount"
      FROM live_ancestors
      JOIN target_tasks ON target_tasks.task_id = live_ancestors.ancestor_id
      WHERE live_ancestors.ancestor_id <> live_ancestors.live_task_id
      GROUP BY live_ancestors.ancestor_id
    `);

    const resultRows = Array.isArray(rows)
      ? rows
      : Array.from(rows as Iterable<unknown>);
    for (const row of resultRows) {
      if (typeof row !== "object" || row === null) continue;
      const taskId = (row as { taskId?: unknown }).taskId;
      const liveDescendantCount = (row as { liveDescendantCount?: unknown })
        .liveDescendantCount;
      if (typeof taskId !== "string") continue;
      const count =
        typeof liveDescendantCount === "number"
          ? liveDescendantCount
          : Number(liveDescendantCount);
      if (Number.isFinite(count)) map.set(taskId, count);
    }
  }

  return map;
}

function createTaskBlockerAttention(
  input: Partial<TaskBlockerAttention> = {},
): TaskBlockerAttention {
  return {
    state: input.state ?? "none",
    reason: input.reason ?? null,
    unresolvedBlockerCount: input.unresolvedBlockerCount ?? 0,
    coveredBlockerCount: input.coveredBlockerCount ?? 0,
    stalledBlockerCount: input.stalledBlockerCount ?? 0,
    attentionBlockerCount: input.attentionBlockerCount ?? 0,
    sampleBlockerIdentifier: input.sampleBlockerIdentifier ?? null,
    sampleStalledBlockerIdentifier:
      input.sampleStalledBlockerIdentifier ?? null,
  };
}

function blockerSampleIdentifier(
  node: TaskBlockerAttentionNode | null | undefined,
) {
  return node?.identifier ?? null;
}

function appendBlockerAttentionEdges(
  edgesByTaskId: Map<string, TaskBlockerAttentionEdge[]>,
  rows: TaskBlockerAttentionEdge[],
) {
  for (const row of rows) {
    const existing = edgesByTaskId.get(row.taskId) ?? [];
    if (!existing.some((edge) => edge.blockerTaskId === row.blockerTaskId)) {
      existing.push(row);
      edgesByTaskId.set(row.taskId, existing);
    }
  }
}

type TaskRelationSummaryRow = {
  relatedId: string;
  taskNumber: number;
  identifier: string;
  title: string | null;
  boardPresentationStatus: string;
  priority: string;
  ownerAgentId: string | null;
  ownerUserId: string | null;
};

function summarizeTaskRelationRow(
  row: TaskRelationSummaryRow,
): TaskRelationTaskSummary {
  return {
    id: row.relatedId,
    taskNumber: row.taskNumber,
    identifier: row.identifier,
    title: row.title,
    boardPresentationStatus:
      row.boardPresentationStatus as TaskRelationTaskSummary["boardPresentationStatus"],
    priority: row.priority as TaskRelationTaskSummary["priority"],
    ownerAgentId: row.ownerAgentId,
    ownerUserId: row.ownerUserId,
  };
}

function taskRelationSortLabel(
  task: Pick<TaskRelationTaskSummary, "id" | "identifier" | "title">,
) {
  return task.title ?? task.identifier;
}

async function terminalExplicitBlockersByRoot(
  companyId: string,
  roots: TaskRelationTaskSummary[],
  dbOrTx: DbReader,
): Promise<Map<string, TaskRelationTaskSummary[]>> {
  const rootIds = [...new Set(roots.map((root) => root.id))];
  const terminalByRoot = new Map<string, TaskRelationTaskSummary[]>();
  if (rootIds.length === 0) return terminalByRoot;

  const nodesById = new Map<string, TaskRelationTaskSummary>();
  const edgesByTaskId = new Map<string, string[]>();
  for (const root of roots) nodesById.set(root.id, root);

  let frontier = rootIds;
  for (
    let depth = 0;
    frontier.length > 0 && depth < BLOCKER_ATTENTION_MAX_DEPTH;
    depth += 1
  ) {
    const nextFrontier = new Set<string>();
    for (const chunk of chunkList(
      [...new Set(frontier)],
      TASK_LIST_RELATED_QUERY_CHUNK_SIZE,
    )) {
      const rows = await dbOrTx
        .select({
          currentTaskId: taskRelations.relatedTaskId,
          relatedId: tasks.id,
          taskNumber: tasks.taskNumber,
          identifier: tasks.identifier,
          title: tasks.title,
          boardPresentationStatus: tasks.boardPresentationStatus,
          priority: tasks.priority,
          ownerAgentId: tasks.ownerAgentId,
          ownerUserId: tasks.ownerUserId,
        })
        .from(taskRelations)
        .innerJoin(tasks, eq(taskRelations.taskId, tasks.id))
        .where(
          and(
            eq(taskRelations.companyId, companyId),
            eq(taskRelations.type, "blocks"),
            inArray(taskRelations.relatedTaskId, chunk),
            eq(tasks.companyId, companyId),
            ne(tasks.boardPresentationStatus, "done"),
          ),
        );

      for (const row of rows) {
        const existingEdges = edgesByTaskId.get(row.currentTaskId) ?? [];
        if (!existingEdges.includes(row.relatedId)) {
          existingEdges.push(row.relatedId);
          edgesByTaskId.set(row.currentTaskId, existingEdges);
        }
        if (!nodesById.has(row.relatedId)) {
          nodesById.set(row.relatedId, summarizeTaskRelationRow(row));
          nextFrontier.add(row.relatedId);
        }
      }
    }

    if (nodesById.size > BLOCKER_ATTENTION_MAX_NODES) break;
    frontier = [...nextFrontier];
  }

  const collectTerminal = (
    taskId: string,
    seen: Set<string>,
  ): TaskRelationTaskSummary[] => {
    if (seen.has(taskId)) return [];
    const node = nodesById.get(taskId);
    if (!node || node.boardPresentationStatus === "done") return [];
    const nextSeen = new Set(seen);
    nextSeen.add(taskId);
    const downstreamIds = edgesByTaskId.get(taskId) ?? [];
    if (downstreamIds.length === 0) return [node];
    return downstreamIds.flatMap((downstreamId) =>
      collectTerminal(downstreamId, nextSeen),
    );
  };

  for (const rootId of rootIds) {
    const deduped = new Map<string, TaskRelationTaskSummary>();
    for (const blocker of collectTerminal(rootId, new Set())) {
      if (blocker.id !== rootId) deduped.set(blocker.id, blocker);
    }
    if (deduped.size > 0) {
      terminalByRoot.set(
        rootId,
        [...deduped.values()].sort((a, b) =>
          taskRelationSortLabel(a).localeCompare(taskRelationSortLabel(b)),
        ),
      );
    }
  }

  return terminalByRoot;
}

async function listTaskBlockerAttentionMap(
  dbOrTx: any,
  companyId: string,
  taskRows: TaskBlockerAttentionInputNode[],
): Promise<Map<string, TaskBlockerAttention>> {
  const statusRows: TaskBlockerAttentionNode[] = taskRows;
  const roots = statusRows.filter(
    (row) =>
      row.companyId === companyId && row.boardPresentationStatus === "blocked",
  );
  const attentionMap = new Map<string, TaskBlockerAttention>();
  for (const row of statusRows) {
    if (row.boardPresentationStatus !== "blocked") {
      attentionMap.set(row.id, createTaskBlockerAttention());
    }
  }
  if (roots.length === 0) return attentionMap;

  const nodesById = new Map<string, TaskBlockerAttentionNode>();
  const edgesByTaskId = new Map<string, TaskBlockerAttentionEdge[]>();
  for (const root of roots) nodesById.set(root.id, { ...root });

  let frontier = roots.map((root) => root.id);
  let truncated = false;
  for (
    let depth = 0;
    frontier.length > 0 && depth < BLOCKER_ATTENTION_MAX_DEPTH;
    depth += 1
  ) {
    const nextFrontier = new Set<string>();

    for (const chunk of chunkList(
      [...new Set(frontier)],
      TASK_LIST_RELATED_QUERY_CHUNK_SIZE,
    )) {
      const explicitBlockerRowsPromise: Promise<
        TaskBlockerAttentionQueryRow[]
      > = dbOrTx
        .select({
          taskId: taskRelations.relatedTaskId,
          blockerTaskId: tasks.id,
          id: tasks.id,
          companyId: tasks.companyId,
          parentId: tasks.parentId,
          identifier: tasks.identifier,
          title: tasks.title,
          boardPresentationStatus: tasks.boardPresentationStatus,
          ownerAgentId: tasks.ownerAgentId,
          ownerUserId: tasks.ownerUserId,
        })
        .from(taskRelations)
        .innerJoin(tasks, eq(taskRelations.taskId, tasks.id))
        .where(
          and(
            eq(taskRelations.companyId, companyId),
            eq(taskRelations.type, "blocks"),
            inArray(taskRelations.relatedTaskId, chunk),
            eq(tasks.companyId, companyId),
            ne(tasks.boardPresentationStatus, "done"),
          ),
        );
      const childRowsPromise: Promise<TaskBlockerAttentionQueryRow[]> = dbOrTx
        .select({
          taskId: tasks.parentId,
          blockerTaskId: tasks.id,
          id: tasks.id,
          companyId: tasks.companyId,
          parentId: tasks.parentId,
          identifier: tasks.identifier,
          title: tasks.title,
          boardPresentationStatus: tasks.boardPresentationStatus,
          ownerAgentId: tasks.ownerAgentId,
          ownerUserId: tasks.ownerUserId,
        })
        .from(tasks)
        .where(
          and(
            eq(tasks.companyId, companyId),
            inArray(tasks.parentId, chunk),
            notInArray(tasks.boardPresentationStatus, [
              ...BLOCKER_ATTENTION_CHILD_TERMINAL_STATUSES,
            ]),
          ),
        );
      const [explicitBlockerRows, childRows] = await Promise.all([
        explicitBlockerRowsPromise,
        childRowsPromise,
      ]);

      appendBlockerAttentionEdges(edgesByTaskId, [
        ...explicitBlockerRows
          .filter(
            (row): row is TaskBlockerAttentionQueryRow & { taskId: string } =>
              row.taskId !== null,
          )
          .map((row) => ({
            taskId: row.taskId,
            blockerTaskId: row.blockerTaskId,
          })),
        ...childRows
          .filter(
            (row): row is TaskBlockerAttentionQueryRow & { taskId: string } =>
              row.taskId !== null,
          )
          .map((row) => ({
            taskId: row.taskId,
            blockerTaskId: row.blockerTaskId,
          })),
      ]);

      for (const row of [...explicitBlockerRows, ...childRows]) {
        if (!row.taskId || nodesById.has(row.blockerTaskId)) continue;
        nodesById.set(row.blockerTaskId, {
          id: row.blockerTaskId,
          companyId: row.companyId,
          parentId: row.parentId,
          identifier: row.identifier,
          title: row.title,
          boardPresentationStatus: row.boardPresentationStatus,
          ownerAgentId: row.ownerAgentId,
          ownerUserId: row.ownerUserId,
        });
        nextFrontier.add(row.blockerTaskId);
      }
    }

    if (nodesById.size > BLOCKER_ATTENTION_MAX_NODES) {
      truncated = true;
      break;
    }
    frontier = [...nextFrontier];
  }
  if (frontier.length > 0) truncated = true;

  const nodeIds = [...nodesById.keys()];
  const activeTaskIds = new Set<string>();
  const agentIds = new Set<string>();
  for (const node of nodesById.values()) {
    if (node.ownerAgentId) agentIds.add(node.ownerAgentId);
  }

  for (const chunk of chunkList(nodeIds, TASK_LIST_RELATED_QUERY_CHUNK_SIZE)) {
    const linkages = await resolveCurrentTaskOwnerRunLinkages(dbOrTx as Db, {
      companyId,
      taskIds: chunk,
    });
    for (const taskId of linkages.keys()) activeTaskIds.add(taskId);
  }

  const explicitWaitCandidateIds = [...nodesById.values()]
    .filter((node) => node.boardPresentationStatus !== "done")
    .map((node) => node.id);
  const explicitWaitingTaskIds = new Set<string>();
  if (explicitWaitCandidateIds.length > 0) {
    for (const chunk of chunkList(
      explicitWaitCandidateIds,
      TASK_LIST_RELATED_QUERY_CHUNK_SIZE,
    )) {
      const approvalRows: Array<{ taskId: string }> = await dbOrTx
        .select({ taskId: taskApprovals.taskId })
        .from(taskApprovals)
        .innerJoin(approvals, eq(taskApprovals.approvalId, approvals.id))
        .where(
          and(
            eq(taskApprovals.companyId, companyId),
            inArray(
              approvals.status,
              BLOCKER_ATTENTION_PENDING_APPROVAL_STATUSES,
            ),
            inArray(taskApprovals.taskId, chunk),
          ),
        );
      for (const row of approvalRows) explicitWaitingTaskIds.add(row.taskId);
    }
  }

  const agentRows: TaskBlockerAttentionAgentRow[] =
    agentIds.size > 0
      ? await dbOrTx
          .select({
            id: agents.id,
            companyId: agents.companyId,
            status: agents.status,
          })
          .from(agents)
          .where(
            and(
              eq(agents.companyId, companyId),
              inArray(agents.id, [...agentIds]),
            ),
          )
      : [];
  const agentsById = new Map(agentRows.map((agent) => [agent.id, agent]));

  type PathClassification = {
    covered: boolean;
    stalled: boolean;
    sampleBlockerIdentifier: string | null;
    sampleStalledBlockerIdentifier: string | null;
  };
  const classifyPath = (
    nodeId: string,
    seen: Set<string>,
  ): PathClassification => {
    const sample = blockerSampleIdentifier(nodesById.get(nodeId));
    if (truncated || seen.has(nodeId)) {
      return {
        covered: false,
        stalled: false,
        sampleBlockerIdentifier: sample,
        sampleStalledBlockerIdentifier: null,
      };
    }
    const node = nodesById.get(nodeId);
    if (!node || node.companyId !== companyId) {
      return {
        covered: false,
        stalled: false,
        sampleBlockerIdentifier: nodeId,
        sampleStalledBlockerIdentifier: null,
      };
    }
    const nodeSample = blockerSampleIdentifier(node);
    if (node.boardPresentationStatus === "done") {
      return {
        covered: true,
        stalled: false,
        sampleBlockerIdentifier: nodeSample,
        sampleStalledBlockerIdentifier: null,
      };
    }
    if (explicitWaitingTaskIds.has(node.id)) {
      return {
        covered: true,
        stalled: false,
        sampleBlockerIdentifier: nodeSample,
        sampleStalledBlockerIdentifier: null,
      };
    }
    if (node.ownerUserId && node.boardPresentationStatus !== "cancelled") {
      return {
        covered: true,
        stalled: false,
        sampleBlockerIdentifier: nodeSample,
        sampleStalledBlockerIdentifier: null,
      };
    }
    if (node.boardPresentationStatus === "in_review") {
      const hasWaitingPath =
        activeTaskIds.has(node.id) || Boolean(node.ownerUserId);
      if (hasWaitingPath) {
        return {
          covered: true,
          stalled: false,
          sampleBlockerIdentifier: nodeSample,
          sampleStalledBlockerIdentifier: null,
        };
      }
      return {
        covered: false,
        stalled: true,
        sampleBlockerIdentifier: nodeSample,
        sampleStalledBlockerIdentifier: nodeSample,
      };
    }
    if (activeTaskIds.has(node.id)) {
      return {
        covered: true,
        stalled: false,
        sampleBlockerIdentifier: nodeSample,
        sampleStalledBlockerIdentifier: null,
      };
    }
    if (node.boardPresentationStatus === "cancelled") {
      return {
        covered: false,
        stalled: false,
        sampleBlockerIdentifier: nodeSample,
        sampleStalledBlockerIdentifier: null,
      };
    }
    if (node.boardPresentationStatus === "backlog" && node.ownerAgentId) {
      return {
        covered: false,
        stalled: false,
        sampleBlockerIdentifier: nodeSample,
        sampleStalledBlockerIdentifier: null,
      };
    }

    const downstream = (edgesByTaskId.get(node.id) ?? []).filter(
      (edge) =>
        nodesById.get(edge.blockerTaskId)?.boardPresentationStatus !== "done",
    );
    if (downstream.length > 0) {
      const nextSeen = new Set(seen);
      nextSeen.add(nodeId);
      const classified = downstream.map((edge) =>
        classifyPath(edge.blockerTaskId, nextSeen),
      );
      const stalledChild = classified.find(
        (result) => result.stalled || result.sampleStalledBlockerIdentifier,
      );
      const sampleStalled =
        stalledChild?.sampleStalledBlockerIdentifier ?? null;
      const hardAttention = classified.find(
        (result) => !result.covered && !result.stalled,
      );
      if (hardAttention) {
        return {
          covered: false,
          stalled: false,
          sampleBlockerIdentifier: hardAttention.sampleBlockerIdentifier,
          sampleStalledBlockerIdentifier: sampleStalled,
        };
      }
      const stalledEntry = classified.find((result) => result.stalled);
      if (stalledEntry) {
        return {
          covered: false,
          stalled: true,
          sampleBlockerIdentifier: stalledEntry.sampleBlockerIdentifier,
          sampleStalledBlockerIdentifier: sampleStalled,
        };
      }
      return {
        covered: true,
        stalled: false,
        sampleBlockerIdentifier:
          classified[0]?.sampleBlockerIdentifier ?? nodeSample,
        sampleStalledBlockerIdentifier: null,
      };
    }

    if (node.ownerAgentId) {
      const owner = agentsById.get(node.ownerAgentId);
      if (
        !owner ||
        owner.companyId !== companyId ||
        !BLOCKER_ATTENTION_INVOKABLE_AGENT_STATUSES.has(owner.status)
      ) {
        return {
          covered: false,
          stalled: false,
          sampleBlockerIdentifier: nodeSample,
          sampleStalledBlockerIdentifier: null,
        };
      }
    }

    return {
      covered: false,
      stalled: false,
      sampleBlockerIdentifier: nodeSample,
      sampleStalledBlockerIdentifier: null,
    };
  };

  for (const root of roots) {
    const topLevelEdges = (edgesByTaskId.get(root.id) ?? []).filter(
      (edge) =>
        nodesById.get(edge.blockerTaskId)?.boardPresentationStatus !== "done",
    );
    if (topLevelEdges.length === 0) {
      attentionMap.set(
        root.id,
        createTaskBlockerAttention({
          state: "needs_attention",
          reason: "attention_required",
        }),
      );
      continue;
    }

    const classified = topLevelEdges.map((edge) => ({
      edge,
      result: classifyPath(edge.blockerTaskId, new Set([root.id])),
    }));
    const coveredBlockerCount = classified.filter(
      (entry) => entry.result.covered,
    ).length;
    const stalledBlockerCount = classified.filter(
      (entry) => entry.result.stalled,
    ).length;
    const attentionBlockerCount =
      classified.length - coveredBlockerCount - stalledBlockerCount;
    const hardAttentionEntry = classified.find(
      (entry) => !entry.result.covered && !entry.result.stalled,
    );
    const stalledEntry = classified.find((entry) => entry.result.stalled);
    const sampleEntry =
      hardAttentionEntry ?? stalledEntry ?? classified[0] ?? null;
    const sampleNode = sampleEntry
      ? nodesById.get(sampleEntry.edge.blockerTaskId)
      : null;
    const sampleStalledFromChain = classified
      .map((entry) => entry.result.sampleStalledBlockerIdentifier)
      .find((value) => value);

    let state: TaskBlockerAttention["state"];
    let reason: TaskBlockerAttention["reason"];
    if (attentionBlockerCount > 0) {
      state = "needs_attention";
      reason = "attention_required";
    } else if (stalledBlockerCount > 0) {
      state = "stalled";
      reason = "stalled_review";
    } else {
      state = "covered";
      reason = topLevelEdges.every(
        (edge) => nodesById.get(edge.blockerTaskId)?.parentId === root.id,
      )
        ? "active_child"
        : "active_dependency";
    }

    attentionMap.set(
      root.id,
      createTaskBlockerAttention({
        state,
        reason,
        unresolvedBlockerCount: topLevelEdges.length,
        coveredBlockerCount,
        stalledBlockerCount,
        attentionBlockerCount,
        sampleBlockerIdentifier:
          sampleEntry?.result.sampleBlockerIdentifier ??
          blockerSampleIdentifier(sampleNode),
        sampleStalledBlockerIdentifier:
          stalledEntry?.result.sampleStalledBlockerIdentifier ??
          sampleStalledFromChain ??
          null,
      }),
    );
  }

  return attentionMap;
}

const taskListSelect = {
  id: tasks.id,
  companyId: tasks.companyId,
  projectId: tasks.projectId,
  projectWorkspaceId: tasks.projectWorkspaceId,
  goalId: tasks.goalId,
  parentId: tasks.parentId,
  parentOwnershipEpoch: tasks.parentOwnershipEpoch,
  title: tasks.title,
  request: sql<string>`
    encode(
      substring(
        convert_to(${tasks.request}, current_setting('server_encoding'))
        FROM 1 FOR ${TASK_LIST_REQUEST_MAX_BYTES}
      ),
      'base64'
    )
  `,
  lifecycleStatus: tasks.lifecycleStatus,
  boardPresentationStatus: tasks.boardPresentationStatus,
  disposition: tasks.disposition,
  workMode: tasks.workMode,
  priority: tasks.priority,
  ownerKind: tasks.ownerKind,
  ownerAgentId: tasks.ownerAgentId,
  ownerUserId: tasks.ownerUserId,
  ownerAssignmentSource: tasks.ownerAssignmentSource,
  ownershipEpoch: tasks.ownershipEpoch,
  creatorKind: tasks.creatorKind,
  creatorAuthorityId: tasks.creatorAuthorityId,
  creatorAdapterConfigRevisionId: tasks.creatorAdapterConfigRevisionId,
  creatorUserId: tasks.creatorUserId,
  creatorPluginInstallationId: tasks.creatorPluginInstallationId,
  creatorPluginKey: tasks.creatorPluginKey,
  creatorCallbackKey: tasks.creatorCallbackKey,
  creatorCallbackVersion: tasks.creatorCallbackVersion,
  creatorRoutineId: tasks.creatorRoutineId,
  creatorRoutineDispatchId: tasks.creatorRoutineDispatchId,
  creatorSystemSourceKind: tasks.creatorSystemSourceKind,
  creatorSystemSourceId: tasks.creatorSystemSourceId,
  escalatedFromAffectedTaskId: tasks.escalatedFromAffectedTaskId,
  escalatedFromTriggeringRunId: tasks.escalatedFromTriggeringRunId,
  escalatedFromReason: tasks.escalatedFromReason,
  affectedOwnershipEpoch: tasks.affectedOwnershipEpoch,
  responsibleUserId: tasks.responsibleUserId,
  taskNumber: tasks.taskNumber,
  identifier: tasks.identifier,
  originKind: tasks.originKind,
  originId: tasks.originId,
  originRunId: tasks.originRunId,
  originFingerprint: tasks.originFingerprint,
  requestDepth: tasks.requestDepth,
  billingCode: tasks.billingCode,
  executionPolicy: sql<null>`null`,
  executionState: sql<null>`null`,
  monitorNextCheckAt: tasks.monitorNextCheckAt,
  monitorLastTriggeredAt: tasks.monitorLastTriggeredAt,
  monitorAttemptCount: tasks.monitorAttemptCount,
  monitorNotes: tasks.monitorNotes,
  monitorScheduledBy: tasks.monitorScheduledBy,
  executionWorkspaceId: sql<string | null>`(
    select ${taskExecutionWorkspaceBindings.executionWorkspaceId}
    from ${taskExecutionWorkspaceBindings}
    where ${taskExecutionWorkspaceBindings.companyId} = ${tasks.companyId}
      and ${taskExecutionWorkspaceBindings.taskId} = ${tasks.id}
      and ${taskExecutionWorkspaceBindings.ownershipEpoch} = ${tasks.ownershipEpoch}
    limit 1
  )`,
  sourceTrust: tasks.sourceTrust,
  startedAt: tasks.startedAt,
  completedAt: tasks.completedAt,
  cancelledAt: tasks.cancelledAt,
  hiddenAt: tasks.hiddenAt,
  createdAt: tasks.createdAt,
  updatedAt: tasks.updatedAt,
};

function withActiveRuns<T extends Pick<TaskRow, "id">>(
  taskRows: T[],
  runMap: Map<string, TaskActiveRunRow>,
): Array<T & { activeRun: TaskActiveRunRow | null }> {
  return taskRows.map((row) => ({
    ...row,
    activeRun: runMap.get(row.id) ?? null,
  }));
}

async function userCommentStatsForTasks(
  dbOrTx: any,
  companyId: string,
  userId: string,
  taskIds: string[],
): Promise<TaskUserCommentStats[]> {
  const stats: TaskUserCommentStats[] = [];
  for (const taskIdChunk of chunkList(
    taskIds,
    TASK_LIST_RELATED_QUERY_CHUNK_SIZE,
  )) {
    const rows = await dbOrTx
      .select({
        taskId: taskComments.taskId,
        myLastCommentAt: sql<Date | null>`
          MAX(CASE WHEN ${taskComments.authorUserId} = ${userId} THEN ${taskComments.createdAt} END)
        `,
        lastExternalCommentAt: sql<Date | null>`
          MAX(
            CASE
              WHEN ${taskComments.authorUserId} IS NULL OR ${taskComments.authorUserId} <> ${userId}
              THEN ${taskComments.createdAt}
            END
          )
        `,
      })
      .from(taskComments)
      .where(
        and(
          eq(taskComments.companyId, companyId),
          inArray(taskComments.taskId, taskIdChunk),
        ),
      )
      .groupBy(taskComments.taskId);
    stats.push(...rows);
  }
  return stats;
}

async function userReadStatsForTasks(
  dbOrTx: any,
  companyId: string,
  userId: string,
  taskIds: string[],
): Promise<TaskReadStat[]> {
  const stats: TaskReadStat[] = [];
  for (const taskIdChunk of chunkList(
    taskIds,
    TASK_LIST_RELATED_QUERY_CHUNK_SIZE,
  )) {
    const rows = await dbOrTx
      .select({
        taskId: taskReadStates.taskId,
        myLastReadAt: taskReadStates.lastReadAt,
      })
      .from(taskReadStates)
      .where(
        and(
          eq(taskReadStates.companyId, companyId),
          eq(taskReadStates.userId, userId),
          inArray(taskReadStates.taskId, taskIdChunk),
        ),
      );
    stats.push(...rows);
  }
  return stats;
}

async function lastActivityStatsForTasks(
  dbOrTx: any,
  companyId: string,
  taskIds: string[],
): Promise<TaskLastActivityStat[]> {
  const byTaskId = new Map<string, TaskLastActivityStat>();
  for (const taskIdChunk of chunkList(
    taskIds,
    TASK_LIST_RELATED_QUERY_CHUNK_SIZE,
  )) {
    const [commentRows, logRows] = await Promise.all([
      dbOrTx
        .select({
          taskId: taskComments.taskId,
          latestCommentAt: sql<Date | null>`MAX(${taskComments.createdAt})`,
        })
        .from(taskComments)
        .where(
          and(
            eq(taskComments.companyId, companyId),
            inArray(taskComments.taskId, taskIdChunk),
          ),
        )
        .groupBy(taskComments.taskId),
      dbOrTx
        .select({
          taskId: activityLog.entityId,
          latestLogAt: sql<Date | null>`MAX(${activityLog.createdAt})`,
        })
        .from(activityLog)
        .where(
          and(
            eq(activityLog.companyId, companyId),
            eq(activityLog.entityType, "task"),
            inArray(activityLog.entityId, taskIdChunk),
            sql`${activityLog.action} NOT IN (${sql.join(
              TASK_LOCAL_INBOX_ACTIVITY_ACTIONS.map((action) => sql`${action}`),
              sql`, `,
            )})`,
          ),
        )
        .groupBy(activityLog.entityId),
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

async function blockedByMapForTasks(
  dbOrTx: any,
  companyId: string,
  taskIds: string[],
): Promise<Map<string, TaskRelationTaskSummary[]>> {
  const map = new Map<string, TaskRelationTaskSummary[]>();
  const uniqueTaskIds = [...new Set(taskIds)];
  if (uniqueTaskIds.length === 0) return map;

  for (const taskId of uniqueTaskIds) {
    map.set(taskId, []);
  }

  for (const taskIdChunk of chunkList(
    uniqueTaskIds,
    TASK_LIST_RELATED_QUERY_CHUNK_SIZE,
  )) {
    const rows = await dbOrTx
      .select({
        currentTaskId: taskRelations.relatedTaskId,
        relatedId: tasks.id,
        taskNumber: tasks.taskNumber,
        identifier: tasks.identifier,
        title: tasks.title,
        boardPresentationStatus: tasks.boardPresentationStatus,
        priority: tasks.priority,
        ownerAgentId: tasks.ownerAgentId,
        ownerUserId: tasks.ownerUserId,
      })
      .from(taskRelations)
      .innerJoin(tasks, eq(taskRelations.taskId, tasks.id))
      .where(
        and(
          eq(taskRelations.companyId, companyId),
          eq(taskRelations.type, "blocks"),
          inArray(taskRelations.relatedTaskId, taskIdChunk),
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
          row.boardPresentationStatus as TaskRelationTaskSummary["boardPresentationStatus"],
        priority: row.priority as TaskRelationTaskSummary["priority"],
        ownerAgentId: row.ownerAgentId,
        ownerUserId: row.ownerUserId,
      });
    }
  }

  for (const blockedBy of map.values()) {
    blockedBy.sort((a, b) =>
      taskRelationSortLabel(a).localeCompare(taskRelationSortLabel(b)),
    );
  }

  return map;
}

const BLOCKED_INBOX_TERMINAL_STATUSES = ["done", "cancelled"] as const;
const BLOCKED_INBOX_PENDING_APPROVAL_STATUSES = [
  "pending",
  "revision_requested",
] as const;

type BlockedInboxTaskRow = TaskRow & {
  labels?: TaskLabelRow[];
  labelIds?: string[];
};
type BlockedInboxApprovalRow = {
  approvalId: string;
  taskId: string;
  createdAt: Date;
};

function taskRef(
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
): TaskBlockedInboxTaskRef | null {
  if (!row) return null;
  return {
    id: row.id,
    taskNumber: row.taskNumber,
    identifier: row.identifier,
    title: row.title,
    boardPresentationStatus: row.boardPresentationStatus,
    priority: row.priority as TaskBlockedInboxTaskRef["priority"],
    ownerAgentId: row.ownerAgentId,
    ownerUserId: row.ownerUserId,
  };
}

function hasPlanDocumentCondition(
  companyId: string,
  hasPlanDocument: boolean,
): SQL {
  const existsPlanDocument = sql<boolean>`
    EXISTS (
      SELECT 1
      FROM ${taskDocuments}
      WHERE ${taskDocuments.companyId} = ${companyId}
        AND ${taskDocuments.taskId} = ${tasks.id}
        AND ${taskDocuments.key} = 'plan'
    )
  `;
  return hasPlanDocument
    ? existsPlanDocument
    : sql<boolean>`NOT ${existsPlanDocument}`;
}

function isoDate(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function attentionBase(input: {
  state: TaskBlockedInboxAttention["state"];
  reason: TaskBlockedInboxAttention["reason"];
  severity: TaskBlockedInboxAttention["severity"];
  stoppedSinceAt: Date | string | null | undefined;
  owner: TaskBlockedInboxAttention["owner"];
  action: TaskBlockedInboxAttention["action"];
  sourceTask: TaskBlockedInboxTaskRef | null;
  leafTask?: TaskBlockedInboxTaskRef | null;
  approvalId?: string | null;
  sampleTaskIdentifier?: string | null;
  externalDetailsRedacted?: boolean;
}): TaskBlockedInboxAttention {
  return {
    kind: "blocked",
    state: input.state,
    reason: input.reason,
    severity: input.severity,
    stoppedSinceAt: isoDate(input.stoppedSinceAt),
    owner: input.owner,
    action: input.action,
    sourceTask: input.sourceTask,
    leafTask: input.leafTask ?? null,
    approvalId: input.approvalId ?? null,
    sampleTaskIdentifier:
      input.sampleTaskIdentifier ??
      input.leafTask?.identifier ??
      input.sourceTask?.identifier ??
      null,
    redaction: {
      externalDetailsRedacted: input.externalDetailsRedacted ?? false,
      secretFieldsOmitted: true,
    },
  };
}

function externalWaitFromRequest(
  request: string | null,
): { owner: string; action: string } | null {
  if (!request) return null;
  const owner = request.match(/^\s*external owner\s*:\s*(.+)$/im)?.[1]?.trim();
  const action = request
    .match(/^\s*external action\s*:\s*(.+)$/im)?.[1]
    ?.trim();
  if (!owner || !action) return null;
  return {
    owner: owner.slice(0, 120),
    action: action.slice(0, 240),
  };
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redactExternalWaitRequest(
  request: string | null | undefined,
  external: { owner: string; action: string } | null,
) {
  if (!request) return null;
  let redacted = request
    .split(/\r?\n/)
    .filter((line) => !/^\s*external\s+(?:owner|action)\s*:/i.test(line))
    .join("\n");

  for (const value of [external?.owner, external?.action]) {
    if (!value) continue;
    redacted = redacted.replace(
      new RegExp(escapeRegExp(value), "gi"),
      "[redacted external wait detail]",
    );
  }

  redacted = redacted.replace(/\n{3,}/g, "\n\n").trim();
  return redacted.length > 0 ? redacted : null;
}

function blockedInboxResponseRequest(
  attention: TaskBlockedInboxAttention,
  row: BlockedInboxTaskRow,
) {
  if (!attention.redaction.externalDetailsRedacted) return row.request;
  return (
    redactExternalWaitRequest(
      row.request,
      externalWaitFromRequest(row.request),
    ) ?? "[redacted]"
  );
}

function blockedInboxSearchText(
  attention: TaskBlockedInboxAttention,
  row: BlockedInboxTaskRow,
) {
  return [
    row.identifier,
    row.title,
    blockedInboxResponseRequest(attention, row),
    attention.sourceTask?.identifier,
    attention.sourceTask?.title,
    attention.leafTask?.identifier,
    attention.leafTask?.title,
    attention.sampleTaskIdentifier,
    attention.action.label,
    attention.action.detail,
  ]
    .filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    )
    .join(" ")
    .toLowerCase();
}

function blockedInboxSeverityRank(
  severity: TaskBlockedInboxAttention["severity"],
) {
  switch (severity) {
    case "critical":
      return 0;
    case "high":
      return 1;
    case "medium":
      return 2;
    case "low":
      return 3;
  }
}

function taskPriorityRank(priority: string) {
  switch (priority) {
    case "critical":
      return 0;
    case "high":
      return 1;
    case "medium":
      return 2;
    case "low":
      return 3;
    default:
      return 4;
  }
}

function compareBlockedInboxRows(
  left: BlockedInboxTaskRow & {
    blockedInboxAttention: TaskBlockedInboxAttention;
    lastActivityAt?: Date | null;
  },
  right: BlockedInboxTaskRow & {
    blockedInboxAttention: TaskBlockedInboxAttention;
    lastActivityAt?: Date | null;
  },
) {
  const leftAttention = left.blockedInboxAttention;
  const rightAttention = right.blockedInboxAttention;
  const severity =
    blockedInboxSeverityRank(leftAttention.severity) -
    blockedInboxSeverityRank(rightAttention.severity);
  if (severity !== 0) return severity;

  const leftStopped = leftAttention.stoppedSinceAt
    ? new Date(leftAttention.stoppedSinceAt).getTime()
    : Number.POSITIVE_INFINITY;
  const rightStopped = rightAttention.stoppedSinceAt
    ? new Date(rightAttention.stoppedSinceAt).getTime()
    : Number.POSITIVE_INFINITY;
  if (leftStopped !== rightStopped) return leftStopped - rightStopped;

  const priority =
    taskPriorityRank(left.priority) - taskPriorityRank(right.priority);
  if (priority !== 0) return priority;

  const leftActivity = left.lastActivityAt
    ? new Date(left.lastActivityAt).getTime()
    : new Date(left.updatedAt).getTime();
  const rightActivity = right.lastActivityAt
    ? new Date(right.lastActivityAt).getTime()
    : new Date(right.updatedAt).getTime();
  if (leftActivity !== rightActivity) return rightActivity - leftActivity;

  return right.id.localeCompare(left.id);
}

async function listTaskBlockedInboxAttentionMap(
  dbOrTx: any,
  companyId: string,
  taskRows: BlockedInboxTaskRow[],
): Promise<Map<string, TaskBlockedInboxAttention>> {
  const rowTaskIds = [...new Set(taskRows.map((row) => row.id))];
  const result = new Map<string, TaskBlockedInboxAttention>();
  if (rowTaskIds.length === 0) return result;

  const approvalRows: BlockedInboxApprovalRow[] = await dbOrTx
    .select({
      approvalId: approvals.id,
      taskId: taskApprovals.taskId,
      createdAt: approvals.createdAt,
    })
    .from(taskApprovals)
    .innerJoin(approvals, eq(taskApprovals.approvalId, approvals.id))
    .where(
      and(
        eq(taskApprovals.companyId, companyId),
        eq(approvals.companyId, companyId),
        inArray(approvals.status, [...BLOCKED_INBOX_PENDING_APPROVAL_STATUSES]),
        inArray(taskApprovals.taskId, rowTaskIds),
      ),
    );
  const blockerAttention = await listTaskBlockerAttentionMap(
    dbOrTx,
    companyId,
    taskRows,
  );

  const approvalByTaskId = new Map<string, BlockedInboxApprovalRow>();
  for (const row of approvalRows) {
    if (!approvalByTaskId.has(row.taskId))
      approvalByTaskId.set(row.taskId, row);
  }
  for (const row of taskRows) {
    if (
      row.companyId !== companyId ||
      BLOCKED_INBOX_TERMINAL_STATUSES.includes(
        row.boardPresentationStatus as (typeof BLOCKED_INBOX_TERMINAL_STATUSES)[number],
      ) ||
      row.hiddenAt
    ) {
      continue;
    }
    const source = taskRef(row);

    const approval = approvalByTaskId.get(row.id);
    if (approval) {
      result.set(
        row.id,
        attentionBase({
          state: "awaiting_decision",
          reason: "pending_board_decision",
          severity: "medium",
          stoppedSinceAt: approval.createdAt,
          owner: { type: "board", agentId: null, userId: null, label: "Board" },
          action: {
            label: "Decide approval",
            detail:
              "Approve, reject, or request revision on the linked approval.",
          },
          sourceTask: source,
          approvalId: approval.approvalId,
        }),
      );
      continue;
    }

    const hasMonitor = Boolean(
      row.monitorNextCheckAt && row.monitorNextCheckAt.getTime() > Date.now(),
    );
    const external =
      row.boardPresentationStatus === "blocked" && !hasMonitor
        ? externalWaitFromRequest(row.request)
        : null;
    if (external) {
      result.set(
        row.id,
        attentionBase({
          state: "external_wait",
          reason: "external_owner_action",
          severity: "medium",
          stoppedSinceAt: row.updatedAt,
          owner: { type: "external", agentId: null, userId: null, label: null },
          action: {
            label: "External owner action",
            detail: null,
          },
          sourceTask: source,
          externalDetailsRedacted: true,
        }),
      );
      continue;
    }

    const blockerState = blockerAttention.get(row.id);
    if (
      row.boardPresentationStatus === "blocked" &&
      (blockerState?.state === "needs_attention" ||
        blockerState?.state === "stalled")
    ) {
      result.set(
        row.id,
        attentionBase({
          state: "needs_attention",
          reason: "blocked_chain_stalled",
          severity: "high",
          stoppedSinceAt: row.updatedAt,
          owner: { type: "unknown", agentId: null, userId: null, label: null },
          action: {
            label: "Inspect blocker chain",
            detail:
              "Inspect the stalled blocker or review leaf and make the next owner/action explicit.",
          },
          sourceTask: source,
          sampleTaskIdentifier:
            blockerState.sampleStalledBlockerIdentifier ??
            blockerState.sampleBlockerIdentifier,
        }),
      );
    }
  }

  return result;
}

function taskOwnerAgentFilter(
  ownerAgentId: TaskFilters["ownerAgentId"],
): string | null | undefined {
  if (typeof ownerAgentId === "string" && !isCanonicalUuid(ownerAgentId)) {
    throw unprocessable("ownerAgentId must be an exact canonical UUID");
  }
  return ownerAgentId;
}

async function blockedInboxTaskConditions(
  dbOrTx: any,
  companyId: string,
  filters?: TaskFilters,
) {
  const conditions = [
    eq(tasks.companyId, companyId),
    visibleTaskCondition(),
    notInArray(tasks.boardPresentationStatus, [
      ...BLOCKED_INBOX_TERMINAL_STATUSES,
    ]),
  ];
  const touchedByUserId = filters?.touchedByUserId;
  const inboxArchivedByUserId = filters?.inboxArchivedByUserId;
  const unreadForUserId = filters?.unreadForUserId;
  const contextUserId =
    unreadForUserId ?? touchedByUserId ?? inboxArchivedByUserId;

  if (filters?.descendantOf) {
    conditions.push(sql<boolean>`
      ${tasks.id} IN (
        WITH RECURSIVE descendants(id) AS (
          SELECT ${tasks.id}
          FROM ${tasks}
          WHERE ${tasks.companyId} = ${companyId}
            AND ${tasks.parentId} = ${filters.descendantOf}
          UNION
          SELECT ${tasks.id}
          FROM ${tasks}
          JOIN descendants ON ${tasks.parentId} = descendants.id
          WHERE ${tasks.companyId} = ${companyId}
        )
        SELECT id FROM descendants
      )
    `);
  }
  const lowTrustCondition = lowTrustBoundaryTaskCondition(
    companyId,
    filters?.lowTrustBoundary,
  );
  if (lowTrustCondition) conditions.push(lowTrustCondition);
  const statuses = filters?.status ?? [];
  if (statuses.length > 0) {
    conditions.push(
      statuses.length === 1
        ? eq(tasks.boardPresentationStatus, statuses[0]!)
        : inArray(tasks.boardPresentationStatus, statuses),
    );
  }
  const ownerAgentFilter = taskOwnerAgentFilter(filters?.ownerAgentId);
  if (ownerAgentFilter === null) {
    conditions.push(isNull(tasks.ownerAgentId));
  } else if (ownerAgentFilter) {
    conditions.push(eq(tasks.ownerAgentId, ownerAgentFilter));
  }
  if (filters?.participantAgentId)
    conditions.push(
      participatedByAgentCondition(companyId, filters.participantAgentId),
    );
  if (filters?.ownerUserId)
    conditions.push(eq(tasks.ownerUserId, filters.ownerUserId));
  if (touchedByUserId)
    conditions.push(touchedByUserCondition(companyId, touchedByUserId));
  if (inboxArchivedByUserId)
    conditions.push(
      inboxVisibleForUserCondition(companyId, inboxArchivedByUserId),
    );
  if (unreadForUserId)
    conditions.push(unreadForUserCondition(companyId, unreadForUserId));
  if (filters?.projectId)
    conditions.push(eq(tasks.projectId, filters.projectId));
  if (filters?.parentId) conditions.push(eq(tasks.parentId, filters.parentId));
  if (filters?.originKind)
    conditions.push(eq(tasks.originKind, filters.originKind));
  if (filters?.originId) conditions.push(eq(tasks.originId, filters.originId));
  if (filters?.hasPlanDocument !== undefined) {
    conditions.push(
      hasPlanDocumentCondition(companyId, filters.hasPlanDocument),
    );
  }
  if (!shouldIncludePluginOperationTasks(filters))
    conditions.push(nonPluginOperationTaskCondition());
  if (filters?.labelId) {
    const labeledTaskIds = await dbOrTx
      .select({ taskId: taskLabels.taskId })
      .from(taskLabels)
      .where(
        and(
          eq(taskLabels.companyId, companyId),
          eq(taskLabels.labelId, filters.labelId),
        ),
      );
    if (labeledTaskIds.length === 0)
      return { conditions: [sql<boolean>`false`], contextUserId };
    conditions.push(
      inArray(
        tasks.id,
        labeledTaskIds.map((row: { taskId: string }) => row.taskId),
      ),
    );
  }
  if (
    filters?.excludeRoutineExecutions &&
    !filters?.originKind &&
    !filters?.originId
  ) {
    conditions.push(ne(tasks.originKind, "routine_execution"));
  }

  return { conditions, contextUserId };
}

async function listBlockedInboxTasks(
  dbOrTx: any,
  companyId: string,
  filters?: TaskFilters,
): Promise<
  Array<
    CanonicalTaskWithLabelsAndRun & {
      blockedBy?: TaskRelationTaskSummary[];
      blockerAttention?: TaskBlockerAttention;
      blockedInboxAttention: TaskBlockedInboxAttention;
      liveDescendantCount?: number;
      lastActivityAt: Date;
      myLastTouchAt?: Date | null;
      lastExternalCommentAt?: Date | null;
      isUnreadForMe?: boolean;
    }
  >
> {
  const { conditions, contextUserId } = await blockedInboxTaskConditions(
    dbOrTx,
    companyId,
    filters,
  );

  const rows: CanonicalTaskListRow[] = (
    await dbOrTx
      .select(taskListSelect)
      .from(tasks)
      .where(and(...conditions))
      .orderBy(
        desc(taskCanonicalLastActivityAtExpr(companyId)),
        desc(tasks.updatedAt),
        desc(tasks.id),
      )
  ).map((row: CanonicalTaskListRow) => ({
    ...row,
    request: decodeDatabaseTextPreview(
      row.request,
      TASK_LIST_REQUEST_MAX_CHARS,
    ),
  }));
  const withLabels = await withTaskLabels(dbOrTx, rows);
  const withRuns = withActiveRuns(
    withLabels,
    await activeRunMapForTasks(dbOrTx, withLabels),
  );
  if (withRuns.length === 0) return [];

  const taskIds = withRuns.map((row) => row.id);
  const includeLiveDescendantSummary =
    filters?.includeLiveDescendantSummary === true;
  const [
    statsRows,
    readRows,
    lastActivityRows,
    blockedByMap,
    blockerAttentionByTaskId,
    blockedInboxAttentionByTaskId,
    liveDescendantCountByTaskId,
  ] = await Promise.all([
    contextUserId
      ? userCommentStatsForTasks(dbOrTx, companyId, contextUserId, taskIds)
      : Promise.resolve([]),
    contextUserId
      ? userReadStatsForTasks(dbOrTx, companyId, contextUserId, taskIds)
      : Promise.resolve([]),
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
    for (const taskIdChunk of chunkList(
      taskIds,
      TASK_LIST_RELATED_QUERY_CHUNK_SIZE,
    )) {
      const rows = await dbOrTx
        .select({ taskId: taskComments.taskId })
        .from(taskComments)
        .where(
          and(
            eq(taskComments.companyId, companyId),
            inArray(taskComments.taskId, taskIdChunk),
            sql<boolean>`${taskComments.body} ILIKE ${containsPattern} ESCAPE '\\'`,
          ),
        );
      for (const row of rows as Array<{ taskId: string }>)
        commentSearchMatchTaskIds.add(row.taskId);
    }
  }
  const statsByTaskId = new Map(statsRows.map((row) => [row.taskId, row]));
  const readByTaskId = new Map(
    readRows.map((row) => [row.taskId, row.myLastReadAt]),
  );
  const lastActivityByTaskId = new Map(
    lastActivityRows.map((row) => [row.taskId, row]),
  );

  const enriched = withRuns
    .flatMap((row) => {
      const blockedInboxAttention = blockedInboxAttentionByTaskId.get(row.id);
      if (!blockedInboxAttention) return [];
      if (
        rawSearch &&
        !blockedInboxSearchText(blockedInboxAttention, row).includes(
          rawSearch,
        ) &&
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
                liveDescendantCount:
                  liveDescendantCountByTaskId.get(row.id) ?? 0,
              }
            : {}),
          ...(contextUserId
            ? deriveTaskUserContext(row, contextUserId, {
                myLastCommentAt:
                  statsByTaskId.get(row.id)?.myLastCommentAt ?? null,
                myLastReadAt: readByTaskId.get(row.id) ?? null,
                lastExternalCommentAt:
                  statsByTaskId.get(row.id)?.lastExternalCommentAt ?? null,
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
  return limit === undefined
    ? enriched.slice(offset)
    : enriched.slice(offset, offset + limit);
}

async function countBlockedInboxTasks(
  dbOrTx: any,
  companyId: string,
  filters?: TaskFilters,
): Promise<number> {
  const { conditions } = await blockedInboxTaskConditions(
    dbOrTx,
    companyId,
    filters,
  );
  const rawRows = (await dbOrTx
    .select()
    .from(tasks)
    .where(and(...conditions))) as TaskRow[];
  if (rawRows.length === 0) return 0;
  const rows = await withTaskLabels(dbOrTx, rawRows);

  const blockedInboxAttentionByTaskId = await listTaskBlockedInboxAttentionMap(
    dbOrTx,
    companyId,
    rows,
  );
  const rawSearchInput = filters?.q ?? "";
  const rawSearch = rawSearchInput.toLowerCase();
  const commentSearchMatchTaskIds = new Set<string>();
  if (rawSearchInput) {
    const taskIds = rows.map((row) => row.id);
    const containsPattern = `%${escapeLikePattern(rawSearchInput)}%`;
    for (const taskIdChunk of chunkList(
      taskIds,
      TASK_LIST_RELATED_QUERY_CHUNK_SIZE,
    )) {
      const commentRows = await dbOrTx
        .select({ taskId: taskComments.taskId })
        .from(taskComments)
        .where(
          and(
            eq(taskComments.companyId, companyId),
            inArray(taskComments.taskId, taskIdChunk),
            sql<boolean>`${taskComments.body} ILIKE ${containsPattern} ESCAPE '\\'`,
          ),
        );
      for (const row of commentRows as Array<{ taskId: string }>)
        commentSearchMatchTaskIds.add(row.taskId);
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

export function taskService(db: Db) {
  const instanceSettings = instanceSettingsService(db);

  async function getTaskByUuid(id: string) {
    const row = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, id))
      .then((rows) => rows[0] ?? null);
    if (!row) return null;
    const [enriched] = await withTaskLabels(db, [row]);
    return enriched;
  }

  async function getTaskByCompanyTaskNumber(
    companyId: string,
    taskNumber: number,
  ) {
    if (!isCanonicalUuid(companyId) || !isCanonicalTaskNumber(taskNumber)) {
      return null;
    }
    const rows = await db
      .select()
      .from(tasks)
      .where(
        and(eq(tasks.companyId, companyId), eq(tasks.taskNumber, taskNumber)),
      )
      .limit(2);
    if (rows.length === 0) return null;
    if (rows.length > 1) {
      throw new Error("Task number is not unique within its company");
    }
    const row = rows[0]!;
    const [enriched] = await withTaskLabels(db, [row]);
    return enriched;
  }

  function redactTaskComment<
    T extends {
      body: string;
      authorType: TaskCommentAuthorType;
      presentation?: unknown;
      metadata?: unknown;
    },
  >(
    comment: T,
    censorUsernameInLogs: boolean,
  ): T & {
    presentation: TaskCommentPresentation | null;
    metadata: TaskCommentMetadata | null;
  } {
    return {
      ...comment,
      body: redactCurrentUserText(comment.body, {
        enabled: censorUsernameInLogs,
      }),
      presentation: taskCommentPresentationSchema
        .nullable()
        .catch(null)
        .parse(comment.presentation ?? null),
      metadata: taskCommentMetadataSchema
        .nullable()
        .catch(null)
        .parse(comment.metadata ?? null),
    };
  }

  type TaskCommentRow = typeof taskComments.$inferSelect;
  type BoardAuthorLabels = {
    agents: Map<string, string>;
    users: Map<string, string>;
  };

  async function loadBoardAuthorLabels(
    comments: readonly Pick<TaskCommentRow, "authorAgentId" | "authorUserId">[],
    extraAgentIds: readonly (string | null)[] = [],
  ): Promise<BoardAuthorLabels> {
    const agentIds = [
      ...new Set(
        [
          ...comments.map((comment) => comment.authorAgentId),
          ...extraAgentIds,
        ].filter((value): value is string => Boolean(value)),
      ),
    ];
    const userIds = [
      ...new Set(
        comments
          .map((comment) => comment.authorUserId)
          .filter((value): value is string => Boolean(value)),
      ),
    ];
    const [agentRows, userRows] = await Promise.all([
      agentIds.length > 0
        ? db
            .select({ id: agents.id, name: agents.name })
            .from(agents)
            .where(inArray(agents.id, agentIds))
        : Promise.resolve([]),
      userIds.length > 0
        ? db
            .select({ id: authUsers.id, name: authUsers.name })
            .from(authUsers)
            .where(inArray(authUsers.id, userIds))
        : Promise.resolve([]),
    ]);
    return {
      agents: new Map(agentRows.map((row) => [row.id, row.name])),
      users: new Map(userRows.map((row) => [row.id, row.name])),
    };
  }

  function boardCommentAuthor(
    comment: Pick<
      TaskCommentRow,
      "authorType" | "authorAgentId" | "authorUserId" | "authorPluginKey"
    >,
    labels: BoardAuthorLabels,
  ): BoardTaskCommentAuthor {
    const label =
      comment.authorType === "agent"
        ? (labels.agents.get(comment.authorAgentId ?? "") ?? "Agent")
        : comment.authorType === "user"
          ? (labels.users.get(comment.authorUserId ?? "") ?? "User")
          : comment.authorType === "plugin"
            ? (comment.authorPluginKey ?? "Plugin")
            : "Paperclip";
    return {
      type: comment.authorType,
      label,
      agentId: comment.authorAgentId,
      userId: comment.authorUserId,
      pluginKey: comment.authorPluginKey,
    };
  }

  function boardCommentExcerpt(body: string): string {
    const compact = body.replace(/\s+/g, " ").trim();
    return compact.length <= 120 ? compact : `${compact.slice(0, 119)}…`;
  }

  function boardCommentParentReference(
    parent: TaskCommentRow | null,
    labels: BoardAuthorLabels,
    censorUsernameInLogs: boolean,
    parentRunState: BoardTaskCommentRunState | null = null,
  ): BoardTaskCommentParentReference | null {
    if (!parent) return null;
    const author = boardCommentAuthor(parent, labels);
    const body = redactCurrentUserText(parent.body, {
      enabled: censorUsernameInLogs,
    });
    const derivedBody =
      parent.presentation?.kind === "run_progress" && body.length === 0
        ? parentRunState === "queued"
          ? "Queued…"
          : parentRunState === "working"
            ? "Working…"
            : "Run finished"
        : body;
    return {
      authorLabel: author.label,
      excerpt: boardCommentExcerpt(derivedBody),
    };
  }

  function projectBoardTaskComment(input: {
    comment: TaskCommentRow;
    parent: TaskCommentRow | null;
    labels: BoardAuthorLabels;
    censorUsernameInLogs: boolean;
    runStatus?: TaskExecutionRunStatus | null;
    parentRunStatus?: TaskExecutionRunStatus | null;
  }): BoardTaskComment {
    const redacted = redactTaskComment(
      input.comment,
      input.censorUsernameInLogs,
    );
    return {
      id: redacted.id,
      author: boardCommentAuthor(redacted, input.labels),
      body: redacted.body,
      presentation: redacted.presentation,
      metadata: redacted.metadata,
      sourceTrust: redacted.sourceTrust ?? null,
      runState: boardRunState(input.runStatus),
      canonicalSequence: redacted.projectedEventSeq,
      immediateParentDisplayReference: boardCommentParentReference(
        input.parent,
        input.labels,
        input.censorUsernameInLogs,
        boardRunState(input.parentRunStatus),
      ),
      createdAt: redacted.createdAt,
      updatedAt: redacted.updatedAt,
    };
  }

  function projectBoardRunSegment(input: {
    message: typeof taskSessionMessages.$inferSelect;
    parent: TaskCommentRow;
    labels: BoardAuthorLabels;
    censorUsernameInLogs: boolean;
    parentRunStatus?: TaskExecutionRunStatus | null;
  }): BoardTaskRunSegmentEntry {
    const data =
      input.message.data && typeof input.message.data === "object"
        ? (input.message.data as Record<string, unknown>)
        : {};
    const content = Array.isArray(data.content) ? data.content : [];
    const parts: BoardTaskRunSegmentPart[] = [];
    for (const raw of content) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const part = raw as Record<string, unknown>;
      if (
        (part.type === "text" || part.type === "reasoning") &&
        typeof part.text === "string"
      ) {
        parts.push({
          type: part.type,
          text: redactCurrentUserText(part.text, {
            enabled: input.censorUsernameInLogs,
          }),
        });
        continue;
      }
      if (part.type !== "tool" || typeof part.name !== "string") continue;
      const state =
        part.state &&
        typeof part.state === "object" &&
        !Array.isArray(part.state)
          ? (part.state as Record<string, unknown>)
          : null;
      const status = state?.status;
      if (
        status === "pending" ||
        status === "running" ||
        status === "completed" ||
        status === "error"
      ) {
        parts.push({ type: "tool", name: part.name, status });
      }
    }
    const time =
      data.time && typeof data.time === "object" && !Array.isArray(data.time)
        ? (data.time as Record<string, unknown>)
        : null;
    const complete = typeof time?.completed === "number";
    const hasError = Boolean(data.error) || data.finish === "error";
    const author: BoardTaskCommentAuthor = {
      type: "agent",
      label: input.message.agentId
        ? (input.labels.agents.get(input.message.agentId) ?? "Agent")
        : "Agent",
      agentId: input.message.agentId,
      userId: null,
      pluginKey: null,
    };
    const id = `segment_${createHash("sha256")
      .update(
        `board-run-segment/v1\u0000${input.message.companyId}\u0000${input.message.taskId}\u0000${input.message.id}`,
      )
      .digest("hex")
      .slice(0, 32)}`;
    return {
      kind: "run_segment",
      id,
      author,
      parts,
      status: hasError ? "error" : complete ? "complete" : "working",
      canonicalSequence: input.message.seq,
      immediateParentDisplayReference: boardCommentParentReference(
        input.parent,
        input.labels,
        input.censorUsernameInLogs,
        boardRunState(input.parentRunStatus),
      ),
      createdAt: input.message.timeCreated,
      updatedAt: input.message.timeUpdated,
    };
  }

  async function loadRunStatuses(
    runIds: readonly (string | null)[],
  ): Promise<Map<string, TaskExecutionRunStatus>> {
    const ids = [
      ...new Set(runIds.filter((value): value is string => Boolean(value))),
    ];
    if (ids.length === 0) return new Map();
    const runs = await Promise.all(
      ids.map(async (runId) => {
        const identity = await resolveTaskExecutionRunIdentityById(db, runId);
        if (!identity) return null;
        return readTaskExecutionRun(db, identity);
      }),
    );
    return new Map(
      runs.filter((run) => run !== null).map((run) => [run.runId, run.status]),
    );
  }

  async function loadBoardCommentThreadPage(input: {
    root: TaskCommentRow;
    cursor?: string | null;
    limit?: number | null;
  }): Promise<
    BoardTaskCommentThreadPage & {
      replyCount: number;
      runSegmentCount: number;
    }
  > {
    const { root } = input;
    const limit = boundedBoardCommentPageSize(
      input.limit,
      DEFAULT_BOARD_COMMENT_ENTRY_LIMIT,
    );
    const cursor = decodeBoardCommentCursor(input.cursor, {
      kind: "thread",
      taskId: root.taskId,
      rootCommentId: root.id,
    });
    const sequenceFloor = cursor?.sequence ?? root.projectedEventSeq;
    const descendantConditions = [
      eq(taskComments.companyId, root.companyId),
      eq(taskComments.taskId, root.taskId),
      eq(taskComments.threadRootCommentId, root.id),
      gte(taskComments.projectedEventSeq, sequenceFloor),
    ];
    const messageConditions = root.runId
      ? [
          eq(taskSessionMessages.companyId, root.companyId),
          eq(taskSessionMessages.taskId, root.taskId),
          eq(taskSessionMessages.sessionId, root.sessionId),
          eq(taskSessionMessages.runId, root.runId),
          eq(taskSessionMessages.type, "assistant" as const),
          gte(taskSessionMessages.seq, sequenceFloor),
          sql`${taskSessionMessages.id} is distinct from (
            select source.terminal_session_message_id
            from ${taskCommentProjectionSources} source
            where source.comment_id = ${root.id}
              and source.company_id = ${root.companyId}
              and source.task_id = ${root.taskId}
            limit 1
          )`,
        ]
      : null;

    const [descendantRows, assistantRows, replyCountRow, runSegmentCountRow] =
      await Promise.all([
        db
          .select()
          .from(taskComments)
          .where(and(...descendantConditions))
          .orderBy(asc(taskComments.projectedEventSeq), asc(taskComments.id))
          .limit(limit + 1),
        messageConditions
          ? db
              .select({
                message: taskSessionMessages,
                steeringParentCommentId: sql<string | null>`(
                  select source.comment_id
                  from task_comment_projection_sources source
                  where source.company_id = ${root.companyId}
                    and source.task_id = ${root.taskId}
                    and source.session_id = ${root.sessionId}
                    and source.run_id = ${root.runId}
                    and source.segment_ordinal is not null
                    and source.projected_event_seq <= ${taskSessionMessages.seq}
                  order by source.projected_event_seq desc, source.comment_id desc
                  limit 1
                )`,
              })
              .from(taskSessionMessages)
              .where(and(...messageConditions))
              .orderBy(
                asc(taskSessionMessages.seq),
                asc(taskSessionMessages.id),
              )
              .limit(limit + 1)
          : Promise.resolve([]),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(taskComments)
          .where(
            and(
              eq(taskComments.companyId, root.companyId),
              eq(taskComments.taskId, root.taskId),
              eq(taskComments.threadRootCommentId, root.id),
            ),
          )
          .then((rows) => rows[0] ?? { count: 0 }),
        root.runId
          ? db
              .select({ count: sql<number>`count(*)::int` })
              .from(taskSessionMessages)
              .where(
                and(
                  eq(taskSessionMessages.companyId, root.companyId),
                  eq(taskSessionMessages.taskId, root.taskId),
                  eq(taskSessionMessages.sessionId, root.sessionId),
                  eq(taskSessionMessages.runId, root.runId),
                  eq(taskSessionMessages.type, "assistant" as const),
                  sql`${taskSessionMessages.id} is distinct from (
                    select source.terminal_session_message_id
                    from ${taskCommentProjectionSources} source
                    where source.comment_id = ${root.id}
                      and source.company_id = ${root.companyId}
                      and source.task_id = ${root.taskId}
                    limit 1
                  )`,
                ),
              )
              .then((rows) => rows[0] ?? { count: 0 })
          : Promise.resolve({ count: 0 }),
      ]);

    const parentIds = [
      ...new Set(
        [
          ...descendantRows.map((comment) => comment.replyToCommentId),
          ...assistantRows.map((row) => row.steeringParentCommentId ?? root.id),
        ].filter((value): value is string => Boolean(value)),
      ),
    ];
    const parentRows =
      parentIds.length > 0
        ? await db
            .select()
            .from(taskComments)
            .where(
              and(
                eq(taskComments.companyId, root.companyId),
                eq(taskComments.taskId, root.taskId),
                inArray(taskComments.id, parentIds),
              ),
            )
        : [];
    const parents = new Map(parentRows.map((comment) => [comment.id, comment]));
    const labels = await loadBoardAuthorLabels(
      [...descendantRows, ...parentRows],
      assistantRows.map((row) => row.message.agentId),
    );
    const runStatuses = await loadRunStatuses([
      root.runId,
      ...descendantRows.map((comment) => comment.runId),
      ...parentRows.map((comment) => comment.runId),
    ]);
    const { censorUsernameInLogs } = await instanceSettings.getGeneral();

    const entries: BoardTaskThreadEntry[] = [
      ...descendantRows.map((comment) => ({
        kind: "comment" as const,
        ...projectBoardTaskComment({
          comment,
          parent: comment.replyToCommentId
            ? (parents.get(comment.replyToCommentId) ?? null)
            : null,
          labels,
          censorUsernameInLogs,
          runStatus: comment.runId ? runStatuses.get(comment.runId) : null,
          parentRunStatus: comment.replyToCommentId
            ? runStatuses.get(
                parents.get(comment.replyToCommentId)?.runId ?? "",
              )
            : null,
        }),
      })),
      ...assistantRows.map((row) => {
        const parent =
          parents.get(row.steeringParentCommentId ?? root.id) ?? root;
        return projectBoardRunSegment({
          message: row.message,
          parent,
          labels,
          censorUsernameInLogs,
          parentRunStatus: parent.runId ? runStatuses.get(parent.runId) : null,
        });
      }),
    ]
      .filter((entry) => isAfterBoardCommentCursor(entry, cursor))
      .sort(compareCanonicalEntry);
    const pageEntries = entries.slice(0, limit);
    const finalEntry = pageEntries.at(-1);
    return {
      entries: pageEntries,
      nextCursor:
        entries.length > limit && finalEntry
          ? encodeBoardCommentCursor({
              version: 1,
              kind: "thread",
              taskId: root.taskId,
              rootCommentId: root.id,
              sequence: finalEntry.canonicalSequence,
              id: finalEntry.id,
            })
          : null,
      replyCount: Number(replyCountRow.count),
      runSegmentCount: Number(runSegmentCountRow.count),
    };
  }

  /**
   * Loads the bounded first entry page for every root in one fixed query plan.
   * Per-kind window ranks keep a large thread from consuming another root's
   * allowance; the in-memory merge then applies the closed union's canonical
   * sequence/stable-id order.
   */
  async function loadBoardCommentThreadPages(
    roots: readonly TaskCommentRow[],
    limit: number,
  ): Promise<
    Map<
      string,
      BoardTaskCommentThreadPage & {
        replyCount: number;
        runSegmentCount: number;
      }
    >
  > {
    const pages = new Map<
      string,
      BoardTaskCommentThreadPage & {
        replyCount: number;
        runSegmentCount: number;
      }
    >();
    if (roots.length === 0) return pages;

    const rootIds = roots.map((root) => root.id);
    const rootIdSql = sql.join(
      rootIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    );
    type RankedCommentIdentity = {
      rootCommentId: string;
      sourceId: string;
      totalCount: number | string;
    };
    type RankedSegmentIdentity = RankedCommentIdentity & {
      steeringParentCommentId: string | null;
    };
    const [commentIdentityResult, segmentIdentityResult] = await Promise.all([
      db.execute(sql<RankedCommentIdentity>`
        select
          ranked.root_comment_id as "rootCommentId",
          ranked.source_id as "sourceId",
          ranked.total_count as "totalCount"
        from (
          select
            comment_entry.thread_root_comment_id as root_comment_id,
            comment_entry.id as source_id,
            count(*) over (
              partition by comment_entry.thread_root_comment_id
            ) as total_count,
            row_number() over (
              partition by comment_entry.thread_root_comment_id
              order by comment_entry.projected_event_seq asc, comment_entry.id asc
            ) as entry_rank
          from ${taskComments} comment_entry
          where comment_entry.company_id = ${roots[0]!.companyId}
            and comment_entry.task_id = ${roots[0]!.taskId}
            and comment_entry.thread_root_comment_id in (${rootIdSql})
        ) ranked
        where ranked.entry_rank <= ${limit + 1}
        order by ranked.root_comment_id asc, ranked.entry_rank asc
      `),
      db.execute(sql<RankedSegmentIdentity>`
        select
          ranked.root_comment_id as "rootCommentId",
          ranked.source_id as "sourceId",
          ranked.steering_parent_comment_id as "steeringParentCommentId",
          ranked.total_count as "totalCount"
        from (
          select
            root_comment.id as root_comment_id,
            message_entry.id as source_id,
            (
              select source.comment_id
              from ${taskCommentProjectionSources} source
              where source.company_id = root_comment.company_id
                and source.task_id = root_comment.task_id
                and source.session_id = root_comment.session_id
                and source.run_id = root_comment.run_id
                and source.segment_ordinal is not null
                and source.projected_event_seq <= message_entry.seq
              order by source.projected_event_seq desc, source.comment_id desc
              limit 1
            ) as steering_parent_comment_id,
            count(*) over (partition by root_comment.id) as total_count,
            row_number() over (
              partition by root_comment.id
              order by message_entry.seq asc, message_entry.id asc
            ) as entry_rank
          from ${taskComments} root_comment
          inner join ${taskCommentProjectionSources} root_source
            on root_source.comment_id = root_comment.id
           and root_source.company_id = root_comment.company_id
           and root_source.task_id = root_comment.task_id
          inner join ${taskSessionMessages} message_entry
            on message_entry.company_id = root_comment.company_id
           and message_entry.task_id = root_comment.task_id
           and message_entry.session_id = root_comment.session_id
           and message_entry.run_id = root_comment.run_id
           and message_entry.type = 'assistant'
           and message_entry.id is distinct from root_source.terminal_session_message_id
          where root_comment.company_id = ${roots[0]!.companyId}
            and root_comment.task_id = ${roots[0]!.taskId}
            and root_comment.id in (${rootIdSql})
            and root_comment.run_id is not null
        ) ranked
        where ranked.entry_rank <= ${limit + 1}
        order by ranked.root_comment_id asc, ranked.entry_rank asc
      `),
    ]);
    const commentIdentities = Array.from(
      commentIdentityResult,
    ) as RankedCommentIdentity[];
    const segmentIdentities = Array.from(
      segmentIdentityResult,
    ) as RankedSegmentIdentity[];
    const commentIds = commentIdentities.map((row) => row.sourceId);
    const messageIds = segmentIdentities.map((row) => row.sourceId);
    const [descendantRows, assistantMessages] = await Promise.all([
      commentIds.length > 0
        ? db
            .select()
            .from(taskComments)
            .where(
              and(
                eq(taskComments.companyId, roots[0]!.companyId),
                eq(taskComments.taskId, roots[0]!.taskId),
                inArray(taskComments.id, commentIds),
              ),
            )
        : Promise.resolve([]),
      messageIds.length > 0
        ? db
            .select()
            .from(taskSessionMessages)
            .where(
              and(
                eq(taskSessionMessages.companyId, roots[0]!.companyId),
                eq(taskSessionMessages.taskId, roots[0]!.taskId),
                inArray(taskSessionMessages.id, messageIds),
              ),
            )
        : Promise.resolve([]),
    ]);
    const descendantsById = new Map(descendantRows.map((row) => [row.id, row]));
    const messagesById = new Map(assistantMessages.map((row) => [row.id, row]));
    const rootsById = new Map(roots.map((root) => [root.id, root]));
    const segmentIdentityByMessageId = new Map(
      segmentIdentities.map((row) => [row.sourceId, row]),
    );
    const parentIds = [
      ...new Set(
        [
          ...descendantRows.map((comment) => comment.replyToCommentId),
          ...segmentIdentities.map(
            (row) => row.steeringParentCommentId ?? row.rootCommentId,
          ),
        ].filter((value): value is string => Boolean(value)),
      ),
    ];
    const missingParentIds = parentIds.filter((id) => !rootsById.has(id));
    const parentRows =
      missingParentIds.length > 0
        ? await db
            .select()
            .from(taskComments)
            .where(
              and(
                eq(taskComments.companyId, roots[0]!.companyId),
                eq(taskComments.taskId, roots[0]!.taskId),
                inArray(taskComments.id, missingParentIds),
              ),
            )
        : [];
    const parents = new Map([
      ...roots.map((root) => [root.id, root] as const),
      ...parentRows.map((parent) => [parent.id, parent] as const),
    ]);
    const [labels, runStatuses, general] = await Promise.all([
      loadBoardAuthorLabels(
        [...roots, ...descendantRows, ...parentRows],
        assistantMessages.map((message) => message.agentId),
      ),
      loadRunStatuses([
        ...roots.map((root) => root.runId),
        ...descendantRows.map((comment) => comment.runId),
        ...parentRows.map((comment) => comment.runId),
      ]),
      instanceSettings.getGeneral(),
    ]);

    const commentsByRoot = new Map<string, TaskCommentRow[]>();
    for (const identity of commentIdentities) {
      const comment = descendantsById.get(identity.sourceId);
      if (!comment) continue;
      const entries = commentsByRoot.get(identity.rootCommentId) ?? [];
      entries.push(comment);
      commentsByRoot.set(identity.rootCommentId, entries);
    }
    const messagesByRoot = new Map<string, typeof assistantMessages>();
    for (const identity of segmentIdentities) {
      const message = messagesById.get(identity.sourceId);
      if (!message) continue;
      const entries = messagesByRoot.get(identity.rootCommentId) ?? [];
      entries.push(message);
      messagesByRoot.set(identity.rootCommentId, entries);
    }
    const countValue = (value: number | string | undefined): number => {
      const count = typeof value === "number" ? value : Number(value ?? 0);
      return Number.isSafeInteger(count) && count >= 0 ? count : 0;
    };
    for (const root of roots) {
      const commentEntries = (commentsByRoot.get(root.id) ?? []).map(
        (comment) => ({
          kind: "comment" as const,
          ...projectBoardTaskComment({
            comment,
            parent: comment.replyToCommentId
              ? (parents.get(comment.replyToCommentId) ?? null)
              : null,
            labels,
            censorUsernameInLogs: general.censorUsernameInLogs,
            runStatus: comment.runId ? runStatuses.get(comment.runId) : null,
            parentRunStatus: comment.replyToCommentId
              ? runStatuses.get(
                  parents.get(comment.replyToCommentId)?.runId ?? "",
                )
              : null,
          }),
        }),
      );
      const segmentEntries = (messagesByRoot.get(root.id) ?? []).map(
        (message) => {
          const identity = segmentIdentityByMessageId.get(message.id);
          const parent =
            parents.get(identity?.steeringParentCommentId ?? root.id) ?? root;
          return projectBoardRunSegment({
            message,
            parent,
            labels,
            censorUsernameInLogs: general.censorUsernameInLogs,
            parentRunStatus: parent.runId
              ? runStatuses.get(parent.runId)
              : null,
          });
        },
      );
      const merged = [...commentEntries, ...segmentEntries].sort(
        compareCanonicalEntry,
      );
      const entries = merged.slice(0, limit);
      const finalEntry = entries.at(-1);
      pages.set(root.id, {
        entries,
        nextCursor:
          merged.length > limit && finalEntry
            ? encodeBoardCommentCursor({
                version: 1,
                kind: "thread",
                taskId: root.taskId,
                rootCommentId: root.id,
                sequence: finalEntry.canonicalSequence,
                id: finalEntry.id,
              })
            : null,
        replyCount: countValue(
          commentIdentities.find((row) => row.rootCommentId === root.id)
            ?.totalCount,
        ),
        runSegmentCount: countValue(
          segmentIdentities.find((row) => row.rootCommentId === root.id)
            ?.totalCount,
        ),
      });
    }
    return pages;
  }

  async function getBoardCommentProjection(input: {
    companyId: string;
    taskId: string;
    commentId: string;
  }): Promise<BoardTaskComment | null> {
    if (
      !isCanonicalUuid(input.companyId) ||
      !isCanonicalUuid(input.taskId) ||
      !isCanonicalUuid(input.commentId)
    ) {
      return null;
    }
    const comment = await db
      .select()
      .from(taskComments)
      .where(
        and(
          eq(taskComments.companyId, input.companyId),
          eq(taskComments.taskId, input.taskId),
          eq(taskComments.id, input.commentId),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!comment) return null;
    const parent = comment.replyToCommentId
      ? await db
          .select()
          .from(taskComments)
          .where(
            and(
              eq(taskComments.companyId, input.companyId),
              eq(taskComments.taskId, input.taskId),
              eq(taskComments.id, comment.replyToCommentId),
            ),
          )
          .then((rows) => rows[0] ?? null)
      : null;
    const [labels, runStatuses, general] = await Promise.all([
      loadBoardAuthorLabels(parent ? [comment, parent] : [comment]),
      loadRunStatuses([comment.runId, parent?.runId ?? null]),
      instanceSettings.getGeneral(),
    ]);
    return projectBoardTaskComment({
      comment,
      parent,
      labels,
      censorUsernameInLogs: general.censorUsernameInLogs,
      runStatus: comment.runId ? runStatuses.get(comment.runId) : null,
      parentRunStatus: parent?.runId ? runStatuses.get(parent.runId) : null,
    });
  }

  async function assertValidLabelIds(
    companyId: string,
    labelIds: string[],
    dbOrTx: any = db,
  ) {
    if (labelIds.length === 0) return;
    const existing = await dbOrTx
      .select({ id: labels.id })
      .from(labels)
      .where(
        and(eq(labels.companyId, companyId), inArray(labels.id, labelIds)),
      );
    if (existing.length !== new Set(labelIds).size) {
      throw unprocessable("One or more labels are invalid for this company");
    }
  }

  async function syncTaskLabels(
    taskId: string,
    companyId: string,
    labelIds: string[],
    dbOrTx: any = db,
  ) {
    const deduped = [...new Set(labelIds)];
    await assertValidLabelIds(companyId, deduped, dbOrTx);
    await dbOrTx.delete(taskLabels).where(eq(taskLabels.taskId, taskId));
    if (deduped.length === 0) return;
    await dbOrTx.insert(taskLabels).values(
      deduped.map((labelId) => ({
        taskId,
        labelId,
        companyId,
      })),
    );
  }

  async function getTaskRelationSummaryMap(
    companyId: string,
    taskIds: string[],
    dbOrTx: DbReader = db,
  ): Promise<Map<string, TaskRelationSummaryMap>> {
    const uniqueTaskIds = [...new Set(taskIds)];
    const empty = new Map<string, TaskRelationSummaryMap>();
    for (const taskId of uniqueTaskIds) {
      empty.set(taskId, { blockedBy: [], blocks: [] });
    }
    if (uniqueTaskIds.length === 0) return empty;

    const [blockedByRows, blockingRows] = await Promise.all([
      dbOrTx
        .select({
          currentTaskId: taskRelations.relatedTaskId,
          relatedId: tasks.id,
          taskNumber: tasks.taskNumber,
          identifier: tasks.identifier,
          title: tasks.title,
          boardPresentationStatus: tasks.boardPresentationStatus,
          priority: tasks.priority,
          ownerAgentId: tasks.ownerAgentId,
          ownerUserId: tasks.ownerUserId,
        })
        .from(taskRelations)
        .innerJoin(tasks, eq(taskRelations.taskId, tasks.id))
        .where(
          and(
            eq(taskRelations.companyId, companyId),
            eq(taskRelations.type, "blocks"),
            inArray(taskRelations.relatedTaskId, uniqueTaskIds),
          ),
        ),
      dbOrTx
        .select({
          currentTaskId: taskRelations.taskId,
          relatedId: tasks.id,
          taskNumber: tasks.taskNumber,
          identifier: tasks.identifier,
          title: tasks.title,
          boardPresentationStatus: tasks.boardPresentationStatus,
          priority: tasks.priority,
          ownerAgentId: tasks.ownerAgentId,
          ownerUserId: tasks.ownerUserId,
        })
        .from(taskRelations)
        .innerJoin(tasks, eq(taskRelations.relatedTaskId, tasks.id))
        .where(
          and(
            eq(taskRelations.companyId, companyId),
            eq(taskRelations.type, "blocks"),
            inArray(taskRelations.taskId, uniqueTaskIds),
          ),
        ),
    ]);

    for (const row of blockedByRows) {
      empty
        .get(row.currentTaskId)
        ?.blockedBy.push(summarizeTaskRelationRow(row));
    }
    for (const row of blockingRows) {
      empty.get(row.currentTaskId)?.blocks.push(summarizeTaskRelationRow(row));
    }

    const terminalByRoot = await terminalExplicitBlockersByRoot(
      companyId,
      [...empty.values()].flatMap((relations) => relations.blockedBy),
      dbOrTx,
    );

    for (const relations of empty.values()) {
      relations.blockedBy.sort((a, b) =>
        taskRelationSortLabel(a).localeCompare(taskRelationSortLabel(b)),
      );
      for (const blocker of relations.blockedBy) {
        const terminalBlockers = terminalByRoot.get(blocker.id);
        if (terminalBlockers && terminalBlockers.length > 0) {
          blocker.terminalBlockers = terminalBlockers;
        }
      }
      relations.blocks.sort((a, b) =>
        taskRelationSortLabel(a).localeCompare(taskRelationSortLabel(b)),
      );
    }

    return empty;
  }

  async function assertNoBlockingCycles(
    companyId: string,
    taskId: string,
    blockerTaskIds: string[],
    dbOrTx: DbReader = db,
  ) {
    if (blockerTaskIds.length === 0) return;

    const rows = await dbOrTx
      .select({
        blockerTaskId: taskRelations.taskId,
        blockedTaskId: taskRelations.relatedTaskId,
      })
      .from(taskRelations)
      .where(
        and(
          eq(taskRelations.companyId, companyId),
          eq(taskRelations.type, "blocks"),
        ),
      );

    const adjacency = new Map<string, string[]>();
    for (const row of rows) {
      const list = adjacency.get(row.blockerTaskId) ?? [];
      list.push(row.blockedTaskId);
      adjacency.set(row.blockerTaskId, list);
    }

    for (const blockerTaskId of blockerTaskIds) {
      const queue = [...(adjacency.get(taskId) ?? [])];
      const visited = new Set<string>([taskId]);
      while (queue.length > 0) {
        const current = queue.shift()!;
        if (current === blockerTaskId) {
          throw unprocessable("Blocking relations cannot contain cycles");
        }
        if (visited.has(current)) continue;
        visited.add(current);
        queue.push(...(adjacency.get(current) ?? []));
      }
    }
  }

  async function syncBlockedByTaskIds(
    taskId: string,
    companyId: string,
    blockedByTaskIds: string[],
    actor: { agentId?: string | null; userId?: string | null } = {},
    dbOrTx: any = db,
  ) {
    const deduped = [...new Set(blockedByTaskIds)];
    if (deduped.some((candidate) => candidate === taskId)) {
      throw unprocessable("Task cannot be blocked by itself");
    }

    if (deduped.length > 0) {
      const lockedTaskIds = [taskId, ...deduped].sort();
      await dbOrTx.execute(
        sql`SELECT ${tasks.id} FROM ${tasks}
            WHERE ${and(eq(tasks.companyId, companyId), inArray(tasks.id, lockedTaskIds))}
            ORDER BY ${tasks.id}
            FOR UPDATE`,
      );
      const relatedTasks = await dbOrTx
        .select({ id: tasks.id })
        .from(tasks)
        .where(and(eq(tasks.companyId, companyId), inArray(tasks.id, deduped)));
      if (relatedTasks.length !== deduped.length) {
        throw unprocessable("Blocked-by tasks must belong to the same company");
      }
      await assertNoBlockingCycles(companyId, taskId, deduped, dbOrTx);
    }

    await dbOrTx
      .delete(taskRelations)
      .where(
        and(
          eq(taskRelations.companyId, companyId),
          eq(taskRelations.relatedTaskId, taskId),
          eq(taskRelations.type, "blocks"),
        ),
      );

    if (deduped.length === 0) return;

    await dbOrTx.insert(taskRelations).values(
      deduped.map((blockerTaskId) => ({
        companyId,
        taskId: blockerTaskId,
        relatedTaskId: taskId,
        type: "blocks",
        createdByAgentId: actor.agentId ?? null,
        createdByUserId: actor.userId ?? null,
      })),
    );
  }

  return {
    list: async (companyId: string, filters?: TaskFilters) => {
      if (filters?.attention === "blocked") {
        return listBlockedInboxTasks(db, companyId, {
          ...filters,
          includeBlockedBy: true,
          includeBlockedInboxAttention: true,
        });
      }

      const conditions = [
        eq(tasks.companyId, companyId),
        visibleTaskCondition(),
      ];
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
      const contextUserId =
        unreadForUserId ?? touchedByUserId ?? inboxArchivedByUserId;
      const includeBlockedBy = filters?.includeBlockedBy === true;
      const includeBlockedInboxAttention =
        filters?.includeBlockedInboxAttention === true;
      const includeLiveDescendantSummary =
        filters?.includeLiveDescendantSummary === true;
      const rawSearch = filters?.q ?? "";
      const hasSearch = rawSearch.length > 0;
      const escapedSearch = hasSearch ? escapeLikePattern(rawSearch) : "";
      const startsWithPattern = `${escapedSearch}%`;
      const containsPattern = `%${escapedSearch}%`;
      const titleStartsWithMatch = sql<boolean>`${tasks.title} ILIKE ${startsWithPattern} ESCAPE '\\'`;
      const titleContainsMatch = sql<boolean>`${tasks.title} ILIKE ${containsPattern} ESCAPE '\\'`;
      const identifierStartsWithMatch = sql<boolean>`${tasks.identifier} ILIKE ${startsWithPattern} ESCAPE '\\'`;
      const identifierContainsMatch = sql<boolean>`${tasks.identifier} ILIKE ${containsPattern} ESCAPE '\\'`;
      const requestContainsMatch = sql<boolean>`${tasks.request} ILIKE ${containsPattern} ESCAPE '\\'`;
      const commentContainsMatch = sql<boolean>`
        EXISTS (
          SELECT 1
          FROM ${taskComments}
          WHERE ${taskComments.taskId} = ${tasks.id}
            AND ${taskComments.companyId} = ${companyId}
            AND ${taskComments.body} ILIKE ${containsPattern} ESCAPE '\\'
        )
      `;
      if (filters?.descendantOf) {
        conditions.push(sql<boolean>`
          ${tasks.id} IN (
            WITH RECURSIVE descendants(id) AS (
              SELECT ${tasks.id}
              FROM ${tasks}
              WHERE ${tasks.companyId} = ${companyId}
                AND ${tasks.parentId} = ${filters.descendantOf}
              UNION
              SELECT ${tasks.id}
              FROM ${tasks}
              JOIN descendants ON ${tasks.parentId} = descendants.id
              WHERE ${tasks.companyId} = ${companyId}
            )
            SELECT id FROM descendants
          )
        `);
      }
      const lowTrustCondition = lowTrustBoundaryTaskCondition(
        companyId,
        filters?.lowTrustBoundary,
      );
      if (lowTrustCondition) conditions.push(lowTrustCondition);
      const statuses = filters?.status ?? [];
      if (statuses.length === 1) {
        conditions.push(eq(tasks.boardPresentationStatus, statuses[0]));
      } else if (statuses.length > 1) {
        conditions.push(inArray(tasks.boardPresentationStatus, statuses));
      }
      if (ownerAgentFilter === null) {
        conditions.push(isNull(tasks.ownerAgentId));
      } else if (ownerAgentFilter) {
        conditions.push(eq(tasks.ownerAgentId, ownerAgentFilter));
      }
      if (filters?.participantAgentId) {
        conditions.push(
          participatedByAgentCondition(companyId, filters.participantAgentId),
        );
      }
      if (filters?.ownerUserId) {
        conditions.push(eq(tasks.ownerUserId, filters.ownerUserId));
      }
      if (touchedByUserId) {
        conditions.push(touchedByUserCondition(companyId, touchedByUserId));
      }
      if (inboxArchivedByUserId) {
        conditions.push(
          inboxVisibleForUserCondition(companyId, inboxArchivedByUserId),
        );
      }
      if (unreadForUserId) {
        conditions.push(unreadForUserCondition(companyId, unreadForUserId));
      }
      if (filters?.projectId)
        conditions.push(eq(tasks.projectId, filters.projectId));
      if (filters?.parentId)
        conditions.push(eq(tasks.parentId, filters.parentId));
      if (filters?.originKind)
        conditions.push(eq(tasks.originKind, filters.originKind));
      if (filters?.originId)
        conditions.push(eq(tasks.originId, filters.originId));
      if (filters?.hasPlanDocument !== undefined) {
        conditions.push(
          hasPlanDocumentCondition(companyId, filters.hasPlanDocument),
        );
      }
      if (!shouldIncludePluginOperationTasks(filters)) {
        conditions.push(nonPluginOperationTaskCondition());
      }
      if (filters?.labelId) {
        const labeledTaskIds = await db
          .select({ taskId: taskLabels.taskId })
          .from(taskLabels)
          .where(
            and(
              eq(taskLabels.companyId, companyId),
              eq(taskLabels.labelId, filters.labelId),
            ),
          );
        if (labeledTaskIds.length === 0) return [];
        conditions.push(
          inArray(
            tasks.id,
            labeledTaskIds.map((row) => row.taskId),
          ),
        );
      }
      if (hasSearch) {
        conditions.push(
          or(
            titleContainsMatch,
            identifierContainsMatch,
            requestContainsMatch,
            commentContainsMatch,
          )!,
        );
      }
      if (
        filters?.excludeRoutineExecutions &&
        !filters?.originKind &&
        !filters?.originId
      ) {
        conditions.push(ne(tasks.originKind, "routine_execution"));
      }
      const priorityOrder = sql`CASE ${tasks.priority} WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END`;
      const searchOrder = sql<number>`
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
        .from(tasks)
        .where(and(...conditions))
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
        request: decodeDatabaseTextPreview(
          row.request,
          TASK_LIST_REQUEST_MAX_CHARS,
        ),
      }));
      const withLabels = await withTaskLabels(db, rows);
      const runMap = await activeRunMapForTasks(db, withLabels);
      const withRuns = withActiveRuns(withLabels, runMap);
      if (withRuns.length === 0) {
        return withRuns;
      }

      const taskIds = withRuns.map((row) => row.id);
      const [
        statsRows,
        readRows,
        lastActivityRows,
        archiveRows,
        blockedByMap,
        liveDescendantCountByTaskId,
      ] = await Promise.all([
        contextUserId
          ? userCommentStatsForTasks(db, companyId, contextUserId, taskIds)
          : Promise.resolve([]),
        contextUserId
          ? userReadStatsForTasks(db, companyId, contextUserId, taskIds)
          : Promise.resolve([]),
        lastActivityStatsForTasks(db, companyId, taskIds),
        contextUserId
          ? inboxArchiveRowsForTasks(db, companyId, contextUserId, taskIds)
          : Promise.resolve([]),
        includeBlockedBy
          ? blockedByMapForTasks(db, companyId, taskIds)
          : Promise.resolve(new Map<string, TaskRelationTaskSummary[]>()),
        includeLiveDescendantSummary
          ? liveDescendantCountMapForTasks(db, companyId, taskIds)
          : Promise.resolve(new Map<string, number>()),
      ]);
      const statsByTaskId = new Map(statsRows.map((row) => [row.taskId, row]));
      const lastActivityByTaskId = new Map(
        lastActivityRows.map((row) => [row.taskId, row]),
      );
      const archiveByTaskId = new Map(
        archiveRows.map((row) => [row.taskId, row]),
      );
      const [blockerAttentionByTaskId, blockedInboxAttentionByTaskId] =
        await Promise.all([
          listTaskBlockerAttentionMap(db, companyId, withRuns),
          includeBlockedInboxAttention
            ? listTaskBlockedInboxAttentionMap(db, companyId, withRuns)
            : Promise.resolve(new Map<string, TaskBlockedInboxAttention>()),
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
            ...(includeBlockedBy
              ? { blockedBy: blockedByMap.get(row.id) ?? [] }
              : {}),
            lastActivityAt,
            ...(blockerAttentionByTaskId.has(row.id)
              ? { blockerAttention: blockerAttentionByTaskId.get(row.id) }
              : {}),
            ...(includeBlockedInboxAttention
              ? {
                  blockedInboxAttention:
                    blockedInboxAttentionByTaskId.get(row.id) ?? null,
                }
              : {}),
            ...(includeLiveDescendantSummary
              ? {
                  liveDescendantCount:
                    liveDescendantCountByTaskId.get(row.id) ?? 0,
                }
              : {}),
          };
        });
      }

      const readByTaskId = new Map(
        readRows.map((row) => [row.taskId, row.myLastReadAt]),
      );

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
          ...activeInboxArchiveFields(
            archiveByTaskId.get(row.id),
            lastActivityAt,
          ),
          ...(includeBlockedBy
            ? { blockedBy: blockedByMap.get(row.id) ?? [] }
            : {}),
          lastActivityAt,
          ...(blockerAttentionByTaskId.has(row.id)
            ? { blockerAttention: blockerAttentionByTaskId.get(row.id) }
            : {}),
          ...(includeBlockedInboxAttention
            ? {
                blockedInboxAttention:
                  blockedInboxAttentionByTaskId.get(row.id) ?? null,
              }
            : {}),
          ...(includeLiveDescendantSummary
            ? {
                liveDescendantCount:
                  liveDescendantCountByTaskId.get(row.id) ?? 0,
              }
            : {}),
          ...deriveTaskUserContext(row, contextUserId, {
            myLastCommentAt: statsByTaskId.get(row.id)?.myLastCommentAt ?? null,
            myLastReadAt: readByTaskId.get(row.id) ?? null,
            lastExternalCommentAt:
              statsByTaskId.get(row.id)?.lastExternalCommentAt ?? null,
          }),
        };
      });
    },

    count: async (companyId: string, filters?: TaskFilters) => {
      if (filters?.attention === "blocked") {
        return countBlockedInboxTasks(db, companyId, filters);
      }

      const conditions = [
        eq(tasks.companyId, companyId),
        visibleTaskCondition(),
      ];
      const statuses = filters?.status ?? [];
      if (statuses.length === 1)
        conditions.push(eq(tasks.boardPresentationStatus, statuses[0]!));
      else if (statuses.length > 1)
        conditions.push(inArray(tasks.boardPresentationStatus, statuses));
      const ownerAgentFilter = taskOwnerAgentFilter(filters?.ownerAgentId);
      if (ownerAgentFilter === null) {
        conditions.push(isNull(tasks.ownerAgentId));
      } else if (ownerAgentFilter) {
        conditions.push(eq(tasks.ownerAgentId, ownerAgentFilter));
      }
      if (filters?.ownerUserId)
        conditions.push(eq(tasks.ownerUserId, filters.ownerUserId));
      if (filters?.projectId)
        conditions.push(eq(tasks.projectId, filters.projectId));
      if (filters?.parentId)
        conditions.push(eq(tasks.parentId, filters.parentId));
      if (filters?.originKind)
        conditions.push(eq(tasks.originKind, filters.originKind));
      if (filters?.originId)
        conditions.push(eq(tasks.originId, filters.originId));
      if (filters?.hasPlanDocument !== undefined) {
        conditions.push(
          hasPlanDocumentCondition(companyId, filters.hasPlanDocument),
        );
      }
      if (!shouldIncludePluginOperationTasks(filters))
        conditions.push(nonPluginOperationTaskCondition());
      const [row] = await db
        .select({ count: sql<number>`count(*)` })
        .from(tasks)
        .where(and(...conditions));
      return Number(row?.count ?? 0);
    },

    markRead: async (
      companyId: string,
      taskId: string,
      userId: string,
      readAt: Date = new Date(),
    ) => {
      const now = new Date();
      const [row] = await db
        .insert(taskReadStates)
        .values({
          companyId,
          taskId,
          userId,
          lastReadAt: readAt,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            taskReadStates.companyId,
            taskReadStates.taskId,
            taskReadStates.userId,
          ],
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
        .delete(taskReadStates)
        .where(
          and(
            eq(taskReadStates.companyId, companyId),
            eq(taskReadStates.taskId, taskId),
            eq(taskReadStates.userId, userId),
          ),
        )
        .returning();
      return deleted.length > 0;
    },

    archiveInbox: async (
      companyId: string,
      taskId: string,
      userId: string,
      archivedAt: Date = new Date(),
      attribution?: {
        archivedByActorType: "user" | "agent";
        archivedByAgentId?: string | null;
        archivedByRunId?: string | null;
      },
    ) => {
      const now = new Date();
      const [row] = await db
        .insert(taskInboxArchives)
        .values({
          companyId,
          taskId,
          userId,
          archivedByActorType: attribution?.archivedByActorType ?? "user",
          archivedByAgentId: attribution?.archivedByAgentId ?? null,
          archivedByRunId: attribution?.archivedByRunId ?? null,
          archivedAt,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            taskInboxArchives.companyId,
            taskInboxArchives.taskId,
            taskInboxArchives.userId,
          ],
          set: {
            archivedAt,
            archivedByActorType: attribution?.archivedByActorType ?? "user",
            archivedByAgentId: attribution?.archivedByAgentId ?? null,
            archivedByRunId: attribution?.archivedByRunId ?? null,
            updatedAt: now,
          },
        })
        .returning();
      return row;
    },

    unarchiveInbox: async (
      companyId: string,
      taskId: string,
      userId: string,
    ) => {
      const [row] = await db
        .delete(taskInboxArchives)
        .where(
          and(
            eq(taskInboxArchives.companyId, companyId),
            eq(taskInboxArchives.taskId, taskId),
            eq(taskInboxArchives.userId, userId),
          ),
        )
        .returning();
      return row ?? null;
    },

    getActiveInboxArchiveFields: async (
      task: Pick<TaskRow, "id" | "companyId" | "updatedAt">,
      userId: string,
    ) => {
      const [[activity], [archive]] = await Promise.all([
        lastActivityStatsForTasks(db, task.companyId, [task.id]),
        inboxArchiveRowsForTasks(db, task.companyId, userId, [task.id]),
      ]);
      const lastActivityAt =
        latestTaskActivityAt(
          task.updatedAt,
          activity?.latestCommentAt ?? null,
          activity?.latestLogAt ?? null,
        ) ?? task.updatedAt;
      return activeInboxArchiveFields(archive, lastActivityAt);
    },

    getById: async (id: string) =>
      isCanonicalUuid(id) ? getTaskByUuid(id) : null,

    getByCompanyTaskNumber: getTaskByCompanyTaskNumber,

    getRelationSummaries: async (taskId: string) => {
      const task = await db
        .select({ id: tasks.id, companyId: tasks.companyId })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .then((rows) => rows[0] ?? null);
      if (!task) throw notFound("Task not found");
      const relations = await getTaskRelationSummaryMap(
        task.companyId,
        [taskId],
        db,
      );
      return relations.get(taskId) ?? { blockedBy: [], blocks: [] };
    },

    getBlockerDiagnostics: async (
      taskId: string,
      maxBlockers = TASK_BLOCKER_DIAGNOSTICS_MAX_BLOCKERS,
    ) => {
      const task = await db
        .select({ id: tasks.id, companyId: tasks.companyId })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .then((rows) => rows[0] ?? null);
      if (!task) throw notFound("Task not found");

      const cappedMax = Math.max(
        0,
        Math.min(maxBlockers, TASK_BLOCKER_DIAGNOSTICS_MAX_BLOCKERS),
      );
      const blockerRows = await db
        .select({
          id: tasks.id,
          companyId: tasks.companyId,
          projectId: tasks.projectId,
          parentId: tasks.parentId,
          taskNumber: tasks.taskNumber,
          identifier: tasks.identifier,
          title: tasks.title,
          boardPresentationStatus: tasks.boardPresentationStatus,
          priority: tasks.priority,
          ownerAgentId: tasks.ownerAgentId,
          ownerUserId: tasks.ownerUserId,
        })
        .from(taskRelations)
        .innerJoin(tasks, eq(taskRelations.taskId, tasks.id))
        .where(
          and(
            eq(taskRelations.companyId, task.companyId),
            eq(taskRelations.type, "blocks"),
            eq(taskRelations.relatedTaskId, task.id),
            eq(tasks.companyId, task.companyId),
          ),
        )
        .orderBy(asc(tasks.title), asc(tasks.id))
        .limit(cappedMax + 1);

      const readiness = await listTaskDependencyReadinessMap(
        db,
        task.companyId,
        [task.id],
      );

      return {
        blockers: blockerRows.slice(
          0,
          cappedMax,
        ) as TaskBlockerDiagnosticsTaskRow[],
        readiness:
          readiness.get(task.id) ?? createTaskDependencyReadiness(task.id),
        truncated: blockerRows.length > cappedMax,
      };
    },

    getSubtreeDiagnostics: async (
      taskId: string,
      opts?: {
        maxDepth?: number;
        maxNodes?: number;
        maxBlockersPerNode?: number;
      },
    ) => {
      const task = await db
        .select({ id: tasks.id, companyId: tasks.companyId })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .then((rows) => rows[0] ?? null);
      if (!task) throw notFound("Task not found");

      const maxDepth = Math.max(
        0,
        Math.min(
          opts?.maxDepth ?? TASK_SUBTREE_DIAGNOSTICS_MAX_DEPTH,
          TASK_SUBTREE_DIAGNOSTICS_MAX_DEPTH,
        ),
      );
      const maxNodes = Math.max(
        1,
        Math.min(
          opts?.maxNodes ?? TASK_SUBTREE_DIAGNOSTICS_MAX_NODES,
          TASK_SUBTREE_DIAGNOSTICS_MAX_NODES,
        ),
      );
      const maxBlockersPerNode = Math.max(
        0,
        Math.min(
          opts?.maxBlockersPerNode ??
            TASK_SUBTREE_DIAGNOSTICS_MAX_BLOCKERS_PER_NODE,
          TASK_SUBTREE_DIAGNOSTICS_MAX_BLOCKERS_PER_NODE,
        ),
      );
      const rawSubtreeRows =
        await db.execute(sql<TaskSubtreeDiagnosticsTaskRow>`
        WITH RECURSIVE task_tree AS (
          SELECT
            id,
            company_id,
            project_id,
            parent_id,
            task_number,
            identifier,
            title,
            board_presentation_status AS "boardPresentationStatus",
            priority,
            owner_agent_id,
            owner_user_id,
            created_at,
            updated_at,
            0 AS depth,
            ARRAY[id] AS path
          FROM tasks
          WHERE company_id = ${task.companyId}
            AND id = ${task.id}
            AND hidden_at IS NULL
          UNION ALL
          SELECT
            child.id,
            child.company_id,
            child.project_id,
            child.parent_id,
            child.task_number,
            child.identifier,
            child.title,
            child.board_presentation_status AS "boardPresentationStatus",
            child.priority,
            child.owner_agent_id,
            child.owner_user_id,
            child.created_at,
            child.updated_at,
            task_tree.depth + 1,
            task_tree.path || child.id
          FROM tasks child
          JOIN task_tree ON child.parent_id = task_tree.id
          WHERE child.company_id = ${task.companyId}
            AND child.hidden_at IS NULL
            AND task_tree.depth < ${maxDepth + 1}
            AND NOT child.id = ANY(task_tree.path)
        )
        SELECT
          id,
          company_id AS "companyId",
          project_id AS "projectId",
          parent_id AS "parentId",
          task_number AS "taskNumber",
          identifier,
          title,
          "boardPresentationStatus",
          priority,
          owner_agent_id AS "ownerAgentId",
          owner_user_id AS "ownerUserId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          depth::int AS depth
        FROM task_tree
        ORDER BY depth ASC, created_at ASC, id ASC
        LIMIT ${maxNodes + 1}
      `);
      const subtreeRows = Array.from(rawSubtreeRows).map((row) => ({
        ...row,
        depth: Number(row.depth),
      }));
      const rowsWithinDepth = subtreeRows.filter(
        (row) => row.depth <= maxDepth,
      );
      const nodes = rowsWithinDepth.slice(
        0,
        maxNodes,
      ) as TaskSubtreeDiagnosticsTaskRow[];
      const truncatedNodes = rowsWithinDepth.length > maxNodes;
      const truncatedDepth =
        truncatedNodes || subtreeRows.some((row) => row.depth > maxDepth);
      const nodeIds = nodes.map((node) => node.id);

      const readiness =
        nodeIds.length > 0
          ? await listTaskDependencyReadinessMap(db, task.companyId, nodeIds)
          : new Map<string, TaskDependencyReadiness>();
      const blockersByTaskId = new Map<
        string,
        TaskSubtreeDiagnosticsBlockerRow[]
      >();
      const truncatedBlockerTaskIds = new Set<string>();

      if (nodeIds.length > 0) {
        const nodeIdValues = sql.join(
          nodeIds.map((id) => sql`${id}`),
          sql`, `,
        );
        const rawBlockerRows = Array.from(
          await db.execute(sql`
          WITH blocker_rows AS (
            SELECT
              blocker.id,
              blocker.company_id AS "companyId",
              blocker.project_id AS "projectId",
              blocker.parent_id AS "parentId",
              blocker.task_number AS "taskNumber",
              blocker.identifier,
              blocker.title,
              blocker.board_presentation_status AS "boardPresentationStatus",
              blocker.priority,
              blocker.owner_agent_id AS "ownerAgentId",
              blocker.owner_user_id AS "ownerUserId",
              relation.related_task_id AS "blockedTaskId",
              relation.created_at AS "relationCreatedAt",
              row_number() OVER (
                PARTITION BY relation.related_task_id
                ORDER BY blocker.title ASC, blocker.id ASC
              )::int AS "rowNumber"
            FROM task_relations relation
            INNER JOIN tasks blocker ON blocker.id = relation.task_id
            WHERE relation.company_id = ${task.companyId}
              AND relation.type = 'blocks'
              AND blocker.company_id = ${task.companyId}
              AND blocker.hidden_at IS NULL
              AND relation.related_task_id::text IN (${nodeIdValues})
          )
          SELECT *
          FROM blocker_rows
          WHERE "rowNumber" <= ${maxBlockersPerNode + 1}
          ORDER BY "blockedTaskId" ASC, "rowNumber" ASC
        `),
        ) as TaskSubtreeDiagnosticsBlockerResultRow[];
        for (const row of rawBlockerRows) {
          const normalized = { ...row, rowNumber: Number(row.rowNumber) };
          if (normalized.rowNumber > maxBlockersPerNode) {
            truncatedBlockerTaskIds.add(normalized.blockedTaskId);
            continue;
          }
          const rows = blockersByTaskId.get(normalized.blockedTaskId) ?? [];
          rows.push(normalized);
          blockersByTaskId.set(normalized.blockedTaskId, rows);
        }
      }

      return {
        nodes,
        blockersByTaskId,
        readinessByTaskId: readiness,
        truncatedNodes,
        truncatedDepth,
        truncatedBlockerTaskIds,
        caps: {
          maxDepth,
          maxNodes,
          maxBlockersPerNode,
        },
      };
    },

    getDependencyReadiness: async (taskId: string, dbOrTx: any = db) => {
      const task = await dbOrTx
        .select({ id: tasks.id, companyId: tasks.companyId })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .then(
          (rows: Array<{ id: string; companyId: string }>) => rows[0] ?? null,
        );
      if (!task) throw notFound("Task not found");
      const readiness = await listTaskDependencyReadinessMap(
        dbOrTx,
        task.companyId,
        [taskId],
      );
      return readiness.get(taskId) ?? createTaskDependencyReadiness(taskId);
    },

    listDependencyReadiness: async (
      companyId: string,
      taskIds: string[],
      dbOrTx: any = db,
    ) => {
      return listTaskDependencyReadinessMap(dbOrTx, companyId, taskIds);
    },

    listBlockerAttention: async (
      companyId: string,
      taskRows: TaskBlockerAttentionInputNode[],
      dbOrTx: any = db,
    ) => {
      return listTaskBlockerAttentionMap(dbOrTx, companyId, taskRows);
    },

    updateTitle: async (id: string, title: string | null) => {
      return db.transaction(async (tx) => {
        const updated = await tx
          .update(tasks)
          .set({ title, updatedAt: new Date() })
          .where(eq(tasks.id, id))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!updated) return null;
        await syncTask(updated.id, tx);
        const [enriched] = await withTaskLabels(tx, [updated]);
        return enriched;
      });
    },

    updateControlState: async (
      id: string,
      data: TaskControlStateUpdate,
      dbOrTx: any = db,
    ) => {
      if (Object.prototype.hasOwnProperty.call(data, "executionWorkspaceId")) {
        throw unprocessable(
          "executionWorkspaceId is managed by the current task execution workspace binding",
        );
      }
      for (const field of [
        "request",
        "title",
        "parentId",
        "parentOwnershipEpoch",
        "ownerKind",
        "ownerAgentId",
        "ownerUserId",
        "ownerAssignmentSource",
        "ownershipEpoch",
        "creatorKind",
        "creatorAuthorityId",
        "creatorAdapterConfigRevisionId",
        "creatorUserId",
        "creatorPluginInstallationId",
        "creatorPluginKey",
        "creatorCallbackKey",
        "creatorCallbackVersion",
        "creatorRoutineId",
        "creatorRoutineDispatchId",
        "creatorSystemSourceKind",
        "creatorSystemSourceId",
        "lifecycleStatus",
        "disposition",
        "completedAt",
        "cancelledAt",
      ] as const) {
        if (Object.prototype.hasOwnProperty.call(data, field)) {
          throw unprocessable(
            `Task ${field} is immutable or has a dedicated canonical command`,
          );
        }
      }
      const existing = await dbOrTx
        .select()
        .from(tasks)
        .where(eq(tasks.id, id))
        .then((rows: Array<typeof tasks.$inferSelect>) => rows[0] ?? null);
      if (!existing) return null;

      const {
        labelIds: nextLabelIds,
        blockedByTaskIds,
        actorAgentId,
        actorUserId,
        ...taskData
      } = data;
      if (taskData.boardPresentationStatus) {
        assertTransition(
          existing.boardPresentationStatus,
          taskData.boardPresentationStatus,
        );
      }

      const patch: Partial<typeof tasks.$inferInsert> = {
        ...taskData,
        updatedAt: new Date(),
      };
      if (taskData.requestDepth !== undefined) {
        patch.requestDepth = clampTaskRequestDepth(taskData.requestDepth);
      }

      if (
        patch.boardPresentationStatus === "in_progress" &&
        !existing.ownerAgentId &&
        !existing.ownerUserId
      ) {
        throw unprocessable("in_progress tasks require an owner");
      }
      if (patch.boardPresentationStatus === "in_progress") {
        const unresolvedBlockerTaskIds =
          blockedByTaskIds !== undefined
            ? await listUnresolvedBlockerTaskIds(
                dbOrTx,
                existing.companyId,
                blockedByTaskIds,
              )
            : ((
                await listTaskDependencyReadinessMap(
                  dbOrTx,
                  existing.companyId,
                  [id],
                )
              ).get(id)?.unresolvedBlockerTaskIds ?? []);
        if (unresolvedBlockerTaskIds.length > 0) {
          throw unprocessable("Task is blocked by unresolved blockers", {
            unresolvedBlockerTaskIds,
          });
        }
      }
      if (
        patch.boardPresentationStatus === "in_progress" &&
        existing.ownerKind === "agent" &&
        existing.ownerAgentId
      ) {
        try {
          await resolveInvokableTaskOwnerFromDb(dbOrTx as Db, {
            companyId: existing.companyId,
            ownerAgentId: existing.ownerAgentId,
          });
        } catch (error) {
          if (error instanceof InvokableTaskOwnerRejected) {
            throw conflict("Task owner must be an invokable task owner", {
              code: "task_owner_not_invokable",
              reason: error.reason,
              companyId: existing.companyId,
              ownerAgentId: existing.ownerAgentId,
              ...error.details,
            });
          }
          throw error;
        }
      }
      applyStatusSideEffects(taskData.boardPresentationStatus, patch);
      if (
        taskData.boardPresentationStatus &&
        taskData.boardPresentationStatus !== "done"
      ) {
        patch.completedAt = null;
      }
      if (
        taskData.boardPresentationStatus &&
        taskData.boardPresentationStatus !== "cancelled"
      ) {
        patch.cancelledAt = null;
      }
      const runUpdate = async (tx: any) => {
        const defaultCompanyGoal = await getDefaultCompanyGoal(
          tx,
          existing.companyId,
        );

        patch.goalId = resolveNextTaskGoalId({
          currentProjectId: existing.projectId,
          currentGoalId: existing.goalId,
          projectId: taskData.projectId,
          goalId: taskData.goalId,
          defaultGoalId: defaultCompanyGoal?.id ?? null,
        });
        const updated = await tx
          .update(tasks)
          .set(patch)
          .where(eq(tasks.id, id))
          .returning()
          .then((rows: Array<typeof tasks.$inferSelect>) => rows[0] ?? null);
        if (!updated) return null;
        if (nextLabelIds !== undefined) {
          await syncTaskLabels(
            updated.id,
            existing.companyId,
            nextLabelIds,
            tx,
          );
        }
        if (blockedByTaskIds !== undefined) {
          await syncBlockedByTaskIds(
            updated.id,
            existing.companyId,
            blockedByTaskIds,
            {
              agentId: actorAgentId ?? null,
              userId: actorUserId ?? null,
            },
            tx,
          );
        }
        const [enriched] = await withTaskLabels(tx, [updated]);
        return enriched;
      };

      return dbOrTx === db ? db.transaction(runUpdate) : runUpdate(dbOrTx);
    },

    listLabels: (companyId: string) =>
      db
        .select()
        .from(labels)
        .where(eq(labels.companyId, companyId))
        .orderBy(asc(labels.name), asc(labels.id)),

    getLabelById: (id: string) => {
      if (!isCanonicalUuid(id)) return Promise.resolve(null);
      return db
        .select()
        .from(labels)
        .where(eq(labels.id, id))
        .then((rows) => rows[0] ?? null);
    },

    createLabel: async (
      companyId: string,
      data: Pick<typeof labels.$inferInsert, "name" | "color">,
    ) => {
      const [created] = await db
        .insert(labels)
        .values({
          companyId,
          name: data.name.trim(),
          color: data.color,
        })
        .returning();
      return created;
    },

    deleteLabel: async (id: string) => {
      if (!isCanonicalUuid(id)) return null;
      return db
        .delete(labels)
        .where(eq(labels.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
    },

    listBoardCommentGroups: async (
      companyId: string,
      taskId: string,
      opts?: {
        cursor?: string | null;
        limit?: number | null;
        entryLimit?: number | null;
      },
    ): Promise<BoardTaskCommentGroupPage> => {
      const limit = boundedBoardCommentPageSize(
        opts?.limit,
        DEFAULT_BOARD_COMMENT_ROOT_LIMIT,
      );
      const entryLimit = boundedBoardCommentPageSize(
        opts?.entryLimit,
        DEFAULT_BOARD_COMMENT_ENTRY_LIMIT,
      );
      const cursor = decodeBoardCommentCursor(opts?.cursor, {
        kind: "roots",
        taskId,
        rootCommentId: null,
      });
      const conditions = [
        eq(taskComments.companyId, companyId),
        eq(taskComments.taskId, taskId),
        isNull(taskComments.replyToCommentId),
      ];
      if (cursor) {
        conditions.push(
          or(
            lt(taskComments.projectedEventSeq, cursor.sequence),
            and(
              eq(taskComments.projectedEventSeq, cursor.sequence),
              lt(taskComments.id, cursor.id),
            ),
          )!,
        );
      }
      const rows = await db
        .select()
        .from(taskComments)
        .where(and(...conditions))
        .orderBy(desc(taskComments.projectedEventSeq), desc(taskComments.id))
        .limit(limit + 1);
      const roots = rows.slice(0, limit);
      const [labels, runStatuses, general, threadPages] = await Promise.all([
        loadBoardAuthorLabels(roots),
        loadRunStatuses(roots.map((root) => root.runId)),
        instanceSettings.getGeneral(),
        loadBoardCommentThreadPages(roots, entryLimit),
      ]);
      const groups = roots.map((root) => {
        const thread = threadPages.get(root.id)!;
        return {
          root: projectBoardTaskComment({
            comment: root,
            parent: null,
            labels,
            censorUsernameInLogs: general.censorUsernameInLogs,
            runStatus: root.runId ? runStatuses.get(root.runId) : null,
          }),
          replyCount: thread.replyCount,
          runSegmentCount: thread.runSegmentCount,
          entries: thread.entries,
          entriesNextCursor: thread.nextCursor,
        };
      });
      const finalRoot = roots.at(-1);
      return {
        groups,
        nextCursor:
          rows.length > limit && finalRoot
            ? encodeBoardCommentCursor({
                version: 1,
                kind: "roots",
                taskId,
                rootCommentId: null,
                sequence: finalRoot.projectedEventSeq,
                id: finalRoot.id,
              })
            : null,
      };
    },

    getBoardComment: (companyId: string, taskId: string, commentId: string) =>
      getBoardCommentProjection({ companyId, taskId, commentId }),

    getBoardCommentThread: async (
      companyId: string,
      taskId: string,
      rootCommentId: string,
      opts?: { cursor?: string | null; limit?: number | null },
    ): Promise<BoardTaskCommentThreadPage | null> => {
      if (
        !isCanonicalUuid(companyId) ||
        !isCanonicalUuid(taskId) ||
        !isCanonicalUuid(rootCommentId)
      ) {
        return null;
      }
      const root = await db
        .select()
        .from(taskComments)
        .where(
          and(
            eq(taskComments.companyId, companyId),
            eq(taskComments.taskId, taskId),
            eq(taskComments.id, rootCommentId),
            isNull(taskComments.replyToCommentId),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (!root) return null;
      const page = await loadBoardCommentThreadPage({
        root,
        cursor: opts?.cursor,
        limit: opts?.limit,
      });
      return { entries: page.entries, nextCursor: page.nextCursor };
    },

    listComments: async (
      taskId: string,
      opts?: {
        afterCommentId?: string | null;
        order?: "asc" | "desc";
        limit?: number | null;
      },
    ) => {
      const order = opts?.order === "asc" ? "asc" : "desc";
      const afterCommentId = opts?.afterCommentId ?? null;
      if (afterCommentId !== null && !isCanonicalUuid(afterCommentId)) {
        throw unprocessable("afterCommentId must be an exact canonical UUID");
      }
      const limit = opts?.limit ?? null;
      if (
        limit !== null &&
        (!Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > MAX_TASK_COMMENT_PAGE_LIMIT)
      ) {
        throw unprocessable(
          `Task comment page limit must be between 1 and ${MAX_TASK_COMMENT_PAGE_LIMIT}`,
        );
      }

      const conditions = [eq(taskComments.taskId, taskId)];
      if (afterCommentId) {
        const anchor = await db
          .select({
            id: taskComments.id,
            createdAt: taskComments.createdAt,
          })
          .from(taskComments)
          .where(
            and(
              eq(taskComments.taskId, taskId),
              eq(taskComments.id, afterCommentId),
            ),
          )
          .then((rows) => rows[0] ?? null);

        if (!anchor) return [];
        const anchorCreatedAt =
          anchor.createdAt instanceof Date
            ? anchor.createdAt
            : new Date(String(anchor.createdAt));
        conditions.push(
          order === "asc"
            ? or(
                gt(taskComments.createdAt, anchorCreatedAt),
                and(
                  eq(taskComments.createdAt, anchorCreatedAt),
                  gt(taskComments.id, anchor.id),
                ),
              )!
            : or(
                lt(taskComments.createdAt, anchorCreatedAt),
                and(
                  eq(taskComments.createdAt, anchorCreatedAt),
                  lt(taskComments.id, anchor.id),
                ),
              )!,
        );
      }

      const query = db
        .select()
        .from(taskComments)
        .where(and(...conditions))
        .orderBy(
          order === "asc"
            ? asc(taskComments.createdAt)
            : desc(taskComments.createdAt),
          order === "asc" ? asc(taskComments.id) : desc(taskComments.id),
        );

      const comments = limit ? await query.limit(limit) : await query;
      const { censorUsernameInLogs } = await instanceSettings.getGeneral();
      return comments.map((comment) =>
        redactTaskComment(comment, censorUsernameInLogs),
      );
    },

    getCommentCursor: async (taskId: string) => {
      const [latest, countRow] = await Promise.all([
        db
          .select({
            latestCommentId: taskComments.id,
            latestCommentAt: taskComments.createdAt,
          })
          .from(taskComments)
          .where(eq(taskComments.taskId, taskId))
          .orderBy(desc(taskComments.createdAt), desc(taskComments.id))
          .limit(1)
          .then((rows) => rows[0] ?? null),
        db
          .select({
            totalComments: sql<number>`count(*)::int`,
          })
          .from(taskComments)
          .where(eq(taskComments.taskId, taskId))
          .then((rows) => rows[0] ?? null),
      ]);

      return {
        totalComments: Number(countRow?.totalComments ?? 0),
        latestCommentId: latest?.latestCommentId ?? null,
        latestCommentAt: latest?.latestCommentAt ?? null,
      };
    },

    getComment: async (commentId: string) => {
      if (!isCanonicalUuid(commentId)) return null;
      const { censorUsernameInLogs } = await instanceSettings.getGeneral();
      const comment = await db
        .select()
        .from(taskComments)
        .where(eq(taskComments.id, commentId))
        .then((rows) => rows[0] ?? null);
      if (!comment) return null;
      return redactTaskComment(comment, censorUsernameInLogs);
    },

    createAttachment: async (input: {
      taskId: string;
      taskCommentId?: string | null;
      provider: string;
      objectKey: string;
      contentType: string;
      byteSize: number;
      sha256: string;
      originalFilename?: string | null;
      createdByAgentId?: string | null;
      createdByUserId?: string | null;
    }) => {
      const task = await db
        .select({ id: tasks.id, companyId: tasks.companyId })
        .from(tasks)
        .where(eq(tasks.id, input.taskId))
        .then((rows) => rows[0] ?? null);
      if (!task) throw notFound("Task not found");

      if (input.taskCommentId) {
        const comment = await db
          .select({
            id: taskComments.id,
            companyId: taskComments.companyId,
            taskId: taskComments.taskId,
          })
          .from(taskComments)
          .where(eq(taskComments.id, input.taskCommentId))
          .then((rows) => rows[0] ?? null);
        if (!comment) throw notFound("Task comment not found");
        if (
          comment.companyId !== task.companyId ||
          comment.taskId !== task.id
        ) {
          throw unprocessable(
            "Attachment comment must belong to same task and company",
          );
        }
      }

      return db.transaction(async (tx) => {
        const [asset] = await tx
          .insert(assets)
          .values({
            companyId: task.companyId,
            provider: input.provider,
            objectKey: input.objectKey,
            contentType: input.contentType,
            byteSize: input.byteSize,
            sha256: input.sha256,
            originalFilename: input.originalFilename ?? null,
            createdByAgentId: input.createdByAgentId ?? null,
            createdByUserId: input.createdByUserId ?? null,
          })
          .returning();

        const [attachment] = await tx
          .insert(taskAttachments)
          .values({
            companyId: task.companyId,
            taskId: task.id,
            assetId: asset.id,
            taskCommentId: input.taskCommentId ?? null,
          })
          .returning();

        return {
          id: attachment.id,
          companyId: attachment.companyId,
          taskId: attachment.taskId,
          taskCommentId: attachment.taskCommentId,
          assetId: attachment.assetId,
          provider: asset.provider,
          objectKey: asset.objectKey,
          contentType: asset.contentType,
          byteSize: asset.byteSize,
          sha256: asset.sha256,
          originalFilename: asset.originalFilename,
          createdByAgentId: asset.createdByAgentId,
          createdByUserId: asset.createdByUserId,
          createdAt: attachment.createdAt,
          updatedAt: attachment.updatedAt,
        };
      });
    },

    listAttachments: async (taskId: string) =>
      db
        .select({
          id: taskAttachments.id,
          companyId: taskAttachments.companyId,
          taskId: taskAttachments.taskId,
          taskCommentId: taskAttachments.taskCommentId,
          assetId: taskAttachments.assetId,
          provider: assets.provider,
          objectKey: assets.objectKey,
          contentType: assets.contentType,
          byteSize: assets.byteSize,
          sha256: assets.sha256,
          originalFilename: assets.originalFilename,
          createdByAgentId: assets.createdByAgentId,
          createdByUserId: assets.createdByUserId,
          createdAt: taskAttachments.createdAt,
          updatedAt: taskAttachments.updatedAt,
        })
        .from(taskAttachments)
        .innerJoin(assets, eq(taskAttachments.assetId, assets.id))
        .where(eq(taskAttachments.taskId, taskId))
        .orderBy(desc(taskAttachments.createdAt)),

    getAttachmentById: async (id: string) => {
      if (!isCanonicalUuid(id)) return null;
      return db
        .select({
          id: taskAttachments.id,
          companyId: taskAttachments.companyId,
          taskId: taskAttachments.taskId,
          taskCommentId: taskAttachments.taskCommentId,
          assetId: taskAttachments.assetId,
          provider: assets.provider,
          objectKey: assets.objectKey,
          contentType: assets.contentType,
          byteSize: assets.byteSize,
          sha256: assets.sha256,
          originalFilename: assets.originalFilename,
          createdByAgentId: assets.createdByAgentId,
          createdByUserId: assets.createdByUserId,
          createdAt: taskAttachments.createdAt,
          updatedAt: taskAttachments.updatedAt,
        })
        .from(taskAttachments)
        .innerJoin(assets, eq(taskAttachments.assetId, assets.id))
        .where(eq(taskAttachments.id, id))
        .then((rows) => rows[0] ?? null);
    },

    removeAttachment: async (id: string) => {
      if (!isCanonicalUuid(id)) return null;
      return db.transaction(async (tx) => {
        const existing = await tx
          .select({
            id: taskAttachments.id,
            companyId: taskAttachments.companyId,
            taskId: taskAttachments.taskId,
            taskCommentId: taskAttachments.taskCommentId,
            assetId: taskAttachments.assetId,
            provider: assets.provider,
            objectKey: assets.objectKey,
            contentType: assets.contentType,
            byteSize: assets.byteSize,
            sha256: assets.sha256,
            originalFilename: assets.originalFilename,
            createdByAgentId: assets.createdByAgentId,
            createdByUserId: assets.createdByUserId,
            createdAt: taskAttachments.createdAt,
            updatedAt: taskAttachments.updatedAt,
          })
          .from(taskAttachments)
          .innerJoin(assets, eq(taskAttachments.assetId, assets.id))
          .where(eq(taskAttachments.id, id))
          .then((rows) => rows[0] ?? null);
        if (!existing) return null;

        await tx.delete(taskAttachments).where(eq(taskAttachments.id, id));
        await tx.delete(assets).where(eq(assets.id, existing.assetId));
        return existing;
      });
    },

    findMentionedAgents: async (companyId: string, body: string) => {
      const explicitAgentMentionIds = extractAgentMentionIds(body);
      if (explicitAgentMentionIds.length === 0) return [];

      const rows = await db
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.companyId, companyId));
      const companyAgentIds = new Set(rows.map((agent) => agent.id));
      return explicitAgentMentionIds.filter((agentId) =>
        companyAgentIds.has(agentId),
      );
    },

    findMentionedProjectIds: async (
      taskId: string,
      opts?: { includeCommentBodies?: boolean },
    ) => {
      const task = await db
        .select({
          companyId: tasks.companyId,
          title: tasks.title,
          request: tasks.request,
        })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .then((rows) => rows[0] ?? null);
      if (!task) return [];

      const mentionedIds = new Set<string>();
      for (const source of [task.title, task.request]) {
        if (!source) continue;
        for (const projectId of extractProjectMentionIds(source)) {
          mentionedIds.add(projectId);
        }
      }

      if (opts?.includeCommentBodies !== false) {
        const comments = await db
          .select({ body: taskComments.body })
          .from(taskComments)
          .where(eq(taskComments.taskId, taskId));

        for (const comment of comments) {
          for (const projectId of extractProjectMentionIds(comment.body)) {
            mentionedIds.add(projectId);
          }
        }
      }

      if (mentionedIds.size === 0) return [];

      const rows = await db
        .select({ id: projects.id })
        .from(projects)
        .where(
          and(
            eq(projects.companyId, task.companyId),
            inArray(projects.id, [...mentionedIds]),
          ),
        );
      const valid = new Set(rows.map((row) => row.id));
      return [...mentionedIds].filter((projectId) => valid.has(projectId));
    },

    getAncestors: async (taskId: string) => {
      const raw: Array<{
        id: string;
        taskNumber: number;
        identifier: string;
        title: string | null;
        request: string | null;
        boardPresentationStatus: TaskStatus;
        priority: string;
        ownerAgentId: string | null;
        ownerUserId: string | null;
        projectId: string | null;
        goalId: string | null;
      }> = [];
      const visited = new Set<string>([taskId]);
      const start = await db
        .select()
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .then((r) => r[0] ?? null);
      let currentId = start?.parentId ?? null;
      while (currentId && !visited.has(currentId) && raw.length < 50) {
        visited.add(currentId);
        const parent = await db
          .select({
            id: tasks.id,
            taskNumber: tasks.taskNumber,
            identifier: tasks.identifier,
            title: tasks.title,
            request: tasks.request,
            boardPresentationStatus: tasks.boardPresentationStatus,
            priority: tasks.priority,
            ownerAgentId: tasks.ownerAgentId,
            ownerUserId: tasks.ownerUserId,
            projectId: tasks.projectId,
            goalId: tasks.goalId,
            parentId: tasks.parentId,
          })
          .from(tasks)
          .where(eq(tasks.id, currentId))
          .then((r) => r[0] ?? null);
        if (!parent) break;
        raw.push({
          id: parent.id,
          taskNumber: parent.taskNumber,
          identifier: parent.identifier,
          title: parent.title,
          request: parent.request,
          boardPresentationStatus: parent.boardPresentationStatus,
          priority: parent.priority,
          ownerAgentId: parent.ownerAgentId ?? null,
          ownerUserId: parent.ownerUserId ?? null,
          projectId: parent.projectId ?? null,
          goalId: parent.goalId ?? null,
        });
        currentId = parent.parentId ?? null;
      }

      // Batch-fetch referenced projects and goals.
      const projectIds = [
        ...new Set(
          raw.map((a) => a.projectId).filter((id): id is string => id != null),
        ),
      ];
      const goalIds = [
        ...new Set(
          raw.map((a) => a.goalId).filter((id): id is string => id != null),
        ),
      ];

      const projectMap = new Map<
        string,
        {
          id: string;
          name: string;
          description: string | null;
          status: string;
        }
      >();
      const goalMap = new Map<
        string,
        {
          id: string;
          title: string;
          description: string | null;
          level: string;
          status: string;
        }
      >();

      if (projectIds.length > 0) {
        const rows = await db
          .select({
            id: projects.id,
            name: projects.name,
            description: projects.description,
            status: projects.status,
          })
          .from(projects)
          .where(inArray(projects.id, projectIds));
        for (const r of rows) {
          projectMap.set(r.id, r);
        }
      }

      if (goalIds.length > 0) {
        const rows = await db
          .select({
            id: goals.id,
            title: goals.title,
            description: goals.description,
            level: goals.level,
            status: goals.status,
          })
          .from(goals)
          .where(inArray(goals.id, goalIds));
        for (const r of rows) goalMap.set(r.id, r);
      }

      return raw.map((a) => ({
        ...a,
        project: a.projectId ? (projectMap.get(a.projectId) ?? null) : null,
        goal: a.goalId ? (goalMap.get(a.goalId) ?? null) : null,
      }));
    },
  };
}
