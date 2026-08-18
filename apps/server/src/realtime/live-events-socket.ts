import type { IncomingMessage, Server as HttpServer } from "node:http";
import { and, asc, eq, gt, or } from "drizzle-orm";
import { Server, type Socket } from "socket.io";
import {
  type Db,
  authSessions,
  companyMemberships,
  instanceUserRoles,
  taskExecutionRuns,
  taskSessionMessages,
} from "@paperclipai/db";
import {
  LIVE_EVENT_SOCKET_EVENT,
  LIVE_EVENT_SOCKET_PATH,
  LIVE_RUN_STREAM_SYNC_EVENT,
  isCanonicalUuid,
  type LiveEventClientToServerEvents,
  type LiveEventServerToClientEvents,
  type RunStreamSyncRequest,
  type RunStreamSyncResponse,
} from "@paperclipai/shared";
import type { BetterAuthSessionResult } from "../auth/better-auth.js";
import {
  canonicalizeBrowserOrigin,
  type RequestAuthority,
  type RequestAuthorityBoundary,
} from "../http/request-authority.js";
import { isNonEmptyActorId } from "../http/request-actor.js";
import { logger } from "../middleware/logger.js";
import { subscribeLiveEvents } from "../services/live-events.js";
import { runStreamAssistantMessageFromRow } from "../services/task-execution-run-stream.js";
import { projectRunEnvelope } from "../services/task-execution-run-service-part-2-section-1.js";
import { serializeTaskExecutionRunEnvelope } from "../services/task-execution-run-wire.js";

type LiveEventsInterServerEvents = Record<never, never>;

interface LiveEventsSocketData {
  companyId: string;
  sessionExpiresAt: Date;
  sessionId: string;
  userId: string;
}

type LiveEventsSocketServer = Server<
  LiveEventClientToServerEvents,
  LiveEventServerToClientEvents,
  LiveEventsInterServerEvents,
  LiveEventsSocketData
>;

type LiveEventsSocket = Socket<
  LiveEventClientToServerEvents,
  LiveEventServerToClientEvents,
  LiveEventsInterServerEvents,
  LiveEventsSocketData
>;

interface LiveEventsIncomingMessage extends IncomingMessage {
  paperclipLiveEventsAuthority?: RequestAuthority;
}

const CREDENTIAL_QUERY_KEYS = new Set([
  "access_token",
  "api-key",
  "api_key",
  "apikey",
  "authorization",
  "bearer",
  "token",
]);
function companyRoomName(companyId: string) {
  return `company:${companyId}`;
}

/** Bounded re-authorization cadence that replaces per-event DB re-checks. */
const SESSION_RECHECK_INTERVAL_MS = 60_000;
const CONNECTION_RECOVERY_WINDOW_MS = 2 * 60_000;
const RUN_STREAM_SYNC_PAGE_SIZE = 50;

function hasCredentialQuery(url: URL) {
  for (const key of url.searchParams.keys()) {
    if (CREDENTIAL_QUERY_KEYS.has(key.toLowerCase())) return true;
  }
  return false;
}

function parseCompanyIdFromAuth(auth: unknown) {
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) return null;
  const entries = Object.entries(auth as Record<string, unknown>);
  if (entries.length !== 1 || entries[0]?.[0] !== "companyId") return null;
  const companyId = entries[0][1];
  if (typeof companyId !== "string") return null;
  return isCanonicalUuid(companyId) ? companyId : null;
}

function admitHandshakeRequest(
  req: LiveEventsIncomingMessage,
  requestAuthorityBoundary: RequestAuthorityBoundary,
) {
  const authority = requestAuthorityBoundary.admit(req);
  const originHeader = req.headers.origin;
  const browserOrigin = Array.isArray(originHeader) ? null : canonicalizeBrowserOrigin(originHeader);
  if (browserOrigin !== authority.origin) return false;
  if (req.headers.authorization !== undefined) return false;

  const url = new URL(req.url ?? LIVE_EVENT_SOCKET_PATH, authority.origin);
  if (hasCredentialQuery(url)) return false;

  req.paperclipLiveEventsAuthority = authority;
  return true;
}

