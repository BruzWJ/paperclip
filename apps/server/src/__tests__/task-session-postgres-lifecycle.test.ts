import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  acknowledgeCompanyCancellationIntentsInTx,
  archiveCompanySessionGraphInTx,
  reconcileCompanyCancellationIntentInTx,
  purgeCompanySessionGraphInTx,
  reactivateCompanySessionGraphInTx,
} from "../services/task-session-lifecycle.js";
import { TaskSessionLifecycleConflict } from "../services/task-session/store.js";
import { createMockDb } from "./helpers/mock-db.js";

const runMocks = vi.hoisted(() => ({
  attachTaskExecutionRunCancellationInTransaction: vi.fn(async () => undefined),
  detachTaskExecutionRunAttemptInTransaction: vi.fn(async () => undefined),
  detachTaskExecutionRunCancellationInTransaction: vi.fn(async () => undefined),
  lockTaskExecutionRunInTransaction: vi.fn(async () => ({
    status: "cancelled",
    cancellationIntentId: null,
    currentAttemptId: null,
    currentLeaseId: null,
  })),
  purgeCompanyTaskExecutionRunsInTransaction: vi.fn(async () => undefined),
}));

vi.mock("../services/task-execution-run-service.js", () => runMocks);

const companyId = "00000000-0000-4000-8000-000000000001";
const taskId = "00000000-0000-4000-8000-000000000002";
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
  taskId?: string;
} = {}) {
  return {
    id: input.id ?? sessionId,
    companyId,
    taskId: input.taskId ?? taskId,
    parentSessionId: input.parentSessionId ?? null,
  };
}

function operation(input: {
  operation?: "archive" | "hard_delete";
  status?: string;
  generation?: number;
  sessionIds?: string[];
  taskIds?: string[];
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
      taskIds: input.taskIds ?? [taskId],
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
    runMocks.lockTaskExecutionRunInTransaction.mockResolvedValue({
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
    )).rejects.toBeInstanceOf(TaskSessionLifecycleConflict);
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
    )).rejects.toBeInstanceOf(TaskSessionLifecycleConflict);
    expect(harness.calls).toEqual([]);
  });

  it("waits when an expired running attempt minted an ACPX capability", async () => {
    const intentId = "00000000-0000-4000-8000-000000000020";
    const attemptId = "00000000-0000-4000-8000-000000000021";
    const leaseId = "00000000-0000-4000-8000-000000000023";
    const runId = "00000000-0000-4000-8000-000000000022";
    const intent = {
      id: intentId,
      companyId,
      taskId,
      runId,
      attemptId,
      leaseId,
      state: "acknowledged",
      nativeCancellationSettledAt: null,
    };
    const harness = createMockDb({
      execute: [[], []],
      select: [
        [intent],
        [intent],
        [{ id: attemptId, state: "running" }],
        [{
          id: leaseId,
          state: "active",
          expiredAtDatabaseClock: true,
        }],
        [{ capabilityConnectionId: "00000000-0000-4000-8000-000000000024" }],
      ],
    });
    runMocks.lockTaskExecutionRunInTransaction.mockResolvedValueOnce({
      runId,
      status: "running",
      cancellationIntentId: intentId,
      currentAttemptId: attemptId,
      currentLeaseId: leaseId,
    });

    await expect(reconcileCompanyCancellationIntentInTx(
      harness.db as never,
      {
        intentId,
        now,
      },
    )).resolves.toBeNull();
    expect(harness.calls.some((call) => call.operation === "update"))
      .toBe(false);
  });

  it("completes an expired attempt that never minted an ACPX capability", async () => {
    const intentId = "00000000-0000-4000-8000-000000000030";
    const attemptId = "00000000-0000-4000-8000-000000000031";
    const leaseId = "00000000-0000-4000-8000-000000000032";
    const runId = "00000000-0000-4000-8000-000000000033";
    const intent = {
      id: intentId,
      companyId,
      taskId,
      sessionId,
      runId,
      attemptId,
      leaseId,
      state: "acknowledged",
      nativeCancellationSettledAt: null,
    };
    const completed = {
      ...intent,
      state: "completed",
      completedAt: now,
    };
    const attempt = { id: attemptId, state: "running" };
    const cancelling = operation({
      operation: "hard_delete",
      status: "cancelling",
      attempts: [{
        intentId,
        companyId,
        taskId,
        sessionId,
        runId,
        attemptId,
        leaseId,
      }],
      runs: [],
    });
    const harness = createMockDb({
      execute: [[], []],
      select: [
        [intent],
        [intent],
        [attempt],
        [{
          id: leaseId,
          state: "active",
          expiredAtDatabaseClock: true,
        }],
        [],
        [cancelling],
      ],
      update: [[], [], [completed]],
    });
    runMocks.lockTaskExecutionRunInTransaction.mockResolvedValueOnce({
      runId,
      status: "running",
      cancellationIntentId: intentId,
      currentAttemptId: attemptId,
      currentLeaseId: leaseId,
    });
    runMocks.detachTaskExecutionRunCancellationInTransaction
      .mockResolvedValueOnce({
        runId,
        status: "running",
        cancellationIntentId: null,
        currentAttemptId: attemptId,
        currentLeaseId: leaseId,
      });

    const result = await reconcileCompanyCancellationIntentInTx(
      harness.db as never,
      {
        intentId,
        now,
      },
    );

    expect(result).toEqual({
      intent: completed,
      operation: cancelling,
    });
    expect(runMocks.detachTaskExecutionRunCancellationInTransaction)
      .toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        runId,
        expectedCancellationIntentId: intentId,
      }));
    expect(runMocks.detachTaskExecutionRunAttemptInTransaction)
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
    const safetyChecks = Array.from({ length: 9 }, () => [] as unknown[]);
    safetyChecks[7] = [{
      leaseId: "00000000-0000-4000-8000-000000000040",
    }];
    const harness = createMockDb({
      execute: [[], []],
      select: [[{ id: companyId }], [purgeReady], ...safetyChecks],
    });

    await expect(purgeCompanySessionGraphInTx(
      harness.db as never,
      { companyId, lifecycleOperationId: operationId, now },
    )).rejects.toBeInstanceOf(TaskSessionLifecycleConflict);
    expect(harness.calls.some((call) => call.operation === "delete"))
      .toBe(false);
  });

  it("purges the canonical graph only after every cancellation gate is empty", async () => {
    const childSessionId = "ses_00000000000040008000000000000005";
    const childTaskId = "00000000-0000-4000-8000-000000000005";
    const purgeReady = operation({
      operation: "hard_delete",
      status: "purge_ready",
      generation: 7,
      sessionIds: [sessionId, childSessionId],
      taskIds: [taskId, childTaskId],
    });
    const emptySafetyChecks = Array.from({ length: 9 }, () => []);
    const deleteResults = [
      ...Array.from({ length: 45 }, () => []),
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
            taskId: childTaskId,
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

    expect(runMocks.purgeCompanyTaskExecutionRunsInTransaction)
      .toHaveBeenCalledWith(expect.anything(), { companyId });
    expect(harness.remaining("select")).toBe(0);
    expect(harness.remaining("delete")).toBe(0);
    expect(harness.remaining("update")).toBe(0);
  });
});
