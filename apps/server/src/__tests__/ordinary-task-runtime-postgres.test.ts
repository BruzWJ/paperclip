import { beforeEach, describe, expect, it, vi } from "vitest";
import { createOrdinaryTaskRuntime, OrdinaryTaskRuntimeRejected } from "../services/ordinary-task-runtime.js";
import { InvokableTaskOwnerRejected } from "../services/agent-invokability.js";
import { createMockDb } from "./helpers/mock-db.js";

const mocks = vi.hoisted(() => ({
  resolveOwner: vi.fn(),
  admitExecutionSource: vi.fn(),
  admitExecutionSourceBatch: vi.fn(),
  persistAggregate: vi.fn(),
  createTaskFormCommitRuntime: vi.fn(() => ({})),
}));

vi.mock("../services/agent-invokability.js", async (importActual) => ({
  ...(await importActual<typeof import("../services/agent-invokability.js")>()),
  resolveInvokableTaskOwnerInTransaction: mocks.resolveOwner,
}));

vi.mock("../services/task-session/admission.js", async (importActual) => ({
  ...(await importActual<typeof import("../services/task-session/admission.js")>()),
  createTaskSessionAdmissionService: vi.fn(() => ({
    admitExecutionSource: mocks.admitExecutionSource,
    admitExecutionSourceBatch: mocks.admitExecutionSourceBatch,
  })),
}));

vi.mock("../services/canonical-task-aggregate.js", async (importActual) => ({
  ...(await importActual<typeof import("../services/canonical-task-aggregate.js")>()),
  persistCanonicalTaskAggregateInTx: mocks.persistAggregate,
}));

vi.mock("../services/runtime-task-action-port.js", async (importActual) => ({
  ...(await importActual<typeof import("../services/runtime-task-action-port.js")>()),
  createTaskFormCommitRuntime: mocks.createTaskFormCommitRuntime,
}));

const companyId = "00000000-0000-4000-8000-000000000201";
const ownerAgentId = "00000000-0000-4000-8000-000000000202";
const revisionId = "00000000-0000-4000-8000-000000000203";
const taskId = "458fef70-be95-597d-80a1-b3d6c0f2d1a0";
const sessionId = "00000000-0000-4000-8000-000000000205";
const authorityId = "00000000-0000-4000-8000-000000000206";
const refId = "00000000-0000-4000-8000-000000000207";
const now = new Date("2026-07-25T19:30:00.000Z");

const company = {
  id: companyId,
  status: "active",
  sessionIntegrityState: "ready",
  sessionIntegrityReadyAt: now,
  hardDeleteFencedAt: null,
  taskCounter: 4,
  taskPrefix: "ORD",
};

const owner = {
  id: ownerAgentId,
  companyId,
  name: "Configured owner",
  status: "idle",
  currentAdapterConfigRevisionId: revisionId,
};

const revision = {
  id: revisionId,
  companyId,
  agentId: ownerAgentId,
};

const ref = {
  id: refId,
  companyId,
  taskId,
  sessionId,
  ownershipEpoch: 1,
  targetAgentId: ownerAgentId,
  adapterConfigRevisionId: revisionId,
  exactMessage: "Preserve these exact bytes.\n",
};

function options(dispatchRef = vi.fn(async () => undefined)) {
  return {
    clock: () => now,
    dispatchRef,
    taskExecutionCancellation: {
      requestScopeCancellationsInTransaction: vi.fn(),
      reconcileRequestedCancellations: vi.fn(),
    },
  };
}

function createInput(overrides: Record<string, unknown> = {}) {
  return {
    taskId,
    companyId,
    request: "Preserve these exact bytes.\n",
    ownerAgentId,
    creator: { kind: "user/board" as const, userId: "board-user" },
    idempotencyKey: "ordinary-create-1",
    title: "Canonical ordinary task",
    ...overrides,
  };
}

function freshCreateDb(instruction: string | null = null) {
  return createMockDb({
    execute: [[], []],
    select: [
      [],
      [company],
      [{ instruction }],
      [{ companyId, ownerKind: "agent", ownerAgentId, ownershipEpoch: 1, executionPolicy: null }],
      [{ id: "00000000-0000-4000-8000-000000000209" }],
      [],
      [{ nextOrdinal: 0 }],
      [],
    ],
    update: [[{ taskNumber: 5, taskPrefix: "ORD" }]],
  });
}

