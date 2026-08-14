import type {
  AttentionItem,
  AttentionProjectRef,
  AttentionSeverity,
  AttentionSourceKind,
  AttentionWorkspaceRef,
} from "@paperclipai/shared";

// ---------------------------------------------------------------------------
// Grouping / sorting / filtering (PAP-13408 — Inbox-style toolbar)
//
// The queue defaults to no grouping, sorted by `activityAt` desc, mirroring the
// `InboxWorkItemGroupBy` pattern in `lib/inbox.ts`. All of these are pure
// functions so the page can re-bucket on the client without refetching, and so
// the logic is unit-tested independently of React.
// ---------------------------------------------------------------------------

export type AttentionGroupBy = "none" | "date" | "type" | "project" | "severity";
export type AttentionSortOrder = "newest" | "oldest";

/** Ordered list used to render the group-by picker (label + value). */
export const ATTENTION_GROUP_BY_OPTIONS: ReadonlyArray<[AttentionGroupBy, string]> = [
  ["none", "None"],
  ["date", "Date"],
  ["type", "Type"],
  ["project", "Project"],
  ["severity", "Severity"],
];

export const ATTENTION_SORT_OPTIONS: ReadonlyArray<[AttentionSortOrder, string]> = [
  ["newest", "Newest first"],
  ["oldest", "Oldest first"],
];

/**
 * Filter selections. Empty arrays mean "no filter" (show everything). The
 * `__none__` sentinel represents rows with no project / workspace.
 */
export interface AttentionFilterState {
  sourceKinds: AttentionSourceKind[];
  projectIds: string[];
  workspaceIds: string[];
  severities: AttentionSeverity[];
}

export const NO_GROUP_SENTINEL = "__none__";

export const defaultAttentionFilterState: AttentionFilterState = {
  sourceKinds: [],
  projectIds: [],
  workspaceIds: [],
  severities: [],
};

export interface AttentionGroup {
  key: string;
  label: string | null;
  items: AttentionItem[];
}

export interface AttentionFilterOptions {
  sourceKinds: AttentionSourceKind[];
  projects: AttentionProjectRef[];
  workspaces: AttentionWorkspaceRef[];
  severities: AttentionSeverity[];
  /** True when at least one row has no project (adds a "No project" option). */
  hasNoProject: boolean;
  /** True when at least one row has no workspace. */
  hasNoWorkspace: boolean;
}

export const ATTENTION_GROUP_BY_KEY = "paperclip:attention:group-by";
export const ATTENTION_SORT_KEY = "paperclip:attention:sort";
export const ATTENTION_FILTERS_KEY_PREFIX = "paperclip:attention:filters";
export const ATTENTION_COLLAPSED_GROUPS_KEY_PREFIX = "paperclip:attention:collapsed-groups";

function isAttentionGroupBy(value: unknown): value is AttentionGroupBy {
  return (
    value === "none" || value === "date" || value === "type" || value === "project" || value === "severity"
  );
}

export function loadAttentionGroupBy(): AttentionGroupBy {
  try {
    const raw = localStorage.getItem(ATTENTION_GROUP_BY_KEY);
    return isAttentionGroupBy(raw) ? raw : "none";
  } catch {
    return "none";
  }
}

export function saveAttentionGroupBy(groupBy: AttentionGroupBy) {
  try {
    localStorage.setItem(ATTENTION_GROUP_BY_KEY, groupBy);
  } catch {
    // Ignore localStorage failures.
  }
}

export function loadAttentionSortOrder(): AttentionSortOrder {
  try {
    const raw = localStorage.getItem(ATTENTION_SORT_KEY);
    return raw === "oldest" ? "oldest" : "newest";
  } catch {
    return "newest";
  }
}

export function saveAttentionSortOrder(order: AttentionSortOrder) {
  try {
    localStorage.setItem(ATTENTION_SORT_KEY, order);
  } catch {
    // Ignore localStorage failures.
  }
}

function getAttentionFiltersStorageKey(companyId: string | null | undefined): string | null {
  if (!companyId) return null;
  return `${ATTENTION_FILTERS_KEY_PREFIX}:${companyId}`;
}

function getAttentionCollapsedGroupsStorageKey(companyId: string | null | undefined): string | null {
  if (!companyId) return null;
  return `${ATTENTION_COLLAPSED_GROUPS_KEY_PREFIX}:${companyId}`;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

export const ALL_SEVERITIES: AttentionSeverity[] = ["critical", "high", "medium", "low"];

export function loadAttentionFilters(companyId: string | null | undefined): AttentionFilterState {
  const storageKey = getAttentionFiltersStorageKey(companyId);
  if (!storageKey) return { ...defaultAttentionFilterState };
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return { ...defaultAttentionFilterState };
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      sourceKinds: normalizeStringArray(parsed.sourceKinds) as AttentionSourceKind[],
      projectIds: normalizeStringArray(parsed.projectIds),
      workspaceIds: normalizeStringArray(parsed.workspaceIds),
      severities: normalizeStringArray(parsed.severities).filter((s): s is AttentionSeverity =>
        (ALL_SEVERITIES as string[]).includes(s),
      ),
    };
  } catch {
    return { ...defaultAttentionFilterState };
  }
}

export function saveAttentionFilters(companyId: string | null | undefined, filters: AttentionFilterState) {
  const storageKey = getAttentionFiltersStorageKey(companyId);
  if (!storageKey) return;
  try {
    localStorage.setItem(storageKey, JSON.stringify(filters));
  } catch {
    // Ignore localStorage failures.
  }
}

export function loadCollapsedAttentionGroupKeys(companyId: string | null | undefined): Set<string> {
  const storageKey = getAttentionCollapsedGroupsStorageKey(companyId);
  if (!storageKey) return new Set();
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((e): e is string => typeof e === "string") : []);
  } catch {
    return new Set();
  }
}

export function saveCollapsedAttentionGroupKeys(
  companyId: string | null | undefined,
  groupKeys: ReadonlySet<string>,
) {
  const storageKey = getAttentionCollapsedGroupsStorageKey(companyId);
  if (!storageKey) return;
  try {
    localStorage.setItem(storageKey, JSON.stringify([...groupKeys]));
  } catch {
    // Ignore localStorage failures.
  }
}
