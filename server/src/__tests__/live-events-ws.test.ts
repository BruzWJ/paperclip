import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupLiveEventsWebSocketServer } from "../realtime/live-events-ws.js";
import { logger } from "../middleware/logger.js";
import {
  createRequestAuthorityBoundary,
  createRequestAuthorityPolicy,
} from "../http/request-authority.js";

vi.mock("../middleware/logger.js", () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

class FakeUpgradeSocket extends EventEmitter {
  destroyed = false;
  writable = true;
  writableEnded = false;
  writableDestroyed = false;
  endedChunks: string[] = [];
  destroyCalls = 0;

  end(chunk?: string) {
    if (chunk) this.endedChunks.push(chunk);
    this.writableEnded = true;
    this.writable = false;
    setImmediate(() => {
      if (this.destroyed) return;
      this.emit("finish");
      if (!this.destroyed) {
        this.emit("close");
      }
    });
    return this;
  }

  destroy() {
    this.destroyCalls += 1;
    this.destroyed = true;
    this.writable = false;
    this.writableDestroyed = true;
    this.emit("close");
    return this;
  }

  emitSocketError(err: Error) {
    this.writable = false;
    this.writableDestroyed = true;
    this.emit("error", err);
  }
}

function createUpgradeRequest(overrides: Partial<IncomingMessage> = {}) {
  return {
    url: "/api/companies/company-1/events/ws",
    headers: {
      host: "localhost:3100",
      origin: "http://localhost:3100",
    },
    socket: { remoteAddress: "203.0.113.10" },
    ...overrides,
  } as IncomingMessage;
}

function requestAuthorityBoundary() {
  return createRequestAuthorityBoundary({
    trustProxy: () => false,
    policy: createRequestAuthorityPolicy({
      deploymentExposure: "private",
      allowedHostnames: [],
      bindHost: "127.0.0.1",
    }),
  });
}

async function flushPromises() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("setupLiveEventsWebSocketServer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not write a rejection response after the raw upgrade socket is already closed", async () => {
    const server = new EventEmitter();
    setupLiveEventsWebSocketServer(server as never, {} as never, {
      requestAuthorityBoundary: requestAuthorityBoundary(),
    });
    const socket = new FakeUpgradeSocket();

    server.emit("upgrade", createUpgradeRequest(), socket as unknown as Duplex, Buffer.alloc(0));
    socket.destroy();
    await flushPromises();

    expect(socket.endedChunks).toEqual([]);
    expect(socket.destroyCalls).toBe(1);
  });

  it.each([
    ["missing", undefined],
    ["mismatched", "https://attacker.example"],
  ])("rejects a %s browser Origin before resolving the cookie session", async (_label, origin) => {
    const server = new EventEmitter();
    const resolveSessionFromHeaders = vi.fn(async () => null);
    setupLiveEventsWebSocketServer(server as never, {} as never, {
      requestAuthorityBoundary: createRequestAuthorityBoundary({
        trustProxy: () => false,
        policy: createRequestAuthorityPolicy({
          deploymentExposure: "public",
          canonicalPublicUrl: "https://paperclip.example",
          allowedHostnames: [],
          bindHost: "0.0.0.0",
        }),
      }),
      resolveSessionFromHeaders,
    });
    const socket = new FakeUpgradeSocket();
    const req = createUpgradeRequest({
      headers: {
        host: "paperclip.example",
        ...(origin === undefined ? {} : { origin }),
      },
      socket: {
        remoteAddress: "203.0.113.10",
        encrypted: true,
      } as never,
    });

    server.emit("upgrade", req, socket as unknown as Duplex, Buffer.alloc(0));
    await flushPromises();
    await flushPromises();

    expect(socket.endedChunks[0]).toContain("403 Forbidden");
    expect(resolveSessionFromHeaders).not.toHaveBeenCalled();
  });

  it("handles raw upgrade socket errors during async authorization", async () => {
    const server = new EventEmitter();
    let resolveSession: (value: null) => void = () => undefined;
    setupLiveEventsWebSocketServer(server as never, {} as never, {
      requestAuthorityBoundary: requestAuthorityBoundary(),
      resolveSessionFromHeaders: () =>
        new Promise((resolve) => {
          resolveSession = resolve;
        }),
    });
    const socket = new FakeUpgradeSocket();

    server.emit("upgrade", createUpgradeRequest(), socket as unknown as Duplex, Buffer.alloc(0));
    expect(() => socket.emitSocketError(new Error("write EPIPE"))).not.toThrow();
    resolveSession(null);
    await flushPromises();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), path: "/api/companies/company-1/events/ws" }),
      "live websocket upgrade socket error",
    );
    expect(socket.endedChunks).toEqual([]);
    expect(socket.destroyed).toBe(true);
  });

  it("destroys and cleans up listeners after flushing a rejection response", async () => {
    const server = new EventEmitter();
    setupLiveEventsWebSocketServer(server as never, {} as never, {
      requestAuthorityBoundary: requestAuthorityBoundary(),
    });
    const socket = new FakeUpgradeSocket();

    server.emit("upgrade", createUpgradeRequest(), socket as unknown as Duplex, Buffer.alloc(0));
    await flushPromises();
    await flushPromises();

    expect(socket.endedChunks[0]).toContain("403 Forbidden");
    expect(socket.destroyed).toBe(true);
    expect(socket.listenerCount("error")).toBe(0);
    expect(socket.listenerCount("close")).toBe(0);
    expect(socket.listenerCount("finish")).toBe(0);
  });

  it.each([
    {
      label: "a blank bound user id",
      session: {
        session: { id: "session-1", userId: "   " },
        user: { id: "user-1" },
      },
    },
    {
      label: "a user id that does not match the session binding",
      session: {
        session: { id: "session-1", userId: "user-2" },
        user: { id: "user-1" },
      },
    },
  ])("rejects $label before querying authorization", async ({ session }) => {
    const server = new EventEmitter();
    const db = { select: vi.fn() };
    setupLiveEventsWebSocketServer(server as never, db as never, {
      requestAuthorityBoundary: requestAuthorityBoundary(),
      resolveSessionFromHeaders: async () => session,
    });
    const socket = new FakeUpgradeSocket();

    server.emit("upgrade", createUpgradeRequest(), socket as unknown as Duplex, Buffer.alloc(0));
    await flushPromises();
    await flushPromises();

    expect(socket.endedChunks[0]).toContain("403 Forbidden");
    expect(db.select).not.toHaveBeenCalled();
  });
});
