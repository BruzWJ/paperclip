import type { DashboardRunActivityDay, TaskExecutionRunEnvelopeRecord } from "@paperclipai/shared";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";

export function getLast14Days(): string[] {
  return Array.from({ length: 14 }, (_, index) => {
    const date = new Date();
    date.setDate(date.getDate() - (13 - index));
    return date.toISOString().slice(0, 10);
  });
}

function formatDayLabel(date: string): string {
  const value = new Date(`${date}T12:00:00`);
  return `${value.getMonth() + 1}/${value.getDate()}`;
}

function emptyRunDay(date: string): DashboardRunActivityDay {
  return {
    date,
    succeeded: 0,
    failed: 0,
    recovered: 0,
    other: 0,
    total: 0,
    failedByErrorCode: {},
  };
}

type RunChartProps =
  | { activity?: DashboardRunActivityDay[] | null; runs?: never }
  | { runs?: TaskExecutionRunEnvelopeRecord[] | null; activity?: never };

function aggregateRuns(runs: readonly TaskExecutionRunEnvelopeRecord[] = []): DashboardRunActivityDay[] {
  const grouped = new Map(getLast14Days().map((date) => [date, emptyRunDay(date)]));

  for (const run of runs) {
    const date = new Date(run.createdAt).toISOString().slice(0, 10);
    const entry = grouped.get(date);
    if (!entry) continue;

    if (run.status === "succeeded") {
      entry.succeeded += 1;
    } else if (run.status === "failed" || run.status === "timed_out") {
      entry.failed += 1;
      const code = run.terminalReasonCode?.trim() || "unknown";
      entry.failedByErrorCode[code] = (entry.failedByErrorCode[code] ?? 0) + 1;
    } else {
      entry.other += 1;
    }
    entry.total += 1;
  }

  return Array.from(grouped.values());
}

function resolveRunActivity(props: RunChartProps): DashboardRunActivityDay[] {
  if (Array.isArray(props.activity)) return props.activity;
  if (Array.isArray(props.runs)) return aggregateRuns(props.runs);
  return [];
}

function EmptyChart({ title }: { title: string }) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
      </EmptyHeader>
    </Empty>
  );
}

type ChartSeries = {
  key: string;
  stacked?: boolean;
};

function ActivityBarChart<TData extends { date: string }>({
  config,
  data,
  series,
  domain,
}: {
  config: ChartConfig;
  data: TData[];
  series: ChartSeries[];
  domain?: [number, number];
}) {
  const dates = data.map((entry) => String(entry.date));
  const ticks = [dates.at(0), dates.at(6), dates.at(-1)].filter((date): date is string => Boolean(date));

  return (
    <ChartContainer config={config} className="h-32 w-full aspect-auto">
      <BarChart accessibilityLayer data={data}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="date"
          ticks={ticks}
          tickFormatter={formatDayLabel}
          tickLine={false}
          axisLine={false}
        />
        {domain ? <YAxis hide domain={domain} /> : null}
        <ChartTooltip content={<ChartTooltipContent />} />
        <ChartLegend content={<ChartLegendContent />} />
        {series.map(({ key, stacked }) => (
          <Bar key={key} dataKey={key} fill={`var(--color-${key})`} stackId={stacked ? "total" : undefined} />
        ))}
      </BarChart>
    </ChartContainer>
  );
}

const RUN_CONFIG = {
  succeeded: { label: "Succeeded", color: "var(--chart-1)" },
  recovered: { label: "Recovered", color: "var(--chart-2)" },
  failed: { label: "Failed", color: "var(--chart-3)" },
  other: { label: "Other", color: "var(--chart-4)" },
} satisfies ChartConfig;

export function RunActivityChart(props: RunChartProps) {
  const activity = resolveRunActivity(props);
  if (!activity.some((entry) => entry.total > 0)) {
    return <EmptyChart title="No runs yet" />;
  }

  const hasRecovered = activity.some((entry) => entry.recovered > 0);
  return (
    <ActivityBarChart
      config={RUN_CONFIG}
      data={activity}
      series={[
        { key: "succeeded", stacked: true },
        ...(hasRecovered ? [{ key: "recovered", stacked: true }] : []),
        { key: "failed", stacked: true },
        { key: "other", stacked: true },
      ]}
    />
  );
}

const PRIORITIES = ["critical", "high", "medium", "low"] as const;
const PRIORITY_CONFIG = {
  critical: { label: "Critical", color: "var(--chart-1)" },
  high: { label: "High", color: "var(--chart-2)" },
  medium: { label: "Medium", color: "var(--chart-3)" },
  low: { label: "Low", color: "var(--chart-4)" },
} satisfies ChartConfig;

export function PriorityChart({ tasks }: { tasks: { priority: string; createdAt: Date }[] }) {
  const grouped = new Map(
    getLast14Days().map((date) => [date, { date, critical: 0, high: 0, medium: 0, low: 0 }]),
  );

  for (const task of tasks) {
    const entry = grouped.get(new Date(task.createdAt).toISOString().slice(0, 10));
    if (entry && PRIORITIES.includes(task.priority as (typeof PRIORITIES)[number])) {
      entry[task.priority as (typeof PRIORITIES)[number]] += 1;
    }
  }

  const data = Array.from(grouped.values());
  if (!data.some((entry) => PRIORITIES.some((key) => entry[key] > 0))) {
    return <EmptyChart title="No tasks" />;
  }

  return (
    <ActivityBarChart
      config={PRIORITY_CONFIG}
      data={data}
      series={PRIORITIES.map((key) => ({ key, stacked: true }))}
    />
  );
}

const STATUS_ORDER = ["todo", "in_progress", "in_review", "done", "blocked", "cancelled", "backlog"] as const;

const STATUS_CONFIG = Object.fromEntries(
  STATUS_ORDER.map((status, index) => [
    status,
    {
      label: status.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase()),
      color: `var(--chart-${(index % 5) + 1})`,
    },
  ]),
) satisfies ChartConfig;

export function TaskStatusChart({
  tasks,
}: {
  tasks: { boardPresentationStatus: string; createdAt: Date }[];
}) {
  const grouped = new Map<string, { date: string } & Record<string, string | number>>(
    getLast14Days().map((date) => [date, { date }]),
  );
  const presentStatuses = new Set<string>();

  for (const task of tasks) {
    const entry = grouped.get(new Date(task.createdAt).toISOString().slice(0, 10));
    if (!entry) continue;
    const status = task.boardPresentationStatus;
    entry[status] = Number(entry[status] ?? 0) + 1;
    presentStatuses.add(status);
  }

  if (presentStatuses.size === 0) return <EmptyChart title="No tasks" />;
  const series = STATUS_ORDER.filter((status) => presentStatuses.has(status));

  return (
    <ActivityBarChart
      config={STATUS_CONFIG}
      data={Array.from(grouped.values())}
      series={series.map((key) => ({ key, stacked: true }))}
    />
  );
}

const SUCCESS_CONFIG = {
  rate: { label: "Success rate (%)", color: "var(--chart-1)" },
} satisfies ChartConfig;

export function SuccessRateChart(props: RunChartProps) {
  const activity = resolveRunActivity(props);
  if (!activity.some((entry) => entry.total > 0)) {
    return <EmptyChart title="No runs yet" />;
  }

  const data = activity.map((entry) => ({
    date: entry.date,
    rate: entry.total > 0 ? Math.round(((entry.succeeded + entry.recovered) / entry.total) * 100) : 0,
  }));

  return (
    <ActivityBarChart config={SUCCESS_CONFIG} data={data} series={[{ key: "rate" }]} domain={[0, 100]} />
  );
}
