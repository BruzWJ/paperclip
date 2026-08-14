import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { dashboardApi } from "@/api/dashboard";
import { activityApi } from "@/api/activity";
import { accessApi } from "@/api/access";
import { tasksApi } from "@/api/tasks";
import { agentsApi } from "@/api/agents";
import { projectsApi } from "@/api/projects";
import { buildCompanyUserProfileMap } from "@/lib/company-members";
import { useDialogActions } from "@/context/DialogContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { queryKeys } from "@/lib/queryKeys";
import { ActivityRow } from "@/components/ActivityRow";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { DomainStatus } from "@/components/patterns/DomainStatus";
import { deriveInitials } from "@/lib/identity";
import { taskValueLabel } from "@/lib/task-blockers";
import { timeAgo } from "@/lib/timeAgo";
import { formatMoneyAmount } from "@/lib/utils";
import { Bot, CircleDot, DollarSign, ShieldCheck, PauseCircle } from "lucide-react";
import { ActiveAgentsPanel } from "@/components/ActiveAgentsPanel";
import { taskDisplayTitle } from "@/lib/task-display";
import {
  RunActivityChart,
  PriorityChart,
  TaskStatusChart,
  SuccessRateChart,
} from "@/components/ActivityCharts";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { compareMoneyAmounts, parseMoneyAmount, type Task } from "@paperclipai/shared";
import { PluginSlotOutlet } from "@/plugins/slots";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import { indexEntitiesById } from "@/lib/presentation-contracts";

export const Route = createFileRoute("/_authenticated/$companyId/dashboard/")({
  component: Dashboard,
});

const DASHBOARD_ACTIVITY_LIMIT = 10;

const ZERO_AMOUNT = parseMoneyAmount("0");

function getRecentTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

