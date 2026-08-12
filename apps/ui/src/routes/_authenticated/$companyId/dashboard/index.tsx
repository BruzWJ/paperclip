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
import { MetricCard } from "@/components/MetricCard";
import { StatusIcon } from "@/components/StatusIcon";
import { ActivityRow } from "@/components/ActivityRow";
import { Identity } from "@/components/Identity";
import { timeAgo } from "@/lib/timeAgo";
import { formatMoneyAmount } from "@/lib/utils";
import {
  Bot,
  CircleDot,
  DollarSign,
  ShieldCheck,
  PauseCircle,
} from "lucide-react";
import { ActiveAgentsPanel } from "@/components/ActiveAgentsPanel";
import { taskDisplayTitle } from "@/lib/task-display";
import {
  ChartCard,
  RunActivityChart,
  PriorityChart,
  TaskStatusChart,
  SuccessRateChart,
} from "@/components/ActivityCharts";
import { PageSkeleton } from "@/components/PageSkeleton";
import { Card } from "@/components/ui/card";
import {
  compareMoneyAmounts,
  parseMoneyAmount,
  type Agent,
  type Task,
} from "@paperclipai/shared";
import { PluginSlotOutlet } from "@/plugins/slots";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";

export const Route = createFileRoute("/_authenticated/$companyId/dashboard/")({
  component: Dashboard,
});

const DASHBOARD_ACTIVITY_LIMIT = 10;

const ZERO_AMOUNT = parseMoneyAmount("0");

function getRecentTasks(tasks: Task[]): Task[] {
  return [...tasks].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
}

