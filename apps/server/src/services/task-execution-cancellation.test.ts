import { describe, expect, it, vi } from "vitest";
import { createMockDb } from "../__tests__/helpers/mock-db.js";
import { createTaskExecutionCancellationService } from "./task-execution-cancellation.js";

const pluginDomainEvents = {
  publish: async () => undefined,
};

function fixture() {
  const fenceRevokedExecutionAuthorityInTransaction = vi.fn(async () => ({
    refIds: ["ref-budget"],
    correlationIds: ["correlation-budget"],
  }));
  const lockActiveRunsForBudgetScopeInTransaction = vi.fn(
    async () => Object.freeze([]),
  );
  const service = createTaskExecutionCancellationService({
    database: {} as never,
    runService: {
      lockActiveRunsForBudgetScopeInTransaction,
    } as never,
    dispatcher: {} as never,
    settlement: {
      fenceRevokedExecutionAuthorityInTransaction,
    } as never,
    pluginDomainEvents,
    now: () => new Date("2026-07-31T12:00:00.000Z"),
  });
  return {
    service,
    fenceRevokedExecutionAuthorityInTransaction,
    lockActiveRunsForBudgetScopeInTransaction,
  };
}

function scopedFixture(input: {
  runs?: readonly unknown[];
  onRunsLocked?: () => void;
  fencedRefIds?: () => readonly string[];
  pluginDomainEvents?: { publish(event: unknown): Promise<void> };
}) {
  const events: string[] = [];
  const lockActiveRunsForScopeInTransaction = vi.fn(async () => {
    events.push("run_locked");
    input.onRunsLocked?.();
    return (input.runs ?? []) as never;
  });
  const fenceRevokedExecutionAuthorityInTransaction = vi.fn(async () => {
    events.push("refs_fenced");
    return {
      refIds: [...(input.fencedRefIds?.() ?? [])],
      correlationIds: [],
    };
  });
  const terminalizeDetachedCancelledRunInTransaction = vi.fn(async () => true);
  return {
    service: createTaskExecutionCancellationService({
      database: {} as never,
      runService: { lockActiveRunsForScopeInTransaction } as never,
      dispatcher: {} as never,
      settlement: {
        fenceRevokedExecutionAuthorityInTransaction,
        terminalizeDetachedCancelledRunInTransaction,
      } as never,
      pluginDomainEvents: input.pluginDomainEvents ?? pluginDomainEvents,
    }),
    events,
    lockActiveRunsForScopeInTransaction,
    fenceRevokedExecutionAuthorityInTransaction,
    terminalizeDetachedCancelledRunInTransaction,
  };
}

function activeRun(
  runId: string,
  status: "queued" | "running" | "scheduled_retry",
  cancellationIntentId: string | null = null,
) {
  return {
    companyId: "company-1",
    taskId: "task-1",
    runId,
    targetAgentId: "agent-1",
    status,
    cancellationIntentId,
    currentAttemptId: null,
    currentLeaseId: null,
  };
}

describe("budget-scope execution suspension", () => {
  it("fences the exact project scope and locks its active runs in one transaction", async () => {
    const value = fixture();
    const transaction = {} as never;
    const now = new Date("2026-07-31T12:00:00.000Z");
    const requested =
      await value.service.requestBudgetScopeSuspensionInTransaction(
        transaction,
        {
          companyId: "company-1",
          scopeType: "project",
          scopeId: "project-1",
          actor: { kind: "system" },
          now,
        },
      );

    expect(
      value.fenceRevokedExecutionAuthorityInTransaction,
    ).toHaveBeenCalledWith(transaction, {
      companyId: "company-1",
      selector: {
        kind: "budget_scope",
        scopeType: "project",
        scopeId: "project-1",
      },
      reason: "budget_hard_stop",
      at: now,
    });
    expect(
      value.lockActiveRunsForBudgetScopeInTransaction,
    ).toHaveBeenCalledWith(transaction, {
      companyId: "company-1",
      scopeType: "project",
      scopeId: "project-1",
    });
    expect(requested).toMatchObject({
      companyId: "company-1",
      scopeType: "project",
      scopeId: "project-1",
      reason: "budget_hard_stop",
      requests: [],
    });
  });

});

