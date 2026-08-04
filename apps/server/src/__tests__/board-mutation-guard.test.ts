import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { boardMutationGuard } from "../middleware/board-mutation-guard.js";
import { testBoardKeyActor, testBoardSessionActor } from "./helpers/request-actor.js";
import {
  canonicalizeAuthority,
  createRequestAuthorityBoundary,
  createRequestAuthorityPolicy,
} from "../http/request-authority.js";

function createApp(
  actorType: "board" | "agent",
  boardSource: "session" | "board_key" = "session",
  trustProxy = false,
) {
  const app = express();
  const boundary = createRequestAuthorityBoundary({
    trustProxy: () => trustProxy,
    policy: createRequestAuthorityPolicy({
      deploymentExposure: "private",
      allowedHostnames: ["10.90.10.20"],
      bindHost: "0.0.0.0",
    }),
  });
  app.use(boundary.middleware);
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actorType === "board"
      ? boardSource === "session"
        ? testBoardSessionActor({
            userId: "user-1",
            sessionId: "session-1",
            userName: "User One",
            userEmail: "user@example.com",
            companyIds: [],
            memberships: [],
            isInstanceAdmin: false,
          })
        : testBoardKeyActor({
            userId: "user-1",
            keyId: "board-key-1",
            userName: "User One",
            userEmail: "user@example.com",
            companyIds: [],
            memberships: [],
            isInstanceAdmin: false,
          })
      : {
          type: "agent",
          source: "internal",
          agentId: "agent-1",
          companyId: "company-1",
          runId: "run-1",
        };
    next();
  });
  app.use(boardMutationGuard());
  app.post("/mutate", (_req, res) => {
    res.status(204).end();
  });
  app.get("/read", (_req, res) => {
    res.status(204).end();
  });
  return app;
}

describe("boardMutationGuard", () => {
  it("allows safe methods for board actor", async () => {
    const app = createApp("board");
    const res = await request(app).get("/read");
    expect([200, 204]).toContain(res.status);
  });

  it("blocks board mutations without trusted origin", () => {
    const middleware = boardMutationGuard();
    const req = {
      method: "POST",
      actor: testBoardSessionActor({
        userId: "user-1",
        sessionId: "session-1",
      }),
      requestAuthority: {
        ...canonicalizeAuthority("localhost:3100", "http"),
        immediatePeerTrusted: false,
      },
      header: () => undefined,
    } as any;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as any;
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: "Board mutation requires trusted browser origin",
    });
  });

  it("allows board bearer-key mutations without origin", async () => {
    const app = createApp("board", "board_key");
    const res = await request(app).post("/mutate").send({ ok: true });
    expect([200, 204]).toContain(res.status);
  });

  it("allows board mutations from trusted origin", async () => {
    const app = createApp("board");
    const res = await request(app)
      .post("/mutate")
      .set("Host", "localhost:3100")
      .set("Origin", "http://localhost:3100")
      .send({ ok: true });
    expect([200, 204]).toContain(res.status);
  });

  it("allows board mutations from trusted referer origin", async () => {
    const app = createApp("board");
    const res = await request(app)
      .post("/mutate")
      .set("Host", "localhost:3100")
      .set("Referer", "http://localhost:3100/issues/abc")
      .send({ ok: true });
    expect([200, 204]).toContain(res.status);
  });

  it("allows canonical forwarded authority only from a trusted immediate proxy", async () => {
    const app = createApp("board", "session", true);
    const res = await request(app)
      .post("/mutate")
      .set("Host", "127.0.0.1")
      .set("X-Forwarded-Host", "10.90.10.20:3443")
      .set("X-Forwarded-Proto", "https")
      .set("Origin", "https://10.90.10.20:3443")
      .send({ ok: true });
    expect([200, 204]).toContain(res.status);
  });

  it("rejects direct forwarded-authority spoofing", async () => {
    const app = createApp("board");
    const res = await request(app)
      .post("/mutate")
      .set("Host", "localhost:3100")
      .set("X-Forwarded-Host", "10.90.10.20:3443")
      .set("X-Forwarded-Proto", "https")
      .set("Origin", "https://10.90.10.20:3443")
      .send({ ok: true });

    expect(res.status).toBe(403);
  });

  it("allows the resolved canonical public origin when the proxy host differs", () => {
    const middleware = boardMutationGuard();
    const req = {
      method: "POST",
      actor: testBoardSessionActor({
        userId: "user-1",
        sessionId: "session-1",
      }),
      requestAuthority: {
        ...canonicalizeAuthority("paperclip.example.com", "https"),
        immediatePeerTrusted: true,
      },
      header: (name: string) => {
        if (name === "host") return "paperclip.internal:3100";
        if (name === "origin") return "https://paperclip.example.com";
        return undefined;
      },
    } as any;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as any;
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("does not trust request-host aliases during public exposure", () => {
    const middleware = boardMutationGuard();
    const req = {
      method: "POST",
      actor: testBoardSessionActor({
        userId: "user-1",
        sessionId: "session-1",
      }),
      requestAuthority: {
        ...canonicalizeAuthority("paperclip.example.com", "https"),
        immediatePeerTrusted: true,
      },
      header: (name: string) => {
        if (name === "host") return "paperclip.internal:3100";
        if (name === "origin") return "https://paperclip.internal:3100";
        return undefined;
      },
    } as any;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as any;
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("blocks board mutations when x-forwarded-host does not match origin", async () => {
    const middleware = boardMutationGuard();
    const req = {
      method: "POST",
      actor: testBoardSessionActor({
        userId: "user-1",
        sessionId: "session-1",
      }),
      requestAuthority: {
        ...canonicalizeAuthority("10.90.10.20:3443", "https"),
        immediatePeerTrusted: true,
      },
      header: (name: string) => {
        if (name === "host") return "127.0.0.1";
        if (name === "x-forwarded-host") return "10.90.10.20:3443";
        if (name === "origin") return "https://evil.example.com";
        return undefined;
      },
    } as any;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as any;
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: "Board mutation requires trusted browser origin",
    });
  });

  it("does not block authenticated agent mutations", async () => {
    const middleware = boardMutationGuard();
    const req = {
      method: "POST",
      actor: {
        type: "agent",
        source: "internal",
        agentId: "agent-1",
        companyId: "company-1",
        runId: "run-1",
      },
      requestAuthority: {
        ...canonicalizeAuthority("localhost:3100", "http"),
        immediatePeerTrusted: false,
      },
      header: () => undefined,
    } as any;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as any;
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });
});
