import { isTaskExecutionRunActive } from "@/api/runs";
import {
  PriorityChart,
  RunActivityChart,
  SuccessRateChart,
  TaskStatusChart,
} from "@/components/ActivityCharts";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Empty, EmptyTitle } from "@/components/ui/empty";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import { taskDisplayTitle } from "@/lib/task-display";
import { DomainStatus } from "@/components/patterns/DomainStatus";
import { formatMoneyAmount, formatTokens, relativeTime } from "@/lib/utils";
import type { AgentRuntimeState, BudgetCurrency, TaskExecutionRunEnvelopeRecord } from "@paperclipai/shared";
import { Link } from "@tanstack/react-router";

export function LatestRunCard({
  runs,
  agentId,
}: {
  runs: TaskExecutionRunEnvelopeRecord[];
  agentId: string;
}) {
  const companyId = useCompanyRouteId();
  if (runs.length === 0) return null;

  const sorted = [...runs].sort(
    (left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
  );
  const run = sorted.find(isTaskExecutionRunActive) ?? sorted[0]!;
  const isLive = isTaskExecutionRunActive(run);
  const terminalSummary = run.terminalReasonCode ? run.terminalReasonCode.replace(/_/g, " ") : null;

  return (
    <div className="space-y-3">
      <div className="flex w-full items-center justify-between">
        <h3 className="text-sm font-medium">{isLive ? "Active run" : "Latest run"}</h3>
        <Button asChild variant="ghost" size="xs">
          <Link to="/$companyId/agents/$agentId/runs/$runId" params={{ companyId, agentId, runId: run.id }}>
            View details
          </Link>
        </Button>
      </div>
      <Item asChild variant="outline">
        <Link
          to="/$companyId/agents/$agentId/runs/$runId"
          params={{ companyId, agentId, runId: run.id }}
          className="no-underline"
        >
          <ItemContent>
            <ItemTitle className="flex-wrap">
              <DomainStatus status={run.status} />
              <Badge variant="outline" className="capitalize">
                {run.kind}
              </Badge>
              <span className="font-mono text-xs text-muted-foreground">{run.id.slice(0, 8)}</span>
            </ItemTitle>
            {terminalSummary ? (
              <ItemDescription className="capitalize">{terminalSummary}</ItemDescription>
            ) : null}
          </ItemContent>
          <ItemActions className="text-xs text-muted-foreground">{relativeTime(run.createdAt)}</ItemActions>
        </Link>
      </Item>
    </div>
  );
}

export function AgentOverview({
  runs,
  assignedTasks,
  runtimeState,
  budgetCurrency,
  agentId,
  agentRouteId,
}: {
  runs: TaskExecutionRunEnvelopeRecord[];
  assignedTasks: {
    id: string;
    taskNumber: number;
    title: string | null;
    boardPresentationStatus: string;
    priority: string;
    identifier: string;
    request?: string | null;
    createdAt: Date;
  }[];
  runtimeState?: AgentRuntimeState | null;
  budgetCurrency?: BudgetCurrency;
  agentId: string;
  agentRouteId: string;
}) {
  const companyId = useCompanyRouteId();
  return (
    <div className="space-y-8">
      <LatestRunCard runs={runs} agentId={agentRouteId} />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {[
          { title: "Run Activity", content: <RunActivityChart runs={runs} /> },
          {
            title: "Tasks by Priority",
            content: <PriorityChart tasks={assignedTasks} />,
          },
          {
            title: "Tasks by Status",
            content: <TaskStatusChart tasks={assignedTasks} />,
          },
          { title: "Success Rate", content: <SuccessRateChart runs={runs} /> },
        ].map((chart) => (
          <Card key={chart.title}>
            <CardHeader>
              <CardTitle>{chart.title}</CardTitle>
              <CardDescription>Last 14 days</CardDescription>
            </CardHeader>
            <CardContent>{chart.content}</CardContent>
          </Card>
        ))}
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">Recent Tasks</h3>
          <Button asChild variant="ghost" size="xs">
            <Link to="/$companyId/tasks" params={{ companyId }} search={{ participantAgentId: agentId }}>
              See all
            </Link>
          </Button>
        </div>
        {assignedTasks.length === 0 ? (
          <Empty className="border py-6">
            <EmptyTitle className="text-base">No recent tasks</EmptyTitle>
          </Empty>
        ) : (
          <ItemGroup className="divide-y overflow-hidden rounded-lg border">
            {assignedTasks.slice(0, 10).map((task) => (
              <Item key={task.id} asChild size="sm">
                <Link
                  to="/$companyId/tasks/$taskNumber"
                  params={{
                    companyId,
                    taskNumber: String(task.taskNumber),
                  }}
                  className="no-underline"
                >
                  <ItemContent>
                    <ItemTitle>
                      <span className="font-mono text-xs text-muted-foreground">{task.identifier}</span>
                      <span>{taskDisplayTitle(task)}</span>
                    </ItemTitle>
                  </ItemContent>
                  <ItemActions>
                    <DomainStatus status={task.boardPresentationStatus} />
                  </ItemActions>
                </Link>
              </Item>
            ))}
            {assignedTasks.length > 10 && (
              <Item size="sm">
                <ItemContent>
                  <ItemDescription className="text-center">
                    +{assignedTasks.length - 10} more tasks
                  </ItemDescription>
                </ItemContent>
              </Item>
            )}
          </ItemGroup>
        )}
      </div>

      <div className="space-y-3">
        <h3 className="text-sm font-medium">Costs</h3>
        <CostsSection runtimeState={runtimeState} budgetCurrency={budgetCurrency} />
      </div>
    </div>
  );
}

export function CostsSection({
  runtimeState,
  budgetCurrency,
}: {
  runtimeState?: AgentRuntimeState | null;
  budgetCurrency?: BudgetCurrency;
}) {
  if (!runtimeState) {
    return (
      <Empty className="border py-6">
        <EmptyTitle className="text-base">No settled accounting</EmptyTitle>
      </Empty>
    );
  }
  const metrics = [
    {
      label: "Latest context",
      value:
        runtimeState.lastContextUsedTokens !== null && runtimeState.lastContextWindowTokens !== null
          ? `${formatTokens(runtimeState.lastContextUsedTokens)} / ${formatTokens(runtimeState.lastContextWindowTokens)}`
          : "Unavailable",
    },
    {
      label: "Peak context used",
      value: formatTokens(runtimeState.peakContextUsedTokens),
    },
    {
      label: "Known cost",
      value: budgetCurrency
        ? formatMoneyAmount(runtimeState.aggregateKnownCostAmount, budgetCurrency)
        : "Currency unavailable",
    },
    { label: "Unpriced prompts", value: runtimeState.unpricedPromptCount },
  ];
  return (
    <ItemGroup className="grid grid-cols-2 gap-4 tabular-nums md:grid-cols-4">
      {metrics.map((metric) => (
        <Item key={metric.label} variant="outline">
          <ItemContent>
            <ItemDescription>{metric.label}</ItemDescription>
            <ItemTitle className="text-lg">{metric.value}</ItemTitle>
          </ItemContent>
        </Item>
      ))}
    </ItemGroup>
  );
}
