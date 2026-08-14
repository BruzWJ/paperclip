import { groupBy } from "@/lib/groupBy";
import { createTaskDetailLocationState } from "@/lib/taskDetailBreadcrumb";
import { assertOnlySearchKeys, optionalSearchEnum, optionalSearchString } from "@/routes/-search";
import {
  isCanonicalUuid,
  type FolderListResult,
  type RoutineListItem,
  type RoutineVariable,
} from "@paperclipai/shared";
import type { SortDirection } from "@/lib/presentation-contracts";

export { autoResizeTextarea } from "@/lib/textarea";

export function buildRoutineFolderRail(
  routineFolders: FolderListResult | undefined,
  visibleRoutines: RoutineListItem[],
): FolderListResult | undefined {
  if (!routineFolders) return routineFolders;
  const counts = new Map<string, number>();
  let unfiledCount = 0;
  for (const routine of visibleRoutines) {
    if (routine.folderId) {
      counts.set(routine.folderId, (counts.get(routine.folderId) ?? 0) + 1);
    } else {
      unfiledCount += 1;
    }
  }
  return {
    ...routineFolders,
    allCount: visibleRoutines.length,
    unfiledCount,
    folders: routineFolders.folders.map((folder) => ({
      ...folder,
      itemCount: counts.get(folder.id) ?? 0,
    })),
  };
}

export function validateRoutinesSearch(search: Record<string, unknown>): {
  tab?: "routines" | "runs";
  folder?: string;
} {
  assertOnlySearchKeys(search, ["tab", "folder"]);
  const folder = optionalSearchString(search.folder, "folder");
  if (folder !== undefined && folder !== "unfiled" && !isCanonicalUuid(folder)) {
    throw new Error('Invalid search parameter "folder": must be unfiled or a canonical UUID');
  }
  return {
    tab: optionalSearchEnum(search.tab, ["routines", "runs"] as const, "tab"),
    folder,
  };
}

export const concurrencyPolicies = ["coalesce_if_active", "always_enqueue", "skip_if_active"];

export const catchUpPolicies = ["skip_missed", "enqueue_missed_with_cap"];

export const RECENT_RUNS_TASK_DETAIL_LOCATION_STATE = createTaskDetailLocationState("routine_runs");

export const concurrencyPolicyDescriptions: Record<string, string> = {
  coalesce_if_active: "If a run is already active, keep just one follow-up run queued.",
  always_enqueue: "Queue every trigger occurrence, even if the routine is already running.",
  skip_if_active: "Drop new trigger occurrences while a run is still active.",
};

export const catchUpPolicyDescriptions: Record<string, string> = {
  skip_missed: "Ignore windows that were missed while the scheduler or routine was paused.",
  enqueue_missed_with_cap:
    "Catch up missed schedule windows after recovery; sub-hourly schedules are combined into one catch-up run, slower schedules replay each missed window up to a cap.",
};

export type RoutinesTab = "routines" | "runs";

export type RoutineGroupBy = "folder" | "none" | "project" | "assignee";

export type RoutineSortField = "updated" | "created" | "title" | "lastRun";

export type RoutineSortDir = SortDirection;

export type RoutineViewState = {
  sortField: RoutineSortField;
  sortDir: RoutineSortDir;
  groupBy: RoutineGroupBy;
  collapsedGroups: string[];
};

export type RoutineGroup = {
  key: string;
  label: string | null;
  items: RoutineListItem[];
};

export interface RoutineComposerDraft {
  title: string;
  description: string;
  projectId: string;
  folderId: string | null;
  assigneeAgentId: string;
  priority: string;
  concurrencyPolicy: string;
  catchUpPolicy: string;
  variables: RoutineVariable[];
}

export const defaultRoutineViewState: RoutineViewState = {
  sortField: "title",
  sortDir: "asc",
  groupBy: "folder",
  collapsedGroups: [],
};

