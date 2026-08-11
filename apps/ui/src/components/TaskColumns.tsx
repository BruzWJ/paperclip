import type { ReactNode } from "react";
import { deriveOriginatingActor, type Task } from "@paperclipai/shared";
import { Columns3 } from "lucide-react";
import { pickTextColorForPillBg } from "@/lib/color-contrast";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatOwnerUserLabel } from "../lib/task-owners";
import type { InboxTaskColumn } from "../lib/inbox";
import { cn } from "../lib/utils";
import { timeAgo } from "../lib/timeAgo";
import { Identity } from "./Identity";
import { StatusIcon } from "./StatusIcon";
import { Badge } from "@/components/ui/badge";

export const taskTrailingColumns: InboxTaskColumn[] = ["owner", "kickedOffBy", "project", "parent", "labels", "updated"];

const taskColumnLabels: Record<InboxTaskColumn, string> = {
  status: "Status",
  id: "ID",
  owner: "Owner",
  kickedOffBy: "Kicked off by",
  project: "Project",
  parent: "Parent task",
  labels: "Tags",
  updated: "Last updated",
};

const taskColumnDescriptions: Record<InboxTaskColumn, string> = {
  status: "Task state chip on the left edge.",
  id: "Task identifier like PAP-1009.",
  owner: "Agent owner or exceptional board escalation owner.",
  kickedOffBy: "Board user or agent who created the task.",
  project: "Linked project pill with its color.",
  parent: "Parent task identifier and title.",
  labels: "Task labels and tags.",
  updated: "Latest visible activity time.",
};

export function taskActivityText(task: Task): string {
  return `Updated ${timeAgo(task.lastActivityAt ?? task.lastExternalCommentAt ?? task.updatedAt)}`;
}

function taskTrailingGridTemplate(columns: InboxTaskColumn[]): string {
  return columns
    .map((column) => {
      if (column === "owner") return "minmax(6rem, 8rem)";
      if (column === "kickedOffBy") return "minmax(6rem, 8rem)";
      if (column === "project") return "minmax(4.5rem, 7rem)";
      if (column === "parent") return "minmax(3.5rem, 5.5rem)";
      if (column === "labels") return "minmax(3rem, 6rem)";
      return "minmax(3.5rem, 4.5rem)";
    })
    .join(" ");
}

