import type {
  BoardIssueComment,
  BoardIssueCommentGroupPage,
  BoardIssueCommentParentReference,
  BoardIssueRunSegmentEntry,
  BoardIssueThreadEntry,
  Issue,
  IssueCommentAuthorType,
  IssueCommentMetadata,
  IssueCommentPresentation,
  SourceTrustMetadata,
} from "@paperclipai/shared";

/** UI-only comment shape built exclusively from the board-safe read DTO. */
export interface ClientIssueComment {
  id: string;
  companyId: string;
  issueId: string;
  authorType: IssueCommentAuthorType;
  authorAgentId: string | null;
  authorUserId: string | null;
  authorPluginKey?: string | null;
  body: string;
  presentation: IssueCommentPresentation | null;
  metadata: IssueCommentMetadata | null;
  sourceTrust?: SourceTrustMetadata | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  runId?: string | null;
  canonicalSourceKind?: string;
  interruptedRunId?: string | null;
  followUpRequested?: boolean;
  canonicalSequence?: number;
  immediateParentDisplayReference?: BoardIssueCommentParentReference | null;
  boardEntryKind?: "comment" | "run_segment";
  boardGroupRootId?: string;
  boardIsRoot?: boolean;
  boardOrder?: number;
  runState?: "queued" | "working" | "terminal" | null;
  boardGroupHasMore?: boolean;
  boardGroupContinuationLoading?: boolean;
  boardGroupContinuationError?: string | null;
}

export interface BoardIssueCommentGroupContinuation {
  entries: readonly BoardIssueThreadEntry[];
  nextCursor: string | null;
  expanded?: boolean;
  loading?: boolean;
  error?: string | null;
}

export interface OptimisticIssueComment extends ClientIssueComment {
  clientId: string;
  clientStatus: "pending" | "queued";
  queueTargetRunId?: string | null;
}

export type IssueTimelineComment =
  | ClientIssueComment
  | OptimisticIssueComment;
