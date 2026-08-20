import { tasksApi } from "@/api/tasks";
import { toast } from "sonner";
import { queryKeys } from "@/lib/queryKeys";
import type { Task, UpdateTaskStatus } from "@paperclipai/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import type { TaskPropertiesUpdate } from "./-task-properties/-TaskProperties";
import type { useTaskDetailCacheActions } from "./-useTaskDetailEffects";

interface TaskDetailCoreMutationsOptions {
  companyId: string;
  taskId: string;
  cacheActions: ReturnType<typeof useTaskDetailCacheActions>;
}

/** Owns the direct task metadata, assignment, and lifecycle mutations. */
export function useTaskDetailCoreMutations({
  companyId,
  taskId,
  cacheActions,
}: TaskDetailCoreMutationsOptions) {
  // Async pending contract: disabled={isPending} aria-busy={isPending} role="status" {isPending ? "Saving" : "Save"}
  const queryClient = useQueryClient();
  const {
    invalidateTaskDetail,
    invalidateTaskThreadLazily,
    invalidateTaskRunState,
    upsertCommentInCache,
    invalidateTaskCollections,
    applyOptimisticTaskTitleUpdate,
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
      applyOptimisticTaskTitleUpdate(taskId, title);
      return { previousTask, previousList, companyId };
    },
    onSuccess: (nextTask) => {
      mergeTaskResponseIntoCaches(nextTask);
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
  const { mutate: mutateTaskExecutionPolicy } = updateTaskExecutionPolicy;
  const reassignTask = useMutation({
    mutationFn: (ownerAgentId: string) =>
      tasksApi.boardReassign(taskId, {
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
  const updateTaskStatus = useMutation({
    mutationFn: (input: UpdateTaskStatus) => tasksApi.updateStatus(taskId, input),
    onSuccess: (result) => {
      mergeTaskResponseIntoCaches(result.task);
      upsertCommentInCache(result.comment);
      invalidateTaskDetail();
      invalidateTaskThreadLazily();
      invalidateTaskRunState();
      invalidateTaskCollections();
      toast.success("Status updated and recipient notified");
    },
    onError: (error) => {
      toast.error("Status update failed", {
        description: error instanceof Error ? error.message : "Unable to update this task",
      });
    },
  });
  const { mutate: mutateReassignTask } = reassignTask;
  const handleTaskPropertiesUpdate = useCallback(
    (data: TaskPropertiesUpdate) => {
      if ("ownerAgentId" in data) {
        mutateReassignTask(data.ownerAgentId);
        return;
      }
      mutateTaskExecutionPolicy(data.executionPolicy);
    },
    [mutateReassignTask, mutateTaskExecutionPolicy],
  );

  return {
    markTaskRead,
    updateTaskTitle,
    updateTaskStatus,
    handleTaskPropertiesUpdate,
  };
}
