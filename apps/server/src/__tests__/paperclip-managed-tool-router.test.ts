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

vi.mock("../services/agents.js", () => ({
  agentService: () => agentServiceMocks,
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
    capability: { companyId } as AgentRunToolAuthority["capability"],
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
  const taskAssign = vi.fn(async () => ({ status: "assigned" }));
  const agentRunActions = {
    taskAssign,
  } as unknown as AgentRunManagedActionPort;
  const listCompanyTasks = vi.fn(async () => ({ tasks: [] }));
  const retrieval = { listCompanyTasks };
  const router = createPaperclipManagedToolRouter({
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
      {
        authority: authority(),
        resolveRuntimeScope: async () => runtimeScope as never,
      },
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

function setupBoard(options: { lifecycle?: () => Promise<unknown> } = {}) {
  const db = createMockDb({ select: [[boardTaskRow()], [], []] });
  const commitOwnerFormUpdate = vi.fn(
    options.lifecycle ?? (async () => ({
      task: { id: taskId },
      comment: { id: "00000000-0000-4000-8000-000000000004" },
      retried: false,
    })),
  );
  const ordinaryTasks = {
    commitOwnerFormUpdate,
    boardReopen: vi.fn(),
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
  return { db, commitOwnerFormUpdate, publish, router };
}

describe("Board MCP managed-tool routing", () => {
  it("uses the canonical owner-form lifecycle transaction and plugin event", async () => {
    const { router, commitOwnerFormUpdate, publish } = setupBoard();
    const structuredResult = { artifact: "report.json" };

    const result = await router.routeExecution(
      parseBoardManagedTool("task_update", {
        companyId,
        taskId,
        status: "done",
        message: "The Board verified the result.",
        structuredResult,
      }),
      { authority: boardAuthority },
    );

    expect(result).toEqual({
      taskId,
      lifecycle: {
        task: { id: taskId },
        comment: { id: "00000000-0000-4000-8000-000000000004" },
        retried: false,
      },
    });
    expect(commitOwnerFormUpdate).toHaveBeenCalledWith(
      taskId,
      {
        status: "done",
        message: "The Board verified the result.",
        structuredResult,
      },
      expect.objectContaining({
        kind: "board",
        companyId,
        actorUserId: userId,
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
      title: "This must not be persisted",
      status: "blocked",
    })).toThrow("A lifecycle status update requires a message");
    expect(commitOwnerFormUpdate).not.toHaveBeenCalled();
  });

  it("does not update a title when the lifecycle transition rejects", async () => {
    const { db, router, commitOwnerFormUpdate } = setupBoard({
      lifecycle: async () => {
        throw new Error("Task lifecycle transition is invalid");
      },
    });

    await expect(router.routeExecution(
      parseBoardManagedTool("task_update", {
        companyId,
        taskId,
        title: "This must not be persisted",
        status: "done",
        message: "Attempt a terminal transition.",
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
