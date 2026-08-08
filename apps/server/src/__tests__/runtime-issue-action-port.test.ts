import { describe, expect, it, vi } from "vitest";
import {
  admitCounterpartIssueUpdate,
  createRuntimeIssueActionPort,
  RuntimeIssueActionConflict,
  RuntimeIssueActionDenied,
  type RuntimeIssueActionService,
} from "../services/runtime-issue-action-port.js";
import {
  agentRunManagedActionInvocation,
  type AgentRunToolAuthority,
} from "../services/paperclip-managed-tool-router.js";
import type { PaperclipManagedToolCommandFor } from "../services/paperclip-managed-tool-registry.js";
import type { IssueSessionAdmissionService } from "../services/issue-session/admission.js";
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
  bootstrapToolGate: false,
  leaseId: "lease",
  leaseGeneration: 1,
  expiresAt: new Date("2026-07-25T01:00:00.000Z"),
  activatedAt: new Date("2026-07-25T00:00:00.000Z"),
  createdAt: new Date("2026-07-25T00:00:00.000Z"),
};

type RuntimeIssueCommandName =
  | "issue_create"
  | "issue_assign"
  | "issue_update"
  | "mention_agent"
  | "mention_board"
  | "list_agents"
  | "agent_read";

const commitMentionAction: AgentRunToolAuthority["invocation"]["commitMentionAction"] =
  async (_transaction, result) => result;

function actionAuthority(
  capability: PromptCapabilityBinding = ownerCapability,
  invocationId = "invoke",
): AgentRunToolAuthority {
  return {
    kind: "agent_run",
    capability,
    invocation: {
      id: invocationId,
      runInterfaceToolCallId: "00000000-0000-4000-8000-000000000001",
      ingressOrdinal: 0,
      commitMentionAction,
    },
  };
}

function runtimeInvocation<Name extends RuntimeIssueCommandName>(
  command: PaperclipManagedToolCommandFor<Name>,
  capability: PromptCapabilityBinding = ownerCapability,
  invocationId = "invoke",
) {
  return agentRunManagedActionInvocation(
    command,
    actionAuthority(capability, invocationId),
  );
}

