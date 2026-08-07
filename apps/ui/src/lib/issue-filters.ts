import { deriveOriginatingActor, type Issue } from "@paperclipai/shared";

export type IssueFilterState = {
  statuses: string[];
  priorities: string[];
  owners: string[];
  creators: string[];
  labels: string[];
  projects: string[];
  liveOnly?: boolean;
  hideRoutineExecutions: boolean;
};

export const defaultIssueFilterState: IssueFilterState = {
  statuses: [],
  priorities: [],
  owners: [],
  creators: [],
  labels: [],
  projects: [],
  liveOnly: false,
  hideRoutineExecutions: false,
};

export const issueStatusOrder = ["in_progress", "todo", "backlog", "in_review", "blocked", "done", "cancelled"];
export const issuePriorityOrder = ["critical", "high", "medium", "low"];

export const issueQuickFilterPresets = [
  { label: "All", statuses: [] as string[] },
  { label: "Active", statuses: ["todo", "in_progress", "in_review", "blocked"] },
  { label: "Backlog", statuses: ["backlog"] },
  { label: "Done", statuses: ["done", "cancelled"] },
];

export function issueFilterLabel(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

export function issueFilterArraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((value, index) => value === sortedB[index]);
}

function normalizeIssueFilterValueArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

export function normalizeIssueFilterState(value: unknown): IssueFilterState {
  if (!value || typeof value !== "object") return { ...defaultIssueFilterState };
  const candidate = value as Partial<Record<keyof IssueFilterState, unknown>>;
  return {
    statuses: normalizeIssueFilterValueArray(candidate.statuses),
    priorities: normalizeIssueFilterValueArray(candidate.priorities),
    owners: normalizeIssueFilterValueArray(candidate.owners),
    creators: normalizeIssueFilterValueArray(candidate.creators),
    labels: normalizeIssueFilterValueArray(candidate.labels),
    projects: normalizeIssueFilterValueArray(candidate.projects),
    liveOnly: candidate.liveOnly === true,
    hideRoutineExecutions: candidate.hideRoutineExecutions === true,
  };
}

export function toggleIssueFilterValue(values: string[], value: string): string[] {
  return values.includes(value) ? values.filter((existing) => existing !== value) : [...values, value];
}

export function applyIssueFilters(
  issues: Issue[],
  state: IssueFilterState,
  currentUserId?: string | null,
  enableRoutineVisibilityFilter = false,
  liveIssueIds?: ReadonlySet<string>,
): Issue[] {
  let result = issues;
  if (state.liveOnly) {
    result = result.filter((issue) => liveIssueIds?.has(issue.id) === true);
  }
  if (enableRoutineVisibilityFilter && state.hideRoutineExecutions) {
    result = result.filter((issue) => issue.originKind !== "routine_execution");
  }
  if (state.statuses.length > 0) result = result.filter((issue) => state.statuses.includes(issue.boardPresentationStatus));
  if (state.priorities.length > 0) result = result.filter((issue) => state.priorities.includes(issue.priority));
  if (state.owners.length > 0) {
    result = result.filter((issue) => {
      for (const owner of state.owners) {
        if (owner === "__board" && issue.ownerKind === "board") return true;
        if (owner === "__me" && currentUserId && issue.ownerUserId === currentUserId) return true;
        if (issue.ownerAgentId === owner) return true;
      }
      return false;
    });
  }
  if (state.creators.length > 0) {
    result = result.filter((issue) => {
      const creatorActor = deriveOriginatingActor(issue);
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
    result = result.filter((issue) => (issue.labelIds ?? []).some((id) => state.labels.includes(id)));
  }
  if (state.projects.length > 0) {
    result = result.filter((issue) => issue.projectId != null && state.projects.includes(issue.projectId));
  }
  return result;
}

export function countActiveIssueFilters(
  state: IssueFilterState,
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
