import * as t from "./plugin-routes-authz.test-support.js";
const { describe, registerSuiteSetup, it, createApp, boardActor, request, expect } = t;
const { mockLifecycle, pluginRecord, pluginId: _pluginId, installedAt, updatedAt } = t;
const { mockRegistry, companyA, readyPlugin, pluginConfig } = t;

describe.sequential("plugin install and upgrade authz", () => {
  registerSuiteSetup();

  it("rejects plugin installation for non-admin board users", async () => {
    const { app } = await createApp(
      boardActor({
        companyIds: ["company-1"],
      }),
    );

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
      id: _pluginId,
      installedAt: installedAt.toISOString(),
      updatedAt: updatedAt.toISOString(),
    });
    expect(mockLifecycle.install).toHaveBeenCalledWith({
      source: "npm",
      packageName: "paperclip-plugin-example",
    });
  }, 20_000);

  it("rejects undeclared install fields", async () => {
    const { app } = await createApp(
      boardActor({
        isInstanceAdmin: true,
        companyIds: [],
      }),
    );

    const res = await request(app).post("/api/plugins/install").send({
      source: "npm",
      packageName: "paperclip-plugin-example",
      unsupportedField: false,
    });

    expect(res.status).toBe(400);
    expect(mockLifecycle.install).not.toHaveBeenCalled();
  }, 20_000);

  it("accepts only exact npm names and absolute local paths", async () => {
    const { app } = await createApp(
      boardActor({
        isInstanceAdmin: true,
        companyIds: [],
      }),
    );

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
    const { app } = await createApp(
      boardActor({
        companyIds: ["company-1"],
      }),
    );

    const res = await request(app).post(`/api/plugins/${pluginId}/upgrade`).send({});

    expect(res.status).toBe(403);
    expect(mockRegistry.getById).not.toHaveBeenCalled();
    expect(mockLifecycle.upgrade).not.toHaveBeenCalled();
  }, 20_000);

  it.each([
    ["logs", `/api/plugins/${_pluginId}/logs`],
    ["configuration", `/api/plugins/${_pluginId}/config`],
    ["jobs", `/api/plugins/${_pluginId}/jobs`],
    ["job runs", `/api/plugins/${_pluginId}/jobs/job-1/runs`],
    ["dashboard", `/api/plugins/${_pluginId}/dashboard`],
  ])(
    "rejects instance-wide plugin %s reads for non-admin board users",
    async (_name, path) => {
      const { app } = await createApp(boardActor({ companyIds: [companyA] }));

      const res = await request(app).get(path);

      expect(res.status).toBe(403);
      expect(mockRegistry.getById).not.toHaveBeenCalled();
    },
    20_000,
  );

  it.each([
    ["delete", "delete", "/api/plugins/11111111-1111-4111-8111-111111111111", undefined],
    ["enable", "post", "/api/plugins/11111111-1111-4111-8111-111111111111/enable", {}],
    ["disable", "post", "/api/plugins/11111111-1111-4111-8111-111111111111/disable", {}],
    ["config", "post", "/api/plugins/11111111-1111-4111-8111-111111111111/config", { configJson: {} }],
    [
      "config test",
      "post",
      "/api/plugins/11111111-1111-4111-8111-111111111111/config/test",
      { configJson: {} },
    ],
  ] as const)(
    "rejects plugin %s for non-admin board users",
    async (_name, method, path, body) => {
      const { app } = await createApp(
        boardActor({
          companyIds: ["company-1"],
        }),
      );

      const req = method === "delete" ? request(app).delete(path) : request(app).post(path).send(body);
      const res = await req;

      expect(res.status).toBe(403);
      expect(mockRegistry.getById).not.toHaveBeenCalled();
      expect(mockLifecycle.updateConfig).not.toHaveBeenCalled();
      expect(mockLifecycle.unload).not.toHaveBeenCalled();
      expect(mockLifecycle.enable).not.toHaveBeenCalled();
      expect(mockLifecycle.disable).not.toHaveBeenCalled();
    },
    20_000,
  );

  it("rejects plugin keys because installation routes are UUID-only", async () => {
    const pluginKey = "paperclipqa.hello-plugin";
    const { app } = await createApp(
      boardActor({
        userId: "admin-1",
        userName: "Admin One",
        userEmail: "admin-1@paperclip.test",
        sessionId: "session-admin-1",
        isInstanceAdmin: true,
        companyIds: [companyA],
      }),
    );

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
    const { app } = await createApp(
      boardActor({
        isInstanceAdmin: true,
        companyIds: [],
      }),
    );

    const first = await request(app).delete(`/api/plugins/${_pluginId}`);
    const repeated = await request(app).delete(`/api/plugins/${_pluginId}`);

    expect(first.status).toBe(204);
    expect(repeated.status).toBe(204);
    expect(mockLifecycle.unload).toHaveBeenNthCalledWith(1, _pluginId);
    expect(mockLifecycle.unload).toHaveBeenNthCalledWith(2, _pluginId);
  }, 20_000);

  it("rejects removed uninstall query options", async () => {
    const { app } = await createApp(
      boardActor({
        isInstanceAdmin: true,
        companyIds: [],
      }),
    );

    const res = await request(app).delete(`/api/plugins/${_pluginId}`).query({ purge: "true" });

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

    const res = await request(app).post(`/api/plugins/${_pluginId}/config`).send({ configJson: draftConfig });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      createdAt: installedAt.toISOString(),
      updatedAt: updatedAt.toISOString(),
    });
    expect(mockLifecycle.updateConfig).toHaveBeenCalledWith(_pluginId, draftConfig);
  }, 20_000);

  it("lets an instance admin read config without company membership", async () => {
    readyPlugin();
    mockRegistry.getConfig.mockResolvedValue(
      pluginConfig({
        endpoint: "https://service.example",
      }),
    );

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

    const res = await request(app).get(`/api/plugins/${_pluginId}/config`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      createdAt: installedAt.toISOString(),
      updatedAt: updatedAt.toISOString(),
    });
    expect(mockRegistry.getConfig).toHaveBeenCalledWith(_pluginId);
  }, 20_000);

  it("delegates configuration and runtime coordination to the lifecycle", async () => {
    readyPlugin();
    mockLifecycle.updateConfig.mockResolvedValue(
      pluginConfig({ revision: "next" }, { id: "config-restart" }),
    );
    const { app } = await createApp(
      boardActor({
        isInstanceAdmin: true,
        companyIds: [],
      }),
      { runtime: {} },
    );

    const response = await request(app)
      .post(`/api/plugins/${_pluginId}/config`)
      .send({ configJson: { revision: "next" } });

    expect(response.status).toBe(200);
    expect(mockLifecycle.updateConfig).toHaveBeenCalledWith(_pluginId, {
      revision: "next",
    });
  }, 20_000);

  it("does not duplicate the lifecycle-owned error transition when config reload fails", async () => {
    readyPlugin();
    mockLifecycle.updateConfig.mockRejectedValue(new Error("worker failed"));
    const { app } = await createApp(
      boardActor({
        isInstanceAdmin: true,
        companyIds: [],
      }),
    );

    const res = await request(app)
      .post(`/api/plugins/${_pluginId}/config`)
      .send({ configJson: { endpoint: "https://service.example" } });

    expect(res.status).toBe(400);
    expect(mockLifecycle.updateConfig).toHaveBeenCalledTimes(1);
    expect(mockLifecycle.markError).not.toHaveBeenCalled();
  }, 20_000);

  it("allows instance admins to upgrade plugins", async () => {
    mockRegistry.getById.mockResolvedValue(pluginRecord());
    mockLifecycle.upgrade.mockResolvedValue(
      pluginRecord({
        manifestJson: {
          ...pluginRecord().manifestJson,
          version: "1.1.0",
        },
      }),
    );

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

    const res = await request(app).post(`/api/plugins/${_pluginId}/upgrade`).send({ version: "1.1.0" });

    expect(res.status).toBe(200);
    expect(mockLifecycle.upgrade).toHaveBeenCalledWith(_pluginId, "1.1.0");
  }, 20_000);
});
