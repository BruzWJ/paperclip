import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  buildTaskChatMessages,
  stabilizeThreadMessages,
  type StableThreadMessageCacheEntry,
  type TaskChatMessage,
} from "@/lib/task-chat-messages";
import {
  type TaskChatMessageContext,
  type TaskChatReplyTarget,
  type TaskChatThreadProps,
  useStableEvent,
} from "./-TaskChatShared";
import { TaskChatThreadView } from "./-TaskChatThreadView";

/**
 * Keeps Paperclip's task/comment behavior separate from the AI Elements view.
 * The controller deliberately exposes plain data and callbacks: there is no
 * assistant-ui runtime or second chat abstraction between PromptInput and the
 * canonical task comment mutation.
 */
export function useTaskChatThreadController(props: TaskChatThreadProps) {
  const {
    comments,
    hasActiveRun = false,
    taskId = null,
    blockedBy = [],
    liveTaskIds,
    taskStatus,
    agentMap,
    currentUserId,
    userProfileMap,
    onAdd,
    onLoadMoreCommentGroup,
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
    footer,
    onImageClick,
    composerRef,
    composerAccessory,
    taskWorkMode,
    onRefreshLatestComments,
    ownerUserId = null,
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

  const rawMessages = useMemo(() => buildTaskChatMessages({ comments }), [comments]);

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

  const stableOnImageClick = useStableEvent(onImageClick);

  const chatCtx = useMemo<TaskChatMessageContext>(
    () => ({
      agentMap,
      currentUserId,
      userProfileMap,
      onImageClick: stableOnImageClick,
      onReply: selectReplyTarget,
      onLoadMoreCommentGroup,
    }),
    [agentMap, currentUserId, userProfileMap, stableOnImageClick, selectReplyTarget, onLoadMoreCommentGroup],
  );

  const previousErrorBoundaryMessagesRef = useRef<readonly TaskChatMessage[] | null>(null);
  const errorBoundaryResetVersionRef = useRef(0);
  if (previousErrorBoundaryMessagesRef.current !== messages) {
    previousErrorBoundaryMessagesRef.current = messages;
    errorBoundaryResetVersionRef.current += 1;
  }

  return {
    agentMap,
    chatCtx,
    commentsLoadingOlder,
    composerAccessory,
    composerDisabledReason,
    composerHint,
    composerRef,
    currentOwnerValue,
    draftKey,
    enableOwnerChange,
    errorBoundaryResetKey: String(errorBoundaryResetVersionRef.current),
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
  };
}

export function TaskChatThread(props: TaskChatThreadProps) {
  return <TaskChatThreadView {...useTaskChatThreadController(props)} />;
}

export type { TaskChatComposerHandle } from "./-TaskChatShared";
