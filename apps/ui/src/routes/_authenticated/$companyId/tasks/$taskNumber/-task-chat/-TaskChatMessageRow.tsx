import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtStep,
} from "@/components/ai-elements/chain-of-thought";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
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
import { Suggestion, Suggestions } from "@/components/ai-elements/suggestion";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { AgentIcon } from "@/routes/_authenticated/$companyId/-AgentIconPicker";
import { deriveInitials } from "@/lib/identity";
import type { TaskChatMessage } from "@/lib/task-chat-messages";
import { cn, formatDateTime } from "@/lib/utils";
import { BrainIcon, MessageSquareTextIcon, PlugIcon, WrenchIcon } from "lucide-react";
import { memo, useContext } from "react";

import { SystemNoticeCommentRow } from "./-SystemNoticeCommentRow";
import { TaskChatMessageActionsMenu } from "./-TaskChatMessageActionsMenu";
import { getThreadMessageCopyText, isSourceTrustMetadata, TaskChatCtx } from "./-TaskChatShared";
import {
  commentDateLabel,
  resolveTaskChatHumanAuthor,
  taskChatMessageAnchorId,
  taskChatMessageCustom,
  taskChatMessageKind,
} from "./-TaskChatMessageUtils";

function ImmediateParent({ custom }: { custom: Record<string, unknown> }) {
  const value = custom.immediateParentDisplayReference;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const reference = value as Record<string, unknown>;
  if (typeof reference.authorLabel !== "string" || typeof reference.excerpt !== "string") return null;
  return (
    <blockquote className="border-l-2 border-border bg-muted/40 py-2 pr-3 pl-3 text-muted-foreground">
      <p className="text-(length:--text-micro) font-medium text-foreground">
        Replying to {reference.authorLabel}
      </p>
      <p className="line-clamp-2 text-sm">{reference.excerpt}</p>
    </blockquote>
  );
}

function RunMessage({ message }: { message: TaskChatMessage }) {
  const parts = message.content;
  const custom = taskChatMessageCustom(message);
  const workPartCount =
    typeof custom.runSegmentPartCount === "number"
      ? Math.min(custom.runSegmentPartCount, parts.length)
      : parts.length;
  const workParts = parts.slice(0, workPartCount);
  const responseParts = parts.slice(workPartCount).filter((part) => part.type === "text");
  const working = message.status?.type === "running";

  return (
    <>
      {working || workParts.length > 0 ? (
        <ChainOfThought defaultOpen={working}>
          <ChainOfThoughtHeader>{working ? "Working" : "Work log"}</ChainOfThoughtHeader>
          <ChainOfThoughtContent>
            {workParts.map((part, index) => {
              const active = working && index === workParts.length - 1;
              return (
                <ChainOfThoughtStep
                  key={`${part.type}:${index}`}
                  icon={
                    part.type === "tool-call"
                      ? WrenchIcon
                      : part.type === "reasoning"
                        ? BrainIcon
                        : MessageSquareTextIcon
                  }
                  label={part.type === "tool-call" ? part.toolName : part.type === "reasoning" ? "Reasoning" : part.text}
                  description={part.type === "tool-call" ? part.status : part.type === "reasoning" ? part.text : undefined}
                  status={active ? "active" : part.type === "tool-call" && part.status === "pending" ? "pending" : "complete"}
                />
              );
            })}
          </ChainOfThoughtContent>
        </ChainOfThought>
      ) : null}
      {responseParts.map((part, index) => (
        <MessageResponse key={`response:${index}`}>{part.text}</MessageResponse>
      ))}
    </>
  );
}

function QueuedMessage({ message }: { message: TaskChatMessage }) {
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
              </div>
              <QueueItemDescription>Waiting for the active run to finish</QueueItemDescription>
            </QueueItem>
          </QueueList>
        </QueueSectionContent>
      </QueueSection>
    </Queue>
  );
}

