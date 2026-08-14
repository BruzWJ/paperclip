import { useMemo, useState, type ReactNode } from "react";
import type {
  ActivityEvent,
  Agent,
  Task,
  TaskExecutionRunEnvelopeRecord,
  TaskExecutionRunListPageRecord,
  TaskExecutionRunLivenessFact,
} from "@paperclipai/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import { runsApi, type TaskExecutionRunJoinedDetail } from "../api/runs";
import { queryKeys } from "../lib/queryKeys";
import { keepPreviousDataForSameQueryTail } from "../lib/query-placeholder-data";
import { cn, relativeTime } from "../lib/utils";
import { DomainStatus } from "./patterns/DomainStatus";
import { Alert, AlertDescription } from "./ui/alert";
import { Button } from "./ui/button";
import { Card, CardContent } from "./ui/card";
import { Empty, EmptyDescription } from "./ui/empty";

type TaskRunLedgerProps = {
  taskId: string;
  taskStatus: Task["boardPresentationStatus"];
  childTasks: Task[];
  agentMap: ReadonlyMap<string, Agent>;
  activityEvents?: ActivityEvent[];
  renderActivityEvent?: (event: ActivityEvent) => ReactNode;
  resolveUserLabel?: (userId: string) => string | null | undefined;
};

type TaskRunLedgerContentProps = {
  runs: TaskExecutionRunEnvelopeRecord[];
  selectedDetail?: TaskExecutionRunJoinedDetail | null;
  selectedRunId?: string | null;
  onSelectRun?: (runId: string) => void;
  taskStatus: Task["boardPresentationStatus"];
  childTasks: Task[];
  agentMap: ReadonlyMap<string, Pick<Agent, "id" | "name">>;
  activityEvents?: ActivityEvent[];
  renderActivityEvent?: (event: ActivityEvent) => ReactNode;
};

type LedgerFeedItem =
  | {
      kind: "run";
      id: string;
      timestamp: string;
      run: TaskExecutionRunEnvelopeRecord;
    }
  | { kind: "activity"; id: string; timestamp: string; event: ActivityEvent };

const TERMINAL_CHILD_STATUSES = new Set<Task["boardPresentationStatus"]>(["done", "cancelled"]);

const LIVENESS_LABEL: Record<TaskExecutionRunLivenessFact["livenessState"], string> = {
  completed: "Completed",
  advanced: "Advanced",
  plan_only: "Plan only",
  empty_response: "Empty response",
  blocked: "Blocked",
  failed: "Failed",
  needs_followup: "Needs follow-up",
};

function runTimestamp(run: TaskExecutionRunEnvelopeRecord): string {
  return run.startedAt ?? run.createdAt;
}

