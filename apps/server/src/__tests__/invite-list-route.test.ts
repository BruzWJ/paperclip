import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createMockDb } from "./helpers/mock-db.js";
import { testBoardSessionActor } from "./helpers/request-actor.js";

const canUserMock = vi.hoisted(() => vi.fn(async () => true));

vi.mock("../services/index.js", () => ({
  accessService: () => ({
    isInstanceAdmin: vi.fn(),
    canUser: canUserMock,
    hasPermission: vi.fn(),
  }),
  agentService: () => ({ getById: vi.fn() }),
  boardAuthService: () => ({}),
  createJoinRequestApprovalService: () => ({ approve: vi.fn() }),
  logActivity: vi.fn(),
}));

import { accessRoutes } from "../routes/access.js";
import { errorHandler } from "../middleware/index.js";

describe("GET /companies/:companyId/invites", () => {
  it("returns invite history in descending pages with nextOffset", async () => {
    const companyId = randomUUID();
    const inviteOneId = randomUUID();
    const inviteTwoId = randomUUID();
    const inviteThreeId = randomUUID();
    const joinRequestId = randomUUID();
    const baseInvite = {
      companyId,
      inviteType: "company_join",
      source: "board_api",
      invitedByUserId: "board-user",
      revokedAt: null,
      acceptedAt: null,
      acceptedByUserId: null,
    };
    const inviteOne = {
      ...baseInvite,
      id: inviteOneId,
      tokenHash: "invite-token-1",
      defaultsPayload: { user: { role: "viewer" } },
      expiresAt: new Date("2030-04-20T00:00:00.000Z"),
      createdAt: new Date("2026-04-10T00:00:00.000Z"),
      updatedAt: new Date("2026-04-10T00:00:00.000Z"),
    };
    const inviteTwo = {
      ...baseInvite,
      id: inviteTwoId,
      tokenHash: "invite-token-2",
      defaultsPayload: { user: { role: "operator" } },
      expiresAt: new Date("2030-04-21T00:00:00.000Z"),
      createdAt: new Date("2026-04-11T00:00:00.000Z"),
      updatedAt: new Date("2026-04-11T00:00:00.000Z"),
    };
    const inviteThree = {
      ...baseInvite,
      id: inviteThreeId,
      tokenHash: "invite-token-3",
      defaultsPayload: { user: { role: "admin" } },
      expiresAt: new Date("2030-04-22T00:00:00.000Z"),
      createdAt: new Date("2026-04-12T00:00:00.000Z"),
      updatedAt: new Date("2026-04-12T00:00:00.000Z"),
    };
    const relatedRows = [
      {
        id: joinRequestId,
        inviteId: inviteThreeId,
        name: "Paperclip",
        email: null,
        image: null,
      },
      {
        id: "board-user",
        inviteId: null,
        name: "Board User",
        email: "board-user@paperclip.test",
        image: null,
      },
    ];
    const harness = createMockDb({
      select: [
        [inviteThree, inviteTwo, inviteOne],
        relatedRows,
        relatedRows,
        relatedRows,
        [inviteOne],
        relatedRows,
        relatedRows,
        relatedRows,
      ],
    });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = testBoardSessionActor({
        userId: "board-user",
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "admin", status: "active" }],
        isInstanceAdmin: false,
      });
      next();
    });
    app.use(
      "/api",
      accessRoutes(harness.db, { deploymentExposure: "private" }),
    );
    app.use(errorHandler);

    const firstPage = await request(app).get(
      `/api/companies/${companyId}/invites?limit=2`,
    );
    expect(firstPage.status, JSON.stringify(firstPage.body)).toBe(200);
    expect(
      firstPage.body.invites.map((invite: { id: string }) => invite.id),
    ).toEqual([inviteThreeId, inviteTwoId]);
    expect(firstPage.body.invites[0]).toMatchObject({
      relatedJoinRequestId: joinRequestId,
      companyName: "Paperclip",
      userRole: "admin",
    });
    expect(firstPage.body.nextOffset).toBe(2);

    const secondPage = await request(app).get(
      `/api/companies/${companyId}/invites?limit=2&offset=2`,
    );
    expect(secondPage.status, JSON.stringify(secondPage.body)).toBe(200);
    expect(secondPage.body.invites).toHaveLength(1);
    expect(secondPage.body.invites[0].id).toBe(inviteOneId);
    expect(secondPage.body.nextOffset).toBeNull();

    expect(canUserMock).toHaveBeenCalledTimes(2);
    expect(canUserMock).toHaveBeenNthCalledWith(
      1,
      companyId,
      "board-user",
      "users:invite",
    );
    expect(harness.remaining("select")).toBe(0);
  });
});
