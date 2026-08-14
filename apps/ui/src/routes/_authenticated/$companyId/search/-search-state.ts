import type { ParsedSearchQuery } from "@/lib/search-query-parser";
import {
  assertOnlySearchKeys,
  optionalCanonicalUuidSearch,
  optionalExactIsoTimestampSearch,
  optionalExactSearchString,
  optionalSearchEnum,
  optionalSearchEnumArray,
  optionalSearchPattern,
} from "@/routes/-search";
import {
  COMPANY_SEARCH_MAX_QUERY_LENGTH,
  COMPANY_SEARCH_SCOPES,
  COMPANY_SEARCH_SORTS,
  TASK_PRIORITIES,
  TASK_STATUSES,
  type CompanySearchCountType,
  type CompanySearchResult,
  type CompanySearchScope,
  type CompanySearchSort,
} from "@paperclipai/shared";

export type CompanySearch = {
  q?: string;
  scope?: (typeof COMPANY_SEARCH_SCOPES)[number];
  sort?: (typeof COMPANY_SEARCH_SORTS)[number];
  status?: (typeof TASK_STATUSES)[number][];
  priority?: (typeof TASK_PRIORITIES)[number][];
  ownerAgentId?: string;
  ownerUserId?: string;
  projectId?: string;
  labelId?: string;
  updatedWithin?: string;
  updatedAfter?: string;
};

export const SEARCH_KEYS = [
  "q",
  "scope",
  "sort",
  "status",
  "priority",
  "ownerAgentId",
  "ownerUserId",
  "projectId",
  "labelId",
  "updatedWithin",
  "updatedAfter",
] as const;

export function validateCompanySearch(search: Record<string, unknown>): CompanySearch {
  assertOnlySearchKeys(search, SEARCH_KEYS);
  const validated = {
    q: optionalExactSearchString(search.q, "q", COMPANY_SEARCH_MAX_QUERY_LENGTH),
    scope: optionalSearchEnum(search.scope, COMPANY_SEARCH_SCOPES, "scope"),
    sort: optionalSearchEnum(search.sort, COMPANY_SEARCH_SORTS, "sort"),
    status: optionalSearchEnumArray(search.status, TASK_STATUSES, "status"),
    priority: optionalSearchEnumArray(search.priority, TASK_PRIORITIES, "priority"),
    ownerAgentId: optionalCanonicalUuidSearch(search.ownerAgentId, "ownerAgentId"),
    ownerUserId: optionalExactSearchString(search.ownerUserId, "ownerUserId"),
    projectId: optionalCanonicalUuidSearch(search.projectId, "projectId"),
    labelId: optionalCanonicalUuidSearch(search.labelId, "labelId"),
    updatedWithin: optionalSearchPattern(
      search.updatedWithin,
      "updatedWithin",
      /^[1-9]\d{0,2}(h|d|w|m)$/,
      "must be a duration like 24h, 7d, 4w, or 3m",
    ),
    updatedAfter: optionalExactIsoTimestampSearch(search.updatedAfter, "updatedAfter"),
  };
  if (validated.ownerAgentId !== undefined && validated.ownerUserId !== undefined) {
    throw new Error('Invalid search parameters: "ownerAgentId" and "ownerUserId" are mutually exclusive');
  }
  return validated;
}

export const SEARCH_DEBOUNCE_MS = 250;

export const SCOPE_LABELS: Record<CompanySearchScope, string> = {
  all: "All",
  tasks: "Tasks",
  comments: "Comments",
  documents: "Documents",
  artifacts: "Artifacts",
  agents: "Agents",
  projects: "Projects",
};

export type SubGroupKey = "tasks" | "comments" | "documents" | "artifacts" | "agents" | "projects";

export interface CompanySearchSubgroup {
  key: SubGroupKey;
  results: CompanySearchResult[];
}

export interface CompanySearchError {
  message: string;
  status?: number;
}

export const SUBGROUP_ORDER: SubGroupKey[] = [
  "tasks",
  "comments",
  "documents",
  "artifacts",
  "agents",
  "projects",
];

export const SUBGROUP_LABELS: Record<SubGroupKey, string> = {
  tasks: "Tasks",
  comments: "Comments",
  documents: "Documents",
  artifacts: "Artifacts",
  agents: "Agents",
  projects: "Projects",
};

