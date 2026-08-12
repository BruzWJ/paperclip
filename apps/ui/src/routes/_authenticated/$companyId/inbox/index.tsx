import { createFileRoute } from "@tanstack/react-router";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  compareMoneyAmounts,
  deriveOriginatingActor,
  INBOX_MINE_TASK_STATUSES,
  parseMoneyAmount,
} from "@paperclipai/shared";
import { approvalsApi } from "@/api/approvals";
import { useApprovalMutations } from "@/hooks/useApprovalMutations";
import { accessApi } from "@/api/access";
import { authApi } from "@/api/auth";
import { ApiError } from "@/api/client";
import { dashboardApi } from "@/api/dashboard";
import { tasksApi } from "@/api/tasks";
import { agentsApi } from "@/api/agents";
import { ACTIVE_TASK_EXECUTION_RUN_STATUSES, runsApi } from "@/api/runs";
import { projectsApi } from "@/api/projects";
import {
  BLOCKED_GROUP_OPTIONS,
  BLOCKED_SORT_OPTIONS,
  type BlockedInboxGroupBy,
  type BlockedInboxSort,
} from "@/lib/blockedInbox";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useGeneralSettings } from "@/context/GeneralSettingsContext";
import { useSidebar } from "@/context/SidebarContext";
import { queryKeys } from "@/lib/queryKeys";
import { useDialogActions } from "@/context/DialogContext";
import {
  applyTaskFilters,
  countActiveTaskFilters,
  type TaskFilterState,
} from "@/lib/task-filters";
import {
  collectLiveTaskIds,
  collectSubtreeLiveCounts,
} from "@/lib/liveTaskIds";
import { formatOwnerUserLabel } from "@/lib/task-owners";
import {
  buildCompanyUserLabelMap,
  buildCompanyUserProfileMap,
} from "@/lib/company-members";
import {
  armTaskDetailInboxQuickArchive,
  createTaskDetailLocationState,
  withTaskDetailHeaderSeed,
  type TaskDetailLocationState,
} from "@/lib/taskDetailBreadcrumb";
import { prefetchTaskDetail } from "@/lib/taskDetailCache";
import {
  hasBlockingShortcutDialog,
  isKeyboardShortcutTextInputTarget,
  resolveInboxUndoArchiveKeyAction,
  shouldBlurPageSearchOnEnter,
  shouldBlurPageSearchOnEscape,
} from "@/lib/keyboardShortcuts";
import {
  resolveInboxTaskBlockerAttention,
  resolveTaskLiveDescendantCount,
} from "@/lib/inbox-live-descendants";
import {
  beginLocalInboxArchive,
  boundLocalInboxArchive,
  cancelInboxTaskQueries,
  clearLocalInboxArchive,
  confirmLocalInboxArchive,
  invalidateInboxTaskQueries,
  getTaskPresenceInActiveInboxCaches,
  removeTaskFromInboxCaches,
  restoreTaskToInboxCaches,
  snapshotInboxTaskCaches,
  useLocalInboxArchiveTaskIds,
} from "@/lib/inboxArchiveCache";
import { EmptyState } from "@/components/EmptyState";
import { TaskGroupHeader } from "@/components/TaskGroupHeader";
import { PageSkeleton } from "@/components/PageSkeleton";
import {
  InboxTaskMetaLeading,
  InboxTaskTrailingColumns,
  TaskColumnPicker,
  taskActivityText,
  taskTrailingColumns,
} from "@/components/TaskColumns";
import { TaskFiltersPopover } from "@/components/TaskFiltersPopover";
import { TaskRow } from "@/components/TaskRow";
import { BlockedInboxView } from "@/components/BlockedInboxView";
import { SwipeToArchive } from "@/components/SwipeToArchive";
import { JoinRequestApprovalControls } from "@/components/JoinRequestApprovalControls";
import { StatusIcon } from "@/components/StatusIcon";
import { cn } from "@/lib/utils";
import { StatusBadge } from "@/components/StatusBadge";
import { approvalLabel, typeIcon } from "@/components/ApprovalPayload";
import { timeAgo } from "@/lib/timeAgo";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { Tabs } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Inbox as InboxIcon,
  AlertTriangle,
  Check,
  ChevronRight,
  ArrowUpDown,
  Layers,
  Plus,
  XCircle,
  X,
  UserPlus,
  Search,
  ListTree,
  ShieldCheck,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { PageTabBar } from "@/components/PageTabBar";
import type {
  Approval,
  TaskExecutionRunEnvelopeRecord,
  Task,
  JoinRequest,
} from "@paperclipai/shared";
import {
  ACTIONABLE_APPROVAL_STATUSES,
  DEFAULT_INBOX_TASK_COLUMNS,
  buildGroupedInboxSections,
  buildInboxTaskGroupCreateDefaults,
  buildInboxKeyboardNavEntries,
  getInboxWorkItemKey,
  getApprovalsForTab,
  getArchivedInboxSearchTasks,
  getInboxKeyboardSelectionIndex,
  getInboxWorkItems,
  getInboxSearchSupplementTasks,
  getLatestFailedRunsByAgent,
  matchesInboxTaskSearch,
  getRecentTouchedTasks,
  isInboxEntityDismissed,
  isMineInboxTab,
  loadCollapsedInboxGroupKeys,
  loadInboxFilterPreferences,
  loadInboxTaskColumns,
  loadInboxNesting,
  loadInboxWorkItemGroupBy,
  normalizeInboxTaskColumns,
  resolveInboxNestingEnabled,
  resolveInboxSelectionIndex,
  saveInboxFilterPreferences,
  saveCollapsedInboxGroupKeys,
  saveInboxTaskColumns,
  saveInboxNesting,
  saveInboxWorkItemGroupBy,
  inboxTaskColumns,
  type InboxApprovalFilter,
  type InboxCategoryFilter,
  type InboxFilterPreferences,
  type InboxTaskColumn,
  type InboxKeyboardNavEntry,
  shouldShowCompanyAlerts,
  shouldShowInboxSection,
  type InboxGroupedSection,
  type InboxTab,
  type InboxWorkItem,
  type InboxWorkItemGroupBy,
} from "@/lib/inbox";
import {
  useDismissedInboxAlerts,
  useInboxDismissals,
  useReadInboxItems,
} from "@/hooks/useInboxBadge";

export const Route = createFileRoute("/_authenticated/$companyId/inbox/")({
  component: MineInboxIndexRoute,
});

function MineInboxIndexRoute() {
  return <Inbox tab="mine" />;
}

const ZERO_AMOUNT = parseMoneyAmount("0");

const INBOX_RUN_LIMIT = 200;

const INBOX_TASK_LIST_LIMIT = 500;

const INBOX_HOT_PATH_STALE_MS = 30_000;

const INBOX_TASK_DETAIL_LOCATION_STATE = createTaskDetailLocationState("inbox");

type SectionKey = "work_items" | "alerts";

function InboxSearchInput({
  value,
  onChange,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  className: string;
}) {
  return (
    <Input
      aria-label="Search inbox"
      type="search"
      placeholder="Search inbox…"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (
          shouldBlurPageSearchOnEnter({
            key: event.key,
            isComposing: event.nativeEvent.isComposing,
          })
        ) {
          event.currentTarget.blur();
          return;
        }

        if (
          shouldBlurPageSearchOnEscape({
            key: event.key,
            isComposing: event.nativeEvent.isComposing,
            currentValue: event.currentTarget.value,
          })
        ) {
          event.currentTarget.blur();
        }
      }}
      className={className}
      data-page-search-target="true"
    />
  );
}

/** A flat navigation entry for keyboard j/k traversal that includes expanded children. */
type NavEntry = InboxKeyboardNavEntry;

// Stable identity for a nav row, resilient to the numeric index shifting when
// the inbox reshapes after an archive or live invalidation. Used to re-anchor both the keyboard
// selection and the hovered row across list refreshes.
const navEntryKey = (entry: NavEntry | undefined): string | null =>
  !entry
    ? null
    : entry.type === "top"
      ? `top:${entry.itemKey}`
      : entry.type === "child"
        ? `child:${entry.taskId}`
        : `group:${entry.groupKey}`;

type CreatorOption = {
  id: string;
  label: string;
  kind: "agent" | "user";
  searchText?: string;
};

function runFailureMessage(run: TaskExecutionRunEnvelopeRecord): string {
  return (
    run.terminalReasonCode?.replace(/_/g, " ") ?? "Run exited with an error."
  );
}

function approvalStatusLabel(status: Approval["status"]): string {
  return status.replaceAll("_", " ");
}

function readTaskIdFromRun(run: TaskExecutionRunEnvelopeRecord): string {
  return run.taskId;
}

