import { describe, expect, it, vi } from "vitest";
import type { OrdinaryTaskRuntime } from "../services/ordinary-task-runtime.js";
import { parseBoardManagedTool } from "../services/paperclip-managed-tool-registry.js";
import {
  createPaperclipManagedToolRouter,
  type AgentRunManagedActionPort,
  type BoardUserToolAuthority,
} from "../services/paperclip-managed-tool-router.js";
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
const userId = "board-user-1";

const boardAuthority: BoardUserToolAuthority = {
  kind: "board_user",
  userId,
  credentialId: "board-key-1",
  companyIds: [companyId],
  companies: [],
  requestId: 1,
};

function taskRow() {
  return {
    id: taskId,
    companyId,
    ownershipEpoch: 1,
    boardPresentationStatus: "open",
    title: "Before lifecycle update",
  };
}

function setup(options: { lifecycle?: () => Promise<unknown> } = {}) {
  const db = createMockDb({
    // `taskInBoardScope` and its canonical label enrichment.
    select: [[taskRow()], [], []],
  });
  const commitOwnerFormUpdate = vi.fn(
    options.lifecycle ?? (async () => ({
      task: { id: taskId },
      comment: { id: "00000000-0000-4000-8000-000000000003" },
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

  return {
    db,
    commitOwnerFormUpdate,
    publish,
    router,
  };
}

describe("Paperclip managed-tool router Board task_update", () => {
  it("uses the canonical owner-form lifecycle transaction with Board authority", async () => {
    const { router, commitOwnerFormUpdate, publish } = setup();
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
        comment: { id: "00000000-0000-4000-8000-000000000003" },
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
      eventId: "00000000-0000-4000-8000-000000000003",
      eventType: "task.board.comment.created",
      companyId,
      payload: {
        companyId,
        taskId,
        commentId: "00000000-0000-4000-8000-000000000003",
      },
    }));
  });

  it("rejects an invalid lifecycle payload before any Board mutation begins", async () => {
    const db = createMockDb();
    const commitOwnerFormUpdate = vi.fn();
    const router = createPaperclipManagedToolRouter({
      db: db.db,
      agentRunActions: {} as AgentRunManagedActionPort,
      ordinaryTasks: () => ({
        commitOwnerFormUpdate,
      }) as unknown as OrdinaryTaskRuntime,
      retrieval: () => ({} as never),
      pluginDomainEvents: { publish: vi.fn() } as never,
    });
    expect(() => parseBoardManagedTool("task_update", {
      companyId,
      taskId,
      title: "This must not be persisted",
      status: "blocked",
    })).toThrow("A lifecycle status update requires a message");

    expect(commitOwnerFormUpdate).not.toHaveBeenCalled();
    expect(db.calls).toEqual([]);
  });

  it("does not update a title before a canonical lifecycle transition rejects", async () => {
    const { db, router, commitOwnerFormUpdate } = setup({
      lifecycle: async () => {
        throw new Error("Task lifecycle transition is invalid");
      },
    });

    await expect(
      router.routeExecution(
        parseBoardManagedTool("task_update", {
          companyId,
          taskId,
          title: "This must not be persisted",
          status: "done",
          message: "Attempt a terminal transition.",
        }),
        { authority: boardAuthority },
      ),
    ).rejects.toThrow("Task lifecycle transition is invalid");

    expect(commitOwnerFormUpdate).toHaveBeenCalledTimes(1);
    expect(db.calls.some((call) => call.operation === "update")).toBe(false);
  });
});

describe("Board managed list_agents", () => {
  it("returns an explicit target together with its reporting descendants", async () => {
    const rootAgentId = "00000000-0000-4000-8000-000000000011";
    const directReportId = "00000000-0000-4000-8000-000000000012";
    const nestedReportId = "00000000-0000-4000-8000-000000000013";
    const siblingId = "00000000-0000-4000-8000-000000000014";
    const agents = [
      { id: rootAgentId, reportsTo: null },
      { id: directReportId, reportsTo: rootAgentId },
      { id: nestedReportId, reportsTo: directReportId },
      { id: siblingId, reportsTo: null },
    ];
    agentServiceMocks.list.mockResolvedValue(agents);

    const router = createPaperclipManagedToolRouter({
      db: createMockDb().db,
      agentRunActions: {} as AgentRunManagedActionPort,
      ordinaryTasks: () => ({} as OrdinaryTaskRuntime),
      retrieval: () => ({} as never),
      pluginDomainEvents: { publish: vi.fn() } as never,
    });
    const result = await router.routeExecution(
      parseBoardManagedTool("list_agents", { companyId, agentId: rootAgentId }),
      { authority: boardAuthority },
    );

    expect(result).toEqual({
      agents: [agents[0], agents[1], agents[2]],
    });
    expect(agentServiceMocks.list).toHaveBeenCalledWith(companyId, {
      includeTerminated: false,
    });
  });
});
