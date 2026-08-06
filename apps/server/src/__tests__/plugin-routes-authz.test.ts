import express from "express";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginConfig, PluginRecord } from "@paperclipai/shared";
import { denyGenericAgentRest } from "../routes/compiled-interface-only.js";
import { testBoardSessionActor } from "./helpers/request-actor.js";

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(),
  getByKey: vi.fn(),
  getConfig: vi.fn(),
  getCompanySettings: vi.fn(),
  upsertCompanySettings: vi.fn(),
}));

const mockLifecycle = vi.hoisted(() => ({
  install: vi.fn(),
  upgrade: vi.fn(),
  unload: vi.fn(),
  enable: vi.fn(),
  disable: vi.fn(),
  updateConfig: vi.fn(),
  markError: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockRegistry,
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn(),
}));

function createAuditDb() {
  return {
    select: vi.fn(() => ({
      from: vi.fn().mockResolvedValue([]),
    })),
  };
}

async function createApp(
  actor: Record<string, unknown>,
  routeOverrides: {
    db?: unknown;
    runtime?: unknown;
    captureJsonContext?: (context: unknown, body: unknown) => void;
  } = {},
) {
  const [{ pluginRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/plugins.js"),
    import("../middleware/index.js"),
  ]);

  const app = express();
  app.use(express.json({
    verify(req, _res, buf) {
      (req as unknown as { rawBody: Buffer }).rawBody = buf;
    },
  }));
  if (routeOverrides.captureJsonContext) {
    app.use((_req, res, next) => {
      const originalJson = res.json.bind(res);
      res.json = ((body: unknown) => {
        routeOverrides.captureJsonContext?.((res as any).__errorContext, body);
        return originalJson(body);
      }) as typeof res.json;
      next();
    });
  }
  app.use((req, _res, next) => {
    req.actor = actor as typeof req.actor;
    next();
  });
  app.use("/api", denyGenericAgentRest("REST"));
  app.use("/api", pluginRoutes(
    (routeOverrides.db ?? createAuditDb()) as never,
    mockLifecycle as never,
    routeOverrides.runtime as never,
  ));
  app.use(errorHandler);

  return { app };
}

const companyA = "22222222-2222-4222-8222-222222222222";
const companyB = "33333333-3333-4333-8333-333333333333";
const agentA = "44444444-4444-4444-8444-444444444444";
const runA = "55555555-5555-4555-8555-555555555555";
const pluginId = "11111111-1111-4111-8111-111111111111";
const installedAt = new Date("2026-08-05T01:02:03.000Z");
const updatedAt = new Date("2026-08-06T04:05:06.000Z");

function pluginRecord(overrides: Partial<PluginRecord> = {}): PluginRecord {
  return {
    id: pluginId,
    pluginKey: "paperclip.example",
    packageName: "paperclip-plugin-example",
    source: "npm",
    packagePath: "/plugins/paperclip-plugin-example",
    status: "ready",
    installOrder: 1,
    manifestJson: {
      id: "paperclip.example",
      apiVersion: 1,
      version: "1.0.0",
      displayName: "Example",
      description: "Example plugin",
      author: "Paperclip",
      categories: ["automation"],
      capabilities: [],
      entrypoints: { worker: "dist/worker.js" },
    },
    lastError: null,
    installedAt,
    updatedAt,
    ...overrides,
  };
}

function pluginConfig(
  configJson: Record<string, unknown>,
  overrides: Partial<PluginConfig> = {},
): PluginConfig {
  return {
    id: "config-1",
    pluginId,
    configJson,
    createdAt: installedAt,
    updatedAt,
    ...overrides,
  };
}

function boardActor(
  overrides: Parameters<typeof testBoardSessionActor>[0] = {},
) {
  return testBoardSessionActor({
    userId: "user-1",
    userName: "User One",
    userEmail: "user-1@paperclip.test",
    sessionId: "session-user-1",
    isInstanceAdmin: false,
    companyIds: [companyA],
    ...overrides,
  });
}

