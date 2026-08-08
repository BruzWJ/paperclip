import { createHash } from "node:crypto";
import {
  agents,
  companies,
  issueExecutionAttempts,
  issueExecutionAuthorities,
  issueExecutionLeases,
  issueExecutionPromptCapabilities,
  issueExecutionPromptSegments,
  issueExecutionRefs,
  issueExecutionRunControls,
  issueExecutionRunRefs,
  issueExecutionSessions,
  issueExecutionWorkspaceBindings,
  issues,
  type Db,
} from "@paperclipai/db";
import { describe, expect, it, vi } from "vitest";
import { resolveContextDial } from "./context-dial-resolver.js";
import {
  createPromptCapabilityGateway,
  mintPromptCapabilityBearer,
  PromptCapabilityAuthenticationError,
  PromptCapabilityAuthorityError,
  type PromptCapabilityBinding,
  type PromptCapabilityGatewayRepository,
  type PromptCapabilityToolExecutor,
} from "./prompt-capability-gateway.js";
import {
  createPostgresPromptCapabilityGatewayRepository,
  lockActivePromptCapabilityBinding,
} from "./prompt-capability-gateway-postgres.js";
import type { IssueSessionDbTransaction } from "./issue-session/event-store.js";
import type { RuntimeInterfaceCompileInput } from "./runtime-interface-compiler.js";
import {
  createRuntimePluginToolPort,
  createRuntimeToolExecutor,
} from "./runtime-tool-executor.js";

const now = new Date("2026-07-31T12:00:00.000Z");
const capability: PromptCapabilityBinding = Object.freeze({
  companyId: "00000000-0000-4000-8000-000000000001",
  capabilityConnectionId: "00000000-0000-4000-8000-000000000002",
  capabilityGeneration: 3,
  runId: "00000000-0000-4000-8000-000000000003",
  runBatchDigest: "a".repeat(64),
  refId: "00000000-0000-4000-8000-000000000004",
  refOrdinal: 1,
  segmentOrdinal: 0,
  attemptId: "00000000-0000-4000-8000-000000000005",
  leaseId: "00000000-0000-4000-8000-000000000006",
  leaseGeneration: 2,
  workerProcessIdentity: "00000000-0000-4000-8000-000000000007",
  issueId: "00000000-0000-4000-8000-000000000008",
  sessionId: "ses_canonical",
  ownershipEpoch: 4,
  targetAgentId: "00000000-0000-4000-8000-000000000009",
  laneKind: "owner",
  executionMode: "owner",
  issueExecutionAuthorityId: "00000000-0000-4000-8000-00000000000a",
  consultExecutionId: null,
  adapterConfigIdentity: "00000000-0000-4000-8000-00000000000b",
  workspaceIdentity: "00000000-0000-4000-8000-00000000000c",
  targetSessionCorrelationId: "00000000-0000-4000-8000-00000000000d",
  effectiveContextExposureDigest: "b".repeat(64),
  effectiveToolsDigest: "c".repeat(64),
  bootstrapToolGate: false,
  expiresAt: new Date("2026-07-31T12:05:00.000Z"),
  activatedAt: new Date("2026-07-31T11:59:00.000Z"),
  createdAt: new Date("2026-07-31T11:58:00.000Z"),
});

function capabilityLockTransaction(row: unknown, databaseTime = now) {
  const selectedTables: unknown[] = [];
  const lockedTables: unknown[] = [];
  const transaction = {
    async execute() {
      return [{ timestamp: databaseTime }];
    },
    select() {
      let table: unknown;
      const builder = {
        from(value: unknown) {
          table = value;
          selectedTables.push(value);
          return builder;
        },
        where() {
          return builder;
        },
        limit() {
          return builder;
        },
        for() {
          lockedTables.push(table);
          return Promise.resolve([row]);
        },
      };
      return builder;
    },
  } as unknown as IssueSessionDbTransaction;
  return { transaction, selectedTables, lockedTables };
}