function Dashboard() {
  const companyId = useCompanyRouteId();
  const { openNewAgent } = useDialogActions();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [animatedActivityIds, setAnimatedActivityIds] = useState<Set<string>>(
    new Set(),
  );
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

  const activityQueryKey = [
    ...queryKeys.activity(companyId),
    { limit: DASHBOARD_ACTIVITY_LIMIT },
  ] as const;
  const { data: activity } = useQuery({
    queryKey: activityQueryKey,
    queryFn: () =>
      activityApi.list(companyId, { limit: DASHBOARD_ACTIVITY_LIMIT }),
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
  const recentActivity = useMemo(
    () => (activity ?? []).slice(0, 10),
    [activity],
  );

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
      activityAnimationTimersRef.current =
        activityAnimationTimersRef.current.filter((t) => t !== timer);
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

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const a of agents ?? []) map.set(a.id, a);
    return map;
  }, [agents]);

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
    return <PageSkeleton variant="dashboard" />;
  }

  const hasNoAgents = agents !== undefined && agents.length === 0;

  return (
    <div className="space-y-6">
      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {hasNoAgents && (
        <div className="flex items-center justify-between gap-3 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 dark:border-amber-500/25 dark:bg-amber-950/60">
          <div className="flex items-center gap-2.5">
            <Bot className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0" />
            <p className="text-sm text-amber-900 dark:text-amber-100">
              You have no agents.
            </p>
          </div>
          <button
            onClick={openNewAgent}
            className="text-sm font-medium text-amber-700 hover:text-amber-900 dark:text-amber-300 dark:hover:text-amber-100 underline underline-offset-2 shrink-0"
          >
            Create one here
          </button>
        </div>
      )}

      <ActiveAgentsPanel companyId={companyId} />

      {data && (
        <>
          {data.budgets.activeIncidents > 0 ? (
            <div className="flex items-start justify-between gap-3 rounded-xl border border-red-500/20 bg-(image:--gradient-extract-1) px-4 py-3">
              <div className="flex items-start gap-2.5">
                <PauseCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-700 dark:text-red-300" />
                <div>
                  <p className="text-sm font-medium text-red-950 dark:text-red-50">
                    {data.budgets.activeIncidents} active budget incident
                    {data.budgets.activeIncidents === 1 ? "" : "s"}
                  </p>
                  <p className="text-xs text-red-900/70 dark:text-red-100/70">
                    {data.budgets.pausedAgents} agents paused ·{" "}
                    {data.budgets.pausedProjects} projects paused ·{" "}
                    {data.budgets.pendingApprovals} pending budget approvals
                  </p>
                </div>
              </div>
              <Link
                to="/$companyId/costs"
                params={{ companyId }}
                className="text-sm underline underline-offset-2 text-red-900 dark:text-red-100"
              >
                Open budgets
              </Link>
            </div>
          ) : null}

          <div className="grid grid-cols-2 xl:grid-cols-4 gap-1 sm:gap-2">
            <MetricCard
              icon={Bot}
              value={data.agents.idle + data.agents.paused + data.agents.error}
              label="Agents"
              linkOptions={{
                to: "/$companyId/agents",
                params: { companyId },
              }}
              description={
                <span>
                  {data.agents.idle} idle{", "}
                  {data.agents.paused} paused{", "}
                  {data.agents.error} errors
                </span>
              }
            />
            <MetricCard
              icon={CircleDot}
              value={data.tasks.inProgress}
              label="Tasks In Progress"
              linkOptions={{
                to: "/$companyId/tasks",
                params: { companyId },
              }}
              description={
                <span>
                  {data.tasks.open} open{", "}
                  {data.tasks.blocked} blocked
                </span>
              }
            />
            <MetricCard
              icon={DollarSign}
              value={formatMoneyAmount(
                data.costs.monthKnownSpendAmount,
                data.costs.budgetCurrency,
              )}
              label="Month Spend"
              linkOptions={{
                to: "/$companyId/costs",
                params: { companyId },
              }}
              description={
                <span>
                  {compareMoneyAmounts(
                    data.costs.monthBudgetAmount,
                    ZERO_AMOUNT,
                  ) > 0
                    ? `${data.costs.monthUtilizationPercent}% of ${formatMoneyAmount(data.costs.monthBudgetAmount, data.costs.budgetCurrency)} budget`
                    : `${data.costs.unpricedPromptCount} unpriced prompts`}
                </span>
              }
            />
            <MetricCard
              icon={ShieldCheck}
              value={data.pendingApprovals + data.budgets.pendingApprovals}
              label="Pending Approvals"
              linkOptions={{
                to: "/$companyId/approvals",
                params: { companyId },
              }}
              description={
                <span>
                  {data.budgets.pendingApprovals > 0
                    ? `${data.budgets.pendingApprovals} budget overrides awaiting board review`
                    : "Awaiting board review"}
                </span>
              }
            />
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <ChartCard title="Run Activity" subtitle="Last 14 days">
              <RunActivityChart activity={data.runActivity} />
            </ChartCard>
            <ChartCard title="Tasks by Priority" subtitle="Last 14 days">
              <PriorityChart tasks={tasks ?? []} />
            </ChartCard>
            <ChartCard title="Tasks by Status" subtitle="Last 14 days">
              <TaskStatusChart tasks={tasks ?? []} />
            </ChartCard>
            <ChartCard title="Success Rate" subtitle="Last 14 days">
              <SuccessRateChart activity={data.runActivity} />
            </ChartCard>
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
                      className={
                        animatedActivityIds.has(event.id)
                          ? "activity-row-enter"
                          : undefined
                      }
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
                <Card className="block p-4">
                  <p className="text-sm text-muted-foreground">No tasks yet.</p>
                </Card>
              ) : (
                <Card className="block py-0 divide-y divide-border overflow-hidden">
                  {recentTasks.slice(0, 10).map((task) => {
                    const content = (
                      <div className="flex items-start gap-2 sm:items-center sm:gap-3">
                        {/* Status icon - left column on mobile */}
                        <span className="shrink-0 sm:hidden">
                          <StatusIcon
                            status={task.boardPresentationStatus}
                            blockerAttention={task.blockerAttention}
                          />
                        </span>

                        {/* Right column on mobile: title + metadata stacked */}
                        <span className="flex min-w-0 flex-1 flex-col gap-1 sm:contents">
                          <span className="line-clamp-2 text-sm sm:order-2 sm:flex-1 sm:min-w-0 sm:line-clamp-none sm:truncate">
                            {taskDisplayTitle(task)}
                          </span>
                          <span className="flex items-center gap-2 sm:order-1 sm:shrink-0">
                            <span className="hidden sm:inline-flex">
                              <StatusIcon
                                status={task.boardPresentationStatus}
                                blockerAttention={task.blockerAttention}
                              />
                            </span>
                            <span className="text-xs font-mono text-muted-foreground">
                              {task.identifier}
                            </span>
                            {task.ownerAgentId &&
                              (() => {
                                const name = agentName(task.ownerAgentId);
                                return name ? (
                                  <span className="hidden sm:inline-flex">
                                    <Identity name={name} size="sm" />
                                  </span>
                                ) : null;
                              })()}
                            <span className="text-xs text-muted-foreground sm:hidden">
                              &middot;
                            </span>
                            <span className="text-xs text-muted-foreground shrink-0 sm:order-last">
                              {timeAgo(task.updatedAt)}
                            </span>
                          </span>
                        </span>
                      </div>
                    );
                    const className =
                      "block px-4 py-3 text-sm text-inherit no-underline";
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
