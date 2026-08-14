import {
  AssistantRuntimeProvider,
  type ThreadMessage,
} from "@assistant-ui/react";
import { useLocation } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
} from "@/components/ui/message-scroller";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Flag, PauseCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { TaskBlockedNotice } from "../TaskBlockedNotice";
import type { useTaskChatThreadController } from "../TaskChatThread";
import { TaskChatComposer } from "./TaskChatComposerView";
import { TaskChatErrorBoundary } from "./TaskChatFallback";
import { TaskChatMessageRow } from "./TaskChatMessageRow";
import { taskChatMessageAnchorId } from "./TaskChatMessageUtils";
import { TaskChatCtx } from "./TaskChatShared";

type Controller = ReturnType<typeof useTaskChatThreadController>;

function TaskChatHashNavigation({
  messages,
  autoScrollToHashOnInitialLoad,
}: {
  messages: readonly ThreadMessage[];
  autoScrollToHashOnInitialLoad: boolean;
}) {
  const location = useLocation();
  const { scrollToMessage } = useMessageScroller();
  const lastScrolledHashRef = useRef<string | null>(null);
  const decidedInitialHashRef = useRef(false);

  useEffect(() => {
    const hash = location.hash ? `#${location.hash}` : window.location.hash;
    const isThreadHash = ["#comment-", "#activity-", "#run-"].some((prefix) =>
      hash.startsWith(prefix),
    );
    if (
      !messages.length ||
      !isThreadHash ||
      lastScrolledHashRef.current === hash
    )
      return;
    if (!decidedInitialHashRef.current) {
      decidedInitialHashRef.current = true;
      if (!autoScrollToHashOnInitialLoad) {
        lastScrolledHashRef.current = hash;
        return;
      }
    }
    const messageId = hash.slice(1);
    if (scrollToMessage(messageId, { align: "center", behavior: "smooth" })) {
      lastScrolledHashRef.current = hash;
    }
  }, [autoScrollToHashOnInitialLoad, location.hash, messages, scrollToMessage]);

  return null;
}

function MessageItem({
  message,
  activeRunIds,
  stoppingRunId,
  interruptingQueuedRunId,
}: Pick<
  Controller,
  "activeRunIds" | "stoppingRunId" | "interruptingQueuedRunId"
> & { message: ThreadMessage }) {
  const anchorId = taskChatMessageAnchorId(message);
  return (
    <MessageScrollerItem
      messageId={anchorId ?? message.id}
      scrollAnchor={message.role === "user"}
    >
      <TaskChatMessageRow
        message={message}
        activeRunIds={activeRunIds}
        stoppingRunId={stoppingRunId}
        interruptingQueuedRunId={interruptingQueuedRunId}
      />
    </MessageScrollerItem>
  );
}

