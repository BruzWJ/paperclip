import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scanIssueSessionDurableWriterSource } from "./check-issue-session-durable-writers.js";

describe("check-issue-session-durable-writers", () => {
  it("rejects renamed and wrapped event-store writers", () => {
    const violations = scanIssueSessionDurableWriterSource(
      "server/src/services/bypass.ts",
      `
        import { appendIssueSessionEvent as append } from "./issue-session/event-store.js";
        const wrapped = append;
        export async function bypass(tx: unknown, input: unknown) {
          return wrapped(tx, input);
        }
      `,
    );
    assert.ok(
      violations.some(
        (entry) =>
          entry.message ===
          "direct appendIssueSessionEvent call bypasses the durable publication boundary",
      ),
    );

    const barrelViolations =
      scanIssueSessionDurableWriterSource(
        "server/src/services/bypass.ts",
        `
          import { appendIssueSessionEvent as append } from "./index.js";
          import * as sessionRuntime from "./issue-session-runtime.js";
          append(tx, input);
          sessionRuntime.projectIssueSessionEventInTx(tx, input);
        `,
      );
    assert.equal(barrelViolations.length, 2);
    assert.ok(
      barrelViolations.every((entry) =>
        entry.message.includes(
          "bypasses the durable publication boundary",
        ),
      ),
    );
  });

  it("rejects aliased table writes and raw-SQL bootstrap bypasses", () => {
    const direct = scanIssueSessionDurableWriterSource(
      "server/src/bootstrap.ts",
      `
        import { issueSessionEvents as events } from "@paperclipai/db";
        const table = events;
        export async function seed(db: any) {
          await db.insert(table).values({});
        }
      `,
    );
    assert.match(
      direct[0]?.message ?? "",
      /direct insert\(issueSessionEvents\)/,
    );

    const raw = scanIssueSessionDurableWriterSource(
      "server/src/bootstrap.ts",
      "db.execute(sql`INSERT INTO issue_session_events (id) VALUES ('x')`);",
    );
    assert.match(raw[0]?.message ?? "", /raw SQL insert/);

    const namespace = scanIssueSessionDurableWriterSource(
      "server/src/bootstrap.ts",
      `
        import * as schema from "@paperclipai/db";
        const tables = schema;
        db.insert(tables.issueSessionSourceUserExecutions).values({});
      `,
    );
    assert.match(
      namespace[0]?.message ?? "",
      /direct insert\(issueSessionSourceUserExecutions\)/,
    );

    const rawString = scanIssueSessionDurableWriterSource(
      "server/src/bootstrap.ts",
      `db.execute('UPDATE "issue_session_messages" SET data = "{}"');`,
    );
    assert.match(rawString[0]?.message ?? "", /raw SQL update/);
  });

  it("rejects the deleted local_file/S3 NDJSON run-log store", () => {
    const violations = scanIssueSessionDurableWriterSource(
      "server/src/services/run-log-mirror.ts",
      `
        const store = "local_file";
        const key = process.env.RUN_LOG_S3_BUCKET;
        const suffix = ".ndjson";
      `,
    );
    assert.match(
      violations[0]?.message ?? "",
      /independent local_file\/S3 NDJSON/,
    );

    const disguised = scanIssueSessionDurableWriterSource(
      "server/src/services/provider-transcript.ts",
      `
        const issueSessionMirror = true;
        const stream = createWriteStream("events.ndjson");
      `,
    );
    assert.match(
      disguised[0]?.message ?? "",
      /independent local_file\/S3 NDJSON/,
    );
  });

  it("rejects direct typed companion helper calls", () => {
    const violations = scanIssueSessionDurableWriterSource(
      "server/src/services/bypass.ts",
      `
        import {
          insertOrAssertIssueSessionSourceUserExecution as persistSource,
        } from "./issue-session/source-user-execution.js";
        persistSource(tx, input);
      `,
    );
    assert.match(
      violations[0]?.message ?? "",
      /insertOrAssertIssueSessionSourceUserExecution/,
    );
  });

  it("permits the closed publication/event-store/projector owners", () => {
    assert.deepEqual(
      scanIssueSessionDurableWriterSource(
        "server/src/services/issue-session/publication.ts",
        `
          import { appendIssueSessionEvent } from "./event-store.js";
          import { projectIssueSessionEventInTx } from "./projector.js";
          appendIssueSessionEvent(tx, input);
          projectIssueSessionEventInTx(tx, input);
        `,
      ),
      [],
    );
  });
});
