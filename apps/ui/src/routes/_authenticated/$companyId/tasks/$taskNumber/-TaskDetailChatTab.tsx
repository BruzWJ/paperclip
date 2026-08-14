import { activityApi } from "@/api/activity";
import { tasksApi } from "@/api/tasks";
import { ApprovalCard } from "@/components/ApprovalCard";
import { TaskChatConfirmation } from "@/components/task-chat/TaskChatConfirmation";
import { TaskReferenceActivitySummary } from "@/components/TaskReferenceActivitySummary";
import { TaskRunLedger } from "@/components/TaskRunLedger";
import { TaskChatThread } from "@/components/TaskChatThread";
import { TaskSiblingNavigation } from "@/components/TaskSiblingNavigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Item, ItemContent, ItemHeader } from "@/components/ui/item";
import { formatTaskActivityAction } from "@/lib/activity-format";
import { applyLocalQueuedTaskCommentState } from "@/lib/optimistic-task-comments";
import { keepPreviousDataForSameQueryTail } from "@/lib/query-placeholder-data";
import { queryKeys } from "@/lib/queryKeys";
import { extractTaskTimelineEvents } from "@/lib/task-timeline-events";
import { type TaskDetailSource } from "@/lib/taskDetailBreadcrumb";
import { formatDurationMs, formatMoneyAmount, relativeTime } from "@/lib/utils";
import type { ActivityEvent } from "@paperclipai/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { memo, useMemo, type ReactNode } from "react";

import {
  TaskDetailComment,
  resolveInterruptibleTaskRun,
  taskDetailSourceRouteOptions,
} from "./-task-detail-model";
import { TaskSectionSkeleton } from "./-TaskDetailLoading";
import { ActorIdentity } from "./-TaskAttribution";
import { useTaskDetailPage } from "./-TaskDetailPageContext";

