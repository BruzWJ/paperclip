import { deriveOriginatingActor, type Task } from "@paperclipai/shared";

export type TaskFilterState = {
  statuses: string[];
  priorities: string[];
  owners: string[];
  creators: string[];
  labels: string[];
  projects: string[];
  liveOnly?: boolean;
  hideRoutineExecutions: boolean;
};

export const defaultTaskFilterState: TaskFilterState = {
  statuses: [],
  priorities: [],
  owners: [],
  creators: [],
  labels: [],
  projects: [],
  liveOnly: false,
  hideRoutineExecutions: false,
};

export const taskStatusOrder = ["in_progress", "todo", "backlog", "in_review", "blocked", "done", "cancelled"];
export const taskPriorityOrder = ["critical", "high", "medium", "low"];

export const taskQuickFilterPresets = [
  { label: "All", statuses: [] as string[] },
  { label: "Active", statuses: ["todo", "in_progress", "in_review", "blocked"] },
  { label: "Backlog", statuses: ["backlog"] },
  { label: "Done", statuses: ["done", "cancelled"] },
];

export function taskFilterLabel(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

export function taskFilterArraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((value, index) => value === sortedB[index]);
}

function normalizeTaskFilterValueArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

export function normalizeTaskFilterState(value: unknown): TaskFilterState {
  if (!value || typeof value !== "object") return { ...defaultTaskFilterState };
  const candidate = value as Partial<Record<keyof TaskFilterState, unknown>>;
  return {
    statuses: normalizeTaskFilterValueArray(candidate.statuses),
    priorities: normalizeTaskFilterValueArray(candidate.priorities),
    owners: normalizeTaskFilterValueArray(candidate.owners),
    creators: normalizeTaskFilterValueArray(candidate.creators),
    labels: normalizeTaskFilterValueArray(candidate.labels),
    projects: normalizeTaskFilterValueArray(candidate.projects),
    liveOnly: candidate.liveOnly === true,
    hideRoutineExecutions: candidate.hideRoutineExecutions === true,
  };
}

export function toggleTaskFilterValue(values: string[], value: string): string[] {
  return values.includes(value) ? values.filter((existing) => existing !== value) : [...values, value];
}

export function applyTaskFilters(
  tasks: Task[],
  state: TaskFilterState,
  currentUserId?: string | null,
  enableRoutineVisibilityFilter = false,
  liveTaskIds?: ReadonlySet<string>,
): Task[] {
  let result = tasks;
  if (state.liveOnly) {
    result = result.filter((task) => liveTaskIds?.has(task.id) === true);
  }
  if (enableRoutineVisibilityFilter && state.hideRoutineExecutions) {
    result = result.filter((task) => task.originKind !== "routine_execution");
  }
  if (state.statuses.length > 0) result = result.filter((task) => state.statuses.includes(task.boardPresentationStatus));
  if (state.priorities.length > 0) result = result.filter((task) => state.priorities.includes(task.priority));
  if (state.owners.length > 0) {
    result = result.filter((task) => {
      for (const owner of state.owners) {
        if (owner === "__board" && task.ownerKind === "board") return true;
        if (owner === "__me" && currentUserId && task.ownerUserId === currentUserId) return true;
        if (task.ownerAgentId === owner) return true;
      }
      return false;
    });
  }
  if (state.creators.length > 0) {
    result = result.filter((task) => {
      const creatorActor = deriveOriginatingActor(task);
      for (const creator of state.creators) {
        if (creator.startsWith("agent:")
          && creatorActor?.kind === "agent"
          && creatorActor.id === creator.slice("agent:".length)) return true;
        if (creator.startsWith("user:")
          && creatorActor?.kind === "user"
          && creatorActor.id === creator.slice("user:".length)) return true;
      }
      return false;
    });
  }
  if (state.labels.length > 0) {
    result = result.filter((task) => (task.labelIds ?? []).some((id) => state.labels.includes(id)));
  }
  if (state.projects.length > 0) {
    result = result.filter((task) => task.projectId != null && state.projects.includes(task.projectId));
  }
  return result;
}

export function countActiveTaskFilters(
  state: TaskFilterState,
  enableRoutineVisibilityFilter = false,
): number {
  let count = 0;
  if (state.statuses.length > 0) count += 1;
  if (state.priorities.length > 0) count += 1;
  if (state.owners.length > 0) count += 1;
  if (state.creators.length > 0) count += 1;
  if (state.labels.length > 0) count += 1;
  if (state.projects.length > 0) count += 1;
  if (state.liveOnly) count += 1;
  if (enableRoutineVisibilityFilter && state.hideRoutineExecutions) count += 1;
  return count;
}
