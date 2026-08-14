import type {
  ThreadAssistantMessage,
  ThreadMessage,
  ThreadSystemMessage,
  ThreadUserMessage,
} from "@assistant-ui/react";
import type { Agent } from "@paperclipai/shared";
import type { ClientTaskComment } from "./optimistic-task-comments";
import { formatOwnerUserLabel } from "./task-owners";
import type { TaskTimelineEvent } from "./task-timeline-events";
import type { TimestampedEntity } from "./presentation-contracts";

export type TaskChatComment = ClientTaskComment & {
  runAgentId?: string | null;
  interruptedRunId?: string | null;
  clientId?: string;
  clientStatus?: "pending" | "queued";
  queueState?: "queued";
  queueTargetRunId?: string | null;
  queueReason?: "hold" | "active_run" | "other";
  followUpRequested?: boolean;
};

type MessageWithOrder = {
  createdAtMs: number;
  order: number;
  message: ThreadMessage;
};

export interface StableThreadMessageCacheEntry {
  fingerprint: string;
  message: ThreadMessage;
}

function toDate(value: Date | string | null | undefined) {
  return value instanceof Date ? value : new Date(value ?? Date.now());
}

function toTimestamp(value: Date | string | null | undefined) {
  return toDate(value).getTime();
}

function fingerprintThreadMessage(message: ThreadMessage) {
  return JSON.stringify(message);
}