export const TaskDetailChatTab = memo(function TaskDetailChatTab() {
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
  const ThreadComponent = TaskChatThread;
  const { data: activity } = useQuery({
    queryKey: queryKeys.tasks.activity(taskId),
    queryFn: () => activityApi.forTask(taskId),
    placeholderData: keepPreviousDataForSameQueryTail<ActivityEvent[]>(taskId),
  });
  const { data: linkedApprovals } = useQuery({
    queryKey: queryKeys.tasks.approvals(taskId),
    queryFn: () => tasksApi.listApprovals(taskId),
    placeholderData:
      keepPreviousDataForSameQueryTail<Awaited<ReturnType<typeof tasksApi.listApprovals>>>(taskId),
  });
  const unresolvedApprovals = (linkedApprovals ?? []).filter(
    (approval) => approval.status === "pending" || approval.status === "revision_requested",
  );
  const resolvedActivity = activity ?? [];
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
  const timelineEvents = useMemo(() => extractTaskTimelineEvents(resolvedActivity), [resolvedActivity]);

  return (
    <ThreadComponent
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
      timelineEvents={timelineEvents}
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

export function TaskDetailActivityTab() {
  const {
    agentMap,
    approvalDecision,
    childTasks,
    currentUserId,
    pendingApprovalAction,
    task,
    userProfileMap,
  } = useTaskDetailPage();
  const taskId = task.id;
  const { data: activity, isLoading: activityLoading } = useQuery({
    queryKey: queryKeys.tasks.activity(taskId),
    queryFn: () => activityApi.forTask(taskId),
    placeholderData: keepPreviousDataForSameQueryTail<ActivityEvent[]>(taskId),
  });
  const { data: linkedApprovals } = useQuery({
    queryKey: queryKeys.tasks.approvals(taskId),
    queryFn: () => tasksApi.listApprovals(taskId),
    placeholderData:
      keepPreviousDataForSameQueryTail<Awaited<ReturnType<typeof tasksApi.listApprovals>>>(taskId),
  });
  const { data: taskTreeCostSummary } = useQuery({
    queryKey: queryKeys.tasks.costSummary(taskId),
    queryFn: () => tasksApi.getCostSummary(taskId),
    placeholderData:
      keepPreviousDataForSameQueryTail<Awaited<ReturnType<typeof tasksApi.getCostSummary>>>(taskId),
  });
  const initialLoading = activityLoading && activity === undefined;
  const hasTaskTreeCost =
    !!taskTreeCostSummary &&
    (taskTreeCostSummary.pricedPromptCount > 0 ||
      taskTreeCostSummary.unpricedPromptCount > 0 ||
      taskTreeCostSummary.runtimeMs > 0 ||
      taskTreeCostSummary.taskCount > 1);

  if (initialLoading) {
    return <TaskSectionSkeleton titleWidth="w-20" rows={4} />;
  }

  return (
    <>
      {hasTaskTreeCost && taskTreeCostSummary ? (
        <Card className="mb-3 gap-1 py-2">
          <CardHeader className="px-3">
            <CardTitle className="text-sm text-muted-foreground">Cost Summary</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-3 px-3 text-xs text-muted-foreground tabular-nums">
            <span className="font-medium text-foreground">
              {taskTreeCostSummary.taskCount > 1 ? "This task and sub-tasks" : "This task"}
            </span>
            <span className="font-medium text-foreground">
              {formatMoneyAmount(taskTreeCostSummary.knownCostAmount, taskTreeCostSummary.budgetCurrency)}
            </span>
            <span>{taskTreeCostSummary.pricedPromptCount} priced prompts</span>
            <span>{taskTreeCostSummary.unpricedPromptCount} unpriced prompts</span>
            {taskTreeCostSummary.runCount > 0 ? (
              <span>
                Runtime {formatDurationMs(taskTreeCostSummary.runtimeMs)}
                {` (${taskTreeCostSummary.runCount} run${taskTreeCostSummary.runCount === 1 ? "" : "s"})`}
              </span>
            ) : null}
            <span>
              {taskTreeCostSummary.taskCount} task
              {taskTreeCostSummary.taskCount === 1 ? "" : "s"}
            </span>
          </CardContent>
        </Card>
      ) : null}
      <div className="mb-3">
        <TaskRunLedger
          taskId={taskId}
          taskStatus={task.boardPresentationStatus}
          childTasks={childTasks}
          agentMap={agentMap}
          activityEvents={activity ?? []}
          resolveUserLabel={(userId) => userProfileMap.get(userId)?.label ?? null}
          renderActivityEvent={(event) => (
            <Item variant="outline" size="sm" className="block text-xs text-muted-foreground">
              <ItemHeader className="justify-start gap-1.5">
                <ActorIdentity evt={event} agentMap={agentMap} userProfileMap={userProfileMap} />
                <span>
                  {formatTaskActivityAction(event.action, event.details, {
                    agentMap,
                    userProfileMap,
                    currentUserId,
                  })}
                </span>
                <span className="ml-auto shrink-0">{relativeTime(event.createdAt)}</span>
              </ItemHeader>
              <ItemContent className="mt-1.5">
                <TaskReferenceActivitySummary event={event} />
              </ItemContent>
            </Item>
          )}
        />
      </div>
      {linkedApprovals?.length ? (
        <div className="mb-3 space-y-3">
          {linkedApprovals.map((approval) => (
            <ApprovalCard
              key={approval.id}
              approval={approval}
              requesterAgent={
                approval.requestedByAgentId ? (agentMap.get(approval.requestedByAgentId) ?? null) : null
              }
              onApprove={() =>
                approvalDecision.mutate({
                  approvalId: approval.id,
                  action: "approve",
                })
              }
              onReject={() =>
                approvalDecision.mutate({
                  approvalId: approval.id,
                  action: "reject",
                })
              }
              linkToDetails
              isPending={pendingApprovalAction?.approvalId === approval.id}
              pendingAction={
                pendingApprovalAction?.approvalId === approval.id ? pendingApprovalAction.action : null
              }
            />
          ))}
        </div>
      ) : null}
    </>
  );
}

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
