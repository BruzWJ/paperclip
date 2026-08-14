import { createContext, useContext, type ReactNode } from "react";

import type { TaskDetailController } from "./index";

const TaskDetailPageContext = createContext<TaskDetailController | null>(null);

export function TaskDetailPageProvider({
  value,
  children,
}: {
  value: TaskDetailController;
  children: ReactNode;
}) {
  return <TaskDetailPageContext.Provider value={value}>{children}</TaskDetailPageContext.Provider>;
}

export function useTaskDetailPage(): TaskDetailController {
  const value = useContext(TaskDetailPageContext);
  if (!value) {
    throw new Error("useTaskDetailPage requires TaskDetailPageProvider");
  }
  return value;
}
