import { useMemo, useState, type ReactNode } from "react";
import type {
  ActivityEvent,
  Agent,
  Issue,
  IssueExecutionRunEnvelopeRecord,
  IssueExecutionRunListPageRecord,
  IssueExecutionRunLivenessFact,
} from "@paperclipai/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { accessApi, type CurrentBoardAccess } from "../api/access";
import { ApiError } from "../api/client";
import {
  runsApi,
  type IssueExecutionRunJoinedDetail,
  type WatchdogDecisionInput,
} from "../api/runs";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { keepPreviousDataForSameQueryTail } from "../lib/query-placeholder-data";
import { cn, relativeTime } from "../lib/utils";

type IssueRunLedgerProps = {
  issueId: string;
  companyId: string;
  issueStatus: Issue["boardPresentationStatus"];
  childIssues: Issue[];
  agentMap: ReadonlyMap<string, Agent>;
  hasLiveRuns: boolean;
  activityEvents?: ActivityEvent[];
  renderActivityEvent?: (event: ActivityEvent) => ReactNode;
  resolveUserLabel?: (userId: string) => string | null | undefined;
};

type IssueRunLedgerContentProps = {
  runs: IssueExecutionRunEnvelopeRecord[];
  selectedDetail?: IssueExecutionRunJoinedDetail | null;
  selectedRunId?: string | null;
  onSelectRun?: (runId: string) => void;
  issueStatus: Issue["boardPresentationStatus"];
  childIssues: Issue[];
  agentMap: ReadonlyMap<string, Pick<Agent, "name">>;
  activityEvents?: ActivityEvent[];
  renderActivityEvent?: (event: ActivityEvent) => ReactNode;
  pendingWatchdogDecision?: WatchdogDecisionInput["decision"] | null;
  canRecordWatchdogDecisions?: boolean;
  watchdogDecisionError?: string | null;
  onWatchdogDecision?: (input: WatchdogDecisionInput) => void;
};

type LedgerFeedItem =
  | { kind: "run-group"; id: string; timestamp: string; group: IssueRunLedgerGroup }
  | { kind: "activity"; id: string; timestamp: string; event: ActivityEvent };

export type IssueRunLedgerGroup = {
  id: string;
  parent: IssueExecutionRunEnvelopeRecord;
  compactions: IssueExecutionRunEnvelopeRecord[];
  timestamp: string;
  orphanedCompaction: boolean;
};

const TERMINAL_CHILD_STATUSES = new Set<Issue["boardPresentationStatus"]>([
  "done",
  "cancelled",
]);

const LIVENESS_COPY: Record<
  IssueExecutionRunLivenessFact["livenessState"],
  { label: string; tone: string }
> = {
  completed: {
    label: "Completed",
    tone: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  },
  advanced: {
    label: "Advanced",
    tone: "border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300",
  },
  plan_only: {
    label: "Plan only",
    tone: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  },
  empty_response: {
    label: "Empty response",
    tone: "border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-300",
  },
  blocked: {
    label: "Blocked",
    tone: "border-yellow-500/30 bg-yellow-500/10 text-yellow-700 dark:text-yellow-300",
  },
  failed: {
    label: "Failed",
    tone: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
  },
  needs_followup: {
    label: "Needs follow-up",
    tone: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  },
};

function runTimestamp(run: IssueExecutionRunEnvelopeRecord): string {
  return run.startedAt ?? run.createdAt;
}

