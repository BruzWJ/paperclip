import "./plugin-worker-manager.test-suite-01-appends-worker-stderr-context-to.js";
import "./plugin-worker-manager.test-suite-02-requires-an-exact-healthy-startup.js";
import * as t from "./plugin-worker-manager.test-support.js";
const { describe, it, vi, createHostClientHandlers, createTestWorker } = t;
const { INVOCATION_SCOPE_WORKER_ENTRYPOINT, TEST_MANIFEST, expect } = t;
const { PLUGIN_RPC_ERROR_CODES, RPC_OPERATION_WORKER_ENTRYPOINT } = t;
const { completeHostHandlers } = t;

describe("plugin-worker-manager stderr failure context", () => {
  it("rejects missing or unknown invocation ids while a company invocation is active", async () => {
    const companiesGet = vi.fn(async () => ({ id: "company-2" }));
    const hostHandlers = createHostClientHandlers({
      pluginKey: "test.plugin",
      capabilities: ["companies.read"],
      services: {
        companies: {
          get: companiesGet,
        },
      } as unknown as t.HostServices,
    });
    const handle = createTestWorker(INVOCATION_SCOPE_WORKER_ENTRYPOINT, {
      hostHandlers,
    });

    try {
      await handle.start();

      for (const mode of ["omit", "unknown"]) {
        await expect(
          handle.call("getData", {
            key: "probe",
            companyId: "company-1",
            params: {
              mode,
              requestedCompanyId: "company-2",
            },
          } as t.HostToWorkerMethods["getData"][0]),
        ).rejects.toMatchObject({
          code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED,
        });
      }

      expect(companiesGet).not.toHaveBeenCalled();
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("assigns one opaque operation identity to an exact worker RPC replay and a different identity to a distinct call", async () => {
    const withdraw = vi.fn(async (_params: unknown, context?: { rpcOperationId?: string }) => ({
      operationId: context?.rpcOperationId,
      task: {
        id: "task-1",
        lifecycleStatus: "closed",
        boardPresentationStatus: "cancelled",
      },
      retried: withdraw.mock.calls.length > 1,
    }));
    const handle = createTestWorker(RPC_OPERATION_WORKER_ENTRYPOINT, {
      hostHandlers: completeHostHandlers({
        "tasks.withdraw": withdraw as never,
      }),
    });

    try {
      await handle.start();

      const result = (await handle.call("getData", {
        key: "rpc-operation",
        companyId: "company-1",
        params: {},
      } as t.HostToWorkerMethods["getData"][0])) as {
        operationIds: string[];
      };

      expect(withdraw).toHaveBeenCalledTimes(3);
      expect(withdraw.mock.calls.map(([params]) => params)).toEqual([
        {
          taskId: "task-1",
          companyId: "company-1",
          message: "Withdraw this exact task.",
        },
        {
          taskId: "task-1",
          companyId: "company-1",
          message: "Withdraw this exact task.",
        },
        {
          taskId: "task-1",
          companyId: "company-1",
          message: "Withdraw this exact task.",
        },
      ]);
      expect(result.operationIds[0]).toBe(result.operationIds[1]);
      expect(result.operationIds[2]).not.toBe(result.operationIds[0]);
      expect(result.operationIds.every((id) => id.startsWith("pc_plugin_rpc_op_v1_"))).toBe(true);
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });
});

describe("plugin instance config host calls", () => {
  it("allows instance config without company scope", async () => {
    const configGet = vi.fn(async () => ({ apiKey: "configured" }));
    const handlers = createHostClientHandlers({
      pluginKey: "test.plugin",
      capabilities: [],
      services: {
        config: { get: configGet },
      } as unknown as t.HostServices,
    });

    await expect(handlers["config.get"]({})).resolves.toEqual({
      apiKey: "configured",
    });
    expect(configGet).toHaveBeenCalledWith({}, undefined);
  });

  it("keeps instance config independent from the invocation company", async () => {
    const configGet = vi.fn(async () => ({
      apiKey: "configured",
    }));
    const hostHandlers = createHostClientHandlers({
      pluginKey: "test.plugin",
      capabilities: [],
      services: {
        config: { get: configGet },
      } as unknown as t.HostServices,
    });
    const handle = createTestWorker(INVOCATION_SCOPE_WORKER_ENTRYPOINT, {
      hostHandlers,
    });

    try {
      await handle.start();

      await expect(
        handle.call("performAction", {
          key: "probe",
          params: {
            mode: "echo",
            hostMethod: "config.get",
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
      ).resolves.toEqual({ apiKey: "configured" });

      expect(configGet).toHaveBeenCalledWith({}, expect.any(Object));
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });
});
