import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import {
  authUsers,
  boardApiKeys,
  companyMemberships,
  instanceUserRoles,
} from "@paperclipai/db";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { rejectRunInterfaceBearerFromGenericApi } from "../middleware/prompt-capability-boundary.js";
import { assertAuthenticated } from "../routes/authz.js";
import { hashBearerToken } from "../services/board-auth.js";
import { testBoardKeyActor } from "./helpers/request-actor.js";

function createDb(input?: {
  boardToken?: string;
  userId?: string;
  companyId?: string;
}) {
  const userId = input?.userId ?? "user-1";
  const companyId = input?.companyId ?? "company-1";
  const boardKey = input?.boardToken
    ? {
        id: "board-key-1",
        userId,
        name: "test board key",
        keyHash: hashBearerToken(input.boardToken),
        expiresAt: null,
        revokedAt: null,
      }
    : null;

  const rowsForTable = (table: unknown): unknown[] => {
    if (table === boardApiKeys) return boardKey ? [boardKey] : [];
    if (table === authUsers) {
      return [{ id: userId, name: "Board User", email: "board@example.com" }];
    }
    if (table === companyMemberships) {
      return [{ companyId, membershipRole: "owner", status: "active" }];
    }
    if (table === instanceUserRoles) return [];
    return [];
  };

  return {
    select: () => ({
      from(table: unknown) {
        const rows = rowsForTable(table);
        return {
          where() {
            return Promise.resolve(rows);
          },
          then(resolve: (value: unknown[]) => unknown) {
            return Promise.resolve(rows).then(resolve);
          },
        };
      },
    }),
    update: () => ({
      set: () => ({
        where: () => Promise.resolve([]),
      }),
    }),
  } as any;
}

function createApp(
  db = createDb(),
) {
  const app = express();
  app.use(rejectRunInterfaceBearerFromGenericApi());
  app.use(
    actorMiddleware(db, {
      resolveSession: async () => null,
    }),
  );
  app.get("/actor", (req, res) => {
    res.json(req.actor);
  });
  app.get("/protected", (req, res) => {
    assertAuthenticated(req);
    res.json({ ok: true });
  });
  app.use(errorHandler);
  return app;
}

describe("generic API bearer authentication", () => {
  it.each([
    ["retired agent API key", "pcp_agent_legacy_key"],
    ["JWT-shaped credential", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZ2VudC0xIn0.invalid"],
    ["prompt-capability bearer", "pc_run_v1_not-a-real-run-token"],
    ["named tool-gateway bearer", "pcgt_not-a-real-session.not-a-real-secret"],
  ])("rejects a %s on generic API routes", async (_label, token) => {
    const response = await request(createApp())
      .get("/protected")
      .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(401);
  });

  it("ignores X-Paperclip-Run-Id as an authentication source", async () => {
    const response = await request(createApp())
      .get("/actor")
      .set("X-Paperclip-Run-Id", "run-spoof");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ type: "none", source: "none" });
  });

  it("categorically rejects reserved run bearers before public generic routes", async () => {
    const response = await request(createApp())
      .get("/actor")
      .set("Authorization", "Bearer pc_run_v1_not-a-real-run-token");

    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      error: "Prompt-capability bearers are not valid generic API credentials",
      code: "prompt_capability_authentication_failed",
    });
  });

  it("does not let an invalid bearer inherit board authority", async () => {
    const response = await request(createApp())
      .get("/protected")
      .set("Authorization", "Bearer pcp_agent_retired");

    expect(response.status).toBe(401);
  });

  it("stays unauthenticated without a Better Auth session or board key", async () => {
    const response = await request(createApp()).get("/actor");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ type: "none", source: "none" });
  });

  it("retains named board API key authentication", async () => {
    const token = "pcp_board_valid";
    const response = await request(
      createApp(createDb({ boardToken: token })),
    )
      .get("/actor")
      .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject(testBoardKeyActor({
      userId: "user-1",
      userName: "Board User",
      userEmail: "board@example.com",
      companyIds: ["company-1"],
      memberships: [
        {
          companyId: "company-1",
          membershipRole: "owner",
          status: "active",
        },
      ],
      keyId: "board-key-1",
    }));
  });
});
