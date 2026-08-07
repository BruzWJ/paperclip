import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { agentService } from "../services/agents.ts";
import { companyService } from "../services/companies.ts";
import { createMockDb } from "./helpers/mock-db.js";

const lifecycleMocks = vi.hoisted(() => ({
  beginHardDelete: vi.fn(),
  purgeGraph: vi.fn(),
  archiveGraph: vi.fn(),
  reactivateGraph: vi.fn(),
}));

vi.mock("../services/issue-session-lifecycle.js", () => ({
  beginCompanyHardDeleteInTx: lifecycleMocks.beginHardDelete,
  purgeCompanySessionGraphInTx: lifecycleMocks.purgeGraph,
  archiveCompanySessionGraphInTx: lifecycleMocks.archiveGraph,
  reactivateCompanySessionGraphInTx: lifecycleMocks.reactivateGraph,
}));

vi.mock("../services/budgets.js", () => ({
  budgetService: () => ({
    getAgentMonthlyKnownSpend: async (_companyId: string, agentIds: string[]) =>
      new Map(agentIds.map((id) => [id, "0"])),
    getCompanyMonthlyKnownSpend: async (companyIds: string[]) =>
      new Map(companyIds.map((id) => [id, "0"])),
  }),
}));

vi.mock("../services/environments.js", () => ({
  environmentService: () => ({ ensureLocalEnvironment: vi.fn() }),
}));

vi.mock("../services/activity-log.js", () => ({ logActivity: vi.fn() }));

const companyId = "00000000-0000-4000-8000-000000000001";
const agentId = "00000000-0000-4000-8000-000000000002";

function callbackTransactionDb() {
  const transaction = vi.fn(async (callback: (tx: Db) => unknown) =>
    callback({} as Db));
  return { db: { transaction } as unknown as Db, transaction };
}

describe("cleanup removal services", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns an agent tombstone without issuing history deletes", async () => {
    const tombstone = {
      id: agentId,
      companyId,
      name: "CodexCoder",
      status: "terminated",
      reportsTo: null,
      instruction: null,
    };
    const harness = createMockDb({ select: [[tombstone], [tombstone]] });
    const committed = {
      tombstone,
      dispatchRefIds: [],
      cancellationRequests: null,
      suspensionRequests: null,
    };
    const transaction = vi.fn().mockResolvedValue(committed);
    (harness.db as unknown as { transaction: typeof transaction }).transaction = transaction;
    const postCommit = {
      actor: { kind: "system" },
      issueExecutionCancellation: {
        reconcileRequestedAgentCancellations: vi.fn(),
        reconcileRequestedAgentSuspensions: vi.fn(),
      },
      dispatchRef: vi.fn(),
    };

    const removed = await agentService(harness.db).terminate(
      agentId,
      postCommit as never,
    );

    expect(removed).toMatchObject({ id: agentId, status: "terminated" });
    expect(transaction).toHaveBeenCalledOnce();
    expect(harness.calls.some((call) => call.operation === "delete")).toBe(false);
    expect(postCommit.dispatchRef).not.toHaveBeenCalled();
  });

  it("completes a purge-ready company hard delete through the canonical graph owner", async () => {
    const { db, transaction } = callbackTransactionDb();
    lifecycleMocks.beginHardDelete.mockResolvedValue({
      operation: { id: "operation-1", generation: 3, status: "purge_ready" },
      intents: [],
    });
    lifecycleMocks.purgeGraph.mockResolvedValue({
      companyId,
      generation: 3,
      purged: true,
    });

    await expect(companyService(db).remove(companyId)).resolves.toEqual({
      companyId,
      generation: 3,
      purged: true,
      lifecycleOperationId: "operation-1",
      status: "completed",
      alreadyAbsent: false,
    });
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(lifecycleMocks.beginHardDelete).toHaveBeenCalledWith(
      expect.anything(),
      companyId,
      expect.any(String),
      { actor: { requestedByAgentId: null, requestedByUserId: null } },
    );
    expect(lifecycleMocks.purgeGraph).toHaveBeenCalledWith(expect.anything(), {
      companyId,
      lifecycleOperationId: "operation-1",
    });
  });

  it("returns the cancellation fence without purging while hard delete is waiting", async () => {
    const { db, transaction } = callbackTransactionDb();
    lifecycleMocks.beginHardDelete.mockResolvedValue({
      operation: { id: "operation-1", generation: 4, status: "waiting_for_cancellation" },
      intents: [{ id: "intent-1" }, { id: "intent-2" }],
    });

    await expect(companyService(db).remove(companyId)).resolves.toEqual({
      companyId,
      lifecycleOperationId: "operation-1",
      generation: 4,
      status: "waiting_for_cancellation",
      cancellationIntentCount: 2,
      purged: false,
      alreadyAbsent: false,
    });
    expect(transaction).toHaveBeenCalledOnce();
    expect(lifecycleMocks.purgeGraph).not.toHaveBeenCalled();
  });

  it("treats an already-absent company as an idempotent completed purge", async () => {
    const { db } = callbackTransactionDb();
    lifecycleMocks.beginHardDelete.mockResolvedValue(null);

    await expect(companyService(db).remove(companyId)).resolves.toEqual({
      companyId,
      lifecycleOperationId: null,
      generation: null,
      status: "completed",
      purged: true,
      alreadyAbsent: true,
    });
    expect(lifecycleMocks.purgeGraph).not.toHaveBeenCalled();
  });
});