describe("scoped execution cancellation", () => {
  it("locks runs before fencing a late finalizer-created routed ref", async () => {
    let routedRefCommitted = false;
    const value = scopedFixture({
      onRunsLocked: () => {
        routedRefCommitted = true;
      },
      fencedRefIds: () =>
        routedRefCommitted ? ["ref-routed-after-finalization"] : [],
    });
    const transaction = {} as never;
    const now = new Date("2026-08-05T12:00:00.000Z");

    const requested =
      await value.service.requestScopeCancellationsInTransaction(transaction, {
        companyId: "company-1",
        taskId: "task-1",
        selector: { kind: "ownership_epoch", ownershipEpoch: 4 },
        reason: "task_cancelled",
        actor: { kind: "system" },
        now,
      });

    expect(value.events).toEqual(["run_locked", "refs_fenced"]);
    expect(requested.fence.refIds).toEqual([
      "ref-routed-after-finalization",
    ]);
  });

  it("interrupts only running attempts without fencing queued refs", async () => {
    const value = scopedFixture({
      runs: [
        activeRun("run-queued", "queued"),
        activeRun("run-running", "running", "intent-running"),
        activeRun("run-retry", "scheduled_retry"),
      ],
    });
    const transaction = {} as never;
    const now = new Date("2026-08-05T12:00:00.000Z");

    const requested =
      await value.service.requestRunningTaskInterruptionsInTransaction(
        transaction,
        {
          companyId: "company-1",
          taskId: "task-1",
          ownershipEpoch: 4,
          reason: "task_tree_paused",
          actor: { kind: "user", userId: "user-1" },
          now,
        },
      );

    expect(value.fenceRevokedExecutionAuthorityInTransaction)
      .not.toHaveBeenCalled();
    expect(requested.requests.map((request) => request.runId))
      .toEqual(["run-running"]);
  });

  it("carries a post-commit event for a detached run terminalized in the transaction", async () => {
    const publish = vi.fn(async () => undefined);
    const value = scopedFixture({
      runs: [activeRun("run-queued", "queued")],
      pluginDomainEvents: { publish },
    });
    const now = new Date("2026-08-05T12:00:00.000Z");

    const requested = await value.service.requestScopeCancellationsInTransaction(
      {} as never,
      {
        companyId: "company-1",
        taskId: "task-1",
        selector: { kind: "ownership_epoch", ownershipEpoch: 4 },
        reason: "task_cancelled",
        actor: { kind: "system" },
        now,
      },
    );

    expect(value.terminalizeDetachedCancelledRunInTransaction).toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(requested.requests).toEqual([expect.objectContaining({
      runId: "run-queued",
      state: "terminalized",
      terminalEvent: {
        companyId: "company-1",
        taskId: "task-1",
        runId: "run-queued",
        agentId: "agent-1",
        outcome: "cancelled",
        reason: "task_cancelled",
        occurredAt: now,
      },
    })]);

    await value.service.reconcileRequestedCancellations(requested);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "agent.run.cancelled",
      companyId: "company-1",
      entityId: "run-queued",
    }));
  });
});

describe("direct run cancellation", () => {
  it("uses the canonical detached-run transaction and publishes its exact terminal event", async () => {
    const runId = "00000000-0000-4000-8000-000000000101";
    const at = new Date("2026-08-05T12:00:00.000Z");
    const publish = vi.fn(async () => undefined);
    const terminalizeDetachedCancelledRunInTransaction = vi.fn(
      async () => true,
    );
    const terminalizeCancelledRun = vi.fn(async () => undefined);
    const lockRun = vi.fn(async () => activeRun(runId, "queued"));
    const { db } = createMockDb({
      select: [[{
        companyId: "company-1",
        taskId: "task-1",
        runId,
      }]],
    });
    const service = createTaskExecutionCancellationService({
      database: db,
      runService: { lockRun } as never,
      dispatcher: {} as never,
      settlement: {
        terminalizeCancelledRun,
        terminalizeDetachedCancelledRunInTransaction,
      } as never,
      pluginDomainEvents: { publish },
      now: () => at,
    });

    await expect(service.cancelRun(runId, "board_cancelled"))
      .resolves.toEqual({
        runId,
        alreadyTerminal: false,
        cancellationIntentId: null,
        state: "terminalized",
      });

    expect(terminalizeDetachedCancelledRunInTransaction).toHaveBeenCalledWith(
      db,
      {
        companyId: "company-1",
        taskId: "task-1",
        runId,
        reason: "board_cancelled",
        finishedAt: at,
      },
    );
    expect(terminalizeCancelledRun).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "agent.run.cancelled",
      companyId: "company-1",
      entityId: runId,
      payload: expect.objectContaining({
        taskId: "task-1",
        agentId: "agent-1",
        reason: "board_cancelled",
      }),
    }));
  });
});
