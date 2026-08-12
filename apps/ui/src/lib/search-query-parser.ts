import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  isCanonicalUuid,
  type TaskPriority,
  type TaskStatus,
} from "@paperclipai/shared";
import type { CompanySearchParams } from "@/api/search";

const OPEN_STATUSES: TaskStatus[] = ["backlog", "todo", "in_progress", "in_review", "blocked"];
const CLOSED_STATUSES: TaskStatus[] = ["done", "cancelled"];

export type SearchOperatorKey = "status" | "owner" | "project" | "label" | "priority" | "updated" | "is";

export interface SearchOperatorPill {
  key: SearchOperatorKey;
  value: string;
  label: string;
}

export interface SearchOperatorSuggestion {
  token: string;
  label: string;
  description: string;
}

export const SEARCH_OPERATOR_QUICK_FILTERS = ["is:open", "updated:>7d"] as const;

export const SEARCH_OPERATOR_SUGGESTIONS: SearchOperatorSuggestion[] = [
  {
    token: "status:todo",
    label: "Open todo tasks",
    description: "Filter by task status",
  },
  {
    token: "status:blocked",
    label: "Blocked tasks",
    description: "Find blocked work",
  },
  {
    token: "priority:high",
    label: "High priority",
    description: "Filter by priority",
  },
  {
    token: "updated:>7d",
    label: "Recently updated",
    description: "Updated in the last 7 days",
  },
];

export interface SearchQueryParserContext {
  agents?: readonly { id: string; name: string }[];
  projects?: readonly { id: string; name: string }[];
  labels?: readonly { id: string; name: string }[];
}

export interface ParsedSearchQuery {
  query: string;
  filters: Omit<
    Pick<
      CompanySearchParams,
      | "status"
      | "priority"
      | "ownerAgentId"
      | "ownerUserId"
      | "projectId"
      | "labelId"
      | "updatedWithin"
      | "updatedAfter"
    >,
    "ownerAgentId"
  > & { ownerAgentId?: string };
  pills: SearchOperatorPill[];
}

interface QueryToken {
  raw: string;
  value: string;
}

function tokenizeQuery(input: string): QueryToken[] {
  const tokens: QueryToken[] = [];
  let index = 0;
  while (index < input.length) {
    while (/\s/.test(input[index] ?? "")) index += 1;
    if (index >= input.length) break;

    const start = index;
    if (input[index] === '"') {
      index += 1;
      while (index < input.length && input[index] !== '"') index += 1;
      if (input[index] === '"') index += 1;
      const raw = input.slice(start, index);
      tokens.push({ raw, value: raw });
      continue;
    }

    while (index < input.length && !/\s/.test(input[index] ?? "")) {
      if (input[index] === ":" && input[index + 1] === '"') {
        index += 2;
        while (index < input.length && input[index] !== '"') index += 1;
        if (input[index] === '"') index += 1;
        break;
      }
      index += 1;
    }

    const raw = input.slice(start, index);
    tokens.push({ raw, value: raw });
  }
  return tokens;
}

function currentTokenBounds(input: string): {
  start: number;
  end: number;
  token: string;
} {
  let end = input.length;
  while (end > 0 && /\s/.test(input[end - 1] ?? "")) end -= 1;
  let start = end;
  while (start > 0 && !/\s/.test(input[start - 1] ?? "")) start -= 1;
  return { start, end, token: input.slice(start, end) };
}

export function searchOperatorSuggestions(input: string, limit = 5): SearchOperatorSuggestion[] {
  const { token } = currentTokenBounds(input);
  const normalized = token.toLowerCase();
  const candidates =
    normalized.length > 0
      ? SEARCH_OPERATOR_SUGGESTIONS.filter((suggestion) => suggestion.token.toLowerCase().startsWith(normalized))
      : SEARCH_OPERATOR_SUGGESTIONS;
  return candidates.slice(0, limit);
}

export function applySearchOperatorSuggestion(input: string, token: string): string {
  const { start, end } = currentTokenBounds(input);
  const prefix = input.slice(0, start).trimEnd();
  const suffix = input.slice(end).trimStart();
  return [prefix, token, suffix].filter(Boolean).join(" ").trim();
}

function addUnique<T extends string>(values: T[] | undefined, value: T): T[] {
  return values?.includes(value) ? values : [...(values ?? []), value];
}

function appendText(parts: string[], raw: string) {
  if (raw.trim().length > 0) parts.push(raw);
}

function parseStatus(value: string): TaskStatus | null {
  return (TASK_STATUSES as readonly string[]).includes(value) ? (value as TaskStatus) : null;
}

function parsePriority(value: string): TaskPriority | null {
  return (TASK_PRIORITIES as readonly string[]).includes(value) ? (value as TaskPriority) : null;
}

function parseUpdatedWithin(value: string): string | null {
  if (!value.startsWith(">")) return null;
  const normalized = value.slice(1);
  if (!/^[1-9]\d{0,2}(h|d|w|m)$/.test(normalized)) return null;
  return normalized;
}

function operatorLabel(key: SearchOperatorKey, value: string) {
  return `${key}:${value}`;
}

