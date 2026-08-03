// PAPERCLIP_REMOVAL_NEGATIVE_FIXTURE: search_tools, run_tool
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  mcpGatewayProtocolRoutes,
  toolGatewayRoutes,
} from "../routes/tool-gateway.js";
import {
  ToolGatewayHttpError,
  type ToolGatewayService,
} from "../services/tool-gateway.js";
import { PromptCapabilityAuthenticationError } from "../services/prompt-capability-gateway.js";
import { createMockDb } from "./helpers/mock-db.js";
import { testBoardSessionActor } from "./helpers/request-actor.js";

const companyId = "00000000-0000-4000-8000-000000000001";
const gatewayId = "00000000-0000-4000-8000-000000000002";
const gatewayPublicId = "public-gateway";
const slotId = "runtime-slot-1";
const bearerToken = "named-gateway-token";
const runBearer = "pc_run_v1_not-valid-for-named-gateways";

function createGatewayDouble() {
  const gateway = {
    initializeNamedGatewayProtocol: vi.fn(async () => undefined),
    listToolsForNamedGateway: vi.fn(async () => []),
    executeToolForNamedGateway: vi.fn(async () => ({ result: null })),
    listRuntimeSlots: vi.fn(async () => []),
    stopRuntimeSlot: vi.fn(async () => ({ id: slotId, status: "stopped" })),
    restartRuntimeSlot: vi.fn(async () => ({ id: slotId, status: "running" })),
  };
  return gateway as unknown as ToolGatewayService & typeof gateway;
}

type GatewayDouble = ReturnType<typeof createGatewayDouble>;

function createProtocolApp(gateway: GatewayDouble) {
  const app = express();
  app.use(express.json());
  app.use(mcpGatewayProtocolRoutes(gateway));
  return app;
}

function createFullRouteApp(gateway: GatewayDouble) {
  const app = express();
  const harness = createMockDb();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = testBoardSessionActor({
      userId: "board-user",
      companyIds: [companyId],
      isInstanceAdmin: true,
    });
    next();
  });
  app.use(mcpGatewayProtocolRoutes(gateway));
  app.use("/api", toolGatewayRoutes(harness.db, gateway));
  return { app, harness };
}

function rpc(method: string, id: unknown = "request-1", params?: Record<string, unknown>) {
  return {
    jsonrpc: "2.0",
    id,
    method,
    ...(params === undefined ? {} : { params }),
  };
}

