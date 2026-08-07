import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  acknowledgeCompanyCancellationIntentsInTx,
  archiveCompanySessionGraphInTx,
  completeCompanyCancellationIntentInTx,
  purgeCompanySessionGraphInTx,
  reactivateCompanySessionGraphInTx,
} from "../services/issue-session-lifecycle.js";
import { IssueSessionLifecycleConflict } from "../services/issue-session/store.js";
import { createMockDb } from "./helpers/mock-db.js";

const runMocks = vi.hoisted(() => ({
  attachIssueExecutionRunCancellationInTransaction: vi.fn(async () => undefined),
  detachIssueExecutionRunAttemptInTransaction: vi.fn(async () => undefined),
  detachIssueExecutionRunCancellationInTransaction: vi.fn(async () => undefined),
  lockIssueExecutionRunInTransaction: vi.fn(async () => ({
    status: "cancelled",
    cancellationIntentId: null,
    currentAttemptId: null,
    currentLeaseId: null,
  })),
  purgeCompanyIssueExecutionRunsInTransaction: vi.fn(async () => undefined),
}));

vi.mock("../services/issue-execution-run-service.js", () => runMocks);

const companyId = "00000000-0000-4000-8000-000000000001";
const issueId = "00000000-0000-4000-8000-000000000002";
const operationId = "00000000-0000-4000-8000-000000000003";
const sessionId = "ses_00000000000040008000000000000004";
const now = new Date("2026-07-25T11:00:00.000Z");

function company(integrityState: string) {
  return {
    id: companyId,
    status: "archived",
    sessionIntegrityState: integrityState,
    sessionLifecycleGeneration: 0,
  };
}

function session(input: {
  id?: string;
  parentSessionId?: string | null;
  issueId?: string;
} = {}) {
  return {
    id: input.id ?? sessionId,
    companyId,
    issueId: input.issueId ?? issueId,
    parentSessionId: input.parentSessionId ?? null,
  };
}

function operation(input: {
  operation?: "archive" | "hard_delete";
  status?: string;
  generation?: number;
  sessionIds?: string[];
  issueIds?: string[];
  attempts?: Record<string, unknown>[];
  runs?: Record<string, unknown>[];
} = {}) {
  return {
    id: operationId,
    companyId,
    generation: input.generation ?? 1,
    operation: input.operation ?? "archive",
    status: input.status ?? "completed",
    fenceToken: "00000000-0000-4000-8000-000000000099",
    sessionGraphSnapshot: {
      version: "company-session-lifecycle/v1",
      sessionIds: input.sessionIds ?? [sessionId],
      issueIds: input.issueIds ?? [issueId],
      attempts: input.attempts ?? [],
      runs: input.runs ?? [],
    },
    cancellingAt: null,
    purgeReadyAt: null,
    completedAt: now,
    failedAt: null,
    failureReason: null,
    createdAt: now,
    updatedAt: now,
  };
}

