import assert from "node:assert/strict";
import test from "node:test";
import { inspectSourceText } from "./check-issue-comment-projector-writers.mjs";

test("rejects direct, aliased, and raw SQL issue comment writes", () => {
  const source = `
    import { issueComments as comments } from "@paperclipai/db";
    const projected = comments;
    await tx.insert(projected).values({});
    await db.update(schema.issueComments).set({});
    await tx.execute(sql\`delete from issue_comments where issue_id = \${issueId}\`);
  `;

  const violations = inspectSourceText("apps/server/src/services/legacy.ts", source);
  assert.deepEqual(
    violations.map((entry) => entry.operation).sort(),
    ["delete", "insert", "update"],
  );
});

test("allows only projector inserts and updates", () => {
  const allowed = inspectSourceText(
    "apps/server/src/services/issue-session/projector.ts",
    `
      import { issueComments } from "@paperclipai/db";
      async function materializeComment() {
        await tx.insert(issueComments).values({});
        await tx.update(issueComments).set({});
      }
    `,
  );
  assert.deepEqual(allowed, []);

  const deniedWrongFunction = inspectSourceText(
    "apps/server/src/services/issue-session/projector.ts",
    `
      import { issueComments } from "@paperclipai/db";
      async function projectSomethingElse() {
        await tx.insert(issueComments).values({});
      }
    `,
  );
  assert.equal(deniedWrongFunction.length, 1);
  assert.equal(deniedWrongFunction[0].operation, "insert");

  const deniedDelete = inspectSourceText(
    "apps/server/src/services/issue-session/projector.ts",
    `
      import { issueComments } from "@paperclipai/db";
      async function materializeComment() {
        await tx.delete(issueComments);
      }
    `,
  );
  assert.equal(deniedDelete.length, 1);
  assert.equal(deniedDelete[0].operation, "delete");
});

test("allows only lifecycle purge deletes", () => {
  const allowed = inspectSourceText(
    "apps/server/src/services/issue-session-lifecycle.ts",
    `
      import { issueComments } from "@paperclipai/db";
      async function purgeCompanySessionGraphInTx() {
        await tx.delete(issueComments);
      }
    `,
  );
  assert.deepEqual(allowed, []);

  const deniedWrongFunction = inspectSourceText(
    "apps/server/src/services/issue-session-lifecycle.ts",
    `
      import { issueComments } from "@paperclipai/db";
      async function purgeSomeOtherState() {
        await tx.delete(issueComments);
      }
    `,
  );
  assert.equal(deniedWrongFunction.length, 1);
  assert.equal(deniedWrongFunction[0].operation, "delete");

  const deniedInsert = inspectSourceText(
    "apps/server/src/services/issue-session-lifecycle.ts",
    `
      import { issueComments } from "@paperclipai/db";
      async function purgeCompanySessionGraphInTx() {
        await tx.insert(issueComments).values({});
      }
    `,
  );
  assert.equal(deniedInsert.length, 1);
  assert.equal(deniedInsert[0].operation, "insert");
});

test("rejects exported generic comment mutators even without a direct write", () => {
  const violations = inspectSourceText(
    "apps/server/src/services/issues.ts",
    `export async function addComment() { return publishLater(); }`,
  );
  assert.equal(violations.length, 1);
  assert.equal(violations[0].operation, "generic-mutator");
});
