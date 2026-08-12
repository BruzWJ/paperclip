import { isCanonicalUuid } from "./canonical-uuid.js";
import { isCanonicalEncodedPathname } from "./canonical-pathname.js";

function splitNavigationTarget(
  target: string,
): { pathname: string; search: string; hash: string } | null {
  const match = target.match(/^([^?#]*)(\?[^#]*)?(#.*)?$/);
  if (!match) return null;
  return {
    pathname: match[1] ?? "",
    search: match[2] ?? "",
    hash: match[3] ?? "",
  };
}

/**
 * Tests the one plugin-to-host navigation target grammar.
 *
 * Targets are absolute within the active company, but never contain the
 * company UUID itself. A concrete path is required before optional search and
 * hash components; empty, dot, traversal, backslash, and encoded separator
 * segments are rejected instead of normalized.
 */
export function isCanonicalPluginNavigationTarget(
  target: unknown,
): target is string {
  if (
    typeof target !== "string" ||
    target.length === 0 ||
    target.trim() !== target
  ) {
    return false;
  }
  if (/[\u0000-\u001f\u007f\\]/.test(target)) return false;

  const parsed = splitNavigationTarget(target);
  if (!parsed) return false;
  const { pathname, search, hash } = parsed;
  if (
    !isCanonicalEncodedPathname(pathname) ||
    !pathname.startsWith("/") ||
    pathname.startsWith("//") ||
    pathname === "/" ||
    pathname.endsWith("/") ||
    search === "?" ||
    hash === "#"
  ) {
    return false;
  }

  const rawSegments = pathname.slice(1).split("/");
  if (rawSegments.some((segment) => segment.length === 0)) return false;

  const decodedSegments: string[] = [];
  for (const rawSegment of rawSegments) {
    let segment: string;
    try {
      segment = decodeURIComponent(rawSegment);
    } catch {
      return false;
    }
    if (
      segment.length === 0 ||
      segment === "." ||
      segment === ".." ||
      segment.includes("/") ||
      segment.includes("\\") ||
      /[\u0000-\u001f\u007f]/.test(segment)
    ) {
      return false;
    }
    decodedSegments.push(segment);
  }

  return !isCanonicalUuid(decodedSegments[0]);
}

/** Resolve a canonical company-relative plugin target to its sole board URL. */
export function resolvePluginNavigationHref(
  target: string,
  companyId: string | null | undefined,
): string {
  if (!isCanonicalUuid(companyId)) {
    throw new Error("Plugin host context requires a canonical company UUID");
  }
  if (!isCanonicalPluginNavigationTarget(target)) {
    throw new Error(
      "Plugin navigation requires an absolute company-relative path without a company UUID, empty segments, or dot segments",
    );
  }
  return `/${companyId}${target}`;
}
