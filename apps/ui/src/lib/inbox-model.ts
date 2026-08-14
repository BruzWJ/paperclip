import type { Approval, JoinRequest, Task, TaskExecutionRunEnvelopeRecord } from "@paperclipai/shared";
import { applyTaskFilters, type TaskFilterState } from "./task-filters";

export const RECENT_TASKS_LIMIT = 100;
export const FAILED_RUN_STATUSES = new Set(["failed", "timed_out"]);
export const ACTIONABLE_APPROVAL_STATUSES = new Set(["pending", "revision_requested"]);
export const DISMISSED_KEY = "paperclip:inbox:dismissed";
export const READ_ITEMS_KEY = "paperclip:inbox:read-items";
export const INBOX_TASK_COLUMNS_KEY = "paperclip:inbox:task-columns";
export const INBOX_NESTING_KEY = "paperclip:inbox:nesting";
export const INBOX_GROUP_BY_KEY = "paperclip:inbox:group-by";
export const INBOX_FILTER_PREFERENCES_KEY_PREFIX = "paperclip:inbox:filters";
export const INBOX_COLLAPSED_GROUPS_KEY_PREFIX = "paperclip:inbox:collapsed-groups";
export type InboxTab = "mine" | "recent" | "unread" | "blocked" | "all";
export type InboxCategoryFilter =
  "everything" | "tasks_i_touched" | "join_requests" | "approvals" | "failed_runs" | "alerts";
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
export const DEFAULT_INBOX_TASK_COLUMNS: InboxTaskColumn[] = ["status", "id", "updated"];
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

export function normalizeTimestamp(value: string | Date | null | undefined): number {
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
  const activityDiff = taskLastActivityTimestamp(b) - taskLastActivityTimestamp(a);
  if (activityDiff !== 0) return activityDiff;
  return normalizeTimestamp(b.updatedAt) - normalizeTimestamp(a.updatedAt);
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
      .filter((item): item is Extract<InboxWorkItem, { kind: "task" }> => item.kind === "task")
      .map((item) => item.task.id),
    ...archivedSearchTasks.map((task) => task.id),
  ]);
  return applyTaskFilters(remoteTasks, taskFilters, enableRoutineVisibilityFilter, liveTaskIds).filter(
    (task) => !visibleTaskIds.has(task.id),
  );
}

export function resolveInboxNestingEnabled(preferenceEnabled: boolean, isMobile: boolean): boolean {
  return preferenceEnabled && !isMobile;
}

export function isMineInboxTab(tab: InboxTab): boolean {
  return tab === "mine";
}

export function shouldShowCompanyAlerts(tab: InboxTab): boolean {
  return tab === "all";
}

export function resolveInboxSelectionIndex(previousIndex: number, itemCount: number): number {
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
  return direction === "next" ? Math.min(previousIndex + 1, itemCount - 1) : Math.max(previousIndex - 1, 0);
}
