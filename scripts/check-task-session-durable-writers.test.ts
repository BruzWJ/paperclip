import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scanTaskSessionDurableWriterSource } from "./check-task-session-durable-writers.js";

describe("check-task-session-durable-writers", () => {
  it("rejects renamed and wrapped event-store writers", () => {
    const violations = scanTaskSessionDurableWriterSource(
      "apps/server/src/services/bypass.ts",
      `
        import { appendTaskSessionEvent as append } from "./task-session/event-store.js";
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
          "direct appendTaskSessionEvent call bypasses the durable publication boundary",
      ),
    );

    const barrelViolations =
      scanTaskSessionDurableWriterSource(
        "apps/server/src/services/bypass.ts",
        `
          import { appendTaskSessionEvent as append } from "./index.js";
          import * as sessionRuntime from "./task-session-runtime.js";
          append(tx, input);
          sessionRuntime.projectTaskSessionEventInTx(tx, input);
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
    const direct = scanTaskSessionDurableWriterSource(
      "apps/server/src/bootstrap.ts",
      `
        import { taskSessionEvents as events } from "@paperclipai/db";
        const table = events;
        export async function seed(db: any) {
          await db.insert(table).values({});
        }
      `,
    );
    assert.match(
      direct[0]?.message ?? "",
      /direct insert\(taskSessionEvents\)/,
    );

    const raw = scanTaskSessionDurableWriterSource(
      "apps/server/src/bootstrap.ts",
      "db.execute(sql`INSERT INTO task_session_events (id) VALUES ('x')`);",
    );
    assert.match(raw[0]?.message ?? "", /raw SQL insert/);

    const namespace = scanTaskSessionDurableWriterSource(
      "apps/server/src/bootstrap.ts",
      `
        import * as schema from "@paperclipai/db";
        const tables = schema;
        db.insert(tables.taskSessionSourceUserExecutions).values({});
      `,
    );
    assert.match(
      namespace[0]?.message ?? "",
      /direct insert\(taskSessionSourceUserExecutions\)/,
    );

    const rawString = scanTaskSessionDurableWriterSource(
      "apps/server/src/bootstrap.ts",
      `db.execute('UPDATE "task_session_messages" SET data = "{}"');`,
    );
    assert.match(rawString[0]?.message ?? "", /raw SQL update/);
  });

  it("rejects the deleted local_file/S3 NDJSON run-log store", () => {
    const violations = scanTaskSessionDurableWriterSource(
      "apps/server/src/services/run-log-mirror.ts",
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

    const disguised = scanTaskSessionDurableWriterSource(
      "apps/server/src/services/provider-transcript.ts",
      `
        const taskSessionMirror = true;
        const stream = createWriteStream("events.ndjson");
      `,
    );
    assert.match(
      disguised[0]?.message ?? "",
      /independent local_file\/S3 NDJSON/,
    );
  });

  it("rejects direct typed companion helper calls", () => {
    const violations = scanTaskSessionDurableWriterSource(
      "apps/server/src/services/bypass.ts",
      `
        import {
          insertOrAssertTaskSessionSourceUserExecution as persistSource,
        } from "./task-session/source-user-execution.js";
        persistSource(tx, input);
      `,
    );
    assert.match(
      violations[0]?.message ?? "",
      /insertOrAssertTaskSessionSourceUserExecution/,
    );
  });

  it("permits the closed publication/event-store/projector owners", () => {
    assert.deepEqual(
      scanTaskSessionDurableWriterSource(
        "apps/server/src/services/task-session/publication.ts",
        `
          import { appendTaskSessionEvent } from "./event-store.js";
          import { projectTaskSessionEventInTx } from "./projector.js";
          appendTaskSessionEvent(tx, input);
          projectTaskSessionEventInTx(tx, input);
        `,
      ),
      [],
    );
  });
});
