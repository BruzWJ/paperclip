import { Spinner } from "@/components/ui/spinner";
import { FieldError } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ThreadMessage } from "@assistant-ui/react";
import { memo, useContext } from "react";
import { TaskChatAssistantMessage } from "./TaskChatAssistantMessage";
import { TaskChatCtx } from "./TaskChatShared";
import { TaskChatSystemMessage } from "./TaskChatSystemMessage";
import { TaskChatUserMessage } from "./TaskChatUserMessage";
import {
  taskChatMessageKind,
  taskChatMessageQueuedRunIsInterrupting,
  taskChatMessageRunIsActive,
  taskChatMessageRunIsStopping,
} from "./TaskChatMessageUtils";

export interface TaskChatMessageRowProps {
  message: ThreadMessage;
  activeRunIds: ReadonlySet<string>;
  stoppingRunId?: string | null;
  interruptingQueuedRunId?: string | null;
}

export function TaskChatCommentGroupContinuation({
  message,
}: {
  message: ThreadMessage;
}) {
  const { onLoadMoreCommentGroup } = useContext(TaskChatCtx);
  const custom = message.metadata.custom as Record<string, unknown>;
  const rootCommentId =
    typeof custom.boardGroupRootId === "string"
      ? custom.boardGroupRootId
      : null;
  const hasMore = custom.boardGroupHasMore === true;
  const loading = custom.boardGroupContinuationLoading === true;
  const error =
    typeof custom.boardGroupContinuationError === "string"
      ? custom.boardGroupContinuationError
      : null;
  if (!rootCommentId || (!hasMore && !loading && !error)) return null;

  return (
    <div
      className="ml-10 mt-2 flex items-center gap-2"
      data-testid="task-chat-comment-group-continuation"
      data-root-comment-id={rootCommentId}
    >
      {error ? <FieldError className="text-xs">{error}</FieldError> : null}
      {hasMore && onLoadMoreCommentGroup ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={loading}
          onClick={() => void onLoadMoreCommentGroup(rootCommentId)}
        >
          {loading ? <Spinner className="mr-1.5 h-3.5 w-3.5" /> : null}
          {loading
            ? "Loading replies…"
            : error
              ? "Retry replies"
              : "Load more replies"}
        </Button>
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
  const kind = taskChatMessageKind(message);
  const custom = message.metadata.custom as Record<string, unknown>;
  const isGroupedEntry =
    typeof custom.boardGroupRootId === "string" && custom.boardIsRoot !== true;
  const isRunActive = taskChatMessageRunIsActive(message, activeRunIds);
  const isStoppingRun = taskChatMessageRunIsStopping(message, stoppingRunId);
  const isInterruptingQueuedRun = taskChatMessageQueuedRunIsInterrupting(
    message,
    interruptingQueuedRunId,
  );
  const renderedMessage =
    message.role === "user" ? (
      <TaskChatUserMessage
        message={message}
        isInterruptingQueuedRun={isInterruptingQueuedRun}
      />
    ) : message.role === "assistant" ? (
      <TaskChatAssistantMessage
        message={message}
        isRunActive={isRunActive}
        isStoppingRun={isStoppingRun}
      />
    ) : (
      <TaskChatSystemMessage message={message} />
    );

  return (
    <div
      className={cn(isGroupedEntry && "ml-4 border-l border-border/60 pl-3")}
      data-testid="task-chat-message-row"
      data-message-role={message.role}
      data-message-kind={kind}
      data-board-group-entry={isGroupedEntry ? "true" : undefined}
    >
      {renderedMessage}
      <TaskChatCommentGroupContinuation message={message} />
    </div>
  );
}, areTaskChatMessageRowPropsEqual);

export function areTaskChatMessageRowPropsEqual(
  prev: TaskChatMessageRowProps,
  next: TaskChatMessageRowProps,
) {
  if (prev.message !== next.message) return false;
  if (
    taskChatMessageRunIsActive(prev.message, prev.activeRunIds) !==
    taskChatMessageRunIsActive(next.message, next.activeRunIds)
  )
    return false;
  if (
    taskChatMessageRunIsStopping(prev.message, prev.stoppingRunId) !==
    taskChatMessageRunIsStopping(next.message, next.stoppingRunId)
  )
    return false;
  if (
    taskChatMessageQueuedRunIsInterrupting(
      prev.message,
      prev.interruptingQueuedRunId,
    ) !==
    taskChatMessageQueuedRunIsInterrupting(
      next.message,
      next.interruptingQueuedRunId,
    )
  )
    return false;
  return true;
}
