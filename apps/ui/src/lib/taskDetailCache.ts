import type { QueryClient } from "@tanstack/react-query";
import type { Task } from "@paperclipai/shared";
import { tasksApi } from "@/api/tasks";
import { queryKeys } from "@/lib/queryKeys";

const TASK_DETAIL_QUERY_PREFIX = ["tasks", "detail"] as const;
export const TASK_DETAIL_STALE_TIME_MS = 60_000;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function collectTaskRefs(
  taskRef: string | null | undefined,
  task?: Pick<Task, "id" | "identifier"> | null,
): string[] {
  const refs = new Set<string>();
  if (isNonEmptyString(taskRef)) refs.add(taskRef);
  if (isNonEmptyString(task?.id)) refs.add(task.id);
  if (isNonEmptyString(task?.identifier)) refs.add(task.identifier);
  return Array.from(refs);
}

function matchesTaskRef(task: Pick<Task, "id" | "identifier">, refs: Iterable<string>) {
  const refSet = refs instanceof Set ? refs : new Set(refs);
  return refSet.has(task.id) || (!!task.identifier && refSet.has(task.identifier));
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
    && (task.identifier === null || typeof task.identifier === "string")
    && (
      (task.ownerKind === "agent" && isNonEmptyString(task.ownerAgentId) && task.ownerUserId === null)
      || (task.ownerKind === "user" && task.ownerAgentId === null && isNonEmptyString(task.ownerUserId))
      || (task.ownerKind === "board" && task.ownerAgentId === null && task.ownerUserId === null)
    )
    && typeof task.ownershipEpoch === "number"
    && typeof task.creatorKind === "string"
    && (task.taskNumber === null || typeof task.taskNumber === "number")
    && typeof task.requestDepth === "number"
    && task.createdAt != null
    && task.updatedAt != null
  );
}

function mergeTaskSnapshots(existing: Task | undefined, incoming: Task): Task {
  if (!existing) return incoming;
  return {
    ...existing,
    ...incoming,
  };
}

export function getTaskDetailCacheRefs(task: Pick<Task, "id" | "identifier">): string[] {
  return collectTaskRefs(null, task);
}

export function getCachedTaskDetail(
  queryClient: QueryClient,
  taskRef: string | null | undefined,
  task?: Pick<Task, "id" | "identifier"> | null,
): Task | undefined {
  const refs = collectTaskRefs(taskRef, task);

  for (const ref of refs) {
    const cached = queryClient.getQueryData<Task>(queryKeys.tasks.detail(ref));
    if (isCompleteTaskSnapshot(cached)) return cached;
  }

  const cachedEntries = queryClient.getQueriesData<Task>({ queryKey: TASK_DETAIL_QUERY_PREFIX });
  return cachedEntries
    .map(([, cachedTask]) => cachedTask)
    .find((cachedTask): cachedTask is Task =>
      isCompleteTaskSnapshot(cachedTask) && matchesTaskRef(cachedTask, refs)
    );
}

export function seedTaskDetailCache(
  queryClient: QueryClient,
  task: Task,
  options?: {
    taskRef?: string | null;
  },
): Task {
  if (!isCompleteTaskSnapshot(task)) return task;

  const refs = collectTaskRefs(options?.taskRef, task);
  const merged = mergeTaskSnapshots(getCachedTaskDetail(queryClient, options?.taskRef, task), task);

  for (const ref of refs) {
    queryClient.setQueryData<Task>(
      queryKeys.tasks.detail(ref),
      (existing) => mergeTaskSnapshots(existing, merged),
    );
  }

  return merged;
}

export async function fetchTaskDetail(
  queryClient: QueryClient,
  taskRef: string,
  options?: { signal?: AbortSignal },
): Promise<Task> {
  const task = options ? await tasksApi.get(taskRef, options) : await tasksApi.get(taskRef);
  return seedTaskDetailCache(queryClient, task, { taskRef });
}

export function getTaskDetailQueryOptions(
  queryClient: QueryClient,
  taskRef: string,
  options?: {
    placeholderTask?: Pick<Task, "id" | "identifier"> | null;
  },
) {
  return {
    queryKey: queryKeys.tasks.detail(taskRef),
    queryFn: ({ signal }: { signal?: AbortSignal }) => fetchTaskDetail(queryClient, taskRef, { signal }),
    placeholderData: getCachedTaskDetail(queryClient, taskRef, options?.placeholderTask ?? undefined),
  };
}

export function prefetchTaskDetail(
  queryClient: QueryClient,
  taskRef: string,
  options?: {
    task?: Task | null;
  },
) {
  if (isCompleteTaskSnapshot(options?.task)) {
    seedTaskDetailCache(queryClient, options.task, { taskRef });
  }

  return queryClient.prefetchQuery({
    queryKey: queryKeys.tasks.detail(taskRef),
    queryFn: () => fetchTaskDetail(queryClient, taskRef),
    staleTime: TASK_DETAIL_STALE_TIME_MS,
  });
}