describe("tool gateway protocol routes", () => {
  let gateway: GatewayDouble;

  beforeEach(() => {
    vi.clearAllMocks();
    gateway = createGatewayDouble();
  });

  it("exposes named public and board gateway metadata without invoking the service", async () => {
    const { app } = createFullRouteApp(gateway);

    await request(app)
      .get(`/mcp/gateways/${gatewayPublicId}`)
      .expect(200, {
        transport: "streamable_http",
        endpoint: `/mcp/gateways/${gatewayPublicId}`,
        authentication: "bearer",
      });
    await request(app)
      .get(`/api/tool-gateway/gateways/${gatewayId}/mcp`)
      .expect(200, {
        transport: "streamable_http",
        endpoint: `/api/tool-gateway/gateways/${gatewayId}/mcp`,
        authentication: "bearer",
      });

    expect(gateway.initializeNamedGatewayProtocol).not.toHaveBeenCalled();
    expect(gateway.listToolsForNamedGateway).not.toHaveBeenCalled();
    expect(gateway.executeToolForNamedGateway).not.toHaveBeenCalled();
  });

  it("rejects run-scoped prompt capability bearers from named gateway metadata and RPC", async () => {
    const app = createProtocolApp(gateway);

    await request(app)
      .get(`/mcp/gateways/${gatewayPublicId}`)
      .set("authorization", `Bearer ${runBearer}`)
      .expect(401, {
        error: "Prompt-capability bearers are not valid named-gateway credentials",
        code: "prompt_capability_authentication_failed",
      });

    await request(app)
      .post(`/mcp/gateways/${gatewayPublicId}`)
      .set("authorization", `Bearer ${runBearer}`)
      .send(rpc("initialize", 9))
      .expect(401, {
        jsonrpc: "2.0",
        id: 9,
        error: {
          code: -32001,
          message: "Prompt-capability bearers are not valid named-gateway credentials",
          data: { code: "prompt_capability_authentication_failed" },
        },
      });

    expect(gateway.initializeNamedGatewayProtocol).not.toHaveBeenCalled();
  });

  it("requires Bearer authentication before dispatching protocol methods", async () => {
    const app = createProtocolApp(gateway);

    await request(app)
      .post(`/mcp/gateways/${gatewayPublicId}`)
      .send(rpc("initialize"))
      .expect(401, { error: "Bearer token is required" });
    await request(app)
      .post(`/mcp/gateways/${gatewayPublicId}`)
      .set("authorization", "Basic not-supported")
      .send(rpc("tools/list"))
      .expect(401, { error: "Bearer token is required" });

    expect(gateway.initializeNamedGatewayProtocol).not.toHaveBeenCalled();
    expect(gateway.listToolsForNamedGateway).not.toHaveBeenCalled();
  });

  it("initializes the named gateway and returns the canonical MCP capabilities", async () => {
    const app = createProtocolApp(gateway);

    const response = await request(app)
      .post(`/mcp/gateways/${gatewayPublicId}`)
      .set("authorization", `Bearer ${bearerToken}`)
      .set("mcp-client-name", "Codex")
      .send(rpc("initialize", "initialize-1"))
      .expect(200);

    expect(response.body).toEqual({
      jsonrpc: "2.0",
      id: "initialize-1",
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "Paperclip MCP Gateway", version: "1.0.0" },
      },
    });
    expect(gateway.initializeNamedGatewayProtocol).toHaveBeenCalledWith({
      gatewayPublicId,
      bearerToken,
      callerHeaders: expect.objectContaining({
        authorization: `Bearer ${bearerToken}`,
        "mcp-client-name": "Codex",
      }),
    });
  });

  it("accepts the initialized notification without a response body or service dispatch", async () => {
    const app = createProtocolApp(gateway);

    const response = await request(app)
      .post(`/mcp/gateways/${gatewayPublicId}`)
      .set("authorization", `Bearer ${bearerToken}`)
      .send({ jsonrpc: "2.0", method: "notifications/initialized" })
      .expect(202);

    expect(response.text).toBe("");
    expect(gateway.initializeNamedGatewayProtocol).not.toHaveBeenCalled();
    expect(gateway.listToolsForNamedGateway).not.toHaveBeenCalled();
    expect(gateway.executeToolForNamedGateway).not.toHaveBeenCalled();
  });

  it("translates Paperclip tool descriptors into canonical MCP tools/list descriptors", async () => {
    gateway.listToolsForNamedGateway.mockResolvedValueOnce([
      {
        name: "mcp.notes:read_note",
        displayName: "Read note",
        description: "Read one note",
        parametersSchema: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
      },
      {
        name: "paperclip.issue:get",
        displayName: "Get issue",
        description: null,
        parametersSchema: null,
      },
    ] as never);
    const { app } = createFullRouteApp(gateway);

    const response = await request(app)
      .post(`/api/tool-gateway/gateways/${gatewayId}/mcp`)
      .set("authorization", `Bearer ${bearerToken}`)
      .set("mcp-session-id", "session-1")
      .send(rpc("tools/list", 2))
      .expect(200);

    expect(response.body).toEqual({
      jsonrpc: "2.0",
      id: 2,
      result: {
        tools: [
          {
            name: "mcp.notes:read_note",
            title: "Read note",
            description: "Read one note",
            inputSchema: {
              type: "object",
              properties: { id: { type: "string" } },
              required: ["id"],
            },
          },
          {
            name: "paperclip.issue:get",
            title: "Get issue",
            description: null,
            inputSchema: { type: "object", properties: {} },
          },
        ],
      },
    });
    expect(gateway.listToolsForNamedGateway).toHaveBeenCalledWith({
      gatewayId,
      bearerToken,
      callerHeaders: expect.objectContaining({
        authorization: `Bearer ${bearerToken}`,
        "mcp-session-id": "session-1",
      }),
    });
  });

  it("translates a canonical Paperclip tool result into MCP tools/call content", async () => {
    gateway.executeToolForNamedGateway.mockResolvedValueOnce({
      result: {
        content: "Read completed",
        data: { id: "note-1", body: "Canonical result" },
      },
    } as never);
    const app = createProtocolApp(gateway);

    const response = await request(app)
      .post(`/mcp/gateways/${gatewayPublicId}`)
      .set("authorization", `Bearer ${bearerToken}`)
      .set("x-request-id", "request-correlation")
      .send(rpc("tools/call", "call-1", {
        name: "mcp.notes:read_note",
        arguments: { id: "note-1" },
      }))
      .expect(200);

    expect(response.body).toEqual({
      jsonrpc: "2.0",
      id: "call-1",
      result: {
        content: [{ type: "text", text: "Read completed" }],
        structuredContent: { id: "note-1", body: "Canonical result" },
        isError: false,
      },
    });
    expect(gateway.executeToolForNamedGateway).toHaveBeenCalledWith({
      bearerToken,
      gatewayId: null,
      gatewayPublicId,
      tool: "mcp.notes:read_note",
      parameters: { id: "note-1" },
      callerHeaders: expect.objectContaining({
        authorization: `Bearer ${bearerToken}`,
        "x-request-id": "request-correlation",
      }),
    });
  });

  it("serializes result data when the canonical result has no text content", async () => {
    gateway.executeToolForNamedGateway.mockResolvedValueOnce({
      result: { data: { ok: true, count: 2 } },
    } as never);
    const app = createProtocolApp(gateway);

    await request(app)
      .post(`/mcp/gateways/${gatewayPublicId}`)
      .set("authorization", `Bearer ${bearerToken}`)
      .send(rpc("tools/call", 3, {
        name: "mcp.notes:list",
        arguments: {},
      }))
      .expect(200, {
        jsonrpc: "2.0",
        id: 3,
        result: {
          content: [{ type: "text", text: JSON.stringify({ ok: true, count: 2 }) }],
          structuredContent: { ok: true, count: 2 },
          isError: false,
        },
      });
  });

  it("rejects tools/call without params.name before service dispatch", async () => {
    const app = createProtocolApp(gateway);

    await request(app)
      .post(`/mcp/gateways/${gatewayPublicId}`)
      .set("authorization", `Bearer ${bearerToken}`)
      .send(rpc("tools/call", "missing-name", { arguments: { id: "note-1" } }))
      .expect(400, {
        jsonrpc: "2.0",
        id: "missing-name",
        error: { code: -32602, message: "params.name is required" },
      });
    expect(gateway.executeToolForNamedGateway).not.toHaveBeenCalled();
  });

  it("returns canonical JSON-RPC method-not-found for unknown methods", async () => {
    const app = createProtocolApp(gateway);

    await request(app)
      .post(`/mcp/gateways/${gatewayPublicId}`)
      .set("authorization", `Bearer ${bearerToken}`)
      .send(rpc("resources/list", "unknown-method"))
      .expect(404, {
        jsonrpc: "2.0",
        id: "unknown-method",
        error: { code: -32601, message: "Method not found" },
      });
  });

  it("maps prompt-capability authentication failures to the named-gateway JSON-RPC boundary", async () => {
    gateway.listToolsForNamedGateway.mockRejectedValueOnce(
      new PromptCapabilityAuthenticationError("Named gateway bearer expired"),
    );
    const app = createProtocolApp(gateway);

    await request(app)
      .post(`/mcp/gateways/${gatewayPublicId}`)
      .set("authorization", `Bearer ${bearerToken}`)
      .send(rpc("tools/list", "auth-failure"))
      .expect(401, {
        jsonrpc: "2.0",
        id: "auth-failure",
        error: {
          code: -32001,
          message: "Named gateway bearer expired",
          data: { code: "prompt_capability_authentication_failed" },
        },
      });
  });

  it("maps controlled gateway errors to client and server JSON-RPC error codes", async () => {
    const cases = [
      {
        error: new ToolGatewayHttpError(429, "Gateway rate limit exceeded", "gateway_rate_limited", {
          retryAfterMs: 1_000,
        }),
        expectedCode: -32000,
        expectedData: { reasonCode: "gateway_rate_limited", retryAfterMs: 1_000 },
      },
      {
        error: new ToolGatewayHttpError(502, "Remote MCP failed", "remote_mcp_error", {
          upstreamStatus: 503,
        }),
        expectedCode: -32603,
        expectedData: { reasonCode: "remote_mcp_error", upstreamStatus: 503 },
      },
    ];

    for (const [index, entry] of cases.entries()) {
      gateway.executeToolForNamedGateway.mockRejectedValueOnce(entry.error);
      const app = createProtocolApp(gateway);
      await request(app)
        .post(`/mcp/gateways/${gatewayPublicId}`)
        .set("authorization", `Bearer ${bearerToken}`)
        .send(rpc("tools/call", `gateway-error-${index}`, {
          name: "mcp.notes:read_note",
          arguments: {},
        }))
        .expect(entry.error.status, {
          jsonrpc: "2.0",
          id: `gateway-error-${index}`,
          error: {
            code: entry.expectedCode,
            message: entry.error.message,
            data: entry.expectedData,
          },
        });
    }
  });

  it("does not expose retired generic tool gateway endpoints", async () => {
    // PAPERCLIP_REMOVAL_NEGATIVE_FIXTURE: /api/tool-gateway/sessions, /api/tool-gateway/sessions/{sessionId}/revoke
    const { app, harness } = createFullRouteApp(gateway);

    await request(app).post("/api/tool-gateway/sessions").send({}).expect(404);
    await request(app).post("/api/tool-gateway/sessions/session-1/revoke").send({}).expect(404);
    await request(app).get("/api/tool-gateway/tools").expect(404);
    await request(app).post("/api/tool-gateway/tools/call").send({}).expect(404);

    expect(gateway.initializeNamedGatewayProtocol).not.toHaveBeenCalled();
    expect(gateway.listToolsForNamedGateway).not.toHaveBeenCalled();
    expect(gateway.executeToolForNamedGateway).not.toHaveBeenCalled();
    expect(harness.calls).toEqual([]);
  });

  it("delegates runtime slot list, stop, and restart to the runtime supervisor boundary", async () => {
    const listed = [{
      id: slotId,
      companyId,
      status: "running",
      connectionId: "connection-1",
    }];
    const stopped = { id: slotId, companyId, status: "stopped" };
    const restarted = { id: slotId, companyId, status: "starting" };
    gateway.listRuntimeSlots.mockResolvedValueOnce(listed as never);
    gateway.stopRuntimeSlot.mockResolvedValueOnce(stopped as never);
    gateway.restartRuntimeSlot.mockResolvedValueOnce(restarted as never);
    const { app, harness } = createFullRouteApp(gateway);

    await request(app)
      .get("/api/tool-gateway/runtime-slots")
      .query({ companyId })
      .expect(200, listed);
    await request(app)
      .post(`/api/tool-gateway/runtime-slots/${slotId}/stop`)
      .send({ companyId })
      .expect(200, stopped);
    await request(app)
      .post(`/api/tool-gateway/runtime-slots/${slotId}/restart`)
      .query({ companyId })
      .send({})
      .expect(200, restarted);

    expect(gateway.listRuntimeSlots).toHaveBeenCalledWith(companyId);
    expect(gateway.stopRuntimeSlot).toHaveBeenCalledWith({ companyId, slotId });
    expect(gateway.restartRuntimeSlot).toHaveBeenCalledWith({ companyId, slotId });
    expect(harness.calls).toEqual([]);
  });

  it("requires company scope before runtime supervisor delegation", async () => {
    const { app, harness } = createFullRouteApp(gateway);

    await request(app)
      .get("/api/tool-gateway/runtime-slots")
      .expect(400, { error: "companyId is required" });
    await request(app)
      .post(`/api/tool-gateway/runtime-slots/${slotId}/stop`)
      .send({})
      .expect(400, { error: "companyId is required" });
    await request(app)
      .post(`/api/tool-gateway/runtime-slots/${slotId}/restart`)
      .send({})
      .expect(400, { error: "companyId is required" });

    expect(gateway.listRuntimeSlots).not.toHaveBeenCalled();
    expect(gateway.stopRuntimeSlot).not.toHaveBeenCalled();
    expect(gateway.restartRuntimeSlot).not.toHaveBeenCalled();
    expect(harness.calls).toEqual([]);
  });
});
