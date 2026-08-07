import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentService,
  terminateAgentToTombstoneInTransaction,
  type AgentLifecycleCancellationService,
} from "../services/agents.js";
import { createMockDb } from "./helpers/mock-db.js";

const dependencies = vi.hoisted(() => ({
  lockGraph: vi.fn(),
  terminalizeEdges: vi.fn(),
  logActivity: vi.fn(),
  monthlySpend: vi.fn(),
}));

vi.mock("../services/agent-org-graph-lock.js", async () => ({
  ...await vi.importActual<typeof import("../services/agent-org-graph-lock.js")>(
    "../services/agent-org-graph-lock.js",
  ),
  lockCompanyAgentGraph: dependencies.lockGraph,
}));

vi.mock("../services/system-escalation-postgres.js", async () => ({
  ...await vi.importActual<typeof import("../services/system-escalation-postgres.js")>(
    "../services/system-escalation-postgres.js",
  ),
  terminalizeAgentCreatorEdgesInTransaction: dependencies.terminalizeEdges,
}));

vi.mock("../services/activity-log.js", async () => ({
  ...await vi.importActual<typeof import("../services/activity-log.js")>(
    "../services/activity-log.js",
  ),
  logActivity: dependencies.logActivity,
}));

vi.mock("../services/budgets.js", async () => ({
  ...await vi.importActual<typeof import("../services/budgets.js")>(
    "../services/budgets.js",
  ),
  budgetService: () => ({
    getAgentMonthlyKnownSpend: dependencies.monthlySpend,
  }),
}));

const companyId = "00000000-0000-4000-8000-000000000001";
const targetId = "00000000-0000-4000-8000-000000000010";
const childId = "00000000-0000-4000-8000-000000000011";
const grandchildId = "00000000-0000-4000-8000-000000000012";
const terminatedId = "00000000-0000-4000-8000-000000000013";
const unrelatedId = "00000000-0000-4000-8000-000000000014";
const now = new Date("2026-07-30T18:00:00.000Z");

function agent(id: string, input: {
  status?: string;
  reportsTo?: string | null;
  name?: string;
} = {}) {
  return {
    id,
    companyId,
    name: input.name ?? id,
    status: input.status ?? "active",
    reportsTo: input.reportsTo ?? null,
  } as never;
}

const target = agent(targetId, { name: "Target manager" });
const child = agent(childId, { status: "error", reportsTo: targetId });
const grandchild = agent(grandchildId, { status: "running", reportsTo: childId });
const terminated = agent(terminatedId, {
  status: "terminated",
  reportsTo: grandchildId,
});
const unrelated = agent(unrelatedId);
const graph = [target, child, grandchild, terminated, unrelated];
const tombstone = {
  ...target,
  status: "terminated",
  updatedAt: now,
};

function cancellationRecorder() {
  const cancel = vi.fn(async (_tx, input) => ({
    companyId: input.companyId,
    agentIds: input.agentIds,
    reason: input.reason,
    fence: { refIds: ["cancelled-ref"], correlationIds: [] },
    requests: [{ runId: "cancelled-run" }],
  }));
  const suspend = vi.fn(async (_tx, input) => ({
    companyId: input.companyId,
    agentIds: input.agentIds,
    reason: input.reason,
    fence: { refIds: ["suspended-ref"], correlationIds: [] },
    requests: [{ runId: "suspended-run" }],
  }));
  const reconcileCancel = vi.fn(async () => undefined);
  const reconcileSuspend = vi.fn(async () => undefined);
  return {
    cancel,
    suspend,
    reconcileCancel,
    reconcileSuspend,
    service: {
      requestAgentCancellationsInTransaction: cancel,
      reconcileRequestedAgentCancellations: reconcileCancel,
      requestAgentSuspensionsInTransaction: suspend,
      reconcileRequestedAgentSuspensions: reconcileSuspend,
    } as AgentLifecycleCancellationService,
  };
}

function setValues(calls: ReturnType<typeof createMockDb>["calls"]) {
  return calls
    .filter((call) => call.operation === "update" && call.method === "set")
    .map((call) => call.args[0] as Record<string, unknown>);
}

