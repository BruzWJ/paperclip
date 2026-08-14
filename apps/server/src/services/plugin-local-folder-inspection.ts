import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import type {
  PluginLocalFolderDeclaration,
  PluginLocalFolderProblem,
  PluginLocalFolderStatus,
} from "@paperclipai/plugin-sdk";
import { assertPluginLocalFolderKey, problem, validateRequiredPath } from "./plugin-local-folder-config.js";
import {
  assertPathInsideRoot,
  ensureDirectoryInsideRoot,
  inspectChildPath,
  isInsideRoot,
} from "./plugin-local-folder-config.js";

export { assertPathInsideRoot, ensureDirectoryInsideRoot, isInsideRoot };

export async function inspectPluginLocalFolder(input: {
  declaration: PluginLocalFolderDeclaration;
  path: string | null;
}): Promise<PluginLocalFolderStatus> {
  assertPluginLocalFolderKey(input.declaration.folderKey);
  const access = input.declaration.access ?? "readWrite";
  const requiredDirectories = (input.declaration.requiredDirectories ?? []).map((item) =>
    validateRequiredPath(item, "requiredDirectories"),
  );
  const requiredFiles = (input.declaration.requiredFiles ?? []).map((item) =>
    validateRequiredPath(item, "requiredFiles"),
  );
  const checkedAt = new Date().toISOString();

  if (!input.path) {
    return {
      folderKey: input.declaration.folderKey,
      configured: false,
      path: null,
      realPath: null,
      access,
      readable: false,
      writable: false,
      requiredDirectories,
      requiredFiles,
      missingDirectories: requiredDirectories,
      missingFiles: requiredFiles,
      healthy: false,
      problems: [problem("not_configured", "No local folder path is configured.")],
      checkedAt,
    };
  }

  const configuredPath = path.resolve(input.path);
  const problems: PluginLocalFolderProblem[] = [];
  const missingDirectories: string[] = [];
  const missingFiles: string[] = [];
  const markRequiredPathsMissing = () => {
    missingDirectories.push(...requiredDirectories);
    missingFiles.push(...requiredFiles);
  };
  let realPath: string | null = null;
  let readable = false;
  let writable = false;

  if (!path.isAbsolute(input.path)) {
    problems.push(problem("not_absolute", "Local folder path must be absolute.", input.path));
  }

  try {
    const stat = await fs.stat(configuredPath);
    if (!stat.isDirectory()) {
      problems.push(
        problem("not_directory", "Configured local folder path is not a directory.", configuredPath),
      );
      markRequiredPathsMissing();
    } else {
      realPath = await fs.realpath(configuredPath);
      try {
        await fs.access(realPath, fsConstants.R_OK);
        readable = true;
      } catch {
        problems.push(problem("not_readable", "Configured local folder is not readable.", configuredPath));
      }

      if (access === "readWrite") {
        try {
          await fs.access(realPath, fsConstants.W_OK);
          const probePath = path.join(realPath, `.paperclip-local-folder-probe-${process.pid}-${Date.now()}`);
          await fs.writeFile(probePath, "");
          await fs.rm(probePath, { force: true });
          writable = true;
        } catch {
          problems.push(problem("not_writable", "Configured local folder is not writable.", configuredPath));
        }
      }

      for (const requiredDir of requiredDirectories) {
        const requiredStatus = await inspectChildPath(realPath, requiredDir, "directory");
        if (!requiredStatus.exists) {
          missingDirectories.push(requiredDir);
          problems.push(problem("missing_directory", "Required directory is missing.", requiredDir));
        } else if (!requiredStatus.contained) {
          problems.push(
            problem("symlink_escape", "Required directory escapes the configured root.", requiredDir),
          );
        } else if (!requiredStatus.matchesKind) {
          missingDirectories.push(requiredDir);
          problems.push(problem("missing_directory", "Required path is not a directory.", requiredDir));
        }
      }

      for (const requiredFile of requiredFiles) {
        const requiredStatus = await inspectChildPath(realPath, requiredFile, "file");
        if (!requiredStatus.exists) {
          missingFiles.push(requiredFile);
          problems.push(problem("missing_file", "Required file is missing.", requiredFile));
        } else if (!requiredStatus.contained) {
          problems.push(
            problem("symlink_escape", "Required file escapes the configured root.", requiredFile),
          );
        } else if (!requiredStatus.matchesKind) {
          missingFiles.push(requiredFile);
          problems.push(problem("missing_file", "Required path is not a file.", requiredFile));
        }
      }
    }
  } catch (error) {
    const code =
      typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code) : "";
    problems.push(
      problem(
        code === "ENOENT" ? "missing" : "not_readable",
        "Configured local folder cannot be inspected.",
        configuredPath,
      ),
    );
    if (code === "ENOENT") {
      markRequiredPathsMissing();
    }
  }

  return {
    folderKey: input.declaration.folderKey,
    configured: true,
    path: configuredPath,
    realPath,
    access,
    readable,
    writable: access === "read" ? false : writable,
    requiredDirectories,
    requiredFiles,
    missingDirectories,
    missingFiles,
    healthy: problems.length === 0 && readable && (access === "read" || writable),
    problems,
    checkedAt,
  };
}
