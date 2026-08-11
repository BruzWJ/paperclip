import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  financeEvents,
  goals,
  tasks,
  projects,
} from "@paperclipai/db";
import {
  canonicalizeMoneyAmount,
  compareMoneyAmounts,
  parseMoneyAmount,
  subtractMoneyAmounts,
  type FinanceDirection,
  type FinanceSummaryRow,
  type MoneyAmount,
} from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";

export interface FinanceDateRange {
  from?: Date;
  to?: Date;
}

function trustedAmount(value: string | null | undefined): MoneyAmount {
  return canonicalizeMoneyAmount(value ?? "0");
}

function parseFinanceCurrency(value: unknown) {
  if (typeof value !== "string" || !/^[A-Z]{3}$/.test(value)) {
    throw unprocessable(
      "Finance currency must be an exact uppercase three-letter code",
    );
  }
  return value;
}

async function assertBelongsToCompany(
  db: Db,
  table: any,
  id: string,
  companyId: string,
  label: string,
) {
  const row = await db
    .select()
    .from(table)
    .where(eq(table.id, id))
    .then((rows) => rows[0] ?? null);
  if (!row) throw notFound(`${label} not found`);
  if ((row as { companyId: string }).companyId !== companyId) {
    throw unprocessable(`${label} does not belong to company`);
  }
}

function rangeConditions(companyId: string, range?: FinanceDateRange) {
  const conditions = [eq(financeEvents.companyId, companyId)];
  if (range?.from) conditions.push(gte(financeEvents.occurredAt, range.from));
  if (range?.to) conditions.push(lte(financeEvents.occurredAt, range.to));
  return conditions;
}

function aggregateSelection() {
  return {
    debitAmount:
      sql<string>`coalesce(sum(case when ${financeEvents.direction} = 'debit' then ${financeEvents.amount} else 0 end), 0)::text`,
    creditAmount:
      sql<string>`coalesce(sum(case when ${financeEvents.direction} = 'credit' then ${financeEvents.amount} else 0 end), 0)::text`,
    estimatedDebitAmount:
      sql<string>`coalesce(sum(case when ${financeEvents.direction} = 'debit' and ${financeEvents.estimated} = true then ${financeEvents.amount} else 0 end), 0)::text`,
    eventCount: sql<number>`count(*)::int`,
  };
}

function netAmount(
  debitAmount: MoneyAmount,
  creditAmount: MoneyAmount,
): { netDirection: FinanceDirection; netAmount: MoneyAmount } {
  const comparison = compareMoneyAmounts(debitAmount, creditAmount);
  if (comparison >= 0) {
    return {
      netDirection: "debit",
      netAmount: subtractMoneyAmounts(debitAmount, creditAmount),
    };
  }
  return {
    netDirection: "credit",
    netAmount: subtractMoneyAmounts(creditAmount, debitAmount),
  };
}

function summaryRow(row: {
  currency: string;
  debitAmount: string;
  creditAmount: string;
  estimatedDebitAmount: string;
  eventCount: number;
}): FinanceSummaryRow {
  const debitAmount = trustedAmount(row.debitAmount);
  const creditAmount = trustedAmount(row.creditAmount);
  return {
    currency: row.currency,
    debitAmount,
    creditAmount,
    ...netAmount(debitAmount, creditAmount),
    estimatedDebitAmount: trustedAmount(row.estimatedDebitAmount),
    eventCount: Number(row.eventCount),
  };
}

export function financeService(db: Db) {
  return {
    createEvent: async (
      companyId: string,
      data: Omit<typeof financeEvents.$inferInsert, "companyId">,
    ) => {
      if (data.agentId) {
        await assertBelongsToCompany(db, agents, data.agentId, companyId, "Agent");
      }
      if (data.taskId) {
        await assertBelongsToCompany(db, tasks, data.taskId, companyId, "Task");
      }
      if (data.projectId) {
        await assertBelongsToCompany(db, projects, data.projectId, companyId, "Project");
      }
      if (data.goalId) {
        await assertBelongsToCompany(db, goals, data.goalId, companyId, "Goal");
      }
      const event = await db
        .insert(financeEvents)
        .values({
          ...data,
          companyId,
          amount: parseMoneyAmount(data.amount),
          currency: parseFinanceCurrency(data.currency),
          direction: data.direction ?? "debit",
          estimated: data.estimated ?? false,
        })
        .returning()
        .then((rows) => rows[0]!);
      return { ...event, amount: trustedAmount(event.amount) };
    },

    summary: async (companyId: string, range?: FinanceDateRange) => {
      const rows = await db
        .select({ currency: financeEvents.currency, ...aggregateSelection() })
        .from(financeEvents)
        .where(and(...rangeConditions(companyId, range)))
        .groupBy(financeEvents.currency)
        .orderBy(financeEvents.currency);
      return {
        companyId,
        currencies: rows.map(summaryRow),
      };
    },

    byBiller: async (companyId: string, range?: FinanceDateRange) => {
      const rows = await db
        .select({
          biller: financeEvents.biller,
          currency: financeEvents.currency,
          ...aggregateSelection(),
          kindCount:
            sql<number>`count(distinct ${financeEvents.eventKind})::int`,
        })
        .from(financeEvents)
        .where(and(...rangeConditions(companyId, range)))
        .groupBy(financeEvents.biller, financeEvents.currency)
        .orderBy(financeEvents.currency, financeEvents.biller);
      return rows.map((row) => ({
        biller: row.biller,
        ...summaryRow(row),
        kindCount: Number(row.kindCount),
      }));
    },

    byKind: async (companyId: string, range?: FinanceDateRange) => {
      const rows = await db
        .select({
          eventKind: financeEvents.eventKind,
          currency: financeEvents.currency,
          ...aggregateSelection(),
          billerCount: sql<number>`count(distinct ${financeEvents.biller})::int`,
        })
        .from(financeEvents)
        .where(and(...rangeConditions(companyId, range)))
        .groupBy(financeEvents.eventKind, financeEvents.currency)
        .orderBy(financeEvents.currency, financeEvents.eventKind);
      return rows.map((row) => ({
        eventKind: row.eventKind,
        ...summaryRow(row),
        billerCount: Number(row.billerCount),
      }));
    },

    list: async (
      companyId: string,
      range?: FinanceDateRange,
      limit = 100,
    ) => {
      const rows = await db
        .select()
        .from(financeEvents)
        .where(and(...rangeConditions(companyId, range)))
        .orderBy(desc(financeEvents.occurredAt), desc(financeEvents.createdAt))
        .limit(limit);
      return rows.map((row) => ({ ...row, amount: trustedAmount(row.amount) }));
    },
  };
}
