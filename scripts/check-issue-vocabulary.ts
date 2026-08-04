#!/usr/bin/env node

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import {
  dirname,
  extname,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_PATH), "..");

export const ISSUE_VOCABULARY_SCAN_OWNERS = Object.freeze([
  "README.md",
  "ROADMAP.md",
  "AGENTS.md",
  "adapter-plugin.md",
  ".agents/skills/company-creator",
  ".agents/skills/create-agent-adapter",
  ".agents/skills/doc-maintenance",
  ".agents/skills/prepare-paperclip-pr",
  "apps/server/src",
  "packages/db/schema",
  "packages/shared/src",
  "packages/plugins/sdk/src",
  "packages/plugins/sdk/README.md",
  "packages/teams-catalog/catalog",
  "packages/teams-catalog/generated",
  "packages/cli/src",
  "packages/cli/README.md",
  "apps/ui/src/api",
  "apps/docs",
  "doc",
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
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);

const SKIPPED_DIRECTORY_NAMES = new Set(["dist", "node_modules"]);

const TASK_TOKEN_PATTERNS = Object.freeze([
  /\b(?:sub[-_ ]?)?tasks?\b/giu,
  /\b(?:sub)?task[_-][a-z0-9_-]+/giu,
  /\b(?:sub)?task[A-Z][a-zA-Z0-9]*\b/gu,
  /\b[a-z0-9]+(?:Task|Tasks|Subtask|Subtasks)[a-z0-9]*\b/gu,
  /\b(?:Task|Tasks|Subtask|Subtasks)[A-Z][a-zA-Z0-9]*\b/gu,
  /\b[a-z0-9]+(?:[_-][a-z0-9]+)*[_-](?:sub)?tasks?(?:[_-][a-z0-9]+)*\b/giu,
  /papercliptaskid/giu,
]);

type VocabularyOccurrence = {
  owner: string;
  line: number;
  column: number;
  token: string;
  text: string;
  locationKind: "content" | "path";
};

type OwnerAllowance = {
  category: string;
  owner: string;
  line?: RegExp;
  token?: RegExp;
  wholeOwner?: true;
};

/**
 * Every exception is owned by one exact file and one semantic line pattern.
 * There is deliberately no directory-wide or generic task-token exemption.
 */
export const ISSUE_VOCABULARY_OWNER_ALLOWLIST: readonly OwnerAllowance[] =
  Object.freeze([
    {
      category: "retained-security-discriminator",
      owner: "apps/server/src/services/execution-mode-context-mask.ts",
      line: /input\.originKind === "task_bridge"/u,
      token: /^task_bridge$/u,
    },
    {
      category: "promise-cancellation-work-queue",
      owner: "apps/server/src/routes/issue-tree-control.ts",
      line: /(?:waitForRunCancellationTasks|runCancellationTasks|cancellationTask|tasks: Promise<void>\[\]|Promise\.all\(tasks\))/u,
      token: /^(?:waitForRunCancellationTasks|runCancellationTasks|cancellationTask|tasks)$/u,
    },
    {
      category: "javascript-microtask",
      owner: "apps/server/src/services/plugin-event-bus.ts",
      line: /\bmicrotask\b/u,
    },
    {
      category: "provider-process-stop-reason",
      owner: "apps/server/src/services/run-liveness.ts",
      line: /(?:UNMANAGED_BACKGROUND_TASK|unmanaged_background_task_stopped|unmanaged background task stopped|unmanagedBackgroundTask|hasUnmanagedBackgroundTaskEvidence)/u,
    },
    {
      category: "rendered-ui-copy-governed-by-design",
      owner: "apps/server/src/ui-branding.ts",
      line: /"Run tasks in this worktree"/u,
    },
    {
      category: "provider-native-stream-example",
      owner: "apps/docs/adapters/adapter-ui-parser.md",
      line: /"Thinking about the task\.\.\."/u,
    },
    {
      category: "aws-ecs-native-vocabulary",
      owner: "apps/docs/deploy/aws-ecs.md",
      line: /(?:\bECS\b|\becs-|AmazonECS|TASK_ARN|task-definition|list-tasks|describe-tasks|tasks\[|task def|Task execution|Task role|Watch task|Check task|new task|old task|paperclip-task-def|taskDefinitionArns)/u,
    },
    {
      category: "aws-ecs-native-vocabulary",
      owner: "apps/docs/deploy/secrets.md",
      line: /(?:ECS task role|orchestrator task role|^task role\))/u,
    },
    {
      category: "aws-ecs-native-vocabulary",
      owner: "doc/SECRETS-AWS-PROVIDER.md",
      line: /ECS task role/u,
    },
    {
      category: "third-party-crm-native-object",
      owner: "doc/connections/FIRST-30-MATRIX.md",
      line: /create (?:note\/task|task\/note)/u,
    },
    {
      category: "design-locked-ui-token",
      owner: "doc/design/CHANGING-THE-UI.md",
      line: /--status-task-/u,
    },
    {
      category: "design-locked-ui-token",
      owner: "doc/design/DECISION-SHEET.md",
      line: /--status-task-/u,
    },
    {
      category: "design-locked-ui-token",
      owner: "doc/design/COMPONENT-INVENTORY.md",
      line: /--status-task-/u,
    },
    {
      category: "design-locked-ui-token",
      owner: "doc/design/TOKEN-AUDIT.md",
      line: /(?:--status-task-|taskStatusVar)/u,
    },
    {
      category: "plan-work-unit",
      owner: "doc/plans/2026-05-05-scaled-kanban-board.md",
      line: /(?:task-by-task|^## Task \d+:)/u,
    },
    {
      category: "vscode-native-task-api",
      owner: "doc/plans/2026-04-12-vscode-task-interoperability-plan.md",
      wholeOwner: true,
    },
    {
      category: "rendered-ui-copy-governed-by-design",
      owner: "doc/spec/ui.md",
      wholeOwner: true,
    },
  ]);

function normalizeOwnerPath(repositoryRoot: string, absolutePath: string): string {
  return relative(repositoryRoot, absolutePath).replaceAll("\\", "/");
}

function isTestOrRemovalProofOwner(owner: string): boolean {
  return (
    owner.includes("/__tests__/") ||
    /\.(?:test|spec)\.[^.]+$/u.test(owner) ||
    owner.includes("/__fixtures__/") ||
    owner.includes("/fixtures/")
  );
}

function collectFiles(repositoryRoot: string, owners: readonly string[]): string[] {
  const files: string[] = [];
  const visit = (absolutePath: string): void => {
    if (!existsSync(absolutePath)) return;
    const stat = statSync(absolutePath);
    if (stat.isFile()) {
      const owner = normalizeOwnerPath(repositoryRoot, absolutePath);
      if (
        SCANNED_EXTENSIONS.has(extname(absolutePath)) &&
        !isTestOrRemovalProofOwner(owner)
      ) {
        files.push(absolutePath);
      }
      return;
    }
    for (const entry of readdirSync(absolutePath, { withFileTypes: true })) {
      if (entry.isDirectory() && SKIPPED_DIRECTORY_NAMES.has(entry.name)) {
        continue;
      }
      visit(join(absolutePath, entry.name));
    }
  };
  for (const owner of owners) {
    visit(resolve(repositoryRoot, owner));
  }
  return Array.from(new Set(files)).sort();
}

function candidateSpans(text: string): Array<{ index: number; token: string }> {
  const spans = new Map<string, { index: number; token: string }>();
  for (const pattern of TASK_TOKEN_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const index = match.index ?? 0;
      const token = match[0];
      spans.set(`${index}:${token}`, { index, token });
    }
  }
  return Array.from(spans.values()).sort((left, right) =>
    left.index - right.index || left.token.localeCompare(right.token),
  );
}

function isAllowedOccurrence(occurrence: VocabularyOccurrence): boolean {
  return ISSUE_VOCABULARY_OWNER_ALLOWLIST.some(
    (allowance) =>
      allowance.owner === occurrence.owner &&
      (allowance.wholeOwner === true ||
        (occurrence.locationKind === "content" &&
          allowance.line?.test(occurrence.text) === true &&
          (allowance.token === undefined ||
            allowance.token.test(occurrence.token)))),
  );
}

function scanOwner(
  repositoryRoot: string,
  absolutePath: string,
): VocabularyOccurrence[] {
  const owner = normalizeOwnerPath(repositoryRoot, absolutePath);
  const occurrences: VocabularyOccurrence[] = [];

  for (const span of candidateSpans(owner)) {
    occurrences.push({
      owner,
      line: 0,
      column: span.index + 1,
      token: span.token,
      text: owner,
      locationKind: "path",
    });
  }

  const lines = readFileSync(absolutePath, "utf8").split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    for (const span of candidateSpans(lines[index])) {
      occurrences.push({
        owner,
        line: index + 1,
        column: span.index + 1,
        token: span.token,
        text: lines[index],
        locationKind: "content",
      });
    }
  }
  return occurrences;
}