describe("canonical company Session lifecycle without a database process", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runMocks.lockIssueExecutionRunInTransaction.mockResolvedValue({
      status: "cancelled",
      cancellationIntentId: null,
      currentAttemptId: null,
      currentLeaseId: null,
    });
  });

  it("archives the graph by fencing admission while leaving durable content untouched", async () => {
    const archived = operation();
    const harness = createMockDb({
      execute: [[], [], []],
      select: [
        [company("ready")],
        [],
        [],
        [session()],
        [],
        [],
        [],
      ],
      insert: [[archived]],
      update: Array.from({ length: 10 }, () => []),
    });

    const result = await archiveCompanySessionGraphInTx(
      harness.db as never,
      companyId,
      operationId,
      { now, fenceToken: archived.fenceToken },
    );

    expect(result).toMatchObject({
      created: true,
      operation: {
        id: operationId,
        operation: "archive",
        status: "completed",
      },
      intents: [],
      runs: [],
    });
    expect(harness.calls.filter((call) => call.method === "update"))
      .toHaveLength(10);
    expect(harness.calls.some((call) => call.operation === "delete"))
      .toBe(false);
    expect(harness.remaining("select")).toBe(0);
    expect(harness.remaining("update")).toBe(0);
  });

  it("reactivates only a completed archive fence and does not repair invalidated history", async () => {
    const archived = operation({ generation: 4 });
    const harness = createMockDb({
      execute: [[], [], []],
      select: [
        [company("archive_fenced")],
        [archived],
        [],
        [session()],
      ],
      update: [[], []],
    });

    await expect(reactivateCompanySessionGraphInTx(
      harness.db as never,
      { companyId, now: new Date(now.getTime() + 1_000) },
    )).resolves.toEqual({ companyId, generation: 4 });

    expect(harness.calls.filter((call) => call.method === "update"))
      .toHaveLength(2);
    expect(harness.calls.some((call) => call.operation === "insert"))
      .toBe(false);
    expect(harness.calls.some((call) => call.operation === "delete"))
      .toBe(false);
  });

  it("refuses reactivation after a hard-delete fence", async () => {
    const harness = createMockDb({
      execute: [[], []],
      select: [[company("hard_delete_fenced")]],
    });

    await expect(reactivateCompanySessionGraphInTx(
      harness.db as never,
      { companyId, now },
    )).rejects.toBeInstanceOf(IssueSessionLifecycleConflict);
    expect(harness.calls.some((call) => call.operation === "update"))
      .toBe(false);
  });

  it("claims requested cancellation intents and leaves acknowledged claims restart-safe", async () => {
    const requested = {
      id: "00000000-0000-4000-8000-000000000010",
      companyId,
      state: "requested",
      requestedAt: now,
    };
    const alreadyAcknowledged = {
      id: "00000000-0000-4000-8000-000000000011",
      companyId,
      state: "acknowledged",
      requestedAt: new Date(now.getTime() + 1),
    };
    const claimed = [
      { ...requested, state: "acknowledged", acknowledgedAt: now },
      alreadyAcknowledged,
    ];
    const harness = createMockDb({
      execute: [[], []],
      select: [[requested, alreadyAcknowledged], claimed],
      update: [[]],
    });

    await expect(acknowledgeCompanyCancellationIntentsInTx(
      harness.db as never,
      { companyId, limit: 2, now },
    )).resolves.toEqual(claimed);

    expect(harness.calls.filter((call) => call.method === "update"))
      .toHaveLength(1);
    expect(harness.remaining("select")).toBe(0);
  });

  it("validates the cancellation claim limit before acquiring a lifecycle lock", async () => {
    const harness = createMockDb();

    await expect(acknowledgeCompanyCancellationIntentsInTx(
      harness.db as never,
      { companyId, limit: 0 },
    )).rejects.toBeInstanceOf(IssueSessionLifecycleConflict);
    expect(harness.calls).toEqual([]);
  });

  it("requires a native-session cancellation signal for a running attempt", async () => {
    const intentId = "00000000-0000-4000-8000-000000000020";
    const attemptId = "00000000-0000-4000-8000-000000000021";
    const intent = {
      id: intentId,
      companyId,
      issueId,
      runId: "00000000-0000-4000-8000-000000000022",
      attemptId,
      leaseId: null,
      processFactId: null,
      state: "acknowledged",
    };
    const harness = createMockDb({
      execute: [[], []],
      select: [
        [intent],
        [intent],
        [],
        [{ id: attemptId, state: "running" }],
      ],
    });

    await expect(completeCompanyCancellationIntentInTx(
      harness.db as never,
      {
        intentId,
        proof: {
          inMemoryExecutionAbsent: true,
          nativeSessionCancellation: "not_required",
        },
        now,
      },
    )).rejects.toBeInstanceOf(IssueSessionLifecycleConflict);
    expect(harness.calls.some((call) => call.operation === "update"))
      .toBe(false);
  });

  it("completes exact attempt ownership and advances hard delete to purge-ready", async () => {
    const intentId = "00000000-0000-4000-8000-000000000030";
    const attemptId = "00000000-0000-4000-8000-000000000031";
    const leaseId = "00000000-0000-4000-8000-000000000032";
    const runId = "00000000-0000-4000-8000-000000000033";
    const intent = {
      id: intentId,
      companyId,
      issueId,
      sessionId,
      runId,
      attemptId,
      leaseId,
      processFactId: null,
      state: "acknowledged",
      sessionCancelSentAt: null,
    };
    const completed = {
      ...intent,
      state: "completed",
      sessionCancelSentAt: now,
      completedAt: now,
    };
    const attempt = { id: attemptId, state: "running" };
    const cancelling = operation({
      operation: "hard_delete",
      status: "cancelling",
      attempts: [{
        intentId,
        companyId,
        issueId,
        sessionId,
        runId,
        attemptId,
        leaseId,
        processFactId: null,
      }],
      runs: [],
    });
    const purgeReady = {
      ...cancelling,
      status: "purge_ready",
      purgeReadyAt: now,
    };
    const harness = createMockDb({
      execute: [[], []],
      select: [
        [intent],
        [intent],
        [cancelling],
        [attempt],
        [completed],
      ],
      update: [[], [], [completed], [purgeReady]],
    });
    runMocks.lockIssueExecutionRunInTransaction
      .mockResolvedValueOnce({
        status: "running",
        cancellationIntentId: intentId,
        currentAttemptId: attemptId,
        currentLeaseId: leaseId,
      })
      .mockResolvedValueOnce({
        status: "cancelled",
        cancellationIntentId: null,
        currentAttemptId: attemptId,
        currentLeaseId: leaseId,
      });

    const result = await completeCompanyCancellationIntentInTx(
      harness.db as never,
      {
        intentId,
        proof: {
          inMemoryExecutionAbsent: true,
          nativeSessionCancellation: "sent",
        },
        now,
      },
    );

    expect(result).toEqual({ intent: completed, operation: purgeReady });
    expect(runMocks.detachIssueExecutionRunCancellationInTransaction)
      .toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        runId,
        expectedCancellationIntentId: intentId,
      }));
    expect(runMocks.detachIssueExecutionRunAttemptInTransaction)
      .toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        runId,
        expectedAttemptId: attemptId,
        expectedLeaseId: leaseId,
      }));
    expect(harness.remaining("select")).toBe(0);
    expect(harness.remaining("update")).toBe(0);
  });

  it("blocks purge while an execution lane still owns a lease", async () => {
    const purgeReady = operation({
      operation: "hard_delete",
      status: "purge_ready",
    });
    const safetyChecks = Array.from({ length: 10 }, () => [] as unknown[]);
    safetyChecks[8] = [{
      leaseId: "00000000-0000-4000-8000-000000000040",
    }];
    const harness = createMockDb({
      execute: [[], []],
      select: [[{ id: companyId }], [purgeReady], ...safetyChecks],
    });

    await expect(purgeCompanySessionGraphInTx(
      harness.db as never,
      { companyId, lifecycleOperationId: operationId, now },
    )).rejects.toBeInstanceOf(IssueSessionLifecycleConflict);
    expect(harness.calls.some((call) => call.operation === "delete"))
      .toBe(false);
  });

  it("purges the canonical graph only after every cancellation gate is empty", async () => {
    const childSessionId = "ses_00000000000040008000000000000005";
    const childIssueId = "00000000-0000-4000-8000-000000000005";
    const purgeReady = operation({
      operation: "hard_delete",
      status: "purge_ready",
      generation: 7,
      sessionIds: [sessionId, childSessionId],
      issueIds: [issueId, childIssueId],
    });
    const emptySafetyChecks = Array.from({ length: 10 }, () => []);
    const deleteResults = [
      ...Array.from({ length: 46 }, () => []),
      [{ id: companyId }],
    ];
    const harness = createMockDb({
      execute: [[], [], [], []],
      select: [
        [{ id: companyId }],
        [purgeReady],
        ...emptySafetyChecks,
        [
          session(),
          session({
            id: childSessionId,
            parentSessionId: sessionId,
            issueId: childIssueId,
          }),
        ],
      ],
      delete: deleteResults,
      update: [[]],
    });

    await expect(purgeCompanySessionGraphInTx(
      harness.db as never,
      { companyId, lifecycleOperationId: operationId, now },
    )).resolves.toEqual({ companyId, generation: 7, purged: true });

    expect(runMocks.purgeCompanyIssueExecutionRunsInTransaction)
      .toHaveBeenCalledWith(expect.anything(), { companyId });
    expect(harness.remaining("select")).toBe(0);
    expect(harness.remaining("delete")).toBe(0);
    expect(harness.remaining("update")).toBe(0);
  });
});
