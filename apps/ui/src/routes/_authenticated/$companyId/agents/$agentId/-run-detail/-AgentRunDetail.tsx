import {
  runsApi,
  type BoundedRunRecords,
  type TaskExecutionRunJoinedDetail,
  type TaskExecutionSessionMessageRecord,
} from "@/api/runs";
import { tasksApi } from "@/api/tasks";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { DomainStatus } from "@/components/patterns/DomainStatus";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { queryKeys } from "@/lib/queryKeys";
import type { Agent, TaskExecutionRunEnvelopeRecord } from "@paperclipai/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangleIcon, RefreshCwIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { AgentRunDiagnostics } from "./-AgentRunDiagnostics";
import { AgentRunHeader } from "./-AgentRunHeader";
import { AgentRunLifecycle } from "./-AgentRunLifecycle";
import { AgentRunOutputs } from "./-AgentRunOutputs";
import { AgentRunTranscript } from "./-AgentRunTranscript";
import { collectRunOutputs, humanizeRunValue } from "./-agent-run-detail-model";

const FAILURE_STATUSES = new Set(["failed", "interrupted", "timed_out", "cancelled"]);

interface MessagePageState {
  runId: string;
  detailUpdatedAt: number;
  pages: BoundedRunRecords<TaskExecutionSessionMessageRecord>[];
}

export function AgentRunDetail({
  runId,
  initialRun,
  agent,
  companyId,
}: {
  runId: string;
  initialRun?: TaskExecutionRunEnvelopeRecord;
  agent: Agent;
  companyId: string;
}) {
  const [messagePageState, setMessagePageState] = useState<MessagePageState>({
    runId: "",
    detailUpdatedAt: 0,
    pages: [],
  });
  const detailQuery = useQuery<TaskExecutionRunJoinedDetail>({
    queryKey: queryKeys.runDetail(runId),
    queryFn: () => runsApi.get(runId),
  });
  const run = detailQuery.data?.run ?? initialRun;
  const taskQuery = useQuery({
    queryKey: queryKeys.tasks.detail(run?.taskId ?? ""),
    queryFn: () => tasksApi.get(run!.taskId),
    enabled: Boolean(run?.taskId),
  });
  const messagePageMutation = useMutation({
    mutationFn: ({ targetRunId, cursor }: { targetRunId: string; cursor: string; detailUpdatedAt: number }) =>
      runsApi.get(targetRunId, 200, undefined, { messageCursor: cursor }),
    onSuccess: (page, variables) => {
      if (variables.targetRunId !== runId) return;
      setMessagePageState((current) => ({
        runId: variables.targetRunId,
        detailUpdatedAt: variables.detailUpdatedAt,
        pages:
          current.runId === variables.targetRunId && current.detailUpdatedAt === variables.detailUpdatedAt
            ? [...current.pages, page.sessionMessages]
            : [page.sessionMessages],
      }));
    },
  });
  const detailUpdatedAt = detailQuery.dataUpdatedAt;
  const messagePages =
    messagePageState.runId === runId && messagePageState.detailUpdatedAt === detailUpdatedAt
      ? messagePageState.pages
      : [];
  const messages = useMemo(() => {
    const records = new Map<string, TaskExecutionSessionMessageRecord>();
    for (const record of detailQuery.data?.sessionMessages.items ?? []) records.set(record.id, record);
    for (const page of messagePages) {
      for (const record of page.items) records.set(record.id, record);
    }
    return [...records.values()].sort((left, right) => left.seq - right.seq);
  }, [detailQuery.data?.sessionMessages.items, messagePages]);

  if (detailQuery.isLoading && !detailQuery.data) {
    return (
      <div className="space-y-4" role="status" aria-label="Loading run detail">
        {run ? (
          <div className="flex flex-wrap items-center gap-2 border-b pb-4">
            <DomainStatus status={run.status} />
            <Badge variant="outline" className="capitalize">
              {run.kind}
            </Badge>
            <span className="truncate font-mono text-xs text-muted-foreground">{run.id}</span>
          </div>
        ) : null}
        <Shimmer className="text-sm">Loading execution transcript and protocol records…</Shimmer>
      </div>
    );
  }

  if (!detailQuery.data) {
    return (
      <Alert variant="destructive">
        <AlertTriangleIcon />
        <AlertTitle>Could not load this run</AlertTitle>
        <AlertDescription>
          <p>
            {detailQuery.error instanceof Error
              ? detailQuery.error.message
              : "The joined execution record is unavailable."}
          </p>
          <Button type="button" size="sm" variant="outline" onClick={() => void detailQuery.refetch()}>
            <RefreshCwIcon />
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  const detail = detailQuery.data;
  const latestMessagePage = messagePages.at(-1);
  const messageCursor = latestMessagePage ? latestMessagePage.nextCursor : detail.sessionMessages.nextCursor;
  const transcriptTruncated = latestMessagePage
    ? latestMessagePage.truncated
    : detail.sessionMessages.truncated;
  const isCurrentPageMutation =
    messagePageMutation.variables?.targetRunId === runId &&
    messagePageMutation.variables.detailUpdatedAt === detailUpdatedAt;
  const outputs = collectRunOutputs(messages);
  return (
    <div className="min-w-0 space-y-5">
      <AgentRunHeader
        detail={detail}
        task={taskQuery.data}
        taskLoading={taskQuery.isLoading}
        agent={agent}
        companyId={companyId}
      />

      {detailQuery.error ? (
        <Alert variant="destructive">
          <AlertTriangleIcon />
          <AlertTitle>Could not refresh this run</AlertTitle>
          <AlertDescription>Showing the most recently loaded execution record.</AlertDescription>
        </Alert>
      ) : null}

      {detail.run.terminalReasonCode ? (
        <Alert variant={FAILURE_STATUSES.has(detail.run.status) ? "destructive" : "default"}>
          <AlertTriangleIcon />
          <AlertTitle className="capitalize">
            {humanizeRunValue(detail.run.terminalClassification ?? detail.run.status)}
          </AlertTitle>
          <AlertDescription className="capitalize">
            {humanizeRunValue(detail.run.terminalReasonCode)}
          </AlertDescription>
        </Alert>
      ) : null}

      <AgentRunLifecycle detail={detail} task={taskQuery.data} companyId={companyId} />
      <AgentRunTranscript
        run={detail.run}
        records={messages}
        truncated={transcriptTruncated}
        hasMore={Boolean(messageCursor)}
        isLoadingMore={isCurrentPageMutation && messagePageMutation.isPending}
        loadMoreError={isCurrentPageMutation ? messagePageMutation.error : null}
        onLoadMore={
          messageCursor
            ? () =>
                messagePageMutation.mutate({
                  targetRunId: runId,
                  cursor: messageCursor,
                  detailUpdatedAt,
                })
            : undefined
        }
      />
      <AgentRunOutputs outputs={outputs} partial={transcriptTruncated} />
      <AgentRunDiagnostics detail={detail} task={taskQuery.data} companyId={companyId} />
    </div>
  );
}
