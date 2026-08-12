import {
  compareMoneyAmounts,
  parseMoneyAmount,
  type Approval,
  type DashboardSummary,
  type TaskExecutionRunEnvelopeRecord,
  type InboxDismissal,
  type Task,
  type JoinRequest,
} from "@paperclipai/shared";
import {
  applyTaskFilters,
  defaultTaskFilterState,
  normalizeTaskFilterState,
  type TaskFilterState,
} from "./task-filters";
import { formatOwnerUserLabel } from "./task-owners";

export const RECENT_TASKS_LIMIT = 100;
const ZERO_AMOUNT = parseMoneyAmount("0");
export const FAILED_RUN_STATUSES = new Set(["failed", "timed_out"]);
export const ACTIONABLE_APPROVAL_STATUSES = new Set([
  "pending",
  "revision_requested",
]);
export const DISMISSED_KEY = "paperclip:inbox:dismissed";
export const READ_ITEMS_KEY = "paperclip:inbox:read-items";
export const INBOX_TASK_COLUMNS_KEY = "paperclip:inbox:task-columns";
export const INBOX_NESTING_KEY = "paperclip:inbox:nesting";
export const INBOX_GROUP_BY_KEY = "paperclip:inbox:group-by";
export const INBOX_FILTER_PREFERENCES_KEY_PREFIX = "paperclip:inbox:filters";
export const INBOX_COLLAPSED_GROUPS_KEY_PREFIX =
  "paperclip:inbox:collapsed-groups";
export type InboxTab = "mine" | "recent" | "unread" | "blocked" | "all";
export type InboxCategoryFilter =
  | "everything"
  | "tasks_i_touched"
  | "join_requests"
  | "approvals"
  | "failed_runs"
  | "alerts";
export type InboxApprovalFilter = "all" | "actionable" | "resolved";
export type InboxWorkItemGroupBy = "none" | "type" | "owner" | "project";
export const inboxTaskColumns = [
  "status",
  "id",
  "owner",
  "kickedOffBy",
  "project",
  "parent",
  "labels",
  "updated",
] as const;
export type InboxTaskColumn = (typeof inboxTaskColumns)[number];
export const DEFAULT_INBOX_TASK_COLUMNS: InboxTaskColumn[] = [
  "status",
  "id",
  "updated",
];
export interface InboxFilterPreferences {
  allCategoryFilter: InboxCategoryFilter;
  allApprovalFilter: InboxApprovalFilter;
  taskFilters: TaskFilterState;
}
export type InboxWorkItem =
  | {
      kind: "task";
      timestamp: number;
      task: Task;
    }
  | {
      kind: "approval";
      timestamp: number;
      approval: Approval;
    }
  | {
      kind: "failed_run";
      timestamp: number;
      run: TaskExecutionRunEnvelopeRecord;
    }
  | {
      kind: "join_request";
      timestamp: number;
      joinRequest: JoinRequest;
    };

export interface InboxBadgeData {
  inbox: number;
  approvals: number;
  failedRuns: number;
  joinRequests: number;
  mineTasks: number;
  alerts: number;
}

export interface InboxWorkItemGroup {
  key: string;
  label: string | null;
  items: InboxWorkItem[];
}

export type InboxSearchSection = "none" | "archived" | "other";

export interface InboxGroupedSection {
  key: string;
  label: string | null;
  displayItems: InboxWorkItem[];
  childrenByTaskId: Map<string, Task[]>;
  searchSection: InboxSearchSection;
}

export interface InboxKeyboardGroupSection {
  key: string;
  label?: string | null;
  displayItems: InboxWorkItem[];
  childrenByTaskId: ReadonlyMap<string, Task[]>;
}

export type InboxKeyboardNavEntry =
  | {
      type: "group";
      groupKey: string;
      label: string;
      collapsed: boolean;
    }
  | {
      type: "top";
      itemKey: string;
      item: InboxWorkItem;
    }
  | {
      type: "child";
      taskId: string;
      task: Task;
    };

export interface InboxGroupingOptions {
  projectById?: ReadonlyMap<string, { name: string | null | undefined }>;
  agentById?: ReadonlyMap<string, string | null | undefined>;
  userLabelById?: ReadonlyMap<string, string>;
  currentUserId?: string | null;
}

