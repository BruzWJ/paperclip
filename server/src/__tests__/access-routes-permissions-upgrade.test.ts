import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockDb } from "./helpers/mock-db.js";
import { testBoardSessionActor } from "./helpers/request-actor.js";

const accessMocks = vi.hoisted(() => ({
  canUser: vi.fn(async () => true),
  getMemberById: vi.fn(),
  getMembership: vi.fn(),
  isInstanceAdmin: vi.fn(async () => false),
  logActivity: vi.fn(async () => undefined),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({
    canUser: accessMocks.canUser,
    getMemberById: accessMocks.getMemberById,
    getMembership: accessMocks.getMembership,
    isInstanceAdmin: accessMocks.isInstanceAdmin,
  }),
  agentService: () => ({ getById: vi.fn() }),
  boardAuthService: () => ({}),
  createJoinRequestApprovalService: () => ({ approve: vi.fn() }),
  logActivity: accessMocks.logActivity,
}));

import { accessRoutes } from "../routes/access.js";

function createApp(
  db: ReturnType<typeof createMockDb>["db"],
  companyId: string,
  userId: string,
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = testBoardSessionActor({
      userId,
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "owner", status: "active" }],
      isInstanceAdmin: false,
    });
    next();
  });
  app.use("/api", accessRoutes(db, { deploymentExposure: "private" }));
  app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.status ?? 500).json({ error: error.message ?? "Internal server error" });
  });
  return app;
}

describe("access routes canonical member-role updates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    accessMocks.canUser.mockResolvedValue(true);
    accessMocks.isInstanceAdmin.mockResolvedValue(false);
  });

  it("rejects owner self-lockout through the role-only member route", async () => {
    const companyId = randomUUID();
    const ownerUserId = `owner-${randomUUID()}`;
    const ownerId = randomUUID();
    accessMocks.getMemberById.mockResolvedValue({
      id: ownerId,
      companyId,
      principalId: ownerUserId,
      principalType: "user",
      status: "active",
      membershipRole: "owner",
    });
    const harness = createMockDb();

    const response = await request(createApp(harness.db, companyId, ownerUserId))
      .patch(`/api/companies/${companyId}/members/${ownerId}`)
      .send({ membershipRole: "admin" });

    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(response.body.error).toContain("You cannot remove yourself");
    expect(harness.calls).toEqual([]);
    expect(accessMocks.logActivity).not.toHaveBeenCalled();
  });

  it("keeps custom grants when the role-only member route changes a member role", async () => {
    const companyId = randomUUID();
    const ownerUserId = `owner-${randomUUID()}`;
    const memberUserId = `admin-${randomUUID()}`;
    const memberId = randomUUID();
    const now = new Date("2026-01-01T00:00:00.000Z");
    const existing = {
      id: memberId,
      companyId,
      principalType: "user",
      principalUserId: memberUserId,
      principalAgentId: null,
      status: "active",
      membershipRole: "admin",
      createdAt: now,
      updatedAt: now,
    };
    const updated = { ...existing, membershipRole: "operator", updatedAt: now };
    const customScope = { targetAgentIds: [randomUUID()] };
    const customGrant = {
      id: randomUUID(),
      companyId,
      principalType: "user",
      principalUserId: memberUserId,
      principalAgentId: null,
      permissionKey: "agents:configure",
      scope: customScope,
      grantedByUserId: ownerUserId,
      createdAt: now,
      updatedAt: now,
    };
    accessMocks.getMemberById.mockResolvedValue({
      id: memberId,
      companyId,
      principalId: memberUserId,
      principalType: "user",
      status: "active",
      membershipRole: "admin",
    });
    accessMocks.getMembership.mockResolvedValue({
      status: "active",
      membershipRole: "owner",
    });
    const harness = createMockDb({
      select: [
        [existing],
        [updated],
        [{ id: memberUserId, name: "Admin", email: "admin@example.com", image: null }],
        [customGrant],
      ],
      update: [[updated]],
      execute: [[]],
    });

    const response = await request(createApp(harness.db, companyId, ownerUserId))
      .patch(`/api/companies/${companyId}/members/${memberId}`)
      .send({ membershipRole: "operator" });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({
      id: memberId,
      principalId: memberUserId,
      membershipRole: "operator",
      grants: [{
        permissionKey: "agents:configure",
        scope: customScope,
        grantedByUserId: ownerUserId,
      }],
    });
    expect(harness.calls.filter((call) => call.operation === "update" && call.method === "set"))
      .toEqual([expect.objectContaining({
        args: [expect.objectContaining({ membershipRole: "operator", status: "active" })],
      })]);
    expect(harness.calls.some((call) => call.operation === "delete")).toBe(false);
    expect(accessMocks.logActivity).toHaveBeenCalledWith(harness.db, expect.objectContaining({
      action: "company_member.updated",
      entityId: memberId,
      details: { membershipRole: "operator", status: "active" },
    }));
    expect(harness.remaining("select")).toBe(0);
    expect(harness.remaining("update")).toBe(0);
    expect(harness.remaining("execute")).toBe(0);
  });
});
