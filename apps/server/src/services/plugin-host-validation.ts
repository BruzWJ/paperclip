import type { PluginAuthorizationAuditDecision } from "@paperclipai/plugin-sdk";

/** Max length for a single plugin log message (bytes/chars). */
export const MAX_LOG_MESSAGE_LENGTH = 10_000;

/** Max serialised JSON size for plugin log meta objects. */
export const MAX_LOG_META_JSON_LENGTH = 50_000;

/** Max length for a metric name. */
export const MAX_METRIC_NAME_LENGTH = 500;

/** Canonical bounds for plugin list and audit offset windows. */
export const PLUGIN_LIST_LIMIT_MAX = 100;

export const PLUGIN_LIST_OFFSET_MAX = Number.MAX_SAFE_INTEGER - PLUGIN_LIST_LIMIT_MAX;

export type ExactPluginListWindow<TLimit extends number | null = number | null> = {
  limit: TLimit;
  offset: number;
};

export function requireExactWindowInteger(
  value: unknown,
  field: "limit" | "offset",
  minimum: number,
  maximum: number,
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${field} must be an exact integer between ${minimum} and ${maximum}`);
  }
  return value;
}

export function readExactPluginListWindow<TDefaultLimit extends number | null>(
  params: unknown,
  defaultLimit: TDefaultLimit,
): ExactPluginListWindow<number | TDefaultLimit> {
  if (params !== undefined && (typeof params !== "object" || params === null || Array.isArray(params))) {
    throw new Error("Plugin list parameters must be an exact object");
  }
  const input = (params ?? {}) as Record<string, unknown>;
  return {
    limit:
      input.limit === undefined
        ? defaultLimit
        : requireExactWindowInteger(input.limit, "limit", 1, PLUGIN_LIST_LIMIT_MAX),
    offset:
      input.offset === undefined
        ? 0
        : requireExactWindowInteger(input.offset, "offset", 0, PLUGIN_LIST_OFFSET_MAX),
  };
}

export function requireExactAuthorizationAuditDecision(
  value: unknown,
): PluginAuthorizationAuditDecision | null {
  if (value === undefined) return null;
  if (value === "allow" || value === "deny") return value;
  throw new Error('decision must be exactly "allow" or "deny"');
}

/** Pino reserved field names that plugins must not overwrite. */
export const PINO_RESERVED_KEYS = new Set(["level", "time", "pid", "hostname", "msg", "v"]);

/** Truncate a string to `max` characters, appending a marker if truncated. */
export function truncStr(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "...[truncated]";
}

/** Sanitise a plugin-supplied meta object: enforce size limit and strip reserved keys. */
export function sanitiseMeta(
  meta: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (meta == null) return null;
  // Strip pino reserved keys
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (!PINO_RESERVED_KEYS.has(k)) {
      cleaned[k] = v;
    }
  }
  // Enforce total serialised size
  let json: string;
  try {
    json = JSON.stringify(cleaned);
  } catch {
    return { _sanitised: true, _error: "meta was not JSON-serialisable" };
  }
  if (json.length > MAX_LOG_META_JSON_LENGTH) {
    return {
      _sanitised: true,
      _error: `meta exceeded ${MAX_LOG_META_JSON_LENGTH} chars`,
    };
  }
  return cleaned;
}
