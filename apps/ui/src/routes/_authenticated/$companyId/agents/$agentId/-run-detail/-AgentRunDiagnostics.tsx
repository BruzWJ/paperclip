import type { TaskExecutionRunJoinedDetail } from "@/api/runs";
import { CodeBlock } from "@/components/ai-elements/code-block";
import { Task, TaskContent, TaskItem, TaskItemFile, TaskTrigger } from "@/components/ai-elements/task";
import { Badge } from "@/components/ui/badge";
import { formatDateTime, formatMoneyAmount } from "@/lib/utils";
import type { Task as PaperclipTask } from "@paperclipai/shared";
import { Link } from "@tanstack/react-router";
import { ActivityIcon, CircleDotIcon, CoinsIcon, RadioIcon } from "lucide-react";
import { humanizeRunValue } from "./-agent-run-detail-model";

function BoundedLabel({ truncated }: { truncated: boolean }) {
  return truncated ? <Badge variant="outline">Bounded view</Badge> : null;
}

function ProtocolTrace({ detail }: { detail: TaskExecutionRunJoinedDetail }) {
  const events = [...detail.sessionEvents.items].sort((left, right) => left.seq - right.seq);
  if (!events.length) return <TaskItem>No protocol events have been recorded.</TaskItem>;
  return (
    <Task defaultOpen={false}>
      <TaskTrigger title={`Protocol event log · ${events.length} event${events.length === 1 ? "" : "s"}`} />
      <TaskContent>
        <ol className="space-y-2">
          {events.map((event, index) => {
            const isLiveTail =
              detail.run.status === "running" &&
              !detail.sessionEvents.truncated &&
              index === events.length - 1;
            return (
              <li key={event.id} className="min-w-0 rounded-lg border p-3">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <RadioIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="min-w-0 flex-1 break-words font-medium capitalize">
                    {humanizeRunValue(event.type)}
                  </span>
                  {isLiveTail ? <Badge variant="secondary">Latest · live run</Badge> : null}
                  <span className="font-mono text-xs text-muted-foreground">seq {event.seq}</span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{formatDateTime(event.createdAt)}</p>
                {Object.keys(event.data).length ? (
                  <div className="mt-2">
                    <CodeBlock code={JSON.stringify(event.data, null, 2)} language="json" />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
      </TaskContent>
    </Task>
  );
}

function PromptProtocolFields({
  transmission,
  settlement,
  outcome,
  steering,
}: {
  transmission: string;
  settlement: string | null;
  outcome: string | null;
  steering?: string;
}) {
  return (
    <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
      {steering ? (
        <div className="flex gap-1">
          <dt className="text-muted-foreground">Steering</dt>
          <dd className="capitalize">{humanizeRunValue(steering)}</dd>
        </div>
      ) : null}
      <div className="flex gap-1">
        <dt className="text-muted-foreground">Transmission</dt>
        <dd className="capitalize">{humanizeRunValue(transmission)}</dd>
      </div>
      <div className="flex gap-1">
        <dt className="text-muted-foreground">Protocol settlement</dt>
        <dd className="capitalize">{settlement ? humanizeRunValue(settlement) : "Not settled"}</dd>
      </div>
      <div className="flex gap-1">
        <dt className="text-muted-foreground">Outcome</dt>
        <dd className="capitalize">{outcome ? humanizeRunValue(outcome) : "Not recorded"}</dd>
      </div>
    </dl>
  );
}

function PromptSettlement({ detail }: { detail: TaskExecutionRunJoinedDetail }) {
  const count = detail.refs.items.length + detail.segments.items.length;
  return (
    <Task defaultOpen={false}>
      <TaskTrigger title={`Prompt settlement · ${count} prompt${count === 1 ? "" : "s"}`} />
      <TaskContent>
        {detail.refs.truncated || detail.segments.truncated ? (
          <TaskItem>Prompt records are bounded and may be partial.</TaskItem>
        ) : null}
        {detail.refs.items.map((ref) => (
          <TaskItem key={`${ref.refId}-${ref.refOrdinal}`} className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">Base</Badge>
              <span>ref {ref.refOrdinal}</span>
            </div>
            <PromptProtocolFields
              transmission={ref.promptTransmissionPhase}
              settlement={ref.protocolSettlementState}
              outcome={ref.outcome}
            />
            <TaskItemFile>{ref.refId}</TaskItemFile>
          </TaskItem>
        ))}
        {detail.segments.items.map((segment) => (
          <TaskItem key={`${segment.refId}-${segment.segmentOrdinal}`} className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">Steering</Badge>
              <span>segment {segment.segmentOrdinal}</span>
            </div>
            <PromptProtocolFields
              steering={segment.steeringState}
              transmission={segment.promptTransmissionPhase}
              settlement={segment.protocolSettlementState}
              outcome={segment.outcome}
            />
            <TaskItemFile>{segment.sourceCommentId}</TaskItemFile>
          </TaskItem>
        ))}
      </TaskContent>
    </Task>
  );
}

function AccountingAndCost({ detail }: { detail: TaskExecutionRunJoinedDetail }) {
  return (
    <Task defaultOpen={false}>
      <TaskTrigger
        title={`Usage and cost · ${detail.accounting.items.length} observation${
          detail.accounting.items.length === 1 ? "" : "s"
        }`}
      />
      <TaskContent>
        {detail.accounting.truncated || detail.costs.truncated ? (
          <TaskItem>Usage or cost records are bounded and may be partial.</TaskItem>
        ) : null}
        {detail.accounting.items.map((record) => {
          const cost = detail.costs.items.find((event) => event.accountingId === record.id);
          return (
            <TaskItem key={record.id} className="space-y-1 rounded-lg border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <CoinsIcon className="size-4" />
                <span className="font-medium capitalize">{record.promptKind} prompt</span>
                {record.selectedModelId ? (
                  <Badge
                    variant="outline"
                    className="max-w-48 truncate font-mono font-normal"
                    title={record.selectedModelId}
                  >
                    {record.selectedModelId}
                  </Badge>
                ) : null}
                <span className="ml-auto font-mono text-xs">
                  {record.contextUsedTokens.toLocaleString()} / {record.contextWindowTokens.toLocaleString()}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                ref {record.runOrdinal ?? "—"} · segment {record.segmentOrdinal ?? "—"} · settled{" "}
                {formatDateTime(record.settledAt)}
              </p>
              {cost ? (
                <p className="text-xs">
                  {cost.kind === "known" && cost.knownDeltaAmount
                    ? formatMoneyAmount(cost.knownDeltaAmount, cost.budgetCurrency)
                    : `Cost unavailable · ${humanizeRunValue(cost.unavailableReason ?? "unknown")}`}
                </p>
              ) : null}
            </TaskItem>
          );
        })}
        {!detail.accounting.items.length ? <TaskItem>No terminal context observations.</TaskItem> : null}
      </TaskContent>
    </Task>
  );
}

function AuditRecords({
  detail,
  task,
  companyId,
}: {
  detail: TaskExecutionRunJoinedDetail;
  task?: PaperclipTask;
  companyId?: string;
}) {
  return (
    <Task defaultOpen={false}>
      <TaskTrigger
        title={`Audit activity · ${detail.activity.items.length} record${
          detail.activity.items.length === 1 ? "" : "s"
        }`}
      />
      <TaskContent>
        {detail.activity.truncated || detail.outputComments.truncated ? (
          <TaskItem>Audit or output-link records are bounded and may be partial.</TaskItem>
        ) : null}
        {detail.activity.items.map((record) => (
          <TaskItem key={record.id} className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <ActivityIcon className="size-4" />
              <span className="capitalize">{humanizeRunValue(record.action)}</span>
              <span className="text-xs text-muted-foreground">
                {record.actorType} · {formatDateTime(record.createdAt)}
              </span>
            </div>
            {record.details ? (
              <CodeBlock code={JSON.stringify(record.details, null, 2)} language="json" />
            ) : null}
          </TaskItem>
        ))}
        {detail.outputComments.items.map((record) => (
          <TaskItem key={`${record.commentId}-${record.messageId}`} className="flex flex-wrap gap-2">
            <CircleDotIcon className="size-4" />
            <span className="capitalize">{humanizeRunValue(record.sourceKind)}</span>
            <TaskItemFile className="max-w-full">
              {task && companyId ? (
                <Link
                  to="/$companyId/tasks/$taskNumber"
                  params={{ companyId, taskNumber: String(task.taskNumber) }}
                  hash={`comment-${record.commentId}`}
                  className="truncate underline-offset-4 hover:underline"
                  aria-label={`Open output comment ${record.commentId} on ${task.identifier}`}
                  title={record.commentId}
                >
                  {record.commentId}
                </Link>
              ) : (
                record.commentId
              )}
            </TaskItemFile>
            <span>event seq {record.projectedEventSeq}</span>
          </TaskItem>
        ))}
      </TaskContent>
    </Task>
  );
}

export function AgentRunDiagnostics({
  detail,
  task,
  companyId,
}: {
  detail: TaskExecutionRunJoinedDetail;
  task?: PaperclipTask;
  companyId?: string;
}) {
  return (
    <Task defaultOpen={false} data-testid="run-protocol-diagnostics">
      <TaskTrigger
        title={`Protocol diagnostics · ${detail.sessionEvents.items.length} event${
          detail.sessionEvents.items.length === 1 ? "" : "s"
        }`}
      />
      <TaskContent>
        <div className="flex flex-wrap gap-2">
          <BoundedLabel truncated={detail.sessionEvents.truncated} />
          <Badge variant="outline">
            {detail.refs.items.length} base prompt{detail.refs.items.length === 1 ? "" : "s"}
          </Badge>
          <Badge variant="outline">
            {detail.segments.items.length} steering prompt
            {detail.segments.items.length === 1 ? "" : "s"}
          </Badge>
          <Badge variant="outline">
            {detail.activity.items.length} audit record{detail.activity.items.length === 1 ? "" : "s"}
          </Badge>
        </div>
        <ProtocolTrace detail={detail} />
        <PromptSettlement detail={detail} />
        <AccountingAndCost detail={detail} />
        <AuditRecords detail={detail} task={task} companyId={companyId} />
      </TaskContent>
    </Task>
  );
}
