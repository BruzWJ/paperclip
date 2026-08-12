import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import {
  RETIRED_WORK_OBJECT_LEXEME,
  scanTaskVocabulary,
} from "./check-task-vocabulary.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "paperclip-task-vocabulary-"));
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
  return scanTaskVocabulary(root, Object.keys(files), {
    checkRetainedContracts: false,
  });
}

function canonicalContractFixture(): Record<string, string> {
  return {
    "packages/shared/src/types/task.ts":
      "export type Task = TaskBase & CanonicalTaskOwner;\n",
    "packages/shared/src/validators/task.ts":
      "export const createTaskSchema = canonicalTaskCreateBaseSchema;\n",
    "packages/db/schema/tasks.ts":
      'export const tasks = pgTable(\n  "tasks",\n  {},\n);\n',
    "apps/server/src/routes/tasks.ts": [
      "export function taskRoutes() {",
      '  router.get("/companies/:companyId/tasks", handler);',
      '  router.get("/tasks/:id", handler);',
      "}",
    ].join("\n"),
    "apps/server/src/app.ts": "api.use(taskRoutes(db));\n",
    "packages/shared/src/types/routine.ts":
      "export interface RoutineRun { linkedTaskId: string | null; }\n",
    "apps/server/src/routes/routines.ts":
      'const activity = { entityType: "routine_run" };\n',
    "packages/db/schema/routines.ts":
      'const row = { linkedTaskId: uuid("linked_task_id") };\n',
  };
}

test("allows canonical task words, identifiers, and paths", () => {
  assert.deepEqual(
    scan({
      "apps/server/src/routes/tasks.ts": [
        "const taskRows = [];",
        'const source = "sub_task";',
        'const path = "sub-task";',
        'const message = "linked tasks";',
      ].join("\n"),
    }),
    [],
  );
});

test("rejects the retired work-object lexeme in content and paths", () => {
  const retired = RETIRED_WORK_OBJECT_LEXEME;
  const owner = `apps/server/src/routes/${retired}s.ts`;
  const violations = scan({
    [owner]: [
      `const ${retired}Rows = [];`,
      `const source = "sub_${retired}";`,
      `const path = "sub-${retired}";`,
      `const upper = "${retired.toUpperCase()}";`,
      `const plural = "${retired}s";`,
    ].join("\n"),
  });

  assert.ok(violations.some((entry) => entry.startsWith(`${owner}: retired`)));
  assert.ok(violations.some((entry) => entry.includes(`"${retired}"`)));
  assert.ok(violations.some((entry) => entry.includes(`"${retired.toUpperCase()}"`)));
  assert.ok(violations.length >= 6);
});

test("checks non-text file paths without reading binary content", () => {
  const retired = RETIRED_WORK_OBJECT_LEXEME;
  const owner = `apps/docs/assets/${retired}-screen.png`;
  const violations = scan({ [owner]: "not parsed as text" });

  assert.equal(violations.length, 1);
  assert.ok(violations[0]?.startsWith(`${owner}: retired`));
});

test("ignores generated server UI build output", () => {
  const retired = RETIRED_WORK_OBJECT_LEXEME;
  const root = fixture({
    "apps/server/src/routes/tasks.ts": "const taskRows = [];\n",
    [`apps/server/ui-dist/assets/${retired}-vendor.js`]:
      `const thirdPartyVocabulary = "${retired}";\n`,
  });

  assert.deepEqual(
    scanTaskVocabulary(root, ["apps"], { checkRetainedContracts: false }),
    [],
  );
});

test("gate sources do not spell the retired lexeme", () => {
  const sources = [
    readFileSync(new URL("./check-task-vocabulary.ts", import.meta.url), "utf8"),
    readFileSync(
      new URL("./check-task-vocabulary.test.ts", import.meta.url),
      "utf8",
    ),
  ];

  for (const source of sources) {
    assert.equal(
      source.toLocaleLowerCase().includes(RETIRED_WORK_OBJECT_LEXEME),
      false,
    );
  }
});

test("accepts the retained canonical task contracts", () => {
  const files = canonicalContractFixture();
  const root = fixture(files);
  assert.deepEqual(scanTaskVocabulary(root, Object.keys(files)), []);
});

test("fails closed when a retained task contract is renamed", () => {
  const files = canonicalContractFixture();
  files["apps/server/src/routes/routines.ts"] =
    'const activity = { entityType: "routine_task" };\n';
  const root = fixture(files);
  const violations = scanTaskVocabulary(root, Object.keys(files));

  assert.ok(
    violations.some((entry) =>
      entry.includes(
        "routine_run must remain the unchanged execution activity kind",
      ),
    ),
  );
});
