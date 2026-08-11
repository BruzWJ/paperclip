import {
  startTransition,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
  useCallback,
  useRef,
} from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useVisibilityRefetchInterval } from "@/lib/polling";
import { accessApi } from "../api/access";
import { useDialogActions } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { Link, useNavigate } from "@/lib/router";
import { tasksApi } from "../api/tasks";
import { authApi } from "../api/auth";
import { queryKeys } from "../lib/queryKeys";
import {
  shouldBlurPageSearchOnEnter,
  shouldBlurPageSearchOnEscape,
} from "../lib/keyboardShortcuts";
import { formatOwnerUserLabel } from "../lib/task-owners";
import {
  buildCompanyUserLabelMap,
  buildCompanyUserProfileMap,
} from "../lib/company-members";
import {
  createTaskDetailPath,
  rememberTaskDetailLocationState,
  withTaskDetailHeaderSeed,
} from "../lib/taskDetailBreadcrumb";
import {
  buildSubTaskProgressSummary,
  shouldRenderSubTaskProgressSummary,
  type SubTaskProgressSummary,
} from "../lib/task-detail-subtasks";
import { groupBy } from "../lib/groupBy";
import {
  applyTaskFilters,
  countActiveTaskFilters,
  defaultTaskFilterState,
  taskFilterLabel,
  taskPriorityOrder,
  normalizeTaskFilterState,
  taskStatusOrder,
  type TaskFilterState,
} from "../lib/task-filters";
import {
  DEFAULT_INBOX_TASK_COLUMNS,
  inboxTaskColumns,
  normalizeInboxTaskColumns,
  type InboxTaskColumn,
} from "../lib/inbox";
import { cn, formatDurationMs, formatMoneyAmount } from "../lib/utils";
import { collectSubtreeLiveCounts } from "../lib/liveTaskIds";
import { taskDisplayTitle } from "../lib/task-display";
import {
  InboxTaskMetaLeading,
  InboxTaskTrailingColumns,
  TaskColumnPicker,
  taskActivityText,
  taskTrailingColumns,
} from "./TaskColumns";
import { StatusIcon } from "./StatusIcon";
import { EmptyState } from "./EmptyState";
import { Identity } from "./Identity";
import { TaskGroupHeader } from "./TaskGroupHeader";
import { TaskFiltersPopover } from "./TaskFiltersPopover";
import { TaskRow } from "./TaskRow";
import { PageSkeleton } from "./PageSkeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import {
  CircleDot,
  Plus,
  ArrowUpDown,
  Layers,
  ChevronRight,
  List,
  ListTree,
  Search,
  CircleSlash2,
  ChevronsDownUp,
  PanelTopClose,
  RotateCcw,
  ListCollapse,
  SquareKanban,
} from "lucide-react";
import {
  KanbanBoard,
  KANBAN_BOARD_HIGH_VOLUME_THRESHOLD,
  KANBAN_COLD_STATUSES,
  KANBAN_COLUMN_DEFAULT_PAGE_SIZE,
  KANBAN_COLUMN_PAGE_SIZE_OPTIONS,
  type KanbanColumnPageSize,
} from "./KanbanBoard";
import { buildTaskTree, countDescendants } from "../lib/task-tree";
import { getInboxKeyboardSelectionIndex } from "../lib/inbox";
import {
  hasBlockingShortcutDialog,
  isKeyboardShortcutTextInputTarget,
} from "../lib/keyboardShortcuts";
import { useGeneralSettings } from "../context/GeneralSettingsContext";
import { buildSubTaskDefaultsForViewer } from "../lib/subTaskDefaults";
import { statusBadge } from "../lib/status-colors";
import { workflowSort } from "../lib/workflow-sort";
import {
  deriveOriginatingActor,
  TASK_STATUSES,
  type Task,
  type TaskStatus,
  type Project,
} from "@paperclipai/shared";
import { Badge } from "@/components/ui/badge";
const TASK_SEARCH_DEBOUNCE_MS = 250;
const TASK_SEARCH_RESULT_LIMIT = 200;
const TASK_BOARD_COLUMN_RESULT_LIMIT = 200;
type TasksListNavEntry =
  | { type: "group"; key: string; collapsed: boolean }
  | {
      type: "task";
      task: Task;
      hasChildren: boolean;
      expanded: boolean;
      budgetOrdinal: number;
    };

function tasksListNavEntryKey(entry: TasksListNavEntry): string {
  return entry.type === "group"
    ? `group:${entry.key}`
    : `task:${entry.task.id}`;
}

// CSS.escape is missing in some non-browser environments (jsdom tests).
function escapeAttrValue(value: string): string {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function"
    ? CSS.escape(value)
    : value.replace(/["\\]/g, "\\$&");
}

const INITIAL_TASK_ROW_RENDER_LIMIT = 100;
const TASK_ROW_RENDER_BATCH_SIZE = 150;
const TASK_SCROLL_LOAD_THRESHOLD_PX = 320;

function findTasksScrollContainer(
  element: HTMLElement | null,
): HTMLElement | null {
  if (!element || typeof window === "undefined") return null;
  let current = element.parentElement;
  while (
    current &&
    current !== document.body &&
    current !== document.documentElement
  ) {
    const overflowY = window.getComputedStyle(current).overflowY;
    if (
      overflowY === "auto" ||
      overflowY === "scroll" ||
      overflowY === "overlay"
    ) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}
const boardTaskStatuses = TASK_STATUSES;
const taskStatusLabels: Record<TaskStatus, string> = {
  backlog: "Backlog",
  todo: "Todo",
  in_progress: "In progress",
  in_review: "In review",
  done: "Done",
  blocked: "Blocked",
  cancelled: "Cancelled",
};
const progressSegmentClasses: Record<TaskStatus, string> = {
  backlog: "bg-muted-foreground/40",
  todo: "bg-blue-500",
  in_progress: "bg-yellow-500",
  in_review: "bg-violet-500",
  done: "bg-green-500",
  blocked: "bg-red-500",
  cancelled: "bg-neutral-400",
};

/* ── View state ── */

export type TaskSortField =
  "status" | "priority" | "title" | "created" | "updated" | "workflow";
export type BoardCardDensity = "auto" | "compact" | "comfortable";
export type BoardColdLaneMode = "auto" | "collapsed" | "expanded";
export type BoardColumnPageSize = KanbanColumnPageSize;

export type TaskViewState = TaskFilterState & {
  sortField: TaskSortField;
  sortDir: "asc" | "desc";
  groupBy:
    | "status"
    | "priority"
    | "owner"
    | "project"
    | "parent"
    | "none";
  viewMode: "list" | "board";
  nestingEnabled: boolean;
  collapsedGroups: string[];
  collapsedParents: string[];
  boardCardDensity: BoardCardDensity;
  boardColdLaneMode: BoardColdLaneMode;
  boardColumnPageSize: BoardColumnPageSize;
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
  return value === "compact" || value === "comfortable" || value === "auto"
    ? value
    : "auto";
}

function normalizeBoardColdLaneMode(value: unknown): BoardColdLaneMode {
  return value === "collapsed" || value === "expanded" || value === "auto"
    ? value
    : "auto";
}

function normalizeBoardColumnPageSize(value: unknown): BoardColumnPageSize {
  return KANBAN_COLUMN_PAGE_SIZE_OPTIONS.includes(value as BoardColumnPageSize)
    ? (value as BoardColumnPageSize)
    : KANBAN_COLUMN_DEFAULT_PAGE_SIZE;
}

function getViewState(key: string): TaskViewState {
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
        boardColumnPageSize: normalizeBoardColumnPageSize(
          parsed.boardColumnPageSize,
        ),
      };
    }
  } catch {
    /* ignore */
  }
  return { ...defaultViewState };
}

function saveViewState(key: string, state: TaskViewState) {
  localStorage.setItem(key, JSON.stringify(state));
}

function getInitialViewState(
  key: string,
  initialOwners?: string[],
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

function hasStoredViewState(key: string): boolean {
  try {
    return localStorage.getItem(key) !== null;
  } catch {
    return false;
  }
}

function getTaskColumnsStorageKey(key: string): string {
  return `${key}:task-columns`;
}

function loadTaskColumns(key: string): InboxTaskColumn[] {
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

function saveTaskColumns(key: string, columns: InboxTaskColumn[]) {
  try {
    localStorage.setItem(
      getTaskColumnsStorageKey(key),
      JSON.stringify(normalizeInboxTaskColumns(columns)),
    );
  } catch {
    // Ignore localStorage failures.
  }
}

function sortTasks(tasks: Task[], state: TaskViewState): Task[] {
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
        return (
          dir *
          (taskPriorityOrder.indexOf(a.priority) -
            taskPriorityOrder.indexOf(b.priority))
        );
      case "title":
        return dir * taskDisplayTitle(a).localeCompare(taskDisplayTitle(b));
      case "created":
        return (
          dir *
          (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
        );
      case "updated":
        return (
          dir *
          (new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime())
        );
      default:
        return 0;
    }
  });
  return sorted;
}

function taskMatchesLocalSearch(
  task: Task,
  normalizedSearch: string,
): boolean {
  if (!normalizedSearch) return true;
  return [task.identifier, task.title, task.request].some((value) =>
    value?.toLowerCase().includes(normalizedSearch),
  );
}

