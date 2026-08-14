import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { tasksApi } from "@/api/tasks";
import { queryKeys } from "@/lib/queryKeys";
import { buildSubTaskProgressSummary, shouldRenderSubTaskProgressSummary } from "@/lib/task-detail-subtasks";
import { applyTaskFilters, countActiveTaskFilters, taskFilterLabel, taskPriorityOrder, taskStatusOrder } from "@/lib/task-filters";
import { groupBy } from "@/lib/groupBy";
import { formatOwnerUserLabel } from "@/lib/task-owners";
import { KANBAN_BOARD_HIGH_VOLUME_THRESHOLD, KANBAN_COLD_STATUSES, KANBAN_COLUMN_DEFAULT_PAGE_SIZE } from "../KanbanBoard";
import { TASK_BOARD_COLUMN_RESULT_LIMIT, isActionableWorkflowStatus, buildChecklistStepNumberMap, buildPreviousSiblingTaskIdMap, shouldSuppressSinglePreviousSiblingBlockerChip, sortTasks, taskMatchesLocalSearch } from "./model";
import type { Task } from "@paperclipai/shared";
import { useTasksListCore, type TasksListCoreInput } from "./useTasksListCore";

export type TasksListDerivedInput = TasksListCoreInput & ReturnType<typeof useTasksListCore>;

