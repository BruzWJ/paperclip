import { z } from "zod";
import { addValidationDetail } from "../validation-details.js";
import { TASK_PRIORITIES, TASK_STATUSES } from "../constants.js";
import { isCanonicalUuid } from "../canonical-uuid.js";
import {
  COMPANY_SEARCH_EXTRACT_KINDS,
  COMPANY_SEARCH_EXTRACT_SCOPES,
  COMPANY_SEARCH_SCOPES,
  COMPANY_SEARCH_SORTS,
} from "../types/search.js";

export const COMPANY_SEARCH_MAX_QUERY_LENGTH = 200;
export const COMPANY_SEARCH_MAX_TOKENS = 8;
export const COMPANY_SEARCH_DEFAULT_LIMIT = 20;
export const COMPANY_SEARCH_MAX_LIMIT = 50;
export const COMPANY_SEARCH_MAX_OFFSET = 200;
export const COMPANY_SEARCH_EXTRACT_DEFAULT_LIMIT = 100;
export const COMPANY_SEARCH_EXTRACT_MAX_LIMIT = 200;
export const COMPANY_SEARCH_EXTRACT_MAX_OFFSET = 5_000;
export const COMPANY_SEARCH_EXTRACT_DEFAULT_MATCHES_PER_TASK = 20;
export const COMPANY_SEARCH_EXTRACT_MAX_MATCHES_PER_TASK = 200;

const UPDATED_WITHIN_RE = /^[1-9]\d{0,2}(h|d|w|m)$/;

function singleQueryValue(
  value: unknown,
  ctx: z.RefinementCtx,
  field: string,
): unknown {
  if (!Array.isArray(value)) return value;
  addValidationDetail(ctx, { message: `${field} must appear at most once` });
  return undefined;
}

function queryValues(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function parseOptionalString(value: unknown, ctx: z.RefinementCtx, field: string): string | undefined {
  const raw = singleQueryValue(value, ctx, field);
  if (raw === undefined) return undefined;
  if (
    typeof raw !== "string" ||
    raw.length === 0 ||
    raw.trim() !== raw
  ) {
    addValidationDetail(ctx, { message: `${field} must be an exact non-blank string` });
    return undefined;
  }
  return raw;
}

function parseIntegerQuery(
  value: unknown,
  ctx: z.RefinementCtx,
  field: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = singleQueryValue(value, ctx, field);
  if (raw === undefined) return fallback;
  if (typeof raw !== "string" || !/^(?:0|[1-9]\d*)$/.test(raw)) {
    addValidationDetail(ctx, { message: `${field} must be an exact non-negative integer` });
    return fallback;
  }
  const numeric = Number(raw);
  if (!Number.isInteger(numeric) || numeric < min || numeric > max) {
    const range = min === 0 ? `between 0 and ${max}` : `between ${min} and ${max}`;
    addValidationDetail(ctx, { message: `${field} must be ${range}` });
    return fallback;
  }
  return numeric;
}

function parseEnumList<T extends string>(
  value: unknown,
  ctx: z.RefinementCtx,
  field: string,
  allowed: readonly T[],
): T[] {
  const allowedSet = new Set<string>(allowed);
  const values: T[] = [];
  for (const rawEntry of queryValues(value)) {
    if (typeof rawEntry !== "string") {
      addValidationDetail(ctx, { message: `${field} must be a string` });
      continue;
    }
    if (!allowedSet.has(rawEntry)) {
      addValidationDetail(ctx, { message: `${field} contains an unsupported value` });
      continue;
    }
    if (values.includes(rawEntry as T)) {
      addValidationDetail(ctx, { message: `${field} must not contain duplicate values` });
      continue;
    }
    values.push(rawEntry as T);
  }
  return values;
}

function parseOptionalUuid(value: unknown, ctx: z.RefinementCtx, field: string): string | undefined {
  const raw = singleQueryValue(value, ctx, field);
  if (raw === undefined) return undefined;
  if (
    typeof raw !== "string" ||
    !isCanonicalUuid(raw)
  ) {
    addValidationDetail(ctx, { message: `${field} must be a UUID` });
    return undefined;
  }
  return raw;
}

function parseUpdatedAfter(value: unknown, ctx: z.RefinementCtx): string | undefined {
  const exact = parseOptionalString(value, ctx, "updatedAfter");
  if (exact === undefined) return undefined;
  const date = new Date(exact);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== exact) {
    addValidationDetail(ctx, { message: "updatedAfter must be an exact ISO timestamp" });
    return undefined;
  }
  return exact;
}

function parseUpdatedWithin(value: unknown, ctx: z.RefinementCtx): string | undefined {
  const normalized = parseOptionalString(value, ctx, "updatedWithin");
  if (normalized === undefined) return undefined;
  if (!UPDATED_WITHIN_RE.test(normalized)) {
    addValidationDetail(ctx, { message: "updatedWithin must be a duration like 24h, 7d, 4w, or 3m" });
    return undefined;
  }
  return normalized;
}

