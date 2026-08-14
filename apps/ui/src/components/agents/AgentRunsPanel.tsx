import { runsApi, type TaskExecutionRunJoinedDetail } from "@/api/runs";
import { tasksApi } from "@/api/tasks";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Empty, EmptyTitle } from "@/components/ui/empty";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@/components/ui/item";
import { Spinner } from "@/components/ui/spinner";
import { useSidebar } from "@/context/SidebarContext";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import { queryKeys } from "@/lib/queryKeys";
import { statusBadgeVariant } from "@/lib/status-variant";
import { cn, relativeTime } from "@/lib/utils";
import type { TaskExecutionRunEnvelopeRecord } from "@paperclipai/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";

function runDuration(run: TaskExecutionRunEnvelopeRecord) {
  if (!run.startedAt) return null;
  const startedAt = new Date(run.startedAt).getTime();
  const finishedAt = run.finishedAt
    ? new Date(run.finishedAt).getTime()
    : Date.now();
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt)) return null;
  const seconds = Math.max(0, Math.round((finishedAt - startedAt) / 1000));
  if (seconds < 60) return String(seconds) + "s";
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds > 0
    ? String(minutes) + "m " + String(remainingSeconds) + "s"
    : String(minutes) + "m";
}

function RunListItem({
  run,
  isSelected,
  agentId,
}: {
  run: TaskExecutionRunEnvelopeRecord;
  isSelected: boolean;
  agentId: string;
}) {
  const companyId = useCompanyRouteId();
  const className = cn(
    "w-full items-stretch border-b text-left text-inherit no-underline last:border-b-0",
    isSelected && "bg-accent",
  );
  const content = (
    <ItemContent>
      <ItemTitle className="flex-wrap">
        <Badge variant={statusBadgeVariant(run.status)}>
          {run.status.replace(/[_-]/g, " ")}
        </Badge>
        <Badge
          variant="outline"
          className="px-1.5 text-(length:--text-nano) capitalize"
        >
          {run.kind}
        </Badge>
        <span className="font-mono text-xs text-muted-foreground">
          {run.id.slice(0, 8)}
        </span>
        <span className="ml-auto shrink-0 text-(length:--text-micro) text-muted-foreground">
          {relativeTime(run.createdAt)}
        </span>
      </ItemTitle>
      {run.terminalReasonCode ? (
        <ItemDescription className="truncate capitalize">
          {run.terminalReasonCode.replace(/_/g, " ")}
        </ItemDescription>
      ) : null}
    </ItemContent>
  );
  if (isSelected) {
    return (
      <Item asChild variant="muted" size="sm" className={className}>
        <Link
          to="/$companyId/agents/$agentId/$tab"
          params={{ companyId, agentId, tab: "runs" }}
        >
          {content}
        </Link>
      </Item>
    );
  }
  return (
    <Item asChild size="sm" className={className}>
      <Link
        to="/$companyId/agents/$agentId/runs/$runId"
        params={{ companyId, agentId, runId: run.id }}
      >
        {content}
      </Link>
    </Item>
  );
}

