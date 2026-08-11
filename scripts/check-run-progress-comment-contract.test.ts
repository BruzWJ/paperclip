import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { runProgressCommentContractViolations } from "./check-run-progress-comment-contract.ts";

const roots = new Set<string>();

const CANONICAL_FILES: Readonly<Record<string, string>> = {
  "packages/shared/src/constants.ts":
    'const TASK_COMMENT_PRESENTATION_KINDS = ["run_progress"];\n',
  "packages/shared/src/types/task.ts":
    'type TaskCommentCanonicalSourceKind = | "run_progress";\n',
  "packages/db/schema/task_comments.ts":
    "task_comments_canonical_source_kind_check('run_progress');\n",
  "packages/db/schema/task_comment_projection_sources.ts": [
    "task_comment_projection_sources_run_progress_uq;",
    "task_comment_projection_sources_run_check;",
    "kind('run_progress');",
    "",
  ].join("\n"),
  "apps/server/src/services/task-execution-dispatcher-postgres.ts": [
    "immutableSourceKey: `run-progress:${created.run.runId}`;",
    "sourceRecordId: created.run.runId;",
    'exactText: "";',
    'projectionKind: "run_progress";',
    "runId: created.run.runId;",
    "",
  ].join("\n"),
  "apps/server/src/services/task-session/admission.ts": [
    'input.sourceKind === "run_progress";',
    'kind: "run_progress" as const;',
    "",
  ].join("\n"),
  "apps/server/src/services/task-session/projector.ts": [
    "function projectTaskSessionFinalCommentInTx() {}",
    'eq(taskCommentProjectionSources.sourceKind, "run_progress");',
    "eq(taskCommentProjectionSources.commentId, input.progressCommentId);",
    'comment.body !== "";',
    'comment.presentation?.kind !== "run_progress";',
    "eq(taskComments.id, comment.id);",
    "",
  ].join("\n"),
  "apps/server/src/services/task-execution-finalization-postgres.ts": [
    "progressCommentId: progress.comment.id;",
    "folded.id !== progress.comment.id;",
    "throw new Error('Stable progress comment did not fold to the exact terminal assistant');",
    "",
  ].join("\n"),
  "apps/server/src/services/context-retrieval.ts": [
    "function providerSafeCommentBody(value: unknown): string { return String(value); }",
    "const safe = { body: providerSafeCommentBody(comment.body) };",
    "",
  ].join("\n"),
  "apps/server/src/routes/openapi.ts":
    "const route = [boardTaskCommentSchema, boardTaskCommentGroupPageSchema];\n",
  "apps/ui/src/api/tasks.ts": "type Response = TaskComment | BoardTaskComment;\n",
  "apps/ui/src/lib/task-chat-messages.ts": [
    'comment.presentation?.kind === "run_progress";',
    'comment.runState === "queued";',
    '"Queued…";',
    'comment.runState === "working";',
    '"Working…";',
    "id: comment.id;",
    "",
  ].join("\n"),
};

function write(root: string, path: string, content: string): void {
  const absolutePath = join(root, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
}

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "paperclip-run-progress-gate-"));
  roots.add(root);
  for (const [path, source] of Object.entries(CANONICAL_FILES)) {
    write(root, path, source);
  }
  return root;
}

function replaceInFile(
  root: string,
  path: string,
  token: string,
  replacement: string,
): void {
  const absolutePath = join(root, path);
  write(
    root,
    path,
    readFileSync(absolutePath, "utf8").replaceAll(token, replacement),
  );
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

test("accepts one stable empty-body run-progress comment contract", () => {
  assert.deepEqual(runProgressCommentContractViolations(fixtureRoot()), []);
});

for (const [path, token] of [
  ["packages/shared/src/constants.ts", '"run_progress"'],
  ["packages/shared/src/types/task.ts", '| "run_progress"'],
  ["packages/db/schema/task_comments.ts", "'run_progress'"],
  [
    "packages/db/schema/task_comment_projection_sources.ts",
    "task_comment_projection_sources_run_progress_uq",
  ],
  [
    "apps/server/src/services/task-execution-dispatcher-postgres.ts",
    'exactText: ""',
  ],
  [
    "apps/server/src/services/task-session/admission.ts",
    'kind: "run_progress" as const',
  ],
  [
    "apps/server/src/services/task-session/projector.ts",
    "eq(taskComments.id, comment.id)",
  ],
  [
    "apps/server/src/services/task-execution-finalization-postgres.ts",
    "folded.id !== progress.comment.id",
  ],
  [
    "apps/server/src/services/context-retrieval.ts",
    "body: providerSafeCommentBody(comment.body)",
  ],
  ["apps/server/src/routes/openapi.ts", "boardTaskCommentSchema"],
  ["apps/ui/src/api/tasks.ts", "TaskComment"],
  ["apps/ui/src/lib/task-chat-messages.ts", '"Queued…"'],
] as const) {
  test(`fails closed when ${path} loses ${token}`, () => {
    const root = fixtureRoot();
    replaceInFile(root, path, token, "removedCanonicalToken");
    assert.ok(runProgressCommentContractViolations(root).length > 0);
  });
}

test("rejects synthetic run-assistant anchors", () => {
  const root = fixtureRoot();
  write(root, "apps/ui/src/lib/legacy-anchor.ts", "const id = `run-assistant:${run.id}`;\n");
  assert.ok(
    runProgressCommentContractViolations(root).some((violation) =>
      violation.includes("run-assistant:"),
    ),
  );
});

test("rejects non-empty validation for canonical run-progress bodies", () => {
  const root = fixtureRoot();
  write(
    root,
    "apps/server/src/services/context-retrieval.ts",
    `${CANONICAL_FILES["apps/server/src/services/context-retrieval.ts"]}\nconst rejected = requiredString(comment.body, "Context comment body");\n`,
  );
  assert.ok(
    runProgressCommentContractViolations(root).some((violation) =>
      violation.includes("must accept the canonical empty string"),
    ),
  );
});

for (const label of ['"Queued..."', '"Working..."'] as const) {
  test(`rejects ASCII run-progress label ${label}`, () => {
    const root = fixtureRoot();
    write(
      root,
      "apps/ui/src/lib/task-chat-messages.ts",
      `${CANONICAL_FILES["apps/ui/src/lib/task-chat-messages.ts"]}${label};\n`,
    );
    assert.ok(
      runProgressCommentContractViolations(root).some((violation) =>
        violation.includes("must use U+2026"),
      ),
    );
  });
}

for (const label of [
  'exactText: "Queued…"',
  'exactText: "Working…"',
] as const) {
  test(`rejects stored assistant progress label ${label}`, () => {
    const root = fixtureRoot();
    write(
      root,
      "apps/server/src/services/task-execution-dispatcher-postgres.ts",
      `${CANONICAL_FILES["apps/server/src/services/task-execution-dispatcher-postgres.ts"]}${label};\n`,
    );
    assert.ok(
      runProgressCommentContractViolations(root).some((violation) =>
        violation.includes("must be UI-derived"),
      ),
    );
  });
}
