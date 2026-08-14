import { type Db, agents, budgetIncidents, companies } from "@paperclipai/db";
import {
  type BudgetServiceHooks,
  createBudgetsContext,
  trustedAmount,
  ZERO_AMOUNT,
  type BudgetsContext,
  companyCurrency,
  isTaskPrefixConflict,
  policyToPublic,
  prefixBase,
  prefixForAttempt,
  type BudgetEnforcementScope,
  type CanonicalAgentCreation,
  type CanonicalCompanyCreation,
} from "./budget-policy-foundation.js";

import { buildBudgetsBudgetEnforcement } from "./budget-enforcement.js";
import { buildBudgetsBudgetPolicySummaries } from "./budget-policy-summaries.js";
import { buildBudgetsBudgetPolicyCommits } from "./budget-policy-commits.js";
import { createBudgetsMethods2 } from "./budgets-methods-2.js";

import {
  addMoneyAmounts,
  type MoneyAmount,
  parseBudgetCurrency,
  parseMoneyAmount,
  type BudgetOverview,
  type BudgetPolicy,
  type BudgetPolicySummary,
  type BudgetPolicyUpsertInput,
} from "@paperclipai/shared";

import { and, desc, eq } from "drizzle-orm";

export function createBudgetsMethods1(
  scope: BudgetsContext &
    ReturnType<typeof buildBudgetsBudgetEnforcement> &
    ReturnType<typeof buildBudgetsBudgetPolicySummaries> &
    ReturnType<typeof buildBudgetsBudgetPolicyCommits>,
) {
  const {
    db,
    hooks,
    listPolicyRows,
    buildPolicySummary,
    hydrateIncidentRows,
    upsertPolicyInTransaction,
    upsertPolicyAndActivityInTransaction,
    applyCommittedPolicyUpsert,
    evaluateCostEventInTransaction,
  } = scope;

  const upsertPolicy = async (
    companyId: string,
    input: BudgetPolicyUpsertInput,
    actorUserId: string | null,
    owner?: "agent_operational_configuration",
  ): Promise<BudgetPolicySummary> => {
    const result = await db.transaction(async (tx) =>
      upsertPolicyAndActivityInTransaction(tx as unknown as Db, companyId, input, actorUserId, owner),
    );
    await applyCommittedPolicyUpsert(result);
    return buildPolicySummary(db, result.row, result.budgetCurrency);
  };

  return {
    /** The only company-creation path that writes budget denomination/limit. */
    createCompany: async (data: CanonicalCompanyCreation, actorUserId: string | null) => {
      const budgetCurrency = parseBudgetCurrency(data.budgetCurrency ?? "USD");
      const budgetMonthlyAmount = parseMoneyAmount(data.budgetMonthlyAmount ?? "0");
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
    createAgentInTransaction: async (data: CanonicalAgentCreation, actorUserId: string | null) => {
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

    upsertPolicy,

    /**
     * Persist an agent monthly-limit mutation and its audit row inside a
     * caller-owned transaction. The caller must pass the returned effects to
     * `applyCommittedPolicyUpsert` only after that transaction commits.
     */
    setAgentMonthlyLimitInTransaction: async (
      companyId: string,
      agentId: string,
      limitAmount: MoneyAmount,
      actorUserId: string | null,
    ) =>
      upsertPolicyAndActivityInTransaction(
        db,
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

    applyCommittedPolicyUpsert,

    setCompanyMonthlyLimit: async (companyId: string, limitAmount: MoneyAmount, actorUserId: string | null) =>
      upsertPolicy(
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
      upsertPolicy(
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
          .where(and(eq(budgetIncidents.companyId, companyId), eq(budgetIncidents.status, "open")))
          .orderBy(desc(budgetIncidents.createdAt)),
        companyCurrency(db, companyId),
      ]);
      const policies = await Promise.all(rows.map((row) => buildPolicySummary(db, row, budgetCurrency)));
      const activeIncidents = await hydrateIncidentRows(db, activeIncidentRows, budgetCurrency);
      return {
        companyId,
        budgetCurrency,
        policies,
        activeIncidents,
        pausedAgentCount: policies.filter((policy) => policy.scopeType === "agent" && policy.paused).length,
        pausedProjectCount: policies.filter((policy) => policy.scopeType === "project" && policy.paused)
          .length,
        pendingApprovalCount: activeIncidents.filter((incident) => incident.approvalStatus === "pending")
          .length,
      };
    },

    /**
     * Canonical cost-ledger evaluation. The caller must pass a transaction-
     * backed service so incident and pause projections commit with the event.
     */
    evaluateCostEventInTransaction,

    /** Post-commit side effects for the scopes returned above. */
    enforceSuspensionScopes: async (scopes: readonly BudgetEnforcementScope[]) => {
      for (const scope of scopes) {
        await hooks.suspendWorkForScope?.(scope);
      }
    },
  };
}

export function createBudgetsMethods3(
  scope: BudgetsContext &
    ReturnType<typeof buildBudgetsBudgetEnforcement> &
    ReturnType<typeof buildBudgetsBudgetPolicySummaries> &
    ReturnType<typeof buildBudgetsBudgetPolicyCommits>,
) {
  const { knownSpendBy } = scope;

  return {
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

    getAgentMonthlyKnownSpend: async (companyId: string, agentIds: readonly string[]) => {
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

export type {
  BudgetEnforcementScope,
  BudgetServiceHooks,
  CanonicalCompanyCreation,
  CanonicalAgentCreation,
} from "./budget-policy-foundation.js";

export function budgetService(db: Db, hooks: BudgetServiceHooks = {}) {
  const context = createBudgetsContext(db, hooks);
  const helpers1 = buildBudgetsBudgetEnforcement(context);
  const scope1 = { ...context, ...helpers1 };
  const helpers2 = buildBudgetsBudgetPolicySummaries(scope1);
  const scope2 = { ...scope1, ...helpers2 };
  const helpers3 = buildBudgetsBudgetPolicyCommits(scope2);
  const scope3 = { ...scope2, ...helpers3 };
  const scope = scope3;
  const methods1 = createBudgetsMethods1(scope);
  const methods2 = createBudgetsMethods2(scope);
  const methods3 = createBudgetsMethods3(scope);
  return { ...methods1, ...methods2, ...methods3 };
}
