import {
  deriveOriginatingActor,
  isCanonicalUuid,
  type Task,
} from "@paperclipai/shared";

export type TaskOwnerFilter =
  | { ownerKind: "board" }
  | { ownerKind: "agent"; ownerAgentId: string }
  | { ownerKind: "user"; ownerUserId: string };

export type TaskFilterState = {
  statuses: string[];
  priorities: string[];
  owners: TaskOwnerFilter[];
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

export const taskStatusOrder = [
  "in_progress",
  "todo",
  "backlog",
  "in_review",
  "blocked",
  "done",
  "cancelled",
];
export const taskPriorityOrder = ["critical", "high", "medium", "low"];

export const taskQuickFilterPresets = [
  { label: "All", statuses: [] as string[] },
  {
    label: "Active",
    statuses: ["todo", "in_progress", "in_review", "blocked"],
  },
  { label: "Backlog", statuses: ["backlog"] },
  { label: "Done", statuses: ["done", "cancelled"] },
];

export function taskFilterLabel(value: string): string {
  return value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
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

function taskOwnerFiltersEqual(
  left: TaskOwnerFilter,
  right: TaskOwnerFilter,
): boolean {
  if (left.ownerKind !== right.ownerKind) return false;
  if (left.ownerKind === "board") return true;
  if (left.ownerKind === "agent" && right.ownerKind === "agent") {
    return left.ownerAgentId === right.ownerAgentId;
  }
  return left.ownerKind === "user" && right.ownerKind === "user"
    ? left.ownerUserId === right.ownerUserId
    : false;
}

function parseTaskOwnerFilter(value: unknown): TaskOwnerFilter | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.ownerKind === "board") {
    return Object.keys(candidate).length === 1 ? { ownerKind: "board" } : null;
  }
  if (
    candidate.ownerKind === "agent" &&
    Object.keys(candidate).length === 2 &&
    typeof candidate.ownerAgentId === "string" &&
    isCanonicalUuid(candidate.ownerAgentId)
  ) {
    return { ownerKind: "agent", ownerAgentId: candidate.ownerAgentId };
  }
  if (
    candidate.ownerKind === "user" &&
    Object.keys(candidate).length === 2 &&
    typeof candidate.ownerUserId === "string" &&
    candidate.ownerUserId.length > 0 &&
    candidate.ownerUserId.trim() === candidate.ownerUserId
  ) {
    return { ownerKind: "user", ownerUserId: candidate.ownerUserId };
  }
  return null;
}

export function hasTaskOwnerFilter(
  owners: readonly TaskOwnerFilter[],
  owner: TaskOwnerFilter,
): boolean {
  return owners.some((candidate) => taskOwnerFiltersEqual(candidate, owner));
}

export function toggleTaskOwnerFilter(
  owners: readonly TaskOwnerFilter[],
  owner: TaskOwnerFilter,
): TaskOwnerFilter[] {
  return hasTaskOwnerFilter(owners, owner)
    ? owners.filter((candidate) => !taskOwnerFiltersEqual(candidate, owner))
    : [...owners, owner];
}

function normalizeTaskOwnerFilters(value: unknown): TaskOwnerFilter[] {
  if (!Array.isArray(value)) return [];
  const owners: TaskOwnerFilter[] = [];
  for (const entry of value) {
    const owner = parseTaskOwnerFilter(entry);
    if (
      owner &&
      !owners.some((existing) => taskOwnerFiltersEqual(existing, owner))
    ) {
      owners.push(owner);
    }
  }
  return owners;
}

export function normalizeTaskFilterState(value: unknown): TaskFilterState {
  if (!value || typeof value !== "object") return { ...defaultTaskFilterState };
  const candidate = value as Partial<Record<keyof TaskFilterState, unknown>>;
  return {
    statuses: normalizeTaskFilterValueArray(candidate.statuses),
    priorities: normalizeTaskFilterValueArray(candidate.priorities),
    owners: normalizeTaskOwnerFilters(candidate.owners),
    creators: normalizeTaskFilterValueArray(candidate.creators),
    labels: normalizeTaskFilterValueArray(candidate.labels),
    projects: normalizeTaskFilterValueArray(candidate.projects),
    liveOnly: candidate.liveOnly === true,
    hideRoutineExecutions: candidate.hideRoutineExecutions === true,
  };
}

export function toggleTaskFilterValue(
  values: string[],
  value: string,
): string[] {
  return values.includes(value)
    ? values.filter((existing) => existing !== value)
    : [...values, value];
}

export function applyTaskFilters(
  tasks: Task[],
  state: TaskFilterState,
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
  if (state.statuses.length > 0)
    result = result.filter((task) =>
      state.statuses.includes(task.boardPresentationStatus),
    );
  if (state.priorities.length > 0)
    result = result.filter((task) => state.priorities.includes(task.priority));
  if (state.owners.length > 0) {
    result = result.filter((task) => {
      for (const owner of state.owners) {
        if (owner.ownerKind === "board" && task.ownerKind === "board")
          return true;
        if (
          owner.ownerKind === "agent" &&
          task.ownerAgentId === owner.ownerAgentId
        )
          return true;
        if (
          owner.ownerKind === "user" &&
          task.ownerUserId === owner.ownerUserId
        )
          return true;
      }
      return false;
    });
  }
  if (state.creators.length > 0) {
    result = result.filter((task) => {
      const creatorActor = deriveOriginatingActor(task);
      for (const creator of state.creators) {
        if (
          creator.startsWith("agent:") &&
          creatorActor?.kind === "agent" &&
          creatorActor.id === creator.slice("agent:".length)
        )
          return true;
        if (
          creator.startsWith("user:") &&
          creatorActor?.kind === "user" &&
          creatorActor.id === creator.slice("user:".length)
        )
          return true;
      }
      return false;
    });
  }
  if (state.labels.length > 0) {
    result = result.filter((task) =>
      (task.labelIds ?? []).some((id) => state.labels.includes(id)),
    );
  }
  if (state.projects.length > 0) {
    result = result.filter(
      (task) =>
        task.projectId != null && state.projects.includes(task.projectId),
    );
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
