import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import type { Agent } from "@paperclipai/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useMatches } from "@tanstack/react-router";
import { Plus, Users } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { agentsApi } from "../api/agents";
import { authApi } from "../api/auth";
import { ACTIVE_TASK_EXECUTION_RUN_STATUSES, runsApi } from "../api/runs";
import { useDialogActions } from "../context/DialogContext";
import { useSidebar } from "../context/SidebarContext";
import { toast } from "sonner";
import { useAgentOrder } from "../hooks/useAgentOrder";
import {
  isStarred,
  resourceMembershipState,
  starredResourceIds,
  useResourceMembershipMutation,
  useResourceMemberships,
} from "../hooks/useResourceMemberships";
import {
  AGENT_SORT_MODE_UPDATED_EVENT,
  getAgentSortModeStorageKey,
  readAgentSortMode,
  writeAgentSortMode,
  type AgentSidebarSortMode,
} from "../lib/agent-order";
import { queryKeys } from "../lib/queryKeys";
import { SidebarSection } from "./SidebarSection";

import { AGENT_SORT_CHOICES, isAgentSortModeUpdatedDetail, sortAgents } from "./SidebarAgentSort";

import { SidebarAgentItem } from "./SidebarAgentItem";
import { SidebarNavItem } from "./SidebarNavItem";
import { SidebarMenu } from "@/components/ui/sidebar";

/**
 * When no agent has a live run, the sidebar falls back to showing at most this
 * many recently updated agents plus a "See all agents" link (IA Phase 5).
 */
const RECENT_AGENT_LIMIT = 3;

const LIVE_AGENT_LINGER_MS = 120_000;