function TaskChatThreadContent(props: Controller) {
  const {
    hasActiveRun,
    blockedBy,
    liveTaskIds,
    blockerAttention,
    taskStatus,
    agentMap,
    currentUserId,
    userLabelMap,
    imageUploadHandler,
    onAttachImage,
    draftKey,
    enableOwnerChange,
    ownerOptions,
    currentOwnerValue,
    suggestedOwnerValue,
    mentions,
    composerDisabledReason,
    composerHint,
    showComposer,
    footer,
    variant,
    interruptingQueuedRunId,
    stoppingRunId,
    composerRef,
    composerAccessory,
    taskWorkMode,
    ownerUserId,
    onResumeFromBacklog,
    resumeFromBacklogPending,
    replyTarget,
    setReplyTarget,
    replyPending,
    setReplyPending,
    activeRunIds,
    messages,
    unresolvedBlockers,
    ownerAgent,
    runtime,
    chatCtx,
    resolvedShowJumpToLatest,
    resolvedEmptyMessage,
    errorBoundaryResetKey,
    autoScrollToHashOnInitialLoad,
    onRefreshLatestComments,
  } = props;

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <TaskChatCtx.Provider value={chatCtx}>
        <div className={cn(variant === "embedded" ? "space-y-3" : "space-y-4")}>
          <TaskChatErrorBoundary
            resetKey={errorBoundaryResetKey}
            messages={messages}
            emptyMessage={resolvedEmptyMessage}
            variant={variant}
          >
            <MessageScroller
              data-testid="thread-root"
              className={cn(
                variant === "embedded" ? "h-(--sz-28dvh)" : "h-(--sz-70vh)",
              )}
            >
              <TaskChatHashNavigation
                messages={messages}
                autoScrollToHashOnInitialLoad={autoScrollToHashOnInitialLoad}
              />
              <MessageScrollerViewport data-testid="thread-viewport">
                <MessageScrollerContent
                  className={variant === "embedded" ? "gap-3" : "gap-4"}
                >
                  {messages.length === 0 ? (
                    <MessageScrollerItem>
                      <Empty>
                        <EmptyDescription>
                          {resolvedEmptyMessage}
                        </EmptyDescription>
                      </Empty>
                    </MessageScrollerItem>
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
                  {showComposer ? (
                    <MessageScrollerItem
                      data-testid="task-chat-thread-notices"
                      className="space-y-2"
                    >
                      {taskStatus === "backlog" &&
                      (ownerAgent || ownerUserId) ? (
                        <Alert
                          role="status"
                          className="mb-3"
                          data-testid="task-owner-backlog-notice"
                        >
                          <Flag />
                          <AlertTitle>Parked</AlertTitle>
                          <AlertDescription className="space-y-1.5">
                            <p className="leading-5">
                              <span className="font-medium">
                                {ownerAgent?.name ?? "the user owner"}
                              </span>{" "}
                              will not receive status-driven dispatch until
                              status changes to <Badge>todo</Badge> or{" "}
                              <Badge>in_progress</Badge>.
                            </p>
                            {ownerAgent ? (
                              <p className="text-xs leading-5">
                                An explicit @mention can queue the owner for
                                questions or triage. Ordinary comments remain
                                non-dispatching.
                              </p>
                            ) : null}
                            {onResumeFromBacklog ? (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={onResumeFromBacklog}
                                disabled={resumeFromBacklogPending}
                                data-testid="task-owner-backlog-resume"
                              >
                                {resumeFromBacklogPending ? <Spinner /> : null}
                                {resumeFromBacklogPending
                                  ? "Resuming…"
                                  : "Resume now"}
                              </Button>
                            ) : null}
                          </AlertDescription>
                        </Alert>
                      ) : null}
                      <TaskBlockedNotice
                        taskStatus={taskStatus}
                        blockers={unresolvedBlockers}
                        allBlockers={blockedBy}
                        liveTaskIds={liveTaskIds}
                        blockerAttention={blockerAttention}
                      />
                      {ownerAgent?.status === "paused" ? (
                        <Alert role="note" className="mb-3">
                          <PauseCircle aria-hidden="true" />
                          <AlertTitle>{ownerAgent.name} is paused</AlertTitle>
                          <AlertDescription>
                            New runs will not start until the agent is resumed.{" "}
                            {ownerAgent.pauseReason === "budget"
                              ? "It was paused by a budget hard stop."
                              : ownerAgent.pauseReason === "system"
                                ? "It was paused by the system."
                                : "It was paused manually."}
                          </AlertDescription>
                        </Alert>
                      ) : null}
                    </MessageScrollerItem>
                  ) : null}
                  {footer ? (
                    <MessageScrollerItem data-testid="task-chat-thread-footer">
                      {footer}
                    </MessageScrollerItem>
                  ) : null}
                </MessageScrollerContent>
              </MessageScrollerViewport>
              {resolvedShowJumpToLatest ? (
                <MessageScrollerButton
                  size="sm"
                  className="inset-s-auto inset-e-3 translate-x-0"
                  onClick={() => {
                    void Promise.resolve(onRefreshLatestComments?.()).catch(
                      () => undefined,
                    );
                  }}
                >
                  Jump to latest
                </MessageScrollerButton>
              ) : null}
            </MessageScroller>
          </TaskChatErrorBoundary>

          {showComposer && composerAccessory ? (
            <div data-testid="task-chat-composer-accessory" className="mb-2">
              {composerAccessory}
            </div>
          ) : null}

          {showComposer ? (
            <div
              data-testid="task-chat-composer-dock"
              className="sticky bottom-(--sz-calc-8) z-20 space-y-2 bg-gradient-to-t from-background via-background/95 to-background/0 pt-6"
            >
              <TaskChatComposer
                ref={composerRef}
                onImageUpload={imageUploadHandler}
                onAttachImage={onAttachImage}
                draftKey={draftKey}
                enableOwnerChange={enableOwnerChange}
                ownerOptions={ownerOptions}
                currentOwnerValue={currentOwnerValue}
                suggestedOwnerValue={suggestedOwnerValue}
                mentions={mentions}
                agentMap={agentMap}
                hasActiveRun={!!hasActiveRun}
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
        </div>
      </TaskChatCtx.Provider>
    </AssistantRuntimeProvider>
  );
}

export function TaskChatThreadView(props: Controller) {
  return (
    <MessageScrollerProvider autoScroll defaultScrollPosition="last-anchor">
      <TaskChatThreadContent {...props} />
    </MessageScrollerProvider>
  );
}
