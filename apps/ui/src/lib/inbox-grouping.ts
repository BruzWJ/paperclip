import type { Task } from "@paperclipai/shared";
import type {
  InboxGroupedSection,
  InboxGroupingOptions,
  InboxKeyboardGroupSection,
  InboxKeyboardNavEntry,
  InboxSearchSection,
  InboxTab,
  InboxTaskGroupCreateDefaults,
  InboxWorkItem,
  InboxWorkItemGroup,
  InboxWorkItemGroupBy,
} from "./inbox-model";
import { sortTasksByMostRecentActivity, taskLastActivityTimestamp } from "./inbox-model";
import { formatOwnerUserLabel } from "./task-owners";

const inboxWorkItemKindOrder: InboxWorkItem["kind"][] = ["task", "approval", "failed_run", "join_request"];

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
  }: Pick<InboxGroupingOptions, "agentById" | "currentUserId" | "userLabelById">,
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
      label: formatOwnerUserLabel(task.ownerUserId, currentUserId, userLabelById) ?? "User",
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
  const groups = new Map<string, { label: string; items: InboxWorkItem[]; latestTimestamp: number }>();
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
      existing.latestTimestamp = Math.max(existing.latestTimestamp, item.timestamp);
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
    return groupInboxWorkItemsByTaskGroup(items, (task) => resolveTaskOwnerGroup(task, options));
  }

  if (groupBy === "project") {
    return groupInboxWorkItemsByTaskGroup(items, (task) => resolveTaskProjectGroup(task, options));
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
  return groupKey.replace(/^archived-search:/, "").replace(/^other-search:/, "");
}

function firstTaskFromInboxWorkItems(items: InboxWorkItem[]): Task | null {
  return items.find((item): item is InboxWorkItem & { kind: "task" } => item.kind === "task")?.task ?? null;
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
    if (item.kind === "task") taskItems.push(item as InboxWorkItem & { kind: "task" });
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

  const subtreeActivityTimestamp = (task: Task, seen: ReadonlySet<string> = new Set()): number => {
    const ownTimestamp = taskLastActivityTimestamp(task);
    if (seen.has(task.id)) return ownTimestamp;
    const nextSeen = new Set(seen);
    nextSeen.add(task.id);
    const children = childrenByTaskId.get(task.id) ?? [];
    if (children.length === 0) return ownTimestamp;
    return Math.max(ownTimestamp, ...children.map((child) => subtreeActivityTimestamp(child, nextSeen)));
  };

  // Sort each child list by most recent descendant activity, not just direct task activity.
  for (const children of childrenByTaskId.values()) {
    children.sort((a, b) => {
      const activityDiff = subtreeActivityTimestamp(b) - subtreeActivityTimestamp(a);
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
      const maxChildTs = Math.max(...children.map((child) => subtreeActivityTimestamp(child)));
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
