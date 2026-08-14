import type { ThreadMessage } from "@assistant-ui/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { usePaperclipTaskRuntime } from "../hooks/usePaperclipTaskRuntime";
import {
  buildTaskChatMessages,
  stabilizeThreadMessages,
  type StableThreadMessageCacheEntry,
} from "../lib/task-chat-messages";
import {
  type TaskChatMessageContext,
  type TaskChatReplyTarget,
  type TaskChatThreadProps,
  useStableEvent,
} from "./task-chat/TaskChatShared";
import { TaskChatThreadView } from "./task-chat/TaskChatThreadView";

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
      composerRef && typeof composerRef === "object" && composerRef.current?.focus();
    },
    [composerRef, replyPending],
  );

  const activeRunIds = useMemo(() => new Set<string>(), []);

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

  const stableMessagesRef = useRef<readonly ThreadMessage[]>([]);

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

  const isRunning = hasActiveRun;

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
    const ownerAgentId = currentOwnerValue.slice("agent:".length);
    return agentMap?.get(ownerAgentId) ?? null;
  }, [agentMap, currentOwnerValue]);

  const runtime = usePaperclipTaskRuntime({
    messages,
    isRunning,
    onSend: ({ body, ownerChange, mentionAgentId, replyToCommentId }) => {
      return onAdd(body, ownerChange, mentionAgentId, replyToCommentId);
    },
    onCancel: onCancelRun,
  });

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

  const previousErrorBoundaryMessagesRef = useRef<readonly ThreadMessage[] | null>(null);

  const errorBoundaryResetVersionRef = useRef(0);

  if (previousErrorBoundaryMessagesRef.current !== messages) {
    previousErrorBoundaryMessagesRef.current = messages;
    errorBoundaryResetVersionRef.current += 1;
  }

  const errorBoundaryResetKey = String(errorBoundaryResetVersionRef.current);

  return {
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
    autoScrollToHashOnInitialLoad,
    onRefreshLatestComments,
    chatCtx,
    resolvedShowJumpToLatest,
    resolvedEmptyMessage,
    errorBoundaryResetKey,
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
