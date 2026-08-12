import { isCanonicalUuid } from "@paperclipai/shared";

function invalidSearchParam(field: string, expectation: string): never {
  throw new Error(`Invalid search parameter "${field}": ${expectation}`);
}

export function assertOnlySearchKeys(
  search: Record<string, unknown>,
  allowedKeys: readonly string[],
): void {
  const allowed = new Set(allowedKeys);
  const unknownKey = Object.keys(search).find((key) => !allowed.has(key));
  if (unknownKey) {
    invalidSearchParam(unknownKey, "unknown parameter");
  }
}

export function optionalSearchString(
  value: unknown,
  field = "value",
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    return invalidSearchParam(field, "must be a string");
  }
  return value;
}

export function optionalExactSearchString(
  value: unknown,
  field: string,
  maxLength?: number,
): string | undefined {
  const exact = optionalSearchString(value, field);
  if (exact === undefined) return undefined;
  if (exact.length === 0 || exact.trim() !== exact) {
    return invalidSearchParam(field, "must be an exact non-blank string");
  }
  if (maxLength !== undefined && exact.length > maxLength) {
    return invalidSearchParam(field, `must be at most ${maxLength} characters`);
  }
  return exact;
}

export function exactSearchString(
  value: unknown,
  field: string,
  options: { minLength?: number; maxLength?: number } = {},
): string {
  const exact = optionalExactSearchString(value, field, options.maxLength);
  if (exact === undefined) {
    return invalidSearchParam(field, "is required");
  }
  if (options.minLength !== undefined && exact.length < options.minLength) {
    return invalidSearchParam(
      field,
      `must be at least ${options.minLength} characters`,
    );
  }
  return exact;
}

export function optionalCanonicalInternalPathSearch(
  value: unknown,
  field: string,
): string | undefined {
  const exact = optionalExactSearchString(value, field, 4096);
  if (exact === undefined) return undefined;
  if (
    !exact.startsWith("/") ||
    exact.startsWith("//") ||
    exact.includes("\\") ||
    exact.includes("#") ||
    /%(?:0[0-9a-f]|1[0-9a-f]|2f|5c|7f)/i.test(exact) ||
    /[\u0000-\u001f\u007f]/.test(exact)
  ) {
    return invalidSearchParam(
      field,
      "must be an exact internal application path",
    );
  }

  const url = new URL(exact, "https://paperclip.invalid");
  const canonical = `${url.pathname}${url.search}`;
  if (
    url.origin !== "https://paperclip.invalid" ||
    canonical !== exact ||
    (url.pathname !== "/" && url.pathname.endsWith("/")) ||
    url.pathname.includes("//")
  ) {
    return invalidSearchParam(
      field,
      "must be an exact internal application path",
    );
  }
  return exact;
}

export function optionalSearchEnum<const TValues extends readonly string[]>(
  value: unknown,
  values: TValues,
  field = "value",
): TValues[number] | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !values.includes(value)) {
    return invalidSearchParam(field, `must be one of ${values.join(", ")}`);
  }
  return value as TValues[number];
}

export function optionalSearchEnumArray<
  const TValues extends readonly string[],
>(
  value: unknown,
  values: TValues,
  field = "value",
): TValues[number][] | undefined {
  if (value === undefined) return undefined;
  const candidates = Array.isArray(value) ? value : [value];
  if (candidates.length === 0) {
    return invalidSearchParam(field, "must contain at least one value");
  }

  const validated: TValues[number][] = [];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !values.includes(candidate)) {
      return invalidSearchParam(
        field,
        `must contain only ${values.join(", ")}`,
      );
    }
    if (validated.includes(candidate as TValues[number])) {
      return invalidSearchParam(field, "must not contain duplicate values");
    }
    validated.push(candidate as TValues[number]);
  }
  return validated;
}

export function optionalCanonicalUuidSearch(
  value: unknown,
  field: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !isCanonicalUuid(value)) {
    return invalidSearchParam(field, "must be a canonical UUID");
  }
  return value;
}

export function optionalSearchPattern(
  value: unknown,
  field: string,
  pattern: RegExp,
  expectation: string,
): string | undefined {
  const exact = optionalExactSearchString(value, field);
  if (exact === undefined) return undefined;
  if (!pattern.test(exact)) {
    return invalidSearchParam(field, expectation);
  }
  return exact;
}

export function optionalExactIsoTimestampSearch(
  value: unknown,
  field: string,
): string | undefined {
  const exact = optionalExactSearchString(value, field);
  if (exact === undefined) return undefined;
  const date = new Date(exact);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== exact) {
    return invalidSearchParam(field, "must be an exact ISO timestamp");
  }
  return exact;
}