function agentActor(overrides: Record<string, unknown> = {}) {
  return {
    type: "agent",
    agentId: agentA,
    companyId: companyA,
    runId: runA,
    source: "internal",
    ...overrides,
  };
}

function readyPlugin() {
  mockRegistry.getById.mockResolvedValue(pluginRecord());
}

describe.sequential("plugin install and upgrade authz", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects plugin installation for non-admin board users", async () => {
    const { app } = await createApp(boardActor({
      companyIds: ["company-1"],
    }));

    const res = await request(app)
      .post("/api/plugins/install")
      .send({ source: "npm", packageName: "paperclip-plugin-example" });

    expect(res.status).toBe(403);
    expect(mockLifecycle.install).not.toHaveBeenCalled();
  }, 20_000);

  it("allows instance admins to install plugins", async () => {
    const installedPlugin = pluginRecord();
    mockLifecycle.install.mockResolvedValue(installedPlugin);

    const { app } = await createApp(
      boardActor({
        userId: "admin-1",
        userName: "Admin One",
        userEmail: "admin-1@paperclip.test",
        sessionId: "session-admin-1",
        isInstanceAdmin: true,
        companyIds: [],
      }),
    );

    const res = await request(app)
      .post("/api/plugins/install")
      .send({ source: "npm", packageName: "paperclip-plugin-example" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: pluginId,
      installedAt: installedAt.toISOString(),
      updatedAt: updatedAt.toISOString(),
    });
    expect(mockLifecycle.install).toHaveBeenCalledWith({
      source: "npm",
      packageName: "paperclip-plugin-example",
    });
  }, 20_000);

  it("rejects undeclared install fields", async () => {
    const { app } = await createApp(boardActor({
      isInstanceAdmin: true,
      companyIds: [],
    }));

    const res = await request(app)
      .post("/api/plugins/install")
      .send({
        source: "npm",
        packageName: "paperclip-plugin-example",
        unsupportedField: false,
      });

    expect(res.status).toBe(400);
    expect(mockLifecycle.install).not.toHaveBeenCalled();
  }, 20_000);

  it("accepts only exact npm names and absolute local paths", async () => {
    const { app } = await createApp(boardActor({
      isInstanceAdmin: true,
      companyIds: [],
    }));

    const invalidNpm = await request(app)
      .post("/api/plugins/install")
      .send({ source: "npm", packageName: "./plugin" });
    const invalidLocal = await request(app)
      .post("/api/plugins/install")
      .send({ source: "local", path: "./plugin" });

    expect(invalidNpm.status).toBe(400);
    expect(invalidLocal.status).toBe(400);
    expect(mockLifecycle.install).not.toHaveBeenCalled();
  }, 20_000);

  it("rejects plugin upgrades for non-admin board users", async () => {
    const pluginId = "11111111-1111-4111-8111-111111111111";
    const { app } = await createApp(boardActor({
      companyIds: ["company-1"],
    }));

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/upgrade`)
      .send({});

    expect(res.status).toBe(403);
    expect(mockRegistry.getById).not.toHaveBeenCalled();
    expect(mockLifecycle.upgrade).not.toHaveBeenCalled();
  }, 20_000);

  it.each([
    ["logs", `/api/plugins/${pluginId}/logs`],
    ["configuration", `/api/plugins/${pluginId}/config`],
    ["jobs", `/api/plugins/${pluginId}/jobs`],
    ["job runs", `/api/plugins/${pluginId}/jobs/job-1/runs`],
    ["dashboard", `/api/plugins/${pluginId}/dashboard`],
  ])("rejects instance-wide plugin %s reads for non-admin board users", async (_name, path) => {
    const { app } = await createApp(boardActor({ companyIds: [companyA] }));

    const res = await request(app).get(path);

    expect(res.status).toBe(403);
    expect(mockRegistry.getById).not.toHaveBeenCalled();
  }, 20_000);

  it.each([
    ["delete", "delete", "/api/plugins/11111111-1111-4111-8111-111111111111", undefined],
    ["enable", "post", "/api/plugins/11111111-1111-4111-8111-111111111111/enable", {}],
    ["disable", "post", "/api/plugins/11111111-1111-4111-8111-111111111111/disable", {}],
    ["config", "post", "/api/plugins/11111111-1111-4111-8111-111111111111/config", { configJson: {} }],
    ["config test", "post", "/api/plugins/11111111-1111-4111-8111-111111111111/config/test", { configJson: {} }],
  ] as const)("rejects plugin %s for non-admin board users", async (_name, method, path, body) => {
    const { app } = await createApp(boardActor({
      companyIds: ["company-1"],
    }));

    const req = method === "delete" ? request(app).delete(path) : request(app).post(path).send(body);
    const res = await req;

    expect(res.status).toBe(403);
    expect(mockRegistry.getById).not.toHaveBeenCalled();
    expect(mockLifecycle.updateConfig).not.toHaveBeenCalled();
    expect(mockLifecycle.unload).not.toHaveBeenCalled();
    expect(mockLifecycle.enable).not.toHaveBeenCalled();
    expect(mockLifecycle.disable).not.toHaveBeenCalled();
  }, 20_000);

  it("rejects plugin keys because installation routes are UUID-only", async () => {
    const pluginKey = "paperclipqa.hello-plugin";
    const { app } = await createApp(boardActor({
      userId: "admin-1",
      userName: "Admin One",
      userEmail: "admin-1@paperclip.test",
      sessionId: "session-admin-1",
      isInstanceAdmin: true,
      companyIds: [companyA],
    }));

    const inspectRes = await request(app).get(`/api/plugins/${pluginKey}`);
    const disableRes = await request(app).post(`/api/plugins/${pluginKey}/disable`).send({});
    const enableRes = await request(app).post(`/api/plugins/${pluginKey}/enable`).send({});
    const uninstallRes = await request(app).delete(`/api/plugins/${pluginKey}`);

    expect(inspectRes.status).toBe(404);
    expect(disableRes.status).toBe(404);
    expect(enableRes.status).toBe(404);
    expect(uninstallRes.status).toBe(404);
    expect(mockRegistry.getById).not.toHaveBeenCalled();
    expect(mockRegistry.getByKey).not.toHaveBeenCalled();
    expect(mockLifecycle.disable).not.toHaveBeenCalled();
    expect(mockLifecycle.enable).not.toHaveBeenCalled();
    expect(mockLifecycle.unload).not.toHaveBeenCalled();
  }, 20_000);

  it("uses one idempotent query-free uninstall operation", async () => {
    mockLifecycle.unload
      .mockResolvedValueOnce(pluginRecord({ status: "disabled" }))
      .mockResolvedValueOnce(null);
    const { app } = await createApp(boardActor({
      isInstanceAdmin: true,
      companyIds: [],
    }));

    const first = await request(app).delete(`/api/plugins/${pluginId}`);
    const repeated = await request(app).delete(`/api/plugins/${pluginId}`);

    expect(first.status).toBe(204);
    expect(repeated.status).toBe(204);
    expect(mockLifecycle.unload).toHaveBeenNthCalledWith(1, pluginId);
    expect(mockLifecycle.unload).toHaveBeenNthCalledWith(2, pluginId);
  }, 20_000);

  it("rejects removed uninstall query options", async () => {
    const { app } = await createApp(boardActor({
      isInstanceAdmin: true,
      companyIds: [],
    }));

    const res = await request(app)
      .delete(`/api/plugins/${pluginId}`)
      .query({ purge: "true" });

    expect(res.status).toBe(400);
    expect(mockLifecycle.unload).not.toHaveBeenCalled();
  }, 20_000);

  it("allows instance admins to save one installation-wide config without a company", async () => {
    readyPlugin();
    const draftConfig = {
      endpoint: "https://service.example",
      apiSecret: "new-secret-value",
    };
    mockLifecycle.updateConfig.mockResolvedValue(pluginConfig(draftConfig));

    const { app } = await createApp(boardActor({
      userId: "admin-1",
      userName: "Admin One",
      userEmail: "admin-1@paperclip.test",
      sessionId: "session-admin-1",
      isInstanceAdmin: true,
      companyIds: [],
    }));

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/config`)
      .send({ configJson: draftConfig });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      createdAt: installedAt.toISOString(),
      updatedAt: updatedAt.toISOString(),
    });
    expect(mockLifecycle.updateConfig).toHaveBeenCalledWith(pluginId, draftConfig);
  }, 20_000);

  it("lets an instance admin read config without company membership", async () => {
    readyPlugin();
    mockRegistry.getConfig.mockResolvedValue(pluginConfig({
      endpoint: "https://service.example",
    }));

    const { app } = await createApp(boardActor({
      userId: "admin-1",
      userName: "Admin One",
      userEmail: "admin-1@paperclip.test",
      sessionId: "session-admin-1",
      isInstanceAdmin: true,
      companyIds: [],
    }));

    const res = await request(app).get(`/api/plugins/${pluginId}/config`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      createdAt: installedAt.toISOString(),
      updatedAt: updatedAt.toISOString(),
    });
    expect(mockRegistry.getConfig).toHaveBeenCalledWith(pluginId);
  }, 20_000);

  it("delegates configuration and runtime coordination to the lifecycle", async () => {
    readyPlugin();
    mockLifecycle.updateConfig.mockResolvedValue(pluginConfig(
      { revision: "next" },
      { id: "config-restart" },
    ));
    const { app } = await createApp(boardActor({
      isInstanceAdmin: true,
      companyIds: [],
    }), { runtime: {} });

    const response = await request(app)
      .post(`/api/plugins/${pluginId}/config`)
      .send({ configJson: { revision: "next" } });

    expect(response.status).toBe(200);
    expect(mockLifecycle.updateConfig).toHaveBeenCalledWith(pluginId, {
      revision: "next",
    });
  }, 20_000);

  it("does not duplicate the lifecycle-owned error transition when config reload fails", async () => {
    readyPlugin();
    mockLifecycle.updateConfig.mockRejectedValue(new Error("worker failed"));
    const { app } = await createApp(boardActor({
      isInstanceAdmin: true,
      companyIds: [],
    }));

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/config`)
      .send({ configJson: { endpoint: "https://service.example" } });

    expect(res.status).toBe(400);
    expect(mockLifecycle.updateConfig).toHaveBeenCalledTimes(1);
    expect(mockLifecycle.markError).not.toHaveBeenCalled();
  }, 20_000);

  it("allows instance admins to upgrade plugins", async () => {
    mockRegistry.getById.mockResolvedValue(pluginRecord());
    mockLifecycle.upgrade.mockResolvedValue(pluginRecord({
      manifestJson: {
        ...pluginRecord().manifestJson,
        version: "1.1.0",
      },
    }));

    const { app } = await createApp(boardActor({
      userId: "admin-1",
      userName: "Admin One",
      userEmail: "admin-1@paperclip.test",
      sessionId: "session-admin-1",
      isInstanceAdmin: true,
      companyIds: [],
    }));

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/upgrade`)
      .send({ version: "1.1.0" });

    expect(res.status).toBe(200);
    expect(mockLifecycle.upgrade).toHaveBeenCalledWith(pluginId, "1.1.0");
  }, 20_000);
});

