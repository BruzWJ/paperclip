import * as t from "./plugin-routes-authz.test-support.js";
const { describe, registerSuiteSetup, it, pluginId, readyPlugin, vi, createApp } = t;
const { boardActor, request, expect, companyA, companyB, jobRunId, jobId } = t;
const { mockRegistry, pluginRecord } = t;

describe.sequential("plugin bridge authz", () => {
  registerSuiteSetup();

  it.each([
    ["data", "post", `/api/plugins/${pluginId}/data/health`, {}],
    ["action", "post", `/api/plugins/${pluginId}/actions/sync`, {}],
  ] as const)(
    "rejects %s bridge calls without companyId for non-admin users",
    async (_name, _method, path, body) => {
      readyPlugin();
      const call = vi.fn();
      const { app } = await createApp(boardActor(), {
        runtime: {
          workerManager: { call },
        },
      });

      const res = await request(app).post(path).send(body);

      expect(res.status).toBe(403);
      expect(call).not.toHaveBeenCalled();
    },
  );

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
    const { app } = await createApp(
      boardActor({
        userId: "admin-1",
        isInstanceAdmin: true,
        companyIds: [],
      }),
      {
        runtime: {
          workerManager: { call },
        },
      },
    );

    const res = await request(app).post(`/api/plugins/${pluginId}/actions/sync`).send({});

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
      memberships: [
        {
          companyId: companyA,
          membershipRole: "operator",
          status: "active",
        },
      ],
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

    const res = await request(app).post(`/api/plugins/${pluginId}/jobs/job-1/trigger`).send({});

    expect(res.status).toBe(403);
    expect(scheduler.triggerJob).not.toHaveBeenCalled();
    expect(jobStore.getJobByIdForPlugin).not.toHaveBeenCalled();
  }, 15_000);

  it("allows manual job triggers for instance admins", async () => {
    readyPlugin();
    const scheduler = {
      triggerJob: vi.fn().mockResolvedValue({ runId: jobRunId, jobId }),
    };
    const jobStore = {
      getJobByIdForPlugin: vi.fn().mockResolvedValue({ id: jobId }),
    };
    const { app } = await createApp(
      boardActor({
        userId: "admin-1",
        isInstanceAdmin: true,
        companyIds: [],
      }),
      {
        runtime: { scheduler, jobStore },
      },
    );

    const res = await request(app).post(`/api/plugins/${pluginId}/jobs/${jobId}/trigger`).send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ runId: jobRunId, jobId });
    expect(scheduler.triggerJob).toHaveBeenCalledWith(jobId);
  });

  it("rejects noncanonical job identity aliases before lookup", async () => {
    readyPlugin();
    const scheduler = { triggerJob: vi.fn() };
    const jobStore = { getJobByIdForPlugin: vi.fn() };
    const { app } = await createApp(
      boardActor({
        userId: "admin-1",
        isInstanceAdmin: true,
        companyIds: [],
      }),
      {
        runtime: { scheduler, jobStore },
      },
    );

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/jobs/${jobId.toUpperCase()}/trigger`)
      .send({});

    expect(res.status).toBe(404);
    expect(jobStore.getJobByIdForPlugin).not.toHaveBeenCalled();
    expect(scheduler.triggerJob).not.toHaveBeenCalled();
  });
});

describe.sequential("plugin webhook body transport", () => {
  registerSuiteSetup();

  it("forwards non-JSON bytes while preserving JSON raw and parsed bodies", async () => {
    mockRegistry.getById.mockResolvedValue(
      pluginRecord({
        manifestJson: {
          ...pluginRecord().manifestJson,
          capabilities: ["webhooks.receive"],
          webhooks: [{ endpointKey: "events", displayName: "Events" }],
        },
      }),
    );
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
