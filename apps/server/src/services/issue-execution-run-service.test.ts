import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  computeIssueExecutionRunBatchDigest,
  createIssueExecutionRunInTransaction,
  createIssueExecutionRunService,
  IssueExecutionRunInvariantViolation,
  IssueExecutionSteeringRejected,
  transitionIssueExecutionRunStatusInTransaction,
  type IssueExecutionSteeringCancellationSettlement,
  type PendingIssueExecutionSteeringForSource,
  type RequestedIssueExecutionSteering,
} from "./issue-execution-run-service.js";
import { createMockDb } from "../__tests__/helpers/mock-db.js";

const runTime = new Date("2026-08-01T12:00:00.000Z");

function persistedRunRow(
  change: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "retry-source",
    companyId: "company",
    issueId: "issue",
    sessionId: "session",
    executionScopeId: "scope",
    kind: "productive",
    status: "failed",
    ownershipEpoch: 1,
    targetAgentId: "agent",
    adapterConfigRevisionId: "revision",
    executionWorkspaceBindingId: "workspace",
    executionMode: "owner",
    issueExecutionAuthorityId: "authority",
    consultExecutionId: null,
    parentRunId: null,
    retryOfRunId: null,
    currentAttemptId: null,
    currentLeaseId: null,
    cancellationIntentId: null,
    terminalFinalizationId: "finalization",
    startedAt: runTime,
    finishedAt: runTime,
    terminalClassification: "failed",
    terminalReasonCode: "process_loss_before_prompt",
    processExitCode: null,
    processSignal: null,
    createdAt: runTime,
    updatedAt: runTime,
    ...change,
  };
}

function runSelectionTransaction(rows: readonly Record<string, unknown>[]) {
  let ordinal = 0;
  const select = vi.fn(() => ({
    from: () => ({
      where: () => ({
        limit: () => ({
          for: async () => {
            const row = rows[ordinal];
            ordinal += 1;
            return row ? [row] : [];
          },
        }),
      }),
    }),
  }));
  return { transaction: { select } as never, select };
}

describe("canonical issue-execution run transitions", () => {
  it("encodes a same-time start predicate through the timestamp column", async () => {
    const harness = createMockDb({
      update: [[persistedRunRow({
        id: "run",
        status: "running",
        terminalFinalizationId: null,
        finishedAt: null,
        terminalClassification: null,
        terminalReasonCode: null,
      })]],
    });

    await transitionIssueExecutionRunStatusInTransaction(harness.db as never, {
      companyId: "company",
      issueId: "issue",
      runId: "run",
      expectedStatus: "queued",
      status: "running",
      startedAt: runTime,
      at: runTime,
    });

    const where = harness.calls.find(
      (call) => call.operation === "update" && call.method === "where",
    );
    const query = new PgDialect().sqlToQuery(where!.args[0] as never);
    expect(query.params.some((param) => param instanceof Date)).toBe(false);
    expect(query.params).toContain(runTime.toISOString());
  });
});

const requested: RequestedIssueExecutionSteering = Object.freeze({
  companyId: "company",
  issueId: "issue",
  ownershipEpoch: 3,
  runId: "run",
  targetAgentId: "agent",
  refId: "ref",
  refOrdinal: 2,
  interruptedSegmentOrdinal: 0,
  segmentOrdinal: 1,
  sourceCommentId: "comment",
  sourceMessageId: "input",
  sourceInputId: "input",
  cancellationIntentId: "cancel",
  cancellation: Object.freeze({
    companyId: "company",
    issueId: "issue",
    sessionId: "session",
    executionScopeId: "scope",
    refId: "ref",
    runId: "run",
    attemptId: "attempt",
    leaseGeneration: 4,
  }),
});

