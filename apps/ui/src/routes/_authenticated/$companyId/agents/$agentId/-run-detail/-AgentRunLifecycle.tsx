import type { TaskExecutionRunJoinedDetail } from "@/api/runs";
import {
  Queue,
  QueueItem,
  QueueItemContent,
  QueueItemDescription,
  QueueItemIndicator,
  QueueList,
  QueueSection,
  QueueSectionContent,
  QueueSectionLabel,
  QueueSectionTrigger,
} from "@/components/ai-elements/queue";
import { Source, Sources, SourcesContent, SourcesTrigger } from "@/components/ai-elements/sources";
import { Task, TaskContent, TaskItem, TaskItemFile, TaskTrigger } from "@/components/ai-elements/task";
import { DomainStatus } from "@/components/patterns/DomainStatus";
import { Badge } from "@/components/ui/badge";
import { formatDateTime, formatDurationMs, relativeTime } from "@/lib/utils";
import type { Task as PaperclipTask } from "@paperclipai/shared";
import { Link } from "@tanstack/react-router";
import { BookOpenIcon, ChevronDownIcon, Clock3Icon, GitPullRequestArrowIcon } from "lucide-react";
import { humanizeRunValue } from "./-agent-run-detail-model";

const TERMINAL_ATTEMPT_STATES = new Set(["settled", "failed", "cancelled"]);

