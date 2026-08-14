import { useMemo, useState } from "react";
import { Activity as ActivityIcon, Play, SlidersHorizontal, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { DomainStatus } from "@/components/patterns/DomainStatus";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { timeAgo } from "../../lib/timeAgo";
import { runRowSubtitle, dedupedTriggerLabel } from "../../lib/routine-run-display";
import { LiveRunWidget } from "../LiveRunWidget";
import { RoutineHistoryTab } from "../RoutineHistoryTab";
import { RoutineActivityRow } from "../RoutineActivityRow";
import { useRoutineDetail } from "./context";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import { Link } from "@tanstack/react-router";

const DATE_WINDOW_OPTIONS: {
  value: string;
  label: string;
  ms: number | null;
}[] = [
  { value: "any", label: "Any time", ms: null },
  { value: "24h", label: "Last 24h", ms: 24 * 60 * 60 * 1000 },
  { value: "7d", label: "Last 7d", ms: 7 * 24 * 60 * 60 * 1000 },
  { value: "30d", label: "Last 30d", ms: 30 * 24 * 60 * 60 * 1000 },
];

export function RunsSection() {
  const ctx = useRoutineDetail();
  const companyId = useCompanyRouteId();
  const { routine, routineRuns, hasLiveRun, activeTaskId, onOpenRunDialog } = ctx;
  const runs = useMemo(() => routineRuns ?? [], [routineRuns]);

  const [sourceFilter, setSourceFilter] = useState("any");
  const [statusFilter, setStatusFilter] = useState("any");
  const [dateFilter, setDateFilter] = useState("any");

  const sourceOptions = useMemo(() => [...new Set(runs.map((run) => run.source))].sort(), [runs]);
  const statusOptions = useMemo(() => [...new Set(runs.map((run) => run.status))].sort(), [runs]);

  const filtered = useMemo(() => {
    const windowMs = DATE_WINDOW_OPTIONS.find((option) => option.value === dateFilter)?.ms ?? null;
    const cutoff = windowMs == null ? null : Date.now() - windowMs;
    return runs.filter((run) => {
      if (sourceFilter !== "any" && run.source !== sourceFilter) return false;
      if (statusFilter !== "any" && run.status !== statusFilter) return false;
      if (cutoff != null && new Date(run.triggeredAt).getTime() < cutoff) return false;
      return true;
    });
  }, [runs, sourceFilter, statusFilter, dateFilter]);

  const activeFilters = useMemo(() => {
    const list: Array<{ key: string; label: string; value: string }> = [];
    if (sourceFilter !== "any") list.push({ key: "source", label: "Source", value: sourceFilter });
    if (statusFilter !== "any") {
      list.push({
        key: "status",
        label: "Status",
        value: statusFilter.replaceAll("_", " "),
      });
    }
    if (dateFilter !== "any") {
      const label = DATE_WINDOW_OPTIONS.find((option) => option.value === dateFilter)?.label ?? dateFilter;
      list.push({ key: "date", label: "Date", value: label });
    }
    return list;
  }, [sourceFilter, statusFilter, dateFilter]);

  function clearFilters() {
    setSourceFilter("any");
    setStatusFilter("any");
    setDateFilter("any");
  }

  function removeFilter(key: string) {
    if (key === "source") setSourceFilter("any");
    if (key === "status") setStatusFilter("any");
    if (key === "date") setDateFilter("any");
  }

  return (
    <div className="space-y-4">
      {hasLiveRun && activeTaskId ? (
        <LiveRunWidget taskId={activeTaskId} companyId={routine.companyId} />
      ) : null}

      {runs.length === 0 ? (
        <Empty className="border-0">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Play />
            </EmptyMedia>
            <EmptyTitle>No runs yet</EmptyTitle>
            <EmptyDescription>
              No runs yet. Trigger a run from the header or wait for the schedule.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={onOpenRunDialog}>Run now</Button>
          </EmptyContent>
        </Empty>
      ) : (
        <>
          {/* Filter chips row (§3.6) */}
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Select value={sourceFilter} onValueChange={setSourceFilter}>
                <SelectTrigger size="sm" className="h-8 w-auto gap-1.5 text-xs" aria-label="Filter by source">
                  <span className="text-muted-foreground">Source:</span>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">any</SelectItem>
                  {sourceOptions.map((source) => (
                    <SelectItem key={source} value={source}>
                      {source}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger size="sm" className="h-8 w-auto gap-1.5 text-xs" aria-label="Filter by status">
                  <span className="text-muted-foreground">Status:</span>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">any</SelectItem>
                  {statusOptions.map((status) => (
                    <SelectItem key={status} value={status}>
                      {status.replaceAll("_", " ")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={dateFilter} onValueChange={setDateFilter}>
                <SelectTrigger size="sm" className="h-8 w-auto gap-1.5 text-xs" aria-label="Filter by date">
                  <span className="text-muted-foreground">Date:</span>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DATE_WINDOW_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {activeFilters.length > 0 ? (
              <div className="flex flex-wrap items-center gap-2">
                {activeFilters.map((filter) => (
                  <Badge key={filter.key} variant="secondary">
                    <span className="text-muted-foreground">{filter.label}:</span>
                    {filter.value}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Remove ${filter.label}: ${filter.value} filter`}
                      onClick={() => removeFilter(filter.key)}
                    >
                      <X />
                    </Button>
                  </Badge>
                ))}
                <Button type="button" variant="ghost" size="xs" onClick={clearFilters}>
                  Clear all
                </Button>
              </div>
            ) : null}
          </div>

          {filtered.length === 0 ? (
            <Empty className="border-0">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <SlidersHorizontal />
                </EmptyMedia>
                <EmptyTitle>No matching runs</EmptyTitle>
                <EmptyDescription>No runs match these filters.</EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button onClick={clearFilters}>Clear filters</Button>
              </EmptyContent>
            </Empty>
          ) : (
            <ItemGroup className="rounded-lg border">
              {filtered.map((run) => {
                const label = dedupedTriggerLabel(run.trigger);
                const title = run.linkedTask?.title ?? label ?? "Run";
                return (
                  <Item key={run.id} size="sm">
                    <ItemMedia>
                      <Badge variant="outline" className="shrink-0">
                        {run.source}
                      </Badge>
                      <DomainStatus status={run.status} className="shrink-0">
                        {run.status.replaceAll("_", " ")}
                      </DomainStatus>
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle>
                        {run.linkedTask?.identifier ? (
                          <span className="font-mono text-xs text-muted-foreground">
                            {run.linkedTask.identifier}
                          </span>
                        ) : null}
                        {run.linkedTask ? (
                          <Link
                            to="/$companyId/tasks/$taskNumber"
                            params={{
                              companyId,
                              taskNumber: String(run.linkedTask.taskNumber),
                            }}
                          >
                            {title}
                          </Link>
                        ) : (
                          title
                        )}
                      </ItemTitle>
                      <ItemDescription>{runRowSubtitle(run, routine.variables) || "\u00a0"}</ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      <span className="text-xs text-muted-foreground">{timeAgo(run.triggeredAt)}</span>
                    </ItemActions>
                  </Item>
                );
              })}
            </ItemGroup>
          )}
        </>
      )}
    </div>
  );
}

export function ActivitySection() {
  const ctx = useRoutineDetail();
  const { activity } = ctx;
  const events = activity ?? [];

  const groups = useMemo(() => {
    const byDay = new Map<string, typeof events>();
    for (const event of events) {
      let label = "Earlier";
      try {
        label = new Date(event.createdAt).toLocaleDateString(undefined, {
          weekday: "short",
          month: "short",
          day: "numeric",
        });
      } catch {
        /* keep fallback label */
      }
      const bucket = byDay.get(label) ?? [];
      bucket.push(event);
      byDay.set(label, bucket);
    }
    return Array.from(byDay.entries());
  }, [events]);

  if (events.length === 0) {
    return (
      <Empty className="border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ActivityIcon />
          </EmptyMedia>
          <EmptyTitle>No activity yet</EmptyTitle>
          <EmptyDescription>Routine changes and runs will appear here.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="space-y-4">
      {groups.map(([day, dayEvents]) => (
        <div key={day}>
          <div className="sticky top-0 bg-background py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {day}
          </div>
          <div>
            {dayEvents.map((event) => (
              <RoutineActivityRow key={event.id} event={event} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function HistorySection() {
  const ctx = useRoutineDetail();
  const {
    routine,
    isEditDirty,
    dirtyFields,
    routineDefaults,
    setEditDraft,
    saveRoutine,
    agentById,
    projectById,
    availableSecrets,
    onHistoryRestoreSecretMaterials,
    onHistoryRestored,
  } = ctx;

  return (
    <RoutineHistoryTab
      routine={routine}
      isEditDirty={isEditDirty}
      dirtyFields={dirtyFields}
      onDiscardEdits={() => setEditDraft(routineDefaults)}
      onSaveEdits={() => {
        if (!saveRoutine.isPending && routine.title.trim()) {
          saveRoutine.mutate();
        }
      }}
      agents={agentById}
      projects={projectById}
      secrets={availableSecrets}
      onRestoreSecretMaterials={onHistoryRestoreSecretMaterials}
      onRestored={onHistoryRestored}
    />
  );
}
