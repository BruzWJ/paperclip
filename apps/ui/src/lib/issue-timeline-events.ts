import type { ActivityEvent } from "@paperclipai/shared";

export interface IssueTimelineOwner {
  ownerKind: "agent" | "user" | "board";
  ownerAgentId: string | null;
  ownerUserId: string | null;
}

export interface IssueTimelineEvent {
  id: string;
  createdAt: Date | string;
  actorType: ActivityEvent["actorType"];
  actorId: string;
  runId?: string | null;
  lifecycleStatusChange?: {
    from: string | null;
    to: string | null;
  };
  ownerChange?: {
    from: IssueTimelineOwner;
    to: IssueTimelineOwner;
  };
  workspaceChange?: {
    from: IssueTimelineWorkspace;
    to: IssueTimelineWorkspace;
  };
  commentId?: string | null;
  followUpRequested?: boolean;
}

export interface IssueTimelineWorkspace {
  label: string | null;
  projectWorkspaceId: string | null;
  executionWorkspaceId: string | null;
  mode: string | null;
}

export function formatTimelineWorkspaceLabel(workspace: IssueTimelineWorkspace) {
  const fallbackId = workspace.executionWorkspaceId ?? workspace.projectWorkspaceId;
  return workspace.label ?? (fallbackId ? fallbackId.slice(0, 8) : "None");
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

function sameOwner(left: IssueTimelineOwner, right: IssueTimelineOwner) {
  return left.ownerKind === right.ownerKind
    && left.ownerAgentId === right.ownerAgentId
    && left.ownerUserId === right.ownerUserId;
}

function ownerFromRecord(value: unknown): IssueTimelineOwner | null {
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

function sameWorkspace(left: IssueTimelineWorkspace, right: IssueTimelineWorkspace) {
  return left.projectWorkspaceId === right.projectWorkspaceId
    && left.executionWorkspaceId === right.executionWorkspaceId
    && left.mode === right.mode
    && left.label === right.label;
}

function workspaceFromRecord(value: unknown): IssueTimelineWorkspace | null {
  const record = asRecord(value);
  if (!record) return null;
  return {
    label: nullableString(record.label),
    projectWorkspaceId: nullableString(record.projectWorkspaceId),
    executionWorkspaceId: nullableString(record.executionWorkspaceId),
    mode: nullableString(record.mode),
  };
}

function workspaceChangeFromDetails(details: Record<string, unknown>) {
  const change = asRecord(details.workspaceChange);
  if (!change) return null;
  const from = workspaceFromRecord(change.from);
  const to = workspaceFromRecord(change.to);
  if (!from || !to || sameWorkspace(from, to)) return null;
  return { from, to };
}

function sortTimelineEvents<T extends { createdAt: Date | string; id: string }>(events: T[]) {
  return [...events].sort((a, b) => {
    const createdAtDiff = toTimestamp(a.createdAt) - toTimestamp(b.createdAt);
    if (createdAtDiff !== 0) return createdAtDiff;
    return a.id.localeCompare(b.id);
  });
}

export function extractIssueTimelineEvents(activity: ActivityEvent[] | null | undefined): IssueTimelineEvent[] {
  const events: IssueTimelineEvent[] = [];

  for (const event of activity ?? []) {
    const details = asRecord(event.details);
    if (!details) continue;

    if (event.action === "issue.comment_added") {
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

    if (event.action !== "issue.updated") continue;

    const previous = asRecord(details._previous);
    const timelineEvent: IssueTimelineEvent = {
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

    const workspaceChange = workspaceChangeFromDetails(details);
    if (workspaceChange) {
      timelineEvent.workspaceChange = workspaceChange;
    }

    if (
      timelineEvent.lifecycleStatusChange
      || timelineEvent.ownerChange
      || timelineEvent.workspaceChange
      || timelineEvent.followUpRequested
    ) {
      events.push(timelineEvent);
    }
  }

  return sortTimelineEvents(events);
}
