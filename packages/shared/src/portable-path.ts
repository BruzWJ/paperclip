import { z } from "zod";

export const MAX_PORTABLE_RELATIVE_PATH_LENGTH = 1024;
export const MAX_PORTABLE_PATH_SEGMENT_LENGTH = 255;

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[A-Za-z]:\//u;

/**
 * Returns true only for an exact, portable, package-relative path.
 *
 * Portable paths always use `/`, never contain traversal segments, and do not
 * rely on trimming or path normalization to acquire their identity.
 */
export function isPortableRelativePath(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > MAX_PORTABLE_RELATIVE_PATH_LENGTH ||
    value.trim() !== value ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("//") ||
    value.includes("\\") ||
    WINDOWS_ABSOLUTE_PATH_PATTERN.test(value) ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    return false;
  }

  return value
    .split("/")
    .every(
      (segment) =>
        segment.length > 0 &&
        segment.length <= MAX_PORTABLE_PATH_SEGMENT_LENGTH &&
        segment !== "." &&
        segment !== ".." &&
        segment.trim() === segment,
    );
}

export const portableRelativePathSchema = z
  .string()
  .min(1)
  .max(MAX_PORTABLE_RELATIVE_PATH_LENGTH)
  .refine(isPortableRelativePath, {
    message:
      "Portable paths must be exact slash-separated relative paths without empty, traversal, absolute, backslash, control, or surrounding-whitespace segments",
  });
