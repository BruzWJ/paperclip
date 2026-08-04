import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createIssueFormCommitRuntime,
  createRuntimeIssueActionPort,
  RuntimeIssueActionConflict,
  RuntimeIssueActionDenied,
  type RuntimeIssueActionService,
} from "../services/runtime-issue-action-port.js";
import { RuntimeToolArgumentsInvalid } from "../services/runtime-tool-executor.js";
import type { PromptCapabilityBinding } from "../services/prompt-capability-gateway.js";
import { createMockDb } from "./helpers/mock-db.js";

const capability: PromptCapabilityBinding = {
  companyId: "00000000-0000-4000-8000-000000000701",
  issueId: "00000000-0000-4000-8000-000000000702",
  ownershipEpoch: 1,
  targetAgentId: "00000000-0000-4000-8000-000000000703",
  executionMode: "owner",
  issueExecutionAuthorityId: "00000000-0000-4000-8000-000000000704",
  consultExecutionId: null,
  capabilityConnectionId: "00000000-0000-4000-8000-000000000705",
  capabilityGeneration: 1,
  runId: "00000000-0000-4000-8000-000000000706",
  runBatchDigest: "batch-digest",
  refId: "00000000-0000-4000-8000-000000000707",
  refOrdinal: 0,
  segmentOrdinal: 0,
  attemptId: "00000000-0000-4000-8000-000000000708",
  leaseId: "00000000-0000-4000-8000-000000000709",
  leaseGeneration: 1,
  workerProcessIdentity: "worker",
  sessionId: "00000000-0000-4000-8000-00000000070a",
  laneKind: "owner",
  adapterConfigIdentity: "revision-1",
  workspaceIdentity: "workspace-1",
  targetSessionCorrelationId: "correlation-1",
  effectiveContextExposureDigest: "context-digest",
  effectiveToolsDigest: "tools-digest",
  expiresAt: new Date("2026-08-02T13:00:00.000Z"),
  activatedAt: new Date("2026-08-02T12:00:00.000Z"),
  createdAt: new Date("2026-08-02T12:00:00.000Z"),
};

function serviceSpies(): RuntimeIssueActionService {
  return {
    create: vi.fn(async (input) => ({ kind: "create", input })),
    assign: vi.fn(async (input) => ({ kind: "assign", input })),
    updateOwner: vi.fn(async (input) => ({ kind: "owner", input })),
    updateCreator: vi.fn(async (input) => ({ kind: "creator", input })),
    mention: vi.fn(async (input) => ({ kind: "mention", input })),
    mentionBoard: vi.fn(async (input) => ({ kind: "board", input })),
  };
}

function invocation(
  args: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) {
  const withMentionAdmission = vi.fn(async <T>(
    _targetAgentId: string,
    prepare: () => Promise<T>,
  ) => prepare());
  return {
    capability,
    invocationId: "invocation-1",
    runInterfaceToolCallId: "tool-call-1",
    ingressOrdinal: 4,
    arguments: args,
    withMentionAdmission,
    ...overrides,
  };
}

