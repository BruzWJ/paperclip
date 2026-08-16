import type { ClientTaskComment } from "./optimistic-task-comments";
import type { TimestampedEntity } from "./presentation-contracts";

export type TaskChatComment = ClientTaskComment & {
  clientStatus?: "pending" | "queued";
};

export type TaskChatMessagePart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | {
      type: "tool-call";
      toolName: string;
      status: "pending" | "running" | "completed" | "error";
    };

/** Board transcript view-model consumed directly by AI Elements renderers. */
export interface TaskChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  createdAt: Date;
  content: TaskChatMessagePart[];
  status?: { type: "running" };
  metadata: { custom: Record<string, unknown> };
}

export interface StableThreadMessageCacheEntry {
  fingerprint: string;
  message: TaskChatMessage;
}

function toDate(value: Date | string) {
  return value instanceof Date ? value : new Date(value);
}

function toTimestamp(value: Date | string) {
  return toDate(value).getTime();
}

function fingerprintThreadMessage(message: TaskChatMessage) {
  return JSON.stringify(message);
}

export function stabilizeThreadMessages(
  messages: readonly TaskChatMessage[],
  previousMessages: readonly TaskChatMessage[],
  previousById: ReadonlyMap<string, StableThreadMessageCacheEntry>,
) {
  const nextById = new Map<string, StableThreadMessageCacheEntry>();
  let sameSequence = previousMessages.length === messages.length;

  const stabilizedMessages = messages.map((message, index) => {
    const fingerprint = fingerprintThreadMessage(message);
    const cached = previousById.get(message.id);
    const stableMessage = cached?.fingerprint === fingerprint ? cached.message : message;
    nextById.set(message.id, { fingerprint, message: stableMessage });
    if (sameSequence && previousMessages[index] !== stableMessage) {
      sameSequence = false;
    }
    return stableMessage;
  });

  return {
    messages: sameSequence ? previousMessages : stabilizedMessages,
    cache: nextById,
  };
}

function sortByCreated<T extends TimestampedEntity>(items: readonly T[]) {
  return [...items].sort((left, right) => {
    const timestampDifference = toTimestamp(left.createdAt) - toTimestamp(right.createdAt);
    return timestampDifference || left.id.localeCompare(right.id);
  });
}

function createRunSegmentContent(comment: TaskChatComment): TaskChatMessage["content"] | null {
  if (!comment.boardRunSegmentParts) return null;

  return comment.boardRunSegmentParts.map((part) => {
    if (part.type === "text") {
      return { type: "text", text: part.text };
    }
    if (part.type === "reasoning") {
      return { type: "reasoning", text: part.text };
    }
    return {
      type: "tool-call",
      toolName: part.name,
      status: part.status,
    };
  });
}

function authorNameForComment(comment: TaskChatComment) {
  const projectedLabel = comment.authorLabel?.trim();
  if (projectedLabel) return projectedLabel;
  if (comment.authorType === "system") return "Paperclip";
  if (comment.authorType === "plugin") return "Plugin";
  if (comment.authorAgentId) return comment.authorAgentId.slice(0, 8);
  return "You";
}

function createCommentMessage(comment: TaskChatComment): TaskChatMessage {
  const isSystemNotice = comment.authorType === "system";
  const isRunProgress = comment.presentation?.kind === "run_progress";
  const custom = {
    kind: isSystemNotice
      ? "system_notice"
      : isRunProgress
        ? "run-progress"
        : comment.boardEntryKind === "run_segment"
          ? "run-segment"
          : "comment",
    commentId: comment.id,
    anchorId: `comment-${comment.id}`,
    authorName: authorNameForComment(comment),
    authorType: comment.authorType,
    authorAgentId: comment.authorAgentId,
    authorUserId: comment.authorUserId,
    clientStatus: comment.clientStatus ?? null,
    presentation: comment.presentation ?? null,
    commentMetadata: comment.metadata ?? null,
    sourceTrust: comment.sourceTrust ?? null,
    boardGroupRootId: comment.boardGroupRootId ?? null,
    boardGroupHasMore: comment.boardGroupHasMore === true,
    boardGroupContinuationLoading: comment.boardGroupContinuationLoading === true,
    boardGroupContinuationError: comment.boardGroupContinuationError ?? null,
    immediateParentDisplayReference: comment.immediateParentDisplayReference ?? null,
    canReply: comment.boardEntryKind === "comment" && !comment.clientStatus,
  };
  const contentText =
    isRunProgress && comment.body.length === 0
      ? comment.runState === "queued"
        ? "Queued…"
        : comment.runState === "working"
          ? "Working…"
          : comment.body
      : comment.body;
  const createdAt = toDate(comment.createdAt);

  if (isSystemNotice) {
    const message: TaskChatMessage = {
      id: comment.id,
      role: "system",
      createdAt,
      content: [{ type: "text", text: contentText }],
      metadata: { custom },
    };
    return message;
  }
  if (comment.authorAgentId || comment.authorType === "plugin") {
    const runSegmentContent = createRunSegmentContent(comment);
    const message: TaskChatMessage = {
      id: comment.id,
      role: "assistant",
      createdAt,
      content: runSegmentContent ?? [{ type: "text", text: contentText }],
      status:
        comment.authorAgentId && (comment.runState === "queued" || comment.runState === "working")
          ? { type: "running" }
          : undefined,
      metadata: { custom },
    };
    return message;
  }
  const message: TaskChatMessage = {
    id: comment.id,
    role: "user",
    createdAt,
    content: [{ type: "text", text: contentText }],
    metadata: { custom },
  };
  return message;
}

export function buildTaskChatMessages(args: { comments: readonly TaskChatComment[] }) {
  const { comments } = args;
  const hasGroupedBoardProjection = comments.some((comment) => comment.boardOrder !== undefined);
  const orderedComments = hasGroupedBoardProjection
    ? [...comments].sort(
        (left, right) => (left.boardOrder ?? 0) - (right.boardOrder ?? 0) || left.id.localeCompare(right.id),
      )
    : sortByCreated(comments);
  const seenIds = new Set<string>();
  return orderedComments.map(createCommentMessage).filter((message) => {
    if (seenIds.has(message.id)) return false;
    seenIds.add(message.id);
    return true;
  });
}
