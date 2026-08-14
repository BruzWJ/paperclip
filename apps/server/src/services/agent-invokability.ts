import { type Db, agentAdapterConfigRevisions, agents } from "@paperclipai/db";
import {
  getAgentWorkEligibility,
  type AgentEligibilityAgent,
  type AgentOrgChainHealth,
} from "@paperclipai/shared";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { TaskSessionDbTransaction } from "./task-session/event-store.js";

type AgentStatus = (typeof agents.$inferSelect)["status"];

export type AgentOrgRow = Pick<
  typeof agents.$inferSelect,
  "id" | "companyId" | "name" | "reportsTo" | "status"
>;

export type AgentInvokabilityBlockReason =
  | "missing"
  | "paused"
  | "terminated"
  | "pending_approval"
  | "unknown_status"
  | "manager_missing"
  | "manager_company_mismatch"
  | "manager_terminated"
  | "reporting_cycle"
  | "reporting_chain_too_deep";

export type AgentInvokability =
  | { invokable: true }
  | {
      invokable: false;
      reason: AgentInvokabilityBlockReason;
      message: string;
      details: Record<string, unknown>;
      invalidOrgChain: boolean;
    };

/**
 * An agent can be selected as a new task owner only when this exact current
 * adapter revision remains resolvable for that same agent in that company.
 * A non-null pointer alone is intentionally not sufficient.
 */
export type InvokableTaskOwnerAgent = AgentOrgRow &
  Pick<typeof agents.$inferSelect, "currentAdapterConfigRevisionId"> &
  Partial<Pick<typeof agents.$inferSelect, "title" | "icon" | "instruction">>;

export type InvokableTaskOwnerRevision = Pick<
  typeof agentAdapterConfigRevisions.$inferSelect,
  "id" | "companyId" | "agentId"
>;

export type InvokableTaskOwnerRejectionReason =
  `owner_not_invokable:${AgentInvokabilityBlockReason}` | "owner_revision_missing";

export class InvokableTaskOwnerRejected extends Error {
  readonly code = "invokable_task_owner_rejected";

  constructor(
    message: string,
    readonly reason: InvokableTaskOwnerRejectionReason,
    readonly details: Record<string, unknown>,
  ) {
    super(message);
    this.name = "InvokableTaskOwnerRejected";
  }
}

export interface InvokableTaskOwnerResolution<
  Owner extends InvokableTaskOwnerAgent = InvokableTaskOwnerAgent,
  Revision extends InvokableTaskOwnerRevision = InvokableTaskOwnerRevision,
> {
  owner: Owner;
  revision: Revision;
  revisionId: string;
}

export interface InvokableTaskOwnerSnapshot<
  Owner extends InvokableTaskOwnerAgent = InvokableTaskOwnerAgent,
  Revision extends InvokableTaskOwnerRevision = InvokableTaskOwnerRevision,
> {
  companyId: string;
  ownerAgentId: string;
  companyAgents: readonly Owner[];
  adapterRevisions: readonly Revision[];
}

function blocked(
  reason: AgentInvokabilityBlockReason,
  message: string,
  details: Record<string, unknown>,
  invalidOrgChain = false,
): AgentInvokability {
  return { invokable: false, reason, message, details, invalidOrgChain };
}

function statusBlockReason(status: AgentStatus): AgentInvokabilityBlockReason | null {
  if (status === "paused") return "paused";
  if (status === "terminated") return "terminated";
  if (status === "pending_approval") return "pending_approval";
  return null;
}

function toEligibilityAgent(row: AgentOrgRow): AgentEligibilityAgent {
  return {
    id: row.id,
    companyId: row.companyId,
    name: row.name,
    status: row.status,
    reportsTo: row.reportsTo,
  };
}

function invalidChainReason(health: AgentOrgChainHealth): AgentInvokabilityBlockReason {
  if (health.reason === "terminated_ancestor") return "manager_terminated";
  if (health.reason === "cycle") return "reporting_cycle";
  return "manager_missing";
}