describe("ordinary task runtime ingress", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveOwner.mockResolvedValue({ owner, revision, revisionId });
    mocks.persistAggregate.mockResolvedValue({
      task: {
        id: taskId,
        companyId,
        title: "Canonical ordinary task",
        request: "Preserve these exact bytes.\n",
        ownerKind: "agent",
        ownerAgentId,
        ownershipEpoch: 1,
      },
      sessionRoot: { contextEpoch: { generation: 1 } },
    });
    mocks.admitExecutionSource.mockResolvedValue({ ref });
  });

  it("rejects an owner with no selected adapter revision before persisting the aggregate", async () => {
    const harness = createMockDb({
      execute: [[], []],
      select: [[], [company]],
    });
    const dispatchRef = vi.fn(async () => undefined);
    mocks.resolveOwner.mockRejectedValueOnce(
      new InvokableTaskOwnerRejected("Owner has no selected adapter revision", "owner_revision_missing"),
    );
    const runtime = createOrdinaryTaskRuntime(harness.db, options(dispatchRef));

    await expect(runtime.create(createInput())).rejects.toMatchObject<Partial<OrdinaryTaskRuntimeRejected>>({
      code: "ordinary_task_runtime_rejected",
      reason: "owner_revision_missing",
    });
    expect(mocks.persistAggregate).not.toHaveBeenCalled();
    expect(mocks.admitExecutionSource).not.toHaveBeenCalled();
    expect(dispatchRef).not.toHaveBeenCalled();
    expect(harness.calls.some((call) => call.operation === "insert")).toBe(false);
    expect(harness.remaining("select")).toBe(0);
    expect(harness.remaining("update")).toBe(0);
  });

  it("persists exact immutable input and dispatches only the admitted stored ref", async () => {
    const harness = freshCreateDb();
    const dispatchRef = vi.fn(async () => undefined);
    const correlate = vi.fn(async () => undefined);
    const runtime = createOrdinaryTaskRuntime(harness.db, options(dispatchRef));

    const result = await runtime.create(
      createInput({
        priority: "high",
        originKind: "manual",
        correlate,
      }),
    );

    expect(result).toMatchObject({
      task: { id: taskId, request: "Preserve these exact bytes.\n" },
      sessionId: expect.any(String),
      authorityId: expect.any(String),
      ref: { id: refId },
      retried: false,
    });
    const aggregateInput = mocks.persistAggregate.mock.calls[0]?.[1];
    expect(aggregateInput).toMatchObject({
      task: {
        id: taskId,
        companyId,
        title: "Canonical ordinary task",
        request: "Preserve these exact bytes.\n",
        priority: "high",
        ownerKind: "agent",
        ownerAgentId,
        ownershipEpoch: 1,
        creatorKind: "user/board",
        creatorUserId: "board-user",
        taskNumber: 5,
        identifier: "ORD-5",
        originKind: "manual",
      },
      authority: {
        agentId: ownerAgentId,
        auditAdapterConfigRevisionId: revisionId,
      },
      idempotency: {
        key: `ordinary-task-create:${companyId}:ordinary-create-1`,
      },
    });
    expect(mocks.admitExecutionSource).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId,
        taskId,
        targetAgentId: ownerAgentId,
        adapterConfigRevisionId: revisionId,
        contextEpoch: 1,
        mode: "owner",
        sourceKind: "task_request",
        actor: { kind: "user/board", userId: "board-user" },
        exactText: "Preserve these exact bytes.\n",
        comment: {
          author: { kind: "user", userId: "board-user" },
          producingRun: null,
          body: "Preserve these exact bytes.\n",
        },
      }),
      harness.db,
    );
    expect(correlate).toHaveBeenCalledWith(
      harness.db,
      expect.objectContaining({
        task: expect.objectContaining({ id: taskId }),
        ref,
      }),
    );
    expect(dispatchRef).toHaveBeenCalledTimes(1);
    expect(dispatchRef).toHaveBeenCalledWith(refId);
  });

  it("prepends an instructed owner through the ordinary execution queue", async () => {
    const bootstrapRef = { ...ref, id: "00000000-0000-4000-8000-000000000208" };
    mocks.resolveOwner.mockResolvedValueOnce({
      owner: { ...owner, instruction: "You are the engineering lead." },
      revision,
      revisionId,
    });
    mocks.admitExecutionSourceBatch.mockResolvedValueOnce([{ ref: bootstrapRef }, { ref }]);
    const dispatchRef = vi.fn(async () => undefined);
    const harness = freshCreateDb("You are the engineering lead.");

    await createOrdinaryTaskRuntime(harness.db, options(dispatchRef)).create(createInput());

    expect(mocks.admitExecutionSource).not.toHaveBeenCalled();
    expect(mocks.admitExecutionSourceBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        sources: [
          expect.objectContaining({
            sourceKind: "task_request",
            actor: {
              kind: "system",
              sourceKind: "task_request",
              sourceId: taskId,
            },
            sourceRecordId: taskId,
            exactText:
              "You are the engineering lead.\n\nThis is your role bootstrap turn, not task work. Do not inspect the filesystem, workspace, repository, home directory, environment, global configuration, or provider configuration, and do not use provider-local tools. If you need organizational or company context, use only the Paperclip-managed tools available in this turn. Briefly acknowledge the role and end the turn; the work message will arrive as a separate queued turn.",
          }),
          expect.objectContaining({
            sourceKind: "task_request",
            exactText: "Preserve these exact bytes.\n",
          }),
        ],
      }),
      harness.db,
    );
    expect(dispatchRef).toHaveBeenCalledWith(refId);
  });

  it("replays an accepted immutable identity without rebuilding canonical records", async () => {
    const existing = {
      id: taskId,
      companyId,
      title: "Canonical ordinary task",
      request: "Preserve these exact bytes.\n",
      ownerAgentId,
      projectId: null,
      goalId: null,
      parentId: null,
      priority: "medium",
      responsibleUserId: null,
      originKind: "manual",
      originId: null,
      originRunId: null,
      originFingerprint: `ordinary-task-create:${companyId}:ordinary-create-1`,
      billingCode: null,
      creatorKind: "user/board",
      creatorUserId: "board-user",
    };
    const harness = createMockDb({
      execute: [[]],
      select: [[{ task: existing }], [{ id: sessionId }], [{ id: authorityId }], [ref]],
    });
    const dispatchRef = vi.fn(async () => undefined);
    const runtime = createOrdinaryTaskRuntime(harness.db, options(dispatchRef));

    await expect(runtime.create(createInput())).resolves.toMatchObject({
      task: existing,
      sessionId,
      authorityId,
      ref,
      retried: true,
    });
    expect(mocks.resolveOwner).not.toHaveBeenCalled();
    expect(mocks.persistAggregate).not.toHaveBeenCalled();
    expect(mocks.admitExecutionSource).not.toHaveBeenCalled();
    expect(dispatchRef).toHaveBeenCalledWith(refId);
    expect(harness.remaining("select")).toBe(0);
  });

  it("rejects immutable idempotency drift without dispatching", async () => {
    const existing = {
      id: taskId,
      request: "Different bytes",
      ownerAgentId,
      title: "Canonical ordinary task",
      projectId: null,
      goalId: null,
      parentId: null,
      priority: "medium",
      responsibleUserId: null,
      originKind: "manual",
      originId: null,
      originRunId: null,
      originFingerprint: `ordinary-task-create:${companyId}:ordinary-create-1`,
      billingCode: null,
      creatorKind: "user/board",
      creatorUserId: "board-user",
    };
    const harness = createMockDb({
      execute: [[]],
      select: [[{ task: existing }]],
    });
    const dispatchRef = vi.fn(async () => undefined);
    const runtime = createOrdinaryTaskRuntime(harness.db, options(dispatchRef));

    await expect(runtime.create(createInput())).rejects.toMatchObject({
      reason: "create_idempotency_conflict",
    });
    expect(dispatchRef).not.toHaveBeenCalled();
    expect(harness.remaining("select")).toBe(0);
  });
});
