import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle } from "lucide-react";
import { Bar, BarChart, CartesianGrid, XAxis } from "recharts";
import type { UserProfileDailyPoint, UserProfileWindowStats } from "@paperclipai/shared";
import { getRouteApi, Link } from "@tanstack/react-router";
import { userProfilesApi } from "@/api/userProfiles";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item";
import { Skeleton } from "@/components/ui/skeleton";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { queryKeys } from "@/lib/queryKeys";
import { DomainStatus } from "@/components/patterns/DomainStatus";
import { formatDate, formatMoneyAmount, formatNumber, formatShortDate, relativeTime } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/$companyId/u/$userId/")({
  component: UserProfile,
});

const route = getRouteApi("/_authenticated/$companyId/u/$userId/");

function initials(name: string | null | undefined) {
  const value = name?.trim() || "User";
  const parts = value.split(/\s+/).filter(Boolean);
  if (parts.length > 1) return `${parts[0]?.[0] ?? ""}${parts[parts.length - 1]?.[0] ?? ""}`.toUpperCase();
  return value.slice(0, 2).toUpperCase();
}

function promptCount(stats: Pick<UserProfileWindowStats, "pricedPromptCount" | "unpricedPromptCount">) {
  return stats.pricedPromptCount + stats.unpricedPromptCount;
}

function completionRate(stats: UserProfileWindowStats) {
  if (stats.touchedTasks === 0) return "0%";
  return `${Math.round((stats.completedTasks / stats.touchedTasks) * 100)}%`;
}

function HeroStat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-2xl font-semibold tabular-nums sm:text-3xl">{value}</div>
      <div className="mt-1 text-(length:--text-micro) font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      {hint ? <div className="mt-0.5 text-xs text-muted-foreground/70">{hint}</div> : null}
    </div>
  );
}

function WindowColumn({ stats, budgetCurrency }: { stats: UserProfileWindowStats; budgetCurrency: string }) {
  const metrics: Array<[string, number]> = [
    ["Touched", stats.touchedTasks],
    ["Completed", stats.completedTasks],
    ["Comments", stats.commentCount],
    ["Actions", stats.activityCount],
  ];
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
        {metrics.map(([label, value]) => (
          <Item key={label} size="sm" className="min-w-0">
            <ItemContent>
              <ItemTitle className="truncate text-xl tabular-nums">{formatNumber(value)}</ItemTitle>
              <ItemDescription>{label}</ItemDescription>
            </ItemContent>
          </Item>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-x-5 gap-y-1.5 pt-3 text-xs tabular-nums text-muted-foreground">
        <span>Settled prompts</span>
        <span className="text-right text-foreground">{formatNumber(promptCount(stats))}</span>
        <span>Known cost</span>
        <span className="text-right text-foreground">
          {formatMoneyAmount(stats.knownCostAmount, budgetCurrency)}
        </span>
        <span>Unpriced</span>
        <span className="text-right text-foreground">{formatNumber(stats.unpricedPromptCount)}</span>
        <span>Created</span>
        <span className="text-right text-foreground">{formatNumber(stats.createdTasks)}</span>
        <span>Open</span>
        <span className="text-right text-foreground">{formatNumber(stats.assignedOpenTasks)}</span>
      </div>
    </div>
  );
}

function UsageChart({ points }: { points: UserProfileDailyPoint[] }) {
  const data = points.map((point) => ({
    ...point,
    prompts: point.pricedPromptCount + point.unpricedPromptCount,
  }));
  const totalPromptCount = data.reduce((sum, point) => sum + point.prompts, 0);
  const config = {
    prompts: { label: "Settled prompts", color: "var(--chart-1)" },
    completedTasks: { label: "Completed tasks", color: "var(--chart-2)" },
  } satisfies ChartConfig;

  return (
    <section>
      <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-border pb-3">
        <h2 className="text-sm font-semibold">Last 14 days</h2>
        <div className="flex items-baseline gap-4 text-xs text-muted-foreground">
          <span className="tabular-nums text-foreground">{formatNumber(totalPromptCount)}</span>
          <span>settled prompts</span>
        </div>
      </div>
      <ChartContainer config={config} className="mt-4 h-48 w-full aspect-auto">
        <BarChart accessibilityLayer data={data}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="date" tickFormatter={formatShortDate} tickLine={false} axisLine={false} />
          <ChartTooltip content={<ChartTooltipContent />} />
          <ChartLegend content={<ChartLegendContent />} />
          <Bar dataKey="prompts" fill="var(--color-prompts)" radius={4} />
          <Bar dataKey="completedTasks" fill="var(--color-completedTasks)" radius={4} />
        </BarChart>
      </ChartContainer>
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
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{rows.length} entries</CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <Empty className="py-6">
            <EmptyDescription>{empty}</EmptyDescription>
          </Empty>
        ) : (
          <ItemGroup>
            {rows.map((row) => (
              <Item key={row.key} size="sm">
                <ItemContent>
                  <ItemTitle>{row.label}</ItemTitle>
                  <ItemDescription>{row.sublabel}</ItemDescription>
                </ItemContent>
                <ItemActions className="text-xs tabular-nums">
                  <span className="text-muted-foreground">
                    {formatNumber(row.pricedPromptCount)} priced · {formatNumber(row.unpricedPromptCount)}{" "}
                    unpriced
                  </span>
                  <span className="font-medium">
                    {formatMoneyAmount(row.knownCostAmount, budgetCurrency)}
                  </span>
                </ItemActions>
              </Item>
            ))}
          </ItemGroup>
        )}
      </CardContent>
    </Card>
  );
}

