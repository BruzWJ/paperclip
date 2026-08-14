import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  PluginLocalFolderEntry,
  PluginLocalFolderListing,
  PluginLocalFolderStatus,
  PluginLocalFolderDeclaration,
} from "@paperclipai/plugin-sdk";
import { badRequest, forbidden, notFound } from "../errors.js";
import {
  normalizeRelativePath,
  parseListRelativePath,
  parseMaxEntries,
  assertPluginLocalFolderKey,
  validateRequiredPath,
} from "./plugin-local-folder-config.js";
import {
  assertPathInsideRoot,
  ensureDirectoryInsideRoot,
  inspectPluginLocalFolder,
} from "./plugin-local-folder-inspection.js";
import {
  inspectChildPath,
  readPluginLocalFolderText,
  resolvePluginLocalFolderPath,
} from "./plugin-local-folder-config.js";

export { inspectChildPath, readPluginLocalFolderText, resolvePluginLocalFolderPath };

export async function preparePluginLocalFolder(input: {
  declaration: PluginLocalFolderDeclaration;
  path: string;
}) {
  assertPluginLocalFolderKey(input.declaration.folderKey);
  if (input.declaration.access === "read" || !path.isAbsolute(input.path)) return;

  const configuredPath = path.resolve(input.path);
  try {
    const stat = await fs.stat(configuredPath);
    if (!stat.isDirectory()) return;
  } catch (error) {
    const code =
      typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code) : "";
    if (code !== "ENOENT") return;
    try {
      await fs.mkdir(configuredPath, { recursive: true });
    } catch {
      return;
    }
  }
  const rootRealPath = await fs.realpath(configuredPath);

  for (const requiredDir of input.declaration.requiredDirectories ?? []) {
    await ensureDirectoryInsideRoot(rootRealPath, validateRequiredPath(requiredDir, "requiredDirectories"));
  }
}

/** Prepare a configured folder, then return its canonical inspected status. */
export async function prepareAndInspectPluginLocalFolder(input: {
  declaration: PluginLocalFolderDeclaration;
  path: string;
}): Promise<PluginLocalFolderStatus> {
  await preparePluginLocalFolder(input);
  return inspectPluginLocalFolder(input);
}

export async function listPluginLocalFolderEntries(
  rootPath: string,
  options: {
    relativePath?: string | null;
    recursive?: boolean;
    maxEntries?: number;
  } = {},
): Promise<PluginLocalFolderListing> {
  const rootRealPath = await fs.realpath(rootPath);
  const relativePath = parseListRelativePath(options.relativePath);
  const target = relativePath
    ? await resolvePluginLocalFolderPath(rootRealPath, relativePath, {
        mustExist: true,
      })
    : { absolutePath: rootRealPath, realPath: rootRealPath, exists: true };
  const targetStat = await fs.stat(target.realPath);
  if (!targetStat.isDirectory()) {
    throw badRequest("Local folder list target must be a directory");
  }

  const maxEntries = parseMaxEntries(options.maxEntries);
  const entries: PluginLocalFolderEntry[] = [];
  let truncated = false;

  const visit = async (directoryRealPath: string, directoryRelativePath: string | null) => {
    if (truncated) return;
    const dirents = await fs.readdir(directoryRealPath, {
      withFileTypes: true,
    });
    dirents.sort((a, b) => a.name.localeCompare(b.name));

    for (const dirent of dirents) {
      if (entries.length >= maxEntries) {
        truncated = true;
        return;
      }

      const childRelativePath = directoryRelativePath
        ? `${directoryRelativePath}/${dirent.name}`
        : dirent.name;
      let resolvedChild: Awaited<ReturnType<typeof resolvePluginLocalFolderPath>>;
      try {
        resolvedChild = await resolvePluginLocalFolderPath(rootRealPath, childRelativePath, {
          mustExist: true,
        });
      } catch {
        continue;
      }

      const stat = await fs.stat(resolvedChild.realPath).catch(() => null);
      if (!stat) continue;
      const kind = stat.isDirectory() ? "directory" : stat.isFile() ? "file" : null;
      if (!kind) continue;

      entries.push({
        path: childRelativePath,
        name: dirent.name,
        kind,
        size: kind === "file" ? stat.size : null,
        modifiedAt: stat.mtime.toISOString(),
      });

      if (options.recursive && kind === "directory") {
        await visit(resolvedChild.realPath, childRelativePath);
        if (truncated) return;
      }
    }
  };

  await visit(target.realPath, relativePath);
  return {
    folderKey: "list-result",
    relativePath,
    entries,
    truncated,
  };
}

