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
import { taskStatusAccessibleLabel, taskValueLabel } from "@/lib/task-blockers";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";

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
        <Badge
          variant="secondary"
          aria-label={taskStatusAccessibleLabel(task.boardPresentationStatus, task.blockerAttention)}
        >
          {taskValueLabel(task.boardPresentationStatus)}
        </Badge>
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
    taskQuicklookSide?: React.ComponentProps<typeof HoverCardContent>["side"];
    taskQuicklookAlign?: React.ComponentProps<typeof HoverCardContent>["align"];
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
  const [open, setOpen] = React.useState(false);

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
        setOpen(true);
        onFocus?.(event);
      }}
      onBlur={(event) => {
        // Keep the portaled card mounted long enough for a keyboard user to
        // activate its task link before focus-driven dismissal.
        setTimeout(() => setOpen(false), 0);
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
        setOpen(false);
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
    <HoverCard open={open} onOpenChange={setOpen} openDelay={120} closeDelay={100}>
      <HoverCardTrigger asChild>{link}</HoverCardTrigger>
      <HoverCardContent className="w-72 p-3" side={taskQuicklookSide} align={taskQuicklookAlign}>
        {data ? (
          <TaskQuicklookCard task={data} linkState={prefetchedState} compact />
        ) : (
          <div className="space-y-2" aria-busy={isLoading}>
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
            {isLoading ? (
              <p role="status" className="sr-only">
                Loading task preview…
              </p>
            ) : (
              <Alert variant="destructive">
                <AlertDescription>Unable to load task preview.</AlertDescription>
              </Alert>
            )}
          </div>
        )}
      </HoverCardContent>
    </HoverCard>
  );
});
