import type { ReactNode } from "react";
import { MoreHorizontal, Play } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import { AgentIcon } from "@/features/agents/AgentIconPicker";
import { Badge } from "@/components/ui/badge";
import { DomainStatus } from "@/components/patterns/DomainStatus";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { Item, ItemActions } from "@/components/ui/item";
import { cn } from "@/lib/utils";
import type { NamedAgentSummary } from "@/lib/presentation-contracts";

export type RoutineListProjectSummary = {
  name: string;
  color?: string | null;
};

export type RoutineListRowItem = {
  id: string;
  title: string;
  status: string;
  projectId: string | null;
  assigneeAgentId: string | null;
  lastRun?: {
    triggeredAt?: Date | string | null;
    status?: string | null;
  } | null;
};

export function formatLastRunTimestamp(value: Date | string | null | undefined) {
  if (!value) return "Never";
  return new Date(value).toLocaleString();
}

export function formatRoutineRunStatus(value: string | null | undefined) {
  if (!value) return null;
  return value.replaceAll("_", " ");
}

export function nextRoutineStatus(currentStatus: string, enabled: boolean) {
  if (currentStatus === "archived" && enabled) return "active";
  return enabled ? "active" : "paused";
}

function RoutineLink({
  routeId,
  className,
  children,
}: {
  routeId: string | null;
  className?: string;
  children: ReactNode;
}) {
  const companyId = useCompanyRouteId();
  if (routeId) {
    return (
      <Link
        to="/$companyId/routines/$routineId"
        params={{ companyId, routineId: routeId }}
        className={className}
      >
        {children}
      </Link>
    );
  }
  return (
    <Link to="/$companyId/routines" params={{ companyId }} className={className}>
      {children}
    </Link>
  );
}

export function RoutineListRow<TRoutine extends RoutineListRowItem>({
  routine,
  projectById,
  agentById,
  runningRoutineId,
  statusMutationRoutineId,
  routineRouteId,
  configureLabel = "Edit",
  managedByLabel,
  secondaryDetails,
  runNowButton = false,
  disableRunNow = false,
  disableToggle = false,
  hideArchiveAction = false,
  divider = true,
  selected = false,
  selectMode = false,
  extraMenuItems,
  onSelectChange,
  onRunNow,
  onToggleEnabled,
  onToggleArchived,
}: {
  routine: TRoutine;
  projectById: Map<string, RoutineListProjectSummary>;
  agentById: Map<string, NamedAgentSummary>;
  runningRoutineId: string | null;
  statusMutationRoutineId: string | null;
  /** Canonical routine route id. `null` links to the routines index; omitted uses `routine.id`. */
  routineRouteId?: string | null;
  configureLabel?: string;
  managedByLabel?: string | null;
  secondaryDetails?: ReactNode;
  runNowButton?: boolean;
  disableRunNow?: boolean;
  disableToggle?: boolean;
  hideArchiveAction?: boolean;
  /** Render a bottom divider between consecutive rows. Off when the group is its own card. */
  divider?: boolean;
  selected?: boolean;
  selectMode?: boolean;
  extraMenuItems?: ReactNode;
  onSelectChange?: (routine: TRoutine, selected: boolean) => void;
  onRunNow: (routine: TRoutine) => void;
  onToggleEnabled: (routine: TRoutine, enabled: boolean) => void;
  onToggleArchived?: (routine: TRoutine) => void;
}) {
  const routeId = routineRouteId === undefined ? routine.id : routineRouteId;
  const enabled = routine.status === "active";
  const isArchived = routine.status === "archived";
  const isStatusPending = statusMutationRoutineId === routine.id;
  const project = routine.projectId ? (projectById.get(routine.projectId) ?? null) : null;
  const agent = routine.assigneeAgentId ? (agentById.get(routine.assigneeAgentId) ?? null) : null;
  const isDraft = !isArchived && !routine.assigneeAgentId;
  const runDisabled = runningRoutineId === routine.id || isArchived || disableRunNow;

  return (
    <Item
      className={cn(
        "group items-start sm:flex-nowrap sm:items-center",
        divider && "rounded-none border-b last:border-b-0",
      )}
    >
      {selectMode ? (
        <Checkbox
          checked={selected}
          aria-label={`Select ${routine.title}`}
          onCheckedChange={(checked) => onSelectChange?.(routine, checked === true)}
        />
      ) : null}
      <RoutineLink routeId={routeId} className="min-w-0 flex-1 space-y-1.5 no-underline text-inherit">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium">{routine.title}</span>
          {isArchived || routine.status === "paused" || isDraft ? (
            <DomainStatus status={isArchived ? "archived" : isDraft ? "draft" : "paused"} />
          ) : null}
          {managedByLabel ? <Badge variant="outline">{managedByLabel}</Badge> : null}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span className="flex items-center gap-2">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-sm"
              style={{
                backgroundColor: project?.color ?? "var(--project-none)",
              }}
            />
            <span>{routine.projectId ? (project?.name ?? "Unknown project") : "No project"}</span>
          </span>
          <span className="flex items-center gap-2">
            {agent?.icon ? <AgentIcon icon={agent.icon} className="h-3.5 w-3.5 shrink-0" /> : null}
            <span>{routine.assigneeAgentId ? (agent?.name ?? "Unknown agent") : "No default agent"}</span>
          </span>
          <span>
            {formatLastRunTimestamp(routine.lastRun?.triggeredAt)}
            {routine.lastRun ? ` · ${formatRoutineRunStatus(routine.lastRun.status)}` : ""}
          </span>
        </div>
        {secondaryDetails ? <div className="text-xs text-muted-foreground">{secondaryDetails}</div> : null}
      </RoutineLink>

      <ItemActions className="w-full sm:w-auto">
        {runNowButton ? (
          <Button variant="outline" size="sm" disabled={runDisabled} onClick={() => onRunNow(routine)}>
            <Play className="h-3.5 w-3.5"  data-icon="inline-start"/>
            {runningRoutineId === routine.id ? "Running..." : "Run now"}
          </Button>
        ) : null}

        <div className="flex items-center gap-3">
          <Switch
            size="default"
            checked={enabled}
            onCheckedChange={() => onToggleEnabled(routine, enabled)}
            disabled={isStatusPending || isArchived || disableToggle}
            aria-label={enabled ? `Disable ${routine.title}` : `Enable ${routine.title}`}
          />
          <span className="w-12 text-xs text-muted-foreground">
            {isArchived ? "Archived" : isDraft ? "Draft" : enabled ? "On" : "Off"}
          </span>
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={`More actions for ${routine.title}`}>
              <MoreHorizontal className="h-4 w-4"  data-icon="inline-start"/>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem asChild>
              <RoutineLink routeId={routeId}>{configureLabel}</RoutineLink>
            </DropdownMenuItem>
            <DropdownMenuItem disabled={runDisabled} onClick={() => onRunNow(routine)}>
              {runningRoutineId === routine.id ? "Running..." : "Run now"}
            </DropdownMenuItem>
            {extraMenuItems ? (
              <>
                <DropdownMenuSeparator />
                {extraMenuItems}
              </>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => onToggleEnabled(routine, enabled)}
              disabled={isStatusPending || isArchived || disableToggle}
            >
              {enabled ? "Pause" : "Enable"}
            </DropdownMenuItem>
            {!hideArchiveAction && onToggleArchived ? (
              <DropdownMenuItem onClick={() => onToggleArchived(routine)} disabled={isStatusPending}>
                {routine.status === "archived" ? "Restore" : "Archive"}
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </ItemActions>
    </Item>
  );
}
