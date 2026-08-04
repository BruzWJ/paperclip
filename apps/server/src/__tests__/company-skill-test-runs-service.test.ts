import { describe, expect, it, vi } from "vitest";
import { companySkillService } from "../services/company-skills.js";
import { createMockDb } from "./helpers/mock-db.js";

const now = new Date("2026-02-03T04:05:06.000Z");

function testRunRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    companyId: "company-1",
    skillId: "skill-1",
    inputId: null,
    inputSnapshot: "Review this change.",
    skillVersionId: "version-1",
    agentId: "agent-1",
    agentConfigSnapshot: { model: "reviewer" },
    issueId: "issue-1",
    templateId: null,
    templateName: null,
    templateBody: null,
    renderedTemplateBody: null,
    harnessIssueRequest: "Review this change.",
    status: "queued",
    outputDocumentKey: "output",
    outputSnapshot: "",
    error: null,
    deletedAt: null,
    supersededAt: null,
    harnessIssueExpiresAt: null,
    harnessIssueDeletedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("companySkillService skill test runs", () => {
  it("marks only a queued, current run as running and hydrates canonical cost defaults", async () => {
    const running = testRunRow({ status: "running" });
    const mock = createMockDb({
      update: [[running]],
      select: [[{ budgetCurrency: "USD" }], []],
    });

    const result = await companySkillService(mock.db)
      .markTestRunRunning("company-1", "issue-1");

    expect(result).toMatchObject({
      id: "run-1",
      issueId: "issue-1",
      status: "running",
      harnessIssueRequest: "Review this change.",
      cost: {
        budgetCurrency: "USD",
        knownCostAmount: "0",
        pricedPromptCount: 0,
        unpricedPromptCount: 0,
      },
    });
    expect(mock.remaining("update")).toBe(0);
    expect(mock.remaining("select")).toBe(0);
  });

  it("requires cancellation before deleting an in-flight run", async () => {
    const mock = createMockDb({ select: [[testRunRow({ status: "running" })]] });
    const hideHarnessIssue = vi.fn();

    await expect(companySkillService(mock.db).deleteTestRun(
      "company-1",
      "skill-1",
      "run-1",
      { hideHarnessIssue },
    )).rejects.toMatchObject({ status: 422 });

    expect(hideHarnessIssue).not.toHaveBeenCalled();
    expect(mock.calls.some((call) => call.operation === "update")).toBe(false);
  });

  it("soft-deletes terminal history and hides its harness issue best-effort", async () => {
    const terminal = testRunRow({ status: "succeeded", outputSnapshot: "Reviewed." });
    const deleted = testRunRow({
      status: "succeeded",
      outputSnapshot: "Reviewed.",
      deletedAt: now,
      harnessIssueDeletedAt: now,
    });
    const mock = createMockDb({
      select: [[terminal], [{ budgetCurrency: "USD" }], []],
      update: [[deleted]],
    });
    const hideHarnessIssue = vi.fn().mockRejectedValue(new Error("already retained away"));

    const result = await companySkillService(mock.db).deleteTestRun(
      "company-1",
      "skill-1",
      "run-1",
      { hideHarnessIssue },
    );

    expect(result).toMatchObject({
      id: "run-1",
      status: "succeeded",
      outputSnapshot: "Reviewed.",
      issueExpired: true,
    });
    expect(hideHarnessIssue).toHaveBeenCalledWith("issue-1");
    expect(mock.remaining("select")).toBe(0);
    expect(mock.remaining("update")).toBe(0);
  });

  it("prunes each expired harness issue and records retention on the run", async () => {
    const mock = createMockDb({
      select: [[
        { id: "run-1", issueId: "issue-1" },
        { id: "run-2", issueId: "issue-2" },
      ]],
      update: [[], [], [], []],
    });

    await expect(companySkillService(mock.db)
      .pruneExpiredTestHarnessIssues("company-1", now))
      .resolves.toEqual({ pruned: 2 });

    const updateTargets = mock.calls
      .filter((call) => call.operation === "update" && call.method === "update");
    expect(updateTargets).toHaveLength(4);
    expect(mock.remaining("update")).toBe(0);
  });
});
