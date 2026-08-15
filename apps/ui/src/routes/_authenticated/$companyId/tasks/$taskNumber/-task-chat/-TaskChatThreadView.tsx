import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Suggestion, Suggestions } from "@/components/ai-elements/suggestion";
import { Task, TaskContent, TaskItem, TaskTrigger } from "@/components/ai-elements/task";
import { useLocation } from "@tanstack/react-router";
import { MessagesSquareIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import type { TaskChatMessage } from "@/lib/task-chat-messages";

import type { useTaskChatThreadController } from "./-TaskChatThread";
import { TaskChatComposer } from "./-TaskChatComposerView";
import { TaskChatErrorBoundary } from "./-TaskChatFallback";
import { TaskChatMessageRow } from "./-TaskChatMessageRow";
import { TaskChatCtx } from "./-TaskChatShared";

type Controller = ReturnType<typeof useTaskChatThreadController>;

const EMPTY_PROMPTS = [
  "Summarize the current state",
  "What should happen next?",
  "Give me a concise progress update",
] as const;
const EMPTY_MESSAGE = "This task conversation is empty. Start with a message below.";

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
}: Pick<
  Controller,
  "taskStatus" | "ownerAgent" | "ownerUserId" | "unresolvedBlockers" | "liveTaskIds" | "composerAccessory"
>) {
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

export function TaskChatThreadView(props: Controller) {
  const {
    agentMap,
    commentsLoadingOlder,
    composerAccessory,
    composerDisabledReason,
    composerHint,
    composerRef,
    currentOwnerValue,
    draftKey,
    enableOwnerChange,
    errorBoundaryResetKey,
    footer,
    hasActiveRun,
    hasOlderComments,
    imageUploadHandler,
    liveTaskIds,
    mentions,
    messages,
    onAdd,
    onAttachImage,
    onLoadOlderComments,
    onRefreshLatestComments,
    ownerAgent,
    ownerOptions,
    ownerUserId,
    replyPending,
    replyTarget,
    setReplyPending,
    setReplyTarget,
    showComposer,
    suggestedOwnerValue,
    taskStatus,
    taskWorkMode,
    unresolvedBlockers,
  } = props;

  return (
    <TaskChatCtx.Provider value={props.chatCtx}>
      <div>
        <TaskChatErrorBoundary
          resetKey={errorBoundaryResetKey}
          messages={messages}
          emptyMessage={EMPTY_MESSAGE}
        >
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
                  {showComposer ? (
                    <Suggestions>
                      {EMPTY_PROMPTS.map((prompt) => (
                        <Suggestion
                          key={prompt}
                          suggestion={prompt}
                          onClick={(value) => {
                            if (composerRef && typeof composerRef === "object") {
                              composerRef.current?.setDraft(value);
                            }
                          }}
                        />
                      ))}
                    </Suggestions>
                  ) : null}
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
          <div className="mt-4 space-y-3" aria-busy={replyPending || undefined}>
            {replyPending ? (
              <p role="status" className="sr-only">
                Sending reply…
              </p>
            ) : null}
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
              onImageUpload={imageUploadHandler}
              onAttachImage={onAttachImage}
              draftKey={draftKey}
              enableOwnerChange={enableOwnerChange}
              ownerOptions={ownerOptions}
              currentOwnerValue={currentOwnerValue}
              suggestedOwnerValue={suggestedOwnerValue}
              mentions={mentions}
              agentMap={agentMap}
              hasActiveRun={hasActiveRun}
              composerDisabledReason={composerDisabledReason}
              composerHint={composerHint}
              taskWorkMode={taskWorkMode}
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
