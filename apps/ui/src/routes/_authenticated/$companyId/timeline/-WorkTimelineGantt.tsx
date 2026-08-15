import type {
  TaskExecutionRunStatus,
  WorkTimelineActor,
  WorkTimelineResult,
  WorkTimelineSpan,
} from "@paperclipai/shared";
import {
  Ban,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clock3,
  LocateFixed,
  Minus,
  Play,
  Plus,
  RotateCcw,
  TimerOff,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import {
  GanttFeatureItem,
  GanttFeatureList,
  GanttFeatureListGroup,
  GanttHeader,
  GanttMarker,
  GanttProvider,
  GanttSidebar,
  GanttSidebarGroup,
  GanttSidebarItem,
  GanttTimeline,
  GanttToday,
  type GanttFeature,
  type GanttStatus,
} from "@/components/kibo-ui/gantt";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn, formatDateTime, formatDurationMs } from "@/lib/utils";

interface RunStatusPresentation {
  gantt: GanttStatus;
  icon: LucideIcon;
  featureClassName: string;
}

const runStatuses: Record<TaskExecutionRunStatus, RunStatusPresentation> = {
  queued: {
    gantt: { id: "queued", name: "Queued", color: "var(--muted-foreground)" },
    icon: Clock3,
    featureClassName: "[&_[data-slot=card]]:border-muted-foreground/50",
  },
  scheduled_retry: {
    gantt: { id: "scheduled_retry", name: "Scheduled retry", color: "var(--chart-4)" },
    icon: RotateCcw,
    featureClassName: "[&_[data-slot=card]]:border-chart-4",
  },
  running: {
    gantt: { id: "running", name: "Running", color: "var(--primary)" },
    icon: Play,
    featureClassName: "[&_[data-slot=card]]:border-primary",
  },
  succeeded: {
    gantt: { id: "succeeded", name: "Succeeded", color: "var(--chart-2)" },
    icon: CheckCircle2,
    featureClassName: "[&_[data-slot=card]]:border-chart-2",
  },
  interrupted: {
    gantt: { id: "interrupted", name: "Interrupted", color: "var(--destructive)" },
    icon: CircleAlert,
    featureClassName: "[&_[data-slot=card]]:border-destructive",
  },
  failed: {
    gantt: { id: "failed", name: "Failed", color: "var(--destructive)" },
    icon: XCircle,
    featureClassName: "[&_[data-slot=card]]:border-destructive",
  },
  cancelled: {
    gantt: { id: "cancelled", name: "Cancelled", color: "var(--muted-foreground)" },
    icon: Ban,
    featureClassName: "[&_[data-slot=card]]:border-muted-foreground/50",
  },
  timed_out: {
    gantt: { id: "timed_out", name: "Timed out", color: "var(--destructive)" },
    icon: TimerOff,
    featureClassName: "[&_[data-slot=card]]:border-destructive",
  },
};

interface TimelineFeature extends GanttFeature {
  actor: WorkTimelineActor;
  span: WorkTimelineSpan;
}

interface ActorFeatureGroup {
  actor: WorkTimelineActor;
  features: TimelineFeature[];
  latestActivityMs: number;
  activityCount: number;
}

interface TimelineActivityPoint {
  at: string;
  label: string;
}

export interface TimelineMarkerCluster {
  id: string;
  date: Date;
  label: string;
  count: number;
}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const MAX_MARKERS = 8;
const DAILY_COLUMN_WIDTH = 50;
const ZOOM_STEPS = [150, 300, 600, 1200, 2400, 4800, 6400] as const;

function validDate(value: string): Date | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function timelineWindow(data: WorkTimelineResult) {
  const start = validDate(data.window.from) ?? new Date();
  const end = validDate(data.window.to) ?? start;
  return { start, end, fromMs: start.getTime(), toMs: end.getTime() };
}

function spanEndMs(span: WorkTimelineSpan, windowEndMs: number) {
  return span.end ? (validDate(span.end)?.getTime() ?? windowEndMs) : windowEndMs;
}

function isWithinWindow(atMs: number, windowFromMs: number, windowToMs: number) {
  return atMs >= windowFromMs && atMs <= windowToMs;
}