describe("canonical agent termination lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dependencies.lockGraph.mockResolvedValue({ company: { id: companyId }, agents: graph });
    dependencies.terminalizeEdges.mockResolvedValue([
      { dispatchRefId: "creator-ref" },
      { dispatchRefId: null },
    ]);
    dependencies.logActivity.mockResolvedValue(undefined);
    dependencies.monthlySpend.mockResolvedValue(new Map([[targetId, "0.00"]]));
  });

  it("tombstones only the target, pauses live descendants, and fences the subtree", async () => {
    const harness = createMockDb({
      update: [[tombstone], [{ id: childId }, { id: grandchildId }]],
      select: [[]],
    });
    const cancellation = cancellationRecorder();

    const committed = await terminateAgentToTombstoneInTransaction(
      harness.db as never,
      {
        companyId,
        agentId: targetId,
        sourceId: `agent-termination:${targetId}`,
        actor: { kind: "system" },
        now,
      },
      cancellation.service,
    );

    expect(committed).toMatchObject({
      tombstone,
      dispatchRefIds: ["creator-ref"],
    });
    expect(setValues(harness.calls)).toEqual([
      expect.objectContaining({ status: "terminated", pauseReason: null, errorReason: null }),
      expect.objectContaining({ status: "paused", pauseReason: "system", errorReason: null }),
    ]);
    expect(cancellation.cancel).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      companyId,
      agentIds: [targetId],
    }));
    expect(cancellation.suspend).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      companyId,
      agentIds: [childId, grandchildId],
    }));
    expect(dependencies.terminalizeEdges).toHaveBeenCalledTimes(1);
    expect(dependencies.logActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "agent.terminated",
      details: expect.objectContaining({
        descendantPausedAgentIds: [childId, grandchildId],
      }),
    }));
    expect(harness.remaining("select")).toBe(0);
  });

  it("is idempotent for an already-terminated target", async () => {
    const alreadyTerminated = agent(targetId, { status: "terminated" });
    dependencies.lockGraph.mockResolvedValue({
      company: { id: companyId },
      agents: [alreadyTerminated],
    });
    const harness = createMockDb();
    const cancellation = cancellationRecorder();

    await expect(terminateAgentToTombstoneInTransaction(
      harness.db as never,
      {
        companyId,
        agentId: targetId,
        sourceId: `agent-termination:${targetId}`,
        actor: { kind: "system" },
        now,
      },
      cancellation.service,
    )).resolves.toMatchObject({ tombstone: alreadyTerminated });

    expect(harness.calls).toHaveLength(0);
    expect(cancellation.cancel).not.toHaveBeenCalled();
    expect(dependencies.terminalizeEdges).not.toHaveBeenCalled();
  });

  it("fails closed when the locked descendant pause transition is incomplete", async () => {
    const harness = createMockDb({
      update: [[tombstone], [{ id: childId }]],
    });
    const cancellation = cancellationRecorder();

    await expect(terminateAgentToTombstoneInTransaction(
      harness.db as never,
      {
        companyId,
        agentId: targetId,
        sourceId: `agent-termination:${targetId}`,
        actor: { kind: "system" },
        now,
      },
      cancellation.service,
    )).rejects.toMatchObject({ status: 409 });

    expect(cancellation.cancel).not.toHaveBeenCalled();
    expect(dependencies.terminalizeEdges).not.toHaveBeenCalled();
    expect(dependencies.logActivity).not.toHaveBeenCalled();
  });

  it("reconciles committed fences and dispatches creator work after commit", async () => {
    const harness = createMockDb({
      select: [
        [{ companyId }],
        [],
        [tombstone],
        [tombstone],
      ],
      update: [[tombstone], [{ id: childId }, { id: grandchildId }]],
    });
    const cancellation = cancellationRecorder();
    const dispatchRef = vi.fn(async () => undefined);

    const result = await agentService(harness.db).terminate(targetId, {
      actor: { kind: "system" },
      issueExecutionCancellation: cancellation.service,
      dispatchRef,
    });

    expect(result).toMatchObject({ id: targetId, status: "terminated" });
    expect(cancellation.reconcileCancel).toHaveBeenCalledTimes(1);
    expect(cancellation.reconcileSuspend).toHaveBeenCalledTimes(1);
    expect(dispatchRef).toHaveBeenCalledWith("creator-ref");
    expect(dependencies.monthlySpend).toHaveBeenCalledWith(companyId, [targetId]);
    expect(harness.remaining("select")).toBe(0);
  });
});
