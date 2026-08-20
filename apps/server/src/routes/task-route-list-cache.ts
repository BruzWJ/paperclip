import { type CompactTask } from "@paperclipai/shared";
import { type Request } from "express";
import { createHash } from "node:crypto";
import type { InternalTaskRuntimeFields } from "./task-route-subtree.js";

export function toPublicTask<T extends object>(task: T): Omit<T, keyof InternalTaskRuntimeFields> {
  const {
    executionWorkspaceId: _executionWorkspaceId,
    currentExecutionWorkspace: _currentExecutionWorkspace,
    ...publicTask
  } = task as T & InternalTaskRuntimeFields;
  return publicTask as Omit<T, keyof InternalTaskRuntimeFields>;
}

export function toCompactTask(
  task: Omit<CompactTask, "workMode" | "priority" | "originKind"> & {
    workMode: string;
    priority: string;
    originKind: string | null;
  } & InternalTaskRuntimeFields,
): CompactTask {
  return {
    id: task.id,
    companyId: task.companyId,
    projectId: task.projectId,
    projectWorkspaceId: task.projectWorkspaceId,
    goalId: task.goalId,
    parentId: task.parentId,
    title: task.title,
    request: task.request,
    boardPresentationStatus: task.boardPresentationStatus,
    lifecycleStatus: task.lifecycleStatus,
    disposition: task.disposition,
    workMode: task.workMode as CompactTask["workMode"],
    priority: task.priority as CompactTask["priority"],
    ownerKind: task.ownerKind,
    ownerAgentId: task.ownerAgentId,
    ownerUserId: task.ownerUserId,
    ownershipEpoch: task.ownershipEpoch,
    creatorKind: task.creatorKind,
    creatorAuthorityId: task.creatorAuthorityId,
    creatorAdapterConfigRevisionId: task.creatorAdapterConfigRevisionId,
    creatorUserId: task.creatorUserId,
    creatorPluginInstallationId: task.creatorPluginInstallationId,
    creatorPluginKey: task.creatorPluginKey,
    creatorCallbackKey: task.creatorCallbackKey,
    creatorCallbackVersion: task.creatorCallbackVersion,
    creatorRoutineId: task.creatorRoutineId,
    creatorRoutineDispatchId: task.creatorRoutineDispatchId,
    creatorSystemSourceKind: task.creatorSystemSourceKind,
    creatorSystemSourceId: task.creatorSystemSourceId,
    taskNumber: task.taskNumber,
    identifier: task.identifier,
    originKind: task.originKind as CompactTask["originKind"],
    originId: task.originId,
    originRunId: task.originRunId,
    requestDepth: task.requestDepth,
    billingCode: task.billingCode,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    cancelledAt: task.cancelledAt,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    ...(task.labelIds ? { labelIds: task.labelIds } : {}),
    ...(task.labels ? { labels: task.labels } : {}),
    ...(task.blockedBy ? { blockedBy: task.blockedBy } : {}),
    ...(task.blockerAttention ? { blockerAttention: task.blockerAttention } : {}),
    ...(task.blockedInboxAttention !== undefined
      ? { blockedInboxAttention: task.blockedInboxAttention }
      : {}),
    ...(task.liveDescendantCount !== undefined ? { liveDescendantCount: task.liveDescendantCount } : {}),
    ...(task.myLastTouchAt !== undefined ? { myLastTouchAt: task.myLastTouchAt } : {}),
    ...(task.lastExternalCommentAt !== undefined
      ? { lastExternalCommentAt: task.lastExternalCommentAt }
      : {}),
    ...(task.lastActivityAt !== undefined ? { lastActivityAt: task.lastActivityAt } : {}),
    ...(task.isUnreadForMe !== undefined ? { isUnreadForMe: task.isUnreadForMe } : {}),
  };
}

export function compactTaskListEtag(tasks: CompactTask[]): string {
  const hash = createHash("sha256").update(JSON.stringify(tasks)).digest("base64url");
  return `"compact-tasks:${hash}"`;
}

export function requestMatchesEtag(ifNoneMatchHeader: string | undefined, etag: string): boolean {
  if (!ifNoneMatchHeader) return false;
  return ifNoneMatchHeader
    .split(",")
    .map((value) => value.trim())
    .some((value) => value === "*" || value === etag || value === `W/${etag}`);
}

export const TASK_LIST_SERVER_CACHE_TTL_MS = 2_000;
export const TASK_LIST_SERVER_CACHE_STALE_MS = 5_000;
export const TASK_LIST_SERVER_CACHE_MAX_ENTRIES = 256;
export const TASK_LIST_STORM_WINDOW_MS = 500;
export const TASK_LIST_STORM_THRESHOLD = 4;
export const TASK_LIST_MAX_ACTOR_CLIENT_INFLIGHT = 8;
export const TASK_LIST_QUERY_KEYS = new Set([
  "attention",
  "descendantOf",
  "excludeRoutineExecutions",
  "hasPlanDocument",
  "inboxArchivedByUserId",
  "includeBlockedBy",
  "includeBlockedInboxAttention",
  "includeLiveDescendantSummary",
  "labelId",
  "limit",
  "offset",
  "originId",
  "originKind",
  "ownerAgentId",
  "ownerUserId",
  "parentId",
  "participantAgentId",
  "projectId",
  "q",
  "sortDir",
  "sortField",
  "status",
  "touchedByUserId",
  "unreadForUserId",
  "view",
]);