function persistedCapabilityRow(input: {
  expiresAt: Date;
  state?: "active" | "revoked";
}) {
  const {
    bootstrapToolGate: _bootstrapToolGate,
    ...persistentCapability
  } = capability;
  return {
    ...persistentCapability,
    state: input.state ?? "active",
    expiresAt: input.expiresAt,
    bearerHash: "d".repeat(64),
    revocationReason: input.state === "revoked" ? "fixture" : null,
    revokedAt: input.state === "revoked" ? now : null,
  };
}

function gatewayAuthorityRows(
  row: ReturnType<typeof persistedCapabilityRow>,
  issueState: {
    lifecycleStatus?: "open" | "blocked" | "done" | "cancelled";
    executionPaused?: boolean;
  } = {},
  sourcePromptTransmissionPhase:
    | "not_transmitted"
    | "transmitted" = "transmitted",
) {
  return new Map<unknown, readonly unknown[]>([
    [issueExecutionPromptCapabilities, [row]],
    [companies, [{ status: "active", integrity: "ready" }]],
    [
      issues,
      [{
        companyId: row.companyId,
        ownershipEpoch: row.ownershipEpoch,
        lifecycleStatus: issueState.lifecycleStatus ?? "open",
        ownerKind: "agent",
        ownerAgentId: row.targetAgentId,
        executionPaused: issueState.executionPaused ?? false,
      }],
    ],
    [
      agents,
      [{
        companyId: row.companyId,
        status: "active",
        currentAdapterConfigRevisionId: row.adapterConfigIdentity,
      }],
    ],
    [
      issueExecutionRefs,
      [{
        companyId: row.companyId,
        issueId: row.issueId,
        sessionId: capability.sessionId,
        ownershipEpoch: row.ownershipEpoch,
        mode: row.executionMode,
        targetAgentId: row.targetAgentId,
        issueExecutionAuthorityId: row.issueExecutionAuthorityId,
        consultExecutionId: row.consultExecutionId,
        adapterConfigRevisionId: row.adapterConfigIdentity,
        disposition: "active",
      }],
    ],
    [
      issueExecutionRunRefs,
      [{
        companyId: row.companyId,
        issueId: row.issueId,
        sessionId: capability.sessionId,
        batchDigest: row.runBatchDigest,
        attemptId: row.attemptId,
        protocolSettlementState: null,
        capabilityConnectionId: row.capabilityConnectionId,
        capabilityGeneration: row.capabilityGeneration,
        promptTransmissionPhase: row.segmentOrdinal === 0
          ? sourcePromptTransmissionPhase
          : "transmitted",
      }],
    ],
    ...(row.segmentOrdinal === 0
      ? []
      : [[
          issueExecutionPromptSegments,
          [{
            companyId: row.companyId,
            issueId: row.issueId,
            sessionId: capability.sessionId,
            attemptId: row.attemptId,
            capabilityConnectionId: row.capabilityConnectionId,
            capabilityGeneration: row.capabilityGeneration,
            protocolSettlementState: null,
            steeringState: "resumed",
            promptTransmissionPhase: sourcePromptTransmissionPhase,
          }],
        ]] as const),
    [
      issueExecutionRunControls,
      [{
        currentRefId: row.refId,
        currentOrdinal: row.refOrdinal,
        currentSegmentOrdinal: row.segmentOrdinal,
      }],
    ],
    [
      issueExecutionAttempts,
      [{
        companyId: row.companyId,
        issueId: row.issueId,
        sessionId: capability.sessionId,
        runId: row.runId,
        runKind: "productive",
        promptKind: row.segmentOrdinal === 0 ? "base" : "steering",
        refId: row.refId,
        refOrdinal: row.refOrdinal,
        segmentOrdinal: row.segmentOrdinal,
        state: "running",
      }],
    ],
    [
      issueExecutionLeases,
      [{
        companyId: row.companyId,
        issueId: row.issueId,
        runId: row.runId,
        attemptId: row.attemptId,
        leaseGeneration: row.leaseGeneration,
        state: "active",
        expiresAt: row.expiresAt,
      }],
    ],
    [
      issueExecutionSessions,
      [{
        issueId: row.issueId,
        ownershipEpoch: row.ownershipEpoch,
        targetAgentId: row.targetAgentId,
        adapterConfigIdentity: row.adapterConfigIdentity,
        workspaceIdentity: row.workspaceIdentity,
        purpose: "active_run_steering",
        state: "current",
        runId: row.runId,
        currentRefId: row.refId,
        currentRefOrdinal: row.refOrdinal,
        currentSegmentOrdinal: row.segmentOrdinal,
      }],
    ],
    [
      issueExecutionWorkspaceBindings,
      [{
        companyId: row.companyId,
        issueId: row.issueId,
        sessionId: capability.sessionId,
        ownershipEpoch: row.ownershipEpoch,
      }],
    ],
    [
      issueExecutionAuthorities,
      [{
        companyId: row.companyId,
        issueId: row.issueId,
        sessionId: capability.sessionId,
        ownershipEpoch: row.ownershipEpoch,
        agentId: row.targetAgentId,
        state: "current",
      }],
    ],
  ]);
}

