import type { TaskExecutionSessionMessageRecord } from "@/api/runs";
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
} from "@/components/ai-elements/chain-of-thought";
import { CodeBlock } from "@/components/ai-elements/code-block";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageActions, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Suggestion, Suggestions } from "@/components/ai-elements/suggestion";
import {
  Terminal,
  TerminalActions,
  TerminalContent,
  TerminalCopyButton,
  TerminalHeader,
  TerminalStatus,
  TerminalTitle,
} from "@/components/ai-elements/terminal";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { formatNumber, relativeTime } from "@/lib/utils";
import type { TaskExecutionRunEnvelopeRecord, TaskSessionMessage } from "@paperclipai/shared";
import { BotIcon, LoaderCircleIcon, MessagesSquareIcon, RouteIcon } from "lucide-react";
import type { ReactNode } from "react";
import { AgentRunToolTrace, RunFileReferences } from "./AgentRunToolTrace";
import { decodeRunMessage } from "./agent-run-detail-model";

type AssistantMessage = Extract<TaskSessionMessage, { type: "assistant" }>;
type AssistantContentPart = AssistantMessage["content"][number];

function MessageMeta({
  label,
  record,
  trailing,
}: {
  label: string;
  record: TaskExecutionSessionMessageRecord;
  trailing?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <span className="min-w-0 max-w-full truncate font-medium text-foreground" title={label}>
        {label}
      </span>
      <span className="shrink-0 font-mono">seq {record.seq}</span>
      <span className="shrink-0">{relativeTime(record.timeCreated)}</span>
      {trailing}
    </div>
  );
}

function ReasoningTrace({
  part,
  isCurrent,
}: {
  part: Extract<AssistantContentPart, { type: "reasoning" }>;
  isCurrent: boolean;
}) {
  return (
    <Reasoning isStreaming={isCurrent} defaultOpen={isCurrent} data-streaming={isCurrent || undefined}>
      <ReasoningTrigger />
      <ReasoningContent>{part.text}</ReasoningContent>
    </Reasoning>
  );
}

function ExecutionTrace({
  parts,
  currentPartId,
}: {
  parts: readonly Exclude<AssistantContentPart, { type: "text" }>[];
  currentPartId: string | null;
}) {
  const hasCurrentPart = parts.some((part) => part.id === currentPartId);
  return (
    <ChainOfThought defaultOpen={hasCurrentPart}>
      <ChainOfThoughtHeader>
        Execution trace · {parts.length} step{parts.length === 1 ? "" : "s"}
      </ChainOfThoughtHeader>
      <ChainOfThoughtContent>
        {parts.map((part) =>
          part.type === "reasoning" ? (
            <ReasoningTrace key={part.id} part={part} isCurrent={part.id === currentPartId} />
          ) : (
            <AgentRunToolTrace key={part.id} tool={part} isCurrent={part.id === currentPartId} />
          ),
        )}
      </ChainOfThoughtContent>
    </ChainOfThought>
  );
}

function isIncompleteAssistantPart(part: AssistantContentPart): boolean {
  if (part.type === "text") return true;
  if (part.type === "reasoning") return !part.time?.completed;
  return part.state.status === "pending" || part.state.status === "running";
}

function orderedAssistantContent(message: AssistantMessage, currentPartId: string | null) {
  const result: ReactNode[] = [];
  let trace: Exclude<AssistantContentPart, { type: "text" }>[] = [];
  const flushTrace = () => {
    if (trace.length === 0) return;
    const first = trace[0]!;
    const traceCurrentPartId = trace.some((part) => part.id === currentPartId) ? currentPartId : null;
    result.push(
      <ExecutionTrace
        key={`trace-${first.id}-${traceCurrentPartId ?? "settled"}`}
        parts={trace}
        currentPartId={traceCurrentPartId}
      />,
    );
    trace = [];
  };
  for (const part of message.content) {
    if (part.type !== "text") {
      trace.push(part);
      continue;
    }
    flushTrace();
    if (part.text) {
      const isCurrent = part.id === currentPartId;
      result.push(
        <MessageResponse key={part.id} isAnimating={isCurrent} data-streaming={isCurrent || undefined}>
          {part.text}
        </MessageResponse>,
      );
    }
  }
  flushTrace();
  return result;
}

