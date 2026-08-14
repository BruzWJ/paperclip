import { agentsApi, type OrgNode } from "@/api/agents";
import { ACTIVE_TASK_EXECUTION_RUN_STATUSES, runsApi } from "@/api/runs";
import { AgentActionButtons } from "@/components/AgentActionButtons";
import { MembershipAction } from "@/components/MembershipAction";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Toggle } from "@/components/ui/toggle";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useDialogActions } from "@/context/DialogContext";
import { useSidebar } from "@/context/SidebarContext";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import {
  isStarred,
  resourceMembershipState,
  useResourceMembershipMutation,
  useResourceMemberships,
} from "@/hooks/useResourceMemberships";
import type { AgentFilterTab, AgentLiveRunSummary } from "@/lib/agent-filter-tabs";
import { indexEntitiesById } from "@/lib/presentation-contracts";
import { queryKeys } from "@/lib/queryKeys";
import { DomainStatus } from "@/components/patterns/DomainStatus";
import { cn } from "@/lib/utils";
import { type Agent } from "@paperclipai/shared";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { AlertTriangle, Bot, GitBranch, List, Plus, Star } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { AgentMetaColumns, AgentsOrgTree } from "@/components/agents/AgentsOrgTree";

const AGENT_FILTER_TAB_ITEMS: { value: AgentFilterTab; label: string }[] = [
  { value: "all", label: "All" },
  { value: "idle", label: "Idle" },
  { value: "paused", label: "Paused" },
  { value: "error", label: "Error" },
];

// Agents in these states never appear in the agents list — `terminated` is
// hidden like an archived company, and `pending_approval` is a hiring gate that
// lives in the task thread, not an agent run state (PAP-75).
const HIDDEN_AGENT_STATUSES = new Set(["terminated", "pending_approval"]);

function matchesFilter(status: string, tab: AgentFilterTab): boolean {
  if (tab === "all") return true;
  if (tab === "idle") return status === "idle";
  if (tab === "paused") return status === "paused";
  if (tab === "error") return status === "error";
  return true;
}

