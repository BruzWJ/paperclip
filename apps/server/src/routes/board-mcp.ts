import { Router } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { companies, type Db } from "@paperclipai/db";
import { inArray } from "drizzle-orm";
import { createBoardMcpServer } from "../services/board-mcp-server.js";
import {
  boardToolAuthority,
  type PaperclipManagedToolRouter,
} from "../services/paperclip-managed-tool-router.js";

const BOARD_MCP_MAX_JSON_RPC_BATCH_SIZE = 10;

function requestId(value: unknown): string | number | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = (value as Record<string, unknown>).id;
  return typeof id === "string" || typeof id === "number" ? id : null;
}

function jsonRpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: Record<string, unknown>,
) {
  return {
    jsonrpc: "2.0" as const,
    id,
    error: { code, message, ...(data ? { data } : {}) },
  };
}

/** Stateless, board-key-authenticated Streamable HTTP MCP transport. */
export function boardMcpRoutes(input: { db: Db; managedTools: PaperclipManagedToolRouter }) {
  const router = Router({ caseSensitive: true, strict: true });

  router.post("/mcp", async (req, res) => {
    if (req.actor.type !== "board" || req.actor.source !== "board_key") {
      res.status(401).json(
        jsonRpcError(requestId(req.body), -32001, "Board API key required", {
          code: "board_mcp_authentication_required",
        }),
      );
      return;
    }
    if (Array.isArray(req.body) && req.body.length > BOARD_MCP_MAX_JSON_RPC_BATCH_SIZE) {
      res.status(400).json(
        jsonRpcError(null, -32600, "JSON-RPC batch is too large", {
          code: "board_mcp_batch_too_large",
          maxBatchSize: BOARD_MCP_MAX_JSON_RPC_BATCH_SIZE,
        }),
      );
      return;
    }

    const companyRows =
      req.actor.companyIds.length === 0
        ? []
        : await input.db
            .select({ id: companies.id, name: companies.name })
            .from(companies)
            .where(inArray(companies.id, req.actor.companyIds));
    const membershipRoleByCompanyId = new Map(
      req.actor.memberships.map((membership) => [membership.companyId, membership.membershipRole ?? null]),
    );
    const authority = boardToolAuthority({
      actor: req.actor,
      requestId: requestId(req.body),
      companies: companyRows.map((company) => ({
        ...company,
        membershipRole: membershipRoleByCompanyId.get(company.id) ?? null,
      })),
    });
    const server = createBoardMcpServer({
      authority,
      managedTools: input.managedTools,
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent) {
        res.status(500).json(
          jsonRpcError(requestId(req.body), -32603, "Board MCP request failed", {
            code: "board_mcp_transport_error",
          }),
        );
      }
    } finally {
      await server.close().catch(() => undefined);
    }
  });

  router.all("/mcp", (_req, res) => {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "Method not allowed" });
  });

  return router;
}
