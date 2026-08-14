import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { createMockDb } from "../__tests__/helpers/mock-db.js";
import { createPostgresTaskExecutionSteeringRepository } from "./task-execution-run-postgres.js";
import type { RequestedTaskExecutionSteering } from "./task-execution-run-service.js";

const request: RequestedTaskExecutionSteering = {
  companyId: "company",
  taskId: "task",
  ownershipEpoch: 1,
  runId: "run",
  targetAgentId: "agent",
  refId: "ref",
  refOrdinal: 0,
  interruptedSegmentOrdinal: 0,
  segmentOrdinal: 1,
  sourceCommentId: "comment",
  sourceMessageId: "message",
  sourceInputId: "message",
  cancellationIntentId: "intent",
  cancellation: {
    companyId: "company",
    taskId: "task",
    sessionId: "session",
    executionScopeId: "scope",
    refId: "ref",
    runId: "run",
    attemptId: "attempt",
    leaseGeneration: 1,
  },
};

type Row = Record<string, unknown>;
const rows = (...values: (Row | null)[]) => values.map((value) => (value === null ? [] : [value]));

function steeringAdmissionPlan(now: Date, message: string) {
  return {
    select: rows(
      {
        id: "run",
        companyId: "company",
        taskId: "task",
        sessionId: "ses_steering",
        executionScopeId: "scope",
        kind: "productive",
        status: "running",
        ownershipEpoch: 1,
        targetAgentId: "agent",
        adapterConfigRevisionId: "revision",
        executionWorkspaceBindingId: "workspace",
        executionMode: "owner",
        taskExecutionAuthorityId: "authority",
        consultExecutionId: null,
        currentAttemptId: "attempt",
        currentLeaseId: "lease",
        cancellationIntentId: null,
        terminalFinalizationId: null,
        startedAt: now,
        finishedAt: null,
      },
      { runId: "run", currentRefId: "ref", currentOrdinal: 0, currentSegmentOrdinal: 0 },
      {
        runId: "run",
        refId: "ref",
        refOrdinal: 0,
        protocolSettlementState: null,
        capabilityConnectionId: "connection",
        capabilityGeneration: 1,
      },
      {
        id: "attempt",
        companyId: "company",
        taskId: "task",
        sessionId: "ses_steering",
        runId: "run",
        runKind: "productive",
        refId: "ref",
        refOrdinal: 0,
        segmentOrdinal: 0,
        promptKind: "base",
        state: "running",
      },
      {
        id: "lease",
        companyId: "company",
        taskId: "task",
        runId: "run",
        attemptId: "attempt",
        leaseGeneration: 1,
        state: "active",
        expiresAt: new Date("2026-08-10T18:01:00.000Z"),
      },
      {
        capabilityConnectionId: "connection",
        capabilityGeneration: 1,
        leaseGeneration: 1,
        targetSessionCorrelationId: "correlation",
        effectiveContextExposureDigest: null,
      },
      {
        id: "correlation",
        purpose: "active_run_steering",
        state: "current",
        laneKind: null,
        runId: "run",
        currentRefId: "ref",
        currentRefOrdinal: 0,
        currentSegmentOrdinal: 0,
        authorizedContextExposureDigest: null,
      },
      {
        id: "comment",
        canonicalMessageId: "msg_steering",
        canonicalSourceKind: "harness_delivery",
        body: message,
        authorType: "agent",
        authorAgentId: "steering-agent",
        runId: "source-run",
      },
      {
        sourceKind: "harness_delivery",
        messageId: "msg_steering",
        steeringTargetRunId: null,
        refId: null,
        refOrdinal: null,
        segmentOrdinal: null,
      },
      {
        id: "msg_steering",
        type: "synthetic",
        data: { time: { created: now.getTime() }, sessionID: "ses_steering", text: message },
        timeCreated: now,
        runId: "source-run",
        agentId: "steering-agent",
        adapterConfigRevisionId: "source-revision",
      },
      null,
    ),
    insert: [[], []],
    update: [[{ capabilityConnectionId: "connection" }], [{ id: "run" }], [{ commentId: "comment" }]],
  };
}