function UserProfile() {
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
  const displayName = data?.user.name?.trim() || data?.user.email?.split("@")[0] || "User";

  const agentUsageRows = useMemo<UsageRow[]>(
    () =>
      (data?.topAgents ?? []).map((row) => ({
        key: row.agentId ?? "unknown",
        label: row.agentName ?? (row.agentId ? row.agentId.slice(0, 8) : "unknown"),
        sublabel: "Task-linked settled prompts",
        knownCostAmount: row.knownCostAmount,
        pricedPromptCount: row.pricedPromptCount,
        unpricedPromptCount: row.unpricedPromptCount,
      })),
    [data?.topAgents],
  );

  if (isLoading) {
    return <Skeleton className="h-32 w-full" />;
  }

  if (error || !data) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <AlertCircle  data-icon="inline-start"/>
          </EmptyMedia>
          <EmptyTitle>User profile not found for this company.</EmptyTitle>
        </EmptyHeader>
      </Empty>
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
            {data.user.image ? <AvatarImage src={data.user.image} alt={displayName} /> : null}
            <AvatarFallback className="text-lg font-semibold">{initials(displayName)}</AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-2xl font-semibold">{displayName}</h1>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
              {data.user.email ? <span className="truncate">{data.user.email}</span> : null}
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
                ? formatMoneyAmount(allTime.knownCostAmount, data.budgetCurrency)
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
          <WindowColumn key={entry.key} stats={entry} budgetCurrency={data.budgetCurrency} />
        ))}
      </section>

      <UsageChart points={data.daily} />

      <div className="grid gap-10 pt-2 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Recent tasks</CardTitle>
            <CardDescription>{data.recentTasks.length} touched tasks</CardDescription>
          </CardHeader>
          <CardContent>
            {data.recentTasks.length === 0 ? (
              <Empty className="py-6">
                <EmptyDescription>No touched tasks yet.</EmptyDescription>
              </Empty>
            ) : (
              <ItemGroup>
                {data.recentTasks.map((task) => {
                  return (
                    <Item key={task.id} asChild size="sm">
                      <Link
                        to="/$companyId/tasks/$taskNumber"
                        params={{
                          companyId,
                          taskNumber: String(task.taskNumber),
                        }}
                      >
                        <ItemContent>
                          <ItemTitle>{task.title}</ItemTitle>
                          <ItemDescription className="font-mono">{task.identifier}</ItemDescription>
                        </ItemContent>
                        <ItemActions>
                          <DomainStatus status={task.boardPresentationStatus} />
                          <span className="text-xs tabular-nums text-muted-foreground">
                            {relativeTime(task.updatedAt)}
                          </span>
                        </ItemActions>
                      </Link>
                    </Item>
                  );
                })}
              </ItemGroup>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent activity</CardTitle>
            <CardDescription>{data.recentActivity.length} direct actions</CardDescription>
          </CardHeader>
          <CardContent>
            {data.recentActivity.length === 0 ? (
              <Empty className="py-6">
                <EmptyDescription>No direct user actions recorded yet.</EmptyDescription>
              </Empty>
            ) : (
              <ItemGroup>
                {data.recentActivity.map((event) => (
                  <Item key={event.id} size="sm">
                    <ItemContent>
                      <ItemTitle>{event.action.replaceAll("_", " ")}</ItemTitle>
                      <ItemDescription>
                        {event.entityType} · {event.entityId.slice(0, 12)}
                      </ItemDescription>
                    </ItemContent>
                    <ItemActions className="text-xs tabular-nums text-muted-foreground">
                      {relativeTime(event.createdAt)}
                    </ItemActions>
                  </Item>
                ))}
              </ItemGroup>
            )}
          </CardContent>
        </Card>
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