function contractViolation(
  repositoryRoot: string,
  owner: string,
  expected: RegExp,
  message: string,
): string | null {
  const absolutePath = resolve(repositoryRoot, owner);
  if (!existsSync(absolutePath)) {
    return `${owner}: missing required contract owner (${message})`;
  }
  const content = readFileSync(absolutePath, "utf8");
  return expected.test(content) ? null : `${owner}: ${message}`;
}

export function scanIssueVocabulary(
  repositoryRoot: string,
  owners: readonly string[] = ISSUE_VOCABULARY_SCAN_OWNERS,
  options: { checkRetainedContracts?: boolean } = {},
): string[] {
  const violations: string[] = [];
  for (const absolutePath of collectFiles(repositoryRoot, owners)) {
    const owner = normalizeOwnerPath(repositoryRoot, absolutePath);
    const content = readFileSync(absolutePath, "utf8");
    const lines = content.split(/\r?\n/u);
    for (let index = 0; index < lines.length; index += 1) {
      if (/\bissue_bridge\b/u.test(lines[index])) {
        violations.push(
          `${owner}:${index + 1}: retired issue_bridge alias is forbidden; the retained security discriminator is exactly task_bridge`,
        );
      }
    }
    for (const occurrence of scanOwner(repositoryRoot, absolutePath)) {
      if (isAllowedOccurrence(occurrence)) continue;
      const location =
        occurrence.locationKind === "path"
          ? owner
          : `${owner}:${occurrence.line}:${occurrence.column}`;
      violations.push(
        `${location}: issue-domain task vocabulary "${occurrence.token}" is forbidden`,
      );
    }
  }

  if (options.checkRetainedContracts !== false) {
    const contracts: Array<string | null> = [
      contractViolation(
        repositoryRoot,
        "apps/server/src/services/execution-mode-context-mask.ts",
        /input\.originKind === "task_bridge"/u,
        "task_bridge must remain the exact all-false execution-mode discriminator",
      ),
      contractViolation(
        repositoryRoot,
        "packages/shared/src/types/routine.ts",
        /\blinkedIssueId: string \| null;/u,
        "routine runs must retain their linkedIssueId contract",
      ),
      contractViolation(
        repositoryRoot,
        "apps/server/src/routes/routines.ts",
        /entityType: "routine_run"/u,
        "routine_run must remain the unchanged execution activity kind",
      ),
      contractViolation(
        repositoryRoot,
        "packages/db/schema/routines.ts",
        /linkedIssueId: uuid\("linked_issue_id"\)/u,
        "routine_runs must remain physically linked to their execution issue",
      ),
    ];
    violations.push(
      ...contracts.filter((violation): violation is string =>
        violation !== null,
      ),
    );
  }

  return Array.from(new Set(violations)).sort();
}

export function assertIssueVocabulary(
  repositoryRoot: string = REPOSITORY_ROOT,
): void {
  const violations = scanIssueVocabulary(repositoryRoot);
  if (violations.length === 0) return;
  throw new Error(
    `Issue vocabulary gate failed:\n\n${violations
      .map((violation) => `  ${violation}`)
      .join("\n")}`,
  );
}

function main(): void {
  try {
    assertIssueVocabulary(REPOSITORY_ROOT);
    console.log(
      "Issue vocabulary gate passed: issue/sub-issue own the checked backend, contract, CLI, portability, generated, and documentation surfaces.",
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (resolve(process.argv[1] ?? "") === SCRIPT_PATH) {
  main();
}
