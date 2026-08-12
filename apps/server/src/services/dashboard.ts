import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, approvals, companies, tasks } from "@paperclipai/db";
import { notFound } from "../errors.js";
import { budgetService } from "./budgets.js";
import { visibleTaskCondition } from "./task-visibility.js";
import { costService } from "./costs.js";
import {
  listTaskExecutionRunsForActivity,
  type TaskExecutionRunEnvelope,
  type TaskExecutionRunListCursor,
} from "./task-execution-run-service.js";

const DASHBOARD_RUN_ACTIVITY_DAYS = 14;

function formatUtcDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function getUtcMonthStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function getRecentUtcDateKeys(now: Date, days: number): string[] {
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Array.from({ length: days }, (_, index) => {
    const dayOffset = index - (days - 1);
    return formatUtcDateKey(new Date(todayUtc + dayOffset * 24 * 60 * 60 * 1000));
  });
}

export function dashboardService(db: Db) {
  const budgets = budgetService(db);
  const costs = costService(db);
  return {
    summary: async (companyId: string) => {
      const company = await db
        .select()
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0] ?? null);

      if (!company) throw notFound("Company not found");

      const agentRows = await db
        .select({ status: agents.status, count: sql<number>`count(*)` })
        .from(agents)
        .where(eq(agents.companyId, companyId))
        .groupBy(agents.status);

      const taskRows = await db
        .select({ status: tasks.boardPresentationStatus, count: sql<number>`count(*)` })
        .from(tasks)
        .where(and(eq(tasks.companyId, companyId), visibleTaskCondition()))
        .groupBy(tasks.boardPresentationStatus);

      const pendingApprovals = await db
        .select({ count: sql<number>`count(*)` })
        .from(approvals)
        .where(and(eq(approvals.companyId, companyId), eq(approvals.status, "pending")))
        .then((rows) => Number(rows[0]?.count ?? 0));

      const agentCounts: Record<string, number> = {
        idle: 0,
        paused: 0,
        error: 0,
      };
      for (const row of agentRows) {
        const count = Number(row.count);
        agentCounts[row.status] = (agentCounts[row.status] ?? 0) + count;
      }

      const taskCounts: Record<string, number> = {
        open: 0,
        inProgress: 0,
        blocked: 0,
        done: 0,
      };
      for (const row of taskRows) {
        const count = Number(row.count);
        if (row.status === "in_progress") taskCounts.inProgress += count;
        if (row.status === "blocked") taskCounts.blocked += count;
        if (row.status === "done") taskCounts.done += count;
        if (row.status !== "done" && row.status !== "cancelled") taskCounts.open += count;
      }

      const now = new Date();
      const runActivityDays = getRecentUtcDateKeys(now, DASHBOARD_RUN_ACTIVITY_DAYS);
      const runActivityStart = new Date(`${runActivityDays[0]}T00:00:00.000Z`);
      const costSummary = await costs.summary(companyId);
      const companyRuns: TaskExecutionRunEnvelope[] = [];
      let runCursor: TaskExecutionRunListCursor | null = null;
      do {
        const page = await listTaskExecutionRunsForActivity(db, {
          companyId,
          cursor: runCursor,
          limit: 200,
        });
        companyRuns.push(...page.items);
        runCursor = page.nextCursor;
      } while (runCursor !== null);
      const runById = new Map(companyRuns.map((run) => [run.runId, run]));
      const recoveredRunIds = new Set<string>();
      for (const run of companyRuns) {
        if (run.status !== "succeeded") continue;
        let ancestorId = run.retryOfRunId;
        const visited = new Set<string>();
        while (ancestorId && !visited.has(ancestorId)) {
          visited.add(ancestorId);
          recoveredRunIds.add(ancestorId);
          ancestorId = runById.get(ancestorId)?.retryOfRunId ?? null;
        }
      }

      const runActivity = new Map(
        runActivityDays.map((date) => [
          date,
          {
            date,
            succeeded: 0,
            failed: 0,
            recovered: 0,
            other: 0,
            total: 0,
            failedByErrorCode: {} as Record<string, number>,
          },
        ]),
      );
      for (const run of companyRuns) {
        if (run.createdAt < runActivityStart) continue;
        const bucket = runActivity.get(formatUtcDateKey(run.createdAt));
        if (!bucket) continue;
        if (run.status === "succeeded") {
          bucket.succeeded += 1;
        } else if (run.status === "failed" || run.status === "timed_out") {
          if (recoveredRunIds.has(run.runId)) {
            bucket.recovered += 1;
          } else {
            bucket.failed += 1;
            const code =
              run.terminalReasonCode && run.terminalReasonCode.length > 0
                ? run.terminalReasonCode
                : "unknown";
            bucket.failedByErrorCode[code] = (bucket.failedByErrorCode[code] ?? 0) + 1;
          }
        } else {
          bucket.other += 1;
        }
        bucket.total += 1;
      }

      const budgetOverview = await budgets.overview(companyId);

      return {
        companyId,
        agents: {
          idle: agentCounts.idle,
          paused: agentCounts.paused,
          error: agentCounts.error,
        },
        tasks: taskCounts,
        costs: {
          budgetCurrency: costSummary.budgetCurrency,
          monthKnownSpendAmount: costSummary.knownSpendAmount,
          monthBudgetAmount: costSummary.budgetMonthlyAmount,
          monthRemainingAmount: costSummary.remainingAmount,
          monthUtilizationPercent: costSummary.utilizationPercent,
          unpricedPromptCount: costSummary.unpricedPromptCount,
        },
        pendingApprovals,
        budgets: {
          activeIncidents: budgetOverview.activeIncidents.length,
          pendingApprovals: budgetOverview.pendingApprovalCount,
          pausedAgents: budgetOverview.pausedAgentCount,
          pausedProjects: budgetOverview.pausedProjectCount,
        },
        runActivity: Array.from(runActivity.values()),
      };
    },
  };
}
