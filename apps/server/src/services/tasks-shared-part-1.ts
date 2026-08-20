import * as d from "./tasks-dependencies.js";

export const ALL_TASK_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "cancelled",
] as const satisfies readonly d.TaskStatus[];

export const MAX_TASK_COMMENT_PAGE_LIMIT = 500;

export const DEFAULT_BOARD_COMMENT_ROOT_LIMIT = 100;

export const DEFAULT_BOARD_COMMENT_ENTRY_LIMIT = 100;

export type BoardCommentCursor = {
  version: 1;
  kind: "roots" | "thread";
  taskId: string;
  rootCommentId: string | null;
  sequence: number;
  id: string;
};

export function encodeBoardCommentCursor(cursor: BoardCommentCursor): string {
  return d.Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeBoardCommentCursor(
  encoded: string | null | undefined,
  expected: Pick<BoardCommentCursor, "kind" | "taskId" | "rootCommentId">,
): BoardCommentCursor | null {
  if (!encoded) return null;
  let value: unknown;
  try {
    const bytes = d.Buffer.from(encoded, "base64url");
    if (bytes.toString("base64url") !== encoded) {
      throw new Error("Non-canonical base64url");
    }
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw d.unprocessable("Invalid task comment cursor");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw d.unprocessable("Invalid task comment cursor");
  }
  const candidate = value as Partial<BoardCommentCursor>;
  if (
    Object.keys(candidate).sort().join(",") !== "id,kind,rootCommentId,sequence,taskId,version" ||
    candidate.version !== 1 ||
    candidate.kind !== expected.kind ||
    candidate.taskId !== expected.taskId ||
    candidate.rootCommentId !== expected.rootCommentId ||
    !Number.isSafeInteger(candidate.sequence) ||
    Number(candidate.sequence) < 0 ||
    typeof candidate.id !== "string" ||
    !d.isCanonicalUuid(candidate.id)
  ) {
    throw d.unprocessable("Task comment cursor does not belong to this view");
  }
  return candidate as BoardCommentCursor;
}

export function boundedBoardCommentPageSize(requested: number | null | undefined, fallback: number): number {
  if (requested == null) return fallback;
  if (!Number.isSafeInteger(requested) || requested < 1 || requested > MAX_TASK_COMMENT_PAGE_LIMIT) {
    throw d.unprocessable(`Task comment page limit must be between 1 and ${MAX_TASK_COMMENT_PAGE_LIMIT}`);
  }
  return requested;
}

export function boardRunState(
  status: d.TaskExecutionRunStatus | null | undefined,
): d.BoardTaskCommentRunState | null {
  if (status === "queued" || status === "scheduled_retry") return "queued";
  if (status === "running") return "working";
  return status ? "terminal" : null;
}

export function compareCanonicalEntry(
  left: { canonicalSequence: number; id: string },
  right: { canonicalSequence: number; id: string },
): number {
  return left.canonicalSequence - right.canonicalSequence || left.id.localeCompare(right.id);
}

export function isAfterBoardCommentCursor(
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

export const TASK_LIST_RELATED_QUERY_CHUNK_SIZE = 500;

export function parseStatusFilter(input: unknown): d.TaskStatus[] {
  if (input === undefined) return [];
  const entries = Array.isArray(input) ? [...input] : [input];
  if (
    entries.length === 0 ||
    entries.some(
      (status) => typeof status !== "string" || !(ALL_TASK_STATUSES as readonly string[]).includes(status),
    ) ||
    new Set(entries).size !== entries.length
  ) {
    throw d.unprocessable("status must contain unique canonical task status values");
  }
  return entries as d.TaskStatus[];
}

export interface TaskFilters {
  attention?: "blocked";
  status?: readonly d.TaskStatus[];
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
  lowTrustBoundary?: d.LowTrustBoundary & { companyId: string };
  q?: string;
  limit?: number;
  offset?: number;
  sortField?: "updated";
  sortDir?: "asc" | "desc";
}

export type TaskRow = typeof d.tasks.$inferSelect;

export type TaskLabelRow = typeof d.labels.$inferSelect;

export type TaskActiveRunRow = {
  id: string;
  status: string;
  agentId: string;
  sourceKind: string;
  sourceRecordId: string;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
};

export type TaskLabelEnrichment = {
  labels: TaskLabelRow[];
  labelIds: string[];
};

export type CanonicalTaskListRow = TaskRow;

export type CanonicalTaskWithLabels = CanonicalTaskListRow & TaskLabelEnrichment;

export type CanonicalTaskWithLabelsAndRun = CanonicalTaskWithLabels & {
  activeRun: TaskActiveRunRow | null;
};

export type TaskUserCommentStats = {
  taskId: string;
  myLastCommentAt: Date | null;
  lastExternalCommentAt: Date | null;
};

export type TaskReadStat = {
  taskId: string;
  myLastReadAt: Date | null;
};

export type TaskLastActivityStat = {
  taskId: string;
  latestCommentAt: Date | null;
  latestLogAt: Date | null;
};

export type TaskUserContextInput = {
  creatorUserId: string | null;
  ownerUserId: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

export type DbReader = Pick<d.Db, "select">;

export type TaskRelationSummaryMap = {
  blockedBy: d.TaskRelationTaskSummary[];
  blocks: d.TaskRelationTaskSummary[];
};