export type TaskListPreparedResponse =
  | {
      kind: "compact";
      body: CompactTask[];
      etag: string;
      cacheControl: string;
    }
  | {
      kind: "full";
      body: unknown[];
    };

export type TaskListCacheStatus = "miss" | "hit" | "coalesced" | "stale" | "retry";

export type TaskListStormEvent = {
  event: "request_storm_detected";
  route: string;
  companyId: string;
  actorType: string;
  actorIdentityHash: string;
  clientHash: string;
  cacheKeyHash: string;
  queryKeys: string[];
  identicalInFlightCount: number;
  windowMs: number;
  referer: string | null;
  visibilityHint: string | null;
};

export type TaskListDiagnostics = {
  onComputeStart?: (context: { companyId: string; cacheKeyHash: string }) => void | Promise<void>;
  onStormDetected?: (event: TaskListStormEvent) => void;
};

export type TaskListCacheEntry = {
  response: TaskListPreparedResponse;
  expiresAt: number;
  staleUntil: number;
};

export type TaskListInflightEntry = {
  promise: Promise<TaskListPreparedResponse>;
  startedAt: number;
  waiterCount: number;
  stormLogged: boolean;
};

export const taskListResponseCache = new Map<string, TaskListCacheEntry>();
export const taskListInflight = new Map<string, TaskListInflightEntry>();
export const taskListActorClientInflight = new Map<string, number>();

export function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("base64url").slice(0, 16);
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

export function normalizeTaskListCacheValue(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (Array.isArray(value)) {
    return value.map(normalizeTaskListCacheValue).sort((a, b) => stableJson(a).localeCompare(stableJson(b)));
  }
  if (typeof value === "object") {
    const normalized: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
      const next = normalizeTaskListCacheValue(nestedValue);
      if (next !== undefined) normalized[key] = next;
    }
    return normalized;
  }
  return value;
}

export function taskListActorIdentity(req: Request, companyId: string) {
  if (req.actor.type === "board") {
    const sessionPart =
      req.actor.source === "session"
        ? `cookie:${shortHash(String(req.headers.cookie ?? "no-cookie"))}`
        : req.actor.keyId;
    const key = ["board", companyId, req.actor.source, req.actor.userId, sessionPart].join(":");
    return { actorType: "board", key, hash: shortHash(key) };
  }

  const key = ["none", companyId, req.actor.source].join(":");
  return { actorType: "none", key, hash: shortHash(key) };
}

export function taskListClientIdentity(req: Request) {
  const forwardedFor = Array.isArray(req.headers["x-forwarded-for"])
    ? req.headers["x-forwarded-for"][0]
    : req.headers["x-forwarded-for"];
  const client = [
    String(forwardedFor ?? req.ip ?? "unknown-ip")
      .split(",")[0]
      ?.trim() ?? "unknown-ip",
    req.header("user-agent") ?? "unknown-agent",
  ].join(":");
  return { key: client, hash: shortHash(client) };
}

export function safeRefererPath(req: Request): string | null {
  const referer = req.header("referer");
  if (!referer) return null;
  try {
    return new URL(referer).pathname;
  } catch {
    return referer.split("?")[0]?.slice(0, 160) ?? null;
  }
}

export function taskListRequestKey(input: {
  req: Request;
  companyId: string;
  normalizedQuery: Record<string, unknown>;
}) {
  const route = "GET /api/companies/:companyId/tasks";
  const actor = taskListActorIdentity(input.req, input.companyId);
  const client = taskListClientIdentity(input.req);
  const normalizedQuery = normalizeTaskListCacheValue(input.normalizedQuery) as Record<string, unknown>;
  const queryKeys = Object.keys(normalizedQuery).sort();
  const key = stableJson({
    actor: actor.key,
    companyId: input.companyId,
    query: normalizedQuery,
    route,
  });
  return {
    actor,
    client,
    key,
    keyHash: shortHash(key),
    queryKeys,
    route,
  };
}

export function pruneTaskListResponseCache(now: number) {
  for (const [key, entry] of taskListResponseCache) {
    if (entry.staleUntil <= now) taskListResponseCache.delete(key);
  }
}

export function touchTaskListResponseCacheEntry(key: string, entry: TaskListCacheEntry) {
  taskListResponseCache.delete(key);
  taskListResponseCache.set(key, entry);
}

export function trimTaskListResponseCache() {
  while (taskListResponseCache.size > TASK_LIST_SERVER_CACHE_MAX_ENTRIES) {
    const oldestKey = taskListResponseCache.keys().next().value as string | undefined;
    if (oldestKey === undefined) return;
    taskListResponseCache.delete(oldestKey);
  }
}

export function setTaskListResponseCacheEntry(key: string, entry: TaskListCacheEntry) {
  touchTaskListResponseCacheEntry(key, entry);
  trimTaskListResponseCache();
}

export function decrementTaskListActorClientInflight(actorClientKey: string) {
  const next = (taskListActorClientInflight.get(actorClientKey) ?? 1) - 1;
  if (next <= 0) taskListActorClientInflight.delete(actorClientKey);
  else taskListActorClientInflight.set(actorClientKey, next);
}
