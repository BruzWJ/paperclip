import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { resourceMembershipRoutes } from "../routes/resource-memberships.js";
import { resourceMembershipService } from "../services/resource-memberships.js";
import { createMockDb } from "./helpers/mock-db.js";
import { testBoardSessionActor } from "./helpers/request-actor.js";

const routeMocks = vi.hoisted(() => ({ logActivity: vi.fn() }));

vi.mock("../services/index.js", async () => ({
  ...await vi.importActual<typeof import("../services/index.js")>("../services/index.js"),
  logActivity: routeMocks.logActivity,
}));

const companyId = "00000000-0000-4000-8000-000000000001";
const projectId = "00000000-0000-4000-8000-000000000010";
const agentId = "00000000-0000-4000-8000-000000000020";
const now = new Date("2026-01-02T03:04:05.000Z");

function boardActor(role: "admin" | "operator" | "viewer" = "viewer") {
  return testBoardSessionActor({
    userId: "user-1",
    isInstanceAdmin: false,
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: role, status: "active" }],
  });
}

function createApp(db: Db, actor: Express.Request["actor"] = boardActor()) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", resourceMembershipRoutes(db));
  app.use(errorHandler);
  return app;
}

describe("resource membership routes", () => {
  beforeEach(() => routeMocks.logActivity.mockReset().mockResolvedValue(undefined));

  it("defaults missing membership rows to joined", async () => {
    const harness = createMockDb({ select: [[], []] });

    const res = await request(createApp(harness.db))
      .get(`/api/companies/${companyId}/resource-memberships/me`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      projectMemberships: {},
      agentMemberships: {},
      starredProjectIds: [],
      starredAgentIds: [],
      projectStarredAt: {},
      agentStarredAt: {},
      updatedAt: null,
    });
    expect(harness.remaining("select")).toBe(0);
  });

  it("allows a viewer to leave a project and keeps a repeated request idempotent", async () => {
    const project = { id: projectId, companyId, archivedAt: null };
    const membership = {
      companyId,
      projectId,
      userId: "user-1",
      state: "left",
      starredAt: null,
      updatedAt: now,
    };
    const harness = createMockDb({
      select: [project, undefined, project, membership],
      insert: [[membership]],
    });
    const app = createApp(harness.db);

    const first = await request(app)
      .put(`/api/companies/${companyId}/resource-memberships/me/projects/${projectId}`)
      .send({ state: "left" });
    const second = await request(app)
      .put(`/api/companies/${companyId}/resource-memberships/me/projects/${projectId}`)
      .send({ state: "left" });

    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ resourceType: "project", resourceId: projectId, state: "left", starredAt: null });
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(harness.calls.filter((call) => call.operation === "insert" && call.method === "insert")).toHaveLength(1);
    expect(routeMocks.logActivity).toHaveBeenCalledTimes(1);
    expect(routeMocks.logActivity).toHaveBeenCalledWith(harness.db, expect.objectContaining({
      action: "resource_membership.left",
      entityType: "project",
      entityId: projectId,
    }));
  });

  it("stars a project idempotently and exposes its sidebar projection", async () => {
    const project = { id: projectId, companyId, archivedAt: null };
    const membership = {
      companyId,
      projectId,
      userId: "user-1",
      state: "joined",
      starredAt: now,
      updatedAt: now,
    };
    const harness = createMockDb({
      select: [project, undefined, project, membership, [{
        projectId,
        state: "joined",
        starredAt: now,
        updatedAt: now,
        projectArchivedAt: null,
      }], []],
      insert: [[membership]],
    });
    const app = createApp(harness.db);

    const first = await request(app)
      .put(`/api/companies/${companyId}/resource-memberships/me/projects/${projectId}`)
      .send({ starred: true });
    const second = await request(app)
      .put(`/api/companies/${companyId}/resource-memberships/me/projects/${projectId}`)
      .send({ starred: true });
    const list = await request(app).get(`/api/companies/${companyId}/resource-memberships/me`);

    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ resourceType: "project", resourceId: projectId, state: "joined", starredAt: now.toISOString() });
    expect(second.body).toEqual(first.body);
    expect(list.body.starredProjectIds).toEqual([projectId]);
    expect(list.body.projectStarredAt).toEqual({ [projectId]: now.toISOString() });
    expect(routeMocks.logActivity).toHaveBeenCalledTimes(1);
  });

  it("keeps joined membership state while excluding archived and terminated resources from stars", async () => {
    const harness = createMockDb({
      select: [[{
        projectId,
        state: "joined",
        starredAt: now,
        updatedAt: now,
        projectArchivedAt: now,
      }], [{
        agentId,
        state: "joined",
        starredAt: now,
        updatedAt: now,
        agentStatus: "terminated",
      }]],
    });

    const res = await request(createApp(harness.db))
      .get(`/api/companies/${companyId}/resource-memberships/me`);

    expect(res.status).toBe(200);
    expect(res.body.projectMemberships).toEqual({ [projectId]: "joined" });
    expect(res.body.agentMemberships).toEqual({ [agentId]: "joined" });
    expect(res.body.starredProjectIds).toEqual([]);
    expect(res.body.starredAgentIds).toEqual([]);
    expect(res.body.projectStarredAt).toEqual({});
    expect(res.body.agentStarredAt).toEqual({});
  });

  it("rejects archived projects and terminated agents before membership mutation", async () => {
    const harness = createMockDb({
      select: [
        { id: projectId, companyId, archivedAt: now },
        { id: agentId, companyId, status: "terminated" },
      ],
    });
    const app = createApp(harness.db);

    const projectRes = await request(app)
      .put(`/api/companies/${companyId}/resource-memberships/me/projects/${projectId}`)
      .send({ starred: true });
    const agentRes = await request(app)
      .put(`/api/companies/${companyId}/resource-memberships/me/agents/${agentId}`)
      .send({ starred: true });

    expect(projectRes.status).toBe(404);
    expect(agentRes.status).toBe(404);
    expect(harness.calls.some((call) => call.operation === "insert")).toBe(false);
    expect(routeMocks.logActivity).not.toHaveBeenCalled();
  });

  it("rejects agent API-key actors without sending a query", async () => {
    const harness = createMockDb();
    const actor = { type: "agent", agentId, companyId, source: "internal" } as const;

    const res = await request(createApp(harness.db, actor))
      .get(`/api/companies/${companyId}/resource-memberships/me`);

    expect(res.status).toBe(403);
    expect(harness.calls).toEqual([]);
  });

  it("rejects cross-company resources without writing membership rows", async () => {
    const harness = createMockDb({ select: [undefined, undefined] });
    const app = createApp(harness.db);

    const projectRes = await request(app)
      .put(`/api/companies/${companyId}/resource-memberships/me/projects/${projectId}`)
      .send({ state: "left" });
    const agentRes = await request(app)
      .put(`/api/companies/${companyId}/resource-memberships/me/agents/${agentId}`)
      .send({ state: "left" });

    expect(projectRes.status).toBe(404);
    expect(agentRes.status).toBe(404);
    expect(harness.calls.some((call) => call.operation === "insert")).toBe(false);
  });

  it("denies direct service attempts to mutate another user's membership", async () => {
    const harness = createMockDb({
      select: [{ id: projectId, companyId, archivedAt: null }, undefined],
    });

    await expect(resourceMembershipService(harness.db).updateProject({
      companyId,
      projectId,
      userId: "other-user",
      state: "left",
      actor: boardActor(),
    })).rejects.toMatchObject({
      status: 403,
      message: "Users may only update their own resource memberships",
    });
    expect(harness.calls.some((call) => call.operation === "insert")).toBe(false);
  });
});
