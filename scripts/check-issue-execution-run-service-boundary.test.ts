import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCanonicalContextRunTraceReader,
  assertCanonicalTargetLaneRunLocking,
  assertMissingCarryStartsFresh,
  scanCanonicalRunBoundaryFiles,
} from "./check-issue-execution-run-service-boundary.ts";

test("rejects every retired run-store surface", () => {
  const terms = [
    "heartbeat_runs",
    "heartbeat_run_events",
    "heartbeatRuns",
    "heartbeatRunEvents",
    "HeartbeatRunStatus",
    "heartbeatRunId",
    "heartbeatsApi",
    "/heartbeat-runs",
    "HEARTBEAT_RUN_STATUSES",
    "heartbeat.run.status",
    "runTelemetryService",
    "run-telemetry",
    "appendRunEvent",
    "writeRunEvent",
    "appendRunLog",
    "writeRunLog",
    "readRunLog",
    "getRunLogAccess",
    "buildRunOutputSilence",
    "decorateActiveRunStatus",
    "finishAttemptRun",
    "reportRunActivity",
    "currentRunRefId",
  ] as const;

  for (const term of terms) {
    const violations = scanCanonicalRunBoundaryFiles([
      {
        path: "apps/server/src/services/legacy-run-store.ts",
        source: `export const stale = ${JSON.stringify(term)};`,
      },
    ]);
    assert.ok(
      violations.length > 0,
      `expected ${term} to be rejected`,
    );
  }
});

test("rejects run-table access outside the canonical service", () => {
  const violations = scanCanonicalRunBoundaryFiles([
    {
      path: "apps/server/src/services/bypass.ts",
      source: [
        'import { issueExecutionRuns } from "@paperclipai/db";',
        "await tx.select().from(issueExecutionRuns);",
        'await tx.execute(sql`select * from "issue_execution_runs"`);',
      ].join("\n"),
    },
  ]);
  assert.equal(
    violations.filter((entry) => entry.rule.includes("run table access")).length,
    3,
  );
});

test("allows typed run ids and schema references without table access", () => {
  const violations = scanCanonicalRunBoundaryFiles([
    {
      path: "apps/server/src/services/consumer.ts",
      source:
        "export async function read(runId: string) { return service.readRun({ runId }); }",
    },
    {
      path: "packages/db/schema/issue_comments.ts",
      source:
        "export const runId = uuid('run_id').references(() => issueExecutionRuns.id);",
    },
  ]);
  assert.deepEqual(violations, []);
});

test("keeps terminal liveness insertion inside the canonical finalizer", () => {
  const rejected = scanCanonicalRunBoundaryFiles([
    {
      path: "apps/server/src/services/read-repair.ts",
      source:
        "await tx.insert(issueExecutionRunLivenessFacts).values(fact);",
    },
  ]);
  assert.ok(
    rejected.some((entry) =>
      entry.rule.includes("run-liveness writer outside"),
    ),
  );

  const accepted = scanCanonicalRunBoundaryFiles([
    {
      path: "apps/server/src/services/issue-execution-finalization-postgres.ts",
      source:
        "await tx.insert(issueExecutionRunLivenessFacts).values(fact);",
    },
  ]);
  assert.deepEqual(accepted, []);
});

test("rejects mutation of immutable terminal liveness facts", () => {
  for (const operation of ["update", "delete"] as const) {
    const violations = scanCanonicalRunBoundaryFiles([
      {
        path: "apps/server/src/services/issue-execution-finalization-postgres.ts",
        source: `await tx.${operation}(issueExecutionRunLivenessFacts);`,
      },
    ]);
    assert.ok(
      violations.some((entry) =>
        entry.rule.includes("insert-only"),
      ),
    );
  }
});

test("rejects the removed generic canonical run-trace event surface at each former owner", () => {
  for (const fixture of [
    {
      path: "apps/server/src/services/context-retrieval.ts",
      source: "export interface CanonicalRunTraceEvent {}",
    },
    {
      path: "apps/server/src/services/context-retrieval-db.ts",
      source: "export function sanitizeCanonicalEventRow() {}",
    },
    {
      path: "apps/server/src/services/context-retrieval-db.ts",
      source: "return { turns, events: [] };",
    },
    {
      path: "apps/server/src/routes/openapi.ts",
      source: "const canonicalRunTraceEventSchema = z.object({});",
    },
    {
      path: "apps/server/src/routes/openapi.ts",
      source: "const canonicalRunTraceSchema = z.object({});",
    },
  ]) {
    const violations = scanCanonicalRunBoundaryFiles([fixture]);
    assert.ok(
      violations.some((entry) =>
        entry.rule.includes("retired generic canonical run-trace event surface"),
      ),
      `expected ${fixture.path} to reject ${fixture.source}`,
    );
  }
});