export function stabilizeThreadMessages(
  messages: readonly ThreadMessage[],
  previousMessages: readonly ThreadMessage[],
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

function createAssistantMetadata(custom: Record<string, unknown>) {
  return {
    unstable_state: null,
    unstable_annotations: [],
    unstable_data: [],
    steps: [],
    custom,
  } as const;
}

function authorNameForComment(
  comment: TaskChatComment,
  agentMap?: Map<string, Agent>,
  currentUserId?: string | null,
  userLabelMap?: ReadonlyMap<string, string> | null,
) {
  if (comment.authorAgentId) {
    return (
      agentMap?.get(comment.authorAgentId)?.name ??
      (comment.authorType === "system" ? "Paperclip" : comment.authorAgentId.slice(0, 8))
    );
  }
  if (!comment.authorUserId) {
    return comment.authorType === "system" ? "Paperclip" : "You";
  }
  return (
    userLabelMap?.get(comment.authorUserId)?.trim() ||
    formatOwnerUserLabel(comment.authorUserId, currentUserId, userLabelMap) ||
    "You"
  );
}

function createCommentMessage(args: {
  comment: TaskChatComment;
  agentMap?: Map<string, Agent>;
  currentUserId?: string | null;
  userLabelMap?: ReadonlyMap<string, string> | null;
  companyId?: string | null;
  projectId?: string | null;
}): ThreadMessage {
  const { comment, agentMap, currentUserId, userLabelMap, companyId, projectId } = args;
  const isSystemNotice = comment.authorType === "system";
  const isRunProgress = comment.presentation?.kind === "run_progress";
  const authorName = authorNameForComment(comment, agentMap, currentUserId, userLabelMap);
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
    authorName,
    authorType: comment.authorType,
    authorAgentId: comment.authorAgentId,
    authorUserId: comment.authorUserId,
    companyId: companyId ?? comment.companyId,
    projectId: projectId ?? null,
    runId: comment.runId ?? null,
    runAgentId: comment.runAgentId ?? comment.authorAgentId,
    clientStatus: comment.clientStatus ?? null,
    queueState: comment.queueState ?? null,
    queueTargetRunId: comment.queueTargetRunId ?? null,
    queueReason: comment.queueReason ?? null,
    interruptedRunId: comment.interruptedRunId ?? null,
    followUpRequested: comment.followUpRequested === true,
    presentation: comment.presentation ?? null,
    commentMetadata: comment.metadata ?? null,
    sourceTrust: comment.sourceTrust ?? null,
    runState: comment.runState ?? null,
    boardEntryKind: comment.boardEntryKind ?? null,
    boardGroupRootId: comment.boardGroupRootId ?? null,
    boardIsRoot: comment.boardIsRoot === true,
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
          : "Run finished"
      : comment.body;
  const createdAt = toDate(comment.createdAt);

  if (isSystemNotice) {
    const message: ThreadSystemMessage = {
      id: comment.id,
      role: "system",
      createdAt,
      content: [{ type: "text", text: contentText }],
      metadata: { custom },
    };
    return message;
  }
  if (comment.authorAgentId) {
    const message: ThreadAssistantMessage = {
      id: comment.id,
      role: "assistant",
      createdAt,
      content: [{ type: "text", text: contentText }],
      status:
        comment.runState === "queued" || comment.runState === "working"
          ? { type: "running" }
          : { type: "complete", reason: "stop" },
      metadata: createAssistantMetadata(custom),
    };
    return message;
  }
  const message: ThreadUserMessage = {
    id: comment.id,
    role: "user",
    createdAt,
    content: [{ type: "text", text: contentText }],
    attachments: [],
    metadata: { custom },
  };
  return message;
}

function createTimelineEventMessage(args: {
  event: TaskTimelineEvent;
  agentMap?: Map<string, Agent>;
  currentUserId?: string | null;
  userLabelMap?: ReadonlyMap<string, string> | null;
}) {
  const { event, agentMap, currentUserId, userLabelMap } = args;
  const actorName =
    event.actorType === "agent"
      ? (agentMap?.get(event.actorId)?.name ?? event.actorId.slice(0, 8))
      : event.actorType === "system"
        ? "System"
        : (formatOwnerUserLabel(event.actorId, currentUserId, userLabelMap) ?? "Board");
  const lines = [
    event.followUpRequested ? `${actorName} requested follow-up` : `${actorName} updated this task`,
  ];
  if (event.lifecycleStatusChange) {
    lines.push(
      `Lifecycle: ${event.lifecycleStatusChange.from ?? "none"} -> ${event.lifecycleStatusChange.to ?? "none"}`,
    );
  }
  if (event.ownerChange) {
    const ownerLabel = (owner: typeof event.ownerChange.from) =>
      owner.ownerAgentId
        ? (agentMap?.get(owner.ownerAgentId)?.name ?? owner.ownerAgentId.slice(0, 8))
        : (formatOwnerUserLabel(owner.ownerUserId, currentUserId, userLabelMap) ?? "Board escalation");
    lines.push(`Owner: ${ownerLabel(event.ownerChange.from)} -> ${ownerLabel(event.ownerChange.to)}`);
  }
  const message: ThreadSystemMessage = {
    id: `activity:${event.id}`,
    role: "system",
    createdAt: toDate(event.createdAt),
    content: [{ type: "text", text: lines.join("\n") }],
    metadata: {
      custom: {
        kind: "event",
        anchorId: `activity-${event.id}`,
        eventId: event.id,
        actorName,
        actorType: event.actorType,
        actorId: event.actorId,
        lifecycleStatusChange: event.lifecycleStatusChange ?? null,
        ownerChange: event.ownerChange ?? null,
        followUpRequested: event.followUpRequested === true,
      },
    },
  };
  return message;
}

export function isCoTSegmentActive(args: {
  isMessageRunning: boolean;
  segmentIndex: number;
  segmentCount: number;
}) {
  const { isMessageRunning, segmentIndex, segmentCount } = args;
  if (!isMessageRunning) return false;
  if (segmentCount <= 0 || segmentIndex < 0) return true;
  return segmentIndex === segmentCount - 1;
}

export function formatDurationWords(ms: number | null) {
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return null;
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds} second${totalSeconds === 1 ? "" : "s"}`;
  }
  const totalMinutes = Math.round(totalSeconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes} minute${totalMinutes === 1 ? "" : "s"}`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (minutes === 0) {
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return `${hours} hour${hours === 1 ? "" : "s"} ${minutes} minute${minutes === 1 ? "" : "s"}`;
}

export function buildTaskChatMessages(args: {
  comments: readonly TaskChatComment[];
  timelineEvents: readonly TaskTimelineEvent[];
  companyId?: string | null;
  projectId?: string | null;
  agentMap?: Map<string, Agent>;
  currentUserId?: string | null;
  userLabelMap?: ReadonlyMap<string, string> | null;
}) {
  const { comments, timelineEvents, companyId, projectId, agentMap, currentUserId, userLabelMap } = args;
  const orderedMessages: MessageWithOrder[] = [];
  const hasGroupedBoardProjection = comments.some((comment) => comment.boardOrder !== undefined);
  const orderedComments = hasGroupedBoardProjection
    ? [...comments].sort((left, right) => (left.boardOrder ?? 0) - (right.boardOrder ?? 0))
    : sortByCreated(comments);

  for (const comment of orderedComments) {
    orderedMessages.push({
      createdAtMs: hasGroupedBoardProjection ? (comment.boardOrder ?? 0) : toTimestamp(comment.createdAt),
      order: 1,
      message: createCommentMessage({
        comment,
        agentMap,
        currentUserId,
        userLabelMap,
        companyId,
        projectId,
      }),
    });
  }
  if (!hasGroupedBoardProjection) {
    for (const event of sortByCreated(timelineEvents)) {
      orderedMessages.push({
        createdAtMs: toTimestamp(event.createdAt),
        order: 0,
        message: createTimelineEventMessage({
          event,
          agentMap,
          currentUserId,
          userLabelMap,
        }),
      });
    }
  }
  const seenIds = new Set<string>();
  return orderedMessages
    .sort((left, right) => {
      const timeDifference = left.createdAtMs - right.createdAtMs;
      if (timeDifference) return timeDifference;
      const orderDifference = left.order - right.order;
      return orderDifference || left.message.id.localeCompare(right.message.id);
    })
    .map((entry) => entry.message)
    .filter((message) => {
      if (seenIds.has(message.id)) return false;
      seenIds.add(message.id);
      return true;
    });
}