export function classifyResult(result: CompanySearchResult): SubGroupKey {
  if (result.type === "artifact") return "artifacts";
  if (result.type === "agent") return "agents";
  if (result.type === "project") return "projects";
  const matched = new Set(result.matchedFields);
  if (matched.has("title") || matched.has("identifier") || matched.has("request")) return "tasks";
  if (matched.has("comment")) return "comments";
  if (matched.has("document")) return "documents";
  return "tasks";
}

export function buildSubgroups(results: CompanySearchResult[]): CompanySearchSubgroup[] {
  const buckets = new Map<SubGroupKey, CompanySearchResult[]>();
  for (const result of results) {
    const key = classifyResult(result);
    const list = buckets.get(key) ?? [];
    list.push(result);
    buckets.set(key, list);
  }
  return SUBGROUP_ORDER.filter((key) => (buckets.get(key)?.length ?? 0) > 0).map((key) => ({
    key,
    results: buckets.get(key) ?? [],
  }));
}

export function isCompanySearchScope(value: unknown): value is CompanySearchScope {
  return Boolean(value) && (COMPANY_SEARCH_SCOPES as readonly string[]).includes(value as string);
}

export function describeScope(scope: CompanySearchScope) {
  if (scope === "all") return "All scopes";
  return SCOPE_LABELS[scope];
}

export function totalMatchCount(counts: Partial<Record<CompanySearchCountType, number>>): number {
  return (
    (counts.task ?? 0) +
    (counts.comment ?? 0) +
    (counts.document ?? 0) +
    (counts.artifact ?? 0) +
    (counts.agent ?? 0) +
    (counts.project ?? 0)
  );
}

export function mergeSearchFilters(
  base: ParsedSearchQuery["filters"],
  override: ParsedSearchQuery["filters"],
): ParsedSearchQuery["filters"] {
  const merged = { ...base, ...override };
  if (override.ownerAgentId !== undefined) delete merged.ownerUserId;
  if (override.ownerUserId !== undefined) delete merged.ownerAgentId;
  return merged;
}

export function searchFiltersFromRoute(search: SearchRouteState): ParsedSearchQuery["filters"] {
  const filters: ParsedSearchQuery["filters"] = {};
  if (search.status !== undefined) filters.status = [...search.status];
  if (search.priority !== undefined) filters.priority = [...search.priority];
  if (search.ownerAgentId !== undefined) filters.ownerAgentId = search.ownerAgentId;
  if (search.ownerUserId !== undefined) filters.ownerUserId = search.ownerUserId;
  if (search.projectId !== undefined) filters.projectId = search.projectId;
  if (search.labelId !== undefined) filters.labelId = search.labelId;
  if (search.updatedWithin !== undefined) filters.updatedWithin = search.updatedWithin;
  if (search.updatedAfter !== undefined) filters.updatedAfter = search.updatedAfter;
  return filters;
}

export type SearchRouteState = CompanySearch;

export function buildSearchState(
  query: string,
  scope: CompanySearchScope,
  filters: ParsedSearchQuery["filters"] = {},
  sort: CompanySearchSort = "relevance",
): SearchRouteState {
  const canonicalQuery = query.trim();
  if (filters.ownerAgentId !== undefined && filters.ownerUserId !== undefined) {
    throw new Error("Search filters cannot contain both an agent owner and a user owner");
  }
  return {
    q: canonicalQuery || undefined,
    scope: scope === "all" ? undefined : scope,
    sort: sort === "relevance" ? undefined : sort,
    status: filters.status?.length ? [...filters.status] : undefined,
    priority: filters.priority?.length ? [...filters.priority] : undefined,
    ownerAgentId: filters.ownerAgentId,
    ownerUserId: filters.ownerUserId,
    projectId: filters.projectId,
    labelId: filters.labelId,
    updatedWithin: filters.updatedWithin,
    updatedAfter: filters.updatedAfter,
  };
}

export function shapeError(error: unknown): CompanySearchError {
  if (!error) return { message: "Unknown error" };
  if (error instanceof Error) {
    const status = (error as Error & { status?: number }).status;
    return {
      message: error.message,
      status: typeof status === "number" ? status : undefined,
    };
  }
  return { message: String(error) };
}
