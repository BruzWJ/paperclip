import { asc, eq, sql } from "drizzle-orm";
import { agents, companies, type Db } from "@paperclipai/db";

export type AgentOrgGraphTransaction =
  Parameters<Parameters<Db["transaction"]>[0]>[0];

export type LockedCompanyAgentGraph = {
  company: typeof companies.$inferSelect | null;
  agents: Array<typeof agents.$inferSelect>;
};

/**
 * Canonical serialization boundary for mutations whose validity depends on an
 * agent's company reporting graph. The advisory lock preserves the historical
 * runtime-agent-configuration namespace while the row locks make subsequent
 * graph reads deterministic.
 */
export async function lockCompanyAgentGraph(
  tx: AgentOrgGraphTransaction,
  companyId: string,
): Promise<LockedCompanyAgentGraph> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`runtime-agent-config:${companyId}`}, 0))`,
  );
  const company = await tx
    .select()
    .from(companies)
    .where(eq(companies.id, companyId))
    .for("update")
    .then((rows) => rows[0] ?? null);
  const companyAgents = await tx
    .select()
    .from(agents)
    .where(eq(agents.companyId, companyId))
    .orderBy(asc(agents.id))
    .for("update");
  return { company, agents: companyAgents };
}

/**
 * Returns the complete reporting subtree in stable parent-before-child order.
 * Cycles cannot loop forever; the locked mutator decides whether an already
 * corrupt graph should be rejected or fenced.
 */
export function listCompanyAgentGraphDescendants<
  Row extends Pick<typeof agents.$inferSelect, "id" | "reportsTo">,
>(
  rootAgentId: string,
  companyAgents: readonly Row[],
): Row[] {
  const byManager = new Map<string, Row[]>();
  for (const row of companyAgents) {
    if (!row.reportsTo) continue;
    const reports = byManager.get(row.reportsTo) ?? [];
    reports.push(row);
    byManager.set(row.reportsTo, reports);
  }
  for (const reports of byManager.values()) {
    reports.sort(
      (left, right) =>
        left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    );
  }

  const descendants: Row[] = [];
  const queue = [...(byManager.get(rootAgentId) ?? [])];
  const seen = new Set<string>([rootAgentId]);
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    if (!current || seen.has(current.id)) continue;
    seen.add(current.id);
    descendants.push(current);
    queue.push(...(byManager.get(current.id) ?? []));
  }
  return descendants;
}
