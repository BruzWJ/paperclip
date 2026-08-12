#!/usr/bin/env node

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import {
  basename,
  dirname,
  extname,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_PATH), "..");

export const TASK_VOCABULARY_SCAN_OWNERS = Object.freeze([
  ".agents",
  ".github",
  "apps",
  "design",
  "doc",
  "docker",
  "evals",
  "packages",
  "releases",
  "scripts",
  "tests",
  "tools",
  ".dockerignore",
  ".env.example",
  ".gitignore",
  ".mailmap",
  ".npmrc",
  "AGENTS.md",
  "CONTRIBUTING.md",
  "DESIGN.md",
  "Dockerfile",
  "LICENSE",
  "README.md",
  "ROADMAP.md",
  "SECURITY.md",
  "adapter-plugin.md",
  "opencode-donor.lock.json",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  "tsconfig.json",
  "turbo.json",
  "vitest.config.ts",
]);

const SCANNED_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".sh",
  ".sql",
  ".svg",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);

const SCANNED_FILE_NAMES = new Set([
  ".dockerignore",
  ".env.example",
  ".gitignore",
  ".mailmap",
  ".npmrc",
  "Dockerfile",
  "LICENSE",
]);

const SKIPPED_DIRECTORY_NAMES = new Set([
  ".git",
  ".next",
  ".turbo",
  ".vite",
  "coverage",
  "dist",
  "node_modules",
  "playwright-report",
  "storybook-static",
  "test-results",
  "ui-dist",
]);

export const RETIRED_WORK_OBJECT_LEXEME = String.fromCharCode(
  105,
  115,
  115,
  117,
  101,
);

type VocabularyOccurrence = {
  owner: string;
  line: number;
  column: number;
  token: string;
  locationKind: "content" | "path";
};

type ScanTargets = {
  contentFiles: string[];
  paths: string[];
};

type RetainedContract = {
  owner: string;
  expected: RegExp;
  message: string;
};