function postgresGatewayRepository(
  row: ReturnType<typeof persistedCapabilityRow>,
  databaseTime = now,
  issueState: Parameters<typeof gatewayAuthorityRows>[1] = {},
  sourcePromptTransmissionPhase:
    | "not_transmitted"
    | "transmitted" = "transmitted",
) {
  const rowsByTable = gatewayAuthorityRows(
    row,
    issueState,
    sourcePromptTransmissionPhase,
  );
  const database: Record<string, unknown> = {
    async execute() {
      return [{ timestamp: databaseTime }];
    },
    select() {
      let table: unknown;
      const builder = {
        from(value: unknown) {
          table = value;
          return builder;
        },
        where() {
          return builder;
        },
        limit() {
          return builder;
        },
        for() {
          return builder;
        },
        then<TResult1 = readonly unknown[], TResult2 = never>(
          onFulfilled?: ((value: readonly unknown[]) => TResult1 | PromiseLike<TResult1>) | null,
          onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
        ) {
          return Promise.resolve(rowsByTable.get(table) ?? []).then(
            onFulfilled,
            onRejected,
          );
        },
      };
      return builder;
    },
  };
  database.transaction = vi.fn(
    async (work: (transaction: unknown) => unknown) => work(database),
  );
  return createPostgresPromptCapabilityGatewayRepository(
    database as unknown as Db,
    {
      resolve: vi.fn(async () => compileInput()),
    },
    {
      readRun: vi.fn(async () => ({
        kind: "productive",
        status: "running",
        sessionId: capability.sessionId,
        ownershipEpoch: row.ownershipEpoch,
        targetAgentId: row.targetAgentId,
        executionMode: row.executionMode,
        issueExecutionAuthorityId: row.issueExecutionAuthorityId,
        consultExecutionId: row.consultExecutionId,
        adapterConfigRevisionId: row.adapterConfigIdentity,
        executionWorkspaceBindingId: row.workspaceIdentity,
        currentAttemptId: row.attemptId,
        currentLeaseId: row.leaseId,
        cancellationIntentId: null,
        terminalFinalizationId: null,
      })),
    } as never,
  );
}

function compileInput(): RuntimeInterfaceCompileInput {
  return {
    mode: "owner" as const,
    contextDial: resolveContextDial({ agent: {} }).effective,
    actionGrants: {},
    isCurrentOwner: true,
    issueCreateDirectChildren: [],
    issueAssignTargets: [],
    creatorUpdateTargets: [],
    mentionTargets: [],
    configureTargets: [],
    pluginTools: [],
  };
}