describe("PostgreSQL task-execution steering recovery", () => {
  it("admits steering while the base prompt segment is still open", async () => {
    const now = new Date("2026-08-10T18:00:00.000Z");
    const message = "Steer the open base prompt";
    const harness = createMockDb(steeringAdmissionPlan(now, message));
    const repository = createPostgresTaskExecutionSteeringRepository(harness.db, {
      now: () => now,
      idFactory: () => "intent",
    });

    await expect(
      repository.requestInTransaction(harness.db as never, {
        companyId: "company",
        taskId: "task",
        ownershipEpoch: 1,
        runId: "run",
        targetAgentId: "agent",
        exactMessage: message,
        sourceCommentId: "comment",
        sourceMessageId: "msg_steering",
        sourceInputId: null,
        actor: { kind: "agent", agentId: "steering-agent" },
      }),
    ).resolves.toEqual({
      ...request,
      sourceMessageId: "msg_steering",
      sourceInputId: null,
      cancellation: { ...request.cancellation, sessionId: "ses_steering" },
    });
    expect(harness.remaining("select")).toBe(0);
    expect(harness.remaining("insert")).toBe(0);
    expect(harness.remaining("update")).toBe(0);
  });

  it.each([
    {
      name: "treats an exact repeated acknowledged cancellation signal as idempotent",
      intentState: "acknowledged",
      steeringState: "sent",
    },
    {
      name: "does not repeat a cancellation signal after its settlement fence",
      intentState: "completed",
      steeringState: "protocol_settled",
    },
  ])("$name", async ({ intentState, steeringState }) => {
    const harness = createMockDb({
      select: rows(
        {
          id: request.cancellationIntentId,
          companyId: request.companyId,
          taskId: request.taskId,
          runId: request.runId,
          state: intentState,
        },
        {
          runId: request.runId,
          refId: request.refId,
          refOrdinal: request.refOrdinal,
          segmentOrdinal: request.segmentOrdinal,
          cancellationIntentId: request.cancellationIntentId,
          steeringState,
        },
      ),
    });
    const repository = createPostgresTaskExecutionSteeringRepository(harness.db);

    await expect(
      repository.recordCancellationSignal({
        request,
        delivered: true,
      }),
    ).resolves.toBeUndefined();
    expect(harness.remaining("update")).toBe(0);
  });

  it("returns a retryable pending observation when the wait deadline expires", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(2);
    const harness = createMockDb({
      select: rows(
        {
          id: "intent",
          state: "requested",
          failureCode: null,
          nativeCancellationSettledAt: null,
        },
        { id: "attempt", state: "running" },
        { id: "lease", state: "active" },
        { protocolSettlementState: null, outcome: null },
      ),
    });
    const repository = createPostgresTaskExecutionSteeringRepository(harness.db, {
      settlementTimeoutMs: 1,
      settlementPollIntervalMs: 1,
    });

    try {
      await expect(repository.awaitCancellationSettlement(request)).resolves.toEqual({
        kind: "pending",
        cancellationIntentId: request.cancellationIntentId,
      });
    } finally {
      now.mockRestore();
    }
    expect(harness.remaining("select")).toBe(0);
    expect(harness.remaining("update")).toBe(0);
  });

  it.each([
    {
      name: "accepts only a native ACPX cancellation as an incomplete old-prompt settlement",
      native: true,
      attemptState: "cancelled",
      leaseState: "released",
      outcome: "cancelled",
      expected: { kind: "settled" },
    },
    {
      name: "keeps an unproven incomplete old prompt fail-closed",
      native: false,
      attemptState: "failed",
      leaseState: "expired",
      outcome: "ambiguous",
      expected: { kind: "ambiguous", reason: "old ACP prompt settled incompletely" },
    },
  ])("$name", async ({ native, attemptState, leaseState, outcome, expected }) => {
    const nativeSettledAt = native ? new Date("2026-08-10T18:00:00.000Z") : null;
    const intent = {
      id: "intent",
      state: "acknowledged",
      failureCode: null,
      ...(native ? { acknowledgedAt: nativeSettledAt } : {}),
      nativeCancellationSettledAt: nativeSettledAt,
    };
    const select = rows(
      intent,
      { id: "attempt", state: attemptState },
      { id: "lease", state: leaseState },
      { protocolSettlementState: "incomplete", outcome },
    );
    if (native) select.push([intent]);
    const harness = createMockDb({
      select,
      ...(native ? { update: [[], []] } : {}),
    });
    const repository = createPostgresTaskExecutionSteeringRepository(harness.db, {
      settlementTimeoutMs: 100,
      settlementPollIntervalMs: 1,
    });

    await expect(repository.awaitCancellationSettlement(request)).resolves.toEqual({
      ...expected,
      cancellationIntentId: request.cancellationIntentId,
    });
    if (native) expect(harness.remaining("update")).toBe(0);
  });

  it("discovers settled orphan attempts for the existing source continuation", async () => {
    const source = {
      companyId: "company",
      taskId: "task",
      sourceCommentId: "comment",
    };
    const harness = createMockDb({ select: [[source]] });
    const repository = createPostgresTaskExecutionSteeringRepository(harness.db);

    await expect(repository.listRecoverableSources(10)).resolves.toEqual([source]);
    const where = harness.calls.find((call) => call.operation === "select" && call.method === "where");
    const query = new PgDialect().sqlToQuery(where!.args[0] as never);
    expect(query.params).toContain("steering");
    expect(query.params).toContain("active");
    expect(query.params).toContain("rebound");
  });
});
