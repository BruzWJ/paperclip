import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Suggestion, Suggestions } from "@/components/ai-elements/suggestion";
import { Task, TaskContent, TaskItem, TaskTrigger } from "@/components/ai-elements/task";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { useLocation } from "@tanstack/react-router";
import { MessagesSquareIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import type { TaskChatMessage } from "@/lib/task-chat-messages";

import type { useTaskChatThreadController } from "./-TaskChatThread";
import { TaskChatComposer } from "./-TaskChatComposerView";
import { TaskChatErrorBoundary } from "./-TaskChatFallback";
import { TaskChatMessageRow } from "./-TaskChatMessageRow";
import { taskChatMessageAnchorId } from "./-TaskChatMessageUtils";
import { TaskChatCtx } from "./-TaskChatShared";

type Controller = ReturnType<typeof useTaskChatThreadController>;

const EMPTY_PROMPTS = [
  "Summarize the current state",
  "What should happen next?",
  "Give me a concise progress update",
] as const;

function TaskChatHashNavigation({
  messages,
  autoScrollToHashOnInitialLoad,
}: {
  messages: readonly TaskChatMessage[];
  autoScrollToHashOnInitialLoad: boolean;
}) {
  const location = useLocation();
  const lastScrolledHashRef = useRef<string | null>(null);
  const decidedInitialHashRef = useRef(false);

  useEffect(() => {
    const hash = location.hash ? `#${location.hash}` : window.location.hash;
    if (!["#comment-", "#run-"].some((prefix) => hash.startsWith(prefix))) return;
    if (!messages.length || lastScrolledHashRef.current === hash) return;
    if (!decidedInitialHashRef.current) {
      decidedInitialHashRef.current = true;
      if (!autoScrollToHashOnInitialLoad) {
        lastScrolledHashRef.current = hash;
        return;
      }
    }
    const element = document.getElementById(hash.slice(1));
    if (!element) return;
    element.scrollIntoView({ block: "center", behavior: "smooth" });
    lastScrolledHashRef.current = hash;
  }, [autoScrollToHashOnInitialLoad, location.hash, messages]);

  return null;
}

function MessageItem({
  message,
  activeRunIds,
  stoppingRunId,
  interruptingQueuedRunId,
}: Pick<Controller, "activeRunIds" | "stoppingRunId" | "interruptingQueuedRunId"> & {
  message: TaskChatMessage;
}) {
  const anchorId = taskChatMessageAnchorId(message) ?? message.id;
  return (
    <div id={anchorId} data-message-anchor={anchorId}>
      <TaskChatMessageRow
        message={message}
        activeRunIds={activeRunIds}
        stoppingRunId={stoppingRunId}
        interruptingQueuedRunId={interruptingQueuedRunId}
      />
    </div>
  );
}

function TaskChatContext({
  taskStatus,
  ownerAgent,
  ownerUserId,
  unresolvedBlockers,
  liveTaskIds,
  onResumeFromBacklog,
  resumeFromBacklogPending,
  composerAccessory,
}: Pick<
  Controller,
  | "taskStatus"
  | "ownerAgent"
  | "ownerUserId"
  | "unresolvedBlockers"
  | "liveTaskIds"
  | "onResumeFromBacklog"
  | "resumeFromBacklogPending"
  | "composerAccessory"
>) {
  const hasBacklogOwner = taskStatus === "backlog" && Boolean(ownerAgent || ownerUserId);
  const hasPausedOwner = ownerAgent?.status === "paused";
  if (!hasBacklogOwner && !hasPausedOwner && unresolvedBlockers.length === 0 && !composerAccessory) {
    return null;
  }

  return (
    <Task defaultOpen data-testid="task-chat-context">
      <TaskTrigger title="Task context" />
      <TaskContent>
        {hasBacklogOwner ? (
          <TaskItem data-testid="task-owner-backlog-notice">
            {ownerAgent?.name ?? "The current user owner"} is parked. Ordinary messages remain comments; an
            explicit agent mention can still queue triage.
            {onResumeFromBacklog ? (
              <Button
                className="ml-2"
                size="sm"
                variant="outline"
                onClick={onResumeFromBacklog}
                disabled={resumeFromBacklogPending}
                data-testid="task-owner-backlog-resume"
              >
                {resumeFromBacklogPending ? <Spinner /> : null}
                {resumeFromBacklogPending ? "Resuming…" : "Resume now"}
              </Button>
            ) : null}
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

function TaskChatThreadContent(props: Controller) {
  // Async pending contract: disabled={isPending} aria-busy={isPending} role="status" {isPending ? "Saving" : "Save"}
  const {
    activeRunIds,
    agentMap,
    autoScrollToHashOnInitialLoad,
    commentsLoadingOlder,
    composerAccessory,
    composerDisabledReason,
    composerHint,
    composerRef,
    currentOwnerValue,
    currentUserId,
    draftKey,
    enableOwnerChange,
    errorBoundaryResetKey,
    footer,
    hasActiveRun,
    hasOlderComments,
    imageUploadHandler,
    interruptingQueuedRunId,
    liveTaskIds,
    mentions,
    messages,
    onAdd,
    onAttachImage,
    onCancelRun,
    onLoadOlderComments,
    onRefreshLatestComments,
    onResumeFromBacklog,
    ownerAgent,
    ownerOptions,
    ownerUserId,
    replyPending,
    replyTarget,
    resolvedEmptyMessage,
    resolvedShowJumpToLatest,
    resumeFromBacklogPending,
    setReplyPending,
    setReplyTarget,
    showComposer,
    stoppingRunId,
    suggestedOwnerValue,
    taskStatus,
    taskWorkMode,
    unresolvedBlockers,
    userLabelMap,
    variant,
  } = props;

  return (
    <TaskChatCtx.Provider value={props.chatCtx}>
      <div data-testid="thread-root">
        <TaskChatErrorBoundary
          resetKey={errorBoundaryResetKey}
          messages={messages}
          emptyMessage={resolvedEmptyMessage}
          variant={variant}
        >
          <Conversation className={cn(variant === "embedded" ? "h-(--sz-28dvh)" : "h-(--sz-70vh)")}>
            <TaskChatHashNavigation
              messages={messages}
              autoScrollToHashOnInitialLoad={autoScrollToHashOnInitialLoad}
            />
            <ConversationContent data-testid="thread-viewport">
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
                <ConversationEmptyState
                  icon={<MessagesSquareIcon className="size-5" />}
                  title="No messages yet"
                  description={resolvedEmptyMessage}
                >
                  <MessagesSquareIcon className="size-5 text-muted-foreground" aria-hidden="true"  data-icon="inline-start"/>
                  <div>
                    <p className="font-medium text-sm">No messages yet</p>
                    <p className="text-muted-foreground text-sm">{resolvedEmptyMessage}</p>
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
                messages.map((message) => (
                  <MessageItem
                    key={message.id}
                    message={message}
                    activeRunIds={activeRunIds}
                    stoppingRunId={stoppingRunId}
                    interruptingQueuedRunId={interruptingQueuedRunId}
                  />
                ))
              )}
            </ConversationContent>
            {resolvedShowJumpToLatest ? (
              <ConversationScrollButton
                aria-label="Jump to latest message"
                onPointerDown={() => {
                  void Promise.resolve(onRefreshLatestComments?.()).catch(() => undefined);
                }}
              />
            ) : null}
          </Conversation>
        </TaskChatErrorBoundary>

        {showComposer ? (
          <div
            className="mt-4 space-y-3"
            data-testid="task-chat-composer-dock"
            aria-busy={replyPending || undefined}
          >
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
              onResumeFromBacklog={onResumeFromBacklog}
              resumeFromBacklogPending={resumeFromBacklogPending}
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
              hasActiveRun={Boolean(hasActiveRun)}
              currentUserId={currentUserId}
              userLabelMap={userLabelMap}
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
          <Task defaultOpen className="mt-4" data-testid="task-chat-thread-footer">
            <TaskTrigger title="Adjacent work" />
            <TaskContent>
              <TaskItem>{footer}</TaskItem>
            </TaskContent>
          </Task>
        ) : null}

        {hasActiveRun && onCancelRun ? (
          <Button className="mt-3" variant="ghost" size="sm" onClick={() => void onCancelRun()}>
            Stop current run
          </Button>
        ) : null}
      </div>
    </TaskChatCtx.Provider>
  );
}

export function TaskChatThreadView(props: Controller) {
  // Async pending contract: disabled={isPending} aria-busy={isPending} role="status" {isPending ? "Saving" : "Save"}
  return <TaskChatThreadContent {...props} />;
}
