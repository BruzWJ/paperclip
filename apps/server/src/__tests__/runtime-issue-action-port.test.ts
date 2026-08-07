import { describe, expect, it, vi } from "vitest";
import {
  admitCounterpartIssueUpdate,
  createRuntimeIssueActionPort,
  type RuntimeIssueActionService,
} from "../services/runtime-issue-action-port.js";
import type { IssueSessionAdmissionService } from "../services/issue-session/admission.js";
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

const commitMentionAction = <T>(_transaction: unknown, result: T) =>
  Promise.resolve(result);
const actionInvocationIdentity = {
  runInterfaceToolCallId: "00000000-0000-4000-8000-000000000001",
  ingressOrdinal: 0,
  commitMentionAction,
} as const;

function setup() {
  const service: RuntimeIssueActionService = {
    create: vi.fn(async (input) => input),
    assign: vi.fn(async (input) => input),
    update: vi.fn(async (input) => input),
    mention: vi.fn(async (input) => input),
    mentionBoard: vi.fn(async (input) => input),
  };
  return { service, port: createRuntimeIssueActionPort(service) };
}

describe("runtime issue action port", () => {
  it("dedupes only an exact same-issue agent update to one comment", async () => {
    const appendNonDispatchControlNotice = vi.fn(async () => ({
      comment: { id: "comment" },
      ref: null,
    }));
    const sessionAdmission = {
      appendNonDispatchControlNotice,
    } as unknown as IssueSessionAdmissionService;

    await admitCounterpartIssueUpdate(sessionAdmission, {} as never, {
      companyId: "company",
      target: {
        kind: "agent",
        target: {
          issueId: "issue",
          sessionId: "session",
          ownershipEpoch: 2,
          agentId: "agent",
          authorityId: "authority",
          adapterConfigRevisionId: "revision",
          contextGeneration: 1,
        },
      },
      actor: {
        kind: "agent-execution",
        agentId: "agent",
        authorityId: "authority",
      },
      comment: {
        author: { kind: "agent", agentId: "agent" },
        producingRun: {
          runId: "run",
          adapterConfigRevisionId: "revision",
        },
      },
      sourceAgentTarget: { issueId: "issue", agentId: "agent" },
      immutableSourceKey: "update",
      sourceRecordId: "update",
      message: "Progress",
    });

    expect(appendNonDispatchControlNotice).toHaveBeenCalledOnce();
  });

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

  it("routes one canonical issue_update ABI for active owners and exact creators", async () => {
    const { service, port } = setup();
    await port.issueUpdate({
      ...actionInvocationIdentity,
      capability: ownerCapability,
      invocationId: "owner-message",
      arguments: { message: "Progress update" },
    });
    await port.issueUpdate({
      ...actionInvocationIdentity,
      capability: ownerCapability,
      invocationId: "owner-update",
      arguments: {
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
        issueId: "child-issue",
        status: "blocked",
        message: "Please adjust",
      },
    });
    expect(service.update).toHaveBeenNthCalledWith(1, {
      capability: ownerCapability,
      invocationId: "owner-message",
      message: "Progress update",
    });
    expect(service.update).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        invocationId: "owner-update",
        status: "done",
        message: "Complete",
        structuredResult: null,
      }),
    );
    expect(service.update).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        invocationId: "creator-update",
        issueId: "child-issue",
        status: "blocked",
      }),
    );
    await expect(
      port.issueUpdate({
        ...actionInvocationIdentity,
        capability: ownerCapability,
        invocationId: "legacy",
        arguments: {
          message: "Complete",
          form: "owner",
        },
      }),
    ).rejects.toBeInstanceOf(RuntimeToolArgumentsInvalid);
  });

  it("rejects malformed canonical update variants at the action boundary", async () => {
    const { port } = setup();
    const malformed = [
      {},
      { message: "" },
      { message: "Progress", status: undefined },
      { message: "Progress", status: null },
      { message: "Progress", status: "paused" },
      {
        message: "Progress",
        structuredResult: { unexpected: true },
      },
      {
        status: "open",
        message: "Progress",
        structuredResult: null,
      },
      {
        status: "done",
        message: "Complete",
        structuredResult: undefined,
      },
      {
        status: "done",
        message: "Complete",
        creatorTargetIssueId: "legacy-target",
      },
      {
        issueId: "child-issue",
        status: "done",
        message: "Only an owner may close an issue",
      },
      {
        issueId: "child-issue",
        status: "cancelled",
        message: "Only an owner may cancel an issue",
        structuredResult: null,
      },
      {
        issueId: undefined,
        message: "No undefined target",
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
        arguments: { message: "Forged progress" },
      }),
    ).rejects.toBeInstanceOf(RuntimeToolArgumentsInvalid);
  });

  it("lowers only the canonical mention message", async () => {
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
      commitMentionAction,
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

  it("accepts only the closed Board-request payload from owner or consult execution", async () => {
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
      commitMentionAction,
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

    const consultCapability = {
      ...ownerCapability,
      executionMode: "consult" as const,
    };
    await port.mentionBoard({
      ...actionInvocationIdentity,
      capability: consultCapability,
      invocationId: "consult-board-request",
      arguments: { message: "Please decide" },
    });
    expect(service.mentionBoard).toHaveBeenLastCalledWith({
      capability: consultCapability,
      invocationId: "consult-board-request",
      runInterfaceToolCallId:
        actionInvocationIdentity.runInterfaceToolCallId,
      ingressOrdinal: actionInvocationIdentity.ingressOrdinal,
      commitMentionAction,
      message: "Please decide",
    });
  });
});
