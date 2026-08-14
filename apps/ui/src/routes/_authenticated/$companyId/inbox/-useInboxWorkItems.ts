import { taskTrailingColumns } from "@/components/TaskColumns";
import { buildCompanyUserLabelMap, buildCompanyUserProfileMap } from "@/lib/company-members";
import {
  getApprovalsForTab,
  getArchivedInboxSearchTasks,
  getInboxSearchSupplementTasks,
  getInboxWorkItems,
  getLatestFailedRunsByAgent,
  getRecentTouchedTasks,
  inboxTaskColumns,
  isInboxEntityDismissed,
} from "@/lib/inbox";
import { applyTaskFilters } from "@/lib/task-filters";
import { useMemo } from "react";
import { buildInboxCreatorOptions, filterInboxWorkItems } from "./-inbox-work-item-helpers";
import { useInboxGrouping } from "./-useInboxGrouping";
import type { useInboxQueries } from "./-useInboxQueries";
import type { InboxState } from "./-useInboxState";

type InboxQueries = ReturnType<typeof useInboxQueries>;

export interface UseInboxWorkItemsOptions {
  tab: Parameters<typeof getApprovalsForTab>[1];
  isMobile: boolean;
  queries: InboxQueries;
  state: InboxState;
}

/** Derives visible inbox entities, search supplements, grouping, and nav indexes. */
export function useInboxWorkItems({ tab, isMobile, queries, state }: UseInboxWorkItemsOptions) {
  const {
    agents,
    projects,
    approvals,
    joinRequests,
    tasks,
    mineTasksRaw,
    touchedTasksRaw,
    runPage,
    liveTaskIds,
    companyMembers,
    currentUserId,
    remoteTaskSearchResults,
  } = queries;
  const {
    locallyArchivedTaskIds,
    taskFilters,
    normalizedSearchQuery,
    allCategoryFilter,
    allApprovalFilter,
    dismissedAtByKey,
    groupBy,
    visibleTaskColumns,
    nestingPreferenceEnabled,
    collapsedGroupKeys,
    collapsedInboxParents,
  } = state;

  const companyUserLabelMap = useMemo(
    () => buildCompanyUserLabelMap(companyMembers?.users),
    [companyMembers?.users],
  );
  const companyUserProfileMap = useMemo(
    () => buildCompanyUserProfileMap(companyMembers?.users),
    [companyMembers?.users],
  );
  const mineTasks = useMemo(
    () => getRecentTouchedTasks(mineTasksRaw).filter((task) => !locallyArchivedTaskIds.has(task.id)),
    [locallyArchivedTaskIds, mineTasksRaw],
  );
  const touchedTasks = useMemo(
    () => getRecentTouchedTasks(touchedTasksRaw).filter((task) => !locallyArchivedTaskIds.has(task.id)),
    [locallyArchivedTaskIds, touchedTasksRaw],
  );
  const visibleMineTasks = useMemo(
    () => applyTaskFilters(mineTasks, taskFilters, true, liveTaskIds),
    [liveTaskIds, mineTasks, taskFilters],
  );
  const visibleTouchedTasks = useMemo(
    () => applyTaskFilters(touchedTasks, taskFilters, true, liveTaskIds),
    [liveTaskIds, taskFilters, touchedTasks],
  );
  const unreadTouchedTasks = useMemo(
    () => visibleTouchedTasks.filter((task) => task.isUnreadForMe),
    [visibleTouchedTasks],
  );
  const creatorOptions = useMemo(
    () =>
      buildInboxCreatorOptions({
        agents,
        currentUserId,
        mineTasks,
        touchedTasks,
      }),
    [agents, currentUserId, mineTasks, touchedTasks],
  );

  const tasksToRender = useMemo(() => {
    if (tab === "mine") return visibleMineTasks;
    if (tab === "unread") return unreadTouchedTasks;
    return visibleTouchedTasks;
  }, [tab, unreadTouchedTasks, visibleMineTasks, visibleTouchedTasks]);
  const agentById = useMemo(() => new Map((agents ?? []).map((agent) => [agent.id, agent.name])), [agents]);
  const taskById = useMemo(() => new Map((tasks ?? []).map((task) => [task.id, task])), [tasks]);
  const projectById = useMemo(() => {
    const map = new Map<string, { name: string; color: string | null }>();
    for (const project of projects ?? []) map.set(project.id, { name: project.name, color: project.color });
    return map;
  }, [projects]);
  const inboxGrouping = useMemo(
    () => ({
      agentById,
      projectById,
      userLabelById: companyUserLabelMap,
      currentUserId,
    }),
    [agentById, companyUserLabelMap, currentUserId, projectById],
  );
  const visibleTaskColumnSet = useMemo(() => new Set(visibleTaskColumns), [visibleTaskColumns]);
  const availableTaskColumns = inboxTaskColumns;
  const availableTaskColumnSet = useMemo(() => new Set(availableTaskColumns), [availableTaskColumns]);
  const visibleTrailingTaskColumns = useMemo(
    () =>
      taskTrailingColumns.filter(
        (column) => visibleTaskColumnSet.has(column) && availableTaskColumnSet.has(column),
      ),
    [availableTaskColumnSet, visibleTaskColumnSet],
  );
  const failedRuns = useMemo(
    () =>
      getLatestFailedRunsByAgent(runPage?.items ?? []).filter(
        (run) => !isInboxEntityDismissed(dismissedAtByKey, `run:${run.id}`, run.createdAt),
      ),
    [dismissedAtByKey, runPage?.items],
  );
  const approvalsToRender = useMemo(() => {
    let filtered = getApprovalsForTab(approvals ?? [], tab, allApprovalFilter, currentUserId);
    if (tab === "mine") {
      filtered = filtered.filter(
        (approval) =>
          !isInboxEntityDismissed(dismissedAtByKey, `approval:${approval.id}`, approval.updatedAt),
      );
    }
    return filtered;
  }, [allApprovalFilter, approvals, currentUserId, dismissedAtByKey, tab]);
  const showJoinRequestsCategory =
    allCategoryFilter === "everything" || allCategoryFilter === "join_requests";
  const showTouchedCategory = allCategoryFilter === "everything" || allCategoryFilter === "tasks_i_touched";
  const showApprovalsCategory = allCategoryFilter === "everything" || allCategoryFilter === "approvals";
  const showFailedRunsCategory = allCategoryFilter === "everything" || allCategoryFilter === "failed_runs";
  const showAlertsCategory = allCategoryFilter === "everything" || allCategoryFilter === "alerts";
  const failedRunsForTab = useMemo(
    () => (tab === "all" && !showFailedRunsCategory ? [] : failedRuns),
    [failedRuns, showFailedRunsCategory, tab],
  );
  const joinRequestsForTab = useMemo(() => {
    if (tab === "all" && !showJoinRequestsCategory) return [];
    if (tab === "mine") {
      return joinRequests.filter(
        (request) =>
          !isInboxEntityDismissed(
            dismissedAtByKey,
            `join:${request.id}`,
            request.updatedAt ?? request.createdAt,
          ),
      );
    }
    return joinRequests;
  }, [dismissedAtByKey, joinRequests, showJoinRequestsCategory, tab]);
  const workItemsToRender = useMemo(
    () =>
      getInboxWorkItems({
        tasks: tab === "all" && !showTouchedCategory ? [] : tasksToRender,
        approvals: tab === "all" && !showApprovalsCategory ? [] : approvalsToRender,
        failedRuns: failedRunsForTab,
        joinRequests: joinRequestsForTab,
      }),
    [
      approvalsToRender,
      failedRunsForTab,
      joinRequestsForTab,
      showApprovalsCategory,
      showTouchedCategory,
      tab,
      tasksToRender,
    ],
  );
  const filteredWorkItems = useMemo(
    () =>
      filterInboxWorkItems({
        agentById,
        normalizedSearchQuery,
        taskById,
        workItems: workItemsToRender,
      }),
    [agentById, normalizedSearchQuery, taskById, workItemsToRender],
  );

  const archivedSearchTasks = useMemo(
    () =>
      tab === "mine"
        ? getArchivedInboxSearchTasks({
            visibleTasks: visibleMineTasks,
            searchableTasks: visibleTouchedTasks,
            query: normalizedSearchQuery,
          })
        : [],
    [normalizedSearchQuery, tab, visibleMineTasks, visibleTouchedTasks],
  );
  const taskSearchSupplementResults = useMemo(
    () =>
      getInboxSearchSupplementTasks({
        query: normalizedSearchQuery,
        filteredWorkItems,
        archivedSearchTasks,
        remoteTasks: remoteTaskSearchResults,
        taskFilters,
        enableRoutineVisibilityFilter: true,
        liveTaskIds,
      }),
    [
      archivedSearchTasks,
      filteredWorkItems,
      liveTaskIds,
      normalizedSearchQuery,
      remoteTaskSearchResults,
      taskFilters,
    ],
  );
  const nonInboxSearchTaskIds = useMemo(
    () =>
      new Set([
        ...archivedSearchTasks.map((task) => task.id),
        ...taskSearchSupplementResults.map((task) => task.id),
      ]),
    [archivedSearchTasks, taskSearchSupplementResults],
  );
  const grouping = useInboxGrouping({
    filteredWorkItems,
    archivedSearchTasks,
    taskSearchSupplementResults,
    groupBy,
    inboxGrouping,
    nestingPreferenceEnabled,
    isMobile,
    collapsedGroupKeys,
    collapsedInboxParents,
    liveTaskIds,
  });
  const {
    nestingEnabled,
    groupedSections,
    totalVisibleWorkItems,
    flatNavItems,
    flatNavItemsRef,
    subtreeLiveCounts,
    topFlatIndex,
    childFlatIndex,
    groupFlatIndex,
  } = grouping;
  const agentName = (id: string | null) => (id ? (agentById.get(id) ?? null) : null);

  return {
    companyUserLabelMap,
    companyUserProfileMap,
    mineTasks,
    touchedTasks,
    visibleMineTasks,
    visibleTouchedTasks,
    unreadTouchedTasks,
    creatorOptions,
    tasksToRender,
    agentById,
    taskById,
    projectById,
    inboxGrouping,
    visibleTaskColumnSet,
    availableTaskColumns,
    availableTaskColumnSet,
    visibleTrailingTaskColumns,
    failedRuns,
    approvalsToRender,
    showJoinRequestsCategory,
    showTouchedCategory,
    showApprovalsCategory,
    showFailedRunsCategory,
    showAlertsCategory,
    failedRunsForTab,
    joinRequestsForTab,
    workItemsToRender,
    filteredWorkItems,
    archivedSearchTasks,
    taskSearchSupplementResults,
    nonInboxSearchTaskIds,
    nestingEnabled,
    groupedSections,
    totalVisibleWorkItems,
    flatNavItems,
    flatNavItemsRef,
    subtreeLiveCounts,
    topFlatIndex,
    childFlatIndex,
    groupFlatIndex,
    agentName,
  };
}
