import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { actorMiddleware } from "../middleware/auth.js";
import { testBoardSessionActor } from "./helpers/request-actor.js";

function createSelectChain(rows: unknown[]) {
  return {
    from() {
      return {
        where() {
          return Promise.resolve(rows);
        },
      };
    },
  };
}

function createDb() {
  return {
    select: vi
      .fn()
      .mockImplementationOnce(() => createSelectChain([]))
      .mockImplementationOnce(() => createSelectChain([])),
  } as any;
}

describe("actorMiddleware Better Auth session identity", () => {
  it("preserves the signed-in Better Auth user on the board actor", async () => {
    const app = express();
    app.use(
      actorMiddleware(createDb(), {
        resolveSession: async () => ({
          session: { id: "session-1", userId: "user-1" },
          user: {
            id: "user-1",
            name: "User One",
            email: "user@example.com",
          },
        }),
      }),
    );
    app.get("/actor", (req, res) => {
      res.json(req.actor);
    });

    const res = await request(app).get("/actor");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject(testBoardSessionActor({
      userId: "user-1",
      userName: "User One",
      userEmail: "user@example.com",
      sessionId: "session-1",
      companyIds: [],
      memberships: [],
      isInstanceAdmin: false,
    }));
  });

  it("rejects blank Better Auth user or session ids without querying authorization", async () => {
    const db = {
      select: vi.fn(),
    } as any;
    const app = express();
    app.use(
      actorMiddleware(db, {
        resolveSession: async () => ({
          session: { id: "   ", userId: "   " },
          user: {
            id: "   ",
            name: "Invalid",
            email: "invalid@example.com",
          },
        }),
      }),
    );
    app.get("/actor", (req, res) => {
      res.json(req.actor);
    });

    const res = await request(app).get("/actor");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ type: "none", source: "none" });
    expect(db.select).not.toHaveBeenCalled();
  });

  it("rejects a session whose bound user id does not match the resolved user", async () => {
    const db = {
      select: vi.fn(),
    } as any;
    const app = express();
    app.use(
      actorMiddleware(db, {
        resolveSession: async () => ({
          session: { id: "session-1", userId: "user-2" },
          user: {
            id: "user-1",
            name: "User One",
            email: "user@example.com",
          },
        }),
      }),
    );
    app.get("/actor", (req, res) => {
      res.json(req.actor);
    });

    const res = await request(app).get("/actor");

    expect(res.body).toEqual({ type: "none", source: "none" });
    expect(db.select).not.toHaveBeenCalled();
  });

  it("ignores retired trusted-cloud identity headers and performs no database writes", async () => {
    const db = {
      select: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    } as any;
    const app = express();
    app.use(actorMiddleware(db, { resolveSession: async () => null }));
    app.get("/actor", (req, res) => {
      res.json(req.actor);
    });

    const res = await request(app)
      .get("/actor")
      .set("x-paperclip-cloud-tenant-token", "retired-token") // paperclip:canonical-human-auth-removal-proof
      .set("x-paperclip-cloud-user-id", "forged-user") // paperclip:canonical-human-auth-removal-proof
      .set("x-paperclip-cloud-user-email", "forged@example.com") // paperclip:canonical-human-auth-removal-proof
      .set("x-paperclip-cloud-stack-id", "retired-stack") // paperclip:canonical-human-auth-removal-proof
      .set("x-paperclip-cloud-stack-role", "owner"); // paperclip:canonical-human-auth-removal-proof

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ type: "none", source: "none" });
    expect(db.select).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
    expect(db.delete).not.toHaveBeenCalled();
  });
});
