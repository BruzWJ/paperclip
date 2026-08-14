import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
} from "@/components/ai-elements/chain-of-thought";
import { Message, MessageContent, MessageResponse, MessageToolbar } from "@/components/ai-elements/message";
import {
  Queue,
  QueueItem,
  QueueItemAction,
  QueueItemActions,
  QueueItemContent,
  QueueItemDescription,
  QueueItemIndicator,
  QueueList,
  QueueSection,
  QueueSectionContent,
  QueueSectionLabel,
  QueueSectionTrigger,
} from "@/components/ai-elements/queue";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { Suggestion, Suggestions } from "@/components/ai-elements/suggestion";
import { Tool, ToolContent, ToolHeader, type ToolPart } from "@/components/ai-elements/tool";
import type { BoardTaskRunSegmentPart } from "@paperclipai/shared";
import { MessageSquareXIcon, SquareIcon } from "lucide-react";
import { memo, useContext } from "react";
import type { TaskChatMessage } from "../../lib/task-chat-messages";

import { SystemNoticeCommentRow } from "./SystemNoticeCommentRow";
import { TaskChatMessageActionBar } from "./TaskChatMessageActionBar";
import { getThreadMessageCopyText, isSourceTrustMetadata, TaskChatCtx } from "./TaskChatShared";
import {
  commentDateLabel,
  resolveTaskChatHumanAuthor,
  taskChatMessageAnchorId,
  taskChatMessageCustom,
  taskChatMessageKind,
  taskChatMessageQueuedRunIsInterrupting,
  taskChatMessageRunIsActive,
  taskChatMessageRunIsStopping,
} from "./TaskChatMessageUtils";

export interface TaskChatMessageRowProps {
  message: TaskChatMessage;
  activeRunIds: ReadonlySet<string>;
  stoppingRunId?: string | null;
  interruptingQueuedRunId?: string | null;
}

function toolState(status: Extract<BoardTaskRunSegmentPart, { type: "tool" }>["status"]): ToolPart["state"] {
  if (status === "pending") return "input-streaming";
  if (status === "running") return "input-available";
  if (status === "error") return "output-error";
  return "output-available";
}

function runSegmentParts(custom: Record<string, unknown>): readonly BoardTaskRunSegmentPart[] {
  return Array.isArray(custom.boardRunSegmentParts)
    ? (custom.boardRunSegmentParts as readonly BoardTaskRunSegmentPart[])
    : [];
}

function ImmediateParent({ custom }: { custom: Record<string, unknown> }) {
  const value = custom.immediateParentDisplayReference;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const reference = value as Record<string, unknown>;
  if (typeof reference.authorLabel !== "string" || typeof reference.excerpt !== "string") return null;
  return <MessageResponse>{`> **${reference.authorLabel}** · ${reference.excerpt}`}</MessageResponse>;
}

function MessageMeta({
  author,
  message,
  custom,
}: {
  author: string;
  message: TaskChatMessage;
  custom: Record<string, unknown>;
}) {
  const clientStatus = typeof custom.clientStatus === "string" ? custom.clientStatus : null;
  const sourceTrust = isSourceTrustMetadata(custom.sourceTrust) ? custom.sourceTrust : null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
      <span>{author}</span>
      {message.createdAt ? (
        <>
          <span aria-hidden="true">·</span>
          <a href={taskChatMessageAnchorId(message) ? `#${taskChatMessageAnchorId(message)}` : undefined}>
            {commentDateLabel(message.createdAt)}
          </a>
        </>
      ) : null}
      {clientStatus ? (
        <>
          <span aria-hidden="true">·</span>
          <span>{clientStatus === "pending" ? "Sending…" : clientStatus}</span>
        </>
      ) : null}
      {sourceTrust ? (
        <>
          <span aria-hidden="true">·</span>
          <span>
            {sourceTrust.disposition === "promoted" ? "Promoted from low-trust" : "Low-trust source"}
          </span>
        </>
      ) : null}
    </div>
  );
}

