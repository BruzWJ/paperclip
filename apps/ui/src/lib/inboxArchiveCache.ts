import { useSyncExternalStore } from "react";
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type { Task } from "@paperclipai/shared";
import { queryKeys } from "./queryKeys";

export type InboxTaskCacheSnapshot = Array<readonly [QueryKey, Task[] | undefined]>;

const INBOX_ARCHIVE_CONFIRMATION_GRACE_MS = 5_000;
const INBOX_ARCHIVE_MAX_GUARD_MS = 30_000;
const EMPTY_ARCHIVED_TASK_IDS: ReadonlySet<string> = new Set();

type InboxArchiveGuardState = {
  taskIds: ReadonlySet<string>;
  listeners: Set<() => void>;
  confirmationTimers: Map<string, ReturnType<typeof setTimeout>>;
  maximumTimers: Map<string, ReturnType<typeof setTimeout>>;
};

const inboxArchiveGuards = new Map<string, InboxArchiveGuardState>();

function pruneInboxArchiveGuard(companyId: string, state: InboxArchiveGuardState) {
  if (
    state.taskIds.size === 0
    && state.listeners.size === 0
    && state.confirmationTimers.size === 0
    && state.maximumTimers.size === 0
    && inboxArchiveGuards.get(companyId) === state
  ) {
    inboxArchiveGuards.delete(companyId);
  }
}

function getInboxArchiveGuard(companyId: string): InboxArchiveGuardState {
  const existing = inboxArchiveGuards.get(companyId);
  if (existing) return existing;

  const created: InboxArchiveGuardState = {
    taskIds: EMPTY_ARCHIVED_TASK_IDS,
    listeners: new Set(),
    confirmationTimers: new Map(),
    maximumTimers: new Map(),
  };
  inboxArchiveGuards.set(companyId, created);
  return created;
}

function publishInboxArchiveGuard(state: InboxArchiveGuardState, taskIds: Set<string>) {
  state.taskIds = taskIds.size > 0 ? taskIds : EMPTY_ARCHIVED_TASK_IDS;
  for (const listener of state.listeners) listener();
}

function clearArchiveGuardTimer(
  timers: Map<string, ReturnType<typeof setTimeout>>,
  taskId: string,
) {
  const timer = timers.get(taskId);
  if (timer) clearTimeout(timer);
  timers.delete(taskId);
}

export function beginLocalInboxArchive(companyId: string, taskId: string) {
  const state = getInboxArchiveGuard(companyId);
  clearArchiveGuardTimer(state.confirmationTimers, taskId);
  clearArchiveGuardTimer(state.maximumTimers, taskId);

  const taskIds = new Set(state.taskIds);
  taskIds.add(taskId);
  publishInboxArchiveGuard(state, taskIds);
}

export function boundLocalInboxArchive(companyId: string, taskId: string) {
  const state = inboxArchiveGuards.get(companyId);
  if (!state?.taskIds.has(taskId)) return;

  clearArchiveGuardTimer(state.maximumTimers, taskId);
  state.maximumTimers.set(taskId, setTimeout(() => {
    clearLocalInboxArchive(companyId, taskId);
  }, INBOX_ARCHIVE_MAX_GUARD_MS));
}

export function confirmLocalInboxArchive(companyId: string, taskId: string) {
  const state = inboxArchiveGuards.get(companyId);
  if (!state?.taskIds.has(taskId)) return;

  clearArchiveGuardTimer(state.confirmationTimers, taskId);
  state.confirmationTimers.set(taskId, setTimeout(() => {
    clearLocalInboxArchive(companyId, taskId);
  }, INBOX_ARCHIVE_CONFIRMATION_GRACE_MS));
}

export function clearLocalInboxArchive(companyId: string, taskId: string) {
  const state = inboxArchiveGuards.get(companyId);
  if (!state) return;
  clearArchiveGuardTimer(state.confirmationTimers, taskId);
  clearArchiveGuardTimer(state.maximumTimers, taskId);
  if (!state.taskIds.has(taskId)) {
    pruneInboxArchiveGuard(companyId, state);
    return;
  }

  const taskIds = new Set(state.taskIds);
  taskIds.delete(taskId);
  publishInboxArchiveGuard(state, taskIds);
  pruneInboxArchiveGuard(companyId, state);
}

export function getLocalInboxArchiveTaskIds(companyId: string | null | undefined): ReadonlySet<string> {
  if (!companyId) return EMPTY_ARCHIVED_TASK_IDS;
  return inboxArchiveGuards.get(companyId)?.taskIds ?? EMPTY_ARCHIVED_TASK_IDS;
}

export function useLocalInboxArchiveTaskIds(companyId: string | null | undefined): ReadonlySet<string> {
  return useSyncExternalStore(
    (listener) => {
      if (!companyId) return () => undefined;
      const state = getInboxArchiveGuard(companyId);
      state.listeners.add(listener);
      return () => {
        state.listeners.delete(listener);
        pruneInboxArchiveGuard(companyId, state);
      };
    },
    () => getLocalInboxArchiveTaskIds(companyId),
    () => EMPTY_ARCHIVED_TASK_IDS,
  );
}