export function SidebarAgents() {
  const companyId = useCompanyRouteId();
  const [open, setOpen] = useState(true);
  const [pendingAgentIds, setPendingAgentIds] = useState<Set<string>>(() => new Set());
  const [liveLingerVersion, setLiveLingerVersion] = useState(0);
  const lastSeenLiveAtRef = useRef<Map<string, number>>(new Map());
  const queryClient = useQueryClient();
  const { openNewAgent } = useDialogActions();
  const { isMobile, setSidebarOpen, collapsed, peeking } = useSidebar();
  const rail = collapsed && !peeking;
  const activeAgentRoute = useMatches({
    select: (matches) => {
      for (const match of matches) {
        const agentId = Reflect.get(match.params, "agentId");
        if (typeof agentId !== "string") continue;

        const tab = Reflect.get(match.params, "tab");
        const runId = Reflect.get(match.params, "runId");
        return {
          agentId,
          tab: typeof tab === "string" ? tab : typeof runId === "string" ? "runs" : null,
        };
      }
      return null;
    },
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
  });
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const membershipsQuery = useResourceMemberships(companyId);
  const membershipMutation = useResourceMembershipMutation(companyId);

  const activeRunStatuses = ACTIVE_TASK_EXECUTION_RUN_STATUSES;
  const activeRunsQueryKey = queryKeys.runs(companyId, {
    status: activeRunStatuses,
  });
  const { data: activeRunPage } = useQuery({
    queryKey: activeRunsQueryKey,
    queryFn: () =>
      runsApi.listForCompany(companyId, {
        status: activeRunStatuses,
        limit: 200,
      }),
  });

  const liveCountByAgent = useMemo(() => {
    const counts = new Map<string, number>();
    for (const run of activeRunPage?.items ?? []) {
      counts.set(run.targetAgentId, (counts.get(run.targetAgentId) ?? 0) + 1);
    }
    return counts;
  }, [activeRunPage?.items]);
  const liveAgentIds = useMemo(() => {
    const ids = new Set<string>();
    for (const [agentId, count] of liveCountByAgent) {
      if (count > 0) ids.add(agentId);
    }
    return ids;
  }, [liveCountByAgent]);

  const visibleAgents = useMemo(() => {
    const filtered = (agents ?? []).filter(
      (a: Agent) =>
        a.status !== "terminated" &&
        (!membershipsQuery.isSuccess ||
          resourceMembershipState(membershipsQuery.data, "agent", a.id) !== "left"),
    );
    return filtered;
  }, [agents, membershipsQuery.data, membershipsQuery.isSuccess]);
  const currentUserId = session?.user.id ?? null;
  const sortModeStorageKey = useMemo(() => {
    return getAgentSortModeStorageKey(companyId, currentUserId);
  }, [companyId, currentUserId]);
  const [sortMode, setSortMode] = useState<AgentSidebarSortMode>(() => {
    if (!sortModeStorageKey) return "top";
    return readAgentSortMode(sortModeStorageKey);
  });
  const { orderedAgents } = useAgentOrder({
    agents: visibleAgents,
    companyId,
    userId: currentUserId,
  });
  const sortedAgents = useMemo(() => sortAgents(orderedAgents, sortMode), [orderedAgents, sortMode]);
  const sortedAgentIdSet = useMemo(
    () => new Set(sortedAgents.map((agent: Agent) => agent.id)),
    [sortedAgents],
  );

  useEffect(() => {
    const now = Date.now();
    for (const agentId of liveAgentIds) {
      lastSeenLiveAtRef.current.set(agentId, now);
    }
    for (const agentId of lastSeenLiveAtRef.current.keys()) {
      if (!sortedAgentIdSet.has(agentId)) {
        lastSeenLiveAtRef.current.delete(agentId);
      }
    }
  }, [liveAgentIds, sortedAgentIdSet]);

  // If any agent has a live run, show only those agents. Agents whose runs just
  // stopped linger briefly so clustered
  // run boundaries do not make rows pop out and the section does not immediately
  // swap to the recent fallback during short all-idle gaps. Otherwise fall back
  // to up to RECENT_AGENT_LIMIT agents. Either way a "See all agents" link is
  // shown so the full list is always reachable.
  const runningAgents = useMemo(() => {
    const nowForLiveLinger = Date.now();
    const lastSeenLiveAtByAgent = lastSeenLiveAtRef.current;
    return sortedAgents.filter((agent: Agent) => {
      if ((liveCountByAgent.get(agent.id) ?? 0) > 0) return true;
      const lastSeenLiveAt = lastSeenLiveAtByAgent.get(agent.id);
      return lastSeenLiveAt !== undefined && nowForLiveLinger - lastSeenLiveAt <= LIVE_AGENT_LINGER_MS;
    });
  }, [liveCountByAgent, liveLingerVersion, sortedAgents]);
  const hasActiveAgents = runningAgents.length > 0;
  const displayedAgents = hasActiveAgents ? runningAgents : sortedAgents.slice(0, RECENT_AGENT_LIMIT);
  // Always expose "See all agents" whenever the displayed list is a subset of all
  // agents, so users never lose the entry point to the full list.
  const showSeeAllLink = sortedAgents.length > 0;

  const activeAgentId = activeAgentRoute?.agentId ?? null;
  const activeTab = activeAgentRoute?.tab ?? null;

  useEffect(() => {
    if (!sortModeStorageKey) {
      setSortMode("top");
      return;
    }
    setSortMode(readAgentSortMode(sortModeStorageKey));
  }, [sortModeStorageKey]);

  useEffect(() => {
    if (!sortModeStorageKey) return;

    const onStorage = (event: StorageEvent) => {
      if (event.key !== sortModeStorageKey) return;
      setSortMode(readAgentSortMode(sortModeStorageKey));
    };
    const onCustomEvent = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const detail = event.detail;
      if (!isAgentSortModeUpdatedDetail(detail) || detail.storageKey !== sortModeStorageKey) return;
      setSortMode(detail.sortMode);
    };

    window.addEventListener("storage", onStorage);
    window.addEventListener(AGENT_SORT_MODE_UPDATED_EVENT, onCustomEvent);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(AGENT_SORT_MODE_UPDATED_EVENT, onCustomEvent);
    };
  }, [sortModeStorageKey]);

  useEffect(() => {
    const now = Date.now();
    let nextExpiryAt: number | null = null;
    for (const agent of sortedAgents) {
      if ((liveCountByAgent.get(agent.id) ?? 0) > 0) continue;
      const lastSeenLiveAt = lastSeenLiveAtRef.current.get(agent.id);
      if (lastSeenLiveAt === undefined) continue;
      const expiresAt = lastSeenLiveAt + LIVE_AGENT_LINGER_MS;
      if (expiresAt < now) continue;
      nextExpiryAt = nextExpiryAt === null ? expiresAt : Math.min(nextExpiryAt, expiresAt);
    }
    if (nextExpiryAt === null) return;

    const timeoutId = window.setTimeout(
      () => {
        setLiveLingerVersion((version) => version + 1);
      },
      Math.max(0, nextExpiryAt - now + 1),
    );

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [sortedAgents, liveCountByAgent, liveLingerVersion]);

  const persistSortMode = useCallback(
    (value: string) => {
      const nextSortMode: AgentSidebarSortMode =
        value === "alphabetical" || value === "recent" ? value : "top";
      setSortMode(nextSortMode);
      if (sortModeStorageKey) {
        writeAgentSortMode(sortModeStorageKey, nextSortMode);
      }
    },
    [sortModeStorageKey],
  );

  const pauseResumeAgent = useMutation({
    mutationFn: ({ agent, action }: { agent: Agent; action: "pause" | "resume" }) =>
      action === "pause" ? agentsApi.pause(agent.id) : agentsApi.resume(agent.id),
    onMutate: ({ agent }) => {
      setPendingAgentIds((current) => {
        const next = new Set(current);
        next.add(agent.id);
        return next;
      });
    },
    onSuccess: async (_agent, { agent, action }) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.agents.list(companyId),
        }),
        queryClient.invalidateQueries({ queryKey: queryKeys.runs(companyId) }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.dashboard(companyId),
        }),
      ]);
      await queryClient.invalidateQueries({
        queryKey: queryKeys.agents.detail(agent.id),
      });
      toast.success(action === "pause" ? "Agent paused" : "Agent resumed", {
        description: agent.name,
      });
    },
    onError: (error, { agent, action }) => {
      toast.error(action === "pause" ? "Could not pause agent" : "Could not resume agent", {
        description: error instanceof Error ? error.message : agent.name,
      });
    },
    onSettled: (_data, _error, { agent }) => {
      setPendingAgentIds((current) => {
        const next = new Set(current);
        next.delete(agent.id);
        return next;
      });
    },
  });

  const leaveAgent = useCallback(
    (agent: Agent) =>
      membershipMutation.mutate({
        resourceType: "agent",
        resourceId: agent.id,
        resourceName: agent.name,
        state: "left",
      }),
    [membershipMutation],
  );
  const agentLeaving = useCallback(
    (agent: Agent) =>
      membershipMutation.isPending &&
      membershipMutation.variables?.resourceType === "agent" &&
      membershipMutation.variables.resourceId === agent.id,
    [membershipMutation.isPending, membershipMutation.variables],
  );

  const toggleStarAgent = useCallback(
    (agent: Agent, starred: boolean) =>
      membershipMutation.mutate({
        resourceType: "agent",
        resourceId: agent.id,
        resourceName: agent.name,
        starred,
      }),
    [membershipMutation],
  );
  const agentStarPending = useCallback(
    (agent: Agent) =>
      membershipMutation.isPending &&
      membershipMutation.variables?.resourceType === "agent" &&
      membershipMutation.variables.resourceId === agent.id &&
      membershipMutation.variables.starred !== undefined,
    [membershipMutation.isPending, membershipMutation.variables],
  );
  const isPending = pauseResumeAgent.isPending || membershipMutation.isPending;

  // Starred agents pin to the top of the section (name order), and are deduped
  // out of the active/recent subset so no agent appears twice.
  const starredAgentIdSet = useMemo(
    () => new Set(starredResourceIds(membershipsQuery.data, "agent")),
    [membershipsQuery.data],
  );
  const starredAgents = useMemo(
    () =>
      sortAgents(
        visibleAgents.filter((agent: Agent) => starredAgentIdSet.has(agent.id)),
        "alphabetical",
      ),
    [visibleAgents, starredAgentIdSet],
  );
  const dedupedDisplayedAgents = useMemo(
    () => displayedAgents.filter((agent: Agent) => !starredAgentIdSet.has(agent.id)),
    [displayedAgents, starredAgentIdSet],
  );

  const renderAgentRow = (agent: Agent, isStarredRow: boolean) => (
    <SidebarAgentItem
      key={agent.id}
      activeAgentId={activeAgentId}
      activeTab={activeTab}
      agent={agent}
      disabled={pendingAgentIds.has(agent.id)}
      isMobile={isMobile}
      leaving={agentLeaving(agent)}
      onLeaveAgent={leaveAgent}
      onPauseResume={(targetAgent, action) => pauseResumeAgent.mutate({ agent: targetAgent, action })}
      rail={rail}
      runCount={liveCountByAgent.get(agent.id) ?? 0}
      setSidebarOpen={setSidebarOpen}
      starred={isStarredRow || isStarred(membershipsQuery.data, "agent", agent.id)}
      onToggleStar={toggleStarAgent}
      starPending={agentStarPending(agent)}
    />
  );

  return (
    <SidebarSection
      label="Agents"
      collapsible={{ open, onOpenChange: setOpen }}
      headerAction={{
        ariaLabel: "New agent",
        icon: Plus,
        onClick: openNewAgent,
      }}
      menu={{
        ariaLabel: "Agents section actions",
        actions: [
          {
            type: "item",
            label: "Browse agents",
            icon: Users,
            renderLink: (content) => (
              <Link to="/$companyId/agents" params={{ companyId }}>
                {content}
              </Link>
            ),
          },
          { type: "separator" },
        ],
        radioLabel: "Agent sort",
        radioChoices: AGENT_SORT_CHOICES,
        radioValue: sortMode,
        onRadioValueChange: persistSortMode,
      }}
    >
      {isPending ? (
        <p
          aria-live="polite"
          role="status"
          className="mx-2 px-2 py-1 text-(length:--text-micro) text-muted-foreground"
        >
          {pauseResumeAgent.isPending ? "Updating agent…" : "Updating agent membership…"}
        </p>
      ) : null}
      <SidebarMenu>
        {starredAgents.map((agent: Agent) => renderAgentRow(agent, true))}
        {dedupedDisplayedAgents.map((agent: Agent) => renderAgentRow(agent, false))}
        {showSeeAllLink ? (
          <SidebarNavItem
            linkOptions={{ to: "/$companyId/agents", params: { companyId } }}
            label="See all agents"
            icon={Users}
            className="text-muted-foreground"
          />
        ) : null}
      </SidebarMenu>
    </SidebarSection>
  );
}

export * from "./SidebarAgentItem";
export * from "./SidebarAgentSort";
