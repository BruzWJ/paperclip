import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { parseMoneyAmount } from "@paperclipai/shared";
import { PgDialect } from "drizzle-orm/pg-core";
import { errorHandler } from "../middleware/index.js";
import { attentionRoutes } from "../routes/attention.js";
import { attentionService } from "../services/attention.js";
import { createMockDb } from "./helpers/mock-db.js";
import { testBoardSessionActor } from "./helpers/request-actor.js";

const dependencyMocks = vi.hoisted(() => ({
  budgetOverview: vi.fn(),
}));

vi.mock("../services/budgets.js", async () => ({
  ...(await vi.importActual<typeof import("../services/budgets.js")>(
    "../services/budgets.js",
  )),
  budgetService: () => ({ overview: dependencyMocks.budgetOverview }),
}));

const companyId = "00000000-0000-4000-8000-000000000001";
const approvalId = "00000000-0000-4000-8000-000000000010";
const reviewTaskId = "00000000-0000-4000-8000-000000000020";
const at = new Date("2026-07-09T12:00:00.000Z");

function emptyRuntimeDependencies() {
  dependencyMocks.budgetOverview.mockResolvedValue({ activeIncidents: [] });
}

function approvalOnlySelectPlan(input: {
  updatedAt?: Date;
  dismissal?: Record<string, unknown> | null;
  linkedTaskRows?: Array<Record<string, unknown>>;
}) {
  const updatedAt = input.updatedAt ?? at;
  return [
    [{ taskPrefix: "ATN" }],
    input.dismissal ? [input.dismissal] : [],
    [
      {
        id: approvalId,
        type: "hire_agent",
        status: "pending",
        requestedByAgentId: null,
        requestedByUserId: "board-user",
        payload: { title: "Hire Designer" },
        createdAt: at,
        updatedAt,
      },
    ],
    input.linkedTaskRows ?? [],
    [],
    [],
    [],
    [],
  ];
}

function boardActor() {
  return testBoardSessionActor({
    userId: "board-user",
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "operator", status: "active" }],
    isInstanceAdmin: false,
  });
}

function createApp(db: Db, actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", attentionRoutes(db));
  app.use(errorHandler);
  return app;
}

