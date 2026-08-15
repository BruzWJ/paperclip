import { agentsApi, type OrgNode } from "@/api/agents";
import { ACTIVE_TASK_EXECUTION_RUN_STATUSES, runsApi } from "@/api/runs";
import { Skeleton } from "@/components/ui/skeleton";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useDialogActions } from "@/context/DialogContext";
import { useSidebar } from "@/context/SidebarContext";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import { useResourceMembershipMutation, useResourceMemberships } from "@/hooks/useResourceMemberships";
import type { AgentFilterTab, AgentLiveRunSummary } from "@/lib/agent-filter-tabs";
import { indexEntitiesById } from "@/lib/presentation-contracts";
import { queryKeys } from "@/lib/queryKeys";
import { type Agent } from "@paperclipai/shared";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Bot, GitBranch, List, Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { AgentsOrgChart } from "@/routes/_authenticated/$companyId/agents/-AgentsOrgChart";
import { AgentsOrgTree } from "@/routes/_authenticated/$companyId/agents/-AgentsOrgTree";

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
  const [view, setView] = useState<"tree" | "chart">("chart");

  const visibleTabItems = AGENT_FILTER_TAB_ITEMS;

  const {
    data: agents,
    isLoading,
    error,
  } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
  });

  const { data: orgTree, isLoading: isOrgLoading } = useQuery({
    queryKey: queryKeys.org(companyId),
    queryFn: () => agentsApi.org(companyId),
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

  const agentMap = useMemo(() => indexEntitiesById(agents), [agents]);
  const liveRunByAgent = useMemo(() => {
    const map = new Map<string, AgentLiveRunSummary>();
    for (const run of runPage?.items ?? []) {
      const existing = map.get(run.targetAgentId);
      if (existing) {
        existing.liveCount += 1;
        continue;
      }
      map.set(run.targetAgentId, { runId: run.id, liveCount: 1 });
    }
    return map;
  }, [runPage?.items]);

  useEffect(() => {
    setBreadcrumbs([{ label: "Agents" }]);
  }, [setBreadcrumbs]);

  if (isLoading || isOrgLoading) {
    return <Skeleton className="h-32 w-full" />;
  }

  const filtered = filterAgents(agents ?? [], tab);
  const filteredOrg = filterOrgTree(orgTree ?? [], tab);

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
          <ToggleGroup
            type="single"
            value={view}
            onValueChange={(value) => {
              if (value) setView(value as "tree" | "chart");
            }}
            variant="outline"
            size="sm"
            aria-label="Agent view"
          >
            <ToggleGroupItem value="tree" className="px-1.5" title="Tree view" aria-label="Tree view">
              <List className="h-3.5 w-3.5" data-icon="inline-start" />
            </ToggleGroupItem>
            <ToggleGroupItem value="chart" className="px-1.5" title="Org chart view" aria-label="Org chart view">
              <GitBranch className="h-3.5 w-3.5" data-icon="inline-start" />
            </ToggleGroupItem>
          </ToggleGroup>
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
              <Bot  data-icon="inline-start"/>
            </EmptyMedia>
            <EmptyTitle>Create your first agent to get started.</EmptyTitle>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={openNewAgent}>
              <Plus  data-icon="inline-start"/>
              New Agent
            </Button>
          </EmptyContent>
        </Empty>
      )}

      {view === "tree" && filteredOrg.length > 0 && (
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

      {view === "chart" && filteredOrg.length > 0 && (
        <AgentsOrgChart
          key={tab}
          nodes={filteredOrg}
          agentMap={agentMap}
        />
      )}

      {orgTree && orgTree.length > 0 && filteredOrg.length === 0 && (
        <Empty className="border-0 py-8 md:py-8">
          <EmptyDescription>No agents match the selected status.</EmptyDescription>
        </Empty>
      )}

      {orgTree && orgTree.length === 0 && (
        <Empty className="border-0 py-8 md:py-8">
          <EmptyDescription>No organizational hierarchy defined.</EmptyDescription>
        </Empty>
      )}
    </div>
  );
}
