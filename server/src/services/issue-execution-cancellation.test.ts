import { describe, expect, it, vi } from "vitest";
import { createIssueExecutionCancellationService } from "./issue-execution-cancellation.js";

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
    compaction: {} as never,
    settlement: {
      fenceRevokedExecutionAuthorityInTransaction,
      releaseBudgetScopeDeliveriesInTransaction,
    } as never,
    now: () => new Date("2026-07-31T12:00:00.000Z"),
  });
  return {
    service,
    fenceRevokedExecutionAuthorityInTransaction,
    releaseBudgetScopeDeliveriesInTransaction,
    lockActiveRunsForBudgetScopeInTransaction,
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