function filterAgents(agents: Agent[], tab: AgentFilterTab): Agent[] {
  return agents
    .filter((a) => {
      if (HIDDEN_AGENT_STATUSES.has(a.status)) return false;
      return matchesFilter(a.status, tab);
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function filterOrgTree(nodes: OrgNode[], tab: AgentFilterTab): OrgNode[] {
  return nodes
    .reduce<OrgNode[]>((acc, node) => {
      const filteredReports = filterOrgTree(node.reports, tab);
      // Hidden agents (terminated / pending_approval) never render as a row, but
      // any visible reports are promoted so the tree doesn't lose live agents.
      if (HIDDEN_AGENT_STATUSES.has(node.status)) {
        acc.push(...filteredReports);
        return acc;
      }
      const nodeMatches = matchesFilter(node.status, tab);
      if (nodeMatches || filteredReports.length > 0) {
        acc.push({ ...node, reports: filteredReports });
      }
      return acc;
    }, [])
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function AgentsScreen({ tab }: { tab: AgentFilterTab }) {
  const companyId = useCompanyRouteId();
  const { openNewAgent } = useDialogActions();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const { isMobile } = useSidebar();
  const [view, setView] = useState<"list" | "org">("org");
  const forceListView = isMobile;
  const effectiveView: "list" | "org" = forceListView ? "list" : view;

  const visibleTabItems = AGENT_FILTER_TAB_ITEMS;

  const {
    data: agents,
    isLoading,
    error,
  } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
  });

  const { data: orgTree } = useQuery({
    queryKey: queryKeys.org(companyId),
    queryFn: () => agentsApi.org(companyId),
    enabled: effectiveView === "org",
  });

  const activeRunStatuses = ACTIVE_TASK_EXECUTION_RUN_STATUSES;
  const runsQueryKey = [...queryKeys.runs(companyId, { status: activeRunStatuses }), "agents-page"] as const;
  const { data: runPage } = useQuery({
    queryKey: runsQueryKey,
    queryFn: () =>
      runsApi.listForCompany(companyId, {
        status: activeRunStatuses,
        limit: 200,
      }),
  });
  const membershipsQuery = useResourceMemberships(companyId);
  const membershipMutation = useResourceMembershipMutation(companyId);

  function handleFilterChange(value: string) {
    if (value === "all") {
      void navigate({
        to: "/$companyId/agents",
        params: { companyId },
      });
    } else if (value === "idle") {
      void navigate({
        to: "/$companyId/agents/idle",
        params: { companyId },
      });
    } else if (value === "paused") {
      void navigate({
        to: "/$companyId/agents/paused",
        params: { companyId },
      });
    } else if (value === "error") {
      void navigate({
        to: "/$companyId/agents/error",
        params: { companyId },
      });
    }
  }

  // Map agentId -> first live run + live run count
  const liveRunByAgent = useMemo(() => {
    const map = new Map<string, AgentLiveRunSummary>();
    for (const r of runPage?.items ?? []) {
      const existing = map.get(r.targetAgentId);
      if (existing) {
        existing.liveCount += 1;
        continue;
      }
      map.set(r.targetAgentId, { runId: r.id, liveCount: 1 });
    }
    return map;
  }, [runPage?.items]);

  const agentMap = useMemo(() => indexEntitiesById(agents), [agents]);

  useEffect(() => {
    setBreadcrumbs([{ label: "Agents" }]);
  }, [setBreadcrumbs]);

  if (isLoading) {
    return <Skeleton className="h-32 w-full" />;
  }

  const filtered = filterAgents(agents ?? [], tab);
  const filteredOrg = filterOrgTree(orgTree ?? [], tab);
  const renderAgentRow = (agent: Agent) => {
    const hasInvalidOrgChain = agent.orgChainHealth?.status === "invalid_org_chain";
    const agentPending =
      membershipMutation.isPending &&
      membershipMutation.variables?.resourceType === "agent" &&
      membershipMutation.variables.resourceId === agent.id;
    const agentStarPending = agentPending && membershipMutation.variables?.starred !== undefined;
    const agentStarred = isStarred(membershipsQuery.data, "agent", agent.id);
    return (
      <Item
        key={agent.id}
        size="sm"
        className={cn(
          agent.pausedAt && tab !== "paused" ? "opacity-50" : "",
          resourceMembershipState(membershipsQuery.data, "agent", agent.id) === "left"
            ? "sm:text-foreground/55"
            : "",
        )}
      >
        <ItemMedia>
          {hasInvalidOrgChain ? (
            <AlertTriangle
              className="h-3.5 w-3.5 text-muted-foreground"
              aria-label="Invalid reporting chain"
            />
          ) : (
            <DomainStatus status={agent.status} />
          )}
        </ItemMedia>
        <ItemContent className="min-w-0">
          <Link
            to="/$companyId/agents/$agentId"
            params={{ companyId, agentId: agent.id }}
            className="min-w-0 no-underline"
          >
            <ItemTitle>{agent.name}</ItemTitle>
            {agent.title || agent.capabilities ? (
              <ItemDescription>{agent.title ?? agent.capabilities}</ItemDescription>
            ) : null}
          </Link>
        </ItemContent>
        <div className="hidden xl:flex">
          <AgentMetaColumns agent={agent} />
        </div>
        <ItemActions>
          <div className="flex items-center gap-3">
            <div className="hidden sm:flex items-center gap-3">
              {liveRunByAgent.has(agent.id) && (
                <Link
                  to="/$companyId/agents/$agentId/runs/$runId"
                  params={{
                    companyId,
                    agentId: agent.id,
                    runId: liveRunByAgent.get(agent.id)!.runId,
                  }}
                  onClick={(event) => event.stopPropagation()}
                >
                  <DomainStatus status="running">
                    Live
                    {liveRunByAgent.get(agent.id)!.liveCount > 1
                      ? ` (${liveRunByAgent.get(agent.id)!.liveCount})`
                      : ""}
                  </DomainStatus>
                </Link>
              )}
              <span className="w-20 flex justify-end">
                <DomainStatus status={agent.status} />
              </span>
              <div>
                <AgentActionButtons agent={agent} companyId={companyId} showStatus={false} />
              </div>
              <Toggle
                size="sm"
                pressed={agentStarred}
                disabled={agentStarPending}
                aria-label={`${agentStarred ? "Unstar" : "Star"} ${agent.name}`}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  membershipMutation.mutate({
                    resourceType: "agent",
                    resourceId: agent.id,
                    resourceName: agent.name,
                    starred: !agentStarred,
                  });
                }}
              >
                {agentStarPending ? <Spinner /> : <Star />}
              </Toggle>
            </div>
            <MembershipAction
              state={resourceMembershipState(membershipsQuery.data, "agent", agent.id)}
              mutation={membershipMutation}
              resourceId={agent.id}
              resourceName={agent.name}
              resourceType="agent"
            />
          </div>
        </ItemActions>
      </Item>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        {isMobile ? (
          <Select value={tab} onValueChange={handleFilterChange}>
            <SelectTrigger className="h-9" aria-label="Page section">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {visibleTabItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Tabs value={tab} onValueChange={handleFilterChange}>
            <TabsList variant="line">
              {visibleTabItems.map((item) => (
                <TabsTrigger key={item.value} value={item.value}>
                  {item.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        )}
        <div className="flex items-center gap-2">
          {/* View toggle */}
          {!forceListView && (
            <ToggleGroup
              type="single"
              value={effectiveView}
              onValueChange={(value) => {
                if (value) setView(value as "list" | "org");
              }}
              variant="outline"
              size="sm"
              aria-label="View mode"
            >
              <ToggleGroupItem value="list" className="px-1.5" title="List view" aria-label="List view">
                <List className="h-3.5 w-3.5" />
              </ToggleGroupItem>
              <ToggleGroupItem
                value="org"
                className="px-1.5"
                title="Org chart view"
                aria-label="Org chart view"
              >
                <GitBranch className="h-3.5 w-3.5" />
              </ToggleGroupItem>
            </ToggleGroup>
          )}
          <Button size="sm" variant="outline" onClick={openNewAgent}>
            <Plus data-icon="inline-start" className="h-3.5 w-3.5 mr-1.5" />
            New Agent
          </Button>
        </div>
      </div>

      {filtered.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {filtered.length} agent{filtered.length !== 1 ? "s" : ""}
        </p>
      )}

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      )}

      {agents && agents.length === 0 && (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Bot />
            </EmptyMedia>
            <EmptyTitle>Create your first agent to get started.</EmptyTitle>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={openNewAgent}>
              <Plus />
              New Agent
            </Button>
          </EmptyContent>
        </Empty>
      )}

      {/* List view */}
      {effectiveView === "list" && filtered.length > 0 && (
        <ItemGroup>{filtered.map(renderAgentRow)}</ItemGroup>
      )}

      {effectiveView === "list" && agents && agents.length > 0 && filtered.length === 0 && (
        <Empty className="border-0 py-8 md:py-8">
          <EmptyDescription>No agents match the selected status.</EmptyDescription>
        </Empty>
      )}

      {/* Org chart view */}
      {effectiveView === "org" && filteredOrg.length > 0 && (
        <AgentsOrgTree
          key={tab}
          nodes={filteredOrg}
          agentMap={agentMap}
          liveRunByAgent={liveRunByAgent}
          tab={tab}
          memberships={membershipsQuery.data}
          membershipMutation={membershipMutation}
        />
      )}

      {effectiveView === "org" && orgTree && orgTree.length > 0 && filteredOrg.length === 0 && (
        <Empty className="border-0 py-8 md:py-8">
          <EmptyDescription>No agents match the selected status.</EmptyDescription>
        </Empty>
      )}

      {effectiveView === "org" && orgTree && orgTree.length === 0 && (
        <Empty className="border-0 py-8 md:py-8">
          <EmptyDescription>No organizational hierarchy defined.</EmptyDescription>
        </Empty>
      )}
    </div>
  );
}
