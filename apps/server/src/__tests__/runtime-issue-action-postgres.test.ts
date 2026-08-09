import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createIssueFormCommitRuntime,
  createPostgresRuntimeIssueActionService,
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
  bootstrapToolGate: false,
  expiresAt: new Date("2026-08-02T13:00:00.000Z"),
  activatedAt: new Date("2026-08-02T12:00:00.000Z"),
  createdAt: new Date("2026-08-02T12:00:00.000Z"),
};

function serviceSpies(): RuntimeIssueActionService {
  return {
    create: vi.fn(async (input) => ({ kind: "create", input })),
    assign: vi.fn(async (input) => ({ kind: "assign", input })),
    update: vi.fn(async (input) => ({ kind: "update", input })),
    mention: vi.fn(async (input) => ({ kind: "mention", input })),
    mentionBoard: vi.fn(async (input) => ({ kind: "board", input })),
    listAgents: vi.fn(async (input) => ({ kind: "list_agents", input })),
    agentRead: vi.fn(async (input) => ({ kind: "agent_read", input })),
  };
}

type RuntimeIssueCommandName =
  | "issue_create"
  | "issue_assign"
  | "issue_update"
  | "mention_agent";

function actionAuthority(
  capabilityBinding: PromptCapabilityBinding = capability,
  invocationId = "invocation-1",
): AgentRunToolAuthority {
  return {
    kind: "agent_run",
    capability: capabilityBinding,
    invocation: {
      id: invocationId,
      runInterfaceToolCallId: "tool-call-1",
      ingressOrdinal: 4,
      commitMentionAction: vi.fn(async <T>(
        _transaction: unknown,
        result: T,
      ) => result),
    },
  };
}

function runtimeInvocation<Name extends RuntimeIssueCommandName>(
  command: PaperclipManagedToolCommandFor<Name>,
  capabilityBinding: PromptCapabilityBinding = capability,
  invocationId = "invocation-1",
) {
  return agentRunManagedActionInvocation(
    command,
    actionAuthority(capabilityBinding, invocationId),
  );
}

