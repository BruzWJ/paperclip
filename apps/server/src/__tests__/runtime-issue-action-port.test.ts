import { describe, expect, it, vi } from "vitest";
import {
  createRuntimeIssueActionPort,
  type RuntimeIssueActionService,
} from "../services/runtime-issue-action-port.js";
import { RuntimeToolArgumentsInvalid } from "../services/runtime-interface-compiler.js";
import type { PromptCapabilityBinding } from "../services/prompt-capability-gateway.js";

const ownerCapability: PromptCapabilityBinding = {
  companyId: "company",
  capabilityConnectionId: "gateway",
  capabilityGeneration: 1,
  issueId: "issue",
  sessionId: "session",
  runId: "run",
  runBatchDigest: "a".repeat(64),
  refId: "ref",
  refOrdinal: 0,
  segmentOrdinal: 0,
  attemptId: "attempt",
  workerProcessIdentity: "worker",
  issueExecutionAuthorityId: "authority",
  consultExecutionId: null,
  laneKind: "owner",
  executionMode: "owner",
  ownershipEpoch: 2,
  targetAgentId: "agent",
  adapterConfigIdentity: "revision",
  workspaceIdentity: "workspace",
  targetSessionCorrelationId: "correlation",
  effectiveContextExposureDigest: "b".repeat(64),
  effectiveToolsDigest: "c".repeat(64),
  leaseId: "lease",
  leaseGeneration: 1,
  expiresAt: new Date("2026-07-25T01:00:00.000Z"),
  activatedAt: new Date("2026-07-25T00:00:00.000Z"),
  createdAt: new Date("2026-07-25T00:00:00.000Z"),
};

const commitTerminalAction = <T>(_transaction: unknown, result: T) =>
  Promise.resolve(result);
const actionInvocationIdentity = {
  runInterfaceToolCallId: "00000000-0000-4000-8000-000000000001",
  ingressOrdinal: 0,
  commitTerminalAction,
} as const;

function setup() {
  const service: RuntimeIssueActionService = {
    create: vi.fn(async (input) => input),
    assign: vi.fn(async (input) => input),
    updateOwner: vi.fn(async (input) => input),
    updateCreator: vi.fn(async (input) => input),
    mention: vi.fn(async (input) => input),
    mentionBoard: vi.fn(async (input) => input),
  };
  return { service, port: createRuntimeIssueActionPort(service) };
}

