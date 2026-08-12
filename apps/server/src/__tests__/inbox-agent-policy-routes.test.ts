import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockDb } from "./helpers/mock-db.js";
import { testBoardSessionActor } from "./helpers/request-actor.js";

const policyRouteMocks = vi.hoisted(() => ({
  canUser: vi.fn(),
  getMembership: vi.fn(),
  logActivity: vi.fn(async () => undefined),
}));

vi.mock("../services/index.js", async () => {
  const actual = await vi.importActual<typeof import("../services/index.js")>(
    "../services/index.js",
  );
  return {
    ...actual,
    accessService: () => ({
      canUser: policyRouteMocks.canUser,
      getMembership: policyRouteMocks.getMembership,
    }),
    logActivity: policyRouteMocks.logActivity,
  };
});

import { errorHandler } from "../middleware/index.js";
import { inboxAgentPolicyRoutes } from "../routes/inbox-agent-policy.js";

function boardActor(companyId: string, userId: string): Express.Request["actor"] {
  return testBoardSessionActor({
    userId,
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "operator", status: "active" }],
    isInstanceAdmin: false,
  });
}

function appFor(
  db: ReturnType<typeof createMockDb>["db"],
  actor: Express.Request["actor"],
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use(inboxAgentPolicyRoutes(db));
  app.use(errorHandler);
  return app;
}

describe("inbox agent policy routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    policyRouteMocks.canUser.mockResolvedValue(false);
    policyRouteMocks.getMembership.mockResolvedValue(null);
  });

  it("returns the open default and lets users update their own policy", async () => {
    const companyId = randomUUID();
    const userId = `user-${randomUUID()}`;
    const agentId = randomUUID();
    const now = new Date("2026-01-01T00:00:00.000Z");
    const materialized = {
      id: randomUUID(),
      companyId,
      userId,
      mode: "allowlist",
      allowedAgentIds: [agentId],
      createdAt: now,
      updatedAt: now,
    };
    const harness = createMockDb({
      select: [[], [], [{ id: agentId }]],
      insert: [[materialized]],
    });
    const app = appFor(harness.db, boardActor(companyId, userId));

    await request(app)
      .get(`/companies/${companyId}/users/${userId}/inbox-agent-policy`)
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({
        companyId,
        userId,
        mode: "open",
        allowedAgentIds: [],
        materialized: false,
      }));

    await request(app)
      .put(`/companies/${companyId}/users/${userId}/inbox-agent-policy`)
      .send({ mode: "allowlist", allowedAgentIds: [agentId] })
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({
        mode: "allowlist",
        allowedAgentIds: [agentId],
        materialized: true,
      }));

    expect(policyRouteMocks.logActivity).toHaveBeenCalledWith(harness.db, {
      companyId,
      actorType: "user",
      actorId: userId,
      action: "inbox.agent_policy_updated",
      entityType: "user_inbox_agent_policy",
      entityId: userId,
      details: {
        userId,
        previousMode: "open",
        mode: "allowlist",
        allowedAgentIds: [agentId],
      },
    });
    expect(harness.remaining("select")).toBe(0);
    expect(harness.remaining("insert")).toBe(0);
  });

  it("gates the admin variant with users:manage_permissions", async () => {
    const companyId = randomUUID();
    const userId = `user-${randomUUID()}`;
    const otherUserId = `user-${randomUUID()}`;
    const now = new Date("2026-01-01T00:00:00.000Z");
    policyRouteMocks.canUser
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    policyRouteMocks.getMembership.mockResolvedValue({ status: "active" });
    const harness = createMockDb({
      select: [[]],
      insert: [[{
        id: randomUUID(),
        companyId,
        userId: otherUserId,
        mode: "disabled",
        allowedAgentIds: [],
        createdAt: now,
        updatedAt: now,
      }]],
    });
    const app = appFor(harness.db, boardActor(companyId, userId));

    await request(app)
      .put(`/companies/${companyId}/users/${otherUserId}/inbox-agent-policy`)
      .send({ mode: "disabled", allowedAgentIds: [] })
      .expect(403)
      .expect(({ body }) => expect(body.code).toBe("inbox_agent_policy_admin_required"));

    await request(app)
      .put(`/companies/${companyId}/users/${otherUserId}/inbox-agent-policy`)
      .send({ mode: "disabled", allowedAgentIds: [] })
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({
        userId: otherUserId,
        mode: "disabled",
        allowedAgentIds: [],
      }));

    expect(policyRouteMocks.canUser).toHaveBeenCalledTimes(2);
    expect(policyRouteMocks.getMembership).toHaveBeenCalledWith(companyId, "user", otherUserId);
    expect(harness.remaining("select")).toBe(0);
    expect(harness.remaining("insert")).toBe(0);
  });

  it("rejects admin policies for users without an active company membership", async () => {
    const companyId = randomUUID();
    const userId = `user-${randomUUID()}`;
    policyRouteMocks.canUser.mockResolvedValue(true);
    policyRouteMocks.getMembership.mockResolvedValue(null);
    const harness = createMockDb();

    await request(appFor(harness.db, boardActor(companyId, userId)))
      .put(`/companies/${companyId}/users/user-missing/inbox-agent-policy`)
      .send({ mode: "disabled", allowedAgentIds: [] })
      .expect(404);

    expect(harness.calls).toEqual([]);
  });

  it("rejects agent IDs outside allowlist mode", async () => {
    const companyId = randomUUID();
    const userId = `user-${randomUUID()}`;
    const harness = createMockDb();

    await request(appFor(harness.db, boardActor(companyId, userId)))
      .put(`/companies/${companyId}/users/${userId}/inbox-agent-policy`)
      .send({ mode: "disabled", allowedAgentIds: [randomUUID()] })
      .expect(400);

    expect(harness.calls).toEqual([]);
  });

  it("rejects allowlist agents from another company", async () => {
    const companyId = randomUUID();
    const userId = `user-${randomUUID()}`;
    const harness = createMockDb({ select: [[], []] });

    await request(appFor(harness.db, boardActor(companyId, userId)))
      .put(`/companies/${companyId}/users/${userId}/inbox-agent-policy`)
      .send({ mode: "allowlist", allowedAgentIds: [randomUUID()] })
      .expect(422)
      .expect(({ body }) => expect(body.code).toBe("inbox_agent_policy_invalid_agents"));

    expect(harness.remaining("select")).toBe(0);
    expect(harness.calls.some((call) => call.operation === "insert")).toBe(false);
  });
});
