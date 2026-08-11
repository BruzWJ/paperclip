import assert from "node:assert/strict";
import test from "node:test";
import { inspectSourceText } from "./check-task-comment-projector-writers.mjs";

test("rejects direct, aliased, and raw SQL task comment writes", () => {
  const source = `
    import { taskComments as comments } from "@paperclipai/db";
    const projected = comments;
    await tx.insert(projected).values({});
    await db.update(schema.taskComments).set({});
    await tx.execute(sql\`delete from task_comments where task_id = \${taskId}\`);
  `;

  const violations = inspectSourceText("apps/server/src/services/legacy.ts", source);
  assert.deepEqual(
    violations.map((entry) => entry.operation).sort(),
    ["delete", "insert", "update"],
  );
});

test("allows only projector inserts and updates", () => {
  const allowed = inspectSourceText(
    "apps/server/src/services/task-session/projector.ts",
    `
      import { taskComments } from "@paperclipai/db";
      async function materializeComment() {
        await tx.insert(taskComments).values({});
        await tx.update(taskComments).set({});
      }
    `,
  );
  assert.deepEqual(allowed, []);

  const deniedWrongFunction = inspectSourceText(
    "apps/server/src/services/task-session/projector.ts",
    `
      import { taskComments } from "@paperclipai/db";
      async function projectSomethingElse() {
        await tx.insert(taskComments).values({});
      }
    `,
  );
  assert.equal(deniedWrongFunction.length, 1);
  assert.equal(deniedWrongFunction[0].operation, "insert");

  const deniedDelete = inspectSourceText(
    "apps/server/src/services/task-session/projector.ts",
    `
      import { taskComments } from "@paperclipai/db";
      async function materializeComment() {
        await tx.delete(taskComments);
      }
    `,
  );
  assert.equal(deniedDelete.length, 1);
  assert.equal(deniedDelete[0].operation, "delete");
});

test("allows only lifecycle purge deletes", () => {
  const allowed = inspectSourceText(
    "apps/server/src/services/task-session-lifecycle.ts",
    `
      import { taskComments } from "@paperclipai/db";
      async function purgeCompanySessionGraphInTx() {
        await tx.delete(taskComments);
      }
    `,
  );
  assert.deepEqual(allowed, []);

  const deniedWrongFunction = inspectSourceText(
    "apps/server/src/services/task-session-lifecycle.ts",
    `
      import { taskComments } from "@paperclipai/db";
      async function purgeSomeOtherState() {
        await tx.delete(taskComments);
      }
    `,
  );
  assert.equal(deniedWrongFunction.length, 1);
  assert.equal(deniedWrongFunction[0].operation, "delete");

  const deniedInsert = inspectSourceText(
    "apps/server/src/services/task-session-lifecycle.ts",
    `
      import { taskComments } from "@paperclipai/db";
      async function purgeCompanySessionGraphInTx() {
        await tx.insert(taskComments).values({});
      }
    `,
  );
  assert.equal(deniedInsert.length, 1);
  assert.equal(deniedInsert[0].operation, "insert");
});

test("rejects exported generic comment mutators even without a direct write", () => {
  const violations = inspectSourceText(
    "apps/server/src/services/tasks.ts",
    `export async function addComment() { return publishLater(); }`,
  );
  assert.equal(violations.length, 1);
  assert.equal(violations[0].operation, "generic-mutator");
});
