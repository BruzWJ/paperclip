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
import { agentsApi } from "@/api/agents";
import { ACTIVE_TASK_EXECUTION_RUN_STATUSES, runsApi } from "@/api/runs";
import { tasksApi } from "@/api/tasks";
import { queryKeys } from "@/lib/queryKeys";
import { DomainStatus } from "@/components/patterns/DomainStatus";
import { cn, relativeTime } from "@/lib/utils";
import { Bot, ExternalLink } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { deriveInitials } from "@/lib/identity";
import { TaskLinkQuicklook } from "../../../../features/tasks/shared/TaskLinkQuicklook";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";

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
  const runsQueryKey = [...queryKeys.runs(companyId, { status }), queryScope, limit] as const;
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
  const agentById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);

  const runs = runPage?.items ?? [];
  const visibleRuns = useMemo(() => runs.slice(0, cardLimit), [cardLimit, runs]);
  const hiddenRunCount = Math.max(0, runs.length - visibleRuns.length);
  const visibleTaskIds = useMemo(() => [...new Set(visibleRuns.map((run) => run.taskId))], [visibleRuns]);
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
      <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      {runs.length === 0 ? (
        <Empty className="border" role="status">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Bot aria-hidden="true"  data-icon="inline-start"/>
            </EmptyMedia>
            <EmptyTitle>{emptyMessage}</EmptyTitle>
            <EmptyDescription>Agent activity will appear here when a task run starts.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className={cn("grid grid-cols-1 gap-2 sm:grid-cols-2 sm:gap-4 xl:grid-cols-4", gridClassName)}>
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
    <Card className={cn("min-h-52 overflow-hidden", className)}>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <DomainStatus status="running">Live</DomainStatus>
              <span className="inline-flex min-w-0 items-center gap-1.5" title={agentName}>
                <Avatar size="sm">
                  <AvatarFallback>{deriveInitials(agentName)}</AvatarFallback>
                </Avatar>
                <span className="truncate text-(length:--text-micro)">{agentName}</span>
              </span>
            </div>
            <div className="mt-2 flex items-center gap-2 text-(length:--text-micro) text-muted-foreground">
              <DomainStatus status={run.status} />
              <span>{relativeTime(run.createdAt)}</span>
            </div>
          </div>
          {agentRef ? (
            <Button asChild variant="outline" size="icon-sm" aria-label={`Open ${agentName}'s ${run.kind} run`}>
              <Link
                to="/$companyId/agents/$agentId/runs/$runId"
                params={{ companyId, agentId: agentRef, runId: run.id }}
                aria-label={`Open ${agentName}'s ${run.kind} run`}
              >
                <ExternalLink aria-hidden="true"  data-icon="inline-start"/>
              </Link>
            </Button>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col justify-between gap-3 text-xs">
        <div>
          <p className="font-medium capitalize">{run.kind} run</p>
          <p className="mt-1 font-mono text-muted-foreground">{run.id}</p>
        </div>
        {task ? (
          <TaskLinkQuicklook
            taskId={task.id}
            taskNumber={task.taskNumber}
            taskPrefetch={task}
            className="text-primary hover:underline"
          >
            {task.identifier}
            {task.title ? " - " + task.title : ""}
          </TaskLinkQuicklook>
        ) : (
          <div className="text-muted-foreground">Task unavailable</div>
        )}
      </CardContent>
    </Card>
  );
});
