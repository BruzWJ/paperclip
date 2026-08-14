import { and, eq, gte, lt, sql } from "drizzle-orm";
import {
  agents,
  companies,
  costEvents,
  projects,
  tasks,
  type Db,
  type budgetIncidents,
  type budgetPolicies,
} from "@paperclipai/db";
import {
  canonicalizeMoneyAmount,
  compareMoneyAmounts,
  isCanonicalUuid,
  parseBudgetCurrency,
  parseMoneyAmount,
  subtractMoneyAmounts,
  type BudgetCurrency,
  type BudgetPolicy,
  type BudgetPolicySummary,
  type BudgetScopeType,
  type BudgetThresholdType,
  type BudgetWindowKind,
  type MoneyAmount,
  type PauseReason,
} from "@paperclipai/shared";
import { notFound } from "../errors.js";
import { type PersistedActivityLog } from "./activity-log.js";

export function createBudgetsContext(db: Db, hooks: BudgetServiceHooks = {}) {
  return { db, hooks };
}

export type BudgetsContext = ReturnType<typeof createBudgetsContext>;

export type PolicyRow = typeof budgetPolicies.$inferSelect;

export type IncidentRow = typeof budgetIncidents.$inferSelect;

export type CompanyInsert = typeof companies.$inferInsert;

export type ScopeRecord = {
  companyId: string;
  name: string;
  paused: boolean;
  pauseReason: PauseReason | null;
};

export type BudgetEnforcementScope = {
  companyId: string;
  scopeType: BudgetScopeType;
  scopeId: string;
};

export type BudgetServiceHooks = {
  suspendWorkForScope?: (scope: BudgetEnforcementScope) => Promise<unknown>;
  resumeWorkForScope?: (scope: BudgetEnforcementScope) => Promise<unknown>;
};

export type BudgetScopeEnforcementAction = "suspend" | "resume" | null;

export type CommittedBudgetPolicyUpsert = {
  row: PolicyRow;
  budgetCurrency: BudgetCurrency;
  enforcementAction: BudgetScopeEnforcementAction;
  enforcementScope: BudgetEnforcementScope;
  activity: PersistedActivityLog;
};

export type CanonicalCompanyCreation = Omit<
  CompanyInsert,
  "budgetCurrency" | "budgetMonthlyAmount" | "taskPrefix"
> & {
  budgetCurrency?: unknown;
  budgetMonthlyAmount?: unknown;
};

export type CanonicalAgentCreation = Omit<typeof agents.$inferInsert, "budgetMonthlyAmount"> & {
  budgetMonthlyAmount?: unknown;
};

export const ZERO_AMOUNT = parseMoneyAmount("0");

export const COMPANY_PREFIX_FALLBACK = "CMP";

export function assertCanonicalBudgetIncidentId(incidentId: string): void {
  if (!isCanonicalUuid(incidentId)) {
    throw notFound("Budget incident not found");
  }
}

export function currentUtcMonthWindow(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0));
  return { start, end };
}

export function resolveWindow(windowKind: BudgetWindowKind, now = new Date()) {
  if (windowKind === "lifetime") {
    return {
      start: new Date(Date.UTC(1970, 0, 1, 0, 0, 0, 0)),
      end: new Date(Date.UTC(9999, 0, 1, 0, 0, 0, 0)),
    };
  }
  return currentUtcMonthWindow(now);
}

export function trustedAmount(value: string): MoneyAmount {
  return canonicalizeMoneyAmount(value);
}

export function decimalParts(value: MoneyAmount) {
  const [integer, fraction = ""] = value.split(".");
  return {
    units: BigInt(`${integer}${fraction}`),
    scale: fraction.length,
  };
}

export function alignAmounts(left: MoneyAmount, right: MoneyAmount) {
  const leftParts = decimalParts(left);
  const rightParts = decimalParts(right);
  const scale = Math.max(leftParts.scale, rightParts.scale);
  return {
    left: leftParts.units * 10n ** BigInt(scale - leftParts.scale),
    right: rightParts.units * 10n ** BigInt(scale - rightParts.scale),
  };
}

export function reachesPercent(observedAmount: MoneyAmount, limitAmount: MoneyAmount, percent: number) {
  const aligned = alignAmounts(observedAmount, limitAmount);
  return aligned.left * 100n >= aligned.right * BigInt(percent);
}

export function budgetStatusFromObserved(
  observedAmount: MoneyAmount,
  limitAmount: MoneyAmount,
  warnPercent: number,
): BudgetPolicySummary["status"] {
  if (compareMoneyAmounts(limitAmount, ZERO_AMOUNT) === 0) return "ok";
  if (compareMoneyAmounts(observedAmount, limitAmount) >= 0) {
    return "hard_stop";
  }
  return reachesPercent(observedAmount, limitAmount, warnPercent) ? "warning" : "ok";
}

export function remainingAmount(observedAmount: MoneyAmount, limitAmount: MoneyAmount) {
  return compareMoneyAmounts(observedAmount, limitAmount) >= 0
    ? ZERO_AMOUNT
    : subtractMoneyAmounts(limitAmount, observedAmount);
}

export function normalizeScopeName(scopeType: BudgetScopeType, name: string) {
  if (scopeType === "company") return name;
  return name.trim().length > 0 ? name : scopeType;
}

