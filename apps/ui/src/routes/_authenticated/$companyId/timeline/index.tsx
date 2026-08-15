import { workTimelineApi, type WorkTimelineParams } from "@/api/workTimeline";
import { DomainStatus } from "@/components/patterns/DomainStatus";
import { DateRangePicker } from "@/components/patterns/DatePicker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useSidebar } from "@/context/SidebarContext";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import { queryKeys } from "@/lib/queryKeys";
import { formatDateTime, formatDurationMs } from "@/lib/utils";
import { WorkTimelineGantt } from "@/routes/_authenticated/$companyId/timeline/-WorkTimelineGantt";
import type { TaskExecutionRunStatus, WorkTimelineResult, WorkTimelineSpan } from "@paperclipai/shared";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  Bot,
  Clock3,
  GanttChartSquare,
  Search,
  X,
} from "lucide-react";
import { type RefObject, useEffect, useMemo, useRef, useState } from "react";

export const Route = createFileRoute("/_authenticated/$companyId/timeline/")({
  component: Timeline,
});

const ATTENTION_STATUSES = new Set<TaskExecutionRunStatus>(["failed", "interrupted", "timed_out"]);
const ACTIVE_STATUSES = new Set<TaskExecutionRunStatus>(["queued", "scheduled_retry", "running"]);

type RangePreset = "today" | "7d" | "30d" | "custom";
type StatusFilter = "all" | "active" | "succeeded" | "attention" | "cancelled";

interface DateRangeState {
  fromDate: string;
  toDate: string;
}

