import { createServer, type Server as HttpServer } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { io as connectSocket, type Socket } from "socket.io-client";
import {
  authSessions,
  companyMemberships,
  instanceUserRoles,
} from "@paperclipai/db";
import {
  LIVE_EVENT_SOCKET_EVENT,
  LIVE_EVENT_SOCKET_PATH,
  type LiveEvent,
} from "@paperclipai/shared";
import { setupLiveEventsSocketServer } from "../realtime/live-events-socket.js";
import { publishLiveEvent } from "../services/live-events.js";

const COMPANY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const TASK_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";

function authorizationDb() {
  const state = {
    sessionActive: true,
    instanceAdmin: false,
    membershipActive: true,
  };
  return {
    state,
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => {
          if (table === authSessions) {
            return Promise.resolve(
              state.sessionActive
                ? [{ expiresAt: new Date(Date.now() + 60_000) }]
                : [],
            );
          }
          if (table === instanceUserRoles) {
            return Promise.resolve(
              state.instanceAdmin ? [{ id: "role-1" }] : [],
            );
          }
          if (table === companyMemberships) {
            return Promise.resolve(
              state.membershipActive ? [{ id: "membership-1" }] : [],
            );
          }
          throw new Error("Unexpected authorization table");
        }),
      })),
    })),
  };
}

function closeHttpServer(server: HttpServer): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe("live Socket.IO native transport", () => {
  const sockets: Socket[] = [];
  const servers: HttpServer[] = [];
  const handles: Array<ReturnType<typeof setupLiveEventsSocketServer>> = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    await Promise.all(handles.splice(0).map((handle) => handle.close()));
    await Promise.all(servers.splice(0).map(closeHttpServer));
  });

  it("authenticates a real WebSocket client and stops delivery after the bounded recheck revokes access", async () => {
    const db = authorizationDb();
    const httpServer = createServer();
    servers.push(httpServer);
    let origin = "";
    const resolveSessionFromHeaders = vi.fn(async (headers: Headers) => {
      if (headers.get("cookie") !== "paperclip-session=test") return null;
      return {
        session: { id: "session-1", userId: "user-1" },
        user: { id: "user-1" },
      };
    });
    const handle = setupLiveEventsSocketServer(httpServer, db as never, {
      resolveSessionFromHeaders,
      sessionRecheckIntervalMs: 50,
      requestAuthorityBoundary: {
        admit: vi.fn(() => ({ origin })),
        headers: vi.fn(
          (request: { headers: Record<string, unknown> }) =>
            new Headers(request.headers as HeadersInit),
        ),
      } as never,
    });
    handles.push(handle);

    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(0, "127.0.0.1", () => resolve());
    });
    const address = httpServer.address();
    if (!address || typeof address === "string") {
      throw new Error("HTTP server did not expose a TCP address");
    }
    origin = `http://127.0.0.1:${address.port}`;

    const socket = connectSocket(origin, {
      path: LIVE_EVENT_SOCKET_PATH,
      transports: ["websocket"],
      auth: { companyId: COMPANY_ID },
      extraHeaders: {
        Cookie: "paperclip-session=test",
        Origin: origin,
      },
      forceNew: true,
      reconnection: false,
    });
    sockets.push(socket);
    await once(socket, "connect");

    expect(socket.io.engine.transport.name).toBe("websocket");
    expect(resolveSessionFromHeaders).toHaveBeenCalledOnce();

    const delivered = once(socket, LIVE_EVENT_SOCKET_EVENT) as Promise<
      [LiveEvent]
    >;
    const event = publishLiveEvent({
      companyId: COMPANY_ID,
      type: "activity.logged",
      payload: {
        actorType: "user",
        actorId: "user-1",
        action: "task.updated",
        entityType: "task",
        entityId: TASK_ID,
        agentId: null,
        runId: null,
        taskId: TASK_ID,
        responsibleUserId: "user-1",
        details: null,
      },
    });
    await expect(delivered).resolves.toEqual([event, expect.any(String)]);

    // Revocation is no longer re-checked per event; the bounded validity
    // recheck disconnects the socket within its cadence.
    const disconnected = once(socket, "disconnect");
    db.state.membershipActive = false;
    await disconnected;

    const leakedEvents: LiveEvent[] = [];
    socket.on(LIVE_EVENT_SOCKET_EVENT, (nextEvent) =>
      leakedEvents.push(nextEvent),
    );
    publishLiveEvent({
      companyId: COMPANY_ID,
      type: "activity.logged",
      payload: {
        actorType: "user",
        actorId: "user-2",
        action: "company_member.archived",
        entityType: "company_membership",
        entityId: "membership-1",
        agentId: null,
        runId: null,
        taskId: null,
        responsibleUserId: "user-2",
        details: null,
      },
    });
    // The socket is already disconnected, so room delivery must not reach it.
    // One macrotask flush covers the synchronous emit path; no wall-clock wait.
    const { promise: flushed, resolve } = Promise.withResolvers<void>();
    setImmediate(resolve);
    await flushed;
    expect(leakedEvents).toEqual([]);
  }, 10_000);
});
