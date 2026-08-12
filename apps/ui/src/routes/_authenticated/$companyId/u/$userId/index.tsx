import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle } from "lucide-react";
import type {
  UserProfileDailyPoint,
  UserProfileWindowStats,
} from "@paperclipai/shared";
import { getRouteApi, Link } from "@tanstack/react-router";
import { userProfilesApi } from "@/api/userProfiles";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { TaskStatusBadge } from "@/components/StatusBadge";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { queryKeys } from "@/lib/queryKeys";
import {
  formatDate,
  formatMoneyAmount,
  formatNumber,
  formatShortDate,
  relativeTime,
} from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/$companyId/u/$userId/")({
  component: UserProfile,
});

const route = getRouteApi("/_authenticated/$companyId/u/$userId/");

function initials(name: string | null | undefined) {
  const value = name?.trim() || "User";
  const parts = value.split(/\s+/).filter(Boolean);
  if (parts.length > 1)
    return `${parts[0]?.[0] ?? ""}${parts[parts.length - 1]?.[0] ?? ""}`.toUpperCase();
  return value.slice(0, 2).toUpperCase();
}

function promptCount(
  stats: Pick<
    UserProfileWindowStats,
    "pricedPromptCount" | "unpricedPromptCount"
  >,
) {
  return stats.pricedPromptCount + stats.unpricedPromptCount;
}

function completionRate(stats: UserProfileWindowStats) {
  if (stats.touchedTasks === 0) return "0%";
  return `${Math.round((stats.completedTasks / stats.touchedTasks) * 100)}%`;
}

function HeroStat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="min-w-0">
      <div className="text-2xl font-semibold tabular-nums sm:text-3xl">
        {value}
      </div>
      <div className="mt-1 text-(length:--text-micro) font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      {hint ? (
        <div className="mt-0.5 text-xs text-muted-foreground/70">{hint}</div>
      ) : null}
    </div>
  );
}

function WindowColumn({
  stats,
  budgetCurrency,
}: {
  stats: UserProfileWindowStats;
  budgetCurrency: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-4 border-l border-border pl-5 first:border-l-0 first:pl-0">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-(length:--text-micro) font-medium uppercase tracking-wide text-muted-foreground">
          {stats.label}
        </h2>
        <span className="text-(length:--text-micro) text-muted-foreground tabular-nums">
          {completionRate(stats)} done
        </span>
      </div>

      <div className="grid grid-cols-2 gap-x-5 gap-y-3">
        <Metric value={formatNumber(stats.touchedTasks)} label="Touched" />
        <Metric value={formatNumber(stats.completedTasks)} label="Completed" />
        <Metric value={formatNumber(stats.commentCount)} label="Comments" />
        <Metric value={formatNumber(stats.activityCount)} label="Actions" />
      </div>

      <div className="grid grid-cols-2 gap-x-5 gap-y-1.5 pt-3 text-xs tabular-nums text-muted-foreground">
        <span>Settled prompts</span>
        <span className="text-right text-foreground">
          {formatNumber(promptCount(stats))}
        </span>
        <span>Known cost</span>
        <span className="text-right text-foreground">
          {formatMoneyAmount(stats.knownCostAmount, budgetCurrency)}
        </span>
        <span>Unpriced</span>
        <span className="text-right text-foreground">
          {formatNumber(stats.unpricedPromptCount)}
        </span>
        <span>Created</span>
        <span className="text-right text-foreground">
          {formatNumber(stats.createdTasks)}
        </span>
        <span>Open</span>
        <span className="text-right text-foreground">
          {formatNumber(stats.assignedOpenTasks)}
        </span>
      </div>
    </div>
  );
}

function Metric({ value, label }: { value: string; label: string }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-xl font-semibold tabular-nums">{value}</div>
      <div className="mt-0.5 text-(length:--text-micro) text-muted-foreground">
        {label}
      </div>
    </div>
  );
}

