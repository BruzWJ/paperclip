import type {
  BoardTaskComment,
  BoardTaskCommentGroupPage,
  BoardTaskCommentParentReference,
  BoardTaskRunSegmentEntry,
  BoardTaskRunSegmentPart,
  BoardTaskThreadEntry,
  Task,
  TaskCommentAuthorType,
  TaskCommentMetadata,
  TaskCommentPresentation,
  SourceTrustMetadata,
} from "@paperclipai/shared";
import type { TimestampedEntity } from "./presentation-contracts";

/** UI-only comment shape built exclusively from the board-safe read DTO. */
export interface ClientTaskComment {
  id: string;
  authorType: TaskCommentAuthorType;
  authorLabel?: string | null;
  authorAgentId: string | null;
  authorUserId: string | null;
  body: string;
  presentation: TaskCommentPresentation | null;
  metadata: TaskCommentMetadata | null;
  sourceTrust?: SourceTrustMetadata | null;
  createdAt: Date | string;
  immediateParentDisplayReference?: BoardTaskCommentParentReference | null;
  boardEntryKind?: "comment" | "run_segment";
  boardRunSegmentParts?: readonly BoardTaskRunSegmentPart[];
  boardGroupRootId?: string;
  boardOrder?: number;
  runState?: "queued" | "working" | "terminal" | null;
  boardGroupHasMore?: boolean;
  boardGroupContinuationLoading?: boolean;
  boardGroupContinuationError?: string | null;
}

export interface BoardTaskCommentGroupContinuation {
  entries: readonly BoardTaskThreadEntry[];
  nextCursor: string | null;
  expanded?: boolean;
  loading?: boolean;
  error?: string | null;
}

export interface OptimisticTaskComment extends ClientTaskComment {
  clientId: string;
  clientStatus: "pending" | "queued";
}

type TaskTimelineComment = ClientTaskComment | OptimisticTaskComment;
type LocallyQueuedTaskComment<T extends ClientTaskComment> = T & {
  clientStatus: "queued";
};

function toTimestamp(value: Date | string) {
  return new Date(value).getTime();
}