export function getRoutineViewState(key: string): RoutineViewState {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return { ...defaultRoutineViewState, ...JSON.parse(raw) };
  } catch {
    // Ignore malformed local state and fall back to defaults.
  }
  return { ...defaultRoutineViewState };
}

export function saveRoutineViewState(key: string, state: RoutineViewState) {
  localStorage.setItem(key, JSON.stringify(state));
}

export function timestampValue(value: Date | string | null | undefined) {
  if (!value) return Number.NEGATIVE_INFINITY;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

export function compareNullableText(left: string | null | undefined, right: string | null | undefined) {
  return (left ?? "").localeCompare(right ?? "", undefined, {
    sensitivity: "base",
  });
}

export function buildRoutineMutationPayload(input: RoutineComposerDraft) {
  return {
    ...input,
    description: input.description.trim() || null,
    projectId: input.projectId || null,
    folderId: input.folderId || null,
    assigneeAgentId: input.assigneeAgentId || null,
  };
}

export function buildRoutineGroups(
  routines: RoutineListItem[],
  groupByValue: RoutineGroupBy,
  projectById: Map<string, { name: string }>,
  agentById: Map<string, { name: string }>,
): RoutineGroup[] {
  if (groupByValue === "none" || groupByValue === "folder") {
    return [{ key: "__all", label: null, items: routines }];
  }

  if (groupByValue === "project") {
    const groups = groupBy(routines, (routine) => routine.projectId ?? "__no_project");
    return Object.keys(groups)
      .sort((left, right) => {
        const leftLabel =
          left === "__no_project" ? "No project" : (projectById.get(left)?.name ?? "Unknown project");
        const rightLabel =
          right === "__no_project" ? "No project" : (projectById.get(right)?.name ?? "Unknown project");
        return leftLabel.localeCompare(rightLabel);
      })
      .map((key) => ({
        key,
        label: key === "__no_project" ? "No project" : (projectById.get(key)?.name ?? "Unknown project"),
        items: groups[key]!,
      }));
  }

  const groups = groupBy(routines, (routine) => routine.assigneeAgentId ?? "__unassigned");
  return Object.keys(groups)
    .sort((left, right) => {
      const leftLabel =
        left === "__unassigned" ? "Unassigned" : (agentById.get(left)?.name ?? "Unknown agent");
      const rightLabel =
        right === "__unassigned" ? "Unassigned" : (agentById.get(right)?.name ?? "Unknown agent");
      return leftLabel.localeCompare(rightLabel);
    })
    .map((key) => ({
      key,
      label: key === "__unassigned" ? "Unassigned" : (agentById.get(key)?.name ?? "Unknown agent"),
      items: groups[key]!,
    }));
}

export function buildRoutineSections(
  routines: RoutineListItem[],
  groupByValue: RoutineGroupBy,
  projectById: Map<string, { name: string }>,
  agentById: Map<string, { name: string }>,
): RoutineGroup[] {
  return buildRoutineGroups(routines, groupByValue, projectById, agentById).filter(
    (group) => group.items.length > 0,
  );
}

export function sortRoutines(
  routines: RoutineListItem[],
  sortField: RoutineSortField,
  sortDir: RoutineSortDir,
): RoutineListItem[] {
  const direction = sortDir === "asc" ? 1 : -1;
  return [...routines].sort((left, right) => {
    let result = 0;

    if (sortField === "title") {
      result = compareNullableText(left.title, right.title);
    } else if (sortField === "created") {
      result = timestampValue(left.createdAt) - timestampValue(right.createdAt);
    } else if (sortField === "lastRun") {
      result =
        timestampValue(left.lastRun?.triggeredAt ?? left.lastTriggeredAt) -
        timestampValue(right.lastRun?.triggeredAt ?? right.lastTriggeredAt);
    } else {
      result = timestampValue(left.updatedAt) - timestampValue(right.updatedAt);
    }

    if (result !== 0) return result * direction;
    return compareNullableText(left.title, right.title);
  });
}
