import { eq, gte, inArray, sql, type SQL } from "drizzle-orm";
import { tasks, type Db } from "@paperclipai/db";
import {
  COMPANY_SEARCH_MAX_LIMIT,
  COMPANY_SEARCH_MAX_OFFSET,
  COMPANY_SEARCH_MAX_TOKENS,
  TASK_PRIORITIES,
  type CompanySearchCountType,
  type CompanySearchFilterOptionCounts,
  type CompanySearchQuery,
  type CompanySearchResult,
  type CompanySearchSnippet,
  type CompanySearchTaskFilterKey,
} from "@paperclipai/shared";
import { notFound } from "../errors.js";

export interface CompanySearchScopeContext {
  db: Db;
  companyId: string;
  query: CompanySearchQuery;
  [key: string]: any;
}

export const MIN_TOKEN_LENGTH = 2;

export const MIN_FUZZY_QUERY_LENGTH = 4;

export const MIN_FUZZY_TOKEN_LENGTH = 4;

export // Cap fuzzy edits using the shorter of (query token, title word) so common
// 4–5 letter English words don't sweep in noise (e.g. "serach" vs "each").
const FUZZY_PAIR_LONG_LENGTH = 6;

export const FUZZY_PAIR_LONG_MAX_EDITS = 2;

export const FUZZY_PAIR_MEDIUM_LENGTH = 5;

export const FUZZY_PAIR_MEDIUM_MAX_EDITS = 1;

export const FUZZY_PAIR_SHORT_MAX_EDITS = 0;

export const FUZZY_IDENTIFIER_SIMILARITY_THRESHOLD = 0.45;

export const SNIPPET_MAX_CHARS = 240;

export const TASK_DISPLAY_LABEL_MAX_CHARS = 96;

export const COMPANY_SEARCH_BRANCH_FETCH_LIMIT = COMPANY_SEARCH_MAX_OFFSET + COMPANY_SEARCH_MAX_LIMIT + 1;

export type TaskSearchRow = {
  id: string;
  taskNumber: number;
  identifier: string;
  title: string | null;
  request: string | null;
  status: string;
  priority: string;
  ownerAgentId: string | null;
  ownerUserId: string | null;
  projectId: string | null;
  createdAt: Date;
  updatedAt: Date;
  score: number | string;
  matchedFields: string[] | null;
  commentSnippet: string | null;
  commentId: string | null;
  documentSnippet: string | null;
  documentTitle: string | null;
  documentKey: string | null;
};

