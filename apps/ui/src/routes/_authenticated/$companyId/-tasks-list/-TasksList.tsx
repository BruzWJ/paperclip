import type { TasksListProps } from "./-model";
import { TasksListContext } from "./-context";
import { TasksListView } from "./-TasksListView";
import { useTasksListModel } from "./-useTasksListModel";

export type {
  BoardCardDensity,
  BoardColdLaneMode,
  TaskSortField,
  TasksListProps,
  TaskViewState,
} from "./-model";

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
