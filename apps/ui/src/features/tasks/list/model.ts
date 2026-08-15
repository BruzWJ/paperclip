import { TASK_STATUSES, type Task, type TaskStatus } from "@paperclipai/shared";
import { tasksApi } from "@/api/tasks";
import {
  defaultTaskFilterState,
  normalizeTaskFilterState,
  taskPriorityOrder,
  taskStatusOrder,
  type TaskFilterState,
  type TaskOwnerFilter,
} from "@/lib/task-filters";
import { DEFAULT_INBOX_TASK_COLUMNS, normalizeInboxTaskColumns, type InboxTaskColumn } from "@/lib/inbox";
import { taskDisplayTitle } from "@/lib/task-display";
import {
  KANBAN_COLUMN_DEFAULT_PAGE_SIZE,
  KANBAN_COLUMN_PAGE_SIZE_OPTIONS,
  type KanbanColumnPageSize,
} from "./KanbanBoard";
import { buildTaskTree } from "@/lib/task-tree";
import { workflowSort } from "@/lib/workflow-sort";
import type { NamedEntity, NamedEntityWithColor } from "@/lib/presentation-contracts";
export const TASK_SEARCH_DEBOUNCE_MS = 250;
export const TASK_SEARCH_RESULT_LIMIT = 200;
export const TASK_BOARD_COLUMN_RESULT_LIMIT = 200;
export type TasksListNavEntry =
  | { type: "group"; key: string; collapsed: boolean }
  | {
      type: "task";
      task: Task;
      hasChildren: boolean;
      expanded: boolean;
      budgetOrdinal: number;
    };

export function tasksListNavEntryKey(entry: TasksListNavEntry): string {
  return entry.type === "group" ? `group:${entry.key}` : `task:${entry.task.id}`;
}