function setup() {
  const service: RuntimeIssueActionService = {
    create: vi.fn(async (input) => input),
    assign: vi.fn(async (input) => input),
    update: vi.fn(async (input) => input),
    mention: vi.fn(async (input) => input),
    mentionBoard: vi.fn(async (input) => input),
    listAgents: vi.fn(async (input) => input),
    agentRead: vi.fn(async (input) => input),
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
      sourceKind: "issue_update",
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
      prompt: {
        toolName: "issue_update",
        arguments: { message: "Progress" },
        context: {
          issue: { id: "issue" },
          from: { id: "agent", name: "Agent" },
          sourceRole: "issue owner",
          previousStatus: "open",
          effectiveStatus: "open",
        },
      },
    });

    expect(appendNonDispatchControlNotice).toHaveBeenCalledWith(
      expect.objectContaining({
        exactText: [
          "[Paperclip issue update]",
          "Issue: issue",
          "From: issue owner, Agent (agent)",
          "Status: open",
          "",
          "Progress",
        ].join("\n"),
      }),
      expect.anything(),
    );
  });

  it("lowers an already-normalized create command without reparsing it", async () => {
    const { service, port } = setup();
    await port.issueCreate(runtimeInvocation({
      name: "issue_create",
      companyId: ownerCapability.companyId,
      parentId: ownerCapability.issueId,
      request: "Do exactly this",
      ownerAgentId: "child",
      contextAccessMask: { read_issue_comments: false },
    }));

    expect(service.create).toHaveBeenCalledWith({
      capability: ownerCapability,
      invocationId: "invoke",
      request: "Do exactly this",
      title: undefined,
      priority: undefined,
      owner: { kind: "agent", agentId: "child" },
      contextAccessMask: { read_issue_comments: false },
    });
  });

  it("derives self ownership only from the canonical ownerAgentId", async () => {
    const { service, port } = setup();
    await port.issueCreate(runtimeInvocation({
      name: "issue_create",
      companyId: ownerCapability.companyId,
      parentId: ownerCapability.issueId,
      request: "Keep ownership",
      ownerAgentId: ownerCapability.targetAgentId,
    }, ownerCapability, "self-owner"));

    expect(service.create).toHaveBeenCalledWith(expect.objectContaining({
      invocationId: "self-owner",
      owner: { kind: "self" },
    }));
  });

  it("routes active-owner and explicit-creator update intent from canonical commands", async () => {
    const { service, port } = setup();
    await port.issueUpdate(runtimeInvocation({
      name: "issue_update",
      companyId: ownerCapability.companyId,
      issueId: ownerCapability.issueId,
      issueTarget: "active",
      message: "Progress update",
    }, ownerCapability, "owner-message"));
    await port.issueUpdate(runtimeInvocation({
      name: "issue_update",
      companyId: ownerCapability.companyId,
      issueId: ownerCapability.issueId,
      issueTarget: "active",
      status: "done",
      message: "Complete",
      structuredResult: null,
    }, ownerCapability, "owner-terminal"));
    await port.issueUpdate(runtimeInvocation({
      name: "issue_update",
      companyId: ownerCapability.companyId,
      issueId: "child-issue",
      issueTarget: "explicit",
      status: "blocked",
      message: "Please adjust",
    }, ownerCapability, "creator-update"));

    expect(service.update).toHaveBeenNthCalledWith(1, {
      capability: ownerCapability,
      invocationId: "owner-message",
      message: "Progress update",
    });
    expect(service.update).toHaveBeenNthCalledWith(2, {
      capability: ownerCapability,
      invocationId: "owner-terminal",
      status: "done",
      message: "Complete",
      structuredResult: null,
    });
    expect(service.update).toHaveBeenNthCalledWith(3, {
      capability: ownerCapability,
      invocationId: "creator-update",
      issueId: "child-issue",
      status: "blocked",
      message: "Please adjust",
    });
  });

  it("fails closed if a forged command loses normalized update intent", async () => {
    const { port } = setup();
    const forged = {
      name: "issue_update",
      companyId: ownerCapability.companyId,
      issueId: ownerCapability.issueId,
      message: "Forged",
    } as unknown as PaperclipManagedToolCommandFor<"issue_update">;

    await expect(
      port.issueUpdate(runtimeInvocation(forged)),
    ).rejects.toBeInstanceOf(RuntimeIssueActionConflict);
  });

  it("denies owner and lifecycle commands to a consult authority", async () => {
    const { service, port } = setup();
    const consultCapability = {
      ...ownerCapability,
      executionMode: "consult" as const,
      laneKind: "consult" as const,
      issueExecutionAuthorityId: null,
      consultExecutionId: "consult-authority",
    };
    await expect(port.issueAssign(runtimeInvocation({
      name: "issue_assign",
      companyId: consultCapability.companyId,
      issueId: "child",
      ownerAgentId: consultCapability.targetAgentId,
    }, consultCapability))).rejects.toBeInstanceOf(RuntimeIssueActionDenied);
    await expect(port.issueUpdate(runtimeInvocation({
      name: "issue_update",
      companyId: consultCapability.companyId,
      issueId: consultCapability.issueId,
      issueTarget: "active",
      message: "Forged progress",
    }, consultCapability))).rejects.toBeInstanceOf(RuntimeIssueActionDenied);
    expect(service.assign).not.toHaveBeenCalled();
    expect(service.update).not.toHaveBeenCalled();
  });

  it("passes canonical agent and Board mentions with their immutable invocation identity", async () => {
    const { service, port } = setup();
    await port.mentionAgent(runtimeInvocation({
      name: "mention_agent",
      companyId: ownerCapability.companyId,
      issueId: ownerCapability.issueId,
      agentId: "agent-2",
      message: "Use this exact added context",
    }, ownerCapability, "mention-agent"));
    expect(service.mention).toHaveBeenCalledWith({
      capability: ownerCapability,
      invocationId: "mention-agent",
      runInterfaceToolCallId: "00000000-0000-4000-8000-000000000001",
      ingressOrdinal: 0,
      commitMentionAction,
      targetAgentId: "agent-2",
      message: "Use this exact added context",
    });

    const consultCapability = {
      ...ownerCapability,
      executionMode: "consult" as const,
      laneKind: "consult" as const,
      issueExecutionAuthorityId: null,
      consultExecutionId: "consult-authority",
    };
    await port.mentionBoard(runtimeInvocation({
      name: "mention_board",
      companyId: consultCapability.companyId,
      issueId: consultCapability.issueId,
      message: "Please decide",
    }, consultCapability, "mention-board"));
    expect(service.mentionBoard).toHaveBeenCalledWith({
      capability: consultCapability,
      invocationId: "mention-board",
      runInterfaceToolCallId: "00000000-0000-4000-8000-000000000001",
      ingressOrdinal: 0,
      commitMentionAction,
      message: "Please decide",
    });
  });

  it("passes canonical agent reader commands directly to the service", async () => {
    const { service, port } = setup();
    await port.listAgents(runtimeInvocation({
      name: "list_agents",
      companyId: ownerCapability.companyId,
      agentId: "agent-2",
    }, ownerCapability, "list-agents"));
    await port.agentRead(runtimeInvocation({
      name: "agent_read",
      companyId: ownerCapability.companyId,
      agentId: "agent-2",
    }, ownerCapability, "read-agent"));

    expect(service.listAgents).toHaveBeenCalledWith({
      capability: ownerCapability,
      invocationId: "list-agents",
      agentId: "agent-2",
    });
    expect(service.agentRead).toHaveBeenCalledWith({
      capability: ownerCapability,
      invocationId: "read-agent",
      agentId: "agent-2",
    });
  });
});
