import { tasksApi } from "@/api/tasks";
import { TaskChatConfirmation } from "@/components/task-chat/TaskChatConfirmation";
import { TaskChatThread } from "@/components/TaskChatThread";
import { TaskSiblingNavigation } from "@/components/TaskSiblingNavigation";
import { applyLocalQueuedTaskCommentState } from "@/lib/optimistic-task-comments";
import { keepPreviousDataForSameQueryTail } from "@/lib/query-placeholder-data";
import { queryKeys } from "@/lib/queryKeys";
import { type TaskDetailSource } from "@/lib/taskDetailBreadcrumb";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { memo, useMemo, type ReactNode } from "react";

import {
  TaskDetailComment,
  resolveInterruptibleTaskRun,
  taskDetailSourceRouteOptions,
} from "./-task-detail-model";
import { useTaskDetailPage } from "./-TaskDetailPageContext";

export const TaskDetailChat = memo(function TaskDetailChat() {
  const {
    agentMap,
    approvalDecision,
    activeTaskRuns: activeRuns,
    commentComposerRef,
    commentOwnerOptions,
    commentsLoadingOlder,
    composerHint,
    currentOwnerValue,
    currentUserId,
    handleChatAdd,
    handleChatImageClick,
    handleCommentAttachImage,
    handleCommentImageUpload,
    hasOlderComments,
    humanLifecycleFormControls,
    isUserCreatorWithdrawalOwner,
    liveTaskIds,
    loadMoreCommentGroup,
    loadOlderComments,
    locallyQueuedCommentRunIds,
    location,
    mentionOptions,
    pendingApprovalAction,
    refetchLatestComments,
    resolvedTaskDetailState,
    siblingNavigation,
    suggestedOwnerValue,
    task,
    threadComments: comments,
    userLabelMap,
    userProfileMap,
  } = useTaskDetailPage();
  const taskId = task.id;
  const { data: linkedApprovals } = useQuery({
    queryKey: queryKeys.tasks.approvals(taskId),
    queryFn: () => tasksApi.listApprovals(taskId),
    placeholderData:
      keepPreviousDataForSameQueryTail<Awaited<ReturnType<typeof tasksApi.listApprovals>>>(taskId),
  });
  const unresolvedApprovals = (linkedApprovals ?? []).filter(
    (approval) => approval.status === "pending" || approval.status === "revision_requested",
  );
  const interruptibleTaskRun = resolveInterruptibleTaskRun(activeRuns);
  const activeRunIds = useMemo(() => new Set(activeRuns.map((run) => run.id)), [activeRuns]);
  const commentsWithRunMeta = useMemo<TaskDetailComment[]>(() => {
    return comments.map((comment) => {
      const nextComment: TaskDetailComment = { ...comment };
      const queuedTargetRunId = locallyQueuedCommentRunIds.get(comment.id) ?? null;
      const locallyQueuedComment = applyLocalQueuedTaskCommentState(nextComment, {
        queuedTargetRunId,
        targetRunIsLive: queuedTargetRunId ? activeRunIds.has(queuedTargetRunId) : false,
        runningRunId: interruptibleTaskRun?.id ?? null,
      });
      return locallyQueuedComment;
    });
  }, [activeRunIds, comments, locallyQueuedCommentRunIds, interruptibleTaskRun]);

  return (
    <TaskChatThread
      composerRef={commentComposerRef}
      composerAccessory={
        unresolvedApprovals.length > 0 || humanLifecycleFormControls ? (
          <div className="space-y-3">
            {unresolvedApprovals.map((approval) => (
              <TaskChatConfirmation
                key={approval.id}
                approval={approval}
                requesterAgent={
                  approval.requestedByAgentId ? (agentMap.get(approval.requestedByAgentId) ?? null) : null
                }
                onDecision={approvalDecision.mutate}
                isPending={pendingApprovalAction?.approvalId === approval.id}
                pendingAction={
                  pendingApprovalAction?.approvalId === approval.id ? pendingApprovalAction.action : null
                }
              />
            ))}
            {humanLifecycleFormControls}
          </div>
        ) : null
      }
      comments={commentsWithRunMeta}
      hasActiveRun={activeRuns.length > 0}
      activeRunIds={activeRunIds}
      hasOlderComments={hasOlderComments}
      commentsLoadingOlder={commentsLoadingOlder}
      onLoadOlderComments={loadOlderComments}
      taskId={taskId}
      blockedBy={task.blockedBy ?? []}
      liveTaskIds={liveTaskIds}
      blockerAttention={task.blockerAttention ?? null}
      companyId={task.companyId}
      projectId={task.projectId ?? null}
      taskStatus={task.boardPresentationStatus}
      agentMap={agentMap}
      currentUserId={currentUserId}
      userLabelMap={userLabelMap}
      userProfileMap={userProfileMap}
      draftKey={`paperclip:task-comment-draft:${task.id}`}
      enableOwnerChange
      ownerOptions={commentOwnerOptions}
      currentOwnerValue={currentOwnerValue}
      suggestedOwnerValue={suggestedOwnerValue}
      mentions={mentionOptions}
      composerDisabledReason={
        isUserCreatorWithdrawalOwner ? "This task is withdrawn; finish its cancellation above." : null
      }
      composerHint={composerHint}
      onAdd={handleChatAdd}
      onLoadMoreCommentGroup={loadMoreCommentGroup}
      imageUploadHandler={handleCommentImageUpload}
      onAttachImage={handleCommentAttachImage}
      taskWorkMode={task.workMode ?? "standard"}
      onImageClick={handleChatImageClick}
      onRefreshLatestComments={refetchLatestComments}
      ownerUserId={task.ownerUserId ?? null}
      footer={
        siblingNavigation ? (
          <TaskSiblingNavigation
            navigation={siblingNavigation}
            linkState={resolvedTaskDetailState ?? location.state}
          />
        ) : null
      }
    />
  );
});

export function TaskDetailSourceLink({
  source,
  companyId,
  children,
}: {
  source: TaskDetailSource | null;
  companyId: string;
  children: ReactNode;
}) {
  return <Link {...taskDetailSourceRouteOptions(source, companyId)}>{children}</Link>;
}
