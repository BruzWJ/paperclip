import type { TasksListProps } from "./tasks-list/model";
import { TasksListContext } from "./tasks-list/context";
import { TasksListView } from "./tasks-list/TasksListView";
import { useTasksListModel } from "./tasks-list/useTasksListModel";

export type {
  BoardCardDensity,
  BoardColdLaneMode,
  TaskSortField,
  TasksListProps,
  TaskViewState,
} from "./tasks-list/model";

export function TasksList({
  searchWithinLoadedTasks = false,
  showProgressSummary = false,
  enableRoutineVisibilityFilter = false,
  hasMoreTasks = false,
  isLoadingMoreTasks = false,
  ...props
}: TasksListProps) {
  const input = {
    ...props,
    searchWithinLoadedTasks,
    showProgressSummary,
    enableRoutineVisibilityFilter,
    hasMoreTasks,
    isLoadingMoreTasks,
  };
  const model = useTasksListModel(input);
  return (
    <TasksListContext.Provider value={model}>
      <TasksListView />
    </TasksListContext.Provider>
  );
}