async function authorizeSocket(
  db: Db,
  req: LiveEventsIncomingMessage,
  auth: unknown,
  opts: {
    resolveSessionFromHeaders: (headers: Headers) => Promise<BetterAuthSessionResult | null>;
    requestAuthorityBoundary: RequestAuthorityBoundary;
  },
): Promise<LiveEventsSocketData | null> {
  if (!req.paperclipLiveEventsAuthority) {
    return null;
  }
  const companyId = parseCompanyIdFromAuth(auth);
  if (!companyId) return null;

  const session = await opts.resolveSessionFromHeaders(opts.requestAuthorityBoundary.headers(req));
  if (!(
    isNonEmptyActorId(session?.user?.id) &&
    isNonEmptyActorId(session.session?.id) &&
    isNonEmptyActorId(session.session.userId) &&
    session.session.userId === session.user.id
  )) {
    return null;
  }
  const userId = session.user.id;

  return loadSocketAuthorization(db, {
    companyId,
    sessionId: session.session.id,
    userId,
  });
}

async function loadSocketAuthorization(
  db: Db,
  identity: Pick<LiveEventsSocketData, "companyId" | "sessionId" | "userId">,
): Promise<LiveEventsSocketData | null> {
  const now = new Date();
  const [sessionRow, roleRow, membership] = await Promise.all([
    db
      .select({ expiresAt: authSessions.expiresAt })
      .from(authSessions)
      .where(
        and(
          eq(authSessions.id, identity.sessionId),
          eq(authSessions.userId, identity.userId),
          gt(authSessions.expiresAt, now),
        ),
      )
      .then((rows) => rows[0] ?? null),
    db
      .select({ id: instanceUserRoles.id })
      .from(instanceUserRoles)
      .where(and(eq(instanceUserRoles.userId, identity.userId), eq(instanceUserRoles.role, "instance_admin")))
      .then((rows) => rows[0] ?? null),
    db
      .select({ id: companyMemberships.id })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, identity.companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalUserId, identity.userId),
          eq(companyMemberships.status, "active"),
        ),
      )
      .then((rows) => rows[0] ?? null),
  ]);

  if (!sessionRow || (!roleRow && !membership)) return null;
  return {
    ...identity,
    sessionExpiresAt: sessionRow.expiresAt,
  };
}

const MAX_TIMER_DELAY_MS = 2_147_000_000;

function enforceSocketValidity(socket: LiveEventsSocket, db: Db, recheckIntervalMs: number): void {
  let timer: NodeJS.Timeout | undefined;
  let active = true;
  const schedule = (delayMs: number) => {
    if (!active) return;
    timer = setTimeout(check, Math.min(Math.max(delayMs, 1), MAX_TIMER_DELAY_MS));
    timer.unref();
  };
  const check = async () => {
    if (!active) return;
    const remaining = socket.data.sessionExpiresAt.getTime() - Date.now();
    if (remaining <= 0) {
      socket.disconnect(true);
      return;
    }
    try {
      const authorization = await loadSocketAuthorization(db, socket.data);
      if (!authorization) {
        socket.disconnect(true);
        return;
      }
      socket.data.sessionExpiresAt = authorization.sessionExpiresAt;
    } catch (error) {
      // Transient storage failure must not disconnect a healthy board socket;
      // the next tick re-checks.
      logger.warn({ err: error, socketId: socket.id }, "live Socket.IO validity recheck failed");
    }
    if (!active) return;
    schedule(Math.min(remaining, recheckIntervalMs));
  };
  socket.once("disconnect", () => {
    active = false;
    if (timer) clearTimeout(timer);
  });
  schedule(Math.min(Math.max(socket.data.sessionExpiresAt.getTime() - Date.now(), 1), recheckIntervalMs));
}

function isRunStreamSyncRequest(value: unknown): value is RunStreamSyncRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length !== 3) return false;
  const request = value as Record<string, unknown>;
  return (
    typeof request.runId === "string" &&
    isCanonicalUuid(request.runId) &&
    Number.isSafeInteger(request.afterSeq) &&
    (request.afterSeq as number) >= 0 &&
    typeof request.afterId === "string"
  );
}

