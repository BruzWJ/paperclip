import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  buildTaskChatMessages,
  stabilizeThreadMessages,
  type StableThreadMessageCacheEntry,
  type TaskChatMessage,
} from "../lib/task-chat-messages";
import {
  type TaskChatMessageContext,
  type TaskChatReplyTarget,
  type TaskChatThreadProps,
  useStableEvent,
} from "./task-chat/TaskChatShared";
import { TaskChatThreadView } from "./task-chat/TaskChatThreadView";

/**
 * Keeps Paperclip's task/comment behavior separate from the AI Elements view.
 * The controller deliberately exposes plain data and callbacks: there is no
 * assistant-ui runtime or second chat abstraction between PromptInput and the
 * canonical task comment mutation.
 */
export function useTaskChatThreadController(props: TaskChatThreadProps) {
  const {
    comments,
    timelineEvents = [],
    hasActiveRun = false,
    taskId = null,
    blockedBy = [],
    liveTaskIds,
    blockerAttention = null,
    companyId,
    projectId,
    taskStatus,
    agentMap,
    currentUserId,
    userLabelMap,
    userProfileMap,
    onAdd,
    onLoadMoreCommentGroup,
    onCancelRun,
    onStopRun,
    stopRunLabel,
    stoppingRunLabel,
    stopRunVariant,
    imageUploadHandler,
    onAttachImage,
    draftKey,
    enableOwnerChange = false,
    ownerOptions = [],
    currentOwnerValue = "",
    suggestedOwnerValue,
    mentions = [],
    composerDisabledReason = null,
    composerHint = null,
    showComposer = true,
    showJumpToLatest,
    autoScrollToHashOnInitialLoad = false,
    emptyMessage,
    footer,
    variant = "full",
    onInterruptQueued,
    onCancelQueued,
    interruptingQueuedRunId = null,
    stoppingRunId = null,
    onImageClick,
    composerRef,
    composerAccessory,
    taskWorkMode,
    onRefreshLatestComments,
    ownerUserId = null,
    onResumeFromBacklog,
    resumeFromBacklogPending = false,
    activeRunIds: suppliedActiveRunIds,
    hasOlderComments = false,
    commentsLoadingOlder = false,
    onLoadOlderComments,
  } = props;

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
      if (composerRef && typeof composerRef === "object") {
        composerRef.current?.focus();
      }
    },
    [composerRef, replyPending],
  );

  const emptyActiveRunIds = useMemo(() => new Set<string>(), []);
  const activeRunIds = suppliedActiveRunIds ?? emptyActiveRunIds;

  const rawMessages = useMemo(
    () =>
      buildTaskChatMessages({
        comments,
        timelineEvents,
        companyId,
        projectId,
        agentMap,
        currentUserId,
        userLabelMap,
      }),
    [comments, timelineEvents, companyId, projectId, agentMap, currentUserId, userLabelMap],
  );

  const stableMessagesRef = useRef<readonly TaskChatMessage[]>([]);
  const stableMessageCacheRef = useRef<Map<string, StableThreadMessageCacheEntry>>(new Map());
  const messages = useMemo(() => {
    const stabilized = stabilizeThreadMessages(
      rawMessages,
      stableMessagesRef.current,
      stableMessageCacheRef.current,
    );
    stableMessagesRef.current = stabilized.messages;
    stableMessageCacheRef.current = stabilized.cache;
    return stabilized.messages;
  }, [rawMessages]);

  const unresolvedBlockers = useMemo(
    () =>
      blockedBy.filter(
        (blocker) =>
          blocker.boardPresentationStatus !== "done" && blocker.boardPresentationStatus !== "cancelled",
      ),
    [blockedBy],
  );

  const ownerAgent = useMemo(() => {
    if (!currentOwnerValue.startsWith("agent:")) return null;
    return agentMap?.get(currentOwnerValue.slice("agent:".length)) ?? null;
  }, [agentMap, currentOwnerValue]);

  const stableOnStopRun = useStableEvent(onStopRun);
  const stableOnInterruptQueued = useStableEvent(onInterruptQueued);
  const stableOnCancelQueued = useStableEvent(onCancelQueued);
  const stableOnImageClick = useStableEvent(onImageClick);
  const stableOnUploadImage = useStableEvent(imageUploadHandler);

  const chatCtx = useMemo<TaskChatMessageContext>(
    () => ({
      agentMap,
      currentUserId,
      userLabelMap,
      userProfileMap,
      onStopRun: stableOnStopRun,
      stopRunLabel,
      stoppingRunLabel,
      stopRunVariant,
      onInterruptQueued: stableOnInterruptQueued,
      onCancelQueued: stableOnCancelQueued,
      onImageClick: stableOnImageClick,
      onUploadImage: stableOnUploadImage,
      onReply: selectReplyTarget,
      onLoadMoreCommentGroup,
    }),
    [
      agentMap,
      currentUserId,
      userLabelMap,
      userProfileMap,
      stableOnStopRun,
      stopRunLabel,
      stoppingRunLabel,
      stopRunVariant,
      stableOnInterruptQueued,
      stableOnCancelQueued,
      stableOnImageClick,
      stableOnUploadImage,
      selectReplyTarget,
      onLoadMoreCommentGroup,
    ],
  );

  const resolvedShowJumpToLatest = showJumpToLatest ?? variant === "full";
  const resolvedEmptyMessage =
    emptyMessage ??
    (variant === "embedded"
      ? "No run output yet."
      : "This task conversation is empty. Start with a message below.");

  const previousErrorBoundaryMessagesRef = useRef<readonly TaskChatMessage[] | null>(null);
  const errorBoundaryResetVersionRef = useRef(0);
  if (previousErrorBoundaryMessagesRef.current !== messages) {
    previousErrorBoundaryMessagesRef.current = messages;
    errorBoundaryResetVersionRef.current += 1;
  }

  return {
    activeRunIds,
    agentMap,
    autoScrollToHashOnInitialLoad,
    blockedBy,
    blockerAttention,
    chatCtx,
    commentsLoadingOlder,
    composerAccessory,
    composerDisabledReason,
    composerHint,
    composerRef,
    currentOwnerValue,
    currentUserId,
    draftKey,
    enableOwnerChange,
    errorBoundaryResetKey: String(errorBoundaryResetVersionRef.current),
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
  };
}

export function TaskChatThread(props: TaskChatThreadProps) {
  return <TaskChatThreadView {...useTaskChatThreadController(props)} />;
}

export {
  canStopTaskChatRun,
  resolveAssistantMessageFoldedState,
  shouldRenderComposerOwnerPreview,
} from "./task-chat/TaskChatShared";
export type { TaskChatComposerHandle, TaskChatThreadProps } from "./task-chat/TaskChatShared";
