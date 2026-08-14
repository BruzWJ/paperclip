import { useMemo, useState } from "react";
import { TaskLinkQuicklook } from "./TaskLinkQuicklook";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { deriveInitials } from "@/lib/identity";
import type { Task, TaskStatus } from "@paperclipai/shared";
import { collectSubtreeLiveCounts } from "../lib/liveTaskIds";
import { taskDisplayTitle } from "../lib/task-display";
import { taskValueLabel } from "../lib/task-blockers";
import { cn } from "../lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

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
  if (collapsed) {
    return (
      <Card
        className="min-h-(--sz-220px) w-(--sz-52px) shrink-0 items-center gap-2 px-1.5 py-2"
        title={`${statusLabel(status)}: ${tasks.length}`}
      >
        <Badge variant="secondary">{statusLabel(status)}</Badge>
        <Badge variant="secondary" className="mt-auto">
          {tasks.length}
        </Badge>
      </Card>
    );
  }

  return (
    <Card className="min-w-(--sz-260px) w-(--sz-260px) shrink-0 gap-0 py-0">
      <CardHeader className="flex-row items-center gap-2 px-3 py-2">
        <CardTitle>
          <Badge variant="secondary">{statusLabel(status)}</Badge>
        </CardTitle>
        <Badge variant="secondary" className="ml-auto">
          {tasks.length}
        </Badge>
      </CardHeader>
      <CardContent className="min-h-(--sz-120px) flex-1 space-y-1 p-2">
        {visibleTasks.map((task) => (
          <KanbanCard
            key={task.id}
            task={task}
            agents={agents}
            isLive={liveTaskIds?.has(task.id)}
            subtreeLiveCount={subtreeLiveCounts?.get(task.id) ?? 0}
            compact={compactCards}
          />
        ))}
        {hiddenCount > 0 ? (
          <Button type="button" variant="outline" size="sm" className="mt-1 w-full" onClick={onShowMore}>
            Show {nextRevealCount} more
          </Button>
        ) : null}
        {tasks.length > 0 && (hiddenCount > 0 || tasks.length >= visibleCount) ? (
          <p className="px-1 pt-1 text-(length:--text-micro) text-muted-foreground">
            Showing {visibleTasks.length} of {tasks.length}
          </p>
        ) : null}
      </CardContent>
    </Card>
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
        <span className="text-xs text-muted-foreground font-mono shrink-0">{task.identifier}</span>
        {isLive && (
          <Badge variant="secondary" className="px-1.5">
            {compact ? <span className="sr-only">Live</span> : "Live"}
          </Badge>
        )}
        {!isLive && subtreeLiveCount > 0 && (
          <Badge
            variant="outline"
            className="border-border px-1.5 text-(length:--text-nano) text-muted-foreground"
            title={`${subtreeLiveCount} sub-task${subtreeLiveCount === 1 ? "" : "s"} running below`}
          >
            {subtreeLiveCount} live below
          </Badge>
        )}
      </div>
      <p className={`${compact ? "mb-1.5 text-xs" : "mb-2 text-sm"} leading-snug line-clamp-2`}>
        {taskDisplayTitle(task)}
      </p>
      <div className="flex items-center gap-2 min-w-0">
        <Badge variant="secondary">{taskValueLabel(task.priority)}</Badge>
        {task.ownerAgentId &&
          (() => {
            const name = agentName(task.ownerAgentId);
            return name ? (
              <span className="inline-flex min-w-0 items-center gap-1" title={name}>
                <Avatar size="sm">
                  <AvatarFallback>{deriveInitials(name)}</AvatarFallback>
                </Avatar>
                <span className="truncate text-sm">{name}</span>
              </span>
            ) : (
              <span className="text-xs text-muted-foreground font-mono">{task.ownerAgentId.slice(0, 8)}</span>
            );
          })()}
      </div>
    </>
  );

  return (
    <Card className={cn("block gap-0 py-0 transition-shadow hover:shadow-sm", className)}>
      <TaskLinkQuicklook
        taskId={task.id}
        taskNumber={task.taskNumber}
        disableTaskQuicklook
        className="block no-underline text-inherit"
      >
        <CardContent className={compact ? "p-2" : "p-2.5"}>{content}</CardContent>
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
          collapsed={
            collapsedStatusSet.has(status) ||
            (collapsedStatusSet.size > 0 && columnTasks[status].length === 0)
          }
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
