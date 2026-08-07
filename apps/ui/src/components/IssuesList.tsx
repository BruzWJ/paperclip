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
import { issuesApi } from "../api/issues";
import { authApi } from "../api/auth";
import { queryKeys } from "../lib/queryKeys";
import {
  shouldBlurPageSearchOnEnter,
  shouldBlurPageSearchOnEscape,
} from "../lib/keyboardShortcuts";
import { formatOwnerUserLabel } from "../lib/issue-owners";
import {
  buildCompanyUserLabelMap,
  buildCompanyUserProfileMap,
} from "../lib/company-members";
import {
  createIssueDetailPath,
  rememberIssueDetailLocationState,
  withIssueDetailHeaderSeed,
} from "../lib/issueDetailBreadcrumb";
import {
  buildSubIssueProgressSummary,
  shouldRenderSubIssueProgressSummary,
  type SubIssueProgressSummary,
} from "../lib/issue-detail-subissues";
import { groupBy } from "../lib/groupBy";
import {
  applyIssueFilters,
  countActiveIssueFilters,
  defaultIssueFilterState,
  issueFilterLabel,
  issuePriorityOrder,
  normalizeIssueFilterState,
  issueStatusOrder,
  type IssueFilterState,
} from "../lib/issue-filters";
import {
  DEFAULT_INBOX_ISSUE_COLUMNS,
  inboxIssueColumns,
  normalizeInboxIssueColumns,
  type InboxIssueColumn,
} from "../lib/inbox";
import { cn, formatDurationMs, formatMoneyAmount } from "../lib/utils";
import { collectSubtreeLiveCounts } from "../lib/liveIssueIds";
import { issueDisplayTitle } from "../lib/issue-display";
import {
  InboxIssueMetaLeading,
  InboxIssueTrailingColumns,
  IssueColumnPicker,
  issueActivityText,
  issueTrailingColumns,
} from "./IssueColumns";
import { StatusIcon } from "./StatusIcon";
import { EmptyState } from "./EmptyState";
import { Identity } from "./Identity";
import { IssueGroupHeader } from "./IssueGroupHeader";
import { IssueFiltersPopover } from "./IssueFiltersPopover";
import { IssueRow } from "./IssueRow";
import { PageSkeleton } from "./PageSkeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import {
  CircleDot,
  Plus,
  ArrowUpDown,
  Layers,
  Check,
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
import { buildIssueTree, countDescendants } from "../lib/issue-tree";
import { getInboxKeyboardSelectionIndex } from "../lib/inbox";
import {
  hasBlockingShortcutDialog,
  isKeyboardShortcutTextInputTarget,
} from "../lib/keyboardShortcuts";
import { useGeneralSettings } from "../context/GeneralSettingsContext";
import { buildSubIssueDefaultsForViewer } from "../lib/subIssueDefaults";
import { statusBadge } from "../lib/status-colors";
import { workflowSort } from "../lib/workflow-sort";
import {
  deriveOriginatingActor,
  ISSUE_STATUSES,
  type Issue,
  type IssueStatus,
  type Project,
} from "@paperclipai/shared";
import { Badge } from "@/components/ui/badge";
const ISSUE_SEARCH_DEBOUNCE_MS = 250;
const ISSUE_SEARCH_RESULT_LIMIT = 200;
const ISSUE_BOARD_COLUMN_RESULT_LIMIT = 200;
type IssuesListNavEntry =
  | { type: "group"; key: string; collapsed: boolean }
  | {
      type: "issue";
      issue: Issue;
      hasChildren: boolean;
      expanded: boolean;
      budgetOrdinal: number;
    };

function issuesListNavEntryKey(entry: IssuesListNavEntry): string {
  return entry.type === "group"
    ? `group:${entry.key}`
    : `issue:${entry.issue.id}`;
}

