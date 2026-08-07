import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { scanIssueVocabulary } from "./check-issue-vocabulary.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "paperclip-issue-vocabulary-"));
  temporaryRoots.push(root);
  for (const [owner, content] of Object.entries(files)) {
    const absolutePath = join(root, owner);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content, "utf8");
  }
  return root;
}

function scan(files: Record<string, string>): string[] {
  const root = fixture(files);
  return scanIssueVocabulary(root, Object.keys(files), {
    checkRetainedContracts: false,
  });
}

test("rejects word, camelCase, snake_case, kebab-case, and path vocabulary", () => {
  const violations = scan({
    "apps/server/src/routes/tasks.ts": [
      "const taskRows = [];",
      'const source = "sub_task";',
      'const path = "sub-task";',
      'const message = "linked tasks";',
    ].join("\n"),
  });
  assert.ok(
    violations.some((entry) =>
      entry.includes("apps/server/src/routes/tasks.ts: issue-domain"),
    ),
  );
  assert.ok(violations.some((entry) => entry.includes('"taskRows"')));
  assert.ok(violations.some((entry) => entry.includes('"sub_task"')));
  assert.ok(violations.some((entry) => entry.includes('"sub-task"')));
  assert.ok(violations.some((entry) => entry.includes('"tasks"')));
});

test("rejects a renamed issue_bridge alias", () => {
  const violations = scan({
    "apps/server/src/services/execution-mode-context-mask.ts":
      'export const originKind = "issue_bridge";\n',
  });
  assert.ok(
    violations.some((entry) =>
      entry.includes("retired issue_bridge alias is forbidden"),
    ),
  );
});

test("allows only the exact retained task_bridge owner", () => {
  const allowedRoot = fixture({
    "apps/server/src/services/execution-mode-context-mask.ts":
      'if (input.originKind === "task_bridge") return denyAll;\n',
  });
  assert.deepEqual(
    scanIssueVocabulary(
      allowedRoot,
      ["apps/server/src/services/execution-mode-context-mask.ts"],
      { checkRetainedContracts: false },
    ),
    [],
  );

  const violations = scan({
    "apps/server/src/services/other.ts":
      'export const originKind = "task_bridge";\n',
  });
  assert.ok(violations.some((entry) => entry.includes('"task_bridge"')));

  const mixedLineViolations = scan({
    "apps/server/src/services/execution-mode-context-mask.ts":
      'if (input.originKind === "task_bridge") throw new Error("linked task");\n',
  });
  assert.ok(mixedLineViolations.some((entry) => entry.includes('"task"')));
});

test("allows an owned Promise work queue but rejects issue-domain wording beside it", () => {
  const root = fixture({
    "apps/server/src/routes/issue-tree-control.ts": [
      "async function waitForRunCancellationTasks(tasks: Promise<void>[]) {",
      "  await Promise.all(tasks);",
      "}",
      'const message = "linked task";',
    ].join("\n"),
  });
  const violations = scanIssueVocabulary(
    root,
    ["apps/server/src/routes/issue-tree-control.ts"],
    { checkRetainedContracts: false },
  );
  assert.equal(violations.length, 1);
  assert.ok(violations[0].includes('"task"'));
});

test("rejects copied native Task API vocabulary outside retained contracts", () => {
  const violations = scan({
    "doc/plans/copied-vocabulary.md":
      "Paperclip constructs a Task from its task provider.\n",
  });
  assert.ok(violations.some((entry) => entry.includes('"Task"')));
});

test("fails closed when routine_run or linkedIssueId ownership is renamed", () => {
  const root = fixture({
    "apps/server/src/services/execution-mode-context-mask.ts":
      'if (input.originKind === "task_bridge") return denyAll;\n',
    "packages/shared/src/types/routine.ts":
      "export interface RoutineRun { linkedIssueId: string | null; }\n",
    "apps/server/src/routes/routines.ts":
      'const activity = { entityType: "routine_issue" };\n',
    "packages/db/schema/routines.ts":
      'const row = { linkedIssueId: uuid("linked_issue_id") };\n',
  });
  const violations = scanIssueVocabulary(root, [
    "apps/server/src/services/execution-mode-context-mask.ts",
    "packages/shared/src/types/routine.ts",
    "apps/server/src/routes/routines.ts",
    "packages/db/schema/routines.ts",
  ]);
  assert.ok(
    violations.some((entry) =>
      entry.includes("routine_run must remain the unchanged execution activity kind"),
    ),
  );
});
