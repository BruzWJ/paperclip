import { tasksApi } from "@/api/tasks";
import { toast } from "sonner";
import { queryKeys } from "@/lib/queryKeys";
import type { Task } from "@paperclipai/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";

import type { useTaskDetailCacheActions } from "./-useTaskDetailEffects";

export interface TaskDetailCoreMutationsOptions {
  companyId: string;
  taskId: string;
  task: Task | undefined;
  currentUserId: string | null;
  cacheActions: ReturnType<typeof useTaskDetailCacheActions>;
}

/** Owns the direct task metadata, assignment, and lifecycle mutations. */
export function useTaskDetailCoreMutations({
  companyId,
  taskId,
  task,
  currentUserId,
  cacheActions,
}: TaskDetailCoreMutationsOptions) {
  const queryClient = useQueryClient();
  const [reopenDialogOpen, setReopenDialogOpen] = useState(false);
  const [reopenReason, setReopenReason] = useState("");
  const {
    invalidateTaskDetail,
    invalidateTaskThreadLazily,
    invalidateTaskRunState,
    upsertCommentInCache,
    invalidateTaskCollections,
    applyOptimisticTaskCacheUpdate,
    mergeTaskResponseIntoCaches,
  } = cacheActions;

  const markTaskRead = useMutation({
    mutationFn: (id: string) => tasksApi.markRead(id),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks.listMineByMe(companyId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks.listTouchedByMe(companyId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks.listUnreadTouchedByMe(companyId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.sidebarBadges(companyId),
      });
    },
  });
  const updateTaskTitle = useMutation({
    mutationFn: (title: string | null) => tasksApi.updateTitle(taskId, { title }),
    onMutate: async (title) => {
      await queryClient.cancelQueries({
        queryKey: queryKeys.tasks.detail(taskId),
      });
      await queryClient.cancelQueries({
        queryKey: queryKeys.tasks.list(companyId),
      });
      const previousTask = queryClient.getQueryData<Task>(queryKeys.tasks.detail(taskId));
      const previousList = queryClient.getQueryData<Task[]>(queryKeys.tasks.list(companyId));
      applyOptimisticTaskCacheUpdate(taskId, { title });
      return { previousTask, previousList, companyId };
    },
    onSuccess: (nextTask) => {
      mergeTaskResponseIntoCaches(nextTask);
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks.activity(taskId),
      });
      invalidateTaskCollections();
    },
    onError: (error, _variables, context) => {
      queryClient.setQueryData(queryKeys.tasks.detail(taskId), context?.previousTask);
      if (context?.companyId) {
        queryClient.setQueryData(queryKeys.tasks.list(context.companyId), context.previousList);
      }
      toast.error("Title update failed", {
        description: error instanceof Error ? error.message : "Unable to save the task title",
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks.detail(taskId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks.list(companyId),
      });
    },
  });
  const updateTaskExecutionPolicy = useMutation({
    mutationFn: (executionPolicy: NonNullable<Task["executionPolicy"]> | null) =>
      tasksApi.updateExecutionPolicy(taskId, { executionPolicy }),
    onSuccess: (nextTask) => {
      mergeTaskResponseIntoCaches(nextTask);
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks.activity(taskId),
      });
      invalidateTaskCollections();
    },
    onError: (error) => {
      toast.error("Execution policy update failed", {
        description: error instanceof Error ? error.message : "Unable to save the execution policy",
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks.detail(taskId),
      });
    },
  });
  const { mutate: mutateTaskTitle } = updateTaskTitle;
  const { mutate: mutateTaskExecutionPolicy } = updateTaskExecutionPolicy;
  const reassignTask = useMutation({
    mutationFn: (ownerAgentId: string) =>
      tasksApi.creatorReassign(taskId, {
        ownerAgentId,
        idempotencyKey: crypto.randomUUID(),
      }),
    onSuccess: ({ task: nextTask }) => {
      mergeTaskResponseIntoCaches(nextTask);
      invalidateTaskDetail();
      invalidateTaskRunState();
      invalidateTaskCollections();
    },
    onError: (error) => {
      toast.error("Reassignment failed", {
        description: error instanceof Error ? error.message : "Unable to reassign this task",
      });
    },
  });
  const commitHumanOwnerStatus = useMutation({
    mutationFn: (input: { status: "open" | "blocked" | "done" | "cancelled"; message: string }) =>
      tasksApi.commitOwnerFormUpdate({
        taskId,
        message: input.message,
        status: input.status,
      }),
    onSuccess: (result) => {
      upsertCommentInCache(result.comment);
      invalidateTaskDetail();
      invalidateTaskRunState();
      invalidateTaskCollections();
    },
    onError: (error) => {
      toast.error("Owner update failed", {
        description: error instanceof Error ? error.message : "Unable to update this task",
      });
    },
  });
  const withdrawAndCancelTask = useMutation({
    mutationFn: async () => {
      if (!task) throw new Error("Task is still loading");
      let withdrawalTask = task;
      if (task.ownerKind === "agent" && task.ownerAgentId) {
        const assigned = await tasksApi.selfAssignForWithdrawal(task.id, {
          idempotencyKey: crypto.randomUUID(),
        });
        withdrawalTask = assigned.task;
        mergeTaskResponseIntoCaches(assigned.task);
      }
      if (
        withdrawalTask.ownerKind !== "user" ||
        withdrawalTask.ownerUserId !== currentUserId ||
        withdrawalTask.ownerAssignmentSource !== "user_creator_withdrawal"
      ) {
        throw new Error("Only the named creator can withdraw an agent-owned task");
      }
      return tasksApi.commitOwnerFormUpdate({
        taskId: task.id,
        message: "Cancelled by the named creator after withdrawal.",
        status: "cancelled",
      });
    },
    onSuccess: (result) => {
      upsertCommentInCache(result.comment);
      invalidateTaskDetail();
      invalidateTaskRunState();
      invalidateTaskCollections();
      toast.success("Task withdrawn and cancelled");
    },
    onError: (error) => {
      invalidateTaskDetail();
      toast.error("Withdrawal failed", {
        description: error instanceof Error ? error.message : "Unable to withdraw this task",
      });
    },
  });
  const reopenTask = useMutation({
    mutationFn: (reason: string) =>
      tasksApi.reopen(taskId, {
        reason,
        idempotencyKey: crypto.randomUUID(),
      }),
    onSuccess: ({ task: nextTask }) => {
      mergeTaskResponseIntoCaches(nextTask);
      setReopenDialogOpen(false);
      setReopenReason("");
      invalidateTaskDetail();
      invalidateTaskThreadLazily();
      invalidateTaskRunState();
      invalidateTaskCollections();
      toast.success("Task reopened");
    },
    onError: (error) => {
      toast.error("Reopen failed", {
        description: error instanceof Error ? error.message : "Unable to reopen this task",
      });
    },
  });
  const handleTaskPropertiesUpdate = useCallback(
    (data: Record<string, unknown>) => {
      const keys = Object.keys(data);
      if (
        keys.length === 1 &&
        keys[0] === "title" &&
        (typeof data.title === "string" || data.title === null)
      ) {
        mutateTaskTitle(data.title);
        return;
      }
      if (
        keys.length === 1 &&
        keys[0] === "executionPolicy" &&
        (data.executionPolicy === null ||
          (typeof data.executionPolicy === "object" && !Array.isArray(data.executionPolicy)))
      ) {
        mutateTaskExecutionPolicy(data.executionPolicy as NonNullable<Task["executionPolicy"]> | null);
        return;
      }
      toast.error("Property is read-only", {
        description:
          "The board can edit title and execution-policy controls. Lifecycle changes belong to the owner runtime.",
      });
    },
    [mutateTaskExecutionPolicy, mutateTaskTitle],
  );

  return {
    reopenDialogOpen,
    reopenReason,
    reopenTask,
    setReopenDialogOpen,
    setReopenReason,
    markTaskRead,
    updateTaskTitle,
    reassignTask,
    commitHumanOwnerStatus,
    withdrawAndCancelTask,
    handleTaskPropertiesUpdate,
  };
}
