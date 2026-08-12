import { memo, useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import { useQueries, useQuery } from "@tanstack/react-query";
import type {
  Agent,
  Task,
  TaskExecutionRunEnvelopeRecord,
  TaskExecutionRunListPageRecord,
} from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import {
  ACTIVE_TASK_EXECUTION_RUN_STATUSES,
  runsApi,
} from "../api/runs";
import { tasksApi } from "../api/tasks";
import { queryKeys } from "../lib/queryKeys";
import { cn, relativeTime } from "../lib/utils";
import { Bot, ExternalLink } from "lucide-react";
import { Identity } from "./Identity";
import { StatusBadge } from "./StatusBadge";
import { TaskLinkQuicklook } from "./TaskLinkQuicklook";

const MIN_DASHBOARD_RUNS = 4;
const DASHBOARD_RUN_CARD_LIMIT = 4;

interface ActiveAgentsPanelProps {
  companyId: string;
  title?: string;
  minRunCount?: number;
  fetchLimit?: number;
  cardLimit?: number;
  gridClassName?: string;
  cardClassName?: string;
  emptyMessage?: string;
  queryScope?: string;
  showMoreLink?: boolean;
}

function ActiveAgentsEmptyState({ message }: { message: string }) {
  return (
    <div className="rounded-xl border border-border p-4" role="status">
      <div className="flex items-start gap-2.5">
        <Bot className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div>
          <p className="text-sm font-medium text-foreground">{message}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Agent activity will appear here when a task run starts.
          </p>
        </div>
      </div>
    </div>
  );
}

export function ActiveAgentsPanel({
  companyId,
  title = "Agents",
  minRunCount = MIN_DASHBOARD_RUNS,
  fetchLimit,
  cardLimit = DASHBOARD_RUN_CARD_LIMIT,
  gridClassName,
  cardClassName,
  emptyMessage = "No active agent runs.",
  queryScope = "dashboard",
  showMoreLink = true,
}: ActiveAgentsPanelProps) {
  const limit = Math.max(1, fetchLimit ?? minRunCount, cardLimit);
  const status = ACTIVE_TASK_EXECUTION_RUN_STATUSES;
  const runsQueryKey = [
    ...queryKeys.runs(companyId, { status }),
    queryScope,
    limit,
  ] as const;
  const { data: runPage } = useQuery<TaskExecutionRunListPageRecord>({
    queryKey: runsQueryKey,
    queryFn: () => runsApi.listForCompany(companyId, { status, limit }),
    enabled: Boolean(companyId),
  });

  const { data: agents = [] } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: Boolean(companyId),
  });
  const agentById = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent])),
    [agents],
  );

  const runs = runPage?.items ?? [];
  const visibleRuns = useMemo(() => runs.slice(0, cardLimit), [cardLimit, runs]);
  const hiddenRunCount = Math.max(0, runs.length - visibleRuns.length);
  const visibleTaskIds = useMemo(
    () => [...new Set(visibleRuns.map((run) => run.taskId))],
    [visibleRuns],
  );
  const taskQueries = useQueries({
    queries: visibleTaskIds.map((taskId) => ({
      queryKey: queryKeys.tasks.detail(taskId),
      queryFn: () => tasksApi.get(taskId),
      staleTime: 30_000,
      retry: false,
    })),
  });
  const taskById = useMemo(() => {
    const map = new Map<string, Task>();
    for (const query of taskQueries) {
      if (query.data) map.set(query.data.id, query.data);
    }
    return map;
  }, [taskQueries]);

  return (
    <div>
      <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {runs.length === 0 ? (
        <ActiveAgentsEmptyState message={emptyMessage} />
      ) : (
        <div className={cn(
          "grid grid-cols-1 gap-2 sm:grid-cols-2 sm:gap-4 xl:grid-cols-4",
          gridClassName,
        )}>
          {visibleRuns.map((run) => (
            <AgentRunCard
              key={run.id}
              run={run}
              agent={agentById.get(run.targetAgentId)}
              task={taskById.get(run.taskId)}
              className={cardClassName}
            />
          ))}
        </div>
      )}
      {showMoreLink && hiddenRunCount > 0 ? (
        <div className="mt-3 flex justify-end text-xs text-muted-foreground">
          <Link
            to="/$companyId/dashboard/live"
            params={{ companyId }}
            className="hover:text-foreground hover:underline"
          >
            {hiddenRunCount} more active run{hiddenRunCount === 1 ? "" : "s"}
          </Link>
        </div>
      ) : null}
    </div>
  );
}

const AgentRunCard = memo(function AgentRunCard({
  run,
  agent,
  task,
  className,
}: {
  run: TaskExecutionRunEnvelopeRecord;
  agent?: Agent;
  task?: Task;
  className?: string;
}) {
  const companyId = useCompanyRouteId();
  const agentRef = agent?.id ?? null;
  const agentName = agent?.name ?? run.targetAgentId.slice(0, 8);
  return (
    <div className={cn(
      "flex min-h-52 flex-col overflow-hidden rounded-xl border border-blue-500/25 bg-blue-500/[0.04] shadow-sm",
      className,
    )}>
      <div className="border-b border-border/60 px-3 py-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="relative flex h-2.5 w-2.5 shrink-0">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-70" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-blue-500" />
              </span>
              <Identity name={agentName} size="sm" className="[&>span:last-child]:!text-(length:--text-micro)" />
            </div>
            <div className="mt-2 flex items-center gap-2 text-(length:--text-micro) text-muted-foreground">
              <StatusBadge status={run.status} />
              <span>{relativeTime(run.createdAt)}</span>
            </div>
          </div>
          {agentRef ? (
            <Link
              to="/$companyId/agents/$agentId/runs/$runId"
              params={{ companyId, agentId: agentRef, runId: run.id }}
              className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-background/70 px-2 py-1 text-(length:--text-nano) text-muted-foreground transition-colors hover:text-foreground"
              aria-label={`Open ${agentName}'s ${run.kind} run`}
            >
              <ExternalLink className="h-2.5 w-2.5" aria-hidden="true" />
            </Link>
          ) : null}
        </div>
      </div>
      <div className="flex flex-1 flex-col justify-between gap-3 p-3 text-xs">
        <div>
          <p className="font-medium capitalize">{run.kind} run</p>
          <p className="mt-1 font-mono text-muted-foreground">{run.id}</p>
        </div>
        {task ? (
          <TaskLinkQuicklook
            taskId={task.id}
            taskNumber={task.taskNumber}
            taskPrefetch={task}
            className="rounded-lg border border-border/60 bg-background/60 px-2.5 py-2 text-blue-700 hover:underline dark:text-blue-300"
          >
            {task.identifier}
            {task.title ? " - " + task.title : ""}
          </TaskLinkQuicklook>
        ) : (
          <div className="rounded-lg border border-border/60 bg-background/60 px-2.5 py-2 text-muted-foreground">
            Task unavailable
          </div>
        )}
      </div>
    </div>
  );
});
