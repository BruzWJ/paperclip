import assert from "node:assert/strict";
import test from "node:test";
import {
  inspectMigrationText,
  inspectSourceText,
  requiredOwnershipViolations,
} from "./check-canonical-task-writers.mjs";

const INSERT_OWNER = "apps/server/src/services/canonical-task-aggregate.ts";

function operations(violations) {
  return violations.map((entry) => entry.operation).sort();
}

test("rejects direct, aliased, namespace, helper-returned, and wrapped task inserts", () => {
  const direct = inspectSourceText(
    "apps/server/src/services/legacy.ts",
    `
      import { tasks as taskRows } from "@paperclipai/db";
      const alias = taskRows;
      const table = () => alias;
      await db.insert(taskRows).values({});
      await db.insert(alias).values({});
      await db.insert(table()).values({});
      writeAggregate(taskRows);
    `,
  );
  assert.deepEqual(operations(direct), [
    "insert",
    "insert",
    "insert",
    "table-wrapper",
  ]);

  const namespace = inspectSourceText(
    "apps/server/src/services/namespace-writer.ts",
    `
      import * as schema from "@paperclipai/db";
      await db.insert(schema.tasks).values({});
    `,
  );
  assert.deepEqual(operations(namespace), ["insert"]);
});

test("permits exactly one insert inside the canonical function", () => {
  const accepted = inspectSourceText(
    INSERT_OWNER,
    `
      import { tasks } from "@paperclipai/db";
      export async function persistCanonicalTaskAggregateInTx(tx, input) {
        return tx.insert(tasks).values(input.task);
      }
    `,
  );
  assert.deepEqual(accepted, []);

  const duplicate = inspectSourceText(
    INSERT_OWNER,
    `
      import { tasks } from "@paperclipai/db";
      export async function persistCanonicalTaskAggregateInTx(tx, input) {
        await tx.insert(tasks).values(input.task);
        return tx.insert(tasks).values(input.task);
      }
    `,
  );
  assert.deepEqual(operations(duplicate), ["second-owner-insert"]);

  const wrongFunction = inspectSourceText(
    INSERT_OWNER,
    `
      import { tasks } from "@paperclipai/db";
      async function insertAnotherTask(tx, row) {
        return tx.insert(tasks).values(row);
      }
    `,
  );
  assert.deepEqual(operations(wrongFunction), ["insert"]);
});

test("rejects raw SQL inserts and later migration mutations of immutable fields", () => {
  const source = inspectSourceText(
    "apps/server/src/services/raw-writer.ts",
    `
      await tx.execute(sql\`insert into tasks (id) values (\${id})\`);
      await tx.execute(sql\`update public.tasks set request = \${request}\`);
    `,
  );
  assert.deepEqual(operations(source), ["immutable-update", "insert"]);

  const migration = inspectMigrationText(
    "packages/db/migrations/0001_later.sql",
    `UPDATE "tasks" SET creator_authority_id = NULL;`,
  );
  assert.deepEqual(operations(migration), ["migration-mutation"]);
});

test("rejects direct, aliased, spread, and generic immutable updates", () => {
  const direct = inspectSourceText(
    "apps/server/src/services/legacy-update.ts",
    `
      import { tasks as rows } from "@paperclipai/db";
      const requestPatch = { request: "replacement" };
      await db.update(rows).set({ creatorAuthorityId: authorityId });
      await db.update(rows).set({ ...requestPatch, updatedAt: new Date() });
      await db.update(rows).set(untypedPatch);
    `,
  );
  assert.deepEqual(operations(direct), [
    "generic-update-payload",
    "immutable-update",
    "immutable-update",
  ]);
});

