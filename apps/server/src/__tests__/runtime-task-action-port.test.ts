import { describe, expect, it, vi } from "vitest";
import {
  admitCounterpartTaskUpdate,
  createRuntimeTaskActionPort,
  RuntimeTaskActionConflict,
  type RuntimeTaskActionService,
} from "../services/runtime-task-action-port.js";
import {
  agentRunManagedActionInvocation,
  type AgentRunToolAuthority,
} from "../services/paperclip-managed-tool-router.js";
import type { PaperclipManagedToolCommandFor } from "../services/paperclip-managed-tool-registry.js";
import type { TaskSessionAdmissionService } from "../services/task-session/admission.js";
import type { PromptCapabilityBinding } from "../services/prompt-capability-gateway.js";

const ownerCapability: PromptCapabilityBinding = {
  companyId: "company",
  capabilityConnectionId: "gateway",
  capabilityGeneration: 1,
  taskId: "task",
  sessionId: "session",
  runId: "run",
  runBatchDigest: "a".repeat(64),
  refId: "ref",
  refOrdinal: 0,
  segmentOrdinal: 0,
  attemptId: "attempt",
  workerProcessIdentity: "worker",
  taskExecutionAuthorityId: "authority",
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

type RuntimeTaskCommandName =
  | "task_create"
  | "task_assign"
  | "task_update"
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

function runtimeInvocation<Name extends RuntimeTaskCommandName>(
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
  const service: RuntimeTaskActionService = {
    create: vi.fn(async (input) => input),
    assign: vi.fn(async (input) => input),
    update: vi.fn(async (input) => input),
    mention: vi.fn(async (input) => input),
    mentionBoard: vi.fn(async (input) => input),
    listAgents: vi.fn(async (input) => input),
    agentRead: vi.fn(async (input) => input),
  };
  return { service, port: createRuntimeTaskActionPort(service) };
}

describe("runtime task action port", () => {
  it("projects an @target comment without rendering an agent notification for a self update", async () => {
    const appendNonDispatchControlNotice = vi.fn(async () => ({
      comment: { id: "comment" },
      ref: null,
    }));
    const sessionAdmission = {
      appendNonDispatchControlNotice,
    } as unknown as TaskSessionAdmissionService;

    await admitCounterpartTaskUpdate(sessionAdmission, {} as never, {
      companyId: "company",
      sourceKind: "task_update",
      target: {
        kind: "agent",
        target: {
          taskId: "task",
          sessionId: "session",
          ownershipEpoch: 2,
          agentId: "agent",
          agentName: "Agent",
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
      sourceAgentTarget: { taskId: "task", agentId: "agent" },
      immutableSourceKey: "update",
      sourceRecordId: "update",
      message: {
        kind: "managed",
        delivery: {
          toolName: "task_update",
          body: "Progress",
          context: {
            task: { id: "task", identifier: "PAP-1" },
            from: { id: "agent", name: "Agent" },
            sourceRole: "task owner",
            previousStatus: "open",
            effectiveStatus: "open",
          },
        },
      },
    });

    expect(appendNonDispatchControlNotice).toHaveBeenCalledWith(
      expect.objectContaining({
        exactText: "@Agent Progress",
        comment: expect.objectContaining({
          body: "@Agent Progress",
        }),
      }),
      expect.anything(),
    );
  });

  it("lowers an already-normalized create command without reparsing it", async () => {
    const { service, port } = setup();
    await port.taskCreate(
      runtimeInvocation({
        name: "task_create",
        companyId: ownerCapability.companyId,
        parentId: ownerCapability.taskId,
        request: "Do exactly this",
        ownerAgentId: "child",
      }),
    );

    expect(service.create).toHaveBeenCalledWith({
      capability: ownerCapability,
      invocationId: "invoke",
      request: "Do exactly this",
      title: undefined,
      priority: undefined,
      owner: { kind: "agent", agentId: "child" },
    });
  });

  it("derives self ownership only from the canonical ownerAgentId", async () => {
    const { service, port } = setup();
    await port.taskCreate(
      runtimeInvocation(
        {
          name: "task_create",
          companyId: ownerCapability.companyId,
          parentId: ownerCapability.taskId,
          request: "Keep ownership",
          ownerAgentId: ownerCapability.targetAgentId,
        },
        ownerCapability,
        "self-owner",
      ),
    );

    expect(service.create).toHaveBeenCalledWith(
      expect.objectContaining({
        invocationId: "self-owner",
        owner: { kind: "self" },
      }),
    );
  });

  it("routes active-owner and explicit-creator update intent from canonical commands", async () => {
    const { service, port } = setup();
    await port.taskUpdate(
      runtimeInvocation(
        {
          name: "task_update",
          companyId: ownerCapability.companyId,
          taskId: ownerCapability.taskId,
          taskTarget: "active",
          message: "Progress update",
        },
        ownerCapability,
        "owner-message",
      ),
    );
    await port.taskUpdate(
      runtimeInvocation(
        {
          name: "task_update",
          companyId: ownerCapability.companyId,
          taskId: ownerCapability.taskId,
          taskTarget: "active",
          status: "done",
          message: "Complete",
          structuredResult: null,
        },
        ownerCapability,
        "owner-terminal",
      ),
    );
    await port.taskUpdate(
      runtimeInvocation(
        {
          name: "task_update",
          companyId: ownerCapability.companyId,
          taskId: "child-task",
          taskTarget: "explicit",
          status: "blocked",
          message: "Please adjust",
        },
        ownerCapability,
        "creator-update",
      ),
    );

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
      taskId: "child-task",
      status: "blocked",
      message: "Please adjust",
    });
  });

  it("fails closed if a forged command loses normalized update intent", async () => {
    const { port } = setup();
    const forged = {
      name: "task_update",
      companyId: ownerCapability.companyId,
      taskId: ownerCapability.taskId,
      message: "Forged",
    } as unknown as PaperclipManagedToolCommandFor<"task_update">;

    await expect(
      port.taskUpdate(runtimeInvocation(forged)),
    ).rejects.toBeInstanceOf(RuntimeTaskActionConflict);
  });

  it("passes canonical agent and Board mentions with their immutable invocation identity", async () => {
    const { service, port } = setup();
    await port.mentionAgent(
      runtimeInvocation(
        {
          name: "mention_agent",
          companyId: ownerCapability.companyId,
          taskId: ownerCapability.taskId,
          agentId: "agent-2",
          message: "Use this exact added context",
        },
        ownerCapability,
        "mention-agent",
      ),
    );
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
      taskExecutionAuthorityId: null,
      consultExecutionId: "consult-authority",
    };
    await port.mentionBoard(
      runtimeInvocation(
        {
          name: "mention_board",
          companyId: consultCapability.companyId,
          taskId: consultCapability.taskId,
          message: "Please decide",
        },
        consultCapability,
        "mention-board",
      ),
    );
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
    await port.listAgents(
      runtimeInvocation(
        {
          name: "list_agents",
          companyId: ownerCapability.companyId,
          agentId: "agent-2",
        },
        ownerCapability,
        "list-agents",
      ),
    );
    await port.agentRead(
      runtimeInvocation(
        {
          name: "agent_read",
          companyId: ownerCapability.companyId,
          agentId: "agent-2",
        },
        ownerCapability,
        "read-agent",
      ),
    );

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