export type LocallyQueuedIssueComment<T extends ClientIssueComment> = T & {
  clientStatus: "queued";
  queueState: "queued";
  queueTargetRunId: string;
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

export function sortIssueComments<T extends { createdAt: Date | string; id: string }>(comments: T[]) {
  return [...comments].sort((a, b) => {
    const createdAtDiff = toTimestamp(a.createdAt) - toTimestamp(b.createdAt);
    if (createdAtDiff !== 0) return createdAtDiff;
    return a.id.localeCompare(b.id);
  });
}

export function createOptimisticIssueComment(params: {
  companyId: string;
  issueId: string;
  body: string;
  authorUserId: string | null;
  clientStatus?: OptimisticIssueComment["clientStatus"];
  queueTargetRunId?: string | null;
}): OptimisticIssueComment {
  const now = new Date();
  const clientId = createOptimisticCommentId();
  return {
    id: clientId,
    clientId,
    companyId: params.companyId,
    issueId: params.issueId,
    authorType: "user",
    authorAgentId: null,
    authorUserId: params.authorUserId,
    body: params.body,
    presentation: null,
    metadata: null,
    clientStatus: params.clientStatus ?? "pending",
    queueTargetRunId: params.queueTargetRunId ?? null,
    createdAt: now,
    updatedAt: now,
  };
}

export function isQueuedIssueComment(params: {
  comment: Pick<IssueTimelineComment, "createdAt"> &
    Partial<Pick<OptimisticIssueComment, "clientStatus">> & {
      id?: string;
      authorAgentId?: string | null;
    };
  activeRunStartedAt?: Date | string | null;
  activeRunAgentId?: string | null;
  activeRunCommentId?: string | null;
  activeRunWakeCommentId?: string | null;
  runId?: string | null;
  interruptedRunId?: string | null;
}) {
  if (params.runId) return false;
  if (params.interruptedRunId) return false;
  if (
    params.comment.id &&
    (params.comment.id === params.activeRunWakeCommentId || params.comment.id === params.activeRunCommentId)
  ) {
    return false;
  }
  if (params.comment.authorAgentId && params.activeRunAgentId && params.comment.authorAgentId === params.activeRunAgentId) {
    return false;
  }
  if (params.comment.clientStatus === "queued") return true;
  if (!params.activeRunStartedAt) return false;
  return toTimestamp(params.comment.createdAt) >= toTimestamp(params.activeRunStartedAt);
}

export function applyLocalQueuedIssueCommentState<T extends ClientIssueComment>(
  comment: T,
  params: {
    queuedTargetRunId?: string | null;
    targetRunIsLive: boolean;
    runningRunId?: string | null;
  },
): T | LocallyQueuedIssueComment<T> {
  const queuedTargetRunId = params.queuedTargetRunId ?? null;
  if (!queuedTargetRunId || !params.targetRunIsLive) return comment;
  if (params.runningRunId && params.runningRunId !== queuedTargetRunId) return comment;

  return {
    ...comment,
    clientStatus: "queued",
    queueState: "queued",
    queueTargetRunId: queuedTargetRunId,
  };
}

export function mergeIssueComments(
  comments: ClientIssueComment[] | undefined,
  optimisticComments: OptimisticIssueComment[],
): IssueTimelineComment[] {
  if ((comments ?? []).some((comment) => comment.boardOrder !== undefined)) {
    const persisted = [...(comments ?? [])].sort(
      (left, right) => (left.boardOrder ?? 0) - (right.boardOrder ?? 0),
    );
    return [...persisted, ...sortIssueComments(optimisticComments)];
  }
  const merged: IssueTimelineComment[] = [
    ...(comments ?? []),
  ];
  const existingIds = new Set(merged.map((comment) => comment.id));
  for (const comment of optimisticComments) {
    if (!existingIds.has(comment.id)) {
      merged.push(comment);
    }
  }
  return sortIssueComments(merged);
}

function boardCommentToClient(
  comment: BoardIssueComment,
  scope: { companyId: string; issueId: string },
  placement: {
    rootId: string;
    isRoot: boolean;
    order: number;
  },
): ClientIssueComment {
  return {
    id: comment.id,
    companyId: scope.companyId,
    issueId: scope.issueId,
    authorType: comment.author.type,
    authorAgentId: comment.author.agentId,
    authorUserId: comment.author.userId,
    authorPluginKey: comment.author.pluginKey,
    body: comment.body,
    presentation: comment.presentation,
    metadata: comment.metadata,
    sourceTrust: comment.sourceTrust,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
    canonicalSequence: comment.canonicalSequence,
    immediateParentDisplayReference: comment.immediateParentDisplayReference,
    boardEntryKind: "comment",
    boardGroupRootId: placement.rootId,
    boardIsRoot: placement.isRoot,
    boardOrder: placement.order,
    runState: comment.runState,
  };
}

function boardRunSegmentToClient(
  segment: BoardIssueRunSegmentEntry,
  scope: { companyId: string; issueId: string },
  placement: { rootId: string; order: number },
): ClientIssueComment {
  const body = segment.parts
    .map((part) => {
      if (part.type === "tool") return `${part.name} — ${part.status}`;
      return part.text;
    })
    .filter((part) => part.trim().length > 0)
    .join("\n\n");
  return {
    id: segment.id,
    companyId: scope.companyId,
    issueId: scope.issueId,
    authorType: "agent",
    authorAgentId: segment.author.agentId,
    authorUserId: null,
    authorPluginKey: null,
    body,
    presentation: null,
    metadata: null,
    createdAt: segment.createdAt,
    updatedAt: segment.updatedAt,
    canonicalSequence: segment.canonicalSequence,
    immediateParentDisplayReference: segment.immediateParentDisplayReference,
    boardEntryKind: "run_segment",
    boardGroupRootId: placement.rootId,
    boardIsRoot: false,
    boardOrder: placement.order,
    runState: segment.status === "working" ? "working" : "terminal",
  };
}

/**
 * Root pages arrive newest-first; each group is expanded atomically before the
 * next root so a late reply never scatters into a later unrelated root.
 */
export function flattenBoardIssueCommentGroupPages(
  pages: readonly BoardIssueCommentGroupPage[] | undefined,
  scope: { companyId: string; issueId: string },
  continuations?: ReadonlyMap<string, BoardIssueCommentGroupContinuation>,
): ClientIssueComment[] {
  const orderedGroups = (pages ?? [])
    .slice()
    .reverse()
    .flatMap((page) => [...page.groups].reverse());
  const comments: ClientIssueComment[] = [];
  let order = 0;
  for (const group of orderedGroups) {
    const groupComments: ClientIssueComment[] = [];
    groupComments.push(boardCommentToClient(group.root, scope, {
      rootId: group.root.id,
      isRoot: true,
      order: order++,
    }));
    const continuation = continuations?.get(group.root.id);
    const entriesByIdentity = new Map<string, BoardIssueThreadEntry>();
    for (const entry of [...group.entries, ...(continuation?.entries ?? [])]) {
      entriesByIdentity.set(`${entry.kind}:${entry.id}`, entry);
    }
    const expectedEntryCount = group.replyCount + group.runSegmentCount;
    const collapsed =
      group.entriesNextCursor !== null &&
      (continuation?.expanded !== true ||
        entriesByIdentity.size < expectedEntryCount);
    const entries = (collapsed ? [] : [...entriesByIdentity.values()]).sort((left, right) =>
        left.canonicalSequence - right.canonicalSequence ||
        left.id.localeCompare(right.id),
      );
    for (const entry of entries) {
      groupComments.push(entry.kind === "comment"
        ? boardCommentToClient(entry, scope, {
            rootId: group.root.id,
            isRoot: false,
            order: order++,
          })
        : boardRunSegmentToClient(entry, scope, {
            rootId: group.root.id,
            order: order++,
          }));
    }
    const nextCursor = continuation?.nextCursor ??
      (collapsed ? group.entriesNextCursor : null);
    const continuationTarget = groupComments.at(-1);
    if (
      continuationTarget &&
      (nextCursor || continuation?.loading || continuation?.error)
    ) {
      continuationTarget.boardGroupHasMore = Boolean(nextCursor);
      continuationTarget.boardGroupContinuationLoading =
        continuation?.loading === true;
      continuationTarget.boardGroupContinuationError =
        continuation?.error ?? null;
    }
    comments.push(...groupComments);
  }
  return comments;
}

export function takeOptimisticIssueComment(
  comments: OptimisticIssueComment[],
  clientId: string,
): { comments: OptimisticIssueComment[]; comment: OptimisticIssueComment | null } {
  const index = comments.findIndex((comment) => comment.clientId === clientId);
  if (index === -1) {
    return { comments, comment: null };
  }

  return {
    comments: comments.filter((comment) => comment.clientId !== clientId),
    comment: comments[index] ?? null,
  };
}

export function shouldAutoloadOlderIssueComments(params: {
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

export function upsertIssueComment<T extends ClientIssueComment>(
  comments: T[] | undefined,
  nextComment: T,
): T[] {
  const current = comments ?? [];
  const existingIndex = current.findIndex((comment) => comment.id === nextComment.id);
  if (existingIndex === -1) {
    return sortIssueComments([...current, nextComment]);
  }

  const updated = [...current];
  updated[existingIndex] = nextComment;
  return sortIssueComments(updated);
}

export function applyOptimisticIssueFieldUpdate(
  issue: Issue | undefined,
  data: Record<string, unknown>,
) {
  if (!issue) return issue;

  const nextIssue: Issue = {
    ...issue,
    updatedAt: new Date(),
  };
  const hasOwn = (key: string) => Object.prototype.hasOwnProperty.call(data, key);
  const assign = <K extends keyof Issue>(key: K) => {
    if (hasOwn(key)) {
      nextIssue[key] = data[key] as Issue[K];
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
    nextIssue.labelIds = nextLabelIds;
    if (issue.labels) {
      nextIssue.labels = issue.labels.filter((label) => nextLabelIds.includes(label.id));
    }
  }

  if (hasOwn("blockedByIssueIds") && Array.isArray(data.blockedByIssueIds) && issue.blockedBy) {
    const nextBlockedByIds = new Set(
      data.blockedByIssueIds.filter((value): value is string => typeof value === "string"),
    );
    nextIssue.blockedBy = issue.blockedBy.filter((relation) => nextBlockedByIds.has(relation.id));
  }

  if (hasOwn("projectId")) {
    nextIssue.project = issue.project?.id === nextIssue.projectId ? issue.project : null;
  }

  if (hasOwn("parentId")) {
    nextIssue.ancestors = undefined;
  }

  return nextIssue;
}

export function matchesIssueRef(
  issue: Pick<Issue, "id" | "identifier">,
  refs: Iterable<string>,
) {
  const refSet = refs instanceof Set ? refs : new Set(refs);
  return refSet.has(issue.id) || (!!issue.identifier && refSet.has(issue.identifier));
}

export function applyOptimisticIssueFieldUpdateToCollection(
  issues: Issue[] | undefined,
  refs: Iterable<string>,
  data: Record<string, unknown>,
) {
  if (!issues) return issues;

  let changed = false;
  const nextIssues = issues.map((issue) => {
    if (!matchesIssueRef(issue, refs)) return issue;
    changed = true;
    return applyOptimisticIssueFieldUpdate(issue, data) ?? issue;
  });

  return changed ? nextIssues : issues;
}
