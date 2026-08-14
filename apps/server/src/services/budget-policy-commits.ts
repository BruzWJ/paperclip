import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { type Db, budgetPolicies, costEvents, tasks } from "@paperclipai/db";
import { type BudgetPolicyUpsertInput, type BudgetScopeType } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";
import { persistActivityLog, publishCommittedActivity } from "./activity-log.js";
import {
  type BudgetEnforcementScope,
  type CommittedBudgetPolicyUpsert,
  companyCurrency,
  currentUtcMonthWindow,
  type BudgetsContext,
} from "./budget-policy-foundation.js";
import { buildBudgetsBudgetEnforcement } from "./budget-enforcement.js";
import { buildBudgetsBudgetPolicySummaries } from "./budget-policy-summaries.js";

export function buildBudgetsBudgetPolicyCommits(
  scope: BudgetsContext &
    ReturnType<typeof buildBudgetsBudgetEnforcement> &
    ReturnType<typeof buildBudgetsBudgetPolicySummaries>,
) {
  const { db, hooks, evaluatePolicy, upsertPolicyInTransaction } = scope;

  async function upsertPolicyAndActivityInTransaction(
    transaction: Db,
    companyId: string,
    input: BudgetPolicyUpsertInput,
    actorUserId: string | null,
    owner?: "agent_operational_configuration",
  ): Promise<CommittedBudgetPolicyUpsert> {
    const result = await upsertPolicyInTransaction(transaction, companyId, input, actorUserId, owner);
    const activity = await persistActivityLog(transaction, {
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
    return {
      ...result,
      enforcementScope: {
        companyId,
        scopeType: input.scopeType,
        scopeId: input.scopeId,
      },
      activity,
    };
  }

  async function applyCommittedPolicyUpsert(committed: CommittedBudgetPolicyUpsert): Promise<void> {
    if (!("$client" in db)) {
      throw new Error("Committed budget policy effects require a root database after commit");
    }
    if (committed.enforcementAction === "suspend") {
      await hooks.suspendWorkForScope?.(committed.enforcementScope);
    } else if (committed.enforcementAction === "resume") {
      await hooks.resumeWorkForScope?.(committed.enforcementScope);
    }
    publishCommittedActivity(committed.activity);
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
      .innerJoin(tasks, and(eq(tasks.id, costEvents.taskId), eq(tasks.companyId, costEvents.companyId)))
      .where(and(...conditions))
      .groupBy(costEvents.companyId, costEvents.agentId, tasks.projectId);
  }

  async function evaluateCostEventInTransaction(
    event: typeof costEvents.$inferSelect,
  ): Promise<BudgetEnforcementScope[]> {
    if (event.kind !== "known" || event.knownDeltaAmount === null) return [];
    const budgetCurrency = await companyCurrency(db, event.companyId, true);
    if (event.budgetCurrency !== budgetCurrency) {
      throw unprocessable("Cost event currency does not match company budget currency");
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
      .where(and(eq(tasks.id, event.taskId), eq(tasks.companyId, event.companyId)))
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
    upsertPolicyAndActivityInTransaction,
    applyCommittedPolicyUpsert,
    knownSpendBy,
    evaluateCostEventInTransaction,
  };
}
