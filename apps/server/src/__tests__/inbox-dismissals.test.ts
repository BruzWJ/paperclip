import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { inboxDismissalRoutes } from "../routes/inbox-dismissals.js";
import { inboxDismissalService } from "../services/inbox-dismissals.ts";
import { sidebarBadgeService } from "../services/sidebar-badges.ts";
import { createMockDb } from "./helpers/mock-db.js";
import { testBoardSessionActor } from "./helpers/request-actor.js";

const mocks = vi.hoisted(() => ({
  logActivity: vi.fn(),
  listTaskExecutionRunsForActivity: vi.fn(),
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mocks.logActivity,
}));

vi.mock("../services/task-execution-run-service.js", () => ({
  listTaskExecutionRunsForActivity: mocks.listTaskExecutionRunsForActivity,
}));

function dismissalRow(input: {
  companyId: string;
  userId: string;
  itemKey: string;
  kind: "dismiss" | "snooze";
  dismissedAt: Date;
  snoozedUntil?: Date | null;
}) {
  return {
    id: randomUUID(),
    ...input,
    snoozedUntil: input.snoozedUntil ?? null,
    createdAt: input.dismissedAt,
    updatedAt: input.dismissedAt,
  };
}

describe("inbox dismissals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.logActivity.mockResolvedValue(undefined);
    mocks.listTaskExecutionRunsForActivity.mockResolvedValue({
      items: [],
      nextCursor: null,
    });
  });

  it("upserts a single dismissal record per user and inbox item key", async () => {
    const companyId = randomUUID();
    const userId = "board-user";
    const itemKey = "approval:approval-1";
    const firstDismissedAt = new Date("2026-03-11T01:00:00.000Z");
    const secondDismissedAt = new Date("2026-03-11T02:00:00.000Z");
    const first = dismissalRow({
      companyId,
      userId,
      itemKey,
      kind: "dismiss",
      dismissedAt: firstDismissedAt,
    });
    const second = {
      ...first,
      dismissedAt: secondDismissedAt,
      updatedAt: secondDismissedAt,
    };
    const { db, calls } = createMockDb({
      insert: [[first], [second]],
      select: [[second]],
    });
    const service = inboxDismissalService(db);

    await service.dismiss(companyId, userId, itemKey, firstDismissedAt);
    await service.dismiss(companyId, userId, itemKey, secondDismissedAt);
    const dismissals = await service.list(companyId, userId);

    expect(dismissals).toEqual([second]);
    expect(dismissals[0]).toMatchObject({
      itemKey,
      kind: "dismiss",
      snoozedUntil: null,
      dismissedAt: secondDismissedAt,
    });
    expect(calls.filter((call) => call.method === "onConflictDoUpdate")).toHaveLength(2);
  });

  it("snoozes and restores dismissal records through the route", async () => {
    const companyId = randomUUID();
    const userId = "board-user";
    const itemKey = "attention:approval:approval-1";
    const snoozedUntil = new Date("2099-01-01T00:00:00.000Z");
    const snoozed = dismissalRow({
      companyId,
      userId,
      itemKey,
      kind: "snooze",
      dismissedAt: new Date("2026-03-11T02:00:00.000Z"),
      snoozedUntil,
    });
    const { db, calls } = createMockDb({
      insert: [[snoozed]],
      delete: [[snoozed]],
    });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = testBoardSessionActor({
        userId,
        companyIds: [companyId],
        isInstanceAdmin: false,
      });
      next();
    });
    app.use("/api", inboxDismissalRoutes(db));
    app.use(errorHandler);

    await request(app)
      .post(`/api/companies/${companyId}/inbox-dismissals`)
      .send({
        itemKey: "attention:approval:old",
        kind: "snooze",
        snoozedUntil: "2020-01-01T00:00:00.000Z",
      })
      .expect(400);

    const createResponse = await request(app)
      .post(`/api/companies/${companyId}/inbox-dismissals`)
      .send({ itemKey, kind: "snooze", snoozedUntil: snoozedUntil.toISOString() })
      .expect(201);
    expect(createResponse.body).toMatchObject({
      companyId,
      userId,
      itemKey,
      kind: "snooze",
      snoozedUntil: snoozedUntil.toISOString(),
    });

    await request(app)
      .delete(`/api/companies/${companyId}/inbox-dismissals/${encodeURIComponent(itemKey)}`)
      .expect(204);

    expect(calls.filter((call) => call.method === "insert")).toHaveLength(1);
    expect(calls.filter((call) => call.method === "delete")).toHaveLength(1);
    expect(mocks.logActivity).toHaveBeenCalledTimes(2);
  });

  it("honors dismissal timestamps and resurfaces approvals with newer activity", async () => {
    const companyId = randomUUID();
    const primaryAgentId = randomUUID();
    const secondaryAgentId = randomUUID();
    const hiddenApprovalId = randomUUID();
    const resurfacedApprovalId = randomUUID();
    const hiddenJoinRequestId = randomUUID();
    const hiddenRunId = randomUUID();
    const visibleRunId = randomUUID();
    const hiddenRunCreatedAt = new Date("2026-03-11T01:00:00.000Z");
    const visibleRunCreatedAt = new Date("2026-03-11T01:30:00.000Z");
    const { db } = createMockDb({
      select: [
        [
          { id: hiddenApprovalId, updatedAt: new Date("2026-03-11T01:00:00.000Z") },
          { id: resurfacedApprovalId, updatedAt: new Date("2026-03-11T03:00:00.000Z") },
        ],
        [{ id: primaryAgentId }, { id: secondaryAgentId }],
      ],
    });
    mocks.listTaskExecutionRunsForActivity.mockResolvedValue({
      items: [
        {
          runId: hiddenRunId,
          kind: "productive",
          targetAgentId: primaryAgentId,
          status: "failed",
          createdAt: hiddenRunCreatedAt,
        },
        {
          runId: visibleRunId,
          kind: "productive",
          targetAgentId: secondaryAgentId,
          status: "timed_out",
          createdAt: visibleRunCreatedAt,
        },
      ],
      nextCursor: null,
    });
    const dismissedAt = new Date("2026-03-11T02:00:00.000Z").getTime();
    const dismissals = new Map([
      [`approval:${hiddenApprovalId}`, dismissedAt],
      [`approval:${resurfacedApprovalId}`, dismissedAt],
      [`join:${hiddenJoinRequestId}`, dismissedAt],
      [`run:${hiddenRunId}`, hiddenRunCreatedAt.getTime() + 1_000],
    ]);

    await expect(sidebarBadgeService(db).get(companyId, {
      dismissals,
      joinRequests: [{
        id: hiddenJoinRequestId,
        createdAt: new Date("2026-03-11T01:00:00.000Z"),
        updatedAt: new Date("2026-03-11T01:00:00.000Z"),
      }],
      unreadTouchedTasks: 1,
    })).resolves.toEqual({
      inbox: 3,
      approvals: 1,
      failedRuns: 1,
      joinRequests: 0,
    });
  });
});