function nonEmptyLabel(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function formatJoinRequestInboxLabel(
  joinRequest: Pick<
    JoinRequest,
    "requestEmailSnapshot" | "requestingUserId"
  > & {
    requesterUser?: {
      name: string | null;
      email: string | null;
    } | null;
  },
) {
  const requesterName = nonEmptyLabel(joinRequest.requesterUser?.name);
  const requesterEmail =
    nonEmptyLabel(joinRequest.requesterUser?.email) ??
    nonEmptyLabel(joinRequest.requestEmailSnapshot);
  const requesterId = nonEmptyLabel(joinRequest.requestingUserId);

  if (requesterName && requesterEmail)
    return `${requesterName} (${requesterEmail})`;
  if (requesterEmail) return requesterEmail;
  if (requesterName) return requesterName;
  if (requesterId) return requesterId;
  return "User join request";
}

type NonTaskUnreadState = "visible" | "fading" | "hidden" | null;

// Rows outside SwipeToArchive (non-archivable tabs/sections) still need the
// hover-follows-selection band that SwipeToArchive's surface normally paints.
function InboxRowSurface({
  selected,
  children,
}: {
  selected: boolean;
  children: ReactNode;
}) {
  return (
    <div className={cn(selected && "rounded-lg bg-accent/50")}>{children}</div>
  );
}

/** Shared unread-dot / mark-read / dismiss slot for non-task inbox rows. */
function InboxRowUnreadSlot({
  unreadState,
  onMarkRead,
  onArchive,
  archiveDisabled,
}: {
  unreadState: NonTaskUnreadState;
  onMarkRead?: () => void;
  onArchive?: () => void;
  archiveDisabled?: boolean;
}) {
  const showUnreadDot = unreadState === "visible" || unreadState === "fading";

  return (
    <span className="hidden sm:inline-flex h-4 w-4 shrink-0 items-center justify-center self-center">
      {showUnreadDot ? (
        <button
          type="button"
          onClick={onMarkRead}
          className={cn(
            "inline-flex h-4 w-4 items-center justify-center rounded-full transition-colors",
            "hover:bg-blue-500/20",
          )}
          aria-label="Mark as read"
        >
          <span
            className={cn(
              "block h-2 w-2 rounded-full transition-opacity duration-300",
              "bg-blue-600 dark:bg-blue-400",
              unreadState === "fading" ? "opacity-0" : "opacity-100",
            )}
          />
        </button>
      ) : onArchive ? (
        <button
          type="button"
          onClick={onArchive}
          disabled={archiveDisabled}
          className="inline-flex h-4 w-4 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100 disabled:pointer-events-none disabled:opacity-30"
          aria-label="Dismiss from inbox"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      ) : (
        <span className="inline-flex h-4 w-4" aria-hidden="true" />
      )}
    </span>
  );
}

export function FailedRunInboxRow({
  run,
  taskById,
  agentName: linkedAgentName,
  agentId,
  onDismiss,
  unreadState = null,
  onMarkRead,
  onArchive,
  archiveDisabled,
  selected = false,
  className,
}: {
  run: TaskExecutionRunEnvelopeRecord;
  taskById: Map<string, Task>;
  agentName: string | null;
  agentId: string | null;
  onDismiss: () => void;
  unreadState?: NonTaskUnreadState;
  onMarkRead?: () => void;
  onArchive?: () => void;
  archiveDisabled?: boolean;
  selected?: boolean;
  className?: string;
}) {
  const companyId = useCompanyRouteId();
  const taskId = readTaskIdFromRun(run);
  const task = taskId ? (taskById.get(taskId) ?? null) : null;
  const displayError = runFailureMessage(run);
  const showUnreadSlot = unreadState !== null;
  const runRowClassName = cn(
    "flex min-w-0 flex-1 items-start gap-2 no-underline text-inherit transition-colors",
    selected ? "hover:bg-transparent" : "hover:bg-accent/50",
  );
  const runRowContent = (
    <>
      {!showUnreadSlot && (
        <span
          className="hidden h-2 w-2 shrink-0 sm:inline-flex"
          aria-hidden="true"
        />
      )}
      <span
        className="hidden h-3.5 w-3.5 shrink-0 sm:inline-flex"
        aria-hidden="true"
      />
      <span className="mt-0.5 shrink-0 rounded-md bg-red-500/20 p-1.5 sm:mt-0">
        <XCircle className="h-4 w-4 text-red-600 dark:text-red-400" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="line-clamp-2 text-sm font-medium sm:truncate sm:line-clamp-none">
          {task ? (
            <>
              <span className="font-mono text-muted-foreground mr-1.5">
                {task.identifier}
              </span>
              {task.title}
            </>
          ) : (
            <>Failed run{linkedAgentName ? ` — ${linkedAgentName}` : ""}</>
          )}
        </span>
        <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <StatusBadge status={run.status} />
          {linkedAgentName && task ? <span>{linkedAgentName}</span> : null}
          <span className="truncate max-w-(--sz-300px)">{displayError}</span>
          <span>{timeAgo(run.createdAt)}</span>
        </span>
      </span>
    </>
  );

  return (
    <div
      className={cn(
        "group border-b border-border px-2 py-2.5 last:border-b-0 sm:px-1 sm:pr-3 sm:py-2",
        className,
      )}
    >
      <div className="flex items-start gap-2 sm:items-center">
        {showUnreadSlot ? (
          <InboxRowUnreadSlot
            unreadState={unreadState}
            onMarkRead={onMarkRead}
            onArchive={onArchive}
            archiveDisabled={archiveDisabled}
          />
        ) : null}
        {agentId ? (
          <Link
            to="/$companyId/agents/$agentId/runs/$runId"
            params={{ companyId, agentId, runId: run.id }}
            className={runRowClassName}
          >
            {runRowContent}
          </Link>
        ) : (
          <div className={runRowClassName}>{runRowContent}</div>
        )}
        <div className="hidden shrink-0 items-center gap-2 sm:flex">
          {!showUnreadSlot && (
            <button
              type="button"
              onClick={onDismiss}
              className="rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100"
              aria-label="Dismiss"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
      <div className="mt-3 flex gap-2 sm:hidden">
        {!showUnreadSlot && (
          <button
            type="button"
            onClick={onDismiss}
            className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="Dismiss"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
}

function ApprovalInboxRow({
  approval,
  requesterName,
  onApprove,
  onReject,
  isPending,
  unreadState = null,
  onMarkRead,
  onArchive,
  archiveDisabled,
  selected = false,
  className,
}: {
  approval: Approval;
  requesterName: string | null;
  onApprove: () => void;
  onReject: () => void;
  isPending: boolean;
  unreadState?: NonTaskUnreadState;
  onMarkRead?: () => void;
  onArchive?: () => void;
  archiveDisabled?: boolean;
  selected?: boolean;
  className?: string;
}) {
  const companyId = useCompanyRouteId();
  const Icon = typeIcon[approval.type] ?? ShieldCheck;
  const label = approvalLabel(
    approval.type,
    approval.payload as Record<string, unknown> | null,
  );
  const showResolutionButtons =
    approval.type !== "budget_override_required" &&
    ACTIONABLE_APPROVAL_STATUSES.has(approval.status);
  const showUnreadSlot = unreadState !== null;

  return (
    <div
      className={cn(
        "group border-b border-border px-2 py-2.5 last:border-b-0 sm:px-1 sm:pr-3 sm:py-2",
        className,
      )}
    >
      <div className="flex items-start gap-2 sm:items-center">
        {showUnreadSlot ? (
          <InboxRowUnreadSlot
            unreadState={unreadState}
            onMarkRead={onMarkRead}
            onArchive={onArchive}
            archiveDisabled={archiveDisabled}
          />
        ) : null}
        <Link
          to="/$companyId/approvals/$approvalId"
          params={{ companyId, approvalId: approval.id }}
          className={cn(
            "flex min-w-0 flex-1 items-start gap-2 no-underline text-inherit transition-colors",
            selected ? "hover:bg-transparent" : "hover:bg-accent/50",
          )}
        >
          {!showUnreadSlot && (
            <span
              className="hidden h-2 w-2 shrink-0 sm:inline-flex"
              aria-hidden="true"
            />
          )}
          <span
            className="hidden h-3.5 w-3.5 shrink-0 sm:inline-flex"
            aria-hidden="true"
          />
          <span className="mt-0.5 shrink-0 rounded-md bg-muted p-1.5 sm:mt-0">
            <Icon className="h-4 w-4 text-muted-foreground" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="line-clamp-2 text-sm font-medium sm:truncate sm:line-clamp-none">
              {label}
            </span>
            <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <span className="capitalize">
                {approvalStatusLabel(approval.status)}
              </span>
              {requesterName ? <span>requested by {requesterName}</span> : null}
              <span>updated {timeAgo(approval.updatedAt)}</span>
            </span>
          </span>
        </Link>
        {showResolutionButtons ? (
          <div className="hidden shrink-0 items-center gap-2 sm:flex">
            <Button
              size="sm"
              className="h-8 bg-green-700 px-3 text-white hover:bg-green-600"
              onClick={onApprove}
              disabled={isPending}
            >
              Approve
            </Button>
            <Button
              variant="destructive"
              size="sm"
              className="h-8 px-3"
              onClick={onReject}
              disabled={isPending}
            >
              Reject
            </Button>
          </div>
        ) : null}
      </div>
      {showResolutionButtons ? (
        <div className="mt-3 flex gap-2 sm:hidden">
          <Button
            size="sm"
            className="h-8 bg-green-700 px-3 text-white hover:bg-green-600"
            onClick={onApprove}
            disabled={isPending}
          >
            Approve
          </Button>
          <Button
            variant="destructive"
            size="sm"
            className="h-8 px-3"
            onClick={onReject}
            disabled={isPending}
          >
            Reject
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function JoinRequestInboxRow({
  joinRequest,
  onApprove,
  onReject,
  isPending,
  unreadState = null,
  onMarkRead,
  onArchive,
  archiveDisabled,
  className,
}: {
  joinRequest: JoinRequest;
  onApprove: () => void;
  onReject: () => void;
  isPending: boolean;
  unreadState?: NonTaskUnreadState;
  onMarkRead?: () => void;
  onArchive?: () => void;
  archiveDisabled?: boolean;
  className?: string;
}) {
  const label = formatJoinRequestInboxLabel(joinRequest);
  const showUnreadSlot = unreadState !== null;

  return (
    <div
      className={cn(
        "group border-b border-border px-2 py-2.5 last:border-b-0 sm:px-1 sm:pr-3 sm:py-2",
        className,
      )}
    >
      <div className="flex items-start gap-2 sm:items-center">
        {showUnreadSlot ? (
          <InboxRowUnreadSlot
            unreadState={unreadState}
            onMarkRead={onMarkRead}
            onArchive={onArchive}
            archiveDisabled={archiveDisabled}
          />
        ) : null}
        <div className="flex min-w-0 flex-1 items-start gap-2">
          {!showUnreadSlot && (
            <span
              className="hidden h-2 w-2 shrink-0 sm:inline-flex"
              aria-hidden="true"
            />
          )}
          <span
            className="hidden h-3.5 w-3.5 shrink-0 sm:inline-flex"
            aria-hidden="true"
          />
          <span className="mt-0.5 shrink-0 rounded-md bg-muted p-1.5 sm:mt-0">
            <UserPlus className="h-4 w-4 text-muted-foreground" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="line-clamp-2 text-sm font-medium sm:truncate sm:line-clamp-none">
              {label}
            </span>
            <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <span>
                requested {timeAgo(joinRequest.createdAt)} from IP{" "}
                {joinRequest.requestIp}
              </span>
            </span>
          </span>
        </div>
      </div>
      <JoinRequestApprovalControls
        onApprove={onApprove}
        onReject={onReject}
        isPending={isPending}
        className="mt-3 flex flex-wrap items-end gap-2"
        buttonClassName="h-8 px-3"
      />
    </div>
  );
}

export function Inbox({ tab }: { tab: InboxTab }) {
  const { setBreadcrumbs } = useBreadcrumbs();
  const { openNewTask } = useDialogActions();
  const { isMobile } = useSidebar();
  const navigate = useNavigate();
  const companyId = useCompanyRouteId();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const { keyboardShortcutsEnabled } = useGeneralSettings();
  const [searchQuery, setSearchQuery] = useState("");
  const normalizedSearchQuery = searchQuery.trim();
  const [filterPreferences, setFilterPreferences] =
    useState<InboxFilterPreferences>(() =>
      loadInboxFilterPreferences(companyId),
    );
  const [groupBy, setGroupBy] = useState<InboxWorkItemGroupBy>(() =>
    loadInboxWorkItemGroupBy(),
  );
  const [blockedGroupBy, setBlockedGroupBy] =
    useState<BlockedInboxGroupBy>("none");
  const [blockedSortBy, setBlockedSortBy] =
    useState<BlockedInboxSort>("most_recent");
  const [visibleTaskColumns, setVisibleTaskColumns] =
    useState<InboxTaskColumn[]>(loadInboxTaskColumns);
  const { dismissed: dismissedAlerts, dismiss: dismissAlert } =
    useDismissedInboxAlerts();
  const { dismissedAtByKey, dismiss: dismissInboxItem } =
    useInboxDismissals(companyId);
  const {
    readItems,
    markRead: markItemRead,
    markUnread: markItemUnread,
  } = useReadInboxItems();
  const { allCategoryFilter, allApprovalFilter, taskFilters } =
    filterPreferences;

  const canArchiveFromTab = isMineInboxTab(tab);
  const taskLinkState = INBOX_TASK_DETAIL_LOCATION_STATE;

  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const currentUserId = session?.user.id ?? null;

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
  });

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(companyId),
    queryFn: () => projectsApi.list(companyId),
  });
  const { data: labels } = useQuery({
    queryKey: queryKeys.tasks.labels(companyId),
    queryFn: () => tasksApi.listLabels(companyId),
  });
  useEffect(() => {
    setBreadcrumbs([{ label: "Inbox" }]);
  }, [setBreadcrumbs]);

  useEffect(() => {
    setSelectedIndex(-1);
    setSearchQuery("");
  }, [tab]);

  const previousCompanyIdRef = useRef<string | null>(companyId);
  useEffect(() => {
    if (previousCompanyIdRef.current !== companyId) {
      previousCompanyIdRef.current = companyId;
      setFilterPreferences(loadInboxFilterPreferences(companyId));
      setCollapsedGroupKeys(loadCollapsedInboxGroupKeys(companyId));
    }
  }, [companyId]);

  const {
    data: approvals,
    isLoading: isApprovalsLoading,
    error: approvalsError,
  } = useQuery({
    queryKey: queryKeys.approvals.list(companyId),
    queryFn: () => approvalsApi.list(companyId),
  });

  const { data: joinRequests = [], isLoading: isJoinRequestsLoading } =
    useQuery({
      queryKey: queryKeys.access.joinRequests(companyId),
      queryFn: async () => {
        try {
          return await accessApi.listJoinRequests(
            companyId,
            "pending_approval",
          );
        } catch (err) {
          if (
            err instanceof ApiError &&
            (err.status === 403 || err.status === 401)
          ) {
            return [];
          }
          throw err;
        }
      },
      retry: false,
    });

  const dashboardQueryKey = queryKeys.dashboard(companyId);
  const { data: dashboard, isLoading: isDashboardLoading } = useQuery({
    queryKey: dashboardQueryKey,
    queryFn: () => dashboardApi.summary(companyId),
  });

  const inboxTasksQueryKey = [
    ...queryKeys.tasks.list(companyId),
    "compact",
    "with-routine-executions",
    "live-descendant-summary",
    INBOX_TASK_LIST_LIMIT,
  ] as const;
  const { data: tasks, isLoading: isTasksLoading } = useQuery({
    queryKey: inboxTasksQueryKey,
    queryFn: () =>
      tasksApi
        .listCompact(companyId, {
          includeLiveDescendantSummary: true,
          limit: INBOX_TASK_LIST_LIMIT,
        })
        .then((rows) => rows as Task[]),
    refetchOnWindowFocus: false,
    staleTime: INBOX_HOT_PATH_STALE_MS,
  });
  const mineTasksQueryKey = [
    ...queryKeys.tasks.listMineByMe(companyId),
    "compact",
    "with-routine-executions",
    "live-descendant-summary",
    INBOX_TASK_LIST_LIMIT,
  ] as const;
  const { data: mineTasksRaw = [], isLoading: isMineTasksLoading } = useQuery({
    queryKey: mineTasksQueryKey,
    queryFn: () =>
      tasksApi
        .listCompact(companyId, {
          touchedByUserId: currentUserId!,
          inboxArchivedByUserId: currentUserId!,
          status: INBOX_MINE_TASK_STATUSES,
          includeLiveDescendantSummary: true,
          limit: INBOX_TASK_LIST_LIMIT,
        })
        .then((rows) => rows as Task[]),
    enabled: !!currentUserId,
    refetchOnWindowFocus: false,
    staleTime: INBOX_HOT_PATH_STALE_MS,
  });
  const touchedTasksQueryKey = [
    ...queryKeys.tasks.listTouchedByMe(companyId),
    "compact",
    "with-routine-executions",
    "live-descendant-summary",
    INBOX_TASK_LIST_LIMIT,
  ] as const;
  const { data: touchedTasksRaw = [], isLoading: isTouchedTasksLoading } =
    useQuery({
      queryKey: touchedTasksQueryKey,
      queryFn: () =>
        tasksApi
          .listCompact(companyId, {
            touchedByUserId: currentUserId!,
            status: INBOX_MINE_TASK_STATUSES,
            includeLiveDescendantSummary: true,
            limit: INBOX_TASK_LIST_LIMIT,
          })
          .then((rows) => rows as Task[]),
      enabled: !!currentUserId,
      refetchOnWindowFocus: false,
      staleTime: INBOX_HOT_PATH_STALE_MS,
    });

  const { data: runPage, isLoading: isRunsLoading } = useQuery({
    queryKey: queryKeys.runs(companyId),
    queryFn: () =>
      runsApi.listForCompany(companyId, {
        limit: INBOX_RUN_LIMIT,
      }),
    refetchOnWindowFocus: false,
    staleTime: INBOX_HOT_PATH_STALE_MS,
  });
  const activeRunsQueryKey = queryKeys.runs(companyId, {
    status: ACTIVE_TASK_EXECUTION_RUN_STATUSES,
  });
  const { data: activeRunPage } = useQuery({
    queryKey: activeRunsQueryKey,
    queryFn: () =>
      runsApi.listForCompany(companyId, {
        status: ACTIVE_TASK_EXECUTION_RUN_STATUSES,
        limit: 200,
      }),
  });
  const liveTaskIds = useMemo(
    () => collectLiveTaskIds(activeRunPage?.items),
    [activeRunPage?.items],
  );
  const { data: companyMembers } = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(companyId),
    queryFn: () => accessApi.listUserDirectory(companyId),
  });
  const [archivingTaskIds, setArchivingTaskIds] = useState<Set<string>>(
    new Set(),
  );
  const [undoableArchiveTaskIds, setUndoableArchiveTaskIds] = useState<
    string[]
  >([]);
  const [unarchivingTaskIds, setUnarchivingTaskIds] = useState<Set<string>>(
    new Set(),
  );
  const guardedArchiveTaskIds = useLocalInboxArchiveTaskIds(companyId);
  const locallyArchivedTaskIds = useMemo(() => {
    const taskIds = new Set(guardedArchiveTaskIds);
    for (const taskId of undoableArchiveTaskIds) taskIds.add(taskId);
    for (const taskId of archivingTaskIds) taskIds.add(taskId);
    for (const taskId of unarchivingTaskIds) taskIds.delete(taskId);
    return taskIds;
  }, [
    archivingTaskIds,
    guardedArchiveTaskIds,
    undoableArchiveTaskIds,
    unarchivingTaskIds,
  ]);

  const companyUserLabelMap = useMemo(
    () => buildCompanyUserLabelMap(companyMembers?.users),
    [companyMembers?.users],
  );
  const companyUserProfileMap = useMemo(
    () => buildCompanyUserProfileMap(companyMembers?.users),
    [companyMembers?.users],
  );

  const mineTasks = useMemo(
    () =>
      getRecentTouchedTasks(mineTasksRaw).filter(
        (task) => !locallyArchivedTaskIds.has(task.id),
      ),
    [locallyArchivedTaskIds, mineTasksRaw],
  );
  const touchedTasks = useMemo(
    () =>
      getRecentTouchedTasks(touchedTasksRaw).filter(
        (task) => !locallyArchivedTaskIds.has(task.id),
      ),
    [locallyArchivedTaskIds, touchedTasksRaw],
  );
  const shouldUseTaskSearchSupplement = normalizedSearchQuery.length > 0;
  const { data: remoteTaskSearchResults = [] } = useQuery({
    queryKey: [
      ...queryKeys.tasks.search(
        companyId,
        normalizedSearchQuery,
        undefined,
        25,
      ),
      "compact",
      "inbox-supplement",
      "live-descendant-summary",
    ],
    queryFn: () =>
      tasksApi
        .listCompact(companyId, {
          q: normalizedSearchQuery,
          limit: 25,
          includeLiveDescendantSummary: true,
        })
        .then((rows) => rows as Task[]),
    enabled: shouldUseTaskSearchSupplement,
    placeholderData: (previousData) => previousData,
  });
  const visibleMineTasks = useMemo(
    () => applyTaskFilters(mineTasks, taskFilters, true, liveTaskIds),
    [mineTasks, taskFilters, liveTaskIds],
  );
  const visibleTouchedTasks = useMemo(
    () => applyTaskFilters(touchedTasks, taskFilters, true, liveTaskIds),
    [touchedTasks, taskFilters, liveTaskIds],
  );
  const unreadTouchedTasks = useMemo(
    () => visibleTouchedTasks.filter((task) => task.isUnreadForMe),
    [visibleTouchedTasks],
  );
  const creatorOptions = useMemo<CreatorOption[]>(() => {
    const options = new Map<string, CreatorOption>();
    const sourceTasks = [...mineTasks, ...touchedTasks];

    if (currentUserId) {
      options.set(`user:${currentUserId}`, {
        id: `user:${currentUserId}`,
        label: "Me",
        kind: "user",
        searchText: `me user ${currentUserId}`,
      });
    }

    for (const task of sourceTasks) {
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
            searchText: `${creator.id} board user`,
          });
        }
      }
    }

    const knownAgentIds = new Set<string>();
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

    for (const task of sourceTasks) {
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
  }, [agents, currentUserId, mineTasks, touchedTasks]);
  const tasksToRender = useMemo(() => {
    if (tab === "mine") return visibleMineTasks;
    if (tab === "unread") return unreadTouchedTasks;
    return visibleTouchedTasks;
  }, [tab, visibleMineTasks, visibleTouchedTasks, unreadTouchedTasks]);

  const agentById = useMemo(() => {
    const map = new Map<string, string>();
    for (const agent of agents ?? []) map.set(agent.id, agent.name);
    return map;
  }, [agents]);

  const taskById = useMemo(() => {
    const map = new Map<string, Task>();
    for (const task of tasks ?? []) map.set(task.id, task);
    return map;
  }, [tasks]);
  const projectById = useMemo(() => {
    const map = new Map<string, { name: string; color: string | null }>();
    for (const project of projects ?? []) {
      map.set(project.id, { name: project.name, color: project.color });
    }
    return map;
  }, [projects]);
  const inboxGrouping = useMemo(
    () => ({
      agentById,
      projectById,
      userLabelById: companyUserLabelMap,
      currentUserId,
    }),
    [agentById, companyUserLabelMap, currentUserId, projectById],
  );
  const visibleTaskColumnSet = useMemo(
    () => new Set(visibleTaskColumns),
    [visibleTaskColumns],
  );
  const availableTaskColumns = inboxTaskColumns;
  const availableTaskColumnSet = useMemo(
    () => new Set(availableTaskColumns),
    [availableTaskColumns],
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

  const failedRuns = useMemo(
    () =>
      getLatestFailedRunsByAgent(runPage?.items ?? []).filter(
        (r) =>
          !isInboxEntityDismissed(dismissedAtByKey, `run:${r.id}`, r.createdAt),
      ),
    [runPage?.items, dismissedAtByKey],
  );
  const approvalsToRender = useMemo(() => {
    let filtered = getApprovalsForTab(
      approvals ?? [],
      tab,
      allApprovalFilter,
      currentUserId,
    );
    if (tab === "mine") {
      filtered = filtered.filter(
        (a) =>
          !isInboxEntityDismissed(
            dismissedAtByKey,
            `approval:${a.id}`,
            a.updatedAt,
          ),
      );
    }
    return filtered;
  }, [approvals, tab, allApprovalFilter, currentUserId, dismissedAtByKey]);
  const showJoinRequestsCategory =
    allCategoryFilter === "everything" || allCategoryFilter === "join_requests";
  const showTouchedCategory =
    allCategoryFilter === "everything" ||
    allCategoryFilter === "tasks_i_touched";
  const showApprovalsCategory =
    allCategoryFilter === "everything" || allCategoryFilter === "approvals";
  const showFailedRunsCategory =
    allCategoryFilter === "everything" || allCategoryFilter === "failed_runs";
  const showAlertsCategory =
    allCategoryFilter === "everything" || allCategoryFilter === "alerts";
  const failedRunsForTab = useMemo(() => {
    if (tab === "all" && !showFailedRunsCategory) return [];
    return failedRuns;
  }, [failedRuns, tab, showFailedRunsCategory]);

  const joinRequestsForTab = useMemo(() => {
    if (tab === "all" && !showJoinRequestsCategory) return [];
    if (tab === "mine") {
      return joinRequests.filter(
        (jr) =>
          !isInboxEntityDismissed(
            dismissedAtByKey,
            `join:${jr.id}`,
            jr.updatedAt ?? jr.createdAt,
          ),
      );
    }
    return joinRequests;
  }, [joinRequests, tab, showJoinRequestsCategory, dismissedAtByKey]);

  const workItemsToRender = useMemo(
    () =>
      getInboxWorkItems({
        tasks: tab === "all" && !showTouchedCategory ? [] : tasksToRender,
        approvals:
          tab === "all" && !showApprovalsCategory ? [] : approvalsToRender,
        failedRuns: failedRunsForTab,
        joinRequests: joinRequestsForTab,
      }),
    [
      approvalsToRender,
      tasksToRender,
      showApprovalsCategory,
      showTouchedCategory,
      tab,
      failedRunsForTab,
      joinRequestsForTab,
    ],
  );

  const filteredWorkItems = useMemo(() => {
    const q = normalizedSearchQuery.toLowerCase();
    if (!q) return workItemsToRender;
    return workItemsToRender.filter((item) => {
      if (item.kind === "task") {
        return matchesInboxTaskSearch(item.task, q);
      }
      if (item.kind === "approval") {
        const a = item.approval;
        const label = approvalLabel(
          a.type,
          a.payload as Record<string, unknown> | null,
        );
        if (label.toLowerCase().includes(q)) return true;
        if (a.type.toLowerCase().includes(q)) return true;
        return false;
      }
      if (item.kind === "failed_run") {
        const run = item.run;
        const name = agentById.get(run.targetAgentId);
        if (name?.toLowerCase().includes(q)) return true;
        const msg = runFailureMessage(run);
        if (msg.toLowerCase().includes(q)) return true;
        const taskId = readTaskIdFromRun(run);
        if (taskId) {
          const task = taskById.get(taskId);
          if (task?.title?.toLowerCase().includes(q)) return true;
          if (task?.identifier?.toLowerCase().includes(q)) return true;
        }
        return false;
      }
      if (item.kind === "join_request") {
        const jr = item.joinRequest;
        return (
          Boolean(jr.requestEmailSnapshot?.toLowerCase().includes(q)) ||
          Boolean(jr.requestingUserId?.toLowerCase().includes(q))
        );
      }
      return false;
    });
  }, [workItemsToRender, agentById, taskById, normalizedSearchQuery]);

  const archivedSearchTasks = useMemo(
    () =>
      tab === "mine"
        ? getArchivedInboxSearchTasks({
            visibleTasks: visibleMineTasks,
            searchableTasks: visibleTouchedTasks,
            query: normalizedSearchQuery,
          })
        : [],
    [normalizedSearchQuery, tab, visibleMineTasks, visibleTouchedTasks],
  );
  const taskSearchSupplementResults = useMemo(
    () =>
      getInboxSearchSupplementTasks({
        query: normalizedSearchQuery,
        filteredWorkItems,
        archivedSearchTasks,
        remoteTasks: remoteTaskSearchResults,
        taskFilters,
        enableRoutineVisibilityFilter: true,
        liveTaskIds,
      }),
    [
      archivedSearchTasks,
      filteredWorkItems,
      taskFilters,
      liveTaskIds,
      normalizedSearchQuery,
      remoteTaskSearchResults,
    ],
  );
  const nonInboxSearchTaskIds = useMemo(
    () =>
      new Set([
        ...archivedSearchTasks.map((task) => task.id),
        ...taskSearchSupplementResults.map((task) => task.id),
      ]),
    [archivedSearchTasks, taskSearchSupplementResults],
  );

  // --- Parent-child nesting for inbox tasks ---
  const [nestingPreferenceEnabled, setNestingPreferenceEnabled] = useState(() =>
    loadInboxNesting(),
  );
  const nestingEnabled = resolveInboxNestingEnabled(
    nestingPreferenceEnabled,
    isMobile,
  );
  const toggleNesting = useCallback(() => {
    setNestingPreferenceEnabled((prev) => {
      const next = !prev;
      saveInboxNesting(next);
      return next;
    });
  }, []);
  const [collapsedInboxParents, setCollapsedInboxParents] = useState<
    Set<string>
  >(new Set());
  const [collapsedGroupKeys, setCollapsedGroupKeys] = useState<Set<string>>(
    () => loadCollapsedInboxGroupKeys(companyId),
  );
  const toggleGroupCollapse = useCallback(
    (groupKey: string) => {
      setCollapsedGroupKeys((prev) => {
        const next = new Set(prev);
        if (next.has(groupKey)) next.delete(groupKey);
        else next.add(groupKey);
        saveCollapsedInboxGroupKeys(companyId, next);
        return next;
      });
    },
    [companyId],
  );
  const setGroupCollapsed = useCallback(
    (groupKey: string, collapsed: boolean) => {
      setCollapsedGroupKeys((prev) => {
        if (collapsed ? prev.has(groupKey) : !prev.has(groupKey)) return prev;
        const next = new Set(prev);
        if (collapsed) next.add(groupKey);
        else next.delete(groupKey);
        saveCollapsedInboxGroupKeys(companyId, next);
        return next;
      });
    },
    [companyId],
  );
  const groupedSections = useMemo<InboxGroupedSection[]>(
    () => [
      ...buildGroupedInboxSections(filteredWorkItems, groupBy, inboxGrouping, {
        nestingEnabled,
      }),
      ...buildGroupedInboxSections(
        getInboxWorkItems({ tasks: archivedSearchTasks, approvals: [] }),
        groupBy,
        inboxGrouping,
        {
          keyPrefix: "archived-search:",
          searchSection: "archived",
          nestingEnabled,
        },
      ),
      ...buildGroupedInboxSections(
        getInboxWorkItems({
          tasks: taskSearchSupplementResults,
          approvals: [],
        }),
        groupBy,
        inboxGrouping,
        { keyPrefix: "other-search:", searchSection: "other", nestingEnabled },
      ),
    ],
    [
      archivedSearchTasks,
      filteredWorkItems,
      groupBy,
      inboxGrouping,
      taskSearchSupplementResults,
      nestingEnabled,
    ],
  );

  const openCreateTaskForGroup = useCallback(
    (group: InboxGroupedSection) => {
      const defaults = buildInboxTaskGroupCreateDefaults(
        group.key,
        groupBy,
        group.displayItems,
      );
      if (!defaults) return;
      openNewTask(defaults);
    },
    [groupBy, openNewTask],
  );
  const totalVisibleWorkItems = useMemo(
    () =>
      groupedSections.reduce(
        (count, group) => count + group.displayItems.length,
        0,
      ),
    [groupedSections],
  );
  const toggleInboxParentCollapse = useCallback((parentId: string) => {
    setCollapsedInboxParents((prev) => {
      const next = new Set(prev);
      if (next.has(parentId)) next.delete(parentId);
      else next.add(parentId);
      return next;
    });
  }, []);
  const setInboxParentCollapsed = useCallback(
    (parentId: string, collapsed: boolean) => {
      setCollapsedInboxParents((prev) => {
        if (prev.has(parentId) === collapsed) return prev;
        const next = new Set(prev);
        if (collapsed) next.add(parentId);
        else next.delete(parentId);
        return next;
      });
    },
    [],
  );

  // Build flat navigation list from visible rows so keyboard traversal respects collapsed groups.
  const flatNavItems = useMemo((): NavEntry[] => {
    return buildInboxKeyboardNavEntries(
      groupedSections,
      collapsedGroupKeys,
      collapsedInboxParents,
    );
  }, [collapsedGroupKeys, collapsedInboxParents, groupedSections]);
  // Read the current nav list from event handlers without recreating them (and
  // without capturing a stale array), so hover can resolve the row's key.
  const flatNavItemsRef = useRef(flatNavItems);
  flatNavItemsRef.current = flatNavItems;
  // Roll live descendant runs up to their ancestors across the loaded inbox tree
  // so a parent that is not itself live can still surface "n live below".
  const subtreeLiveCounts = useMemo(() => {
    const nodes: { id: string; parentId: string | null }[] = [];
    const seen = new Set<string>();
    const pushTask = (task: Task) => {
      if (seen.has(task.id)) return;
      seen.add(task.id);
      nodes.push({ id: task.id, parentId: task.parentId });
    };
    for (const group of groupedSections) {
      for (const item of group.displayItems) {
        if (item.kind === "task") pushTask(item.task);
      }
      for (const children of group.childrenByTaskId.values()) {
        for (const child of children) pushTask(child);
      }
    }
    return collectSubtreeLiveCounts(nodes, liveTaskIds);
  }, [groupedSections, liveTaskIds]);
  const topFlatIndex = useMemo(() => {
    const map = new Map<string, number>();
    flatNavItems.forEach((entry, index) => {
      if (entry.type === "top") map.set(entry.itemKey, index);
    });
    return map;
  }, [flatNavItems]);
  const childFlatIndex = useMemo(() => {
    const map = new Map<string, number>();
    flatNavItems.forEach((entry, index) => {
      if (entry.type === "child") map.set(entry.taskId, index);
    });
    return map;
  }, [flatNavItems]);
  const groupFlatIndex = useMemo(() => {
    const map = new Map<string, number>();
    flatNavItems.forEach((entry, index) => {
      if (entry.type === "group") map.set(entry.groupKey, index);
    });
    return map;
  }, [flatNavItems]);

  const agentName = (id: string | null) => {
    if (!id) return null;
    return agentById.get(id) ?? null;
  };
  const setTaskColumns = useCallback((next: InboxTaskColumn[]) => {
    const normalized = normalizeInboxTaskColumns(next);
    setVisibleTaskColumns(normalized);
    saveInboxTaskColumns(normalized);
  }, []);
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
  const updateFilterPreferences = useCallback(
    (updater: (previous: InboxFilterPreferences) => InboxFilterPreferences) => {
      setFilterPreferences((previous) => {
        const next = updater(previous);
        saveInboxFilterPreferences(companyId, next);
        return next;
      });
    },
    [companyId],
  );
  const updateTaskFilters = useCallback(
    (patch: Partial<TaskFilterState>) => {
      updateFilterPreferences((previous) => ({
        ...previous,
        taskFilters: { ...previous.taskFilters, ...patch },
      }));
    },
    [updateFilterPreferences],
  );
  const updateAllCategoryFilter = useCallback(
    (value: InboxCategoryFilter) => {
      updateFilterPreferences((previous) => ({
        ...previous,
        allCategoryFilter: value,
      }));
    },
    [updateFilterPreferences],
  );
  const updateAllApprovalFilter = useCallback(
    (value: InboxApprovalFilter) => {
      updateFilterPreferences((previous) => ({
        ...previous,
        allApprovalFilter: value,
      }));
    },
    [updateFilterPreferences],
  );
  const updateGroupBy = useCallback((nextGroupBy: InboxWorkItemGroupBy) => {
    setGroupBy(nextGroupBy);
    saveInboxWorkItemGroupBy(nextGroupBy);
  }, []);

  const { approveMutation, rejectMutation } = useApprovalMutations(
    companyId,
    setActionError,
  );

  const approveJoinMutation = useMutation({
    mutationFn: (joinRequest: JoinRequest) =>
      accessApi.approveJoinRequest(companyId, joinRequest.id),
    onSuccess: () => {
      setActionError(null);
      queryClient.invalidateQueries({
        queryKey: queryKeys.access.joinRequests(companyId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.sidebarBadges(companyId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.agents.list(companyId),
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
    },
    onError: (err) => {
      setActionError(
        err instanceof Error ? err.message : "Failed to approve join request",
      );
    },
  });

  const rejectJoinMutation = useMutation({
    mutationFn: (joinRequest: JoinRequest) =>
      accessApi.rejectJoinRequest(companyId, joinRequest.id),
    onSuccess: () => {
      setActionError(null);
      queryClient.invalidateQueries({
        queryKey: queryKeys.access.joinRequests(companyId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.sidebarBadges(companyId),
      });
    },
    onError: (err) => {
      setActionError(
        err instanceof Error ? err.message : "Failed to reject join request",
      );
    },
  });

  const [fadingOutTasks, setFadingOutTasks] = useState<Set<string>>(new Set());
  const [showMarkAllReadConfirm, setShowMarkAllReadConfirm] = useState(false);
  const [fadingNonTaskItems, setFadingNonTaskItems] = useState<Set<string>>(
    new Set(),
  );
  const [archivingNonTaskIds, setArchivingNonTaskIds] = useState<Set<string>>(
    new Set(),
  );
  const [selectedIndex, setSelectedIndex] = useState<number>(-1);
  const listRef = useRef<HTMLDivElement>(null);
  // Keyboard nav scrolls the list, which fires mouseenter on whatever row lands
  // under the stationary cursor — that must not steal the selection. Hover only
  // selects after the pointer has physically moved since the last key nav.
  const pointerMovedSinceKeyNavRef = useRef(true);
  useEffect(() => {
    const handlePointerMove = () => {
      pointerMovedSinceKeyNavRef.current = true;
    };
    window.addEventListener("mousemove", handlePointerMove, { passive: true });
    return () => window.removeEventListener("mousemove", handlePointerMove);
  }, []);
  // Which row the cursor is over, tracked WITHOUT React state so scrubbing the
  // list costs zero re-renders (hover paints via CSS `:hover`, see TaskRow).
  // Keyboard nav reads this to continue from the hovered row.
  const hoveredIndexRef = useRef<number | null>(null);
  // The hovered row's stable key, kept alongside the numeric index so a live
  // update that reshapes the list can re-anchor the hover to the same row instead of
  // dropping it (which stranded j/k back at the top — PAP-9679 regression).
  const hoveredNavKeyRef = useRef<string | null>(null);
  const setSelectedIndexFromPointer = useCallback((idx: number) => {
    if (!pointerMovedSinceKeyNavRef.current) return;
    hoveredIndexRef.current = idx;
    hoveredNavKeyRef.current = navEntryKey(flatNavItemsRef.current[idx]);
    // Drop any keyboard selection band the moment the mouse takes over, so we
    // never show two identical highlights at once. React bails out when the
    // value is already -1, so continuous hovering triggers no re-render.
    setSelectedIndex((prev) => (prev < 0 ? prev : -1));
  }, []);

  const invalidateInboxTaskQueryCaches = () => {
    invalidateInboxTaskQueries(queryClient, companyId);
  };

  const archiveTaskMutation = useMutation({
    mutationFn: (id: string) => tasksApi.archiveFromInbox(id),
    onMutate: async (id) => {
      setActionError(null);
      setArchivingTaskIds((prev) => new Set(prev).add(id));

      beginLocalInboxArchive(companyId, id);

      await cancelInboxTaskQueries(queryClient, companyId);
      const previousData = snapshotInboxTaskCaches(queryClient, companyId);
      removeTaskFromInboxCaches(queryClient, companyId, id);

      return { companyId: companyId, previousData };
    },
    onError: (err, id, context) => {
      setActionError(
        err instanceof Error ? err.message : "Failed to archive task",
      );
      if (context?.companyId) clearLocalInboxArchive(context.companyId, id);
      setArchivingTaskIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      // Restore only this failed archive so overlapping archive mutations stay removed.
      if (context?.previousData) {
        restoreTaskToInboxCaches(queryClient, context.previousData, id);
      }
    },
    onSettled: async (_data, error, id, context) => {
      // Clean up archiving state and refetch to sync with server
      setArchivingTaskIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      if (!context?.companyId) return;
      if (!error) boundLocalInboxArchive(context.companyId, id);
      await invalidateInboxTaskQueries(queryClient, context.companyId);
      if (!error) {
        const presence = getTaskPresenceInActiveInboxCaches(
          queryClient,
          context.companyId,
          id,
        );
        if (presence !== "unknown")
          confirmLocalInboxArchive(context.companyId, id);
      }
    },
    onSuccess: (_data, id) => {
      setUndoableArchiveTaskIds((prev) => [
        ...prev.filter((taskId) => taskId !== id),
        id,
      ]);
    },
  });

  const unarchiveTaskMutation = useMutation({
    mutationFn: (id: string) => tasksApi.unarchiveFromInbox(id),
    onMutate: (id) => {
      setActionError(null);
      setUnarchivingTaskIds((prev) => new Set(prev).add(id));
      clearLocalInboxArchive(companyId, id);
      return { companyId: companyId };
    },
    onError: (err, id, context) => {
      setActionError(
        err instanceof Error ? err.message : "Failed to undo inbox archive",
      );
      if (context?.companyId) {
        beginLocalInboxArchive(context.companyId, id);
        boundLocalInboxArchive(context.companyId, id);
      }
    },
    onSuccess: (_data, id) => {
      setUndoableArchiveTaskIds((prev) => {
        const next = prev.filter((taskId) => taskId !== id);
        return next;
      });
    },
    onSettled: (_data, _error, id) => {
      setUnarchivingTaskIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      invalidateInboxTaskQueryCaches();
    },
  });

  const markReadMutation = useMutation({
    mutationFn: (id: string) => tasksApi.markRead(id),
    onMutate: (id) => {
      setFadingOutTasks((prev) => new Set(prev).add(id));
    },
    onSuccess: () => {
      invalidateInboxTaskQueryCaches();
    },
    onSettled: (_data, _error, id) => {
      setTimeout(() => {
        setFadingOutTasks((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }, 300);
    },
  });

  const markAllReadMutation = useMutation({
    mutationFn: async (taskIds: string[]) => {
      await Promise.all(taskIds.map((taskId) => tasksApi.markRead(taskId)));
    },
    onMutate: (taskIds) => {
      setFadingOutTasks((prev) => {
        const next = new Set(prev);
        for (const taskId of taskIds) next.add(taskId);
        return next;
      });
    },
    onSuccess: () => {
      invalidateInboxTaskQueryCaches();
    },
    onSettled: (_data, _error, taskIds) => {
      setTimeout(() => {
        setFadingOutTasks((prev) => {
          const next = new Set(prev);
          for (const taskId of taskIds) next.delete(taskId);
          return next;
        });
      }, 300);
    },
  });

  const markUnreadMutation = useMutation({
    mutationFn: (id: string) => tasksApi.markUnread(id),
    onSuccess: () => {
      invalidateInboxTaskQueryCaches();
    },
  });

  const handleMarkNonTaskRead = useCallback(
    (key: string) => {
      setFadingNonTaskItems((prev) => new Set(prev).add(key));
      markItemRead(key);
      setTimeout(() => {
        setFadingNonTaskItems((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }, 300);
    },
    [markItemRead],
  );

  const handleArchiveNonTask = useCallback(
    (key: string) => {
      setArchivingNonTaskIds((prev) => new Set(prev).add(key));
      setTimeout(() => {
        if (key.startsWith("alert:")) {
          dismissAlert(key);
        } else {
          dismissInboxItem(key);
        }
        setArchivingNonTaskIds((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }, 200);
    },
    [dismissAlert, dismissInboxItem],
  );

  const nonTaskUnreadState = (key: string): NonTaskUnreadState => {
    if (!canArchiveFromTab) return null;
    const isRead = readItems.has(key);
    const isFading = fadingNonTaskItems.has(key);
    if (isFading) return "fading";
    if (!isRead) return "visible";
    return "hidden";
  };

  // Keep selection on the same logical item when the list shape changes —
  // rows archived/refreshed above the selection would otherwise shift the
  // numeric index onto a neighboring row (and Enter would open the wrong
  // task). Falls back to clamping when the item is gone; never auto-selects
  // on initial load.
  const selectedNavKeyRef = useRef<string | null>(null);
  useEffect(() => {
    // A reshaped list invalidates the numeric hover index. Re-anchor it to the
    // same row by key (the inbox updates live, so nulling it here silently
    // broke hover→j/k sync — PAP-9679). Drop it only when the row is gone.
    const hoveredKey = hoveredNavKeyRef.current;
    const nextHovered =
      hoveredKey === null
        ? -1
        : flatNavItems.findIndex((entry) => navEntryKey(entry) === hoveredKey);
    hoveredIndexRef.current = nextHovered >= 0 ? nextHovered : null;
    if (nextHovered < 0) hoveredNavKeyRef.current = null;
    setSelectedIndex((prev) => {
      if (prev < 0)
        return resolveInboxSelectionIndex(prev, flatNavItems.length);
      const prevKey = selectedNavKeyRef.current;
      const keyIndex =
        prevKey === null
          ? -1
          : flatNavItems.findIndex((entry) => navEntryKey(entry) === prevKey);
      return keyIndex >= 0
        ? keyIndex
        : resolveInboxSelectionIndex(prev, flatNavItems.length);
    });
  }, [flatNavItems]);
  useEffect(() => {
    selectedNavKeyRef.current =
      selectedIndex >= 0 ? navEntryKey(flatNavItems[selectedIndex]) : null;
  }, [flatNavItems, selectedIndex]);

  useEffect(() => {
    setUndoableArchiveTaskIds((prev) =>
      prev.filter(
        (taskId) =>
          guardedArchiveTaskIds.has(taskId) || unarchivingTaskIds.has(taskId),
      ),
    );
  }, [guardedArchiveTaskIds, unarchivingTaskIds]);

  useEffect(() => {
    setUndoableArchiveTaskIds([]);
    setUnarchivingTaskIds(new Set());
  }, [companyId]);

  // Use refs for keyboard handler to avoid stale closures
  const kbStateRef = useRef({
    workItems: groupedSections,
    flatNavItems,
    selectedIndex,
    canArchive: canArchiveFromTab,
    nonInboxSearchTaskIds,
    archivingTaskIds,
    undoableArchiveTaskIds,
    unarchivingTaskIds,
    archivingNonTaskIds,
    fadingOutTasks,
    readItems,
  });
  kbStateRef.current = {
    workItems: groupedSections,
    flatNavItems,
    selectedIndex,
    canArchive: canArchiveFromTab,
    nonInboxSearchTaskIds,
    archivingTaskIds,
    undoableArchiveTaskIds,
    unarchivingTaskIds,
    archivingNonTaskIds,
    fadingOutTasks,
    readItems,
  };

  const kbActions = {
    archiveTask: (id: string) => archiveTaskMutation.mutate(id),
    undoArchiveTask: (id: string) => unarchiveTaskMutation.mutate(id),
    archiveNonTask: handleArchiveNonTask,
    markRead: (id: string) => markReadMutation.mutate(id),
    markUnreadTask: (id: string) => markUnreadMutation.mutate(id),
    markNonTaskRead: handleMarkNonTaskRead,
    markNonTaskUnread: markItemUnread,
    setGroupCollapsed,
    setInboxParentCollapsed,
    navigateToTask: (taskNumber: number, state?: TaskDetailLocationState) => {
      void navigate({
        to: "/$companyId/tasks/$taskNumber",
        params: { companyId, taskNumber: String(taskNumber) },
        state,
      });
    },
    navigateToApproval: (approvalId: string) =>
      void navigate({
        to: "/$companyId/approvals/$approvalId",
        params: { companyId, approvalId },
      }),
    navigateToRun: (agentId: string, runId: string) =>
      void navigate({
        to: "/$companyId/agents/$agentId/runs/$runId",
        params: { companyId, agentId, runId },
      }),
  };
  const kbActionsRef = useRef(kbActions);
  kbActionsRef.current = kbActions;

  // Keyboard shortcuts (mail-client style) — single stable listener using refs
  useEffect(() => {
    if (!keyboardShortcutsEnabled) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;

      // Don't capture when typing in inputs/textareas or with modifier keys
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

      const st = kbStateRef.current;
      const act = kbActionsRef.current;

      // Navigation works on every tab; archive/undo (and a/y below) stay
      // scoped to the "mine" tab, the only place items are archivable.
      const undoArchiveAction = !st.canArchive
        ? "none"
        : resolveInboxUndoArchiveKeyAction({
            hasUndoableArchive: st.undoableArchiveTaskIds.length > 0,
            defaultPrevented: e.defaultPrevented,
            key: e.key,
            metaKey: e.metaKey,
            ctrlKey: e.ctrlKey,
            altKey: e.altKey,
            target,
            hasOpenDialog: hasBlockingShortcutDialog(document),
          });
      if (undoArchiveAction === "undo_archive") {
        const taskId =
          st.undoableArchiveTaskIds[st.undoableArchiveTaskIds.length - 1];
        if (!taskId || st.unarchivingTaskIds.has(taskId)) return;
        e.preventDefault();
        act.undoArchiveTask(taskId);
        return;
      }

      const navItems = st.flatNavItems;
      const navCount = navItems.length;
      if (navCount === 0) return;

      /** Resolve the nav entry at an index to a child task or top-level inbox item. */
      const resolveNavEntry = (
        idx: number,
      ): { task?: Task; item?: InboxWorkItem } => {
        const entry = navItems[idx];
        if (!entry) return {};
        if (entry.type === "child") return { task: entry.task };
        if (entry.type === "top") return { item: entry.item };
        return {};
      };

      // The row a keystroke acts on: the hovered row when the mouse has moved
      // since the last key nav (so "hover a row → press a/r/Enter/Arrow" acts on
      // it), otherwise the keyboard selection. Hover no longer writes selection
      // state, so this is what threads the pointer position into every handler.
      const rawHovered = hoveredIndexRef.current;
      const hoveredIndex =
        rawHovered != null && rawHovered >= 0 && rawHovered < navCount
          ? rawHovered
          : -1;
      const fromHover = pointerMovedSinceKeyNavRef.current && hoveredIndex >= 0;
      const effectiveIndex = fromHover ? hoveredIndex : st.selectedIndex;

      switch (e.key) {
        case "j":
        case "ArrowDown": {
          e.preventDefault();
          pointerMovedSinceKeyNavRef.current = false;
          setSelectedIndex(
            getInboxKeyboardSelectionIndex(effectiveIndex, navCount, "next"),
          );
          break;
        }
        case "k":
        case "ArrowUp": {
          e.preventDefault();
          pointerMovedSinceKeyNavRef.current = false;
          setSelectedIndex(
            getInboxKeyboardSelectionIndex(
              effectiveIndex,
              navCount,
              "previous",
            ),
          );
          break;
        }
        case "ArrowLeft":
        case "ArrowRight": {
          if (effectiveIndex < 0 || effectiveIndex >= navCount) return;
          const entry = navItems[effectiveIndex];
          if (!entry) return;
          if (entry.type === "group") {
            e.preventDefault();
            pointerMovedSinceKeyNavRef.current = false;
            setSelectedIndex(effectiveIndex);
            act.setGroupCollapsed(entry.groupKey, e.key === "ArrowLeft");
            break;
          }
          // Parent tasks collapse/expand with the same keys as groups.
          const { task, item } = resolveNavEntry(effectiveIndex);
          const targetTask = task ?? (item?.kind === "task" ? item.task : null);
          if (!targetTask) return;
          const hasChildren = st.workItems.some(
            (group) =>
              (group.childrenByTaskId.get(targetTask.id)?.length ?? 0) > 0,
          );
          if (!hasChildren) return;
          e.preventDefault();
          pointerMovedSinceKeyNavRef.current = false;
          setSelectedIndex(effectiveIndex);
          act.setInboxParentCollapsed(targetTask.id, e.key === "ArrowLeft");
          break;
        }
        case "a":
        case "y": {
          if (!st.canArchive) return;
          if (effectiveIndex < 0 || effectiveIndex >= navCount) return;
          e.preventDefault();
          const { task, item } = resolveNavEntry(effectiveIndex);
          if (task) {
            if (
              !st.nonInboxSearchTaskIds.has(task.id) &&
              !st.archivingTaskIds.has(task.id)
            )
              act.archiveTask(task.id);
          } else if (item) {
            if (item.kind === "task") {
              if (
                !st.nonInboxSearchTaskIds.has(item.task.id) &&
                !st.archivingTaskIds.has(item.task.id)
              ) {
                act.archiveTask(item.task.id);
              }
            } else {
              const key = getInboxWorkItemKey(item);
              if (!st.archivingNonTaskIds.has(key)) act.archiveNonTask(key);
            }
          }
          break;
        }
        case "U": {
          if (!st.canArchive) return;
          if (effectiveIndex < 0 || effectiveIndex >= navCount) return;
          e.preventDefault();
          const { task, item } = resolveNavEntry(effectiveIndex);
          if (task) {
            act.markUnreadTask(task.id);
          } else if (item) {
            if (item.kind === "task") act.markUnreadTask(item.task.id);
            else act.markNonTaskUnread(getInboxWorkItemKey(item));
          }
          break;
        }
        case "r": {
          if (!st.canArchive) return;
          if (effectiveIndex < 0 || effectiveIndex >= navCount) return;
          e.preventDefault();
          const { task, item } = resolveNavEntry(effectiveIndex);
          if (task) {
            if (task.isUnreadForMe && !st.fadingOutTasks.has(task.id))
              act.markRead(task.id);
          } else if (item) {
            if (item.kind === "task") {
              if (
                item.task.isUnreadForMe &&
                !st.fadingOutTasks.has(item.task.id)
              )
                act.markRead(item.task.id);
            } else {
              const key = getInboxWorkItemKey(item);
              if (!st.readItems.has(key)) act.markNonTaskRead(key);
            }
          }
          break;
        }
        case "Enter": {
          if (effectiveIndex < 0 || effectiveIndex >= navCount) return;
          e.preventDefault();
          const { task, item } = resolveNavEntry(effectiveIndex);
          if (task) {
            const detailState = armTaskDetailInboxQuickArchive(
              withTaskDetailHeaderSeed(taskLinkState, task),
            );
            void prefetchTaskDetail(queryClient, task.id, { task });
            act.navigateToTask(task.taskNumber, detailState);
          } else if (item) {
            if (item.kind === "task") {
              const detailState = armTaskDetailInboxQuickArchive(
                withTaskDetailHeaderSeed(taskLinkState, item.task),
              );
              void prefetchTaskDetail(queryClient, item.task.id, {
                task: item.task,
              });
              act.navigateToTask(item.task.taskNumber, detailState);
            } else if (item.kind === "approval") {
              act.navigateToApproval(item.approval.id);
            } else if (item.kind === "failed_run") {
              act.navigateToRun(item.run.targetAgentId, item.run.id);
            }
          }
          break;
        }
        default:
          return;
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [taskLinkState, keyboardShortcutsEnabled]);

  // Scroll selected item into view
  useEffect(() => {
    if (selectedIndex < 0 || !listRef.current) return;
    const rows = listRef.current.querySelectorAll("[data-inbox-item]");
    const row = rows[selectedIndex];
    if (row) row.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const hasRunFailures = failedRuns.length > 0;
  const showCompanyAlerts = shouldShowCompanyAlerts(tab) && showAlertsCategory;
  const showAggregateAgentError =
    showCompanyAlerts &&
    !!dashboard &&
    dashboard.agents.error > 0 &&
    !hasRunFailures &&
    !dismissedAlerts.has("alert:agent-errors");
  const showBudgetAlert =
    showCompanyAlerts &&
    !!dashboard &&
    compareMoneyAmounts(dashboard.costs.monthBudgetAmount, ZERO_AMOUNT) > 0 &&
    dashboard.costs.monthUtilizationPercent >= 80 &&
    !dismissedAlerts.has("alert:budget");
  const hasAlerts = showAggregateAgentError || showBudgetAlert;
  const showWorkItemsSection = totalVisibleWorkItems > 0;
  const showAlertsSection = shouldShowInboxSection({
    tab,
    hasItems: hasAlerts,
    showOnMine: false,
    showOnRecent: false,
    showOnUnread: false,
    showOnAll: hasAlerts,
  });

  const visibleSections = [
    showAlertsSection ? "alerts" : null,
    showWorkItemsSection ? "work_items" : null,
  ].filter((key): key is SectionKey => key !== null);

  const allLoaded =
    !isJoinRequestsLoading &&
    !isApprovalsLoading &&
    !isDashboardLoading &&
    !isTasksLoading &&
    !isMineTasksLoading &&
    !isTouchedTasksLoading &&
    !isRunsLoading;

  const showSeparatorBefore = (key: SectionKey) =>
    visibleSections.indexOf(key) > 0;
  const markAllReadTasks = (
    tab === "mine" ? visibleMineTasks : unreadTouchedTasks
  ).filter(
    (task) =>
      task.isUnreadForMe &&
      !fadingOutTasks.has(task.id) &&
      !archivingTaskIds.has(task.id),
  );
  const unreadTaskIds = markAllReadTasks.map((task) => task.id);
  const canMarkAllRead = unreadTaskIds.length > 0;
  const activeTaskFilterCount = countActiveTaskFilters(taskFilters, true);
  const showGeneralTaskToolbarControls = tab !== "blocked";
  const taskFiltersPopover = (
    <TaskFiltersPopover
      state={taskFilters}
      onChange={updateTaskFilters}
      activeFilterCount={activeTaskFilterCount}
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
      enableRoutineVisibilityFilter
      buttonVariant="outline"
      iconOnly
    />
  );
  return (
    <div className="space-y-6">
      {markAllReadMutation.isPending ? (
        <p className="sr-only" role="status">
          Marking all visible inbox items as read.
        </p>
      ) : null}
      <div className="space-y-2">
        {/* Search — full-width row on mobile, inline on desktop */}
        <div className="relative sm:hidden">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <InboxSearchInput
            value={searchQuery}
            onChange={setSearchQuery}
            className="h-8 w-full pl-8 text-xs"
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Tabs
            value={tab}
            onValueChange={(value) => {
              if (value === "mine") {
                void navigate({
                  to: "/$companyId/inbox",
                  params: { companyId },
                });
              } else if (value === "recent") {
                void navigate({
                  to: "/$companyId/inbox/recent",
                  params: { companyId },
                });
              } else if (value === "unread") {
                void navigate({
                  to: "/$companyId/inbox/unread",
                  params: { companyId },
                });
              } else if (value === "blocked") {
                void navigate({
                  to: "/$companyId/inbox/blocked",
                  params: { companyId },
                });
              } else if (value === "all") {
                void navigate({
                  to: "/$companyId/inbox/all",
                  params: { companyId },
                });
              }
            }}
          >
            <PageTabBar
              items={[
                {
                  value: "mine",
                  label: "Mine",
                },
                {
                  value: "recent",
                  label: "Recent",
                },
                { value: "unread", label: "Unread" },
                { value: "blocked", label: "Blocked" },
                { value: "all", label: "All" },
              ]}
            />
          </Tabs>

          <div className="flex items-center gap-2">
            <div className="relative hidden sm:block">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <InboxSearchInput
                value={searchQuery}
                onChange={setSearchQuery}
                className="h-8 w-(--sz-220px) pl-8 text-xs"
              />
            </div>
            {tab === "blocked" ? (
              <>
                {taskFiltersPopover}
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className={cn(
                        "h-8 w-8 shrink-0",
                        blockedGroupBy !== "none" && "bg-accent",
                      )}
                      title="Group"
                    >
                      <Layers className="h-3.5 w-3.5" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="end" className="w-44 p-0">
                    <div className="space-y-0.5 p-2">
                      {BLOCKED_GROUP_OPTIONS.map(([value, label]) => (
                        <button
                          key={value}
                          type="button"
                          className={cn(
                            "flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-sm",
                            blockedGroupBy === value
                              ? "bg-accent/50 text-foreground"
                              : "text-muted-foreground hover:bg-accent/50",
                          )}
                          onClick={() => setBlockedGroupBy(value)}
                        >
                          <span>{label}</span>
                          {blockedGroupBy === value ? (
                            <Check className="h-3.5 w-3.5" />
                          ) : null}
                        </button>
                      ))}
                    </div>
                  </PopoverContent>
                </Popover>
                <TaskColumnPicker
                  availableColumns={availableTaskColumns}
                  visibleColumnSet={visibleTaskColumnSet}
                  onToggleColumn={toggleTaskColumn}
                  onResetColumns={() =>
                    setTaskColumns(DEFAULT_INBOX_TASK_COLUMNS)
                  }
                  title="Choose which inbox columns stay visible"
                  iconOnly
                />
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      title="Sort"
                    >
                      <ArrowUpDown className="h-3.5 w-3.5" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="end" className="w-48 p-0">
                    <div className="space-y-0.5 p-2">
                      {BLOCKED_SORT_OPTIONS.map(([value, label]) => (
                        <button
                          key={value}
                          type="button"
                          className={cn(
                            "flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-sm",
                            blockedSortBy === value
                              ? "bg-accent/50 text-foreground"
                              : "text-muted-foreground hover:bg-accent/50",
                          )}
                          onClick={() => setBlockedSortBy(value)}
                        >
                          <span>{label}</span>
                          {blockedSortBy === value ? (
                            <Check className="h-3.5 w-3.5" />
                          ) : null}
                        </button>
                      ))}
                    </div>
                  </PopoverContent>
                </Popover>
              </>
            ) : showGeneralTaskToolbarControls ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className={cn(
                    "hidden h-8 w-8 shrink-0 sm:inline-flex",
                    nestingEnabled && "bg-accent",
                  )}
                  onClick={toggleNesting}
                  title={
                    nestingEnabled
                      ? "Disable parent-child nesting"
                      : "Enable parent-child nesting"
                  }
                >
                  <ListTree className="h-3.5 w-3.5" />
                </Button>
                {taskFiltersPopover}
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className={cn(
                        "h-8 w-8 shrink-0",
                        groupBy !== "none" && "bg-accent",
                      )}
                      title="Group"
                    >
                      <Layers className="h-3.5 w-3.5" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="end" className="w-40 p-2">
                    <div className="space-y-0.5">
                      {(
                        [
                          ["none", "None"],
                          ["type", "Type"],
                          ["owner", "Owner"],
                          ["project", "Project"],
                        ] as const
                      ).map(([value, label]) => (
                        <button
                          key={value}
                          type="button"
                          className={cn(
                            "flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-sm",
                            groupBy === value
                              ? "bg-accent/50 text-foreground"
                              : "text-muted-foreground hover:bg-accent/50",
                          )}
                          onClick={() => updateGroupBy(value)}
                        >
                          <span>{label}</span>
                          {groupBy === value ? (
                            <Check className="h-3.5 w-3.5" />
                          ) : null}
                        </button>
                      ))}
                    </div>
                  </PopoverContent>
                </Popover>
                <TaskColumnPicker
                  availableColumns={availableTaskColumns}
                  visibleColumnSet={visibleTaskColumnSet}
                  onToggleColumn={toggleTaskColumn}
                  onResetColumns={() =>
                    setTaskColumns(DEFAULT_INBOX_TASK_COLUMNS)
                  }
                  title="Choose which inbox columns stay visible"
                  iconOnly
                />
                {canMarkAllRead && (
                  <>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 shrink-0"
                      onClick={() => setShowMarkAllReadConfirm(true)}
                      disabled={markAllReadMutation.isPending}
                    >
                      {markAllReadMutation.isPending
                        ? "Marking…"
                        : "Mark all as read"}
                    </Button>
                    <Dialog
                      open={showMarkAllReadConfirm}
                      onOpenChange={setShowMarkAllReadConfirm}
                    >
                      <DialogContent className="sm:max-w-md">
                        <DialogHeader>
                          <DialogTitle>Mark all as read?</DialogTitle>
                          <DialogDescription>
                            This will mark {unreadTaskIds.length} unread{" "}
                            {unreadTaskIds.length === 1 ? "item" : "items"} as
                            read.
                          </DialogDescription>
                        </DialogHeader>
                        <DialogFooter>
                          <Button
                            variant="outline"
                            onClick={() => setShowMarkAllReadConfirm(false)}
                          >
                            Cancel
                          </Button>
                          <Button
                            onClick={() => {
                              setShowMarkAllReadConfirm(false);
                              markAllReadMutation.mutate(unreadTaskIds);
                            }}
                          >
                            Mark all as read
                          </Button>
                        </DialogFooter>
                      </DialogContent>
                    </Dialog>
                  </>
                )}
              </>
            ) : null}
          </div>
        </div>
      </div>

      {tab === "all" && (
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={allCategoryFilter}
            onValueChange={(value) =>
              updateAllCategoryFilter(value as InboxCategoryFilter)
            }
          >
            <SelectTrigger
              aria-label="Filter inbox by category"
              className="h-8 w-(--sz-170px) text-xs"
            >
              <SelectValue placeholder="Category" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="everything">All categories</SelectItem>
              <SelectItem value="tasks_i_touched">My recent tasks</SelectItem>
              <SelectItem value="join_requests">Join requests</SelectItem>
              <SelectItem value="approvals">Approvals</SelectItem>
              <SelectItem value="failed_runs">Failed runs</SelectItem>
              <SelectItem value="alerts">Alerts</SelectItem>
            </SelectContent>
          </Select>

          {showApprovalsCategory && (
            <Select
              value={allApprovalFilter}
              onValueChange={(value) =>
                updateAllApprovalFilter(value as InboxApprovalFilter)
              }
            >
              <SelectTrigger
                aria-label="Filter inbox by approval status"
                className="h-8 w-(--sz-170px) text-xs"
              >
                <SelectValue placeholder="Approval status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All approval statuses</SelectItem>
                <SelectItem value="actionable">Needs action</SelectItem>
                <SelectItem value="resolved">Resolved</SelectItem>
              </SelectContent>
            </Select>
          )}
        </div>
      )}

      {approvalsError && (
        <p className="text-sm text-destructive">{approvalsError.message}</p>
      )}
      {actionError && (
        <p className="text-sm text-destructive" role="alert">
          {actionError}
        </p>
      )}

      {tab === "blocked" ? (
        <BlockedInboxView
          companyId={companyId}
          searchQuery={searchQuery}
          agentNameById={agentById}
          userLabelById={companyUserLabelMap}
          taskLinkState={taskLinkState}
          groupBy={blockedGroupBy}
          sortBy={blockedSortBy}
          taskFilters={taskFilters}
          liveTaskIds={liveTaskIds}
          subtreeLiveCounts={subtreeLiveCounts}
          showStatusColumn={
            visibleTaskColumnSet.has("status") &&
            availableTaskColumnSet.has("status")
          }
          showIdentifierColumn={
            visibleTaskColumnSet.has("id") && availableTaskColumnSet.has("id")
          }
          showUpdatedColumn={
            visibleTaskColumnSet.has("updated") &&
            availableTaskColumnSet.has("updated")
          }
        />
      ) : null}

      {tab !== "blocked" && !allLoaded && visibleSections.length === 0 && (
        <PageSkeleton variant="inbox" />
      )}

      {tab !== "blocked" && allLoaded && visibleSections.length === 0 && (
        <EmptyState
          icon={searchQuery.trim() ? Search : InboxIcon}
          message={
            searchQuery.trim()
              ? "No inbox items match your search."
              : tab === "mine"
                ? "Inbox zero."
                : tab === "unread"
                  ? "No new inbox items."
                  : tab === "recent"
                    ? "No recent inbox items."
                    : "No inbox items match these filters."
          }
        />
      )}

      {tab !== "blocked" && showWorkItemsSection && (
        <>
          {showSeparatorBefore("work_items") && <Separator />}
          <div>
            <div ref={listRef} className="overflow-hidden">
              {(() => {
                const renderInboxTask = ({
                  task,
                  depth,
                  selected,
                  hasChildren = false,
                  isExpanded = false,
                  childCount = 0,
                  collapseParentId = null,
                  allowArchive = canArchiveFromTab,
                }: {
                  task: Task;
                  depth: number;
                  selected: boolean;
                  hasChildren?: boolean;
                  isExpanded?: boolean;
                  childCount?: number;
                  collapseParentId?: string | null;
                  allowArchive?: boolean;
                }) => {
                  const isUnread =
                    task.isUnreadForMe && !fadingOutTasks.has(task.id);
                  const isFading = fadingOutTasks.has(task.id);
                  const isArchiving = archivingTaskIds.has(task.id);
                  const project = task.projectId
                    ? (projectById.get(task.projectId) ?? null)
                    : null;
                  const ownerUserProfile = task.ownerUserId
                    ? (companyUserProfileMap.get(task.ownerUserId) ?? null)
                    : null;
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
                  const isLive = liveTaskIds.has(task.id);
                  const loadedSubtreeLiveCount =
                    subtreeLiveCounts.get(task.id) ?? 0;
                  const liveDescendantCount = resolveTaskLiveDescendantCount(
                    task,
                    loadedSubtreeLiveCount,
                  );
                  const blockerAttention = resolveInboxTaskBlockerAttention(
                    task,
                    {
                      isLive,
                      loadedSubtreeLiveCount,
                    },
                  );
                  const showStatus =
                    visibleTaskColumnSet.has("status") &&
                    availableTaskColumnSet.has("status");
                  const showSubtreeLiveChip = !(
                    showStatus &&
                    task.boardPresentationStatus === "blocked" &&
                    blockerAttention?.state === "covered"
                  );
                  const rowStatusIcon = (
                    <StatusIcon
                      status={task.boardPresentationStatus}
                      blockerAttention={blockerAttention}
                      size="md"
                    />
                  );
                  return (
                    <TaskRow
                      key={`task:${task.id}`}
                      task={task}
                      taskLinkState={taskLinkState}
                      treeGuides={depth}
                      hideDivider={hasChildren && isExpanded}
                      selected={selected}
                      className={
                        isArchiving
                          ? "pointer-events-none -translate-x-4 scale-(--s-0_98) opacity-0 transition-all duration-200 ease-out"
                          : "transition-all duration-200 ease-out"
                      }
                      desktopMetaLeading={
                        <>
                          {nestingEnabled ? (
                            depth === 0 && hasChildren && collapseParentId ? (
                              <button
                                type="button"
                                data-slot="icon-button"
                                className="hidden w-4 shrink-0 items-center justify-center sm:inline-flex"
                                aria-label="Toggle subtasks"
                                aria-expanded={isExpanded}
                                onClick={(event) => {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  toggleInboxParentCollapse(collapseParentId);
                                }}
                              >
                                <ChevronRight
                                  className={cn(
                                    "h-3.5 w-3.5 transition-transform",
                                    isExpanded && "rotate-90",
                                  )}
                                />
                              </button>
                            ) : (
                              // Every non-chevron row reserves this spacer so the
                              // status column lines up under the parent rows'
                              // collapse chevron. (The unread mark-read dot has
                              // its own reserved leading slot in TaskRow, to the
                              // left of this spacer.)
                              <span className="hidden w-4 shrink-0 sm:block" />
                            )
                          ) : null}
                          <InboxTaskMetaLeading
                            task={task}
                            isLive={isLive}
                            subtreeLiveCount={liveDescendantCount}
                            showSubtreeLiveChip={showSubtreeLiveChip}
                            showStatus={showStatus}
                            showIdentifier={
                              visibleTaskColumnSet.has("id") &&
                              availableTaskColumnSet.has("id")
                            }
                            statusSlot={rowStatusIcon}
                          />
                        </>
                      }
                      titleSuffix={
                        hasChildren && !isExpanded && depth === 0 ? (
                          <span className="ml-1.5 text-xs text-muted-foreground">
                            ({childCount} sub-task{childCount !== 1 ? "s" : ""})
                          </span>
                        ) : undefined
                      }
                      mobileMeta={taskActivityText(task).toLowerCase()}
                      mobileLeading={
                        depth === 0 && hasChildren && collapseParentId ? (
                          <button
                            type="button"
                            data-slot="icon-button"
                            aria-label="Toggle subtasks"
                            aria-expanded={isExpanded}
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              toggleInboxParentCollapse(collapseParentId);
                            }}
                          >
                            <ChevronRight
                              className={cn(
                                "h-3.5 w-3.5 transition-transform",
                                isExpanded && "rotate-90",
                              )}
                            />
                          </button>
                        ) : (
                          <StatusIcon
                            status={task.boardPresentationStatus}
                            blockerAttention={blockerAttention}
                            size="md"
                          />
                        )
                      }
                      unreadState={
                        isUnread ? "visible" : isFading ? "fading" : "hidden"
                      }
                      onMarkRead={() => markReadMutation.mutate(task.id)}
                      onArchive={
                        allowArchive
                          ? () => archiveTaskMutation.mutate(task.id)
                          : undefined
                      }
                      archiveDisabled={isArchiving}
                      desktopTrailing={
                        visibleTrailingTaskColumns.length > 0 ? (
                          <InboxTaskTrailingColumns
                            task={task}
                            columns={visibleTrailingTaskColumns}
                            projectName={project?.name ?? null}
                            projectColor={project?.color ?? null}
                            ownerName={agentName(task.ownerAgentId)}
                            ownerUserName={
                              formatOwnerUserLabel(
                                task.ownerUserId,
                                currentUserId,
                                companyUserLabelMap,
                              ) ??
                              ownerUserProfile?.label ??
                              null
                            }
                            ownerUserAvatarUrl={ownerUserProfile?.image ?? null}
                            originatingAgentName={agentName(originatingAgentId)}
                            creatorUserName={
                              originatingUserId
                                ? (companyUserProfileMap.get(originatingUserId)
                                    ?.label ?? null)
                                : null
                            }
                            creatorUserAvatarUrl={
                              originatingUserId
                                ? (companyUserProfileMap.get(originatingUserId)
                                    ?.image ?? null)
                                : null
                            }
                            viaAgentName={
                              originatingViaAgentId
                                ? agentName(originatingViaAgentId)
                                : null
                            }
                            currentUserId={currentUserId}
                            parentIdentifier={
                              task.parentId
                                ? (taskById.get(task.parentId)?.identifier ??
                                  null)
                                : null
                            }
                            parentTitle={
                              task.parentId
                                ? (taskById.get(task.parentId)?.title ?? null)
                                : null
                            }
                          />
                        ) : undefined
                      }
                    />
                  );
                };

                let previousTimestamp = Number.POSITIVE_INFINITY;
                return groupedSections.flatMap((group, groupIndex) => {
                  const elements: ReactNode[] = [];
                  const isGroupCollapsed = collapsedGroupKeys.has(group.key);
                  if (
                    group.searchSection !== "none" &&
                    group.searchSection !==
                      groupedSections[groupIndex - 1]?.searchSection
                  ) {
                    elements.push(
                      <div
                        key={`${group.searchSection}-search-divider`}
                        className="flex items-center gap-3 border-y border-border/70 bg-muted/30 px-4 py-2"
                      >
                        <div className="h-px flex-1 bg-border/80" />
                        <span className="shrink-0 text-(length:--text-micro) font-semibold uppercase tracking-wide text-muted-foreground">
                          {group.searchSection === "archived"
                            ? "Archived"
                            : "Other results"}
                        </span>
                        <div className="h-px flex-1 bg-border/80" />
                      </div>,
                    );
                  }
                  if (group.label) {
                    const groupNavIdx = groupFlatIndex.get(group.key) ?? -1;
                    const isGroupSelected =
                      groupNavIdx >= 0 && selectedIndex === groupNavIdx;
                    const canCreateTaskInGroup = group.displayItems.some(
                      (item) => item.kind === "task",
                    );
                    elements.push(
                      <div
                        key={`group-${group.key}`}
                        data-inbox-item
                        className={cn(groupIndex > 0 && "pt-2")}
                        onFocusCapture={() => {
                          if (groupNavIdx >= 0) setSelectedIndex(groupNavIdx);
                        }}
                        onMouseEnter={() => {
                          if (groupNavIdx >= 0)
                            setSelectedIndexFromPointer(groupNavIdx);
                        }}
                      >
                        {/* Left inset aligns the header chevron with the nested
                            task chevrons. Read rows no longer reserve a
                            mark-read column, so inbox rows sit at pl-1 before
                            their chevron — same as the tasks list. */}
                        <div
                          className={cn(
                            "rounded-lg px-3 sm:pl-0 sm:pr-4",
                            isGroupSelected
                              ? "bg-accent/50"
                              : "hover:bg-accent/50",
                          )}
                        >
                          <TaskGroupHeader
                            label={group.label}
                            collapsible
                            collapsed={isGroupCollapsed}
                            onToggle={() => toggleGroupCollapse(group.key)}
                            trailing={
                              canCreateTaskInGroup ? (
                                <Button
                                  variant="ghost"
                                  size="icon-xs"
                                  className="-mr-2 text-muted-foreground"
                                  title={`New task in ${group.label}`}
                                  aria-label={`New task in ${group.label}`}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    openCreateTaskForGroup(group);
                                  }}
                                >
                                  <Plus className="h-3 w-3" />
                                </Button>
                              ) : null
                            }
                          />
                        </div>
                      </div>,
                    );
                  }
                  if (isGroupCollapsed) return elements;

                  for (
                    let index = 0;
                    index < group.displayItems.length;
                    index += 1
                  ) {
                    const item = group.displayItems[index]!;
                    const navIdx =
                      topFlatIndex.get(
                        `${group.key}:${getInboxWorkItemKey(item)}`,
                      ) ?? 0;
                    const wrapItem = (key: string, child: ReactNode) => (
                      <div
                        key={`sel-${key}`}
                        data-inbox-item
                        className="relative"
                        onFocusCapture={() => setSelectedIndex(navIdx)}
                        onMouseEnter={() => setSelectedIndexFromPointer(navIdx)}
                      >
                        {child}
                      </div>
                    );
                    const todayCutoff = Date.now() - 24 * 60 * 60 * 1000;
                    const showTodayDivider =
                      groupBy === "none" &&
                      item.timestamp > 0 &&
                      item.timestamp < todayCutoff &&
                      previousTimestamp >= todayCutoff;
                    previousTimestamp =
                      item.timestamp > 0 ? item.timestamp : previousTimestamp;
                    if (showTodayDivider) {
                      elements.push(
                        <div
                          key={`today-divider-${group.key}-${index}`}
                          className="my-2 flex items-center gap-3 px-4"
                        >
                          <div className="flex-1 border-t border-zinc-600" />
                          <span className="shrink-0 text-(length:--text-micro) font-medium uppercase tracking-wider text-zinc-500">
                            Earlier
                          </span>
                        </div>,
                      );
                    }
                    const isSelected = selectedIndex === navIdx;

                    if (item.kind === "approval") {
                      const approvalKey = `approval:${item.approval.id}`;
                      const isArchiving = archivingNonTaskIds.has(approvalKey);
                      const row = (
                        <ApprovalInboxRow
                          key={approvalKey}
                          approval={item.approval}
                          selected={isSelected}
                          requesterName={agentName(
                            item.approval.requestedByAgentId,
                          )}
                          onApprove={() =>
                            approveMutation.mutate(item.approval.id)
                          }
                          onReject={() =>
                            rejectMutation.mutate(item.approval.id)
                          }
                          isPending={
                            approveMutation.isPending ||
                            rejectMutation.isPending
                          }
                          unreadState={nonTaskUnreadState(approvalKey)}
                          onMarkRead={() => handleMarkNonTaskRead(approvalKey)}
                          onArchive={
                            canArchiveFromTab
                              ? () => handleArchiveNonTask(approvalKey)
                              : undefined
                          }
                          archiveDisabled={isArchiving}
                          className={
                            isArchiving
                              ? "pointer-events-none -translate-x-4 scale-(--s-0_98) opacity-0 transition-all duration-200 ease-out"
                              : "transition-all duration-200 ease-out"
                          }
                        />
                      );
                      elements.push(
                        wrapItem(
                          approvalKey,
                          canArchiveFromTab ? (
                            <SwipeToArchive
                              key={approvalKey}
                              selected={isSelected}
                              disabled={isArchiving}
                              onArchive={() =>
                                handleArchiveNonTask(approvalKey)
                              }
                            >
                              {row}
                            </SwipeToArchive>
                          ) : (
                            <InboxRowSurface selected={isSelected}>
                              {row}
                            </InboxRowSurface>
                          ),
                        ),
                      );
                      continue;
                    }

                    if (item.kind === "failed_run") {
                      const runKey = `run:${item.run.id}`;
                      const isArchiving = archivingNonTaskIds.has(runKey);
                      const row = (
                        <FailedRunInboxRow
                          key={runKey}
                          run={item.run}
                          selected={isSelected}
                          taskById={taskById}
                          agentName={agentName(item.run.targetAgentId)}
                          agentId={item.run.targetAgentId}
                          onDismiss={() => dismissInboxItem(runKey)}
                          unreadState={nonTaskUnreadState(runKey)}
                          onMarkRead={() => handleMarkNonTaskRead(runKey)}
                          onArchive={
                            canArchiveFromTab
                              ? () => handleArchiveNonTask(runKey)
                              : undefined
                          }
                          archiveDisabled={isArchiving}
                          className={
                            isArchiving
                              ? "pointer-events-none -translate-x-4 scale-(--s-0_98) opacity-0 transition-all duration-200 ease-out"
                              : "transition-all duration-200 ease-out"
                          }
                        />
                      );
                      elements.push(
                        wrapItem(
                          runKey,
                          canArchiveFromTab ? (
                            <SwipeToArchive
                              key={runKey}
                              selected={isSelected}
                              disabled={isArchiving}
                              onArchive={() => handleArchiveNonTask(runKey)}
                            >
                              {row}
                            </SwipeToArchive>
                          ) : (
                            <InboxRowSurface selected={isSelected}>
                              {row}
                            </InboxRowSurface>
                          ),
                        ),
                      );
                      continue;
                    }

                    if (item.kind === "join_request") {
                      const joinKey = `join:${item.joinRequest.id}`;
                      const isArchiving = archivingNonTaskIds.has(joinKey);
                      const row = (
                        <JoinRequestInboxRow
                          key={joinKey}
                          joinRequest={item.joinRequest}
                          onApprove={() =>
                            approveJoinMutation.mutate(item.joinRequest)
                          }
                          onReject={() =>
                            rejectJoinMutation.mutate(item.joinRequest)
                          }
                          isPending={
                            approveJoinMutation.isPending ||
                            rejectJoinMutation.isPending
                          }
                          unreadState={nonTaskUnreadState(joinKey)}
                          onMarkRead={() => handleMarkNonTaskRead(joinKey)}
                          onArchive={
                            canArchiveFromTab
                              ? () => handleArchiveNonTask(joinKey)
                              : undefined
                          }
                          archiveDisabled={isArchiving}
                          className={
                            isArchiving
                              ? "pointer-events-none -translate-x-4 scale-(--s-0_98) opacity-0 transition-all duration-200 ease-out"
                              : "transition-all duration-200 ease-out"
                          }
                        />
                      );
                      elements.push(
                        wrapItem(
                          joinKey,
                          canArchiveFromTab ? (
                            <SwipeToArchive
                              key={joinKey}
                              selected={isSelected}
                              disabled={isArchiving}
                              onArchive={() => handleArchiveNonTask(joinKey)}
                            >
                              {row}
                            </SwipeToArchive>
                          ) : (
                            <InboxRowSurface selected={isSelected}>
                              {row}
                            </InboxRowSurface>
                          ),
                        ),
                      );
                      continue;
                    }

                    const task = item.task;
                    const childTasks =
                      group.childrenByTaskId.get(task.id) ?? [];
                    const hasChildren = childTasks.length > 0;
                    const isExpanded =
                      hasChildren && !collapsedInboxParents.has(task.id);
                    const canArchiveTask =
                      canArchiveFromTab && group.searchSection === "none";
                    const renderChildTaskRows = (
                      children: Task[],
                      depth: number,
                      seen: ReadonlySet<string>,
                    ): ReactNode[] =>
                      children.flatMap((child) => {
                        if (seen.has(child.id)) return [];
                        const nextSeen = new Set(seen);
                        nextSeen.add(child.id);
                        const childNavIdx = childFlatIndex.get(child.id) ?? -1;
                        const isChildSelected = selectedIndex === childNavIdx;
                        const grandchildTasks =
                          group.childrenByTaskId.get(child.id) ?? [];
                        const childHasChildren = grandchildTasks.length > 0;
                        const childIsExpanded =
                          childHasChildren &&
                          !collapsedInboxParents.has(child.id);
                        const childRow = renderInboxTask({
                          task: child,
                          depth,
                          selected: isChildSelected,
                          hasChildren: childHasChildren,
                          isExpanded: childIsExpanded,
                          childCount: grandchildTasks.length,
                          collapseParentId: child.id,
                          allowArchive: canArchiveTask,
                        });
                        const isChildArchiving = archivingTaskIds.has(child.id);
                        const row = (
                          <div
                            key={`sel-task:${child.id}`}
                            data-inbox-item
                            className="relative"
                            onFocusCapture={() => {
                              if (childNavIdx >= 0)
                                setSelectedIndex(childNavIdx);
                            }}
                            onMouseEnter={() => {
                              if (childNavIdx >= 0)
                                setSelectedIndexFromPointer(childNavIdx);
                            }}
                          >
                            {canArchiveTask ? (
                              <SwipeToArchive
                                key={`task:${child.id}`}
                                selected={isChildSelected}
                                disabled={isChildArchiving}
                                onArchive={() =>
                                  archiveTaskMutation.mutate(child.id)
                                }
                              >
                                {childRow}
                              </SwipeToArchive>
                            ) : (
                              <InboxRowSurface selected={isChildSelected}>
                                {childRow}
                              </InboxRowSurface>
                            )}
                          </div>
                        );

                        return childIsExpanded
                          ? [
                              row,
                              ...renderChildTaskRows(
                                grandchildTasks,
                                depth + 1,
                                nextSeen,
                              ),
                            ]
                          : [row];
                      });
                    const parentRow = renderInboxTask({
                      task,
                      depth: 0,
                      selected: isSelected,
                      hasChildren,
                      isExpanded,
                      childCount: childTasks.length,
                      collapseParentId: task.id,
                      allowArchive: canArchiveTask,
                    });

                    elements.push(
                      wrapItem(
                        `task:${task.id}`,
                        canArchiveTask ? (
                          <SwipeToArchive
                            key={`task:${task.id}`}
                            selected={isSelected}
                            disabled={archivingTaskIds.has(task.id)}
                            onArchive={() =>
                              archiveTaskMutation.mutate(task.id)
                            }
                          >
                            {parentRow}
                          </SwipeToArchive>
                        ) : (
                          <InboxRowSurface selected={isSelected}>
                            {parentRow}
                          </InboxRowSurface>
                        ),
                      ),
                    );

                    if (isExpanded) {
                      elements.push(
                        ...renderChildTaskRows(
                          childTasks,
                          1,
                          new Set([task.id]),
                        ),
                      );
                    }
                  }

                  return elements;
                });
              })()}
            </div>
          </div>
        </>
      )}

      {showAlertsSection && (
        <>
          {showSeparatorBefore("alerts") && <Separator />}
          <div>
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Alerts
            </h3>
            <div className="divide-y divide-border border border-border">
              {showAggregateAgentError && (
                <div className="group/alert relative flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/50">
                  <Link
                    to="/$companyId/agents"
                    params={{ companyId }}
                    className="flex flex-1 cursor-pointer items-center gap-3 no-underline text-inherit"
                  >
                    <AlertTriangle className="h-4 w-4 shrink-0 text-red-600 dark:text-red-400" />
                    <span className="text-sm">
                      <span className="font-medium">
                        {dashboard!.agents.error}
                      </span>{" "}
                      {dashboard!.agents.error === 1
                        ? "agent has"
                        : "agents have"}{" "}
                      errors
                    </span>
                  </Link>
                  <button
                    type="button"
                    onClick={() => dismissAlert("alert:agent-errors")}
                    className="rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover/alert:opacity-100"
                    aria-label="Dismiss"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
              {showBudgetAlert && (
                <div className="group/alert relative flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/50">
                  <Link
                    to="/$companyId/costs"
                    params={{ companyId }}
                    className="flex flex-1 cursor-pointer items-center gap-3 no-underline text-inherit"
                  >
                    <AlertTriangle className="h-4 w-4 shrink-0 text-yellow-400" />
                    <span className="text-sm">
                      Budget at{" "}
                      <span className="font-medium">
                        {dashboard!.costs.monthUtilizationPercent}%
                      </span>{" "}
                      utilization this month
                    </span>
                  </Link>
                  <button
                    type="button"
                    onClick={() => dismissAlert("alert:budget")}
                    className="rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover/alert:opacity-100"
                    aria-label="Dismiss"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
