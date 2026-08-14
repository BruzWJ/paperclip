import type {
  TaskExecutionRunStatus,
  WorkTimelineActor,
  WorkTimelineResult,
  WorkTimelineSpan,
} from "@paperclipai/shared";
import { useMemo } from "react";

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
  type Range,
} from "@/components/kibo-ui/gantt";
import { cn } from "@/lib/utils";

const runStatuses: Record<TaskExecutionRunStatus, GanttStatus> = {
  queued: { id: "queued", name: "Queued", color: "var(--muted-foreground)" },
  scheduled_retry: { id: "scheduled_retry", name: "Scheduled retry", color: "var(--chart-4)" },
  running: { id: "running", name: "Running", color: "var(--primary)" },
  succeeded: { id: "succeeded", name: "Succeeded", color: "var(--chart-2)" },
  interrupted: { id: "interrupted", name: "Interrupted", color: "var(--destructive)" },
  failed: { id: "failed", name: "Failed", color: "var(--destructive)" },
  cancelled: { id: "cancelled", name: "Cancelled", color: "var(--destructive)" },
  timed_out: { id: "timed_out", name: "Timed out", color: "var(--destructive)" },
};

interface TimelineFeature extends GanttFeature {
  actorId: string;
  span: WorkTimelineSpan;
}

interface ActorFeatureGroup {
  actor: WorkTimelineActor;
  features: TimelineFeature[];
}

function validDate(value: string): Date | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function featureFromSpan(span: WorkTimelineSpan, windowEnd: Date): TimelineFeature | null {
  const startAt = validDate(span.start);
  if (!startAt) return null;
  const parsedEnd = span.end ? validDate(span.end) : windowEnd;
  const endAt = parsedEnd && parsedEnd >= startAt ? parsedEnd : startAt;

  return {
    id: span.runId,
    name: `${span.taskIdentifier} · ${span.taskTitle ?? `Task ${span.taskNumber}`}`,
    startAt,
    endAt,
    status: runStatuses[span.status],
    lane: span.actorId,
    actorId: span.actorId,
    span,
  };
}

function rangeForWindow(data: WorkTimelineResult): Range {
  const from = validDate(data.window.from);
  const to = validDate(data.window.to);
  if (!from || !to) return "monthly";
  const days = Math.max(1, (to.getTime() - from.getTime()) / 86_400_000);
  if (days <= 45) return "daily";
  if (days <= 370) return "monthly";
  return "quarterly";
}

export interface WorkTimelineGanttProps {
  data: WorkTimelineResult;
  zoom?: number;
  range?: Range;
  className?: string;
}

/** Maps Paperclip's run/actor DTO onto Kibo's read-only Gantt composition. */
export function WorkTimelineGantt({ data, zoom = 100, range, className }: WorkTimelineGanttProps) {
  const initialExtent = useMemo(() => {
    const from = validDate(data.window.from);
    const to = validDate(data.window.to);
    if (!from || !to) return undefined;
    return { from, to };
  }, [data.window.from, data.window.to]);

  const groups = useMemo<ActorFeatureGroup[]>(() => {
    const windowEnd = validDate(data.window.to) ?? new Date();
    const actorById = new Map(data.actors.map((actor) => [actor.id, actor]));
    const featuresByActor = new Map<string, TimelineFeature[]>();

    for (const span of data.spans) {
      const feature = featureFromSpan(span, windowEnd);
      if (!feature) continue;
      const current = featuresByActor.get(span.actorId);
      if (current) current.push(feature);
      else featuresByActor.set(span.actorId, [feature]);
    }

    const orderedActors = data.actors.filter((actor) => featuresByActor.has(actor.id));
    for (const actorId of featuresByActor.keys()) {
      if (!actorById.has(actorId)) {
        orderedActors.push({ id: actorId, type: "system", name: "Unknown actor" });
      }
    }

    return orderedActors.map((actor) => ({
      actor,
      features: (featuresByActor.get(actor.id) ?? []).sort(
        (left, right) => left.startAt.getTime() - right.startAt.getTime(),
      ),
    }));
  }, [data]);

  return (
    <GanttProvider
      className={cn("h-(--sz-560px) border", className)}
      initialExtent={initialExtent}
      key={`${data.window.from}:${data.window.to}`}
      range={range ?? rangeForWindow(data)}
      zoom={zoom}
    >
      <GanttSidebar>
        {groups.map(({ actor, features }) => (
          <GanttSidebarGroup key={actor.id} name={actor.name}>
            {features.map((feature) => (
              <GanttSidebarItem feature={feature} key={feature.id} />
            ))}
          </GanttSidebarGroup>
        ))}
      </GanttSidebar>
      <GanttTimeline>
        <GanttHeader />
        <GanttFeatureList>
          {groups.map(({ actor, features }) => (
            <GanttFeatureListGroup key={actor.id}>
              {features.map((feature) => (
                <div className="flex" key={feature.id}>
                  <GanttFeatureItem {...feature} draggable={false} />
                </div>
              ))}
            </GanttFeatureListGroup>
          ))}
        </GanttFeatureList>
        {data.events.map((event, index) => {
          const date = validDate(event.at);
          if (!date) return null;
          const actorName = data.actors.find((actor) => actor.id === event.actorId)?.name;
          return (
            <GanttMarker
              id={`${event.actorId}:${event.taskId}:${event.kind}:${event.at}:${index}`}
              date={date}
              key={`${event.actorId}:${event.taskId}:${event.kind}:${event.at}:${index}`}
              label={`${actorName ? `${actorName} · ` : ""}${event.kind.replaceAll("_", " ")}`}
            />
          );
        })}
        <GanttToday />
      </GanttTimeline>
    </GanttProvider>
  );
}