export interface InboxTaskGroupCreateDefaults {
  projectId?: string;
  ownerAgentId?: string;
}

const defaultInboxFilterPreferences: InboxFilterPreferences = {
  allCategoryFilter: "everything",
  allApprovalFilter: "all",
  taskFilters: defaultTaskFilterState,
};

function normalizeInboxCategoryFilter(value: unknown): InboxCategoryFilter {
  return value === "tasks_i_touched" ||
    value === "join_requests" ||
    value === "approvals" ||
    value === "failed_runs" ||
    value === "alerts"
    ? value
    : "everything";
}

function normalizeInboxApprovalFilter(value: unknown): InboxApprovalFilter {
  return value === "actionable" || value === "resolved" ? value : "all";
}

function getInboxFilterPreferencesStorageKey(
  companyId: string | null | undefined,
): string | null {
  if (!companyId) return null;
  return `${INBOX_FILTER_PREFERENCES_KEY_PREFIX}:${companyId}`;
}

function getInboxCollapsedGroupsStorageKey(
  companyId: string | null | undefined,
): string | null {
  if (!companyId) return null;
  return `${INBOX_COLLAPSED_GROUPS_KEY_PREFIX}:${companyId}`;
}

export function loadInboxFilterPreferences(
  companyId: string | null | undefined,
): InboxFilterPreferences {
  const storageKey = getInboxFilterPreferencesStorageKey(companyId);
  if (!storageKey) {
    return {
      ...defaultInboxFilterPreferences,
      taskFilters: { ...defaultTaskFilterState },
    };
  }

  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) {
      return {
        ...defaultInboxFilterPreferences,
        taskFilters: { ...defaultTaskFilterState },
      };
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      allCategoryFilter: normalizeInboxCategoryFilter(parsed.allCategoryFilter),
      allApprovalFilter: normalizeInboxApprovalFilter(parsed.allApprovalFilter),
      taskFilters: normalizeTaskFilterState(parsed.taskFilters),
    };
  } catch {
    return {
      ...defaultInboxFilterPreferences,
      taskFilters: { ...defaultTaskFilterState },
    };
  }
}

export function saveInboxFilterPreferences(
  companyId: string | null | undefined,
  preferences: InboxFilterPreferences,
) {
  const storageKey = getInboxFilterPreferencesStorageKey(companyId);
  if (!storageKey) return;

  try {
    localStorage.setItem(
      storageKey,
      JSON.stringify({
        allCategoryFilter: normalizeInboxCategoryFilter(
          preferences.allCategoryFilter,
        ),
        allApprovalFilter: normalizeInboxApprovalFilter(
          preferences.allApprovalFilter,
        ),
        taskFilters: normalizeTaskFilterState(preferences.taskFilters),
      }),
    );
  } catch {
    // Ignore localStorage failures.
  }
}

export function loadCollapsedInboxGroupKeys(
  companyId: string | null | undefined,
): Set<string> {
  const storageKey = getInboxCollapsedGroupsStorageKey(companyId);
  if (!storageKey) return new Set();

  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((entry): entry is string => typeof entry === "string")
        : [],
    );
  } catch {
    return new Set();
  }
}

export function saveCollapsedInboxGroupKeys(
  companyId: string | null | undefined,
  groupKeys: ReadonlySet<string>,
) {
  const storageKey = getInboxCollapsedGroupsStorageKey(companyId);
  if (!storageKey) return;

  try {
    localStorage.setItem(storageKey, JSON.stringify([...groupKeys]));
  } catch {
    // Ignore localStorage failures.
  }
}

export function loadDismissedInboxAlerts(): Set<string> {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed.filter(
        (value): value is string =>
          typeof value === "string" && value.startsWith("alert:"),
      ),
    );
  } catch {
    return new Set();
  }
}

export function saveDismissedInboxAlerts(ids: Set<string>) {
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([...ids]));
  } catch {
    // Ignore localStorage failures.
  }
}

export function buildInboxDismissedAtByKey(
  dismissals: InboxDismissal[],
): Map<string, number> {
  return new Map(
    dismissals.map((dismissal) => [
      dismissal.itemKey,
      normalizeTimestamp(dismissal.dismissedAt),
    ]),
  );
}