describe.sequential("scoped plugin API routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("dispatches manifest-declared scoped routes after company access checks", async () => {
    const pluginId = "11111111-1111-4111-8111-111111111111";
    const workerManager = {
      isRunning: vi.fn().mockReturnValue(true),
      call: vi.fn().mockResolvedValue({
        status: 202,
        body: { ok: true },
      }),
    };
    mockRegistry.getById.mockResolvedValue({
      id: pluginId,
      pluginKey: "paperclip.example",
      status: "ready",
      manifestJson: {
        id: "paperclip.example",
        capabilities: ["api.routes.register"],
        apiRoutes: [
          {
            routeKey: "smoke",
            method: "GET",
            path: "/smoke",
            companyResolution: { from: "query", key: "companyId" },
          },
        ],
      },
    });

    const { app } = await createApp(
      boardActor({
        userId: "admin-1",
        userName: "Admin One",
        userEmail: "admin-1@paperclip.test",
        sessionId: "session-admin-1",
        isInstanceAdmin: false,
        companyIds: ["company-1"],
      }),
      { runtime: { workerManager } },
    );

    const res = await request(app)
      .get(`/api/plugins/${pluginId}/api/smoke`)
      .query({ companyId: "company-1" });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ ok: true });
    expect(workerManager.call).toHaveBeenCalledWith(
      pluginId,
      "handleApiRequest",
      expect.objectContaining({
        routeKey: "smoke",
        method: "GET",
        companyId: "company-1",
        query: { companyId: "company-1" },
      }),
    );
  }, 20_000);
});