function timestampValue(value: string): number {
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function compareRunsNewestFirst(
  left: IssueExecutionRunEnvelopeRecord,
  right: IssueExecutionRunEnvelopeRecord,
): number {
  return timestampValue(runTimestamp(right)) - timestampValue(runTimestamp(left)) ||
    right.id.localeCompare(left.id);
}

export function projectIssueRunLedgerGroups(
  runs: readonly IssueExecutionRunEnvelopeRecord[],
): IssueRunLedgerGroup[] {
  const productiveParents = new Map<
    string,
    {
      parent: IssueExecutionRunEnvelopeRecord;
      compactions: IssueExecutionRunEnvelopeRecord[];
    }
  >();
  for (const run of runs) {
    if (run.kind !== "compaction" && !productiveParents.has(run.id)) {
      productiveParents.set(run.id, { parent: run, compactions: [] });
    }
  }

  const orphanedCompactions: IssueExecutionRunEnvelopeRecord[] = [];
  for (const run of runs) {
    if (run.kind !== "compaction") continue;
    const parent = run.triggeredByRunId
      ? productiveParents.get(run.triggeredByRunId)
      : undefined;
    if (parent) {
      parent.compactions.push(run);
    } else {
      orphanedCompactions.push(run);
    }
  }

  const groups: IssueRunLedgerGroup[] = [];
  for (const { parent, compactions } of productiveParents.values()) {
    compactions.sort(compareRunsNewestFirst);
    const newest = [parent, ...compactions].sort(compareRunsNewestFirst)[0]!;
    groups.push({
      id: parent.id,
      parent,
      compactions,
      timestamp: runTimestamp(newest),
      orphanedCompaction: false,
    });
  }
  for (const compaction of orphanedCompactions.sort(compareRunsNewestFirst)) {
    groups.push({
      id: compaction.id,
      parent: compaction,
      compactions: [],
      timestamp: runTimestamp(compaction),
      orphanedCompaction: true,
    });
  }
  return groups.sort((left, right) =>
    timestampValue(right.timestamp) - timestampValue(left.timestamp) ||
    right.id.localeCompare(left.id));
}

export function defaultIssueRunLedgerRunId(
  runs: readonly IssueExecutionRunEnvelopeRecord[],
): string | null {
  return projectIssueRunLedgerGroups(runs).find(
    (group) => !group.orphanedCompaction,
  )?.parent.id ?? null;
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
  run: IssueExecutionRunEnvelopeRecord,
  agentMap: ReadonlyMap<string, Pick<Agent, "name">>,
) {
  if (!run.targetAgentId) return "Paperclip compaction";
  return agentMap.get(run.targetAgentId)?.name ?? run.targetAgentId.slice(0, 8);
}

function runSummary(
  run: IssueExecutionRunEnvelopeRecord,
  agentMap: ReadonlyMap<string, Pick<Agent, "name">>,
) {
  const agent = runAgentName(run, agentMap);
  if (run.status === "running") return `Running now by ${agent}`;
  if (run.status === "queued") return `Queued for ${agent}`;
  if (run.status === "scheduled_retry") return `Retry scheduled for ${agent}`;
  return `${statusLabel(run.status)} by ${agent}`;
}

function childIssueSummary(childIssues: Issue[]) {
  const active = childIssues.filter(
    (issue) => !TERMINAL_CHILD_STATUSES.has(issue.boardPresentationStatus),
  );
  return {
    active,
    done: childIssues.filter((issue) => issue.boardPresentationStatus === "done").length,
    cancelled: childIssues.filter((issue) => issue.boardPresentationStatus === "cancelled").length,
    total: childIssues.length,
  };
}

function canBoardRecordWatchdogDecision(
  companyId: string,
  boardAccess: CurrentBoardAccess | undefined,
) {
  if (!boardAccess) return false;
  if (boardAccess.isInstanceAdmin) return true;
  const membership = boardAccess.memberships?.find(
    (item) => item.companyId === companyId && item.status === "active",
  );
  if (!membership) {
    return boardAccess.companyIds.includes(companyId) && !boardAccess.memberships;
  }
  return membership.membershipRole !== "viewer" && membership.membershipRole !== null;
}

function watchdogDecisionErrorMessage(error: unknown) {
  if (error instanceof ApiError && error.status === 403) {
    return "Only the board or the assigned recovery owner can record watchdog decisions";
  }
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "Paperclip could not record the watchdog decision.";
}

export function IssueRunLedger({
  issueId,
  companyId,
  issueStatus,
  childIssues,
  agentMap,
  hasLiveRuns,
  activityEvents,
  renderActivityEvent,
}: IssueRunLedgerProps) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [watchdogDecisionError, setWatchdogDecisionError] = useState<string | null>(null);
  const { data: boardAccess } = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    retry: false,
  });
  const { data: runPage } = useQuery({
    queryKey: queryKeys.issues.runs(issueId),
    queryFn: () => runsApi.listForIssue(issueId, { limit: 200 }),
    refetchInterval: hasLiveRuns || issueStatus === "in_progress" ? 5000 : false,
    placeholderData:
      keepPreviousDataForSameQueryTail<IssueExecutionRunListPageRecord>(issueId),
  });
  const runs = runPage?.items ?? [];
  const defaultRunId = useMemo(
    () => defaultIssueRunLedgerRunId(runs),
    [runs],
  );
  const effectiveSelectedRunId =
    selectedRunId && runs.some((run) => run.id === selectedRunId)
      ? selectedRunId
      : defaultRunId;
  const { data: selectedDetail } = useQuery({
    queryKey: queryKeys.runDetail(effectiveSelectedRunId ?? "pending"),
    queryFn: () => runsApi.get(effectiveSelectedRunId!),
    enabled: Boolean(effectiveSelectedRunId),
    refetchInterval: selectedRunId && hasLiveRuns ? 3000 : false,
  });
  const watchdogDecision = useMutation({
    mutationFn: (input: WatchdogDecisionInput) => runsApi.recordWatchdogDecision(input),
    onMutate: () => setWatchdogDecisionError(null),
    onSuccess: (_record, input) => {
      setWatchdogDecisionError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.runDetail(input.runId) });
    },
    onError: (error) => {
      const message = watchdogDecisionErrorMessage(error);
      setWatchdogDecisionError(message);
      pushToast({
        title: "Watchdog decision not recorded",
        body: message,
        tone: "error",
        dedupeKey: `watchdog-decision:${issueId}`,
      });
    },
  });

  return (
    <IssueRunLedgerContent
      runs={runs}
      selectedDetail={selectedDetail}
      selectedRunId={effectiveSelectedRunId}
      onSelectRun={setSelectedRunId}
      issueStatus={issueStatus}
      childIssues={childIssues}
      agentMap={agentMap}
      activityEvents={activityEvents}
      renderActivityEvent={renderActivityEvent}
      pendingWatchdogDecision={watchdogDecision.variables?.decision ?? null}
      canRecordWatchdogDecisions={canBoardRecordWatchdogDecision(companyId, boardAccess)}
      watchdogDecisionError={watchdogDecisionError}
      onWatchdogDecision={(input) => watchdogDecision.mutate(input)}
    />
  );
}