function fixture() {
  const order: string[] = [];
  const repository = {
    requestInTransaction: vi.fn(async () => requested),
    recordCancellationSignal: vi.fn(async () => {
      order.push("signal_recorded");
    }),
    awaitCancellationSettlement: vi.fn(
      async (): Promise<IssueExecutionSteeringCancellationSettlement> => {
      order.push("settled");
      return {
        kind: "settled_and_reaped" as const,
        cancellationIntentId: requested.cancellationIntentId,
      };
      },
    ),
    markAmbiguous: vi.fn(async () => {
      order.push("ambiguous");
    }),
    rebindAfterCancellation: vi.fn(async () => {
      order.push("rebound");
      return {
        companyId: requested.companyId,
        issueId: requested.issueId,
        ownershipEpoch: requested.ownershipEpoch,
        runId: requested.runId,
        targetAgentId: requested.targetAgentId,
        refId: requested.refId,
        refOrdinal: requested.refOrdinal,
        segmentOrdinal: requested.segmentOrdinal,
      };
    }),
    markResumeReady: vi.fn(async () => {
      order.push("resume_ready");
    }),
    findPendingForSource: vi.fn(
      async (): Promise<PendingIssueExecutionSteeringForSource> => ({
        kind: "requested" as const,
        request: requested,
      }),
    ),
  };
  const cancellation = {
    signalAttemptCancellation: vi.fn(() => {
      order.push("cancel");
      return true;
    }),
  };
  const resume = {
    resumeSteering: vi.fn(async () => {
      order.push("resume");
    }),
  };
  const steeringResults = {
    rebind: vi.fn(),
    publish: vi.fn(),
  };
  return {
    order,
    repository,
    cancellation,
    resume,
    steeringResults,
    service: createIssueExecutionRunService({
      database: {} as never,
      issueSessionStore: {} as never,
      repository,
      cancellation,
      resume,
      steeringResults,
    }),
  };
}