test("rejects a partial agent-execution creator pair at canonical creation", () => {
  const partial = inspectSourceText(
    "apps/server/src/services/runtime-task-action-port.ts",
    `
      await persistCanonicalTaskAggregateInTx(tx, {
        task: {
          taskNumber,
          identifier,
          creatorKind: "agent-execution",
          creatorAuthorityId: authorityId,
        },
      });
    `,
  );
  assert.deepEqual(operations(partial), ["partial-creator-pair"]);

  const complete = inspectSourceText(
    "apps/server/src/services/runtime-task-action-port.ts",
    `
      await persistCanonicalTaskAggregateInTx(tx, {
        task: {
          taskNumber,
          identifier,
          creatorKind: "agent-execution",
          creatorAuthorityId: authorityId,
          creatorAdapterConfigRevisionId: revisionId,
        },
      });
    `,
  );
  assert.deepEqual(complete, []);
});

test("requires every canonical aggregate caller to supply task number and identifier", () => {
  const missing = inspectSourceText(
    "apps/server/src/services/ordinary-task-runtime.ts",
    `
      await persistCanonicalTaskAggregateInTx(tx, {
        task: { taskNumber },
      });
    `,
  );
  assert.deepEqual(operations(missing), ["missing-canonical-identity"]);
});

function validOwnerGraph() {
  return new Map([
    [
      "apps/server/src/services/canonical-task-aggregate.ts",
      `
        export interface CanonicalTaskAggregateInput { task: { request: string } }
        export async function allocateCanonicalTaskIdentityInTx() {}
        export async function persistCanonicalTaskAggregateInTx(tx, input) {
          const { task } = input;
          await assertCanonicalTaskIdentity(tx, task);
          await assertAgentExecutionCreator(tx, task);
          return tx.insert(tasks).values(task);
        }
      `,
    ],
    [
      "apps/server/src/services/paperclip-managed-tool-registry.ts",
      `export const PAPERCLIP_MANAGED_TOOL_NAMES = [];
       export const boardMcpInputSchemas = {};
       export const BOARD_MANAGED_TOOLS = [];
       function projectRuntimeTaskCreate(input) { if (input.mode !== "owner" || input.actionGrants.task_create !== true) return null; return { name: "task_create" }; }
       switch (name) { case "task_create": return projectRuntimeTaskCreate(input); }`,
    ],
    [
      "apps/server/src/services/runtime-task-action-port.ts",
      `
        lockRuntimeActionAuthority(tx, capability, "task_create", now);
        if (!input.capability.taskExecutionAuthorityId) throw denied();
        persistCanonicalTaskAggregateInTx(tx, { task: {
          taskNumber,
          identifier,
          creatorAuthorityId: input.capability.taskExecutionAuthorityId,
          creatorAdapterConfigRevisionId: input.capability.adapterConfigIdentity,
        }});
      `,
    ],
    [
      "packages/db/schema/tasks.ts",
      `request: text("request").notNull(), creatorAuthorityId: uuid("creator_authority_id"), creatorAdapterConfigRevisionId: uuid("creator_adapter_config_revision_id")`,
    ],
  ]);
}

test("requires registry, action-port, aggregate, and schema owners", () => {
  assert.deepEqual(requiredOwnershipViolations(validOwnerGraph()), []);

  for (const [path, marker] of [
    [
      "apps/server/src/services/canonical-task-aggregate.ts",
      "await assertAgentExecutionCreator(tx, task);",
    ],
    [
      "apps/server/src/services/paperclip-managed-tool-registry.ts",
      "input.actionGrants.task_create !== true",
    ],
    [
      "apps/server/src/services/paperclip-managed-tool-registry.ts",
      'case "task_create": return projectRuntimeTaskCreate(input);',
    ],
    [
      "apps/server/src/services/runtime-task-action-port.ts",
      "if (!input.capability.taskExecutionAuthorityId)",
    ],
    ["packages/db/schema/tasks.ts", 'request: text("request").notNull()'],
  ]) {
    const mutated = validOwnerGraph();
    mutated.set(path, mutated.get(path).replace(marker, ""));
    assert.ok(
      requiredOwnershipViolations(mutated).length > 0,
      `${path} mutation must fail`,
    );
  }
});
