import { Router, type Request } from "express";
import { RUN_TOOLS_INGRESS_ORDINAL_HEADER } from "@paperclipai/adapter-utils/run-tools-stdio-proxy";
import { decodeToolResult } from "@paperclipai/plugin-sdk";
import {
  PromptCapabilityAuthenticationError,
  PromptCapabilityAuthorityError,
  type PromptCapabilityGateway,
  type PromptCapabilityToolExecutionResult,
} from "../services/prompt-capability-gateway.js";
import { RuntimeToolUnavailable } from "../services/runtime-tool-errors.js";

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: "initialize" | "tools/list" | "tools/call";
  params?: unknown;
}

const RUN_TOOLS_INSTRUCTIONS =
  "Paperclip-managed tools exposed by this server are already available in your tool catalog; invoke them directly without a separate discovery step. Use them for Paperclip company, issue, project, and agent state or mutations, and never substitute repository, catalog, or configuration-file edits for Paperclip actions.";

function bearer(req: Request): string {
  const authorization = req.header("authorization")?.trim() ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  if (!match?.[1]) {
    throw new PromptCapabilityAuthenticationError(
      "paperclip.run-tools/v1 requires its prompt-capability bearer",
    );
  }
  return match[1];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requestBody(value: unknown): JsonRpcRequest {
  if (!isRecord(value) || value.jsonrpc !== "2.0") {
    throw new Error("Invalid JSON-RPC request");
  }
  if (
    value.method !== "initialize" &&
    value.method !== "tools/list" &&
    value.method !== "tools/call"
  ) {
    throw new Error("Unsupported paperclip.run-tools method");
  }
  return value as unknown as JsonRpcRequest;
}

function callParams(value: unknown): {
  name: string;
  arguments: unknown;
} {
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    value.name.length === 0 ||
    Object.keys(value).some(
      (key) => key !== "name" && key !== "arguments" && key !== "_meta",
    )
  ) {
    throw new Error("Invalid tools/call parameters");
  }
  if (value._meta !== undefined) {
    if (!isRecord(value._meta)) {
      throw new Error("Invalid tools/call request metadata");
    }
    const progressToken = value._meta.progressToken;
    if (
      progressToken !== undefined &&
      typeof progressToken !== "string" &&
      (
        typeof progressToken !== "number" ||
        !Number.isFinite(progressToken)
      )
    ) {
      throw new Error("Invalid tools/call progress token");
    }
  }
  return {
    name: value.name,
    // MCP request metadata belongs to the transport envelope. It neither
    // changes the managed-tool arguments nor participates in their digest.
    arguments: value.arguments ?? {},
  };
}

function ingressOrdinal(req: Request): number {
  const raw = req.header(RUN_TOOLS_INGRESS_ORDINAL_HEADER)?.trim();
  if (!raw || !/^(?:0|[1-9][0-9]*)$/.test(raw)) {
    throw new Error(
      "tools/call requires its private nonnegative ingress ordinal",
    );
  }
  const ordinal = Number(raw);
  if (!Number.isSafeInteger(ordinal)) {
    throw new Error(
      "tools/call ingress ordinal exceeds the supported integer range",
    );
  }
  return ordinal;
}

async function registerTerminalInvalidToolsCall(input: {
  gateway: PromptCapabilityGateway;
  bearer: string;
  ingressOrdinal: number;
  body: Record<string, unknown>;
  error: unknown;
}): Promise<void> {
  const params = isRecord(input.body.params) ? input.body.params : null;
  const callIdentity =
    Object.prototype.hasOwnProperty.call(input.body, "id")
    && (
      typeof input.body.id === "string"
      || typeof input.body.id === "number"
    )
      ? { source: "jsonrpc" as const, id: input.body.id }
      : null;
  await input.gateway.registerTerminalInvalidToolCall({
    bearer: input.bearer,
    toolName:
      typeof params?.name === "string" && params.name.length > 0
        ? params.name
        : null,
    // A terminal-invalid row digests the exact malformed params envelope so
    // identity replay cannot silently change an extra/invalid params field.
    arguments: input.body.params ?? null,
    callIdentity,
    ingressOrdinal: input.ingressOrdinal,
    error: input.error,
  });
}

function jsonRpcError(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: Record<string, unknown>,
) {
  return {
    jsonrpc: "2.0" as const,
    id,
    error: {
      code,
      message,
      ...(data ? { data } : {}),
    },
  };
}

function text(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value) ?? "null";
}