describe.sequential("plugin local folder routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRegistry.getCompanySettings.mockResolvedValue(null);
  });

  function readyLocalFolderPlugin() {
    mockRegistry.getById.mockResolvedValue({
      id: pluginId,
      pluginKey: "paperclip.example",
      status: "ready",
      manifestJson: {
        id: "paperclip.example",
        capabilities: ["local.folders"],
        localFolders: [
          {
            folderKey: "content-root",
            displayName: "Content root",
            access: "readWrite",
            requiredDirectories: ["docs"],
            requiredFiles: ["README.md"],
          },
        ],
      },
    });
  }

  it("rejects validation for undeclared local folder keys", async () => {
    readyLocalFolderPlugin();
    const { app } = await createApp(boardActor());

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/companies/${companyA}/local-folders/ssh/validate`)
      .send({ path: "/tmp" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Local folder key is not declared");
    expect(mockRegistry.upsertCompanySettings).not.toHaveBeenCalled();
  });

  it("rejects saving undeclared local folder keys", async () => {
    readyLocalFolderPlugin();
    const { app } = await createApp(boardActor());

    const res = await request(app)
      .put(`/api/plugins/${pluginId}/companies/${companyA}/local-folders/ssh`)
      .send({ path: "/tmp" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Local folder key is not declared");
    expect(mockRegistry.upsertCompanySettings).not.toHaveBeenCalled();
  });

  it("rejects local-folder declaration overrides in REST input", async () => {
    readyLocalFolderPlugin();
    const { app } = await createApp(boardActor());

    const res = await request(app)
      .put(`/api/plugins/${pluginId}/companies/${companyA}/local-folders/content-root`)
      .send({ path: "/tmp", access: "read" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid plugin local-folder path request");
    expect(mockRegistry.upsertCompanySettings).not.toHaveBeenCalled();
  });

  it("persists only the operator-selected local-folder path", async () => {
    readyLocalFolderPlugin();
    const { app } = await createApp(boardActor());
    const folderPath = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-plugin-route-folder-"));

    try {
      const res = await request(app)
        .put(`/api/plugins/${pluginId}/companies/${companyA}/local-folders/content-root`)
        .send({ path: folderPath });

      expect(res.status).toBe(200);
      await expect(fs.stat(path.join(folderPath, "docs"))).resolves.toMatchObject({});
      expect(mockRegistry.upsertCompanySettings).toHaveBeenCalledWith(
        pluginId,
        companyA,
        {
          settingsJson: {
            localFolders: {
              "content-root": {
                path: folderPath,
              },
            },
          },
        },
      );
    } finally {
      await fs.rm(folderPath, { recursive: true, force: true });
    }
  });
});

describe.sequential("plugin bridge authz", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ["data", "post", `/api/plugins/${pluginId}/data/health`, {}],
    ["action", "post", `/api/plugins/${pluginId}/actions/sync`, {}],
  ] as const)("rejects %s bridge calls without companyId for non-admin users", async (_name, _method, path, body) => {
    readyPlugin();
    const call = vi.fn();
    const { app } = await createApp(boardActor(), {
      runtime: {
        workerManager: { call },
      },
    });

    const res = await request(app)
      .post(path)
      .send(body);

    expect(res.status).toBe(403);
    expect(call).not.toHaveBeenCalled();
  });

  it("forwards authorized bridge company scope to the plugin worker", async () => {
    readyPlugin();
    const call = vi.fn().mockResolvedValue({ ok: true });
    const { app } = await createApp(boardActor(), {
      runtime: {
        workerManager: { call },
      },
    });

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/data/health`)
      .send({ companyId: companyA, params: { view: "compact" } });

    expect(res.status).toBe(200);
    expect(call).toHaveBeenCalledWith(pluginId, "getData", {
      key: "health",
      companyId: companyA,
      params: { view: "compact" },
      renderEnvironment: null,
    });
  });

  it("allows omitted-company bridge calls for instance admins as global plugin actions", async () => {
    readyPlugin();
    const call = vi.fn().mockResolvedValue({ ok: true });
    const { app } = await createApp(boardActor({
      userId: "admin-1",
      isInstanceAdmin: true,
      companyIds: [],
    }), {
      runtime: {
        workerManager: { call },
      },
    });

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/actions/sync`)
      .send({});

    expect(res.status).toBe(200);
    expect(call).toHaveBeenCalledWith(pluginId, "performAction", {
      key: "sync",
      params: {},
      actorContext: {
        type: "user",
        userId: "admin-1",
        companyId: null,
      },
      renderEnvironment: null,
    });
  });

  it("passes authenticated actor context and overrides spoofed company scope for plugin actions", async () => {
    readyPlugin();
    const call = vi.fn().mockResolvedValue({ ok: true });
    const { app } = await createApp(boardActor(), {
      runtime: {
        workerManager: { call },
      },
    });

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/actions/sync`)
      .send({
        companyId: companyA,
        params: {
          companyId: companyB,
          reviewerUserId: "spoofed-user",
        },
      });

    expect(res.status).toBe(200);
    expect(call).toHaveBeenCalledWith(pluginId, "performAction", {
      key: "sync",
      params: {
        companyId: companyA,
        reviewerUserId: "spoofed-user",
      },
      actorContext: {
        type: "user",
        userId: "user-1",
        companyId: companyA,
      },
      renderEnvironment: null,
    });
  });

  it("rejects malformed board actors without a canonical Better Auth user id", async () => {
    readyPlugin();
    const call = vi.fn().mockResolvedValue({ ok: true });
    const malformedActor = {
      type: "board",
      userId: undefined,
      userName: "User One",
      userEmail: "user-1@paperclip.test",
      sessionId: "session-user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyA],
      memberships: [{
        companyId: companyA,
        membershipRole: "operator",
        status: "active",
      }],
    };
    const { app } = await createApp(malformedActor, {
      runtime: {
        workerManager: { call },
      },
    });

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/actions/sync`)
      .send({ companyId: companyA });

    expect(res.status).toBe(403);
    expect(call).not.toHaveBeenCalled();
  });

  it("rejects agent-scoped plugin actions at the generic REST boundary", async () => {
    readyPlugin();
    const call = vi.fn().mockResolvedValue({ ok: true });
    const { app } = await createApp(agentActor(), {
      runtime: {
        workerManager: { call },
      },
    });

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/actions/sync`)
      .send({
        companyId: companyA,
        params: {
          companyId: companyB,
          reviewerAgentId: "spoofed-agent",
        },
      });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      code: "compiled_run_interface_required",
    });
    expect(call).not.toHaveBeenCalled();

  });

  it("rejects agent plugin actions outside the authenticated company scope", async () => {
    readyPlugin();
    const call = vi.fn().mockResolvedValue({ ok: true });
    const { app } = await createApp(agentActor(), {
      runtime: {
        workerManager: { call },
      },
    });

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/actions/sync`)
      .send({ companyId: companyB });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      code: "compiled_run_interface_required",
    });
    expect(call).not.toHaveBeenCalled();
  });

  it("attaches worker bridge errors to the HTTP logger context", async () => {
    readyPlugin();
    const call = vi.fn().mockRejectedValue(new Error("missing source_objects column"));
    const captured: Array<{ context: any; body: unknown }> = [];
    const { app } = await createApp(boardActor(), {
      runtime: {
        workerManager: { call },
      },
      captureJsonContext: (context, body) => {
        captured.push({ context, body });
      },
    });

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/data/source-objects`)
      .send({ companyId: companyA });

    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({
      code: "UNKNOWN",
      message: "missing source_objects column",
    });
    expect(captured.at(-1)?.context?.error).toMatchObject({
      message: "missing source_objects column",
      details: {
        pluginId,
        pluginKey: "paperclip.example",
        bridgeMethod: "getData",
        dataKey: "source-objects",
        bridgeCode: "UNKNOWN",
      },
    });
  });

  it("rejects manual job triggers for non-admin board users", async () => {
    const scheduler = { triggerJob: vi.fn() };
    const jobStore = { getJobByIdForPlugin: vi.fn() };
    const { app } = await createApp(boardActor(), {
      runtime: { scheduler, jobStore },
    });

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/jobs/job-1/trigger`)
      .send({});

    expect(res.status).toBe(403);
    expect(scheduler.triggerJob).not.toHaveBeenCalled();
    expect(jobStore.getJobByIdForPlugin).not.toHaveBeenCalled();
  }, 15_000);

  it("allows manual job triggers for instance admins", async () => {
    readyPlugin();
    const scheduler = { triggerJob: vi.fn().mockResolvedValue({ runId: "run-1", jobId: "job-1" }) };
    const jobStore = { getJobByIdForPlugin: vi.fn().mockResolvedValue({ id: "job-1" }) };
    const { app } = await createApp(boardActor({
      userId: "admin-1",
      isInstanceAdmin: true,
      companyIds: [],
    }), {
      runtime: { scheduler, jobStore },
    });

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/jobs/job-1/trigger`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ runId: "run-1", jobId: "job-1" });
    expect(scheduler.triggerJob).toHaveBeenCalledWith("job-1");
  });

});

