import type { Task, TaskStatus } from "@paperclipai/shared";
import { workflowSort } from "./workflow-sort";

export type SubTaskProgressTargetKind = "next" | "blocked";

export type SubTaskProgressTarget = {
  task: Task;
  kind: SubTaskProgressTargetKind;
};

export type SubTaskProgressSummary = {
  totalCount: number;
  doneCount: number;
  inProgressCount: number;
  blockedCount: number;
  countsByStatus: Partial<Record<TaskStatus, number>>;
  target: SubTaskProgressTarget | null;
};

export type TaskSiblingNavigation = {
  previous: Task | null;
  next: Task | null;
  currentIndex: number;
  totalCount: number;
};

export function shouldRenderRichSubTasksSection(childTasksLoading: boolean, childTaskCount: number): boolean {
  return childTasksLoading || childTaskCount > 0;
}

const MIN_CHILD_TASKS_FOR_PROGRESS_SUMMARY = 2;

export function shouldRenderSubTaskProgressSummary(enabled: boolean | undefined, childTaskCount: number): boolean {
  return enabled === true && childTaskCount >= MIN_CHILD_TASKS_FOR_PROGRESS_SUMMARY;
}

export function buildSubTaskProgressSummary(tasks: Task[]): SubTaskProgressSummary {
  const countsByStatus: Partial<Record<TaskStatus, number>> = {};
  const progressTasks = tasks.filter((task) => task.boardPresentationStatus !== "cancelled");
  for (const task of progressTasks) {
    countsByStatus[task.boardPresentationStatus] = (countsByStatus[task.boardPresentationStatus] ?? 0) + 1;
  }

  const orderedTasks = workflowSort(progressTasks);
  const nextTask = orderedTasks.find((task) => isActionableStatus(task.boardPresentationStatus)) ?? null;
  const remainingTasks = orderedTasks.filter((task) => !isTerminalStatus(task.boardPresentationStatus));
  const blockedTask =
    nextTask === null && remainingTasks.length > 0 && remainingTasks.every((task) => task.boardPresentationStatus === "blocked")
      ? remainingTasks[0]
      : null;

  return {
    totalCount: progressTasks.length,
    doneCount: countsByStatus.done ?? 0,
    inProgressCount: countsByStatus.in_progress ?? 0,
    blockedCount: countsByStatus.blocked ?? 0,
    countsByStatus,
    target: nextTask
      ? { task: nextTask, kind: "next" }
      : blockedTask
        ? { task: blockedTask, kind: "blocked" }
        : null,
  };
}

export function buildTaskSiblingNavigation(
  currentTask: Task,
  siblingTasks: Task[],
  childTasks: Task[] = [],
): TaskSiblingNavigation | null {
  if (currentTask.hiddenAt) return null;

  const byId = new Map<string, Task>();
  if (currentTask.parentId) {
    for (const task of siblingTasks) {
      if (task.parentId !== currentTask.parentId || task.hiddenAt) continue;
      byId.set(
        task.id,
        task.id === currentTask.id
          ? { ...task, ...currentTask, blockedBy: currentTask.blockedBy ?? task.blockedBy }
          : task,
      );
    }
    if (!byId.has(currentTask.id)) byId.set(currentTask.id, currentTask);
  }

  const ordered = workflowSort(Array.from(byId.values()));
  const currentIndex = ordered.findIndex((task) => task.id === currentTask.id);
  const directChildren = workflowSort(
    childTasks.filter((task) => task.parentId === currentTask.id && !task.hiddenAt),
  );
  const firstChild = directChildren[0] ?? null;

  if (currentIndex < 0) {
    return firstChild
      ? {
          previous: null,
          next: firstChild,
          currentIndex: 0,
          totalCount: directChildren.length + 1,
        }
      : null;
  }

  const previous = currentIndex > 0 ? ordered[currentIndex - 1] : null;
  const next = currentIndex < ordered.length - 1 ? ordered[currentIndex + 1] : firstChild;
  if (!previous && !next) return null;

  return {
    previous,
    next,
    currentIndex,
    totalCount: ordered.length,
  };
}

function isActionableStatus(status: TaskStatus): boolean {
  return status !== "done" && status !== "cancelled" && status !== "blocked";
}

function isTerminalStatus(status: TaskStatus): boolean {
  return status === "done" || status === "cancelled";
}
