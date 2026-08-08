import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import type { PaperclipManagedToolRouter } from "../services/paperclip-managed-tool-router.js";
import { boardMcpRoutes } from "../routes/board-mcp.js";

const companyId = "00000000-0000-4000-8000-000000000001";
const userId = "board-user-1";
const boardApiKeyId = "board-key-1";
const issueId = "00000000-0000-4000-8000-000000000002";
const targetAgentId = "00000000-0000-4000-8000-000000000003";

const mocks = vi.hoisted(() => ({
  routeExecution: vi.fn(),
}));

function fakeDb() {
  return {
    select: () => ({
      from: () => ({
        where: async () => [{ id: companyId, name: "Acme Board" }],
      }),
    }),
  } as unknown as Db;
}

function createApp(authenticated = true) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = authenticated
      ? {
          type: "board",
          source: "board_key",
          keyId: boardApiKeyId,
          userId,
          userName: null,
          userEmail: null,
          companyIds: [companyId],
          memberships: [{ companyId, membershipRole: "viewer", status: "active" }],
          isInstanceAdmin: false,
        }
      : { type: "none", source: "none" };
    next();
  });
  app.use(boardMcpRoutes({
    db: fakeDb(),
    managedTools: {
      routeExecution: mocks.routeExecution,
    } as unknown as PaperclipManagedToolRouter,
  }));
  return app;
}

const initializeRequest = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "Paperclip test", version: "1" },
  },
};

describe("Board MCP route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.routeExecution.mockResolvedValue({ agents: [] });
  });

  it("places accessible companies in initialize instructions instead of a list_companies tool", async () => {
    await request(createApp())
      .post("/mcp")
      .set("accept", "application/json, text/event-stream")
      .send(initializeRequest)
      .expect(200)
      .expect(({ body }) => {
        expect(body.result.instructions).toContain(
          `- Acme Board: companyId=${companyId}, membershipRole=viewer`,
        );
        expect(body.result.instructions).toContain("mention_board is intentionally unavailable");
        expect(body.result.instructions).not.toContain("list_companies");
      });
  });

  it("exposes the complete managed-tool catalog without list_companies or mention_board", async () => {
    await request(createApp())
      .post("/mcp")
      .set("accept", "application/json, text/event-stream")
      .send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
      .expect(200)
      .expect(({ body }) => {
        const names = body.result.tools.map((tool: { name: string }) => tool.name);
        expect(names).toContain("issue_create");
        expect(names).toContain("mention_agent");
        expect(names).toContain("read_issue_agent_run");
        expect(names).not.toContain("list_companies");
        expect(names).not.toContain("mention_board");
      });
  });

  it("calls the same app-owned managed-tool router used by ACPX", async () => {
    await request(createApp())
      .post("/mcp")
      .set("accept", "application/json, text/event-stream")
      .send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "list_agents", arguments: { companyId } },
      })
      .expect(200)
      .expect(({ body }) => {
        expect(body.result.structuredContent).toEqual({ agents: [] });
      });

    expect(mocks.routeExecution).toHaveBeenCalledWith(
      { name: "list_agents", companyId },
      expect.objectContaining({
        authority: expect.objectContaining({ kind: "board_user", userId, credentialId: boardApiKeyId }),
      }),
    );
  });

  it("forwards mention_agent's explicit target agentId unchanged", async () => {
    await request(createApp())
      .post("/mcp")
      .set("accept", "application/json, text/event-stream")
      .send({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "mention_agent",
          arguments: {
            companyId,
            issueId,
            agentId: targetAgentId,
            message: "Please review this issue.",
          },
        },
      })
      .expect(200);

    expect(mocks.routeExecution).toHaveBeenCalledWith(
      {
        name: "mention_agent",
        companyId,
        issueId,
        agentId: targetAgentId,
        message: "Please review this issue.",
      },
      expect.any(Object),
    );
  });

  it("requires the existing board-key actor", async () => {
    await request(createApp(false))
      .post("/mcp")
      .set("accept", "application/json, text/event-stream")
      .send(initializeRequest)
      .expect(401)
      .expect(({ body }) => {
        expect(body.error.data.code).toBe("board_mcp_authentication_required");
      });
  });
});
