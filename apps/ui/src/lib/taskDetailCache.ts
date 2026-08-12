import type { QueryClient } from "@tanstack/react-query";
import type { Task } from "@paperclipai/shared";
import { tasksApi } from "@/api/tasks";
import { queryKeys } from "@/lib/queryKeys";

export const TASK_DETAIL_STALE_TIME_MS = 60_000;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isCompleteTaskSnapshot(value: unknown): value is Task {
  if (typeof value !== "object" || value === null) return false;
  const task = value as Partial<Task>;
  return (
    isNonEmptyString(task.id)
    && isNonEmptyString(task.companyId)
    && (task.title === null || typeof task.title === "string")
    && isNonEmptyString(task.request)
    && typeof task.boardPresentationStatus === "string"
    && typeof task.lifecycleStatus === "string"
    && typeof task.workMode === "string"
    && typeof task.priority === "string"
    && (task.projectId === null || typeof task.projectId === "string")
    && (task.parentId === null || typeof task.parentId === "string")
    && isNonEmptyString(task.identifier)
    && (
      (task.ownerKind === "agent" && isNonEmptyString(task.ownerAgentId) && task.ownerUserId === null)
      || (task.ownerKind === "user" && task.ownerAgentId === null && isNonEmptyString(task.ownerUserId))
      || (task.ownerKind === "board" && task.ownerAgentId === null && task.ownerUserId === null)
    )
    && typeof task.ownershipEpoch === "number"
    && typeof task.creatorKind === "string"
    && typeof task.taskNumber === "number"
    && Number.isInteger(task.taskNumber)
    && task.taskNumber > 0
    && typeof task.requestDepth === "number"
    && task.createdAt != null
    && task.updatedAt != null
  );
}

function mergeTaskSnapshots(existing: Task | undefined, incoming: Task): Task {
  return existing ? { ...existing, ...incoming } : incoming;
}

export function getCachedTaskDetail(
  queryClient: QueryClient,
  taskId: string | null | undefined,
): Task | undefined {
  if (!isNonEmptyString(taskId)) return undefined;
  const cached = queryClient.getQueryData<Task>(queryKeys.tasks.detail(taskId));
  return isCompleteTaskSnapshot(cached) ? cached : undefined;
}

export function seedTaskDetailCache(queryClient: QueryClient, task: Task): Task {
  if (!isCompleteTaskSnapshot(task)) return task;
  const merged = mergeTaskSnapshots(getCachedTaskDetail(queryClient, task.id), task);
  queryClient.setQueryData<Task>(
    queryKeys.tasks.detail(task.id),
    (existing) => mergeTaskSnapshots(existing, merged),
  );
  return merged;
}

export async function fetchTaskDetail(
  queryClient: QueryClient,
  taskId: string,
  options?: { signal?: AbortSignal },
): Promise<Task> {
  const task = options ? await tasksApi.get(taskId, options) : await tasksApi.get(taskId);
  return seedTaskDetailCache(queryClient, task);
}

export function getTaskDetailQueryOptions(
  queryClient: QueryClient,
  taskId: string,
) {
  return {
    queryKey: queryKeys.tasks.detail(taskId),
    queryFn: ({ signal }: { signal?: AbortSignal }) => fetchTaskDetail(queryClient, taskId, { signal }),
    placeholderData: getCachedTaskDetail(queryClient, taskId),
  };
}

export function prefetchTaskDetail(
  queryClient: QueryClient,
  taskId: string,
  options?: { task?: Task | null },
) {
  if (isCompleteTaskSnapshot(options?.task) && options.task.id === taskId) {
    seedTaskDetailCache(queryClient, options.task);
  }

  return queryClient.prefetchQuery({
    queryKey: queryKeys.tasks.detail(taskId),
    queryFn: () => fetchTaskDetail(queryClient, taskId),
    staleTime: TASK_DETAIL_STALE_TIME_MS,
  });
}
