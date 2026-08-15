import { useMemo, useState } from "react";
import type { Task, TaskStatus } from "@paperclipai/shared";
import {
  KanbanBoard as KiboKanbanBoard,
  KanbanCard as KiboKanbanCard,
  KanbanCards as KiboKanbanCards,
  KanbanHeader as KiboKanbanHeader,
  KanbanProvider,
} from "@/components/kibo-ui/kanban";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DomainStatus } from "@/components/patterns/DomainStatus";
import { deriveInitials } from "@/lib/identity";
import { collectSubtreeLiveCounts } from "@/lib/liveTaskIds";
import { taskValueLabel } from "@/lib/task-blockers";
import { taskDisplayTitle } from "@/lib/task-display";
import type { NamedEntity } from "@/lib/presentation-contracts";
import { TaskLinkQuicklook } from "../-TaskLinkQuicklook";

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
  return status.replace(/_/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

interface KanbanBoardProps {
  tasks: Task[];
  agents?: NamedEntity[];
  liveTaskIds?: Set<string>;
  compactCards?: boolean;
  collapsedStatuses?: string[];
  initialVisibleCount?: number;
  revealIncrement?: number;
}

type PaperclipKanbanColumn = {
  id: TaskStatus;
  name: string;
} & Record<string, unknown>;

type PaperclipKanbanItem = {
  id: string;
  name: string;
  column: TaskStatus;
  task: Task;
} & Record<string, unknown>;

function TaskCardContent({
  task,
  agentNameById,
  isLive,
  subtreeLiveCount = 0,
  compact = false,
}: {
  task: Task;
  agentNameById: ReadonlyMap<string, string>;
  isLive?: boolean;
  subtreeLiveCount?: number;
  compact?: boolean;
}) {
  const ownerName = task.ownerAgentId ? agentNameById.get(task.ownerAgentId) : undefined;

  return (
    <TaskLinkQuicklook
      taskId={task.id}
      taskNumber={task.taskNumber}
      disableTaskQuicklook
      className={compact ? "block p-2 text-inherit no-underline" : "block p-2.5 text-inherit no-underline"}
    >
      <div className={compact ? "mb-1 flex items-start gap-1.5" : "mb-1.5 flex items-start gap-1.5"}>
        <span className="shrink-0 font-mono text-xs text-muted-foreground">{task.identifier}</span>
        {isLive ? (
          <DomainStatus status="running" className="px-1.5">
            {compact ? <span className="sr-only">Live</span> : "Live"}
          </DomainStatus>
        ) : null}
        {!isLive && subtreeLiveCount > 0 ? (
          <Badge
            variant="outline"
            className="border-border px-1.5 text-(length:--text-nano) text-muted-foreground"
            title={`${subtreeLiveCount} sub-task${subtreeLiveCount === 1 ? "" : "s"} running below`}
          >
            {subtreeLiveCount} live below
          </Badge>
        ) : null}
      </div>
      <p
        className={
          compact ? "mb-1.5 line-clamp-2 text-xs leading-snug" : "mb-2 line-clamp-2 text-sm leading-snug"
        }
      >
        {taskDisplayTitle(task)}
      </p>
      <div className="flex min-w-0 items-center gap-2">
        <Badge variant="secondary">{taskValueLabel(task.priority)}</Badge>
        {task.ownerAgentId ? (
          ownerName ? (
            <span className="inline-flex min-w-0 items-center gap-1" title={ownerName}>
              <Avatar size="sm">
                <AvatarFallback>{deriveInitials(ownerName)}</AvatarFallback>
              </Avatar>
              <span className="truncate text-sm">{ownerName}</span>
            </span>
          ) : (
            <span className="font-mono text-xs text-muted-foreground">{task.ownerAgentId.slice(0, 8)}</span>
          )
        ) : null}
      </div>
    </TaskLinkQuicklook>
  );
}

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
  const columns = useMemo<PaperclipKanbanColumn[]>(
    () => boardStatuses.map((status) => ({ id: status, name: statusLabel(status) })),
    [],
  );
  const agentNameById = useMemo(
    () => new Map((agents ?? []).map((agent) => [agent.id, agent.name])),
    [agents],
  );

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

  const collapsedByStatus = useMemo(() => {
    const result: Record<TaskStatus, boolean> = {} as Record<TaskStatus, boolean>;
    for (const status of boardStatuses) {
      result[status] =
        collapsedStatusSet.has(status) || (collapsedStatusSet.size > 0 && columnTasks[status].length === 0);
    }
    return result;
  }, [collapsedStatusSet, columnTasks]);

  const visibleItems = useMemo<PaperclipKanbanItem[]>(
    () =>
      boardStatuses.flatMap((status) => {
        if (collapsedByStatus[status]) return [];
        const visibleCount = visibleCountByStatus[status] ?? initialVisibleCount;
        return columnTasks[status].slice(0, visibleCount).map((task) => ({
          id: task.id,
          name: taskDisplayTitle(task),
          column: status,
          task,
        }));
      }),
    [collapsedByStatus, columnTasks, initialVisibleCount, visibleCountByStatus],
  );

  const subtreeLiveCounts = useMemo(
    () => collectSubtreeLiveCounts(tasks, liveTaskIds ?? new Set<string>()),
    [tasks, liveTaskIds],
  );

  return (
    <KanbanProvider<PaperclipKanbanItem, PaperclipKanbanColumn>
      columns={columns}
      data={visibleItems}
      sensors={[]}
      className="-mx-2 flex h-auto w-full items-stretch gap-3 overflow-x-auto px-2 pb-4"
    >
      {(column) => {
        const status = column.id;
        const statusTasks = columnTasks[status];
        const collapsed = collapsedByStatus[status];
        const visibleCount = visibleCountByStatus[status] ?? initialVisibleCount;
        const visibleTaskCount = collapsed ? 0 : Math.min(statusTasks.length, visibleCount);
        const hiddenCount = Math.max(statusTasks.length - visibleTaskCount, 0);
        const nextRevealCount = Math.min(revealIncrement, hiddenCount);

        if (collapsed) {
          return (
            <KiboKanbanBoard
              key={status}
              id={status}
              className="min-h-(--sz-220px) w-(--sz-52px) shrink-0 bg-card text-card-foreground"
            >
              <KiboKanbanHeader
                data-slot="kanban-header"
                className="flex h-full flex-col items-center gap-2 p-1.5"
                title={`${column.name}: ${statusTasks.length}`}
              >
                <Badge variant="secondary">{column.name}</Badge>
                <Badge variant="secondary" className="mt-auto">
                  {statusTasks.length}
                </Badge>
              </KiboKanbanHeader>
            </KiboKanbanBoard>
          );
        }

        return (
          <KiboKanbanBoard
            key={status}
            id={status}
            className="min-w-(--sz-260px) w-(--sz-260px) shrink-0 bg-card text-card-foreground"
          >
            <KiboKanbanHeader data-slot="kanban-header" className="flex items-center gap-2 px-3 py-2">
              <Badge variant="secondary">{column.name}</Badge>
              <Badge variant="secondary" className="ml-auto">
                {statusTasks.length}
              </Badge>
            </KiboKanbanHeader>
            <div className="flex min-h-(--sz-120px) flex-1 flex-col">
              <KiboKanbanCards<PaperclipKanbanItem> id={status} data-slot="kanban-cards" className="gap-1">
                {(item) => (
                  <KiboKanbanCard
                    key={item.id}
                    {...item}
                    draggable={false}
                    className="gap-0 rounded-md p-0 shadow-sm transition-shadow hover:shadow-sm"
                  >
                    <TaskCardContent
                      task={item.task}
                      agentNameById={agentNameById}
                      isLive={liveTaskIds?.has(item.id)}
                      subtreeLiveCount={subtreeLiveCounts.get(item.id) ?? 0}
                      compact={compactCards}
                    />
                  </KiboKanbanCard>
                )}
              </KiboKanbanCards>
              {hiddenCount > 0 ? (
                <div className="px-2 pb-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="w-full"
                    onClick={() => {
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
                  >
                    Show {nextRevealCount} more
                  </Button>
                </div>
              ) : null}
              {statusTasks.length > 0 && (hiddenCount > 0 || statusTasks.length >= visibleCount) ? (
                <p className="px-3 pb-2 text-(length:--text-micro) text-muted-foreground">
                  Showing {visibleTaskCount} of {statusTasks.length}
                </p>
              ) : null}
            </div>
          </KiboKanbanBoard>
        );
      }}
    </KanbanProvider>
  );
}
