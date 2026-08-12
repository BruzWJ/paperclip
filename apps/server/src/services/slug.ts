const SLUG_DELIMITER_RE = /[^a-z0-9]+/g;
const SLUG_EDGE_RE = /^-+|-+$/g;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Normalize a package/resource label into a lowercase portable slug. */
export function normalizeSlug(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(SLUG_DELIMITER_RE, "-")
    .replace(SLUG_EDGE_RE, "");
  return normalized.length > 0 ? normalized : null;
}

export function isCanonicalSlug(value: string | null | undefined): value is string {
  return typeof value === "string" && SLUG_RE.test(value);
}
