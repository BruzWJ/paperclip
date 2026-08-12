import { describe, expect, expectTypeOf, it, vi } from "vitest";

import type { ProviderSafeRunTrace } from "@paperclipai/shared";
import type { HostServices } from "../src/host-client-factory.js";
import {
  CapabilityDeniedError,
  createHostClientHandlers,
  InvocationScopeDeniedError,
} from "../src/host-client-factory.js";
import {
  PLUGIN_RPC_ERROR_CODES,
  type WorkerToHostMethods,
} from "../src/protocol.js";

describe("createHostClientHandlers invocation company scope", () => {
  it("types authorization audit decisions as the exact protocol enum", () => {
    expectTypeOf<
      WorkerToHostMethods["authorization.audit.search"][0]["decision"]
    >().toEqualTypeOf<"allow" | "deny" | undefined>();
  });

  it("allows instance config reads without a company scope", async () => {
    const configGet = vi.fn(async () => ({ apiKey: "configured" }));
    const services = {
      config: { get: configGet },
    } as unknown as HostServices;

    const handlers = createHostClientHandlers({
      pluginKey: "paperclip.test",
      capabilities: [],
      services,
    });

    await expect(handlers["config.get"]({})).resolves.toEqual({ apiKey: "configured" });
    expect(configGet).toHaveBeenCalledWith({}, undefined);
  });

  it("ignores worker-supplied company fields for instance config", async () => {
    const configGet = vi.fn(async () => ({ apiKey: "configured" }));
    const services = {
      config: { get: configGet },
    } as unknown as HostServices;

    const handlers = createHostClientHandlers({
      pluginKey: "paperclip.test",
      capabilities: [],
      services,
    });
    const context = { invocationScope: { companyId: "company-a" } };

    await expect(
      handlers["config.get"]({ companyId: "company-b" } as never, context),
    ).resolves.toEqual({ apiKey: "configured" });

    expect(configGet).toHaveBeenCalledWith({}, context);
  });

  it("rejects company-scoped host calls outside the current invocation company", async () => {
    const projectsList = vi.fn(async () => []);
    const services = {
      projects: {
        list: projectsList,
      },
    } as unknown as HostServices;

    const handlers = createHostClientHandlers({
      pluginKey: "paperclip.test",
      capabilities: ["projects.read"],
      services,
    });

    await expect(
      handlers["projects.list"](
        { companyId: "company-b" },
        { invocationScope: { companyId: "company-a" } },
      ),
    ).rejects.toBeInstanceOf(InvocationScopeDeniedError);
    await expect(
      handlers["projects.list"](
        { companyId: "company-b" },
        { invocationScope: { companyId: "company-a" } },
      ),
    ).rejects.toMatchObject({
      code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED,
    });
    expect(projectsList).not.toHaveBeenCalled();
  });

  it("filters companies.list to the current invocation company", async () => {
    const services = {
      companies: {
        list: vi.fn(async () => [
          { id: "company-a", name: "Company A" },
          { id: "company-b", name: "Company B" },
        ]),
      },
    } as unknown as HostServices;

    const handlers = createHostClientHandlers({
      pluginKey: "paperclip.test",
      capabilities: ["companies.read"],
      services,
    });

    await expect(
      handlers["companies.list"](
        {},
        { invocationScope: { companyId: "company-a" } },
      ),
    ).resolves.toEqual([{ id: "company-a", name: "Company A" }]);
  });

  it("rejects company-scope store access for a different company", async () => {
    const stateGet = vi.fn(async () => null);
    const services = {
      state: {
        get: stateGet,
      },
    } as unknown as HostServices;

    const handlers = createHostClientHandlers({
      pluginKey: "paperclip.test",
      capabilities: ["plugin.state.read"],
      services,
    });

    await expect(
      handlers["state.get"](
        { scopeKind: "company", scopeId: "company-b", stateKey: "settings" },
        { invocationScope: { companyId: "company-a" } },
      ),
    ).rejects.toBeInstanceOf(InvocationScopeDeniedError);
    expect(stateGet).not.toHaveBeenCalled();
  });

  it.each([
    [
      "access.members.list",
      "access.members.read",
      { companyId: "company-a" },
      (services: HostServices) => vi.mocked(services.access.listMembers),
    ],
    [
      "access.members.update",
      "access.members.write",
      { companyId: "company-a", memberId: "member-a", patch: { status: "active" } },
      (services: HostServices) => vi.mocked(services.access.updateMember),
    ],
    [
      "authorization.grants.set",
      "authorization.grants.write",
      { companyId: "company-a", principalType: "agent", principalId: "agent-a", grants: [] },
      (services: HostServices) => vi.mocked(services.authorization.setGrants),
    ],
    [
      "authorization.policies.update",
      "authorization.policies.write",
      { companyId: "company-a", resourceType: "agent", resourceId: "agent-a", policy: null },
      (services: HostServices) => vi.mocked(services.authorization.updatePolicy),
    ],
    [
      "authorization.audit.search",
      "authorization.audit.read",
      { companyId: "company-a" },
      (services: HostServices) => vi.mocked(services.authorization.searchAudit),
    ],
  ] as const)(
    "rejects %s when the plugin lacks %s",
    async (method, capability, params, getDelegate) => {
      const services = {
        access: {
          listMembers: vi.fn(async () => []),
          updateMember: vi.fn(async () => ({ id: "member-a" })),
        },
        authorization: {
          setGrants: vi.fn(async () => []),
          updatePolicy: vi.fn(async () => ({ policy: null })),
          searchAudit: vi.fn(async () => []),
        },
      } as unknown as HostServices;
      const handlers = createHostClientHandlers({
        pluginKey: "paperclip.test",
        capabilities: [],
        services,
      });

      await expect(
        (handlers as Record<string, (input: unknown) => Promise<unknown>>)[method](params),
      ).rejects.toMatchObject({
        name: "CapabilityDeniedError",
        message: expect.stringContaining(capability),
      });
      await expect(
        (handlers as Record<string, (input: unknown) => Promise<unknown>>)[method](params),
      ).rejects.toBeInstanceOf(CapabilityDeniedError);
      expect(getDelegate(services)).not.toHaveBeenCalled();
    },
  );

  it("checks invocation company scope before exposing authorization data", async () => {
    const searchAudit = vi.fn(async () => []);
    const services = {
      authorization: {
        searchAudit,
      },
    } as unknown as HostServices;
    const handlers = createHostClientHandlers({
      pluginKey: "paperclip.test",
      capabilities: ["authorization.audit.read"],
      services,
    });

    await expect(
      handlers["authorization.audit.search"](
        { companyId: "company-b" },
        { invocationScope: { companyId: "company-a" } },
      ),
    ).rejects.toBeInstanceOf(InvocationScopeDeniedError);
    expect(searchAudit).not.toHaveBeenCalled();
  });

  it("gates withdrawal and injects the host-owned operation identity", async () => {
    const withdraw = vi.fn(async (_params, operation) => ({
      operationId: operation.hostRpcOperationId,
      task: { id: "task-1", status: "cancelled" },
      retried: false,
    }));
    const services = {
      tasks: { withdraw },
    } as unknown as HostServices;
    const handlers = createHostClientHandlers({
      pluginKey: "paperclip.test",
      capabilities: ["tasks.withdraw"],
      services,
    });

    await expect(handlers["tasks.withdraw"]({
      companyId: "company-a",
      taskId: "task-1",
      message: "No longer needed",
    }, {
      invocationScope: { companyId: "company-a" },
      rpcOperationId: "host-op-1",
    })).resolves.toMatchObject({
      operationId: "host-op-1",
      retried: false,
    });
    expect(withdraw).toHaveBeenCalledWith({
      companyId: "company-a",
      taskId: "task-1",
      message: "No longer needed",
    }, {
      hostRpcOperationId: "host-op-1",
    });

    await expect(handlers["tasks.withdraw"]({
      companyId: "company-a",
      taskId: "task-1",
      message: "No host identity",
    }, {
      invocationScope: { companyId: "company-a" },
    })).rejects.toThrow("Host-assigned RPC operation identity is required");

    await expect(handlers["tasks.withdraw"]({
      companyId: " company-a ",
      taskId: "task-1",
      message: "Aliased company identity",
    }, {
      invocationScope: { companyId: "company-a" },
      rpcOperationId: "host-op-1",
    })).rejects.toBeInstanceOf(InvocationScopeDeniedError);

    await expect(handlers["tasks.withdraw"]({
      companyId: "company-a",
      taskId: "task-1",
      message: "Aliased operation identity",
    }, {
      invocationScope: { companyId: "company-a" },
      rpcOperationId: " host-op-1 ",
    })).rejects.toThrow("Host-assigned RPC operation identity is required");

    const denied = createHostClientHandlers({
      pluginKey: "paperclip.test",
      capabilities: [],
      services,
    });
    await expect(denied["tasks.withdraw"]({
      companyId: "company-a",
      taskId: "task-1",
      message: "No longer needed",
    }, {
      invocationScope: { companyId: "company-a" },
      rpcOperationId: "host-op-2",
    })).rejects.toBeInstanceOf(CapabilityDeniedError);
  });
});