function createOptimisticCommentId() {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  if (randomUuid) {
    return `optimistic-${randomUuid}`;
  }
  return `optimistic-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function sortTaskComments<T extends TimestampedEntity>(comments: T[]) {
  return [...comments].sort((a, b) => {
    const createdAtDiff = toTimestamp(a.createdAt) - toTimestamp(b.createdAt);
    if (createdAtDiff !== 0) return createdAtDiff;
    return a.id.localeCompare(b.id);
  });
}

export function createOptimisticTaskComment(params: {
  body: string;
  authorUserId: string | null;
  clientStatus?: OptimisticTaskComment["clientStatus"];
}): OptimisticTaskComment {
  const clientId = createOptimisticCommentId();
  return {
    id: clientId,
    clientId,
    authorType: "user",
    authorAgentId: null,
    authorUserId: params.authorUserId,
    body: params.body,
    presentation: null,
    metadata: null,
    clientStatus: params.clientStatus ?? "pending",
    createdAt: new Date(),
  };
}

export function applyLocalQueuedTaskCommentState<T extends ClientTaskComment>(
  comment: T,
  params: {
    queuedTargetRunId?: string | null;
    targetRunIsLive: boolean;
    runningRunId?: string | null;
  },
): T | LocallyQueuedTaskComment<T> {
  const queuedTargetRunId = params.queuedTargetRunId ?? null;
  if (!queuedTargetRunId || !params.targetRunIsLive) return comment;
  if (params.runningRunId && params.runningRunId !== queuedTargetRunId) return comment;

  return {
    ...comment,
    clientStatus: "queued",
  };
}

export function mergeTaskComments(
  comments: ClientTaskComment[] | undefined,
  optimisticComments: OptimisticTaskComment[],
): TaskTimelineComment[] {
  if ((comments ?? []).some((comment) => comment.boardOrder !== undefined)) {
    const persisted = [...(comments ?? [])].sort(
      (left, right) => (left.boardOrder ?? 0) - (right.boardOrder ?? 0),
    );
    return [...persisted, ...sortTaskComments(optimisticComments)];
  }
  const merged: TaskTimelineComment[] = [...(comments ?? [])];
  const existingIds = new Set(merged.map((comment) => comment.id));
  for (const comment of optimisticComments) {
    if (!existingIds.has(comment.id)) {
      merged.push(comment);
    }
  }
  return sortTaskComments(merged);
}

function boardCommentToClient(
  comment: BoardTaskComment,
  placement: {
    rootId: string;
    order: number;
  },
): ClientTaskComment {
  return {
    id: comment.id,
    authorType: comment.author.type,
    authorLabel: comment.author.label,
    authorAgentId: comment.author.agentId,
    authorUserId: comment.author.userId,
    body: comment.body,
    presentation: comment.presentation,
    metadata: comment.metadata,
    sourceTrust: comment.sourceTrust,
    createdAt: comment.createdAt,
    immediateParentDisplayReference: comment.immediateParentDisplayReference,
    boardEntryKind: "comment",
    boardGroupRootId: placement.rootId,
    boardOrder: placement.order,
    runState: comment.runState,
  };
}

function boardRunSegmentToClient(
  segment: BoardTaskRunSegmentEntry,
  placement: { rootId: string; order: number },
): ClientTaskComment {
  return {
    id: segment.id,
    authorType: "agent",
    authorLabel: segment.author.label,
    authorAgentId: segment.author.agentId,
    authorUserId: null,
    body: "",
    presentation: null,
    metadata: null,
    createdAt: segment.createdAt,
    immediateParentDisplayReference: segment.immediateParentDisplayReference,
    boardEntryKind: "run_segment",
    boardRunSegmentParts: segment.parts,
    boardGroupRootId: placement.rootId,
    boardOrder: placement.order,
    runState: segment.status === "working" ? "working" : "terminal",
  };
}

/**
 * Root pages arrive newest-first; each group is expanded atomically before the
 * next root so a late reply never scatters into a later unrelated root.
 */
export function flattenBoardTaskCommentGroupPages(
  pages: readonly BoardTaskCommentGroupPage[] | undefined,
  continuations?: ReadonlyMap<string, BoardTaskCommentGroupContinuation>,
): ClientTaskComment[] {
  const orderedGroups = (pages ?? [])
    .slice()
    .reverse()
    .flatMap((page) => [...page.groups].reverse());
  const comments: ClientTaskComment[] = [];
  let order = 0;
  for (const group of orderedGroups) {
    const groupComments: ClientTaskComment[] = [];
    groupComments.push(
      boardCommentToClient(group.root, {
        rootId: group.root.id,
        order: order++,
      }),
    );
    const continuation = continuations?.get(group.root.id);
    const entriesByIdentity = new Map<string, BoardTaskThreadEntry>();
    for (const entry of [...group.entries, ...(continuation?.entries ?? [])]) {
      entriesByIdentity.set(`${entry.kind}:${entry.id}`, entry);
    }
    const expectedEntryCount = group.replyCount + group.runSegmentCount;
    const collapsed =
      group.entriesNextCursor !== null &&
      (continuation?.expanded !== true || entriesByIdentity.size < expectedEntryCount);
    const entries = (collapsed ? [] : [...entriesByIdentity.values()]).sort(
      (left, right) => left.canonicalSequence - right.canonicalSequence || left.id.localeCompare(right.id),
    );
    for (const entry of entries) {
      groupComments.push(
        entry.kind === "comment"
          ? boardCommentToClient(entry, {
              rootId: group.root.id,
              order: order++,
            })
          : boardRunSegmentToClient(entry, {
              rootId: group.root.id,
              order: order++,
            }),
      );
    }
    const nextCursor = continuation?.nextCursor ?? (collapsed ? group.entriesNextCursor : null);
    const continuationTarget = groupComments.at(-1);
    if (continuationTarget && (nextCursor || continuation?.loading || continuation?.error)) {
      continuationTarget.boardGroupHasMore = Boolean(nextCursor);
      continuationTarget.boardGroupContinuationLoading = continuation?.loading === true;
      continuationTarget.boardGroupContinuationError = continuation?.error ?? null;
    }
    comments.push(...groupComments);
  }
  return comments;
}

export function shouldAutoloadOlderTaskComments(params: {
  activeDetailTab: string;
  hasOlderComments: boolean;
  loadedCommentCount: number;
  initialPageLoading: boolean;
  olderPageLoading: boolean;
  autoLoadLimit: number;
}) {
  if (params.activeDetailTab !== "chat") return false;
  if (!params.hasOlderComments) return false;
  if (params.initialPageLoading || params.olderPageLoading) return false;
  if (params.loadedCommentCount === 0) return false;
  return params.loadedCommentCount < params.autoLoadLimit;
}

export function applyOptimisticTaskFieldUpdate(task: Task | undefined, data: Record<string, unknown>) {
  if (!task) return task;

  const nextTask: Task = {
    ...task,
    updatedAt: new Date(),
  };
  const hasOwn = (key: string) => Object.prototype.hasOwnProperty.call(data, key);
  const assign = <K extends keyof Task>(key: K) => {
    if (hasOwn(key)) {
      nextTask[key] = data[key] as Task[K];
    }
  };

  assign("boardPresentationStatus");
  assign("priority");
  assign("ownerAgentId");
  assign("ownerUserId");
  assign("ownerKind");
  assign("ownerAssignmentSource");
  assign("ownershipEpoch");
  assign("projectId");
  assign("parentId");
  assign("hiddenAt");

  if (hasOwn("labelIds") && Array.isArray(data.labelIds)) {
    const nextLabelIds = data.labelIds.filter((value): value is string => typeof value === "string");
    nextTask.labelIds = nextLabelIds;
    if (task.labels) {
      nextTask.labels = task.labels.filter((label) => nextLabelIds.includes(label.id));
    }
  }

  if (hasOwn("blockedByTaskIds") && Array.isArray(data.blockedByTaskIds) && task.blockedBy) {
    const nextBlockedByIds = new Set(
      data.blockedByTaskIds.filter((value): value is string => typeof value === "string"),
    );
    nextTask.blockedBy = task.blockedBy.filter((relation) => nextBlockedByIds.has(relation.id));
  }

  if (hasOwn("projectId")) {
    nextTask.project = task.project?.id === nextTask.projectId ? task.project : null;
  }

  if (hasOwn("parentId")) {
    nextTask.ancestors = undefined;
  }

  return nextTask;
}

export function matchesTaskId(task: Pick<Task, "id">, taskId: string) {
  return task.id === taskId;
}

export function applyOptimisticTaskFieldUpdateToCollection(
  tasks: Task[] | undefined,
  taskId: string,
  data: Record<string, unknown>,
) {
  if (!tasks) return tasks;

  let changed = false;
  const nextTasks = tasks.map((task) => {
    if (!matchesTaskId(task, taskId)) return task;
    changed = true;
    return applyOptimisticTaskFieldUpdate(task, data) ?? task;
  });

  return changed ? nextTasks : tasks;
}
