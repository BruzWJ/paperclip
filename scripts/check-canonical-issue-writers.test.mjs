import assert from "node:assert/strict";
import test from "node:test";
import {
  inspectMigrationText,
  inspectSourceText,
  requiredOwnershipViolations,
} from "./check-canonical-issue-writers.mjs";

const INSERT_OWNER = "apps/server/src/services/canonical-issue-aggregate.ts";

function operations(violations) {
  return violations.map((entry) => entry.operation).sort();
}

test("rejects direct, aliased, namespace, helper-returned, and wrapped issue inserts", () => {
  const direct = inspectSourceText(
    "apps/server/src/services/legacy.ts",
    `
      import { issues as issueRows } from "@paperclipai/db";
      const alias = issueRows;
      const table = () => alias;
      await db.insert(issueRows).values({});
      await db.insert(alias).values({});
      await db.insert(table()).values({});
      writeAggregate(issueRows);
    `,
  );
  assert.deepEqual(operations(direct), ["insert", "insert", "insert", "table-wrapper"]);

  const namespace = inspectSourceText(
    "apps/server/src/services/namespace-writer.ts",
    `
      import * as schema from "@paperclipai/db";
      await db.insert(schema.issues).values({});
    `,
  );
  assert.deepEqual(operations(namespace), ["insert"]);
});

test("permits exactly one insert inside the canonical function", () => {
  const accepted = inspectSourceText(
    INSERT_OWNER,
    `
      import { issues } from "@paperclipai/db";
      export async function persistCanonicalIssueAggregateInTx(tx, input) {
        return tx.insert(issues).values(input.issue);
      }
    `,
  );
  assert.deepEqual(accepted, []);

  const duplicate = inspectSourceText(
    INSERT_OWNER,
    `
      import { issues } from "@paperclipai/db";
      export async function persistCanonicalIssueAggregateInTx(tx, input) {
        await tx.insert(issues).values(input.issue);
        return tx.insert(issues).values(input.issue);
      }
    `,
  );
  assert.deepEqual(operations(duplicate), ["second-owner-insert"]);

  const wrongFunction = inspectSourceText(
    INSERT_OWNER,
    `
      import { issues } from "@paperclipai/db";
      async function insertAnotherIssue(tx, row) {
        return tx.insert(issues).values(row);
      }
    `,
  );
  assert.deepEqual(operations(wrongFunction), ["insert"]);
});

test("rejects raw SQL inserts and later migration mutations of immutable fields", () => {
  const source = inspectSourceText(
    "apps/server/src/services/raw-writer.ts",
    `
      await tx.execute(sql\`insert into issues (id) values (\${id})\`);
      await tx.execute(sql\`update public.issues set request = \${request}\`);
    `,
  );
  assert.deepEqual(operations(source), ["immutable-update", "insert"]);

  const migration = inspectMigrationText(
    "packages/db/migrations/0001_later.sql",
    `UPDATE "issues" SET creator_authority_id = NULL;`,
  );
  assert.deepEqual(operations(migration), ["migration-mutation"]);
});

test("rejects direct, aliased, spread, and generic immutable updates", () => {
  const direct = inspectSourceText(
    "apps/server/src/services/legacy-update.ts",
    `
      import { issues as rows } from "@paperclipai/db";
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

test("allows the one statically closed control-state patch contract", () => {
  const source = `
    import { issues } from "@paperclipai/db";
    type IssueControlStateUpdate = Partial<Omit<typeof issues.$inferInsert,
      "request" | "creatorAuthorityId" | "creatorAdapterConfigRevisionId">>;
    const service = {
      updateControlState: async function updateControlState(data: IssueControlStateUpdate) {
        return db.update(issues).set(data);
      },
    };
  `;
  assert.deepEqual(inspectSourceText("apps/server/src/services/issues.ts", source), []);
});

test("rejects a partial agent-execution creator pair at canonical creation", () => {
  const partial = inspectSourceText(
    "apps/server/src/services/runtime-issue-action-port.ts",
    `
      await persistCanonicalIssueAggregateInTx(tx, {
        issue: {
          creatorKind: "agent-execution",
          creatorAuthorityId: authorityId,
        },
      });
    `,
  );
  assert.deepEqual(operations(partial), ["partial-creator-pair"]);

  const complete = inspectSourceText(
    "apps/server/src/services/runtime-issue-action-port.ts",
    `
      await persistCanonicalIssueAggregateInTx(tx, {
        issue: {
          creatorKind: "agent-execution",
          creatorAuthorityId: authorityId,
          creatorAdapterConfigRevisionId: revisionId,
        },
      });
    `,
  );
  assert.deepEqual(complete, []);
});

function validOwnerGraph() {
  return new Map([
    [
      "apps/server/src/services/canonical-issue-aggregate.ts",
      `
        export interface CanonicalIssueAggregateInput { issue: { request: string } }
        export async function persistCanonicalIssueAggregateInTx(tx, input) {
          const { issue } = input;
          await assertAgentExecutionCreator(tx, issue);
          return tx.insert(issues).values(issue);
        }
      `,
    ],
    [
      "apps/server/src/services/issues.ts",
      `type IssueControlStateUpdate = Omit<Row, | "request" | "creatorAuthorityId" | "creatorAdapterConfigRevisionId">;
       function updateControlState(data: IssueControlStateUpdate) {}`,
    ],
    [
      "apps/server/src/services/runtime-interface-compiler.ts",
      `if (input.actionGrants.issue_create === true) descriptors.push(issueCreateDescriptor(input.issueCreateDirectChildren));`,
    ],
    [
      "apps/server/src/services/runtime-issue-action-port.ts",
      `
        lockRuntimeActionAuthority(tx, capability, "issue_create", now);
        if (!input.capability.issueExecutionAuthorityId) throw denied();
        persistCanonicalIssueAggregateInTx(tx, { issue: {
          creatorAuthorityId: input.capability.issueExecutionAuthorityId,
          creatorAdapterConfigRevisionId: input.capability.adapterConfigIdentity,
        }});
      `,
    ],
    [
      "packages/db/schema/issues.ts",
      `request: text("request").notNull(), creatorAuthorityId: uuid("creator_authority_id"), creatorAdapterConfigRevisionId: uuid("creator_adapter_config_revision_id")`,
    ],
  ]);
}

test("requires compiler, action-port, aggregate, schema, and closed update owners", () => {
  assert.deepEqual(requiredOwnershipViolations(validOwnerGraph()), []);

  for (const [path, marker] of [
    ["apps/server/src/services/canonical-issue-aggregate.ts", "await assertAgentExecutionCreator(tx, issue);"],
    ["apps/server/src/services/issues.ts", '| "request"'],
    ["apps/server/src/services/runtime-interface-compiler.ts", "input.actionGrants.issue_create === true"],
    ["apps/server/src/services/runtime-issue-action-port.ts", "if (!input.capability.issueExecutionAuthorityId)"],
    ["packages/db/schema/issues.ts", 'request: text("request").notNull()'],
  ]) {
    const mutated = validOwnerGraph();
    mutated.set(path, mutated.get(path).replace(marker, ""));
    assert.ok(
      requiredOwnershipViolations(mutated).length > 0,
      `${path} mutation must fail`,
    );
  }
});
