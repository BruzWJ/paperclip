import { createFileRoute } from "@tanstack/react-router";
import {
  assertOnlySearchKeys,
  optionalCanonicalUuidSearch,
  optionalExactSearchString,
} from "@/routes/-search";
import { useEffect, useMemo, useCallback, useRef } from "react";
import { getRouteApi } from "@tanstack/react-router";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { tasksApi } from "@/api/tasks";
import { agentsApi } from "@/api/agents";
import { projectsApi } from "@/api/projects";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompanyLiveTaskIds } from "@/hooks/useCompanyLiveTaskIds";
import { queryKeys } from "@/lib/queryKeys";
import { createTaskDetailLocationState } from "@/lib/taskDetailBreadcrumb";
import { TasksList } from "@/components/TasksList";
import type { Task } from "@paperclipai/shared";

export function validateTasksSearch(search: Record<string, unknown>): {
  q?: string;
  participantAgentId?: string;
  ownerAgentId?: string;
  ownerUserId?: string;
} {
  assertOnlySearchKeys(search, ["q", "participantAgentId", "ownerAgentId", "ownerUserId"]);
  const q = optionalExactSearchString(search.q, "q");
  if (q !== undefined && q.toLowerCase() !== q) {
    throw new Error('Invalid search parameter "q": must use canonical lowercase');
  }
  const ownerAgentId = optionalCanonicalUuidSearch(search.ownerAgentId, "ownerAgentId");
  const ownerUserId = optionalExactSearchString(search.ownerUserId, "ownerUserId");
  if (ownerAgentId !== undefined && ownerUserId !== undefined) {
    throw new Error('Invalid search parameters: "ownerAgentId" and "ownerUserId" are mutually exclusive');
  }
  return {
    q,
    participantAgentId: optionalCanonicalUuidSearch(search.participantAgentId, "participantAgentId"),
    ownerAgentId,
    ownerUserId,
  };
}

export const Route = createFileRoute("/_authenticated/$companyId/tasks/")({
  validateSearch: validateTasksSearch,
  component: Tasks,
});

const TASKS_PAGE_SIZE = 100;

const TASK_DETAIL_LOCATION_STATE = createTaskDetailLocationState("tasks");

export function getNextTasksPageOffset(
  loadedPageSize: number,
  currentOffset: number,
  pageSize: number = TASKS_PAGE_SIZE,
): number | undefined {
  return loadedPageSize >= pageSize ? currentOffset + pageSize : undefined;
}

export function mergeTaskPagesStable<T extends { id: string }>(pages: T[][]): T[] {
  const seenTaskIds = new Set<string>();
  const merged: T[] = [];

  for (const page of pages) {
    for (const task of page) {
      if (seenTaskIds.has(task.id)) continue;
      seenTaskIds.add(task.id);
      merged.push(task);
    }
  }

  return merged;
}

function Tasks() {
  const companyId = useCompanyRouteId();
  const { setBreadcrumbs } = useBreadcrumbs();
  const route = getRouteApi("/_authenticated/$companyId/tasks/");
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const fetchNextPageInFlightRef = useRef(false);

  const syncedSearch = search.q ?? "";
  const participantAgentId = search.participantAgentId;
  const ownerAgentId = search.ownerAgentId;
  const ownerUserId = search.ownerUserId;
  const handleSearchChange = useCallback(
    (nextSearch: string) => {
      const canonicalSearch = nextSearch.trim().toLowerCase();
      if (canonicalSearch === syncedSearch) return;
      void navigate({
        search: (previous) => ({
          ...previous,
          q: canonicalSearch || undefined,
        }),
        replace: true,
      });
    },
    [navigate, syncedSearch],
  );

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
  });

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(companyId),
    queryFn: () => projectsApi.list(companyId),
  });

  const liveTaskIds = useCompanyLiveTaskIds(companyId);

  const taskLinkState = TASK_DETAIL_LOCATION_STATE;

  useEffect(() => {
    setBreadcrumbs([{ label: "Tasks" }]);
  }, [setBreadcrumbs]);

  const taskPageSize = TASKS_PAGE_SIZE;

  const {
    data: taskPages,
    isLoading,
    isFetchingNextPage,
    error,
    hasNextPage,
    fetchNextPage,
  } = useInfiniteQuery({
    queryKey: [
      ...queryKeys.tasks.list(companyId),
      "participant-agent",
      participantAgentId ?? null,
      "owner-agent",
      ownerAgentId ?? null,
      "owner-user",
      ownerUserId ?? null,
      "compact",
      "with-routine-executions",
      "infinite",
      taskPageSize,
    ],
    queryFn: ({ pageParam, signal }) =>
      tasksApi.listCompact(
        companyId,
        {
          participantAgentId,
          ownerAgentId,
          ownerUserId,
          limit: taskPageSize,
          offset: pageParam,
          sortField: "updated",
          sortDir: "desc",
        },
        { signal },
      ),
    initialPageParam: 0,
    getNextPageParam: (lastPage, _allPages, lastPageParam) =>
      getNextTasksPageOffset(lastPage.length, lastPageParam, taskPageSize),
    placeholderData: (previousData) => previousData,
  });

  const tasks = useMemo(() => mergeTaskPagesStable(taskPages?.pages ?? []) as Task[], [taskPages]);
  const hasMoreServerTasks = syncedSearch.trim().length === 0 && hasNextPage === true;
  const loadMoreServerTasks = useCallback(() => {
    if (!hasNextPage || isFetchingNextPage || fetchNextPageInFlightRef.current) return;
    fetchNextPageInFlightRef.current = true;
    void fetchNextPage({ cancelRefetch: false }).finally(() => {
      fetchNextPageInFlightRef.current = false;
    });
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);

  return (
    <TasksList
      tasks={tasks ?? []}
      isLoading={isLoading}
      isLoadingMoreTasks={isFetchingNextPage}
      error={error as Error | null}
      agents={agents}
      projects={projects}
      liveTaskIds={liveTaskIds}
      viewStateKey="paperclip:tasks-view"
      taskLinkState={taskLinkState}
      initialOwners={
        ownerAgentId
          ? [{ ownerKind: "agent", ownerAgentId }]
          : ownerUserId
            ? [{ ownerKind: "user", ownerUserId }]
            : undefined
      }
      initialSearch={syncedSearch}
      onSearchChange={handleSearchChange}
      enableRoutineVisibilityFilter
      hasMoreTasks={hasMoreServerTasks}
      onLoadMoreTasks={loadMoreServerTasks}
      searchFilters={
        participantAgentId || ownerAgentId || ownerUserId
          ? { participantAgentId, ownerAgentId, ownerUserId }
          : undefined
      }
    />
  );
}
