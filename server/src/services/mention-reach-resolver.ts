import type {
  AgentMentionReachGrantKey,
} from "@paperclipai/shared";
import {
  evaluateAgentInvokability,
  type AgentOrgRow,
} from "./agent-invokability.js";

export interface MentionReachAgent extends AgentOrgRow {
  currentAdapterConfigRevisionId: string | null;
}

export interface MentionReachIssue {
  id: string;
  parentId: string | null;
  ownerKind: string;
  ownerAgentId: string | null;
}

export interface MentionReachResolution {
  targetAgentIds: ReadonlySet<string>;
  activatesTool: boolean;
}

function invokableAgentIds(
  agents: readonly MentionReachAgent[],
): ReadonlySet<string> {
  return new Set(
    agents
      .filter(
        (agent) =>
          agent.currentAdapterConfigRevisionId !== null &&
          evaluateAgentInvokability(
            agent,
            agents as MentionReachAgent[],
          ).invokable,
      )
      .map((agent) => agent.id),
  );
}

function orgDescendantIds(
  sourceAgentId: string,
  agents: readonly MentionReachAgent[],
): ReadonlySet<string> {
  const childrenByParent = new Map<string, string[]>();
  for (const agent of agents) {
    if (!agent.reportsTo) continue;
    const children = childrenByParent.get(agent.reportsTo) ?? [];
    children.push(agent.id);
    childrenByParent.set(agent.reportsTo, children);
  }

  const descendants = new Set<string>();
  const pending = [...(childrenByParent.get(sourceAgentId) ?? [])];
  while (pending.length > 0) {
    const candidate = pending.pop();
    if (!candidate || descendants.has(candidate)) continue;
    descendants.add(candidate);
    pending.push(...(childrenByParent.get(candidate) ?? []));
  }
  return descendants;
}

function boundedAncestorIds(
  source: MentionReachAgent,
  agentsById: ReadonlyMap<string, MentionReachAgent>,
  rootOwnerAgentId: string | null,
): ReadonlySet<string> {
  if (!rootOwnerAgentId || rootOwnerAgentId === source.id) {
    return new Set();
  }

  const ordered: string[] = [];
  const visited = new Set<string>();
  let cursor = source.reportsTo;
  while (cursor && !visited.has(cursor)) {
    ordered.push(cursor);
    if (cursor === rootOwnerAgentId) return new Set(ordered);
    visited.add(cursor);
    cursor = agentsById.get(cursor)?.reportsTo ?? null;
  }

  // The issue root owner is the inclusive ceiling. If it is not on the
  // caller's reporting line, there is no safe dynamic upward reach.
  return new Set();
}

/**
 * Canonical same-issue consult resolver used by both tools/list compilation
 * and the transactional tools/call recheck.
 */
export function resolveMentionReach(input: {
  sourceAgentId: string;
  companyAgents: readonly MentionReachAgent[];
  issueTree: readonly MentionReachIssue[];
  mentionReach: Readonly<
    Partial<Record<AgentMentionReachGrantKey, boolean>>
  >;
}): MentionReachResolution {
  const agentsById = new Map(
    input.companyAgents.map((agent) => [agent.id, agent]),
  );
  const source = agentsById.get(input.sourceAgentId);
  if (!source) return { targetAgentIds: new Set(), activatesTool: false };

  const eligible = invokableAgentIds(input.companyAgents);
  const directChildren = input.companyAgents
    .filter(
      (agent) =>
        agent.reportsTo === source.id &&
        eligible.has(agent.id),
    )
    .map((agent) => agent.id);
  const directParent =
    source.reportsTo && eligible.has(source.reportsTo)
      ? source.reportsTo
      : null;

  const root = input.issueTree.find((issue) => issue.parentId === null) ?? null;
  const treeOwnerIds = new Set(
    input.issueTree
      .filter(
        (issue) =>
          issue.ownerKind === "agent" &&
          issue.ownerAgentId !== null,
      )
      .map((issue) => issue.ownerAgentId!),
  );

  const dynamicTargets = new Set<string>();
  if (input.mentionReach.mention_any_descendant === true) {
    for (const agentId of orgDescendantIds(source.id, input.companyAgents)) {
      if (treeOwnerIds.has(agentId) && eligible.has(agentId)) {
        dynamicTargets.add(agentId);
      }
    }
  }
  if (input.mentionReach.mention_any_ancestor === true) {
    for (const agentId of boundedAncestorIds(
      source,
      agentsById,
      root?.ownerKind === "agent" ? root.ownerAgentId : null,
    )) {
      if (eligible.has(agentId)) dynamicTargets.add(agentId);
    }
  }

  const activatesTool =
    directChildren.length > 0 ||
    directParent !== null ||
    dynamicTargets.size > 0;
  if (!activatesTool) {
    return { targetAgentIds: new Set(), activatesTool: false };
  }

  const targetAgentIds = new Set<string>([
    ...directChildren,
    ...dynamicTargets,
  ]);
  if (directParent) targetAgentIds.add(directParent);
  targetAgentIds.delete(source.id);
  return { targetAgentIds, activatesTool: true };
}
