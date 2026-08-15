import { workTimelineApi, type WorkTimelineParams } from "@/api/workTimeline";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { WorkTimelineGantt } from "@/routes/_authenticated/$companyId/timeline/-WorkTimelineGantt";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Item, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useSidebar } from "@/context/SidebarContext";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import { queryKeys } from "@/lib/queryKeys";
import { formatDurationMs } from "@/lib/utils";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { WorkTimelineResult } from "@paperclipai/shared";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Bot, Clock3, GanttChartSquare, Minus, Plus, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
export const Route = createFileRoute("/_authenticated/$companyId/timeline/")({
  component: Timeline,
});

function formatInteger(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

type RangePreset = "today" | "7d" | "30d" | "custom";

interface DateRangeState {
  fromDate: string;
  toDate: string;
}

function dateInputValue(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function presetRange(preset: Exclude<RangePreset, "custom">, now = new Date()): DateRangeState {
  const from = new Date(now);
  const to = new Date(now);
  if (preset === "today") {
    return { fromDate: dateInputValue(from), toDate: dateInputValue(to) };
  }
  from.setDate(from.getDate() - (preset === "7d" ? 6 : 29));
  return { fromDate: dateInputValue(from), toDate: dateInputValue(to) };
}

function rangeWindow(range: DateRangeState): Pick<WorkTimelineParams, "from" | "to"> | null {
  if (!range.fromDate || !range.toDate) return null;
  const from = new Date(`${range.fromDate}T00:00:00`);
  const to = new Date(`${range.toDate}T23:59:59.999`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) {
    return null;
  }
  return { from: from.toISOString(), to: to.toISOString() };
}

function rangeError(range: DateRangeState): string | null {
  if (!range.fromDate || !range.toDate) return "Choose a start and end date.";
  if (!rangeWindow(range)) return "Start date must be before end date.";
  return null;
}

function dataWindow(data: WorkTimelineResult): VisibleTimelineWindow {
  return {
    fromMs: new Date(data.window.from).getTime(),
    toMs: new Date(data.window.to).getTime(),
  };
}

interface VisibleTimelineWindow {
  fromMs: number;
  toMs: number;
}

export function timelineSummary(
  data: WorkTimelineResult,
  visibleWindow: VisibleTimelineWindow = dataWindow(data),
) {
  const actorById = new Map(data.actors.map((actor) => [actor.id, actor]));
  const activeAgentIds = new Set<string>();
  const fullWindow = dataWindow(data);
  const windowFromMs = Math.max(fullWindow.fromMs, Math.min(fullWindow.toMs, visibleWindow.fromMs));
  const windowToMs = Math.max(windowFromMs, Math.min(fullWindow.toMs, visibleWindow.toMs));
  let activeMs = 0;
  let runs = 0;

  for (const span of data.spans) {
    const rawStartMs = new Date(span.start).getTime();
    const rawEndMs = span.end ? new Date(span.end).getTime() : fullWindow.toMs;
    const startMs = Math.max(rawStartMs, windowFromMs);
    const endMs = Math.min(rawEndMs, windowToMs);
    const clippedMs = Math.max(0, endMs - startMs);
    if (clippedMs <= 0) continue;
    runs += 1;
    if (actorById.get(span.actorId)?.type === "agent") {
      activeAgentIds.add(span.actorId);
    }
    activeMs += clippedMs;
  }

  return { runs, agents: activeAgentIds.size, activeMs };
}

function Timeline() {
  const { setRouteRequestsCollapsed } = useSidebar();
  useEffect(() => {
    setRouteRequestsCollapsed(true);
    return () => setRouteRequestsCollapsed(false);
  }, [setRouteRequestsCollapsed]);
  const companyId = useCompanyRouteId();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [zoom, setZoom] = useState(100);
  const [rangePreset, setRangePreset] = useState<RangePreset>("7d");
  const [dateRange, setDateRange] = useState<DateRangeState>(() => presetRange("7d"));

  useEffect(() => {
    setBreadcrumbs([{ label: "Timeline" }]);
  }, [setBreadcrumbs]);

  const dateRangeError = rangeError(dateRange);
  const params: WorkTimelineParams | null = useMemo(() => {
    const window = rangeWindow(dateRange);
    if (!window) return null;
    return window;
  }, [dateRange]);

  const { data, isLoading, error } = useQuery({
    queryKey: [...queryKeys.workTimeline(companyId), dateRange.fromDate, dateRange.toDate],
    queryFn: () => workTimelineApi.get(companyId, params!),
    enabled: !!params,
  });

  const header = (
    <div className="flex items-center gap-2">
      <GanttChartSquare className="h-6 w-6 text-muted-foreground" />
      <h1 className="text-3xl font-semibold tracking-tight">Work Timeline</h1>
    </div>
  );

  const adjustZoom = (factor: number) => {
    setZoom((current) => Math.max(50, Math.min(200, Math.round(current * factor))));
  };

  const resetZoom = () => {
    setZoom(100);
  };

  const summary = data ? timelineSummary(data) : null;
  const summaryStats = summary
    ? [
        {
          label: "Runs",
          value: formatInteger(summary.runs),
          icon: GanttChartSquare,
        },
        {
          label: "Agents",
          value: formatInteger(summary.agents),
          icon: Bot,
        },
        {
          label: "Run time",
          value: formatDurationMs(summary.activeMs),
          icon: Clock3,
        },
      ]
    : [];

  const rangeControls = (
    <ButtonGroup
      className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground"
      aria-label="Timeline date range"
    >
      <span>Range</span>
      <ToggleGroup
        type="single"
        value={rangePreset}
        onValueChange={(next) => {
          if (next !== "today" && next !== "7d" && next !== "30d") return;
          setRangePreset(next);
          setDateRange(presetRange(next));
        }}
        variant="outline"
        size="sm"
      >
        <ToggleGroupItem value="today">Today</ToggleGroupItem>
        <ToggleGroupItem value="7d">7 days</ToggleGroupItem>
        <ToggleGroupItem value="30d">30 days</ToggleGroupItem>
      </ToggleGroup>
      <Input
        type="date"
        value={dateRange.fromDate}
        onChange={(event) => {
          setRangePreset("custom");
          setDateRange((prev) => ({
            ...prev,
            fromDate: event.target.value,
          }));
        }}
        className="h-8 w-(--sz-150px) text-xs"
        aria-label="Timeline start date"
      />
      <span>to</span>
      <Input
        type="date"
        value={dateRange.toDate}
        onChange={(event) => {
          setRangePreset("custom");
          setDateRange((prev) => ({ ...prev, toDate: event.target.value }));
        }}
        className="h-8 w-(--sz-150px) text-xs"
        aria-label="Timeline end date"
      />
    </ButtonGroup>
  );

  const toolbar = (
    <div className="flex flex-wrap items-start gap-3">
      {summary && (
        <ItemGroup className="grid flex-1 grid-cols-2 gap-3 border-y py-3 md:grid-cols-3">
          {summaryStats.map((stat) => {
            const Icon = stat.icon;
            return (
              <Item key={stat.label} size="sm" className="border-0 p-0">
                <ItemMedia>
                  <Icon className="size-4 text-muted-foreground" />
                </ItemMedia>
                <ItemContent className="min-w-0">
                  <ItemTitle className="truncate text-lg tabular-nums">{stat.value}</ItemTitle>
                  <ItemDescription className="text-xs">{stat.label}</ItemDescription>
                </ItemContent>
              </Item>
            );
          })}
        </ItemGroup>
      )}
      <div className="ml-auto flex items-center gap-1 pt-3" aria-label="Timeline zoom controls">
        <Button
          type="button"
          variant="outline"
          size="icon-xs"
          onClick={() => adjustZoom(0.8)}
          aria-label="Zoom out"
          title="Zoom out"
        >
          <Minus className="h-3 w-3" />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon-xs"
          onClick={() => adjustZoom(1.25)}
          aria-label="Zoom in"
          title="Zoom in"
        >
          <Plus className="h-3 w-3" />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon-xs"
          onClick={resetZoom}
          aria-label="Reset zoom"
          title="Reset zoom"
        >
          <RotateCcw className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      {header}
      {toolbar}

      {isLoading && <Skeleton className="h-32 w-full" />}

      {dateRangeError && (
        <div className="space-y-3">
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <GanttChartSquare />
              </EmptyMedia>
              <EmptyTitle>{dateRangeError}</EmptyTitle>
            </EmptyHeader>
          </Empty>
          <div className="flex flex-wrap items-center justify-end gap-3">{rangeControls}</div>
        </div>
      )}

      {error && (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <GanttChartSquare />
            </EmptyMedia>
            <EmptyTitle>
              Couldn&apos;t load the timeline. The aggregation endpoint may be unavailable.
            </EmptyTitle>
          </EmptyHeader>
        </Empty>
      )}

      {data &&
        !isLoading &&
        !dateRangeError &&
        (data.spans.length === 0 ? (
          <div className="space-y-3">
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <GanttChartSquare />
                </EmptyMedia>
                <EmptyTitle>No activity in this window.</EmptyTitle>
              </EmptyHeader>
            </Empty>
            <div className="flex flex-wrap items-center justify-end gap-3">{rangeControls}</div>
          </div>
        ) : (
          <div className="space-y-3">
            <WorkTimelineGantt data={data} zoom={zoom} />
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                {data.spans.length} run{data.spans.length === 1 ? "" : "s"} ·{" "}
                {new Date(data.window.from).toLocaleString()} to {new Date(data.window.to).toLocaleString()}
                {data.window.capped ? " · window capped" : ""}
              </p>
              {rangeControls}
            </div>
          </div>
        ))}
    </div>
  );
}
