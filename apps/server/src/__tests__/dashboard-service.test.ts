import { beforeEach, describe, expect, it, vi } from "vitest";
import { dashboardService, getUtcMonthStart } from "../services/dashboard.ts";
import { createMockDb } from "./helpers/mock-db.js";

const mocks = vi.hoisted(() => ({
  listRuns: vi.fn(),
  costSummary: vi.fn(),
  budgetOverview: vi.fn(),
}));

vi.mock("../services/task-execution-run-service.js", () => ({
  listTaskExecutionRunsForActivity: mocks.listRuns,
}));

vi.mock("../services/costs.js", () => ({
  costService: () => ({ summary: mocks.costSummary }),
}));

vi.mock("../services/budgets.js", () => ({
  budgetService: () => ({ overview: mocks.budgetOverview }),
}));

const companyId = "00000000-0000-4000-8000-000000000001";

function utcDay(offsetDays: number): Date {
  const now = new Date();
  const day = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offsetDays, 12);
  return new Date(day);
}

function utcDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function run(
  runId: string,
  status: "succeeded" | "failed" | "timed_out" | "cancelled",
  createdAt: Date,
  input: { retryOfRunId?: string | null; terminalReasonCode?: string | null } = {},
) {
  return {
    runId,
    status,
    createdAt,
    retryOfRunId: input.retryOfRunId ?? null,
    terminalReasonCode: input.terminalReasonCode ?? null,
  };
}

function createDashboardDb() {
  return createMockDb({
    select: [
      [{ id: companyId }],
      [],
      [],
      [{ count: 0 }],
    ],
  }).db;
}

describe("getUtcMonthStart", () => {
  it("anchors the monthly spend window to UTC month boundaries", () => {
    expect(getUtcMonthStart(new Date("2026-03-31T20:30:00.000-05:00")).toISOString()).toBe(
      "2026-04-01T00:00:00.000Z",
    );
    expect(getUtcMonthStart(new Date("2026-04-01T00:30:00.000+14:00")).toISOString()).toBe(
      "2026-03-01T00:00:00.000Z",
    );
  });
});

describe("dashboard service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.costSummary.mockResolvedValue({
      budgetCurrency: "USD",
      knownSpendAmount: "0",
      budgetMonthlyAmount: "0",
      remainingAmount: "0",
      utilizationPercent: 0,
      unpricedPromptCount: 0,
    });
    mocks.budgetOverview.mockResolvedValue({
      activeIncidents: [],
      pendingApprovalCount: 0,
      pausedAgentCount: 0,
      pausedProjectCount: 0,
    });
  });

  it("aggregates the full 14-day run activity window without recent-run truncation", async () => {
    const today = utcDay(0);
    const weekAgo = utcDay(-7);
    const runs = [
      ...Array.from({ length: 105 }, (_, index) =>
        run(`run-today-${index}`, "succeeded", today)),
      run("run-failed", "failed", weekAgo),
      run("run-timed-out", "timed_out", weekAgo),
      run("run-cancelled", "cancelled", weekAgo),
    ];
    mocks.listRuns.mockResolvedValue({ items: runs, nextCursor: null });

    const summary = await dashboardService(createDashboardDb()).summary(companyId);

    expect(summary.runActivity).toHaveLength(14);
    const todayBucket = summary.runActivity.find((bucket) => bucket.date === utcDateKey(today));
    const weekAgoBucket = summary.runActivity.find((bucket) => bucket.date === utcDateKey(weekAgo));
    expect(todayBucket).toMatchObject({
      succeeded: 105,
      failed: 0,
      recovered: 0,
      other: 0,
      total: 105,
      failedByErrorCode: {},
    });
    expect(weekAgoBucket).toMatchObject({
      succeeded: 0,
      failed: 2,
      recovered: 0,
      other: 1,
      total: 3,
      failedByErrorCode: { unknown: 2 },
    });
    expect(mocks.listRuns).toHaveBeenCalledWith(expect.anything(), {
      companyId,
      cursor: null,
      limit: 200,
    });
  });

  it("separates recovered worker-loss runs from true failures and breaks failures down by error code", async () => {
    const day = utcDay(-2);
    mocks.listRuns.mockResolvedValue({
      items: [
        run("original", "failed", day, { terminalReasonCode: "worker_loss_after_prompt" }),
        run("retry", "succeeded", day, { retryOfRunId: "original" }),
        run("chain-original", "failed", day, { terminalReasonCode: "worker_loss_after_prompt" }),
        run("chain-retry", "failed", day, {
          retryOfRunId: "chain-original",
          terminalReasonCode: "worker_loss_after_prompt",
        }),
        run("chain-success", "succeeded", day, { retryOfRunId: "chain-retry" }),
        run("transport", "failed", day, { terminalReasonCode: "transport_transient" }),
      ],
      nextCursor: null,
    });

    const summary = await dashboardService(createDashboardDb()).summary(companyId);
    const bucket = summary.runActivity.find((entry) => entry.date === utcDateKey(day));

    expect(bucket).toMatchObject({
      succeeded: 2,
      recovered: 3,
      failed: 1,
      other: 0,
      total: 6,
      failedByErrorCode: { transport_transient: 1 },
    });
    expect(bucket?.failedByErrorCode.worker_loss_after_prompt).toBeUndefined();
  });
});