function attemptDuration(startedAt: string | null, finishedAt: string | null) {
  if (!startedAt) return null;
  const start = new Date(startedAt).getTime();
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

function promptSettlementLabel(value: string | null) {
  return value ? humanizeRunValue(value) : "pending";
}

function dependencyCountLabel(count: number, singular: string, plural: string, truncated: boolean) {
  return `${count} ${truncated ? "loaded " : ""}${count === 1 ? singular : plural}${
    truncated ? " (partial)" : ""
  }`;
}

function PromptSources({
  detail,
  task,
  companyId,
}: {
  detail: TaskExecutionRunJoinedDetail;
  task: PaperclipTask | undefined;
  companyId: string;
}) {
  if (!task) return null;
  const sources = [
    ...detail.refs.items.map((ref) => ({
      id: ref.refId,
      title: `Base prompt · ref ${ref.refOrdinal} · transmission ${humanizeRunValue(
        ref.promptTransmissionPhase,
      )} · settlement ${promptSettlementLabel(ref.protocolSettlementState)}`,
      href: `/${companyId}/tasks/${task.taskNumber}`,
    })),
    ...detail.segments.items.map((segment) => ({
      id: `${segment.refId}-${segment.segmentOrdinal}`,
      title: `Steering prompt · segment ${segment.segmentOrdinal} · steering ${humanizeRunValue(
        segment.steeringState,
      )} · transmission ${humanizeRunValue(
        segment.promptTransmissionPhase,
      )} · settlement ${promptSettlementLabel(segment.protocolSettlementState)}`,
      href: `/${companyId}/tasks/${task.taskNumber}#comment-${segment.sourceCommentId}`,
    })),
  ];
  if (sources.length === 0) return null;
  return (
    <Sources>
      <SourcesTrigger count={sources.length} className="group">
        <BookOpenIcon className="size-4"  data-icon="inline-start"/>
        <span className="font-medium">Prompt sources · {sources.length}</span>
        <ChevronDownIcon className="size-4 transition-transform group-data-[state=open]:rotate-180"  data-icon="inline-start"/>
      </SourcesTrigger>
      <SourcesContent>
        {sources.map((source) => (
          <Source key={source.id} href={source.href} title={source.title} target="_self" />
        ))}
      </SourcesContent>
    </Sources>
  );
}

function AttemptQueue({ detail }: { detail: TaskExecutionRunJoinedDetail }) {
  return (
    <Queue>
      <QueueSection defaultOpen>
        <QueueSectionTrigger>
          <QueueSectionLabel
            count={detail.attempts.items.length}
            label={detail.attempts.items.length === 1 ? "attempt" : "attempts"}
            icon={<GitPullRequestArrowIcon className="size-4" />}
          />
        </QueueSectionTrigger>
        <QueueSectionContent>
          <QueueList>
            {detail.attempts.items.map((attempt) => {
              const duration = attemptDuration(attempt.startedAt, attempt.finishedAt);
              const lease = detail.leases.items.find((item) => item.attemptId === attempt.id);
              const cancellation = detail.cancellations.items.find((item) => item.attemptId === attempt.id);
              return (
                <QueueItem key={attempt.id}>
                  <div className="flex items-center gap-2">
                    <QueueItemIndicator completed={TERMINAL_ATTEMPT_STATES.has(attempt.state)} />
                    <QueueItemContent>
                      <span className="capitalize">{humanizeRunValue(attempt.promptKind)} prompt</span>
                      <span className="ml-2 font-mono text-xs">generation {attempt.attemptGeneration}</span>
                    </QueueItemContent>
                    <DomainStatus status={attempt.state} />
                  </div>
                  <QueueItemDescription>
                    {humanizeRunValue(attempt.sessionOperation)} · ref {attempt.refOrdinal ?? "—"} · segment{" "}
                    {attempt.segmentOrdinal ?? "—"}
                    {duration !== null ? ` · ${formatDurationMs(duration)}` : ""}
                    {lease ? ` · lease ${lease.leaseGeneration} ${lease.state}` : ""}
                    {cancellation ? ` · cancellation ${cancellation.state}` : ""}
                  </QueueItemDescription>
                </QueueItem>
              );
            })}
          </QueueList>
        </QueueSectionContent>
      </QueueSection>

      {detail.retrySchedules.items.length ? (
        <QueueSection defaultOpen>
          <QueueSectionTrigger>
            <QueueSectionLabel
              count={detail.retrySchedules.items.length}
              label={detail.retrySchedules.items.length === 1 ? "retry" : "retries"}
              icon={<Clock3Icon className="size-4" />}
            />
          </QueueSectionTrigger>
          <QueueSectionContent>
            <QueueList>
              {detail.retrySchedules.items.map((retry) => (
                <QueueItem key={retry.id}>
                  <div className="flex items-center gap-2">
                    <QueueItemIndicator completed={retry.state !== "scheduled"} />
                    <QueueItemContent>{humanizeRunValue(retry.reasonCode)}</QueueItemContent>
                    <DomainStatus status={retry.state} />
                  </div>
                  <QueueItemDescription>
                    {retry.state === "scheduled"
                      ? `Due ${relativeTime(retry.retryAt)}`
                      : humanizeRunValue(retry.state)}{" "}
                    · predecessor {retry.predecessorAttemptId.slice(0, 8)}
                  </QueueItemDescription>
                </QueueItem>
              ))}
            </QueueList>
          </QueueSectionContent>
        </QueueSection>
      ) : null}
    </Queue>
  );
}

export function AgentRunLifecycle({
  detail,
  task,
  companyId,
}: {
  detail: TaskExecutionRunJoinedDetail;
  task: PaperclipTask | undefined;
  companyId: string;
}) {
  const bounded =
    [
      detail.refs,
      detail.segments,
      detail.attempts,
      detail.retrySchedules,
      detail.leases,
      detail.cancellations,
    ].some((collection) => collection.truncated) ||
    Boolean(
      detail.finalization &&
      (detail.finalization.promptDependencies.truncated || detail.finalization.updateDependencies.truncated),
    );
  return (
    <Task defaultOpen data-testid="run-execution-lifecycle">
      <TaskTrigger
        title={`Execution lifecycle · ${detail.attempts.items.length} attempt${
          detail.attempts.items.length === 1 ? "" : "s"
        }`}
      />
      <TaskContent>
        {bounded ? (
          <TaskItem className="rounded-lg border border-dashed p-3">
            Some execution collections are bounded. The records shown here may be partial.
          </TaskItem>
        ) : null}

        <PromptSources detail={detail} task={task} companyId={companyId} />

        {detail.control ? (
          <TaskItem className="flex flex-wrap items-center gap-2">
            <span>Control pointer</span>
            <TaskItemFile>{detail.control.currentRefId ?? "No current ref"}</TaskItemFile>
            <span>
              ordinal {detail.control.currentOrdinal ?? "—"} · segment{" "}
              {detail.control.currentSegmentOrdinal ?? "—"}
            </span>
          </TaskItem>
        ) : null}

        {detail.finalization ? (
          <TaskItem className="space-y-2 rounded-lg border p-3 text-foreground">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">Finalization</span>
              <Badge variant="secondary" className="capitalize">
                {humanizeRunValue(detail.finalization.record.action)}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {formatDateTime(detail.finalization.record.finalizedAt)}
              </span>
            </div>
            {detail.finalization.liveness ? (
              <div className="space-y-1 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <DomainStatus status={detail.finalization.liveness.livenessState} />
                  <span>{detail.finalization.liveness.livenessReason}</span>
                </div>
                {detail.finalization.liveness.nextAction ? (
                  <p>
                    <span className="text-muted-foreground">Next action: </span>
                    {detail.finalization.liveness.nextAction}
                  </p>
                ) : null}
              </div>
            ) : null}
            {detail.finalization.record.progressCommentId ? (
              task ? (
                <p className="text-xs">
                  <Link
                    to="/$companyId/tasks/$taskNumber"
                    params={{ companyId, taskNumber: String(task.taskNumber) }}
                    hash={`comment-${detail.finalization.record.progressCommentId}`}
                    className="underline-offset-4 hover:underline"
                  >
                    Open finalization progress comment
                  </Link>
                </p>
              ) : (
                <TaskItemFile>{detail.finalization.record.progressCommentId}</TaskItemFile>
              )
            ) : null}
            <p className="text-xs text-muted-foreground">
              {dependencyCountLabel(
                detail.finalization.promptDependencies.items.length,
                "prompt dependency",
                "prompt dependencies",
                detail.finalization.promptDependencies.truncated,
              )}{" "}
              ·{" "}
              {dependencyCountLabel(
                detail.finalization.updateDependencies.items.length,
                "task update dependency",
                "task update dependencies",
                detail.finalization.updateDependencies.truncated,
              )}
            </p>
          </TaskItem>
        ) : null}

        {detail.attempts.items.length ? (
          <AttemptQueue detail={detail} />
        ) : (
          <TaskItem>No execution attempts have been recorded.</TaskItem>
        )}
      </TaskContent>
    </Task>
  );
}
