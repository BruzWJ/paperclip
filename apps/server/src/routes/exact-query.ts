import { badRequest } from "../errors.js";

export function assertExactQueryKeys(
  query: Record<string, unknown>,
  allowed: readonly string[],
) {
  const unknown = Object.keys(query)
    .filter((key) => !allowed.includes(key))
    .sort();
  if (unknown.length > 0) {
    throw badRequest(`Unsupported query parameter: ${unknown.join(", ")}`);
  }
}

export function parseExactBooleanQuery(
  value: unknown,
  field: string,
  defaultValue = false,
) {
  if (value === undefined) return defaultValue;
  if (value === "true") return true;
  if (value === "false") return false;
  throw badRequest(`${field} must be exactly true or false`);
}

export function parseExactPositiveIntegerQuery(
  value: unknown,
  field: string,
  options: { defaultValue: number; max: number },
) {
  if (value === undefined) return options.defaultValue;
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
    throw badRequest(`${field} must be an exact positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > options.max) {
    throw badRequest(`${field} must not exceed ${options.max}`);
  }
  return parsed;
}

export function parseExactOptionalEnum<const T extends readonly string[]>(
  value: unknown,
  field: string,
  allowed: T,
): T[number] | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
    return value as T[number];
  }
  throw badRequest(`${field} has an unsupported value`);
}

export function parseExactOptionalNonBlankQuery(
  value: unknown,
  field: string,
  maxLength = 1_000,
) {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    value.trim() !== value
  ) {
    throw badRequest(`${field} must be exact and non-empty`);
  }
  return value;
}
