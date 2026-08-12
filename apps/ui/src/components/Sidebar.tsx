import {
  Inbox,
  CircleDot,
  Target,
  LayoutDashboard,
  DollarSign,
  History,
  Search,
  SquarePen,
  Network,
  Repeat,
  Package,
  Settings,
  FolderOpen,
  PanelLeftClose,
  PanelLeftOpen,
  Pin,
  GanttChartSquare,
  ListChecks,
} from "lucide-react";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import { SidebarSection } from "./SidebarSection";
import { SidebarNavItem } from "./SidebarNavItem";
import { SidebarAgents } from "./SidebarAgents";
import { SidebarStarredProjects } from "./SidebarStarredProjects";
import { useDialogActions } from "../context/DialogContext";
import { useSidebar } from "../context/SidebarContext";
import {
  ACTIVE_TASK_EXECUTION_RUN_STATUSES,
  runsApi,
} from "../api/runs";
import { attentionApi } from "../api/attention";
import { attentionBadgeCount } from "../lib/attention";
import { queryKeys } from "../lib/queryKeys";
import { useInboxBadge } from "../hooks/useInboxBadge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SIDEBAR_RAIL_HIDDEN_LABEL } from "../lib/utils";
import { PluginSlotOutlet } from "@/plugins/slots";
import { PluginLauncherOutlet } from "@/plugins/launchers";
import { SidebarCompanyMenu } from "./SidebarCompanyMenu";