export async function writePluginLocalFolderTextAtomic(
  rootPath: string,
  relativePath: string,
  contents: string,
) {
  const rootRealPath = await fs.realpath(rootPath);
  const normalized = normalizeRelativePath(relativePath);
  const parentRelativePath = path.dirname(normalized);
  if (parentRelativePath !== ".") {
    await ensureDirectoryInsideRoot(rootRealPath, parentRelativePath);
  }
  const resolved = await resolvePluginLocalFolderPath(rootRealPath, normalized);
  await assertPathInsideRoot(rootRealPath, path.dirname(resolved.absolutePath));
  const tempPath = path.join(
    path.dirname(resolved.absolutePath),
    `.paperclip-${path.basename(resolved.absolutePath)}-${process.pid}-${randomUUID()}.tmp`,
  );
  let tempCreated = false;
  try {
    const handle = await fs.open(tempPath, "wx");
    tempCreated = true;
    try {
      await assertPathInsideRoot(rootRealPath, tempPath);
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (tempCreated) {
      await fs.rm(tempPath, { force: true });
    }
    throw error;
  }

  try {
    await resolvePluginLocalFolderPath(rootRealPath, relativePath);
    await fs.rename(tempPath, resolved.absolutePath);
    await resolvePluginLocalFolderPath(rootRealPath, relativePath, {
      mustExist: true,
    });
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    throw error;
  }

  if (process.platform !== "win32") {
    const dirHandle = await fs.open(path.dirname(resolved.absolutePath), "r");
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
  }
}

export async function deletePluginLocalFolderFile(rootPath: string, relativePath: string) {
  const rootRealPath = await fs.realpath(rootPath);
  const resolved = await resolvePluginLocalFolderPath(rootRealPath, relativePath, {
    mustExist: true,
    allowMissingLeaf: true,
  });

  if (resolved.exists) {
    const stat = await fs.lstat(resolved.absolutePath);
    if (stat.isDirectory()) {
      throw badRequest("Local folder delete target must be a file");
    }
    await fs.rm(resolved.absolutePath, { force: true });
    if (process.platform !== "win32") {
      const dirHandle = await fs.open(path.dirname(resolved.absolutePath), "r");
      try {
        await dirHandle.sync();
      } finally {
        await dirHandle.close();
      }
    }
  }
}

export function assertConfiguredLocalFolder(status: PluginLocalFolderStatus) {
  if (!status.configured || !status.realPath || !status.readable) {
    throw notFound("Local folder is not configured or readable");
  }
  if (!status.healthy) {
    throw badRequest("Local folder is not healthy");
  }
}

export function assertWritableConfiguredLocalFolder(status: PluginLocalFolderStatus) {
  if (!status.configured || !status.realPath || !status.readable) {
    throw notFound("Local folder is not configured or readable");
  }
  if (status.access !== "readWrite" || !status.writable) {
    throw forbidden("Local folder is not configured for writes");
  }
  const onlyMissingRequiredPaths = status.problems.every(
    (item) => item.code === "missing_directory" || item.code === "missing_file",
  );
  if (!status.healthy && !onlyMissingRequiredPaths) {
    throw badRequest("Local folder is not healthy");
  }
}
export * from "./plugin-local-folder-config.js";
export * from "./plugin-local-folder-inspection.js";
