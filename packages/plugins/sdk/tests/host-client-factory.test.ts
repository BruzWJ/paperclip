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
  it("rejects worker-selected config and secret company ids without a host invocation scope", async () => {
    const configGet = vi.fn(async () => ({ apiKeyRef: "unreachable" }));
    const secretsResolve = vi.fn(async () => "unreachable");
    const services = {
      config: { get: configGet },
      secrets: { resolve: secretsResolve },
    } as unknown as HostServices;

    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["secrets.read-ref"],
      services,
    });

    await expect(
      handlers["config.get"]({ companyId: "company-a" }),
    ).rejects.toBeInstanceOf(InvocationScopeDeniedError);
    await expect(
      handlers["secrets.resolve"]({
        companyId: "company-a",
        secretRef: { type: "secret_ref", secretId: "secret-a" },
      }),
    ).rejects.toBeInstanceOf(InvocationScopeDeniedError);
    expect(configGet).not.toHaveBeenCalled();
    expect(secretsResolve).not.toHaveBeenCalled();
  });

  it("allows explicit config and secret company ids only when they match the host invocation scope", async () => {
    const configGet = vi.fn(async () => ({ apiKeyRef: "ref" }));
    const secretsResolve = vi.fn(async () => "resolved");
    const services = {
      config: { get: configGet },
      secrets: { resolve: secretsResolve },
    } as unknown as HostServices;

    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["secrets.read-ref"],
      services,
    });
    const context = { invocationScope: { companyId: "company-a" } };

    await expect(
      handlers["config.get"]({ companyId: "company-a" }, context),
    ).resolves.toEqual({ apiKeyRef: "ref" });
    await expect(
      handlers["secrets.resolve"]({
        companyId: "company-a",
        secretRef: { type: "secret_ref", secretId: "secret-a" },
      }, context),
    ).resolves.toBe("resolved");

    expect(configGet).toHaveBeenCalledWith({ companyId: "company-a" }, context);
    expect(secretsResolve).toHaveBeenCalledWith({
      companyId: "company-a",
      secretRef: { type: "secret_ref", secretId: "secret-a" },
    }, context);
  });

  it("rejects company-scoped host calls outside the current invocation company", async () => {
    const projectsList = vi.fn(async () => []);
    const services = {
      projects: {
        list: projectsList,
      },
    } as unknown as HostServices;

    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
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
      pluginId: "paperclip.test",
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
      pluginId: "paperclip.test",
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
        pluginId: "paperclip.test",
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
      pluginId: "paperclip.test",
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
      issue: { id: "issue-1", status: "cancelled" },
      retried: false,
    }));
    const services = {
      issues: { withdraw },
    } as unknown as HostServices;
    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["issues.withdraw"],
      services,
    });

    await expect(handlers["issues.withdraw"]({
      companyId: "company-a",
      issueId: "issue-1",
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
      issueId: "issue-1",
      message: "No longer needed",
    }, {
      hostRpcOperationId: "host-op-1",
    });

    await expect(handlers["issues.withdraw"]({
      companyId: "company-a",
      issueId: "issue-1",
      message: "No host identity",
    }, {
      invocationScope: { companyId: "company-a" },
    })).rejects.toThrow("Host-assigned RPC operation identity is required");

    const denied = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: [],
      services,
    });
    await expect(denied["issues.withdraw"]({
      companyId: "company-a",
      issueId: "issue-1",
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
      "issues.list",
      "issues.read",
      { companyId: "company-a" },
    ],
    [
      "issues.get",
      "issues.read",
      { companyId: "company-a", issueId: "issue-a" },
    ],
    [
      "issues.creatorCallback.register",
      "issues.create",
      { callbackKey: "creator", callbackVersion: "1" },
    ],
    [
      "issues.create",
      "issues.create",
      {
        companyId: "company-a",
        request: "Create ordinary plugin work.",
        ownerAgentId: "agent-a",
        callbackKey: "creator",
        callbackVersion: "1",
      },
    ],
    [
      "issues.update",
      "issues.update",
      {
        companyId: "company-a",
        issueId: "issue-a",
        input: { kind: "message", message: "Creator message." },
      },
    ],
    [
      "issues.withdraw",
      "issues.withdraw",
      {
        companyId: "company-a",
        issueId: "issue-a",
        message: "No longer needed.",
      },
    ],
  ] as const)(
    "rejects ordinary %s control-plane access while an agent run context is active",
    async (method, capability, params) => {
      const ordinaryIssueServices = {
        list: vi.fn(async () => []),
        get: vi.fn(async () => null),
        registerCreatorCallback: vi.fn(async () => ({
          callbackKey: "creator",
          callbackVersion: "1",
          registered: true as const,
        })),
        create: vi.fn(async () => ({ id: "issue-a" })),
        update: vi.fn(async () => ({ id: "issue-a" })),
        withdraw: vi.fn(async () => ({ issue: { id: "issue-a" } })),
      };
      const handlers = createHostClientHandlers({
        pluginId: "paperclip.test",
        capabilities: [capability],
        services: {
          issues: ordinaryIssueServices,
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
          "installation issue control plane is unavailable while serving an agent run",
        ),
      });
      expect(
        Object.values(ordinaryIssueServices).reduce(
          (callCount, delegate) => callCount + delegate.mock.calls.length,
          0,
        ),
      ).toBe(0);
    },
  );

  it("allows a run-serving issue read only with the exact active opaque handle", async () => {
    const listCompanyIssues = vi.fn(async () => ({
      items: [],
      nextCursor: null,
    }));
    const services = {
      runIssues: { listCompanyIssues },
    } as unknown as HostServices;
    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["issues.read"],
      services,
    });
    const params = {
      runContextHandle: "pc_plugin_ctx_v1_exact",
      limit: 10,
    };

    await expect(
      handlers["run.issues.listCompanyIssues"](params, {
        invocationScope: {
          companyId: "company-a",
          pluginRunContextHandle: "pc_plugin_ctx_v1_exact",
        },
      }),
    ).resolves.toEqual({ items: [], nextCursor: null });
    expect(listCompanyIssues).toHaveBeenCalledWith(params);
  });

  it("gates privileged run identity resolution by capability and exact opaque handle", async () => {
    const resolved = {
      companyId: "company-a",
      issueId: "issue-a",
      agentId: "agent-a",
      runId: "run-a",
      projectId: null,
      contextAccess: {},
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
      runIssues: { resolveContext },
    } as unknown as HostServices;

    await expect(createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: [],
      services,
    })["run.context.resolve"](params, context)).rejects.toBeInstanceOf(
      CapabilityDeniedError,
    );
    await expect(createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["runtime.context.read"],
      services,
    })["run.context.resolve"](params, context)).resolves.toBe(resolved);
  });

  it("keeps privileged runtime records inside the invocation company", async () => {
    const readIssueComments = vi.fn(async () => ({ items: [], nextCursor: null }));
    const services = {
      runtimeRecords: { readIssueComments },
    } as unknown as HostServices;
    const handler = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["runtime.records.read"],
      services,
    })["runtime.records.readIssueComments"];

    await expect(handler(
      { companyId: "company-b", issueId: "issue-b" },
      { invocationScope: { companyId: "company-a" } },
    )).rejects.toBeInstanceOf(InvocationScopeDeniedError);
    expect(readIssueComments).not.toHaveBeenCalled();
  });

  it("uses the shared gateway trace DTO unchanged in the plugin protocol", async () => {
    type PluginTrace =
      WorkerToHostMethods["run.issues.readIssueAgentRun"][1];
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
    const readIssueAgentRun = vi.fn(async () => trace);
    const services = {
      runIssues: { readIssueAgentRun },
    } as unknown as HostServices;
    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["issues.read"],
      services,
    });
    const params = {
      runContextHandle: "pc_plugin_ctx_v1_exact",
      runId: "run-a",
    };

    const result = await handlers["run.issues.readIssueAgentRun"](params, {
      invocationScope: {
        companyId: "company-a",
        pluginRunContextHandle: "pc_plugin_ctx_v1_exact",
      },
    });

    expect(result).toBe(trace);
    expect(readIssueAgentRun).toHaveBeenCalledWith(params);
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
    const readIssueComments = vi.fn(async () => ({
      items: [],
      nextCursor: null,
    }));
    const services = {
      runIssues: { readIssueComments },
    } as unknown as HostServices;
    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["issues.read"],
      services,
    });

    await expect(
      handlers["run.issues.readIssueComments"](
        { runContextHandle: "pc_plugin_ctx_v1_exact" },
        context,
      ),
    ).rejects.toBeInstanceOf(InvocationScopeDeniedError);
    expect(readIssueComments).not.toHaveBeenCalled();
  });

  it("keeps the installation control plane available outside runs and unrelated control-plane calls available during runs", async () => {
    const list = vi.fn(async () => []);
    const managedGet = vi.fn(async () => ({ routine: null }));
    const services = {
      issues: { list },
      routines: { managedGet },
    } as unknown as HostServices;
    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["issues.read", "routines.managed"],
      services,
    });

    await expect(
      handlers["issues.list"](
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