export function useTasksListDerived(m: TasksListDerivedInput) {
  const { boardTasks, normalizedTaskSearch, searchWithinLoadedTasks, searchedTasks, tasks, boardTaskQueries, viewState, searchFilters, enableRoutineVisibilityFilter, liveTaskIds, showProgressSummary, defaultSortField, taskById, companyId, projectById, taskTitleMap, agents, agentName, currentUserId, companyUserLabelMap } = m;
  const boardColumnLimitReached = useMemo(
    () =>
      viewState.viewMode === "board" &&
      !searchWithinLoadedTasks &&
      boardTaskQueries.some(
        (query: { data?: Task[] }) => (query.data?.length ?? 0) === TASK_BOARD_COLUMN_RESULT_LIMIT,
      ),
    [boardTaskQueries, searchWithinLoadedTasks, viewState.viewMode],
  );

  const sourceTasks = useMemo(() => {
    const useRemoteSearch =
      normalizedTaskSearch.length > 0 && !searchWithinLoadedTasks;
    return boardTasks ?? (useRemoteSearch ? searchedTasks : tasks);
  }, [
    boardTasks,
    tasks,
    normalizedTaskSearch,
    searchedTasks,
    searchWithinLoadedTasks,
  ]);

  const searchScopedTasks = useMemo(
    () =>
      normalizedTaskSearch.length > 0 && searchWithinLoadedTasks
        ? sourceTasks.filter((task: Task) =>
            taskMatchesLocalSearch(task, normalizedTaskSearch),
          )
        : sourceTasks,
    [normalizedTaskSearch, searchWithinLoadedTasks, sourceTasks],
  );
  const filtered = useMemo(() => {
    const filteredByControls = applyTaskFilters(
      searchScopedTasks,
      viewState,
      enableRoutineVisibilityFilter,
      liveTaskIds,
    );
    return sortTasks(filteredByControls, viewState);
  }, [
    searchScopedTasks,
    viewState,
    enableRoutineVisibilityFilter,
    liveTaskIds,
  ]);

  const progressSummary = useMemo(
    () =>
      shouldRenderSubTaskProgressSummary(showProgressSummary, tasks.length)
        ? buildSubTaskProgressSummary(tasks)
        : null,
    [tasks, showProgressSummary],
  );
  const checklistAffordanceEnabled = useMemo(
    () => defaultSortField === "workflow" && viewState.groupBy === "none",
    [defaultSortField, viewState.groupBy],
  );
  const workflowChecklistMeta = useMemo(() => {
    if (!checklistAffordanceEnabled) return null;

    const visibleTaskIds = new Set(filtered.map((task) => task.id));
    const stepNumberByTaskId = buildChecklistStepNumberMap(
      filtered,
      viewState.nestingEnabled,
    );
    const previousSiblingTaskIdByTaskId = buildPreviousSiblingTaskIdMap(
      filtered,
      viewState.nestingEnabled,
    );
    const unresolvedVisibleBlockersByTaskId = new Map<string, string[]>();

    filtered.forEach((task) => {
      const unresolvedVisible = (task.blockedBy ?? [])
        .map((blocker) => blocker.id)
        .filter((blockerId) => {
          if (!visibleTaskIds.has(blockerId)) return false;
          const blockerTask = taskById.get(blockerId);
          if (!blockerTask) return false;
          return (
            blockerTask.boardPresentationStatus !== "done" &&
            blockerTask.boardPresentationStatus !== "cancelled"
          );
        });
      const shouldSuppressChip = shouldSuppressSinglePreviousSiblingBlockerChip(
        task,
        unresolvedVisible,
        previousSiblingTaskIdByTaskId.get(task.id),
      );
      unresolvedVisibleBlockersByTaskId.set(
        task.id,
        shouldSuppressChip ? [] : unresolvedVisible,
      );
    });

    const firstActionable =
      filtered.find((task) =>
        isActionableWorkflowStatus(task.boardPresentationStatus),
      ) ?? null;
    const currentStepTask =
      firstActionable ??
      filtered.find((task) => task.boardPresentationStatus === "blocked") ??
      null;

    return {
      stepNumberByTaskId,
      unresolvedVisibleBlockersByTaskId,
      currentStepTaskId: currentStepTask?.id ?? null,
    };
  }, [
    checklistAffordanceEnabled,
    filtered,
    taskById,
    viewState.nestingEnabled,
  ]);

  const { data: labels } = useQuery({
    queryKey: queryKeys.tasks.labels(companyId),
    queryFn: () => tasksApi.listLabels(companyId),
  });

  const activeFilterCount = countActiveTaskFilters(
    viewState,
    enableRoutineVisibilityFilter,
  );
  const boardHighVolume =
    viewState.viewMode === "board" &&
    filtered.length > KANBAN_BOARD_HIGH_VOLUME_THRESHOLD;
  const boardCompactCards =
    viewState.boardCardDensity === "compact" ||
    (viewState.boardCardDensity === "auto" && boardHighVolume);
  const boardCollapsedStatuses = useMemo(
    () =>
      viewState.boardColdLaneMode === "collapsed" ||
      (viewState.boardColdLaneMode === "auto" && boardHighVolume)
        ? [...KANBAN_COLD_STATUSES]
        : [],
    [boardHighVolume, viewState.boardColdLaneMode],
  );
  const boardDensityCustomized =
    viewState.boardCardDensity !== "auto" ||
    viewState.boardColdLaneMode !== "auto" ||
    viewState.boardColumnPageSize !== KANBAN_COLUMN_DEFAULT_PAGE_SIZE;

  const groupedContent = useMemo(() => {
    if (viewState.groupBy === "none") {
      return [{ key: "__all", label: null as string | null, items: filtered }];
    }
    if (viewState.groupBy === "status") {
      const groups = groupBy(filtered, (i) => i.boardPresentationStatus);
      return taskStatusOrder
        .filter((s) => groups[s]?.length)
        .map((s) => ({
          key: s,
          label: taskFilterLabel(s),
          items: groups[s]!,
        }));
    }
    if (viewState.groupBy === "priority") {
      const groups = groupBy(filtered, (i) => i.priority);
      return taskPriorityOrder
        .filter((p) => groups[p]?.length)
        .map((p) => ({
          key: p,
          label: taskFilterLabel(p),
          items: groups[p]!,
        }));
    }
    if (viewState.groupBy === "project") {
      const groups = groupBy(
        filtered,
        (task) => task.projectId ?? "__no_project",
      );
      return Object.keys(groups)
        .sort((a, b) => {
          if (a === "__no_project") return 1;
          if (b === "__no_project") return -1;
          const labelA = projectById.get(a)?.name ?? a;
          const labelB = projectById.get(b)?.name ?? b;
          return labelA.localeCompare(labelB);
        })
        .map((key) => ({
          key,
          label:
            key === "__no_project"
              ? "No Project"
              : (projectById.get(key)?.name ?? key.slice(0, 8)),
          items: groups[key]!,
        }));
    }
    if (viewState.groupBy === "parent") {
      const groups = groupBy(filtered, (i) => i.parentId ?? "__no_parent");
      return Object.keys(groups)
        .sort((a, b) => {
          // Groups with items first, "no parent" last
          if (a === "__no_parent") return 1;
          if (b === "__no_parent") return -1;
          return (groups[b]?.length ?? 0) - (groups[a]?.length ?? 0);
        })
        .map((key) => ({
          key,
          label:
            key === "__no_parent"
              ? "No Parent"
              : (taskTitleMap.get(key) ?? key.slice(0, 8)),
          items: groups[key]!,
        }));
    }
    // owner
    const groups = groupBy(filtered, (task) =>
      task.ownerAgentId
        ? `agent:${task.ownerAgentId}`
        : task.ownerUserId
          ? `user:${task.ownerUserId}`
          : "board",
    );
    return Object.keys(groups).map((key) => ({
      key,
      label:
        key === "board"
          ? "Board escalation"
          : key.startsWith("user:")
            ? (formatOwnerUserLabel(
                key.slice("user:".length),
                currentUserId,
                companyUserLabelMap,
              ) ?? "User")
            : (agentName(key.slice("agent:".length)) ??
              key.slice("agent:".length, "agent:".length + 8)),
      items: groups[key]!,
    }));
  }, [
    filtered,
    viewState.groupBy,
    agents,
    agentName,
    currentUserId,
    taskTitleMap,
    companyUserLabelMap,
    projectById,
  ]);

  return { boardColumnLimitReached, sourceTasks, searchScopedTasks, filtered, progressSummary, workflowChecklistMeta, labels, activeFilterCount, boardCompactCards, boardCollapsedStatuses, boardDensityCustomized, groupedContent };
}
