import { createContext, useContext } from "react";
import type { TasksListModel } from "./-useTasksListModel";

export const TasksListContext = createContext<TasksListModel | null>(null);
export function useTasksListViewModel() {
  const value = useContext(TasksListContext);
  if (!value) throw new Error("TasksList view requires its context");
  return value;
}
