import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetExperimental = vi.hoisted(() => vi.fn());
const mockOrdinaryIssues = vi.hoisted(() => ({
  create: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  instanceSettingsService: () => ({ getExperimental: mockGetExperimental }),
}));

vi.mock("../routes/authz.js", () => ({
  assertBoard: (req: Express.Request) => {
    req.actor = {
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      memberships: [],
      isInstanceAdmin: false,
      source: "session",
    };
  },
  assertCompanyAccess: () => {},
}));

async function createApp() {
  const { boardChatRoutes } = await import("../routes/board-chat.js");
  const app = express();
  app.use(express.json());
  app.use(
    "/api",
    boardChatRoutes({} as never, {
      ordinaryIssues: mockOrdinaryIssues as never,
    }),
  );
  return app;
}

describe("POST /api/board/chat/messages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 403 FEATURE_DISABLED before creating an issue", async () => {
    mockGetExperimental.mockResolvedValue({
      enableConferenceRoomChat: false,
    });
    const app = await createApp();

    const res = await request(app)
      .post("/api/board/chat/messages")
      .send({
        companyId: "company-1",
        agentId: "agent-1",
        message: "hello",
      });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: "Conference Room Chat is not enabled",
      code: "FEATURE_DISABLED",
    });
    expect(mockOrdinaryIssues.create).not.toHaveBeenCalled();
  });

  it("validates the ordinary issue form after the feature gate", async () => {
    mockGetExperimental.mockResolvedValue({
      enableConferenceRoomChat: true,
    });
    const app = await createApp();

    const res = await request(app)
      .post("/api/board/chat/messages")
      .send({});

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: "companyId, agentId, and message are required",
    });
  });

  it("creates one ordinary issue and preserves the exact request bytes", async () => {
    mockGetExperimental.mockResolvedValue({
      enableConferenceRoomChat: true,
    });
    const rawMessage = "  Keep these boundary spaces.\n";
    mockOrdinaryIssues.create.mockResolvedValue({
      issue: {
        id: "issue-1",
        companyId: "company-1",
        request: rawMessage,
      },
      ref: { id: "ref-1" },
      retried: false,
    });
    const app = await createApp();

    const res = await request(app)
      .post("/api/board/chat/messages")
      .send({
        companyId: "company-1",
        agentId: "agent-1",
        message: rawMessage,
        idempotencyKey: "chat-request-1",
      });

    expect(res.status).toBe(201);
    expect(mockOrdinaryIssues.create).toHaveBeenCalledWith({
      companyId: "company-1",
      request: rawMessage,
      ownerAgentId: "agent-1",
      creator: {
        kind: "user/board",
        userId: "user-1",
      },
      idempotencyKey: "chat-request-1",
      sourceKind: "board_chat",
      title: "Board Chat",
      priority: "medium",
      contextAccessMask: null,
    });
    expect(res.body).toMatchObject({
      issueId: "issue-1",
      refId: "ref-1",
      retried: false,
    });
  });

  it("normalizes initial issue context access and rejects malformed masks", async () => {
    mockGetExperimental.mockResolvedValue({
      enableConferenceRoomChat: true,
    });
    mockOrdinaryIssues.create.mockResolvedValue({
      issue: { id: "issue-1", companyId: "company-1" },
      ref: { id: "ref-1" },
      retried: false,
    });
    const app = await createApp();

    await request(app)
      .post("/api/board/chat/messages")
      .send({
        companyId: "company-1",
        agentId: "agent-1",
        message: "hello",
        contextAccessMask: {
          carry_context: true,
          read_issue_comments: false,
        },
      })
      .expect(201);

    expect(mockOrdinaryIssues.create).toHaveBeenCalledWith(
      expect.objectContaining({
        contextAccessMask: { read_issue_comments: false },
      }),
    );

    const malformed = await request(app)
      .post("/api/board/chat/messages")
      .send({
        companyId: "company-1",
        agentId: "agent-1",
        message: "hello",
        contextAccessMask: { unknown_context: false },
      });
    expect(malformed.status).toBe(400);
    expect(mockOrdinaryIssues.create).toHaveBeenCalledTimes(1);
  });

  it("rejects follow-ups because the special route is creation-only", async () => {
    mockGetExperimental.mockResolvedValue({
      enableConferenceRoomChat: true,
    });
    const app = await createApp();

    const res = await request(app)
      .post("/api/board/chat/messages")
      .send({
        companyId: "company-1",
        agentId: "agent-1",
        issueId: "issue-1",
        message: "\nFollow up exactly.\n",
        idempotencyKey: "chat-follow-up-1",
      });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: "Board Chat accepts creation fields only",
      code: "BOARD_CHAT_CREATION_ONLY",
    });
    expect(mockOrdinaryIssues.create).not.toHaveBeenCalled();
  });

  it("rejects context access on a follow-up", async () => {
    mockGetExperimental.mockResolvedValue({
      enableConferenceRoomChat: true,
    });
    const app = await createApp();

    const res = await request(app)
      .post("/api/board/chat/messages")
      .send({
        companyId: "company-1",
        agentId: "agent-1",
        issueId: "issue-1",
        message: "follow up",
        contextAccessMask: { carry_context: false },
      });

    expect(res.status).toBe(400);
    expect(mockOrdinaryIssues.create).not.toHaveBeenCalled();
  });
});
