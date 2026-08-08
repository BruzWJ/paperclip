import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  paperclipManagedToolPublicError,
  type BoardUserToolAuthority,
  type PaperclipManagedToolRouter,
} from "./paperclip-managed-tool-router.js";
import {
  BOARD_MANAGED_TOOLS,
  parseBoardManagedTool,
} from "./paperclip-managed-tool-registry.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return JSON.stringify({ value: String(value) });
  }
}

function successResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: jsonText(value) }],
    structuredContent: isRecord(value) ? value : { value },
  };
}

function errorResult(error: unknown) {
  const publicError = paperclipManagedToolPublicError(error);
  return {
    content: [{ type: "text" as const, text: jsonText({ error: publicError }) }],
    structuredContent: { error: publicError },
    isError: true,
  };
}

/**
 * Streamable-HTTP SDK adapter only. It owns MCP envelopes and instructions;
 * it has no Board tool handlers or domain-service dependencies. Every call
 * crosses the same app-owned `PaperclipManagedToolRouter` as ACPX.
 */
export function createBoardMcpServer(input: {
  authority: BoardUserToolAuthority;
  managedTools: PaperclipManagedToolRouter;
}) {
  const companyLines = input.authority.companies.map(
    (company) =>
      `- ${company.name}: companyId=${company.id}, membershipRole=${company.membershipRole ?? "member"}`,
  );
  const server = new McpServer(
    { name: "paperclip-board-mcp", version: "1" },
    {
      instructions: [
        "Paperclip Board MCP exposes Paperclip-managed tools for trusted local coding agents acting as the authenticated board user.",
        "Local MCP config stores only this board API key. Do not store companyId, issueId, agentId, runId, or other entity targets in the local MCP config.",
        "Use tools/list as the source of truth for each tool input schema. Every listed Paperclip action and context reader is available without agent action grants, context dials, or mention-reach grants. Mutating tools execute directly for the authenticated board key. mention_board is intentionally unavailable because this MCP is already the board.",
        "mention_agent uses the canonical Board comment mention path, so agentId must be the issue's current owner.",
        "Accessible companies for the authenticated board user:",
        ...(companyLines.length > 0 ? companyLines : ["- No accessible companies"]),
      ].join("\n"),
    },
  );

  for (const tool of BOARD_MANAGED_TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: { readOnlyHint: tool.readOnly },
      },
      async (arguments_) => {
        try {
          return successResult(
            await input.managedTools.routeExecution(
              parseBoardManagedTool(tool.name, arguments_),
              { authority: input.authority },
            ),
          );
        } catch (error) {
          return errorResult(error);
        }
      },
    );
  }

  // Match the TradingGoose tools-only contract explicitly.
  server.server.registerCapabilities({ prompts: {}, resources: {} });
  server.server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [] }));
  server.server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));
  server.server.setRequestHandler(
    ListResourceTemplatesRequestSchema,
    async () => ({ resourceTemplates: [] }),
  );
  return server;
}
