import { useEffect, useMemo, useCallback, useRef, useState } from "react";
import { useLocation, useSearchParams } from "@/lib/router";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { tasksApi } from "../api/tasks";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { ACTIVE_TASK_EXECUTION_RUN_STATUSES, runsApi } from "../api/runs";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { collectLiveTaskIds } from "../lib/liveTaskIds";
import { usePublishSharedQueryData, useSharedPollingQuery } from "@/hooks/useSharedPolling";
import { queryKeys } from "../lib/queryKeys";
import { createTaskDetailLocationState } from "../lib/taskDetailBreadcrumb";
import { EmptyState } from "../components/EmptyState";
import { TasksList } from "../components/TasksList";
import { CircleDot } from "lucide-react";
import type { Task } from "@paperclipai/shared";

const TASKS_PAGE_SIZE = 100;

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

export function buildTasksSearchUrl(currentHref: string, search: string): string | null {
  const url = new URL(currentHref);
  const currentSearch = url.searchParams.get("q") ?? "";
  if (currentSearch === search) return null;

  if (search.length > 0) {
    url.searchParams.set("q", search);
  } else {
    url.searchParams.delete("q");
  }

  return `${url.pathname}${url.search}${url.hash}`;
}

export function Tasks() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const fetchNextPageInFlightRef = useRef(false);

  const urlSearch = searchParams.get("q") ?? "";
  const [searchOverride, setSearchOverride] = useState<{ search: string; locationSearch: string } | null>(null);
  const syncedSearch = useMemo(() => {
    if (typeof window !== "undefined" && searchOverride?.locationSearch === window.location.search) {
      return searchOverride.search;
    }
    return urlSearch;
  }, [searchOverride, urlSearch, location.search]);
  const participantAgentId = searchParams.get("participantAgentId") ?? undefined;
  const handleSearchChange = useCallback((search: string) => {
    const nextUrl = buildTasksSearchUrl(window.location.href, search);
    if (!nextUrl) {
      setSearchOverride(null);
      return;
    }
    window.history.replaceState(window.history.state, "", nextUrl);
    setSearchOverride({ search, locationSearch: window.location.search });
  }, []);

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const activeRunsQueryKey = queryKeys.runs(selectedCompanyId!, { status: ACTIVE_TASK_EXECUTION_RUN_STATUSES });
  const sharedActiveRuns = useSharedPollingQuery({
    companyId: selectedCompanyId,
    resourceKey: "active-runs",
    queryKey: activeRunsQueryKey,
    enabled: !!selectedCompanyId,
    // Event-sourced via LiveUpdatesProvider; no interval poll needed.
    refetchInterval: false,
    leaderOnly: true,
  });
  const { data: activeRunPage, dataUpdatedAt: activeRunsUpdatedAt } = useQuery({
    queryKey: activeRunsQueryKey,
    queryFn: () => runsApi.listForCompany(selectedCompanyId!, { status: ACTIVE_TASK_EXECUTION_RUN_STATUSES, limit: 200 }),
    enabled: sharedActiveRuns.enabled,
    refetchInterval: sharedActiveRuns.refetchInterval,
  });
  usePublishSharedQueryData(sharedActiveRuns, activeRunPage, activeRunsUpdatedAt);

  const liveTaskIds = useMemo(() => collectLiveTaskIds(activeRunPage?.items), [activeRunPage]);

  const taskLinkState = useMemo(
    () =>
      createTaskDetailLocationState(
        "Tasks",
        `${location.pathname}${location.search}${location.hash}`,
        "tasks",
      ),
    [location.pathname, location.search, location.hash],
  );

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
      ...queryKeys.tasks.list(selectedCompanyId!),
      "participant-agent",
      participantAgentId ?? "__all__",
      "compact",
      "with-routine-executions",
      "infinite",
      taskPageSize,
    ],
    queryFn: ({ pageParam, signal }) => tasksApi.listCompact(selectedCompanyId!, {
      participantAgentId,
      includeRoutineExecutions: true,
      limit: taskPageSize,
      offset: pageParam,
      sortField: "updated",
      sortDir: "desc",
    }, { signal }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, _allPages, lastPageParam) =>
      getNextTasksPageOffset(lastPage.length, lastPageParam, taskPageSize),
    enabled: !!selectedCompanyId,
    placeholderData: (previousData) => previousData,
  });

  const tasks = useMemo(() => mergeTaskPagesStable(taskPages?.pages ?? []) as Task[], [taskPages]);
  const hasMoreServerTasks = syncedSearch.trim().length === 0
    && hasNextPage === true;
  const loadMoreServerTasks = useCallback(() => {
    if (!hasNextPage || isFetchingNextPage || fetchNextPageInFlightRef.current) return;
    fetchNextPageInFlightRef.current = true;
    void fetchNextPage({ cancelRefetch: false }).finally(() => {
      fetchNextPageInFlightRef.current = false;
    });
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);

  if (!selectedCompanyId) {
    return <EmptyState icon={CircleDot} message="Select a company to view tasks." />;
  }

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
      initialOwners={searchParams.get("owner") ? [searchParams.get("owner")!] : undefined}
      initialSearch={syncedSearch}
      onSearchChange={handleSearchChange}
      enableRoutineVisibilityFilter
      hasMoreTasks={hasMoreServerTasks}
      onLoadMoreTasks={loadMoreServerTasks}
      searchFilters={participantAgentId ? { participantAgentId } : undefined}
    />
  );
}