function taskLabel(span: WorkTimelineSpan): string {
  return `${span.taskIdentifier} · ${span.taskTitle ?? `Task ${span.taskNumber}`}`;
}

function featureFromSpan(
  span: WorkTimelineSpan,
  actor: WorkTimelineActor,
  windowStart: Date,
  windowEnd: Date,
): TimelineFeature | null {
  const parsedStart = validDate(span.start);
  if (!parsedStart) return null;
  const parsedEnd = span.end ? validDate(span.end) : windowEnd;
  const rawEndMs = parsedEnd?.getTime() ?? windowEnd.getTime();
  if (rawEndMs < windowStart.getTime() || parsedStart.getTime() > windowEnd.getTime()) return null;
  const clippedStartMs = Math.max(parsedStart.getTime(), windowStart.getTime());
  const clippedEndMs = Math.min(rawEndMs, windowEnd.getTime());
  const startAt = new Date(clippedStartMs);
  const endAt = new Date(Math.max(clippedStartMs, clippedEndMs));

  return {
    id: span.runId,
    name: taskLabel(span),
    startAt,
    endAt,
    status: runStatuses[span.status].gantt,
    actor,
    span,
  };
}

function activityExtentMs(data: WorkTimelineResult): { fromMs: number; toMs: number } {
  const { fromMs: windowFromMs, toMs: windowToMs } = timelineWindow(data);
  const points: number[] = [];

  for (const span of data.spans) {
    const startMs = validDate(span.start)?.getTime();
    if (startMs === undefined) continue;
    const endMs = spanEndMs(span, windowToMs);
    if (endMs < windowFromMs || startMs > windowToMs) continue;
    points.push(Math.max(windowFromMs, startMs), Math.min(windowToMs, endMs));
  }
  for (const event of data.events) {
    const atMs = validDate(event.at)?.getTime();
    if (atMs !== undefined && isWithinWindow(atMs, windowFromMs, windowToMs)) points.push(atMs);
  }
  for (const edge of data.edges) {
    const atMs = validDate(edge.at)?.getTime();
    if (atMs !== undefined && isWithinWindow(atMs, windowFromMs, windowToMs)) points.push(atMs);
  }

  if (points.length === 0) return { fromMs: windowFromMs, toMs: windowToMs };
  return {
    fromMs: Math.min(...points),
    toMs: Math.max(...points),
  };
}

function recommendedZoom(extent: { fromMs: number; toMs: number }): number {
  const durationMs = Math.max(MINUTE_MS, extent.toMs - extent.fromMs);
  if (durationMs <= 6 * HOUR_MS) return 4800;
  if (durationMs <= DAY_MS) return 2400;
  if (durationMs <= 3 * DAY_MS) return 1200;
  if (durationMs <= 10 * DAY_MS) return 600;
  return 300;
}

function focusDateForExtent(extent: { fromMs: number; toMs: number }): Date {
  return new Date(extent.fromMs + (extent.toMs - extent.fromMs) / 2);
}

function markerBucketMs(windowFromMs: number, windowToMs: number): number {
  const windowDurationMs = Math.max(MINUTE_MS, windowToMs - windowFromMs);
  const minimumBucketMs =
    windowDurationMs <= DAY_MS ? 2 * HOUR_MS : windowDurationMs <= 7 * DAY_MS ? 6 * HOUR_MS : DAY_MS;
  return Math.max(minimumBucketMs, Math.ceil(windowDurationMs / MAX_MARKERS));
}