export function TaskColumnPicker({
  availableColumns,
  visibleColumnSet,
  onToggleColumn,
  onResetColumns,
  title,
  iconOnly = false,
}: {
  availableColumns: readonly InboxTaskColumn[];
  visibleColumnSet: ReadonlySet<InboxTaskColumn>;
  onToggleColumn: (column: InboxTaskColumn, enabled: boolean) => void;
  onResetColumns: () => void;
  title: string;
  iconOnly?: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant={iconOnly ? "outline" : "ghost"}
          size={iconOnly ? "icon" : "sm"}
          className={iconOnly ? "h-8 w-8 shrink-0" : "hidden h-8 shrink-0 px-2 text-xs sm:inline-flex"}
          title="Columns"
        >
          <Columns3 className={iconOnly ? "h-3.5 w-3.5" : "mr-1 h-3.5 w-3.5"} />
          {!iconOnly && "Columns"}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-(--sz-300px) rounded-xl border-border/70 p-1.5 shadow-xl shadow-black/10">
        <DropdownMenuLabel className="px-2 pb-1 pt-1.5">
          <div className="space-y-1">
            <div className="text-(length:--text-nano) font-semibold uppercase tracking-(--tracking-caps) text-muted-foreground">
              Desktop task rows
            </div>
            <div className="text-sm font-medium text-foreground">
              {title}
            </div>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {availableColumns.map((column) => (
          <DropdownMenuCheckboxItem
            key={column}
            checked={visibleColumnSet.has(column)}
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={(checked) => onToggleColumn(column, checked === true)}
            className="items-start rounded-lg px-3 py-2.5 pl-8"
          >
            <span className="flex flex-col gap-0.5">
              <span className="text-sm font-medium text-foreground">
                {taskColumnLabels[column]}
              </span>
              <span className="text-xs leading-relaxed text-muted-foreground">
                {taskColumnDescriptions[column]}
              </span>
            </span>
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={onResetColumns}
          className="rounded-lg px-3 py-2 text-sm"
        >
          Reset defaults
          <span className="ml-auto text-xs text-muted-foreground">status, id, updated</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function InboxTaskMetaLeading({
  task,
  isLive,
  subtreeLiveCount = 0,
  showSubtreeLiveChip = true,
  showStatus = true,
  showIdentifier = true,
  statusSlot,
  checklistStepNumber = null,
}: {
  task: Task;
  isLive: boolean;
  subtreeLiveCount?: number;
  showSubtreeLiveChip?: boolean;
  showStatus?: boolean;
  showIdentifier?: boolean;
  statusSlot?: ReactNode;
  checklistStepNumber?: number | string | null;
}) {
  return (
    <>
      {showStatus ? (
        <span className="hidden shrink-0 items-center sm:inline-flex">
          {statusSlot ?? <StatusIcon status={task.boardPresentationStatus} blockerAttention={task.blockerAttention} />}
        </span>
      ) : null}
      {checklistStepNumber !== null ? (
        <span className="shrink-0 font-mono text-xs text-muted-foreground" aria-hidden="true">
          {checklistStepNumber}.
        </span>
      ) : null}
      {showIdentifier ? (
        <span className="shrink-0 font-mono text-xs text-muted-foreground">
          {task.identifier ?? task.id.slice(0, 8)}
        </span>
      ) : null}
      {isLive && (
        <Badge variant="ghost"
          className={cn(
            "px-1.5 sm:gap-1.5 sm:px-2",
            "bg-blue-500/10",
          )}
        >
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-pulse rounded-full bg-blue-400 opacity-75" />
            <span
              className={cn(
                "relative inline-flex h-2 w-2 rounded-full",
                "bg-blue-500",
              )}
            />
          </span>
          <span
            className={cn(
              "hidden text-(length:--text-micro) font-medium sm:inline",
              "text-blue-600 dark:text-blue-400",
            )}
          >
            Live
          </span>
        </Badge>
      )}
      {showSubtreeLiveChip && !isLive && subtreeLiveCount > 0 && (
        <Badge variant="outline"
          className={cn(
            "px-1.5 sm:gap-1.5 sm:px-2",
            "border-border bg-transparent",
          )}
          title={`${subtreeLiveCount} sub-task${subtreeLiveCount === 1 ? "" : "s"} running below`}
        >
          <span
            className={cn(
              "h-2 w-2 shrink-0 rounded-full border",
              "border-muted-foreground/60 bg-transparent",
            )}
            aria-hidden="true"
          />
          <span className="hidden text-(length:--text-micro) font-medium text-muted-foreground sm:inline">
            {subtreeLiveCount} live below
          </span>
        </Badge>
      )}
    </>
  );
}

export function InboxTaskTrailingColumns({
  task,
  columns,
  projectName,
  projectColor,
  ownerName,
  ownerUserName,
  ownerUserAvatarUrl,
  originatingAgentName,
  creatorUserName,
  creatorUserAvatarUrl,
  viaAgentName,
  currentUserId,
  parentIdentifier,
  parentTitle,
  ownerContent,
}: {
  task: Task;
  columns: InboxTaskColumn[];
  projectName: string | null;
  projectColor: string | null;
  ownerName: string | null;
  ownerUserName?: string | null;
  ownerUserAvatarUrl?: string | null;
  originatingAgentName?: string | null;
  creatorUserName?: string | null;
  creatorUserAvatarUrl?: string | null;
  viaAgentName?: string | null;
  currentUserId: string | null;
  parentIdentifier: string | null;
  parentTitle: string | null;
  ownerContent?: ReactNode;
}) {
  const activityText = timeAgo(task.lastActivityAt ?? task.lastExternalCommentAt ?? task.updatedAt);
  const userLabel = ownerUserName ?? formatOwnerUserLabel(task.ownerUserId, currentUserId) ?? "User";
  const originatingActor = deriveOriginatingActor(task);
  const originatingUserId = originatingActor?.kind === "user" ? originatingActor.id : null;
  const creatorUserLabel = creatorUserName ?? formatOwnerUserLabel(originatingUserId, currentUserId) ?? "User";

  return (
    <span
      className="grid items-center gap-2"
      style={{ gridTemplateColumns: taskTrailingGridTemplate(columns) }}
    >
      {columns.map((column) => {
        if (column === "owner") {
          if (ownerContent) {
            return <span key={column} className="min-w-0">{ownerContent}</span>;
          }

          if (task.ownerAgentId) {
            return (
              <span key={column} className="min-w-0 text-xs text-foreground">
                <Identity
                  name={ownerName ?? task.ownerAgentId.slice(0, 8)}
                  size="sm"
                  className="min-w-0"
                />
              </span>
            );
          }

          if (task.ownerUserId) {
            return (
              <span key={column} className="min-w-0 text-xs text-foreground">
                <Identity
                  name={userLabel}
                  avatarUrl={ownerUserAvatarUrl}
                  size="sm"
                  className="min-w-0"
                />
              </span>
            );
          }

          return (
            <span key={column} className="min-w-0 truncate text-xs text-muted-foreground">
              Board escalation
            </span>
          );
        }

        if (column === "kickedOffBy") {
          if (originatingActor?.kind === "agent") {
            const name = originatingAgentName ?? originatingActor.id.slice(0, 8);
            return (
              <Tooltip key={column}>
                <TooltipTrigger asChild>
                  <span className="min-w-0 text-xs text-foreground">
                    <Identity
                      name={name}
                      size="sm"
                      className="min-w-0"
                    />
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={6}>{name}</TooltipContent>
              </Tooltip>
            );
          }

          if (originatingActor?.kind === "user") {
            const tooltipText = viaAgentName ? `${creatorUserLabel} · via ${viaAgentName}` : creatorUserLabel;
            return (
              <Tooltip key={column}>
                <TooltipTrigger asChild>
                  <span className="min-w-0 text-xs text-foreground">
                    <Identity
                      name={creatorUserLabel}
                      avatarUrl={creatorUserAvatarUrl}
                      size="sm"
                      className="min-w-0"
                    />
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={6}>{tooltipText}</TooltipContent>
              </Tooltip>
            );
          }

          return (
            <span key={column} className="min-w-0 truncate text-xs text-muted-foreground">
              Unknown
            </span>
          );
        }

        if (column === "project") {
          if (projectName) {
            // token-extraction: allowlisted — accentColor also feeds pickTextColorForPillBg() contrast math; a var() string can't be parsed as a hex color there.
            const accentColor = projectColor ?? "#64748b";
            return (
              <span
                key={column}
                className="inline-flex min-w-0 items-center gap-2 text-xs font-medium"
                style={{ color: pickTextColorForPillBg(accentColor, 0.12) }}
              >
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ backgroundColor: accentColor }}
                />
                <span className="truncate">{projectName}</span>
              </span>
            );
          }

          return (
            <span key={column} className="min-w-0 truncate text-xs text-muted-foreground">
              No project
            </span>
          );
        }

        if (column === "labels") {
          if ((task.labels ?? []).length > 0) {
            return (
              <span key={column} className="flex min-w-0 items-center gap-1 overflow-hidden">
                {(task.labels ?? []).slice(0, 2).map((label) => (
                  <Badge variant="outline"
                    key={label.id}
                    className="min-w-0 max-w-full px-1.5 py-0 text-(length:--text-nano)"
                    style={{
                      borderColor: label.color,
                      color: pickTextColorForPillBg(label.color, 0.12),
                      backgroundColor: `${label.color}1f`,
                    }}
                  >
                    <span className="truncate">{label.name}</span>
                  </Badge>
                ))}
                {(task.labels ?? []).length > 2 ? (
                  <span className="shrink-0 text-(length:--text-nano) font-medium text-muted-foreground">
                    +{(task.labels ?? []).length - 2}
                  </span>
                ) : null}
              </span>
            );
          }

          return <span key={column} className="min-w-0" aria-hidden="true" />;
        }

        if (column === "parent") {
          if (!task.parentId) {
            return <span key={column} className="min-w-0" aria-hidden="true" />;
          }

          return (
            <span key={column} className="min-w-0 truncate text-xs text-muted-foreground" title={parentTitle ?? undefined}>
              {parentIdentifier ? (
                <span className="font-mono">{parentIdentifier}</span>
              ) : (
                <span className="italic">Sub-task</span>
              )}
            </span>
          );
        }

        if (column === "updated") {
          return (
            <span key={column} className="min-w-0 truncate text-right text-(length:--text-micro) font-medium text-muted-foreground">
              {activityText}
            </span>
          );
        }

        return null;
      })}
    </span>
  );
}
