import type { Db } from "@paperclipai/db";
import { agentAdapterConfigRevisions, agents } from "@paperclipai/db";
import { getAgentWorkEligibility, type AgentEligibilityAgent, type AgentOrgChainHealth } from "@paperclipai/shared";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { IssueSessionDbTransaction } from "./issue-session/event-store.js";
import {
  isServerAdapterImplementationAvailable,
} from "../adapters/registry.js";

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
 * An agent can be selected as a new issue owner only when this exact current
 * adapter revision remains resolvable for that same agent in that company.
 * A non-null pointer alone is intentionally not sufficient.
 */
export type InvokableIssueOwnerAgent = AgentOrgRow & Pick<
  typeof agents.$inferSelect,
  "currentAdapterConfigRevisionId"
> & Partial<Pick<typeof agents.$inferSelect, "title" | "icon">>;

export type InvokableIssueOwnerRevision = Pick<
  typeof agentAdapterConfigRevisions.$inferSelect,
  | "id"
  | "companyId"
  | "agentId"
  | "adapterType"
  | "implementationIdentity"
> & {
  implementationAvailable: boolean;
};

export type InvokableIssueOwnerRejectionReason =
  | `owner_not_invokable:${AgentInvokabilityBlockReason}`
  | "owner_revision_missing"
  | "owner_implementation_unavailable";

export class InvokableIssueOwnerRejected extends Error {
  readonly code = "invokable_issue_owner_rejected";

  constructor(
    message: string,
    readonly reason: InvokableIssueOwnerRejectionReason,
    readonly details: Record<string, unknown>,
  ) {
    super(message);
    this.name = "InvokableIssueOwnerRejected";
  }
}

export interface InvokableIssueOwnerResolution<
  Owner extends InvokableIssueOwnerAgent = InvokableIssueOwnerAgent,
  Revision extends InvokableIssueOwnerRevision = InvokableIssueOwnerRevision,
> {
  owner: Owner;
  revision: Revision;
  revisionId: string;
}

export interface InvokableIssueOwnerSnapshot<
  Owner extends InvokableIssueOwnerAgent = InvokableIssueOwnerAgent,
  Revision extends InvokableIssueOwnerRevision = InvokableIssueOwnerRevision,
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

  const directStatusReason = eligibility.invokabilityReason === "unknown_status"
    ? "unknown_status"
    : statusBlockReason(agent.status);
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
 * eligibility identical to the issuance-time owner check.
 */
export function resolveInvokableIssueOwner<
  Owner extends InvokableIssueOwnerAgent,
  Revision extends InvokableIssueOwnerRevision,
