import { tasksApi } from "@/api/tasks";
import { TaskChatConfirmation } from "@/routes/_authenticated/$companyId/tasks/$taskNumber/-task-chat/-TaskChatConfirmation";
import { TaskChatThread } from "@/routes/_authenticated/$companyId/tasks/$taskNumber/-task-chat/-TaskChatThread";
import { TaskSiblingNavigation } from "@/routes/_authenticated/$companyId/tasks/$taskNumber/-TaskSiblingNavigation";
import { applyLocalQueuedTaskCommentState } from "@/lib/optimistic-task-comments";
import { keepPreviousDataForSameQueryTail } from "@/lib/query-placeholder-data";
import { queryKeys } from "@/lib/queryKeys";
import { type TaskDetailSource } from "@/lib/taskDetailBreadcrumb";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { memo, useMemo, type ReactNode } from "react";

import { resolveInterruptibleTaskRun, taskDetailSourceRouteOptions } from "./-task-detail-model";
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
    userProfileMap,
  } = useTaskDetailPage();
  const taskId = task.id;
  const { data: linkedApprovals } = useQuery({
    queryKey: queryKeys.tasks.approvals(taskId),
    queryFn: () => tasksApi.listApprovals(taskId),
    placeholderData:
      keepPreviousDataForSameQueryTail<Awaited<ReturnType<typeof tasksApi.listApprovals>>>(taskId),
  });
  const data = linkedApprovals ?? [];
  const unresolvedApprovals = data.filter(
    (approval) => approval.status === "pending" || approval.status === "revision_requested",
  );
  const interruptibleTaskRun = resolveInterruptibleTaskRun(activeRuns);
  const activeRunIds = useMemo(() => new Set(activeRuns.map((run) => run.id)), [activeRuns]);
  const commentsWithQueueState = useMemo(() => {
    return comments.map((comment) => {
      const queuedTargetRunId = locallyQueuedCommentRunIds.get(comment.id) ?? null;
      return applyLocalQueuedTaskCommentState(comment, {
        queuedTargetRunId,
        targetRunIsLive: queuedTargetRunId ? activeRunIds.has(queuedTargetRunId) : false,
        runningRunId: interruptibleTaskRun?.id ?? null,
      });
    });
  }, [activeRunIds, comments, locallyQueuedCommentRunIds, interruptibleTaskRun]);

  return (
    <TaskChatThread
      composerRef={commentComposerRef}
      composerAccessory={
        linkedApprovals === undefined ? (
          humanLifecycleFormControls ? (
            <div className="space-y-3">{humanLifecycleFormControls}</div>
          ) : null
        ) : (
          <div className="space-y-3">
            {unresolvedApprovals.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {data.length === 0
                  ? "No linked approval requests."
                  : "All linked approval requests are resolved."}
              </p>
            ) : (
              unresolvedApprovals.map((approval) => (
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
              ))
            )}
            {humanLifecycleFormControls}
          </div>
        )
      }
      comments={commentsWithQueueState}
      hasActiveRun={activeRuns.length > 0}
      hasOlderComments={hasOlderComments}
      commentsLoadingOlder={commentsLoadingOlder}
      onLoadOlderComments={loadOlderComments}
      taskId={taskId}
      blockedBy={task.blockedBy ?? []}
      liveTaskIds={liveTaskIds}
      taskStatus={task.boardPresentationStatus}
      agentMap={agentMap}
      currentUserId={currentUserId}
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