describe("canonical issue-execution run steering", () => {
  it("commits only the exact run selector and preserves message bytes", async () => {
    const { service, repository } = fixture();
    const transaction = {} as never;
    const input = {
      companyId: "company",
      issueId: "issue",
      ownershipEpoch: 3,
      runId: "run",
      targetAgentId: "agent",
      exactMessage: "  exact steering message\n",
      sourceCommentId: "comment",
      sourceMessageId: "input",
      sourceInputId: "input",
      actor: { kind: "user" as const, userId: "user" },
    };

    await expect(
      service.requestSteeringInTransaction(transaction, input),
    ).resolves.toBe(requested);
    expect(repository.requestInTransaction).toHaveBeenCalledWith(
      transaction,
      input,
    );
  });

  it("orders exact-attempt cancellation, settlement/reap, rebound, then same-run resume", async () => {
    const { service, order, cancellation, resume } = fixture();
    await expect(service.continueSteering(requested)).resolves.toMatchObject({
      runId: requested.runId,
      segmentOrdinal: requested.segmentOrdinal,
    });
    expect(order).toEqual([
      "cancel",
      "signal_recorded",
      "settled",
      "rebound",
      "resume_ready",
      "resume",
    ]);
    expect(cancellation.signalAttemptCancellation).toHaveBeenCalledWith(
      requested.cancellation,
    );
    expect(resume.resumeSteering).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: requested.runId,
        refId: requested.refId,
        segmentOrdinal: requested.segmentOrdinal,
      }),
    );
  });

  it("still fences through durable settlement when natural completion wins the signal race", async () => {
    const fixtureValue = fixture();
    fixtureValue.cancellation.signalAttemptCancellation.mockImplementation(
      () => {
        fixtureValue.order.push("cancel");
        return false;
      },
    );
    await fixtureValue.service.continueSteering(requested);
    expect(fixtureValue.order).toEqual([
      "cancel",
      "signal_recorded",
      "settled",
      "rebound",
      "resume_ready",
      "resume",
    ]);
  });

  it("fails closed on ambiguous cancellation without rebound or resume", async () => {
    const fixtureValue = fixture();
    fixtureValue.repository.awaitCancellationSettlement.mockResolvedValue({
      kind: "ambiguous",
      cancellationIntentId: requested.cancellationIntentId,
      reason: "old prompt transmission ordering is unknown",
    });

    await expect(
      fixtureValue.service.continueSteering(requested),
    ).rejects.toMatchObject({
      reason: "cancellation_ambiguous",
    });
    expect(fixtureValue.repository.markAmbiguous).toHaveBeenCalledOnce();
    expect(
      fixtureValue.repository.rebindAfterCancellation,
    ).not.toHaveBeenCalled();
    expect(fixtureValue.resume.resumeSteering).not.toHaveBeenCalled();
  });

  it("rejects a rebound that changes any canonical run/ref/segment identity", async () => {
    const fixtureValue = fixture();
    fixtureValue.repository.rebindAfterCancellation.mockResolvedValue({
      companyId: requested.companyId,
      issueId: requested.issueId,
      ownershipEpoch: requested.ownershipEpoch,
      runId: "different-run",
      targetAgentId: requested.targetAgentId,
      refId: requested.refId,
      refOrdinal: requested.refOrdinal,
      segmentOrdinal: requested.segmentOrdinal,
    });

    await expect(
      fixtureValue.service.continueSteering(requested),
    ).rejects.toBeInstanceOf(IssueExecutionSteeringRejected);
    expect(fixtureValue.repository.markAmbiguous).toHaveBeenCalledOnce();
    expect(fixtureValue.resume.resumeSteering).not.toHaveBeenCalled();
  });

  it("rejects missing identities and empty messages before persistence", async () => {
    const { service, repository } = fixture();
    await expect(
      service.requestSteeringInTransaction({} as never, {
        companyId: "company",
        issueId: "issue",
        ownershipEpoch: 3,
        runId: "run",
        targetAgentId: "agent",
        exactMessage: "",
        sourceCommentId: "comment",
        sourceMessageId: "synthetic",
        sourceInputId: null,
        actor: { kind: "agent", agentId: "agent" },
      }),
    ).rejects.toMatchObject({ reason: "invalid_request" });
    expect(repository.requestInTransaction).not.toHaveBeenCalled();
  });

  it("continues a durable requested segment from its source comment", async () => {
    const fixtureValue = fixture();
    await expect(
      fixtureValue.service.continuePendingSteeringForSource({
        companyId: requested.companyId,
        issueId: requested.issueId,
        sourceCommentId: requested.sourceCommentId,
      }),
    ).resolves.toEqual({
      kind: "continued_requested",
      rebound: expect.objectContaining({
        runId: requested.runId,
        segmentOrdinal: requested.segmentOrdinal,
      }),
    });
    expect(fixtureValue.repository.findPendingForSource).toHaveBeenCalledWith({
      companyId: requested.companyId,
      issueId: requested.issueId,
      sourceCommentId: requested.sourceCommentId,
    });
    expect(fixtureValue.order).toEqual([
      "cancel",
      "signal_recorded",
      "settled",
      "rebound",
      "resume_ready",
      "resume",
    ]);
  });

  it("re-fences and schedules an already rebound segment without cancelling again", async () => {
    const fixtureValue = fixture();
    fixtureValue.repository.findPendingForSource.mockResolvedValue({
      kind: "rebound",
      rebound: {
        companyId: requested.companyId,
        issueId: requested.issueId,
        ownershipEpoch: requested.ownershipEpoch,
        runId: requested.runId,
        targetAgentId: requested.targetAgentId,
        refId: requested.refId,
        refOrdinal: requested.refOrdinal,
        segmentOrdinal: requested.segmentOrdinal,
      },
    });

    await expect(
      fixtureValue.service.continuePendingSteeringForSource({
        companyId: requested.companyId,
        issueId: requested.issueId,
        sourceCommentId: requested.sourceCommentId,
      }),
    ).resolves.toMatchObject({ kind: "continued_rebound" });
    expect(fixtureValue.order).toEqual(["resume_ready", "resume"]);
    expect(
      fixtureValue.cancellation.signalAttemptCancellation,
    ).not.toHaveBeenCalled();
  });

  it("settles a waiting selector result when durable rebound resume fails", async () => {
    const fixtureValue = fixture();
    const rebound = {
      companyId: requested.companyId,
      issueId: requested.issueId,
      ownershipEpoch: requested.ownershipEpoch,
      runId: requested.runId,
      targetAgentId: requested.targetAgentId,
      refId: requested.refId,
      refOrdinal: requested.refOrdinal,
      segmentOrdinal: requested.segmentOrdinal,
    };
    fixtureValue.repository.findPendingForSource.mockResolvedValue({
      kind: "rebound",
      rebound,
    });
    fixtureValue.resume.resumeSteering.mockRejectedValue(
      new Error("native resume rejected"),
    );

    await expect(
      fixtureValue.service.continuePendingSteeringForSource({
        companyId: requested.companyId,
        issueId: requested.issueId,
        sourceCommentId: requested.sourceCommentId,
      }),
    ).rejects.toThrow("native resume rejected");
    expect(fixtureValue.steeringResults.publish).toHaveBeenCalledWith({
      companyId: rebound.companyId,
      issueId: rebound.issueId,
      runId: rebound.runId,
      refId: rebound.refId,
      refOrdinal: rebound.refOrdinal,
      segmentOrdinal: rebound.segmentOrdinal,
      outcome: "failed",
      response: "",
      reason: "native resume rejected",
    });
  });

  it("returns a typed in-flight result for an already resumed source", async () => {
    const fixtureValue = fixture();
    fixtureValue.repository.findPendingForSource.mockResolvedValue({
      kind: "resumed",
    });
    await expect(
      fixtureValue.service.continuePendingSteeringForSource({
        companyId: requested.companyId,
        issueId: requested.issueId,
        sourceCommentId: requested.sourceCommentId,
      }),
    ).resolves.toEqual({ kind: "already_resumed" });
    expect(fixtureValue.order).toEqual([]);
  });

  it("replays a canonical already-settled steering result", async () => {
    const fixtureValue = fixture();
    const result = {
      companyId: requested.companyId,
      issueId: requested.issueId,
      runId: requested.runId,
      refId: requested.refId,
      refOrdinal: requested.refOrdinal,
      segmentOrdinal: requested.segmentOrdinal,
      outcome: "succeeded" as const,
      response: "settled response",
      reason: null,
    };
    fixtureValue.repository.findPendingForSource.mockResolvedValue({
      kind: "terminal",
      result,
    });
    await expect(
      fixtureValue.service.continuePendingSteeringForSource({
        companyId: requested.companyId,
        issueId: requested.issueId,
        sourceCommentId: requested.sourceCommentId,
      }),
    ).resolves.toEqual({ kind: "already_settled", result });
    expect(fixtureValue.order).toEqual([]);
  });

  it("fails closed for an ambiguous durable source state", async () => {
    const fixtureValue = fixture();
    fixtureValue.repository.findPendingForSource.mockResolvedValue({
      kind: "ambiguous",
      reason: "persisted segment lifecycle is incomplete",
    });
    await expect(
      fixtureValue.service.continuePendingSteeringForSource({
        companyId: requested.companyId,
        issueId: requested.issueId,
        sourceCommentId: requested.sourceCommentId,
      }),
    ).rejects.toMatchObject({ reason: "persisted_ambiguous" });
    expect(fixtureValue.order).toEqual([]);
  });
});

