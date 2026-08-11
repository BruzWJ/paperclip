import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import {
  extname,
  join,
  relative,
  resolve,
} from "node:path";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "..");
const SCAN_ROOTS = [
  ".agents",
  ".github",
  "apps",
  "doc",
  "packages",
  "scripts",
] as const;
const SOURCE_EXTENSIONS = new Set([
  ".cjs",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".sql",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);

const FORBIDDEN_TERMS = [
  ["taskExecution", "OutcomeTranslations"].join(""),
  ["task_execution", "_outcome_translations"].join(""),
  ["normalized", "Final"].join(""),
  ["normalized", "_final"].join(""),
  ["normalized", "-final"].join(""),
] as const;

type ForbiddenTerm = (typeof FORBIDDEN_TERMS)[number];

const SELF_TEST_PATH = "scripts/check-outcome-mirror-removal.test.ts";
const FINALIZATION_SCHEMA_PATH =
  "packages/db/schema/task_execution_runs.ts";
const COMMENT_SOURCE_SCHEMA_PATH =
  "packages/db/schema/task_comment_projection_sources.ts";

export interface OutcomeMirrorRemovalFile {
  readonly path: string;
  readonly source: string;
}

export interface OutcomeMirrorRemovalViolation {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly term: ForbiddenTerm;
}

function toPosix(value: string): string {
  return value.split("\\").join("/");
}

function isIgnored(path: string): boolean {
  const normalized = `/${toPosix(path)}`;
  return (
    normalized.includes("/.git/") ||
    normalized.includes("/coverage/") ||
    normalized.includes("/dist/") ||
    normalized.includes("/node_modules/") ||
    toPosix(path) === SELF_TEST_PATH
  );
}

function lineAndColumn(
  source: string,
  offset: number,
): { line: number; column: number } {
  const before = source.slice(0, offset);
  const previousNewline = before.lastIndexOf("\n");
  return {
    line: before.split("\n").length,
    column: offset - previousNewline,
  };
}

export function scanOutcomeMirrorRemovalFiles(
  files: readonly OutcomeMirrorRemovalFile[],
): OutcomeMirrorRemovalViolation[] {
  const violations: OutcomeMirrorRemovalViolation[] = [];
  for (const file of files) {
    for (const term of FORBIDDEN_TERMS) {
      let offset = file.source.indexOf(term);
      while (offset !== -1) {
        violations.push({
          path: toPosix(file.path),
          ...lineAndColumn(file.source, offset),
          term,
        });
        offset = file.source.indexOf(term, offset + term.length);
      }
    }
  }
  return violations.sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.line - right.line ||
      left.column - right.column ||
      left.term.localeCompare(right.term),
  );
}

function walk(
  directory: string,
  repositoryRoot: string,
  files: OutcomeMirrorRemovalFile[],
): void {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = join(directory, entry.name);
    const relativePath = toPosix(relative(repositoryRoot, absolutePath));
    if (isIgnored(relativePath)) continue;
    if (entry.isDirectory()) {
      walk(absolutePath, repositoryRoot, files);
      continue;
    }
    if (!SOURCE_EXTENSIONS.has(extname(entry.name))) continue;
    files.push({
      path: relativePath,
      source: readFileSync(absolutePath, "utf8"),
    });
  }
}

export function listOutcomeMirrorRemovalFiles(
  repositoryRoot = REPOSITORY_ROOT,
): OutcomeMirrorRemovalFile[] {
  const files: OutcomeMirrorRemovalFile[] = [];
  for (const root of SCAN_ROOTS) {
    walk(resolve(repositoryRoot, root), repositoryRoot, files);
  }
  return files.sort((left, right) =>
    left.path.localeCompare(right.path),
  );
}

function assertCanonicalOwners(repositoryRoot: string): void {
  const finalizationSource = readFileSync(
    resolve(repositoryRoot, FINALIZATION_SCHEMA_PATH),
    "utf8",
  );
  for (const required of [
    '"task_execution_finalizations"',
    "finalizationIdentityDigest",
    "terminalSessionEventId",
    "terminalSessionMessageId",
    "progressCommentId",
  ]) {
    if (!finalizationSource.includes(required)) {
      throw new Error(
        `${FINALIZATION_SCHEMA_PATH} is missing canonical finalization owner ${required}`,
      );
    }
  }

  const commentSource = readFileSync(
    resolve(repositoryRoot, COMMENT_SOURCE_SCHEMA_PATH),
    "utf8",
  );
  for (const required of [
    '"run_output"',
    '"run_progress"',
    '"task_update"',
  ]) {
    if (!commentSource.includes(required)) {
      throw new Error(
        `${COMMENT_SOURCE_SCHEMA_PATH} is missing canonical source kind ${required}`,
      );
    }
  }
}

export function assertOutcomeMirrorRemoval(
  repositoryRoot = REPOSITORY_ROOT,
): void {
  const violations = scanOutcomeMirrorRemovalFiles(
    listOutcomeMirrorRemovalFiles(repositoryRoot),
  );
  if (violations.length > 0) {
    throw new Error(
      `Obsolete outcome mirror identifiers remain:\n${violations
        .map(
          (entry) =>
            `${entry.path}:${entry.line}:${entry.column} contains ${entry.term}`,
        )
        .join("\n")}`,
    );
  }
  assertCanonicalOwners(repositoryRoot);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(import.meta.filename)
) {
  assertOutcomeMirrorRemoval();
  console.log("Outcome-mirror removal check passed.");
}
