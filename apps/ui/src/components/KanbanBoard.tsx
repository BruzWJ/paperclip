import { useMemo, useState } from "react";
import { TaskLinkQuicklook } from "./TaskLinkQuicklook";
import { StatusIcon } from "./StatusIcon";
import { PriorityIcon } from "./PriorityIcon";
import { Identity } from "./Identity";
import type { Task, TaskStatus } from "@paperclipai/shared";
import { collectSubtreeLiveCounts } from "../lib/liveTaskIds";
import { taskDisplayTitle } from "../lib/task-display";
import { cn } from "../lib/utils";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const KANBAN_BOARD_HIGH_VOLUME_THRESHOLD = 100;
export const KANBAN_COLUMN_PAGE_SIZE_OPTIONS = [10, 25, 50] as const;
export type KanbanColumnPageSize = (typeof KANBAN_COLUMN_PAGE_SIZE_OPTIONS)[number];
export const KANBAN_COLUMN_DEFAULT_PAGE_SIZE: KanbanColumnPageSize = 10;
export const KANBAN_COLD_STATUSES = ["backlog", "done", "cancelled"] as const;

export const boardStatuses = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "cancelled",
] as const satisfies readonly TaskStatus[];

const defaultKanbanColumnTone = {
  rail: "border-border bg-muted/20",
  railOver: "bg-accent/50 ring-1 ring-primary/20",
  header: "text-muted-foreground",
  count: "text-muted-foreground/60",
  body: "bg-muted/20",
  bodyOver: "bg-accent/40",
  card: "",
};

// Every column carries a status-hued tint (matching the app-wide status
// vocabulary: gray backlog, amber todo, blue in-progress, violet review,
// red blocked, green done) so no column reads as accidentally unstyled.
export const kanbanColumnTones: Partial<Record<TaskStatus, typeof defaultKanbanColumnTone>> = {
  backlog: {
    rail: "border-border bg-muted/30",
    railOver: "bg-muted/50 ring-1 ring-neutral-400/25",
    header: "text-muted-foreground",
    count: "text-muted-foreground/60",
    body: "bg-muted/30 ring-1 ring-inset ring-border/50",
    bodyOver: "bg-muted/50 ring-1 ring-inset ring-neutral-400/25",
    card: "",
  },
  todo: {
    rail: "border-amber-500/25 bg-amber-50/60 dark:bg-amber-950/20",
    railOver: "bg-amber-100/70 ring-1 ring-amber-500/25 dark:bg-amber-950/35",
    header: "text-amber-700 dark:text-amber-300",
    count: "text-amber-700/65 dark:text-amber-300/65",
    body: "bg-amber-50/45 ring-1 ring-inset ring-amber-500/15 dark:bg-amber-950/15",
    bodyOver: "bg-amber-100/70 ring-1 ring-inset ring-amber-500/25 dark:bg-amber-950/30",
    card: "",
  },
  in_progress: {
    rail: "border-blue-500/25 bg-blue-50/60 dark:bg-blue-950/20",
    railOver: "bg-blue-100/70 ring-1 ring-blue-500/25 dark:bg-blue-950/35",
    header: "text-blue-700 dark:text-blue-300",
    count: "text-blue-700/65 dark:text-blue-300/65",
    body: "bg-blue-50/45 ring-1 ring-inset ring-blue-500/15 dark:bg-blue-950/15",
    bodyOver: "bg-blue-100/70 ring-1 ring-inset ring-blue-500/25 dark:bg-blue-950/30",
    card: "",
  },
  blocked: {
    rail: "border-red-500/25 bg-red-50/60 dark:bg-red-950/20",
    railOver: "bg-red-100/70 ring-1 ring-red-500/25 dark:bg-red-950/35",
    header: "text-red-700 dark:text-red-300",
    count: "text-red-700/65 dark:text-red-300/65",
    body: "bg-red-50/45 ring-1 ring-inset ring-red-500/15 dark:bg-red-950/15",
    bodyOver: "bg-red-100/70 ring-1 ring-inset ring-red-500/25 dark:bg-red-950/30",
    card: "",
  },
  in_review: {
    rail: "border-violet-500/25 bg-violet-50/60 dark:bg-violet-950/20",
    railOver: "bg-violet-100/70 ring-1 ring-violet-500/25 dark:bg-violet-950/35",
    header: "text-violet-700 dark:text-violet-300",
    count: "text-violet-700/65 dark:text-violet-300/65",
    body: "bg-violet-50/45 ring-1 ring-inset ring-violet-500/15 dark:bg-violet-950/15",
    bodyOver: "bg-violet-100/70 ring-1 ring-inset ring-violet-500/25 dark:bg-violet-950/30",
    card: "",
  },
  done: {
    rail: "border-green-500/25 bg-green-50/60 dark:bg-green-950/20",
    railOver: "bg-green-100/70 ring-1 ring-green-500/25 dark:bg-green-950/35",
    header: "text-green-700 dark:text-green-300",
    count: "text-green-700/65 dark:text-green-300/65",
    body: "bg-green-50/45 ring-1 ring-inset ring-green-500/15 dark:bg-green-950/15",
    bodyOver: "bg-green-100/70 ring-1 ring-inset ring-green-500/25 dark:bg-green-950/30",
    card: "",
  },
  cancelled: {
    rail: "border-neutral-300/70 bg-muted/25 opacity-80 dark:border-neutral-700/70 dark:bg-neutral-900/20",
    railOver: "bg-muted/45 opacity-90 ring-1 ring-neutral-400/25 dark:bg-neutral-900/35",
    header: "text-muted-foreground/80",
    count: "text-muted-foreground/50",
    body: "bg-muted/25 ring-1 ring-inset ring-border/50",
    bodyOver: "bg-muted/45 ring-1 ring-inset ring-neutral-400/25",
    card: "bg-muted/35 text-muted-foreground opacity-80 hover:shadow-none",
  },
};

