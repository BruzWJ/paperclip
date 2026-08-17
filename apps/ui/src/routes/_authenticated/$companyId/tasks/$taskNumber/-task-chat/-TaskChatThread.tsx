import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Suggestion, Suggestions } from "@/components/ai-elements/suggestion";
import { Task, TaskContent, TaskItem, TaskTrigger } from "@/components/ai-elements/task";
import {
  buildTaskChatMessages,
  stabilizeThreadMessages,
  type StableThreadMessageCacheEntry,
  type TaskChatMessage,
} from "@/lib/task-chat-messages";
import type { Agent } from "@paperclipai/shared";
import { useLocation } from "@tanstack/react-router";
import { MessagesSquareIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { TaskChatComposer } from "./-TaskChatComposerView";
import { TaskChatErrorBoundary } from "./-TaskChatFallback";
import { TaskChatMessageRow } from "./-TaskChatMessageRow";
import {
  TaskChatCtx,
  type TaskChatMessageContext,
  type TaskChatReplyTarget,
  type TaskChatThreadProps,
} from "./-TaskChatShared";

const EMPTY_MESSAGE = "This task conversation is empty. Start with a message below.";
const EMPTY_BLOCKERS: NonNullable<TaskChatThreadProps["blockedBy"]> = [];

function TaskChatHashNavigation({ messages }: { messages: readonly TaskChatMessage[] }) {
  const location = useLocation();
  const lastScrolledHashRef = useRef<string | null>(null);
  const decidedInitialHashRef = useRef(false);

  useEffect(() => {
    const hash = location.hash ? `#${location.hash}` : window.location.hash;
    if (!hash.startsWith("#comment-")) return;
    if (!messages.length || lastScrolledHashRef.current === hash) return;
    if (!decidedInitialHashRef.current) {
      decidedInitialHashRef.current = true;
      lastScrolledHashRef.current = hash;
      return;
    }
    const element = document.getElementById(hash.slice(1));
    if (!element) return;
    element.scrollIntoView({ block: "center", behavior: "smooth" });
    lastScrolledHashRef.current = hash;
  }, [location.hash, messages]);

  return null;
}

function TaskChatContext({
  taskStatus,
  ownerAgent,
  ownerUserId,
  unresolvedBlockers,
  liveTaskIds,
  composerAccessory,
}: {
  taskStatus: TaskChatThreadProps["taskStatus"];
  ownerAgent: Agent | null;
  ownerUserId: TaskChatThreadProps["ownerUserId"];
  unresolvedBlockers: NonNullable<TaskChatThreadProps["blockedBy"]>;
  liveTaskIds: TaskChatThreadProps["liveTaskIds"];
  composerAccessory: TaskChatThreadProps["composerAccessory"];
}) {
  const hasBacklogOwner = taskStatus === "backlog" && Boolean(ownerAgent || ownerUserId);
  const hasPausedOwner = ownerAgent?.status === "paused";
  if (!hasBacklogOwner && !hasPausedOwner && unresolvedBlockers.length === 0 && !composerAccessory) {
    return null;
  }

  return (
    <Task defaultOpen>
      <TaskTrigger title="Task context" />
      <TaskContent>
        {hasBacklogOwner ? (
          <TaskItem>
            {ownerAgent?.name ?? "The current user owner"} is parked. Ordinary messages remain comments; an
            explicit agent mention can still queue triage.
          </TaskItem>
        ) : null}
        {unresolvedBlockers.length > 0 ? (
          <TaskItem>
            Waiting on {unresolvedBlockers.length} blocker
            {unresolvedBlockers.length === 1 ? "" : "s"}:
            {unresolvedBlockers.map((blocker) => (
              <span key={blocker.id} className="ml-2 inline-flex gap-1">
                <span>{liveTaskIds?.has(blocker.id) ? "Working" : blocker.boardPresentationStatus}</span>
                <span>{blocker.identifier}</span>
                <span>{blocker.title}</span>
              </span>
            ))}
          </TaskItem>
        ) : null}
        {hasPausedOwner ? (
          <TaskItem>{ownerAgent.name} is paused. New runs will wait until the agent is resumed.</TaskItem>
        ) : null}
        {composerAccessory ? <TaskItem>{composerAccessory}</TaskItem> : null}
      </TaskContent>
    </Task>
  );
}

export function TaskChatThread({
  comments,
  taskId = null,
  blockedBy = EMPTY_BLOCKERS,
  liveTaskIds,
  taskStatus,
  agentMap,
  currentUserId,
  userProfileMap,
  onAdd,
  onLoadMoreCommentGroup,
  onAttachFile,
  draftKey,
  ownerOptions,
  currentOwnerValue = "",
  mentionTarget = null,
  composerDisabledReason = null,
  composerHint = null,
  showComposer = true,
  footer,
  onImageClick,
  composerRef,
  composerAccessory,
  onRefreshLatestComments,
  ownerUserId = null,
  hasOlderComments = false,
  commentsLoadingOlder = false,
  onLoadOlderComments,
}: TaskChatThreadProps) {
  const [replyTarget, setReplyTarget] = useState<TaskChatReplyTarget | null>(null);
  const [replyPending, setReplyPending] = useState(false);

  useEffect(() => {
    setReplyTarget(null);
    setReplyPending(false);
  }, [taskId]);

  const selectReplyTarget = useCallback(
    (target: TaskChatReplyTarget) => {
      if (replyPending) return;
      setReplyTarget(target);
      composerRef?.current?.focus();
    },
    [composerRef, replyPending],
  );

  const stableMessagesRef = useRef<readonly TaskChatMessage[]>([]);
  const stableMessageCacheRef = useRef<Map<string, StableThreadMessageCacheEntry>>(new Map());
  const messages = useMemo(() => {
    const stabilized = stabilizeThreadMessages(
      buildTaskChatMessages({ comments }),
      stableMessagesRef.current,
      stableMessageCacheRef.current,
    );
    stableMessagesRef.current = stabilized.messages;
    stableMessageCacheRef.current = stabilized.cache;
    return stabilized.messages;
  }, [comments]);

  const unresolvedBlockers = blockedBy.filter(
    (blocker) =>
      blocker.boardPresentationStatus !== "done" && blocker.boardPresentationStatus !== "cancelled",
  );

  const ownerAgent = currentOwnerValue.startsWith("agent:")
    ? (agentMap?.get(currentOwnerValue.slice("agent:".length)) ?? null)
    : null;

  const chatCtx = useMemo<TaskChatMessageContext>(
    () => ({
      agentMap,
      currentUserId,
      userProfileMap,
      onImageClick,
      onReply: selectReplyTarget,
      onLoadMoreCommentGroup,
    }),
    [agentMap, currentUserId, userProfileMap, onImageClick, selectReplyTarget, onLoadMoreCommentGroup],
  );

  return (
    <TaskChatCtx.Provider value={chatCtx}>
      <div>
        <TaskChatErrorBoundary messages={messages} emptyMessage={EMPTY_MESSAGE}>
          <Conversation className="h-(--sz-70vh)">
            <TaskChatHashNavigation messages={messages} />
            <ConversationContent className="gap-6 p-3 sm:p-4">
              {hasOlderComments ? (
                <Suggestions className="justify-center">
                  <Suggestion
                    suggestion={commentsLoadingOlder ? "Loading earlier messages…" : "Load earlier messages"}
                    disabled={commentsLoadingOlder}
                    onClick={() => void onLoadOlderComments?.()}
                  />
                </Suggestions>
              ) : null}

              {messages.length === 0 ? (
                <ConversationEmptyState>
                  <MessagesSquareIcon
                    className="size-5 text-muted-foreground"
                    aria-hidden="true"
                    data-icon="inline-start"
                  />
                  <div>
                    <p className="font-medium text-sm">No messages yet</p>
                    <p className="text-muted-foreground text-sm">{EMPTY_MESSAGE}</p>
                  </div>
                </ConversationEmptyState>
              ) : (
                messages.map((message) => <TaskChatMessageRow key={message.id} message={message} />)
              )}
            </ConversationContent>
            <ConversationScrollButton
              aria-label="Jump to latest message"
              onPointerDown={() => {
                void Promise.resolve(onRefreshLatestComments?.()).catch(() => undefined);
              }}
            />
          </Conversation>
        </TaskChatErrorBoundary>

        {showComposer ? (
          <div className="mt-4 space-y-3">
            <TaskChatContext
              taskStatus={taskStatus}
              ownerAgent={ownerAgent}
              ownerUserId={ownerUserId}
              unresolvedBlockers={unresolvedBlockers}
              liveTaskIds={liveTaskIds}
              composerAccessory={composerAccessory}
            />
            <TaskChatComposer
              ref={composerRef}
              onSubmit={onAdd}
              onAttachFile={onAttachFile}
              draftKey={draftKey}
              ownerOptions={ownerOptions}
              currentOwnerValue={currentOwnerValue}
              mentionTarget={mentionTarget}
              composerDisabledReason={composerDisabledReason}
              composerHint={composerHint}
              replyTarget={replyTarget}
              onClearReply={() => {
                if (!replyPending) setReplyTarget(null);
              }}
              onReplySubmitted={() => setReplyTarget(null)}
              onReplyPendingChange={setReplyPending}
            />
          </div>
        ) : null}

        {footer ? (
          <Task defaultOpen className="mt-4">
            <TaskTrigger title="Adjacent work" />
            <TaskContent>
              <TaskItem>{footer}</TaskItem>
            </TaskContent>
          </Task>
        ) : null}
      </div>
    </TaskChatCtx.Provider>
  );
}
