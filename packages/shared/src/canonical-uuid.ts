export const CANONICAL_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Returns whether a value is an exact lowercase, hyphenated UUID with a
 * current RFC 9562 version and variant.
 *
 * Route and API identities use this representation directly. The predicate
 * deliberately rejects surrounding whitespace and case-normalized aliases.
 */
export function isCanonicalUuid(
  value: string | null | undefined,
): value is string {
  return typeof value === "string" && CANONICAL_UUID_RE.test(value);
}