function UsageChart({ points }: { points: UserProfileDailyPoint[] }) {
  const totals = points.map(
    (point) => point.pricedPromptCount + point.unpricedPromptCount,
  );
  const maxPrompts = Math.max(1, ...totals);
  const maxCompleted = Math.max(
    1,
    ...points.map((point) => point.completedTasks),
  );
  const totalPromptCount = totals.reduce((sum, value) => sum + value, 0);

  return (
    <section>
      <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-border pb-3">
        <h2 className="text-sm font-semibold">Last 14 days</h2>
        <div className="flex items-baseline gap-4 text-xs text-muted-foreground">
          <span className="tabular-nums text-foreground">
            {formatNumber(totalPromptCount)}
          </span>
          <span>settled prompts</span>
        </div>
      </div>
      <div className="mt-6 grid grid-cols-(--gtc-57) items-end gap-1.5 sm:gap-2">
        {points.map((point) => {
          const prompts = point.pricedPromptCount + point.unpricedPromptCount;
          const heightPct =
            prompts === 0
              ? 0
              : Math.max(2, Math.round((prompts / maxPrompts) * 100));
          const completedPct =
            point.completedTasks === 0
              ? 0
              : Math.max(
                  8,
                  Math.round((point.completedTasks / maxCompleted) * 36),
                );
          return (
            <div
              key={point.date}
              className="group flex h-36 flex-col justify-end"
            >
              <div
                className="w-full bg-foreground/80 transition-opacity group-hover:bg-foreground"
                style={{
                  height: `${heightPct}%`,
                  minHeight: prompts === 0 ? 1 : undefined,
                }}
                title={`${formatShortDate(point.date)}: ${formatNumber(prompts)} settled prompts, ${point.completedTasks} completed`}
              />
              {completedPct > 0 ? (
                <div
                  className="mt-1 w-full rounded-full bg-emerald-500/80"
                  style={{
                    height: 2,
                    opacity: Math.min(1, 0.35 + completedPct / 100),
                  }}
                />
              ) : null}
            </div>
          );
        })}
      </div>
      <div className="mt-2 grid grid-cols-(--gtc-57) gap-1.5 text-(length:--text-nano) tabular-nums text-muted-foreground sm:gap-2">
        {points.map((point, index) => (
          <div key={point.date} className="text-center">
            {index === 0 || index === 6 || index === 13
              ? formatShortDate(point.date)
              : null}
          </div>
        ))}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-4 text-(length:--text-nano) uppercase tracking-wide text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 bg-foreground/80" /> settled prompts / day
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-(--sz-3px) w-4 rounded-full bg-emerald-500/80" />{" "}
          completions
        </span>
      </div>
    </section>
  );
}

interface UsageRow {
  key: string;
  label: string;
  sublabel: string;
  knownCostAmount: UserProfileWindowStats["knownCostAmount"];
  pricedPromptCount: number;
  unpricedPromptCount: number;
}

