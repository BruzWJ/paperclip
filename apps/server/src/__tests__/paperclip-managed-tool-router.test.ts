import { describe, expect, it, vi } from "vitest";
import type { OrdinaryTaskRuntime } from "../services/ordinary-task-runtime.js";
import { parseBoardManagedTool } from "../services/paperclip-managed-tool-registry.js";
import {
  createPaperclipManagedToolRouter,
  type AgentRunManagedActionPort,
  type AgentRunToolAuthority,
  type BoardUserToolAuthority,
} from "../services/paperclip-managed-tool-router.js";
import { RuntimeInterfaceConflict } from "../services/runtime-tool-errors.js";
import { createMockDb } from "./helpers/mock-db.js";

const agentServiceMocks = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
}));
const runtimeAuthorityMocks = vi.hoisted(() => ({
  lockRuntimeToolAuthority: vi.fn(),
}));

vi.mock("../services/agents.js", () => ({
  agentService: () => agentServiceMocks,
}));
vi.mock("../services/runtime-task-action-port-shared-part-3.js", () => ({
  lockRuntimeToolAuthority: runtimeAuthorityMocks.lockRuntimeToolAuthority,
}));

const companyId = "00000000-0000-4000-8000-000000000001";
const taskId = "00000000-0000-4000-8000-000000000002";
const ownerAgentId = "00000000-0000-4000-8000-000000000003";
const userId = "board-user-1";

const boardAuthority: BoardUserToolAuthority = {
  kind: "board_user",
  userId,
  credentialId: "board-key-1",
  companyIds: [companyId],
  companies: [],
  requestId: 1,
};

function authority(): AgentRunToolAuthority {
  return {
    kind: "agent_run",
    capability: { companyId, taskId } as AgentRunToolAuthority["capability"],
    invocation: {
      id: "call-1",
      runInterfaceToolCallId: "ledger-call-1",
      ingressOrdinal: 0,
      async commitMentionAction(_transaction, result) {
        return result;
      },
    },
  };
}

function setup() {
  runtimeAuthorityMocks.lockRuntimeToolAuthority.mockReset();
  runtimeAuthorityMocks.lockRuntimeToolAuthority.mockResolvedValue({
    catalog: { contextDial: {} },
  });
  const db = {
    transaction: vi.fn(async (callback: (transaction: unknown) => Promise<unknown>) =>
      callback({})),
  };
  const taskAssign = vi.fn(async () => ({ status: "assigned" }));
  const agentRunActions = {
    taskAssign,
  } as unknown as AgentRunManagedActionPort;
  const listCompanyTasks = vi.fn(async () => ({ tasks: [] }));
  const retrieval = { listCompanyTasks };
  const router = createPaperclipManagedToolRouter({
    db: db as never,
    agentRunActions,
    retrieval: () => retrieval as never,
  });
  return { listCompanyTasks, router, taskAssign };
}

describe("ACPX managed-tool router", () => {
  it("routes a normalized action only through its run authority", async () => {
    const { router, taskAssign } = setup();
    const runAuthority = authority();
    const command = {
      name: "task_assign" as const,
      companyId,
      taskId,
      ownerAgentId,
    };

    await expect(
      router.routeExecution(command, { authority: runAuthority }),
    ).resolves.toEqual({ status: "assigned" });
    expect(taskAssign).toHaveBeenCalledWith({
      command,
      authority: runAuthority,
    });
  });

  it("rejects a normalized command outside the run company", async () => {
    const { router, taskAssign } = setup();

    await expect(
      router.routeExecution(
        {
          name: "task_assign",
          companyId: "00000000-0000-4000-8000-000000000099",
          taskId,
          ownerAgentId,
        },
        { authority: authority() },
      ),
    ).rejects.toBeInstanceOf(RuntimeInterfaceConflict);
    expect(taskAssign).not.toHaveBeenCalled();
  });

  it("uses the exact run-scoped context for retrieval", async () => {
    const { listCompanyTasks, router } = setup();
    const runtimeScope = {
      companyId,
      activeTaskId: taskId,
      dial: {},
    };

    await router.routeExecution(
      { name: "list_company_tasks", companyId, limit: 25 },
      { authority: authority() },
    );

    expect(runtimeAuthorityMocks.lockRuntimeToolAuthority).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      authority().capability,
      "list_company_tasks",
      expect.any(Date),
    );
    expect(listCompanyTasks).toHaveBeenCalledWith(runtimeScope, {
      filters: undefined,
      cursor: undefined,
      limit: 25,
    });
  });
});

