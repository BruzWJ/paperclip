import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { type Db, agents, companies, costEvents, tasks, projects } from "@paperclipai/db";
import {
  canonicalizeMoneyAmount,
  compareMoneyAmounts,
  moneyAmountUtilizationPercent,
  parseBudgetCurrency,
  parseMoneyAmount,
  subtractMoneyAmounts,
  type BudgetCurrency,
  type CostEvent,
  type MoneyAmount,
} from "@paperclipai/shared";
import { notFound } from "../errors.js";
import { visibleTaskCondition } from "./task-visibility.js";
import {
  listTaskExecutionRunsForTask,
  type TaskExecutionRunEnvelope,
  type TaskExecutionRunListCursor,
} from "./task-execution-run-service.js";

export interface CostDateRange {
  from?: Date;
  to?: Date;
}

const ZERO_AMOUNT = parseMoneyAmount("0");

function trustedAmount(value: string | null | undefined): MoneyAmount {
  return canonicalizeMoneyAmount(value ?? "0");
}

function currentUtcMonthWindow(now = new Date()) {
  return {
    from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0)),
    to: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0)),
  };
}

function remaining(spend: MoneyAmount, limit: MoneyAmount) {
  return compareMoneyAmounts(spend, limit) >= 0 ? ZERO_AMOUNT : subtractMoneyAmounts(limit, spend);
}

function dateConditions(companyId: string, range?: CostDateRange) {
  const conditions = [eq(costEvents.companyId, companyId)];
  if (range?.from) conditions.push(gte(costEvents.occurredAt, range.from));
  if (range?.to) conditions.push(lte(costEvents.occurredAt, range.to));
  return conditions;
}

function costAggregateSelection() {
  return {
    knownAmount: sql<string>`coalesce(sum(${costEvents.knownDeltaAmount}) filter (where ${costEvents.kind} = 'known'), 0)::text`,
    pricedPromptCount: sql<number>`count(*) filter (where ${costEvents.kind} = 'known')::int`,
    unpricedPromptCount: sql<number>`count(*) filter (where ${costEvents.kind} = 'unavailable')::int`,
  };
}

function toCostEvent(row: typeof costEvents.$inferSelect): CostEvent {
  return {
    ...row,
    budgetCurrency: parseBudgetCurrency(row.budgetCurrency),
    observedCumulativeAmount:
      row.observedCumulativeAmount === null ? null : trustedAmount(row.observedCumulativeAmount),
    knownDeltaAmount: row.knownDeltaAmount === null ? null : trustedAmount(row.knownDeltaAmount),
    cursorBeforeAmount: row.cursorBeforeAmount === null ? null : trustedAmount(row.cursorBeforeAmount),
    cursorBeforeCurrency:
      row.cursorBeforeCurrency === null ? null : parseBudgetCurrency(row.cursorBeforeCurrency),
    cursorAfterAmount: row.cursorAfterAmount === null ? null : trustedAmount(row.cursorAfterAmount),
    cursorAfterCurrency:
      row.cursorAfterCurrency === null ? null : parseBudgetCurrency(row.cursorAfterCurrency),
  };
}

async function requireCompanyAccounting(
  db: Db,
  companyId: string,
): Promise<{
  budgetCurrency: BudgetCurrency;
  budgetMonthlyAmount: MoneyAmount;
}> {
  const row = await db
    .select({
      budgetCurrency: companies.budgetCurrency,
      budgetMonthlyAmount: companies.budgetMonthlyAmount,
    })
    .from(companies)
    .where(eq(companies.id, companyId))
    .then((rows) => rows[0] ?? null);
  if (!row) throw notFound("Company not found");
  return {
    budgetCurrency: parseBudgetCurrency(row.budgetCurrency),
    budgetMonthlyAmount: trustedAmount(row.budgetMonthlyAmount),
  };
}