export function Sidebar() {
  const companyId = useCompanyRouteId();
  const { openNewTask } = useDialogActions();
  // Every labeled section is collapsible (session-scoped, default open) —
  // one policy across static nav groups and the data-driven sections.
  const [workOpen, setWorkOpen] = useState(true);
  const [companyOpen, setCompanyOpen] = useState(true);
  const { isMobile, collapsed, collapseLocked, peeking, toggleCollapsed, setCollapsed } = useSidebar();
  const rail = collapsed && !peeking;
  const inboxBadge = useInboxBadge(companyId);
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
  const liveRunCount = activeRunPage?.items.length ?? 0;
  const { data: attentionFeed } = useQuery({
    queryKey: queryKeys.attention(companyId),
    queryFn: () => attentionApi.list(companyId),
  });
  const showDecisions =
    attentionFeed?.items.some((item) => item.sourceKind === "mention_board") === true;
  const attentionCount = attentionBadgeCount(attentionFeed);

  const pluginContext = {
    companyId,
  };

  return (
    <aside className="w-full h-full min-h-0 border-r border-border bg-background flex flex-col">
      {/* Top bar: Company name (bold) + Search — aligned with top sections (no visible border) */}
      <div className="flex items-center gap-1 px-3 h-12 shrink-0">
        <SidebarCompanyMenu />
        {/* In the collapsed rail the search/toggle controls don't fit beside the
            logo — keeping them would overflow the 64px rail and squeeze the logo
            out of alignment with the icon column below it (PAP-10676). They return
            as soon as the panel is expanded (pinned) or peeking. Expansion in the
            rail is still reachable via hover-peek + Pin and Cmd/Ctrl+B. */}
        {!rail ? (
          <>
            <Button
              asChild
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground shrink-0"
              aria-label="Open search"
              title="Open search"
            >
              <Link
                to="/$companyId/search"
                params={{ companyId }}
              >
                <Search className="h-4 w-4" />
              </Link>
            </Button>
            {/* Desktop-only collapse/expand affordance. While peeking (hover flyout
                over the collapsed rail) it becomes a Pin that promotes the peek to a
                pinned-expanded sidebar; otherwise it toggles the pinned rail. Mobile
                uses the off-canvas drawer, so this control is hidden there. It is
                also hidden while a secondary sidebar forces the rail (collapseLocked):
                the user cannot expand the primary while a secondary sidebar is shown. */}
            {!isMobile && !collapseLocked ? (
              peeking ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground shrink-0"
                  aria-label="Keep sidebar expanded"
                  title="Keep sidebar expanded"
                  onClick={() => setCollapsed(false)}
                >
                  <Pin className="h-4 w-4" />
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground shrink-0"
                  aria-expanded={!collapsed}
                  aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
                  title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
                  onClick={() => toggleCollapsed()}
                >
                  {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
                </Button>
              )
            ) : null}
          </>
        ) : null}
      </div>

      <nav className="flex-1 min-h-0 overflow-y-auto scrollbar-auto-hide flex flex-col gap-4 pointer-coarse:gap-3 px-3 py-2">
        <div className="flex flex-col gap-0.5">
          {/* New Task button aligned with nav items */}
          {(() => {
            const newTaskButton = (
              <button
                onClick={() => openNewTask()}
                data-slot="icon-button"
                aria-label={rail ? "New Task" : undefined}
                className="flex items-center gap-2.5 mx-2 rounded-lg px-2 py-1.5 pointer-coarse:py-1 text-(length:--text-compact) font-medium text-foreground/80 hover:bg-accent/50 hover:text-foreground transition-colors"
              >
                <SquarePen className="h-4 w-4 shrink-0" />
                <span className={rail ? SIDEBAR_RAIL_HIDDEN_LABEL : "truncate"}>New Task</span>
              </button>
            );
            return rail ? (
              <Tooltip>
                <TooltipTrigger asChild>{newTaskButton}</TooltipTrigger>
                <TooltipContent side="right">New Task</TooltipContent>
              </Tooltip>
            ) : (
              newTaskButton
            );
          })()}
          <SidebarNavItem
            linkOptions={{ to: "/$companyId/dashboard", params: { companyId } }}
            label="Dashboard"
            icon={LayoutDashboard}
            liveCount={liveRunCount}
          />
          <SidebarNavItem
            linkOptions={{ to: "/$companyId/inbox", params: { companyId } }}
            label="Inbox"
            icon={Inbox}
            badge={inboxBadge.inbox}
            badgeLabel="unread"
            badgeTone={inboxBadge.failedRuns > 0 ? "danger" : "default"}
            alert={inboxBadge.failedRuns > 0}
          />
          {showDecisions ? (
            <SidebarNavItem
              linkOptions={{ to: "/$companyId/decisions", params: { companyId } }}
              label="Decisions"
              icon={ListChecks}
              badge={attentionCount}
              badgeLabel="decisions"
            />
          ) : null}
        </div>

        <SidebarSection label="Work" collapsible={{ open: workOpen, onOpenChange: setWorkOpen }}>
          <SidebarNavItem linkOptions={{ to: "/$companyId/tasks", params: { companyId } }} label="Tasks" icon={CircleDot} />
          <SidebarNavItem linkOptions={{ to: "/$companyId/routines", params: { companyId } }} label="Routines" icon={Repeat} />
          <SidebarNavItem linkOptions={{ to: "/$companyId/goals", params: { companyId } }} label="Goals" icon={Target} />
          <SidebarNavItem linkOptions={{ to: "/$companyId/artifacts", params: { companyId } }} label="Artifacts" icon={Package} />
          <SidebarNavItem linkOptions={{ to: "/$companyId/projects", params: { companyId } }} label="Projects" icon={FolderOpen} />
          <SidebarStarredProjects />
          <PluginSlotOutlet
            slotTypes={["sidebar"]}
            context={pluginContext}
            className="flex flex-col gap-0.5"
            itemClassName="text-(length:--text-compact) font-medium"
            missingBehavior="placeholder"
          />
          <PluginLauncherOutlet
            placementZones={["sidebar"]}
            context={pluginContext}
            className="flex flex-col gap-0.5"
            itemClassName="text-(length:--text-compact) font-medium"
          />
        </SidebarSection>

        <SidebarAgents />

        <SidebarSection label="Company" collapsible={{ open: companyOpen, onOpenChange: setCompanyOpen }}>
          <SidebarNavItem linkOptions={{ to: "/$companyId/org", params: { companyId } }} label="Org" icon={Network} />
          <SidebarNavItem linkOptions={{ to: "/$companyId/timeline", params: { companyId } }} label="Timeline" icon={GanttChartSquare} />
          <SidebarNavItem linkOptions={{ to: "/$companyId/costs", params: { companyId } }} label="Costs" icon={DollarSign} />
          <SidebarNavItem linkOptions={{ to: "/$companyId/activity", params: { companyId } }} label="Activity" icon={History} />
          <SidebarNavItem linkOptions={{ to: "/$companyId/company/settings", params: { companyId } }} label="Settings" icon={Settings} />
        </SidebarSection>

        <PluginSlotOutlet
          slotTypes={["sidebarPanel"]}
          context={pluginContext}
          className="flex flex-col gap-3"
          itemClassName="rounded-lg border border-border p-3"
          missingBehavior="placeholder"
        />
      </nav>
    </aside>
  );
}