function boardTaskRow() {
  return {
    id: taskId,
    companyId,
    ownershipEpoch: 1,
    boardPresentationStatus: "open",
    title: "Before lifecycle update",
  };
}

function setupBoard(options: {
  lifecycle?: () => Promise<unknown>;
  reassignment?: () => Promise<unknown>;
} = {}) {
  const db = createMockDb({ select: [[boardTaskRow()], [], []] });
  const commitOwnerFormUpdate = vi.fn(
    options.lifecycle ?? (async () => ({
      task: { id: taskId },
      comment: { id: "00000000-0000-4000-8000-000000000004" },
      retried: false,
    })),
  );
  const boardReassign = vi.fn(options.reassignment);
  const ordinaryTasks = {
    boardReassign,
    commitOwnerFormUpdate,
    userComment: vi.fn(),
  } as unknown as OrdinaryTaskRuntime;
  const publish = vi.fn();
  const router = createPaperclipManagedToolRouter({
    db: db.db,
    agentRunActions: {} as AgentRunManagedActionPort,
    ordinaryTasks: () => ordinaryTasks,
    retrieval: () => ({} as never),
    pluginDomainEvents: { publish } as never,
  });
  return { boardReassign, db, commitOwnerFormUpdate, publish, router };
}

describe("Board MCP managed-tool routing", () => {
  it("returns a terminal ownership-only reassignment without inventing an execution ref", async () => {
    const reassignment = {
      task: { id: taskId, lifecycleStatus: "done", ownerAgentId },
      ref: null,
      auditId: "reassignment-audit",
      retried: false,
    };
    const { router, boardReassign } = setupBoard({
      reassignment: async () => reassignment,
    });

    await expect(
      router.routeExecution(
        parseBoardManagedTool("task_assign", { companyId, taskId, ownerAgentId }),
        { authority: boardAuthority },
      ),
    ).resolves.toEqual({
      task: reassignment.task,
      executionRefId: null,
      auditId: reassignment.auditId,
      retried: false,
    });
    expect(boardReassign).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId,
        taskId,
        ownerAgentId,
        actorUserId: userId,
      }),
    );
  });

  it("uses the canonical owner-form lifecycle transaction and plugin event", async () => {
    const { router, commitOwnerFormUpdate, publish } = setupBoard();

    const result = await router.routeExecution(
      parseBoardManagedTool("task_update", {
        companyId,
        taskId,
        status: "done",
        message: "The Board verified the result.",
        recipient: "owner",
      }),
      { authority: boardAuthority },
    );

    expect(result).toEqual({
      task: { id: taskId },
      comment: { id: "00000000-0000-4000-8000-000000000004" },
      retried: false,
    });
    expect(commitOwnerFormUpdate).toHaveBeenCalledWith(
      taskId,
      {
        status: "done",
        message: "The Board verified the result.",
      },
      expect.objectContaining({
        kind: "board",
        companyId,
        actorUserId: userId,
        recipient: "owner",
        gatewayInvocationId: expect.stringContaining(
          "paperclip-tool:task_update:",
        ),
      }),
    );
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      eventId: "00000000-0000-4000-8000-000000000004",
      eventType: "task.board.comment.created",
      companyId,
    }));
  });

  it("rejects invalid lifecycle input before any mutation", () => {
    const { commitOwnerFormUpdate } = setupBoard();
    expect(() => parseBoardManagedTool("task_update", {
      companyId,
      taskId,
      status: "blocked",
      recipient: "owner",
    })).toThrow();
    expect(() => parseBoardManagedTool("task_update", {
      companyId,
      taskId,
      title: "Generic title updates are not accepted",
      message: "This must remain one comment/status command.",
    })).toThrow();
    expect(commitOwnerFormUpdate).not.toHaveBeenCalled();
  });

  it("requires one explicit lifecycle status and recipient", () => {
    expect(() => parseBoardManagedTool("task_update", {
      companyId,
      taskId,
      message: "Waiting on input.",
      recipient: "owner",
    })).toThrow();
    expect(() => parseBoardManagedTool("task_update", {
      companyId,
      taskId,
      status: "blocked",
      message: "Waiting on input.",
    })).toThrow();
  });

  it("represents terminal continuation as status open on the same task_update path", async () => {
    const { router, commitOwnerFormUpdate } = setupBoard();

    await router.routeExecution(
      parseBoardManagedTool("task_update", {
        companyId,
        taskId,
        status: "open",
        message: "Continue with the Board follow-up.",
        recipient: "owner",
      }),
      { authority: boardAuthority },
    );

    expect(commitOwnerFormUpdate).toHaveBeenCalledWith(
      taskId,
      { status: "open", message: "Continue with the Board follow-up." },
      expect.objectContaining({ kind: "board", recipient: "owner" }),
    );
  });

  it("does not perform a second mutation when the lifecycle transition rejects", async () => {
    const { db, router, commitOwnerFormUpdate } = setupBoard({
      lifecycle: async () => {
        throw new Error("Task lifecycle transition is invalid");
      },
    });

    await expect(router.routeExecution(
      parseBoardManagedTool("task_update", {
        companyId,
        taskId,
        status: "done",
        message: "Attempt a terminal transition.",
        recipient: "creator",
      }),
      { authority: boardAuthority },
    )).rejects.toThrow("Task lifecycle transition is invalid");
    expect(commitOwnerFormUpdate).toHaveBeenCalledTimes(1);
    expect(db.calls.some((call) => call.operation === "update")).toBe(false);
  });

  it("returns an explicit agent together with reporting descendants", async () => {
    const rootAgentId = "00000000-0000-4000-8000-000000000011";
    const directReportId = "00000000-0000-4000-8000-000000000012";
    const nestedReportId = "00000000-0000-4000-8000-000000000013";
    const siblingId = "00000000-0000-4000-8000-000000000014";
    const companyAgents = [
      { id: rootAgentId, reportsTo: null },
      { id: directReportId, reportsTo: rootAgentId },
      { id: nestedReportId, reportsTo: directReportId },
      { id: siblingId, reportsTo: null },
    ];
    agentServiceMocks.list.mockResolvedValue(companyAgents);
    const router = createPaperclipManagedToolRouter({
      db: createMockDb().db,
      agentRunActions: {} as AgentRunManagedActionPort,
      ordinaryTasks: () => ({} as OrdinaryTaskRuntime),
      retrieval: () => ({} as never),
      pluginDomainEvents: { publish: vi.fn() } as never,
    });

    await expect(router.routeExecution(
      parseBoardManagedTool("list_agents", { companyId, agentId: rootAgentId }),
      { authority: boardAuthority },
    )).resolves.toEqual({
      agents: [companyAgents[0], companyAgents[1], companyAgents[2]],
    });
    expect(agentServiceMocks.list).toHaveBeenCalledWith(companyId, {
      includeTerminated: false,
    });
  });

  it("does not expose mention_board through the Board catalog", () => {
    expect(() => parseBoardManagedTool("mention_board" as never, {
      companyId,
      taskId,
      message: "Alias attempt",
    })).toThrow();
  });
});