function RunSegment({ message, custom }: { message: TaskChatMessage; custom: Record<string, unknown> }) {
  const parts = runSegmentParts(custom);
  const traceParts = parts.filter((part) => part.type !== "text");
  const textParts = parts.filter(
    (part): part is Extract<BoardTaskRunSegmentPart, { type: "text" }> => part.type === "text",
  );
  const working = custom.boardRunSegmentStatus === "working" || custom.runState === "working";

  return (
    <>
      {traceParts.length > 0 ? (
        <ChainOfThought defaultOpen={working}>
          <ChainOfThoughtHeader>{working ? "Working" : "Work log"}</ChainOfThoughtHeader>
          <ChainOfThoughtContent>
            {traceParts.map((part, index) =>
              part.type === "reasoning" ? (
                <Reasoning
                  key={`reasoning:${index}`}
                  isStreaming={working && index === traceParts.length - 1}
                  defaultOpen={working}
                >
                  <ReasoningTrigger getThinkingMessage={() => "Reasoning"} />
                  <ReasoningContent>{part.text}</ReasoningContent>
                </Reasoning>
              ) : (
                <Tool
                  key={`tool:${index}:${part.name}`}
                  defaultOpen={part.status === "running" || part.status === "error"}
                >
                  <ToolHeader type="dynamic-tool" toolName={part.name} state={toolState(part.status)} />
                  <ToolContent>
                    <p className="text-sm text-muted-foreground">
                      The board transcript exposes this tool&apos;s name and status only.
                    </p>
                  </ToolContent>
                </Tool>
              ),
            )}
          </ChainOfThoughtContent>
        </ChainOfThought>
      ) : null}
      {textParts.length > 0 ? (
        textParts.map((part, index) => (
          <MessageResponse key={`text:${index}`} isAnimating={working}>
            {part.text}
          </MessageResponse>
        ))
      ) : traceParts.length === 0 ? (
        <MessageResponse isAnimating={working}>{getThreadMessageCopyText(message)}</MessageResponse>
      ) : null}
    </>
  );
}

function QueuedMessage({
  message,
  custom,
  isInterrupting,
}: {
  message: TaskChatMessage;
  custom: Record<string, unknown>;
  isInterrupting: boolean;
}) {
  const { onCancelQueued, onInterruptQueued } = useContext(TaskChatCtx);
  const commentId = typeof custom.commentId === "string" ? custom.commentId : null;
  const runId = typeof custom.queueTargetRunId === "string" ? custom.queueTargetRunId : null;
  return (
    <Queue>
      <QueueSection defaultOpen>
        <QueueSectionTrigger>
          <QueueSectionLabel count={1} label="queued message" />
        </QueueSectionTrigger>
        <QueueSectionContent>
          <QueueList>
            <QueueItem>
              <div className="flex items-start gap-2">
                <QueueItemIndicator />
                <QueueItemContent>{getThreadMessageCopyText(message)}</QueueItemContent>
                <QueueItemActions>
                  {runId && onInterruptQueued ? (
                    <QueueItemAction
                      aria-label="Interrupt current run"
                      title="Interrupt current run"
                      disabled={isInterrupting}
                      onClick={() => void onInterruptQueued(runId)}
                    >
                      <SquareIcon className="size-4" />
                    </QueueItemAction>
                  ) : null}
                  {commentId && onCancelQueued ? (
                    <QueueItemAction
                      aria-label="Cancel queued message"
                      title="Cancel queued message"
                      onClick={() => onCancelQueued(commentId)}
                    >
                      <MessageSquareXIcon className="size-4" />
                    </QueueItemAction>
                  ) : null}
                </QueueItemActions>
              </div>
              <QueueItemDescription>
                {isInterrupting ? "Interrupting…" : "Waiting for the active run to finish"}
              </QueueItemDescription>
            </QueueItem>
          </QueueList>
        </QueueSectionContent>
      </QueueSection>
    </Queue>
  );
}

export function TaskChatCommentGroupContinuation({ message }: { message: TaskChatMessage }) {
  const { onLoadMoreCommentGroup } = useContext(TaskChatCtx);
  const custom = taskChatMessageCustom(message);
  const rootCommentId = typeof custom.boardGroupRootId === "string" ? custom.boardGroupRootId : null;
  const hasMore = custom.boardGroupHasMore === true;
  const loading = custom.boardGroupContinuationLoading === true;
  const error =
    typeof custom.boardGroupContinuationError === "string" ? custom.boardGroupContinuationError : null;
  if (!rootCommentId || (!hasMore && !loading && !error)) return null;
  return (
    <div data-testid="task-chat-comment-group-continuation" data-root-comment-id={rootCommentId}>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {hasMore && onLoadMoreCommentGroup ? (
        <Suggestions>
          <Suggestion
            suggestion={loading ? "Loading replies…" : error ? "Retry replies" : "Load more replies"}
            disabled={loading}
            onClick={() => void onLoadMoreCommentGroup(rootCommentId)}
          />
        </Suggestions>
      ) : null}
    </div>
  );
}

