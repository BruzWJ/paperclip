import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useMatches } from "@tanstack/react-router";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  MoreHorizontal,
  Loader2,
  LogOut,
  PauseCircle,
  Pencil,
  PlayCircle,
  Plus,
  Star,
  Users,
  AlertTriangle,
} from "lucide-react";
import { useDialogActions } from "../context/DialogContext";
import { useSidebar } from "../context/SidebarContext";
import { useToastActions } from "../context/ToastContext";
import { agentsApi } from "../api/agents";
import { authApi } from "../api/auth";
import {
  ACTIVE_TASK_EXECUTION_RUN_STATUSES,
  runsApi,
} from "../api/runs";
import { SIDEBAR_SCROLL_RESET_STATE } from "../lib/navigation-scroll";
import { queryKeys } from "../lib/queryKeys";
import { cn, SIDEBAR_RAIL_HIDDEN_LABEL } from "../lib/utils";
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
  type AgentSortModeUpdatedDetail,
  type AgentSidebarSortMode,
  writeAgentSortMode,
} from "../lib/agent-order";
import { AgentIcon } from "./AgentIconPicker";
import { BudgetSidebarMarker } from "./BudgetSidebarMarker";
import { SidebarNavItem } from "./SidebarNavItem";
import { SidebarSection, type SidebarSectionRadioChoice } from "./SidebarSection";
import { StarToggle } from "./StarToggle";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Agent } from "@paperclipai/shared";

/**
 * When no agent has a live run, the sidebar falls back to showing at most this
 * many recently updated agents plus a "See all agents" link (IA Phase 5).
 */
const RECENT_AGENT_LIMIT = 3;
const LIVE_AGENT_LINGER_MS = 120_000;

const AGENT_SORT_CHOICES: SidebarSectionRadioChoice[] = [
  { value: "top", label: "Top" },
  { value: "alphabetical", label: "Alphabetical" },
  { value: "recent", label: "Recent" },
];

function isAgentSortModeUpdatedDetail(value: unknown): value is AgentSortModeUpdatedDetail {
  if (typeof value !== "object" || value === null) return false;
  const storageKey = Reflect.get(value, "storageKey");
  const sortMode = Reflect.get(value, "sortMode");
  return (
    typeof storageKey === "string" &&
    (sortMode === "top" || sortMode === "alphabetical" || sortMode === "recent")
  );
}

function agentTimestamp(agent: Agent, field: "updatedAt" | "createdAt"): number {
  const raw = agent[field];
  if (!raw) return 0;
  const time = new Date(raw).getTime();
  return Number.isFinite(time) ? time : 0;
}

function sortAgents(agents: Agent[], sortMode: AgentSidebarSortMode): Agent[] {
  if (sortMode === "top") return agents;
  const sorted = [...agents];
  if (sortMode === "alphabetical") {
    sorted.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
    return sorted;
  }
  sorted.sort((left, right) => {
    const updatedDiff = agentTimestamp(right, "updatedAt") - agentTimestamp(left, "updatedAt");
    if (updatedDiff !== 0) return updatedDiff;

    const createdDiff = agentTimestamp(right, "createdAt") - agentTimestamp(left, "createdAt");
    return createdDiff !== 0
      ? createdDiff
      : left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
  });
  return sorted;
}

// Sidebar star reveals with the agent row's own group, not the shared group.
const AGENT_STAR_ROW_REVEAL =
  "opacity-0 transition-opacity group-hover/agent:opacity-100 group-focus-within/agent:opacity-100";