async function synchronizeRunStream(
  socket: LiveEventsSocket,
  db: Db,
  request: RunStreamSyncRequest,
): Promise<RunStreamSyncResponse> {
  const [rows, runRow] = await Promise.all([
    db
      .select()
      .from(taskSessionMessages)
      .where(
        and(
          eq(taskSessionMessages.companyId, socket.data.companyId),
          eq(taskSessionMessages.runId, request.runId),
          eq(taskSessionMessages.type, "assistant"),
          or(
            gt(taskSessionMessages.modelStateSeq, request.afterSeq),
            and(
              eq(taskSessionMessages.modelStateSeq, request.afterSeq),
              gt(taskSessionMessages.id, request.afterId),
            ),
          ),
        ),
      )
      .orderBy(asc(taskSessionMessages.modelStateSeq), asc(taskSessionMessages.id))
      .limit(RUN_STREAM_SYNC_PAGE_SIZE + 1),
    db
      .select()
      .from(taskExecutionRuns)
      .where(
        and(eq(taskExecutionRuns.companyId, socket.data.companyId), eq(taskExecutionRuns.id, request.runId)),
      )
      .limit(1)
      .then((runRows) => runRows[0] ?? null),
  ]);
  const page = rows.slice(0, RUN_STREAM_SYNC_PAGE_SIZE);
  const last = page.at(-1);
  return {
    runId: request.runId,
    run: runRow ? serializeTaskExecutionRunEnvelope(projectRunEnvelope(runRow)) : null,
    messages: page.map(runStreamAssistantMessageFromRow),
    nextCursor:
      rows.length > RUN_STREAM_SYNC_PAGE_SIZE && last
        ? { afterSeq: last.modelStateSeq, afterId: last.id }
        : null,
  };
}

interface LiveEventsSocketServerHandle {
  close(): Promise<void>;
}

export function setupLiveEventsSocketServer(
  server: HttpServer,
  db: Db,
  opts: {
    resolveSessionFromHeaders: (headers: Headers) => Promise<BetterAuthSessionResult | null>;
    requestAuthorityBoundary: RequestAuthorityBoundary;
    /** Test seam: overrides the bounded session re-check cadence. */
    sessionRecheckIntervalMs?: number;
  },
): LiveEventsSocketServerHandle {
  const io: LiveEventsSocketServer = new Server(server, {
    path: LIVE_EVENT_SOCKET_PATH,
    addTrailingSlash: false,
    perMessageDeflate: false,
    serveClient: false,
    transports: ["websocket"],
    connectionStateRecovery: {
      maxDisconnectionDuration: CONNECTION_RECOVERY_WINDOW_MS,
      skipMiddlewares: false,
    },
    allowRequest(req, done) {
      try {
        done(null, admitHandshakeRequest(req, opts.requestAuthorityBoundary));
      } catch (error) {
        logger.warn({ err: error }, "live Socket.IO handshake rejected by request authority");
        done("forbidden", false);
      }
    },
  });

  io.use(async (socket, next) => {
    try {
      const authorization = await authorizeSocket(
        db,
        socket.request as LiveEventsIncomingMessage,
        socket.handshake.auth,
        opts,
      );
      if (!authorization) {
        next(new Error("forbidden"));
        return;
      }

      socket.data.companyId = authorization.companyId;
      socket.data.sessionExpiresAt = authorization.sessionExpiresAt;
      socket.data.sessionId = authorization.sessionId;
      socket.data.userId = authorization.userId;
      await socket.join(companyRoomName(authorization.companyId));
      enforceSocketValidity(socket, db, opts.sessionRecheckIntervalMs ?? SESSION_RECHECK_INTERVAL_MS);
      next();
    } catch (error) {
      logger.error({ err: error }, "live Socket.IO authorization failed");
      next(new Error("forbidden"));
    }
  });

  io.on("connection", (socket) => {
    socket.on(LIVE_RUN_STREAM_SYNC_EVENT, (request, acknowledge) => {
      if (!isRunStreamSyncRequest(request)) {
        socket.disconnect(true);
        return;
      }
      void synchronizeRunStream(socket, db, request)
        .then(acknowledge)
        .catch((error) => {
          logger.warn(
            { err: error, socketId: socket.id, runId: request.runId },
            "live run-stream synchronization failed",
          );
        });
    });
  });

  const unsubscribe = subscribeLiveEvents((event) => {
    io.to(companyRoomName(event.companyId)).emit(LIVE_EVENT_SOCKET_EVENT, event);
  });

  let closePromise: Promise<void> | null = null;
  return {
    close() {
      closePromise ??= (async () => {
        unsubscribe();
        await io.close();
      })();
      return closePromise;
    },
  };
}
