import { describe, expect, it, vi } from "vitest";
import { createIssueExecutionCancellationService } from "./issue-execution-cancellation.js";

const pluginDomainEvents = {
  publish: async () => undefined,
};

function fixture() {
  const fenceRevokedExecutionAuthorityInTransaction = vi.fn(async () => ({
    refIds: ["ref-budget"],
    deliveryIds: ["delivery-budget"],
    correlationIds: ["correlation-budget"],
  }));
  const releaseBudgetScopeDeliveriesInTransaction = vi.fn(
    async () => ["delivery-budget"],
  );
  const lockActiveRunsForBudgetScopeInTransaction = vi.fn(
    async () => Object.freeze([]),
  );
  const service = createIssueExecutionCancellationService({
    database: {} as never,
    runService: {
      lockActiveRunsForBudgetScopeInTransaction,
    } as never,
    dispatcher: {} as never,
    settlement: {
      fenceRevokedExecutionAuthorityInTransaction,
      releaseBudgetScopeDeliveriesInTransaction,
    } as never,
    pluginDomainEvents,
    now: () => new Date("2026-07-31T12:00:00.000Z"),
  });
  return {
    service,
    fenceRevokedExecutionAuthorityInTransaction,
    releaseBudgetScopeDeliveriesInTransaction,
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
      deliveryIds: [],
      correlationIds: [],
    };
  });
  const terminalizeDetachedCancelledRunInTransaction = vi.fn(async () => true);
  return {
    service: createIssueExecutionCancellationService({
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
    issueId: "issue-1",
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

  it("releases only the exact budget hold through the typed settlement owner", async () => {
    const value = fixture();
    const transaction = {} as never;
    const now = new Date("2026-07-31T12:00:00.000Z");
    await expect(
      value.service.releaseBudgetScopeSuspensionInTransaction(transaction, {
        companyId: "company-1",
        scopeType: "agent",
        scopeId: "agent-1",
        now,
      }),
    ).resolves.toEqual({
      companyId: "company-1",
      scopeType: "agent",
      scopeId: "agent-1",
      deliveryIds: ["delivery-budget"],
    });
    expect(
      value.releaseBudgetScopeDeliveriesInTransaction,
    ).toHaveBeenCalledWith(transaction, {
      companyId: "company-1",
      scopeType: "agent",
      scopeId: "agent-1",
      at: now,
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
        issueId: "issue-1",
        selector: { kind: "ownership_epoch", ownershipEpoch: 4 },
        reason: "issue_cancelled",
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
      await value.service.requestRunningIssueInterruptionsInTransaction(
        transaction,
        {
          companyId: "company-1",
          issueId: "issue-1",
          ownershipEpoch: 4,
          reason: "issue_tree_paused",
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
        issueId: "issue-1",
        selector: { kind: "ownership_epoch", ownershipEpoch: 4 },
        reason: "issue_cancelled",
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
        issueId: "issue-1",
        runId: "run-queued",
        agentId: "agent-1",
        outcome: "cancelled",
        reason: "issue_cancelled",
        occurredAt: now,
      },
    })]);

    await value.service.reconcileRequestedScopeCancellations(requested);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "agent.run.cancelled",
      companyId: "company-1",
      entityId: "run-queued",
    }));
  });
});
