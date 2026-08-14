import { agentRuntimeState, agents, approvals, type Db } from "@paperclipai/db";
import {
  canonicalizeMoneyAmount,
  getAgentWorkEligibility,
  isCanonicalUuid,
  type AgentEligibilityAgent,
  type AgentRuntimeState,
  type MoneyAmount,
} from "@paperclipai/shared";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { conflict } from "../errors.js";
import { publishCommittedActivity } from "./activity-log.js";
import { lockCompanyAgentGraph } from "./agent-org-graph-lock.js";
import {
  terminateAgentToTombstoneInTransaction,
  type AgentSuspensionPostCommit,
  type AgentTerminationPostCommit,
} from "./agents-termination-commit.js";
import { budgetService } from "./budgets.js";

export function agentService(db: Db) {
  const budgets = budgetService(db);

  function toEligibilityAgent(
    row: Pick<typeof agents.$inferSelect, "id" | "companyId" | "name" | "status" | "reportsTo">,
  ): AgentEligibilityAgent {
    return {
      id: row.id,
      companyId: row.companyId,
      name: row.name,
      status: row.status,
      reportsTo: row.reportsTo,
    };
  }

  function normalizeAgentRows<T extends typeof agents.$inferSelect>(
    rows: T[],
    allCompanyRows: (typeof agents.$inferSelect)[] = rows,
  ) {
    const eligibilityAgents = allCompanyRows.map(toEligibilityAgent);
    return rows.map((row) => {
      return {
        ...row,
        orgChainHealth: getAgentWorkEligibility({
          agent: toEligibilityAgent(row),
          agents: eligibilityAgents,
        }).orgChainHealth,
      };
    });
  }

  function normalizeAgentRow<T extends typeof agents.$inferSelect>(
    row: T,
    allCompanyRows?: (typeof agents.$inferSelect)[],
  ) {
    return normalizeAgentRows([row], allCompanyRows)[0]!;
  }

  async function listCompanyAgentRows(companyId: string) {
    return db.select().from(agents).where(eq(agents.companyId, companyId));
  }

  async function getMonthlySpendByAgentIds(companyId: string, agentIds: string[]) {
    return budgets.getAgentMonthlyKnownSpend(companyId, agentIds);
  }

  async function hydrateAgentSpend<T extends { id: string; companyId: string }>(
    rows: T[],
  ): Promise<Array<T & { knownSpendAmount: MoneyAmount }>> {
    if (rows.length === 0) return [];
    const agentIds = rows.map((row) => row.id);
    const companyId = rows[0]!.companyId;
    const spendByAgentId = await getMonthlySpendByAgentIds(companyId, agentIds);
    return rows.map((row) => ({
      ...row,
      knownSpendAmount: spendByAgentId.get(row.id)!,
    }));
  }

  async function getById(id: string) {
    if (!isCanonicalUuid(id)) return null;
    const row = await db
      .select()
      .from(agents)
      .where(eq(agents.id, id))
      .then((rows) => rows[0] ?? null);
    if (!row) return null;
    const [companyRows, hydrated] = await Promise.all([
      listCompanyAgentRows(row.companyId),
      hydrateAgentSpend([row]).then((rows) => rows[0]!),
    ]);
    return normalizeAgentRow(hydrated, companyRows);
  }

  return {
    list: async (companyId: string, options?: { includeTerminated?: boolean }) => {
      const conditions = [eq(agents.companyId, companyId)];
      if (!options?.includeTerminated) {
        conditions.push(ne(agents.status, "terminated"));
      }
      const [rows, allCompanyRows] = await Promise.all([
        db
          .select()
          .from(agents)
          .where(and(...conditions)),
        listCompanyAgentRows(companyId),
      ]);
      const hydrated = await hydrateAgentSpend(rows);
      return normalizeAgentRows(hydrated, allCompanyRows);
    },

    getById,

    getRuntimeState: async (agentId: string): Promise<AgentRuntimeState | null> => {
      const row = await db
        .select()
        .from(agentRuntimeState)
        .where(eq(agentRuntimeState.agentId, agentId))
        .then((rows) => rows[0] ?? null);
      if (!row) return null;
      return {
        ...row,
        aggregateKnownCostAmount: canonicalizeMoneyAmount(row.aggregateKnownCostAmount),
      };
    },

    pause: async (
      id: string,
      postCommit: AgentSuspensionPostCommit,
      reason: "manual" | "budget" | "system" = "manual",
    ) => {
      const committed = await db.transaction(async (tx) => {
        const companyId = await tx
          .select({ companyId: agents.companyId })
          .from(agents)
          .where(eq(agents.id, id))
          .then((rows) => rows[0]?.companyId ?? null);
        if (!companyId) return null;

        const locked = await lockCompanyAgentGraph(tx, companyId);
        const existing = locked.agents.find((candidate) => candidate.id === id);
        if (!existing) return null;
        if (existing.status === "terminated") {
          throw conflict("Cannot pause terminated agent");
        }
        if (existing.status === "pending_approval") {
          throw conflict("Pending approval agents must be rejected instead of paused", {
            code: "pending_hire_requires_rejection",
            agentId: id,
          });
        }

        const now = new Date();
        if (existing.status !== "paused") {
          const updated = await tx
            .update(agents)
            .set({
              status: "paused",
              pauseReason: reason,
              pausedAt: now,
              errorReason: null,
              updatedAt: now,
            })
            .where(
              and(
                eq(agents.id, existing.id),
                eq(agents.companyId, existing.companyId),
                eq(agents.status, existing.status),
              ),
            )
            .returning({ id: agents.id })
            .then((rows) => rows[0] ?? null);
          if (!updated) {
            throw conflict("Agent pause lost its locked lifecycle transition");
          }
        }

        const suspensionRequests =
          await postCommit.taskExecutionCancellation.requestAgentSuspensionsInTransaction(tx, {
            companyId: existing.companyId,
            agentIds: [existing.id],
            reason: "Suspended because the agent was paused",
            actor: postCommit.actor,
            now,
          });
        return { agentId: existing.id, suspensionRequests };
      });
      if (!committed) return null;
      await postCommit.taskExecutionCancellation.reconcileRequestedCancellations(
        committed.suspensionRequests,
      );
      return getById(committed.agentId);
    },

    resume: async (id: string) => {
      const updatedId = await db.transaction(async (tx) => {
        const companyId = await tx
          .select({ companyId: agents.companyId })
          .from(agents)
          .where(eq(agents.id, id))
          .then((rows) => rows[0]?.companyId ?? null);
        if (!companyId) return null;
        const locked = await lockCompanyAgentGraph(tx, companyId);
        const existing = locked.agents.find((candidate) => candidate.id === id);
        if (!existing) return null;
        if (existing.status === "terminated") {
          throw conflict("Cannot resume terminated agent");
        }
        if (existing.pauseReason === "budget") {
          throw conflict("Budget-paused agents must be resumed through budget resolution", {
            code: "budget_resume_requires_budget_resolution",
            agentId: existing.id,
          });
        }

        const eligibility = getAgentWorkEligibility({
          agent: toEligibilityAgent(existing),
          agents: locked.agents.map(toEligibilityAgent),
        });
        if (eligibility.orgChainHealth.status === "invalid_org_chain") {
          throw conflict(
            eligibility.orgChainHealth.repairGuidance ??
              "Repair this agent's reporting chain before resuming it",
            {
              code: "invalid_agent_org_chain",
              agentId: existing.id,
            },
          );
        }

        const openHireApproval = await tx
          .select({ id: approvals.id })
          .from(approvals)
          .where(
            and(
              eq(approvals.companyId, existing.companyId),
              eq(approvals.type, "hire_agent"),
              inArray(approvals.status, ["pending", "revision_requested"]),
              sql`${approvals.payload} ->> 'agentId' = ${existing.id}`,
            ),
          )
          .orderBy(approvals.id)
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (existing.status === "pending_approval" || openHireApproval) {
          throw conflict("Pending approval agents cannot be resumed", {
            code: "pending_hire_requires_approval",
            agentId: existing.id,
            approvalId: openHireApproval?.id ?? null,
          });
        }

        const now = new Date();
        const updated = await tx
          .update(agents)
          .set({
            status: "idle",
            pauseReason: null,
            pausedAt: null,
            errorReason: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(agents.id, existing.id),
              eq(agents.companyId, existing.companyId),
              eq(agents.status, existing.status),
            ),
          )
          .returning({ id: agents.id })
          .then((rows) => rows[0] ?? null);
        if (!updated) {
          throw conflict("Agent resume lost its locked lifecycle transition");
        }
        return updated.id;
      });
      return updatedId ? getById(updatedId) : null;
    },

    clearError: async (id: string) => {
      const existing = await getById(id);
      if (!existing) return null;
      if (existing.status === "terminated") throw conflict("Cannot clear error on terminated agent");
      if (existing.status === "pending_approval") {
        throw conflict("Pending approval agents cannot have errors cleared");
      }
      if (existing.status !== "error") {
        throw conflict("Only agents in error status can have their error cleared");
      }

      const updated = await db
        .update(agents)
        .set({
          status: "idle",
          pauseReason: null,
          pausedAt: null,
          errorReason: null,
          updatedAt: new Date(),
        })
        .where(and(eq(agents.id, id), eq(agents.status, "error")))
        .returning()
        .then((rows) => rows[0] ?? null);

      if (!updated) {
        throw conflict("Only agents in error status can have their error cleared");
      }
      return getById(updated.id);
    },

    terminate: async (id: string, postCommit: AgentTerminationPostCommit) => {
      const committed = await db.transaction(async (tx) => {
        const now = new Date();
        return terminateAgentToTombstoneInTransaction(
          tx,
          {
            agentId: id,
            sourceId: `agent-termination:${id}`,
            actor: postCommit.actor,
            now,
          },
          postCommit.taskExecutionCancellation,
        );
      });
      for (const activity of committed?.activities ?? []) {
        publishCommittedActivity(activity);
      }
      if (committed?.cancellationRequests) {
        await postCommit.taskExecutionCancellation.reconcileRequestedCancellations(
          committed.cancellationRequests,
        );
      }
      if (committed?.suspensionRequests) {
        await postCommit.taskExecutionCancellation.reconcileRequestedCancellations(
          committed.suspensionRequests,
        );
      }
      for (const refId of committed?.dispatchRefIds ?? []) {
        await postCommit.dispatchRef(refId);
      }
      return committed ? getById(id) : null;
    },

    orgForCompany: async (companyId: string) => {
      const allCompanyRows = await listCompanyAgentRows(companyId);
      const rows = allCompanyRows.filter((row) => row.status !== "terminated");
      const normalizedRows = normalizeAgentRows(rows, allCompanyRows);
      const byManager = new Map<string | null, typeof normalizedRows>();
      for (const row of normalizedRows) {
        const key =
          row.reportsTo && rows.some((candidate) => candidate.id === row.reportsTo) ? row.reportsTo : null;
        const group = byManager.get(key) ?? [];
        group.push(row);
        byManager.set(key, group);
      }

      const build = (managerId: string | null): Array<Record<string, unknown>> => {
        const members = byManager.get(managerId) ?? [];
        return members.map((member) => ({
          ...member,
          reports: build(member.id),
        }));
      };

      return build(null);
    },

    getChainOfCommand: async (agentId: string) => {
      const chain: { id: string; name: string; title: string | null }[] = [];
      const visited = new Set<string>([agentId]);
      const start = await getById(agentId);
      let currentId = start?.reportsTo ?? null;
      while (currentId && !visited.has(currentId) && chain.length < 50) {
        visited.add(currentId);
        const mgr = await getById(currentId);
        if (!mgr) break;
        chain.push({ id: mgr.id, name: mgr.name, title: mgr.title ?? null });
        currentId = mgr.reportsTo ?? null;
      }
      return chain;
    },
  };
}
