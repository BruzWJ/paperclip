import type {
  AttentionItem,
  AttentionProjectRef,
  AttentionSeverity,
  AttentionSourceKind,
  AttentionWorkspaceRef,
} from "@paperclipai/shared";
import {
  ALL_SEVERITIES,
  NO_GROUP_SENTINEL,
  type AttentionFilterOptions,
  type AttentionFilterState,
  type AttentionGroup,
  type AttentionGroupBy,
  type AttentionSortOrder,
} from "./attention-preferences";
import { sourceMeta } from "./attention-presentation";

export function countActiveAttentionFilters(filters: AttentionFilterState): number {
  return (
    filters.sourceKinds.length +
    filters.projectIds.length +
    filters.workspaceIds.length +
    filters.severities.length
  );
}

export function attentionActivityTimestamp(item: AttentionItem): number {
  const ts = new Date(item.activityAt).getTime();
  return Number.isFinite(ts) ? ts : 0;
}

/**
 * Sort by activity time in the requested direction. `rank` is the stable
 * tiebreaker (lower rank = higher priority) so equal-timestamp rows keep the
 * server's escalation order.
 */
export function sortAttentionItems(items: AttentionItem[], order: AttentionSortOrder): AttentionItem[] {
  const sign = order === "oldest" ? -1 : 1;
  return [...items].sort((a, b) => {
    const diff = attentionActivityTimestamp(b) - attentionActivityTimestamp(a);
    if (diff !== 0) return sign * diff;
    return a.rank - b.rank;
  });
}

export function attentionItemMatchesFilters(item: AttentionItem, filters: AttentionFilterState): boolean {
  if (filters.sourceKinds.length > 0 && !filters.sourceKinds.includes(item.sourceKind)) return false;
  if (filters.severities.length > 0 && !filters.severities.includes(item.severity)) return false;
  if (filters.projectIds.length > 0) {
    const projectId = item.project?.id ?? NO_GROUP_SENTINEL;
    if (!filters.projectIds.includes(projectId)) return false;
  }
  if (filters.workspaceIds.length > 0) {
    const workspaceId = item.workspace?.id ?? NO_GROUP_SENTINEL;
    if (!filters.workspaceIds.includes(workspaceId)) return false;
  }
  return true;
}

export function filterAttentionItems(items: AttentionItem[], filters: AttentionFilterState): AttentionItem[] {
  if (countActiveAttentionFilters(filters) === 0) return items;
  return items.filter((item) => attentionItemMatchesFilters(item, filters));
}

/** Distinct filterable dimensions present in the current feed, for the picker. */
export function buildAttentionFilterOptions(items: AttentionItem[]): AttentionFilterOptions {
  const sourceKinds = new Set<AttentionSourceKind>();
  const projects = new Map<string, AttentionProjectRef>();
  const workspaces = new Map<string, AttentionWorkspaceRef>();
  const severities = new Set<AttentionSeverity>();
  let hasNoProject = false;
  let hasNoWorkspace = false;

  for (const item of items) {
    sourceKinds.add(item.sourceKind);
    severities.add(item.severity);
    if (item.project) projects.set(item.project.id, item.project);
    else hasNoProject = true;
    if (item.workspace) workspaces.set(item.workspace.id, item.workspace);
    else hasNoWorkspace = true;
  }

  return {
    sourceKinds: [...sourceKinds].sort((a, b) => sourceMeta(a).label.localeCompare(sourceMeta(b).label)),
    projects: [...projects.values()].sort((a, b) => a.name.localeCompare(b.name)),
    workspaces: [...workspaces.values()].sort((a, b) => a.name.localeCompare(b.name)),
    severities: ALL_SEVERITIES.filter((s) => severities.has(s)),
    hasNoProject,
    hasNoWorkspace,
  };
}

export interface AttentionRenderPlan {
  /** Rows to render per group key (empty for collapsed groups). */
  groupRows: Map<string, AttentionItem[]>;
  snoozedRows: AttentionItem[];
  dismissedRows: AttentionItem[];
  /** True when at least one visible row was left unrendered by the budget. */
  hasMoreRows: boolean;
}

/**
 * Allocate a bounded render budget across the queue in document order — active
 * groups first, then the open curtains (PAP-13784). The feed is uncapped, so
 * the page renders only `limit` rows and grows the budget as the user scrolls;
 * collapsed groups and closed curtains cost nothing.
 */
