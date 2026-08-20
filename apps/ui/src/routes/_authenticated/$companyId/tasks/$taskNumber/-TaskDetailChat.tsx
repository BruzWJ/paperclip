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
    activeTaskRuns,
    commentComposerRef,
    commentsLoadingOlder,
    composerHint,
    currentUserId,
    handleChatAdd,
    handleChatImageClick,
    handleCommentAttachFile,
    hasOlderComments,
    liveTaskIds,
    loadMoreCommentGroup,
    loadOlderComments,
    locallyQueuedCommentRunIds,
    location,
    pendingApprovalAction,
    refetchLatestComments,
    resolvedTaskDetailState,
    siblingNavigation,
    task,
    taskOwnerCatalog,
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
  const unresolvedApprovals = (linkedApprovals ?? []).filter(
    (approval) => approval.status === "pending" || approval.status === "revision_requested",
  );
  const interruptibleTaskRun = resolveInterruptibleTaskRun(activeTaskRuns);
  const activeRunIds = useMemo(() => new Set(activeTaskRuns.map((run) => run.id)), [activeTaskRuns]);
  const isTerminalTask = task.lifecycleStatus === "done" || task.lifecycleStatus === "cancelled";
  const mentionTarget = useMemo(() => {
    if (!task.ownerAgentId || !Number.isInteger(task.ownershipEpoch) || task.ownershipEpoch < 1) {
      return null;
    }
    const owner = taskOwnerCatalog?.find((candidate) => candidate.id === task.ownerAgentId);
    if (!owner) return null;
    return {
      targetAgentId: owner.id,
      ownershipEpoch: task.ownershipEpoch,
      name: owner.name,
      icon: owner.icon ?? null,
    };
  }, [task.ownerAgentId, task.ownershipEpoch, taskOwnerCatalog]);
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
        unresolvedApprovals.length > 0 ? (
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
          </div>
        ) : null
      }
      comments={commentsWithQueueState}
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
      ownerAgentId={task.ownerAgentId}
      mentionTarget={mentionTarget}
      mentionIsResponseOnly={isTerminalTask}
      composerHint={composerHint}
      onAdd={handleChatAdd}
      onLoadMoreCommentGroup={loadMoreCommentGroup}
      onAttachFile={handleCommentAttachFile}
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
