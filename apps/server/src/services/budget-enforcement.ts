import { and, desc, eq, inArray, ne } from "drizzle-orm";
import {
  agents,
  approvals,
  budgetIncidents,
  budgetPolicies,
  companies,
  projects,
  type Db,
} from "@paperclipai/db";
import {
  compareMoneyAmounts,
  type BudgetCurrency,
  type BudgetScopeType,
  type BudgetThresholdType,
  type BudgetWindowKind,
  type MoneyAmount,
} from "@paperclipai/shared";
import {
  ZERO_AMOUNT,
  buildApprovalPayload,
  computeObservedAmount,
  normalizeScopeName,
  reachesPercent,
  resolveScopeRecord,
  resolveWindow,
  trustedAmount,
  type BudgetsContext,
  type BudgetScopeEnforcementAction,
  type PolicyRow,
} from "./budget-policy-foundation.js";

export function buildBudgetsBudgetEnforcement(scope: BudgetsContext) {
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
        .where(and(eq(agents.id, policy.scopeId), inArray(agents.status, ["idle", "error"])));
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
        .set({
          status: "idle",
          pauseReason: null,
          pausedAt: null,
          updatedAt: now,
        })
        .where(and(eq(agents.id, policy.scopeId), eq(agents.pauseReason, "budget")));
      return;
    }
    if (policy.scopeType === "project") {
      await database
        .update(projects)
        .set({ pauseReason: null, pausedAt: null, updatedAt: now })
        .where(and(eq(projects.id, policy.scopeId), eq(projects.pauseReason, "budget")));
      return;
    }
    await database
      .update(companies)
      .set({
        status: "active",
        pauseReason: null,
        pausedAt: null,
        updatedAt: now,
      })
      .where(and(eq(companies.id, policy.scopeId), eq(companies.pauseReason, "budget")));
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
    const { start, end } = resolveWindow(policy.windowKind as BudgetWindowKind);
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

    const scope = await resolveScopeRecord(database, policy.scopeType as BudgetScopeType, policy.scopeId);
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
                scopeName: normalizeScopeName(policy.scopeType as BudgetScopeType, scope.name),
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
      .where(and(eq(budgetIncidents.policyId, policyId), eq(budgetIncidents.status, "open")));
    const now = new Date();
    await database
      .update(budgetIncidents)
      .set({ status: "resolved", resolvedAt: now, updatedAt: now })
      .where(and(eq(budgetIncidents.policyId, policyId), eq(budgetIncidents.status, "open")));
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
    if (policy.notifyEnabled && reachesPercent(observedAmount, limitAmount, policy.warnPercent)) {
      await createIncidentIfNeeded(database, policy, budgetCurrency, "soft", observedAmount);
    }
    if (policy.hardStopEnabled && compareMoneyAmounts(observedAmount, limitAmount) >= 0) {
      await resolveOpenSoftIncidents(database, policy.id);
      await createIncidentIfNeeded(database, policy, budgetCurrency, "hard", observedAmount);
      await pauseScope(database, policy);
      return "suspend";
    }
    if (compareMoneyAmounts(observedAmount, limitAmount) < 0) {
      await resumeScope(database, policy);
      return "resume";
    }
    return null;
  }

  return {
    listPolicyRows,
    pauseScope,
    resumeScope,
    markApprovalStatus,
    createIncidentIfNeeded,
    resolveOpenSoftIncidents,
    resolveOpenIncidentsForPolicy,
    evaluatePolicy,
  };
}