export function getKanbanColumnTone(status: TaskStatus) {
  return kanbanColumnTones[status] ?? defaultKanbanColumnTone;
}

function statusLabel(status: string): string {
  return status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

interface Agent {
  id: string;
  name: string;
}

interface KanbanBoardProps {
  tasks: Task[];
  agents?: Agent[];
  liveTaskIds?: Set<string>;
  compactCards?: boolean;
  collapsedStatuses?: string[];
  initialVisibleCount?: number;
  revealIncrement?: number;
}

/* ── Droppable Column ── */

function KanbanColumn({
  status,
  tasks,
  agents,
  liveTaskIds,
  subtreeLiveCounts,
  compactCards = false,
  collapsed = false,
  visibleCount,
  revealIncrement,
  onShowMore,
}: {
  status: TaskStatus;
  tasks: Task[];
  agents?: Agent[];
  liveTaskIds?: Set<string>;
  subtreeLiveCounts?: ReadonlyMap<string, number>;
  compactCards?: boolean;
  collapsed?: boolean;
  visibleCount: number;
  revealIncrement: number;
  onShowMore: () => void;
}) {
  const visibleTasks = collapsed ? [] : tasks.slice(0, visibleCount);
  const hiddenCount = Math.max(tasks.length - visibleTasks.length, 0);
  const nextRevealCount = Math.min(revealIncrement, hiddenCount);
  const tone = getKanbanColumnTone(status);

  if (collapsed) {
    return (
      <div
        className={cn(
          "flex min-h-(--sz-220px) w-(--sz-52px) shrink-0 flex-col items-center rounded-md border px-1.5 py-2 transition-colors",
          tone.rail,
        )}
        title={`${statusLabel(status)}: ${tasks.length}`}
      >
        <StatusIcon status={status} />
        <span className={cn("mt-2 [writing-mode:vertical-rl] rotate-180 text-(length:--text-nano) font-semibold uppercase tracking-wide", tone.header)}>
          {statusLabel(status)}
        </span>
        <Badge variant="ghost" className={cn("mt-auto bg-background px-1.5 text-(length:--text-nano) tabular-nums", tone.header)}>
          {tasks.length}
        </Badge>
      </div>
    );
  }

  return (
    <div className="flex flex-col shrink-0 min-w-(--sz-260px) w-(--sz-260px)">
      <div className="flex items-center gap-2 px-3 py-2 mb-1">
        <StatusIcon status={status} />
        <span className={cn("text-xs font-semibold uppercase tracking-wide", tone.header)}>
          {statusLabel(status)}
        </span>
        <span className={cn("ml-auto text-xs tabular-nums", tone.count)}>
          {tasks.length}
        </span>
      </div>
      <div
        className={cn(
          "flex-1 min-h-(--sz-120px) rounded-md p-2 space-y-1 transition-colors",
          tone.body,
        )}
      >
        {visibleTasks.map((task) => (
          <KanbanCard
            key={task.id}
            task={task}
            agents={agents}
            isLive={liveTaskIds?.has(task.id)}
            subtreeLiveCount={subtreeLiveCounts?.get(task.id) ?? 0}
            compact={compactCards}
            className={tone.card}
          />
        ))}
        {hiddenCount > 0 ? (
          <button
            type="button"
            className="mt-1 flex w-full items-center justify-center rounded-md border border-dashed border-border bg-background/70 px-2 py-2 text-xs font-medium text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
            onClick={onShowMore}
          >
            Show {nextRevealCount} more
          </button>
        ) : null}
        {tasks.length > 0 && (hiddenCount > 0 || tasks.length >= visibleCount) ? (
          <p className="px-1 pt-1 text-(length:--text-micro) text-muted-foreground">
            Showing {visibleTasks.length} of {tasks.length}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/* ── Draggable Card ── */

function KanbanCard({
  task,
  agents,
  isLive,
  subtreeLiveCount = 0,
  compact = false,
  className,
}: {
  task: Task;
  agents?: Agent[];
  isLive?: boolean;
  subtreeLiveCount?: number;
  compact?: boolean;
  className?: string;
}) {
  const agentName = (id: string | null) => {
    if (!id || !agents) return null;
    return agents.find((a) => a.id === id)?.name ?? null;
  };
  const content = (
    <>
      <div className={`flex items-start gap-1.5 ${compact ? "mb-1" : "mb-1.5"}`}>
        <span className="text-xs text-muted-foreground font-mono shrink-0">
          {task.identifier}
        </span>
        {isLive && (
          <span className="inline-flex shrink-0 items-center gap-1 text-(length:--text-nano) font-medium text-blue-600 dark:text-blue-400">
            <span className="relative flex h-2 w-2">
              <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
            </span>
            {compact ? "Live" : null}
          </span>
        )}
        {!isLive && subtreeLiveCount > 0 && (
          <Badge variant="outline"
            className="border-border px-1.5 text-(length:--text-nano) text-muted-foreground"
            title={`${subtreeLiveCount} sub-task${subtreeLiveCount === 1 ? "" : "s"} running below`}
          >
            <span className="h-2 w-2 shrink-0 rounded-full border border-muted-foreground/60" aria-hidden="true" />
            {subtreeLiveCount} live below
          </Badge>
        )}
      </div>
      <p className={`${compact ? "mb-1.5 text-xs" : "mb-2 text-sm"} leading-snug line-clamp-2`}>{taskDisplayTitle(task)}</p>
      <div className="flex items-center gap-2 min-w-0">
        <PriorityIcon priority={task.priority} />
        {task.ownerAgentId && (() => {
          const name = agentName(task.ownerAgentId);
          return name ? (
            <Identity name={name} size="xs" />
          ) : (
            <span className="text-xs text-muted-foreground font-mono">
              {task.ownerAgentId.slice(0, 8)}
            </span>
          );
        })()}
      </div>
    </>
  );

  return (
    <Card
      className={cn(
        "block transition-shadow",
        "hover:shadow-sm",
        compact ? "p-2" : "p-2.5",
        className,
      )}
    >
      <TaskLinkQuicklook
        taskId={task.id}
        taskNumber={task.taskNumber}
        disableTaskQuicklook
        className="block no-underline text-inherit"
      >
        {content}
      </TaskLinkQuicklook>
    </Card>
  );
}

/* ── Main Board ── */

export function KanbanBoard({
  tasks,
  agents,
  liveTaskIds,
  compactCards = false,
  collapsedStatuses = [],
  initialVisibleCount = KANBAN_COLUMN_DEFAULT_PAGE_SIZE,
  revealIncrement = KANBAN_COLUMN_DEFAULT_PAGE_SIZE,
}: KanbanBoardProps) {
  const paginationKey = `${initialVisibleCount}:${revealIncrement}`;
  const [visibleState, setVisibleState] = useState<{
    paginationKey: string;
    counts: Record<string, number>;
  }>({ paginationKey, counts: {} });
  const visibleCountByStatus = visibleState.paginationKey === paginationKey ? visibleState.counts : {};
  const collapsedStatusSet = useMemo(() => new Set(collapsedStatuses), [collapsedStatuses]);

  const columnTasks = useMemo(() => {
    const grouped: Record<TaskStatus, Task[]> = {} as Record<TaskStatus, Task[]>;
    for (const status of boardStatuses) {
      grouped[status] = [];
    }
    for (const task of tasks) {
      if (grouped[task.boardPresentationStatus]) {
        grouped[task.boardPresentationStatus].push(task);
      }
    }
    return grouped;
  }, [tasks]);

  const subtreeLiveCounts = useMemo(
    () => collectSubtreeLiveCounts(tasks, liveTaskIds ?? new Set<string>()),
    [tasks, liveTaskIds],
  );

  return (
    <div className="flex gap-3 overflow-x-auto pb-4 -mx-2 px-2">
        {boardStatuses.map((status) => (
          <KanbanColumn
            key={status}
            status={status}
            tasks={columnTasks[status] ?? []}
            agents={agents}
            liveTaskIds={liveTaskIds}
            subtreeLiveCounts={subtreeLiveCounts}
            compactCards={compactCards}
            // Compact mode (any lane explicitly collapsed) also collapses
            // empty lanes to the same labeled rail, so an empty In Progress
            // reads like the other rails instead of a lone expanded column.
            collapsed={collapsedStatusSet.has(status) || (collapsedStatusSet.size > 0 && columnTasks[status].length === 0)}
            visibleCount={visibleCountByStatus[status] ?? initialVisibleCount}
            revealIncrement={revealIncrement}
            onShowMore={() => {
              setVisibleState((current) => {
                const counts = current.paginationKey === paginationKey ? current.counts : {};
                return {
                  paginationKey,
                  counts: {
                    ...counts,
                    [status]: (counts[status] ?? initialVisibleCount) + revealIncrement,
                  },
                };
              });
            }}
          />
        ))}
    </div>
  );
}
