import { accessApi } from "@/api/access";
import { agentsApi } from "@/api/agents";
import { approvalsApi } from "@/api/approvals";
import { authApi } from "@/api/auth";
import { ApiError } from "@/api/client";
import { dashboardApi } from "@/api/dashboard";
import { projectsApi } from "@/api/projects";
import { ACTIVE_TASK_EXECUTION_RUN_STATUSES, runsApi } from "@/api/runs";
import { tasksApi } from "@/api/tasks";
import { collectLiveTaskIds } from "@/lib/liveTaskIds";
import { queryKeys } from "@/lib/queryKeys";
import type { Task } from "@paperclipai/shared";
import { INBOX_MINE_TASK_STATUSES } from "@paperclipai/shared";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { INBOX_HOT_PATH_STALE_MS, INBOX_RUN_LIMIT, INBOX_TASK_LIST_LIMIT } from "./-inbox-controller-model";

export interface UseInboxQueriesOptions {
  companyId: string;
  normalizedSearchQuery: string;
}

/** Loads the inbox's independent data sources and exposes their query keys. */
export function useInboxQueries({ companyId, normalizedSearchQuery }: UseInboxQueriesOptions) {
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const currentUserId = session?.user.id ?? null;
  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
  });
  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(companyId),
    queryFn: () => projectsApi.list(companyId),
  });
  const { data: labels } = useQuery({
    queryKey: queryKeys.tasks.labels(companyId),
    queryFn: () => tasksApi.listLabels(companyId),
  });
  const {
    data: approvals,
    isLoading: isApprovalsLoading,
    error: approvalsError,
  } = useQuery({
    queryKey: queryKeys.approvals.list(companyId),
    queryFn: () => approvalsApi.list(companyId),
  });
  const { data: joinRequests = [], isLoading: isJoinRequestsLoading } = useQuery({
    queryKey: queryKeys.access.joinRequests(companyId),
    queryFn: async () => {
      try {
        return await accessApi.listJoinRequests(companyId, "pending_approval");
      } catch (error) {
        if (error instanceof ApiError && (error.status === 403 || error.status === 401)) return [];
        throw error;
      }
    },
    retry: false,
  });

  const dashboardQueryKey = queryKeys.dashboard(companyId);
  const { data: dashboard, isLoading: isDashboardLoading } = useQuery({
    queryKey: dashboardQueryKey,
    queryFn: () => dashboardApi.summary(companyId),
  });
  const inboxTasksQueryKey = [
    ...queryKeys.tasks.list(companyId),
    "compact",
    "with-routine-executions",
    "live-descendant-summary",
    INBOX_TASK_LIST_LIMIT,
  ] as const;
  const { data: tasks, isLoading: isTasksLoading } = useQuery({
    queryKey: inboxTasksQueryKey,
    queryFn: () =>
      tasksApi
        .listCompact(companyId, {
          includeLiveDescendantSummary: true,
          limit: INBOX_TASK_LIST_LIMIT,
        })
        .then((rows) => rows as Task[]),
    refetchOnWindowFocus: false,
    staleTime: INBOX_HOT_PATH_STALE_MS,
  });
  const mineTasksQueryKey = [
    ...queryKeys.tasks.listMineByMe(companyId),
    "compact",
    "with-routine-executions",
    "live-descendant-summary",
    INBOX_TASK_LIST_LIMIT,
  ] as const;
  const { data: mineTasksRaw = [], isLoading: isMineTasksLoading } = useQuery({
    queryKey: mineTasksQueryKey,
    queryFn: () =>
      tasksApi
        .listCompact(companyId, {
          touchedByUserId: currentUserId!,
          inboxArchivedByUserId: currentUserId!,
          status: INBOX_MINE_TASK_STATUSES,
          includeLiveDescendantSummary: true,
          limit: INBOX_TASK_LIST_LIMIT,
        })
        .then((rows) => rows as Task[]),
    enabled: Boolean(currentUserId),
    refetchOnWindowFocus: false,
    staleTime: INBOX_HOT_PATH_STALE_MS,
  });
  const touchedTasksQueryKey = [
    ...queryKeys.tasks.listTouchedByMe(companyId),
    "compact",
    "with-routine-executions",
    "live-descendant-summary",
    INBOX_TASK_LIST_LIMIT,
  ] as const;
  const { data: touchedTasksRaw = [], isLoading: isTouchedTasksLoading } = useQuery({
    queryKey: touchedTasksQueryKey,
    queryFn: () =>
      tasksApi
        .listCompact(companyId, {
          touchedByUserId: currentUserId!,
          status: INBOX_MINE_TASK_STATUSES,
          includeLiveDescendantSummary: true,
          limit: INBOX_TASK_LIST_LIMIT,
        })
        .then((rows) => rows as Task[]),
    enabled: Boolean(currentUserId),
    refetchOnWindowFocus: false,
    staleTime: INBOX_HOT_PATH_STALE_MS,
  });
  const { data: runPage, isLoading: isRunsLoading } = useQuery({
    queryKey: queryKeys.runs(companyId),
    queryFn: () => runsApi.listForCompany(companyId, { limit: INBOX_RUN_LIMIT }),
    refetchOnWindowFocus: false,
    staleTime: INBOX_HOT_PATH_STALE_MS,
  });
  const activeRunsQueryKey = queryKeys.runs(companyId, {
    status: ACTIVE_TASK_EXECUTION_RUN_STATUSES,
  });
  const { data: activeRunPage } = useQuery({
    queryKey: activeRunsQueryKey,
    queryFn: () =>
      runsApi.listForCompany(companyId, {
        status: ACTIVE_TASK_EXECUTION_RUN_STATUSES,
        limit: 200,
      }),
  });
  const liveTaskIds = useMemo(() => collectLiveTaskIds(activeRunPage?.items), [activeRunPage?.items]);
  const { data: companyMembers } = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(companyId),
    queryFn: () => accessApi.listUserDirectory(companyId),
  });
  const shouldUseTaskSearchSupplement = normalizedSearchQuery.length > 0;
  const { data: remoteTaskSearchResults = [] } = useQuery({
    queryKey: [
      ...queryKeys.tasks.search(companyId, normalizedSearchQuery, undefined, 25),
      "compact",
      "inbox-supplement",
      "live-descendant-summary",
    ],
    queryFn: () =>
      tasksApi
        .listCompact(companyId, {
          q: normalizedSearchQuery,
          limit: 25,
          includeLiveDescendantSummary: true,
        })
        .then((rows) => rows as Task[]),
    enabled: shouldUseTaskSearchSupplement,
    placeholderData: (previousData) => previousData,
  });

  return {
    session,
    currentUserId,
    agents,
    projects,
    labels,
    approvals,
    isApprovalsLoading,
    approvalsError,
    joinRequests,
    isJoinRequestsLoading,
    dashboardQueryKey,
    dashboard,
    isDashboardLoading,
    inboxTasksQueryKey,
    tasks,
    isTasksLoading,
    mineTasksQueryKey,
    mineTasksRaw,
    isMineTasksLoading,
    touchedTasksQueryKey,
    touchedTasksRaw,
    isTouchedTasksLoading,
    runPage,
    isRunsLoading,
    activeRunsQueryKey,
    activeRunPage,
    liveTaskIds,
    companyMembers,
    shouldUseTaskSearchSupplement,
    remoteTaskSearchResults,
  };
}
