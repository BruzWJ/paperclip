import { and, desc, eq, gte, inArray, lt, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  approvals,
  budgetIncidents,
  budgetPolicies,
  companies,
  costEvents,
  tasks,
  projects,
} from "@paperclipai/db";
import {
  canonicalizeMoneyAmount,
  addMoneyAmounts,
  compareMoneyAmounts,
  isCanonicalUuid,
  moneyAmountUtilizationPercent,
  parseBudgetCurrency,
  parseMoneyAmount,
  subtractMoneyAmounts,
  type BudgetCurrency,
  type BudgetIncident,
  type BudgetIncidentResolutionInput,
  type BudgetOverview,
  type BudgetPolicy,
  type BudgetPolicySummary,
  type BudgetPolicyUpsertInput,
  type BudgetScopeType,
  type BudgetThresholdType,
  type BudgetWindowKind,
  type MoneyAmount,
  type PauseReason,
} from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";
import { logActivity } from "./activity-log.js";

type PolicyRow = typeof budgetPolicies.$inferSelect;
type IncidentRow = typeof budgetIncidents.$inferSelect;
type CompanyInsert = typeof companies.$inferInsert;

type ScopeRecord = {
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

type BudgetScopeEnforcementAction = "suspend" | "resume" | null;

export type CanonicalCompanyCreation = Omit<
  CompanyInsert,
  "budgetCurrency" | "budgetMonthlyAmount" | "taskPrefix"
> & {
  budgetCurrency?: unknown;
  budgetMonthlyAmount?: unknown;
};

export type CanonicalAgentCreation = Omit<
  typeof agents.$inferInsert,
  "budgetMonthlyAmount"
> & {
  budgetMonthlyAmount?: unknown;
};

const ZERO_AMOUNT = parseMoneyAmount("0");
const COMPANY_PREFIX_FALLBACK = "CMP";

function assertCanonicalBudgetIncidentId(incidentId: string): void {
  if (!isCanonicalUuid(incidentId)) {
    throw notFound("Budget incident not found");
  }
}

function currentUtcMonthWindow(now = new Date()) {
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0),
  );
  const end = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0),
  );
  return { start, end };
}

function resolveWindow(windowKind: BudgetWindowKind, now = new Date()) {
  if (windowKind === "lifetime") {
    return {
      start: new Date(Date.UTC(1970, 0, 1, 0, 0, 0, 0)),
      end: new Date(Date.UTC(9999, 0, 1, 0, 0, 0, 0)),
    };
  }
  return currentUtcMonthWindow(now);
}

function trustedAmount(value: string): MoneyAmount {
  return canonicalizeMoneyAmount(value);
}

function decimalParts(value: MoneyAmount) {
  const [integer, fraction = ""] = value.split(".");
  return {
    units: BigInt(`${integer}${fraction}`),
    scale: fraction.length,
  };
}

function alignAmounts(left: MoneyAmount, right: MoneyAmount) {
  const leftParts = decimalParts(left);
  const rightParts = decimalParts(right);
  const scale = Math.max(leftParts.scale, rightParts.scale);
  return {
    left: leftParts.units * 10n ** BigInt(scale - leftParts.scale),
    right: rightParts.units * 10n ** BigInt(scale - rightParts.scale),
  };
}

function reachesPercent(
  observedAmount: MoneyAmount,
  limitAmount: MoneyAmount,
  percent: number,
) {
  const aligned = alignAmounts(observedAmount, limitAmount);
  return aligned.left * 100n >= aligned.right * BigInt(percent);
}

function budgetStatusFromObserved(
  observedAmount: MoneyAmount,
  limitAmount: MoneyAmount,
  warnPercent: number,
): BudgetPolicySummary["status"] {
  if (compareMoneyAmounts(limitAmount, ZERO_AMOUNT) === 0) return "ok";
  if (compareMoneyAmounts(observedAmount, limitAmount) >= 0) {
    return "hard_stop";
  }
  return reachesPercent(observedAmount, limitAmount, warnPercent)
    ? "warning"
    : "ok";
}

function remainingAmount(
  observedAmount: MoneyAmount,
  limitAmount: MoneyAmount,
) {
  return compareMoneyAmounts(observedAmount, limitAmount) >= 0
    ? ZERO_AMOUNT
    : subtractMoneyAmounts(limitAmount, observedAmount);
}

function normalizeScopeName(scopeType: BudgetScopeType, name: string) {
  if (scopeType === "company") return name;
  return name.trim().length > 0 ? name : scopeType;
}

function prefixBase(name: string) {
  return name.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3) ||
    COMPANY_PREFIX_FALLBACK;
}

function prefixForAttempt(base: string, attempt: number) {
  return attempt === 1 ? base : `${base}${"A".repeat(attempt - 1)}`;
}