export function planAttentionRenderRows(options: {
  groups: AttentionGroup[];
  collapsedGroupKeys: ReadonlySet<string>;
  snoozedItems: AttentionItem[];
  snoozedOpen: boolean;
  dismissedItems: AttentionItem[];
  dismissedOpen: boolean;
  limit: number;
}): AttentionRenderPlan {
  let remaining = options.limit;
  let truncated = false;
  const take = (items: AttentionItem[]): AttentionItem[] => {
    const slice = items.slice(0, Math.max(0, remaining));
    remaining -= slice.length;
    if (slice.length < items.length) truncated = true;
    return slice;
  };
  const groupRows = new Map<string, AttentionItem[]>();
  for (const group of options.groups) {
    const collapsed = group.label !== null && options.collapsedGroupKeys.has(group.key);
    groupRows.set(group.key, collapsed ? [] : take(group.items));
  }
  const snoozedRows = options.snoozedOpen ? take(options.snoozedItems) : [];
  const dismissedRows = options.dismissedOpen ? take(options.dismissedItems) : [];
  return { groupRows, snoozedRows, dismissedRows, hasMoreRows: truncated };
}

const DATE_BUCKET_ORDER = ["today", "yesterday", "this_week", "earlier"] as const;
type DateBucket = (typeof DATE_BUCKET_ORDER)[number];

const DATE_BUCKET_LABELS: Record<DateBucket, string> = {
  today: "Today",
  yesterday: "Yesterday",
  this_week: "This week",
  earlier: "Earlier",
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function attentionDateBucket(activityAt: string, now: number): DateBucket {
  const ts = new Date(activityAt).getTime();
  if (!Number.isFinite(ts)) return "earlier";
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const todayStart = startOfToday.getTime();
  if (ts >= todayStart) return "today";
  if (ts >= todayStart - MS_PER_DAY) return "yesterday";
  if (ts >= todayStart - 6 * MS_PER_DAY) return "this_week";
  return "earlier";
}

const SEVERITY_LABEL: Record<AttentionSeverity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};

export function groupAttentionItems(
  items: AttentionItem[],
  groupBy: AttentionGroupBy,
  options: { now?: number } = {},
): AttentionGroup[] {
  if (items.length === 0) return [];

  if (groupBy === "none") {
    return [{ key: "__all", label: null, items }];
  }

  if (groupBy === "date") {
    const now = options.now ?? Date.now();
    const buckets = new Map<DateBucket, AttentionItem[]>();
    for (const item of items) {
      const bucket = attentionDateBucket(item.activityAt, now);
      const list = buckets.get(bucket) ?? [];
      list.push(item);
      buckets.set(bucket, list);
    }
    return DATE_BUCKET_ORDER.filter((bucket) => buckets.has(bucket)).map((bucket) => ({
      key: `date:${bucket}`,
      label: DATE_BUCKET_LABELS[bucket],
      items: buckets.get(bucket)!,
    }));
  }

  if (groupBy === "severity") {
    const buckets = new Map<AttentionSeverity, AttentionItem[]>();
    for (const item of items) {
      const list = buckets.get(item.severity) ?? [];
      list.push(item);
      buckets.set(item.severity, list);
    }
    return ALL_SEVERITIES.filter((severity) => buckets.has(severity)).map((severity) => ({
      key: `severity:${severity}`,
      label: SEVERITY_LABEL[severity],
      items: buckets.get(severity)!,
    }));
  }

  const groups = new Map<string, { label: string; items: AttentionItem[]; latest: number }>();
  for (const item of items) {
    const resolved =
      groupBy === "type"
        ? {
            key: `type:${item.sourceKind}`,
            label: sourceMeta(item.sourceKind).label,
          }
        : item.project
          ? { key: `project:${item.project.id}`, label: item.project.name }
          : { key: `project:${NO_GROUP_SENTINEL}`, label: "No project" };
    const existing = groups.get(resolved.key);
    const timestamp = attentionActivityTimestamp(item);
    if (existing) {
      existing.items.push(item);
      existing.latest = Math.max(existing.latest, timestamp);
    } else {
      groups.set(resolved.key, {
        label: resolved.label,
        items: [item],
        latest: timestamp,
      });
    }
  }

  return [...groups.entries()]
    .sort(([, a], [, b]) => {
      const difference = b.latest - a.latest;
      if (difference !== 0) return difference;
      return a.label.localeCompare(b.label);
    })
    .map(([key, value]) => ({ key, label: value.label, items: value.items }));
}