function TaskChatCommentGroupContinuation({ message }: { message: TaskChatMessage }) {
  const { onLoadMoreCommentGroup } = useContext(TaskChatCtx);
  const custom = taskChatMessageCustom(message);
  const rootCommentId = typeof custom.boardGroupRootId === "string" ? custom.boardGroupRootId : null;
  const hasMore = custom.boardGroupHasMore === true;
  const loading = custom.boardGroupContinuationLoading === true;
  const error =
    typeof custom.boardGroupContinuationError === "string" ? custom.boardGroupContinuationError : null;
  if (!rootCommentId || (!hasMore && !loading && !error)) return null;
  return (
    <div>
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
}: {
  message: TaskChatMessage;
}) {
  const { agentMap, currentUserId, userProfileMap, onImageClick } = useContext(TaskChatCtx);
  const custom = taskChatMessageCustom(message);
  const kind = taskChatMessageKind(message);
  const anchorId = taskChatMessageAnchorId(message);

  if (message.role === "system" && kind === "system_notice") {
    return (
      <article id={anchorId ?? message.id} data-message-role="system">
        <SystemNoticeCommentRow message={message} anchorId={anchorId ?? undefined} />
        <TaskChatCommentGroupContinuation message={message} />
      </article>
    );
  }

  const authorName = typeof custom.authorName === "string" ? custom.authorName : "Agent";
  const authorType =
    custom.authorType === "agent" || custom.authorType === "plugin" || custom.authorType === "system"
      ? custom.authorType
      : "user";
  const authorAgentId = typeof custom.authorAgentId === "string" ? custom.authorAgentId : null;
  const authorUserId = typeof custom.authorUserId === "string" ? custom.authorUserId : null;
  const agent = authorAgentId ? agentMap?.get(authorAgentId) : null;
  const human = resolveTaskChatHumanAuthor({
    authorName,
    authorUserId,
    currentUserId,
    userProfileMap,
  });
  const humanIsCurrentUser =
    human.isCurrentUser || (authorType === "user" && !authorUserId && authorName.trim() === "You");
  const senderKind =
    authorType === "plugin"
      ? "plugin"
      : authorType === "agent" || authorAgentId || message.role === "assistant"
        ? "agent"
        : "human";
  const senderName =
    senderKind === "agent"
      ? (agent?.name ?? authorName)
      : senderKind === "human"
        ? human.authorName
        : authorName;
  const senderRole =
    senderKind === "agent"
      ? "Agent"
      : senderKind === "plugin"
        ? "Plugin"
        : humanIsCurrentUser
          ? "You"
          : "Member";
  const senderIsCurrentUser = senderKind === "human" && humanIsCurrentUser;
  const showSenderRole = senderRole.toLowerCase() !== senderName.toLowerCase();
  const clientStatus = typeof custom.clientStatus === "string" ? custom.clientStatus : null;
  const sourceTrust = isSourceTrustMetadata(custom.sourceTrust) ? custom.sourceTrust : null;
  const senderLabelId = `task-chat-sender-${message.id}`;

  const queued = clientStatus === "queued";
  return (
    <article id={anchorId ?? message.id} aria-labelledby={senderLabelId} data-message-role={message.role}>
      <Message from={senderIsCurrentUser ? "user" : "assistant"} className="max-w-full gap-1.5">
        <div
          className={cn(
            "flex w-full min-w-0 items-center gap-2",
            senderIsCurrentUser ? "justify-end" : "justify-start",
          )}
        >
          <Avatar size="sm">
            {senderKind === "human" && human.avatarUrl ? <AvatarImage src={human.avatarUrl} alt="" /> : null}
            <AvatarFallback
              className={cn(
                senderKind === "agent" && "bg-primary/10 text-primary",
                senderKind === "plugin" && "bg-accent text-accent-foreground",
              )}
            >
              {senderKind === "agent" ? (
                <span aria-hidden="true">
                  <AgentIcon icon={agent?.icon} className="size-3.5" />
                </span>
              ) : senderKind === "plugin" ? (
                <PlugIcon className="size-3.5" aria-hidden="true" data-icon="inline-start" />
              ) : (
                deriveInitials(senderName)
              )}
            </AvatarFallback>
          </Avatar>
          <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-muted-foreground">
            <span id={senderLabelId} className="min-w-0 truncate text-sm font-medium text-foreground">
              {senderName}
            </span>
            {showSenderRole ? (
              <span className="shrink-0 text-(length:--text-micro) font-medium">{senderRole}</span>
            ) : null}
            <span aria-hidden="true">·</span>
            <a
              href={`#${anchorId ?? message.id}`}
              className="shrink-0 text-(length:--text-micro) hover:text-foreground focus-visible:text-foreground"
            >
              <time dateTime={message.createdAt.toISOString()} title={formatDateTime(message.createdAt)}>
                {commentDateLabel(message.createdAt)}
              </time>
            </a>
            {clientStatus ? (
              <span className="text-(length:--text-micro)">
                · {clientStatus === "pending" ? "Sending…" : clientStatus}
              </span>
            ) : null}
            {sourceTrust ? (
              <span className="text-(length:--text-micro)">
                · {sourceTrust.disposition === "promoted" ? "Promoted from low-trust" : "Low-trust source"}
              </span>
            ) : null}
          </div>
          {!queued ? (
            <TaskChatMessageActionsMenu
              message={message}
              authorLabel={senderName}
              anchorId={anchorId}
              align={senderIsCurrentUser ? "end" : "start"}
            />
          ) : null}
        </div>
        <div
          className={cn(
            "flex w-full min-w-0",
            senderIsCurrentUser ? "justify-end pr-0 sm:pr-8" : "justify-start pl-0 sm:pl-8",
          )}
        >
          <MessageContent
            className={cn("max-w-3xl", queued && "w-full")}
            onClick={(event) => {
              const target = event.target;
              if (target instanceof HTMLImageElement && target.src) onImageClick?.(target.src);
            }}
          >
            <ImmediateParent custom={custom} />
            {queued ? (
              <QueuedMessage message={message} />
            ) : kind === "run" ? (
              <RunMessage message={message} />
            ) : (
              <MessageResponse
                isAnimating={message.role === "assistant" && message.status?.type === "running"}
              >
                {getThreadMessageCopyText(message)}
              </MessageResponse>
            )}
          </MessageContent>
        </div>
      </Message>
      <TaskChatCommentGroupContinuation message={message} />
    </article>
  );
});