function isTaskPrefixConflict(error: unknown) {
  const seen = new Set<unknown>();
  let current = error;
  while (
    typeof current === "object" &&
    current !== null &&
    !seen.has(current)
  ) {
    seen.add(current);
    const candidate = current as {
      code?: string;
      constraint?: string;
      constraint_name?: string;
      cause?: unknown;
    };
    if (
      candidate.code === "23505" &&
      (candidate.constraint ?? candidate.constraint_name) ===
        "companies_task_prefix_idx"
    ) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

async function resolveScopeRecord(
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
    const row = await (lock ? query.for("update") : query).then(
      (rows) => rows[0] ?? null,
    );
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
    const row = await (lock ? query.for("update") : query).then(
      (rows) => rows[0] ?? null,
    );
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
  const row = await (lock ? query.for("update") : query).then(
    (rows) => rows[0] ?? null,
  );
  if (!row) throw notFound("Project not found");
  return {
    companyId: row.companyId,
    name: row.name,
    paused: Boolean(row.pausedAt),
    pauseReason: (row.pauseReason as PauseReason | null) ?? null,
  };
}

async function companyCurrency(
  database: Db,
  companyId: string,
  lock = false,
): Promise<BudgetCurrency> {
  const query = database
    .select({ budgetCurrency: companies.budgetCurrency })
    .from(companies)
    .where(eq(companies.id, companyId));
  const row = await (lock ? query.for("update") : query).then(
    (rows) => rows[0] ?? null,
  );
  if (!row) throw notFound("Company not found");
  return parseBudgetCurrency(row.budgetCurrency);
}

async function computeObservedAmount(database: Db, policy: PolicyRow) {
  const conditions = [
    eq(costEvents.companyId, policy.companyId),
    eq(costEvents.kind, "known"),
  ];
  if (policy.scopeType === "agent") {
    conditions.push(eq(costEvents.agentId, policy.scopeId));
  }
  if (policy.scopeType === "project") {
    conditions.push(eq(tasks.projectId, policy.scopeId));
  }
  const { start, end } = resolveWindow(
    policy.windowKind as BudgetWindowKind,
  );
  if (policy.windowKind === "calendar_month_utc") {
    conditions.push(gte(costEvents.occurredAt, start));
    conditions.push(lt(costEvents.occurredAt, end));
  }
  const row = await database
    .select({
      total: sql<string>`coalesce(sum(${costEvents.knownDeltaAmount}), 0)::text`,
    })
    .from(costEvents)
    .innerJoin(
      tasks,
      and(
        eq(tasks.id, costEvents.taskId),
        eq(tasks.companyId, costEvents.companyId),
      ),
    )
    .where(and(...conditions))
    .then((rows) => rows[0]);
  return trustedAmount(row?.total ?? "0");
}

function policyToPublic(
  row: PolicyRow,
  budgetCurrency: BudgetCurrency,
): BudgetPolicy {
  return {
    ...row,
    budgetCurrency,
    scopeType: row.scopeType as BudgetScopeType,
    windowKind: row.windowKind as BudgetWindowKind,
    limitAmount: trustedAmount(row.limitAmount),
  };
}

function buildApprovalPayload(input: {
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

export function budgetService(db: Db, hooks: BudgetServiceHooks = {}) {
  async function listPolicyRows(database: Db, companyId: string) {
    return database
      .select()
      .from(budgetPolicies)
      .where(eq(budgetPolicies.companyId, companyId))
      .orderBy(desc(budgetPolicies.updatedAt));
  }

  async function pauseScope(database: Db, policy: PolicyRow) {
    const now = new Date();
    if (policy.scopeType === "agent") {
      await database
        .update(agents)
        .set({
          status: "paused",
          pauseReason: "budget",
          pausedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(agents.id, policy.scopeId),
            inArray(agents.status, ["idle", "error"]),
          ),
        );
      return;
    }
    if (policy.scopeType === "project") {
      await database
        .update(projects)
        .set({ pauseReason: "budget", pausedAt: now, updatedAt: now })
        .where(eq(projects.id, policy.scopeId));
      return;
    }
    await database
      .update(companies)
      .set({
        status: "paused",
        pauseReason: "budget",
        pausedAt: now,
        updatedAt: now,
      })
      .where(eq(companies.id, policy.scopeId));
  }

  async function resumeScope(database: Db, policy: PolicyRow) {
    const now = new Date();
    if (policy.scopeType === "agent") {
      await database
        .update(agents)
        .set({ status: "idle", pauseReason: null, pausedAt: null, updatedAt: now })
        .where(
          and(eq(agents.id, policy.scopeId), eq(agents.pauseReason, "budget")),
        );
      return;
    }
    if (policy.scopeType === "project") {
      await database
        .update(projects)
        .set({ pauseReason: null, pausedAt: null, updatedAt: now })
        .where(
          and(eq(projects.id, policy.scopeId), eq(projects.pauseReason, "budget")),
        );
      return;
    }
    await database
      .update(companies)
      .set({ status: "active", pauseReason: null, pausedAt: null, updatedAt: now })
      .where(
        and(eq(companies.id, policy.scopeId), eq(companies.pauseReason, "budget")),
      );
  }

  async function markApprovalStatus(
    database: Db,
    approvalId: string | null,
    status: "approved" | "rejected",
    decisionNote: string | null | undefined,
    decidedByUserId: string,
  ) {
    if (!approvalId) return;
    await database
      .update(approvals)
      .set({
        status,
        decisionNote: decisionNote ?? null,
        decidedByUserId,
        decidedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(approvals.id, approvalId));
  }

  async function createIncidentIfNeeded(
    database: Db,
    policy: PolicyRow,
    budgetCurrency: BudgetCurrency,
    thresholdType: BudgetThresholdType,
    observedAmount: MoneyAmount,
  ) {
    const { start, end } = resolveWindow(
      policy.windowKind as BudgetWindowKind,
    );
    const existing = await database
      .select()
      .from(budgetIncidents)
      .where(
        and(
          eq(budgetIncidents.policyId, policy.id),
          eq(budgetIncidents.windowStart, start),
          eq(budgetIncidents.thresholdType, thresholdType),
          ne(budgetIncidents.status, "dismissed"),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (existing) return { incident: existing, created: false };

    const scope = await resolveScopeRecord(
      database,
      policy.scopeType as BudgetScopeType,
      policy.scopeId,
    );
    const approval =
      thresholdType === "hard"
        ? await database
            .insert(approvals)
            .values({
              companyId: policy.companyId,
              type: "budget_override_required",
              requestedByUserId: null,
              requestedByAgentId: null,
              status: "pending",
              payload: buildApprovalPayload({
                policy,
                budgetCurrency,
                scopeName: normalizeScopeName(
                  policy.scopeType as BudgetScopeType,
                  scope.name,
                ),
                thresholdType,
                observedAmount,
                windowStart: start,
                windowEnd: end,
              }),
            })
            .returning()
            .then((rows) => rows[0] ?? null)
        : null;

    const incident = await database
      .insert(budgetIncidents)
      .values({
        companyId: policy.companyId,
        policyId: policy.id,
        scopeType: policy.scopeType,
        scopeId: policy.scopeId,
        windowKind: policy.windowKind,
        windowStart: start,
        windowEnd: end,
        thresholdType,
        limitAmount: policy.limitAmount,
        observedAmount,
        status: "open",
        approvalId: approval?.id ?? null,
      })
      .returning()
      .then((rows) => rows[0] ?? null);
    return incident ? { incident, created: true } : null;
  }

  async function resolveOpenSoftIncidents(database: Db, policyId: string) {
    const now = new Date();
    await database
      .update(budgetIncidents)
      .set({ status: "resolved", resolvedAt: now, updatedAt: now })
      .where(
        and(
          eq(budgetIncidents.policyId, policyId),
          eq(budgetIncidents.thresholdType, "soft"),
          eq(budgetIncidents.status, "open"),
        ),
      );
  }

  async function resolveOpenIncidentsForPolicy(
    database: Db,
    policyId: string,
    approvalStatus: "approved" | "rejected" | null,
    decidedByUserId: string | null,
  ) {
    const openRows = await database
      .select()
      .from(budgetIncidents)
      .where(
        and(
          eq(budgetIncidents.policyId, policyId),
          eq(budgetIncidents.status, "open"),
        ),
      );
    const now = new Date();
    await database
      .update(budgetIncidents)
      .set({ status: "resolved", resolvedAt: now, updatedAt: now })
      .where(
        and(
          eq(budgetIncidents.policyId, policyId),
          eq(budgetIncidents.status, "open"),
        ),
      );
    if (!approvalStatus || !decidedByUserId) return;
    for (const row of openRows) {
      await markApprovalStatus(
        database,
        row.approvalId ?? null,
        approvalStatus,
        "Resolved via budget update",
        decidedByUserId,
      );
    }
  }

  async function evaluatePolicy(
    database: Db,
    policy: PolicyRow,
    budgetCurrency: BudgetCurrency,
  ): Promise<BudgetScopeEnforcementAction> {
    const limitAmount = trustedAmount(policy.limitAmount);
    if (!policy.isActive || compareMoneyAmounts(limitAmount, ZERO_AMOUNT) === 0) {
      await resumeScope(database, policy);
      return "resume";
    }
    const observedAmount = await computeObservedAmount(database, policy);
    if (
      policy.notifyEnabled &&
      reachesPercent(observedAmount, limitAmount, policy.warnPercent)
    ) {
      await createIncidentIfNeeded(
        database,
        policy,
        budgetCurrency,
        "soft",
        observedAmount,
      );
    }
    if (
      policy.hardStopEnabled &&
      compareMoneyAmounts(observedAmount, limitAmount) >= 0
    ) {
      await resolveOpenSoftIncidents(database, policy.id);
      await createIncidentIfNeeded(
        database,
        policy,
        budgetCurrency,
        "hard",
        observedAmount,
      );
      await pauseScope(database, policy);
      return "suspend";
    }
    if (compareMoneyAmounts(observedAmount, limitAmount) < 0) {
      await resumeScope(database, policy);
      return "resume";
    }
    return null;
  }

  async function buildPolicySummary(
    database: Db,
    policy: PolicyRow,
    currency?: BudgetCurrency,
  ): Promise<BudgetPolicySummary> {
    const [scope, budgetCurrency, observedAmount] = await Promise.all([
      resolveScopeRecord(
        database,
        policy.scopeType as BudgetScopeType,
        policy.scopeId,
      ),
      currency ?? companyCurrency(database, policy.companyId),
      computeObservedAmount(database, policy),
    ]);
    const { start, end } = resolveWindow(
      policy.windowKind as BudgetWindowKind,
    );
    const limitAmount = trustedAmount(policy.limitAmount);
    return {
      policyId: policy.id,
      companyId: policy.companyId,
      budgetCurrency,
      scopeType: policy.scopeType as BudgetScopeType,
      scopeId: policy.scopeId,
      scopeName: normalizeScopeName(
        policy.scopeType as BudgetScopeType,
        scope.name,
      ),
      windowKind: policy.windowKind as BudgetWindowKind,
      limitAmount,
      observedAmount,
      remainingAmount: remainingAmount(observedAmount, limitAmount),
      utilizationPercent: moneyAmountUtilizationPercent(
        observedAmount,
        limitAmount,
      ),
      warnPercent: policy.warnPercent,
      hardStopEnabled: policy.hardStopEnabled,
      notifyEnabled: policy.notifyEnabled,
      isActive: policy.isActive,
      status: policy.isActive
        ? budgetStatusFromObserved(
            observedAmount,
            limitAmount,
            policy.warnPercent,
          )
        : "ok",
      paused: scope.paused,
      pauseReason: scope.pauseReason,
      windowStart: start,
      windowEnd: end,
    };
  }

  async function hydrateIncidentRows(
    database: Db,
    rows: IncidentRow[],
    currency?: BudgetCurrency,
  ): Promise<BudgetIncident[]> {
    const approvalIds = rows
      .map((row) => row.approvalId)
      .filter((value): value is string => Boolean(value));
    const approvalRows =
      approvalIds.length > 0
        ? await database
            .select({ id: approvals.id, status: approvals.status })
            .from(approvals)
            .where(inArray(approvals.id, approvalIds))
        : [];
    const approvalStatusById = new Map(
      approvalRows.map((row) => [row.id, row.status]),
    );
    return Promise.all(
      rows.map(async (row) => {
        const [scope, budgetCurrency] = await Promise.all([
          resolveScopeRecord(
            database,
            row.scopeType as BudgetScopeType,
            row.scopeId,
          ),
          currency ?? companyCurrency(database, row.companyId),
        ]);
        return {
          id: row.id,
          companyId: row.companyId,
          budgetCurrency,
          policyId: row.policyId,
          scopeType: row.scopeType as BudgetScopeType,
          scopeId: row.scopeId,
          scopeName: normalizeScopeName(
            row.scopeType as BudgetScopeType,
            scope.name,
          ),
          windowKind: row.windowKind as BudgetWindowKind,
          windowStart: row.windowStart,
          windowEnd: row.windowEnd,
          thresholdType: row.thresholdType as BudgetThresholdType,
          limitAmount: trustedAmount(row.limitAmount),
          observedAmount: trustedAmount(row.observedAmount),
          status: row.status as BudgetIncident["status"],
          approvalId: row.approvalId ?? null,
          approvalStatus: row.approvalId
            ? approvalStatusById.get(row.approvalId) ?? null
            : null,
          resolvedAt: row.resolvedAt ?? null,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        };
      }),
    );
  }

  async function upsertPolicyInTransaction(
    transaction: Db,
    companyId: string,
    input: BudgetPolicyUpsertInput,
    actorUserId: string | null,
    owner?: "agent_operational_configuration",
  ) {
    if (
      input.scopeType === "agent" &&
      owner !== "agent_operational_configuration"
    ) {
      throw unprocessable(
        "Agent budgets are owned by agent operational configuration",
        { code: "agent_budget_requires_operational_configuration" },
      );
    }
    const budgetCurrency = await companyCurrency(
      transaction,
      companyId,
      true,
    );
    const scope = await resolveScopeRecord(
      transaction,
      input.scopeType,
      input.scopeId,
      input.scopeType !== "company",
    );
    if (scope.companyId !== companyId) {
      throw unprocessable("Budget scope does not belong to company");
    }
    const limitAmount = parseMoneyAmount(input.limitAmount);
    const windowKind =
      input.windowKind ??
      (input.scopeType === "project" ? "lifetime" : "calendar_month_utc");
    const active =
      compareMoneyAmounts(limitAmount, ZERO_AMOUNT) > 0 &&
      (input.isActive ?? true);
    const existing = await transaction
      .select()
      .from(budgetPolicies)
      .where(
        and(
          eq(budgetPolicies.companyId, companyId),
          eq(budgetPolicies.scopeType, input.scopeType),
          eq(budgetPolicies.scopeId, input.scopeId),
          eq(budgetPolicies.windowKind, windowKind),
        ),
      )
      .for("update")
      .then((rows) => rows[0] ?? null);
    const now = new Date();
    const row = existing
      ? await transaction
          .update(budgetPolicies)
          .set({
            limitAmount,
            warnPercent: input.warnPercent ?? existing.warnPercent,
            hardStopEnabled:
              input.hardStopEnabled ?? existing.hardStopEnabled,
            notifyEnabled: input.notifyEnabled ?? existing.notifyEnabled,
            isActive: active,
            updatedByUserId: actorUserId,
            updatedAt: now,
          })
          .where(eq(budgetPolicies.id, existing.id))
          .returning()
          .then((rows) => rows[0]!)
      : await transaction
          .insert(budgetPolicies)
          .values({
            companyId,
            scopeType: input.scopeType,
            scopeId: input.scopeId,
            windowKind,
            limitAmount,
            warnPercent: input.warnPercent ?? 80,
            hardStopEnabled: input.hardStopEnabled ?? true,
            notifyEnabled: input.notifyEnabled ?? true,
            isActive: active,
            createdByUserId: actorUserId,
            updatedByUserId: actorUserId,
          })
          .returning()
          .then((rows) => rows[0]!);

    if (windowKind === "calendar_month_utc") {
      if (input.scopeType === "company") {
        await transaction
          .update(companies)
          .set({ budgetMonthlyAmount: limitAmount, updatedAt: now })
          .where(eq(companies.id, input.scopeId));
      } else if (input.scopeType === "agent") {
        await transaction
          .update(agents)
          .set({ budgetMonthlyAmount: limitAmount, updatedAt: now })
          .where(eq(agents.id, input.scopeId));
      }
    }

    const enforcementAction = await evaluatePolicy(
      transaction,
      row,
      budgetCurrency,
    );
    if (!active) {
      await resolveOpenIncidentsForPolicy(
        transaction,
        row.id,
        actorUserId ? "approved" : null,
        actorUserId,
      );
    }
    return { row, budgetCurrency, enforcementAction };
  }

  async function knownSpendBy(
    input: {
      companyIds?: readonly string[];
      companyId?: string;
      agentIds?: readonly string[];
      projectIds?: readonly string[];
    },
    range = currentUtcMonthWindow(),
  ) {
    const conditions = [
      eq(costEvents.kind, "known"),
      gte(costEvents.occurredAt, range.start),
      lt(costEvents.occurredAt, range.end),
    ];
    if (input.companyIds) {
      if (input.companyIds.length === 0) return [];
      conditions.push(inArray(costEvents.companyId, [...input.companyIds]));
    }
    if (input.companyId) conditions.push(eq(costEvents.companyId, input.companyId));
    if (input.agentIds) {
      if (input.agentIds.length === 0) return [];
      conditions.push(inArray(costEvents.agentId, [...input.agentIds]));
    }
    if (input.projectIds) {
      if (input.projectIds.length === 0) return [];
      conditions.push(inArray(tasks.projectId, [...input.projectIds]));
    }
    return db
      .select({
        companyId: costEvents.companyId,
        agentId: costEvents.agentId,
        projectId: tasks.projectId,
        knownSpendAmount: sql<string>`coalesce(sum(${costEvents.knownDeltaAmount}), 0)::text`,
      })
      .from(costEvents)
      .innerJoin(
        tasks,
        and(
          eq(tasks.id, costEvents.taskId),
          eq(tasks.companyId, costEvents.companyId),
        ),
      )
      .where(and(...conditions))
      .groupBy(costEvents.companyId, costEvents.agentId, tasks.projectId);
  }

  async function evaluateCostEventInTransaction(
    event: typeof costEvents.$inferSelect,
  ): Promise<BudgetEnforcementScope[]> {
    if (event.kind !== "known" || event.knownDeltaAmount === null) return [];
    const budgetCurrency = await companyCurrency(
      db,
      event.companyId,
      true,
    );
    if (event.budgetCurrency !== budgetCurrency) {
      throw unprocessable(
        "Cost event currency does not match company budget currency",
      );
    }
    const policies = await db
      .select()
      .from(budgetPolicies)
      .where(
        and(
          eq(budgetPolicies.companyId, event.companyId),
          eq(budgetPolicies.isActive, true),
          inArray(budgetPolicies.scopeType, ["company", "agent", "project"]),
        ),
      )
      .for("update");
    const eventProjectId = await db
      .select({ projectId: tasks.projectId })
      .from(tasks)
      .where(
        and(
          eq(tasks.id, event.taskId),
          eq(tasks.companyId, event.companyId),
        ),
      )
      .then((rows) => rows[0]?.projectId ?? null);
    const relevant = policies.filter((policy) => {
      if (policy.scopeType === "company") {
        return policy.scopeId === event.companyId;
      }
      if (policy.scopeType === "agent") {
        return policy.scopeId === event.agentId;
      }
      return eventProjectId !== null && policy.scopeId === eventProjectId;
    });
    const blocked: BudgetEnforcementScope[] = [];
    for (const policy of relevant) {
      if ((await evaluatePolicy(db, policy, budgetCurrency)) === "suspend") {
        blocked.push({
          companyId: policy.companyId,
          scopeType: policy.scopeType as BudgetScopeType,
          scopeId: policy.scopeId,
        });
      }
    }
    return blocked;
  }

  return {
    /** The only company-creation path that writes budget denomination/limit. */
    createCompany: async (
      data: CanonicalCompanyCreation,
      actorUserId: string | null,
    ) => {
      const budgetCurrency = parseBudgetCurrency(data.budgetCurrency ?? "USD");
      const budgetMonthlyAmount = parseMoneyAmount(
        data.budgetMonthlyAmount ?? "0",
      );
      const base = prefixBase(data.name);
      for (let attempt = 1; attempt < 10_000; attempt += 1) {
        try {
          return await db.transaction(async (tx) => {
            const transaction = tx as unknown as Db;
            const now = new Date();
            const created = await transaction
              .insert(companies)
              .values({
                ...data,
                budgetCurrency,
                budgetMonthlyAmount,
                taskPrefix: prefixForAttempt(base, attempt),
                sessionIntegrityState: "ready",
                sessionIntegrityReadyAt: now,
              })
              .returning()
              .then((rows) => rows[0] ?? null);
            if (!created) throw new Error("Company insert returned no row");
            await upsertPolicyInTransaction(
              transaction,
              created.id,
              {
                scopeType: "company",
                scopeId: created.id,
                windowKind: "calendar_month_utc",
                limitAmount: budgetMonthlyAmount,
              },
              actorUserId,
            );
            return created;
          });
        } catch (error) {
          if (!isTaskPrefixConflict(error)) throw error;
        }
      }
      throw new Error("Unable to allocate unique task prefix");
    },

    /**
     * Transaction-scoped agent creation. Callers supply a transaction-backed
     * service so the row and its monthly policy commit together.
     */
    createAgentInTransaction: async (
      data: CanonicalAgentCreation,
      actorUserId: string | null,
    ) => {
      const limitAmount = parseMoneyAmount(data.budgetMonthlyAmount ?? "0");
      await companyCurrency(db, data.companyId, true);
      const created = await db
        .insert(agents)
        .values({ ...data, budgetMonthlyAmount: limitAmount })
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!created) throw new Error("Agent insert returned no row");
      await upsertPolicyInTransaction(
        db,
        created.companyId,
        {
          scopeType: "agent",
          scopeId: created.id,
          windowKind: "calendar_month_utc",
          limitAmount,
        },
        actorUserId,
        "agent_operational_configuration",
      );
      return created;
    },

    listPolicies: async (companyId: string): Promise<BudgetPolicy[]> => {
      const [rows, budgetCurrency] = await Promise.all([
        listPolicyRows(db, companyId),
        companyCurrency(db, companyId),
      ]);
      return rows.map((row) => policyToPublic(row, budgetCurrency));
    },

    upsertPolicy: async (
      companyId: string,
      input: BudgetPolicyUpsertInput,
      actorUserId: string | null,
      owner?: "agent_operational_configuration",
    ): Promise<BudgetPolicySummary> => {
      const result = await db.transaction(async (tx) =>
        upsertPolicyInTransaction(
          tx as unknown as Db,
          companyId,
          input,
          actorUserId,
          owner,
        ),
      );
      const enforcementScope = {
        companyId,
        scopeType: input.scopeType,
        scopeId: input.scopeId,
      } satisfies BudgetEnforcementScope;
      if (result.enforcementAction === "suspend") {
        await hooks.suspendWorkForScope?.(enforcementScope);
      } else if (result.enforcementAction === "resume") {
        await hooks.resumeWorkForScope?.(enforcementScope);
      }
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: actorUserId ?? "board",
        action: "budget.policy_upserted",
        entityType: "budget_policy",
        entityId: result.row.id,
        details: {
          scopeType: result.row.scopeType,
          scopeId: result.row.scopeId,
          budgetCurrency: result.budgetCurrency,
          limitAmount: result.row.limitAmount,
          windowKind: result.row.windowKind,
        },
      });
      return buildPolicySummary(db, result.row, result.budgetCurrency);
    },

    setCompanyMonthlyLimit: async (
      companyId: string,
      limitAmount: MoneyAmount,
      actorUserId: string | null,
    ) =>
      budgetService(db, hooks).upsertPolicy(
        companyId,
        {
          scopeType: "company",
          scopeId: companyId,
          windowKind: "calendar_month_utc",
          limitAmount: parseMoneyAmount(limitAmount),
        },
        actorUserId,
      ),

    setAgentMonthlyLimit: async (
      companyId: string,
      agentId: string,
      limitAmount: MoneyAmount,
      actorUserId: string | null,
    ) =>
      budgetService(db, hooks).upsertPolicy(
        companyId,
        {
          scopeType: "agent",
          scopeId: agentId,
          windowKind: "calendar_month_utc",
          limitAmount: parseMoneyAmount(limitAmount),
        },
        actorUserId,
        "agent_operational_configuration",
      ),

    overview: async (companyId: string): Promise<BudgetOverview> => {
      const [rows, activeIncidentRows, budgetCurrency] = await Promise.all([
        listPolicyRows(db, companyId),
        db
          .select()
          .from(budgetIncidents)
          .where(
            and(
              eq(budgetIncidents.companyId, companyId),
              eq(budgetIncidents.status, "open"),
            ),
          )
          .orderBy(desc(budgetIncidents.createdAt)),
        companyCurrency(db, companyId),
      ]);
      const policies = await Promise.all(
        rows.map((row) => buildPolicySummary(db, row, budgetCurrency)),
      );
      const activeIncidents = await hydrateIncidentRows(
        db,
        activeIncidentRows,
        budgetCurrency,
      );
      return {
        companyId,
        budgetCurrency,
        policies,
        activeIncidents,
        pausedAgentCount: policies.filter(
          (policy) => policy.scopeType === "agent" && policy.paused,
        ).length,
        pausedProjectCount: policies.filter(
          (policy) => policy.scopeType === "project" && policy.paused,
        ).length,
        pendingApprovalCount: activeIncidents.filter(
          (incident) => incident.approvalStatus === "pending",
        ).length,
      };
    },

    /**
     * Canonical cost-ledger evaluation. The caller must pass a transaction-
     * backed service so incident and pause projections commit with the event.
     */
    evaluateCostEventInTransaction,

    /** Post-commit side effects for the scopes returned above. */
    enforceSuspensionScopes: async (
      scopes: readonly BudgetEnforcementScope[],
    ) => {
      for (const scope of scopes) {
        await hooks.suspendWorkForScope?.(scope);
      }
    },

    getInvocationBlock: async (
      companyId: string,
      agentId: string,
      context?: { taskId?: string | null; projectId?: string | null },
    ) => {
      const [agent, company, policies] = await Promise.all([
        db
          .select({
            status: agents.status,
            pauseReason: agents.pauseReason,
            companyId: agents.companyId,
            name: agents.name,
          })
          .from(agents)
          .where(eq(agents.id, agentId))
          .then((rows) => rows[0] ?? null),
        db
          .select({
            status: companies.status,
            pauseReason: companies.pauseReason,
            name: companies.name,
          })
          .from(companies)
          .where(eq(companies.id, companyId))
          .then((rows) => rows[0] ?? null),
        listPolicyRows(db, companyId),
      ]);
      if (!agent || agent.companyId !== companyId) throw notFound("Agent not found");
      if (!company) throw notFound("Company not found");
      if (company.status === "paused") {
        return {
          scopeType: "company" as const,
          scopeId: companyId,
          scopeName: company.name,
          reason:
            company.pauseReason === "budget"
              ? "Company is paused because its budget hard-stop was reached."
              : "Company is paused and cannot start new work.",
        };
      }
      const targets: Array<{
        scopeType: BudgetScopeType;
        scopeId: string;
        scopeName: string;
      }> = [
        { scopeType: "company", scopeId: companyId, scopeName: company.name },
        { scopeType: "agent", scopeId: agentId, scopeName: agent.name },
      ];
      if (context?.projectId) {
        const project = await db
          .select({
            id: projects.id,
            companyId: projects.companyId,
            name: projects.name,
            pauseReason: projects.pauseReason,
            pausedAt: projects.pausedAt,
          })
          .from(projects)
          .where(eq(projects.id, context.projectId))
          .then((rows) => rows[0] ?? null);
        if (project?.companyId === companyId) {
          if (project.pausedAt && project.pauseReason === "budget") {
            return {
              scopeType: "project" as const,
              scopeId: project.id,
              scopeName: project.name,
              reason: "Project is paused because its budget hard-stop was reached.",
            };
          }
          targets.push({
            scopeType: "project",
            scopeId: project.id,
            scopeName: project.name,
          });
        }
      }
      if (agent.status === "paused" && agent.pauseReason === "budget") {
        return {
          scopeType: "agent" as const,
          scopeId: agentId,
          scopeName: agent.name,
          reason: "Agent is paused because its budget hard-stop was reached.",
        };
      }
      for (const target of targets) {
        const policy = policies.find(
          (candidate) =>
            candidate.scopeType === target.scopeType &&
            candidate.scopeId === target.scopeId &&
            candidate.isActive &&
            candidate.hardStopEnabled,
        );
        if (!policy) continue;
        const observed = await computeObservedAmount(db, policy);
        if (
          compareMoneyAmounts(observed, trustedAmount(policy.limitAmount)) >= 0
        ) {
          return {
            ...target,
            reason: `${target.scopeName} cannot start work because its budget hard-stop is exceeded.`,
          };
        }
      }
      return null;
    },

    resolveIncident: async (
      companyId: string,
      incidentId: string,
      input: BudgetIncidentResolutionInput,
      actorUserId: string,
      owner?: "agent_operational_configuration",
    ): Promise<BudgetIncident> => {
      assertCanonicalBudgetIncidentId(incidentId);
      const result = await db.transaction(async (tx) => {
        const transaction = tx as unknown as Db;
        const budgetCurrency = await companyCurrency(transaction, companyId, true);
        const incident = await transaction
          .select()
          .from(budgetIncidents)
          .where(
            and(
              eq(budgetIncidents.id, incidentId),
              eq(budgetIncidents.companyId, companyId),
            ),
          )
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!incident) throw notFound("Budget incident not found");
        const policy = await transaction
          .select()
          .from(budgetPolicies)
          .where(eq(budgetPolicies.id, incident.policyId))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!policy) throw notFound("Budget policy not found");
        if (
          policy.scopeType === "agent" &&
          owner !== "agent_operational_configuration"
        ) {
          throw unprocessable(
            "Agent budget incidents are owned by agent operational configuration",
            { code: "agent_budget_requires_operational_configuration" },
          );
        }
        await resolveScopeRecord(
          transaction,
          policy.scopeType as BudgetScopeType,
          policy.scopeId,
          policy.scopeType !== "company",
        );
        const now = new Date();
        if (input.action === "raise_budget_and_resume") {
          const nextLimit = parseMoneyAmount(input.limitAmount);
          const observed = await computeObservedAmount(transaction, policy);
          if (compareMoneyAmounts(nextLimit, observed) <= 0) {
            throw unprocessable("New budget must exceed current observed spend");
          }
          await transaction
            .update(budgetPolicies)
            .set({
              limitAmount: nextLimit,
              isActive: true,
              updatedByUserId: actorUserId,
              updatedAt: now,
            })
            .where(eq(budgetPolicies.id, policy.id));
          if (policy.windowKind === "calendar_month_utc") {
            if (policy.scopeType === "company") {
              await transaction
                .update(companies)
                .set({ budgetMonthlyAmount: nextLimit, updatedAt: now })
                .where(eq(companies.id, policy.scopeId));
            } else if (policy.scopeType === "agent") {
              await transaction
                .update(agents)
                .set({ budgetMonthlyAmount: nextLimit, updatedAt: now })
                .where(eq(agents.id, policy.scopeId));
            }
          }
          await resumeScope(transaction, policy);
          await transaction
            .update(budgetIncidents)
            .set({ status: "resolved", resolvedAt: now, updatedAt: now })
            .where(
              and(
                eq(budgetIncidents.policyId, policy.id),
                eq(budgetIncidents.status, "open"),
              ),
            );
          await markApprovalStatus(
            transaction,
            incident.approvalId ?? null,
            "approved",
            input.decisionNote,
            actorUserId,
          );
        } else {
          await transaction
            .update(budgetIncidents)
            .set({ status: "dismissed", resolvedAt: now, updatedAt: now })
            .where(eq(budgetIncidents.id, incident.id));
          await markApprovalStatus(
            transaction,
            incident.approvalId ?? null,
            "rejected",
            input.decisionNote,
            actorUserId,
          );
        }
        const updated = await transaction
          .select()
          .from(budgetIncidents)
          .where(eq(budgetIncidents.id, incident.id))
          .then((rows) => rows[0]!);
        return {
          updated,
          budgetCurrency,
          resumedScope:
            input.action === "raise_budget_and_resume"
              ? ({
                  companyId,
                  scopeType: policy.scopeType as BudgetScopeType,
                  scopeId: policy.scopeId,
                } satisfies BudgetEnforcementScope)
              : null,
        };
      });
      if (result.resumedScope) {
        await hooks.resumeWorkForScope?.(result.resumedScope);
      }
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: actorUserId,
        action: "budget.incident_resolved",
        entityType: "budget_incident",
        entityId: incidentId,
        details: {
          action: input.action,
          limitAmount: input.limitAmount ?? null,
        },
      });
      return (
        await hydrateIncidentRows(
          db,
          [result.updated],
          result.budgetCurrency,
        )
      )[0]!;
    },

    getIncidentScope: async (companyId: string, incidentId: string) => {
      assertCanonicalBudgetIncidentId(incidentId);
      const incident = await db
        .select({
          companyId: budgetIncidents.companyId,
          scopeType: budgetIncidents.scopeType,
          scopeId: budgetIncidents.scopeId,
        })
        .from(budgetIncidents)
        .where(eq(budgetIncidents.id, incidentId))
        .then((rows) => rows[0] ?? null);
      if (!incident || incident.companyId !== companyId) {
        throw notFound("Budget incident not found");
      }
      return {
        scopeType: incident.scopeType as BudgetScopeType,
        scopeId: incident.scopeId,
      };
    },

    getCompanyMonthlyKnownSpend: async (companyIds: readonly string[]) => {
      const rows = await knownSpendBy({ companyIds });
      const totals = new Map<string, MoneyAmount>();
      for (const companyId of companyIds) totals.set(companyId, ZERO_AMOUNT);
      for (const row of rows) {
        const current = totals.get(row.companyId) ?? ZERO_AMOUNT;
        const amount = trustedAmount(row.knownSpendAmount);
        totals.set(row.companyId, addMoneyAmounts(current, amount));
      }
      return totals;
    },

    getAgentMonthlyKnownSpend: async (
      companyId: string,
      agentIds: readonly string[],
    ) => {
      const rows = await knownSpendBy({ companyId, agentIds });
      const totals = new Map<string, MoneyAmount>();
      for (const agentId of agentIds) totals.set(agentId, ZERO_AMOUNT);
      for (const row of rows) {
        const current = totals.get(row.agentId) ?? ZERO_AMOUNT;
        const amount = trustedAmount(row.knownSpendAmount);
        totals.set(row.agentId, addMoneyAmounts(current, amount));
      }
      return totals;
    },
  };
}