function structuredContent(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function mcpToolResult(result: PromptCapabilityToolExecutionResult) {
  if (result.source !== "plugin") {
    const structured = structuredContent(result.value);
    return {
      content: [{ type: "text" as const, text: text(result.value) }],
      ...(structured ? { structuredContent: structured } : {}),
    };
  }

  const value = decodeToolResult(result.value);
  if (value.ok) {
    return {
      content: [{ type: "text" as const, text: value.content }],
      ...(value.data === undefined ? {} : { structuredContent: value.data }),
    };
  }
  return {
    content: [{ type: "text" as const, text: value.error }],
    ...(value.data === undefined ? {} : { structuredContent: value.data }),
    isError: true,
  };
}

/**
 * The only provider-facing Paperclip capability endpoint. It has no selector,
 * session-creation, generic API, profile, or alternate capability fallback.
 */
export function runToolsRoutes(gateway: PromptCapabilityGateway) {
  const router = Router();

  router.post("/run-tools", async (req, res) => {
    let body: JsonRpcRequest;
    try {
      const rawToolsCall =
        isRecord(req.body) && req.body.method === "tools/call"
          ? req.body
          : null;
      const rawCallBearer = rawToolsCall ? bearer(req) : null;
      const rawCallIngressOrdinal = rawToolsCall
        ? ingressOrdinal(req)
        : null;
      try {
        body = requestBody(req.body);
      } catch (error) {
        if (
          rawToolsCall
          && rawCallBearer
          && rawCallIngressOrdinal !== null
        ) {
          await registerTerminalInvalidToolsCall({
            gateway,
            bearer: rawCallBearer,
            ingressOrdinal: rawCallIngressOrdinal,
            body: rawToolsCall,
            error,
          });
        }
        throw error;
      }
      const token = rawCallBearer ?? bearer(req);
      if (body.method === "initialize") {
        // Authentication is exercised by dynamic discovery; initialize never
        // returns identity, issue scope, or a static catalog.
        await gateway.listTools(token);
        res.json({
          jsonrpc: "2.0",
          id: body.id ?? null,
          result: {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            instructions: RUN_TOOLS_INSTRUCTIONS,
            serverInfo: {
              name: "paperclip.run-tools",
              version: "1",
            },
          },
        });
        return;
      }
      if (body.method === "tools/list") {
        const tools = await gateway.listTools(token);
        res.json({
          jsonrpc: "2.0",
          id: body.id ?? null,
          result: {
            tools: tools.map((tool) => ({
              name: tool.name,
              title: tool.title,
              description: tool.description,
              inputSchema: tool.inputSchema,
            })),
          },
        });
        return;
      }

      const ordinal = rawCallIngressOrdinal!;
      const callIdentity =
        Object.prototype.hasOwnProperty.call(body, "id")
        && (typeof body.id === "string" || typeof body.id === "number")
          ? { source: "jsonrpc" as const, id: body.id }
          : null;
      let params: ReturnType<typeof callParams>;
      try {
        if (!callIdentity) {
          throw new Error(
            "tools/call requires a string or number JSON-RPC id",
          );
        }
        params = callParams(body.params);
      } catch (error) {
        await registerTerminalInvalidToolsCall({
          gateway,
          bearer: token,
          ingressOrdinal: ordinal,
          body: body as unknown as Record<string, unknown>,
          error,
        });
        throw error;
      }
      const result = await gateway.callTool({
        bearer: token,
        toolName: params.name,
        arguments: params.arguments,
        ingressOrdinal: ordinal,
        callIdentity,
      });
      res.json({
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: mcpToolResult(result),
      });
    } catch (error) {
      const id =
        typeof req.body?.id === "string" ||
        typeof req.body?.id === "number" ||
        req.body?.id === null
          ? req.body.id
          : null;
      if (error instanceof PromptCapabilityAuthenticationError) {
        res
          .status(401)
          .json(jsonRpcError(id, -32001, error.message, { code: error.code }));
        return;
      }
      if (error instanceof PromptCapabilityAuthorityError) {
        res
          .status(409)
          .json(jsonRpcError(id, -32002, error.message, { code: error.code }));
        return;
      }
      if (error instanceof RuntimeToolUnavailable) {
        res
          .status(403)
          .json(jsonRpcError(id, -32601, error.message, { code: error.code }));
        return;
      }
      res.status(400).json(
        jsonRpcError(
          id,
          -32600,
          error instanceof Error ? error.message : "Invalid request",
        ),
      );
    }
  });

  return router;
}