// CSS.escape is missing in some non-browser environments (jsdom tests).
function escapeAttrValue(value: string): string {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function"
    ? CSS.escape(value)
    : value.replace(/["\\]/g, "\\$&");
}

const INITIAL_ISSUE_ROW_RENDER_LIMIT = 100;
const ISSUE_ROW_RENDER_BATCH_SIZE = 150;
const ISSUE_SCROLL_LOAD_THRESHOLD_PX = 320;

function findIssuesScrollContainer(
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
const boardIssueStatuses = ISSUE_STATUSES;
const issueStatusLabels: Record<IssueStatus, string> = {
  backlog: "Backlog",
  todo: "Todo",
  in_progress: "In progress",
  in_review: "In review",
  done: "Done",
  blocked: "Blocked",
  cancelled: "Cancelled",
};
const progressSegmentClasses: Record<IssueStatus, string> = {
  backlog: "bg-muted-foreground/40",
  todo: "bg-blue-500",
  in_progress: "bg-yellow-500",
  in_review: "bg-violet-500",
  done: "bg-green-500",
  blocked: "bg-red-500",
  cancelled: "bg-neutral-400",
};

/* ── View state ── */

export type IssueSortField =
  "status" | "priority" | "title" | "created" | "updated" | "workflow";
export type BoardCardDensity = "auto" | "compact" | "comfortable";
export type BoardColdLaneMode = "auto" | "collapsed" | "expanded";
export type BoardColumnPageSize = KanbanColumnPageSize;

export type IssueViewState = IssueFilterState & {
  sortField: IssueSortField;
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

const defaultViewState: IssueViewState = {
  ...defaultIssueFilterState,
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

function getViewState(key: string): IssueViewState {
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        ...defaultViewState,
        ...parsed,
        ...normalizeIssueFilterState(parsed),
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

function saveViewState(key: string, state: IssueViewState) {
  localStorage.setItem(key, JSON.stringify(state));
}

function getInitialViewState(
  key: string,
  initialOwners?: string[],
  defaultSortField?: IssueSortField,
): IssueViewState {
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

function getIssueColumnsStorageKey(key: string): string {
  return `${key}:issue-columns`;
}

function loadIssueColumns(key: string): InboxIssueColumn[] {
  try {
    const raw = localStorage.getItem(getIssueColumnsStorageKey(key));
    if (raw === null) return DEFAULT_INBOX_ISSUE_COLUMNS;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_INBOX_ISSUE_COLUMNS;
    return normalizeInboxIssueColumns(parsed);
  } catch {
    return DEFAULT_INBOX_ISSUE_COLUMNS;
  }
}

function saveIssueColumns(key: string, columns: InboxIssueColumn[]) {
  try {
    localStorage.setItem(
      getIssueColumnsStorageKey(key),
      JSON.stringify(normalizeInboxIssueColumns(columns)),
    );
  } catch {
    // Ignore localStorage failures.
  }
}

function sortIssues(issues: Issue[], state: IssueViewState): Issue[] {
  if (state.sortField === "workflow") {
    const ordered = workflowSort(issues);
    return state.sortDir === "desc" ? [...ordered].reverse() : ordered;
  }
  const sorted = [...issues];
  const dir = state.sortDir === "asc" ? 1 : -1;
  sorted.sort((a, b) => {
    switch (state.sortField) {
      case "status":
        return (
          dir *
          (issueStatusOrder.indexOf(a.boardPresentationStatus) -
            issueStatusOrder.indexOf(b.boardPresentationStatus))
        );
      case "priority":
        return (
          dir *
          (issuePriorityOrder.indexOf(a.priority) -
            issuePriorityOrder.indexOf(b.priority))
        );
      case "title":
        return dir * issueDisplayTitle(a).localeCompare(issueDisplayTitle(b));
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

function issueMatchesLocalSearch(
  issue: Issue,
  normalizedSearch: string,
): boolean {
  if (!normalizedSearch) return true;
  return [issue.identifier, issue.title, issue.request].some((value) =>
    value?.toLowerCase().includes(normalizedSearch),
  );
}

function isActionableWorkflowStatus(status: IssueStatus): boolean {
  return status !== "done" && status !== "cancelled" && status !== "blocked";
}

function buildChecklistStepNumberMap(
  issues: Issue[],
  nestingEnabled: boolean,
): Map<string, string> {
  const stepNumberByIssueId = new Map<string, string>();

  if (!nestingEnabled) {
    issues.forEach((issue, index) => {
      stepNumberByIssueId.set(issue.id, String(index + 1));
    });
    return stepNumberByIssueId;
  }

  const { roots, childMap } = buildIssueTree(issues);
  const visit = (siblings: Issue[], prefix: string | null) => {
    siblings.forEach((issue, index) => {
      const stepNumber = prefix ? `${prefix}.${index + 1}` : String(index + 1);
      stepNumberByIssueId.set(issue.id, stepNumber);
      visit(childMap.get(issue.id) ?? [], stepNumber);
    });
  };
  visit(roots, null);

  issues.forEach((issue, index) => {
    if (!stepNumberByIssueId.has(issue.id)) {
      stepNumberByIssueId.set(issue.id, String(index + 1));
    }
  });

  return stepNumberByIssueId;
}

function buildPreviousSiblingIssueIdMap(
  issues: Issue[],
  nestingEnabled: boolean,
): Map<string, string> {
  const previousSiblingByIssueId = new Map<string, string>();

  if (!nestingEnabled) {
    const previousByParentId = new Map<string, Issue>();
    for (const issue of issues) {
      if (!issue.parentId) continue;
      const previousSibling = previousByParentId.get(issue.parentId);
      if (previousSibling) {
        previousSiblingByIssueId.set(issue.id, previousSibling.id);
      }
      previousByParentId.set(issue.parentId, issue);
    }
    return previousSiblingByIssueId;
  }

  const { roots, childMap } = buildIssueTree(issues);
  const visit = (siblings: Issue[]) => {
    siblings.forEach((issue, index) => {
      const previousSibling = index > 0 ? siblings[index - 1] : null;
      if (issue.parentId && previousSibling?.parentId === issue.parentId) {
        previousSiblingByIssueId.set(issue.id, previousSibling.id);
      }
      visit(childMap.get(issue.id) ?? []);
    });
  };
  visit(roots);

  return previousSiblingByIssueId;
}

function shouldSuppressSinglePreviousSiblingBlockerChip(
  issue: Issue,
  unresolvedVisibleBlockerIds: string[],
  previousSiblingIssueId: string | undefined,
): boolean {
  return Boolean(
    issue.parentId &&
    previousSiblingIssueId &&
    (issue.blockedBy ?? []).length === 1 &&
    unresolvedVisibleBlockerIds.length === 1 &&
    unresolvedVisibleBlockerIds[0] === previousSiblingIssueId,
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
type IssueListRequestFilters = NonNullable<
  Parameters<typeof issuesApi.list>[1]
>;

interface IssuesListProps {
  issues: Issue[];
  isLoading?: boolean;
  error?: Error | null;
  agents?: Agent[];
  projects?: ProjectOption[];
  liveIssueIds?: Set<string>;
  projectId?: string;
  viewStateKey: string;
  issueLinkState?: unknown;
  initialOwners?: string[];
  initialSearch?: string;
  searchFilters?: Omit<
    IssueListRequestFilters,
    "q" | "projectId" | "limit" | "includeRoutineExecutions"
  >;
  searchWithinLoadedIssues?: boolean;
  baseCreateIssueDefaults?: Record<string, unknown>;
  createIssueLabel?: string;
  defaultSortField?: IssueSortField;
  showProgressSummary?: boolean;
  /**
   * When set together with `showProgressSummary`, the progress strip fetches
   * the recursive cost-summary for this parent issue and renders aggregate
   * tokens + wall-clock runtime for every run in the tree.
   */
  parentIssueIdForCostSummary?: string;
  enableRoutineVisibilityFilter?: boolean;
  hasMoreIssues?: boolean;
  isLoadingMoreIssues?: boolean;
  mutedIssueIds?: Set<string>;
  issueBadgeById?: Map<string, string>;
  onLoadMoreIssues?: () => void;
  onSearchChange?: (search: string) => void;
}

function IssueSearchInput({
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
    }, ISSUE_SEARCH_DEBOUNCE_MS);

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

function SubIssueProgressSummaryStrip({
  summary,
  issueLinkState,
  parentIssueIdForCostSummary,
}: {
  summary: SubIssueProgressSummary;
  issueLinkState?: unknown;
  parentIssueIdForCostSummary?: string;
}) {
  const target = summary.target;
  const targetIssue = target?.issue ?? null;
  const targetPathId = targetIssue?.identifier ?? targetIssue?.id ?? "";
  const targetState = targetIssue
    ? withIssueDetailHeaderSeed(issueLinkState, targetIssue)
    : undefined;
  const statusEntries = ISSUE_STATUSES.map((status) => ({
    status,
    count: summary.countsByStatus[status] ?? 0,
  })).filter((entry) => entry.count > 0);

  // Refresh fast enough that the runtime ticks up while a sub-issue is still
  // running, but slow enough not to hammer the recursive CTE on idle trees.
  const hasInProgress = summary.inProgressCount > 0;
  const costRefetchInterval = useVisibilityRefetchInterval({
    visibleMs: 5_000,
  });
  const { data: costSummary } = useQuery({
    queryKey: queryKeys.issues.costSummary(
      parentIssueIdForCostSummary ?? "pending",
      { excludeRoot: true },
    ),
    queryFn: () =>
      issuesApi.getCostSummary(parentIssueIdForCostSummary!, {
        excludeRoot: true,
      }),
    enabled: !!parentIssueIdForCostSummary,
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
                  } across ${costSummary.issueCount} sub-task${
                    costSummary.issueCount === 1 ? "" : "s"
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
                title={`${issueStatusLabels[status]}: ${count}`}
                aria-hidden="true"
              />
            ))}
          </div>
        </div>

        <div className="min-w-0 border border-border bg-background px-3 py-2 text-sm lg:w-72">
          {target && targetIssue ? (
            <>
              <div className="text-xs font-medium text-muted-foreground">
                {target.kind === "next" ? "Next up" : "Waiting on blockers"}
              </div>
              <Link
                to={createIssueDetailPath(targetPathId)}
                state={targetState}
                issuePrefetch={targetIssue}
                className="mt-1 block min-w-0 text-foreground underline-offset-2 hover:underline"
              >
                <span className="font-mono text-xs text-muted-foreground">
                  {targetIssue.identifier ?? targetIssue.id.slice(0, 8)}
                </span>{" "}
                <span>{targetIssue.title}</span>
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

// Mobile-only indent for nested task rows (desktop uses IssueRow treeGuides).
const MOBILE_TREE_INDENT = [
  "",
  "pl-4 sm:pl-0",
  "pl-8 sm:pl-0",
  "pl-12 sm:pl-0",
  "pl-16 sm:pl-0",
];

export function IssuesList({
  issues,
  isLoading,
  error,
  agents,
  projects,
  liveIssueIds,
  projectId,
  viewStateKey,
  issueLinkState,
  initialOwners,
  initialSearch,
  searchFilters,
  searchWithinLoadedIssues = false,
  baseCreateIssueDefaults,
  createIssueLabel,
  defaultSortField,
  showProgressSummary = false,
  parentIssueIdForCostSummary,
  enableRoutineVisibilityFilter = false,
  hasMoreIssues = false,
  isLoadingMoreIssues = false,
  mutedIssueIds,
  issueBadgeById,
  onLoadMoreIssues,
  onSearchChange,
}: IssuesListProps) {
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
  const { openNewIssue } = useDialogActions();
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

  const [viewState, setViewState] = useState<IssueViewState>(() =>
    getInitialViewState(scopedKey, initialOwners, defaultSortField),
  );
  const [issueSearch, setIssueSearch] = useState(initialSearch ?? "");
  const [renderedIssueRowLimit, setRenderedIssueRowLimit] = useState(
    INITIAL_ISSUE_ROW_RENDER_LIMIT,
  );
  const [visibleIssueColumns, setVisibleIssueColumns] = useState<
    InboxIssueColumn[]
  >(() => loadIssueColumns(scopedKey));
  const renderedIssueIdsRef = useRef("");
  const initialServerFillRequestedRef = useRef(false);
  const deferredIssueSearch = useDeferredValue(issueSearch);
  const normalizedIssueSearch = deferredIssueSearch.trim().toLowerCase();

  useEffect(() => {
    setIssueSearch(initialSearch ?? "");
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
      setVisibleIssueColumns(loadIssueColumns(scopedKey));
    }
  }, [scopedKey]);

  const updateView = useCallback(
    (patch: Partial<IssueViewState>) => {
      setViewState((prev) => {
        const next = { ...prev, ...patch };
        saveViewState(scopedKey, next);
        return next;
      });
    },
    [scopedKey],
  );

  // Prune stale IDs from collapsedParents whenever the issue list changes.
  // Deleted or reassigned issues leave orphan IDs in localStorage; this keeps
  // the stored array bounded to only current parent IDs.
  useEffect(() => {
    const parentIds = new Set(
      issues.map((i) => i.parentId).filter(Boolean) as string[],
    );
    const pruned = viewState.collapsedParents.filter((id) => parentIds.has(id));
    if (pruned.length !== viewState.collapsedParents.length) {
      updateView({ collapsedParents: pruned });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issues]);

  const { data: searchedIssues = [] } = useQuery({
    queryKey: [
      ...queryKeys.issues.search(
        selectedCompanyId!,
        normalizedIssueSearch,
        projectId,
      ),
      searchFilters ?? {},
      "compact",
      ISSUE_SEARCH_RESULT_LIMIT,
      enableRoutineVisibilityFilter
        ? "with-routine-executions"
        : "without-routine-executions",
    ],
    queryFn: ({ signal }) =>
      issuesApi
        .listCompact(
          selectedCompanyId!,
          {
            q: normalizedIssueSearch,
            projectId,
            limit: ISSUE_SEARCH_RESULT_LIMIT,
            ...searchFilters,
            ...(enableRoutineVisibilityFilter
              ? { includeRoutineExecutions: true }
              : {}),
          },
          { signal },
        )
        .then((rows) => rows as Issue[]),
    enabled:
      !!selectedCompanyId &&
      normalizedIssueSearch.length > 0 &&
      !searchWithinLoadedIssues,
    placeholderData: (previousData) => previousData,
  });
  const boardIssueQueries = useQueries({
    queries: boardIssueStatuses.map((status) => ({
      queryKey: [
        ...queryKeys.issues.list(selectedCompanyId ?? "__no-company__"),
        "board-column",
        status,
        normalizedIssueSearch,
        projectId ?? "__all-projects__",
        searchFilters ?? {},
        "compact",
        ISSUE_BOARD_COLUMN_RESULT_LIMIT,
        enableRoutineVisibilityFilter
          ? "with-routine-executions"
          : "without-routine-executions",
      ],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        issuesApi
          .listCompact(
            selectedCompanyId!,
            {
              ...searchFilters,
              ...(normalizedIssueSearch.length > 0
                ? { q: normalizedIssueSearch }
                : {}),
              projectId,
              status,
              limit: ISSUE_BOARD_COLUMN_RESULT_LIMIT,
              ...(enableRoutineVisibilityFilter
                ? { includeRoutineExecutions: true }
                : {}),
            },
            { signal },
          )
          .then((rows) => rows as Issue[]),
      enabled:
        !!selectedCompanyId &&
        viewState.viewMode === "board" &&
        !searchWithinLoadedIssues,
      placeholderData: (previousData: Issue[] | undefined) => previousData,
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

    for (const issue of issues) {
      const creator = deriveOriginatingActor(issue);
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

    for (const issue of issues) {
      const creator = deriveOriginatingActor(issue);
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
  }, [agents, currentUserId, issues]);

  const visibleIssueColumnSet = useMemo(
    () => new Set(visibleIssueColumns),
    [visibleIssueColumns],
  );
  const availableIssueColumns = inboxIssueColumns;
  const availableIssueColumnSet = useMemo(
    () => new Set(availableIssueColumns),
    [availableIssueColumns],
  );
  const subtreeLiveCounts = useMemo(
    () => collectSubtreeLiveCounts(issues, liveIssueIds ?? new Set<string>()),
    [issues, liveIssueIds],
  );
  const visibleTrailingIssueColumns = useMemo(
    () =>
      issueTrailingColumns.filter(
        (column) =>
          visibleIssueColumnSet.has(column) &&
          availableIssueColumnSet.has(column),
      ),
    [availableIssueColumnSet, visibleIssueColumnSet],
  );

  const issueById = useMemo(() => {
    const map = new Map<string, Issue>();
    for (const issue of issues) {
      map.set(issue.id, issue);
    }
    return map;
  }, [issues]);

  const issueTitleMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const issue of issues) {
      const title = issueDisplayTitle(issue);
      map.set(
        issue.id,
        issue.identifier && issue.identifier !== title
          ? `${issue.identifier}: ${title}`
          : title,
      );
    }
    return map;
  }, [issues]);

  const boardIssues = useMemo(() => {
    if (viewState.viewMode !== "board" || searchWithinLoadedIssues) return null;
    const merged = new Map<string, Issue>();
    let isPending = false;
    for (const query of boardIssueQueries) {
      isPending ||= query.isPending;
      for (const issue of query.data ?? []) {
        merged.set(issue.id, issue);
      }
    }
    if (merged.size > 0) return [...merged.values()];
    return isPending ? issues : [];
  }, [boardIssueQueries, issues, searchWithinLoadedIssues, viewState.viewMode]);
  const boardColumnLimitReached = useMemo(
    () =>
      viewState.viewMode === "board" &&
      !searchWithinLoadedIssues &&
      boardIssueQueries.some(
        (query) =>
          (query.data?.length ?? 0) === ISSUE_BOARD_COLUMN_RESULT_LIMIT,
      ),
    [boardIssueQueries, searchWithinLoadedIssues, viewState.viewMode],
  );

  const sourceIssues = useMemo(() => {
    const useRemoteSearch =
      normalizedIssueSearch.length > 0 && !searchWithinLoadedIssues;
    return boardIssues ?? (useRemoteSearch ? searchedIssues : issues);
  }, [
    boardIssues,
    issues,
    normalizedIssueSearch,
    searchedIssues,
    searchWithinLoadedIssues,
  ]);

  const searchScopedIssues = useMemo(
    () =>
      normalizedIssueSearch.length > 0 && searchWithinLoadedIssues
        ? sourceIssues.filter((issue) =>
            issueMatchesLocalSearch(issue, normalizedIssueSearch),
          )
        : sourceIssues,
    [normalizedIssueSearch, searchWithinLoadedIssues, sourceIssues],
  );
  const filtered = useMemo(() => {
    const filteredByControls = applyIssueFilters(
      searchScopedIssues,
      viewState,
      currentUserId,
      enableRoutineVisibilityFilter,
      liveIssueIds,
    );
    return sortIssues(filteredByControls, viewState);
  }, [
    searchScopedIssues,
    viewState,
    currentUserId,
    enableRoutineVisibilityFilter,
    liveIssueIds,
  ]);

  const progressSummary = useMemo(
    () =>
      shouldRenderSubIssueProgressSummary(showProgressSummary, issues.length)
        ? buildSubIssueProgressSummary(issues)
        : null,
    [issues, showProgressSummary],
  );
  const checklistAffordanceEnabled = useMemo(
    () => defaultSortField === "workflow" && viewState.groupBy === "none",
    [defaultSortField, viewState.groupBy],
  );
  const workflowChecklistMeta = useMemo(() => {
    if (!checklistAffordanceEnabled) return null;

    const visibleIssueIds = new Set(filtered.map((issue) => issue.id));
    const stepNumberByIssueId = buildChecklistStepNumberMap(
      filtered,
      viewState.nestingEnabled,
    );
    const previousSiblingIssueIdByIssueId = buildPreviousSiblingIssueIdMap(
      filtered,
      viewState.nestingEnabled,
    );
    const unresolvedVisibleBlockersByIssueId = new Map<string, string[]>();

    filtered.forEach((issue) => {
      const unresolvedVisible = (issue.blockedBy ?? [])
        .map((blocker) => blocker.id)
        .filter((blockerId) => {
          if (!visibleIssueIds.has(blockerId)) return false;
          const blockerIssue = issueById.get(blockerId);
          if (!blockerIssue) return false;
          return (
            blockerIssue.boardPresentationStatus !== "done" &&
            blockerIssue.boardPresentationStatus !== "cancelled"
          );
        });
      const shouldSuppressChip = shouldSuppressSinglePreviousSiblingBlockerChip(
        issue,
        unresolvedVisible,
        previousSiblingIssueIdByIssueId.get(issue.id),
      );
      unresolvedVisibleBlockersByIssueId.set(
        issue.id,
        shouldSuppressChip ? [] : unresolvedVisible,
      );
    });

    const firstActionable =
      filtered.find((issue) =>
        isActionableWorkflowStatus(issue.boardPresentationStatus),
      ) ?? null;
    const currentStepIssue =
      firstActionable ??
      filtered.find((issue) => issue.boardPresentationStatus === "blocked") ??
      null;

    return {
      stepNumberByIssueId,
      unresolvedVisibleBlockersByIssueId,
      currentStepIssueId: currentStepIssue?.id ?? null,
    };
  }, [
    checklistAffordanceEnabled,
    filtered,
    issueById,
    viewState.nestingEnabled,
  ]);

  const { data: labels } = useQuery({
    queryKey: queryKeys.issues.labels(selectedCompanyId!),
    queryFn: () => issuesApi.listLabels(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const activeFilterCount = countActiveIssueFilters(
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
      return issueStatusOrder
        .filter((s) => groups[s]?.length)
        .map((s) => ({
          key: s,
          label: issueFilterLabel(s),
          items: groups[s]!,
        }));
    }
    if (viewState.groupBy === "priority") {
      const groups = groupBy(filtered, (i) => i.priority);
      return issuePriorityOrder
        .filter((p) => groups[p]?.length)
        .map((p) => ({
          key: p,
          label: issueFilterLabel(p),
          items: groups[p]!,
        }));
    }
    if (viewState.groupBy === "project") {
      const groups = groupBy(
        filtered,
        (issue) => issue.projectId ?? "__no_project",
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
              : (issueTitleMap.get(key) ?? key.slice(0, 8)),
          items: groups[key]!,
        }));
    }
    // owner
    const groups = groupBy(
      filtered,
      (issue) =>
        issue.ownerAgentId ??
        (issue.ownerUserId ? `__user:${issue.ownerUserId}` : "__board"),
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
    issueTitleMap,
    companyUserLabelMap,
    projectById,
  ]);

  // Flattened visible order (group headers, then tree DFS per group —
  // collapsed groups keep their header entry but skip their rows) — must
  // match render order below for keyboard traversal. `budgetOrdinal` counts
  // rows the way the progressive renderer consumes its budget (collapsed
  // groups still consume rows; collapsed parents' subtrees do not).
  const flatNavEntries = useMemo(() => {
    if (viewState.viewMode !== "list") return [] as IssuesListNavEntry[];
    const out: IssuesListNavEntry[] = [];
    let budgetCount = 0;
    for (const group of groupedContent) {
      const collapsed =
        Boolean(group.label) && viewState.collapsedGroups.includes(group.key);
      if (group.label) out.push({ type: "group", key: group.key, collapsed });
      const { roots, childMap } = viewState.nestingEnabled
        ? buildIssueTree(group.items)
        : { roots: group.items, childMap: new Map<string, Issue[]>() };
      const walk = (issue: Issue) => {
        budgetCount += 1;
        const children = childMap.get(issue.id) ?? [];
        const expanded = !viewState.collapsedParents.includes(issue.id);
        if (!collapsed) {
          out.push({
            type: "issue",
            issue,
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
    issueLinkState,
    collapsedGroups: viewState.collapsedGroups,
    collapsedParents: viewState.collapsedParents,
    updateView,
  });
  listNavStateRef.current = {
    flatNavEntries,
    selectedNavKey,
    viewMode: viewState.viewMode,
    issueLinkState,
    collapsedGroups: viewState.collapsedGroups,
    collapsedParents: viewState.collapsedParents,
    updateView,
  };

  const findSelectedNavElement = useCallback((navKey: string) => {
    if (navKey.startsWith("group:")) {
      const header = rootRef.current?.querySelector(
        `[data-issues-group-key="${escapeAttrValue(navKey.slice("group:".length))}"]`,
      );
      return header instanceof HTMLElement ? header : null;
    }
    const row = rootRef.current?.querySelector(
      `[data-issue-row-id="${escapeAttrValue(navKey.slice("issue:".length))}"]`,
    );
    const link = row?.querySelector(":scope > [data-inbox-issue-link]");
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
              (entry) => issuesListNavEntryKey(entry) === key,
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
          setSelectedNavKey(issuesListNavEntryKey(nextEntry));
          // The list renders progressively; make sure the selected row is
          // within the render budget so the band mounts and can scroll into
          // view (the +1 keeps the next row visible as a scroll cue).
          if (nextEntry.type === "issue") {
            setRenderedIssueRowLimit((current) =>
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
            setSelectedNavKey(issuesListNavEntryKey(entry));
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
          setSelectedNavKey(issuesListNavEntryKey(entry));
          st.updateView({
            collapsedParents: collapse
              ? st.collapsedParents.includes(entry.issue.id)
                ? st.collapsedParents
                : [...st.collapsedParents, entry.issue.id]
              : st.collapsedParents.filter((id) => id !== entry.issue.id),
          });
          break;
        }
        case "Enter": {
          const entry = st.flatNavEntries[currentIndex];
          if (!entry || entry.type !== "issue") return;
          e.preventDefault();
          // Navigate from the entry data (like the inbox) rather than the DOM
          // row — the selected row may sit past the mounted render batch.
          const issue = entry.issue;
          const pathId = issue.identifier ?? issue.id;
          const detailState = withIssueDetailHeaderSeed(
            st.issueLinkState,
            issue,
          );
          rememberIssueDetailLocationState(pathId, detailState);
          navigate(createIssueDetailPath(pathId), { state: detailState });
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
  }, [findSelectedNavElement, renderedIssueRowLimit, selectedNavKey]);

  useEffect(() => {
    if (viewState.viewMode !== "list") return;
    const nextIssueIds = filtered.map((issue) => issue.id).join("|");
    const previousIssueIds = renderedIssueIdsRef.current;
    renderedIssueIdsRef.current = nextIssueIds;

    setRenderedIssueRowLimit((current) => {
      const nextInitialLimit = Math.min(
        filtered.length,
        INITIAL_ISSUE_ROW_RENDER_LIMIT,
      );
      const listAppended =
        previousIssueIds.length > 0 &&
        nextIssueIds.startsWith(previousIssueIds) &&
        filtered.length >= current;
      if (listAppended)
        return Math.min(filtered.length, Math.max(current, nextInitialLimit));
      return nextInitialLimit;
    });
  }, [filtered, viewState.viewMode]);

  const hasMoreRenderedRows =
    viewState.viewMode === "list" && renderedIssueRowLimit < filtered.length;
  const remainingIssueRowCount = Math.max(
    filtered.length - renderedIssueRowLimit,
    0,
  );
  const loadMoreIssueRows = useCallback(() => {
    if (viewState.viewMode !== "list") return;
    if (hasMoreRenderedRows) {
      setRenderedIssueRowLimit((current) =>
        Math.min(filtered.length, current + ISSUE_ROW_RENDER_BATCH_SIZE),
      );
      return;
    }
    if (hasMoreIssues && !isLoadingMoreIssues) {
      onLoadMoreIssues?.();
    }
  }, [
    filtered.length,
    hasMoreIssues,
    hasMoreRenderedRows,
    isLoadingMoreIssues,
    onLoadMoreIssues,
    viewState.viewMode,
  ]);

  const canLoadMoreIssues =
    viewState.viewMode === "list" &&
    !isLoading &&
    (hasMoreRenderedRows || (hasMoreIssues && !isLoadingMoreIssues));

  useEffect(() => {
    if (!canLoadMoreIssues) return;
    let animationFrameId: number | null = null;
    const scrollContainer = findIssuesScrollContainer(rootRef.current);
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
        const threshold = scrollHeight - ISSUE_SCROLL_LOAD_THRESHOLD_PX;
        if (scrollBottom >= threshold) {
          if (
            trigger === "initial" &&
            !hasMoreRenderedRows &&
            hasMoreIssues &&
            !hasScrollableOverflow
          ) {
            if (initialServerFillRequestedRef.current) return;
            initialServerFillRequestedRef.current = true;
          }
          loadMoreIssueRows();
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
    canLoadMoreIssues,
    hasMoreIssues,
    hasMoreRenderedRows,
    loadMoreIssueRows,
  ]);

  const newIssueDefaults = useCallback(
    (group?: { key: string; items: Issue[] }) => {
      const groupKey = group?.key;
      const defaults: Record<string, unknown> = {
        ...(baseCreateIssueDefaults ?? {}),
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
          const parentIssue = issueById.get(groupKey);
          if (parentIssue)
            Object.assign(
              defaults,
              buildSubIssueDefaultsForViewer(parentIssue),
            );
          else defaults.parentId = groupKey;
        }
      }
      return defaults;
    },
    [
      baseCreateIssueDefaults,
      issueById,
      projectId,
      viewState.groupBy,
    ],
  );

  const createActionLabel = createIssueLabel
    ? `Create ${createIssueLabel}`
    : "Create Task";
  const createButtonLabel = createIssueLabel
    ? `New ${createIssueLabel}`
    : "New Task";
  const openCreateIssueDialog = useCallback(
    (group?: { key: string; items: Issue[] }) => {
      openNewIssue(newIssueDefaults(group));
    },
    [newIssueDefaults, openNewIssue],
  );

  const setIssueColumns = useCallback(
    (next: InboxIssueColumn[]) => {
      const normalized = normalizeInboxIssueColumns(next);
      setVisibleIssueColumns(normalized);
      saveIssueColumns(scopedKey, normalized);
    },
    [scopedKey],
  );

  const toggleIssueColumn = useCallback(
    (column: InboxIssueColumn, enabled: boolean) => {
      if (enabled) {
        setIssueColumns([...visibleIssueColumns, column]);
        return;
      }
      setIssueColumns(visibleIssueColumns.filter((value) => value !== column));
    },
    [setIssueColumns, visibleIssueColumns],
  );

  let remainingRowsToRender =
    viewState.viewMode === "list"
      ? renderedIssueRowLimit
      : Number.POSITIVE_INFINITY;

  return (
    <div ref={rootRef} className="space-y-4">
      {isLoading || isLoadingMoreIssues ? (
        <p className="sr-only" role="status">
          {isLoading ? "Loading tasks." : "Loading more tasks."}
        </p>
      ) : null}
      {progressSummary ? (
        <SubIssueProgressSummaryStrip
          summary={progressSummary}
          issueLinkState={issueLinkState}
          parentIssueIdForCostSummary={parentIssueIdForCostSummary}
        />
      ) : null}

      {/* Toolbar */}
      <div className="flex items-center justify-between gap-2 sm:gap-3">
        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          <Button
            size="sm"
            variant="outline"
            onClick={() => openCreateIssueDialog()}
          >
            <Plus className="h-4 w-4 sm:mr-1" />
            <span className="hidden sm:inline">{createButtonLabel}</span>
          </Button>
          <IssueSearchInput
            value={issueSearch}
            onDebouncedChange={(nextSearch) => {
              setIssueSearch(nextSearch);
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
              <Popover>
                <PopoverTrigger asChild>
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
                </PopoverTrigger>
                <PopoverContent align="end" className="w-40 p-0">
                  <div className="p-2 space-y-0.5">
                    {KANBAN_COLUMN_PAGE_SIZE_OPTIONS.map((pageSize) => (
                      <button
                        key={pageSize}
                        type="button"
                        className={cn(
                          "flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-sm",
                          viewState.boardColumnPageSize === pageSize
                            ? "bg-accent/50 text-foreground"
                            : "text-muted-foreground hover:bg-accent/50",
                        )}
                        onClick={() =>
                          updateView({ boardColumnPageSize: pageSize })
                        }
                      >
                        <span>{pageSize} per column</span>
                        {viewState.boardColumnPageSize === pageSize && (
                          <Check className="h-3.5 w-3.5" />
                        )}
                      </button>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>
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

          <IssueColumnPicker
            availableColumns={availableIssueColumns}
            visibleColumnSet={visibleIssueColumnSet}
            onToggleColumn={toggleIssueColumn}
            onResetColumns={() => setIssueColumns(DEFAULT_INBOX_ISSUE_COLUMNS)}
            title="Choose which task columns stay visible"
            iconOnly
          />

          <IssueFiltersPopover
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
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-8 w-8 shrink-0"
                  title="Sort"
                >
                  <ArrowUpDown className="h-3.5 w-3.5" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-48 p-0">
                <div className="p-2 space-y-0.5">
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
                    <button
                      key={field}
                      className={`flex items-center justify-between w-full px-2 py-1.5 text-sm rounded-sm ${
                        viewState.sortField === field
                          ? "bg-accent/50 text-foreground"
                          : "hover:bg-accent/50 text-muted-foreground"
                      }`}
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
                        <span className="text-xs text-muted-foreground">
                          {viewState.sortDir === "asc" ? "\u2191" : "\u2193"}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              </PopoverContent>
            </Popover>
          )}

          {/* Group (list view only) */}
          {viewState.viewMode === "list" && (
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-8 w-8 shrink-0"
                  title="Group"
                >
                  <Layers className="h-3.5 w-3.5" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-44 p-0">
                <div className="p-2 space-y-0.5">
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
                    <button
                      key={value}
                      className={`flex items-center justify-between w-full px-2 py-1.5 text-sm rounded-sm ${
                        viewState.groupBy === value
                          ? "bg-accent/50 text-foreground"
                          : "hover:bg-accent/50 text-muted-foreground"
                      }`}
                      onClick={() => updateView({ groupBy: value })}
                    >
                      <span>{label}</span>
                      {viewState.groupBy === value && (
                        <Check className="h-3.5 w-3.5" />
                      )}
                    </button>
                  ))}
                </div>
              </PopoverContent>
            </Popover>
          )}
        </div>
      </div>

      {isLoading && (
        <PageSkeleton variant="issues-list" />
      )}
      {error && <p className="text-sm text-destructive" role="alert">{error.message}</p>}
      {!searchWithinLoadedIssues &&
        normalizedIssueSearch.length > 0 &&
        searchedIssues.length === ISSUE_SEARCH_RESULT_LIMIT && (
          <p className="text-xs text-muted-foreground">
            Showing up to {ISSUE_SEARCH_RESULT_LIMIT} matches. Refine the search
            to narrow further.
          </p>
        )}
      {boardColumnLimitReached && (
        <p className="text-xs text-muted-foreground">
          Some board columns are showing up to {ISSUE_BOARD_COLUMN_RESULT_LIMIT}{" "}
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
            onAction={() => openCreateIssueDialog()}
          />
        )}

      {viewState.viewMode === "board" ? (
        <KanbanBoard
          issues={filtered}
          agents={agents}
          liveIssueIds={liveIssueIds}
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
                    data-issues-group-key={group.key}
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
                    <IssueGroupHeader
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
                          onClick={() => openCreateIssueDialog(group)}
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
                      ? buildIssueTree(group.items)
                      : {
                          roots: group.items,
                          childMap: new Map<string, Issue[]>(),
                        };

                    const renderIssueRow = (issue: Issue, depth: number) => {
                      if (remainingRowsToRender <= 0) return null;
                      remainingRowsToRender -= 1;

                      const children = childMap.get(issue.id) ?? [];
                      const hasChildren = children.length > 0;
                      const totalDescendants = hasChildren
                        ? countDescendants(issue.id, childMap)
                        : 0;
                      const isExpanded = !viewState.collapsedParents.includes(
                        issue.id,
                      );
                      const useDeferredRowRendering = !(
                        hasChildren && isExpanded
                      );
                      const issueProject = issue.projectId
                        ? (projectById.get(issue.projectId) ?? null)
                        : null;
                      const parentIssue = issue.parentId
                        ? (issueById.get(issue.parentId) ?? null)
                        : null;
                      const issueBadge = issueBadgeById?.get(issue.id);
                      const isMutedIssue =
                        mutedIssueIds?.has(issue.id) === true;
                      const ownerUserProfile = issue.ownerUserId
                        ? (companyUserProfileMap.get(issue.ownerUserId) ?? null)
                        : null;
                      const ownerUserLabel =
                        formatOwnerUserLabel(
                          issue.ownerUserId,
                          currentUserId,
                          companyUserLabelMap,
                        ) ??
                        ownerUserProfile?.label ??
                        null;
                      const originatingActor = deriveOriginatingActor(issue);
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
                            ? [...viewState.collapsedParents, issue.id]
                            : viewState.collapsedParents.filter(
                                (id) => id !== issue.id,
                              ),
                        });
                      };
                      const checklistMeta = workflowChecklistMeta;
                      const checklistStepNumber =
                        checklistMeta?.stepNumberByIssueId.get(issue.id) ??
                        null;
                      const unresolvedVisibleBlockers =
                        checklistMeta?.unresolvedVisibleBlockersByIssueId.get(
                          issue.id,
                        ) ?? [];
                      const checklistRowId = checklistMeta
                        ? `issue-workflow-row-${issue.id}`
                        : undefined;
                      const doneRowTitleClass =
                        checklistMeta &&
                        issue.boardPresentationStatus === "done"
                          ? "text-muted-foreground"
                          : undefined;
                      const visibleBlockerChips = unresolvedVisibleBlockers
                        .map((blockerId) => {
                          const blockerIssue = issueById.get(blockerId);
                          if (!blockerIssue) return null;
                          const label =
                            blockerIssue.identifier ??
                            blockerIssue.id.slice(0, 8);
                          const blockerStep =
                            checklistMeta?.stepNumberByIssueId.get(blockerId);
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
                                `issue-workflow-row-${firstVisibleBlockerChip.blockerId}`,
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
                          key={issue.id}
                          data-issue-row-id={issue.id}
                          // Desktop indentation comes from IssueRow's treeGuides
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
                          <IssueRow
                            issue={issue}
                            issueLinkState={issueLinkState}
                            selected={selectedNavKey === `issue:${issue.id}`}
                            onMouseEnter={() =>
                              setNavSelectionFromPointer(`issue:${issue.id}`)
                            }
                            treeGuides={depth}
                            chevronInGuide={depth > 0 && hasChildren}
                            hideDivider={hasChildren && isExpanded}
                            checklistStepNumber={checklistStepNumber}
                            checklistCurrentStep={
                              checklistMeta?.currentStepIssueId === issue.id
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
                                {issueBadge ? (
                                  issueBadge === "Paused" ? (
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
                                      {issueBadge}
                                    </Badge>
                                  )
                                ) : null}
                              </>
                            }
                            className={cn(
                              isMutedIssue && "opacity-70",
                              selectedNavKey === `issue:${issue.id}` &&
                                "bg-accent/50 hover:bg-accent/50",
                            )}
                            mobileLeading={
                              hasChildren ? (
                                <button
                                  type="button"
                                  data-slot="icon-button"
                                  aria-label={`${isExpanded ? "Collapse" : "Expand"} sub-tasks for ${issue.title}`}
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
                                    status={issue.boardPresentationStatus}
                                    size="md"
                                    blockerAttention={issue.blockerAttention}
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
                                    aria-label={`${isExpanded ? "Collapse" : "Expand"} sub-tasks for ${issue.title}`}
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
                                <InboxIssueMetaLeading
                                  issue={issue}
                                  isLive={liveIssueIds?.has(issue.id) === true}
                                  subtreeLiveCount={
                                    subtreeLiveCounts.get(issue.id) ?? 0
                                  }
                                  showStatus={
                                    visibleIssueColumnSet.has("status") &&
                                    availableIssueColumnSet.has("status")
                                  }
                                  showIdentifier={
                                    visibleIssueColumnSet.has("id") &&
                                    availableIssueColumnSet.has("id")
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
                                        status={issue.boardPresentationStatus}
                                        size="md"
                                        blockerAttention={
                                          issue.blockerAttention
                                        }
                                      />
                                    </span>
                                  }
                                />
                              </>
                            }
                            mobileMeta={issueActivityText(issue).toLowerCase()}
                            desktopTrailing={
                              visibleTrailingIssueColumns.length > 0 ? (
                                <InboxIssueTrailingColumns
                                  issue={issue}
                                  columns={visibleTrailingIssueColumns}
                                  projectName={issueProject?.name ?? null}
                                  projectColor={issueProject?.color ?? null}
                                  ownerName={agentName(issue.ownerAgentId)}
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
                                    parentIssue?.identifier ?? null
                                  }
                                  parentTitle={parentIssue?.title ?? null}
                                  ownerContent={
                                    <div className="flex w-full shrink-0 items-center overflow-hidden px-2 py-1">
                                      {issue.ownerAgentId &&
                                      agentName(issue.ownerAgentId) ? (
                                        <Identity
                                          name={agentName(issue.ownerAgentId)!}
                                          size="sm"
                                          shape="square"
                                          className="min-w-0"
                                        />
                                      ) : issue.ownerUserId ? (
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
                              renderIssueRow(child, depth + 1),
                            )}
                        </div>
                      );
                    };

                    return roots
                      .map((issue) => renderIssueRow(issue, 0))
                      .filter((node) => node !== null);
                  })()}
                </CollapsibleContent>
              </Collapsible>
            );
          })}
          {(remainingIssueRowCount > 0 ||
            hasMoreIssues ||
            isLoadingMoreIssues) && (
            <div className="py-2" data-testid="issues-load-more-sentinel">
              <p className="text-xs text-muted-foreground">
                {isLoadingMoreIssues
                  ? "Loading more tasks..."
                  : remainingIssueRowCount > 0
                    ? `Rendering ${Math.min(renderedIssueRowLimit, filtered.length)} of ${filtered.length} tasks`
                    : "Scroll to load more tasks"}
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
