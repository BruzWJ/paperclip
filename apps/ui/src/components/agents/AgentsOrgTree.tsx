import type { OrgNode } from "@/api/agents";
import { MembershipAction } from "@/components/MembershipAction";
import { Spinner } from "@/components/ui/spinner";
import { Toggle } from "@/components/ui/toggle";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import {
  isStarred,
  resourceMembershipState,
  useResourceMembershipMutation,
  useResourceMemberships,
} from "@/hooks/useResourceMemberships";
import { AGENT_FILTER_TABS } from "@/lib/agent-filter-tabs";
import { statusBadgeVariant } from "@/lib/status-variant";
import { cn } from "@/lib/utils";
import type { Agent } from "@paperclipai/shared";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, Star } from "lucide-react";
import { Badge } from "@/components/ui/badge";

type FilterTab = (typeof AGENT_FILTER_TABS)[number];

export function OrgTreeNode({
  node,
  depth,
  agentMap,
  liveRunByAgent,
  tab,
  memberships,
  membershipMutation,
}: {
  node: OrgNode;
  depth: number;
  agentMap: Map<string, Agent>;
  liveRunByAgent: Map<string, { runId: string; liveCount: number }>;
  tab: FilterTab;
  memberships: ReturnType<typeof useResourceMemberships>["data"];
  membershipMutation: ReturnType<typeof useResourceMembershipMutation>;
}) {
  const companyId = useCompanyRouteId();
  const agent = agentMap.get(node.id);
  if (!agent) return null;
  const hasInvalidOrgChain = Boolean(
    agent && agent.orgChainHealth?.status === "invalid_org_chain",
  );
  const membershipState = resourceMembershipState(
    memberships,
    "agent",
    node.id,
  );
  const pending =
    membershipMutation.isPending &&
    membershipMutation.variables?.resourceType === "agent" &&
    membershipMutation.variables.resourceId === node.id;
  const starPending =
    pending && membershipMutation.variables?.starred !== undefined;
  const joinLeavePending =
    pending && membershipMutation.variables?.starred === undefined;
  const starred = isStarred(memberships, "agent", node.id);

  return (
    <div style={{ paddingLeft: depth * 24 }}>
      <Link
        to="/$companyId/agents/$agentId"
        params={{
          companyId,
          agentId: agent.id,
        }}
        className={cn(
          "group flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-accent/50 transition-colors w-full text-left no-underline text-inherit",
          agent?.pausedAt && tab !== "paused" && "opacity-50",
          membershipState === "left" && "sm:text-foreground/55",
        )}
      >
        {hasInvalidOrgChain ? (
          <AlertTriangle
            className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
            aria-label="Invalid reporting chain"
          />
        ) : (
          <Badge variant={statusBadgeVariant(node.status)}>
            <span className="sr-only">{node.status.replace(/_/g, " ")}</span>
          </Badge>
        )}
        <div className="flex-1 min-w-0 flex flex-wrap items-center gap-2">
          {/* Name floor + `truncate` keeps the primary identifier readable; the
              cluster wraps to a second line under pressure instead of starving
              the name at narrow widths. */}
          <div className="min-w-(--sz-7rem) truncate">
            <span className="text-sm font-medium">{node.name}</span>
            {agent?.title ? (
              <span className="text-xs text-muted-foreground ml-2">
                {agent.title}
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <span className="sm:hidden">
            {liveRunByAgent.has(node.id) ? (
              <Badge asChild variant="secondary">
                <Link
                  to="/$companyId/agents/$agentId/runs/$runId"
                  params={{
                    companyId,
                    agentId: agent.id,
                    runId: liveRunByAgent.get(node.id)!.runId,
                  }}
                  onClick={(event) => event.stopPropagation()}
                >
                  Live
                  {liveRunByAgent.get(node.id)!.liveCount > 1
                    ? ` (${liveRunByAgent.get(node.id)!.liveCount})`
                    : ""}
                </Link>
              </Badge>
            ) : (
              <Badge variant={statusBadgeVariant(node.status)}>
                {node.status.replace(/_/g, " ")}
              </Badge>
            )}
          </span>
          <div className="hidden sm:flex items-center gap-3">
            {liveRunByAgent.has(node.id) && (
              <Badge asChild variant="secondary">
                <Link
                  to="/$companyId/agents/$agentId/runs/$runId"
                  params={{
                    companyId,
                    agentId: agent.id,
                    runId: liveRunByAgent.get(node.id)!.runId,
                  }}
                  onClick={(event) => event.stopPropagation()}
                >
                  Live
                  {liveRunByAgent.get(node.id)!.liveCount > 1
                    ? ` (${liveRunByAgent.get(node.id)!.liveCount})`
                    : ""}
                </Link>
              </Badge>
            )}
            {agent && (
              <div className="hidden xl:flex items-center gap-3">
                <AgentMetaColumns agent={agent} />
              </div>
            )}
            <span className="w-20 flex justify-end">
              <Badge variant={statusBadgeVariant(node.status)}>
                {node.status.replace(/_/g, " ")}
              </Badge>
            </span>
          </div>
          <MembershipAction
            state={membershipState}
            pending={joinLeavePending}
            pendingState={
              joinLeavePending ? membershipMutation.variables?.state : null
            }
            resourceName={node.name}
            onJoin={() =>
              membershipMutation.mutate({
                resourceType: "agent",
                resourceId: node.id,
                resourceName: node.name,
                state: "joined",
              })
            }
            onLeave={() =>
              membershipMutation.mutate({
                resourceType: "agent",
                resourceId: node.id,
                resourceName: node.name,
                state: "left",
              })
            }
          />
          <div className="hidden sm:flex items-center gap-3">
            <Toggle
              size="sm"
              pressed={starred}
              disabled={starPending}
              aria-label={`${starred ? "Unstar" : "Star"} ${node.name}`}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                membershipMutation.mutate({
                  resourceType: "agent",
                  resourceId: node.id,
                  resourceName: node.name,
                  starred: !starred,
                });
              }}
            >
              {starPending ? <Spinner /> : <Star />}
            </Toggle>
          </div>
        </div>
      </Link>
      {node.reports && node.reports.length > 0 && (
        <div className="border-l border-border ml-4">
          {node.reports.map((child) => (
            <OrgTreeNode
              key={child.id}
              node={child}
              depth={depth + 1}
              agentMap={agentMap}
              liveRunByAgent={liveRunByAgent}
              tab={tab}
              memberships={memberships}
              membershipMutation={membershipMutation}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** Configuration state shared by the list and org views. */
export function AgentMetaColumns({ agent }: { agent: Agent }) {
  const configurationLabel = agent.currentAdapterConfigRevisionId
    ? "Configured"
    : "Not configured";
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
