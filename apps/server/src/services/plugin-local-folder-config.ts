import path from "node:path";
import type { PluginLocalFolderDeclaration, PluginLocalFolderProblem } from "@paperclipai/plugin-sdk";
import { badRequest, forbidden } from "../errors.js";
import { promises as fs } from "node:fs";

export interface StoredPluginLocalFolderConfig {
  path: string;
}

export interface PluginLocalFolderSettingsJson {
  localFolders?: Record<string, StoredPluginLocalFolderConfig>;
  [key: string]: unknown;
}

export const LOCAL_FOLDER_KEY_PATTERN = /^[a-z0-9][a-z0-9._:-]*$/;

export function problem(
  code: PluginLocalFolderProblem["code"],
  message: string,
  problemPath?: string,
): PluginLocalFolderProblem {
  return { code, message, path: problemPath };
}

export function assertPluginLocalFolderKey(folderKey: string) {
  if (!LOCAL_FOLDER_KEY_PATTERN.test(folderKey)) {
    throw badRequest(
      "folderKey must start with a lowercase alphanumeric and contain only lowercase letters, digits, dots, colons, underscores, or hyphens",
    );
  }
}

export function requireLocalFolderDeclaration(
  declarations: PluginLocalFolderDeclaration[],
  folderKey: string,
) {
  assertPluginLocalFolderKey(folderKey);
  const declaration = declarations.find((candidate) => candidate.folderKey === folderKey);
  if (!declaration) {
    throw badRequest("Local folder key is not declared by this plugin manifest");
  }
  return declaration;
}

export function normalizeRelativePath(relativePath: string): string {
  if (
    !relativePath ||
    path.isAbsolute(relativePath) ||
    relativePath.includes("\\") ||
    relativePath.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw forbidden("Local folder relative paths must stay inside the configured root");
  }
  return relativePath;
}

export function validateRequiredPath(pathValue: string, label: string): string {
  try {
    return normalizeRelativePath(pathValue);
  } catch {
    throw badRequest(
      `${label} must contain only relative paths without traversal, empty segments, or backslashes`,
    );
  }
}

export function parseListRelativePath(relativePath: string | null | undefined): string | null {
  if (relativePath === undefined || relativePath === null) return null;
  if (relativePath.length === 0 || relativePath.trim() !== relativePath) {
    throw badRequest("Local folder list relativePath must be exact and non-empty");
  }
  return normalizeRelativePath(relativePath);
}

export function parseMaxEntries(value: number | undefined): number {
  if (value === undefined) return 100;
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw badRequest("Local folder maxEntries must be an exact integer between 1 and 100");
  }
  return value;
}

export function getStoredLocalFolders(settingsJson: Record<string, unknown> | null | undefined) {
  const folders = settingsJson?.localFolders;
  if (folders === undefined) return {};
  if (typeof folders !== "object" || folders === null || Array.isArray(folders)) {
    throw new Error("Stored plugin local folders must be an object");
  }

  const result: Record<string, StoredPluginLocalFolderConfig> = {};
  for (const [folderKey, value] of Object.entries(folders)) {
    assertPluginLocalFolderKey(folderKey);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`Stored plugin local folder '${folderKey}' must be an object`);
    }
    const keys = Object.keys(value);
    if (keys.some((key) => key !== "path")) {
      throw new Error(`Stored plugin local folder '${folderKey}' contains undeclared fields`);
    }
    if (
      !("path" in value) ||
      typeof value.path !== "string" ||
      value.path.length === 0 ||
      value.path.trim() !== value.path
    ) {
      throw new Error(`Stored plugin local folder '${folderKey}' must contain a non-empty path`);
    }
    result[folderKey] = { path: value.path };
  }
  return result;
}

export function setStoredLocalFolder(
  settingsJson: Record<string, unknown> | null | undefined,
  folderKey: string,
  folderPath: string,
): PluginLocalFolderSettingsJson {
  assertPluginLocalFolderKey(folderKey);
  if (folderPath.length === 0 || folderPath.trim() !== folderPath) {
    throw badRequest("Local folder path must be exact and non-empty");
  }
  return {
    ...(settingsJson ?? {}),
    localFolders: {
      ...getStoredLocalFolders(settingsJson),
      [folderKey]: { path: folderPath },
    },
  };
}