function AssistantTurn({
  message,
  record,
  isCurrentRecord,
}: {
  message: AssistantMessage;
  record: TaskExecutionSessionMessageRecord;
  isCurrentRecord: boolean;
}) {
  const finalPart = message.content.at(-1);
  const currentPartId =
    isCurrentRecord && !message.time.completed && finalPart && isIncompleteAssistantPart(finalPart)
      ? finalPart.id
      : null;
  const modelLabel = message.model ? `${message.model.providerID}/${message.model.id}` : null;
  return (
    <Message
      from="assistant"
      data-message-role="assistant"
      data-current-record={isCurrentRecord || undefined}
    >
      <MessageMeta
        label={message.agent || "Agent"}
        record={record}
        trailing={
          modelLabel ? (
            <Badge variant="outline" className="min-w-0 max-w-full font-mono font-normal" title={modelLabel}>
              <span className="truncate">{modelLabel}</span>
            </Badge>
          ) : null
        }
      />
      <MessageContent className="w-full">
        {orderedAssistantContent(message, currentPartId)}
        {message.error ? (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{message.error.message}</AlertDescription>
          </Alert>
        ) : null}
      </MessageContent>
      {message.finish || message.tokens ? (
        <MessageActions className="flex-wrap text-xs text-muted-foreground">
          {message.finish ? <span className="capitalize">{message.finish}</span> : null}
          {message.tokens ? (
            <>
              <span>{formatNumber(message.tokens.input)} input</span>
              <span>{formatNumber(message.tokens.output)} output</span>
              {message.tokens.reasoning ? (
                <span>{formatNumber(message.tokens.reasoning)} reasoning</span>
              ) : null}
              {message.tokens.cache.read || message.tokens.cache.write ? (
                <span>
                  {formatNumber(message.tokens.cache.read)} cache read ·{" "}
                  {formatNumber(message.tokens.cache.write)} cache write
                </span>
              ) : null}
            </>
          ) : null}
        </MessageActions>
      ) : null}
    </Message>
  );
}

function UserTurn({
  message,
  record,
}: {
  message: Extract<TaskSessionMessage, { type: "user" }>;
  record: TaskExecutionSessionMessageRecord;
}) {
  const files = (message.files ?? []).map((file, index) => ({
    id: `${record.id}-file-${index}`,
    uri: file.uri,
    mime: file.mime,
    name: file.name,
    description: file.description,
  }));
  return (
    <Message from="user" data-message-role="user">
      <MessageMeta label="User" record={record} />
      <MessageContent>
        <MessageResponse>{message.text}</MessageResponse>
        <RunFileReferences files={files} label="Attachments" />
        {message.agents?.length ? (
          <div className="flex flex-wrap justify-end gap-1">
            {message.agents.map((agent) => (
              <Badge key={agent.name} variant="secondary">
                @{agent.name}
              </Badge>
            ))}
          </div>
        ) : null}
      </MessageContent>
    </Message>
  );
}

function ShellTurn({
  message,
  record,
  isCurrentRecord,
}: {
  message: Extract<TaskSessionMessage, { type: "shell" }>;
  record: TaskExecutionSessionMessageRecord;
  isCurrentRecord: boolean;
}) {
  const isStreaming = isCurrentRecord && !message.time.completed;
  return (
    <Message from="assistant" data-message-role="assistant">
      <MessageMeta label="Shell" record={record} />
      <MessageContent className="w-full">
        <Terminal
          output={message.output}
          isStreaming={isStreaming}
          className="min-w-0 max-w-full"
          data-streaming={isStreaming || undefined}
        >
          <TerminalHeader className="min-w-0 gap-2">
            <TerminalTitle className="min-w-0 flex-1">
              <span className="block max-w-full truncate font-mono" title={message.command}>
                {message.command}
              </span>
            </TerminalTitle>
            <TerminalActions className="shrink-0">
              <TerminalStatus>{isStreaming ? <Shimmer>Running</Shimmer> : null}</TerminalStatus>
              <TerminalCopyButton aria-label="Copy terminal output" />
            </TerminalActions>
          </TerminalHeader>
          <TerminalContent className="max-h-none overflow-visible" />
        </Terminal>
      </MessageContent>
    </Message>
  );
}

function NoticeTurn({
  message,
  record,
}: {
  message: Exclude<TaskSessionMessage, { type: "user" | "assistant" | "shell" }>;
  record: TaskExecutionSessionMessageRecord;
}) {
  const copy =
    message.type === "agent-switched"
      ? `Agent switched to ${message.agent}`
      : message.type === "model-switched"
        ? `Model switched to ${message.model.providerID}/${message.model.id}`
        : message.text;
  const label = message.type === "synthetic" ? "Synthetic input" : "System";
  return (
    <Message from="system" data-message-role="system">
      <MessageContent className="w-full rounded-lg border border-dashed bg-muted/30 px-3 py-2">
        <div className="flex items-start gap-2">
          {message.type === "agent-switched" || message.type === "model-switched" ? (
            <RouteIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          ) : (
            <BotIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          )}
          <div className="min-w-0 flex-1">
            <MessageMeta label={label} record={record} />
            <MessageResponse className="mt-1">{copy}</MessageResponse>
          </div>
        </div>
      </MessageContent>
    </Message>
  );
}

