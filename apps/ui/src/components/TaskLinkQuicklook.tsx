import * as React from "react";
import { useMemo } from "react";
import type { Task } from "@paperclipai/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { timeAgo } from "@/lib/timeAgo";
import { withTaskDetailHeaderSeed } from "@/lib/taskDetailBreadcrumb";
import {
  getTaskDetailQueryOptions,
  TASK_DETAIL_STALE_TIME_MS,
  prefetchTaskDetail,
} from "@/lib/taskDetailCache";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { StatusIcon } from "@/components/StatusIcon";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";

/* ------------------------------------------------------------------ */
/*  Single-flight quicklook store                                      */
/*                                                                     */
/*  Every task link renders its own Radix Popover. In a dense list,   */
/*  independent per-card open                                           */
/*  state lets popovers overlap, linger, and stack — two flyouts at    */
/*  once, sometimes showing the wrong card. This module-level store    */
/*  enforces exactly one open quicklook across the whole tree: opening  */
/*  one closes any other.                                               */
/* ------------------------------------------------------------------ */

let activeQuicklookId: symbol | null = null;
const quicklookListeners = new Set<() => void>();

function emitQuicklookChange() {
  for (const listener of quicklookListeners) listener();
}

function openQuicklookId(id: symbol) {
  if (activeQuicklookId === id) return;
  activeQuicklookId = id;
  emitQuicklookChange();
}

function closeQuicklookId(id: symbol) {
  if (activeQuicklookId !== id) return;
  activeQuicklookId = null;
  emitQuicklookChange();
}

function subscribeQuicklook(listener: () => void) {
  quicklookListeners.add(listener);
  return () => {
    quicklookListeners.delete(listener);
  };
}

function useIsQuicklookOpen(id: symbol) {
  return React.useSyncExternalStore(
    subscribeQuicklook,
    () => activeQuicklookId === id,
    () => false,
  );
}

/** Hover-intent delay (ms) before a quicklook opens — prevents flicker
 *  as the pointer crosses cards on its way somewhere else. */
const QUICKLOOK_OPEN_DELAY_MS = 120;

type TaskQuicklookTask = Pick<Task, "id" | "title" | "taskNumber" | "updatedAt"> & {
  identifier: string;
  boardPresentationStatus: string;
  priority: string;
  request?: string | null;
  blockerAttention?: Task["blockerAttention"];
  projectId?: string | null;
  project?: { name?: string | null } | null;
  originKind?: string;
  originId?: string | null;
};

