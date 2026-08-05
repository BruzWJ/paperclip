import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockDb, type MockDbHarness } from "./helpers/mock-db.js";

const mocks = vi.hoisted(() => ({
  sessions: {
    admitExecutionSource: vi.fn(),
    admitSteeringComment: vi.fn(),
    appendNonDispatchUserComment: vi.fn(),
  },
  issueForms: {
    commitOwnerFormUpdate: vi.fn(),
    commitCreatorFormUpdate: vi.fn(),
  },
  resolveInvokableOwner: vi.fn(),
  recordLiveness: vi.fn(),
  dispatchRef: vi.fn(),
  notifyCreatorDelivery: vi.fn(),
  requestSteering: vi.fn(),
  continueSteering: vi.fn(),
  requestCancellations: vi.fn(),
  reconcileCancellations: vi.fn(),
}));

vi.mock("../services/issue-session/admission.js", async (importActual) => {
  const actual = await importActual<
    typeof import("../services/issue-session/admission.js")
  >();
  return {
    ...actual,
    createIssueSessionAdmissionService: vi.fn(() => mocks.sessions),
  };
});

vi.mock("../services/runtime-issue-action-port.js", async (importActual) => {
  const actual = await importActual<
    typeof import("../services/runtime-issue-action-port.js")
  >();
  return {
    ...actual,
    createIssueFormCommitRuntime: vi.fn(() => mocks.issueForms),
  };
});

vi.mock("../services/agent-invokability.js", async (importActual) => {
  const actual = await importActual<
    typeof import("../services/agent-invokability.js")
  >();
  return {
    ...actual,
    resolveInvokableIssueOwnerInTransaction: mocks.resolveInvokableOwner,
  };
});

vi.mock(
  "../services/issue-liveness-reconciliation.js",
  async (importActual) => {
    const actual = await importActual<
      typeof import("../services/issue-liveness-reconciliation.js")
    >();
    return {
      ...actual,
      recordIssueLivenessActionInTransaction: mocks.recordLiveness,
    };
  },
);

import {
  createOrdinaryIssueRuntime,
  OrdinaryIssueRuntimeRejected,
} from "../services/ordinary-issue-runtime.js";
import {
  RuntimeIssueActionDenied,
} from "../services/runtime-issue-action-port.js";

const COMPANY_ID = "company-1";
const ISSUE_ID = "issue-1";
const NOW = new Date("2026-07-25T20:00:00.000Z");

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function identityDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function createRuntime(harness: MockDbHarness) {
  return createOrdinaryIssueRuntime(harness.db, {
    clock: () => NOW,
    issueExecutionRunService: {
      requestSteeringInTransaction: mocks.requestSteering,
      continuePendingSteeringForSource: mocks.continueSteering,
    },
    issueExecutionCancellation: {
      requestScopeCancellationsInTransaction: mocks.requestCancellations,
      reconcileRequestedScopeCancellations: mocks.reconcileCancellations,
    },
    dispatchRef: mocks.dispatchRef,
    notifyCreatorDelivery: mocks.notifyCreatorDelivery,
  });
}

function sessionState() {
  return {
    session: {
      id: "ses_issue_1",
      companyId: COMPANY_ID,
      issueId: ISSUE_ID,
      integrityState: "ready",
      timeArchived: null,
      purgeFencedAt: null,
    },
    contextGeneration: 3,
  };
}

beforeEach(() => {
  for (const candidate of Object.values(mocks)) {
    if (typeof candidate === "function" && "mockReset" in candidate) {
      candidate.mockReset();
    }
  }
  for (const candidate of Object.values(mocks.sessions)) candidate.mockReset();
  for (const candidate of Object.values(mocks.issueForms)) candidate.mockReset();
  mocks.resolveInvokableOwner.mockResolvedValue({
    revisionId: "revision-owner",
  });
  mocks.recordLiveness.mockResolvedValue(undefined);
  mocks.dispatchRef.mockResolvedValue(undefined);
  mocks.notifyCreatorDelivery.mockResolvedValue(undefined);
  mocks.requestSteering.mockResolvedValue(undefined);
  mocks.continueSteering.mockResolvedValue(undefined);
  mocks.requestCancellations.mockResolvedValue(null);
  mocks.reconcileCancellations.mockResolvedValue(undefined);
});

