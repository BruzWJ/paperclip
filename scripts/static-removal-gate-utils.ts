import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

const TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".sh",
  ".sql",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);

const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".turbo",
  "coverage",
  "dist",
  "node_modules",
  "storybook-static",
]);

const REMOVAL_FIXTURE_MARKER = "PAPERCLIP_REMOVAL_NEGATIVE_FIXTURE:";

export interface LiteralRemovalGateInput {
  forbiddenTokens: readonly string[];
  ignoredPaths?: readonly string[];
  roots?: readonly string[];
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function isTestPath(path: string): boolean {
  return (
    path.includes("/__tests__/") ||
    /(?:^|\/)__fixtures__(?:\/|$)/.test(path) ||
    /\.(?:test|spec)\.[^.]+$/.test(path)
  );
}

function declaredRemovalFixtureTokens(
  path: string,
  content: string,
): ReadonlySet<string> {
  if (!isTestPath(path)) return new Set();

  const declared = new Set<string>();
  for (const line of content.split("\n")) {
    const marker = line.indexOf(REMOVAL_FIXTURE_MARKER);
    if (marker === -1) continue;
    const declaration = line.slice(marker + REMOVAL_FIXTURE_MARKER.length);
    for (const token of declaration.split(",")) {
      const normalized = token.trim().replace(/^[`'"]|[`'"]$/g, "");
      if (normalized.length > 0) declared.add(normalized);
    }
  }
  return declared;
}

function lineNumberAt(content: string, offset: number): number {
  return content.slice(0, offset).split("\n").length;
}

export function listRepositoryTextFiles(
  repositoryRoot: string,
  roots: readonly string[] = ["."],
): string[] {
  const files: string[] = [];
  const visit = (absolutePath: string) => {
    if (!existsSync(absolutePath)) return;
    if (statSync(absolutePath).isFile()) {
      if (TEXT_EXTENSIONS.has(extname(absolutePath))) files.push(absolutePath);
      return;
    }
    const entries = readdirSync(absolutePath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && SKIPPED_DIRECTORIES.has(entry.name)) {
        continue;
      }
      const child = join(absolutePath, entry.name);
      if (entry.isDirectory()) {
        visit(child);
      } else if (TEXT_EXTENSIONS.has(extname(entry.name))) {
        files.push(child);
      }
    }
  };

  for (const root of roots) visit(resolve(repositoryRoot, root));
  return [...new Set(files)].sort();
}

export function literalRemovalViolations(
  repositoryRoot: string,
  input: LiteralRemovalGateInput,
): string[] {
  const ignoredPaths = new Set(
    (input.ignoredPaths ?? []).map((path) => normalizePath(path)),
  );
  const violations: string[] = [];

  for (const absolutePath of listRepositoryTextFiles(
    repositoryRoot,
    input.roots,
  )) {
    const path = normalizePath(relative(repositoryRoot, absolutePath));
    if (ignoredPaths.has(path)) continue;

    const content = readFileSync(absolutePath, "utf8");
    const fixtureTokens = declaredRemovalFixtureTokens(path, content);
    for (const token of input.forbiddenTokens) {
      if (fixtureTokens.has(token)) continue;
      let offset = content.indexOf(token);
      while (offset !== -1) {
        violations.push(
          `${path}:${lineNumberAt(content, offset)}: forbidden retired token ${token}`,
        );
        offset = content.indexOf(token, offset + token.length);
      }
    }
  }

  return violations.sort();
}

export function requireFileTokens(
  repositoryRoot: string,
  path: string,
  tokens: readonly string[],
): string[] {
  const absolutePath = resolve(repositoryRoot, path);
  if (!existsSync(absolutePath)) {
    return [`${path}: required canonical owner is missing`];
  }
  const content = readFileSync(absolutePath, "utf8");
  return tokens
    .filter((token) => !content.includes(token))
    .map((token) => `${path}: missing canonical ownership token ${token}`);
}

export function assertNoGateViolations(
  label: string,
  violations: readonly string[],
): void {
  if (violations.length === 0) return;
  throw new Error(
    `${label} failed:\n${violations
      .map((violation) => `  ${violation}`)
      .join("\n")}`,
  );
}
