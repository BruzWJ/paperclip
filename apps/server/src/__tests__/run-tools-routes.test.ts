import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { runToolsRoutes } from "../routes/run-tools.js";
import type { PromptCapabilityGateway } from "../services/prompt-capability-gateway.js";
import { RuntimeToolUnavailable } from "../services/runtime-interface-compiler.js";
import { RUN_TOOLS_INGRESS_ORDINAL_HEADER } from "@paperclipai/adapter-utils/run-tools-stdio-proxy";

function app(service: PromptCapabilityGateway) {
  const instance = express();
  instance.use(express.json());
  instance.use("/api", runToolsRoutes(service));
  return instance;
}

function service(): PromptCapabilityGateway {
  return {
    listTools: vi.fn(async () => [
      {
        name: "read_issue_comments",
        title: "Read issue comments",
        description: "Read an authorized thread",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        source: "paperclip",
      },
    ]),
    callTool: vi.fn(async () => ({ items: [] })),
    registerTerminalInvalidToolCall: vi.fn(async () => undefined),
    resolvePluginRunContext: vi.fn(),
  };
}

describe("run-tools routes", () => {
  it("provides dynamic MCP discovery with no selector or identity payload", async () => {
    const runtime = service();
    const response = await request(app(runtime))
      .post("/api/run-tools")
      .set("authorization", "Bearer pc_run_v1_secret")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(response.status).toBe(200);
    expect(response.body.result.tools).toEqual([
      expect.objectContaining({ name: "read_issue_comments" }),
    ]);
    expect(JSON.stringify(response.body)).not.toContain("agentId");
    expect(JSON.stringify(response.body)).not.toContain("issueId");
    expect(runtime.listTools).toHaveBeenCalledWith("pc_run_v1_secret");
  });

  it("requires only the prompt-capability bearer and has no public constructor", async () => {
    const response = await request(app(service()))
      .post("/api/run-tools")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(response.status).toBe(401);
    expect(response.body.error.data.code).toBe(
      "prompt_capability_authentication_failed",
    );
  });

  it("maps a removed or forged descriptor to a denied call", async () => {
    const runtime = service();
    runtime.callTool = vi.fn(async () => {
      throw new RuntimeToolUnavailable("issue_create");
    });
    const response = await request(app(runtime))
      .post("/api/run-tools")
      .set("authorization", "Bearer pc_run_v1_secret")
      .set(RUN_TOOLS_INGRESS_ORDINAL_HEADER, "0")
      .send({
        jsonrpc: "2.0",
        id: "call",
        method: "tools/call",
        params: { name: "issue_create", arguments: {} },
      });
    expect(response.status).toBe(403);
    expect(response.body.error.data.code).toBe("runtime_tool_unavailable");
    expect(runtime.callTool).toHaveBeenCalledWith(
      expect.objectContaining({
        ingressOrdinal: 0,
        arguments: {},
      }),
    );
  });

  it("keeps ingress private and requires the authenticated proxy header", async () => {
    const runtime = service();
    const withoutIngress = await request(app(runtime))
      .post("/api/run-tools")
      .set("authorization", "Bearer pc_run_v1_secret")
      .send({
        jsonrpc: "2.0",
        id: "call-without-ingress",
        method: "tools/call",
        params: { name: "issue_create", arguments: { request: "exact" } },
      });
    expect(withoutIngress.status).toBe(400);
    expect(runtime.callTool).not.toHaveBeenCalled();

    const withIngress = await request(app(runtime))
      .post("/api/run-tools")
      .set("authorization", "Bearer pc_run_v1_secret")
      .set(RUN_TOOLS_INGRESS_ORDINAL_HEADER, "7")
      .send({
        jsonrpc: "2.0",
        id: "call-with-ingress",
        method: "tools/call",
        params: { name: "issue_create", arguments: { request: "exact" } },
      });
    expect(withIngress.status).toBe(200);
    expect(runtime.callTool).toHaveBeenCalledWith(
      expect.objectContaining({
        ingressOrdinal: 7,
        arguments: { request: "exact" },
      }),
    );
    expect(JSON.stringify(withIngress.body)).not.toContain("ingressOrdinal");
  });

  it.each([
    ["created"],
    ["configured"],
    ["change_consent_requested"],
  ] as const)(
    "serializes the closed %s action receipt identically as text and structured content",
    async (status) => {
      const runtime = service();
      runtime.callTool = vi.fn(async () => ({ status }));
      const response = await request(app(runtime))
        .post("/api/run-tools")
        .set("authorization", "Bearer pc_run_v1_secret")
        .set(RUN_TOOLS_INGRESS_ORDINAL_HEADER, "0")
        .send({
          jsonrpc: "2.0",
          id: `receipt-${status}`,
          method: "tools/call",
          params: { name: "agent_configure", arguments: {} },
        });

      expect(response.status).toBe(200);
      expect(response.body.result).toEqual({
        content: [{
          type: "text",
          text: JSON.stringify({ status }),
        }],
        structuredContent: { status },
      });
    },
  );

  it("terminal-registers every malformed tools/call before the next ordinal", async () => {
    const runtime = service();
    const post = (
      ordinal: number,
      body: Record<string, unknown>,
    ) => request(app(runtime))
      .post("/api/run-tools")
      .set("authorization", "Bearer pc_run_v1_secret")
      .set(RUN_TOOLS_INGRESS_ORDINAL_HEADER, String(ordinal))
      .send(body);

    await expect(post(0, {
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "read_issue_comments", arguments: {} },
    }).then((response) => response.status)).resolves.toBe(400);
    await expect(post(1, {
      jsonrpc: "2.0",
      id: { invalid: true },
      method: "tools/call",
      params: { name: "read_issue_comments", arguments: {} },
    }).then((response) => response.status)).resolves.toBe(400);
    await expect(post(2, {
      jsonrpc: "2.0",
      id: "bad-params",
      method: "tools/call",
      params: { name: 42, arguments: {} },
    }).then((response) => response.status)).resolves.toBe(400);
    await expect(post(3, {
      jsonrpc: "1.0",
      id: "bad-envelope",
      method: "tools/call",
      params: { name: "read_issue_comments", arguments: {} },
    }).then((response) => response.status)).resolves.toBe(400);

    const valid = await post(4, {
      jsonrpc: "2.0",
      id: "valid-after-invalid",
      method: "tools/call",
      params: { name: "read_issue_comments", arguments: {} },
    });
    expect(valid.status).toBe(200);
    expect(runtime.registerTerminalInvalidToolCall).toHaveBeenCalledTimes(4);
    expect(runtime.registerTerminalInvalidToolCall).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        ingressOrdinal: 0,
        callIdentity: null,
      }),
    );
    expect(runtime.registerTerminalInvalidToolCall).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        ingressOrdinal: 1,
        callIdentity: null,
      }),
    );
    expect(runtime.registerTerminalInvalidToolCall).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        ingressOrdinal: 2,
        callIdentity: { source: "jsonrpc", id: "bad-params" },
      }),
    );
    expect(runtime.registerTerminalInvalidToolCall).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({
        ingressOrdinal: 3,
        callIdentity: { source: "jsonrpc", id: "bad-envelope" },
      }),
    );
    expect(runtime.callTool).toHaveBeenCalledWith(
      expect.objectContaining({ ingressOrdinal: 4 }),
    );
  });
});
