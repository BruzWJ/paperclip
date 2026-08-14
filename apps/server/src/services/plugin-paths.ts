import fs from "node:fs";
import path from "node:path";

type PluginPathFailure = "invalid_root" | "invalid_relative_path" | "escape" | "missing" | "wrong_kind";

export class PluginPathError extends Error {
  constructor(
    readonly failure: PluginPathFailure,
    message: string,
  ) {
    super(message);
    this.name = "PluginPathError";
  }
}

export function isPathContained(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

export function resolvePluginPath(
  root: string,
  relativePath: string,
  options: {
    label: string;
    kind?: "file" | "directory";
  },
): string {
  if (!path.isAbsolute(root)) {
    throw new PluginPathError("invalid_root", `${options.label} root must be absolute`);
  }
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw new PluginPathError("invalid_relative_path", `${options.label} must be relative to its root`);
  }

  let canonicalRoot: string;
  try {
    canonicalRoot = fs.realpathSync(root);
  } catch {
    throw new PluginPathError("missing", `${options.label} root not found`);
  }
  if (!fs.statSync(canonicalRoot).isDirectory()) {
    throw new PluginPathError("invalid_root", `${options.label} root is not a directory`);
  }

  const candidate = path.resolve(canonicalRoot, relativePath);
  if (!isPathContained(canonicalRoot, candidate)) {
    throw new PluginPathError("escape", `${options.label} must resolve inside its root`);
  }
  if (!fs.existsSync(candidate)) {
    throw new PluginPathError("missing", `${options.label} not found`);
  }

  const canonicalCandidate = fs.realpathSync(candidate);
  if (!isPathContained(canonicalRoot, canonicalCandidate)) {
    throw new PluginPathError("escape", `${options.label} must resolve inside its root`);
  }
  const stat = fs.statSync(canonicalCandidate);
  if ((options.kind === "file" && !stat.isFile()) || (options.kind === "directory" && !stat.isDirectory())) {
    throw new PluginPathError("wrong_kind", `${options.label} is not a ${options.kind}`);
  }
  return canonicalCandidate;
}