export function isInsideRoot(rootRealPath: string, candidateRealPath: string) {
  const relative = path.relative(rootRealPath, candidateRealPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function assertPathInsideRoot(rootRealPath: string, candidatePath: string) {
  const candidateRealPath = await fs.realpath(candidatePath);
  if (!isInsideRoot(rootRealPath, candidateRealPath)) {
    throw forbidden("Local folder symlink escape is not allowed");
  }
}

export async function ensureDirectoryInsideRoot(rootRealPath: string, relativePath: string) {
  const normalized = normalizeRelativePath(relativePath);
  const segments = normalized.split("/");
  let currentRealPath = rootRealPath;

  for (const segment of segments) {
    const nextPath = path.join(currentRealPath, segment);
    try {
      const stat = await fs.stat(nextPath);
      if (!stat.isDirectory()) {
        throw badRequest("Required directory path exists but is not a directory");
      }
    } catch (error) {
      const code =
        typeof error === "object" && error && "code" in error
          ? String((error as { code?: unknown }).code)
          : "";
      if (code !== "ENOENT") throw error;
      await fs.mkdir(nextPath);
    }

    const nextRealPath = await fs.realpath(nextPath);
    if (!isInsideRoot(rootRealPath, nextRealPath)) {
      throw forbidden("Local folder symlink escape is not allowed");
    }
    currentRealPath = nextRealPath;
  }
}

export async function resolvePluginLocalFolderPath(
  rootPath: string,
  relativePath: string,
  options?: { mustExist?: boolean; allowMissingLeaf?: boolean },
) {
  const normalized = normalizeRelativePath(relativePath);
  const rootRealPath = await fs.realpath(rootPath);
  const absolutePath = path.resolve(rootRealPath, normalized);
  const relativeFromRoot = path.relative(rootRealPath, absolutePath);
  if (relativeFromRoot.startsWith("..") || path.isAbsolute(relativeFromRoot)) {
    throw forbidden("Local folder path traversal is not allowed");
  }

  try {
    const realPath = await fs.realpath(absolutePath);
    const realRelative = path.relative(rootRealPath, realPath);
    if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
      throw forbidden("Local folder symlink escape is not allowed");
    }
    return { absolutePath, realPath, exists: true };
  } catch (error) {
    const code =
      typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code) : "";
    if (code !== "ENOENT" || options?.mustExist) {
      if (options?.allowMissingLeaf && code === "ENOENT") {
        return { absolutePath, realPath: absolutePath, exists: false };
      }
      throw error;
    }

    const parentRealPath = await fs.realpath(path.dirname(absolutePath));
    const parentRelative = path.relative(rootRealPath, parentRealPath);
    if (parentRelative.startsWith("..") || path.isAbsolute(parentRelative)) {
      throw forbidden("Local folder symlink escape is not allowed");
    }
    return { absolutePath, realPath: absolutePath, exists: false };
  }
}

export async function inspectChildPath(
  rootRealPath: string,
  relativePath: string,
  kind: "directory" | "file",
) {
  let resolvedPath: Awaited<ReturnType<typeof resolvePluginLocalFolderPath>>;
  try {
    resolvedPath = await resolvePluginLocalFolderPath(rootRealPath, relativePath, {
      mustExist: true,
      allowMissingLeaf: true,
    });
  } catch {
    return { exists: true, contained: false, matchesKind: false };
  }
  if (!resolvedPath.exists) {
    return { exists: false, contained: true, matchesKind: false };
  }
  const stat = await fs.stat(resolvedPath.realPath);
  return {
    exists: true,
    contained: true,
    matchesKind: kind === "directory" ? stat.isDirectory() : stat.isFile(),
  };
}

export async function readPluginLocalFolderText(rootPath: string, relativePath: string) {
  const resolved = await resolvePluginLocalFolderPath(rootPath, relativePath, {
    mustExist: true,
  });
  const stat = await fs.stat(resolved.realPath);
  if (!stat.isFile()) {
    throw badRequest("Local folder read target must be a file");
  }
  return fs.readFile(resolved.realPath, "utf8");
}
