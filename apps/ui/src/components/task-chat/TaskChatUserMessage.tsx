import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { DomainStatus } from "@/components/patterns/DomainStatus";
import { Button } from "@/components/ui/button";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import {
  Message,
  MessageAvatar,
  MessageContent,
  MessageFooter,
  MessageHeader,
} from "@/components/ui/message";
import type { ThreadMessage } from "@assistant-ui/react";
import { Check, Copy } from "lucide-react";
import { useContext } from "react";
import { cn } from "../../lib/utils";

import {
  TaskChatCtx,
  TaskChatImmediateParentLabel,
  getThreadMessageCopyText,
  replyTargetForMessage,
} from "./TaskChatShared";
import {
  TaskChatFollowUpBadge,
  TaskChatReplyMenu,
  TaskChatSourceTrustIndicator,
  TaskChatTimestamp,
  useTaskChatCopy,
} from "./TaskChatMessagePrimitives";

import { initialsForName, resolveTaskChatHumanAuthor } from "./TaskChatMessageUtils";

import { TaskChatTextParts } from "./TaskChatMessageParts";

export function TaskChatUserMessage({
  message,
  isInterruptingQueuedRun,
}: {
  message: ThreadMessage;
  isInterruptingQueuedRun: boolean;
}) {
  const { onInterruptQueued, onCancelQueued, currentUserId, userProfileMap, onReply } =
    useContext(TaskChatCtx);
  const custom = message.metadata.custom as Record<string, unknown>;
  const anchorId = typeof custom.anchorId === "string" ? custom.anchorId : undefined;
  const commentId = typeof custom.commentId === "string" ? custom.commentId : message.id;
  const authorName = typeof custom.authorName === "string" ? custom.authorName : null;
  const authorUserId = typeof custom.authorUserId === "string" ? custom.authorUserId : null;
  const queued = custom.queueState === "queued" || custom.clientStatus === "queued";
  const sourceTrustIndicator = <TaskChatSourceTrustIndicator appearance="badge" value={custom.sourceTrust} />;
  const followUpRequested = custom.followUpRequested === true;
  const queueReason = typeof custom.queueReason === "string" ? custom.queueReason : null;
  const queueBadgeLabel = queueReason === "hold" ? "\u23f8 Held" : "Queued";
  const pending = custom.clientStatus === "pending";
  const queueTargetRunId = typeof custom.queueTargetRunId === "string" ? custom.queueTargetRunId : null;
  const { copied, copy } = useTaskChatCopy("Unable to copy message");
  const {
    isCurrentUser,
    authorName: resolvedAuthorName,
    avatarUrl,
  } = resolveTaskChatHumanAuthor({
    authorName,
    authorUserId,
    currentUserId,
    userProfileMap,
  });
  const authorAvatar = (
    <Avatar size="sm" className="shrink-0">
      {avatarUrl ? <AvatarImage src={avatarUrl} alt={resolvedAuthorName} /> : null}
      <AvatarFallback>{initialsForName(resolvedAuthorName)}</AvatarFallback>
    </Avatar>
  );
  const replyTarget = replyTargetForMessage(message, resolvedAuthorName);
  const messageBody = (
    <MessageContent className={cn("flex min-w-0 max-w-(--pct-85) flex-col", isCurrentUser && "items-end")}>
      <TaskChatImmediateParentLabel custom={custom} />
      <MessageHeader
        className={cn("mb-1 flex items-center gap-2 px-1", isCurrentUser ? "justify-end" : "justify-start")}
      >
        <span className="text-sm font-medium text-foreground">{resolvedAuthorName}</span>
        {sourceTrustIndicator}
        <TaskChatFollowUpBadge requested={followUpRequested} />
      </MessageHeader>
      <Bubble
        align={isCurrentUser ? "end" : "start"}
        variant={queued ? "tinted" : isCurrentUser ? "default" : "muted"}
        className={cn(
          "min-w-0 max-w-full",
          // Tail-hugging corner: flatten the bottom corner nearest the avatar so
          // the bubble points at it (bottom-right for the right-aligned human).
          isCurrentUser ? "rounded-br-(--rad-4)" : "rounded-bl-(--rad-4)",
          pending && "opacity-80",
        )}
      >
        <BubbleContent className="max-w-full overflow-hidden break-all">
          {queued ? (
            <div className="mb-1.5 flex items-center gap-2">
              <DomainStatus status="queued">{queueBadgeLabel}</DomainStatus>
              {queueTargetRunId && onInterruptQueued ? (
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={isInterruptingQueuedRun}
                  onClick={() => void onInterruptQueued(queueTargetRunId)}
                >
                  {isInterruptingQueuedRun ? "Interrupting..." : "Interrupt"}
                </Button>
              ) : null}
              {onCancelQueued ? (
                <Button size="sm" variant="outline" onClick={() => onCancelQueued(commentId)}>
                  Cancel
                </Button>
              ) : null}
            </div>
          ) : null}
          <div className="min-w-0 max-w-full space-y-3">
            <TaskChatTextParts message={message} onAccent={isCurrentUser && !queued} />
          </div>
        </BubbleContent>
      </Bubble>

      {pending ? (
        <MessageFooter
          className={cn(
            "mt-1 flex px-1 text-(length:--text-micro) text-muted-foreground",
            isCurrentUser ? "justify-end" : "justify-start",
          )}
        >
          Sending...
        </MessageFooter>
      ) : (
        <MessageFooter
          className={cn(
            "mt-1 flex items-center gap-1.5 px-1 opacity-0 transition-opacity group-hover:opacity-100",
            isCurrentUser ? "justify-end" : "justify-start",
          )}
        >
          <TaskChatTimestamp anchorId={anchorId} createdAt={message.createdAt} />
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            title="Copy message"
            aria-label="Copy message"
            onClick={() => copy(getThreadMessageCopyText(message))}
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          </Button>
          <TaskChatReplyMenu
            align={isCurrentUser ? "end" : "start"}
            replyTarget={replyTarget}
            onReply={onReply}
          />
        </MessageFooter>
      )}
    </MessageContent>
  );

  return (
    <div id={anchorId}>
      <Message align={isCurrentUser ? "end" : "start"} className="group items-end">
        {isCurrentUser ? (
          <>
            {messageBody}
            <MessageAvatar className="bg-transparent">{authorAvatar}</MessageAvatar>
          </>
        ) : (
          <>
            <MessageAvatar className="bg-transparent">{authorAvatar}</MessageAvatar>
            {messageBody}
          </>
        )}
      </Message>
    </div>
  );
}
