import { type Request, type Response } from "express";
import { conflict, forbidden, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { OrdinaryTaskRuntimeRejected } from "../services/index.js";
import { assertBoard } from "./authz.js";
import * as listCache from "./task-route-list-cache.js";

export async function coordinateTaskListGet(input: {
  req: Request;
  companyId: string;
  requestKey: ReturnType<typeof listCache.taskListRequestKey>;
  allowTtlCache: boolean;
  diagnostics?: listCache.TaskListDiagnostics;
  compute: () => Promise<listCache.TaskListPreparedResponse>;
}): Promise<{
  response: listCache.TaskListPreparedResponse | null;
  cacheStatus: listCache.TaskListCacheStatus;
  identicalInFlightCount: number;
  retryAfterSeconds?: number;
}> {
  const now = Date.now();
  listCache.pruneTaskListResponseCache(now);

  const cached = input.allowTtlCache ? listCache.taskListResponseCache.get(input.requestKey.key) : undefined;
  if (cached && cached.expiresAt > now) {
    listCache.touchTaskListResponseCacheEntry(input.requestKey.key, cached);
    return {
      response: cached.response,
      cacheStatus: "hit",
      identicalInFlightCount: 0,
    };
  }

  const existing = listCache.taskListInflight.get(input.requestKey.key);
  if (existing) {
    existing.waiterCount += 1;
    const identicalInFlightCount = existing.waiterCount + 1;
    if (
      !existing.stormLogged &&
      identicalInFlightCount >= listCache.TASK_LIST_STORM_THRESHOLD &&
      now - existing.startedAt <= listCache.TASK_LIST_STORM_WINDOW_MS
    ) {
      existing.stormLogged = true;
      const event: listCache.TaskListStormEvent = {
        event: "request_storm_detected",
        route: input.requestKey.route,
        companyId: input.companyId,
        actorType: input.requestKey.actor.actorType,
        actorIdentityHash: input.requestKey.actor.hash,
        clientHash: input.requestKey.client.hash,
        cacheKeyHash: input.requestKey.keyHash,
        queryKeys: input.requestKey.queryKeys,
        identicalInFlightCount,
        windowMs: now - existing.startedAt,
        referer: listCache.safeRefererPath(input.req),
        visibilityHint: input.req.header("x-paperclip-tab-visible") ?? null,
      };
      logger.warn(event, "request_storm_detected");
      input.diagnostics?.onStormDetected?.(event);
    }
    const response = await existing.promise;
    return { response, cacheStatus: "coalesced", identicalInFlightCount };
  }

  const actorClientKey = `${input.requestKey.actor.key}:${input.requestKey.client.key}`;
  const actorClientInflight = listCache.taskListActorClientInflight.get(actorClientKey) ?? 0;
  if (actorClientInflight >= listCache.TASK_LIST_MAX_ACTOR_CLIENT_INFLIGHT) {
    if (cached && cached.staleUntil > now) {
      listCache.touchTaskListResponseCacheEntry(input.requestKey.key, cached);
      return {
        response: cached.response,
        cacheStatus: "stale",
        identicalInFlightCount: 0,
      };
    }
    return {
      response: null,
      cacheStatus: "retry",
      identicalInFlightCount: 0,
      retryAfterSeconds: 1,
    };
  }

  listCache.taskListActorClientInflight.set(actorClientKey, actorClientInflight + 1);
  const promise = (async () => {
    await input.diagnostics?.onComputeStart?.({
      companyId: input.companyId,
      cacheKeyHash: input.requestKey.keyHash,
    });
    return input.compute();
  })();
  const inflightEntry: listCache.TaskListInflightEntry = {
    promise,
    startedAt: now,
    waiterCount: 0,
    stormLogged: false,
  };
  listCache.taskListInflight.set(input.requestKey.key, inflightEntry);

  try {
    const response = await promise;
    if (input.allowTtlCache) {
      listCache.setTaskListResponseCacheEntry(input.requestKey.key, {
        response,
        expiresAt: Date.now() + listCache.TASK_LIST_SERVER_CACHE_TTL_MS,
        staleUntil: Date.now() + listCache.TASK_LIST_SERVER_CACHE_STALE_MS,
      });
    }
    return { response, cacheStatus: "miss", identicalInFlightCount: 1 };
  } finally {
    if (listCache.taskListInflight.get(input.requestKey.key) === inflightEntry) {
      listCache.taskListInflight.delete(input.requestKey.key);
    }
    listCache.decrementTaskListActorClientInflight(actorClientKey);
  }
}

export function estimatedJsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export function logTaskListRequest(input: {
  req: Request;
  res: Response;
  companyId: string;
  requestKey: ReturnType<typeof listCache.taskListRequestKey>;
  startedAt: number;
  cacheStatus: listCache.TaskListCacheStatus;
  bodyBytes: number;
  etagOutcome: "none" | "fresh" | "not_modified";
  identicalInFlightCount: number;
}) {
  input.res.once("finish", () => {
    const contentEncoding = input.res.getHeader("content-encoding");
    const contentLength = Number(input.res.getHeader("content-length"));
    logger.debug(
      {
        event: "safe_get_request_observed",
        route: input.requestKey.route,
        companyId: input.companyId,
        actorType: input.requestKey.actor.actorType,
        actorIdentityHash: input.requestKey.actor.hash,
        clientHash: input.requestKey.client.hash,
        cacheKeyHash: input.requestKey.keyHash,
        queryKeys: input.requestKey.queryKeys,
        requestCount: input.identicalInFlightCount,
        durationMs: Date.now() - input.startedAt,
        statusCode: input.res.statusCode,
        responseBytes: input.bodyBytes,
        compressedBytes: contentEncoding && Number.isFinite(contentLength) ? contentLength : null,
        contentEncoding: contentEncoding ? String(contentEncoding) : null,
        cacheStatus: input.cacheStatus,
        etagOutcome: input.etagOutcome,
        referer: listCache.safeRefererPath(input.req),
        visibilityHint: input.req.header("x-paperclip-tab-visible") ?? null,
      },
      "safe authenticated GET observed",
    );
  });
}

export function requireNamedBoardUser(req: Request): string {
  if (req.actor.type !== "board" || !req.actor.userId || req.actor.userId.trim() !== req.actor.userId) {
    throw forbidden("Task commands require an exact authenticated board user ID");
  }
  assertBoard(req);
  return req.actor.userId;
}

export function canonicalTaskMutationError(error: unknown): never {
  if (!(error instanceof OrdinaryTaskRuntimeRejected)) {
    throw error;
  }
  const details = { code: error.reason };
  if (error.reason === "creator_authority_mismatch") {
    throw forbidden(error.message, details);
  }
  if (error.reason === "owner_authority_invalid") {
    throw forbidden(error.message, details);
  }
  if (
    error.reason.endsWith("_idempotency_conflict") ||
    error.reason.endsWith("_lifecycle_conflict") ||
    error.reason === "task_form_conflict" ||
    error.reason === "reassignment_owner_unchanged" ||
    error.reason === "reassignment_target_invalid" ||
    error.reason === "human_mention_scope_invalid"
  ) {
    throw conflict(error.message, details);
  }
  throw unprocessable(error.message, details);
}
