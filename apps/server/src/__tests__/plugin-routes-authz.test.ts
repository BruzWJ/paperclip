import "./plugin-routes-authz.test-suite-01-rejects-plugin-installation-for-non.js";
import "./plugin-routes-authz.test-suite-05-rejects-s-bridge-calls-without.js";
import * as t from "./plugin-routes-authz.test-support.js";
const { describe, registerSuiteSetup, it, createApp, boardActor, request, expect } = t;
const { mockCatalog, mockLifecycle, pluginRecord, vi, companyA, mockLogActivity } = t;
const { pluginId, pluginId: _pluginId, mockRegistry, scopedCompanyId } = t;
const { readyLocalFolderPlugin, fs, path, os } = t;

describe.sequential("repo plugin catalog authz and installation", () => {
  registerSuiteSetup({ emptyRegistryList: true });

  it("rejects catalog listing and installation for non-admin board users", async () => {
    const { app } = await createApp(boardActor());

    const listResponse = await request(app).get("/api/plugins/catalog");
    const installResponse = await request(app)
      .post("/api/plugins/catalog/install")
      .send({ packageName: "@paperclipai/plugin-agentmemory" });

    expect(listResponse.status).toBe(403);
    expect(installResponse.status).toBe(403);
    expect(mockCatalog.list).not.toHaveBeenCalled();
    expect(mockCatalog.install).not.toHaveBeenCalled();
    expect(mockLifecycle.install).not.toHaveBeenCalled();
  });

  it("allows instance admins to list repo-relative catalog entries", async () => {
    mockCatalog.list.mockResolvedValue([
      {
        packageName: "@paperclipai/plugin-agentmemory",
        version: "0.1.0",
        displayName: "AgentMemory",
        description: "Memory plugin",
        relativePath: "packages/plugins/agentmemory-plugin",
        kind: "first_party",
        built: false,
      },
    ]);
    const { app } = await createApp(boardActor({ isInstanceAdmin: true }));

    const response = await request(app).get("/api/plugins/catalog");

    expect(response.status).toBe(200);
    expect(response.body).toEqual([
      expect.objectContaining({
        packageName: "@paperclipai/plugin-agentmemory",
        relativePath: "packages/plugins/agentmemory-plugin",
        built: false,
      }),
    ]);
    expect(mockCatalog.list).toHaveBeenCalledOnce();
  });

  it("rejects undeclared catalog install fields before invoking the catalog", async () => {
    const { app } = await createApp(boardActor({ isInstanceAdmin: true }));

    const response = await request(app).post("/api/plugins/catalog/install").send({
      packageName: "@paperclipai/plugin-agentmemory",
      path: "/tmp/plugin-agentmemory",
    });

    expect(response.status).toBe(400);
    expect(mockCatalog.install).not.toHaveBeenCalled();
  });

  it("resolves, checks, installs, and audits a catalog package for an instance admin", async () => {
    const packageName = "@paperclipai/plugin-agentmemory";
    const packageRoot = "/trusted/repo/packages/plugins/agentmemory-plugin";
    const installedPlugin = pluginRecord({
      packageName,
      source: "local",
      packagePath: packageRoot,
    });
    mockLifecycle.install.mockResolvedValue(installedPlugin);
    mockCatalog.install.mockImplementation(async (_packageName, dependencies) => {
      expect(await dependencies.isInstalled()).toBe(false);
      return dependencies.install(packageRoot);
    });
    const auditDb = {
      select: vi.fn(() => ({
        from: vi.fn().mockResolvedValue([{ id: companyA }]),
      })),
    };
    const { app } = await createApp(
      boardActor({
        userId: "admin-1",
        isInstanceAdmin: true,
      }),
      { db: auditDb },
    );

    const response = await request(app).post("/api/plugins/catalog/install").send({ packageName });

    expect(response.status).toBe(201);
    expect(mockCatalog.install).toHaveBeenCalledWith(
      packageName,
      expect.objectContaining({
        isInstalled: expect.any(Function),
        install: expect.any(Function),
      }),
    );
    expect(mockLifecycle.install).toHaveBeenCalledWith({
      source: "local",
      path: packageRoot,
    });
    expect(mockLogActivity).toHaveBeenCalledWith(auditDb, {
      companyId: companyA,
      actorType: "user",
      actorId: "admin-1",
      action: "plugin.installed",
      entityType: "plugin",
      entityId: _pluginId,
      details: {
        pluginId,
        pluginKey: installedPlugin.pluginKey,
        packageName,
        version: installedPlugin.manifestJson.version,
        source: "local",
      },
    });
  });

  it("does not report a completed install as failed when activity logging fails", async () => {
    const packageName = "@paperclipai/plugin-agentmemory";
    const packageRoot = "/trusted/repo/packages/plugins/agentmemory-plugin";
    const installedPlugin = pluginRecord({
      packageName,
      source: "local",
      packagePath: packageRoot,
    });
    mockLifecycle.install.mockResolvedValue(installedPlugin);
    mockCatalog.install.mockImplementation(async (_packageName, dependencies) =>
      dependencies.install(packageRoot),
    );
    mockLogActivity.mockRejectedValueOnce(new Error("activity store unavailable"));
    const auditDb = {
      select: vi.fn(() => ({
        from: vi.fn().mockResolvedValue([{ id: companyA }]),
      })),
    };
    const { app } = await createApp(
      boardActor({
        userId: "admin-1",
        isInstanceAdmin: true,
      }),
      { db: auditDb },
    );

    const response = await request(app).post("/api/plugins/catalog/install").send({ packageName });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ id: _pluginId, packageName });
    expect(mockLifecycle.install).toHaveBeenCalledOnce();
    expect(mockLogActivity).toHaveBeenCalledOnce();
  });
});