function UsageList({
  title,
  empty,
  rows,
  budgetCurrency,
}: {
  title: string;
  empty: string;
  rows: UsageRow[];
  budgetCurrency: string;
}) {
  return (
    <section>
      <div className="flex items-baseline justify-between gap-3 border-b border-border pb-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        <span className="text-xs text-muted-foreground tabular-nums">
          {rows.length}
        </span>
      </div>
      {rows.length === 0 ? (
        <div className="pt-4 text-sm text-muted-foreground">{empty}</div>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((row) => (
            <li
              key={row.key}
              className="grid gap-2 py-2.5 sm:grid-cols-(--gtc-17) sm:items-center"
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{row.label}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {row.sublabel}
                </div>
              </div>
              <div className="flex items-baseline gap-4 text-xs tabular-nums sm:justify-end">
                <span className="text-muted-foreground">
                  {formatNumber(row.pricedPromptCount)} priced ·{" "}
                  {formatNumber(row.unpricedPromptCount)} unpriced
                </span>
                <span className="font-medium">
                  {formatMoneyAmount(row.knownCostAmount, budgetCurrency)}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function UserProfile() {
  const { companyId, userId } = route.useParams();
  const { setBreadcrumbs } = useBreadcrumbs();

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.userProfile(companyId, userId),
    queryFn: () => userProfilesApi.get(companyId, userId),
  });

  useEffect(() => {
    const label = data?.user.name?.trim() || data?.user.email?.trim() || "User";
    setBreadcrumbs([{ label: "Users" }, { label }]);
  }, [data?.user.email, data?.user.name, setBreadcrumbs]);

  const allTime = data?.stats.find((entry) => entry.key === "all");
  const last7 = data?.stats.find((entry) => entry.key === "last7");
  const displayName =
    data?.user.name?.trim() || data?.user.email?.split("@")[0] || "User";

  const agentUsageRows = useMemo<UsageRow[]>(
    () =>
      (data?.topAgents ?? []).map((row) => ({
        key: row.agentId ?? "unknown",
        label:
          row.agentName ?? (row.agentId ? row.agentId.slice(0, 8) : "unknown"),
        sublabel: "Task-linked settled prompts",
        knownCostAmount: row.knownCostAmount,
        pricedPromptCount: row.pricedPromptCount,
        unpricedPromptCount: row.unpricedPromptCount,
      })),
    [data?.topAgents],
  );

  if (isLoading) {
    return <PageSkeleton variant="dashboard" />;
  }

  if (error || !data) {
    return (
      <EmptyState
        icon={AlertCircle}
        message="User profile not found for this company."
      />
    );
  }

  const metaParts = [
    data.user.membershipRole,
    data.user.membershipStatus,
    `joined ${formatDate(data.user.joinedAt)}`,
  ];

  return (
    <div className="space-y-10 pb-10">
      <section className="flex flex-col gap-7 border-b border-border pb-8">
        <div className="flex flex-wrap items-center gap-5">
          <Avatar className="size-16 border border-border" size="lg">
            {data.user.image ? (
              <AvatarImage src={data.user.image} alt={displayName} />
            ) : null}
            <AvatarFallback className="text-lg font-semibold">
              {initials(displayName)}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-2xl font-semibold">{displayName}</h1>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
              {data.user.email ? (
                <span className="truncate">{data.user.email}</span>
              ) : null}
              {data.user.email ? <span aria-hidden>·</span> : null}
              <span>{metaParts.join(" · ")}</span>
            </div>
          </div>
        </div>

        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          <HeroStat
            label="Known AI cost"
            value={
              allTime
                ? formatMoneyAmount(
                    allTime.knownCostAmount,
                    data.budgetCurrency,
                  )
                : `${data.budgetCurrency} 0`
            }
            hint={`${formatNumber(allTime?.unpricedPromptCount ?? 0)} unpriced prompts`}
          />
          <HeroStat
            label="Completed"
            value={formatNumber(allTime?.completedTasks ?? 0)}
            hint={allTime ? `${completionRate(allTime)} rate` : undefined}
          />
          <HeroStat
            label="Open assigned"
            value={formatNumber(allTime?.assignedOpenTasks ?? 0)}
            hint={`${formatNumber(allTime?.createdTasks ?? 0)} created`}
          />
          <HeroStat
            label="7-day actions"
            value={formatNumber(last7?.activityCount ?? 0)}
            hint={`${formatNumber(last7?.commentCount ?? 0)} comments`}
          />
        </div>
      </section>

      <section className="grid gap-8 border-b border-border pb-8 lg:grid-cols-3">
        {data.stats.map((entry) => (
          <WindowColumn
            key={entry.key}
            stats={entry}
            budgetCurrency={data.budgetCurrency}
          />
        ))}
      </section>

      <UsageChart points={data.daily} />

      <div className="grid gap-10 pt-2 xl:grid-cols-2">
        <section>
          <div className="flex items-baseline justify-between gap-3 border-b border-border pb-3">
            <h2 className="text-sm font-semibold">Recent tasks</h2>
            <span className="text-xs text-muted-foreground tabular-nums">
              {data.recentTasks.length}
            </span>
          </div>
          {data.recentTasks.length === 0 ? (
            <div className="pt-4 text-sm text-muted-foreground">
              No touched tasks yet.
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {data.recentTasks.map((task) => {
                const content = (
                  <>
                    <span className="font-mono text-xs text-muted-foreground">
                      {task.identifier}
                    </span>
                    <span className="truncate text-sm">{task.title}</span>
                    <span className="flex items-center gap-3 sm:justify-end">
                      <TaskStatusBadge status={task.boardPresentationStatus} />
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {relativeTime(task.updatedAt)}
                      </span>
                    </span>
                  </>
                );
                const className =
                  "grid gap-2 py-2.5 sm:grid-cols-(--gtc-58) sm:items-center";
                return (
                  <li key={task.id}>
                    <Link
                      to="/$companyId/tasks/$taskNumber"
                      params={{
                        companyId,
                        taskNumber: String(task.taskNumber),
                      }}
                      className={`${className} transition-colors hover:bg-accent/40`}
                    >
                      {content}
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section>
          <div className="flex items-baseline justify-between gap-3 border-b border-border pb-3">
            <h2 className="text-sm font-semibold">Recent activity</h2>
            <span className="text-xs text-muted-foreground tabular-nums">
              {data.recentActivity.length}
            </span>
          </div>
          {data.recentActivity.length === 0 ? (
            <div className="pt-4 text-sm text-muted-foreground">
              No direct user actions recorded yet.
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {data.recentActivity.map((event) => (
                <li
                  key={event.id}
                  className="grid gap-2 py-2.5 sm:grid-cols-(--gtc-17) sm:items-center"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm">
                      {event.action.replaceAll("_", " ")}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {event.entityType} · {event.entityId.slice(0, 12)}
                    </div>
                  </div>
                  <span className="text-xs tabular-nums text-muted-foreground sm:justify-self-end">
                    {relativeTime(event.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <UsageList
        title="Agent attribution"
        empty="No task-linked settled prompts yet."
        rows={agentUsageRows}
        budgetCurrency={data.budgetCurrency}
      />
    </div>
  );
}
