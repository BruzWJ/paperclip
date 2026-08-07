import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOrdinaryIssueRuntime,
  OrdinaryIssueRuntimeRejected,
} from "../services/ordinary-issue-runtime.js";
import { InvokableIssueOwnerRejected } from "../services/agent-invokability.js";
import { createMockDb } from "./helpers/mock-db.js";

const mocks = vi.hoisted(() => ({
  resolveOwner: vi.fn(),
  admitExecutionSource: vi.fn(),
  persistAggregate: vi.fn(),
  createIssueFormCommitRuntime: vi.fn(() => ({})),
}));

vi.mock("../services/agent-invokability.js", async (importActual) => ({
  ...(await importActual<typeof import("../services/agent-invokability.js")>()),
  resolveInvokableIssueOwnerInTransaction: mocks.resolveOwner,
}));

vi.mock("../services/issue-session/admission.js", async (importActual) => ({
  ...(await importActual<typeof import("../services/issue-session/admission.js")>()),
  createIssueSessionAdmissionService: vi.fn(() => ({
    admitExecutionSource: mocks.admitExecutionSource,
  })),
}));

vi.mock("../services/canonical-issue-aggregate.js", async (importActual) => ({
  ...(await importActual<typeof import("../services/canonical-issue-aggregate.js")>()),
  persistCanonicalIssueAggregateInTx: mocks.persistAggregate,
}));

vi.mock("../services/runtime-issue-action-port.js", async (importActual) => ({
  ...(await importActual<typeof import("../services/runtime-issue-action-port.js")>()),
  createIssueFormCommitRuntime: mocks.createIssueFormCommitRuntime,
}));

const companyId = "00000000-0000-4000-8000-000000000201";
const ownerAgentId = "00000000-0000-4000-8000-000000000202";
const revisionId = "00000000-0000-4000-8000-000000000203";
const issueId = "00000000-0000-4000-8000-000000000204";
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
  issueCounter: 4,
  issuePrefix: "ORD",
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
  adapterType: "codex",
  implementationIdentity: "codex/default",
  implementationAvailable: true,
};

const ref = {
  id: refId,
  companyId,
  issueId,
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
    issueExecutionRunService: {
      requestSteeringInTransaction: vi.fn(),
      continuePendingSteeringForSource: vi.fn(),
    },
    issueExecutionCancellation: {
      requestScopeCancellationsInTransaction: vi.fn(),
      reconcileRequestedScopeCancellations: vi.fn(),
    },
  };
}

function createInput(overrides: Record<string, unknown> = {}) {
  return {
    issueId,
    companyId,
    request: "Preserve these exact bytes.\n",
    ownerAgentId,
    creator: { kind: "user/board" as const, userId: "board-user" },
    idempotencyKey: "ordinary-create-1",
    title: "Canonical ordinary issue",
    ...overrides,
  };
}

function freshCreateDb() {
  return createMockDb({
    execute: [[], []],
    select: [
      [],
      [company],
      [{ value: 2 }],
    ],
    update: [[]],
  });
}