describe("runtime issue action contracts", () => {
  let service: RuntimeIssueActionService;

  beforeEach(() => {
    service = serviceSpies();
  });

  it("lowers issue_create into the canonical typed service input", async () => {
    const port = createRuntimeIssueActionPort(service);
    const call = invocation({
      request: "Build the child task",
      title: "Child task",
      priority: "high",
      owner: { kind: "self" },
      contextAccessMask: {
        carry_context: true,
        read_issue_comments: false,
      },
    });

    await port.issueCreate(call);

    expect(service.create).toHaveBeenCalledWith({
      capability,
      invocationId: "invocation-1",
      request: "Build the child task",
      title: "Child task",
      priority: "high",
      owner: { kind: "self" },
      contextAccessMask: { read_issue_comments: false },
    });
  });

  it("lowers assignment and both owner-update forms without rewriting payloads", async () => {
    const port = createRuntimeIssueActionPort(service);
    const issueId = "00000000-0000-4000-8000-00000000070b";
    const nextOwner = "00000000-0000-4000-8000-00000000070c";

    await port.issueAssign(invocation({
      issueId,
      owner: { kind: "agent", agentId: nextOwner },
    }));
    await port.issueUpdate(invocation({
      form: "owner",
      message: "Progress note",
    }));
    await port.issueUpdate(invocation({
      form: "owner",
      status: "done",
      message: "Finished exactly",
      structuredResult: { artifact: "report.json" },
    }));

    expect(service.assign).toHaveBeenCalledWith({
      capability,
      invocationId: "invocation-1",
      issueId,
      owner: { kind: "agent", agentId: nextOwner },
    });
    expect(service.updateOwner).toHaveBeenNthCalledWith(1, {
      capability,
      invocationId: "invocation-1",
      message: "Progress note",
    });
    expect(service.updateOwner).toHaveBeenNthCalledWith(2, {
      capability,
      invocationId: "invocation-1",
      status: "done",
      message: "Finished exactly",
      structuredResult: { artifact: "report.json" },
    });
  });

  it("routes creator_message explicitly to the selected creator target", async () => {
    const port = createRuntimeIssueActionPort(service);
    const creatorTargetIssueId = "00000000-0000-4000-8000-00000000070d";

    await port.issueUpdate(invocation({
      form: "creator_message",
      creatorTargetIssueId,
      message: "Report to the immutable creator edge",
    }));

    expect(service.updateCreator).toHaveBeenCalledWith({
      capability,
      invocationId: "invocation-1",
      creatorTargetIssueId,
      message: "Report to the immutable creator edge",
    });
  });

  it("passes mention admission identity and an optional mentionRunId unchanged", async () => {
    const port = createRuntimeIssueActionPort(service);
    const targetAgentId = "00000000-0000-4000-8000-00000000070e";
    const mentionRunId = "00000000-0000-4000-8000-00000000070f";
    const call = invocation({
      agentId: targetAgentId,
      message: "Continue this exact run",
      mentionRunId,
    });

    await port.mentionAgent(call);

    expect(service.mention).toHaveBeenCalledWith({
      capability,
      invocationId: "invocation-1",
      runInterfaceToolCallId: "tool-call-1",
      ingressOrdinal: 4,
      withMentionAdmission: call.withMentionAdmission,
      targetAgentId,
      message: "Continue this exact run",
      mentionRunId,
    });
  });

  it("rejects consult lifecycle mutations before the service boundary", async () => {
    const consultCapability = {
      ...capability,
      executionMode: "consult" as const,
      laneKind: "consult" as const,
      issueExecutionAuthorityId: null,
      consultExecutionId: "00000000-0000-4000-8000-000000000710",
    };
    const port = createRuntimeIssueActionPort(service);

    await expect(port.issueCreate(invocation({
      request: "No",
      owner: { kind: "self" },
    }, { capability: consultCapability }))).rejects.toBeInstanceOf(
      RuntimeToolArgumentsInvalid,
    );
    await expect(port.issueAssign(invocation({
      issueId: capability.issueId,
      owner: { kind: "self" },
    }, { capability: consultCapability }))).rejects.toBeInstanceOf(
      RuntimeToolArgumentsInvalid,
    );
    await expect(port.issueUpdate(invocation({
      form: "owner",
      message: "No",
    }, { capability: consultCapability }))).rejects.toBeInstanceOf(
      RuntimeToolArgumentsInvalid,
    );
    expect(service.create).not.toHaveBeenCalled();
    expect(service.assign).not.toHaveBeenCalled();
    expect(service.updateOwner).not.toHaveBeenCalled();
  });

  it("enforces the closed issue-action ABI before persistence", async () => {
    const port = createRuntimeIssueActionPort(service);

    await expect(port.issueCreate(invocation({
      request: "Bad priority",
      owner: { kind: "self" },
      priority: "urgent",
    }))).rejects.toBeInstanceOf(RuntimeToolArgumentsInvalid);
    await expect(port.issueAssign(invocation({
      issueId: capability.issueId,
      owner: { kind: "agent", agentId: "" },
    }))).rejects.toBeInstanceOf(RuntimeToolArgumentsInvalid);
    await expect(port.issueUpdate(invocation({
      form: "owner",
      status: "done",
      message: "Invalid undefined result",
      structuredResult: undefined,
    }))).rejects.toBeInstanceOf(RuntimeToolArgumentsInvalid);
    await expect(port.issueUpdate(invocation({
      form: "creator_message",
      creatorTargetIssueId: capability.issueId,
      message: "Unexpected key",
      status: "open",
    }))).rejects.toBeInstanceOf(RuntimeToolArgumentsInvalid);
    await expect(port.mentionAgent(invocation({
      agentId: capability.targetAgentId,
      message: "Bad selector",
      mentionRunId: undefined,
    }))).rejects.toBeInstanceOf(RuntimeToolArgumentsInvalid);
  });

  it("validates canonical owner and creator forms before opening a transaction", async () => {
    const harness = createMockDb();
    const runtime = createIssueFormCommitRuntime(harness.db, {
      notifyCreatorDelivery: vi.fn(async () => undefined),
    });
    const humanAuthority = {
      kind: "system-escalation-human" as const,
      companyId: capability.companyId,
      actorUserId: "board-user",
      gatewayInvocationId: "human-owner-1",
    };

    await expect(runtime.commitOwnerFormUpdate(
      capability.issueId,
      { message: "" },
      humanAuthority,
    )).rejects.toBeInstanceOf(RuntimeIssueActionConflict);
    await expect(runtime.commitOwnerFormUpdate(
      capability.issueId,
      { message: "Nonterminal result", structuredResult: { invalid: true } } as never,
      humanAuthority,
    )).rejects.toBeInstanceOf(RuntimeIssueActionConflict);
    await expect(runtime.commitCreatorFormUpdate(
      capability.issueId,
      "   ",
      {
        kind: "user/board",
        companyId: capability.companyId,
        userId: "board-user",
        gatewayInvocationId: "human-creator-1",
      },
    )).rejects.toBeInstanceOf(RuntimeIssueActionConflict);
    expect(harness.calls).toEqual([]);
  });

  it("limits withdrawal ownership to message-only cancellation", async () => {
    const harness = createMockDb();
    const runtime = createIssueFormCommitRuntime(harness.db, {
      notifyCreatorDelivery: vi.fn(async () => undefined),
    });
    const withdrawalAuthority = {
      kind: "user-creator-withdrawal" as const,
      companyId: capability.companyId,
      actorUserId: "creator-user",
      gatewayInvocationId: "withdrawal-1",
    };

    await expect(runtime.commitOwnerFormUpdate(
      capability.issueId,
      { message: "Cannot finish", status: "done" },
      withdrawalAuthority,
    )).rejects.toMatchObject<Partial<RuntimeIssueActionDenied>>({
      reason: "user_withdrawal_cancel_only",
    });
    await expect(runtime.commitOwnerFormUpdate(
      capability.issueId,
      {
        message: "Cannot attach a result",
        status: "cancelled",
        structuredResult: { invalid: true },
      },
      withdrawalAuthority,
    )).rejects.toMatchObject<Partial<RuntimeIssueActionDenied>>({
      reason: "user_withdrawal_cancel_only",
    });
    expect(harness.calls).toEqual([]);
  });
});
