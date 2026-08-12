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
const SOURCE_ROOTS = [
  "apps/server/src",
  "packages/adapter-utils/src",
  "packages/shared/src",
  "packages/plugins/sdk",
  "packages/cli/src",
  "apps/ui/src",
] as const;
const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

const FORBIDDEN_TERMS = [
  "nativeCorrelationKind",
  "nativeCorrelation",
  "task-execution-native/v1",
] as const;

type ForbiddenTerm = (typeof FORBIDDEN_TERMS)[number];

const FIXED_ACP_CORRELATION_CONTRACT_PATH =
  "packages/adapter-utils/src/acpx-runtime/correlation.ts";

export interface NativeCorrelationBoundaryFile {
  path: string;
  source: string;
}

export interface NativeCorrelationBoundaryViolation {
  path: string;
  line: number;
  column: number;
  term: ForbiddenTerm;
}

function toPosix(value: string): string {
  return value.split("\\").join("/");
}

function isTestOrGeneratedPath(path: string): boolean {
  const normalized = toPosix(path);
  const basename = normalized.split("/").at(-1) ?? "";
  return (
    normalized.includes("/node_modules/")
    || normalized.includes("/dist/")
    || normalized.includes("/generated/")
    || normalized.includes("/__tests__/")
    || normalized.startsWith("packages/db/migrations/")
    || /\.(?:test|spec|stories)\.[cm]?[jt]sx?$/.test(basename)
  );
}

type AllowedOccurrenceSpan = {
  readonly start: number;
  readonly end: number;
  readonly term: ForbiddenTerm;
};

function fixedAcpCorrelationContractSpans(
  path: string,
  source: string,
): readonly AllowedOccurrenceSpan[] {
  if (path !== FIXED_ACP_CORRELATION_CONTRACT_PATH) return [];
  const literal = '"task-execution-native/v1"';
  const start = source.indexOf(literal);
  if (start === -1 || source.indexOf(literal, start + literal.length) !== -1) {
    return [];
  }
  return [{
    start,
    end: start + literal.length,
    term: "task-execution-native/v1",
  }];
}

function lineAndColumn(
  source: string,
  offset: number,
): { line: number; column: number } {
  const before = source.slice(0, offset);
  const line = before.split("\n").length;
  const previousNewline = before.lastIndexOf("\n");
  return {
    line,
    column: offset - previousNewline,
  };
}

export function scanNativeCorrelationBoundaryFiles(
  files: readonly NativeCorrelationBoundaryFile[],
): NativeCorrelationBoundaryViolation[] {
  const violations: NativeCorrelationBoundaryViolation[] = [];
  for (const file of files) {
    const path = toPosix(file.path);
    if (isTestOrGeneratedPath(path)) {
      continue;
    }
    const allowedSpans = fixedAcpCorrelationContractSpans(
      path,
      file.source,
    );
    for (const term of FORBIDDEN_TERMS) {
      let offset = file.source.indexOf(term);
      while (offset !== -1) {
        const allowed = allowedSpans.some(
          (span) =>
            span.term === term &&
            offset >= span.start &&
            offset + term.length <= span.end,
        );
        if (!allowed) {
          const location = lineAndColumn(file.source, offset);
          violations.push({
            path,
            ...location,
            term,
          });
        }
        offset = file.source.indexOf(term, offset + term.length);
      }
    }
  }
  return violations.sort((left, right) =>
    left.path.localeCompare(right.path)
    || left.line - right.line
    || left.column - right.column
    || left.term.localeCompare(right.term));
}

function walkSourceFiles(
  directory: string,
  repositoryRoot: string,
  files: NativeCorrelationBoundaryFile[],
): void {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = join(directory, entry.name);
    const relativePath = toPosix(relative(repositoryRoot, absolutePath));
    if (entry.isDirectory()) {
      if (!isTestOrGeneratedPath(`${relativePath}/`)) {
        walkSourceFiles(absolutePath, repositoryRoot, files);
      }
      continue;
    }
    if (
      !SOURCE_EXTENSIONS.has(extname(entry.name))
      || isTestOrGeneratedPath(relativePath)
    ) {
      continue;
    }
    files.push({
      path: relativePath,
      source: readFileSync(absolutePath, "utf8"),
    });
  }
}

export function listNativeCorrelationBoundaryFiles(
  repositoryRoot = REPOSITORY_ROOT,
): NativeCorrelationBoundaryFile[] {
  const files: NativeCorrelationBoundaryFile[] = [];
  for (const root of SOURCE_ROOTS) {
    walkSourceFiles(resolve(repositoryRoot, root), repositoryRoot, files);
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

export function assertNativeCorrelationBoundary(
  repositoryRoot = REPOSITORY_ROOT,
): void {
  const violations = scanNativeCorrelationBoundaryFiles(
    listNativeCorrelationBoundaryFiles(repositoryRoot),
  );
  if (violations.length === 0) return;
  const details = violations
    .map((entry) =>
      `${entry.path}:${entry.line}:${entry.column} exposes ${entry.term}`)
    .join("\n");
  throw new Error(
    "Native correlation escaped its closed adapter/internal boundary:\n"
    + details,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  assertNativeCorrelationBoundary();
  console.log("Native-correlation boundary check passed.");
}