function Dashboard() {
  const companyId = useCompanyRouteId();
  const { openNewAgent } = useDialogActions();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [animatedActivityIds, setAnimatedActivityIds] = useState<Set<string>>(new Set());
  const seenActivityIdsRef = useRef<Set<string>>(new Set());
  const hydratedActivityRef = useRef(false);
  const activityAnimationTimersRef = useRef<number[]>([]);

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
  });

  useEffect(() => {
    setBreadcrumbs([{ label: "Dashboard" }]);
  }, [setBreadcrumbs]);

  const dashboardQueryKey = queryKeys.dashboard(companyId);
  const { data, isLoading, error } = useQuery({
    queryKey: dashboardQueryKey,
    queryFn: () => dashboardApi.summary(companyId),
  });

  const activityQueryKey = [...queryKeys.activity(companyId), { limit: DASHBOARD_ACTIVITY_LIMIT }] as const;
  const { data: activity } = useQuery({
    queryKey: activityQueryKey,
    queryFn: () => activityApi.list(companyId, { limit: DASHBOARD_ACTIVITY_LIMIT }),
  });

  const { data: tasks } = useQuery({
    queryKey: queryKeys.tasks.list(companyId),
    queryFn: () => tasksApi.list(companyId),
  });

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(companyId),
    queryFn: () => projectsApi.list(companyId),
  });

  const { data: companyMembers } = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(companyId),
    queryFn: () => accessApi.listUserDirectory(companyId),
  });

  const userProfileMap = useMemo(
    () => buildCompanyUserProfileMap(companyMembers?.users),
    [companyMembers?.users],
  );

  const recentTasks = tasks ? getRecentTasks(tasks) : [];
  const recentActivity = useMemo(() => (activity ?? []).slice(0, 10), [activity]);

  useEffect(() => {
    for (const timer of activityAnimationTimersRef.current) {
      window.clearTimeout(timer);
    }
    activityAnimationTimersRef.current = [];
    seenActivityIdsRef.current = new Set();
    hydratedActivityRef.current = false;
    setAnimatedActivityIds(new Set());
  }, [companyId]);

  useEffect(() => {
    if (recentActivity.length === 0) return;

    const seen = seenActivityIdsRef.current;
    const currentIds = recentActivity.map((event) => event.id);

    if (!hydratedActivityRef.current) {
      for (const id of currentIds) seen.add(id);
      hydratedActivityRef.current = true;
      return;
    }

    const newIds = currentIds.filter((id) => !seen.has(id));
    if (newIds.length === 0) {
      for (const id of currentIds) seen.add(id);
      return;
    }

    setAnimatedActivityIds((prev) => {
      const next = new Set(prev);
      for (const id of newIds) next.add(id);
      return next;
    });

    for (const id of newIds) seen.add(id);

    const timer = window.setTimeout(() => {
      setAnimatedActivityIds((prev) => {
        const next = new Set(prev);
        for (const id of newIds) next.delete(id);
        return next;
      });
      activityAnimationTimersRef.current = activityAnimationTimersRef.current.filter((t) => t !== timer);
    }, 980);
    activityAnimationTimersRef.current.push(timer);
  }, [recentActivity]);

  useEffect(() => {
    return () => {
      for (const timer of activityAnimationTimersRef.current) {
        window.clearTimeout(timer);
      }
    };
  }, []);

  const agentMap = useMemo(() => indexEntitiesById(agents), [agents]);

  const entityNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const i of tasks ?? []) map.set(`task:${i.id}`, i.identifier);
    for (const a of agents ?? []) map.set(`agent:${a.id}`, a.name);
    for (const p of projects ?? []) map.set(`project:${p.id}`, p.name);
    return map;
  }, [tasks, agents, projects]);

  const entityTitleMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const i of tasks ?? []) map.set(`task:${i.id}`, taskDisplayTitle(i));
    return map;
  }, [tasks]);

  const agentName = (id: string | null) => {
    if (!id || !agents) return null;
    return agents.find((a) => a.id === id)?.name ?? null;
  };

  if (isLoading) {
    return <Skeleton className="h-32 w-full" />;
  }

  const hasNoAgents = agents !== undefined && agents.length === 0;
  const metrics = data
    ? [
        {
          icon: Bot,
          value: data.agents.idle + data.agents.paused + data.agents.error,
          label: "Agents",
          to: "/$companyId/agents" as const,
          description: `${data.agents.idle} idle, ${data.agents.paused} paused, ${data.agents.error} errors`,
        },
        {
          icon: CircleDot,
          value: data.tasks.inProgress,
          label: "Tasks In Progress",
          to: "/$companyId/tasks" as const,
          description: `${data.tasks.open} open, ${data.tasks.blocked} blocked`,
        },
        {
          icon: DollarSign,
          value: formatMoneyAmount(data.costs.monthKnownSpendAmount, data.costs.budgetCurrency),
          label: "Month Spend",
          to: "/$companyId/costs" as const,
          description:
            compareMoneyAmounts(data.costs.monthBudgetAmount, ZERO_AMOUNT) > 0
              ? `${data.costs.monthUtilizationPercent}% of ${formatMoneyAmount(data.costs.monthBudgetAmount, data.costs.budgetCurrency)} budget`
              : `${data.costs.unpricedPromptCount} unpriced prompts`,
        },
        {
          icon: ShieldCheck,
          value: data.pendingApprovals + data.budgets.pendingApprovals,
          label: "Pending Approvals",
          to: "/$companyId/approvals" as const,
          description:
            data.budgets.pendingApprovals > 0
              ? `${data.budgets.pendingApprovals} budget overrides awaiting board review`
              : "Awaiting board review",
        },
      ]
    : [];
  const charts = data
    ? [
        {
          title: "Run Activity",
          content: <RunActivityChart activity={data.runActivity} />,
        },
        {
          title: "Tasks by Priority",
          content: <PriorityChart tasks={tasks ?? []} />,
        },
        {
          title: "Tasks by Status",
          content: <TaskStatusChart tasks={tasks ?? []} />,
        },
        {
          title: "Success Rate",
          content: <SuccessRateChart activity={data.runActivity} />,
        },
      ]
    : [];

  return (
    <div className="space-y-6">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      )}

      {hasNoAgents && (
        <Alert>
          <Bot />
          <AlertTitle>You have no agents.</AlertTitle>
          <AlertDescription>
            <Button variant="outline" size="sm" onClick={openNewAgent}>
              Create one here
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <ActiveAgentsPanel companyId={companyId} />

      {data && (
        <>
          {data.budgets.activeIncidents > 0 ? (
            <Alert variant="destructive">
              <PauseCircle />
              <AlertTitle>
                {data.budgets.activeIncidents} active budget incident
                {data.budgets.activeIncidents === 1 ? "" : "s"}
              </AlertTitle>
              <AlertDescription>
                <p>
                  {data.budgets.pausedAgents} agents paused · {data.budgets.pausedProjects} projects paused ·{" "}
                  {data.budgets.pendingApprovals} pending budget approvals
                </p>
                <Button variant="outline" size="sm" asChild>
                  <Link to="/$companyId/costs" params={{ companyId }}>
                    Open budgets
                  </Link>
                </Button>
              </AlertDescription>
            </Alert>
          ) : null}

          <div className="grid grid-cols-2 xl:grid-cols-4 gap-1 sm:gap-2">
            {metrics.map((metric) => {
              const Icon = metric.icon;
              return (
                <Card key={metric.label} className="h-full py-0">
                  <Link
                    to={metric.to}
                    params={{ companyId }}
                    className="h-full text-inherit no-underline hover:bg-accent/50"
                  >
                    <CardContent className="flex items-start justify-between gap-3 py-4">
                      <div className="min-w-0 flex-1">
                        <p className="text-2xl font-semibold tabular-nums sm:text-3xl">{metric.value}</p>
                        <p className="mt-1 text-sm font-medium text-muted-foreground">{metric.label}</p>
                        <p className="mt-1 hidden text-xs text-muted-foreground sm:block">
                          {metric.description}
                        </p>
                      </div>
                      <Icon className="size-4 shrink-0 text-muted-foreground" />
                    </CardContent>
                  </Link>
                </Card>
              );
            })}
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {charts.map((chart) => (
              <Card key={chart.title}>
                <CardHeader>
                  <CardTitle>{chart.title}</CardTitle>
                  <CardDescription>Last 14 days</CardDescription>
                </CardHeader>
                <CardContent>{chart.content}</CardContent>
              </Card>
            ))}
          </div>

          <PluginSlotOutlet
            slotTypes={["dashboardWidget"]}
            context={{ companyId }}
            className="grid gap-4 md:grid-cols-2"
            // design-allow(card-pattern): class-string prop consumed by the plugin outlet; a component can't be passed here (C5a Run 3)
            itemClassName="rounded-lg border bg-card p-4 shadow-sm"
          />

          <div className="grid md:grid-cols-2 gap-4">
            {/* Recent Activity */}
            {recentActivity.length > 0 && (
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
                  Recent Activity
                </h3>
                <Card className="block py-0 divide-y divide-border overflow-hidden">
                  {recentActivity.map((event) => (
                    <ActivityRow
                      key={event.id}
                      event={event}
                      agentMap={agentMap}
                      userProfileMap={userProfileMap}
                      entityNameMap={entityNameMap}
                      entityTitleMap={entityTitleMap}
                      className={animatedActivityIds.has(event.id) ? "activity-row-enter" : undefined}
                    />
                  ))}
                </Card>
              </div>
            )}

            {/* Recent Tasks */}
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
                Recent Tasks
              </h3>
              {recentTasks.length === 0 ? (
                <Empty className="py-6">
                  <EmptyDescription>No tasks yet.</EmptyDescription>
                </Empty>
              ) : (
                <Card className="block py-0 divide-y divide-border overflow-hidden">
                  {recentTasks.slice(0, 10).map((task) => {
                    const content = (
                      <div className="flex items-start gap-2 sm:items-center sm:gap-3">
                        {/* Status icon - left column on mobile */}
                        <span className="shrink-0 sm:hidden">
                          <DomainStatus status={task.boardPresentationStatus}>
                            {taskValueLabel(task.boardPresentationStatus)}
                          </DomainStatus>
                        </span>

                        {/* Right column on mobile: title + metadata stacked */}
                        <span className="flex min-w-0 flex-1 flex-col gap-1 sm:contents">
                          <span className="line-clamp-2 text-sm sm:order-2 sm:flex-1 sm:min-w-0 sm:line-clamp-none sm:truncate">
                            {taskDisplayTitle(task)}
                          </span>
                          <span className="flex items-center gap-2 sm:order-1 sm:shrink-0">
                            <span className="hidden sm:inline-flex">
                              <DomainStatus status={task.boardPresentationStatus}>
                                {taskValueLabel(task.boardPresentationStatus)}
                              </DomainStatus>
                            </span>
                            <span className="text-xs font-mono text-muted-foreground">{task.identifier}</span>
                            {task.ownerAgentId &&
                              (() => {
                                const name = agentName(task.ownerAgentId);
                                return name ? (
                                  <span className="hidden items-center gap-1.5 sm:inline-flex" title={name}>
                                    <Avatar size="sm">
                                      <AvatarFallback>{deriveInitials(name)}</AvatarFallback>
                                    </Avatar>
                                    <span className="truncate text-xs">{name}</span>
                                  </span>
                                ) : null;
                              })()}
                            <span className="text-xs text-muted-foreground sm:hidden">&middot;</span>
                            <span className="text-xs text-muted-foreground shrink-0 sm:order-last">
                              {timeAgo(task.updatedAt)}
                            </span>
                          </span>
                        </span>
                      </div>
                    );
                    const className = "block px-4 py-3 text-sm text-inherit no-underline";
                    return (
                      <Link
                        key={task.id}
                        to="/$companyId/tasks/$taskNumber"
                        params={{
                          companyId,
                          taskNumber: String(task.taskNumber),
                        }}
                        className={`${className} cursor-pointer transition-colors hover:bg-accent/50`}
                      >
                        {content}
                      </Link>
                    );
                  })}
                </Card>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
