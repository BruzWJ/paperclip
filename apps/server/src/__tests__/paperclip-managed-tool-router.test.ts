import { describe, expect, it, vi } from "vitest";
import type { OrdinaryIssueRuntime } from "../services/ordinary-issue-runtime.js";
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
const issueId = "00000000-0000-4000-8000-000000000002";
const userId = "board-user-1";

const boardAuthority: BoardUserToolAuthority = {
  kind: "board_user",
  userId,
  credentialId: "board-key-1",
  companyIds: [companyId],
  companies: [],
  requestId: 1,
};

function issueRow() {
  return {
    id: issueId,
    companyId,
    ownershipEpoch: 1,
    boardPresentationStatus: "open",
    title: "Before lifecycle update",
  };
}

function setup(options: { lifecycle?: () => Promise<unknown> } = {}) {
  const db = createMockDb({
    // `issueInBoardScope` and its canonical label enrichment.
    select: [[issueRow()], [], []],
  });
  const commitOwnerFormUpdate = vi.fn(
    options.lifecycle ?? (async () => ({
      issue: { id: issueId },
      comment: { id: "00000000-0000-4000-8000-000000000003" },
      retried: false,
    })),
  );
  const ordinaryIssues = {
    commitOwnerFormUpdate,
    boardReopen: vi.fn(),
    userComment: vi.fn(),
  } as unknown as OrdinaryIssueRuntime;
  const publish = vi.fn();
  const router = createPaperclipManagedToolRouter({
    db: db.db,
    agentRunActions: {} as AgentRunManagedActionPort,
    ordinaryIssues: () => ordinaryIssues,
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

describe("Paperclip managed-tool router Board issue_update", () => {
  it("uses the canonical owner-form lifecycle transaction with Board authority", async () => {
    const { router, commitOwnerFormUpdate, publish } = setup();
    const structuredResult = { artifact: "report.json" };

    const result = await router.routeExecution(
      parseBoardManagedTool("issue_update", {
        companyId,
        issueId,
        status: "done",
        message: "The Board verified the result.",
        structuredResult,
      }),
      { authority: boardAuthority },
    );

    expect(result).toEqual({
      issueId,
      lifecycle: {
        issue: { id: issueId },
        comment: { id: "00000000-0000-4000-8000-000000000003" },
        retried: false,
      },
    });
    expect(commitOwnerFormUpdate).toHaveBeenCalledWith(
      issueId,
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
          "paperclip-tool:issue_update:",
        ),
      }),
    );
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      eventId: "00000000-0000-4000-8000-000000000003",
      eventType: "issue.board.comment.created",
      companyId,
      payload: {
        companyId,
        issueId,
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
      ordinaryIssues: () => ({
        commitOwnerFormUpdate,
      }) as unknown as OrdinaryIssueRuntime,
      retrieval: () => ({} as never),
      pluginDomainEvents: { publish: vi.fn() } as never,
    });
    expect(() => parseBoardManagedTool("issue_update", {
      companyId,
      issueId,
      title: "This must not be persisted",
      status: "blocked",
    })).toThrow("A lifecycle status update requires a message");

    expect(commitOwnerFormUpdate).not.toHaveBeenCalled();
    expect(db.calls).toEqual([]);
  });

  it("does not update a title before a canonical lifecycle transition rejects", async () => {
    const { db, router, commitOwnerFormUpdate } = setup({
      lifecycle: async () => {
        throw new Error("Issue lifecycle transition is invalid");
      },
    });

    await expect(
      router.routeExecution(
        parseBoardManagedTool("issue_update", {
          companyId,
          issueId,
          title: "This must not be persisted",
          status: "done",
          message: "Attempt a terminal transition.",
        }),
        { authority: boardAuthority },
      ),
    ).rejects.toThrow("Issue lifecycle transition is invalid");

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
      ordinaryIssues: () => ({} as OrdinaryIssueRuntime),
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