export function AgentRunsPanel({
  runs,
  agentRouteId,
  selectedRunId,
}: {
  runs: TaskExecutionRunEnvelopeRecord[];
  agentRouteId: string;
  selectedRunId: string | null;
}) {
  const { isMobile } = useSidebar();
  const companyId = useCompanyRouteId();

  if (runs.length === 0) {
    return (
      <Empty className="border">
        <EmptyTitle>No runs yet</EmptyTitle>
      </Empty>
    );
  }

  const sorted = [...runs].sort(
    (left, right) =>
      new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
  );
  const effectiveRunId = isMobile
    ? selectedRunId
    : (selectedRunId ?? sorted[0]?.id ?? null);
  const selectedRun = sorted.find((run) => run.id === effectiveRunId) ?? null;

  if (isMobile) {
    if (selectedRun) {
      return (
        <div className="min-w-0 space-y-3 overflow-x-hidden">
          <Button asChild variant="ghost" size="sm">
            <Link
              to="/$companyId/agents/$agentId/$tab"
              params={{ companyId, agentId: agentRouteId, tab: "runs" }}
            >
              <ArrowLeft />
              Back to runs
            </Link>
          </Button>
          <RunDetail run={selectedRun} />
        </div>
      );
    }
    return (
      <ItemGroup className="overflow-x-hidden rounded-lg border">
        {sorted.map((run) => (
          <RunListItem
            key={run.id}
            run={run}
            isSelected={false}
            agentId={agentRouteId}
          />
        ))}
      </ItemGroup>
    );
  }

  return (
    <div className="flex gap-0">
      <div
        className={cn(
          "shrink-0 rounded-lg border",
          selectedRun ? "w-72" : "w-full",
        )}
      >
        <ItemGroup
          className="sticky top-4 overflow-y-auto"
          style={{ maxHeight: "calc(100vh - 2rem)" }}
        >
          {sorted.map((run) => (
            <RunListItem
              key={run.id}
              run={run}
              isSelected={run.id === effectiveRunId}
              agentId={agentRouteId}
            />
          ))}
        </ItemGroup>
      </div>
      {selectedRun ? (
        <div className="min-w-0 flex-1 pl-4">
          <RunDetail run={selectedRun} />
        </div>
      ) : null}
    </div>
  );
}

function BoundedRecordSection<T>({
  title,
  items,
  truncated,
  render,
}: {
  title: string;
  items: readonly T[];
  truncated: boolean;
  render: (item: T, index: number) => ReactNode;
}) {
  if (items.length === 0) return null;
  return (
    <Card className="gap-0 py-0">
      <CardHeader className="flex-row items-center justify-between py-3">
        <h3 className="text-xs font-medium text-muted-foreground">
          {title} ({items.length})
        </h3>
        {truncated ? (
          <Badge variant="outline" className="text-(length:--text-micro)">
            Bounded view
          </Badge>
        ) : null}
      </CardHeader>
      <CardContent className="p-0">
        <ItemGroup className="divide-y">
          {items.map((item, index) => (
            <Item key={index} size="sm" className="items-stretch">
              {render(item, index)}
            </Item>
          ))}
        </ItemGroup>
      </CardContent>
    </Card>
  );
}

function JsonData({ value }: { value: unknown }) {
  return (
    <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2 text-(length:--text-micro)">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function RecordContent({
  label,
  detail,
  trailing,
  description,
  children,
}: {
  label: string;
  detail: string;
  trailing?: ReactNode;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <ItemContent className="basis-full">
      <ItemTitle className="w-full flex-wrap">
        <Badge variant="outline" className="capitalize">
          {label}
        </Badge>
        <span>{detail}</span>
        {trailing ? <span className="ml-auto">{trailing}</span> : null}
      </ItemTitle>
      {description ? (
        <ItemDescription className="font-mono">{description}</ItemDescription>
      ) : null}
      {children}
    </ItemContent>
  );
}