describe("runtime issue action contracts", () => {
  let service: RuntimeIssueActionService;

  beforeEach(() => {
    service = serviceSpies();
  });

  it("lowers issue_create into the canonical typed service input", async () => {
    const port = createRuntimeIssueActionPort(service);
    const call = runtimeInvocation({
      name: "issue_create",
      companyId: capability.companyId,
      parentId: capability.issueId,
      request: "Build the child task",
      title: "Child task",
      priority: "high",
      ownerAgentId: capability.targetAgentId,
    });

    await port.issueCreate(call);

    expect(service.create).toHaveBeenCalledWith({
      capability,
      invocationId: "invocation-1",
      request: "Build the child task",
      title: "Child task",
      priority: "high",
      owner: { kind: "self" },
    });
  });

  it("lowers assignment and canonical issue updates without rewriting payloads", async () => {
    const port = createRuntimeIssueActionPort(service);
    const issueId = "00000000-0000-4000-8000-00000000070b";
    const nextOwner = "00000000-0000-4000-8000-00000000070c";

    await port.issueAssign(runtimeInvocation({
      name: "issue_assign",
      companyId: capability.companyId,
      issueId,
      ownerAgentId: nextOwner,
    }));
    await port.issueUpdate(runtimeInvocation({
      name: "issue_update",
      companyId: capability.companyId,
      issueId: capability.issueId,
      issueTarget: "active",
      message: "Progress note",
    }));
    await port.issueUpdate(runtimeInvocation({
      name: "issue_update",
      companyId: capability.companyId,
      issueId: capability.issueId,
      issueTarget: "active",
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
    expect(service.update).toHaveBeenNthCalledWith(1, {
      capability,
      invocationId: "invocation-1",
      message: "Progress note",
    });
    expect(service.update).toHaveBeenNthCalledWith(2, {
      capability,
      invocationId: "invocation-1",
      status: "done",
      message: "Finished exactly",
      structuredResult: { artifact: "report.json" },
    });
  });

  it("routes a creator update explicitly to the selected direct child", async () => {
    const port = createRuntimeIssueActionPort(service);
    const issueId = "00000000-0000-4000-8000-00000000070d";

    await port.issueUpdate(runtimeInvocation({
      name: "issue_update",
      companyId: capability.companyId,
      issueId,
      issueTarget: "explicit",
      status: "blocked",
      message: "Report to the immutable creator edge",
    }));

    expect(service.update).toHaveBeenCalledWith({
      capability,
      invocationId: "invocation-1",
      issueId,
      status: "blocked",
      message: "Report to the immutable creator edge",
    });
  });

  it("passes mention admission identity with the canonical message", async () => {
    const port = createRuntimeIssueActionPort(service);
    const targetAgentId = "00000000-0000-4000-8000-00000000070e";
    const call = runtimeInvocation({
      name: "mention_agent",
      companyId: capability.companyId,
      issueId: capability.issueId,
      agentId: targetAgentId,
      message: "Send this canonical mention",
    });

    await port.mentionAgent(call);

    expect(service.mention).toHaveBeenCalledWith({
      capability,
      invocationId: "invocation-1",
      runInterfaceToolCallId: "tool-call-1",
      ingressOrdinal: 4,
      commitMentionAction: call.authority.invocation.commitMentionAction,
      targetAgentId,
      message: "Send this canonical mention",
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

    await expect(port.issueCreate(runtimeInvocation({
      name: "issue_create",
      companyId: consultCapability.companyId,
      parentId: consultCapability.issueId,
      request: "No",
      ownerAgentId: consultCapability.targetAgentId,
    }, consultCapability))).rejects.toBeInstanceOf(RuntimeIssueActionDenied);
    await expect(port.issueAssign(runtimeInvocation({
      name: "issue_assign",
      companyId: consultCapability.companyId,
      issueId: capability.issueId,
      ownerAgentId: consultCapability.targetAgentId,
    }, consultCapability))).rejects.toBeInstanceOf(RuntimeIssueActionDenied);
    await expect(port.issueUpdate(runtimeInvocation({
      name: "issue_update",
      companyId: consultCapability.companyId,
      issueId: consultCapability.issueId,
      issueTarget: "active",
      message: "No",
    }, consultCapability))).rejects.toBeInstanceOf(RuntimeIssueActionDenied);
    expect(service.create).not.toHaveBeenCalled();
    expect(service.assign).not.toHaveBeenCalled();
    expect(service.update).not.toHaveBeenCalled();
  });

  it("fails closed when a forged command has lost canonical target intent", async () => {
    const port = createRuntimeIssueActionPort(service);
    const forged = {
      name: "issue_update",
      companyId: capability.companyId,
      issueId: capability.issueId,
      message: "Unexpected target intent",
    } as unknown as PaperclipManagedToolCommandFor<"issue_update">;

    await expect(port.issueUpdate(runtimeInvocation(forged)))
      .rejects.toBeInstanceOf(RuntimeIssueActionConflict);
    expect(service.update).not.toHaveBeenCalled();
  });

  it("validates canonical owner and creator forms before opening a transaction", async () => {
    const harness = createMockDb();
    const runtime = createIssueFormCommitRuntime(harness.db, {
      dispatchPersistedRef: vi.fn(async () => undefined),
      issueExecutionCancellation: {
        requestScopeCancellationsInTransaction: vi.fn(),
        reconcileRequestedScopeCancellations: vi.fn(),
      },
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
    await expect(runtime.commitCreatorFormUpdate(
      capability.issueId,
      {
        message: "A creator cannot close its child",
        status: "done",
      } as never,
      {
        kind: "agent-execution",
        capability,
        invocationId: "creator-terminal-1",
      },
    )).rejects.toMatchObject<Partial<RuntimeIssueActionDenied>>({
      reason: "creator_terminal_status_forbidden",
    });
    expect(harness.calls).toEqual([]);
  });

  it("limits withdrawal ownership to message-only cancellation", async () => {
    const harness = createMockDb();
    const runtime = createIssueFormCommitRuntime(harness.db, {
      dispatchPersistedRef: vi.fn(async () => undefined),
      issueExecutionCancellation: {
        requestScopeCancellationsInTransaction: vi.fn(),
        reconcileRequestedScopeCancellations: vi.fn(),
      },
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

  it.each([
    {
      lifecycleStatus: "cancelled",
      executionPaused: false,
      reason: "issue_lifecycle_terminal",
    },
    {
      lifecycleStatus: "open",
      executionPaused: true,
      reason: "issue_execution_paused",
    },
  ])(
    "rejects $reason under the runtime mutation lock",
    async ({ lifecycleStatus, executionPaused, reason }) => {
      const harness = createMockDb({
        execute: [[], []],
        select: [
          [{ id: capability.companyId }],
          [{ id: capability.issueId, lifecycleStatus, executionPaused }],
        ],
      });
      const runtime = createPostgresRuntimeIssueActionService(harness.db, {
        clock: () => new Date("2026-08-02T12:30:00.000Z"),
        dispatchPersistedRef: vi.fn(async () => undefined),
        issueExecutionCancellation: {
          requestScopeCancellationsInTransaction: vi.fn(),
          reconcileRequestedScopeCancellations: vi.fn(),
        },
      });

      await expect(runtime.mentionBoard({
        capability,
        invocationId: `mutation-fence-${reason}`,
        runInterfaceToolCallId: "00000000-0000-4000-8000-000000000711",
        ingressOrdinal: 0,
        commitMentionAction: vi.fn(),
        message: "Do not commit this mention",
      })).rejects.toMatchObject<Partial<RuntimeIssueActionDenied>>({ reason });

      expect(harness.calls
        .filter((call) => call.method === call.operation)
        .map((call) => call.operation))
        .toEqual(["execute", "select", "execute", "select"]);
      expect(harness.remaining("execute")).toBe(0);
      expect(harness.remaining("select")).toBe(0);
    },
  );

  it("rejects a pre-cancel capability after the issue is restored", async () => {
    const harness = createMockDb({
      execute: [[], []],
      insert: [[]],
      select: [
        [{ id: capability.companyId }],
        [{
          id: capability.issueId,
          lifecycleStatus: "open",
          executionPaused: false,
        }],
        [{ id: capability.sessionId }],
        [{ id: capability.targetAgentId }],
        [{ targetAgentId: capability.targetAgentId }],
        [{
          id: capability.runId,
          companyId: capability.companyId,
          issueId: capability.issueId,
          sessionId: capability.sessionId,
          executionScopeId: "00000000-0000-4000-8000-00000000070b",
          kind: "productive",
          status: "running",
          ownershipEpoch: capability.ownershipEpoch,
          targetAgentId: capability.targetAgentId,
          executionMode: capability.executionMode,
          issueExecutionAuthorityId: capability.issueExecutionAuthorityId,
          consultExecutionId: capability.consultExecutionId,
          parentRunId: null,
          retryOfRunId: null,
          adapterConfigRevisionId: capability.adapterConfigIdentity,
          executionWorkspaceBindingId: capability.workspaceIdentity,
          currentAttemptId: capability.attemptId,
          currentLeaseId: capability.leaseId,
          cancellationIntentId: "00000000-0000-4000-8000-000000000712",
          terminalFinalizationId: null,
          startedAt: new Date("2026-08-02T12:00:00.000Z"),
          finishedAt: null,
          terminalClassification: null,
          terminalReasonCode: null,
          processExitCode: null,
          processSignal: null,
          createdAt: new Date("2026-08-02T12:00:00.000Z"),
          updatedAt: new Date("2026-08-02T12:00:00.000Z"),
        }],
      ],
    });
    const runtime = createPostgresRuntimeIssueActionService(harness.db, {
      clock: () => new Date("2026-08-02T12:30:00.000Z"),
      dispatchPersistedRef: vi.fn(async () => undefined),
      issueExecutionCancellation: {
        requestScopeCancellationsInTransaction: vi.fn(),
        reconcileRequestedScopeCancellations: vi.fn(),
      },
    });

    await expect(runtime.mentionBoard({
      capability,
      invocationId: "mutation-fence-cancelled-run",
      runInterfaceToolCallId: "00000000-0000-4000-8000-000000000713",
      ingressOrdinal: 0,
        commitMentionAction: vi.fn(),
      message: "Do not revive this call",
    })).rejects.toMatchObject<Partial<RuntimeIssueActionDenied>>({
      reason: "run_scope_changed",
    });
    expect(harness.remaining("execute")).toBe(0);
    expect(harness.remaining("insert")).toBe(0);
    expect(harness.remaining("select")).toBe(0);
  });
});