interface VisibleTimelineWindow {
  fromMs: number;
  toMs: number;
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
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

function parsedCalendarRange(range: DateRangeState) {
  if (!range.fromDate || !range.toDate) return null;
  const from = new Date(`${range.fromDate}T00:00:00`);
  const to = new Date(`${range.toDate}T23:59:59.999`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) return null;
  return { from, to };
}

function resolveDateRange(range: DateRangeState): {
  window: Pick<WorkTimelineParams, "from" | "to"> | null;
  error: string | null;
} {
  if (!range.fromDate || !range.toDate) {
    return { window: null, error: "Choose a start and end date." };
  }
  const parsed = parsedCalendarRange(range);
  if (!parsed) return { window: null, error: "Start date must be before end date." };
  const lastAllowedDay = new Date(parsed.from);
  lastAllowedDay.setDate(lastAllowedDay.getDate() + 30);
  lastAllowedDay.setHours(23, 59, 59, 999);
  if (parsed.to > lastAllowedDay) {
    return { window: null, error: "Timeline windows can be up to 31 days." };
  }
  return {
    window: { from: parsed.from.toISOString(), to: parsed.to.toISOString() },
    error: null,
  };
}

function dataWindow(data: WorkTimelineResult): VisibleTimelineWindow {
  return {
    fromMs: new Date(data.window.from).getTime(),
    toMs: new Date(data.window.to).getTime(),
  };
}

function statusMatches(status: TaskExecutionRunStatus, filter: StatusFilter) {
  if (filter === "all") return true;
  if (filter === "active") return ACTIVE_STATUSES.has(status);
  if (filter === "attention") return ATTENTION_STATUSES.has(status);
  return status === filter;
}

export function filterTimelineData(
  data: WorkTimelineResult,
  search: string,
  statusFilter: StatusFilter,
): WorkTimelineResult {
  const query = search.trim().toLocaleLowerCase();
  if (!query && statusFilter === "all") return data;

  const queryMatchedTaskIds = new Set<string>();
  if (query) {
    const actorById = new Map(data.actors.map((actor) => [actor.id, actor]));
    for (const span of data.spans) {
      const actor = actorById.get(span.actorId);
      if (
        [span.taskIdentifier, span.taskTitle, actor?.name, span.status, span.kind].some((value) =>
          value?.toLocaleLowerCase().includes(query),
        )
      ) {
        queryMatchedTaskIds.add(span.taskId);
      }
    }
    for (const event of data.events) {
      const actor = actorById.get(event.actorId);
      if (
        [actor?.name, event.kind, event.taskId].some((value) => value?.toLocaleLowerCase().includes(query))
      ) {
        queryMatchedTaskIds.add(event.taskId);
      }
    }
    for (const edge of data.edges) {
      const fromActor = actorById.get(edge.fromActorId);
      const toActor = actorById.get(edge.toActorId);
      if (
        [fromActor?.name, toActor?.name, edge.kind, edge.taskId].some((value) =>
          value?.toLocaleLowerCase().includes(query),
        )
      ) {
        queryMatchedTaskIds.add(edge.taskId);
      }
    }
  }

  const spans = data.spans.filter((span) => {
    if (!statusMatches(span.status, statusFilter)) return false;
    if (!query) return true;
    return queryMatchedTaskIds.has(span.taskId);
  });

  const taskIds = new Set(spans.map((span) => span.taskId));
  if (query && statusFilter === "all") {
    for (const taskId of queryMatchedTaskIds) taskIds.add(taskId);
  }
  const events = data.events.filter((event) => taskIds.has(event.taskId));
  const edges = data.edges.filter((edge) => taskIds.has(edge.taskId));
  const actorIds = new Set<string>();
  for (const span of spans) actorIds.add(span.actorId);
  for (const event of events) actorIds.add(event.actorId);
  for (const edge of edges) {
    actorIds.add(edge.fromActorId);
    actorIds.add(edge.toActorId);
  }

  return {
    ...data,
    spans,
    events,
    edges,
    actors: data.actors.filter((actor) => actorIds.has(actor.id)),
  };
}

export function timelineSummary(data: WorkTimelineResult, visibleWindow?: VisibleTimelineWindow) {
  const actorById = new Map(data.actors.map((actor) => [actor.id, actor]));
  const activeAgentIds = new Set<string>();
  const fullWindow = dataWindow(data);
  const requestedWindow = visibleWindow ?? fullWindow;
  const windowFromMs = Math.max(fullWindow.fromMs, Math.min(fullWindow.toMs, requestedWindow.fromMs));
  const windowToMs = Math.max(windowFromMs, Math.min(fullWindow.toMs, requestedWindow.toMs));
  let activeMs = 0;
  let runs = 0;
  let attention = 0;

  for (const span of data.spans) {
    const rawStartMs = new Date(span.start).getTime();
    const rawEndMs = span.end ? new Date(span.end).getTime() : fullWindow.toMs;
    const startMs = Math.max(rawStartMs, windowFromMs);
    const endMs = Math.min(rawEndMs, windowToMs);
    const clippedMs = Math.max(0, endMs - startMs);
    if (clippedMs <= 0) continue;
    runs += 1;
    if (ATTENTION_STATUSES.has(span.status)) attention += 1;
    if (actorById.get(span.actorId)?.type === "agent") activeAgentIds.add(span.actorId);
    activeMs += clippedMs;
  }

  const activity = data.events.filter((event) => {
    const atMs = new Date(event.at).getTime();
    return atMs >= windowFromMs && atMs <= windowToMs;
  }).length;
  const relationships = data.edges.filter((edge) => {
    const atMs = new Date(edge.at).getTime();
    return atMs >= windowFromMs && atMs <= windowToMs;
  }).length;

  return { runs, agents: activeAgentIds.size, activeMs, activity, relationships, attention };
}

function SelectedRunDetails({
  companyId,
  data,
  span,
  onClose,
  sectionRef,
}: {
  companyId: string;
  data: WorkTimelineResult;
  span: WorkTimelineSpan;
  onClose: () => void;
  sectionRef: RefObject<HTMLElement | null>;
}) {
  const actor = data.actors.find((candidate) => candidate.id === span.actorId);
  const start = new Date(span.start);
  const end = span.end ? new Date(span.end) : new Date(data.window.to);
  const duration = formatDurationMs(Math.max(0, end.getTime() - start.getTime()));

  return (
    <section
      ref={sectionRef}
      className="border-t bg-muted/30 p-3 outline-none"
      aria-labelledby="selected-run-title"
      aria-live="polite"
      tabIndex={-1}
    >
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <DomainStatus status={span.status} />
            <Badge variant="outline">{span.kind.replaceAll("_", " ")}</Badge>
            {span.retryOfRunId ? <Badge variant="outline">Retry</Badge> : null}
            <h3 id="selected-run-title" className="min-w-0 truncate text-sm font-semibold">
              {span.taskIdentifier} · {span.taskTitle ?? `Task ${span.taskNumber}`}
            </h3>
          </div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs md:grid-cols-4">
            <div>
              <dt className="text-muted-foreground">Actor</dt>
              <dd className="truncate font-medium">{actor?.name ?? "Unknown actor"}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Started</dt>
              <dd className="truncate font-mono" title={formatDateTime(start)}>
                {formatDateTime(start)}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Duration</dt>
              <dd className="font-mono">{span.end ? duration : `${duration} so far`}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Run</dt>
              <dd className="truncate font-mono" title={span.runId}>
                {span.runId}
              </dd>
            </div>
          </dl>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button asChild size="sm">
            <Link
              to="/$companyId/tasks/$taskNumber"
              params={{ companyId, taskNumber: String(span.taskNumber) }}
            >
              Open task
              <ArrowUpRight data-icon="inline-end" />
            </Link>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label="Close run details"
          >
            <X data-icon="inline-start" />
          </Button>
        </div>
      </div>
    </section>
  );
}

function Timeline() {
  const { setRouteRequestsCollapsed } = useSidebar();
  const companyId = useCompanyRouteId();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [rangePreset, setRangePreset] = useState<RangePreset>("7d");
  const [dateRange, setDateRange] = useState<DateRangeState>(() => presetRange("7d"));
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [taskOffset, setTaskOffset] = useState(0);
  const selectedDetailsRef = useRef<HTMLElement>(null);

  useEffect(() => {
    setRouteRequestsCollapsed(true);
    return () => setRouteRequestsCollapsed(false);
  }, [setRouteRequestsCollapsed]);

  useEffect(() => {
    setBreadcrumbs([{ label: "Timeline" }]);
  }, [setBreadcrumbs]);

  const resolvedDateRange = useMemo(() => resolveDateRange(dateRange), [dateRange]);
  const dateRangeError = resolvedDateRange.error;
  const params: WorkTimelineParams | null = useMemo(() => {
    if (!resolvedDateRange.window) return null;
    return { ...resolvedDateRange.window, limit: 200, offset: taskOffset };
  }, [resolvedDateRange, taskOffset]);

  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: [...queryKeys.workTimeline(companyId), dateRange.fromDate, dateRange.toDate, taskOffset],
    queryFn: () => workTimelineApi.get(companyId, params!),
    enabled: !!params,
  });

  const filteredData = useMemo(
    () => (data ? filterTimelineData(data, search, statusFilter) : null),
    [data, search, statusFilter],
  );
  const rawSummary = data ? timelineSummary(data) : null;
  const summary = filteredData ? timelineSummary(filteredData) : null;
  const selectedSpan = filteredData?.spans.find((span) => span.runId === selectedRunId) ?? null;
  const rawActivityCount =
    (rawSummary?.runs ?? 0) + (rawSummary?.activity ?? 0) + (rawSummary?.relationships ?? 0);
  const visibleActivityCount =
    (summary?.runs ?? 0) + (summary?.activity ?? 0) + (summary?.relationships ?? 0);

  useEffect(() => {
    const details = selectedDetailsRef.current;
    if (!selectedSpan || !details) return;
    const frame = window.requestAnimationFrame(() => {
      details.focus({ preventScroll: true });
      if (typeof details.scrollIntoView === "function") {
        details.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [selectedSpan]);

  const clearFilters = () => {
    setSearch("");
    setStatusFilter("all");
    setSelectedRunId(null);
  };

  const applyPreset = (next: Exclude<RangePreset, "custom">) => {
    setRangePreset(next);
    setDateRange(presetRange(next));
    setSelectedRunId(null);
    setTaskOffset(0);
  };

  const rangeControls = (
    <div className="flex min-w-0 flex-wrap items-center gap-2" aria-label="Timeline date range">
      <span className="text-xs font-medium text-muted-foreground">Window</span>
      <ToggleGroup
        type="single"
        value={rangePreset}
        onValueChange={(next) => {
          if (next === "today" || next === "7d" || next === "30d") applyPreset(next);
        }}
        variant="outline"
        size="sm"
        aria-label="Date range presets"
      >
        <ToggleGroupItem value="today">Today</ToggleGroupItem>
        <ToggleGroupItem value="7d">7 days</ToggleGroupItem>
        <ToggleGroupItem value="30d">30 days</ToggleGroupItem>
      </ToggleGroup>
      <DateRangePicker
        value={{ from: dateRange.fromDate, to: dateRange.toDate }}
        onValueChange={({ from, to }) => {
          setRangePreset("custom");
          setDateRange({ fromDate: from, toDate: to });
          setSelectedRunId(null);
          setTaskOffset(0);
        }}
        ariaLabel="Custom timeline date range"
        size="sm"
        className="w-full sm:w-auto"
      />
    </div>
  );

  const summaryStats = summary
    ? [
        { label: "Runs", value: formatInteger(summary.runs), icon: GanttChartSquare },
        { label: "Agents", value: formatInteger(summary.agents), icon: Bot },
        { label: "Run time", value: formatDurationMs(summary.activeMs), icon: Clock3 },
        {
          label: "Activity",
          value: formatInteger(summary.activity + summary.relationships),
          icon: Activity,
        },
      ]
    : [];

  return (
    <div className="flex min-h-0 flex-col gap-4">
      <header className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Work timeline</h1>
          <p className="text-sm text-muted-foreground">
            Inspect execution timing, activity, and collaboration across the company.
          </p>
        </div>
        {rangeControls}
      </header>

      {summary ? (
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4" aria-label="Timeline summary">
          {summaryStats.map((stat) => {
            const Icon = stat.icon;
            return (
              <div key={stat.label} className="flex items-center gap-3 rounded-lg border bg-card p-3">
                <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <div className="min-w-0">
                  <p className="truncate text-lg font-semibold tabular-nums">{stat.value}</p>
                  <p className="text-xs text-muted-foreground">{stat.label}</p>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}

      <div className="min-w-0 overflow-hidden rounded-xl border bg-card">
        <div className="flex flex-wrap items-center gap-2 border-b p-3">
          <InputGroup className="w-full sm:max-w-sm">
            <InputGroupAddon>
              <Search aria-hidden="true" />
            </InputGroupAddon>
            <InputGroupInput
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setSelectedRunId(null);
              }}
              placeholder="Search tasks or actors"
              aria-label="Search timeline runs"
              disabled={!data}
            />
            {search ? (
              <InputGroupAddon align="inline-end">
                <InputGroupButton
                  size="icon-xs"
                  onClick={() => {
                    setSearch("");
                    setSelectedRunId(null);
                  }}
                  aria-label="Clear timeline search"
                >
                  <X aria-hidden="true" />
                </InputGroupButton>
              </InputGroupAddon>
            ) : null}
          </InputGroup>

          <NativeSelect
            size="sm"
            value={statusFilter}
            onChange={(event) => {
              setStatusFilter(event.target.value as StatusFilter);
              setSelectedRunId(null);
            }}
            aria-label="Filter timeline by run status"
            disabled={!data}
            className="w-full sm:w-auto"
          >
            <NativeSelectOption value="all">All statuses</NativeSelectOption>
            <NativeSelectOption value="active">Active</NativeSelectOption>
            <NativeSelectOption value="succeeded">Succeeded</NativeSelectOption>
            <NativeSelectOption value="attention">Needs attention</NativeSelectOption>
            <NativeSelectOption value="cancelled">Cancelled</NativeSelectOption>
          </NativeSelect>

          <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
            {isFetching && !isLoading ? <Spinner /> : null}
            {data ? (
              <span>
                {formatInteger(filteredData?.spans.length ?? 0)} of {formatInteger(data.spans.length)} runs
              </span>
            ) : null}
            {summary?.attention ? (
              <Badge variant="destructive">{summary.attention} need attention</Badge>
            ) : null}
          </div>
        </div>

        {error && data ? (
          <div
            className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-3 py-2 text-xs"
            role="alert"
          >
            <AlertTriangle className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="min-w-0 flex-1">Refresh failed. Showing the most recently loaded timeline.</span>
            <Button type="button" variant="ghost" size="sm" onClick={() => void refetch()}>
              Retry
            </Button>
          </div>
        ) : null}
        {data?.window.capped ? (
          <div className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-3 py-2 text-xs">
            <AlertTriangle className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            The server capped this request. The chart shows {formatDateTime(data.window.from)} through{" "}
            {formatDateTime(data.window.to)}.
          </div>
        ) : null}
        {data &&
        (data.pagination.hasMore ||
          data.pagination.offset > 0 ||
          data.pagination.totalTasks > data.pagination.limit) ? (
          <div className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-3 py-2 text-xs">
            <AlertTriangle className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              Showing tasks {formatInteger(data.pagination.offset + 1)}–
              {formatInteger(
                Math.min(data.pagination.offset + data.pagination.limit, data.pagination.totalTasks),
              )}{" "}
              of {formatInteger(data.pagination.totalTasks)}. Search and status filters apply to this page.
            </span>
            <ButtonGroup aria-label="Timeline task pages">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={data.pagination.offset === 0}
                onClick={() => {
                  setSelectedRunId(null);
                  setTaskOffset(Math.max(0, data.pagination.offset - data.pagination.limit));
                }}
              >
                Previous
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!data.pagination.hasMore}
                onClick={() => {
                  setSelectedRunId(null);
                  setTaskOffset(data.pagination.offset + data.pagination.limit);
                }}
              >
                Next
              </Button>
            </ButtonGroup>
          </div>
        ) : null}

        {dateRangeError ? (
          <Empty className="h-(--sz-560px) rounded-none border-0">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <GanttChartSquare aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle>{dateRangeError}</EmptyTitle>
              <EmptyDescription>Adjust the window above to load company activity.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : isLoading && !data ? (
          <Skeleton className="h-(--sz-560px) w-full rounded-none" />
        ) : error && !data ? (
          <Empty className="h-(--sz-560px) rounded-none border-0">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <AlertTriangle aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle>Couldn&apos;t load the work timeline</EmptyTitle>
              <EmptyDescription>
                Check the connection and try again. Your range and filters are preserved.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button type="button" variant="outline" onClick={() => void refetch()}>
                Try again
              </Button>
            </EmptyContent>
          </Empty>
        ) : data && rawActivityCount === 0 ? (
          <Empty className="h-(--sz-560px) rounded-none border-0">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <GanttChartSquare aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle>No work recorded in this window</EmptyTitle>
              <EmptyDescription>
                Choose a wider window to look for runs and operator activity.
              </EmptyDescription>
            </EmptyHeader>
            {rangePreset !== "30d" ? (
              <EmptyContent>
                <Button type="button" variant="outline" onClick={() => applyPreset("30d")}>
                  Show 30 days
                </Button>
              </EmptyContent>
            ) : null}
          </Empty>
        ) : data && filteredData && visibleActivityCount === 0 ? (
          <Empty className="h-(--sz-560px) rounded-none border-0">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Search aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle>No runs match these filters</EmptyTitle>
              <EmptyDescription>Try a different task, actor, or status.</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button type="button" variant="outline" onClick={clearFilters}>
                Clear filters
              </Button>
            </EmptyContent>
          </Empty>
        ) : filteredData ? (
          <>
            <WorkTimelineGantt
              key={`${filteredData.window.from}:${filteredData.window.to}`}
              data={filteredData}
              selectedRunId={selectedRunId}
              onSelectRun={setSelectedRunId}
            />
            {selectedSpan ? (
              <SelectedRunDetails
                companyId={companyId}
                data={filteredData}
                span={selectedSpan}
                onClose={() => setSelectedRunId(null)}
                sectionRef={selectedDetailsRef}
              />
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