export type SimpleSearchRow = {
  id: string;
  title: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type SearchResultWithSort = CompanySearchResult & {
  sortCreatedAt: string | null;
  sortPriorityRank: number;
};

export type SearchAggregateRow = {
  kind: string;
  value: string | null;
  count: number | string;
};

export function normalizeQuery(query: string) {
  return query.trim().replace(/\s+/g, " ").toLowerCase();
}

export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

export function tokenizeQuery(normalizedQuery: string) {
  const matches = normalizedQuery.match(/"[^"]+"|[^\s]+/g) ?? [];
  const tokens: string[] = [];
  for (const match of matches) {
    const token = match.replace(/^"|"$/g, "").replace(/^[^\p{L}\p{N}%_\\-]+|[^\p{L}\p{N}%_\\-]+$/gu, "");
    if (token.length < MIN_TOKEN_LENGTH) continue;
    if (!tokens.includes(token)) tokens.push(token);
    if (tokens.length >= COMPANY_SEARCH_MAX_TOKENS) break;
  }
  return tokens;
}

export function fuzzyEligibleTokens(tokens: string[]): string[] {
  return tokens.filter((token) => token.length >= MIN_FUZZY_TOKEN_LENGTH);
}

export function sqlTextArray(values: string[]) {
  if (values.length === 0) return sql`ARRAY[]::text[]`;
  return sql`ARRAY[${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )}]::text[]`;
}

export function sqlUuidArray(values: string[]) {
  if (values.length === 0) return sql`ARRAY[]::uuid[]`;
  return sql`ARRAY[${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )}]::uuid[]`;
}

export function noMatchSql() {
  return sql<boolean>`false`;
}

export function plainText(value: string | null | undefined) {
  return (value ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[#>*_~|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function taskDisplayLabel(task: Pick<TaskSearchRow, "id" | "identifier" | "title" | "request">) {
  if (task.title) return task.title;
  if (task.identifier) return task.identifier;
  const requestLabel = plainText(task.request);
  if (!requestLabel) return `Task ${task.id}`;
  if (requestLabel.length <= TASK_DISPLAY_LABEL_MAX_CHARS) return requestLabel;
  return `${requestLabel.slice(0, TASK_DISPLAY_LABEL_MAX_CHARS - 3).trimEnd()}...`;
}

export const MARKDOWN_IMAGE_PATTERN = /!\[[^\]]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/;

export function extractFirstImageUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = MARKDOWN_IMAGE_PATTERN.exec(value);
  return match ? match[1] : null;
}

export function findFirstMatchIndex(value: string, terms: string[]) {
  const lower = value.toLowerCase();
  let best = -1;
  for (const term of terms) {
    if (term.length === 0) continue;
    const index = lower.indexOf(term.toLowerCase());
    if (index >= 0 && (best < 0 || index < best)) best = index;
  }
  return best;
}

export function highlightRanges(value: string, terms: string[]) {
  const lower = value.toLowerCase();
  const ranges: Array<{ start: number; end: number }> = [];
  for (const term of terms) {
    const normalized = term.toLowerCase();
    if (normalized.length === 0) continue;
    let index = lower.indexOf(normalized);
    while (index >= 0) {
      const next = { start: index, end: index + normalized.length };
      const overlaps = ranges.some((range) => next.start < range.end && next.end > range.start);
      if (!overlaps) ranges.push(next);
      index = lower.indexOf(normalized, index + normalized.length);
    }
  }
  return ranges.sort((left, right) => left.start - right.start);
}

export function createSnippet(
  field: string,
  label: string,
  source: string | null | undefined,
  terms: string[],
): CompanySearchSnippet | null {
  const text = plainText(source);
  if (!text) return null;
  const firstMatch = findFirstMatchIndex(text, terms);
  const windowStart = firstMatch < 0 ? 0 : Math.max(0, firstMatch - 80);
  const windowEnd = Math.min(text.length, windowStart + SNIPPET_MAX_CHARS);
  const prefix = windowStart > 0 ? "..." : "";
  const suffix = windowEnd < text.length ? "..." : "";
  const slice = text.slice(windowStart, windowEnd).trim();
  const snippetText = `${prefix}${slice}${suffix}`;
  const offset = prefix.length - windowStart;
  return {
    field,
    label,
    text: snippetText,
    highlights: highlightRanges(text, terms)
      .filter((range) => range.end > windowStart && range.start < windowEnd)
      .map((range) => ({
        start: Math.max(0, range.start + offset),
        end: Math.min(snippetText.length, range.end + offset),
      })),
  };
}

export function iso(value: Date | string | null | undefined) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function requireCompany(company: { id: string } | null) {
  if (!company) throw notFound("Company not found");
}

export function matchTerms(normalizedQuery: string, tokens: string[]) {
  return [normalizedQuery, ...tokens].filter(
    (term, index, terms) => term.length > 0 && terms.indexOf(term) === index,
  );
}

export function emptySearchCounts(): Record<CompanySearchCountType, number> {
  return {
    task: 0,
    comment: 0,
    document: 0,
    artifact: 0,
    agent: 0,
    project: 0,
  };
}

export function emptyFilterOptionCounts(): CompanySearchFilterOptionCounts {
  return {
    status: {},
    priority: {},
    ownerAgentId: {},
    ownerUserId: {},
    projectId: {},
    labelId: {},
    updatedWithin: {},
  };
}

export function priorityRank(priority: string | null | undefined) {
  const index = (TASK_PRIORITIES as readonly string[]).indexOf(priority ?? "");
  return index >= 0 ? index : TASK_PRIORITIES.length;
}

export function updatedWithinStart(value: string | undefined, now = new Date()): Date | null {
  if (!value) return null;
  const match = /^(\d+)(h|d|w|m)$/.exec(value);
  if (!match) return null;
  const amount = Number.parseInt(match[1]!, 10);
  const unit = match[2];
  const hours =
    unit === "h" ? amount : unit === "d" ? amount * 24 : unit === "w" ? amount * 24 * 7 : amount * 24 * 30;
  return new Date(now.getTime() - hours * 60 * 60 * 1000);
}

export function taskOnlyFiltersActive(query: CompanySearchQuery) {
  return (
    query.status.length > 0 ||
    query.priority.length > 0 ||
    query.ownerAgentId !== undefined ||
    Boolean(query.ownerUserId) ||
    Boolean(query.projectId) ||
    Boolean(query.labelId) ||
    Boolean(query.updatedWithin) ||
    Boolean(query.updatedAfter)
  );
}

export function activeTaskFilters(
  query: CompanySearchQuery,
): Array<{ key: CompanySearchTaskFilterKey; values: string[] }> {
  const filters: Array<{
    key: CompanySearchTaskFilterKey;
    values: string[];
  }> = [];
  if (query.status.length > 0) filters.push({ key: "status", values: query.status });
  if (query.ownerAgentId !== undefined) filters.push({ key: "ownerAgentId", values: [query.ownerAgentId] });
  if (query.ownerUserId) filters.push({ key: "ownerUserId", values: [query.ownerUserId] });
  if (query.projectId) filters.push({ key: "projectId", values: [query.projectId] });
  if (query.labelId) filters.push({ key: "labelId", values: [query.labelId] });
  if (query.priority.length > 0) filters.push({ key: "priority", values: query.priority });
  if (query.updatedWithin) filters.push({ key: "updatedWithin", values: [query.updatedWithin] });
  if (query.updatedAfter) filters.push({ key: "updatedAfter", values: [query.updatedAfter] });
  return filters;
}

export function queryWithoutFilter(
  query: CompanySearchQuery,
  key: CompanySearchTaskFilterKey,
): CompanySearchQuery {
  return {
    ...query,
    status: key === "status" ? [] : query.status,
    priority: key === "priority" ? [] : query.priority,
    ownerAgentId: key === "ownerAgentId" ? undefined : query.ownerAgentId,
    ownerUserId: key === "ownerUserId" ? undefined : query.ownerUserId,
    projectId: key === "projectId" ? undefined : query.projectId,
    labelId: key === "labelId" ? undefined : query.labelId,
    updatedWithin: key === "updatedWithin" ? undefined : query.updatedWithin,
    updatedAfter: key === "updatedAfter" ? undefined : query.updatedAfter,
  };
}

export function queryWithoutTaskFilters(query: CompanySearchQuery): CompanySearchQuery {
  return {
    ...query,
    status: [],
    priority: [],
    ownerAgentId: undefined,
    ownerUserId: undefined,
    projectId: undefined,
    labelId: undefined,
    updatedWithin: undefined,
    updatedAfter: undefined,
  };
}

export function taskFilterConditions(
  companyId: string,
  query: CompanySearchQuery,
  omit?: CompanySearchTaskFilterKey,
): SQL[] {
  const conditions: SQL[] = [];
  if (omit !== "status" && query.status.length > 0) {
    conditions.push(
      query.status.length === 1
        ? eq(tasks.boardPresentationStatus, query.status[0]!)
        : inArray(tasks.boardPresentationStatus, query.status),
    );
  }
  if (omit !== "priority" && query.priority.length > 0) {
    conditions.push(
      query.priority.length === 1
        ? eq(tasks.priority, query.priority[0]!)
        : inArray(tasks.priority, query.priority),
    );
  }
  if (omit !== "ownerAgentId" && query.ownerAgentId !== undefined) {
    conditions.push(eq(tasks.ownerAgentId, query.ownerAgentId));
  }
  if (omit !== "ownerUserId" && query.ownerUserId) {
    conditions.push(eq(tasks.ownerUserId, query.ownerUserId));
  }
  if (omit !== "projectId" && query.projectId) conditions.push(eq(tasks.projectId, query.projectId));
  if (omit !== "labelId" && query.labelId) {
    conditions.push(sql<boolean>`
      EXISTS (
        SELECT 1
        FROM task_labels search_filter_labels
        WHERE search_filter_labels.company_id = ${companyId}
          AND search_filter_labels.task_id = ${tasks.id}
          AND search_filter_labels.label_id = ${query.labelId}
      )
    `);
  }
  if (omit !== "updatedWithin") {
    const updatedWithin = updatedWithinStart(query.updatedWithin);
    if (updatedWithin) conditions.push(gte(tasks.updatedAt, updatedWithin));
  }
  if (omit !== "updatedAfter" && query.updatedAfter) {
    conditions.push(gte(tasks.updatedAt, new Date(query.updatedAfter)));
  }
  return conditions;
}