function setup(
  compile = compileInput(),
  binding: PromptCapabilityBinding = capability,
) {
  const authenticateIngressBearerHash = vi.fn(async () => ({
    kind: "authenticated" as const,
    capability: binding,
  }));
  const authenticateBearerHash = vi.fn(async () => ({
    kind: "authenticated" as const,
    capability: binding,
  }));
  const revalidate = vi.fn(async () => ({
    kind: "authenticated" as const,
    capability: binding,
  }));
  const repository: PromptCapabilityGatewayRepository = {
    authenticateIngressBearerHash,
    authenticateBearerHash,
    revalidate,
    resolveCompileInput: vi.fn(async () => compile),
    createPluginRunContext: vi.fn(async () => undefined),
    resolvePluginRunContextHash: vi.fn(async () => null),
  };
  const registerTerminalInvalid = vi.fn(async () => undefined);
  const execute = vi.fn(async (
    input: Parameters<PromptCapabilityToolExecutor["execute"]>[0],
  ) => ({ source: "paperclip" as const, value: { accepted: true } }));
  return {
    authenticateIngressBearerHash,
    authenticateBearerHash,
    execute,
    registerTerminalInvalid,
    revalidate,
    gateway: createPromptCapabilityGateway({
      repository,
      executor: { execute, registerTerminalInvalid },
      now: () => now,
    }),
  };
}

function composedPluginToolRuntime() {
  const bearer = mintPromptCapabilityBearer(new Uint8Array(32).fill(13));
  const installation = { status: "ready", manifestIdentity: "manifest-v1" };
  const compile: RuntimeInterfaceCompileInput = {
    ...compileInput(),
    actionGrants: {},
    // This fixture isolates plugin-tool binding. The automatic owner update
    // action is covered by the runtime action tests instead.
    isCurrentOwner: false,
    pluginTools: [{
      installationId: "plugin-installation",
      manifestIdentity: "manifest-v1",
      name: "acme.search__lookup",
      toolName: "lookup",
      title: "Lookup",
      description: "Look up an external record",
      inputSchema: { type: "object" },
    }],
  };
  const originalCall = vi.fn(async () => ({
    ok: true as const,
    content: "original worker",
  }));
  let selectedWorker = {
    status: "running" as const,
    manifestIdentity: "manifest-v1",
    call: originalCall,
  };
  let afterWorkerSelection: (() => void) | undefined;
  const getWorker = vi.fn(() => {
    const worker = selectedWorker;
    afterWorkerSelection?.();
    afterWorkerSelection = undefined;
    return worker;
  });
  const createPluginRunContext = vi.fn(async (
    input: Parameters<
      PromptCapabilityGatewayRepository["createPluginRunContext"]
    >[0],
  ) => {
    if (
      installation.status !== "ready" ||
      installation.manifestIdentity !== input.pluginManifestIdentity
    ) {
      throw new Error("Plugin context is not bound to a ready tool");
    }
  });
  const authenticated = async () => ({
    kind: "authenticated" as const,
    capability,
  });
  const repository = {
    authenticateBearerHash: authenticated,
    revalidate: authenticated,
    resolveCompileInput: vi.fn(async () => compile),
    createPluginRunContext,
  } as unknown as PromptCapabilityGatewayRepository;
  const unused = vi.fn(async () => undefined);
  const executor = createRuntimeToolExecutor({
    retrieval: {} as never,
    retrievalScope: {} as never,
    actions: {
      issueCreate: unused,
      issueAssign: unused,
      issueUpdate: unused,
      mentionAgent: unused,
      mentionBoard: unused,
      agentHire: unused,
      agentConfigure: unused,
      listAgents: unused,
      agentRead: unused,
    } as never,
    pluginTools: createRuntimePluginToolPort({ getWorker } as never),
    callLedger: {
      claim: vi.fn(async () => ({
        state: "claimed" as const,
        id: "plugin-call-1",
      })),
      classify: vi.fn(async () => undefined),
      complete: vi.fn(async () => undefined),
      fail: vi.fn(async () => undefined),
    } as never,
  });

  return {
    bearer,
    createPluginRunContext,
    gateway: createPromptCapabilityGateway({
      repository,
      executor,
      now: () => now,
    }),
    originalCall,
    stageChangeBeforeMint(
      change: "status" | "manifest identity",
      replacementCall: typeof originalCall,
    ) {
      afterWorkerSelection = () => {
        installation.status = change === "status" ? "disabled" : "ready";
        installation.manifestIdentity =
          change === "manifest identity" ? "manifest-v2" : "manifest-v1";
        selectedWorker = {
          status: "running",
          manifestIdentity:
            change === "manifest identity" ? "manifest-v2" : "manifest-v1",
          call: replacementCall,
        };
      };
    },
  };
}