describe.sequential("scoped plugin API routes", () => {
  registerSuiteSetup();

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
        companyIds: [scopedCompanyId],
      }),
      { runtime: { workerManager } },
    );

    const res = await request(app)
      .get(`/api/plugins/${pluginId}/api/smoke`)
      .query({ companyId: scopedCompanyId });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ ok: true });
    expect(workerManager.call).toHaveBeenCalledWith(
      pluginId,
      "handleApiRequest",
      expect.objectContaining({
        routeKey: "smoke",
        method: "GET",
        companyId: scopedCompanyId,
        query: { companyId: scopedCompanyId },
      }),
    );
  }, 20_000);
});

describe.sequential("plugin local folder routes", () => {
  registerSuiteSetup({ emptyCompanySettings: true });

  it("rejects validation for undeclared local folder keys", async () => {
    readyLocalFolderPlugin();
    const { app } = await createApp(boardActor());

    const res = await request(app)
      .post(`/api/plugins/${_pluginId}/companies/${companyA}/local-folders/ssh/validate`)
      .send({ path: "/tmp" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Local folder key is not declared");
    expect(mockRegistry.upsertCompanySettings).not.toHaveBeenCalled();
  });

  it("rejects saving undeclared local folder keys", async () => {
    readyLocalFolderPlugin();
    const { app } = await createApp(boardActor());

    const res = await request(app)
      .put(`/api/plugins/${_pluginId}/companies/${companyA}/local-folders/ssh`)
      .send({ path: "/tmp" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Local folder key is not declared");
    expect(mockRegistry.upsertCompanySettings).not.toHaveBeenCalled();
  });

  it("rejects local-folder declaration overrides in REST input", async () => {
    readyLocalFolderPlugin();
    const { app } = await createApp(boardActor());

    const res = await request(app)
      .put(`/api/plugins/${_pluginId}/companies/${companyA}/local-folders/content-root`)
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
        .put(`/api/plugins/${_pluginId}/companies/${companyA}/local-folders/content-root`)
        .send({ path: folderPath });

      expect(res.status).toBe(200);
      await expect(fs.stat(path.join(folderPath, "docs"))).resolves.toMatchObject({});
      expect(mockRegistry.upsertCompanySettings).toHaveBeenCalledWith(_pluginId, companyA, {
        settingsJson: {
          localFolders: {
            "content-root": {
              path: folderPath,
            },
          },
        },
      });
    } finally {
      await fs.rm(folderPath, { recursive: true, force: true });
    }
  });
});