describe.sequential("plugin webhook body transport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards non-JSON bytes while preserving JSON raw and parsed bodies", async () => {
    mockRegistry.getById.mockResolvedValue(pluginRecord({
      manifestJson: {
        ...pluginRecord().manifestJson,
        capabilities: ["webhooks.receive"],
        webhooks: [{ endpointKey: "events", displayName: "Events" }],
      },
    }));
    const call = vi.fn().mockResolvedValue(undefined);
    const db = {
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          returning: vi.fn().mockResolvedValue([{ id: "delivery-1" }]),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn().mockResolvedValue(undefined),
        })),
      })),
    };
    const { app } = await createApp(boardActor(), {
      db,
      runtime: { workerManager: { call } },
    });

    const text = await request(app)
      .post(`/api/plugins/${pluginId}/webhooks/events`)
      .type("text/plain")
      .send("event=push&ref=main");
    const json = await request(app)
      .post(`/api/plugins/${pluginId}/webhooks/events`)
      .send({ event: "push", ref: "main" });

    expect(text.status).toBe(200);
    expect(json.status).toBe(200);
    expect(call).toHaveBeenNthCalledWith(
      1,
      pluginId,
      "handleWebhook",
      expect.objectContaining({
        rawBody: "event=push&ref=main",
        parsedBody: undefined,
      }),
    );
    expect(call).toHaveBeenNthCalledWith(
      2,
      pluginId,
      "handleWebhook",
      expect.objectContaining({
        rawBody: '{"event":"push","ref":"main"}',
        parsedBody: { event: "push", ref: "main" },
      }),
    );
  });
});