export function clusterTimelineActivity(data: WorkTimelineResult): TimelineMarkerCluster[] {
  if (data.events.length === 0 && data.edges.length === 0) return [];
  const actorById = new Map(data.actors.map((actor) => [actor.id, actor]));
  const { fromMs: windowFromMs, toMs: windowToMs } = timelineWindow(data);
  const bucketMs = markerBucketMs(windowFromMs, windowToMs);
  const bucketCount = Math.min(MAX_MARKERS, Math.max(1, Math.ceil((windowToMs - windowFromMs) / bucketMs)));
  const buckets = new Map<number, TimelineActivityPoint[]>();

  const addPoint = (point: TimelineActivityPoint) => {
    const atMs = validDate(point.at)?.getTime();
    if (atMs === undefined || !isWithinWindow(atMs, windowFromMs, windowToMs)) return;
    const bucket = Math.min(bucketCount - 1, Math.floor((atMs - windowFromMs) / bucketMs));
    const current = buckets.get(bucket);
    if (current) current.push(point);
    else buckets.set(bucket, [point]);
  };

  for (const event of data.events) {
    const actorName = actorById.get(event.actorId)?.name;
    addPoint({
      at: event.at,
      label: `${actorName ? `${actorName} · ` : ""}${event.kind.replaceAll("_", " ")}`,
    });
  }
  for (const edge of data.edges) {
    const fromActorName = actorById.get(edge.fromActorId)?.name ?? "Unknown actor";
    const toActorName = actorById.get(edge.toActorId)?.name ?? "Unknown actor";
    addPoint({
      at: edge.at,
      label: `${fromActorName} → ${toActorName} · ${edge.kind.replaceAll("_", " ")}`,
    });
  }

  return Array.from(buckets.entries())
    .sort(([left], [right]) => left - right)
    .map(([bucket, points]) => {
      const ordered = [...points].sort((left, right) => left.at.localeCompare(right.at));
      const representative = ordered[Math.floor(ordered.length / 2)]!;
      const date =
        ordered.length === 1
          ? validDate(representative.at)!
          : new Date(Math.min(windowToMs, windowFromMs + (bucket + 0.5) * bucketMs));
      const label = ordered.length === 1 ? representative.label : `${ordered.length} activity items`;
      return {
        id: `activity:${bucket}:${representative.at}`,
        date,
        label,
        count: ordered.length,
      };
    });
}

function buildGroups(data: WorkTimelineResult): ActorFeatureGroup[] {
  const { start: windowStart, end: windowEnd } = timelineWindow(data);
  const actorById = new Map(data.actors.map((actor) => [actor.id, actor]));
  const referencedActorIds = new Set<string>();
  const latestActivityByActor = new Map<string, number>();
  const activityCountByActor = new Map<string, number>();
  const featuresByActor = new Map<string, TimelineFeature[]>();

  for (const span of data.spans) {
    const actor = actorById.get(span.actorId) ?? {
      id: span.actorId,
      type: "system" as const,
      name: "Unknown actor",
    };
    const feature = featureFromSpan(span, actor, windowStart, windowEnd);
    if (!feature) continue;
    referencedActorIds.add(span.actorId);
    const current = featuresByActor.get(span.actorId);
    if (current) current.push(feature);
    else featuresByActor.set(span.actorId, [feature]);
    latestActivityByActor.set(
      span.actorId,
      Math.max(latestActivityByActor.get(span.actorId) ?? 0, feature.endAt.getTime()),
    );
  }

  for (const event of data.events) {
    const atMs = validDate(event.at)?.getTime();
    if (atMs === undefined || !isWithinWindow(atMs, windowStart.getTime(), windowEnd.getTime())) continue;
    referencedActorIds.add(event.actorId);
    latestActivityByActor.set(event.actorId, Math.max(latestActivityByActor.get(event.actorId) ?? 0, atMs));
    activityCountByActor.set(event.actorId, (activityCountByActor.get(event.actorId) ?? 0) + 1);
  }

  for (const edge of data.edges) {
    const atMs = validDate(edge.at)?.getTime();
    if (atMs === undefined || !isWithinWindow(atMs, windowStart.getTime(), windowEnd.getTime())) continue;
    for (const actorId of [edge.fromActorId, edge.toActorId]) {
      referencedActorIds.add(actorId);
      latestActivityByActor.set(actorId, Math.max(latestActivityByActor.get(actorId) ?? 0, atMs));
      activityCountByActor.set(actorId, (activityCountByActor.get(actorId) ?? 0) + 1);
    }
  }

  const actors = Array.from(referencedActorIds).map(
    (actorId) =>
      actorById.get(actorId) ?? {
        id: actorId,
        type: "system" as const,
        name: "Unknown actor",
      },
  );

  return actors
    .map((actor) => ({
      actor,
      latestActivityMs: latestActivityByActor.get(actor.id) ?? 0,
      activityCount: activityCountByActor.get(actor.id) ?? 0,
      features: (featuresByActor.get(actor.id) ?? []).sort(
        (left, right) => right.startAt.getTime() - left.startAt.getTime(),
      ),
    }))
    .sort(
      (left, right) =>
        right.latestActivityMs - left.latestActivityMs || left.actor.name.localeCompare(right.actor.name),
    );
}