export const companySearchQuerySchema = z.object({
  q: z.unknown()
    .optional()
    .transform((value, ctx) => {
      const exact = parseOptionalString(value, ctx, "q") ?? "";
      if (exact.length > COMPANY_SEARCH_MAX_QUERY_LENGTH) {
        addValidationDetail(ctx, { message: `q must be at most ${COMPANY_SEARCH_MAX_QUERY_LENGTH} characters` });
        return "";
      }
      return exact;
    }),
  scope: z.unknown()
    .optional()
    .transform((value, ctx) => {
      const normalized = parseOptionalString(value, ctx, "scope") ?? "all";
      if (!(COMPANY_SEARCH_SCOPES as readonly string[]).includes(normalized)) {
        addValidationDetail(ctx, { message: "scope must be a supported search scope" });
        return "all";
      }
      return normalized as (typeof COMPANY_SEARCH_SCOPES)[number];
    }),
  limit: z.unknown()
    .optional()
    .transform((value, ctx) => parseIntegerQuery(value, ctx, "limit", COMPANY_SEARCH_DEFAULT_LIMIT, 1, COMPANY_SEARCH_MAX_LIMIT)),
  offset: z.unknown()
    .optional()
    .transform((value, ctx) => parseIntegerQuery(value, ctx, "offset", 0, 0, COMPANY_SEARCH_MAX_OFFSET)),
  status: z.unknown()
    .optional()
    .transform((value, ctx) => parseEnumList(value, ctx, "status", TASK_STATUSES)),
  priority: z.unknown()
    .optional()
    .transform((value, ctx) => parseEnumList(value, ctx, "priority", TASK_PRIORITIES)),
  ownerAgentId: z.unknown()
    .optional()
    .transform((value, ctx) => parseOptionalUuid(value, ctx, "ownerAgentId")),
  ownerUserId: z.unknown()
    .optional()
    .transform((value, ctx) => parseOptionalString(value, ctx, "ownerUserId")),
  projectId: z.unknown()
    .optional()
    .transform((value, ctx) => parseOptionalUuid(value, ctx, "projectId")),
  labelId: z.unknown()
    .optional()
    .transform((value, ctx) => parseOptionalUuid(value, ctx, "labelId")),
  updatedWithin: z.unknown()
    .optional()
    .transform((value, ctx) => parseUpdatedWithin(value, ctx)),
  updatedAfter: z.unknown()
    .optional()
    .transform((value, ctx) => parseUpdatedAfter(value, ctx)),
  sort: z.unknown()
    .optional()
    .transform((value, ctx) => {
      const normalized = parseOptionalString(value, ctx, "sort") ?? "relevance";
      if (!(COMPANY_SEARCH_SORTS as readonly string[]).includes(normalized)) {
        addValidationDetail(ctx, { message: "sort must be relevance, updated, created, or priority" });
        return "relevance";
      }
      return normalized as (typeof COMPANY_SEARCH_SORTS)[number];
    }),
}).strict();

export type CompanySearchQuery = z.infer<typeof companySearchQuerySchema>;

export const companySearchExtractQuerySchema = z.object({
  contains: z.unknown().transform((value, ctx) => {
    const normalized = parseOptionalString(value, ctx, "contains");
    if (!normalized || normalized.length < 2) {
      addValidationDetail(ctx, { message: "contains must be at least 2 characters" });
      return "";
    }
    if (normalized.length > COMPANY_SEARCH_MAX_QUERY_LENGTH) {
      addValidationDetail(ctx, {
        message: `contains must be at most ${COMPANY_SEARCH_MAX_QUERY_LENGTH} characters`,
      });
    }
    return normalized.slice(0, COMPANY_SEARCH_MAX_QUERY_LENGTH);
  }),
  kind: z.unknown()
    .optional()
    .transform((value, ctx) => {
      const normalized = parseOptionalString(value, ctx, "kind") ?? "literal";
      if (!(COMPANY_SEARCH_EXTRACT_KINDS as readonly string[]).includes(normalized)) {
        addValidationDetail(ctx, { message: "kind must be literal or url" });
        return "literal";
      }
      return normalized as (typeof COMPANY_SEARCH_EXTRACT_KINDS)[number];
    }),
  scope: z.unknown()
    .optional()
    .transform((value, ctx) => {
      const normalized = parseOptionalString(value, ctx, "scope") ?? "all";
      if (!(COMPANY_SEARCH_EXTRACT_SCOPES as readonly string[]).includes(normalized)) {
        addValidationDetail(ctx, { message: "scope must be all, tasks, comments, or documents" });
        return "all";
      }
      return normalized as (typeof COMPANY_SEARCH_EXTRACT_SCOPES)[number];
    }),
  limit: z.unknown()
    .optional()
    .transform((value, ctx) => parseIntegerQuery(
      value,
      ctx,
      "limit",
      COMPANY_SEARCH_EXTRACT_DEFAULT_LIMIT,
      1,
      COMPANY_SEARCH_EXTRACT_MAX_LIMIT,
    )),
  offset: z.unknown()
    .optional()
    .transform((value, ctx) => parseIntegerQuery(value, ctx, "offset", 0, 0, COMPANY_SEARCH_EXTRACT_MAX_OFFSET)),
  matchesPerTask: z.unknown()
    .optional()
    .transform((value, ctx) => parseIntegerQuery(
      value,
      ctx,
      "matchesPerTask",
      COMPANY_SEARCH_EXTRACT_DEFAULT_MATCHES_PER_TASK,
      1,
      COMPANY_SEARCH_EXTRACT_MAX_MATCHES_PER_TASK,
    )),
  status: z.unknown()
    .optional()
    .transform((value, ctx) => parseEnumList(value, ctx, "status", TASK_STATUSES)),
  updatedWithin: z.unknown()
    .optional()
    .transform((value, ctx) => parseUpdatedWithin(value, ctx)),
  updatedAfter: z.unknown()
    .optional()
    .transform((value, ctx) => parseUpdatedAfter(value, ctx)),
}).strict().superRefine((value, ctx) => {
  if (value.updatedWithin && value.updatedAfter) {
    addValidationDetail(ctx, {
      message: "updatedWithin and updatedAfter cannot be used together",
    });
  }
});

export type CompanySearchExtractQuery = z.infer<typeof companySearchExtractQuerySchema>;
