import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { denyGenericAgentRest } from "../routes/compiled-interface-only.js";
import { issueRoutes } from "../routes/issues.js";
import { issueService as createIssueService } from "../services/issues.js";
import { createMockDb } from "./helpers/mock-db.js";
import { testBoardSessionActor } from "./helpers/request-actor.js";

const routeMocks = vi.hoisted(() => ({
  getById: vi.fn(),
  archiveInbox: vi.fn(),
  unarchiveInbox: vi.fn(),
  logActivity: vi.fn(),
}));

vi.mock("../services/index.js", async () => ({
  ...await vi.importActual<typeof import("../services/index.js")>("../services/index.js"),
  issueService: () => routeMocks,
  logActivity: routeMocks.logActivity,
}));

const companyId = "00000000-0000-4000-8000-000000000001";
const issueId = "00000000-0000-4000-8000-000000000010";
const agentId = "00000000-0000-4000-8000-000000000020";
const userId = "responsible-user";
const targetUserId = "target-user";
const archivedAt = new Date("2026-01-02T03:04:05.000Z");

const issue = {
  id: issueId,
  companyId,
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

const archiveRow = {
  id: "00000000-0000-4000-8000-000000000030",
  companyId,
  issueId,
  userId,
  archivedByActorType: "user",
  archivedByAgentId: null,
  archivedByRunId: null,
  archivedAt,
  updatedAt: archivedAt,
};

function boardActor(): Express.Request["actor"] {
  return testBoardSessionActor({
    userId,
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "operator", status: "active" }],
    isInstanceAdmin: false,
  });
}

function createApp(db: Db, actor: Express.Request["actor"] = boardActor()) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", denyGenericAgentRest("REST"));
  app.use("/api", issueRoutes(db, {} as never, { ordinaryIssues: {} as never }));
  app.use(errorHandler);
  return app;
}

describe("inbox archive routes", () => {
  beforeEach(() => {
    routeMocks.getById.mockReset();
    routeMocks.archiveInbox.mockReset();
    routeMocks.unarchiveInbox.mockReset();
    routeMocks.logActivity.mockReset().mockResolvedValue(undefined);
  });

  it("preserves board archive and unarchive idempotency for the authenticated user", async () => {
    routeMocks.getById.mockResolvedValue(issue);
    routeMocks.archiveInbox.mockResolvedValue(archiveRow);
    routeMocks.unarchiveInbox
      .mockResolvedValueOnce(archiveRow)
      .mockResolvedValueOnce(null);
    const harness = createMockDb();
    const app = createApp(harness.db);

    const first = await request(app).post(`/api/issues/${issueId}/inbox-archive`).send({});
    const second = await request(app).post(`/api/issues/${issueId}/inbox-archive`).send({});
    const removed = await request(app).delete(`/api/issues/${issueId}/inbox-archive`).send({});
    const repeated = await request(app).delete(`/api/issues/${issueId}/inbox-archive`).send({});

    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ id: archiveRow.id, userId, archivedByActorType: "user" });
    expect(second.body.id).toBe(first.body.id);
    expect(removed.body).toMatchObject({ id: archiveRow.id, userId });
    expect(repeated.body).toEqual({ ok: true, userId });
    expect(routeMocks.archiveInbox).toHaveBeenCalledTimes(2);
    expect(routeMocks.archiveInbox).toHaveBeenCalledWith(
      companyId,
      issueId,
      userId,
      expect.any(Date),
      { archivedByActorType: "user" },
    );
    expect(routeMocks.unarchiveInbox).toHaveBeenCalledTimes(2);
    expect(routeMocks.logActivity).toHaveBeenCalledTimes(4);
    expect(harness.calls).toEqual([]);
  });

  it("projects an active archive and drops it when newer issue activity resurfaces the issue", async () => {
    const activeHarness = createMockDb({
      select: [[{
        issueId,
        latestCommentAt: new Date("2026-01-01T12:00:00.000Z"),
      }], [], [archiveRow]],
    });
    const resurfacedHarness = createMockDb({
      select: [[{
        issueId,
        latestCommentAt: new Date("2026-01-03T00:00:00.000Z"),
      }], [], [archiveRow]],
    });

    await expect(createIssueService(activeHarness.db).getActiveInboxArchiveFields(issue, userId)).resolves.toEqual({
      archivedAt,
      archivedByActorType: "user",
      archivedByAgentId: null,
      archivedByRunId: null,
    });
    await expect(createIssueService(resurfacedHarness.db).getActiveInboxArchiveFields(issue, userId)).resolves.toEqual({});
    expect(activeHarness.remaining("select")).toBe(0);
    expect(resurfacedHarness.remaining("select")).toBe(0);
  });

  it("rejects agent archive and unarchive requests at the generic REST boundary", async () => {
    const harness = createMockDb();
    const actor = {
      type: "agent",
      source: "internal",
      agentId,
      companyId,
      runId: "00000000-0000-4000-8000-000000000040",
      onBehalfOfUserId: userId,
      onBehalfOfMemberships: [{ companyId, membershipRole: "operator", status: "active" }],
    } as const;
    const app = createApp(harness.db, actor);

    const archive = await request(app).post(`/api/issues/${issueId}/inbox-archive`).send({});
    const unarchive = await request(app).delete(`/api/issues/${issueId}/inbox-archive`).send({});

    expect(archive.status).toBe(403);
    expect(unarchive.status).toBe(403);
    expect(archive.body.code).toBe("compiled_run_interface_required");
    expect(unarchive.body.code).toBe("compiled_run_interface_required");
    expect(routeMocks.getById).not.toHaveBeenCalled();
    expect(routeMocks.archiveInbox).not.toHaveBeenCalled();
    expect(routeMocks.unarchiveInbox).not.toHaveBeenCalled();
    expect(harness.calls).toEqual([]);
  });

  it("rejects the retired explicit target-user body before loading the issue", async () => {
    const harness = createMockDb();
    const app = createApp(harness.db);

    const archive = await request(app)
      .post(`/api/issues/${issueId}/inbox-archive`)
      .send({ userId: targetUserId });
    const unarchive = await request(app)
      .delete(`/api/issues/${issueId}/inbox-archive`)
      .send({ userId: targetUserId });

    expect(archive.status).toBe(400);
    expect(unarchive.status).toBe(400);
    expect(routeMocks.getById).not.toHaveBeenCalled();
    expect(routeMocks.archiveInbox).not.toHaveBeenCalled();
    expect(routeMocks.unarchiveInbox).not.toHaveBeenCalled();
    expect(harness.calls).toEqual([]);
  });
});
