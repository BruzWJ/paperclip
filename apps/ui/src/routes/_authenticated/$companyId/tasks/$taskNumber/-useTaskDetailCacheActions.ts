import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/queryKeys";
import {
  matchesTaskId,
  type ClientTaskComment,
  withOptimisticTaskTitle,
  withOptimisticTaskTitleInCollection,
} from "@/lib/optimistic-task-comments";
import type { Task } from "@paperclipai/shared";

/** Centralizes cache updates shared by task-detail mutations. */
export function useTaskDetailCacheActions(companyId: string, taskId: string) {
  const queryClient = useQueryClient();
  const invalidateTaskDetail = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: queryKeys.tasks.detail(taskId) });
  }, [taskId, queryClient]);
  const invalidateTaskThreadLazily = useCallback(() => {
    queryClient.invalidateQueries({
      queryKey: queryKeys.tasks.detail(taskId),
      refetchType: "inactive",
    });
  }, [taskId, queryClient]);
  const invalidateTaskRunState = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["tasks", "runs", taskId] });
  }, [taskId, queryClient]);
  const upsertCommentInCache = useCallback(
    (_comment: ClientTaskComment) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks.comments(taskId),
      });
    },
    [taskId, queryClient],
  );
  const invalidateTaskCollections = useCallback(() => {
    queryClient.invalidateQueries({
      queryKey: queryKeys.tasks.list(companyId),
    });
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
  }, [queryClient, companyId]);
  const applyOptimisticTaskTitleUpdate = useCallback(
    (canonicalTaskId: string, title: string | null) => {
      queryClient.setQueryData<Task>(queryKeys.tasks.detail(canonicalTaskId), (cached) =>
        withOptimisticTaskTitle(cached, title),
      );
      queryClient.setQueryData<Task[] | undefined>(queryKeys.tasks.list(companyId), (cached) =>
        withOptimisticTaskTitleInCollection(cached, canonicalTaskId, title),
      );
    },
    [queryClient, companyId],
  );
  const mergeTaskResponseIntoCaches = useCallback(
    (nextTask: Task) => {
      queryClient.setQueryData<Task>(queryKeys.tasks.detail(nextTask.id), (cached) =>
        cached ? { ...cached, ...nextTask } : nextTask,
      );
      queryClient.setQueryData<Task[] | undefined>(queryKeys.tasks.list(companyId), (cached) =>
        cached?.map((item) => (matchesTaskId(item, nextTask.id) ? { ...item, ...nextTask } : item)),
      );
    },
    [queryClient, companyId],
  );

  return {
    invalidateTaskDetail,
    invalidateTaskThreadLazily,
    invalidateTaskRunState,
    upsertCommentInCache,
    invalidateTaskCollections,
    applyOptimisticTaskTitleUpdate,
    mergeTaskResponseIntoCaches,
  };
}