export function evaluateAgentInvokability(
  agent: AgentOrgRow | null | undefined,
  companyAgents: AgentOrgRow[],
): AgentInvokability {
  if (!agent) {
    return blocked("missing", "Agent no longer exists", {}, false);
  }

  const eligibility = getAgentWorkEligibility({
    agent: toEligibilityAgent(agent),
    agents: companyAgents.map(toEligibilityAgent),
  });

  if (eligibility.invokable) return { invokable: true };

  const directStatusReason =
    eligibility.invokabilityReason === "unknown_status" ? "unknown_status" : statusBlockReason(agent.status);
  if (directStatusReason) {
    return blocked(
      directStatusReason,
      "Agent is not invokable in its current state",
      { agentId: agent.id, agentStatus: agent.status },
      false,
    );
  }

  const health = eligibility.orgChainHealth;
  const firstInvalidAncestor = health.firstInvalidAncestor;
  return blocked(
    invalidChainReason(health),
    "Agent is not invokable because its reporting chain is invalid",
    {
      agentId: agent.id,
      managerId: firstInvalidAncestor?.id ?? null,
      managerStatus: firstInvalidAncestor?.status ?? null,
      reportingChainAgentIds: health.fullChain
        .filter((entry) => entry.relation === "ancestor")
        .map((entry) => entry.id),
      orgChainHealth: health,
    },
    true,
  );
}

/**
 * Pure owner assertion used by both locked writes and catalog snapshots.
 * Keeping the adapter-revision relation here makes a descriptor's owner
 * eligibility identical to the ref-creation-time owner check.
 */
export function resolveInvokableTaskOwner<
  Owner extends InvokableTaskOwnerAgent,
  Revision extends InvokableTaskOwnerRevision,
>(input: InvokableTaskOwnerSnapshot<Owner, Revision>): InvokableTaskOwnerResolution<Owner, Revision> {
  const companyAgents = input.companyAgents.filter((candidate) => candidate.companyId === input.companyId);
  const owner = companyAgents.find((candidate) => candidate.id === input.ownerAgentId);
  if (!owner) {
    throw new InvokableTaskOwnerRejected("Agent no longer exists", "owner_not_invokable:missing", {
      companyId: input.companyId,
      ownerAgentId: input.ownerAgentId,
    });
  }
  const invokability = evaluateAgentInvokability(owner, companyAgents);
  if (!invokability.invokable) {
    throw new InvokableTaskOwnerRejected(invokability.message, `owner_not_invokable:${invokability.reason}`, {
      companyId: input.companyId,
      ownerAgentId: input.ownerAgentId,
      ...invokability.details,
    });
  }
  if (!owner.currentAdapterConfigRevisionId) {
    throw new InvokableTaskOwnerRejected(
      "Owner has no current adapter configuration revision",
      "owner_revision_missing",
      {
        companyId: input.companyId,
        ownerAgentId: owner.id,
      },
    );
  }

  const revision = input.adapterRevisions.find(
    (candidate) =>
      candidate.id === owner.currentAdapterConfigRevisionId &&
      candidate.companyId === input.companyId &&
      candidate.agentId === owner.id,
  );
  if (!revision) {
    throw new InvokableTaskOwnerRejected(
      "Owner adapter configuration revision does not exist",
      "owner_revision_missing",
      {
        companyId: input.companyId,
        ownerAgentId: owner.id,
        currentAdapterConfigRevisionId: owner.currentAdapterConfigRevisionId,
      },
    );
  }
  return { owner, revision, revisionId: revision.id };
}

/**
 * Catalog form of the canonical owner predicate. Rejections are expected
 * catalog omissions; callers that need the precise reason use the single
 * owner resolver above.
 */
export function resolveInvokableTaskOwnerCatalog<
  Owner extends InvokableTaskOwnerAgent,
  Revision extends InvokableTaskOwnerRevision,
>(
  input: Omit<InvokableTaskOwnerSnapshot<Owner, Revision>, "ownerAgentId">,
): ReadonlyMap<string, InvokableTaskOwnerResolution<Owner, Revision>> {
  const result = new Map<string, InvokableTaskOwnerResolution<Owner, Revision>>();
  for (const candidate of input.companyAgents) {
    if (candidate.companyId !== input.companyId) continue;
    try {
      const resolved = resolveInvokableTaskOwner({
        ...input,
        ownerAgentId: candidate.id,
      });
      result.set(candidate.id, resolved);
    } catch (error) {
      if (error instanceof InvokableTaskOwnerRejected) continue;
      throw error;
    }
  }
  return result;
}

