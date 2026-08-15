import type { OrgNode } from "@/api/agents";
import { AgentActionButtons } from "@/routes/_authenticated/$companyId/agents/-AgentActionButtons";
import { MembershipAction } from "@/routes/_authenticated/$companyId/-MembershipAction";
import { DomainTree, type DomainTreeNode } from "@/components/patterns/DomainTree";
import { Spinner } from "@/components/ui/spinner";
import { Toggle } from "@/components/ui/toggle";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import {
  isStarred,
  resourceMembershipState,
  useResourceMemberships,
  type ResourceMembershipMutation,
} from "@/hooks/useResourceMemberships";
import type { AgentFilterTab, AgentLiveRunSummary } from "@/lib/agent-filter-tabs";
import { DomainStatus } from "@/components/patterns/DomainStatus";
import { cn } from "@/lib/utils";
import type { Agent } from "@paperclipai/shared";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, Star } from "lucide-react";
import { useMemo } from "react";

type Memberships = ReturnType<typeof useResourceMemberships>["data"];

interface AgentsOrgTreeProps {
  nodes: OrgNode[];
  agentMap: Map<string, Agent>;
  liveRunByAgent: Map<string, AgentLiveRunSummary>;
  tab: AgentFilterTab;
  memberships: Memberships;
  membershipMutation: ResourceMembershipMutation;
}

function toDomainNodes(nodes: OrgNode[]): DomainTreeNode<OrgNode>[] {
  return nodes.map((node) => ({
    id: node.id,
    value: node,
    children: toDomainNodes(node.reports ?? []),
  }));
}

function collectParentIds(nodes: DomainTreeNode<OrgNode>[]): Set<string> {
  const result = new Set<string>();
  for (const node of nodes) {
    if (node.children?.length) {
      result.add(node.id);
      for (const childId of collectParentIds(node.children)) result.add(childId);
    }
  }
  return result;
}

/** Agent reporting hierarchy mapped onto the official Kibo Tree. */
export function AgentsOrgTree({
  nodes,
  agentMap,
  liveRunByAgent,
  tab,
  memberships,
  membershipMutation,
}: AgentsOrgTreeProps) {
  const companyId = useCompanyRouteId();
  const treeNodes = useMemo(() => toDomainNodes(nodes), [nodes]);
  const defaultExpandedIds = useMemo(() => collectParentIds(treeNodes), [treeNodes]);

  return (
    <DomainTree
      nodes={treeNodes}
      defaultExpandedIds={defaultExpandedIds}
      ariaLabel="Agent reporting hierarchy"
      rowClassName={({ node }) => {
        const agent = agentMap.get(node.id);
        return cn(
          agent?.pausedAt && tab !== "paused" && "opacity-50",
          resourceMembershipState(memberships, "agent", node.id) === "left" && "sm:text-foreground/55",
        );
      }}
      renderIcon={({ node }) => {
        const agent = agentMap.get(node.id);
        return agent?.orgChainHealth?.status === "invalid_org_chain" ? (
          <AlertTriangle className="size-4 text-muted-foreground" aria-label="Invalid reporting chain" data-icon="inline-start" />
        ) : (
          <DomainStatus status={node.value.status}>
            <span className="sr-only">{node.value.status.replace(/_/g, " ")}</span>
          </DomainStatus>
        );
      }}
      renderLabel={({ node }) => {
        const agent = agentMap.get(node.id);
        return (
          <Link
            to="/$companyId/agents/$agentId"
            params={{ companyId, agentId: node.id }}
            className="flex min-w-0 items-center gap-2 text-left text-inherit no-underline"
            onClick={(event) => event.stopPropagation()}
          >
            <span className="truncate text-sm font-medium">{node.value.name}</span>
            {agent?.title ? (
              <span className="truncate text-xs text-muted-foreground">{agent.title}</span>
            ) : null}
          </Link>
        );
      }}
      renderAfterLabel={({ node }) => {
        const agent = agentMap.get(node.id);
        if (!agent) return null;
        const liveRun = liveRunByAgent.get(node.id);
        const membershipState = resourceMembershipState(memberships, "agent", node.id);
        const pending =
          membershipMutation.isPending &&
          membershipMutation.variables?.resourceType === "agent" &&
          membershipMutation.variables.resourceId === node.id;
        const starPending = pending && membershipMutation.variables?.starred !== undefined;
        const starred = isStarred(memberships, "agent", node.id);

        return (
          <div className="flex shrink-0 items-center gap-3">
            {liveRun ? (
              <Link
                to="/$companyId/agents/$agentId/runs/$runId"
                params={{ companyId, agentId: node.id, runId: liveRun.runId }}
              >
                <DomainStatus status="running">
                  Live{liveRun.liveCount > 1 ? ` (${liveRun.liveCount})` : ""}
                </DomainStatus>
              </Link>
            ) : null}
            <div className="hidden xl:flex">
              <AgentMetaColumns agent={agent} />
            </div>
            <span className="hidden w-20 justify-end sm:flex">
              <DomainStatus status={node.value.status} />
            </span>
            <div className="hidden sm:flex">
              <AgentActionButtons agent={agent} companyId={companyId} showStatus={false} />
            </div>
            <MembershipAction
              state={membershipState}
              mutation={membershipMutation}
              resourceId={node.id}
              resourceName={node.value.name}
              resourceType="agent"
            />
            <Toggle
              className="hidden sm:inline-flex"
              size="sm"
              pressed={starred}
              disabled={starPending}
              aria-label={`${starred ? "Unstar" : "Star"} ${node.value.name}`}
              onClick={() =>
                membershipMutation.mutate({
                  resourceType: "agent",
                  resourceId: node.id,
                  resourceName: node.value.name,
                  starred: !starred,
                })
              }
            >
              {starPending ? <Spinner /> : <Star data-icon="inline-start" />}
            </Toggle>
          </div>
        );
      }}
    />
  );
}

/** Configuration state shared by the tree and org-chart views. */
export function AgentMetaColumns({ agent }: { agent: Agent }) {
  const configurationLabel = agent.currentAdapterConfigRevisionId ? "Configured" : "Not configured";
  return (
    <div className="w-44 min-w-0 leading-tight">
      <div
        className="truncate font-mono text-(length:--text-micro) text-muted-foreground/70"
        title={configurationLabel}
      >
        {configurationLabel}
      </div>
    </div>
  );
}
