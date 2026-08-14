import type { ActivityEvent } from "@paperclipai/shared";
import type { TaskOwnerReference, TimestampedEntity } from "@/lib/presentation-contracts";

export type TaskTimelineOwner = TaskOwnerReference;

export interface TaskTimelineStatusChange {
  from: string | null;
  to: string | null;
}

export interface TaskTimelineOwnerChange {
  from: TaskTimelineOwner;
  to: TaskTimelineOwner;
}

export interface TaskTimelineEvent {
  id: string;
  createdAt: Date | string;
  actorType: ActivityEvent["actorType"];
  actorId: string;
  runId?: string | null;
  lifecycleStatusChange?: TaskTimelineStatusChange;
  ownerChange?: TaskTimelineOwnerChange;
  commentId?: string | null;
  followUpRequested?: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function hasOwn(record: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function toTimestamp(value: Date | string) {
  return new Date(value).getTime();
}

function sameOwner(left: TaskTimelineOwner, right: TaskTimelineOwner) {
  return (
    left.ownerKind === right.ownerKind &&
    left.ownerAgentId === right.ownerAgentId &&
    left.ownerUserId === right.ownerUserId
  );
}

function ownerFromRecord(value: unknown): TaskTimelineOwner | null {
  const record = asRecord(value);
  if (!record) return null;
  const ownerKind = record.ownerKind;
  const ownerAgentId = nullableString(record.ownerAgentId);
  const ownerUserId = nullableString(record.ownerUserId);
  if (ownerKind === "agent" && ownerAgentId && ownerUserId === null) {
    return { ownerKind, ownerAgentId, ownerUserId: null };
  }
  if (ownerKind === "user" && ownerAgentId === null && ownerUserId) {
    return { ownerKind, ownerAgentId: null, ownerUserId };
  }
  if (ownerKind === "board" && ownerAgentId === null && ownerUserId === null) {
    return { ownerKind, ownerAgentId: null, ownerUserId: null };
  }
  return null;
}

function sortTimelineEvents<T extends TimestampedEntity>(events: T[]) {
  return [...events].sort((a, b) => {
    const createdAtDiff = toTimestamp(a.createdAt) - toTimestamp(b.createdAt);
    if (createdAtDiff !== 0) return createdAtDiff;
    return a.id.localeCompare(b.id);
  });
}

export function extractTaskTimelineEvents(activity: ActivityEvent[] | null | undefined): TaskTimelineEvent[] {
  const events: TaskTimelineEvent[] = [];

  for (const event of activity ?? []) {
    const details = asRecord(event.details);
    if (!details) continue;

    if (event.action === "task.comment_added") {
      if (details.followUpRequested !== true && details.resumeIntent !== true) continue;
      if (details.reopened === true) continue;
      const commentId = nullableString(details.commentId);
      events.push({
        id: event.id,
        createdAt: event.createdAt,
        actorType: event.actorType,
        actorId: event.actorId,
        runId: event.runId ?? null,
        commentId,
        followUpRequested: true,
      });
      continue;
    }

    if (event.action !== "task.updated") continue;

    const previous = asRecord(details._previous);
    const timelineEvent: TaskTimelineEvent = {
      id: event.id,
      createdAt: event.createdAt,
      actorType: event.actorType,
      actorId: event.actorId,
      runId: event.runId ?? null,
    };
    if (details.followUpRequested === true || details.resumeIntent === true) {
      timelineEvent.followUpRequested = true;
      timelineEvent.commentId = nullableString(details.commentId);
    }

    if (hasOwn(details, "lifecycleStatus")) {
      const from = nullableString(previous?.lifecycleStatus);
      const to = nullableString(details.lifecycleStatus);
      if (from !== to) {
        timelineEvent.lifecycleStatusChange = { from, to };
      }
    }

    if (hasOwn(details, "ownerKind") || hasOwn(details, "ownerAgentId") || hasOwn(details, "ownerUserId")) {
      const previousOwner = ownerFromRecord(previous);
      const nextOwner = ownerFromRecord(details);
      if (previousOwner && nextOwner && !sameOwner(previousOwner, nextOwner)) {
        timelineEvent.ownerChange = {
          from: previousOwner,
          to: nextOwner,
        };
      }
    }

    if (timelineEvent.lifecycleStatusChange || timelineEvent.ownerChange || timelineEvent.followUpRequested) {
      events.push(timelineEvent);
    }
  }

  return sortTimelineEvents(events);
}
