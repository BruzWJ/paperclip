import type { Task, UpdateTaskStatus } from "@paperclipai/shared";
import { TaskPropertiesView } from "./-TaskPropertiesView";
import { useTaskPropertiesData } from "./-useTaskPropertiesData";
import { useTaskPropertiesMonitor } from "./-useTaskPropertiesMonitor";
import { useTaskPropertiesOwnership } from "./-useTaskPropertiesOwnership";
import { useTaskPropertiesState } from "./-useTaskPropertiesState";

interface TaskPropertiesProps {
  task: Task;
  childTasks?: Task[];
  onUpdate: (data: TaskPropertiesUpdate) => void;
  onStatusUpdate: (input: UpdateTaskStatus) => Promise<unknown>;
  statusUpdatePending: boolean;
  inline?: boolean;
  hasActiveRun?: boolean;
}

export type TaskPropertiesUpdate =
  { ownerAgentId: string } | { executionPolicy: NonNullable<Task["executionPolicy"]> | null };

function useTaskPropertiesController({
  task,
  childTasks = [],
  onUpdate,
  onStatusUpdate,
  statusUpdatePending,
  inline,
  hasActiveRun = false,
}: TaskPropertiesProps) {
  const state = useTaskPropertiesState(task);
  const base = {
    task,
    childTasks,
    onUpdate,
    onStatusUpdate,
    statusUpdatePending,
    inline,
    hasActiveRun,
    state,
  };
  const data = useTaskPropertiesData(base);
  const context = { ...base, data };
  const monitor = useTaskPropertiesMonitor(context);
  const ownership = useTaskPropertiesOwnership(context);
  return { ...base, ...data, ...monitor, ...ownership };
}

export type TaskPropertiesController = ReturnType<typeof useTaskPropertiesController>;

export function TaskProperties(props: TaskPropertiesProps) {
  return <TaskPropertiesView {...useTaskPropertiesController(props)} />;
}