describe("createHostClientHandlers plugin run-context scope", () => {
  it.each([
    [
      "tasks.list",
      "tasks.read",
      { companyId: "company-a" },
    ],
    [
      "tasks.get",
      "tasks.read",
      { companyId: "company-a", taskId: "task-a" },
    ],
    [
      "tasks.creatorCallback.register",
      "tasks.create",
      { callbackKey: "creator", callbackVersion: "1" },
    ],
    [
      "tasks.create",
      "tasks.create",
      {
        companyId: "company-a",
        request: "Create ordinary plugin work.",
        ownerAgentId: "agent-a",
        callbackKey: "creator",
        callbackVersion: "1",
      },
    ],
    [
      "tasks.update",
      "tasks.update",
      {
        companyId: "company-a",
        taskId: "task-a",
        input: { kind: "message", message: "Creator message." },
      },
    ],
    [
      "tasks.withdraw",
      "tasks.withdraw",
      {
        companyId: "company-a",
        taskId: "task-a",
        message: "No longer needed.",
      },
    ],
  ] as const)(
    "rejects ordinary %s control-plane access while an agent run context is active",
    async (method, capability, params) => {
      const ordinaryTaskServices = {
        list: vi.fn(async () => []),
        get: vi.fn(async () => null),
        registerCreatorCallback: vi.fn(async () => ({
          callbackKey: "creator",
          callbackVersion: "1",
          registered: true as const,
        })),
        create: vi.fn(async () => ({ id: "task-a" })),
        update: vi.fn(async () => ({ id: "task-a" })),
        withdraw: vi.fn(async () => ({ task: { id: "task-a" } })),
      };
      const handlers = createHostClientHandlers({
        pluginKey: "paperclip.test",
        capabilities: [capability],
        services: {
          tasks: ordinaryTaskServices,
        } as unknown as HostServices,
      });

      await expect(
        (
          handlers as Record<
            string,
            (input: unknown, context: unknown) => Promise<unknown>
          >
        )[method](params, {
          invocationScope: {
            companyId: "company-a",
            pluginRunContextHandle: "pc_plugin_ctx_v1_exact",
          },
          rpcOperationId: "host-operation-a",
        }),
      ).rejects.toMatchObject({
        name: "InvocationScopeDeniedError",
        code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED,
        message: expect.stringContaining(
          "installation task control plane is unavailable while serving an agent run",
        ),
      });
      expect(
        Object.values(ordinaryTaskServices).reduce(
          (callCount, delegate) => callCount + delegate.mock.calls.length,
          0,
        ),
      ).toBe(0);
    },
  );

  it("allows a run-serving task read only with the exact active opaque handle", async () => {
    const listCompanyTasks = vi.fn(async () => ({
      items: [],
      nextCursor: null,
    }));
    const services = {
      runTasks: { listCompanyTasks },
    } as unknown as HostServices;
    const handlers = createHostClientHandlers({
      pluginKey: "paperclip.test",
      capabilities: ["tasks.read"],
      services,
    });
    const params = {
      runContextHandle: "pc_plugin_ctx_v1_exact",
      limit: 10,
    };

    await expect(
      handlers["run.tasks.listCompanyTasks"](params, {
        invocationScope: {
          companyId: "company-a",
          pluginRunContextHandle: "pc_plugin_ctx_v1_exact",
        },
      }),
    ).resolves.toEqual({ items: [], nextCursor: null });
    expect(listCompanyTasks).toHaveBeenCalledWith(params);
  });

  it("gates privileged run identity resolution by capability and exact opaque handle", async () => {
    const resolved = {
      companyId: "company-a",
      taskId: "task-a",
      agentId: "agent-a",
      runId: "run-a",
      projectId: null,
      contextAccess: {
        carry_context: false,
        read_task_comments: false,
        read_task_agent_run: false,
        list_sub_tasks: false,
        read_sub_task_comments: false,
        read_sub_task_agent_run: false,
        list_company_tasks: false,
        read_company_task_comments: false,
        read_company_task_agent_run: false,
      },
    };
    const resolveContext = vi.fn(async () => resolved);
    const params = { runContextHandle: "pc_plugin_ctx_v1_exact" };
    const context = {
      invocationScope: {
        companyId: "company-a",
        pluginRunContextHandle: "pc_plugin_ctx_v1_exact",
      },
    };
    const services = {
      runTasks: { resolveContext },
    } as unknown as HostServices;

    await expect(createHostClientHandlers({
      pluginKey: "paperclip.test",
      capabilities: [],
      services,
    })["run.context.resolve"](params, context)).rejects.toBeInstanceOf(
      CapabilityDeniedError,
    );
    await expect(createHostClientHandlers({
      pluginKey: "paperclip.test",
      capabilities: ["runtime.context.read"],
      services,
    })["run.context.resolve"](params, context)).resolves.toBe(resolved);
  });

  it("keeps privileged runtime records inside the invocation company", async () => {
    const readTaskComments = vi.fn(async () => ({ items: [], nextCursor: null }));
    const readSession = vi.fn(async () => ({
      session: {
        companyId: "company-a",
        taskId: "task-a",
        sessionId: "session-a",
      },
      snapshotHighWaterSeq: 15,
    }) as never);
    const services = {
      runtimeRecords: { readTaskComments, readSession },
    } as unknown as HostServices;
    const handlers = createHostClientHandlers({
      pluginKey: "paperclip.test",
      capabilities: ["runtime.records.read"],
      services,
    });

    await expect(handlers["runtime.records.readTaskComments"](
      { companyId: "company-b", taskId: "task-b" },
      { invocationScope: { companyId: "company-a" } },
    )).rejects.toBeInstanceOf(InvocationScopeDeniedError);
    expect(readTaskComments).not.toHaveBeenCalled();

    const sessionInput = {
      companyId: "company-a",
      sessionId: "session-a",
      snapshotHighWaterSeq: 15,
      messages: { afterSeq: 8, limit: 50 },
      events: { afterSeq: -1, limit: 50 },
    };
    await handlers["runtime.records.readSession"](sessionInput, {
      invocationScope: {
        companyId: "company-a",
        canonicalSession: {
          taskId: "task-a",
          sessionId: "session-a",
          snapshotHighWaterSeq: 15,
        },
      },
    });
    expect(readSession).toHaveBeenCalledWith(sessionInput);

    await expect(handlers["runtime.records.readSession"](
      { ...sessionInput, snapshotHighWaterSeq: 16 },
      {
        invocationScope: {
          companyId: "company-a",
          canonicalSession: {
            taskId: "task-a",
            sessionId: "session-a",
            snapshotHighWaterSeq: 15,
          },
        },
      },
    )).rejects.toBeInstanceOf(InvocationScopeDeniedError);
    expect(readSession).toHaveBeenCalledOnce();

    await expect(handlers["runtime.records.readSession"](
      { ...sessionInput, companyId: "company-b" },
      { invocationScope: { companyId: "company-a" } },
    )).rejects.toBeInstanceOf(InvocationScopeDeniedError);
    expect(readSession).toHaveBeenCalledOnce();

    await expect(createHostClientHandlers({
      pluginKey: "paperclip.test",
      capabilities: [],
      services,
    })["runtime.records.readSession"](sessionInput)).rejects.toBeInstanceOf(
      CapabilityDeniedError,
    );
  });

  it("uses the shared gateway trace DTO unchanged in the plugin protocol", async () => {
    type PluginTrace =
      WorkerToHostMethods["run.tasks.readTaskAgentRun"][1];
    expectTypeOf<PluginTrace>().toEqualTypeOf<ProviderSafeRunTrace>();

    const trace: ProviderSafeRunTrace = {
      runId: "run-a",
      runKind: "productive",
      status: "succeeded",
      startedAt: "2026-07-25T00:00:00.000Z",
      finishedAt: "2026-07-25T00:01:00.000Z",
      outcome: "succeeded",
      turns: [
        {
          kind: "assistant",
          timestamp: "2026-07-25T00:00:30.000Z",
          content: [
            { kind: "reasoning", text: "Safe summary" },
            {
              kind: "tool",
              name: "lookup",
              state: "completed",
              input: { query: "safe" },
              result: { answer: "safe" },
            },
          ],
        },
      ],
      outputComments: [
        { commentId: "comment-a" },
      ],
    };
    const readTaskAgentRun = vi.fn(async () => trace);
    const services = {
      runTasks: { readTaskAgentRun },
    } as unknown as HostServices;
    const handlers = createHostClientHandlers({
      pluginKey: "paperclip.test",
      capabilities: ["tasks.read"],
      services,
    });
    const params = {
      runContextHandle: "pc_plugin_ctx_v1_exact",
      runId: "run-a",
    };

    const result = await handlers["run.tasks.readTaskAgentRun"](params, {
      invocationScope: {
        companyId: "company-a",
        pluginRunContextHandle: "pc_plugin_ctx_v1_exact",
      },
    });

    expect(result).toBe(trace);
    expect(readTaskAgentRun).toHaveBeenCalledWith(params);
  });

  it.each([
    ["missing invocation", undefined],
    [
      "missing run handle",
      { invocationScope: { companyId: "company-a" } },
    ],
    [
      "forged run handle",
      {
        invocationScope: {
          companyId: "company-a",
          pluginRunContextHandle: "pc_plugin_ctx_v1_other",
        },
      },
    ],
    ["expired invocation", { invalidInvocationScope: true }],
  ])("rejects %s without calling the run reader", async (_label, context) => {
    const readTaskComments = vi.fn(async () => ({
      items: [],
      nextCursor: null,
    }));
    const services = {
      runTasks: { readTaskComments },
    } as unknown as HostServices;
    const handlers = createHostClientHandlers({
      pluginKey: "paperclip.test",
      capabilities: ["tasks.read"],
      services,
    });

    await expect(
      handlers["run.tasks.readTaskComments"](
        { runContextHandle: "pc_plugin_ctx_v1_exact" },
        context,
      ),
    ).rejects.toBeInstanceOf(InvocationScopeDeniedError);
    expect(readTaskComments).not.toHaveBeenCalled();
  });

  it("keeps the installation control plane available outside runs and unrelated control-plane calls available during runs", async () => {
    const list = vi.fn(async () => []);
    const managedGet = vi.fn(async () => ({ routine: null }));
    const services = {
      tasks: { list },
      routines: { managedGet },
    } as unknown as HostServices;
    const handlers = createHostClientHandlers({
      pluginKey: "paperclip.test",
      capabilities: ["tasks.read", "routines.managed"],
      services,
    });

    await expect(
      handlers["tasks.list"](
        { companyId: "company-a" },
        { invocationScope: { companyId: "company-a" } },
      ),
    ).resolves.toEqual([]);
    expect(list).toHaveBeenCalledWith({ companyId: "company-a" });

    await expect(
      handlers["routines.managed.get"](
        { routineKey: "daily", companyId: "company-a" },
        {
          invocationScope: {
            companyId: "company-a",
            pluginRunContextHandle: "pc_plugin_ctx_v1_exact",
          },
        },
      ),
    ).resolves.toEqual({ routine: null });
    expect(managedGet).toHaveBeenCalledWith({
      routineKey: "daily",
      companyId: "company-a",
    });
  });
});