function zoomStep(current: number, direction: "in" | "out"): number {
  if (direction === "in") {
    return ZOOM_STEPS.find((step) => step > current) ?? ZOOM_STEPS.at(-1)!;
  }
  return [...ZOOM_STEPS].reverse().find((step) => step < current) ?? ZOOM_STEPS[0];
}

function statusDuration(feature: TimelineFeature): string {
  return formatDurationMs(Math.max(0, feature.endAt.getTime() - feature.startAt.getTime()));
}

function countVisiblePoints(
  points: readonly { at: string }[],
  windowFromMs: number,
  windowToMs: number,
): number {
  return points.filter((point) => {
    const atMs = validDate(point.at)?.getTime();
    return atMs !== undefined && isWithinWindow(atMs, windowFromMs, windowToMs);
  }).length;
}

export interface WorkTimelineGanttProps {
  data: WorkTimelineResult;
  initialZoom?: number;
  selectedRunId?: string | null;
  onSelectRun?: (runId: string) => void;
}

function TimelineActivitySummary({
  runCount,
  eventCount,
  relationshipCount,
  className,
}: {
  runCount: number;
  eventCount: number;
  relationshipCount: number;
  className?: string;
}) {
  return (
    <div className={className}>
      <h2 className="text-sm font-medium">Execution timeline</h2>
      <p className="text-xs text-muted-foreground">
        {runCount} run{runCount === 1 ? "" : "s"} · {eventCount} activit
        {eventCount === 1 ? "y" : "ies"} · {relationshipCount} relationship
        {relationshipCount === 1 ? "" : "s"}
      </p>
    </div>
  );
}