function SidebarAgentItem({
  activeAgentId,
  activeTab,
  agent,
  disabled,
  isMobile,
  leaving,
  onLeaveAgent,
  onPauseResume,
  rail,
  runCount,
  setSidebarOpen,
  starred = false,
  onToggleStar,
  starPending = false,
}: {
  activeAgentId: string | null;
  activeTab: string | null;
  agent: Agent;
  disabled: boolean;
  isMobile: boolean;
  leaving: boolean;
  onLeaveAgent: (agent: Agent) => void;
  onPauseResume: (agent: Agent, action: "pause" | "resume") => void;
  rail: boolean;
  runCount: number;
  setSidebarOpen: (open: boolean) => void;
  starred?: boolean;
  onToggleStar?: (agent: Agent, starred: boolean) => void;
  starPending?: boolean;
}) {
  const companyId = useCompanyRouteId();
  const agentId = agent.id;
  const isActive = activeAgentId === agentId;
  const isPaused = agent.status === "paused";
  const isBudgetPaused = isPaused && agent.pauseReason === "budget";
  const hasInvalidOrgChain = agent.orgChainHealth?.status === "invalid_org_chain";
  const pauseResumeLabel = isPaused ? "Resume agent" : "Pause agent";
  const pauseResumeDisabled = disabled || agent.status === "pending_approval" || isBudgetPaused || (isPaused && hasInvalidOrgChain);
  const pauseResumeDisabledLabel = disabled
    ? "Updating..."
    : isBudgetPaused
      ? "Budget paused"
      : isPaused && hasInvalidOrgChain
        ? "Invalid org chain"
      : pauseResumeLabel;
  const trailingLabel = [
    hasInvalidOrgChain ? "Invalid reporting chain" : null,
  ].filter(Boolean).join(", ") || undefined;

  // C11 (DECISION-SHEET.md): the row itself is a SidebarNavItem, so agent rows
  // share the nav-row chrome (type, active state, rail tooltip, live dot).
  const navItemProps = {
    label: agent.name,
    iconNode: <AgentIcon icon={agent.icon} className="shrink-0 h-4 w-4" />,
    active: isActive,
    liveCount: runCount,
    className: cn(
      "min-w-0 flex-1",
      // Reserve room for the hover ⋯ menu; starred rows widen it for the
      // inline unstar star.
      starred && !isMobile ? "pr-14" : "pr-8",
    ),
    trailing: hasInvalidOrgChain ? (
      <span className="ml-1 flex shrink-0 items-center gap-1">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" aria-label="Invalid reporting chain" />
      </span>
    ) : undefined,
    trailingLabel,
    liveAccessory:
      agent.pauseReason === "budget" ? (
        <BudgetSidebarMarker title="Agent paused by budget" />
      ) : undefined,
  };
  const navItem = activeTab ? (
    <SidebarNavItem
      {...navItemProps}
      linkOptions={{
        to: "/$companyId/agents/$agentId/$tab",
        params: { companyId, agentId, tab: activeTab },
      }}
    />
  ) : (
    <SidebarNavItem
      {...navItemProps}
      linkOptions={{
        to: "/$companyId/agents/$agentId",
        params: { companyId, agentId },
      }}
    />
  );

  // Rail: the star/menu overlays are hidden, so render the nav item bare (it
  // supplies its own rail tooltip) and let it fill the column like every other
  // rail row.
  if (rail) return navItem;

  return (
    <div className="group/agent relative flex items-center">
      {navItem}

      {starred && !isMobile && onToggleStar ? (
        // Desktop: quiet inline unstar, left of the ⋯ menu, revealed on hover/focus.
        <span className="absolute right-10 top-1/2 -translate-y-1/2">
          <StarToggle
            size="row"
            quiet
            starred
            pending={starPending}
            resourceName={agent.name}
            onToggle={() => onToggleStar(agent, false)}
            revealClassName={AGENT_STAR_ROW_REVEAL}
          />
        </span>
      ) : null}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            className={cn(
              "absolute right-3 top-1/2 h-6 w-6 -translate-y-1/2 transition-opacity data-[state=open]:pointer-events-auto data-[state=open]:opacity-100",
              isMobile
                ? "opacity-100"
                : "pointer-events-none opacity-0 group-hover/agent:pointer-events-auto group-hover/agent:opacity-100 group-focus-within/agent:pointer-events-auto group-focus-within/agent:opacity-100",
            )}
            aria-label={`Open actions for ${agent.name}`}
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          {onToggleStar ? (
            <>
              <DropdownMenuItem
                onClick={() => {
                  if (starPending) return;
                  onToggleStar(agent, !starred);
                }}
                disabled={starPending}
              >
                {starPending ? (
                  <Loader2 className="size-4 motion-safe:animate-spin" />
                ) : (
                  <Star className={cn("size-4", starred && "fill-amber-500 text-amber-500")} />
                )}
                <span>{starred ? "Remove from starred" : "Star agent"}</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          ) : null}
          <DropdownMenuItem asChild>
            <Link
              to="/$companyId/agents/$agentId/$tab"
              params={{
                companyId,
                agentId,
                tab: "configuration",
              }}
              onClick={() => {
                if (isMobile) setSidebarOpen(false);
              }}
            >
              <Pencil className="size-4" />
              <span>Edit agent</span>
            </Link>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => {
              if (pauseResumeDisabled) return;
              onPauseResume(agent, isPaused ? "resume" : "pause");
            }}
            disabled={pauseResumeDisabled}
            title={isBudgetPaused ? "Agent was paused by budget limits" : undefined}
          >
            {isPaused ? <PlayCircle className="size-4" /> : <PauseCircle className="size-4" />}
            <span>{pauseResumeDisabledLabel}</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => {
              if (leaving) return;
              onLeaveAgent(agent);
            }}
            disabled={leaving}
          >
            {leaving ? <Loader2 className="size-4 motion-safe:animate-spin" /> : <LogOut className="size-4" />}
            <span>{leaving ? "Leaving..." : "Leave agent"}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

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
  const { pushToast } = useToastActions();
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
    queryFn: () => runsApi.listForCompany(companyId, {
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
        (
          !membershipsQuery.isSuccess ||
          resourceMembershipState(membershipsQuery.data, "agent", a.id) !== "left"
        )
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
  const sortedAgents = useMemo(
    () => sortAgents(orderedAgents, sortMode),
    [orderedAgents, sortMode],
  );
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
  const displayedAgents = hasActiveAgents
    ? runningAgents
    : sortedAgents.slice(0, RECENT_AGENT_LIMIT);
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

    const timeoutId = window.setTimeout(() => {
      setLiveLingerVersion((version) => version + 1);
    }, Math.max(0, nextExpiryAt - now + 1));

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
      action === "pause"
        ? agentsApi.pause(agent.id)
        : agentsApi.resume(agent.id),
    onMutate: ({ agent }) => {
      setPendingAgentIds((current) => {
        const next = new Set(current);
        next.add(agent.id);
        return next;
      });
    },
    onSuccess: async (_agent, { agent, action }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.runs(companyId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(companyId) }),
      ]);
      await queryClient.invalidateQueries({
        queryKey: queryKeys.agents.detail(agent.id),
      });
      pushToast({
        title: action === "pause" ? "Agent paused" : "Agent resumed",
        body: agent.name,
        tone: "success",
      });
    },
    onError: (error, { agent, action }) => {
      pushToast({
        title: action === "pause" ? "Could not pause agent" : "Could not resume agent",
        body: error instanceof Error ? error.message : agent.name,
        tone: "error",
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
    (agent: Agent) => membershipMutation.mutate({
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
    (agent: Agent, starred: boolean) => membershipMutation.mutate({
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
    () => sortAgents(visibleAgents.filter((agent: Agent) => starredAgentIdSet.has(agent.id)), "alphabetical"),
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
              <Link
                to="/$companyId/agents"
                params={{ companyId }}
              >
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
          {pauseResumeAgent.isPending
            ? "Updating agent…"
            : "Updating agent membership…"}
        </p>
      ) : null}
      {starredAgents.map((agent: Agent) => renderAgentRow(agent, true))}
      {dedupedDisplayedAgents.map((agent: Agent) => renderAgentRow(agent, false))}
      {showSeeAllLink && (() => {
        // Deliberately NOT a SidebarNavItem: this is a quiet muted affordance
        // (plain Link) that must not adopt nav-row active-route highlighting.
        const seeAllLink = (
          <Link
            to="/$companyId/agents"
            params={{ companyId }}
            state={SIDEBAR_SCROLL_RESET_STATE}
            aria-label={rail ? "See all agents" : undefined}
            onClick={() => {
              if (isMobile) setSidebarOpen(false);
            }}
            className="flex items-center gap-2.5 mx-2 rounded-lg px-2 py-1.5 pointer-coarse:py-1 text-(length:--text-compact) font-medium text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
          >
            <Users className="shrink-0 h-4 w-4" />
            <span className={rail ? SIDEBAR_RAIL_HIDDEN_LABEL : undefined}>See all agents</span>
          </Link>
        );
        return rail ? (
          <Tooltip>
            <TooltipTrigger asChild>{seeAllLink}</TooltipTrigger>
            <TooltipContent side="right">See all agents</TooltipContent>
          </Tooltip>
        ) : (
          seeAllLink
        );
      })()}
    </SidebarSection>
  );
}