export function prefixBase(name: string) {
  return (
    name
      .toUpperCase()
      .replace(/[^A-Z]/g, "")
      .slice(0, 3) || COMPANY_PREFIX_FALLBACK
  );
}

export function prefixForAttempt(base: string, attempt: number) {
  return attempt === 1 ? base : `${base}${"A".repeat(attempt - 1)}`;
}

export function isTaskPrefixConflict(error: unknown) {
  const seen = new Set<unknown>();
  let current = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    const candidate = current as {
      code?: string;
      constraint?: string;
      constraint_name?: string;
      cause?: unknown;
    };
    if (
      candidate.code === "23505" &&
      (candidate.constraint ?? candidate.constraint_name) === "companies_task_prefix_idx"
    ) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

export async function resolveScopeRecord(
  database: Db,
  scopeType: BudgetScopeType,
  scopeId: string,
  lock = false,
): Promise<ScopeRecord> {
  if (scopeType === "company") {
    const query = database
      .select({
        companyId: companies.id,
        name: companies.name,
        status: companies.status,
        pauseReason: companies.pauseReason,
        pausedAt: companies.pausedAt,
      })
      .from(companies)
      .where(eq(companies.id, scopeId));
    const row = await (lock ? query.for("update") : query).then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Company not found");
    return {
      companyId: row.companyId,
      name: row.name,
      paused: row.status === "paused" || Boolean(row.pausedAt),
      pauseReason: (row.pauseReason as PauseReason | null) ?? null,
    };
  }

  if (scopeType === "agent") {
    const query = database
      .select({
        companyId: agents.companyId,
        name: agents.name,
        status: agents.status,
        pauseReason: agents.pauseReason,
      })
      .from(agents)
      .where(eq(agents.id, scopeId));
    const row = await (lock ? query.for("update") : query).then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Agent not found");
    return {
      companyId: row.companyId,
      name: row.name,
      paused: row.status === "paused",
      pauseReason: (row.pauseReason as PauseReason | null) ?? null,
    };
  }

  const query = database
    .select({
      companyId: projects.companyId,
      name: projects.name,
      pauseReason: projects.pauseReason,
      pausedAt: projects.pausedAt,
    })
    .from(projects)
    .where(eq(projects.id, scopeId));
  const row = await (lock ? query.for("update") : query).then((rows) => rows[0] ?? null);
  if (!row) throw notFound("Project not found");
  return {
    companyId: row.companyId,
    name: row.name,
    paused: Boolean(row.pausedAt),
    pauseReason: (row.pauseReason as PauseReason | null) ?? null,
  };
}

export async function companyCurrency(
  database: Db,
  companyId: string,
  lock = false,
): Promise<BudgetCurrency> {
  const query = database
    .select({ budgetCurrency: companies.budgetCurrency })
    .from(companies)
    .where(eq(companies.id, companyId));
  const row = await (lock ? query.for("update") : query).then((rows) => rows[0] ?? null);
  if (!row) throw notFound("Company not found");
  return parseBudgetCurrency(row.budgetCurrency);
}

export async function computeObservedAmount(database: Db, policy: PolicyRow) {
  const conditions = [eq(costEvents.companyId, policy.companyId), eq(costEvents.kind, "known")];
  if (policy.scopeType === "agent") {
    conditions.push(eq(costEvents.agentId, policy.scopeId));
  }
  if (policy.scopeType === "project") {
    conditions.push(eq(tasks.projectId, policy.scopeId));
  }
  const { start, end } = resolveWindow(policy.windowKind as BudgetWindowKind);
  if (policy.windowKind === "calendar_month_utc") {
    conditions.push(gte(costEvents.occurredAt, start));
    conditions.push(lt(costEvents.occurredAt, end));
  }
  const row = await database
    .select({
      total: sql<string>`coalesce(sum(${costEvents.knownDeltaAmount}), 0)::text`,
    })
    .from(costEvents)
    .innerJoin(tasks, and(eq(tasks.id, costEvents.taskId), eq(tasks.companyId, costEvents.companyId)))
    .where(and(...conditions))
    .then((rows) => rows[0]);
  return trustedAmount(row?.total ?? "0");
}

export function policyToPublic(row: PolicyRow, budgetCurrency: BudgetCurrency): BudgetPolicy {
  return {
    ...row,
    budgetCurrency,
    scopeType: row.scopeType as BudgetScopeType,
    windowKind: row.windowKind as BudgetWindowKind,
    limitAmount: trustedAmount(row.limitAmount),
  };
}

export function buildApprovalPayload(input: {
  policy: PolicyRow;
  budgetCurrency: BudgetCurrency;
  scopeName: string;
  thresholdType: BudgetThresholdType;
  observedAmount: MoneyAmount;
  windowStart: Date;
  windowEnd: Date;
}) {
  return {
    scopeType: input.policy.scopeType,
    scopeId: input.policy.scopeId,
    scopeName: input.scopeName,
    budgetCurrency: input.budgetCurrency,
    windowKind: input.policy.windowKind,
    thresholdType: input.thresholdType,
    limitAmount: trustedAmount(input.policy.limitAmount),
    observedAmount: input.observedAmount,
    warnPercent: input.policy.warnPercent,
    windowStart: input.windowStart.toISOString(),
    windowEnd: input.windowEnd.toISOString(),
    policyId: input.policy.id,
    guidance: "Raise the budget and resume the scope, or keep the scope paused.",
  };
}