describe("ordinary issue board mutations without a database", () => {
  it("replays one accepted agent reopen from its exact persisted ref", async () => {
    const input = {
      companyId: COMPANY_ID,
      issueId: ISSUE_ID,
      actorUserId: "board-user",
      reason: "  Re-open with these exact bytes.  ",
      idempotencyKey: "reopen-key-1",
    };
    const command = {
      id: "reopen-command-1",
      companyId: COMPANY_ID,
      issueId: ISSUE_ID,
      actorUserId: input.actorUserId,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
      identityDigest: identityDigest({
        contract: "ordinary-board-reopen/v2",
        companyId: COMPANY_ID,
        issueId: ISSUE_ID,
        actorUserId: input.actorUserId,
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
      }),
      priorStatus: "done",
      priorDisposition: { message: "done" },
      ownershipEpoch: 1,
      branch: "agent_execution",
      preservedOwnerKind: "agent",
      continuityFenceGeneration: 2,
      creatorEdgeId: "edge-1",
      executionRefId: "ref-reopen-1",
      systemEscalationIdentityId: null,
      createdAt: NOW,
    };
    const issue = {
      id: ISSUE_ID,
      companyId: COMPANY_ID,
      request: "  Preserve the original issue request.  ",
    };
    const edge = { id: "edge-1", companyId: COMPANY_ID };
    const ref = {
      id: command.executionRefId,
      companyId: COMPANY_ID,
      issueId: ISSUE_ID,
      sessionId: "ses_issue_1",
      ownershipEpoch: 1,
      previousOwnershipEpoch: null,
      executionScopeId: "scope-1",
      executionLineageId: "lineage-1",
      mode: "owner",
      sourceKind: "issue_reopen",
      sourceId: command.id,
      sourceRecordId: command.id,
      messageKind: "input",
      sourceMessageId: "message-1",
      exactMessage: issue.request,
      deliveryIdempotencyKey:
        `board-reopen:${COMPANY_ID}:${input.idempotencyKey}`,
      targetAgentId: "owner-agent",
      laneOrdinal: 1,
      issueExecutionAuthorityId: "authority-owner",
      consultExecutionId: null,
      adapterConfigRevisionId: "revision-owner",
      contextEpoch: 3,
      historyViewId: null,
      admissionHighWaterSeq: 4,
      inputId: "input-1",
      admittedSeq: 4,
      promotedSeq: null,
      counterpartIssueId: null,
      counterpartAuthorityId: null,
      counterpartOwnershipEpoch: null,
      consultCallerRefId: null,
      consultChainToken: null,
      disposition: "pending",
    };
    const harness = createMockDb({
      execute: [[]],
      select: [
        [{ id: input.actorUserId }],
        [command],
        [issue],
        [edge],
        [ref],
      ],
    });

    const result = await createRuntime(harness).boardReopen(input);

    expect(result).toMatchObject({
      issue,
      edge,
      command,
      retried: true,
      dispatch: {
        kind: "agent_execution",
        executionRef: { id: ref.id, exactMessage: issue.request },
      },
    });
    expect(mocks.dispatchRef).toHaveBeenCalledOnce();
    expect(mocks.dispatchRef).toHaveBeenCalledWith(ref.id);
    expect(harness.remaining("select")).toBe(0);
  });

  it("fences the terminal epoch before admitting the one fresh reopen ref", async () => {
    const ownerAgentId = "owner-agent";
    const session = sessionState();
    const issue = {
      id: ISSUE_ID,
      companyId: COMPANY_ID,
      request: "Resume from one fresh board command.",
      lifecycleStatus: "done",
      disposition: { message: "Previously completed" },
      ownershipEpoch: 1,
      ownerKind: "agent",
      ownerAgentId,
      ownerUserId: null,
      ownerAssignmentSource: null,
      creatorKind: "user/board",
      creatorUserId: "creator-user",
    };
    const reopened = {
      ...issue,
      lifecycleStatus: "open",
      disposition: null,
    };
    const edge = {
      id: "edge-1",
      companyId: COMPANY_ID,
      issueId: ISSUE_ID,
      ownershipEpoch: 1,
      creatorKind: "user/board",
      endpointKind: "user/board",
      endpointId: "creator-user",
      state: "receivable",
    };
    const authority = {
      id: "authority-owner",
      companyId: COMPANY_ID,
      issueId: ISSUE_ID,
      sessionId: session.session.id,
      ownershipEpoch: 1,
      agentId: ownerAgentId,
      state: "current",
    };
    const ref = {
      id: "ref-reopen-fresh",
      companyId: COMPANY_ID,
      issueId: ISSUE_ID,
      sessionId: session.session.id,
      ownershipEpoch: 1,
      mode: "owner",
      sourceKind: "issue_reopen",
      exactMessage: issue.request,
      targetAgentId: ownerAgentId,
      issueExecutionAuthorityId: authority.id,
      disposition: "active",
    };
    const command = {
      id: "reopen-command-fresh",
      companyId: COMPANY_ID,
      issueId: ISSUE_ID,
    };
    const cancellations = {
      companyId: COMPANY_ID,
      issueId: ISSUE_ID,
      selector: { kind: "ownership_epoch", ownershipEpoch: 1 },
      reason: "board_reopen_continuity_fence",
      fence: { refIds: ["ref-stale"], deliveryIds: [], correlationIds: [] },
      requests: [],
    };
    mocks.sessions.admitExecutionSource.mockResolvedValue({ ref });
    mocks.requestCancellations.mockResolvedValue(cancellations);
    const harness = createMockDb({
      execute: [[]],
      select: [
        [{ id: "board-user" }],
        [],
        [issue],
        [session],
        [edge],
        [authority],
        [],
        [],
        [],
      ],
      update: [[], [reopened]],
      insert: [[command]],
    });

    const result = await createRuntime(harness).boardReopen({
      companyId: COMPANY_ID,
      issueId: ISSUE_ID,
      actorUserId: "board-user",
      reason: "Resume cleanly",
      idempotencyKey: "reopen-fenced-1",
    });

    expect(mocks.requestCancellations).toHaveBeenCalledWith(
      expect.anything(),
      {
        companyId: COMPANY_ID,
        issueId: ISSUE_ID,
        selector: { kind: "ownership_epoch", ownershipEpoch: 1 },
        reason: "board_reopen_continuity_fence",
        actor: { kind: "user", userId: "board-user" },
        now: NOW,
      },
    );
    expect(mocks.reconcileCancellations).toHaveBeenCalledWith(cancellations);
    expect(mocks.dispatchRef).toHaveBeenCalledWith(ref.id);
    expect(result).not.toHaveProperty("cancellations");
    expect(harness.remaining("select")).toBe(0);
    expect(harness.remaining("update")).toBe(0);
    expect(harness.remaining("insert")).toBe(0);
  });

  it("requires an authenticated named board user before a reopen can mutate", async () => {
    const harness = createMockDb({ execute: [[]], select: [[]] });

    await expect(
      createRuntime(harness).boardReopen({
        companyId: COMPANY_ID,
        issueId: ISSUE_ID,
        actorUserId: "missing-user",
        reason: "Reopen",
        idempotencyKey: "reopen-key-2",
      }),
    ).rejects.toMatchObject({
      reason: "board_reopen_actor_invalid",
    });
    expect(
      harness.calls.filter((call) =>
        ["insert", "update", "delete"].includes(call.operation),
      ),
    ).toHaveLength(0);
    expect(mocks.dispatchRef).not.toHaveBeenCalled();
  });

  it("persists a terminal-issue comment without dispatching from prose", async () => {
    const issue = {
      id: ISSUE_ID,
      companyId: COMPANY_ID,
      lifecycleStatus: "done",
      ownershipEpoch: 1,
      ownerKind: "agent",
      ownerAgentId: "owner-agent",
    };
    const comment = { id: "comment-1", issueId: ISSUE_ID, runId: null };
    const command = { id: "comment-command-1", commentId: comment.id };
    mocks.sessions.appendNonDispatchUserComment.mockResolvedValue({
      comment,
      input: null,
      ref: null,
      source: { messageId: "message-1" },
    });
    const harness = createMockDb({
      execute: [[]],
      select: [[], [issue], [sessionState()]],
      insert: [[command]],
    });

    const result = await createRuntime(harness).userComment({
      companyId: COMPANY_ID,
      issueId: ISSUE_ID,
      actorUserId: "commenter",
      message: "  @owner is only prose here.  ",
      idempotencyKey: "comment-key-1",
    });

    expect(result).toMatchObject({ comment, ref: null, retried: false });
    expect(mocks.sessions.appendNonDispatchUserComment).toHaveBeenCalledWith(
      expect.objectContaining({
        exactText: "  @owner is only prose here.  ",
        delivery: "queue",
        sourceKind: "human_comment",
      }),
      harness.db,
    );
    expect(mocks.sessions.admitExecutionSource).not.toHaveBeenCalled();
    expect(mocks.dispatchRef).not.toHaveBeenCalled();
  });

  it("dispatches only an explicit mention of the exact current owner epoch", async () => {
    const issue = {
      id: ISSUE_ID,
      companyId: COMPANY_ID,
      lifecycleStatus: "open",
      ownershipEpoch: 2,
      ownerKind: "agent",
      ownerAgentId: "owner-agent",
    };
    const authority = {
      id: "authority-owner",
      agentId: issue.ownerAgentId,
      ownershipEpoch: issue.ownershipEpoch,
    };
    const comment = { id: "comment-mention", issueId: ISSUE_ID };
    const ref = { id: "ref-mention" };
    mocks.sessions.admitExecutionSource.mockResolvedValue({
      comment,
      input: { id: "input-mention" },
      ref,
      source: { messageId: "message-mention" },
    });
    const harness = createMockDb({
      execute: [[]],
      select: [[], [issue], [sessionState()], [authority]],
      insert: [[{ id: "mention-command", commentId: comment.id }]],
    });

    await createRuntime(harness).userComment({
      companyId: COMPANY_ID,
      issueId: ISSUE_ID,
      actorUserId: "commenter",
      message: "  Continue with this exact context.  ",
      idempotencyKey: "comment-key-mention",
      mention: {
        targetAgentId: issue.ownerAgentId,
        ownershipEpoch: issue.ownershipEpoch,
      },
    });

    expect(mocks.sessions.admitExecutionSource).toHaveBeenCalledWith(
      expect.objectContaining({
        targetAgentId: issue.ownerAgentId,
        ownershipEpoch: issue.ownershipEpoch,
        issueExecutionAuthorityId: authority.id,
        adapterConfigRevisionId: "revision-owner",
        sourceKind: "human_comment_mention",
        exactText: "  Continue with this exact context.  ",
      }),
      harness.db,
    );
    expect(mocks.dispatchRef).toHaveBeenCalledOnce();
    expect(mocks.dispatchRef).toHaveBeenCalledWith(ref.id);
  });

  it.each([
    {
      label: "mention plus reply",
      input: {
        mention: { targetAgentId: "owner-agent", ownershipEpoch: 1 },
        replyToCommentId: "comment-parent",
      },
      reason: "human_comment_target_conflict",
    },
    {
      label: "non-positive mention epoch",
      input: {
        mention: { targetAgentId: "owner-agent", ownershipEpoch: 0 },
      },
      reason: "human_mention_epoch_invalid",
    },
  ])("rejects $label before opening a transaction", async ({ input, reason }) => {
    const harness = createMockDb();

    await expect(
      createRuntime(harness).userComment({
        companyId: COMPANY_ID,
        issueId: ISSUE_ID,
        actorUserId: "commenter",
        message: "Comment",
        idempotencyKey: "invalid-comment-key",
        ...input,
      }),
    ).rejects.toMatchObject({ reason });
    expect(harness.calls).toHaveLength(0);
  });

  it("delegates creator-form admission and translates a denied authority", async () => {
    const harness = createMockDb();
    const runtime = createRuntime(harness);
    const authority = {
      kind: "user/board" as const,
      companyId: COMPANY_ID,
      userId: "creator-user",
      gatewayInvocationId: "gateway-1",
    };
    const accepted = { issue: { id: ISSUE_ID }, delivery: { id: "delivery-1" } };
    mocks.issueForms.commitCreatorFormUpdate.mockResolvedValueOnce(accepted);

    await expect(
      runtime.commitCreatorFormUpdate(
        ISSUE_ID,
        "  Exact creator response.  ",
        authority,
      ),
    ).resolves.toBe(accepted);
    expect(mocks.issueForms.commitCreatorFormUpdate).toHaveBeenCalledWith(
      ISSUE_ID,
      "  Exact creator response.  ",
      authority,
    );

    mocks.issueForms.commitCreatorFormUpdate.mockRejectedValueOnce(
      new RuntimeIssueActionDenied("Wrong creator", "creator_not_authorized"),
    );
    await expect(
      runtime.commitCreatorFormUpdate(ISSUE_ID, "Denied", authority),
    ).rejects.toEqual(
      expect.objectContaining<Partial<OrdinaryIssueRuntimeRejected>>({
        name: "OrdinaryIssueRuntimeRejected",
        reason: "creator_not_authorized",
      }),
    );
    expect(harness.calls).toHaveLength(0);
  });

  it("allows only the exact named creator to enter withdrawal self-assignment", async () => {
    const issue = {
      id: ISSUE_ID,
      companyId: COMPANY_ID,
      ownershipEpoch: 1,
      lifecycleStatus: "open",
      creatorKind: "user/board",
      creatorUserId: "different-user",
      ownerKind: "agent",
      ownerAgentId: "owner-agent",
    };
    const harness = createMockDb({
      execute: [[]],
      select: [[], [issue]],
    });

    await expect(
      createRuntime(harness).userCreatorWithdrawalSelfAssign({
        companyId: COMPANY_ID,
        issueId: ISSUE_ID,
        actorUserId: "creator-user",
        idempotencyKey: "withdrawal-key-1",
      }),
    ).rejects.toMatchObject({
      reason: "withdrawal_self_assignment_target_invalid",
    });
    expect(
      harness.calls.filter((call) =>
        ["insert", "update", "delete"].includes(call.operation),
      ),
    ).toHaveLength(0);
    expect(mocks.dispatchRef).not.toHaveBeenCalled();
  });
});