function TranscriptRecord({
  record,
  isCurrentRecord,
}: {
  record: TaskExecutionSessionMessageRecord;
  isCurrentRecord: boolean;
}) {
  const decoded = decodeRunMessage(record);
  if (!decoded.message) {
    return (
      <Message from="system" data-message-role="system">
        <MessageMeta label="Unrecognized session message" record={record} />
        <MessageContent className="w-full rounded-lg border border-dashed p-3">
          <p className="text-xs text-muted-foreground">
            This stored payload does not match the current canonical session schema.
          </p>
          <CodeBlock code={JSON.stringify(record.data, null, 2)} language="json" />
        </MessageContent>
      </Message>
    );
  }
  if (decoded.message.type === "user") return <UserTurn message={decoded.message} record={record} />;
  if (decoded.message.type === "assistant") {
    return <AssistantTurn message={decoded.message} record={record} isCurrentRecord={isCurrentRecord} />;
  }
  if (decoded.message.type === "shell") {
    return <ShellTurn message={decoded.message} record={record} isCurrentRecord={isCurrentRecord} />;
  }
  return <NoticeTurn message={decoded.message} record={record} />;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The next transcript page could not be loaded.";
}

export function AgentRunTranscript({
  run,
  records,
  truncated,
  hasMore,
  isLoadingMore,
  loadMoreError,
  onLoadMore,
}: {
  run: TaskExecutionRunEnvelopeRecord;
  records: readonly TaskExecutionSessionMessageRecord[];
  truncated: boolean;
  hasMore: boolean;
  isLoadingMore: boolean;
  loadMoreError: unknown;
  onLoadMore?: () => void;
}) {
  const ordered = [...records].sort((left, right) => left.seq - right.seq);
  const isLive = run.status === "running" && !truncated && !hasMore;
  const currentRecordId = isLive ? ordered.at(-1)?.id : undefined;
  const pageActionLabel = loadMoreError ? "Retry loading later messages" : "Load later messages";
  return (
    <section className="overflow-hidden rounded-lg border" aria-labelledby="run-transcript-title">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <div className="min-w-0 flex-1">
          <h3 id="run-transcript-title" className="font-medium text-sm">
            Session transcript
          </h3>
          <p className="text-xs text-muted-foreground">Canonical messages in provider sequence order</p>
        </div>
        {isLive ? (
          <Badge variant="secondary">
            <Shimmer>Live</Shimmer>
          </Badge>
        ) : null}
        <Badge variant="outline">{ordered.length} messages</Badge>
        {truncated ? <Badge variant="outline">Bounded view</Badge> : null}
      </div>
      <Conversation className="h-(--sz-70vh)" aria-label="Run session transcript">
        <ConversationContent>
          {truncated ? (
            <Alert>
              <AlertDescription>
                Later stored messages are omitted from this bounded transcript.
              </AlertDescription>
            </Alert>
          ) : null}
          {ordered.length === 0 ? (
            <ConversationEmptyState
              icon={<MessagesSquareIcon className="size-5" />}
              title="No session messages"
              description="The run has not projected any canonical conversation messages yet."
            />
          ) : (
            ordered.map((record) => (
              <TranscriptRecord
                key={record.id}
                record={record}
                isCurrentRecord={record.id === currentRecordId}
              />
            ))
          )}
          {hasMore || loadMoreError ? (
            <div className="space-y-2 border-t pt-4">
              {loadMoreError ? (
                <Alert variant="destructive" role="alert">
                  <AlertDescription>
                    Could not load later messages. {errorMessage(loadMoreError)}
                  </AlertDescription>
                </Alert>
              ) : null}
              {hasMore ? (
                <Suggestions aria-label="Transcript pagination" className="justify-center py-1">
                  <Suggestion
                    suggestion={pageActionLabel}
                    onClick={() => onLoadMore?.()}
                    disabled={isLoadingMore || !onLoadMore}
                  >
                    {isLoadingMore ? (
                      <>
                        <LoaderCircleIcon className="animate-spin" />
                        Loading later messages…
                      </>
                    ) : (
                      pageActionLabel
                    )}
                  </Suggestion>
                </Suggestions>
              ) : null}
            </div>
          ) : null}
        </ConversationContent>
        <ConversationScrollButton
          aria-label={truncated ? "Jump to latest loaded session message" : "Jump to latest session message"}
        />
      </Conversation>
    </section>
  );
}