describe("attention service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    emptyRuntimeDependencies();
  });

  it("returns ranked Board Attention rows across approvals, joins, reviews, budgets, and agent requests", async () => {
    dependencyMocks.budgetOverview.mockResolvedValue({
      activeIncidents: [
        {
          id: "budget-1",
          policyId: "policy-1",
          scopeName: "Acme",
          scopeType: "company",
          scopeId: companyId,
          thresholdType: "hard",
          budgetCurrency: "USD",
          observedAmount: parseMoneyAmount("100"),
          limitAmount: parseMoneyAmount("100"),
          approvalId: null,
          approvalStatus: null,
          status: "open",
          windowStart: new Date("2026-07-01T00:00:00.000Z"),
          createdAt: new Date("2026-07-09T12:03:00.000Z"),
          updatedAt: new Date("2026-07-09T12:03:00.000Z"),
        },
      ],
    });
    const review = {
      id: reviewTaskId,
      companyId,
      taskNumber: 6,
      identifier: "ATN-6",
      title: "Human review",
      boardPresentationStatus: "in_review",
      priority: "medium",
      ownerAgentId: null,
      ownerUserId: "board-user",
      executionState: null,
      createdAt: at,
      updatedAt: new Date("2026-07-09T12:02:00.000Z"),
    };
    const boardMentionTaskId = "00000000-0000-4000-8000-000000000021";
    const boardMention = {
      id: "00000000-0000-4000-8000-000000000030",
      taskId: boardMentionTaskId,
      agentId: "00000000-0000-4000-8000-000000000031",
      ownershipEpoch: 1,
      message: "Which rollout should I use?",
      createdAt: new Date("2026-07-09T12:04:00.000Z"),
    };
    const harness = createMockDb({
      select: [
        [{ taskPrefix: "ATN" }],
        [],
        [
          {
            id: approvalId,
            type: "hire_agent",
            status: "pending",
            requestedByAgentId: null,
            requestedByUserId: "board-user",
            payload: { title: "Hire Designer" },
            createdAt: at,
            updatedAt: at,
          },
        ],
        [{ approvalId, taskId: reviewTaskId }],
        [
          {
            id: "join-1",
            status: "pending_approval",
            requestingUserId: "new-user",
            requestEmailSnapshot: "new@paperclip.test",
            createdAt: at,
            updatedAt: new Date("2026-07-09T12:01:00.000Z"),
          },
        ],
        [review],
        [],
        [
          {
            ...review,
            projectId: null,
            projectName: null,
            projectColor: null,
            projectIcon: null,
            workspaceId: null,
            workspaceName: null,
          },
        ],
        [],
        [
          {
            ...boardMention,
          },
        ],
        [
          {
            id: boardMentionTaskId,
            companyId,
            taskNumber: 7,
            identifier: "ATN-7",
            title: "Choose rollout path",
            boardPresentationStatus: "in_progress",
            priority: "medium",
            ownerAgentId: boardMention.agentId,
            ownerUserId: null,
            createdAt: at,
            updatedAt: new Date("2026-07-09T12:04:00.000Z"),
          },
        ],
        [],
      ],
    });

    const feed = await attentionService(harness.db).list(companyId, {
      userId: "board-user",
    });

    expect(feed.totalCount).toBe(5);
    expect(feed.countsBySourceKind).toMatchObject({
      approval: 1,
      join_request: 1,
      review: 1,
      budget_alert: 1,
      mention_board: 1,
    });
    expect(feed.items.map((item) => item.sourceKind)).toEqual(
      expect.arrayContaining([
        "approval",
        "join_request",
        "review",
        "budget_alert",
        "mention_board",
      ]),
    );
    expect(
      feed.items.find((item) => item.sourceKind === "approval")?.subject
        .routeTarget,
    ).toEqual({ kind: "approval", id: approvalId });
    expect(
      feed.items.find((item) => item.sourceKind === "join_request")?.subject
        .routeTarget,
    ).toEqual({ kind: "join_requests" });
    expect(
      feed.items.find((item) => item.sourceKind === "review")?.subject
        .routeTarget,
    ).toEqual({ kind: "task", taskNumber: 6, hash: null });
    expect(
      feed.items.find((item) => item.sourceKind === "mention_board")?.subject
        .routeTarget,
    ).toEqual({ kind: "task", taskNumber: 7, hash: null });
    expect(
      feed.items.find((item) => item.sourceKind === "budget_alert")?.subject
        .routeTarget,
    ).toEqual({ kind: "costs" });
    for (const item of feed.items) {
      expect(item.dismissalKey).toBe(`attention:${item.dedupKey}`);
      expect(item.rank).toBeGreaterThan(0);
      expect(item.whyNow).toBeTruthy();
      expect(item.entryRule).toBeTruthy();
      expect(item.exitRule).toBeTruthy();
    }
    expect(
      feed.items.find((item) => item.sourceKind === "approval")?.detail,
    ).toMatchObject({
      kind: "approval",
      summaryExcerpt: "Hire Designer",
    });
    expect(
      feed.items.find((item) => item.sourceKind === "budget_alert")?.detail,
    ).toMatchObject({
      kind: "budget",
      observedPercent: 100,
    });
    expect(
      feed.items.find((item) => item.sourceKind === "mention_board")?.detail,
    ).toMatchObject({
      kind: "generic",
      summaryExcerpt: "Which rollout should I use?",
    });
    const reopenFence = harness.calls.find(
      (call) =>
        call.method === "where" &&
        new PgDialect()
          .sqlToQuery(call.args[0] as never)
          .sql.includes("task_board_reopen_commands"),
    );
    expect(reopenFence).toBeDefined();
    expect(
      new PgDialect().sqlToQuery(reopenFence!.args[0] as never).sql,
    ).toContain(">=");
    expect(harness.remaining("select")).toBe(0);
  });

  it("uses attention-prefixed dismissal keys and resurfaces newer activity", async () => {
    const dismissedAt = new Date("2026-07-09T13:00:00.000Z");
    const dismissal = {
      itemKey: `attention:approval:${approvalId}`,
      kind: "dismiss",
      dismissedAt,
      snoozedUntil: null,
    };
    const hiddenHarness = createMockDb({
      select: approvalOnlySelectPlan({ updatedAt: at, dismissal }),
    });
    const includedHarness = createMockDb({
      select: approvalOnlySelectPlan({ updatedAt: at, dismissal }),
    });
    const resurfacedHarness = createMockDb({
      select: approvalOnlySelectPlan({
        updatedAt: new Date("2026-07-09T14:00:00.000Z"),
        dismissal,
      }),
    });

    await expect(
      attentionService(hiddenHarness.db).list(companyId, {
        userId: "board-user",
      }),
    ).resolves.toMatchObject({ totalCount: 0 });
    const included = await attentionService(includedHarness.db).list(
      companyId,
      {
        userId: "board-user",
        includeDismissed: true,
      },
    );
    expect(included.items[0]).toMatchObject({
      dedupKey: `approval:${approvalId}`,
      dismissalKey: `attention:approval:${approvalId}`,
      dismissal: { kind: "dismiss", isActive: true },
    });
    const resurfaced = await attentionService(resurfacedHarness.db).list(
      companyId,
      { userId: "board-user" },
    );
    expect(resurfaced.items[0]).toMatchObject({
      dedupKey: `approval:${approvalId}`,
      dismissal: { kind: "dismiss", isActive: false },
    });
  });

  it("deduplicates an approval linked to multiple tasks and selects the first ordered link", async () => {
    const firstTaskId = "00000000-0000-4000-8000-000000000001";
    const secondTaskId = "00000000-0000-4000-8000-000000000002";
    const harness = createMockDb({
      select: approvalOnlySelectPlan({
        linkedTaskRows: [
          { approvalId, taskId: firstTaskId },
          { approvalId, taskId: secondTaskId },
        ],
      }),
    });

    const feed = await attentionService(harness.db).list(companyId, {
      userId: "board-user",
    });

    expect(feed.items).toHaveLength(1);
    expect(feed.items[0]).toMatchObject({
      dedupKey: `approval:${approvalId}`,
      subject: { metadata: { taskId: firstTaskId } },
    });
  });

  it("serves board users without database infrastructure", async () => {
    const boardHarness = createMockDb({
      select: [[{ taskPrefix: "ATN" }], [], [], [], [], []],
    });

    const boardResponse = await request(
      createApp(boardHarness.db, boardActor()),
    ).get(`/api/companies/${companyId}/attention`);

    expect(boardResponse.status).toBe(200);
    expect(boardResponse.body.totalCount).toBe(0);
  });
});