function currentRevisionIds(companyAgents: readonly InvokableTaskOwnerAgent[]): string[] {
  return [
    ...new Set(
      companyAgents
        .map((agent) => agent.currentAdapterConfigRevisionId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
}

async function listCurrentAdapterRevisions(
  db: Db,
  companyId: string,
  companyAgents: readonly InvokableTaskOwnerAgent[],
): Promise<InvokableTaskOwnerRevision[]> {
  const revisionIds = currentRevisionIds(companyAgents);
  if (revisionIds.length === 0) return [];
  return db
    .select({
      id: agentAdapterConfigRevisions.id,
      companyId: agentAdapterConfigRevisions.companyId,
      agentId: agentAdapterConfigRevisions.agentId,
    })
    .from(agentAdapterConfigRevisions)
    .where(
      and(
        eq(agentAdapterConfigRevisions.companyId, companyId),
        inArray(agentAdapterConfigRevisions.id, revisionIds),
      ),
    )
    .orderBy(asc(agentAdapterConfigRevisions.id));
}

async function listCurrentAdapterRevisionsForUpdate(
  tx: TaskSessionDbTransaction,
  companyId: string,
  companyAgents: readonly InvokableTaskOwnerAgent[],
): Promise<InvokableTaskOwnerRevision[]> {
  const revisionIds = currentRevisionIds(companyAgents);
  if (revisionIds.length === 0) return [];
  return tx
    .select({
      id: agentAdapterConfigRevisions.id,
      companyId: agentAdapterConfigRevisions.companyId,
      agentId: agentAdapterConfigRevisions.agentId,
    })
    .from(agentAdapterConfigRevisions)
    .where(
      and(
        eq(agentAdapterConfigRevisions.companyId, companyId),
        inArray(agentAdapterConfigRevisions.id, revisionIds),
      ),
    )
    .orderBy(asc(agentAdapterConfigRevisions.id))
    .for("update");
}

/** Resolves a configuration-time owner without acquiring write locks. */
export async function resolveInvokableTaskOwnerFromDb(
  db: Db,
  input: Pick<InvokableTaskOwnerSnapshot, "companyId" | "ownerAgentId">,
): Promise<InvokableTaskOwnerResolution> {
  const companyAgents = await db
    .select()
    .from(agents)
    .where(eq(agents.companyId, input.companyId))
    .orderBy(asc(agents.id));
  const adapterRevisions = await listCurrentAdapterRevisions(db, input.companyId, companyAgents);
  return resolveInvokableTaskOwner({
    ...input,
    companyAgents,
    adapterRevisions,
  });
}

/**
 * Resolves the complete company-wide catalog through the same canonical
 * owner/revision predicate used by single-owner configuration reads.
 */
export async function resolveInvokableTaskOwnerCatalogFromDb(
  db: Db,
  input: Pick<InvokableTaskOwnerSnapshot, "companyId">,
): Promise<ReadonlyMap<string, InvokableTaskOwnerResolution>> {
  const companyAgents = await db
    .select()
    .from(agents)
    .where(eq(agents.companyId, input.companyId))
    .orderBy(asc(agents.id));
  const adapterRevisions = await listCurrentAdapterRevisions(db, input.companyId, companyAgents);
  return resolveInvokableTaskOwnerCatalog({
    ...input,
    companyAgents,
    adapterRevisions,
  });
}

/**
 * Resolves and locks a new task owner together with its exact selected
 * adapter revision. Use this immediately before persisting an owner epoch or
 * creating its first ref.
 */
export async function resolveInvokableTaskOwnerInTransaction(
  tx: TaskSessionDbTransaction,
  input: Pick<InvokableTaskOwnerSnapshot, "companyId" | "ownerAgentId">,
): Promise<InvokableTaskOwnerResolution> {
  const companyAgents = await tx
    .select()
    .from(agents)
    .where(eq(agents.companyId, input.companyId))
    .orderBy(asc(agents.id))
    .for("update");
  const adapterRevisions = await listCurrentAdapterRevisionsForUpdate(tx, input.companyId, companyAgents);
  return resolveInvokableTaskOwner({
    ...input,
    companyAgents,
    adapterRevisions,
  });
}

/**
 * Locks and resolves the complete company-wide owner catalog. Callers that
 * add authorization layers before this one must acquire those locks first;
 * this function owns the deterministic agents -> current revisions suffix.
 */
export async function resolveInvokableTaskOwnerCatalogInTransaction(
  tx: TaskSessionDbTransaction,
  input: Pick<InvokableTaskOwnerSnapshot, "companyId">,
): Promise<ReadonlyMap<string, InvokableTaskOwnerResolution>> {
  const companyAgents = await tx
    .select()
    .from(agents)
    .where(eq(agents.companyId, input.companyId))
    .orderBy(asc(agents.id))
    .for("update");
  const adapterRevisions = await listCurrentAdapterRevisionsForUpdate(tx, input.companyId, companyAgents);
  return resolveInvokableTaskOwnerCatalog({
    ...input,
    companyAgents,
    adapterRevisions,
  });
}