describe("runtime issue action port", () => {
  it("passes only the closed immutable create contract", async () => {
    const { service, port } = setup();
    await port.issueCreate({
      ...actionInvocationIdentity,
      capability: ownerCapability,
      invocationId: "invoke",
      arguments: {
        request: "Do exactly this",
        owner: { kind: "agent", agentId: "child" },
        contextAccessMask: {
          carry_context: false,
          read_issue_comments: false,
        },
      },
    });
    expect(service.create).toHaveBeenCalledWith({
      capability: ownerCapability,
      invocationId: "invoke",
      request: "Do exactly this",
      title: undefined,
      priority: undefined,
      owner: { kind: "agent", agentId: "child" },
      contextAccessMask: {
        carry_context: false,
        read_issue_comments: false,
      },
    });
  });

  it("canonicalizes identity mask cells and rejects broad fields and malformed owners", async () => {
    const { service, port } = setup();
    await port.issueCreate({
      ...actionInvocationIdentity,
      capability: ownerCapability,
      invocationId: "identity-mask",
      arguments: {
        request: "x",
        owner: { kind: "self" },
        contextAccessMask: {
          carry_context: true,
          read_issue_comments: false,
        },
      },
    });
    expect(service.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        contextAccessMask: { read_issue_comments: false },
      }),
    );
    for (const argumentsValue of [
      {
        request: "x",
        owner: { kind: "self" },
        contextAccessMask: { unknown_context: false },
      },
      {
        request: "x",
        owner: { kind: "self" },
        assigneeAgentId: "legacy",
      },
      {
        request: "x",
        owner: { kind: "agent", agentId: "child", name: "leak" },
      },
    ]) {
      await expect(
        port.issueCreate({
          ...actionInvocationIdentity,
          capability: ownerCapability,
          invocationId: "invoke",
          arguments: argumentsValue,
        }),
      ).rejects.toBeInstanceOf(RuntimeToolArgumentsInvalid);
    }
  });

  it("routes the two issue_update forms without a disposition alias", async () => {
    const { service, port } = setup();
    await port.issueUpdate({
      ...actionInvocationIdentity,
      capability: ownerCapability,
      invocationId: "owner-message",
      arguments: { form: "owner", message: "Progress update" },
    });
    await port.issueUpdate({
      ...actionInvocationIdentity,
      capability: ownerCapability,
      invocationId: "owner-update",
      arguments: {
        form: "owner",
        status: "done",
        message: "Complete",
        structuredResult: null,
      },
    });
    await port.issueUpdate({
      ...actionInvocationIdentity,
      capability: ownerCapability,
      invocationId: "creator-update",
      arguments: {
        form: "creator_message",
        creatorTargetIssueId: "child-issue",
        message: "Please adjust",
      },
    });
    expect(service.updateOwner).toHaveBeenNthCalledWith(1, {
      capability: ownerCapability,
      invocationId: "owner-message",
      message: "Progress update",
    });
    expect(service.updateOwner).toHaveBeenCalledWith(
      expect.objectContaining({
        invocationId: "owner-update",
        status: "done",
        message: "Complete",
        structuredResult: null,
      }),
    );
    expect(service.updateCreator).toHaveBeenCalledWith(
      expect.objectContaining({
        invocationId: "creator-update",
        creatorTargetIssueId: "child-issue",
      }),
    );
    await expect(
      port.issueUpdate({
        ...actionInvocationIdentity,
        capability: ownerCapability,
        invocationId: "legacy",
        arguments: {
          form: "owner",
          status: "done",
          message: "Complete",
          disposition: "duplicate",
        },
      }),
    ).rejects.toBeInstanceOf(RuntimeToolArgumentsInvalid);
  });

  it("rejects malformed owner update variants at the action boundary", async () => {
    const { port } = setup();
    const malformed = [
      { form: "owner" },
      { form: "owner", message: "" },
      { form: "owner", message: "Progress", status: undefined },
      { form: "owner", message: "Progress", status: null },
      { form: "owner", message: "Progress", status: "paused" },
      {
        form: "owner",
        message: "Progress",
        structuredResult: { unexpected: true },
      },
      {
        form: "owner",
        status: "open",
        message: "Progress",
        structuredResult: null,
      },
      {
        form: "owner",
        status: "done",
        message: "Complete",
        structuredResult: undefined,
      },
      {
        form: "owner",
        status: "done",
        message: "Complete",
        issueId: "legacy-target",
      },
    ] as const;

    for (const [index, argumentsValue] of malformed.entries()) {
      await expect(
        port.issueUpdate({
          ...actionInvocationIdentity,
          capability: ownerCapability,
          invocationId: `malformed-owner-${index}`,
          arguments: argumentsValue,
        }),
      ).rejects.toBeInstanceOf(RuntimeToolArgumentsInvalid);
    }
  });

  it("denies owner/lifecycle actions to consult bearers", async () => {
    const { port } = setup();
    await expect(
      port.issueAssign({
        ...actionInvocationIdentity,
        capability: { ...ownerCapability, executionMode: "consult" },
        invocationId: "invoke",
        arguments: { issueId: "child", owner: { kind: "self" } },
      }),
    ).rejects.toBeInstanceOf(RuntimeToolArgumentsInvalid);
    await expect(
      port.issueUpdate({
        ...actionInvocationIdentity,
        capability: { ...ownerCapability, executionMode: "consult" },
        invocationId: "invoke-update",
        arguments: { form: "owner", message: "Forged progress" },
      }),
    ).rejects.toBeInstanceOf(RuntimeToolArgumentsInvalid);
  });

  it("lowers only the canonical terminal mention message", async () => {
    const { service, port } = setup();
    await port.mentionAgent({
      ...actionInvocationIdentity,
      capability: ownerCapability,
      invocationId: "steer-target",
      arguments: {
        agentId: "agent-2",
        message: "Use this exact added context",
      },
    });
    expect(service.mention).toHaveBeenCalledWith({
      capability: ownerCapability,
      invocationId: "steer-target",
      runInterfaceToolCallId:
        actionInvocationIdentity.runInterfaceToolCallId,
      ingressOrdinal: actionInvocationIdentity.ingressOrdinal,
      commitTerminalAction,
      targetAgentId: "agent-2",
      message: "Use this exact added context",
    });

    for (const argumentsValue of [
      {
        agentId: "agent-2",
        message: "x",
        mentionSessionId: "8710c164-9694-42cf-9538-2f17fd665891",
      },
      {
        agentId: "agent-2",
        message: "x",
        sessionId: "ses_private",
      },
      {
        agentId: "agent-2",
        message: "x",
        mentionRunId: "8710c164-9694-42cf-9538-2f17fd665891",
      },
      {
        agentId: "agent-2",
        message: "x",
        mentionRunId: undefined,
      },
    ]) {
      await expect(
        port.mentionAgent({
          ...actionInvocationIdentity,
          capability: ownerCapability,
          invocationId: "invalid-selector",
          arguments: argumentsValue,
        }),
      ).rejects.toBeInstanceOf(RuntimeToolArgumentsInvalid);
    }
  });

  it("accepts only the closed Board-request payload and requires an owner execution", async () => {
    const { service, port } = setup();
    await port.mentionBoard({
      ...actionInvocationIdentity,
      capability: ownerCapability,
      invocationId: "board-request",
      arguments: {
        message: "Which release plan should I follow?",
      },
    });
    expect(service.mentionBoard).toHaveBeenCalledWith({
      capability: ownerCapability,
      invocationId: "board-request",
      runInterfaceToolCallId:
        actionInvocationIdentity.runInterfaceToolCallId,
      ingressOrdinal: actionInvocationIdentity.ingressOrdinal,
      commitTerminalAction,
      message: "Which release plan should I follow?",
    });

    for (const argumentsValue of [
      {},
      { message: "" },
      { message: "   " },
      { message: "x", reason: "clarification" },
      { message: "x", agentId: "forged-target" },
    ]) {
      await expect(
        port.mentionBoard({
          ...actionInvocationIdentity,
          capability: ownerCapability,
          invocationId: "invalid-board-request",
          arguments: argumentsValue,
        }),
      ).rejects.toBeInstanceOf(RuntimeToolArgumentsInvalid);
    }

    await expect(
      port.mentionBoard({
        ...actionInvocationIdentity,
        capability: { ...ownerCapability, executionMode: "consult" },
        invocationId: "consult-board-request",
        arguments: { message: "Please decide" },
      }),
    ).rejects.toBeInstanceOf(RuntimeToolArgumentsInvalid);
  });
});
