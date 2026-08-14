import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import {
  Message,
  MessageAvatar,
  MessageContent,
  MessageFooter,
  MessageHeader,
} from "@/components/ui/message";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { ThreadMessage } from "@assistant-ui/react";
import {
  BadgeCheck,
  Check,
  Copy,
  MoreHorizontal,
  Reply as ReplyIcon,
  ShieldAlert,
} from "lucide-react";
import { useContext, useState } from "react";
import { toast } from "sonner";
import { copyTextToClipboard } from "../../lib/clipboard";
import { cn, formatDateTime } from "../../lib/utils";

import {
  TaskChatCtx,
  TaskChatImmediateParentLabel,
  isSourceTrustMetadata,
  replyTargetForMessage,
} from "./TaskChatShared";

import {
  commentDateLabel,
  initialsForName,
  resolveTaskChatHumanAuthor,
} from "./TaskChatMessageUtils";

import { TaskChatTextParts } from "./TaskChatMessageParts";

export function TaskChatUserMessage({
  message,
  isInterruptingQueuedRun,
}: {
  message: ThreadMessage;
  isInterruptingQueuedRun: boolean;
}) {
  const {
    onInterruptQueued,
    onCancelQueued,
    currentUserId,
    userProfileMap,
    onReply,
  } = useContext(TaskChatCtx);
  const custom = message.metadata.custom as Record<string, unknown>;
  const anchorId =
    typeof custom.anchorId === "string" ? custom.anchorId : undefined;
  const commentId =
    typeof custom.commentId === "string" ? custom.commentId : message.id;
  const authorName =
    typeof custom.authorName === "string" ? custom.authorName : null;
  const authorUserId =
    typeof custom.authorUserId === "string" ? custom.authorUserId : null;
  const queued =
    custom.queueState === "queued" || custom.clientStatus === "queued";
  const sourceTrust = isSourceTrustMetadata(custom.sourceTrust)
    ? custom.sourceTrust
    : null;
  const lowTrust = sourceTrust?.preset === "low_trust_review";
  const promoted = sourceTrust?.disposition === "promoted";
  const trustLabel = promoted ? "Promoted from low-trust" : "Low-trust source";
  const trustDescription = promoted
    ? `Promoted from low-trust${sourceTrust?.promotedAt ? ` on ${new Date(sourceTrust.promotedAt).toLocaleString()}` : ""}.`
    : "Authored by a low-trust review agent. Raw comment is not auto-shared with higher-trust agents.";
  const sourceTrustIndicator = lowTrust ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant={promoted ? "secondary" : "destructive"}
          aria-label={trustLabel}
        >
          {promoted ? <BadgeCheck /> : <ShieldAlert />}
          {trustLabel}
        </Badge>
      </TooltipTrigger>
      <TooltipContent>{trustDescription}</TooltipContent>
    </Tooltip>
  ) : null;
  const followUpRequested = custom.followUpRequested === true;
  const queueReason =
    typeof custom.queueReason === "string" ? custom.queueReason : null;
  const queueBadgeLabel = queueReason === "hold" ? "\u23f8 Held" : "Queued";
  const pending = custom.clientStatus === "pending";
  const queueTargetRunId =
    typeof custom.queueTargetRunId === "string"
      ? custom.queueTargetRunId
      : null;
  const [copied, setCopied] = useState(false);
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
      {avatarUrl ? (
        <AvatarImage src={avatarUrl} alt={resolvedAuthorName} />
      ) : null}
      <AvatarFallback>{initialsForName(resolvedAuthorName)}</AvatarFallback>
    </Avatar>
  );
  const replyTarget = replyTargetForMessage(message, resolvedAuthorName);
  const messageBody = (
    <MessageContent
      className={cn(
        "flex min-w-0 max-w-(--pct-85) flex-col",
        isCurrentUser && "items-end",
      )}
    >
      <TaskChatImmediateParentLabel custom={custom} />
      <MessageHeader
        className={cn(
          "mb-1 flex items-center gap-2 px-1",
          isCurrentUser ? "justify-end" : "justify-start",
        )}
      >
        <span className="text-sm font-medium text-foreground">
          {resolvedAuthorName}
        </span>
        {sourceTrustIndicator}
        {followUpRequested ? (
          <Badge
            variant="outline"
            className="text-(length:--text-nano) uppercase tracking-(--tracking-eyebrow)"
          >
            Follow-up
          </Badge>
        ) : null}
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
              <Badge variant="secondary">{queueBadgeLabel}</Badge>
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
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onCancelQueued(commentId)}
                >
                  Cancel
                </Button>
              ) : null}
            </div>
          ) : null}
          <div className="min-w-0 max-w-full space-y-3">
            <TaskChatTextParts
              message={message}
              onAccent={isCurrentUser && !queued}
            />
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
          <Tooltip>
            <TooltipTrigger asChild>
              <a href={anchorId ? `#${anchorId}` : undefined}>
                {message.createdAt ? commentDateLabel(message.createdAt) : ""}
              </a>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {message.createdAt ? formatDateTime(message.createdAt) : ""}
            </TooltipContent>
          </Tooltip>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            title="Copy message"
            aria-label="Copy message"
            onClick={() => {
              const text = message.content
                .filter(
                  (p): p is { type: "text"; text: string } => p.type === "text",
                )
                .map((p) => p.text)
                .join("\n\n");
              void copyTextToClipboard(text)
                .then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                })
                .catch((error) => {
                  toast.error("Copy failed", {
                    description:
                      error instanceof Error
                        ? error.message
                        : "Unable to copy message",
                  });
                });
            }}
          >
            {copied ? (
              <Check className="h-3.5 w-3.5" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </Button>
          {replyTarget && onReply ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  title="More actions"
                  aria-label="More actions"
                >
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align={isCurrentUser ? "end" : "start"}>
                <DropdownMenuItem onSelect={() => onReply(replyTarget)}>
                  <ReplyIcon className="mr-2 h-3.5 w-3.5" />
                  Reply
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </MessageFooter>
      )}
    </MessageContent>
  );

  return (
    <div id={anchorId}>
      <Message
        align={isCurrentUser ? "end" : "start"}
        className="group items-end"
      >
        {isCurrentUser ? (
          <>
            {messageBody}
            <MessageAvatar className="bg-transparent">
              {authorAvatar}
            </MessageAvatar>
          </>
        ) : (
          <>
            <MessageAvatar className="bg-transparent">
              {authorAvatar}
            </MessageAvatar>
            {messageBody}
          </>
        )}
      </Message>
    </div>
  );
}
