import { useCallback } from "react";
import type { Task } from "@paperclipai/shared";
import { buildSubTaskDefaultsForViewer } from "@/lib/subTaskDefaults";
import { normalizeInboxTaskColumns, type InboxTaskColumn, DEFAULT_INBOX_TASK_COLUMNS } from "@/lib/inbox";
import { saveTaskColumns } from "./-model";
import { taskActivityText } from "./-TaskColumns";
import { useTasksListNavigation, type TasksListNavigationInput } from "./-useTasksListNavigation";

export type TasksListActionsInput = TasksListNavigationInput & ReturnType<typeof useTasksListNavigation>;

interface TaskListGroup {
  key: string;
  items: Task[];
}

export function useTasksListActions(m: TasksListActionsInput) {
  const {
    baseCreateTaskDefaults,
    projectId,
    viewState,
    taskById,
    createTaskLabel,
    openNewTask,
    scopedKey,
    setVisibleTaskColumns,
    visibleTaskColumns,
    renderedTaskRowLimit,
  } = m;
  const newTaskDefaults = useCallback(
    (group?: TaskListGroup) => {
      const groupKey = group?.key;
      const defaults: Record<string, unknown> = {
        ...(baseCreateTaskDefaults ?? {}),
      };
      if (projectId && defaults.projectId === undefined) defaults.projectId = projectId;
      if (groupKey) {
        if (viewState.groupBy === "status") defaults.status = groupKey;
        else if (viewState.groupBy === "priority") defaults.priority = groupKey;
        else if (viewState.groupBy === "owner" && groupKey.startsWith("agent:")) {
          defaults.ownerAgentId = groupKey.slice("agent:".length);
        } else if (viewState.groupBy === "project" && groupKey !== "__no_project")
          defaults.projectId = groupKey;
        else if (viewState.groupBy === "parent" && groupKey !== "__no_parent") {
          const parentTask = taskById.get(groupKey);
          if (parentTask) Object.assign(defaults, buildSubTaskDefaultsForViewer(parentTask));
          else defaults.parentId = groupKey;
        }
      }
      return defaults;
    },
    [baseCreateTaskDefaults, taskById, projectId, viewState.groupBy],
  );

  const createActionLabel = createTaskLabel ? `Create ${createTaskLabel}` : "Create Task";
  const createButtonLabel = createTaskLabel ? `New ${createTaskLabel}` : "New Task";
  const openCreateTaskDialog = useCallback(
    (group?: TaskListGroup) => {
      openNewTask(newTaskDefaults(group));
    },
    [newTaskDefaults, openNewTask],
  );

  const setTaskColumns = useCallback(
    (next: InboxTaskColumn[]) => {
      const normalized = normalizeInboxTaskColumns(next);
      setVisibleTaskColumns(normalized);
      saveTaskColumns(scopedKey, normalized);
    },
    [scopedKey],
  );

  const toggleTaskColumn = useCallback(
    (column: InboxTaskColumn, enabled: boolean) => {
      if (enabled) {
        setTaskColumns([...visibleTaskColumns, column]);
        return;
      }
      setTaskColumns(visibleTaskColumns.filter((value: InboxTaskColumn) => value !== column));
    },
    [setTaskColumns, visibleTaskColumns],
  );

  let remainingRowsToRender = viewState.viewMode === "list" ? renderedTaskRowLimit : Number.POSITIVE_INFINITY;

  return {
    newTaskDefaults,
    createActionLabel,
    createButtonLabel,
    openCreateTaskDialog,
    setTaskColumns,
    toggleTaskColumn,
    remainingRowsToRender,
    taskActivityText,
    DEFAULT_INBOX_TASK_COLUMNS,
  };
}