function isActionableWorkflowStatus(status: TaskStatus): boolean {
  return status !== "done" && status !== "cancelled" && status !== "blocked";
}

function buildChecklistStepNumberMap(
  tasks: Task[],
  nestingEnabled: boolean,
): Map<string, string> {
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

function buildPreviousSiblingTaskIdMap(
  tasks: Task[],
  nestingEnabled: boolean,
): Map<string, string> {
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

function shouldSuppressSinglePreviousSiblingBlockerChip(
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

interface Agent {
  id: string;
  name: string;
}

type CreatorOption = {
  id: string;
  label: string;
  kind: "agent" | "user";
  searchText?: string;
};

type ProjectOption = Pick<Project, "id" | "name" | "color">;
type TaskListRequestFilters = NonNullable<
  Parameters<typeof tasksApi.list>[1]
>;

interface TasksListProps {
  tasks: Task[];
  isLoading?: boolean;
  error?: Error | null;
  agents?: Agent[];
  projects?: ProjectOption[];
  liveTaskIds?: Set<string>;
  projectId?: string;
  viewStateKey: string;
  taskLinkState?: unknown;
  initialOwners?: string[];
  initialSearch?: string;
  searchFilters?: Omit<
    TaskListRequestFilters,
    "q" | "projectId" | "limit" | "includeRoutineExecutions"
  >;
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

function TaskSearchInput({
  value,
  onDebouncedChange,
}: {
  value: string;
  onDebouncedChange?: (search: string) => void;
}) {
  const [draftValue, setDraftValue] = useState(value);
  const lastCommittedValueRef = useRef(value);

  useEffect(() => {
    setDraftValue(value);
    lastCommittedValueRef.current = value;
  }, [value]);

  useEffect(() => {
    if (!onDebouncedChange || draftValue === lastCommittedValueRef.current)
      return;

    const timeoutId = window.setTimeout(() => {
      lastCommittedValueRef.current = draftValue;
      startTransition(() => {
        onDebouncedChange(draftValue);
      });
    }, TASK_SEARCH_DEBOUNCE_MS);

    return () => window.clearTimeout(timeoutId);
  }, [draftValue, onDebouncedChange]);

  return (
    <div className="relative w-48 sm:w-64 md:w-80">
      <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={draftValue}
        onChange={(e) => {
          setDraftValue(e.target.value);
        }}
        onKeyDown={(e) => {
          if (
            shouldBlurPageSearchOnEnter({
              key: e.key,
              isComposing: e.nativeEvent.isComposing,
            })
          ) {
            e.currentTarget.blur();
            return;
          }

          if (
            shouldBlurPageSearchOnEscape({
              key: e.key,
              isComposing: e.nativeEvent.isComposing,
              currentValue: e.currentTarget.value,
            })
          ) {
            e.currentTarget.blur();
          }
        }}
        placeholder="Search tasks..."
        className="pl-7 text-xs sm:text-sm"
        aria-label="Search tasks"
        data-page-search-target="true"
      />
    </div>
  );
}

function SubTaskProgressSummaryStrip({
  summary,
  taskLinkState,
  parentTaskIdForCostSummary,
}: {
  summary: SubTaskProgressSummary;
  taskLinkState?: unknown;
  parentTaskIdForCostSummary?: string;
}) {
  const target = summary.target;
  const targetTask = target?.task ?? null;
  const targetPathId = targetTask?.identifier ?? targetTask?.id ?? "";
  const targetState = targetTask
    ? withTaskDetailHeaderSeed(taskLinkState, targetTask)
    : undefined;
  const statusEntries = TASK_STATUSES.map((status) => ({
    status,
    count: summary.countsByStatus[status] ?? 0,
  })).filter((entry) => entry.count > 0);

  // Refresh fast enough that the runtime ticks up while a sub-task is still
  // running, but slow enough not to hammer the recursive CTE on idle trees.
  const hasInProgress = summary.inProgressCount > 0;
  const costRefetchInterval = useVisibilityRefetchInterval({
    visibleMs: 5_000,
  });
  const { data: costSummary } = useQuery({
    queryKey: queryKeys.tasks.costSummary(
      parentTaskIdForCostSummary ?? "pending",
      { excludeRoot: true },
    ),
    queryFn: () =>
      tasksApi.getCostSummary(parentTaskIdForCostSummary!, {
        excludeRoot: true,
      }),
    enabled: !!parentTaskIdForCostSummary,
    refetchInterval: hasInProgress ? costRefetchInterval : false,
  });

  const showCostSummary =
    !!costSummary && (
      costSummary.runCount > 0 ||
      costSummary.pricedPromptCount > 0 ||
      costSummary.unpricedPromptCount > 0
    );

  return (
    <div className="border border-border bg-background p-3">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            <span className="font-medium text-foreground">
              {summary.doneCount}/{summary.totalCount} done
            </span>
            <span className="text-muted-foreground">
              {summary.inProgressCount} in progress
            </span>
            <span className="text-muted-foreground">
              {summary.blockedCount} blocked
            </span>
            {showCostSummary && (
              <>
                <span
                  className="text-muted-foreground tabular-nums"
                  title={`${costSummary.runCount.toLocaleString()} run${
                    costSummary.runCount === 1 ? "" : "s"
                  } across ${costSummary.taskCount} sub-task${
                    costSummary.taskCount === 1 ? "" : "s"
                  }`}
                >
                  {formatMoneyAmount(
                    costSummary.knownCostAmount,
                    costSummary.budgetCurrency,
                  )} known cost · {costSummary.unpricedPromptCount} unpriced
                </span>
                <span className="text-muted-foreground tabular-nums">
                  {formatDurationMs(costSummary.runtimeMs)} runtime
                </span>
              </>
            )}
          </div>
          <div
            role="progressbar"
            aria-label="Sub-tasks completion progress"
            aria-valuemin={0}
            aria-valuenow={summary.doneCount}
            aria-valuemax={summary.totalCount}
            className="flex h-2 w-full overflow-hidden rounded-full bg-muted"
          >
            {statusEntries.map(({ status, count }) => (
              <span
                key={status}
                className={cn("h-full", progressSegmentClasses[status])}
                style={{ width: `${(count / summary.totalCount) * 100}%` }}
                title={`${taskStatusLabels[status]}: ${count}`}
                aria-hidden="true"
              />
            ))}
          </div>
        </div>

        <div className="min-w-0 border border-border bg-background px-3 py-2 text-sm lg:w-72">
          {target && targetTask ? (
            <>
              <div className="text-xs font-medium text-muted-foreground">
                {target.kind === "next" ? "Next up" : "Waiting on blockers"}
              </div>
              <Link
                to={createTaskDetailPath(targetPathId)}
                state={targetState}
                taskPrefetch={targetTask}
                className="mt-1 block min-w-0 text-foreground underline-offset-2 hover:underline"
              >
                <span className="font-mono text-xs text-muted-foreground">
                  {targetTask.identifier ?? targetTask.id.slice(0, 8)}
                </span>{" "}
                <span>{targetTask.title}</span>
              </Link>
            </>
          ) : summary.totalCount === 0 ? (
            <div className="text-sm font-medium text-foreground">
              No active sub-tasks
            </div>
          ) : summary.doneCount === summary.totalCount ? (
            <div className="text-sm font-medium text-foreground">
              All sub-tasks done
            </div>
          ) : (
            <div className="text-sm font-medium text-foreground">
              No actionable sub-tasks
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Mobile-only indent for nested task rows (desktop uses TaskRow treeGuides).
const MOBILE_TREE_INDENT = [
  "",
  "pl-4 sm:pl-0",
  "pl-8 sm:pl-0",
  "pl-12 sm:pl-0",
  "pl-16 sm:pl-0",
];

export function TasksList({
  tasks,
  isLoading,
  error,
  agents,
  projects,
  liveTaskIds,
  projectId,
  viewStateKey,
  taskLinkState,
  initialOwners,
  initialSearch,
  searchFilters,
  searchWithinLoadedTasks = false,
  baseCreateTaskDefaults,
  createTaskLabel,
  defaultSortField,
  showProgressSummary = false,
  parentTaskIdForCostSummary,
  enableRoutineVisibilityFilter = false,
  hasMoreTasks = false,
  isLoadingMoreTasks = false,
  mutedTaskIds,
  taskBadgeById,
  onLoadMoreTasks,
  onSearchChange,
}: TasksListProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const navigate = useNavigate();
  const { keyboardShortcutsEnabled } = useGeneralSettings();
  // Keyboard selection for the list view (mirrors the inbox). Hover moves the
  // selection only after real pointer movement, so keyboard-driven scrolling
  // doesn't hand the selection to whatever row lands under the cursor.
  const [selectedNavKey, setSelectedNavKey] = useState<string | null>(null);
  const pointerMovedSinceKeyNavRef = useRef(true);
  useEffect(() => {
    const handlePointerMove = () => {
      pointerMovedSinceKeyNavRef.current = true;
    };
    window.addEventListener("mousemove", handlePointerMove, { passive: true });
    return () => window.removeEventListener("mousemove", handlePointerMove);
  }, []);
  // Which entry the cursor is over, tracked WITHOUT React state so scrubbing the
  // list costs zero re-renders (hover paints via CSS `:hover`). Keyboard nav
  // reads this to continue from the hovered row. Key-based, so it self-heals if
  // the entry disappears (findIndex → -1).
  const hoveredNavKeyRef = useRef<string | null>(null);
  const setNavSelectionFromPointer = useCallback((navKey: string) => {
    if (!pointerMovedSinceKeyNavRef.current) return;
    hoveredNavKeyRef.current = navKey;
    // Drop any keyboard selection band the moment the mouse takes over, so we
    // never show two identical highlights at once. React bails when already
    // null, so continuous hovering triggers no re-render.
    setSelectedNavKey((prev) => (prev === null ? prev : null));
  }, []);
  const { selectedCompanyId } = useCompany();
  const { openNewTask } = useDialogActions();
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const { data: companyMembers } = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(selectedCompanyId!),
    queryFn: () => accessApi.listUserDirectory(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;

  // Scope the storage key per company so folding/view state is independent across companies.
  const scopedKey = selectedCompanyId
    ? `${viewStateKey}:${selectedCompanyId}`
    : viewStateKey;
  const initialOwnersKey = initialOwners?.join("|") ?? "";

  const [viewState, setViewState] = useState<TaskViewState>(() =>
    getInitialViewState(scopedKey, initialOwners, defaultSortField),
  );
  const [taskSearch, setTaskSearch] = useState(initialSearch ?? "");
  const [renderedTaskRowLimit, setRenderedTaskRowLimit] = useState(
    INITIAL_TASK_ROW_RENDER_LIMIT,
  );
  const [visibleTaskColumns, setVisibleTaskColumns] = useState<
    InboxTaskColumn[]
  >(() => loadTaskColumns(scopedKey));
  const renderedTaskIdsRef = useRef("");
  const initialServerFillRequestedRef = useRef(false);
  const deferredTaskSearch = useDeferredValue(taskSearch);
  const normalizedTaskSearch = deferredTaskSearch.trim().toLowerCase();

  useEffect(() => {
    setTaskSearch(initialSearch ?? "");
  }, [initialSearch]);

  // Reload view state whenever the persisted context changes.
  const prevViewStateContextKey = useRef(
    `${scopedKey}::${initialOwnersKey}`,
  );
  useEffect(() => {
    const nextContextKey = `${scopedKey}::${initialOwnersKey}`;
    if (prevViewStateContextKey.current !== nextContextKey) {
      prevViewStateContextKey.current = nextContextKey;
      setViewState(
        getInitialViewState(scopedKey, initialOwners, defaultSortField),
      );
    }
  }, [
    scopedKey,
    initialOwners,
    initialOwnersKey,
    defaultSortField,
  ]);

  const prevColumnsScopedKey = useRef(scopedKey);
  useEffect(() => {
    if (prevColumnsScopedKey.current !== scopedKey) {
      prevColumnsScopedKey.current = scopedKey;
      setVisibleTaskColumns(loadTaskColumns(scopedKey));
    }
  }, [scopedKey]);

  const updateView = useCallback(
    (patch: Partial<TaskViewState>) => {
      setViewState((prev) => {
        const next = { ...prev, ...patch };
        saveViewState(scopedKey, next);
        return next;
      });
    },
    [scopedKey],
  );

  // Prune stale IDs from collapsedParents whenever the task list changes.
  // Deleted or reassigned tasks leave orphan IDs in localStorage; this keeps
  // the stored array bounded to only current parent IDs.
  useEffect(() => {
    const parentIds = new Set(
      tasks.map((i) => i.parentId).filter(Boolean) as string[],
    );
    const pruned = viewState.collapsedParents.filter((id) => parentIds.has(id));
    if (pruned.length !== viewState.collapsedParents.length) {
      updateView({ collapsedParents: pruned });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks]);

  const { data: searchedTasks = [] } = useQuery({
    queryKey: [
      ...queryKeys.tasks.search(
        selectedCompanyId!,
        normalizedTaskSearch,
        projectId,
      ),
      searchFilters ?? {},
      "compact",
      TASK_SEARCH_RESULT_LIMIT,
      enableRoutineVisibilityFilter
        ? "with-routine-executions"
        : "without-routine-executions",
    ],
    queryFn: ({ signal }) =>
      tasksApi
        .listCompact(
          selectedCompanyId!,
          {
            q: normalizedTaskSearch,
            projectId,
            limit: TASK_SEARCH_RESULT_LIMIT,
            ...searchFilters,
            ...(enableRoutineVisibilityFilter
              ? { includeRoutineExecutions: true }
              : {}),
          },
          { signal },
        )
        .then((rows) => rows as Task[]),
    enabled:
      !!selectedCompanyId &&
      normalizedTaskSearch.length > 0 &&
      !searchWithinLoadedTasks,
    placeholderData: (previousData) => previousData,
  });
  const boardTaskQueries = useQueries({
    queries: boardTaskStatuses.map((status) => ({
      queryKey: [
        ...queryKeys.tasks.list(selectedCompanyId ?? "__no-company__"),
        "board-column",
        status,
        normalizedTaskSearch,
        projectId ?? "__all-projects__",
        searchFilters ?? {},
        "compact",
        TASK_BOARD_COLUMN_RESULT_LIMIT,
        enableRoutineVisibilityFilter
          ? "with-routine-executions"
          : "without-routine-executions",
      ],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        tasksApi
          .listCompact(
            selectedCompanyId!,
            {
              ...searchFilters,
              ...(normalizedTaskSearch.length > 0
                ? { q: normalizedTaskSearch }
                : {}),
              projectId,
              status,
              limit: TASK_BOARD_COLUMN_RESULT_LIMIT,
              ...(enableRoutineVisibilityFilter
                ? { includeRoutineExecutions: true }
                : {}),
            },
            { signal },
          )
          .then((rows) => rows as Task[]),
      enabled:
        !!selectedCompanyId &&
        viewState.viewMode === "board" &&
        !searchWithinLoadedTasks,
      placeholderData: (previousData: Task[] | undefined) => previousData,
    })),
  });
  const agentName = useCallback(
    (id: string | null) => {
      if (!id || !agents) return null;
      return agents.find((a) => a.id === id)?.name ?? null;
    },
    [agents],
  );

  const companyUserLabelMap = useMemo(
    () => buildCompanyUserLabelMap(companyMembers?.users),
    [companyMembers?.users],
  );
  const companyUserProfileMap = useMemo(
    () => buildCompanyUserProfileMap(companyMembers?.users),
    [companyMembers?.users],
  );

  const projectById = useMemo(() => {
    const map = new Map<string, { name: string; color: string | null }>();
    for (const project of projects ?? []) {
      map.set(project.id, { name: project.name, color: project.color ?? null });
    }
    return map;
  }, [projects]);

  const creatorOptions = useMemo<CreatorOption[]>(() => {
    const options = new Map<string, CreatorOption>();
    const knownAgentIds = new Set<string>();

    if (currentUserId) {
      options.set(`user:${currentUserId}`, {
        id: `user:${currentUserId}`,
        label: "Me",
        kind: "user",
        searchText: `me user human ${currentUserId}`,
      });
    }

    for (const task of tasks) {
      const creator = deriveOriginatingActor(task);
      if (creator?.kind === "user") {
        const id = `user:${creator.id}`;
        if (!options.has(id)) {
          options.set(id, {
            id,
            label:
              formatOwnerUserLabel(creator.id, currentUserId) ??
              creator.id.slice(0, 5),
            kind: "user",
            searchText: `${creator.id} board user human`,
          });
        }
      }
    }

    for (const agent of agents ?? []) {
      knownAgentIds.add(agent.id);
      const id = `agent:${agent.id}`;
      if (!options.has(id)) {
        options.set(id, {
          id,
          label: agent.name,
          kind: "agent",
          searchText: `${agent.name} ${agent.id} agent`,
        });
      }
    }

    for (const task of tasks) {
      const creator = deriveOriginatingActor(task);
      if (creator?.kind === "agent" && !knownAgentIds.has(creator.id)) {
        const id = `agent:${creator.id}`;
        if (!options.has(id)) {
          options.set(id, {
            id,
            label: creator.id.slice(0, 8),
            kind: "agent",
            searchText: `${creator.id} agent`,
          });
        }
      }
    }

    return [...options.values()].sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "user" ? -1 : 1;
      return a.label.localeCompare(b.label);
    });
  }, [agents, currentUserId, tasks]);

  const visibleTaskColumnSet = useMemo(
    () => new Set(visibleTaskColumns),
    [visibleTaskColumns],
  );
  const availableTaskColumns = inboxTaskColumns;
  const availableTaskColumnSet = useMemo(
    () => new Set(availableTaskColumns),
    [availableTaskColumns],
  );
  const subtreeLiveCounts = useMemo(
    () => collectSubtreeLiveCounts(tasks, liveTaskIds ?? new Set<string>()),
    [tasks, liveTaskIds],
  );
  const visibleTrailingTaskColumns = useMemo(
    () =>
      taskTrailingColumns.filter(
        (column) =>
          visibleTaskColumnSet.has(column) &&
          availableTaskColumnSet.has(column),
      ),
    [availableTaskColumnSet, visibleTaskColumnSet],
  );

  const taskById = useMemo(() => {
    const map = new Map<string, Task>();
    for (const task of tasks) {
      map.set(task.id, task);
    }
    return map;
  }, [tasks]);

  const taskTitleMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const task of tasks) {
      const title = taskDisplayTitle(task);
      map.set(
        task.id,
        task.identifier && task.identifier !== title
          ? `${task.identifier}: ${title}`
          : title,
      );
    }
    return map;
  }, [tasks]);

  const boardTasks = useMemo(() => {
    if (viewState.viewMode !== "board" || searchWithinLoadedTasks) return null;
    const merged = new Map<string, Task>();
    let isPending = false;
    for (const query of boardTaskQueries) {
      isPending ||= query.isPending;
      for (const task of query.data ?? []) {
        merged.set(task.id, task);
      }
    }
    if (merged.size > 0) return [...merged.values()];
    return isPending ? tasks : [];
  }, [boardTaskQueries, tasks, searchWithinLoadedTasks, viewState.viewMode]);
  const boardColumnLimitReached = useMemo(
    () =>
      viewState.viewMode === "board" &&
      !searchWithinLoadedTasks &&
      boardTaskQueries.some(
        (query) =>
          (query.data?.length ?? 0) === TASK_BOARD_COLUMN_RESULT_LIMIT,
      ),
    [boardTaskQueries, searchWithinLoadedTasks, viewState.viewMode],
  );

  const sourceTasks = useMemo(() => {
    const useRemoteSearch =
      normalizedTaskSearch.length > 0 && !searchWithinLoadedTasks;
    return boardTasks ?? (useRemoteSearch ? searchedTasks : tasks);
  }, [
    boardTasks,
    tasks,
    normalizedTaskSearch,
    searchedTasks,
    searchWithinLoadedTasks,
  ]);

  const searchScopedTasks = useMemo(
    () =>
      normalizedTaskSearch.length > 0 && searchWithinLoadedTasks
        ? sourceTasks.filter((task) =>
            taskMatchesLocalSearch(task, normalizedTaskSearch),
          )
        : sourceTasks,
    [normalizedTaskSearch, searchWithinLoadedTasks, sourceTasks],
  );
  const filtered = useMemo(() => {
    const filteredByControls = applyTaskFilters(
      searchScopedTasks,
      viewState,
      currentUserId,
      enableRoutineVisibilityFilter,
      liveTaskIds,
    );
    return sortTasks(filteredByControls, viewState);
  }, [
    searchScopedTasks,
    viewState,
    currentUserId,
    enableRoutineVisibilityFilter,
    liveTaskIds,
  ]);

  const progressSummary = useMemo(
    () =>
      shouldRenderSubTaskProgressSummary(showProgressSummary, tasks.length)
        ? buildSubTaskProgressSummary(tasks)
        : null,
    [tasks, showProgressSummary],
  );
  const checklistAffordanceEnabled = useMemo(
    () => defaultSortField === "workflow" && viewState.groupBy === "none",
    [defaultSortField, viewState.groupBy],
  );
  const workflowChecklistMeta = useMemo(() => {
    if (!checklistAffordanceEnabled) return null;

    const visibleTaskIds = new Set(filtered.map((task) => task.id));
    const stepNumberByTaskId = buildChecklistStepNumberMap(
      filtered,
      viewState.nestingEnabled,
    );
    const previousSiblingTaskIdByTaskId = buildPreviousSiblingTaskIdMap(
      filtered,
      viewState.nestingEnabled,
    );
    const unresolvedVisibleBlockersByTaskId = new Map<string, string[]>();

    filtered.forEach((task) => {
      const unresolvedVisible = (task.blockedBy ?? [])
        .map((blocker) => blocker.id)
        .filter((blockerId) => {
          if (!visibleTaskIds.has(blockerId)) return false;
          const blockerTask = taskById.get(blockerId);
          if (!blockerTask) return false;
          return (
            blockerTask.boardPresentationStatus !== "done" &&
            blockerTask.boardPresentationStatus !== "cancelled"
          );
        });
      const shouldSuppressChip = shouldSuppressSinglePreviousSiblingBlockerChip(
        task,
        unresolvedVisible,
        previousSiblingTaskIdByTaskId.get(task.id),
      );
      unresolvedVisibleBlockersByTaskId.set(
        task.id,
        shouldSuppressChip ? [] : unresolvedVisible,
      );
    });

    const firstActionable =
      filtered.find((task) =>
        isActionableWorkflowStatus(task.boardPresentationStatus),
      ) ?? null;
    const currentStepTask =
      firstActionable ??
      filtered.find((task) => task.boardPresentationStatus === "blocked") ??
      null;

    return {
      stepNumberByTaskId,
      unresolvedVisibleBlockersByTaskId,
      currentStepTaskId: currentStepTask?.id ?? null,
    };
  }, [
    checklistAffordanceEnabled,
    filtered,
    taskById,
    viewState.nestingEnabled,
  ]);

  const { data: labels } = useQuery({
    queryKey: queryKeys.tasks.labels(selectedCompanyId!),
    queryFn: () => tasksApi.listLabels(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const activeFilterCount = countActiveTaskFilters(
    viewState,
    enableRoutineVisibilityFilter,
  );
  const boardHighVolume =
    viewState.viewMode === "board" &&
    filtered.length > KANBAN_BOARD_HIGH_VOLUME_THRESHOLD;
  const boardCompactCards =
    viewState.boardCardDensity === "compact" ||
    (viewState.boardCardDensity === "auto" && boardHighVolume);
  const boardCollapsedStatuses = useMemo(
    () =>
      viewState.boardColdLaneMode === "collapsed" ||
      (viewState.boardColdLaneMode === "auto" && boardHighVolume)
        ? [...KANBAN_COLD_STATUSES]
        : [],
    [boardHighVolume, viewState.boardColdLaneMode],
  );
  const boardDensityCustomized =
    viewState.boardCardDensity !== "auto" ||
    viewState.boardColdLaneMode !== "auto" ||
    viewState.boardColumnPageSize !== KANBAN_COLUMN_DEFAULT_PAGE_SIZE;

  const groupedContent = useMemo(() => {
    if (viewState.groupBy === "none") {
      return [{ key: "__all", label: null as string | null, items: filtered }];
    }
    if (viewState.groupBy === "status") {
      const groups = groupBy(filtered, (i) => i.boardPresentationStatus);
      return taskStatusOrder
        .filter((s) => groups[s]?.length)
        .map((s) => ({
          key: s,
          label: taskFilterLabel(s),
          items: groups[s]!,
        }));
    }
    if (viewState.groupBy === "priority") {
      const groups = groupBy(filtered, (i) => i.priority);
      return taskPriorityOrder
        .filter((p) => groups[p]?.length)
        .map((p) => ({
          key: p,
          label: taskFilterLabel(p),
          items: groups[p]!,
        }));
    }
    if (viewState.groupBy === "project") {
      const groups = groupBy(
        filtered,
        (task) => task.projectId ?? "__no_project",
      );
      return Object.keys(groups)
        .sort((a, b) => {
          if (a === "__no_project") return 1;
          if (b === "__no_project") return -1;
          const labelA = projectById.get(a)?.name ?? a;
          const labelB = projectById.get(b)?.name ?? b;
          return labelA.localeCompare(labelB);
        })
        .map((key) => ({
          key,
          label:
            key === "__no_project"
              ? "No Project"
              : (projectById.get(key)?.name ?? key.slice(0, 8)),
          items: groups[key]!,
        }));
    }
    if (viewState.groupBy === "parent") {
      const groups = groupBy(filtered, (i) => i.parentId ?? "__no_parent");
      return Object.keys(groups)
        .sort((a, b) => {
          // Groups with items first, "no parent" last
          if (a === "__no_parent") return 1;
          if (b === "__no_parent") return -1;
          return (groups[b]?.length ?? 0) - (groups[a]?.length ?? 0);
        })
        .map((key) => ({
          key,
          label:
            key === "__no_parent"
              ? "No Parent"
              : (taskTitleMap.get(key) ?? key.slice(0, 8)),
          items: groups[key]!,
        }));
    }
    // owner
    const groups = groupBy(
      filtered,
      (task) =>
        task.ownerAgentId ??
        (task.ownerUserId ? `__user:${task.ownerUserId}` : "__board"),
    );
    return Object.keys(groups).map((key) => ({
      key,
      label:
        key === "__board"
          ? "Board escalation"
          : key.startsWith("__user:")
            ? (formatOwnerUserLabel(
                key.slice("__user:".length),
                currentUserId,
                companyUserLabelMap,
              ) ?? "User")
            : (agentName(key) ?? key.slice(0, 8)),
      items: groups[key]!,
    }));
  }, [
    filtered,
    viewState.groupBy,
    agents,
    agentName,
    currentUserId,
    taskTitleMap,
    companyUserLabelMap,
    projectById,
  ]);

  // Flattened visible order (group headers, then tree DFS per group —
  // collapsed groups keep their header entry but skip their rows) — must
  // match render order below for keyboard traversal. `budgetOrdinal` counts
  // rows the way the progressive renderer consumes its budget (collapsed
  // groups still consume rows; collapsed parents' subtrees do not).
  const flatNavEntries = useMemo(() => {
    if (viewState.viewMode !== "list") return [] as TasksListNavEntry[];
    const out: TasksListNavEntry[] = [];
    let budgetCount = 0;
    for (const group of groupedContent) {
      const collapsed =
        Boolean(group.label) && viewState.collapsedGroups.includes(group.key);
      if (group.label) out.push({ type: "group", key: group.key, collapsed });
      const { roots, childMap } = viewState.nestingEnabled
        ? buildTaskTree(group.items)
        : { roots: group.items, childMap: new Map<string, Task[]>() };
      const walk = (task: Task) => {
        budgetCount += 1;
        const children = childMap.get(task.id) ?? [];
        const expanded = !viewState.collapsedParents.includes(task.id);
        if (!collapsed) {
          out.push({
            type: "task",
            task,
            hasChildren: children.length > 0,
            expanded,
            budgetOrdinal: budgetCount,
          });
        }
        if (expanded) for (const child of children) walk(child);
      };
      for (const root of roots) walk(root);
    }
    return out;
  }, [
    groupedContent,
    viewState.viewMode,
    viewState.collapsedGroups,
    viewState.collapsedParents,
    viewState.nestingEnabled,
  ]);

  const listNavStateRef = useRef({
    flatNavEntries,
    selectedNavKey,
    viewMode: viewState.viewMode,
    taskLinkState,
    collapsedGroups: viewState.collapsedGroups,
    collapsedParents: viewState.collapsedParents,
    updateView,
  });
  listNavStateRef.current = {
    flatNavEntries,
    selectedNavKey,
    viewMode: viewState.viewMode,
    taskLinkState,
    collapsedGroups: viewState.collapsedGroups,
    collapsedParents: viewState.collapsedParents,
    updateView,
  };

  const findSelectedNavElement = useCallback((navKey: string) => {
    if (navKey.startsWith("group:")) {
      const header = rootRef.current?.querySelector(
        `[data-tasks-group-key="${escapeAttrValue(navKey.slice("group:".length))}"]`,
      );
      return header instanceof HTMLElement ? header : null;
    }
    const row = rootRef.current?.querySelector(
      `[data-task-row-id="${escapeAttrValue(navKey.slice("task:".length))}"]`,
    );
    const link = row?.querySelector(":scope > [data-inbox-task-link]");
    return link instanceof HTMLElement ? link : null;
  }, []);

  useEffect(() => {
    if (!keyboardShortcutsEnabled) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const target = e.target;
      if (
        !(target instanceof HTMLElement) ||
        isKeyboardShortcutTextInputTarget(target) ||
        hasBlockingShortcutDialog(document) ||
        e.metaKey ||
        e.ctrlKey ||
        e.altKey
      ) {
        return;
      }
      const st = listNavStateRef.current;
      if (st.viewMode !== "list" || st.flatNavEntries.length === 0) return;
      // The row a keystroke acts on: the hovered row when the mouse moved since
      // the last key nav (so "hover a row → press Arrow/Enter" acts on it),
      // otherwise the keyboard selection. Hover no longer writes selection
      // state, so this threads the pointer position into every handler.
      const indexOfKey = (key: string | null) =>
        key
          ? st.flatNavEntries.findIndex(
              (entry) => tasksListNavEntryKey(entry) === key,
            )
          : -1;
      const hoveredIndex = indexOfKey(hoveredNavKeyRef.current);
      const fromHover = pointerMovedSinceKeyNavRef.current && hoveredIndex >= 0;
      const currentIndex = fromHover
        ? hoveredIndex
        : indexOfKey(st.selectedNavKey);
      switch (e.key) {
        case "j":
        case "ArrowDown":
        case "k":
        case "ArrowUp": {
          e.preventDefault();
          pointerMovedSinceKeyNavRef.current = false;
          const direction =
            e.key === "j" || e.key === "ArrowDown" ? "next" : "previous";
          const nextIndex = getInboxKeyboardSelectionIndex(
            currentIndex,
            st.flatNavEntries.length,
            direction,
          );
          const nextEntry = st.flatNavEntries[nextIndex];
          if (!nextEntry) break;
          setSelectedNavKey(tasksListNavEntryKey(nextEntry));
          // The list renders progressively; make sure the selected row is
          // within the render budget so the band mounts and can scroll into
          // view (the +1 keeps the next row visible as a scroll cue).
          if (nextEntry.type === "task") {
            setRenderedTaskRowLimit((current) =>
              Math.max(current, nextEntry.budgetOrdinal + 1),
            );
          }
          break;
        }
        case "ArrowLeft":
        case "ArrowRight": {
          // Groups and parent tasks collapse/expand with the same keys as the
          // inbox.
          const entry = st.flatNavEntries[currentIndex];
          if (!entry) return;
          const collapse = e.key === "ArrowLeft";
          if (entry.type === "group") {
            e.preventDefault();
            pointerMovedSinceKeyNavRef.current = false;
            setSelectedNavKey(tasksListNavEntryKey(entry));
            st.updateView({
              collapsedGroups: collapse
                ? st.collapsedGroups.includes(entry.key)
                  ? st.collapsedGroups
                  : [...st.collapsedGroups, entry.key]
                : st.collapsedGroups.filter((k) => k !== entry.key),
            });
            break;
          }
          if (!entry.hasChildren) return;
          e.preventDefault();
          pointerMovedSinceKeyNavRef.current = false;
          setSelectedNavKey(tasksListNavEntryKey(entry));
          st.updateView({
            collapsedParents: collapse
              ? st.collapsedParents.includes(entry.task.id)
                ? st.collapsedParents
                : [...st.collapsedParents, entry.task.id]
              : st.collapsedParents.filter((id) => id !== entry.task.id),
          });
          break;
        }
        case "Enter": {
          const entry = st.flatNavEntries[currentIndex];
          if (!entry || entry.type !== "task") return;
          e.preventDefault();
          // Navigate from the entry data (like the inbox) rather than the DOM
          // row — the selected row may sit past the mounted render batch.
          const task = entry.task;
          const pathId = task.identifier ?? task.id;
          const detailState = withTaskDetailHeaderSeed(
            st.taskLinkState,
            task,
          );
          rememberTaskDetailLocationState(pathId, detailState);
          navigate(createTaskDetailPath(pathId), { state: detailState });
          break;
        }
        default:
          return;
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [keyboardShortcutsEnabled, navigate]);

  // Keep the keyboard selection visible while navigating. Depends on the
  // render budget too: a selection past the mounted batch scrolls once its
  // row mounts.
  useEffect(() => {
    if (!selectedNavKey) return;
    findSelectedNavElement(selectedNavKey)?.scrollIntoView({
      block: "nearest",
    });
  }, [findSelectedNavElement, renderedTaskRowLimit, selectedNavKey]);

  useEffect(() => {
    if (viewState.viewMode !== "list") return;
    const nextTaskIds = filtered.map((task) => task.id).join("|");
    const previousTaskIds = renderedTaskIdsRef.current;
    if (nextTaskIds === previousTaskIds) return;
    renderedTaskIdsRef.current = nextTaskIds;

    setRenderedTaskRowLimit((current) => {
      const nextInitialLimit = Math.min(
        filtered.length,
        INITIAL_TASK_ROW_RENDER_LIMIT,
      );
      const listAppended =
        previousTaskIds.length > 0 &&
        nextTaskIds.startsWith(previousTaskIds) &&
        filtered.length >= current;
      if (listAppended)
        return Math.min(filtered.length, Math.max(current, nextInitialLimit));
      return nextInitialLimit;
    });
  }, [filtered, viewState.viewMode]);

  const hasMoreRenderedRows =
    viewState.viewMode === "list" && renderedTaskRowLimit < filtered.length;
  const remainingTaskRowCount = Math.max(
    filtered.length - renderedTaskRowLimit,
    0,
  );
  const loadMoreTaskRows = useCallback(() => {
    if (viewState.viewMode !== "list") return;
    if (hasMoreRenderedRows) {
      setRenderedTaskRowLimit((current) =>
        Math.min(filtered.length, current + TASK_ROW_RENDER_BATCH_SIZE),
      );
      return;
    }
    if (hasMoreTasks && !isLoadingMoreTasks) {
      onLoadMoreTasks?.();
    }
  }, [
    filtered.length,
    hasMoreTasks,
    hasMoreRenderedRows,
    isLoadingMoreTasks,
    onLoadMoreTasks,
    viewState.viewMode,
  ]);

  const canLoadMoreTasks =
    viewState.viewMode === "list" &&
    !isLoading &&
    (hasMoreRenderedRows || (hasMoreTasks && !isLoadingMoreTasks));

  useEffect(() => {
    if (!canLoadMoreTasks) return;
    let animationFrameId: number | null = null;
    const scrollContainer = findTasksScrollContainer(rootRef.current);
    const scrollTarget: Window | HTMLElement = scrollContainer ?? window;

    const checkScrollPosition = (
      trigger: "initial" | "scroll" | "resize" = "scroll",
    ) => {
      if (animationFrameId !== null) return;
      animationFrameId = window.requestAnimationFrame(() => {
        animationFrameId = null;
        const scrollHeight =
          scrollContainer?.scrollHeight ??
          document.documentElement.scrollHeight;
        if (scrollHeight === 0) return;
        const viewportHeight =
          scrollContainer?.clientHeight ?? window.innerHeight;
        const scrollBottom = scrollContainer
          ? scrollContainer.scrollTop + scrollContainer.clientHeight
          : window.scrollY + window.innerHeight;
        const hasScrollableOverflow = scrollHeight > viewportHeight + 1;
        const threshold = scrollHeight - TASK_SCROLL_LOAD_THRESHOLD_PX;
        if (scrollBottom >= threshold) {
          if (
            trigger === "initial" &&
            !hasMoreRenderedRows &&
            hasMoreTasks &&
            !hasScrollableOverflow
          ) {
            if (initialServerFillRequestedRef.current) return;
            initialServerFillRequestedRef.current = true;
          }
          loadMoreTaskRows();
        }
      });
    };

    const handleScroll = () => checkScrollPosition("scroll");
    const handleResize = () => checkScrollPosition("resize");
    scrollTarget.addEventListener("scroll", handleScroll, { passive: true });
    window.addEventListener("resize", handleResize);
    checkScrollPosition("initial");

    return () => {
      scrollTarget.removeEventListener("scroll", handleScroll);
      window.removeEventListener("resize", handleResize);
      if (animationFrameId !== null)
        window.cancelAnimationFrame(animationFrameId);
    };
  }, [
    canLoadMoreTasks,
    hasMoreTasks,
    hasMoreRenderedRows,
    loadMoreTaskRows,
  ]);

  const newTaskDefaults = useCallback(
    (group?: { key: string; items: Task[] }) => {
      const groupKey = group?.key;
      const defaults: Record<string, unknown> = {
        ...(baseCreateTaskDefaults ?? {}),
      };
      if (projectId && defaults.projectId === undefined)
        defaults.projectId = projectId;
      if (groupKey) {
        if (viewState.groupBy === "status") defaults.status = groupKey;
        else if (viewState.groupBy === "priority") defaults.priority = groupKey;
        else if (
          viewState.groupBy === "owner" &&
          groupKey !== "__board" &&
          !groupKey.startsWith("__user:")
        ) {
          defaults.ownerAgentId = groupKey;
        } else if (
          viewState.groupBy === "project" &&
          groupKey !== "__no_project"
        )
          defaults.projectId = groupKey;
        else if (
          viewState.groupBy === "parent" &&
          groupKey !== "__no_parent"
        ) {
          const parentTask = taskById.get(groupKey);
          if (parentTask)
            Object.assign(
              defaults,
              buildSubTaskDefaultsForViewer(parentTask),
            );
          else defaults.parentId = groupKey;
        }
      }
      return defaults;
    },
    [
      baseCreateTaskDefaults,
      taskById,
      projectId,
      viewState.groupBy,
    ],
  );

  const createActionLabel = createTaskLabel
    ? `Create ${createTaskLabel}`
    : "Create Task";
  const createButtonLabel = createTaskLabel
    ? `New ${createTaskLabel}`
    : "New Task";
  const openCreateTaskDialog = useCallback(
    (group?: { key: string; items: Task[] }) => {
      openNewTask(newTaskDefaults(group));
    },
    [newTaskDefaults, openNewTask],
  );

  const setTaskColumns = useCallback(
    (next: InboxTaskColumn[]) => {
      const normalized = normalizeInboxTaskColumns(next);
      setVisibleTaskColumns(normalized);
      saveTaskColumns(scopedKey, normalized);
    },
    [scopedKey],
  );

  const toggleTaskColumn = useCallback(
    (column: InboxTaskColumn, enabled: boolean) => {
      if (enabled) {
        setTaskColumns([...visibleTaskColumns, column]);
        return;
      }
      setTaskColumns(visibleTaskColumns.filter((value) => value !== column));
    },
    [setTaskColumns, visibleTaskColumns],
  );

  let remainingRowsToRender =
    viewState.viewMode === "list"
      ? renderedTaskRowLimit
      : Number.POSITIVE_INFINITY;

  return (
    <div ref={rootRef} className="space-y-4">
      {isLoading || isLoadingMoreTasks ? (
        <p className="sr-only" role="status">
          {isLoading ? "Loading tasks." : "Loading more tasks."}
        </p>
      ) : null}
      {progressSummary ? (
        <SubTaskProgressSummaryStrip
          summary={progressSummary}
          taskLinkState={taskLinkState}
          parentTaskIdForCostSummary={parentTaskIdForCostSummary}
        />
      ) : null}

      {/* Toolbar */}
      <div className="flex items-center justify-between gap-2 sm:gap-3">
        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          <Button
            size="sm"
            variant="outline"
            onClick={() => openCreateTaskDialog()}
          >
            <Plus className="h-4 w-4 sm:mr-1" />
            <span className="hidden sm:inline">{createButtonLabel}</span>
          </Button>
          <TaskSearchInput
            value={taskSearch}
            onDebouncedChange={(nextSearch) => {
              setTaskSearch(nextSearch);
              onSearchChange?.(nextSearch);
            }}
          />
        </div>

        <div className="flex items-center gap-0.5 sm:gap-1 shrink-0">
          {/* View mode toggle */}
          <div
            className="flex items-center border border-border rounded-md overflow-hidden mr-1"
            role="group"
            aria-label="View mode"
          >
            <button
              className={`flex h-8 w-8 items-center justify-center transition-colors ${viewState.viewMode === "list" ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"}`}
              onClick={() => updateView({ viewMode: "list" })}
              title="List view"
              aria-label="List view"
              aria-pressed={viewState.viewMode === "list"}
            >
              <List className="h-3.5 w-3.5" />
            </button>
            <button
              className={`flex h-8 w-8 items-center justify-center transition-colors ${viewState.viewMode === "board" ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"}`}
              onClick={() => updateView({ viewMode: "board" })}
              title="Board view"
              aria-label="Board view"
              aria-pressed={viewState.viewMode === "board"}
            >
              <SquareKanban className="h-3.5 w-3.5" />
            </button>
          </div>

          {viewState.viewMode === "list" && (
            <Button
              type="button"
              variant="outline"
              size="icon"
              className={cn(
                "hidden h-8 w-8 shrink-0 sm:inline-flex",
                viewState.nestingEnabled && "bg-accent",
              )}
              onClick={() =>
                updateView({ nestingEnabled: !viewState.nestingEnabled })
              }
              title={
                viewState.nestingEnabled
                  ? "Disable parent-child nesting"
                  : "Enable parent-child nesting"
              }
            >
              <ListTree className="h-3.5 w-3.5" />
            </Button>
          )}

          {viewState.viewMode === "board" && (
            <>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className={cn(
                  "h-8 w-8 shrink-0",
                  boardCompactCards && "bg-accent",
                )}
                onClick={() =>
                  updateView({
                    boardCardDensity: boardCompactCards
                      ? "comfortable"
                      : "compact",
                  })
                }
                title={
                  boardCompactCards
                    ? "Use comfortable cards"
                    : "Use compact cards"
                }
              >
                <ChevronsDownUp className="h-3.5 w-3.5" />
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className={cn(
                  "h-8 w-8 shrink-0",
                  boardCollapsedStatuses.length > 0 && "bg-accent",
                )}
                onClick={() =>
                  updateView({
                    boardColdLaneMode:
                      boardCollapsedStatuses.length > 0
                        ? "expanded"
                        : "collapsed",
                  })
                }
                title={
                  boardCollapsedStatuses.length > 0
                    ? "Expand cold lanes"
                    : "Collapse cold lanes"
                }
              >
                <PanelTopClose className="h-3.5 w-3.5" />
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className={cn(
                      "h-8 shrink-0 gap-1.5 px-2",
                      viewState.boardColumnPageSize !==
                        KANBAN_COLUMN_DEFAULT_PAGE_SIZE && "bg-accent",
                    )}
                    title="Cards per column"
                  >
                    <ListCollapse className="h-3.5 w-3.5" />
                    <span className="min-w-4 text-xs tabular-nums">
                      {viewState.boardColumnPageSize}
                    </span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuRadioGroup
                    value={String(viewState.boardColumnPageSize)}
                    onValueChange={(v) =>
                      updateView({ boardColumnPageSize: Number(v) as 10 | 25 | 50 })
                    }
                  >
                    {KANBAN_COLUMN_PAGE_SIZE_OPTIONS.map((pageSize) => (
                      <DropdownMenuRadioItem
                        key={pageSize}
                        value={String(pageSize)}
                        className="text-sm"
                      >
                        {pageSize} per column
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="h-8 w-8 shrink-0"
                onClick={() =>
                  updateView({
                    boardCardDensity: "auto",
                    boardColdLaneMode: "expanded",
                    boardColumnPageSize: KANBAN_COLUMN_DEFAULT_PAGE_SIZE,
                  })
                }
                disabled={!boardDensityCustomized}
                title="Reset board density"
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </Button>
            </>
          )}

          <TaskColumnPicker
            availableColumns={availableTaskColumns}
            visibleColumnSet={visibleTaskColumnSet}
            onToggleColumn={toggleTaskColumn}
            onResetColumns={() => setTaskColumns(DEFAULT_INBOX_TASK_COLUMNS)}
            title="Choose which task columns stay visible"
            iconOnly
          />

          <TaskFiltersPopover
            state={viewState}
            onChange={updateView}
            buttonVariant="outline"
            activeFilterCount={activeFilterCount}
            agents={agents}
            creators={creatorOptions}
            projects={projects?.map((project) => ({
              id: project.id,
              name: project.name,
            }))}
            labels={labels?.map((label) => ({
              id: label.id,
              name: label.name,
              color: label.color,
            }))}
            currentUserId={currentUserId}
            enableRoutineVisibilityFilter={enableRoutineVisibilityFilter}
            iconOnly
          />

          {/* Sort (list view only) */}
          {viewState.viewMode === "list" && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-8 w-8 shrink-0"
                  title="Sort"
                >
                  <ArrowUpDown className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                {(
                  [
                    ["workflow", "Workflow"],
                    ["status", "Status"],
                    ["priority", "Priority"],
                    ["title", "Title"],
                    ["created", "Created"],
                    ["updated", "Updated"],
                  ] as const
                ).map(([field, label]) => (
                  <DropdownMenuItem
                    key={field}
                    className="text-sm"
                    onClick={() => {
                      if (viewState.sortField === field) {
                        updateView({
                          sortDir:
                            viewState.sortDir === "asc" ? "desc" : "asc",
                        });
                      } else {
                        updateView({ sortField: field, sortDir: "asc" });
                      }
                    }}
                  >
                    <span>{label}</span>
                    {viewState.sortField === field && (
                      <span className="ml-auto text-xs text-muted-foreground">
                        {viewState.sortDir === "asc" ? "\u2191" : "\u2193"}
                      </span>
                    )}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {/* Group (list view only) */}
          {viewState.viewMode === "list" && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-8 w-8 shrink-0"
                  title="Group"
                >
                  <Layers className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuRadioGroup
                  value={viewState.groupBy ?? "none"}
                  onValueChange={(v) => updateView({ groupBy: (v === "none" ? undefined : v) as TaskViewState["groupBy"] })}
                >
                  {(
                    [
                      ["status", "Status"],
                      ["priority", "Priority"],
                      ["owner", "Owner"],
                      ["project", "Project"],
                      ["parent", "Parent Task"],
                      ["none", "None"],
                    ] as const
                  ).map(([value, label]) => (
                    <DropdownMenuRadioItem key={value} value={value} className="text-sm">
                      {label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      {isLoading && (
        <PageSkeleton variant="tasks-list" />
      )}
      {error && <p className="text-sm text-destructive" role="alert">{error.message}</p>}
      {!searchWithinLoadedTasks &&
        normalizedTaskSearch.length > 0 &&
        searchedTasks.length === TASK_SEARCH_RESULT_LIMIT && (
          <p className="text-xs text-muted-foreground">
            Showing up to {TASK_SEARCH_RESULT_LIMIT} matches. Refine the search
            to narrow further.
          </p>
        )}
      {boardColumnLimitReached && (
        <p className="text-xs text-muted-foreground">
          Some board columns are showing up to {TASK_BOARD_COLUMN_RESULT_LIMIT}{" "}
          tasks. Refine filters or search to reveal the rest.
        </p>
      )}
      {!isLoading &&
        filtered.length === 0 &&
        viewState.viewMode === "list" && (
          <EmptyState
            icon={CircleDot}
            message="No tasks match the current filters or search."
            action={createActionLabel}
            onAction={() => openCreateTaskDialog()}
          />
        )}

      {viewState.viewMode === "board" ? (
        <KanbanBoard
          tasks={filtered}
          agents={agents}
          liveTaskIds={liveTaskIds}
          compactCards={boardCompactCards}
          collapsedStatuses={boardCollapsedStatuses}
          initialVisibleCount={viewState.boardColumnPageSize}
          revealIncrement={viewState.boardColumnPageSize}
        />
      ) : (
        <>
          {groupedContent.map((group) => {
            if (remainingRowsToRender <= 0) return null;
            return (
              <Collapsible
                key={group.key}
                open={!viewState.collapsedGroups.includes(group.key)}
                onOpenChange={(open) => {
                  updateView({
                    collapsedGroups: open
                      ? viewState.collapsedGroups.filter((k) => k !== group.key)
                      : [...viewState.collapsedGroups, group.key],
                  });
                }}
              >
                {group.label && (
                  // Left inset aligns the header chevron with the nested task
                  // chevrons: tasks-list rows sit at pl-1 before their chevron
                  // (no unread column), so the band adds no extra left inset.
                  <div
                    data-tasks-group-key={group.key}
                    className={cn(
                      "rounded-lg px-3 sm:pl-0 sm:pr-4",
                      selectedNavKey === `group:${group.key}`
                        ? "bg-accent/50"
                        : "hover:bg-accent/50",
                    )}
                    onMouseEnter={() =>
                      setNavSelectionFromPointer(`group:${group.key}`)
                    }
                  >
                    <TaskGroupHeader
                      label={group.label}
                      collapsible
                      collapsed={viewState.collapsedGroups.includes(group.key)}
                      onToggle={() => {
                        updateView({
                          collapsedGroups: viewState.collapsedGroups.includes(
                            group.key,
                          )
                            ? viewState.collapsedGroups.filter(
                                (k) => k !== group.key,
                              )
                            : [...viewState.collapsedGroups, group.key],
                        });
                      }}
                      trailing={
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          className="-mr-2 text-muted-foreground"
                          title={`New task in ${group.label}`}
                          aria-label={`New task in ${group.label}`}
                          onClick={() => openCreateTaskDialog(group)}
                        >
                          <Plus className="h-3 w-3" />
                        </Button>
                      }
                    />
                  </div>
                )}
                <CollapsibleContent>
                  {(() => {
                    const { roots, childMap } = viewState.nestingEnabled
                      ? buildTaskTree(group.items)
                      : {
                          roots: group.items,
                          childMap: new Map<string, Task[]>(),
                        };

                    const renderTaskRow = (task: Task, depth: number) => {
                      if (remainingRowsToRender <= 0) return null;
                      remainingRowsToRender -= 1;

                      const children = childMap.get(task.id) ?? [];
                      const hasChildren = children.length > 0;
                      const totalDescendants = hasChildren
                        ? countDescendants(task.id, childMap)
                        : 0;
                      const isExpanded = !viewState.collapsedParents.includes(
                        task.id,
                      );
                      const useDeferredRowRendering = !(
                        hasChildren && isExpanded
                      );
                      const taskProject = task.projectId
                        ? (projectById.get(task.projectId) ?? null)
                        : null;
                      const parentTask = task.parentId
                        ? (taskById.get(task.parentId) ?? null)
                        : null;
                      const taskBadge = taskBadgeById?.get(task.id);
                      const isMutedTask =
                        mutedTaskIds?.has(task.id) === true;
                      const ownerUserProfile = task.ownerUserId
                        ? (companyUserProfileMap.get(task.ownerUserId) ?? null)
                        : null;
                      const ownerUserLabel =
                        formatOwnerUserLabel(
                          task.ownerUserId,
                          currentUserId,
                          companyUserLabelMap,
                        ) ??
                        ownerUserProfile?.label ??
                        null;
                      const originatingActor = deriveOriginatingActor(task);
                      const originatingAgentId =
                        originatingActor?.kind === "agent"
                          ? originatingActor.id
                          : null;
                      const originatingUserId =
                        originatingActor?.kind === "user"
                          ? originatingActor.id
                          : null;
                      const originatingViaAgentId =
                        originatingActor?.kind === "user"
                          ? (originatingActor.viaAgentId ?? null)
                          : null;
                      const toggleCollapse = (e: {
                        preventDefault: () => void;
                        stopPropagation: () => void;
                      }) => {
                        e.preventDefault();
                        e.stopPropagation();
                        updateView({
                          collapsedParents: isExpanded
                            ? [...viewState.collapsedParents, task.id]
                            : viewState.collapsedParents.filter(
                                (id) => id !== task.id,
                              ),
                        });
                      };
                      const checklistMeta = workflowChecklistMeta;
                      const checklistStepNumber =
                        checklistMeta?.stepNumberByTaskId.get(task.id) ??
                        null;
                      const unresolvedVisibleBlockers =
                        checklistMeta?.unresolvedVisibleBlockersByTaskId.get(
                          task.id,
                        ) ?? [];
                      const checklistRowId = checklistMeta
                        ? `task-workflow-row-${task.id}`
                        : undefined;
                      const doneRowTitleClass =
                        checklistMeta &&
                        task.boardPresentationStatus === "done"
                          ? "text-muted-foreground"
                          : undefined;
                      const visibleBlockerChips = unresolvedVisibleBlockers
                        .map((blockerId) => {
                          const blockerTask = taskById.get(blockerId);
                          if (!blockerTask) return null;
                          const label =
                            blockerTask.identifier ??
                            blockerTask.id.slice(0, 8);
                          const blockerStep =
                            checklistMeta?.stepNumberByTaskId.get(blockerId);
                          const blockerStepSuffix = blockerStep
                            ? ` \u00b7 step ${blockerStep}`
                            : "";
                          return {
                            blockerId,
                            chipLabel: `blocked by ${label}${blockerStepSuffix}`,
                          };
                        })
                        .filter(
                          (
                            chip,
                          ): chip is { blockerId: string; chipLabel: string } =>
                            chip !== null,
                        );
                      const firstVisibleBlockerChip =
                        visibleBlockerChips[0] ?? null;
                      const additionalVisibleBlockerCount = Math.max(
                        visibleBlockerChips.length - 1,
                        0,
                      );
                      const additionalVisibleBlockerLabel =
                        additionalVisibleBlockerCount > 0
                          ? ` ... and ${additionalVisibleBlockerCount} more`
                          : "";
                      const firstVisibleBlockerDisplayLabel =
                        firstVisibleBlockerChip
                          ? `${firstVisibleBlockerChip.chipLabel}${additionalVisibleBlockerLabel}`
                          : "";
                      const hiddenVisibleBlockerLabels = visibleBlockerChips
                        .slice(1)
                        .map((chip) => chip.chipLabel)
                        .join(", ");
                      const firstVisibleBlockerTitle =
                        additionalVisibleBlockerCount > 0
                          ? `${firstVisibleBlockerDisplayLabel}: ${hiddenVisibleBlockerLabels}`
                          : firstVisibleBlockerDisplayLabel;
                      const checklistDependencyChips =
                        checklistMeta && firstVisibleBlockerChip ? (
                          <button
                            key={firstVisibleBlockerChip.blockerId}
                            type="button"
                            data-slot="icon-button"
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              const target = document.getElementById(
                                `task-workflow-row-${firstVisibleBlockerChip.blockerId}`,
                              );
                              if (!target) return;
                              target.scrollIntoView({
                                behavior: "smooth",
                                block: "nearest",
                              });
                              target.focus?.();
                            }}
                            className="inline-flex items-center rounded-full border border-amber-400/45 bg-amber-50/60 px-1.5 py-0.5 text-(length:--text-nano) font-medium text-amber-700 hover:bg-amber-100/80 dark:border-amber-300/35 dark:bg-amber-400/10 dark:text-amber-300"
                            title={firstVisibleBlockerTitle}
                            aria-label={firstVisibleBlockerTitle}
                          >
                            {firstVisibleBlockerDisplayLabel}
                          </button>
                        ) : null;

                      return (
                        <div
                          key={task.id}
                          data-task-row-id={task.id}
                          // Desktop indentation comes from TaskRow's treeGuides
                          // (vertical connector slots); mobile keeps a plain
                          // padding indent (guides are sm-only).
                          className={
                            depth > 0
                              ? MOBILE_TREE_INDENT[
                                  Math.min(depth, MOBILE_TREE_INDENT.length - 1)
                                ]
                              : undefined
                          }
                          style={
                            useDeferredRowRendering
                              ? {
                                  contentVisibility: "auto",
                                  containIntrinsicSize: "44px",
                                }
                              : undefined
                          }
                        >
                          <TaskRow
                            task={task}
                            taskLinkState={taskLinkState}
                            selected={selectedNavKey === `task:${task.id}`}
                            onMouseEnter={() =>
                              setNavSelectionFromPointer(`task:${task.id}`)
                            }
                            treeGuides={depth}
                            chevronInGuide={depth > 0 && hasChildren}
                            hideDivider={hasChildren && isExpanded}
                            checklistStepNumber={checklistStepNumber}
                            checklistCurrentStep={
                              checklistMeta?.currentStepTaskId === task.id
                            }
                            checklistDependencyChips={checklistDependencyChips}
                            checklistRowId={checklistRowId}
                            titleClassName={doneRowTitleClass}
                            titleSuffix={
                              <>
                                {hasChildren && !isExpanded ? (
                                  <span className="ml-1.5 text-xs text-muted-foreground">
                                    ({totalDescendants} sub-task
                                    {totalDescendants !== 1 ? "s" : ""})
                                  </span>
                                ) : null}
                                {taskBadge ? (
                                  taskBadge === "Paused" ? (
                                    <Badge
                                      variant="ghost"
                                      className={cn(
                                        "ml-1.5 px-1.5 text-(length:--text-nano)",
                                        statusBadge.paused,
                                      )}
                                      aria-label="Paused"
                                      title="Paused"
                                    >
                                      <CircleSlash2 className="h-3 w-3" />
                                      Paused
                                    </Badge>
                                  ) : (
                                    <Badge
                                      variant="outline"
                                      className="ml-1.5 border-amber-500/40 bg-amber-500/10 px-1.5 text-(length:--text-nano) text-amber-700 dark:text-amber-300"
                                    >
                                      {taskBadge}
                                    </Badge>
                                  )
                                ) : null}
                              </>
                            }
                            className={cn(
                              isMutedTask && "opacity-70",
                              selectedNavKey === `task:${task.id}` &&
                                "bg-accent/50 hover:bg-accent/50",
                            )}
                            mobileLeading={
                              hasChildren ? (
                                <button
                                  type="button"
                                  data-slot="icon-button"
                                  aria-label={`${isExpanded ? "Collapse" : "Expand"} sub-tasks for ${task.title}`}
                                  aria-expanded={isExpanded}
                                  onClick={toggleCollapse}
                                >
                                  <ChevronRight
                                    className={cn(
                                      "h-3.5 w-3.5 transition-transform",
                                      isExpanded && "rotate-90",
                                    )}
                                  />
                                </button>
                              ) : (
                                <span
                                  className="inline-flex items-center"
                                  onClickCapture={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                  }}
                                >
                                  <StatusIcon
                                    status={task.boardPresentationStatus}
                                    size="md"
                                    blockerAttention={task.blockerAttention}
                                  />
                                </span>
                              )
                            }
                            desktopMetaLeading={
                              <>
                                {hasChildren ? (
                                  <button
                                    type="button"
                                    data-slot="icon-button"
                                    className="relative z-10 hidden w-4 shrink-0 items-center justify-center sm:inline-flex"
                                    aria-label={`${isExpanded ? "Collapse" : "Expand"} sub-tasks for ${task.title}`}
                                    aria-expanded={isExpanded}
                                    onClick={toggleCollapse}
                                  >
                                    <ChevronRight
                                      className={cn(
                                        "h-3.5 w-3.5 transition-transform",
                                        isExpanded && "rotate-90",
                                      )}
                                    />
                                  </button>
                                ) : (
                                  <span className="hidden w-4 shrink-0 sm:block" />
                                )}
                                <InboxTaskMetaLeading
                                  task={task}
                                  isLive={liveTaskIds?.has(task.id) === true}
                                  subtreeLiveCount={
                                    subtreeLiveCounts.get(task.id) ?? 0
                                  }
                                  showStatus={
                                    visibleTaskColumnSet.has("status") &&
                                    availableTaskColumnSet.has("status")
                                  }
                                  showIdentifier={
                                    visibleTaskColumnSet.has("id") &&
                                    availableTaskColumnSet.has("id")
                                  }
                                  checklistStepNumber={checklistStepNumber}
                                  statusSlot={
                                    <span
                                      className="inline-flex items-center"
                                      onClickCapture={(e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                      }}
                                    >
                                      <StatusIcon
                                        status={task.boardPresentationStatus}
                                        size="md"
                                        blockerAttention={
                                          task.blockerAttention
                                        }
                                      />
                                    </span>
                                  }
                                />
                              </>
                            }
                            mobileMeta={taskActivityText(task).toLowerCase()}
                            desktopTrailing={
                              visibleTrailingTaskColumns.length > 0 ? (
                                <InboxTaskTrailingColumns
                                  task={task}
                                  columns={visibleTrailingTaskColumns}
                                  projectName={taskProject?.name ?? null}
                                  projectColor={taskProject?.color ?? null}
                                  ownerName={agentName(task.ownerAgentId)}
                                  ownerUserName={ownerUserLabel}
                                  ownerUserAvatarUrl={
                                    ownerUserProfile?.image ?? null
                                  }
                                  originatingAgentName={agentName(
                                    originatingAgentId,
                                  )}
                                  creatorUserName={
                                    originatingUserId
                                      ? (companyUserProfileMap.get(
                                          originatingUserId,
                                        )?.label ?? null)
                                      : null
                                  }
                                  creatorUserAvatarUrl={
                                    originatingUserId
                                      ? (companyUserProfileMap.get(
                                          originatingUserId,
                                        )?.image ?? null)
                                      : null
                                  }
                                  viaAgentName={
                                    originatingViaAgentId
                                      ? agentName(originatingViaAgentId)
                                      : null
                                  }
                                  currentUserId={currentUserId}
                                  parentIdentifier={
                                    parentTask?.identifier ?? null
                                  }
                                  parentTitle={parentTask?.title ?? null}
                                  ownerContent={
                                    <div className="flex w-full shrink-0 items-center overflow-hidden px-2 py-1">
                                      {task.ownerAgentId &&
                                      agentName(task.ownerAgentId) ? (
                                        <Identity
                                          name={agentName(task.ownerAgentId)!}
                                          size="sm"
                                          className="min-w-0"
                                        />
                                      ) : task.ownerUserId ? (
                                        <Identity
                                          name={ownerUserLabel ?? "User"}
                                          avatarUrl={
                                            ownerUserProfile?.image ?? null
                                          }
                                          size="sm"
                                          className="min-w-0"
                                        />
                                      ) : (
                                        <span className="text-xs text-muted-foreground">
                                          Board escalation
                                        </span>
                                      )}
                                    </div>
                                  }
                                />
                              ) : undefined
                            }
                          />
                          {hasChildren &&
                            isExpanded &&
                            children.map((child) =>
                              renderTaskRow(child, depth + 1),
                            )}
                        </div>
                      );
                    };

                    return roots
                      .map((task) => renderTaskRow(task, 0))
                      .filter((node) => node !== null);
                  })()}
                </CollapsibleContent>
              </Collapsible>
            );
          })}
          {(remainingTaskRowCount > 0 ||
            hasMoreTasks ||
            isLoadingMoreTasks) && (
            <div className="py-2" data-testid="tasks-load-more-sentinel">
              <p className="text-xs text-muted-foreground">
                {isLoadingMoreTasks
                  ? "Loading more tasks..."
                  : remainingTaskRowCount > 0
                    ? `Rendering ${Math.min(renderedTaskRowLimit, filtered.length)} of ${filtered.length} tasks`
                    : "Scroll to load more tasks"}
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
