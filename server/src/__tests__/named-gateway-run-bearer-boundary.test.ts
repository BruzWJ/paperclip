import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  mcpGatewayProtocolRoutes,
  toolGatewayRoutes,
} from "../routes/tool-gateway.js";
import type { ToolGatewayService } from "../services/tool-gateway.js";

function createApp() {
  const initializeNamedGatewayProtocol = vi.fn();
  const listToolsForNamedGateway = vi.fn();
  const executeToolForNamedGateway = vi.fn();
  const gateway = {
    initializeNamedGatewayProtocol,
    listToolsForNamedGateway,
    executeToolForNamedGateway,
  } as unknown as ToolGatewayService;
  const app = express();
  app.use(express.json());
  app.use(mcpGatewayProtocolRoutes(gateway));
  app.use("/api", toolGatewayRoutes({} as Db, gateway));
  return {
    app,
    serviceCalls: [
      initializeNamedGatewayProtocol,
      listToolsForNamedGateway,
      executeToolForNamedGateway,
    ],
  };
}

describe("named-gateway run-bearer boundary", () => {
  it.each([
    "/mcp/gateways/gw_public",
    "/api/tool-gateway/gateways/gateway-id/mcp",
  ])("rejects a run-interface bearer from GET %s", async (path) => {
    const { app, serviceCalls } = createApp();

    const response = await request(app)
      .get(path)
      .set("authorization", "Bearer pc_run_v1_reserved-secret")
      .expect(401);

    expect(response.body).toEqual({
      error: "Prompt-capability bearers are not valid named-gateway credentials",
      code: "prompt_capability_authentication_failed",
    });
    for (const serviceCall of serviceCalls) {
      expect(serviceCall).not.toHaveBeenCalled();
    }
  });

  it.each([
    "/mcp/gateways/gw_public",
    "/api/tool-gateway/gateways/gateway-id/mcp",
  ])("rejects a run-interface bearer from POST %s", async (path) => {
    const { app, serviceCalls } = createApp();

    const response = await request(app)
      .post(path)
      .set("authorization", "Bearer pc_run_v1_reserved-secret")
      .send({
        jsonrpc: "2.0",
        id: 17,
        method: "tools/list",
      })
      .expect(401);

    expect(response.body).toEqual({
      jsonrpc: "2.0",
      id: 17,
      error: {
        code: -32001,
        message:
          "Prompt-capability bearers are not valid named-gateway credentials",
        data: { code: "prompt_capability_authentication_failed" },
      },
    });
    for (const serviceCall of serviceCalls) {
      expect(serviceCall).not.toHaveBeenCalled();
    }
  });
});