describe("prompt-capability gateway", () => {
  it.each(["stable", "status", "manifest identity"] as const)(
    "composes an exact plugin tool binding across a %s runtime",
    async (state) => {
      const runtime = composedPluginToolRuntime();
      const replacementCall = vi.fn(async () => ({
        ok: true as const,
        content: "replacement worker",
      }));

      await expect(runtime.gateway.listTools(runtime.bearer)).resolves.toEqual([
        expect.objectContaining({
          name: "acme.search__lookup",
          source: "plugin",
          pluginInstallationId: "plugin-installation",
          pluginManifestIdentity: "manifest-v1",
          pluginToolName: "lookup",
        }),
      ]);
      if (state !== "stable") {
        runtime.stageChangeBeforeMint(state, replacementCall);
      }

      const call = runtime.gateway.callTool({
        bearer: runtime.bearer,
        toolName: "acme.search__lookup",
        arguments: { query: "record" },
        callIdentity: { source: "jsonrpc", id: `plugin-${state}` },
        ingressOrdinal: 0,
      });
      if (state !== "stable") {
        await expect(call).rejects.toThrow(
          "Plugin context is not bound to a ready tool",
        );
        expect(runtime.originalCall).not.toHaveBeenCalled();
        expect(replacementCall).not.toHaveBeenCalled();
        return;
      }

      await expect(call).resolves.toEqual({
        source: "plugin",
        value: { ok: true, content: "original worker" },
      });
      const rpcCall = runtime.originalCall.mock.calls[0] as unknown as readonly unknown[];
      const rpcParams = rpcCall[1] as { runContextHandle: string };
      const invocationScope = rpcCall[3] as {
        pluginRunContextHandle: string;
      };
      expect(runtime.originalCall).toHaveBeenCalledWith(
        "executeTool",
        expect.objectContaining({
          toolName: "lookup",
          parameters: { query: "record" },
          runContextHandle: expect.stringMatching(/^pc_plugin_ctx_v1_/),
        }),
        undefined,
        expect.objectContaining({ companyId: capability.companyId }),
      );
      expect(invocationScope.pluginRunContextHandle).toBe(
        rpcParams.runContextHandle,
      );
      expect(runtime.createPluginRunContext).toHaveBeenCalledWith(
        expect.objectContaining({
          pluginInstallationId: "plugin-installation",
          pluginManifestIdentity: "manifest-v1",
          runInterfaceToolCallId: "plugin-call-1",
        }),
      );
    },
  );

  it("authenticates only the SHA-256 hash and recompiles before list/call", async () => {
    const runtime = setup();
    const bearer = mintPromptCapabilityBearer(new Uint8Array(32).fill(7));

    const tools = await runtime.gateway.listTools(bearer);
    expect(tools.map((tool) => tool.name)).toContain("issue_update");
    await runtime.gateway.callTool({
      bearer,
      toolName: "issue_update",
      arguments: { message: "progress" },
      callIdentity: { source: "jsonrpc", id: 7 },
      ingressOrdinal: 0,
    });

    expect(runtime.authenticateBearerHash).toHaveBeenCalledWith(
      createHash("sha256").update(bearer, "utf8").digest("hex"),
      now,
    );
    expect(runtime.authenticateBearerHash.mock.calls.flat()).not.toContain(
      bearer,
    );
    expect(runtime.revalidate).toHaveBeenCalledTimes(2);
    expect(runtime.execute).toHaveBeenCalledWith(
      expect.objectContaining({ capability }),
    );
  });

  it("executes a canonical board mention through the action port", async () => {
    const runtime = setup({
      ...compileInput(),
      actionGrants: { mention_board: true },
    });
    const bearer = mintPromptCapabilityBearer(new Uint8Array(32).fill(8));

    await expect(runtime.gateway.callTool({
      bearer,
      toolName: "mention_board",
      arguments: { message: "Need Board direction" },
      callIdentity: { source: "jsonrpc", id: 8 },
      ingressOrdinal: 0,
    })).resolves.toEqual({
      source: "paperclip",
      value: { accepted: true },
    });

    expect(runtime.execute).toHaveBeenCalledWith(expect.objectContaining({
      capability,
      descriptor: expect.objectContaining({ name: "mention_board" }),
    }));
  });

  it("keeps one tool catalogue while limiting bootstrap calls to opted-in plugin tools", async () => {
    const bootstrapCapability: PromptCapabilityBinding = {
      ...capability,
      bootstrapToolGate: true,
    };
    const runtime = setup({
      ...compileInput(),
      pluginTools: [{
        installationId: "memory-plugin",
        manifestIdentity: "memory-v1",
        name: "memory.read_company_agent_memory",
        toolName: "read_company_agent_memory",
        title: "Read company memory",
        description: "Read agent background memory",
        inputSchema: { type: "object" },
        bootstrapEnabled: true,
      }],
    }, bootstrapCapability);
    const bearer = mintPromptCapabilityBearer(new Uint8Array(32).fill(10));

    const names = (await runtime.gateway.listTools(bearer)).map(
      (tool) => tool.name,
    );
    expect(names).toContain("issue_update");
    expect(names).toContain("memory.read_company_agent_memory");

    await expect(runtime.gateway.callTool({
      bearer,
      toolName: "issue_update",
      arguments: { message: "do work" },
      callIdentity: { source: "jsonrpc", id: "bootstrap-denied" },
      ingressOrdinal: 0,
    })).rejects.toMatchObject({
      code: "runtime_tool_unavailable",
      message: "Tool is unavailable during instruction bootstrap: issue_update",
    });
    expect(runtime.execute).not.toHaveBeenCalled();
    expect(runtime.registerTerminalInvalid).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: bootstrapCapability,
        descriptor: expect.objectContaining({ name: "issue_update" }),
      }),
    );

    await expect(runtime.gateway.callTool({
      bearer,
      toolName: "memory.read_company_agent_memory",
      arguments: {},
      callIdentity: { source: "jsonrpc", id: "bootstrap-memory" },
      ingressOrdinal: 1,
    })).resolves.toEqual({
      source: "paperclip",
      value: { accepted: true },
    });
    expect(runtime.execute).toHaveBeenCalledWith(expect.objectContaining({
      capability: bootstrapCapability,
      descriptor: expect.objectContaining({
        name: "memory.read_company_agent_memory",
        bootstrapEnabled: true,
      }),
    }));
  });

  it("keeps restore_session listed for a recovery handle but permits it only during bootstrap", async () => {
    const compile = { ...compileInput(), restoreSession: true };
    const bootstrapCapability: PromptCapabilityBinding = {
      ...capability,
      bootstrapToolGate: true,
    };
    const bootstrap = setup(compile, bootstrapCapability);
    const bootstrapBearer = mintPromptCapabilityBearer(
      new Uint8Array(32).fill(14),
    );

    expect(
      (await bootstrap.gateway.listTools(bootstrapBearer)).map((tool) => tool.name),
    ).toContain("restore_session");
    await expect(bootstrap.gateway.callTool({
      bearer: bootstrapBearer,
      toolName: "restore_session",
      arguments: {},
      callIdentity: { source: "jsonrpc", id: "restore-bootstrap" },
      ingressOrdinal: 0,
    })).resolves.toEqual({
      source: "paperclip",
      value: { accepted: true },
    });
    expect(bootstrap.execute).toHaveBeenCalledWith(expect.objectContaining({
      descriptor: expect.objectContaining({
        name: "restore_session",
        bootstrapEnabled: true,
      }),
    }));

    const work = setup(compile, {
      ...capability,
      bootstrapToolGate: false,
    });
    const workBearer = mintPromptCapabilityBearer(new Uint8Array(32).fill(15));
    expect(
      (await work.gateway.listTools(workBearer)).map((tool) => tool.name),
    ).toContain("restore_session");
    await expect(work.gateway.callTool({
      bearer: workBearer,
      toolName: "restore_session",
      arguments: {},
      callIdentity: { source: "jsonrpc", id: "restore-work" },
      ingressOrdinal: 0,
    })).rejects.toMatchObject({
      code: "runtime_tool_unavailable",
      message: "Tool is unavailable outside recovery bootstrap: restore_session",
    });
    expect(work.execute).not.toHaveBeenCalled();
  });

  it("rejects every credential class other than a prompt capability", async () => {
    const runtime = setup();
    await expect(runtime.gateway.listTools("pc_plugin_ctx_v1_not-a-run"))
      .rejects.toBeInstanceOf(PromptCapabilityAuthenticationError);
    expect(runtime.authenticateBearerHash).not.toHaveBeenCalled();
  });

  it("keeps the immutable binding authoritative when only its persisted expiry is renewed", async () => {
    const runtime = capabilityLockTransaction(
      persistedCapabilityRow({
        expiresAt: new Date("2026-07-31T12:10:00.000Z"),
      }),
    );

    await expect(
      lockActivePromptCapabilityBinding(
        runtime.transaction,
        capability,
        new Date("2026-07-31T12:06:00.000Z"),
      ),
    ).resolves.toBeUndefined();
    expect(runtime.selectedTables).toEqual([
      issueExecutionPromptCapabilities,
    ]);
    expect(runtime.lockedTables).toEqual([
      issueExecutionPromptCapabilities,
    ]);
  });

  it("revalidates an immutable gateway binding after its database expiry is extended", async () => {
    const row = persistedCapabilityRow({
      expiresAt: new Date("2026-07-31T12:10:00.000Z"),
    });
    const repository = postgresGatewayRepository(row);

    await expect(
      repository.revalidate(
        capability,
        new Date("2026-07-31T12:06:00.000Z"),
      ),
    ).resolves.toEqual({
      kind: "authenticated",
      capability: {
        ...capability,
        expiresAt: row.expiresAt,
      },
    });
  });

  it.each([
    {
      label: "a base prompt before transmission",
      segmentOrdinal: 0,
      sourcePromptTransmissionPhase: "not_transmitted" as const,
      bootstrapToolGate: true,
    },
    {
      label: "a base prompt after transmission",
      segmentOrdinal: 0,
      sourcePromptTransmissionPhase: "transmitted" as const,
      bootstrapToolGate: false,
    },
    {
      label: "a steering prompt before transmission",
      segmentOrdinal: 1,
      sourcePromptTransmissionPhase: "not_transmitted" as const,
      bootstrapToolGate: true,
    },
    {
      label: "a steering prompt after transmission",
      segmentOrdinal: 1,
      sourcePromptTransmissionPhase: "transmitted" as const,
      bootstrapToolGate: false,
    },
  ])(
    "derives the transient bootstrap tool gate from $label",
    async ({
      segmentOrdinal,
      sourcePromptTransmissionPhase,
      bootstrapToolGate,
    }) => {
      const row = {
        ...persistedCapabilityRow({
          expiresAt: new Date("2026-07-31T12:10:00.000Z"),
        }),
        segmentOrdinal,
      };
      const sourceBinding: PromptCapabilityBinding = {
        ...capability,
        segmentOrdinal,
        // This value is intentionally stale: revalidation derives it again
        // and ignores it when comparing durable binding identity.
        bootstrapToolGate: false,
      };
      const repository = postgresGatewayRepository(
        row,
        now,
        {},
        sourcePromptTransmissionPhase,
      );

      await expect(
        repository.revalidate(
          sourceBinding,
          new Date("2026-07-31T12:06:00.000Z"),
        ),
      ).resolves.toEqual({
        kind: "authenticated",
        capability: {
          ...sourceBinding,
          bootstrapToolGate,
          expiresAt: row.expiresAt,
        },
      });
    },
  );

  it.each([
    {
      label: "blocked issue",
      issueState: { lifecycleStatus: "blocked" as const },
      expected: "authenticated",
    },
    {
      label: "cancelled issue",
      issueState: { lifecycleStatus: "cancelled" as const },
      expected: "issue_lifecycle_terminal",
    },
    {
      label: "paused issue tree",
      issueState: { executionPaused: true },
      expected: "issue_execution_paused",
    },
  ])("applies the canonical execution gate for a $label", async ({ issueState, expected }) => {
    const row = persistedCapabilityRow({
      expiresAt: new Date("2026-07-31T12:10:00.000Z"),
    });
    const repository = postgresGatewayRepository(row, now, issueState);
    const result = await repository.revalidate(
      capability,
      new Date("2026-07-31T12:06:00.000Z"),
    );

    if (expected === "authenticated") {
      expect(result.kind).toBe("authenticated");
    } else {
      expect(result).toEqual({ kind: "authority_invalid", reason: expected });
    }
  });

  it.each([
    {
      label: "currently expired",
      row: persistedCapabilityRow({ expiresAt: now }),
    },
    {
      label: "revoked",
      row: persistedCapabilityRow({
        expiresAt: new Date("2026-07-31T12:10:00.000Z"),
        state: "revoked",
      }),
    },
  ])("rejects a $label persisted capability despite the original binding", async ({ row }) => {
    const runtime = capabilityLockTransaction(row);

    await expect(
      lockActivePromptCapabilityBinding(
        runtime.transaction,
        capability,
        now,
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<PromptCapabilityAuthorityError>>({
        code: "prompt_capability_authority_invalid",
        reason: "capability_generation_changed",
      }),
    );
  });

  it("rejects authority that expires while waiting for its capability lock", async () => {
    const expiresAt = new Date("2026-07-31T12:05:00.000Z");
    const runtime = capabilityLockTransaction(
      persistedCapabilityRow({ expiresAt }),
      new Date("2026-07-31T12:05:00.001Z"),
    );

    await expect(
      lockActivePromptCapabilityBinding(
        runtime.transaction,
        capability,
        new Date("2026-07-31T12:04:00.000Z"),
      ),
    ).rejects.toMatchObject({
      reason: "capability_generation_changed",
    });
  });

  it("uses the post-lock database instant instead of a stale gateway timestamp", async () => {
    const row = persistedCapabilityRow({
      expiresAt: new Date("2026-07-31T12:05:00.000Z"),
    });
    const repository = postgresGatewayRepository(
      row,
      new Date("2026-07-31T12:05:00.001Z"),
    );

    await expect(
      repository.revalidate(
        capability,
        new Date("2026-07-31T12:04:00.000Z"),
      ),
    ).resolves.toEqual({ kind: "inactive" });
  });
});