function timestampValue(value: string): number {
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function compareRunsNewestFirst(
  left: TaskExecutionRunEnvelopeRecord,
  right: TaskExecutionRunEnvelopeRecord,
): number {
  return (
    timestampValue(runTimestamp(right)) - timestampValue(runTimestamp(left)) ||
    right.id.localeCompare(left.id)
  );
}

export function defaultTaskRunLedgerRunId(runs: readonly TaskExecutionRunEnvelopeRecord[]): string | null {
  return [...runs].sort(compareRunsNewestFirst)[0]?.id ?? null;
}

function formatDuration(start: string | null, end: string | null) {
  if (!start) return null;
  const startMs = new Date(start).getTime();
  const endMs = end ? new Date(end).getTime() : Date.now();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  const totalSeconds = Math.max(0, Math.round((endMs - startMs) / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function statusLabel(status: string) {
  return status.replace(/_/g, " ");
}

function runAgentName(
  run: TaskExecutionRunEnvelopeRecord,
  agentMap: ReadonlyMap<string, Pick<Agent, "id" | "name">>,
) {
  return agentMap.get(run.targetAgentId)?.name ?? "Unknown agent";
}

function runSummary(
  run: TaskExecutionRunEnvelopeRecord,
  agentMap: ReadonlyMap<string, Pick<Agent, "id" | "name">>,
) {
  const agent = runAgentName(run, agentMap);
  if (run.status === "running") return `Running now by ${agent}`;
  if (run.status === "queued") return `Queued for ${agent}`;
  if (run.status === "scheduled_retry") return `Retry scheduled for ${agent}`;
  return `${statusLabel(run.status)} by ${agent}`;
}

function childTaskSummary(childTasks: Task[]) {
  const active = childTasks.filter((task) => !TERMINAL_CHILD_STATUSES.has(task.boardPresentationStatus));
  return {
    active,
    done: childTasks.filter((task) => task.boardPresentationStatus === "done").length,
    cancelled: childTasks.filter((task) => task.boardPresentationStatus === "cancelled").length,
    total: childTasks.length,
  };
}

export function TaskRunLedger({
  taskId,
  taskStatus,
  childTasks,
  agentMap,
  activityEvents,
  renderActivityEvent,
}: TaskRunLedgerProps) {
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const { data: runPage } = useQuery({
    queryKey: queryKeys.tasks.runs(taskId),
    queryFn: () => runsApi.listForTask(taskId, { limit: 200 }),
    placeholderData: keepPreviousDataForSameQueryTail<TaskExecutionRunListPageRecord>(taskId),
  });
  const runs = runPage?.items ?? [];
  const defaultRunId = useMemo(() => defaultTaskRunLedgerRunId(runs), [runs]);
  const effectiveSelectedRunId =
    selectedRunId && runs.some((run) => run.id === selectedRunId) ? selectedRunId : defaultRunId;
  const { data: selectedDetail } = useQuery({
    queryKey: queryKeys.runDetail(effectiveSelectedRunId ?? "pending"),
    queryFn: () => runsApi.get(effectiveSelectedRunId!),
    enabled: Boolean(effectiveSelectedRunId),
  });

  return (
    <TaskRunLedgerContent
      runs={runs}
      selectedDetail={selectedDetail}
      selectedRunId={effectiveSelectedRunId}
      onSelectRun={setSelectedRunId}
      taskStatus={taskStatus}
      childTasks={childTasks}
      agentMap={agentMap}
      activityEvents={activityEvents}
      renderActivityEvent={renderActivityEvent}
    />
  );
}

export function TaskRunLedgerContent({
  runs,
  selectedDetail,
  selectedRunId,
  onSelectRun,
  taskStatus,
  childTasks,
  agentMap,
  activityEvents,
  renderActivityEvent,
}: TaskRunLedgerContentProps) {
  const companyId = useCompanyRouteId();
  const orderedRuns = useMemo(() => [...runs].sort(compareRunsNewestFirst), [runs]);
  const latestRun = orderedRuns[0] ?? null;
  const children = childTaskSummary(childTasks);
  const feedItems = useMemo<LedgerFeedItem[]>(() => {
    const items: LedgerFeedItem[] = orderedRuns.map((run) => ({
      kind: "run",
      id: run.id,
      timestamp: runTimestamp(run),
      run,
    }));
    if (renderActivityEvent) {
      for (const event of activityEvents ?? []) {
        items.push({
          kind: "activity",
          id: event.id,
          timestamp:
            event.createdAt instanceof Date ? event.createdAt.toISOString() : String(event.createdAt),
          event,
        });
      }
    }
    return items.sort((left, right) => {
      const difference = new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime();
      return difference || right.id.localeCompare(left.id);
    });
  }, [activityEvents, orderedRuns, renderActivityEvent]);
  const selectedLiveness =
    selectedDetail?.run.id === selectedRunId ? (selectedDetail?.finalization?.liveness ?? null) : null;
  const selectedRetry = selectedDetail?.retrySchedules.items.at(-1) ?? null;
  const renderRunCard = (run: TaskExecutionRunEnvelopeRecord) => {
    const isSelected = run.id === selectedRunId;
    const liveness = isSelected && selectedLiveness ? selectedLiveness.livenessState : null;
    return (
      <Card
        key={`run:${run.id}`}
        data-run-id={run.id}
        data-run-kind={run.kind}
        className={cn("gap-2 px-3 py-2 text-xs text-muted-foreground", isSelected && "border-primary")}
      >
        <Button
          type="button"
          variant="ghost"
          className="h-auto w-full flex-wrap justify-start px-0"
          onClick={() => onSelectRun?.(run.id)}
        >
          <span className="font-medium text-foreground">Run</span>
          <span className="font-mono text-foreground">{run.id.slice(0, 8)}</span>
          <span>by {runAgentName(run, agentMap)}</span>
          <DomainStatus status={run.status} className="capitalize">
            {statusLabel(run.status)}
          </DomainStatus>
          {liveness ? <DomainStatus status={liveness}>{LIVENESS_LABEL[liveness]}</DomainStatus> : null}
          <span className="ml-auto">{relativeTime(runTimestamp(run))}</span>
        </Button>
        <div className="grid gap-2 sm:grid-cols-3">
          <div>
            <span className="text-foreground">Elapsed</span>{" "}
            {formatDuration(run.startedAt, run.finishedAt) ?? "not started"}
          </div>
          <div>
            <span className="text-foreground">Mode</span> {run.executionMode}
          </div>
          <div>
            <span className="text-foreground">Terminal reason</span> {run.terminalReasonCode ?? "—"}
          </div>
        </div>
        {isSelected && selectedLiveness ? (
          <Alert>
            <AlertDescription>
              <p>{selectedLiveness.livenessReason}</p>
              {selectedLiveness.nextAction ? (
                <p>
                  <span className="font-medium text-foreground">Next action:</span>{" "}
                  {selectedLiveness.nextAction}
                </p>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}
        {isSelected && selectedRetry ? (
          <p>
            Retry {statusLabel(selectedRetry.state)} for {relativeTime(selectedRetry.retryAt)}:{" "}
            {selectedRetry.reasonCode}
          </p>
        ) : null}
      </Card>
    );
  };

  return (
    <section className="space-y-3" aria-label="Task run ledger">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-muted-foreground">Run ledger</h3>
          <p className="text-xs text-muted-foreground">
            {latestRun
              ? runSummary(latestRun, agentMap)
              : taskStatus === "in_progress"
                ? "Waiting for the first run record."
                : "No runs linked yet."}
          </p>
        </div>
        {latestRun && agentMap.has(latestRun.targetAgentId) ? (
          <Button variant="outline" size="sm" asChild>
            <Link
              to="/$companyId/agents/$agentId/runs/$runId"
              params={{
                companyId,
                agentId: latestRun.targetAgentId,
                runId: latestRun.id,
              }}
            >
              Latest run
            </Link>
          </Button>
        ) : null}
      </div>

      {children.total > 0 ? (
        <Card className="gap-0 py-2">
          <CardContent className="flex flex-wrap items-center gap-2 px-3 text-xs">
            <span className="font-medium text-foreground">Child work</span>
            <span className="text-muted-foreground">
              {children.active.length > 0
                ? `${children.active.length} active, ${children.done} done, ${children.cancelled} cancelled`
                : `all ${children.total} terminal (${children.done} done, ${children.cancelled} cancelled)`}
            </span>
          </CardContent>
        </Card>
      ) : null}

      {feedItems.length === 0 ? (
        <Empty className="p-6">
          <EmptyDescription>Runs and activity will appear here once this task has history.</EmptyDescription>
        </Empty>
      ) : (
        <div className="space-y-1.5">
          {feedItems.slice(0, 20).map((item) => {
            if (item.kind === "activity") {
              return <div key={`activity:${item.id}`}>{renderActivityEvent?.(item.event)}</div>;
            }
            return renderRunCard(item.run);
          })}
        </div>
      )}
    </section>
  );
}
