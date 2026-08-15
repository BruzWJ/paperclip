import type { Task } from "@paperclipai/shared";
import { TaskPropertiesView } from "./-TaskPropertiesView";
import { useTaskLabelProperties } from "./-useTaskLabelProperties";
import { useTaskProjectProperties } from "./-useTaskProjectProperties";
import { useTaskPropertiesData } from "./-useTaskPropertiesData";
import { useTaskPropertiesMonitor } from "./-useTaskPropertiesMonitor";
import { useTaskPropertiesOwnership } from "./-useTaskPropertiesOwnership";
import { useTaskPropertiesState } from "./-useTaskPropertiesState";
import { useTaskRelationProperties } from "./-useTaskRelationProperties";

interface TaskPropertiesProps {
  task: Task;
  childTasks?: Task[];
  onAddSubTask?: () => void;
  onUpdate: (data: Record<string, unknown>) => void;
  inline?: boolean;
  hasActiveRun?: boolean;
}

function useTaskPropertiesController({
  task,
  childTasks = [],
  onAddSubTask,
  onUpdate,
  inline,
  hasActiveRun = false,
}: TaskPropertiesProps) {
  const state = useTaskPropertiesState(task);
  const base = {
    task,
    childTasks,
    onAddSubTask,
    onUpdate,
    inline,
    hasActiveRun,
    state,
  };
  const data = useTaskPropertiesData(base);
  const context = { ...base, data };
  const monitor = useTaskPropertiesMonitor(context);
  const labels = useTaskLabelProperties(context);
  const ownership = useTaskPropertiesOwnership(context);
  const project = useTaskProjectProperties(context);
  const relations = useTaskRelationProperties(context);
  return { ...base, ...data, ...monitor, ...labels, ...ownership, ...project, ...relations };
}

export type TaskPropertiesController = ReturnType<typeof useTaskPropertiesController>;

export function TaskProperties(props: TaskPropertiesProps) {
  return <TaskPropertiesView {...useTaskPropertiesController(props)} />;
}