function RunDetail({
  run: initialRun,
}: {
  run: TaskExecutionRunEnvelopeRecord;
}) {
  const companyId = useCompanyRouteId();
  const {
    data: detail,
    isLoading,
    error,
  } = useQuery<TaskExecutionRunJoinedDetail>({
    queryKey: queryKeys.runDetail(initialRun.id),
    queryFn: () => runsApi.get(initialRun.id),
  });
  const run = detail?.run ?? initialRun;
  const duration = runDuration(run);
  const { data: task } = useQuery({
    queryKey: queryKeys.tasks.detail(run.taskId),
    queryFn: () => tasksApi.get(run.taskId),
  });
  const summaryRows: Array<{ label: string; value: ReactNode }> = [
    {
      label: "Task",
      value: task ? (
        <Link
          to="/$companyId/tasks/$taskNumber"
          params={{ companyId, taskNumber: String(task.taskNumber) }}
          className="font-mono hover:underline"
        >
          {task.identifier}
        </Link>
      ) : (
        <span>Task unavailable</span>
      ),
    },
    { label: "Session", value: run.sessionId.slice(0, 8) },
    { label: "Execution scope", value: run.executionScopeId.slice(0, 8) },
    { label: "Ownership epoch", value: run.ownershipEpoch },
    { label: "Created", value: relativeTime(run.createdAt) },
    { label: "Duration", value: duration ?? "Not started" },
  ];

  return (
    <div className="min-w-0 space-y-4">
      <Card className="gap-4 py-4">
        <CardHeader className="flex-row flex-wrap items-center gap-2 px-4">
          <Badge variant={statusBadgeVariant(run.status)}>
            {run.status.replace(/[_-]/g, " ")}
          </Badge>
          <Badge variant="outline" className="capitalize">
            {run.kind}
          </Badge>
          <span className="font-mono text-xs text-muted-foreground">
            {run.id}
          </span>
        </CardHeader>
        <CardContent className="space-y-3 px-4">
          <ItemGroup className="grid gap-2 sm:grid-cols-2">
            {summaryRows.map((row) => (
              <Item key={row.label} variant="muted" size="sm">
                <ItemDescription>{row.label}</ItemDescription>
                <span className="ml-auto text-right text-xs">{row.value}</span>
              </Item>
            ))}
          </ItemGroup>
          {run.terminalReasonCode ? (
            <ItemDescription className="capitalize">
              {run.terminalReasonCode.replace(/_/g, " ")}
            </ItemDescription>
          ) : null}
        </CardContent>
      </Card>

      {isLoading && !detail ? (
        <p
          className="flex items-center gap-2 text-sm text-muted-foreground"
          role="status"
        >
          <Spinner />
          Loading joined run detail…
        </p>
      ) : null}
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>
            {error instanceof Error
              ? error.message
              : "Could not load the run detail."}
          </AlertDescription>
        </Alert>
      ) : null}

      {detail?.finalization ? (
        <Item variant="outline" className="items-stretch">
          <ItemContent>
            <ItemTitle className="flex-wrap">
              Finalization
              <Badge variant="outline" className="capitalize">
                {detail.finalization.record.action.replace(/_/g, " ")}
              </Badge>
              {detail.finalization.liveness ? (
                <Badge variant="outline" className="capitalize">
                  {detail.finalization.liveness.livenessState.replace(
                    /_/g,
                    " ",
                  )}
                </Badge>
              ) : null}
            </ItemTitle>
            {detail.finalization.liveness?.livenessReason ? (
              <ItemDescription className="capitalize">
                {detail.finalization.liveness.livenessReason.replace(/_/g, " ")}
              </ItemDescription>
            ) : null}
          </ItemContent>
        </Item>
      ) : null}

      <BoundedRecordSection
        title="Attempts"
        items={detail?.attempts.items ?? []}
        truncated={detail?.attempts.truncated ?? false}
        render={(attempt) => (
          <RecordContent
            label={attempt.state}
            detail={`${attempt.promptKind} · ${attempt.sessionOperation.replace(/_/g, " ")}`}
            trailing={`generation ${attempt.attemptGeneration}`}
            description={attempt.id}
          />
        )}
      />

      <BoundedRecordSection
        title="Retry schedules"
        items={detail?.retrySchedules.items ?? []}
        truncated={detail?.retrySchedules.truncated ?? false}
        render={(retry) => (
          <RecordContent
            label={retry.state}
            detail={retry.reasonCode.replace(/_/g, " ")}
            trailing={relativeTime(retry.retryAt)}
            description={retry.predecessorAttemptId}
          />
        )}
      />

      <BoundedRecordSection
        title="Session messages"
        items={detail?.sessionMessages.items ?? []}
        truncated={detail?.sessionMessages.truncated ?? false}
        render={(message) => (
          <RecordContent
            label={message.type.replace(/-/g, " ")}
            detail={`seq ${message.seq}`}
            trailing={relativeTime(message.timeCreated)}
          >
            <JsonData value={message.data} />
          </RecordContent>
        )}
      />

      <BoundedRecordSection
        title="Session events"
        items={detail?.sessionEvents.items ?? []}
        truncated={detail?.sessionEvents.truncated ?? false}
        render={(event) => (
          <RecordContent
            label={event.type}
            detail={`seq ${event.seq}`}
            trailing={relativeTime(event.createdAt)}
          >
            <JsonData value={event.data} />
          </RecordContent>
        )}
      />
    </div>
  );
}