export function filterLocalInboxArchivedTasks(
  companyId: string | null | undefined,
  tasks: Task[],
): Task[] {
  const taskIds = getLocalInboxArchiveTaskIds(companyId);
  if (taskIds.size === 0) return tasks;
  return tasks.filter((task) => !taskIds.has(task.id));
}

function inboxTaskCompanyIdFromQueryKey(queryKey: QueryKey): string | null {
  const inboxQueryKind = String(queryKey[2]);
  if (
    queryKey[0] !== "tasks"
    || typeof queryKey[1] !== "string"
    || !["compact", "mine-by-me", "touched-by-me", "unread-touched-by-me"].includes(inboxQueryKind)
  ) {
    return null;
  }
  return queryKey[1];
}

export function filterLocalInboxArchivedQueryData<TData>(queryKey: QueryKey, data: TData): TData {
  const companyId = inboxTaskCompanyIdFromQueryKey(queryKey);
  if (!companyId || !Array.isArray(data)) return data;
  return filterLocalInboxArchivedTasks(companyId, data as Task[]) as TData;
}

function inboxTaskQueryPrefixes(companyId: string) {
  return [
    queryKeys.tasks.listMineByMe(companyId),
    queryKeys.tasks.listTouchedByMe(companyId),
    queryKeys.tasks.listUnreadTouchedByMe(companyId),
  ] as const;
}

function resolveRestoreIndex(currentData: Task[], previousData: Task[], previousIndex: number) {
  for (let index = previousIndex - 1; index >= 0; index -= 1) {
    const beforeIndex = currentData.findIndex((task) => task.id === previousData[index]?.id);
    if (beforeIndex >= 0) return beforeIndex + 1;
  }

  for (let index = previousIndex + 1; index < previousData.length; index += 1) {
    const afterIndex = currentData.findIndex((task) => task.id === previousData[index]?.id);
    if (afterIndex >= 0) return afterIndex;
  }

  return Math.min(previousIndex, currentData.length);
}

export async function cancelInboxTaskQueries(queryClient: QueryClient, companyId: string) {
  await Promise.all(
    inboxTaskQueryPrefixes(companyId).map((queryKey) =>
      queryClient.cancelQueries({ queryKey }),
    ),
  );
}

export function snapshotInboxTaskCaches(
  queryClient: QueryClient,
  companyId: string,
): InboxTaskCacheSnapshot {
  return inboxTaskQueryPrefixes(companyId).flatMap((queryKey) =>
    queryClient.getQueriesData<Task[]>({ queryKey }),
  );
}

export function removeTaskFromInboxCaches(
  queryClient: QueryClient,
  companyId: string,
  taskId: string,
) {
  for (const queryKey of inboxTaskQueryPrefixes(companyId)) {
    queryClient.setQueriesData<Task[]>(
      { queryKey },
      (cached) => cached?.filter((task) => task.id !== taskId),
    );
  }
}

export function restoreTaskToInboxCaches(
  queryClient: QueryClient,
  snapshot: InboxTaskCacheSnapshot,
  taskId: string,
) {
  for (const [queryKey, previousData] of snapshot) {
    if (!previousData) continue;

    const previousIndex = previousData.findIndex((task) => task.id === taskId);
    if (previousIndex < 0) continue;

    const taskToRestore = previousData[previousIndex];
    queryClient.setQueryData<Task[]>(queryKey, (currentData) => {
      if (currentData?.some((task) => task.id === taskId)) return currentData;

      const nextData = [...(currentData ?? [])];
      nextData.splice(resolveRestoreIndex(nextData, previousData, previousIndex), 0, taskToRestore);
      return nextData;
    });
  }
}

export function invalidateInboxTaskQueries(queryClient: QueryClient, companyId: string) {
  return Promise.all([
    ...inboxTaskQueryPrefixes(companyId).map((queryKey) =>
      queryClient.invalidateQueries({ queryKey }),
    ),
    queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(companyId) }),
  ]);
}

export function getTaskPresenceInActiveInboxCaches(
  queryClient: QueryClient,
  companyId: string,
  taskId: string,
): "absent" | "present" | "unknown" {
  const activeQueries = inboxTaskQueryPrefixes(companyId).flatMap((queryKey) =>
    queryClient.getQueryCache().findAll({ queryKey })
      .filter((query) => query.getObserversCount() > 0),
  );
  if (activeQueries.length === 0) return "unknown";

  const isPresent = activeQueries.some((query) => {
    const data = query.state.data;
    return Array.isArray(data) && data.some((task) => (task as Task).id === taskId);
  });
  return isPresent ? "present" : "absent";
}
