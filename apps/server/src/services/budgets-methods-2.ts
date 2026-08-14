import { and, eq } from "drizzle-orm";
import { agents, budgetIncidents, budgetPolicies, companies, projects, type Db } from "@paperclipai/db";
import {
  compareMoneyAmounts,
  parseMoneyAmount,
  type BudgetIncident,
  type BudgetIncidentResolutionInput,
  type BudgetScopeType,
} from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";
import { logActivity } from "./activity-log.js";
import * as budgetPolicy from "./budget-policy-foundation.js";
import { buildBudgetsBudgetEnforcement } from "./budget-enforcement.js";
import { buildBudgetsBudgetPolicySummaries } from "./budget-policy-summaries.js";
import { buildBudgetsBudgetPolicyCommits } from "./budget-policy-commits.js";

export function createBudgetsMethods2(
  scope: budgetPolicy.BudgetsContext &
    ReturnType<typeof buildBudgetsBudgetEnforcement> &
    ReturnType<typeof buildBudgetsBudgetPolicySummaries> &
    ReturnType<typeof buildBudgetsBudgetPolicyCommits>,
) {
  const { db, hooks, listPolicyRows, resumeScope, markApprovalStatus, hydrateIncidentRows } = scope;

  return {
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
        const observed = await budgetPolicy.computeObservedAmount(db, policy);
        if (compareMoneyAmounts(observed, budgetPolicy.trustedAmount(policy.limitAmount)) >= 0) {
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
      budgetPolicy.assertCanonicalBudgetIncidentId(incidentId);
      const result = await db.transaction(async (tx) => {
        const transaction = tx as unknown as Db;
        const budgetCurrency = await budgetPolicy.companyCurrency(transaction, companyId, true);
        const incident = await transaction
          .select()
          .from(budgetIncidents)
          .where(and(eq(budgetIncidents.id, incidentId), eq(budgetIncidents.companyId, companyId)))
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
        if (policy.scopeType === "agent" && owner !== "agent_operational_configuration") {
          throw unprocessable("Agent budget incidents are owned by agent operational configuration", {
            code: "agent_budget_requires_operational_configuration",
          });
        }
        await budgetPolicy.resolveScopeRecord(
          transaction,
          policy.scopeType as BudgetScopeType,
          policy.scopeId,
          policy.scopeType !== "company",
        );
        const now = new Date();
        if (input.action === "raise_budget_and_resume") {
          const nextLimit = parseMoneyAmount(input.limitAmount);
          const observed = await budgetPolicy.computeObservedAmount(transaction, policy);
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
            .where(and(eq(budgetIncidents.policyId, policy.id), eq(budgetIncidents.status, "open")));
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
                } satisfies budgetPolicy.BudgetEnforcementScope)
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
      return (await hydrateIncidentRows(db, [result.updated], result.budgetCurrency))[0]!;
    },

    getIncidentScope: async (companyId: string, incidentId: string) => {
      budgetPolicy.assertCanonicalBudgetIncidentId(incidentId);
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
  };
}
