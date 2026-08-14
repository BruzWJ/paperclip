import fs from "node:fs/promises";
import path from "node:path";
import { runGit } from "./workspace-runtime-process.js";

export type GitWorktreeListEntry = {
  worktree: string;
  branch: string | null;
};

export function parseGitWorktreeListPorcelain(raw: string): GitWorktreeListEntry[] {
  const entries: GitWorktreeListEntry[] = [];
  let current: Partial<GitWorktreeListEntry> = {};

  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      current = { worktree: line.slice("worktree ".length) };
      continue;
    }
    if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length);
      continue;
    }
    if (line === "" && current.worktree) {
      entries.push({
        worktree: current.worktree,
        branch: current.branch ?? null,
      });
      current = {};
    }
  }

  if (current.worktree) {
    entries.push({
      worktree: current.worktree,
      branch: current.branch ?? null,
    });
  }

  return entries;
}

export async function findRegisteredGitWorktreeByPath(
  repoRoot: string,
  worktreePath: string,
): Promise<GitWorktreeListEntry | null> {
  const raw = await runGit(["worktree", "list", "--porcelain"], repoRoot).catch(() => null);
  if (!raw) return null;

  const expectedPath = await resolvePathForWorktreeComparison(worktreePath);
  for (const entry of parseGitWorktreeListPorcelain(raw)) {
    if ((await resolvePathForWorktreeComparison(entry.worktree)) === expectedPath) {
      return entry;
    }
  }
  return null;
}

export async function resolvePathForWorktreeComparison(value: string): Promise<string> {
  const resolved = path.resolve(value);
  return fs
    .realpath(resolved)
    .then((realPath) => path.resolve(realPath))
    .catch(() => resolved);
}