export function parseSearchQuery(input: string, context: SearchQueryParserContext = {}): ParsedSearchQuery {
  const textParts: string[] = [];
  const filters: ParsedSearchQuery["filters"] = {};
  const pills: SearchOperatorPill[] = [];

  for (const token of tokenizeQuery(input)) {
    const match = /^([a-z]+):(.*)$/s.exec(token.value);
    if (!match) {
      appendText(textParts, token.raw);
      continue;
    }

    const key = match[1]!;
    const value = match[2]!;
    if (!value) {
      appendText(textParts, token.raw);
      continue;
    }

    if (key === "status") {
      const status = parseStatus(value);
      if (!status) {
        appendText(textParts, token.raw);
        continue;
      }
      filters.status = addUnique(filters.status, status);
      pills.push({
        key: "status",
        value: status,
        label: operatorLabel("status", status),
      });
      continue;
    }

    if (key === "priority") {
      const priority = parsePriority(value);
      if (!priority) {
        appendText(textParts, token.raw);
        continue;
      }
      filters.priority = addUnique(filters.priority, priority);
      pills.push({
        key: "priority",
        value: priority,
        label: operatorLabel("priority", priority),
      });
      continue;
    }

    if (key === "owner") {
      if (!isCanonicalUuid(value)) {
        appendText(textParts, token.raw);
        continue;
      }
      filters.ownerAgentId = value;
      pills.push({
        key: "owner",
        value,
        label: operatorLabel("owner", nameForId(context.agents, value)),
      });
      continue;
    }

    if (key === "project") {
      if (!isCanonicalUuid(value)) {
        appendText(textParts, token.raw);
        continue;
      }
      filters.projectId = value;
      pills.push({
        key: "project",
        value,
        label: operatorLabel("project", nameForId(context.projects, value)),
      });
      continue;
    }

    if (key === "label") {
      if (isCanonicalUuid(value)) {
        filters.labelId = value;
        pills.push({
          key: "label",
          value,
          label: operatorLabel("label", nameForId(context.labels, value)),
        });
        continue;
      }
      appendText(textParts, token.raw);
      continue;
    }

    if (key === "updated") {
      const updatedWithin = parseUpdatedWithin(value);
      if (!updatedWithin) {
        appendText(textParts, token.raw);
        continue;
      }
      filters.updatedWithin = updatedWithin;
      pills.push({
        key: "updated",
        value: `>${updatedWithin}`,
        label: operatorLabel("updated", `>${updatedWithin}`),
      });
      continue;
    }

    if (key === "is") {
      if (value === "open") {
        filters.status = OPEN_STATUSES;
        pills.push({ key: "is", value: "open", label: "is:open" });
        continue;
      }
      if (value === "closed") {
        filters.status = CLOSED_STATUSES;
        pills.push({ key: "is", value: "closed", label: "is:closed" });
        continue;
      }
      appendText(textParts, token.raw);
      continue;
    }

    appendText(textParts, token.raw);
  }

  return {
    query: textParts.join(" ").replace(/\s+/g, " ").trim(),
    filters,
    pills,
  };
}

export function hasSearchFilters(filters: ParsedSearchQuery["filters"]) {
  return Boolean(
    filters.status?.length ||
    filters.priority?.length ||
    filters.ownerAgentId !== undefined ||
    filters.ownerUserId ||
    filters.projectId ||
    filters.labelId ||
    filters.updatedWithin ||
    filters.updatedAfter,
  );
}

function nameForId<T extends { id: string; name: string }>(entries: readonly T[] | undefined, id: string) {
  return entries?.find((entry) => entry.id === id)?.name ?? id.slice(0, 8);
}

export function searchFilterPills(
  filters: ParsedSearchQuery["filters"],
  context: SearchQueryParserContext = {},
): SearchOperatorPill[] {
  const pills: SearchOperatorPill[] = [];
  for (const status of filters.status ?? []) {
    pills.push({
      key: "status",
      value: status,
      label: operatorLabel("status", status),
    });
  }
  for (const priority of filters.priority ?? []) {
    pills.push({
      key: "priority",
      value: priority,
      label: operatorLabel("priority", priority),
    });
  }
  if (filters.ownerAgentId !== undefined) {
    const label = nameForId(context.agents, filters.ownerAgentId);
    pills.push({
      key: "owner",
      value: filters.ownerAgentId,
      label: operatorLabel("owner", label),
    });
  }
  if (filters.ownerUserId) {
    pills.push({
      key: "owner",
      value: filters.ownerUserId,
      label: operatorLabel("owner", filters.ownerUserId.slice(0, 8)),
    });
  }
  if (filters.projectId) {
    const label = nameForId(context.projects, filters.projectId);
    pills.push({
      key: "project",
      value: filters.projectId,
      label: operatorLabel("project", label),
    });
  }
  if (filters.labelId) {
    const label = nameForId(context.labels, filters.labelId);
    pills.push({
      key: "label",
      value: filters.labelId,
      label: operatorLabel("label", label),
    });
  }
  if (filters.updatedWithin) {
    pills.push({
      key: "updated",
      value: `>${filters.updatedWithin}`,
      label: operatorLabel("updated", `>${filters.updatedWithin}`),
    });
  }
  if (filters.updatedAfter) {
    pills.push({
      key: "updated",
      value: filters.updatedAfter,
      label: operatorLabel("updated", filters.updatedAfter),
    });
  }
  return pills;
}