>(
  input: InvokableIssueOwnerSnapshot<Owner, Revision>,
): InvokableIssueOwnerResolution<Owner, Revision> {
  const companyAgents = input.companyAgents.filter(
    (candidate) => candidate.companyId === input.companyId,
  );
  const owner = companyAgents.find(
    (candidate) => candidate.id === input.ownerAgentId,
  );
  if (!owner) {
    throw new InvokableIssueOwnerRejected(
      "Agent no longer exists",
      "owner_not_invokable:missing",
      {
        companyId: input.companyId,
        ownerAgentId: input.ownerAgentId,
      },
    );
  }
  const invokability = evaluateAgentInvokability(
    owner,
    companyAgents,
  );
  if (!invokability.invokable) {
    throw new InvokableIssueOwnerRejected(
      invokability.message,
      `owner_not_invokable:${invokability.reason}`,
      {
        companyId: input.companyId,
        ownerAgentId: input.ownerAgentId,
        ...invokability.details,
      },
    );
  }
  if (!owner.currentAdapterConfigRevisionId) {
    throw new InvokableIssueOwnerRejected(
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
    throw new InvokableIssueOwnerRejected(
      "Owner adapter configuration revision does not exist",
      "owner_revision_missing",
      {
        companyId: input.companyId,
        ownerAgentId: owner.id,
        currentAdapterConfigRevisionId: owner.currentAdapterConfigRevisionId,
      },
    );
  }
  if (!revision.implementationAvailable) {
    throw new InvokableIssueOwnerRejected(
      "Owner adapter implementation is unavailable",
      "owner_implementation_unavailable",
      {
        companyId: input.companyId,
        ownerAgentId: owner.id,
        adapterConfigRevisionId: revision.id,
        adapterType: revision.adapterType,
        implementationIdentity: revision.implementationIdentity,
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
export function resolveInvokableIssueOwnerCatalog<
  Owner extends InvokableIssueOwnerAgent,
  Revision extends InvokableIssueOwnerRevision,
>(input: Omit<InvokableIssueOwnerSnapshot<Owner, Revision>, "ownerAgentId">):
  ReadonlyMap<string, InvokableIssueOwnerResolution<Owner, Revision>> {
  const result = new Map<
    string,
    InvokableIssueOwnerResolution<Owner, Revision>
  >();
  for (const candidate of input.companyAgents) {
    if (candidate.companyId !== input.companyId) continue;
    try {
      const resolved = resolveInvokableIssueOwner({
        ...input,
        ownerAgentId: candidate.id,
      });
      result.set(candidate.id, resolved);
    } catch (error) {
      if (error instanceof InvokableIssueOwnerRejected) continue;
      throw error;
    }
  }
  return result;
}

function currentRevisionIds(
  companyAgents: readonly InvokableIssueOwnerAgent[],
): string[] {
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
  companyAgents: readonly InvokableIssueOwnerAgent[],
): Promise<InvokableIssueOwnerRevision[]> {
  const revisionIds = currentRevisionIds(companyAgents);
  if (revisionIds.length === 0) return [];
  return db
    .select({
      id: agentAdapterConfigRevisions.id,
      companyId: agentAdapterConfigRevisions.companyId,
      agentId: agentAdapterConfigRevisions.agentId,
      adapterType: agentAdapterConfigRevisions.adapterType,
      implementationIdentity:
        agentAdapterConfigRevisions.implementationIdentity,
    })
    .from(agentAdapterConfigRevisions)
    .where(
      and(
        eq(agentAdapterConfigRevisions.companyId, companyId),
        inArray(agentAdapterConfigRevisions.id, revisionIds),
      ),
    )
    .orderBy(asc(agentAdapterConfigRevisions.id))
    .then((rows) =>
      rows.map((revision) => ({
        ...revision,
        implementationAvailable:
          isServerAdapterImplementationAvailable(
            revision.adapterType,
            revision.implementationIdentity,
          ),
      })),
    );
}

async function listCurrentAdapterRevisionsForUpdate(
  tx: IssueSessionDbTransaction,
  companyId: string,
  companyAgents: readonly InvokableIssueOwnerAgent[],
): Promise<InvokableIssueOwnerRevision[]> {
  const revisionIds = currentRevisionIds(companyAgents);
  if (revisionIds.length === 0) return [];
  return tx
    .select({
      id: agentAdapterConfigRevisions.id,
      companyId: agentAdapterConfigRevisions.companyId,
      agentId: agentAdapterConfigRevisions.agentId,
      adapterType: agentAdapterConfigRevisions.adapterType,
      implementationIdentity:
        agentAdapterConfigRevisions.implementationIdentity,
    })
    .from(agentAdapterConfigRevisions)
    .where(
      and(
        eq(agentAdapterConfigRevisions.companyId, companyId),
        inArray(agentAdapterConfigRevisions.id, revisionIds),
      ),
    )
    .orderBy(asc(agentAdapterConfigRevisions.id))
    .for("update")
    .then((rows) =>
      rows.map((revision) => ({
        ...revision,
        implementationAvailable:
          isServerAdapterImplementationAvailable(
            revision.adapterType,
            revision.implementationIdentity,
          ),
      })),
    );
}

/** Resolves a configuration-time owner without acquiring write locks. */
export async function resolveInvokableIssueOwnerFromDb(
  db: Db,
  input: Pick<InvokableIssueOwnerSnapshot, "companyId" | "ownerAgentId">,
): Promise<InvokableIssueOwnerResolution> {
  const companyAgents = await db
    .select()
    .from(agents)
    .where(eq(agents.companyId, input.companyId))
    .orderBy(asc(agents.id));
  const adapterRevisions = await listCurrentAdapterRevisions(
    db,
    input.companyId,
    companyAgents,
  );
  return resolveInvokableIssueOwner({
    ...input,
    companyAgents,
    adapterRevisions,
  });
}

/**
 * Resolves the complete company-wide catalog through the same canonical
 * owner/revision predicate used by single-owner configuration reads.
 */
export async function resolveInvokableIssueOwnerCatalogFromDb(
  db: Db,
  input: Pick<InvokableIssueOwnerSnapshot, "companyId">,
): Promise<ReadonlyMap<string, InvokableIssueOwnerResolution>> {
  const companyAgents = await db
    .select()
    .from(agents)
    .where(eq(agents.companyId, input.companyId))
    .orderBy(asc(agents.id));
  const adapterRevisions = await listCurrentAdapterRevisions(
    db,
    input.companyId,
    companyAgents,
  );
  return resolveInvokableIssueOwnerCatalog({
    ...input,
    companyAgents,
    adapterRevisions,
  });
}

/**
 * Resolves and locks a new issue owner together with its exact selected
 * adapter revision. Use this immediately before persisting an owner epoch or
 * issuing its first ref.
 */
export async function resolveInvokableIssueOwnerInTransaction(
  tx: IssueSessionDbTransaction,
  input: Pick<InvokableIssueOwnerSnapshot, "companyId" | "ownerAgentId">,
): Promise<InvokableIssueOwnerResolution> {
  const companyAgents = await tx
    .select()
    .from(agents)
    .where(eq(agents.companyId, input.companyId))
    .orderBy(asc(agents.id))
    .for("update");
  const adapterRevisions = await listCurrentAdapterRevisionsForUpdate(
    tx,
    input.companyId,
    companyAgents,
  );
  return resolveInvokableIssueOwner({
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
export async function resolveInvokableIssueOwnerCatalogInTransaction(
  tx: IssueSessionDbTransaction,
  input: Pick<InvokableIssueOwnerSnapshot, "companyId">,
): Promise<ReadonlyMap<string, InvokableIssueOwnerResolution>> {
  const companyAgents = await tx
    .select()
    .from(agents)
    .where(eq(agents.companyId, input.companyId))
    .orderBy(asc(agents.id))
    .for("update");
  const adapterRevisions = await listCurrentAdapterRevisionsForUpdate(
    tx,
    input.companyId,
    companyAgents,
  );
  return resolveInvokableIssueOwnerCatalog({
    ...input,
    companyAgents,
    adapterRevisions,
  });
}

export async function evaluateAgentInvokabilityFromDb(
  db: Db,
  agent: AgentOrgRow | null | undefined,
): Promise<AgentInvokability> {
  if (!agent) return evaluateAgentInvokability(agent, []);
  const companyAgents = await db
    .select({
      id: agents.id,
      companyId: agents.companyId,
      name: agents.name,
      reportsTo: agents.reportsTo,
      status: agents.status,
    })
    .from(agents)
    .where(eq(agents.companyId, agent.companyId));
  return evaluateAgentInvokability(agent, companyAgents);
}