function summarizeTaskRequest(request: string | null | undefined) {
  if (!request) return null;
  const summary = request
    .replace(/!\[[^\]]*]\([^)]+\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[#>*_`~-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!summary) return null;
  return summary.length > 180 ? `${summary.slice(0, 177).trimEnd()}...` : summary;
}

function TaskQuicklookCard({
  task,
  linkState,
  compact = false,
}: {
  task: TaskQuicklookTask;
  linkState?: React.ComponentProps<typeof Link>["state"];
  compact?: boolean;
}) {
  const requestSummary = useMemo(() => summarizeTaskRequest(task.request), [task.request]);
  const companyId = useCompanyRouteId();

  return (
    <div className={cn("space-y-2", compact && "space-y-1.5")}>
      <div className="flex items-start gap-2">
        <StatusIcon status={task.boardPresentationStatus} blockerAttention={task.blockerAttention} className="mt-0.5 shrink-0" />
        <Link
          to="/$companyId/tasks/$taskNumber"
          params={{ companyId, taskNumber: String(task.taskNumber) }}
          state={linkState ?? withTaskDetailHeaderSeed(null, task)}
          className="text-sm font-medium leading-snug hover:underline line-clamp-2"
        >
          {task.title}
        </Link>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="font-mono">{task.identifier}</span>
        <span>&middot;</span>
        <span>{task.boardPresentationStatus.replace(/_/g, " ")}</span>
        <span>&middot;</span>
        <span>{timeAgo(new Date(task.updatedAt))}</span>
      </div>
      {requestSummary ? (
        <p className="text-xs leading-5 text-muted-foreground [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:4] overflow-hidden">
          {requestSummary}
        </p>
      ) : null}
    </div>
  );
}

export const TaskLinkQuicklook = React.forwardRef<
  HTMLAnchorElement,
  Omit<React.ComponentPropsWithoutRef<"a">, "href"> & {
    taskId: string;
    taskNumber: number | null;
    "data-mention-kind"?: string;
    hash?: string;
    state?: React.ComponentProps<typeof Link>["state"];
    disableTaskQuicklook?: boolean;
    taskPrefetch?: Task | null;
    taskQuicklookSide?: React.ComponentProps<typeof PopoverContent>["side"];
    taskQuicklookAlign?: React.ComponentProps<typeof PopoverContent>["align"];
  }
>(function TaskLinkQuicklookImpl(
  {
    taskId,
    taskNumber,
    "data-mention-kind": dataMentionKind,
    hash,
    children,
    className,
    state,
    disableTaskQuicklook = false,
    taskPrefetch = null,
    taskQuicklookSide = "top",
    taskQuicklookAlign = "start",
    onClick,
    onClickCapture,
    onMouseEnter,
    onFocus,
    onBlur,
    onTouchStart,
    ...props
  },
  ref,
) {
  const queryClient = useQueryClient();
  const companyId = useCompanyRouteId();
  const instanceId = React.useMemo(() => Symbol("task-quicklook"), []);
  const open = useIsQuicklookOpen(instanceId);
  const openTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelScheduledOpen = React.useCallback(() => {
    if (openTimerRef.current) {
      clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
  }, []);

  // Open immediately (keyboard focus, or re-entering the open popover).
  const openNow = React.useCallback(() => {
    cancelScheduledOpen();
    openQuicklookId(instanceId);
  }, [cancelScheduledOpen, instanceId]);

  // Open after the hover-intent delay (pointer entering a card).
  const scheduleOpen = React.useCallback(() => {
    cancelScheduledOpen();
    openTimerRef.current = setTimeout(() => {
      openTimerRef.current = null;
      openQuicklookId(instanceId);
    }, QUICKLOOK_OPEN_DELAY_MS);
  }, [cancelScheduledOpen, instanceId]);

  const close = React.useCallback(() => {
    cancelScheduledOpen();
    closeQuicklookId(instanceId);
  }, [cancelScheduledOpen, instanceId]);

  // Clear any pending timer and release the active slot on unmount.
  React.useEffect(() => {
    return () => {
      cancelScheduledOpen();
      closeQuicklookId(instanceId);
    };
  }, [cancelScheduledOpen, instanceId]);

  const prefetchedState = taskPrefetch ? withTaskDetailHeaderSeed(state, taskPrefetch) : state;
  const taskQuery = useQuery({
    ...getTaskDetailQueryOptions(queryClient, taskId),
    enabled: open || taskNumber === null,
    staleTime: TASK_DETAIL_STALE_TIME_MS,
  });
  const data = taskQuery.data;
  const isLoading = taskQuery.isLoading;
  const resolvedTaskNumber = taskPrefetch?.taskNumber ?? data?.taskNumber ?? taskNumber;

  const handlePrefetch = React.useCallback(() => {
    void prefetchTaskDetail(queryClient, taskId, { task: taskPrefetch });
  }, [queryClient, taskId, taskPrefetch]);
  if (resolvedTaskNumber === null) {
    return (
      <span
        className={className}
        title={props.title}
        aria-label={props["aria-label"]}
        data-mention-kind={dataMentionKind}
      >
        {children}
      </span>
    );
  }

  const link = (
    <Link
      ref={ref}
      to="/$companyId/tasks/$taskNumber"
      params={{ companyId, taskNumber: String(resolvedTaskNumber) }}
      hash={hash}
      state={prefetchedState}
      data-mention-kind={dataMentionKind}
      className={className}
      onMouseEnter={(event) => {
        handlePrefetch();
        onMouseEnter?.(event);
      }}
      onFocus={(event) => {
        handlePrefetch();
        openNow();
        onFocus?.(event);
      }}
      onBlur={(event) => {
        // Let clicks inside the portaled quicklook content finish before closing.
        setTimeout(() => close(), 0);
        onBlur?.(event);
      }}
      onTouchStart={(event) => {
        handlePrefetch();
        onTouchStart?.(event);
      }}
      onClickCapture={(event) => {
        handlePrefetch();
        onClickCapture?.(event);
      }}
      onClick={(event) => {
        close();
        onClick?.(event);
      }}
      {...props}
    >
      {children}
    </Link>
  );

  if (disableTaskQuicklook) {
    return link;
  }

  return (
    <Popover open={open} onOpenChange={(next) => (next ? openNow() : close())}>
      <PopoverTrigger
        asChild
        onMouseEnter={() => {
          handlePrefetch();
          scheduleOpen();
        }}
        onMouseLeave={close}
      >
        {link}
      </PopoverTrigger>
      <PopoverContent
        className="w-72 p-3"
        side={taskQuicklookSide}
        align={taskQuicklookAlign}
        onMouseEnter={openNow}
        onMouseLeave={close}
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        {data ? (
          <TaskQuicklookCard task={data} linkState={prefetchedState} compact />
        ) : (
          <div className="space-y-2" aria-busy={isLoading}>
            <div className="h-4 w-24 rounded bg-accent/50" />
            <div className="h-4 w-full rounded bg-accent/40" />
            <div className="h-4 w-3/4 rounded bg-accent/30" />
            {isLoading ? <p role="status" className="sr-only">Loading task preview…</p> : (
              <p role="alert" className="text-xs text-muted-foreground">Unable to load task preview.</p>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
});
