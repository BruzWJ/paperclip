import { and, eq } from "drizzle-orm";
import { agents, type Db } from "@paperclipai/db";
import {
  agentOperationalConfigurationUpdateSchema,
  type AgentOperationalConfigurationUpdateInput,
  type BudgetIncident,
  type BudgetIncidentResolutionInput,
} from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";
import {
  budgetService,
  type BudgetServiceHooks,
} from "./budgets.js";

export interface AgentOperationalConfigurationResult {
  agent: typeof agents.$inferSelect;
}

/**
 * Board-only owner for display, role-instruction, and operational agent state.
 *
 * Identity/grants, adapter/provider/runtime configuration, lifecycle, spend,
 * and telemetry are deliberately absent. The agent projection and its monthly
 * budget policy are committed atomically.
 */
export function createAgentOperationalConfigurationService(
  db: Db,
  budgetHooks: BudgetServiceHooks = {},
) {
  return {
    async update(input: {
      companyId: string;
      agentId: string;
      configuration: AgentOperationalConfigurationUpdateInput | unknown;
      actorUserId: string | null;
    }): Promise<AgentOperationalConfigurationResult> {
      const parsed =
        agentOperationalConfigurationUpdateSchema.safeParse(
          input.configuration,
        );
      if (!parsed.success) {
        throw unprocessable(
          "Invalid agent operational configuration",
          {
            code: "invalid_agent_operational_configuration",
            issues: parsed.error.issues,
          },
        );
      }

      return db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const locked = await tx
          .select()
          .from(agents)
          .where(
            and(
              eq(agents.companyId, input.companyId),
              eq(agents.id, input.agentId),
            ),
          )
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!locked) throw notFound("Agent not found");
        if (locked.status === "terminated") {
          throw unprocessable(
            "Terminated agents cannot receive operational configuration updates",
            { code: "terminated_agent_operational_configuration" },
          );
        }

        const directPatch: Partial<typeof agents.$inferInsert> = {};
        if (Object.prototype.hasOwnProperty.call(parsed.data, "icon")) {
          directPatch.icon = parsed.data.icon ?? null;
        }
        if (Object.prototype.hasOwnProperty.call(parsed.data, "instruction")) {
          directPatch.instruction = parsed.data.instruction ?? null;
        }
        if (Object.keys(directPatch).length > 0) {
          await tx
            .update(agents)
            .set({ ...directPatch, updatedAt: new Date() })
            .where(
              and(
                eq(agents.companyId, input.companyId),
                eq(agents.id, input.agentId),
              ),
            );
        }

        if (
          Object.prototype.hasOwnProperty.call(
            parsed.data,
            "budgetMonthlyAmount",
          )
        ) {
          await budgetService(txDb, budgetHooks).setAgentMonthlyLimit(
            input.companyId,
            input.agentId,
            parsed.data.budgetMonthlyAmount!,
            input.actorUserId,
          );
        }

        const agent = await tx
          .select()
          .from(agents)
          .where(
            and(
              eq(agents.companyId, input.companyId),
              eq(agents.id, input.agentId),
            ),
          )
          .then((rows) => rows[0] ?? null);
        if (!agent) throw notFound("Agent not found");
        return { agent };
      });
    },

    async resolveBudgetIncident(input: {
      companyId: string;
      incidentId: string;
      resolution: BudgetIncidentResolutionInput;
      actorUserId: string;
    }): Promise<BudgetIncident> {
      const budgets = budgetService(db, budgetHooks);
      const scope = await budgets.getIncidentScope(
        input.companyId,
        input.incidentId,
      );
      if (scope.scopeType !== "agent") {
        throw unprocessable(
          "Only agent budget incidents belong to agent operational configuration",
          { code: "budget_incident_not_agent_scoped" },
        );
      }
      return budgets.resolveIncident(
        input.companyId,
        input.incidentId,
        input.resolution,
        input.actorUserId,
        "agent_operational_configuration",
      );
    },
  };
}

export type AgentOperationalConfigurationService = ReturnType<
  typeof createAgentOperationalConfigurationService
>;
