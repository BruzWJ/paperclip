import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pluginManifestV1Schema, type PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { testBoardSessionActor } from "./helpers/request-actor.js";

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(),
  getByKey: vi.fn(),
}));

const mockLifecycle = vi.hoisted(() => ({
  load: vi.fn(),
  upgrade: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockRegistry,
}));

vi.mock("../services/issues.js", () => ({
  issueService: () => mockIssueService,
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn(),
}));

vi.mock("../services/live-events.js", () => ({
  publishGlobalLiveEvent: vi.fn(),
}));

function manifest(apiRoutes: NonNullable<PaperclipPluginManifestV1["apiRoutes"]>): PaperclipPluginManifestV1 {
  return {
    id: "paperclip.scoped-api-test",
    apiVersion: 1,
    version: "1.0.0",
    displayName: "Scoped API Test",
    description: "Test plugin for scoped API routes",
    author: "Paperclip",
    categories: ["automation"],
    capabilities: ["api.routes.register"],
    entrypoints: { worker: "dist/worker.js" },
    apiRoutes,
  };
}

async function createApp(input: {
  actor: Record<string, unknown>;
  plugin?: Record<string, unknown> | null;
  workerRunning?: boolean;
  workerResult?: unknown;
}) {
  const [{ pluginRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/plugins.js"),
    import("../middleware/index.js"),
  ]);

  const workerManager = {
    isRunning: vi.fn().mockReturnValue(input.workerRunning ?? true),
    call: vi.fn().mockResolvedValue(input.workerResult ?? { status: 200, body: { ok: true } }),
  };

  mockRegistry.getById.mockResolvedValue(input.plugin ?? null);
  mockRegistry.getByKey.mockResolvedValue(input.plugin ?? null);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = input.actor as typeof req.actor;
    next();
  });
  app.use(
    "/api",
    pluginRoutes(
      {} as never,
      { installPlugin: vi.fn() } as never,
      mockLifecycle as never,
      undefined,
      undefined,
      { workerManager } as never,
    ),
  );
  app.use(errorHandler);

  return { app, workerManager };
}

