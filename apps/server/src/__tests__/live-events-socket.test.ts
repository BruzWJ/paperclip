import type { IncomingMessage } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LIVE_EVENT_SOCKET_EVENT,
  LIVE_EVENT_SOCKET_PATH,
} from "@paperclipai/shared";
import {
  authSessions,
  companyMemberships,
  instanceUserRoles,
} from "@paperclipai/db";
import { publishLiveEvent } from "../services/live-events.js";

type FakeSocket = {
  request: IncomingMessage;
  handshake: { auth: unknown };
  data: Record<string, unknown>;
  disconnected: boolean;
  rooms: Set<string>;
  join: ReturnType<typeof vi.fn<(room: string) => Promise<void>>>;
  emit: ReturnType<typeof vi.fn<(event: string, payload: unknown) => void>>;
  disconnect: ReturnType<typeof vi.fn<(close?: boolean) => void>>;
  once: ReturnType<typeof vi.fn<(event: string, listener: () => void) => void>>;
};

type SocketMiddleware = (
  socket: FakeSocket,
  next: (error?: Error) => void,
) => Promise<void>;

const socketIoState = vi.hoisted(() => ({
  instances: [] as Array<{
    options: Record<string, unknown>;
    middleware:
      | ((socket: unknown, next: (error?: Error) => void) => Promise<void>)
      | null;
    sockets: FakeSocket[];
    emissions: Array<{ room: string; event: string; payload: unknown }>;
    close: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("socket.io", () => ({
  Server: function FakeSocketIoServer(
    _server: unknown,
    options: Record<string, unknown>,
  ) {
    const instance = {
      options,
      middleware: null as
        | ((socket: unknown, next: (error?: Error) => void) => Promise<void>)
        | null,
      emissions: [] as Array<{ room: string; event: string; payload: unknown }>,
      sockets: [] as FakeSocket[],
      close: vi.fn(async () => undefined),
      use(
        handler: (
          socket: unknown,
          next: (error?: Error) => void,
        ) => Promise<void>,
      ) {
        instance.middleware = handler;
        return instance;
      },
      in(room: string) {
        return {
          async fetchSockets() {
            return instance.sockets.filter(
              (socket) => !socket.disconnected && socket.rooms.has(room),
            );
          },
        };
      },
    };
    socketIoState.instances.push(instance);
    return instance;
  },
}));

import { setupLiveEventsSocketServer } from "../realtime/live-events-socket.js";

const COMPANY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const TASK_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";

function request(overrides: Partial<IncomingMessage> = {}) {
  return {
    url: `${LIVE_EVENT_SOCKET_PATH}?EIO=4&transport=websocket`,
    headers: {
      host: "paperclip.example",
      origin: "https://paperclip.example",
    },
    socket: { remoteAddress: "203.0.113.10" },
    ...overrides,
  } as IncomingMessage;
}

function requestAuthorityBoundary() {
  return {
    admit: vi.fn(() => ({ origin: "https://paperclip.example" })),
    headers: vi.fn(() => new Headers({ cookie: "paperclip-session=test" })),
  };
}

function selectingDb(input: {
  sessionActive?: boolean;
  sessionExpiresAt?: Date;
  instanceAdmin?: boolean;
  membershipActive?: boolean;
} = {}) {
  const state = {
    sessionActive: input.sessionActive ?? true,
    sessionExpiresAt: input.sessionExpiresAt ?? new Date(Date.now() + 60_000),
    instanceAdmin: input.instanceAdmin ?? false,
    membershipActive: input.membershipActive ?? false,
  };
  return {
    state,
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => {
          if (table === authSessions) {
            return Promise.resolve(
              state.sessionActive
                ? [{ expiresAt: state.sessionExpiresAt }]
                : [],
            );
          }
          if (table === instanceUserRoles) {
            return Promise.resolve(state.instanceAdmin ? [{ id: "role-1" }] : []);
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

type FakeSocketIoServer = (typeof socketIoState.instances)[number];

const openHandles: Array<ReturnType<typeof setupLiveEventsSocketServer>> = [];

function setupServer(
  options: {
    db?: ReturnType<typeof selectingDb>;
    resolveSessionFromHeaders?: () => Promise<{
      session: { id: string; userId: string };
      user: { id: string };
    } | null>;
  } = {},
) {
  const boundary = requestAuthorityBoundary();
  const handle = setupLiveEventsSocketServer(
    {} as never,
    (options.db ?? selectingDb()) as never,
    {
      requestAuthorityBoundary: boundary as never,
      resolveSessionFromHeaders: options.resolveSessionFromHeaders,
    },
  );
  openHandles.push(handle);
  return {
    handle,
    server: socketIoState.instances.at(-1)!,
  };
}

function admit(server: FakeSocketIoServer, req: IncomingMessage) {
  const allowRequest = server.options.allowRequest as (
    request: IncomingMessage,
    done: (error: string | null, allowed: boolean) => void,
  ) => void;
  let result: { error: string | null; allowed: boolean } | null = null;
  allowRequest(req, (error, allowed) => {
    result = { error, allowed };
  });
  return result;
}

async function authorize(
  server: FakeSocketIoServer,
  req: IncomingMessage,
  auth: unknown,
) {
  const disconnectListeners: Array<() => void> = [];
  const socket = {
    request: req,
    handshake: { auth },
    data: {},
    disconnected: false,
    rooms: new Set<string>(),
    join: vi.fn(async (room: string) => {
      socket.rooms.add(room);
    }),
    emit: vi.fn((event: string, payload: unknown) => {
      server.emissions.push({
        room: `socket:${server.sockets.indexOf(socket)}`,
        event,
        payload,
      });
    }),
    disconnect: vi.fn(() => {
      socket.disconnected = true;
      for (const listener of disconnectListeners) listener();
    }),
    once: vi.fn((event: string, listener: () => void) => {
      if (event === "disconnect") disconnectListeners.push(listener);
    }),
  } satisfies FakeSocket;
  const next = vi.fn<(error?: Error) => void>();
  await (server.middleware as SocketMiddleware)(socket, next);
  if (next.mock.calls[0]?.length === 0) server.sockets.push(socket);
  return { join: socket.join, next, socket };
}

describe("live Socket.IO authorization", () => {
  beforeEach(() => {
    socketIoState.instances.length = 0;
  });

  afterEach(async () => {
    await Promise.all(openHandles.splice(0).map((handle) => handle.close()));
  });

  it("mounts exactly the canonical WebSocket-only transport", () => {
    const { server } = setupServer();
    expect(server.options).toMatchObject({
      path: LIVE_EVENT_SOCKET_PATH,
      addTrailingSlash: false,
      serveClient: false,
      transports: ["websocket"],
    });
    expect(server.options).not.toHaveProperty("allowUpgrades");
    expect(server.options).not.toHaveProperty("destroyUpgrade");
  });

  it("rejects auth payloads with missing or extra fields before database reads", async () => {
    const db = selectingDb({ membershipActive: true });
    const { server } = setupServer({
      db,
      resolveSessionFromHeaders: async () => ({
        session: { id: "session-1", userId: "user-1" },
        user: { id: "user-1" },
      }),
    });
    const req = request();
    expect(admit(server, req)).toEqual({ error: null, allowed: true });

    const extra = await authorize(server, req, {
      companyId: COMPANY_ID,
      token: "secret",
    });
    const missing = await authorize(server, req, { token: "secret" });

    expect(extra.next.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(missing.next.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(db.select).not.toHaveBeenCalled();
  });

  it.each([
    ["missing Origin", { origin: undefined }],
    ["cross-origin browser", { origin: "https://attacker.example" }],
    [
      "authorization header",
      { origin: "https://paperclip.example", authorization: "Bearer secret" },
    ],
  ])("rejects %s at the request-authority boundary", (_label, headers) => {
    const { server } = setupServer();
    expect(
      admit(
        server,
        request({ headers: { host: "paperclip.example", ...headers } }),
      ),
    ).toEqual({ error: null, allowed: false });
  });

  it("rejects query credentials before session authorization", () => {
    const { server } = setupServer();
    expect(
      admit(
        server,
        request({
          url: `${LIVE_EVENT_SOCKET_PATH}?EIO=4&transport=websocket&token=secret`,
        }),
      ),
    ).toEqual({ error: null, allowed: false });
  });

  it("rejects a mismatched Better Auth session binding before database reads", async () => {
    const db = selectingDb();
    const { server } = setupServer({
      db,
      resolveSessionFromHeaders: async () => ({
        session: { id: "session-1", userId: "user-2" },
        user: { id: "user-1" },
      }),
    });
    const req = request();
    expect(admit(server, req)).toEqual({ error: null, allowed: true });

    const { next } = await authorize(server, req, { companyId: COMPANY_ID });

    expect(next.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(db.select).not.toHaveBeenCalled();
  });

  it.each([
    [` ${COMPANY_ID}`, "leading whitespace"],
    [`${COMPANY_ID} `, "trailing whitespace"],
    [COMPANY_ID.toUpperCase(), "uppercase spelling"],
    ["company-1", "non-UUID identifier"],
  ])(
    "rejects a non-canonical company id before database reads: %s (%s)",
    async (candidate) => {
      const db = selectingDb({ membershipActive: true });
      const { server } = setupServer({
        db,
        resolveSessionFromHeaders: async () => ({
          session: { id: "session-1", userId: "user-1" },
          user: { id: "user-1" },
        }),
      });
      const req = request();
      expect(admit(server, req)).toEqual({ error: null, allowed: true });

      const { join, next } = await authorize(server, req, {
        companyId: candidate,
      });

      expect(next.mock.calls[0]?.[0]).toBeInstanceOf(Error);
      expect(join).not.toHaveBeenCalled();
      expect(db.select).not.toHaveBeenCalled();
    },
  );

  it("joins only the exact server-derived company UUID room for an active member", async () => {
    const db = selectingDb({ membershipActive: true });
    const { server } = setupServer({
      db,
      resolveSessionFromHeaders: async () => ({
        session: { id: "session-1", userId: "user-1" },
        user: { id: "user-1" },
      }),
    });
    const req = request();
    expect(admit(server, req)).toEqual({ error: null, allowed: true });

    const { join, next } = await authorize(server, req, {
      companyId: COMPANY_ID,
    });

    expect(next).toHaveBeenCalledExactlyOnceWith();
    expect(join).toHaveBeenCalledExactlyOnceWith(`company:${COMPANY_ID}`);
  });

  it("broadcasts one typed event to its company room and closes idempotently", async () => {
    const db = selectingDb({ membershipActive: true });
    const { handle, server } = setupServer({
      db,
      resolveSessionFromHeaders: async () => ({
        session: { id: "session-1", userId: "user-1" },
        user: { id: "user-1" },
      }),
    });
    const req = request();
    expect(admit(server, req)).toEqual({ error: null, allowed: true });
    const { socket } = await authorize(server, req, {
      companyId: COMPANY_ID,
    });
    expect(socket.data).toMatchObject({
      companyId: COMPANY_ID,
      sessionId: "session-1",
      userId: "user-1",
    });

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
    await vi.waitFor(() => expect(server.emissions).toHaveLength(1));
    expect(server.emissions).toEqual([
      {
        room: "socket:0",
        event: LIVE_EVENT_SOCKET_EVENT,
        payload: event,
      },
    ]);

    await Promise.all([handle.close(), handle.close()]);
    expect(server.close).toHaveBeenCalledExactlyOnceWith();

    publishLiveEvent({
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
    expect(server.emissions).toHaveLength(1);
  });

  it("disconnects a revoked member before delivering the next event", async () => {
    const db = selectingDb({ membershipActive: true });
    const { server } = setupServer({
      db,
      resolveSessionFromHeaders: async () => ({
        session: { id: "session-1", userId: "user-1" },
        user: { id: "user-1" },
      }),
    });
    const req = request();
    expect(admit(server, req)).toEqual({ error: null, allowed: true });
    const { socket } = await authorize(server, req, {
      companyId: COMPANY_ID,
    });

    db.state.membershipActive = false;
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

    await vi.waitFor(() =>
      expect(socket.disconnect).toHaveBeenCalledExactlyOnceWith(true),
    );
    expect(server.emissions).toEqual([]);
  });

  it("disconnects when the authenticated session expires", async () => {
    const db = selectingDb({
      membershipActive: true,
      sessionExpiresAt: new Date(Date.now() + 20),
    });
    const { server } = setupServer({
      db,
      resolveSessionFromHeaders: async () => ({
        session: { id: "session-1", userId: "user-1" },
        user: { id: "user-1" },
      }),
    });
    const req = request();
    expect(admit(server, req)).toEqual({ error: null, allowed: true });
    const { socket } = await authorize(server, req, {
      companyId: COMPANY_ID,
    });

    await vi.waitFor(() =>
      expect(socket.disconnect).toHaveBeenCalledExactlyOnceWith(true),
    );
  });
});