export const TASK_VOCABULARY_RETAINED_CONTRACTS: readonly RetainedContract[] =
  Object.freeze([
    {
      owner: "packages/shared/src/types/task.ts",
      expected: /\bexport type Task =/u,
      message: "the canonical Task type must remain exported",
    },
    {
      owner: "packages/shared/src/validators/task.ts",
      expected: /\bexport const createTaskSchema\b/u,
      message: "the canonical task create validator must remain exported",
    },
    {
      owner: "packages/db/schema/tasks.ts",
      expected: /\bexport const tasks = pgTable\(\s*"tasks"/u,
      message: "the canonical tasks table must retain its physical name",
    },
    {
      owner: "apps/server/src/routes/tasks.ts",
      expected: /\bexport function taskRoutes\(/u,
      message: "the canonical task router must remain exported",
    },
    {
      owner: "apps/server/src/routes/tasks.ts",
      expected: /router\.get\("\/companies\/:companyId\/tasks"/u,
      message: "the company task-list route must remain canonical",
    },
    {
      owner: "apps/server/src/routes/tasks.ts",
      expected: /router\.get\("\/tasks\/:id"/u,
      message: "the task detail route must remain canonical",
    },
    {
      owner: "apps/server/src/app.ts",
      expected: /\bapi\.use\(\s*taskRoutes\(/u,
      message: "the canonical task router must remain mounted",
    },
    {
      owner: "packages/shared/src/types/routine.ts",
      expected: /\blinkedTaskId: string \| null;/u,
      message: "routine runs must retain their linkedTaskId contract",
    },
    {
      owner: "apps/server/src/routes/routines.ts",
      expected: /entityType: "routine_run"/u,
      message: "routine_run must remain the unchanged execution activity kind",
    },
    {
      owner: "packages/db/schema/routines.ts",
      expected: /linkedTaskId: uuid\("linked_task_id"\)/u,
      message: "routine_runs must remain physically linked to their execution task",
    },
  ]);

function normalizeOwnerPath(repositoryRoot: string, absolutePath: string): string {
  return relative(repositoryRoot, absolutePath).replaceAll("\\", "/");
}

function isScannedContentFile(absolutePath: string): boolean {
  return (
    SCANNED_EXTENSIONS.has(extname(absolutePath)) ||
    SCANNED_FILE_NAMES.has(basename(absolutePath))
  );
}

function collectScanTargets(
  repositoryRoot: string,
  owners: readonly string[],
): ScanTargets {
  const contentFiles = new Set<string>();
  const paths = new Set<string>();

  const visit = (absolutePath: string): void => {
    if (!existsSync(absolutePath)) return;
    const stat = statSync(absolutePath);
    const owner = normalizeOwnerPath(repositoryRoot, absolutePath);
    if (owner) paths.add(owner);

    if (stat.isFile()) {
      if (isScannedContentFile(absolutePath)) contentFiles.add(absolutePath);
      return;
    }

    for (const entry of readdirSync(absolutePath, { withFileTypes: true })) {
      if (
        entry.isDirectory() &&
        SKIPPED_DIRECTORY_NAMES.has(entry.name)
      ) {
        continue;
      }
      visit(join(absolutePath, entry.name));
    }
  };

  for (const owner of owners) visit(resolve(repositoryRoot, owner));

  return {
    contentFiles: Array.from(contentFiles).sort(),
    paths: Array.from(paths).sort(),
  };
}

function candidateSpans(text: string): Array<{ index: number; token: string }> {
  const pattern = new RegExp(RETIRED_WORK_OBJECT_LEXEME, "giu");
  return Array.from(text.matchAll(pattern), (match) => ({
    index: match.index ?? 0,
    token: match[0],
  }));
}

function lineAndColumn(
  text: string,
  offset: number,
): { line: number; column: number } {
  const before = text.slice(0, offset);
  const previousNewline = before.lastIndexOf("\n");
  return {
    line: before.split("\n").length,
    column: offset - previousNewline,
  };
}

function scanTargets(
  repositoryRoot: string,
  targets: ScanTargets,
): VocabularyOccurrence[] {
  const occurrences: VocabularyOccurrence[] = [];

  for (const owner of targets.paths) {
    for (const span of candidateSpans(owner)) {
      occurrences.push({
        owner,
        line: 0,
        column: span.index + 1,
        token: span.token,
        locationKind: "path",
      });
    }
  }

  for (const absolutePath of targets.contentFiles) {
    const owner = normalizeOwnerPath(repositoryRoot, absolutePath);
    const content = readFileSync(absolutePath, "utf8");
    for (const span of candidateSpans(content)) {
      occurrences.push({
        owner,
        ...lineAndColumn(content, span.index),
        token: span.token,
        locationKind: "content",
      });
    }
  }

  return occurrences.sort(
    (left, right) =>
      left.owner.localeCompare(right.owner) ||
      left.line - right.line ||
      left.column - right.column ||
      left.token.localeCompare(right.token),
  );
}

function contractViolation(
  repositoryRoot: string,
  contract: RetainedContract,
): string | null {
  const absolutePath = resolve(repositoryRoot, contract.owner);
  if (!existsSync(absolutePath)) {
    return `${contract.owner}: missing required contract owner (${contract.message})`;
  }
  const content = readFileSync(absolutePath, "utf8");
  return contract.expected.test(content)
    ? null
    : `${contract.owner}: ${contract.message}`;
}

export function scanTaskVocabulary(
  repositoryRoot: string,
  owners: readonly string[] = TASK_VOCABULARY_SCAN_OWNERS,
  options: { checkRetainedContracts?: boolean } = {},
): string[] {
  const targets = collectScanTargets(repositoryRoot, owners);
  const violations = scanTargets(repositoryRoot, targets).map((occurrence) => {
    const location =
      occurrence.locationKind === "path"
        ? occurrence.owner
        : `${occurrence.owner}:${occurrence.line}:${occurrence.column}`;
    return `${location}: retired work-object vocabulary "${occurrence.token}" is forbidden`;
  });

  if (options.checkRetainedContracts !== false) {
    violations.push(
      ...TASK_VOCABULARY_RETAINED_CONTRACTS.map((contract) =>
        contractViolation(repositoryRoot, contract),
      ).filter((violation): violation is string => violation !== null),
    );
  }

  return Array.from(new Set(violations)).sort();
}

export function assertTaskVocabulary(
  repositoryRoot: string = REPOSITORY_ROOT,
): void {
  const violations = scanTaskVocabulary(repositoryRoot);
  if (violations.length === 0) return;
  throw new Error(
    `Task vocabulary gate failed:\n\n${violations
      .map((violation) => `  ${violation}`)
      .join("\n")}`,
  );
}

function main(): void {
  try {
    assertTaskVocabulary(REPOSITORY_ROOT);
    console.log(
      "Task vocabulary gate passed: task and sub-task are the only canonical work-object identities across checked paths and content.",
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (resolve(process.argv[1] ?? "") === SCRIPT_PATH) main();