describe.sequential("plugin scoped API routes", () => {
  const pluginId = "11111111-1111-4111-8111-111111111111";
  const companyId = "22222222-2222-4222-8222-222222222222";

  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.getById.mockResolvedValue(null);
  });

  it("dispatches a board GET route with params, query, actor, and company context", async () => {
    const apiRoutes = manifest([
      {
        routeKey: "summary.get",
        method: "GET",
        path: "/companies/:companySlug/summary",
        auth: "board",
        capability: "api.routes.register",
        companyResolution: { from: "query", key: "companyId" },
      },
    ]);
    const { app, workerManager } = await createApp({
      actor: testBoardSessionActor({
        userId: "user-1",
        userName: "User One",
        userEmail: "user-1@paperclip.test",
        sessionId: "session-user-1",
        companyIds: [companyId],
        memberships: [{ companyId, status: "active", membershipRole: "admin" }],
        isInstanceAdmin: true,
      }),
      plugin: {
        id: pluginId,
        pluginKey: apiRoutes.id,
        status: "ready",
        manifestJson: apiRoutes,
      },
      workerResult: { status: 201, body: { handled: true } },
    });

    const res = await request(app)
      .get(`/api/plugins/${pluginId}/api/companies/acme/summary?companyId=${companyId}&view=compact`)
      .set("Authorization", "Bearer should-not-forward");

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ handled: true });
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "handleApiRequest", expect.objectContaining({
      routeKey: "summary.get",
      method: "GET",
      params: { companySlug: "acme" },
      query: { companyId, view: "compact" },
      companyId,
      actor: {
        actorType: "user",
        actorId: "user-1",
        userId: "user-1",
      },
    }));
    expect(workerManager.call.mock.calls[0]?.[2].headers.authorization).toBeUndefined();
  });

  it("only forwards allowlisted response headers from plugin routes", async () => {
    const apiRoutes = manifest([
      {
        routeKey: "summary.get",
        method: "GET",
        path: "/companies/:companySlug/summary",
        auth: "board",
        capability: "api.routes.register",
        companyResolution: { from: "query", key: "companyId" },
      },
    ]);
    const { app } = await createApp({
      actor: testBoardSessionActor({
        userId: "user-1",
        userName: "User One",
        userEmail: "user-1@paperclip.test",
        sessionId: "session-user-1",
        companyIds: [companyId],
        memberships: [{ companyId, status: "active", membershipRole: "admin" }],
        isInstanceAdmin: true,
      }),
      plugin: {
        id: pluginId,
        pluginKey: apiRoutes.id,
        status: "ready",
        manifestJson: apiRoutes,
      },
      workerResult: {
        status: 200,
        body: { handled: true },
        headers: {
          "cache-control": "no-store",
          "content-security-policy": "default-src 'none'",
          location: "https://example.invalid",
          "x-request-id": "plugin-request",
        },
      },
    });

    const res = await request(app)
      .get(`/api/plugins/${pluginId}/api/companies/acme/summary?companyId=${companyId}`);

    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["x-request-id"]).toBe("plugin-request");
    expect(res.headers["content-security-policy"]).toBeUndefined();
    expect(res.headers.location).toBeUndefined();
  });

  it("returns a clear error for disabled plugins without worker dispatch", async () => {
    const apiRoutes = manifest([
      {
        routeKey: "summary.get",
        method: "GET",
        path: "/summary",
        auth: "board",
        capability: "api.routes.register",
        companyResolution: { from: "query", key: "companyId" },
      },
    ]);
    const { app, workerManager } = await createApp({
      actor: testBoardSessionActor({
        userId: "user-1",
        userName: "User One",
        userEmail: "user-1@paperclip.test",
        sessionId: "session-user-1",
        companyIds: [companyId],
        memberships: [{ companyId, status: "active", membershipRole: "admin" }],
        isInstanceAdmin: true,
      }),
      plugin: {
        id: pluginId,
        pluginKey: apiRoutes.id,
        status: "disabled",
        manifestJson: apiRoutes,
      },
    });

    const res = await request(app)
      .get(`/api/plugins/${pluginId}/api/summary?companyId=${companyId}`);

    expect(res.status).toBe(503);
    expect(res.body.error).toContain("disabled");
    expect(workerManager.call).not.toHaveBeenCalled();
  });

  it("returns a clear error when a ready plugin has no running worker", async () => {
    const apiRoutes = manifest([
      {
        routeKey: "summary.get",
        method: "GET",
        path: "/summary",
        auth: "board",
        capability: "api.routes.register",
        companyResolution: { from: "query", key: "companyId" },
      },
    ]);
    const { app, workerManager } = await createApp({
      actor: testBoardSessionActor({
        userId: "user-1",
        userName: "User One",
        userEmail: "user-1@paperclip.test",
        sessionId: "session-user-1",
        companyIds: [companyId],
        memberships: [{ companyId, status: "active", membershipRole: "admin" }],
        isInstanceAdmin: true,
      }),
      plugin: {
        id: pluginId,
        pluginKey: apiRoutes.id,
        status: "ready",
        manifestJson: apiRoutes,
      },
      workerRunning: false,
    });

    const res = await request(app)
      .get(`/api/plugins/${pluginId}/api/summary?companyId=${companyId}`);

    expect(res.status).toBe(503);
    expect(res.body.error).toContain("worker is not running");
    expect(workerManager.call).not.toHaveBeenCalled();
  });

  it("rejects manifest routes that try to claim core API paths", () => {
    const result = pluginManifestV1Schema.safeParse(manifest([
      {
        routeKey: "bad.shadow",
        method: "POST",
        path: "/api/issues/:issueId",
        auth: "board",
        capability: "api.routes.register",
      },
    ]));

    expect(result.success).toBe(false);
    if (result.success) throw new Error("Expected manifest validation to fail");
    expect(result.error.issues.map((issue) => issue.message).join("\n")).toContain(
      "path must stay inside the plugin api namespace",
    );
  });
});
