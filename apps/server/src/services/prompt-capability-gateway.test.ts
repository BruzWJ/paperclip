import * as t from "./prompt-capability-gateway.test-support.js";
const { describe, it, composedPluginToolRuntime, vi, expect, capability, setup } = t;
const { compileInput, mintPromptCapabilityBearer } = t;
const { PromptCapabilityAuthenticationError, createHash, now, resolveContextDial } = t;
const { createRuntimeToolGateway, createPromptCapabilityGateway } = t;
const { capabilityLockTransaction, persistedCapabilityRow } = t;
const { lockActivePromptCapabilityBinding, taskExecutionPromptCapabilities } = t;
const { postgresGatewayRepository } = t;

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
        await expect(call).rejects.toThrow("Plugin context is not bound to a ready tool");
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
        expect.objectContaining({
          companyId: capability.companyId,
        }),
      );
      expect(invocationScope.pluginRunContextHandle).toBe(rpcParams.runContextHandle);
      expect(runtime.createPluginRunContext).toHaveBeenCalledWith(
        expect.objectContaining({
          pluginInstallationId: "plugin-installation",
          pluginManifestIdentity: "manifest-v1",
          runInterfaceToolCallId: "plugin-call-1",
        }),
      );
    },
  );

  it("authenticates setup discovery by hash while keeping calls active-only", async () => {
    const runtime = setup(compileInput(), {
      ...capability,
      targetSessionCorrelationId: null,
      activatedAt: null,
    });
    const bearer = mintPromptCapabilityBearer(new Uint8Array(32).fill(7));

    const tools = await runtime.gateway.listTools(bearer);
    expect(tools.map((tool) => tool.name)).toContain("task_update");
    await expect(
      runtime.gateway.callTool({
        bearer,
        toolName: "task_update",
        arguments: { message: "progress" },
        callIdentity: { source: "jsonrpc", id: 7 },
        ingressOrdinal: 0,
      }),
    ).rejects.toBeInstanceOf(PromptCapabilityAuthenticationError);

    expect(runtime.authenticateBearerHash).toHaveBeenCalledWith(
      createHash("sha256").update(bearer, "utf8").digest("hex"),
      now,
    );
    expect(runtime.authenticateBearerHash.mock.calls.flat()).not.toContain(bearer);
    expect(runtime.authenticateBearerHash).toHaveBeenCalledTimes(3);
    expect(runtime.revalidate).not.toHaveBeenCalled();
    expect(runtime.execute).not.toHaveBeenCalled();
  });

  it("executes a canonical board mention through the action port", async () => {
    const runtime = setup({
      ...compileInput(),
      actionGrants: { mention_board: true },
    });
    const bearer = mintPromptCapabilityBearer(new Uint8Array(32).fill(8));

    await expect(
      runtime.gateway.callTool({
        bearer,
        toolName: "mention_board",
        arguments: { message: "Need Board direction" },
        callIdentity: { source: "jsonrpc", id: 8 },
        ingressOrdinal: 0,
      }),
    ).resolves.toEqual({
      source: "paperclip",
      value: { accepted: true },
    });

    expect(runtime.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        capability,
        descriptor: expect.objectContaining({
          name: "mention_board",
        }),
      }),
    );
  });

  it("uses one compiled snapshot for descriptor and context scope", async () => {
    const bearer = mintPromptCapabilityBearer(new Uint8Array(32).fill(9));
    const compiledDial = resolveContextDial({
      agent: { read_task_comments: true },
    }).effective;
    const driftedDial = resolveContextDial({
      agent: {},
    }).effective;
    const resolveCompileInput = vi
      .fn()
      .mockResolvedValueOnce({
        ...compileInput(),
        contextDial: compiledDial,
      })
      .mockResolvedValue({
        ...compileInput(),
        contextDial: driftedDial,
      });
    const authenticated = vi.fn(async () => ({
      kind: "authenticated" as const,
      capability,
    }));
    const repository: t.PromptCapabilityGatewayRepository = {
      authenticateBearerHash: authenticated,
      revalidate: authenticated,
      resolveCompileInput,
      createPluginRunContext: vi.fn(async () => undefined),
      resolvePluginRunContextHash: vi.fn(async () => null),
    };
    const observedScopes: unknown[] = [];
    const managedTools = {
      async routeExecution(
        _command: t.PaperclipManagedToolCommand,
        context: t.PaperclipManagedToolRouteContext,
      ) {
        observedScopes.push(await context.resolveRuntimeScope!());
        return { items: [] };
      },
    };
    const runtimeToolGateway = createRuntimeToolGateway({
      managedTools,
      pluginTools: {} as never,
      callLedger: {
        claim: vi.fn(async () => ({
          state: "claimed" as const,
          id: "context-call-1",
        })),
        complete: vi.fn(async () => undefined),
        fail: vi.fn(async () => undefined),
      } as never,
    });
    const gateway = createPromptCapabilityGateway({
      repository,
      executor: runtimeToolGateway,
      now: () => now,
    });

    await expect(
      gateway.callTool({
        bearer,
        toolName: "read_task_comments",
        arguments: {},
        callIdentity: { source: "jsonrpc", id: "context-call" },
        ingressOrdinal: 0,
      }),
    ).resolves.toEqual({ source: "paperclip", value: { items: [] } });

    expect(resolveCompileInput).toHaveBeenCalledOnce();
    expect(observedScopes).toEqual([
      {
        companyId: capability.companyId,
        activeTaskId: capability.taskId,
        dial: compiledDial,
      },
    ]);
    expect(observedScopes).not.toContainEqual(
      expect.objectContaining({
        dial: driftedDial,
      }),
    );
  });

  it("uses the compiled bootstrap turn for discovery and calls", async () => {
    const runtime = setup({
      ...compileInput(),
      turn: "bootstrap",
      pluginTools: [
        {
          installationId: "memory-plugin",
          manifestIdentity: "memory-v1",
          name: "memory.read_company_agent_memory",
          toolName: "read_company_agent_memory",
          title: "Read company memory",
          description: "Read agent background memory",
          inputSchema: { type: "object" },
          bootstrapEnabled: true,
        },
      ],
    });
    const bearer = mintPromptCapabilityBearer(new Uint8Array(32).fill(10));

    const names = (await runtime.gateway.listTools(bearer)).map((tool) => tool.name);
    expect(names).toEqual(["memory.read_company_agent_memory"]);

    await expect(
      runtime.gateway.callTool({
        bearer,
        toolName: "task_update",
        arguments: { message: "do work" },
        callIdentity: { source: "jsonrpc", id: "bootstrap-denied" },
        ingressOrdinal: 0,
      }),
    ).rejects.toMatchObject({
      code: "runtime_tool_unavailable",
      message: "Tool is not available for the current task execution: task_update",
    });
    expect(runtime.execute).not.toHaveBeenCalled();
    expect(runtime.registerTerminalInvalid).toHaveBeenCalledWith(
      expect.objectContaining({
        capability,
        descriptor: expect.objectContaining({
          name: "task_update",
        }),
      }),
    );

    await expect(
      runtime.gateway.callTool({
        bearer,
        toolName: "memory.read_company_agent_memory",
        arguments: {},
        callIdentity: { source: "jsonrpc", id: "bootstrap-memory" },
        ingressOrdinal: 1,
      }),
    ).resolves.toEqual({
      source: "paperclip",
      value: { accepted: true },
    });
    expect(runtime.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        capability,
        descriptor: expect.objectContaining({
          name: "memory.read_company_agent_memory",
          availability: "both",
        }),
      }),
    );
  });

  it("rejects every credential class other than a prompt capability", async () => {
    const runtime = setup();
    await expect(runtime.gateway.listTools("pc_plugin_ctx_v1_not-a-run")).rejects.toBeInstanceOf(
      PromptCapabilityAuthenticationError,
    );
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
    expect(runtime.selectedTables).toEqual([taskExecutionPromptCapabilities]);
    expect(runtime.lockedTables).toEqual([taskExecutionPromptCapabilities]);
  });

  it("revalidates an immutable gateway binding after its database expiry is extended", async () => {
    const row = persistedCapabilityRow({
      expiresAt: new Date("2026-07-31T12:10:00.000Z"),
    });
    const repository = postgresGatewayRepository(row);

    await expect(repository.revalidate(capability, new Date("2026-07-31T12:06:00.000Z"))).resolves.toEqual({
      kind: "authenticated",
      capability: {
        ...capability,
        expiresAt: row.expiresAt,
      },
    });
  });

  it("authenticates the same capability generation while setup is pending", async () => {
    const row = persistedCapabilityRow({
      state: "pending_setup",
      expiresAt: new Date("2026-07-31T12:10:00.000Z"),
    });

    await expect(
      postgresGatewayRepository(row).authenticateBearerHash(row.bearerHash, now),
    ).resolves.toMatchObject({
      kind: "authenticated",
      capability: {
        activatedAt: null,
        sessionId: capability.sessionId,
      },
    });
  });

  it.each([
    {
      label: "blocked task",
      taskState: { lifecycleStatus: "blocked" as const },
      expected: "authenticated",
    },
    {
      label: "cancelled task",
      taskState: { lifecycleStatus: "cancelled" as const },
      expected: "task_lifecycle_terminal",
    },
    {
      label: "paused task tree",
      taskState: { executionPaused: true },
      expected: "task_execution_paused",
    },
  ])("applies the canonical execution gate for a $label", async ({ taskState, expected }) => {
    const row = persistedCapabilityRow({
      expiresAt: new Date("2026-07-31T12:10:00.000Z"),
    });
    const repository = postgresGatewayRepository(row, now, taskState);
    const result = await repository.revalidate(capability, new Date("2026-07-31T12:06:00.000Z"));

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

    await expect(lockActivePromptCapabilityBinding(runtime.transaction, capability, now)).rejects.toEqual(
      expect.objectContaining({
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
    const repository = postgresGatewayRepository(row, new Date("2026-07-31T12:05:00.001Z"));

    await expect(repository.revalidate(capability, new Date("2026-07-31T12:04:00.000Z"))).resolves.toEqual({
      kind: "inactive",
    });
  });
});