export function isInboxEntityDismissed(
  dismissedAtByKey: ReadonlyMap<string, number>,
  itemKey: string,
  activityAt: string | Date | null | undefined,
): boolean {
  const dismissedAt = dismissedAtByKey.get(itemKey);
  if (dismissedAt == null) return false;
  return dismissedAt >= normalizeTimestamp(activityAt);
}

export function loadReadInboxItems(): Set<string> {
  try {
    const raw = localStorage.getItem(READ_ITEMS_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}

export function saveReadInboxItems(ids: Set<string>) {
  try {
    localStorage.setItem(READ_ITEMS_KEY, JSON.stringify([...ids]));
  } catch {
    // Ignore localStorage failures.
  }
}

export function normalizeInboxTaskColumns(
  columns: Iterable<string | InboxTaskColumn>,
): InboxTaskColumn[] {
  const selected = new Set(columns);
  return inboxTaskColumns.filter((column) => selected.has(column));
}

export function loadInboxTaskColumns(): InboxTaskColumn[] {
  try {
    const raw = localStorage.getItem(INBOX_TASK_COLUMNS_KEY);
    if (raw === null) return DEFAULT_INBOX_TASK_COLUMNS;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_INBOX_TASK_COLUMNS;
    return normalizeInboxTaskColumns(parsed);
  } catch {
    return DEFAULT_INBOX_TASK_COLUMNS;
  }
}

export function saveInboxTaskColumns(columns: InboxTaskColumn[]) {
  try {
    localStorage.setItem(
      INBOX_TASK_COLUMNS_KEY,
      JSON.stringify(normalizeInboxTaskColumns(columns)),
    );
  } catch {
    // Ignore localStorage failures.
  }
}

export function loadInboxWorkItemGroupBy(): InboxWorkItemGroupBy {
  try {
    const raw = localStorage.getItem(INBOX_GROUP_BY_KEY);
    return raw === "type" || raw === "owner" || raw === "project"
      ? raw
      : "none";
  } catch {
    return "none";
  }
}

export function saveInboxWorkItemGroupBy(groupBy: InboxWorkItemGroupBy) {
  try {
    localStorage.setItem(INBOX_GROUP_BY_KEY, groupBy);
  } catch {
    // Ignore localStorage failures.
  }
}

export function matchesInboxTaskSearch(
  task: Pick<Task, "title" | "identifier" | "request">,
  query: string,
): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return true;
  if (task.title?.toLowerCase().includes(normalizedQuery)) return true;
  if (task.identifier?.toLowerCase().includes(normalizedQuery)) return true;
  if (task.request?.toLowerCase().includes(normalizedQuery)) return true;
  return false;
}

export function getArchivedInboxSearchTasks({
  visibleTasks,
  searchableTasks,
  query,
}: {
  visibleTasks: Task[];
  searchableTasks: Task[];
  query: string;
}): Task[] {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return [];

  const visibleTaskIds = new Set(visibleTasks.map((task) => task.id));
  return searchableTasks
    .filter((task) => !visibleTaskIds.has(task.id))
    .filter((task) => matchesInboxTaskSearch(task, normalizedQuery))
    .sort(sortTasksByMostRecentActivity);
}

export function getInboxSearchSupplementTasks({
  query,
  filteredWorkItems,
  archivedSearchTasks,
  remoteTasks,
  taskFilters,
  enableRoutineVisibilityFilter = false,
  liveTaskIds,
}: {
  query: string;
  filteredWorkItems: InboxWorkItem[];
  archivedSearchTasks: Task[];
  remoteTasks: Task[];
  taskFilters: TaskFilterState;
  enableRoutineVisibilityFilter?: boolean;
  liveTaskIds?: ReadonlySet<string>;
}): Task[] {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return [];
  const visibleTaskIds = new Set([
    ...filteredWorkItems
      .filter(
        (item): item is Extract<InboxWorkItem, { kind: "task" }> =>
          item.kind === "task",
      )
      .map((item) => item.task.id),
    ...archivedSearchTasks.map((task) => task.id),
  ]);
  return applyTaskFilters(
    remoteTasks,
    taskFilters,
    enableRoutineVisibilityFilter,
    liveTaskIds,
  ).filter((task) => !visibleTaskIds.has(task.id));
}

export function loadInboxNesting(): boolean {
  try {
    const raw = localStorage.getItem(INBOX_NESTING_KEY);
    return raw !== "false";
  } catch {
    return true;
  }
}

export function saveInboxNesting(enabled: boolean) {
  try {
    localStorage.setItem(INBOX_NESTING_KEY, String(enabled));
  } catch {
    // Ignore localStorage failures.
  }
}

export function resolveInboxNestingEnabled(
  preferenceEnabled: boolean,
  isMobile: boolean,
): boolean {
  return preferenceEnabled && !isMobile;
}

export function isMineInboxTab(tab: InboxTab): boolean {
  return tab === "mine";
}

export function shouldShowCompanyAlerts(tab: InboxTab): boolean {
  return tab === "all";
}

export function resolveInboxSelectionIndex(
  previousIndex: number,
  itemCount: number,
): number {
  if (itemCount === 0) return -1;
  if (previousIndex < 0) return -1;
  return Math.min(previousIndex, itemCount - 1);
}

export function getInboxKeyboardSelectionIndex(
  previousIndex: number,
  itemCount: number,
  direction: "next" | "previous",
): number {
  if (itemCount === 0) return -1;
  if (previousIndex < 0) return 0;
  return direction === "next"
    ? Math.min(previousIndex + 1, itemCount - 1)
    : Math.max(previousIndex - 1, 0);
}

export function getLatestFailedRunsByAgent(
  runs: TaskExecutionRunEnvelopeRecord[],
): TaskExecutionRunEnvelopeRecord[] {
  const sorted = [...runs].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
  const latestByAgent = new Map<string, TaskExecutionRunEnvelopeRecord>();

  for (const run of sorted) {
    const agentKey = run.targetAgentId;
    if (!latestByAgent.has(agentKey)) {
      latestByAgent.set(agentKey, run);
    }
  }

  return Array.from(latestByAgent.values()).filter((run) =>
    FAILED_RUN_STATUSES.has(run.status),
  );
}

export function normalizeTimestamp(
  value: string | Date | null | undefined,
): number {
  if (!value) return 0;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function taskLastActivityTimestamp(task: Task): number {
  const lastActivityAt = normalizeTimestamp(task.lastActivityAt);
  if (lastActivityAt > 0) return lastActivityAt;

  const lastExternalCommentAt = normalizeTimestamp(task.lastExternalCommentAt);
  if (lastExternalCommentAt > 0) return lastExternalCommentAt;

  return normalizeTimestamp(task.updatedAt);
}

export function sortTasksByMostRecentActivity(a: Task, b: Task): number {
  const activityDiff =
    taskLastActivityTimestamp(b) - taskLastActivityTimestamp(a);
  if (activityDiff !== 0) return activityDiff;
  return normalizeTimestamp(b.updatedAt) - normalizeTimestamp(a.updatedAt);
}

export function getRecentTouchedTasks(tasks: Task[]): Task[] {
  return [...tasks]
    .sort(sortTasksByMostRecentActivity)
    .slice(0, RECENT_TASKS_LIMIT);
}

export function getApprovalsForTab(
  approvals: Approval[],
  tab: InboxTab,
  filter: InboxApprovalFilter,
  currentUserId?: string | null,
): Approval[] {
  const sortedApprovals = [...approvals].sort(
    (a, b) => normalizeTimestamp(b.updatedAt) - normalizeTimestamp(a.updatedAt),
  );

  if (tab === "mine") {
    return sortedApprovals.filter((approval) =>
      isApprovalVisibleInMine(approval, currentUserId),
    );
  }
  if (tab === "recent") return sortedApprovals;
  if (tab === "unread") {
    return sortedApprovals.filter((approval) =>
      ACTIONABLE_APPROVAL_STATUSES.has(approval.status),
    );
  }
  if (filter === "all") return sortedApprovals;

  return sortedApprovals.filter((approval) => {
    const isActionable = ACTIONABLE_APPROVAL_STATUSES.has(approval.status);
    return filter === "actionable" ? isActionable : !isActionable;
  });
}

export function isApprovalVisibleInMine(
  approval: Approval,
  currentUserId?: string | null,
): boolean {
  if (ACTIONABLE_APPROVAL_STATUSES.has(approval.status)) return true;
  if (!currentUserId) return false;
  return (
    approval.requestedByUserId === currentUserId ||
    approval.decidedByUserId === currentUserId
  );
}

export function approvalActivityTimestamp(approval: Approval): number {
  const updatedAt = normalizeTimestamp(approval.updatedAt);
  if (updatedAt > 0) return updatedAt;
  return normalizeTimestamp(approval.createdAt);
}

export function getInboxWorkItems({
  tasks,
  approvals,
  failedRuns = [],
  joinRequests = [],
}: {
  tasks: Task[];
  approvals: Approval[];
  failedRuns?: TaskExecutionRunEnvelopeRecord[];
  joinRequests?: JoinRequest[];
}): InboxWorkItem[] {
  return [
    ...tasks.map((task) => ({
      kind: "task" as const,
      timestamp: taskLastActivityTimestamp(task),
      task,
    })),
    ...approvals.map((approval) => ({
      kind: "approval" as const,
      timestamp: approvalActivityTimestamp(approval),
      approval,
    })),
    ...failedRuns.map((run) => ({
      kind: "failed_run" as const,
      timestamp: normalizeTimestamp(run.createdAt),
      run,
    })),
    ...joinRequests.map((joinRequest) => ({
      kind: "join_request" as const,
      timestamp: normalizeTimestamp(joinRequest.createdAt),
      joinRequest,
    })),
  ].sort((a, b) => {
    const timestampDiff = b.timestamp - a.timestamp;
    if (timestampDiff !== 0) return timestampDiff;

    if (a.kind === "task" && b.kind === "task") {
      return sortTasksByMostRecentActivity(a.task, b.task);
    }
    if (a.kind === "approval" && b.kind === "approval") {
      return (
        approvalActivityTimestamp(b.approval) -
        approvalActivityTimestamp(a.approval)
      );
    }

    return a.kind === "approval" ? -1 : 1;
  });
}

const inboxWorkItemKindOrder: InboxWorkItem["kind"][] = [
  "task",
  "approval",
  "failed_run",
  "join_request",
];

const inboxWorkItemKindLabels: Record<InboxWorkItem["kind"], string> = {
  task: "Tasks",
  approval: "Approvals",
  failed_run: "Failed runs",
  join_request: "Join requests",
};

function resolveTaskOwnerGroup(
  task: Pick<Task, "ownerKind" | "ownerAgentId" | "ownerUserId">,
  {
    agentById,
    currentUserId,
    userLabelById,
  }: Pick<
    InboxGroupingOptions,
    "agentById" | "currentUserId" | "userLabelById"
  >,
): { key: string; label: string } {
  if (task.ownerAgentId) {
    const agentName = agentById?.get(task.ownerAgentId)?.trim();
    return {
      key: `owner:agent:${task.ownerAgentId}`,
      label: agentName || task.ownerAgentId.slice(0, 8),
    };
  }

  if (task.ownerUserId) {
    return {
      key: `owner:user:${task.ownerUserId}`,
      label:
        formatOwnerUserLabel(task.ownerUserId, currentUserId, userLabelById) ??
        "User",
    };
  }

  return { key: "owner:board", label: "Board escalation" };
}

function resolveTaskProjectGroup(
  task: Pick<Task, "projectId">,
  { projectById }: Pick<InboxGroupingOptions, "projectById">,
): { key: string; label: string } {
  if (!task.projectId) return { key: "project:none", label: "No project" };

  const projectName = projectById?.get(task.projectId)?.name?.trim();
  return {
    key: `project:${task.projectId}`,
    label: projectName || task.projectId.slice(0, 8),
  };
}

function groupInboxWorkItemsByTaskGroup(
  items: InboxWorkItem[],
  resolveTaskGroup: (task: Task) => { key: string; label: string },
): InboxWorkItemGroup[] {
  const groups = new Map<
    string,
    { label: string; items: InboxWorkItem[]; latestTimestamp: number }
  >();
  for (const item of items) {
    const resolvedGroup =
      item.kind === "task"
        ? resolveTaskGroup(item.task)
        : {
            key: `kind:${item.kind}`,
            label: inboxWorkItemKindLabels[item.kind],
          };
    const existing = groups.get(resolvedGroup.key);
    if (existing) {
      existing.items.push(item);
      existing.latestTimestamp = Math.max(
        existing.latestTimestamp,
        item.timestamp,
      );
    } else {
      groups.set(resolvedGroup.key, {
        label: resolvedGroup.label,
        items: [item],
        latestTimestamp: item.timestamp,
      });
    }
  }

  return [...groups.entries()]
    .map(([key, value]) => ({
      key,
      label: value.label,
      items: value.items,
      latestTimestamp: value.latestTimestamp,
    }))
    .sort((a, b) => {
      const timestampDiff = b.latestTimestamp - a.latestTimestamp;
      if (timestampDiff !== 0) return timestampDiff;
      return a.label.localeCompare(b.label);
    })
    .map(({ key, label, items: groupItems }) => ({
      key,
      label,
      items: groupItems,
    }));
}

export function groupInboxWorkItems(
  items: InboxWorkItem[],
  groupBy: InboxWorkItemGroupBy,
  options: InboxGroupingOptions = {},
): InboxWorkItemGroup[] {
  if (groupBy === "none") {
    return [{ key: "__all", label: null, items }];
  }

  if (groupBy === "owner") {
    return groupInboxWorkItemsByTaskGroup(items, (task) =>
      resolveTaskOwnerGroup(task, options),
    );
  }

  if (groupBy === "project") {
    return groupInboxWorkItemsByTaskGroup(items, (task) =>
      resolveTaskProjectGroup(task, options),
    );
  }

  const groups = new Map<InboxWorkItem["kind"], InboxWorkItem[]>();
  for (const item of items) {
    const existing = groups.get(item.kind) ?? [];
    existing.push(item);
    groups.set(item.kind, existing);
  }

  const orderedGroups: InboxWorkItemGroup[] = [];
  for (const kind of inboxWorkItemKindOrder) {
    const groupItems = groups.get(kind) ?? [];
    if (groupItems.length === 0) continue;
    orderedGroups.push({
      key: kind,
      label: inboxWorkItemKindLabels[kind],
      items: groupItems,
    });
  }
  return orderedGroups;
}

function stripInboxSearchGroupPrefix(groupKey: string) {
  return groupKey
    .replace(/^archived-search:/, "")
    .replace(/^other-search:/, "");
}

function firstTaskFromInboxWorkItems(items: InboxWorkItem[]): Task | null {
  return (
    items.find(
      (item): item is InboxWorkItem & { kind: "task" } => item.kind === "task",
    )?.task ?? null
  );
}

export function buildInboxTaskGroupCreateDefaults(
  groupKey: string,
  groupBy: InboxWorkItemGroupBy,
  items: InboxWorkItem[],
): InboxTaskGroupCreateDefaults | null {
  const fallbackTask = firstTaskFromInboxWorkItems(items);
  if (!fallbackTask) return null;

  const key = stripInboxSearchGroupPrefix(groupKey);
  if (groupBy === "project") {
    if (!key.startsWith("project:")) return {};
    const projectId = key.slice("project:".length);
    return projectId && projectId !== "none" ? { projectId } : {};
  }

  if (groupBy === "owner") {
    if (key.startsWith("owner:agent:")) {
      const ownerAgentId = key.slice("owner:agent:".length);
      return ownerAgentId ? { ownerAgentId } : {};
    }
    return {};
  }

  return {};
}

/**
 * Groups parent-child tasks in a flat InboxWorkItem list.
 *
 * - Children whose parent is also in the list are removed from the top level
 *   and stored in `childrenByTaskId`.
 * - The parent's sort timestamp becomes max(parent, children) so that a group
 *   with a recently-updated child floats to the top.
 * - If a parent is absent (e.g. archived), children remain as independent roots.
 */
export function buildInboxNesting(items: InboxWorkItem[]): {
  displayItems: InboxWorkItem[];
  childrenByTaskId: Map<string, Task[]>;
} {
  const taskItems: (InboxWorkItem & { kind: "task" })[] = [];
  const nonTaskItems: InboxWorkItem[] = [];
  for (const item of items) {
    if (item.kind === "task")
      taskItems.push(item as InboxWorkItem & { kind: "task" });
    else nonTaskItems.push(item);
  }

  const taskIdSet = new Set(taskItems.map((i) => i.task.id));
  const childrenByTaskId = new Map<string, Task[]>();
  const childIds = new Set<string>();

  for (const item of taskItems) {
    const { task } = item;
    if (task.parentId && taskIdSet.has(task.parentId)) {
      childIds.add(task.id);
      const arr = childrenByTaskId.get(task.parentId) ?? [];
      arr.push(task);
      childrenByTaskId.set(task.parentId, arr);
    }
  }

  const subtreeActivityTimestamp = (
    task: Task,
    seen: ReadonlySet<string> = new Set(),
  ): number => {
    const ownTimestamp = taskLastActivityTimestamp(task);
    if (seen.has(task.id)) return ownTimestamp;
    const nextSeen = new Set(seen);
    nextSeen.add(task.id);
    const children = childrenByTaskId.get(task.id) ?? [];
    if (children.length === 0) return ownTimestamp;
    return Math.max(
      ownTimestamp,
      ...children.map((child) => subtreeActivityTimestamp(child, nextSeen)),
    );
  };

  // Sort each child list by most recent descendant activity, not just direct task activity.
  for (const children of childrenByTaskId.values()) {
    children.sort((a, b) => {
      const activityDiff =
        subtreeActivityTimestamp(b) - subtreeActivityTimestamp(a);
      if (activityDiff !== 0) return activityDiff;
      return sortTasksByMostRecentActivity(a, b);
    });
  }

  // Build root task items with group-adjusted timestamps
  const rootTaskItems: InboxWorkItem[] = taskItems
    .filter((item) => !childIds.has(item.task.id))
    .map((item) => {
      const children = childrenByTaskId.get(item.task.id);
      if (!children?.length) return item;
      const maxChildTs = Math.max(
        ...children.map((child) => subtreeActivityTimestamp(child)),
      );
      return { ...item, timestamp: Math.max(item.timestamp, maxChildTs) };
    });

  // Merge and re-sort
  const displayItems = [...rootTaskItems, ...nonTaskItems].sort((a, b) => {
    const diff = b.timestamp - a.timestamp;
    if (diff !== 0) return diff;
    if (a.kind === "task" && b.kind === "task") {
      return sortTasksByMostRecentActivity(a.task, b.task);
    }
    return 0;
  });

  return { displayItems, childrenByTaskId };
}

export function buildGroupedInboxSections(
  items: InboxWorkItem[],
  groupBy: InboxWorkItemGroupBy,
  grouping: InboxGroupingOptions,
  options?: {
    keyPrefix?: string;
    searchSection?: InboxSearchSection;
    nestingEnabled?: boolean;
  },
): InboxGroupedSection[] {
  const keyPrefix = options?.keyPrefix ?? "";
  const searchSection = options?.searchSection ?? "none";
  const nestingEnabled = options?.nestingEnabled ?? false;

  return groupInboxWorkItems(items, groupBy, grouping).map((group) => {
    const nestedGroup =
      nestingEnabled && group.items.some((item) => item.kind === "task")
        ? buildInboxNesting(group.items)
        : {
            displayItems: group.items,
            childrenByTaskId: new Map<string, Task[]>(),
          };

    return {
      key: `${keyPrefix}${group.key}`,
      label: group.label,
      displayItems: nestedGroup.displayItems,
      childrenByTaskId: nestedGroup.childrenByTaskId,
      searchSection,
    };
  });
}

export function getInboxWorkItemKey(item: InboxWorkItem): string {
  if (item.kind === "task") return `task:${item.task.id}`;
  if (item.kind === "approval") return `approval:${item.approval.id}`;
  if (item.kind === "failed_run") return `run:${item.run.id}`;
  return `join:${item.joinRequest.id}`;
}

export function buildInboxKeyboardNavEntries(
  groupedSections: ReadonlyArray<InboxKeyboardGroupSection>,
  collapsedGroupKeys: ReadonlySet<string>,
  collapsedInboxParents: ReadonlySet<string>,
): InboxKeyboardNavEntry[] {
  const entries: InboxKeyboardNavEntry[] = [];

  for (const group of groupedSections) {
    const isCollapsed = collapsedGroupKeys.has(group.key);
    if (group.label) {
      entries.push({
        type: "group",
        groupKey: group.key,
        label: group.label,
        collapsed: isCollapsed,
      });
    }
    if (isCollapsed) continue;

    const addTaskChildren = (taskId: string, seen: ReadonlySet<string>) => {
      const children = group.childrenByTaskId.get(taskId);
      if (!children?.length || collapsedInboxParents.has(taskId)) return;

      for (const child of children) {
        if (seen.has(child.id)) continue;
        const nextSeen = new Set(seen);
        nextSeen.add(child.id);
        entries.push({
          type: "child",
          taskId: child.id,
          task: child,
        });
        addTaskChildren(child.id, nextSeen);
      }
    };

    for (const item of group.displayItems) {
      entries.push({
        type: "top",
        itemKey: `${group.key}:${getInboxWorkItemKey(item)}`,
        item,
      });

      if (item.kind !== "task") continue;
      addTaskChildren(item.task.id, new Set([item.task.id]));
    }
  }

  return entries;
}

export function shouldShowInboxSection({
  tab,
  hasItems,
  showOnMine,
  showOnRecent,
  showOnUnread,
  showOnAll,
}: {
  tab: InboxTab;
  hasItems: boolean;
  showOnMine: boolean;
  showOnRecent: boolean;
  showOnUnread: boolean;
  showOnAll: boolean;
}): boolean {
  if (!hasItems) return false;
  if (tab === "mine") return showOnMine;
  if (tab === "recent") return showOnRecent;
  if (tab === "unread") return showOnUnread;
  return showOnAll;
}

export function computeInboxBadgeData({
  approvals,
  joinRequests,
  dashboard,
  runs,
  mineTasks,
  dismissedAlerts,
  dismissedAtByKey,
  currentUserId,
}: {
  approvals: Approval[];
  joinRequests: JoinRequest[];
  dashboard: DashboardSummary | undefined;
  runs: TaskExecutionRunEnvelopeRecord[];
  mineTasks: Task[];
  dismissedAlerts: Set<string>;
  dismissedAtByKey: ReadonlyMap<string, number>;
  currentUserId?: string | null;
}): InboxBadgeData {
  const actionableApprovals = approvals.filter(
    (approval) =>
      isApprovalVisibleInMine(approval, currentUserId) &&
      ACTIONABLE_APPROVAL_STATUSES.has(approval.status) &&
      !isInboxEntityDismissed(
        dismissedAtByKey,
        `approval:${approval.id}`,
        approval.updatedAt,
      ),
  ).length;
  const failedRuns = getLatestFailedRunsByAgent(runs).filter(
    (run) =>
      !isInboxEntityDismissed(dismissedAtByKey, `run:${run.id}`, run.createdAt),
  ).length;
  const visibleJoinRequests = joinRequests.filter(
    (jr) =>
      !isInboxEntityDismissed(
        dismissedAtByKey,
        `join:${jr.id}`,
        jr.updatedAt ?? jr.createdAt,
      ),
  ).length;
  const visibleMineTasks = mineTasks.filter(
    (task) => task.isUnreadForMe,
  ).length;
  const agentErrorCount = dashboard?.agents.error ?? 0;
  const monthBudgetAmount = dashboard?.costs.monthBudgetAmount ?? ZERO_AMOUNT;
  const monthUtilizationPercent = dashboard?.costs.monthUtilizationPercent ?? 0;
  const showAggregateAgentError =
    agentErrorCount > 0 &&
    failedRuns === 0 &&
    !dismissedAlerts.has("alert:agent-errors");
  const showBudgetAlert =
    compareMoneyAmounts(monthBudgetAmount, ZERO_AMOUNT) > 0 &&
    monthUtilizationPercent >= 80 &&
    !dismissedAlerts.has("alert:budget");
  const alerts = Number(showAggregateAgentError) + Number(showBudgetAlert);

  return {
    // The inbox badge reflects personal/actionable work, not company-wide health alerts.
    inbox:
      actionableApprovals + visibleJoinRequests + failedRuns + visibleMineTasks,
    approvals: actionableApprovals,
    failedRuns,
    joinRequests: visibleJoinRequests,
    mineTasks: visibleMineTasks,
    alerts,
  };
}