test("requires run traces to combine the canonical run and transmitted Session reads", () => {
  const source = [
    "const identity = await resolveIssueExecutionRunIdentityById(db, runId);",
    "const detail = await options.runService.readJoinedRunDetail(identity);",
    "const messages = await db.select().from(issueSessionMessages);",
    "and member.prompt_transmission_phase = 'transmitted'",
    "and source_ref.source_message_id = issueSessionMessages.id",
    "and segment.source_message_id = issueSessionMessages.id",
    "const turns = messages.map((row) =>",
    "  sanitizeCanonicalMessage(decodeStoredIssueSessionMessage(row), row.seq),",
    ");",
    "return { turns, detail };",
  ].join("\n");

  assert.doesNotThrow(() => assertCanonicalContextRunTraceReader(source));
  assert.throws(
    () =>
      assertCanonicalContextRunTraceReader(
        source.replace(".from(issueSessionMessages)", ".from(runDetailMessages)"),
      ),
    /must resolve the canonical run and project its transmitted Issue Session trace/,
  );
});

test("requires a fresh active-run lock after the exact target-lane hierarchy", () => {
  const canonicalRunService = [
    "export async function lockActiveProductiveRunForLaneInTransaction(",
    "transaction: IssueSessionDbTransaction,",
    "input: IssueExecutionTargetLaneIdentity,",
    "): Promise<IssueExecutionRunEnvelope | null> {}",
  ].join("\n");
  const canonicalDispatcher = [
    "async function findExistingRunForLane(",
    "transaction: IssueSessionDbTransaction,",
    "lane: IssueExecutionTargetLaneIdentity,",
    ") {",
    "await lockLaneParents(transaction, lane);",
    "await lockLane(transaction, lane);",
    "return lockActiveProductiveRunForLaneInTransaction(transaction, lane);",
    "}",
    "async function createRunForRef() {}",
  ].join("\n");
  assert.doesNotThrow(() =>
    assertCanonicalTargetLaneRunLocking(
      canonicalRunService,
      canonicalDispatcher,
    ),
  );

  assert.throws(
    () =>
      assertCanonicalTargetLaneRunLocking(
        `${canonicalRunService}\nconst expectedRunId = "stale";`,
        canonicalDispatcher,
      ),
    /stale target-lane probe contract expectedRunId/,
  );
  assert.throws(
    () =>
      assertCanonicalTargetLaneRunLocking(
        canonicalRunService,
        canonicalDispatcher.replace(
          "await lockLaneParents(transaction, lane);",
          "return lockActiveProductiveRunForLaneInTransaction(transaction, lane);",
        ),
      ),
    /must lock company, issue, Session, exact lane/,
  );
});

test("requires missing true-carry mappings to start a fresh session", () => {
  const dispatcher = [
    "async function selectSessionOperation() {",
    "const eligible = [];",
    "if (eligible.length === 1) return \"resume\";",
    'return "new";',
    "}",
    "async function assertRefDispatchable() {}",
  ].join("\n");
  const executor = [
    "const operation = prompt.sessionOperation;",
    "const operationIsValid =",
    '(operation === "new" && prompt.storedCorrelation === null);',
    "if (!operationIsValid) {}",
  ].join("\n");
  assert.doesNotThrow(() =>
    assertMissingCarryStartsFresh(dispatcher, executor));
  assert.throws(
    () => assertMissingCarryStartsFresh(
      dispatcher.replace('return "new";', 'return "resume";'),
      executor,
    ),
    /fresh session/,
  );
  assert.throws(
    () => assertMissingCarryStartsFresh(
      dispatcher,
      executor.replace(
        'operation === "new" && ',
        'operation === "new" && !prompt.carryContext && ',
      ),
    ),
    /regardless of carry_context/,
  );
});
