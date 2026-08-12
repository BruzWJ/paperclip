const PATH_SEPARATOR_PATTERN = /[\\/]/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;

/** Extract the still-encoded pathname from a relative href. */
export function rawPathnameFromHref(href: string): string {
  const queryIndex = href.indexOf("?");
  const hashIndex = href.indexOf("#");
  const end = [queryIndex, hashIndex]
    .filter((index) => index >= 0)
    .reduce((lowest, index) => Math.min(lowest, index), href.length);
  return href.slice(0, end);
}

/** Extract the still-encoded fragment, without `#`, from a relative href. */
export function rawFragmentFromHref(href: string): string {
  const hashIndex = href.indexOf("#");
  return hashIndex === -1 ? "" : href.slice(hashIndex + 1);
}

/** Extract the still-encoded search string, including `?`, from an href. */
export function rawSearchFromHref(href: string): string {
  const queryIndex = href.indexOf("?");
  if (queryIndex === -1) return "";
  const hashIndex = href.indexOf("#", queryIndex);
  return href.slice(queryIndex, hashIndex === -1 ? href.length : hashIndex);
}

/**
 * Accept the single application/x-www-form-urlencoded spelling emitted by
 * URLSearchParams. Express decodes query keys and values before route schemas,
 * so percent-encoded aliases must be rejected against the raw request target.
 */
export function isCanonicalUrlSearch(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value === "") return true;
  if (!value.startsWith("?") || value.length === 1) return false;
  const raw = value.slice(1);
  try {
    return new URLSearchParams(raw).toString() === raw;
  } catch {
    return false;
  }
}

/**
 * Accept only the browser URL serializer's single spelling of a fragment.
 * TanStack decodes fragments before components receive them, so this check
 * must run against the raw href at the root route boundary.
 */
export function isCanonicalEncodedFragment(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0) return true;

  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return false;
  }
  if (CONTROL_CHARACTER_PATTERN.test(decoded)) return false;

  const url = new URL("http://paperclip.invalid/");
  url.hash = decoded;
  return url.hash.slice(1) === value;
}

/**
 * Accepts only the single encodeURIComponent spelling of each URL path
 * segment. Framework routers decode params before validation, so this raw
 * boundary rejects percent-encoded unreserved aliases and encoded separators
 * before two path spellings can select the same route identity.
 */
export function isCanonicalEncodedPathname(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith("/")) return false;
  if (value === "/") return true;
  if (value.endsWith("/") || value.includes("?") || value.includes("#")) {
    return false;
  }

  for (const rawSegment of value.slice(1).split("/")) {
    if (rawSegment.length === 0) return false;
    let decodedSegment: string;
    try {
      decodedSegment = decodeURIComponent(rawSegment);
    } catch {
      return false;
    }
    if (
      decodedSegment.length === 0 ||
      PATH_SEPARATOR_PATTERN.test(decodedSegment) ||
      CONTROL_CHARACTER_PATTERN.test(decodedSegment) ||
      encodeURIComponent(decodedSegment) !== rawSegment
    ) {
      return false;
    }
  }

  return true;
}
