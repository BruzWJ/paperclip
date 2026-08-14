import { and, eq, inArray } from "drizzle-orm";
import { type Db, agents, approvals, budgetPolicies, companies } from "@paperclipai/db";
import {
  compareMoneyAmounts,
  moneyAmountUtilizationPercent,
  parseMoneyAmount,
  type BudgetCurrency,
  type BudgetIncident,
  type BudgetPolicySummary,
  type BudgetPolicyUpsertInput,
  type BudgetScopeType,
  type BudgetThresholdType,
  type BudgetWindowKind,
} from "@paperclipai/shared";
import { unprocessable } from "../errors.js";
import * as budgetPolicy from "./budget-policy-foundation.js";
import { buildBudgetsBudgetEnforcement } from "./budget-enforcement.js";

export function buildBudgetsBudgetPolicySummaries(
  scope: budgetPolicy.BudgetsContext & ReturnType<typeof buildBudgetsBudgetEnforcement>,
) {
  const { resolveOpenIncidentsForPolicy, evaluatePolicy } = scope;

  async function buildPolicySummary(
    database: Db,
    policy: budgetPolicy.PolicyRow,
    currency?: BudgetCurrency,
  ): Promise<BudgetPolicySummary> {
    const [scope, budgetCurrency, observedAmount] = await Promise.all([
      budgetPolicy.resolveScopeRecord(database, policy.scopeType as BudgetScopeType, policy.scopeId),
      currency ?? budgetPolicy.companyCurrency(database, policy.companyId),
      budgetPolicy.computeObservedAmount(database, policy),
    ]);
    const { start, end } = budgetPolicy.resolveWindow(policy.windowKind as BudgetWindowKind);
    const limitAmount = budgetPolicy.trustedAmount(policy.limitAmount);
    return {
      policyId: policy.id,
      companyId: policy.companyId,
      budgetCurrency,
      scopeType: policy.scopeType as BudgetScopeType,
      scopeId: policy.scopeId,
      scopeName: budgetPolicy.normalizeScopeName(policy.scopeType as BudgetScopeType, scope.name),
      windowKind: policy.windowKind as BudgetWindowKind,
      limitAmount,
      observedAmount,
      remainingAmount: budgetPolicy.remainingAmount(observedAmount, limitAmount),
      utilizationPercent: moneyAmountUtilizationPercent(observedAmount, limitAmount),
      warnPercent: policy.warnPercent,
      hardStopEnabled: policy.hardStopEnabled,
      notifyEnabled: policy.notifyEnabled,
      isActive: policy.isActive,
      status: policy.isActive
        ? budgetPolicy.budgetStatusFromObserved(observedAmount, limitAmount, policy.warnPercent)
        : "ok",
      paused: scope.paused,
      pauseReason: scope.pauseReason,
      windowStart: start,
      windowEnd: end,
    };
  }

  async function hydrateIncidentRows(
    database: Db,
    rows: budgetPolicy.IncidentRow[],
    currency?: BudgetCurrency,
  ): Promise<BudgetIncident[]> {
    const approvalIds = rows.map((row) => row.approvalId).filter((value): value is string => Boolean(value));
    const approvalRows =
      approvalIds.length > 0
        ? await database
            .select({ id: approvals.id, status: approvals.status })
            .from(approvals)
            .where(inArray(approvals.id, approvalIds))
        : [];
    const approvalStatusById = new Map(approvalRows.map((row) => [row.id, row.status]));
    return Promise.all(
      rows.map(async (row) => {
        const [scope, budgetCurrency] = await Promise.all([
          budgetPolicy.resolveScopeRecord(database, row.scopeType as BudgetScopeType, row.scopeId),
          currency ?? budgetPolicy.companyCurrency(database, row.companyId),
        ]);
        return {
          id: row.id,
          companyId: row.companyId,
          budgetCurrency,
          policyId: row.policyId,
          scopeType: row.scopeType as BudgetScopeType,
          scopeId: row.scopeId,
          scopeName: budgetPolicy.normalizeScopeName(row.scopeType as BudgetScopeType, scope.name),
          windowKind: row.windowKind as BudgetWindowKind,
          windowStart: row.windowStart,
          windowEnd: row.windowEnd,
          thresholdType: row.thresholdType as BudgetThresholdType,
          limitAmount: budgetPolicy.trustedAmount(row.limitAmount),
          observedAmount: budgetPolicy.trustedAmount(row.observedAmount),
          status: row.status as BudgetIncident["status"],
          approvalId: row.approvalId ?? null,
          approvalStatus: row.approvalId ? (approvalStatusById.get(row.approvalId) ?? null) : null,
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
    if (input.scopeType === "agent" && owner !== "agent_operational_configuration") {
      throw unprocessable("Agent budgets are owned by agent operational configuration", {
        code: "agent_budget_requires_operational_configuration",
      });
    }
    const budgetCurrency = await budgetPolicy.companyCurrency(transaction, companyId, true);
    const scope = await budgetPolicy.resolveScopeRecord(
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
      input.windowKind ?? (input.scopeType === "project" ? "lifetime" : "calendar_month_utc");
    const active = compareMoneyAmounts(limitAmount, budgetPolicy.ZERO_AMOUNT) > 0 && (input.isActive ?? true);
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
            hardStopEnabled: input.hardStopEnabled ?? existing.hardStopEnabled,
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

    const enforcementAction = await evaluatePolicy(transaction, row, budgetCurrency);
    if (!active) {
      await resolveOpenIncidentsForPolicy(transaction, row.id, actorUserId ? "approved" : null, actorUserId);
    }
    return { row, budgetCurrency, enforcementAction };
  }

  return { buildPolicySummary, hydrateIncidentRows, upsertPolicyInTransaction };
}