/** Maps Paperclip's run/actor DTO onto Kibo's read-only, intraday-aware Gantt composition. */
export function WorkTimelineGantt({
  data,
  initialZoom,
  selectedRunId = null,
  onSelectRun,
}: WorkTimelineGanttProps) {
  const isMobile = useIsMobile();
  const chartRootRef = useRef<HTMLDivElement>(null);
  const activityExtent = useMemo(() => activityExtentMs(data), [data]);
  const recommended = useMemo(() => recommendedZoom(activityExtent), [activityExtent]);
  const [zoom, setZoom] = useState(() => initialZoom ?? recommended);
  const [focusVersion, setFocusVersion] = useState(0);
  const groups = useMemo(() => buildGroups(data), [data]);
  const featureCount = useMemo(
    () => groups.reduce((total, group) => total + group.features.length, 0),
    [groups],
  );
  const markerClusters = useMemo(() => clusterTimelineActivity(data), [data]);
  const focusDate = useMemo(() => focusDateForExtent(activityExtent), [activityExtent]);
  const todayMs = Date.now();
  const { fromMs: timelineFromMs, toMs: timelineToMs } = timelineWindow(data);
  const visibleEventCount = countVisiblePoints(data.events, timelineFromMs, timelineToMs);
  const visibleRelationshipCount = countVisiblePoints(data.edges, timelineFromMs, timelineToMs);
  const showsToday = todayMs >= timelineFromMs - DAY_MS && todayMs <= timelineToMs + DAY_MS;
  const pixelsPerHour = Math.max(1, Math.round((DAILY_COLUMN_WIDTH * zoom) / 100 / 24));

  const scrollElement = () => chartRootRef.current?.querySelector<HTMLElement>(".gantt") ?? null;

  const scrollViewport = (direction: "previous" | "next") => {
    const element = scrollElement();
    if (!element) return;
    const distance = Math.max(element.clientWidth * 0.8, DAILY_COLUMN_WIDTH);
    const left = direction === "next" ? distance : -distance;
    if (typeof element.scrollBy === "function") {
      element.scrollBy({ left, behavior: "smooth" });
    } else {
      element.scrollLeft += left;
    }
  };

  const scrollToToday = () => {
    const element = scrollElement();
    const marker = element?.querySelector<HTMLElement>('[data-roadmap-ui="gantt-today"]');
    if (!element || !marker) return;
    const elementRect = element.getBoundingClientRect();
    const markerRect = marker.getBoundingClientRect();
    const sidebarWidth =
      element.querySelector<HTMLElement>('[data-roadmap-ui="gantt-sidebar"]')?.getBoundingClientRect()
        .width ?? 0;
    const plotWidth = Math.max(0, element.clientWidth - sidebarWidth);
    const markerViewportTarget = sidebarWidth + plotWidth / 2;
    const left = Math.max(0, element.scrollLeft + markerRect.left - elementRect.left - markerViewportTarget);
    element.scrollTo({ left, behavior: "smooth" });
  };

  if (isMobile) {
    return (
      <div className="min-w-0">
        <div className="border-b bg-card px-3 py-2">
          <TimelineActivitySummary
            runCount={featureCount}
            eventCount={visibleEventCount}
            relationshipCount={visibleRelationshipCount}
          />
        </div>
        <div className="h-(--sz-560px) overflow-y-auto bg-background" aria-label="Timeline runs by actor">
          {groups.map(({ actor, activityCount, features: actorFeatures }) => (
            <section key={actor.id} aria-labelledby={`timeline-actor-${actor.id}`}>
              <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-y bg-muted/90 px-3 py-2 backdrop-blur-sm">
                <h3 id={`timeline-actor-${actor.id}`} className="truncate text-xs font-semibold">
                  {actor.name}
                </h3>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {actorFeatures.length} run{actorFeatures.length === 1 ? "" : "s"}
                </span>
              </div>
              {actorFeatures.length > 0 ? (
                <div className="divide-y">
                  {actorFeatures.map((feature) => {
                    const presentation = runStatuses[feature.span.status];
                    const StatusIcon = presentation.icon;
                    const isSelected = selectedRunId === feature.id;
                    return (
                      <button
                        key={feature.id}
                        type="button"
                        className={cn(
                          "flex w-full items-center gap-3 p-3 text-left transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                          isSelected && "bg-accent text-accent-foreground",
                        )}
                        aria-pressed={isSelected}
                        onClick={() => onSelectRun?.(feature.id)}
                      >
                        <StatusIcon
                          className="size-4 shrink-0"
                          style={{ color: presentation.gantt.color }}
                          aria-hidden="true"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{feature.name}</span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {formatDateTime(feature.startAt)} · {statusDuration(feature)}
                          </span>
                        </span>
                        <span className="shrink-0 text-xs font-medium">{presentation.gantt.name}</span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p className="px-3 py-4 text-xs text-muted-foreground">
                  {activityCount} activity item{activityCount === 1 ? "" : "s"}; no execution runs.
                </p>
              )}
            </section>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div ref={chartRootRef} className="min-w-0">
      <div className="border-b bg-card px-3 py-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <TimelineActivitySummary
            className="mr-auto min-w-max"
            runCount={featureCount}
            eventCount={visibleEventCount}
            relationshipCount={visibleRelationshipCount}
          />

          <ButtonGroup aria-label="Timeline scale" className="shrink-0">
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              onClick={() => setZoom((current) => zoomStep(current, "out"))}
              disabled={zoom <= ZOOM_STEPS[0]}
              aria-label="Zoom out"
              title="Zoom out"
            >
              <Minus data-icon="inline-start" />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-w-(--sz-100px) tabular-nums"
              onClick={() => setZoom(recommended)}
              aria-label={`Timeline scale: ${pixelsPerHour} pixels per hour. Reset to recommended scale`}
              title="Reset to recommended scale"
            >
              {pixelsPerHour} px/hr
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              onClick={() => setZoom((current) => zoomStep(current, "in"))}
              disabled={zoom >= ZOOM_STEPS.at(-1)!}
              aria-label="Zoom in"
              title="Zoom in"
            >
              <Plus data-icon="inline-start" />
            </Button>
          </ButtonGroup>

          <ButtonGroup aria-label="Timeline navigation" className="shrink-0">
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              onClick={() => setFocusVersion((current) => current + 1)}
              aria-label="Focus activity window"
              title="Focus activity window"
            >
              <LocateFixed data-icon="inline-start" />
            </Button>
            {showsToday ? (
              <Button type="button" variant="outline" size="sm" onClick={scrollToToday}>
                Today
              </Button>
            ) : null}
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              onClick={() => scrollViewport("previous")}
              aria-label="Previous timeline viewport"
              title="Previous timeline viewport"
            >
              <ChevronLeft data-icon="inline-start" />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              onClick={() => scrollViewport("next")}
              aria-label="Next timeline viewport"
              title="Next timeline viewport"
            >
              <ChevronRight data-icon="inline-start" />
            </Button>
          </ButtonGroup>
        </div>
      </div>

      <TooltipProvider>
        <GanttProvider
          className="h-(--sz-560px) rounded-none border-0 bg-background"
          initialExtent={{
            from: validDate(data.window.from) ?? focusDate,
            to: validDate(data.window.to) ?? focusDate,
          }}
          initialFocusDate={focusDate}
          key={`${data.window.from}:${data.window.to}:${focusVersion}`}
          range="daily"
          showDailyHourTicks
          zoom={zoom}
        >
          <GanttSidebar itemLabel="Tasks" durationLabel="Duration">
            {groups.map(({ actor, features }) => (
              <GanttSidebarGroup
                key={actor.id}
                name={`${actor.name} · ${features.length} run${features.length === 1 ? "" : "s"}`}
              >
                {features.map((feature) => (
                  <GanttSidebarItem
                    feature={feature}
                    key={feature.id}
                    className={cn(selectedRunId === feature.id && "bg-accent text-accent-foreground")}
                    onSelectItem={onSelectRun}
                  />
                ))}
              </GanttSidebarGroup>
            ))}
          </GanttSidebar>
          <GanttTimeline>
            <GanttHeader />
            <GanttFeatureList>
              {groups.map(({ actor, features }) => (
                <GanttFeatureListGroup key={actor.id}>
                  {features.map((feature) => {
                    const presentation = runStatuses[feature.span.status];
                    const StatusIcon = presentation.icon;
                    const duration = statusDuration(feature);
                    const isSelected = selectedRunId === feature.id;
                    return (
                      <div className="flex" key={feature.id}>
                        <GanttFeatureItem
                          {...feature}
                          draggable={false}
                          className={cn(
                            "[&_[data-slot=card]]:overflow-hidden [&_[data-slot=card]]:border-l-4",
                            presentation.featureClassName,
                            isSelected &&
                              "[&_[data-slot=card]]:ring-2 [&_[data-slot=card]]:ring-ring [&_[data-slot=card]]:ring-offset-2 [&_[data-slot=card]]:ring-offset-background",
                          )}
                        >
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <button
                                type="button"
                                className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                aria-label={`${feature.name}, ${presentation.gantt.name}, ${duration}`}
                                aria-pressed={isSelected}
                                onClick={() => onSelectRun?.(feature.id)}
                              >
                                <StatusIcon
                                  className="size-3 shrink-0"
                                  style={{ color: presentation.gantt.color }}
                                  aria-hidden="true"
                                />
                                <span className="truncate text-xs">{feature.name}</span>
                              </button>
                            </TooltipTrigger>
                            <TooltipContent side="top" className="max-w-sm space-y-1">
                              <p className="font-medium">{feature.name}</p>
                              <p>
                                {feature.actor.name} · {presentation.gantt.name} · {duration}
                              </p>
                              <p>
                                {formatDateTime(feature.startAt)} – {formatDateTime(feature.endAt)}
                              </p>
                            </TooltipContent>
                          </Tooltip>
                        </GanttFeatureItem>
                      </div>
                    );
                  })}
                </GanttFeatureListGroup>
              ))}
            </GanttFeatureList>
            {markerClusters.map((cluster) => (
              <GanttMarker
                id={cluster.id}
                date={cluster.date}
                key={cluster.id}
                label={cluster.label}
                className="bg-muted-foreground text-background"
              />
            ))}
            {showsToday ? <GanttToday className="bg-primary text-primary-foreground" /> : null}
          </GanttTimeline>
        </GanttProvider>
      </TooltipProvider>
    </div>
  );
}