describe("ordinary issue runtime ingress", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveOwner.mockResolvedValue({ owner, revision, revisionId });
    mocks.persistAggregate.mockResolvedValue({
      issue: {
        id: issueId,
        companyId,
        title: "Canonical ordinary issue",
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
    const harness = freshCreateDb();
    const dispatchRef = vi.fn(async () => undefined);
    mocks.resolveOwner.mockRejectedValueOnce(
      new InvokableIssueOwnerRejected(
        "Owner has no selected adapter revision",
        "owner_revision_missing",
      ),
    );
    const runtime = createOrdinaryIssueRuntime(
      harness.db,
      options(dispatchRef),
    );

    await expect(runtime.create(createInput())).rejects.toMatchObject<
      Partial<OrdinaryIssueRuntimeRejected>
    >({
      code: "ordinary_issue_runtime_rejected",
      reason: "owner_revision_missing",
    });
    expect(mocks.persistAggregate).not.toHaveBeenCalled();
    expect(mocks.admitExecutionSource).not.toHaveBeenCalled();
    expect(dispatchRef).not.toHaveBeenCalled();
    expect(harness.calls.some((call) => call.operation === "insert")).toBe(false);
  });

  it("persists exact immutable input and dispatches only the admitted stored ref", async () => {
    const harness = freshCreateDb();
    const dispatchRef = vi.fn(async () => undefined);
    const correlate = vi.fn(async () => undefined);
    const runtime = createOrdinaryIssueRuntime(
      harness.db,
      options(dispatchRef),
    );

    const result = await runtime.create(createInput({
      priority: "high",
      originKind: "manual",
      contextAccessMask: { read_issue_comments: false },
      correlate,
    }));

    expect(result).toMatchObject({
      issue: { id: issueId, request: "Preserve these exact bytes.\n" },
      sessionId: expect.any(String),
      authorityId: expect.any(String),
      ref: { id: refId },
      retried: false,
    });
    const aggregateInput = mocks.persistAggregate.mock.calls[0]?.[1];
    expect(aggregateInput).toMatchObject({
      issue: {
        id: issueId,
        companyId,
        title: "Canonical ordinary issue",
        request: "Preserve these exact bytes.\n",
        priority: "high",
        ownerKind: "agent",
        ownerAgentId,
        ownershipEpoch: 1,
        creatorKind: "user/board",
        creatorUserId: "board-user",
        originKind: "manual",
      },
      authority: {
        agentId: ownerAgentId,
        auditAdapterConfigRevisionId: revisionId,
      },
      idempotency: {
        key: `ordinary-issue-create:${companyId}:ordinary-create-1`,
      },
    });
    expect(mocks.admitExecutionSource).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId,
        issueId,
        targetAgentId: ownerAgentId,
        adapterConfigRevisionId: revisionId,
        contextEpoch: 1,
        mode: "owner",
        sourceKind: "issue_request",
        actor: { kind: "user/board", userId: "board-user" },
        exactText: "Preserve these exact bytes.\n",
        comment: {
          author: { kind: "user", userId: "board-user" },
          producingRun: null,
        },
      }),
      harness.db,
    );
    expect(correlate).toHaveBeenCalledWith(
      harness.db,
      expect.objectContaining({
        issue: expect.objectContaining({ id: issueId }),
        ref,
      }),
    );
    expect(dispatchRef).toHaveBeenCalledTimes(1);
    expect(dispatchRef).toHaveBeenCalledWith(refId);
  });

  it("replays an accepted immutable identity without rebuilding canonical records", async () => {
    const existing = {
      id: issueId,
      companyId,
      title: "Canonical ordinary issue",
      request: "Preserve these exact bytes.\n",
      ownerAgentId,
      projectId: null,
      projectWorkspaceId: null,
      executionWorkspacePreference: null,
      executionWorkspaceSettings: null,
      goalId: null,
      parentId: null,
      priority: "medium",
      responsibleUserId: null,
      originKind: "manual",
      originId: null,
      originRunId: null,
      originFingerprint: `ordinary-issue-create:${companyId}:ordinary-create-1`,
      billingCode: null,
      contextAccessMask: null,
      creatorKind: "user/board",
      creatorUserId: "board-user",
    };
    const harness = createMockDb({
      execute: [[]],
      select: [
        [{ issue: existing }],
        [],
        [{ id: sessionId }],
        [{ id: authorityId }],
        [ref],
      ],
    });
    const dispatchRef = vi.fn(async () => undefined);
    const runtime = createOrdinaryIssueRuntime(
      harness.db,
      options(dispatchRef),
    );

    await expect(runtime.create(createInput())).resolves.toMatchObject({
      issue: existing,
      sessionId,
      authorityId,
      ref,
      retried: true,
    });
    expect(mocks.resolveOwner).not.toHaveBeenCalled();
    expect(mocks.persistAggregate).not.toHaveBeenCalled();
    expect(mocks.admitExecutionSource).not.toHaveBeenCalled();
    expect(dispatchRef).toHaveBeenCalledWith(refId);
  });

  it("rejects immutable idempotency drift without dispatching", async () => {
    const existing = {
      id: issueId,
      request: "Different bytes",
      ownerAgentId,
      title: "Canonical ordinary issue",
      projectId: null,
      projectWorkspaceId: null,
      executionWorkspacePreference: null,
      executionWorkspaceSettings: null,
      goalId: null,
      parentId: null,
      priority: "medium",
      responsibleUserId: null,
      originKind: "manual",
      originId: null,
      originRunId: null,
      originFingerprint: `ordinary-issue-create:${companyId}:ordinary-create-1`,
      billingCode: null,
      contextAccessMask: null,
      creatorKind: "user/board",
      creatorUserId: "board-user",
    };
    const harness = createMockDb({
      execute: [[]],
      select: [[{ issue: existing }], []],
    });
    const dispatchRef = vi.fn(async () => undefined);
    const runtime = createOrdinaryIssueRuntime(
      harness.db,
      options(dispatchRef),
    );

    await expect(runtime.create(createInput())).rejects.toMatchObject({
      reason: "create_idempotency_conflict",
    });
    expect(dispatchRef).not.toHaveBeenCalled();
  });

  it("validates execution-workspace intent before opening a transaction", async () => {
    const harness = createMockDb();
    const runtime = createOrdinaryIssueRuntime(harness.db, options());

    await expect(runtime.create(createInput({
      executionWorkspaceId: randomUUID(),
    }))).rejects.toMatchObject({
      reason: "execution_workspace_preference_invalid",
    });
    await expect(runtime.create(createInput({
      executionWorkspacePreference: "reuse_existing",
    }))).rejects.toMatchObject({
      reason: "execution_workspace_missing",
    });
    expect(harness.calls).toEqual([]);
  });
});
