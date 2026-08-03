import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createMockDb } from "./helpers/mock-db.js";
import { testBoardSessionActor } from "./helpers/request-actor.js";
import { errorHandler } from "../middleware/index.js";
import { userProfileRoutes } from "../routes/user-profiles.js";

describe("GET /companies/:companyId/users/:userSlug/profile", () => {
  it("resolves a user slug and returns issue, activity, and attributed cost stats", async () => {
    const companyId = randomUUID();
    const userId = randomUUID();
    const agentId = randomUUID();
    const openIssueId = randomUUID();
    const doneIssueId = randomUUID();
    const now = new Date("2026-01-15T00:00:00.000Z");
    const companyUser = {
      id: randomUUID(),
      principalId: userId,
      status: "active",
      membershipRole: "owner",
      createdAt: now,
      userId,
      name: "Dotta",
      email: "dotta@example.com",
      image: null,
    };
    // Every aggregate query receives a read-only superset row. Aggregate
    // consumers read their named fields, while list consumers preserve the
    // declared recent-issue ordering. This is a response queue, not a SQL
    // emulator: no predicates or mutations are interpreted in test code.
    const universalRows = [
      {
        id: openIssueId,
        identifier: "USR-2",
        title: "Review profile copy",
        boardPresentationStatus: "in_progress",
        priority: "medium",
        ownerAgentId: null,
        ownerUserId: userId,
        updatedAt: now,
        completedAt: null,
        touchedIssues: 2,
        createdIssues: 1,
        completedIssues: 1,
        assignedOpenIssues: 1,
        count: 1,
        knownCostAmount: "42",
        pricedPromptCount: 1,
        unpricedPromptCount: 0,
        date: "1900-01-01",
        action: "issue.updated",
        entityType: "issue",
        entityId: doneIssueId,
        details: null,
        createdAt: now,
        agentId,
        agentName: "Coder",
      },
      {
        id: doneIssueId,
        identifier: "USR-1",
        title: "Ship profile page",
        boardPresentationStatus: "done",
        priority: "high",
        ownerAgentId: null,
        ownerUserId: null,
        updatedAt: new Date(now.getTime() - 1_000),
        completedAt: now,
        date: "1900-01-02",
      },
    ];
    const harness = createMockDb({
      select: [
        [companyUser],
        [{ budgetCurrency: "USD" }],
        ...Array.from({ length: 18 }, () => universalRows),
      ],
    });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = testBoardSessionActor({ userId, companyIds: [companyId] });
      next();
    });
    app.use("/api", userProfileRoutes(harness.db));
    app.use(errorHandler);

    const response = await request(app)
      .get(`/api/companies/${companyId}/users/dotta/profile`);

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.user).toMatchObject({
      id: userId,
      slug: "dotta",
      membershipRole: "owner",
      membershipStatus: "active",
    });
    expect(response.body.budgetCurrency).toBe("USD");
    expect(response.body.stats).toHaveLength(3);
    const all = response.body.stats.find((entry: { key: string }) => entry.key === "all");
    expect(all).toMatchObject({
      touchedIssues: 2,
      createdIssues: 1,
      completedIssues: 1,
      assignedOpenIssues: 1,
      commentCount: 1,
      activityCount: 1,
      knownCostAmount: "42",
      pricedPromptCount: 1,
      unpricedPromptCount: 0,
    });
    expect(response.body.daily).toHaveLength(14);
    expect(response.body.recentIssues.map((issue: { identifier: string }) => issue.identifier))
      .toEqual(["USR-2", "USR-1"]);
    expect(response.body.recentActivity[0].action).toBe("issue.updated");
    expect(response.body.topAgents[0]).toMatchObject({
      agentId,
      agentName: "Coder",
      knownCostAmount: "42",
      pricedPromptCount: 1,
      unpricedPromptCount: 0,
    });
    expect(harness.remaining("select")).toBe(0);
  });
});
