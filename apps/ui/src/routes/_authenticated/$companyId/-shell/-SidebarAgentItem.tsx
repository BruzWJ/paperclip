import { Spinner } from "@/components/ui/spinner";
import { DomainStatus } from "@/components/patterns/DomainStatus";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import type { Agent } from "@paperclipai/shared";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, LogOut, MoreHorizontal, PauseCircle, Pencil, PlayCircle, Star } from "lucide-react";
import { cn } from "@/lib/utils";
import { AgentIcon } from "../../../../features/agents/AgentIconPicker";
import { SidebarNavItem } from "./-SidebarNavItem";
import { Toggle } from "@/components/ui/toggle";
import { SidebarMenuItem } from "@/components/ui/sidebar";

export function SidebarAgentItem({
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
  const pauseResumeDisabled =
    disabled || agent.status === "pending_approval" || isBudgetPaused || (isPaused && hasInvalidOrgChain);
  const pauseResumeDisabledLabel = disabled
    ? "Updating..."
    : isBudgetPaused
      ? "Budget paused"
      : isPaused && hasInvalidOrgChain
        ? "Invalid org chain"
        : pauseResumeLabel;
  const trailingLabel =
    [hasInvalidOrgChain ? "Invalid reporting chain" : null].filter(Boolean).join(", ") || undefined;

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
        <AlertTriangle
          className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
          aria-label="Invalid reporting chain"
        />
      </span>
    ) : undefined,
    trailingLabel,
    withinMenuItem: true,
    liveAccessory:
      agent.pauseReason === "budget" ? (
        <DomainStatus status="hard_stop" title="Agent paused by budget">
          <span className="sr-only">Agent paused by budget</span>
        </DomainStatus>
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
  if (rail) return <SidebarMenuItem>{navItem}</SidebarMenuItem>;

  return (
    <SidebarMenuItem className="group/agent flex items-center">
      {navItem}

      {starred && !isMobile && onToggleStar ? (
        // Desktop: quiet inline unstar, left of the ⋯ menu, revealed on hover/focus.
        <span className="absolute right-10 top-1/2 -translate-y-1/2">
          <Toggle
            size="sm"
            pressed
            disabled={starPending}
            aria-label={`Unstar ${agent.name}`}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onToggleStar(agent, false);
            }}
          >
            {starPending ? <Spinner /> : <Star />}
          </Toggle>
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
                  <Spinner className="size-4" />
                ) : (
                  <Star className={cn("size-4", starred && "fill-current")} />
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
            {leaving ? <Spinner className="size-4" /> : <LogOut className="size-4" />}
            <span>{leaving ? "Leaving..." : "Leave agent"}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  );
}
