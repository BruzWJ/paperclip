import * as t from "./plugin-worker-manager.test-support.js";
const { describe, it, configuredWorker, TEST_MANIFEST, expect } = t;
const { PLUGIN_RPC_ERROR_CODES, createTestWorker } = t;
const { DELAYED_WORKER_ENTRYPOINT, completeHostHandlers, vi } = t;
const { TERMINATED_WORKER_ENTRYPOINT, JsonRpcCallError } = t;
const { INVOCATION_SCOPE_WORKER_ENTRYPOINT, createHostClientHandlers } = t;

describe("plugin-worker-manager stderr failure context", () => {
  it.each([
    [{ rejectHealth: true }, "Health is not implemented"],
    [{ healthResult: null }, "Worker health must return an object"],
    [{ healthResult: { status: "ok", unexpected: true } }, "Worker health returned unexpected fields"],
    [
      { healthResult: { status: "degraded", message: "dependency lag" } },
      'Worker health check failed with status "degraded": dependency lag',
    ],
  ])("requires an exact healthy startup response", async (config, expected) => {
    const handle = configuredWorker(TEST_MANIFEST, config);

    try {
      await expect(handle.start()).rejects.toThrow(expected);
      expect(handle.status).not.toBe("running");
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("rejects optional calls the worker did not advertise", async () => {
    const handle = configuredWorker();

    try {
      await handle.start();
      await expect(
        handle.call("performAction", {
          key: "unadvertised",
          params: {},
          actorContext: {
            type: "system",
            companyId: null,
          },
          renderEnvironment: null,
        }),
      ).rejects.toMatchObject({
        code: PLUGIN_RPC_ERROR_CODES.METHOD_NOT_IMPLEMENTED,
        message: expect.stringContaining("did not advertise it during initialization"),
      });
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("times out advertised calls using the handle default when no override is provided", async () => {
    const handle = createTestWorker(DELAYED_WORKER_ENTRYPOINT, {
      rpcTimeoutMs: 10,
    });

    try {
      await handle.start();

      await expect(
        handle.call("getData", {
          key: "delayed",
          companyId: "company-1",
          params: { delayMs: 50 },
        }),
      ).rejects.toMatchObject({
        message: expect.stringContaining("timed out after 10ms"),
      });
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("honors per-call timeout overrides for advertised calls", async () => {
    const handle = createTestWorker(DELAYED_WORKER_ENTRYPOINT, {
      rpcTimeoutMs: 10,
    });

    try {
      await handle.start();

      await expect(
        handle.call(
          "getData",
          {
            key: "delayed",
            companyId: "company-1",
            params: { delayMs: 50 },
          },
          100,
        ),
      ).resolves.toMatchObject({
        exitCode: 0,
        stdout: "ok\n",
      });
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("fences new calls while stop drains an already-accepted request", async () => {
    const handle = createTestWorker(DELAYED_WORKER_ENTRYPOINT, {
      rpcTimeoutMs: 1_000,
    });

    try {
      await handle.start();
      const completionOrder: string[] = [];
      const activeRequest = handle
        .call("getData", {
          key: "accepted-before-stop",
          companyId: "company-1",
          params: { delayMs: 50 },
        })
        .then((result) => {
          completionOrder.push("request");
          return result;
        });
      const stop = handle.stop().then(() => {
        completionOrder.push("stop");
      });

      expect(handle.status).toBe("stopping");
      await expect(
        handle.call("getData", {
          key: "rejected-during-stop",
          companyId: "company-1",
          params: { delayMs: 0 },
        }),
      ).rejects.toMatchObject({
        code: PLUGIN_RPC_ERROR_CODES.WORKER_UNAVAILABLE,
        message: expect.stringContaining("is stopping"),
      });

      await expect(activeRequest).resolves.toMatchObject({ stdout: "ok\n" });
      await stop;
      expect(completionOrder).toEqual(["request", "stop"]);
      expect(handle.status).toBe("stopped");
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("does not emit an unhandled rejection when a plugin responds with terminated before callers attach handlers", async () => {
    const unhandledRejection = vi.fn();
    process.on("unhandledRejection", unhandledRejection);

    const handle = createTestWorker(TERMINATED_WORKER_ENTRYPOINT);

    try {
      await handle.start();

      const pendingCall = handle.call(
        "getData" as keyof t.HostToWorkerMethods,
        {
          key: "terminated",
          companyId: "company-1",
          params: {},
        } as t.HostToWorkerMethods[keyof t.HostToWorkerMethods][0],
      );

      await new Promise((resolve) => setImmediate(resolve));

      await expect(pendingCall).rejects.toBeInstanceOf(JsonRpcCallError);
      await expect(pendingCall).rejects.toMatchObject({
        message: expect.stringContaining("terminated"),
      });
      expect(unhandledRejection).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandledRejection);
      await handle.stop().catch(() => undefined);
    }
  });

  it("passes performAction invocation scope to nested worker host calls", async () => {
    const companiesGet = vi.fn(
      async (
        params: { companyId: string },
        context?: { invocationScope?: { companyId?: string | null } | null },
      ) => ({
        id: params.companyId,
        scopedCompanyId: context?.invocationScope?.companyId ?? null,
      }),
    );
    const handle = createTestWorker(INVOCATION_SCOPE_WORKER_ENTRYPOINT, {
      hostHandlers: completeHostHandlers({
        "companies.get": companiesGet as never,
      }),
    });

    try {
      await handle.start();

      await expect(
        handle.call("performAction", {
          key: "probe",
          params: {
            mode: "echo",
            requestedCompanyId: "company-a",
          },
          actorContext: {
            type: "agent",
            agentId: "agent-1",
            runId: "run-1",
            companyId: "company-a",
          },
          renderEnvironment: null,
        }),
      ).resolves.toEqual({
        id: "company-a",
        scopedCompanyId: "company-a",
      });
      expect(companiesGet).toHaveBeenCalledWith(
        { companyId: "company-a" },
        expect.objectContaining({
          invocationScope: { companyId: "company-a" },
          rpcOperationId: expect.stringMatching(/^pc_plugin_rpc_op_v1_/),
        }),
      );
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("passes echoed invocation scope to worker-to-host handlers", async () => {
    const companiesGet = vi.fn(async () => ({ id: "company-1" }));
    const handle = createTestWorker(INVOCATION_SCOPE_WORKER_ENTRYPOINT, {
      hostHandlers: completeHostHandlers({
        "companies.get": companiesGet as never,
      }),
    });

    try {
      await handle.start();

      await expect(
        handle.call("getData", {
          key: "probe",
          companyId: "company-1",
          params: {
            mode: "echo",
            requestedCompanyId: "company-1",
          },
        } as t.HostToWorkerMethods["getData"][0]),
      ).resolves.toEqual({ id: "company-1" });

      expect(companiesGet).toHaveBeenCalledWith(
        { companyId: "company-1" },
        expect.objectContaining({
          invocationScope: { companyId: "company-1" },
          rpcOperationId: expect.stringMatching(/^pc_plugin_rpc_op_v1_/),
        }),
      );
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("rejects performAction nested host calls that omit the invocation id", async () => {
    const handlers = createHostClientHandlers({
      pluginKey: "test.plugin",
      capabilities: ["companies.read"],
      services: {
        companies: {
          list: vi.fn(async () => []),
          get: vi.fn(async (params: { companyId: string }) => ({
            id: params.companyId,
          })),
        },
      } as unknown as t.HostServices,
    });
    const handle = createTestWorker(INVOCATION_SCOPE_WORKER_ENTRYPOINT, {
      hostHandlers: handlers,
    });

    try {
      await handle.start();

      await expect(
        handle.call("performAction", {
          key: "probe",
          params: {
            requestedCompanyId: "company-b",
          },
          actorContext: {
            type: "agent",
            agentId: "agent-1",
            runId: "run-1",
            companyId: "company-a",
          },
          renderEnvironment: null,
        }),
      ).rejects.toMatchObject({
        code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED,
        message: expect.stringContaining("unknown invocation scope"),
      });
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("rejects nested worker host calls that forge an unknown invocation id", async () => {
    const companiesGet = vi.fn(async (params: { companyId: string }) => ({
      id: params.companyId,
    }));
    const handlers = createHostClientHandlers({
      pluginKey: "test.plugin",
      capabilities: ["companies.read"],
      services: {
        companies: {
          get: companiesGet,
        },
      } as unknown as t.HostServices,
    });
    const handle = createTestWorker(INVOCATION_SCOPE_WORKER_ENTRYPOINT, {
      hostHandlers: handlers,
    });

    try {
      await handle.start();

      await expect(
        handle.call("performAction", {
          key: "probe",
          params: {
            mode: "unknown",
            requestedCompanyId: "company-a",
          },
          actorContext: {
            type: "agent",
            agentId: "agent-1",
            runId: "run-1",
            companyId: "company-a",
          },
          renderEnvironment: null,
        }),
      ).rejects.toMatchObject({
        code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED,
        message: expect.stringContaining("unknown invocation scope"),
      });
      expect(companiesGet).not.toHaveBeenCalled();
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });
});