export function IssueRunLedgerContent({
  runs,
  selectedDetail,
  selectedRunId,
  onSelectRun,
  issueStatus,
  childIssues,
  agentMap,
  activityEvents,
  renderActivityEvent,
  pendingWatchdogDecision,
  canRecordWatchdogDecisions = true,
  watchdogDecisionError,
  onWatchdogDecision,
}: IssueRunLedgerContentProps) {
  const runGroups = useMemo(() => projectIssueRunLedgerGroups(runs), [runs]);
  const latestRun = runGroups.find(
    (group) => !group.orphanedCompaction,
  )?.parent ?? null;
  const children = childIssueSummary(childIssues);
  const feedItems = useMemo<LedgerFeedItem[]>(() => {
    const items: LedgerFeedItem[] = runGroups.map((group) => ({
      kind: "run-group",
      id: group.id,
      timestamp: group.timestamp,
      group,
    }));
    if (renderActivityEvent) {
      for (const event of activityEvents ?? []) {
        items.push({
          kind: "activity",
          id: event.id,
          timestamp:
            event.createdAt instanceof Date
              ? event.createdAt.toISOString()
              : String(event.createdAt),
          event,
        });
      }
    }
    return items.sort((left, right) => {
      const difference =
        new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime();
      return difference || right.id.localeCompare(left.id);
    });
  }, [activityEvents, renderActivityEvent, runGroups]);
  const selectedLiveness =
    selectedDetail?.run.id === selectedRunId
      ? selectedDetail?.finalization?.liveness ?? null
      : null;
  const selectedRetry = selectedDetail?.retrySchedules.items.at(-1) ?? null;
  const selectedDecisions = selectedDetail?.watchdogDecisions.items ?? [];
  const renderRunCard = (
    run: IssueExecutionRunEnvelopeRecord,
    options: {
      nested?: boolean;
      orphanedCompaction?: boolean;
    } = {},
  ) => {
    const isSelected = run.id === selectedRunId;
    const liveness = isSelected && selectedLiveness
      ? LIVENESS_COPY[selectedLiveness.livenessState]
      : null;
    return (
      <article
        key={`run:${run.id}`}
        data-run-id={run.id}
        data-run-kind={run.kind}
        className={cn(
          "space-y-1.5 rounded-lg border px-3 py-2 text-xs text-muted-foreground",
          options.nested && "ml-4 border-violet-500/20 bg-violet-500/5",
          isSelected ? "border-foreground/30 bg-accent/20" : "border-border/60",
        )}
      >
        <button
          type="button"
          className="flex w-full flex-wrap items-center gap-1.5 text-left"
          onClick={() => onSelectRun?.(run.id)}
        >
          <span className="font-medium text-foreground">Run</span>
          <span className="font-mono text-foreground">{run.id.slice(0, 8)}</span>
          <span>by {runAgentName(run, agentMap)}</span>
          <span className="rounded-md border border-border px-1.5 py-0.5 text-(length:--text-micro) capitalize">
            {statusLabel(run.status)}
          </span>
          {run.kind === "compaction" ? (
            <span className="rounded-md border border-violet-500/30 bg-violet-500/10 px-1.5 py-0.5 text-(length:--text-micro) text-violet-700 dark:text-violet-300">
              recovery compaction
            </span>
          ) : null}
          {options.orphanedCompaction ? (
            <span className="rounded-md border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-(length:--text-micro) text-amber-700 dark:text-amber-300">
              triggering run unavailable
            </span>
          ) : null}
          {liveness ? (
            <span className={cn("rounded-md border px-1.5 py-0.5 text-(length:--text-micro)", liveness.tone)}>
              {liveness.label}
            </span>
          ) : null}
          <span className="ml-auto">{relativeTime(runTimestamp(run))}</span>
        </button>
        <div className="grid gap-2 sm:grid-cols-3">
          <div><span className="text-foreground">Elapsed</span> {formatDuration(run.startedAt, run.finishedAt) ?? "not started"}</div>
          <div><span className="text-foreground">Mode</span> {run.executionMode ?? run.compactionScopeKind ?? "—"}</div>
          <div><span className="text-foreground">Terminal reason</span> {run.terminalReasonCode ?? "—"}</div>
        </div>
        {isSelected && selectedLiveness ? (
          <div className="rounded-md bg-accent/40 px-2 py-1.5">
            <p>{selectedLiveness.livenessReason}</p>
            {selectedLiveness.nextAction ? (
              <p><span className="font-medium text-foreground">Next action:</span> {selectedLiveness.nextAction}</p>
            ) : null}
          </div>
        ) : null}
        {isSelected && selectedRetry ? (
          <p>
            Retry {statusLabel(selectedRetry.state)} for {relativeTime(selectedRetry.retryAt)}: {selectedRetry.reasonCode}
          </p>
        ) : null}
        {isSelected && selectedDecisions.length > 0 ? (
          <div className="space-y-1 rounded-md border border-border/70 px-2 py-1.5">
            <p className="font-medium text-foreground">Watchdog decisions</p>
            {selectedDecisions.map((decision) => (
              <p key={decision.id}>
                {statusLabel(decision.decision)}{decision.reason ? ` — ${decision.reason}` : ""}
              </p>
            ))}
          </div>
        ) : null}
        {isSelected && onWatchdogDecision && canRecordWatchdogDecisions && run.status === "running" ? (
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              className="rounded-md border border-border bg-background px-2 py-1 text-(length:--text-micro) text-foreground"
              disabled={pendingWatchdogDecision != null}
              onClick={() => onWatchdogDecision({ runId: run.id, decision: "continue" })}
            >
              Continue monitoring
            </button>
            <button
              type="button"
              className="rounded-md border border-border bg-background px-2 py-1 text-(length:--text-micro) text-foreground"
              disabled={pendingWatchdogDecision != null}
              onClick={() => onWatchdogDecision({
                runId: run.id,
                decision: "snooze",
                snoozedUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
                reason: "Snoozed from task run ledger",
              })}
            >
              Snooze 1h
            </button>
            <button
              type="button"
              className="rounded-md border border-border bg-background px-2 py-1 text-(length:--text-micro) text-foreground"
              disabled={pendingWatchdogDecision != null}
              onClick={() => onWatchdogDecision({
                runId: run.id,
                decision: "dismissed_false_positive",
                reason: "Dismissed from task run ledger",
              })}
            >
              Mark false positive
            </button>
          </div>
        ) : null}
        {isSelected && watchdogDecisionError ? (
          <p className="rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1 text-red-900 dark:text-red-200">
            {watchdogDecisionError}
          </p>
        ) : null}
      </article>
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
              : issueStatus === "in_progress"
                ? "Waiting for the first run record."
                : "No runs linked yet."}
          </p>
        </div>
        {latestRun?.targetAgentId ? (
          <Link
            to={`/agents/${latestRun.targetAgentId}/runs/${latestRun.id}`}
            className="shrink-0 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
          >
            Latest run
          </Link>
        ) : null}
      </div>

      {children.total > 0 ? (
        <div className="rounded-md border border-border/70 px-3 py-2">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-medium text-foreground">Child work</span>
            <span className="text-muted-foreground">
              {children.active.length > 0
                ? `${children.active.length} active, ${children.done} done, ${children.cancelled} cancelled`
                : `all ${children.total} terminal (${children.done} done, ${children.cancelled} cancelled)`}
            </span>
          </div>
        </div>
      ) : null}

      {feedItems.length === 0 ? (
        <div className="rounded-md border border-dashed border-border px-3 py-3 text-sm text-muted-foreground">
          Runs and activity will appear here once this task has history.
        </div>
      ) : (
        <div className="space-y-1.5">
          {feedItems.slice(0, 20).map((item) => {
            if (item.kind === "activity") {
              return <div key={`activity:${item.id}`}>{renderActivityEvent?.(item.event)}</div>;
            }
            const group = item.group;
            if (group.orphanedCompaction) {
              return renderRunCard(group.parent, {
                orphanedCompaction: true,
              });
            }
            return (
              <div
                key={`run-group:${group.id}`}
                data-run-group-id={group.id}
                className="space-y-1.5"
              >
                {renderRunCard(group.parent)}
                {group.compactions.length > 0 ? (
                  <div
                    className="space-y-1"
                    aria-label={`Recovery compactions for run ${group.parent.id}`}
                  >
                    {group.compactions.map((compaction) =>
                      renderRunCard(compaction, { nested: true }))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