describe("canonical issue-execution run envelope", () => {
  it("derives a stable text-free digest from ordered ref admission identities", () => {
    const members = [
      {
        refId: "ref-a",
        messageKind: "user",
        sourceMessageId: "input-a",
        admissionOrder: 3,
        admissionVersion: 10,
      },
      {
        refId: "ref-b",
        messageKind: "synthetic",
        sourceMessageId: "synthetic-b",
        admissionOrder: 4,
        admissionVersion: 11,
      },
    ] as const;
    expect(computeIssueExecutionRunBatchDigest(members)).toBe(
      computeIssueExecutionRunBatchDigest(members),
    );
    expect(computeIssueExecutionRunBatchDigest(members)).toMatch(
      /^[0-9a-f]{64}$/,
    );
    expect(
      computeIssueExecutionRunBatchDigest([
        members[0],
        { ...members[1], admissionVersion: 12 },
      ]),
    ).not.toBe(computeIssueExecutionRunBatchDigest(members));
  });

  it("rejects empty, duplicate, and non-monotonic run batches", () => {
    expect(() => computeIssueExecutionRunBatchDigest([])).toThrow(
      IssueExecutionRunInvariantViolation,
    );
    expect(() =>
      computeIssueExecutionRunBatchDigest([
        {
          refId: "ref",
          messageKind: "user",
          sourceMessageId: "input-a",
          admissionOrder: 2,
          admissionVersion: 2,
        },
        {
          refId: "ref",
          messageKind: "user",
          sourceMessageId: "input-b",
          admissionOrder: 3,
          admissionVersion: 3,
        },
      ]),
    ).toThrow(IssueExecutionRunInvariantViolation);
    expect(() =>
      computeIssueExecutionRunBatchDigest([
        {
          refId: "ref-a",
          messageKind: "user",
          sourceMessageId: "input-a",
          admissionOrder: 3,
          admissionVersion: 2,
        },
        {
          refId: "ref-b",
          messageKind: "user",
          sourceMessageId: "input-b",
          admissionOrder: 2,
          admissionVersion: 3,
        },
      ]),
    ).toThrow(IssueExecutionRunInvariantViolation);
  });

  it("rejects an empty productive batch before issuing a database query", async () => {
    const { service } = fixture();
    await expect(
      service.createRun({} as never, {
        companyId: "company",
        issueId: "issue",
        sessionId: "session",
        executionScopeId: "scope",
        ownershipEpoch: 1,
        adapterConfigRevisionId: "revision",
        executionWorkspaceBindingId: "workspace",
        at: new Date("2026-01-01T00:00:00.000Z"),
        kind: "productive",
        targetAgentId: "agent",
        issueExecutionAuthorityId: "authority",
        orderedRefIds: [],
      }),
    ).rejects.toBeInstanceOf(IssueExecutionRunInvariantViolation);
  });

  it("rejects a productive retry whose source has a different authority", async () => {
    const { transaction, select } = runSelectionTransaction([
      persistedRunRow({ issueExecutionAuthorityId: "other-authority" }),
    ]);
    await expect(
      createIssueExecutionRunInTransaction(transaction, {
        companyId: "company",
        issueId: "issue",
        sessionId: "session",
        executionScopeId: "scope",
        ownershipEpoch: 1,
        adapterConfigRevisionId: "revision",
        executionWorkspaceBindingId: "workspace",
        retryOfRunId: "retry-source",
        at: runTime,
        kind: "productive",
        targetAgentId: "agent",
        issueExecutionAuthorityId: "authority",
        orderedRefIds: ["ref"],
      }),
    ).rejects.toThrow(
      "retry run is not a terminal run of the exact same kind and scope",
    );
    expect(select).toHaveBeenCalledOnce();
  });

  it.each([
    {
      label: "consult execution",
      change: { consultExecutionId: "other-consult" },
    },
    {
      label: "parent run",
      change: { parentRunId: "other-parent" },
    },
  ])("rejects a consult retry with a different $label", async ({ change }) => {
    const activeParent = persistedRunRow({
      id: "parent",
      status: "running",
      terminalFinalizationId: null,
      finishedAt: null,
      terminalClassification: null,
      terminalReasonCode: null,
    });
    const retrySource = persistedRunRow({
      id: "retry-source",
      kind: "consult",
      executionMode: "consult",
      issueExecutionAuthorityId: null,
      consultExecutionId: "consult",
      parentRunId: "parent",
      ...change,
    });
    const { transaction, select } = runSelectionTransaction([
      activeParent,
      retrySource,
    ]);
    await expect(
      createIssueExecutionRunInTransaction(transaction, {
        companyId: "company",
        issueId: "issue",
        sessionId: "session",
        executionScopeId: "scope",
        ownershipEpoch: 1,
        adapterConfigRevisionId: "revision",
        executionWorkspaceBindingId: "workspace",
        retryOfRunId: "retry-source",
        at: runTime,
        kind: "consult",
        targetAgentId: "agent",
        consultExecutionId: "consult",
        parentRunId: "parent",
        orderedRefIds: ["ref"],
      }),
    ).rejects.toThrow(
      "retry run is not a terminal run of the exact same kind and scope",
    );
    expect(select).toHaveBeenCalledTimes(2);
  });

  it("rejects unbounded list/detail reads before touching the database", async () => {
    const { service } = fixture();
    await expect(
      service.listForIssue({
        companyId: "company",
        issueId: "issue",
        limit: 201,
      }),
    ).rejects.toBeInstanceOf(IssueExecutionRunInvariantViolation);
    await expect(
      service.readJoinedRunDetail({
        companyId: "company",
        issueId: "issue",
        runId: "run",
        limit: 501,
      }),
    ).rejects.toBeInstanceOf(IssueExecutionRunInvariantViolation);
  });

  it("rejects empty, duplicate, and open-ended run status filters before querying", async () => {
    const { service } = fixture();
    for (const statuses of [
      [],
      ["running", "running"],
      ["unknown"],
    ] as const) {
      await expect(
        service.listForActivity({
          companyId: "company",
          statuses: statuses as never,
          limit: 20,
        }),
      ).rejects.toBeInstanceOf(IssueExecutionRunInvariantViolation);
    }
  });
});