export function costService(db: Db) {
  return {
    summary: async (companyId: string, range?: CostDateRange) => {
      const company = await requireCompanyAccounting(db, companyId);
      const effectiveRange = range ?? currentUtcMonthWindow();
      const row = await db
        .select(costAggregateSelection())
        .from(costEvents)
        .where(and(...dateConditions(companyId, effectiveRange)))
        .then((rows) => rows[0]);
      const knownSpendAmount = trustedAmount(row?.knownAmount);
      return {
        companyId,
        budgetCurrency: company.budgetCurrency,
        knownSpendAmount,
        budgetMonthlyAmount: company.budgetMonthlyAmount,
        remainingAmount: remaining(knownSpendAmount, company.budgetMonthlyAmount),
        utilizationPercent: moneyAmountUtilizationPercent(knownSpendAmount, company.budgetMonthlyAmount),
        pricedPromptCount: Number(row?.pricedPromptCount ?? 0),
        unpricedPromptCount: Number(row?.unpricedPromptCount ?? 0),
      };
    },

    taskTreeSummary: async (companyId: string, taskId: string, options: { excludeRoot?: boolean } = {}) => {
      const { budgetCurrency } = await requireCompanyAccounting(db, companyId);
      const visibleTasks = await db
        .select({ id: tasks.id, parentId: tasks.parentId })
        .from(tasks)
        .where(and(eq(tasks.companyId, companyId), visibleTaskCondition()));
      const visibleTaskIds = new Set(visibleTasks.map((task) => task.id));
      const childrenByParentId = new Map<string, string[]>();
      for (const task of visibleTasks) {
        if (!task.parentId) continue;
        const children = childrenByParentId.get(task.parentId) ?? [];
        children.push(task.id);
        childrenByParentId.set(task.parentId, children);
      }
      const pending = options.excludeRoot
        ? [...(childrenByParentId.get(taskId) ?? [])]
        : visibleTaskIds.has(taskId)
          ? [taskId]
          : [];
      const taskTreeIds: string[] = [];
      const visited = new Set<string>();
      while (pending.length > 0) {
        const currentId = pending.pop()!;
        if (visited.has(currentId)) continue;
        visited.add(currentId);
        taskTreeIds.push(currentId);
        pending.push(...(childrenByParentId.get(currentId) ?? []));
      }

      const costRows =
        taskTreeIds.length === 0
          ? []
          : await db
              .select({
                taskCount: sql<number>`count(distinct ${tasks.id})::int`,
                ...costAggregateSelection(),
              })
              .from(tasks)
              .leftJoin(costEvents, and(eq(costEvents.companyId, companyId), eq(costEvents.taskId, tasks.id)))
              .where(
                and(eq(tasks.companyId, companyId), visibleTaskCondition(), inArray(tasks.id, taskTreeIds)),
              );
      const runPages = await Promise.all(
        taskTreeIds.map(async (treeTaskId) => {
          const runs: TaskExecutionRunEnvelope[] = [];
          let cursor: TaskExecutionRunListCursor | null = null;
          do {
            const page = await listTaskExecutionRunsForTask(db, {
              companyId,
              taskId: treeTaskId,
              cursor,
              limit: 200,
            });
            runs.push(...page.items);
            cursor = page.nextCursor;
          } while (cursor !== null);
          return runs;
        }),
      );
      const startedRuns = runPages.flat().filter((run) => run.startedAt !== null);
      const runtimeCutoff = new Date();
      const costRow = costRows[0];
      return {
        taskId,
        taskCount: Number(costRow?.taskCount ?? 0),
        includeDescendants: true,
        budgetCurrency,
        knownCostAmount: trustedAmount(costRow?.knownAmount),
        pricedPromptCount: Number(costRow?.pricedPromptCount ?? 0),
        unpricedPromptCount: Number(costRow?.unpricedPromptCount ?? 0),
        runCount: startedRuns.length,
        runtimeMs: startedRuns.reduce(
          (total, run) => total + ((run.finishedAt ?? runtimeCutoff).getTime() - run.startedAt!.getTime()),
          0,
        ),
      };
    },

    byAgent: async (companyId: string, range?: CostDateRange) => {
      const { budgetCurrency } = await requireCompanyAccounting(db, companyId);
      const rows = await db
        .select({
          agentId: costEvents.agentId,
          agentName: agents.name,
          agentStatus: agents.status,
          ...costAggregateSelection(),
        })
        .from(costEvents)
        .leftJoin(agents, eq(costEvents.agentId, agents.id))
        .where(and(...dateConditions(companyId, range)))
        .groupBy(costEvents.agentId, agents.name, agents.status)
        .orderBy(
          desc(
            sql`coalesce(sum(${costEvents.knownDeltaAmount}) filter (where ${costEvents.kind} = 'known'), 0)`,
          ),
        );
      return rows.map((row) => ({
        agentId: row.agentId,
        agentName: row.agentName,
        agentStatus: row.agentStatus,
        budgetCurrency,
        knownCostAmount: trustedAmount(row.knownAmount),
        pricedPromptCount: Number(row.pricedPromptCount),
        unpricedPromptCount: Number(row.unpricedPromptCount),
      }));
    },

    byProject: async (companyId: string, range?: CostDateRange) => {
      const { budgetCurrency } = await requireCompanyAccounting(db, companyId);
      const rows = await db
        .select({
          projectId: tasks.projectId,
          projectName: projects.name,
          ...costAggregateSelection(),
        })
        .from(costEvents)
        .innerJoin(tasks, and(eq(tasks.id, costEvents.taskId), eq(tasks.companyId, costEvents.companyId)))
        .leftJoin(projects, eq(projects.id, tasks.projectId))
        .where(and(...dateConditions(companyId, range)))
        .groupBy(tasks.projectId, projects.name)
        .orderBy(
          desc(
            sql`coalesce(sum(${costEvents.knownDeltaAmount}) filter (where ${costEvents.kind} = 'known'), 0)`,
          ),
        );
      return rows.map((row) => ({
        projectId: row.projectId,
        projectName: row.projectName,
        budgetCurrency,
        knownCostAmount: trustedAmount(row.knownAmount),
        pricedPromptCount: Number(row.pricedPromptCount),
        unpricedPromptCount: Number(row.unpricedPromptCount),
      }));
    },

    listEvents: async (companyId: string, range?: CostDateRange, limit = 100) => {
      await requireCompanyAccounting(db, companyId);
      const rows = await db
        .select()
        .from(costEvents)
        .where(and(...dateConditions(companyId, range)))
        .orderBy(desc(costEvents.occurredAt), desc(costEvents.id))
        .limit(limit);
      return rows.map(toCostEvent);
    },
  };
}
