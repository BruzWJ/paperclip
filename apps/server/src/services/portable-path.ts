import path from "node:path";
import { isPortableRelativePath } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";

export function requirePortablePath(
  input: string,
  label = "Portable path",
): string {
  if (!isPortableRelativePath(input)) {
    throw unprocessable(`${label} is not an exact portable relative path`);
  }
  return input;
}

export function resolvePortablePath(
  fromPath: string,
  targetPath: string,
): string {
  const canonicalFromPath = requirePortablePath(fromPath, "Source path");
  const canonicalTargetPath = requirePortablePath(targetPath, "Target path");
  const baseDirectory = path.posix.dirname(canonicalFromPath);
  const resolved = path.posix.join(baseDirectory, canonicalTargetPath);
  requirePortablePath(resolved, "Resolved path");

  if (baseDirectory !== "." && !resolved.startsWith(`${baseDirectory}/`)) {
    throw unprocessable("Resolved path escapes its package directory");
  }

  return resolved;
}

export function joinPortablePaths(...paths: string[]): string {
  if (paths.length === 0) {
    throw unprocessable("Portable path join requires at least one path");
  }
  const joined = paths.map((entry) => requirePortablePath(entry)).join("/");
  return requirePortablePath(joined, "Joined path");
}