// CSS.escape is missing in some non-browser environments (jsdom tests).
export function escapeAttrValue(value: string): string {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function"
    ? CSS.escape(value)
    : value.replace(/["\\]/g, "\\$&");
}

export const INITIAL_TASK_ROW_RENDER_LIMIT = 100;
export const TASK_ROW_RENDER_BATCH_SIZE = 150;
export const TASK_SCROLL_LOAD_THRESHOLD_PX = 320;

export function findTasksScrollContainer(element: HTMLElement | null): HTMLElement | null {
  if (!element || typeof window === "undefined") return null;
  let current = element.parentElement;
  while (current && current !== document.body && current !== document.documentElement) {
    const overflowY = window.getComputedStyle(current).overflowY;
    if (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}
export const boardTaskStatuses = TASK_STATUSES;
export const taskStatusLabels: Record<TaskStatus, string> = {
  backlog: "Backlog",
  todo: "Todo",
  in_progress: "In progress",
  in_review: "In review",
  done: "Done",
  blocked: "Blocked",
  cancelled: "Cancelled",
};
/* ── View state ── */

export type TaskSortField = "status" | "priority" | "title" | "created" | "updated" | "workflow";
export type BoardCardDensity = "auto" | "compact" | "comfortable";
export type BoardColdLaneMode = "auto" | "collapsed" | "expanded";

export type TaskViewState = TaskFilterState & {
  sortField: TaskSortField;
  sortDir: "asc" | "desc";
  groupBy: "status" | "priority" | "owner" | "project" | "parent" | "none";
  viewMode: "list" | "board";
  nestingEnabled: boolean;
  collapsedGroups: string[];
  collapsedParents: string[];
  boardCardDensity: BoardCardDensity;
  boardColdLaneMode: BoardColdLaneMode;
  boardColumnPageSize: KanbanColumnPageSize;
};

const defaultViewState: TaskViewState = {
  ...defaultTaskFilterState,
  sortField: "updated",
  sortDir: "desc",
  groupBy: "none",
  viewMode: "list",
  nestingEnabled: true,
  collapsedGroups: [],
  collapsedParents: [],
  boardCardDensity: "auto",
  boardColdLaneMode: "expanded",
  boardColumnPageSize: KANBAN_COLUMN_DEFAULT_PAGE_SIZE,
};

function normalizeBoardCardDensity(value: unknown): BoardCardDensity {
  return value === "compact" || value === "comfortable" || value === "auto" ? value : "auto";
}

function normalizeBoardColdLaneMode(value: unknown): BoardColdLaneMode {
  return value === "collapsed" || value === "expanded" || value === "auto" ? value : "auto";
}

function normalizeBoardColumnPageSize(value: unknown): KanbanColumnPageSize {
  return KANBAN_COLUMN_PAGE_SIZE_OPTIONS.includes(value as KanbanColumnPageSize)
    ? (value as KanbanColumnPageSize)
    : KANBAN_COLUMN_DEFAULT_PAGE_SIZE;
}

export function getViewState(key: string): TaskViewState {
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        ...defaultViewState,
        ...parsed,
        ...normalizeTaskFilterState(parsed),
        boardCardDensity: normalizeBoardCardDensity(parsed.boardCardDensity),
        boardColdLaneMode: normalizeBoardColdLaneMode(parsed.boardColdLaneMode),
        boardColumnPageSize: normalizeBoardColumnPageSize(parsed.boardColumnPageSize),
      };
    }
  } catch {
    /* ignore */
  }
  return { ...defaultViewState };
}

export function saveViewState(key: string, state: TaskViewState) {
  localStorage.setItem(key, JSON.stringify(state));
}

export function getInitialViewState(
  key: string,
  initialOwners?: TaskOwnerFilter[],
  defaultSortField?: TaskSortField,
): TaskViewState {
  const hasStored = hasStoredViewState(key);
  const stored = getViewState(key);
  const base =
    !hasStored && defaultSortField
      ? { ...stored, sortField: defaultSortField, sortDir: "asc" as const }
      : stored;
  if (!initialOwners) return base;
  return {
    ...base,
    owners: initialOwners,
    statuses: [],
  };
}

export function hasStoredViewState(key: string): boolean {
  try {
    return localStorage.getItem(key) !== null;
  } catch {
    return false;
  }
}

export function getTaskColumnsStorageKey(key: string): string {
  return `${key}:task-columns`;
}

export function loadTaskColumns(key: string): InboxTaskColumn[] {
  try {
    const raw = localStorage.getItem(getTaskColumnsStorageKey(key));
    if (raw === null) return DEFAULT_INBOX_TASK_COLUMNS;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_INBOX_TASK_COLUMNS;
    return normalizeInboxTaskColumns(parsed);
  } catch {
    return DEFAULT_INBOX_TASK_COLUMNS;
  }
}

export function saveTaskColumns(key: string, columns: InboxTaskColumn[]) {
  try {
    localStorage.setItem(getTaskColumnsStorageKey(key), JSON.stringify(normalizeInboxTaskColumns(columns)));
  } catch {
    // Ignore localStorage failures.
  }
}

export function sortTasks(tasks: Task[], state: TaskViewState): Task[] {
  if (state.sortField === "workflow") {
    const ordered = workflowSort(tasks);
    return state.sortDir === "desc" ? [...ordered].reverse() : ordered;
  }
  const sorted = [...tasks];
  const dir = state.sortDir === "asc" ? 1 : -1;
  sorted.sort((a, b) => {
    switch (state.sortField) {
      case "status":
        return (
          dir *
          (taskStatusOrder.indexOf(a.boardPresentationStatus) -
            taskStatusOrder.indexOf(b.boardPresentationStatus))
        );
      case "priority":
        return dir * (taskPriorityOrder.indexOf(a.priority) - taskPriorityOrder.indexOf(b.priority));
      case "title":
        return dir * taskDisplayTitle(a).localeCompare(taskDisplayTitle(b));
      case "created":
        return dir * (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      case "updated":
        return dir * (new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime());
      default:
        return 0;
    }
  });
  return sorted;
}

export function taskMatchesLocalSearch(task: Task, normalizedSearch: string): boolean {
  if (!normalizedSearch) return true;
  return [task.identifier, task.title, task.request].some((value) =>
    value?.toLowerCase().includes(normalizedSearch),
  );
}

export function isActionableWorkflowStatus(status: TaskStatus): boolean {
  return status !== "done" && status !== "cancelled" && status !== "blocked";
}

export function buildChecklistStepNumberMap(tasks: Task[], nestingEnabled: boolean): Map<string, string> {
  const stepNumberByTaskId = new Map<string, string>();

  if (!nestingEnabled) {
    tasks.forEach((task, index) => {
      stepNumberByTaskId.set(task.id, String(index + 1));
    });
    return stepNumberByTaskId;
  }

  const { roots, childMap } = buildTaskTree(tasks);
  const visit = (siblings: Task[], prefix: string | null) => {
    siblings.forEach((task, index) => {
      const stepNumber = prefix ? `${prefix}.${index + 1}` : String(index + 1);
      stepNumberByTaskId.set(task.id, stepNumber);
      visit(childMap.get(task.id) ?? [], stepNumber);
    });
  };
  visit(roots, null);

  tasks.forEach((task, index) => {
    if (!stepNumberByTaskId.has(task.id)) {
      stepNumberByTaskId.set(task.id, String(index + 1));
    }
  });

  return stepNumberByTaskId;
}

export function buildPreviousSiblingTaskIdMap(tasks: Task[], nestingEnabled: boolean): Map<string, string> {
  const previousSiblingByTaskId = new Map<string, string>();

  if (!nestingEnabled) {
    const previousByParentId = new Map<string, Task>();
    for (const task of tasks) {
      if (!task.parentId) continue;
      const previousSibling = previousByParentId.get(task.parentId);
      if (previousSibling) {
        previousSiblingByTaskId.set(task.id, previousSibling.id);
      }
      previousByParentId.set(task.parentId, task);
    }
    return previousSiblingByTaskId;
  }

  const { roots, childMap } = buildTaskTree(tasks);
  const visit = (siblings: Task[]) => {
    siblings.forEach((task, index) => {
      const previousSibling = index > 0 ? siblings[index - 1] : null;
      if (task.parentId && previousSibling?.parentId === task.parentId) {
        previousSiblingByTaskId.set(task.id, previousSibling.id);
      }
      visit(childMap.get(task.id) ?? []);
    });
  };
  visit(roots);

  return previousSiblingByTaskId;
}

export function shouldSuppressSinglePreviousSiblingBlockerChip(
  task: Task,
  unresolvedVisibleBlockerIds: string[],
  previousSiblingTaskId: string | undefined,
): boolean {
  return Boolean(
    task.parentId &&
    previousSiblingTaskId &&
    (task.blockedBy ?? []).length === 1 &&
    unresolvedVisibleBlockerIds.length === 1 &&
    unresolvedVisibleBlockerIds[0] === previousSiblingTaskId,
  );
}

/* ── Component ── */

export type TaskListRequestFilters = NonNullable<Parameters<typeof tasksApi.list>[1]>;

export interface TasksListProps {
  // Loading and error surfaces announce through role="status" live regions.
  tasks: Task[];
  isLoading?: boolean;
  error?: Error | null;
  agents?: NamedEntity[];
  projects?: NamedEntityWithColor[];
  liveTaskIds?: Set<string>;
  projectId?: string;
  viewStateKey: string;
  taskLinkState?: unknown;
  initialOwners?: TaskOwnerFilter[];
  initialSearch?: string;
  searchFilters?: Omit<TaskListRequestFilters, "q" | "projectId" | "limit">;
  searchWithinLoadedTasks?: boolean;
  baseCreateTaskDefaults?: Record<string, unknown>;
  createTaskLabel?: string;
  defaultSortField?: TaskSortField;
  showProgressSummary?: boolean;
  /**
   * When set together with `showProgressSummary`, the progress strip fetches
   * the recursive cost-summary for this parent task and renders aggregate
   * tokens + wall-clock runtime for every run in the tree.
   */
  parentTaskIdForCostSummary?: string;
  enableRoutineVisibilityFilter?: boolean;
  hasMoreTasks?: boolean;
  isLoadingMoreTasks?: boolean;
  mutedTaskIds?: Set<string>;
  taskBadgeById?: Map<string, string>;
  onLoadMoreTasks?: () => void;
  onSearchChange?: (search: string) => void;
}
