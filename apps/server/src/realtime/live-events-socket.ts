import type { IncomingMessage, Server as HttpServer } from "node:http";
import { and, eq, gt } from "drizzle-orm";
import { Server, type Socket } from "socket.io";
import { type Db, authSessions, companyMemberships, instanceUserRoles } from "@paperclipai/db";
import {
  LIVE_EVENT_SOCKET_EVENT,
  LIVE_EVENT_SOCKET_PATH,
  isCanonicalUuid,
  type LiveEvent,
  type LiveEventClientToServerEvents,
  type LiveEventServerToClientEvents,
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
    resolveSessionFromHeaders?: (headers: Headers) => Promise<BetterAuthSessionResult | null>;
    requestAuthorityBoundary: RequestAuthorityBoundary;
  },
): Promise<LiveEventsSocketData | null> {
  if (!req.paperclipLiveEventsAuthority || !opts.resolveSessionFromHeaders) {
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

function disconnectAtSessionExpiry(socket: LiveEventsSocket): void {
  let timer: NodeJS.Timeout | null = null;
  const schedule = () => {
    const remaining = socket.data.sessionExpiresAt.getTime() - Date.now();
    if (remaining <= 0) {
      socket.disconnect(true);
      return;
    }
    timer = setTimeout(schedule, Math.min(remaining, MAX_TIMER_DELAY_MS));
    timer.unref();
  };
  socket.once("disconnect", () => {
    if (timer) clearTimeout(timer);
  });
  schedule();
}

async function deliverAuthorizedEvent(io: LiveEventsSocketServer, db: Db, event: LiveEvent): Promise<void> {
  const sockets = await io.in(companyRoomName(event.companyId)).fetchSockets();
  await Promise.all(
    sockets.map(async (socket) => {
      try {
        const authorization = await loadSocketAuthorization(db, socket.data);
        if (!authorization) {
          socket.disconnect(true);
          return;
        }
        socket.data.companyId = authorization.companyId;
        socket.data.sessionExpiresAt = authorization.sessionExpiresAt;
        socket.data.sessionId = authorization.sessionId;
        socket.data.userId = authorization.userId;
        socket.emit(LIVE_EVENT_SOCKET_EVENT, event);
      } catch (error) {
        socket.disconnect(true);
        throw error;
      }
    }),
  );
}

interface LiveEventsSocketServerHandle {
  close(): Promise<void>;
}

export function setupLiveEventsSocketServer(
  server: HttpServer,
  db: Db,
  opts: {
    resolveSessionFromHeaders?: (headers: Headers) => Promise<BetterAuthSessionResult | null>;
    requestAuthorityBoundary: RequestAuthorityBoundary;
  },
): LiveEventsSocketServerHandle {
  const io: LiveEventsSocketServer = new Server(server, {
    path: LIVE_EVENT_SOCKET_PATH,
    addTrailingSlash: false,
    perMessageDeflate: false,
    serveClient: false,
    transports: ["websocket"],
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
      disconnectAtSessionExpiry(socket);
      next();
    } catch (error) {
      logger.error({ err: error }, "live Socket.IO authorization failed");
      next(new Error("forbidden"));
    }
  });

  const deliveryTailByCompany = new Map<string, Promise<void>>();
  const unsubscribe = subscribeLiveEvents((event) => {
    const previous = deliveryTailByCompany.get(event.companyId) ?? Promise.resolve();
    const delivery = previous.catch(() => undefined).then(() => deliverAuthorizedEvent(io, db, event));
    deliveryTailByCompany.set(event.companyId, delivery);
    void delivery
      .catch((error) => {
        logger.error(
          { err: error, companyId: event.companyId, eventType: event.type },
          "live Socket.IO delivery authorization failed",
        );
      })
      .finally(() => {
        if (deliveryTailByCompany.get(event.companyId) === delivery) {
          deliveryTailByCompany.delete(event.companyId);
        }
      });
  });

  let closePromise: Promise<void> | null = null;
  return {
    close() {
      closePromise ??= (async () => {
        unsubscribe();
        await Promise.allSettled([...deliveryTailByCompany.values()]);
        await io.close();
      })();
      return closePromise;
    },
  };
}