export const TaskChatMessageRow = memo(function TaskChatMessageRow({
  message,
  activeRunIds,
  stoppingRunId,
  interruptingQueuedRunId,
}: TaskChatMessageRowProps) {
  const { currentUserId, userProfileMap, onImageClick } = useContext(TaskChatCtx);
  const custom = taskChatMessageCustom(message);
  const kind = taskChatMessageKind(message);
  const anchorId = taskChatMessageAnchorId(message);
  const authorName = typeof custom.authorName === "string" ? custom.authorName : "Agent";
  const human = resolveTaskChatHumanAuthor({
    authorName,
    authorUserId: typeof custom.authorUserId === "string" ? custom.authorUserId : null,
    currentUserId,
    userProfileMap,
  });
  const resolvedAuthor = message.role === "user" ? human.authorName : authorName;
  const isRunActive = taskChatMessageRunIsActive(message, activeRunIds);
  const isStoppingRun = taskChatMessageRunIsStopping(message, stoppingRunId);
  const isInterruptingQueuedRun = taskChatMessageQueuedRunIsInterrupting(message, interruptingQueuedRunId);

  if (message.role === "system" && kind === "system_notice") {
    return (
      <div data-testid="task-chat-message-row" data-message-role="system" data-message-kind={kind}>
        <SystemNoticeCommentRow message={message} anchorId={anchorId ?? undefined} />
        <TaskChatCommentGroupContinuation message={message} />
      </div>
    );
  }

  const queued = custom.queueState === "queued" || custom.clientStatus === "queued";
  return (
    <div
      data-testid="task-chat-message-row"
      data-message-role={message.role}
      data-message-kind={kind}
      data-board-group-entry={custom.boardIsRoot !== true && custom.boardGroupRootId ? "true" : undefined}
    >
      <Message from={message.role === "user" ? "user" : "assistant"}>
        <MessageContent
          onClick={(event) => {
            const target = event.target;
            if (target instanceof HTMLImageElement && target.src) onImageClick?.(target.src);
          }}
        >
          <MessageMeta author={resolvedAuthor} message={message} custom={custom} />
          <ImmediateParent custom={custom} />
          {queued ? (
            <QueuedMessage message={message} custom={custom} isInterrupting={isInterruptingQueuedRun} />
          ) : kind === "run-segment" ? (
            <RunSegment message={message} custom={custom} />
          ) : (
            <MessageResponse isAnimating={message.role === "assistant" && message.status?.type === "running"}>
              {getThreadMessageCopyText(message)}
            </MessageResponse>
          )}
        </MessageContent>
        {!queued ? (
          <MessageToolbar className={message.role === "user" ? "justify-end" : "justify-start"}>
            <TaskChatMessageActionBar
              message={message}
              authorLabel={resolvedAuthor}
              anchorId={anchorId}
              isRunActive={isRunActive}
              isStoppingRun={isStoppingRun}
            />
          </MessageToolbar>
        ) : null}
      </Message>
      <TaskChatCommentGroupContinuation message={message} />
    </div>
  );
}, areTaskChatMessageRowPropsEqual);

export function areTaskChatMessageRowPropsEqual(
  previous: TaskChatMessageRowProps,
  next: TaskChatMessageRowProps,
) {
  if (previous.message !== next.message) return false;
  if (
    taskChatMessageRunIsActive(previous.message, previous.activeRunIds) !==
    taskChatMessageRunIsActive(next.message, next.activeRunIds)
  )
    return false;
  if (
    taskChatMessageRunIsStopping(previous.message, previous.stoppingRunId) !==
    taskChatMessageRunIsStopping(next.message, next.stoppingRunId)
  )
    return false;
  return (
    taskChatMessageQueuedRunIsInterrupting(previous.message, previous.interruptingQueuedRunId) ===
    taskChatMessageQueuedRunIsInterrupting(next.message, next.interruptingQueuedRunId)
  );
}
