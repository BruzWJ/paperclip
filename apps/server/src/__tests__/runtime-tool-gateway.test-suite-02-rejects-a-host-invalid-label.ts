import * as t from "./runtime-tool-gateway.test-support.js";
const { describe, it, setup, expect, readComments, paperclipDescriptor } = t;
const { resolveContextDial, capability, mintPluginRunContext, vi } = t;
const { compileRuntimeInterface, RuntimeToolArgumentsInvalid } = t;

describe("runtime tool gateway", () => {
  it.each([
    {
      label: "plugin descriptor without an installation binding",
      descriptor: {
        name: "paperclip.example__lookup",
        title: "Lookup",
        description: "",
        inputSchema: {},
        source: "plugin" as const,
        pluginToolName: "lookup",
      },
      message: "Plugin tool is missing its immutable installation binding",
    },
    {
      label: "unknown Paperclip action descriptor",
      descriptor: {
        name: "unknown_paperclip_action",
        title: "Unknown",
        description: "",
        inputSchema: {},
        source: "paperclip" as const,
      },
      message: "Unknown Paperclip managed tool unknown_paperclip_action",
    },
  ])("rejects a host-invalid $label as an interface conflict", async ({ descriptor, message }) => {
    const { executor, claim, registerTerminalInvalid } = setup();
    await expect(
      executor.execute({
        capability,
        descriptor,
        arguments: {},
        callIdentity: { source: "provider", id: descriptor.name },
        ingressOrdinal: 0,
        mintPluginRunContext,
      }),
    ).rejects.toMatchObject({
      name: "RuntimeInterfaceConflict",
      code: "runtime_interface_conflict",
      message,
    });
    expect(claim).not.toHaveBeenCalled();
    expect(registerTerminalInvalid).toHaveBeenCalledOnce();
  });

  it("routes retrieval through the effective task scope", async () => {
    const { executor } = setup();
    await expect(
      executor.execute({
        capability,
        descriptor: readComments,
        arguments: {},
        callIdentity: { source: "provider", id: "call-1" },
        ingressOrdinal: 0,
        mintPluginRunContext,
      }),
    ).resolves.toMatchObject({
      source: "paperclip",
      value: { items: [{ body: "visible" }] },
    });
  });

  it("uses a signed run-trace cursor through the compiled retrieval ABI", async () => {
    const { executor, readCanonicalRunTrace } = setup({
      agentDial: { read_task_agent_run: true },
      enableRunTrace: true,
    });
    const first = await executor.execute({
      capability,
      descriptor: paperclipDescriptor("read_task_agent_run", {
        contextDial: resolveContextDial({
          agent: { read_task_agent_run: true },
        }).effective,
      }),
      arguments: { runId: "run-observed" },
      callIdentity: { source: "provider", id: "call-run-page-2" },
      ingressOrdinal: 0,
      mintPluginRunContext,
    });

    expect(first).toMatchObject({ source: "paperclip" });
    expect(readCanonicalRunTrace).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "company",
        runId: "run-observed",
        after: null,
      }),
    );
  });

  it("routes a Paperclip action with a run-bound canonical authority", async () => {
    const { executor, taskUpdate } = setup();
    await executor.execute({
      capability,
      descriptor: paperclipDescriptor("task_update"),
      arguments: { status: "done", message: "done" },
      callIdentity: { source: "provider", id: "call-1" },
      ingressOrdinal: 0,
      mintPluginRunContext,
    });
    expect(taskUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({
          name: "task_update",
          companyId: capability.companyId,
          taskId: capability.taskId,
          taskTarget: "active",
          status: "done",
          message: "done",
        }),
        authority: expect.objectContaining({
          capability,
          invocation: expect.objectContaining({
            id: expect.stringMatching(/^call_[0-9a-f]{64}$/),
            runInterfaceToolCallId: "ledger-call-1",
            ingressOrdinal: 0,
            commitMentionAction: expect.any(Function),
          }),
        }),
      }),
    );
  });

  it("gives direct plugin tools only an opaque run-context handle", async () => {
    const { executor, executePlugin } = setup();
    await executor.execute({
      capability,
      descriptor: {
        name: "paperclip.example__lookup",
        title: "",
        description: "",
        inputSchema: {},
        source: "plugin",
        pluginInstallationId: "plugin-installation",
        pluginManifestIdentity: "manifest-1",
        pluginToolName: "lookup",
      },
      arguments: { query: "x" },
      callIdentity: { source: "provider", id: "call-1" },
      ingressOrdinal: 0,
      mintPluginRunContext,
    });
    expect(mintPluginRunContext).toHaveBeenCalledWith({
      runInterfaceToolCallId: "ledger-call-1",
      pluginInstallationId: "plugin-installation",
      pluginManifestIdentity: "manifest-1",
    });
    expect(executePlugin).toHaveBeenCalledWith(
      expect.objectContaining({
        capability,
        toolName: "lookup",
        pluginInstallationId: "plugin-installation",
        pluginManifestIdentity: "manifest-1",
        arguments: { query: "x" },
        mintPluginRunContext: expect.any(Function),
      }),
    );
  });

  it("rejects invalid plugin arguments before minting context or calling the worker", async () => {
    const { executor, executePlugin, claim, registerTerminalInvalid } = setup();
    const mintRunContext = vi.fn(async () => "opaque");
    const descriptor = compileRuntimeInterface({
      mode: "owner",
      turn: "work",
      contextDial: resolveContextDial({ agent: {} }).effective,
      actionGrants: {},
      isCurrentOwner: true,
      taskCreateDirectChildren: [],
      taskAssignTargets: [],
      creatorUpdateTargets: [],
      mentionTargets: [],
      pluginTools: [
        {
          installationId: "plugin-installation",
          manifestIdentity: "manifest-1",
          name: "paperclip.example__lookup",
          toolName: "lookup",
          title: "Lookup",
          description: "Lookup",
          inputSchema: {
            type: "object",
            required: ["query"],
            additionalProperties: false,
            properties: { query: { type: "string", minLength: 1 } },
          },
        },
      ],
    }).byName.get("paperclip.example__lookup")!;

    await expect(
      executor.execute({
        capability,
        descriptor,
        arguments: { query: "", unexpected: true },
        callIdentity: { source: "provider", id: "invalid-plugin-call" },
        ingressOrdinal: 0,
        mintPluginRunContext: mintRunContext,
      }),
    ).rejects.toThrow(RuntimeToolArgumentsInvalid);
    expect(claim).not.toHaveBeenCalled();
    expect(registerTerminalInvalid).toHaveBeenCalledOnce();
    expect(mintRunContext).not.toHaveBeenCalled();
    expect(executePlugin).not.toHaveBeenCalled();
  });

  it("classifies and propagates the immutable mention ingress boundary", async () => {
    const { executor, mentionAgent, claim, commitMentionAction } = setup();
    const descriptor = compileRuntimeInterface({
      mode: "owner",
      turn: "work",
      contextDial: resolveContextDial({ agent: {} }).effective,
      actionGrants: {},
      isCurrentOwner: true,
      taskCreateDirectChildren: [],
      taskAssignTargets: [],
      creatorUpdateTargets: [],
      mentionTargets: [{ id: "mentioned-agent", name: "Mentioned", capabilities: null }],
      pluginTools: [],
    }).byName.get("mention_agent")!;

    await executor.execute({
      capability,
      descriptor,
      arguments: { agentId: "mentioned-agent", message: "help" },
      callIdentity: { source: "jsonrpc", id: "mention-1" },
      ingressOrdinal: 7,
      mintPluginRunContext,
    });

    expect(claim).toHaveBeenCalledWith(
      expect.objectContaining({
        classification: {
          classification: "validated_mention",
          targetAgentId: "mentioned-agent",
        },
      }),
    );
    const mention = mentionAgent.mock.calls[0]![0];
    expect(mention).toEqual(
      expect.objectContaining({
        command: expect.objectContaining({
          name: "mention_agent",
          agentId: "mentioned-agent",
        }),
        authority: expect.objectContaining({
          invocation: expect.objectContaining({
            runInterfaceToolCallId: "ledger-call-1",
            ingressOrdinal: 7,
          }),
        }),
      }),
    );
    expect(commitMentionAction).toHaveBeenCalledWith(
      expect.objectContaining({
        capability,
        id: "ledger-call-1",
        ingressOrdinal: 7,
        toolName: "mention_agent",
        targetAgentId: "mentioned-agent",
        result: { consulted: true },
      }),
    );
  });

  it("routes a Board request as a non-mention ledger action", async () => {
    const { executor, mentionBoard, claim, commitMentionAction } = setup();
    const descriptor = compileRuntimeInterface({
      mode: "owner",
      turn: "work",
      contextDial: resolveContextDial({ agent: {} }).effective,
      actionGrants: { mention_board: true },
      isCurrentOwner: true,
      taskCreateDirectChildren: [],
      taskAssignTargets: [],
      creatorUpdateTargets: [],
      mentionTargets: [],
      pluginTools: [],
    }).byName.get("mention_board")!;

    await expect(
      executor.execute({
        capability,
        descriptor,
        arguments: { message: "Please choose a rollout" },
        callIdentity: { source: "jsonrpc", id: "board-request-1" },
        ingressOrdinal: 8,
        mintPluginRunContext,
      }),
    ).resolves.toEqual({
      source: "paperclip",
      value: { requested: true },
    });

    expect(claim).toHaveBeenCalledWith(
      expect.objectContaining({
        classification: { classification: "non_mention" },
      }),
    );
    expect(mentionBoard).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({
          name: "mention_board",
        }),
        authority: expect.objectContaining({
          invocation: expect.objectContaining({
            runInterfaceToolCallId: "ledger-call-1",
            ingressOrdinal: 8,
          }),
        }),
      }),
    );
    expect(commitMentionAction).toHaveBeenCalledWith(
      expect.objectContaining({
        capability,
        id: "ledger-call-1",
        ingressOrdinal: 8,
        toolName: "mention_board",
        targetAgentId: null,
        result: { requested: true },
      }),
    );
  });

  it("rejects broad or malformed retrieval arguments", async () => {
    const { executor, claim, registerTerminalInvalid } = setup();
    await expect(
      executor.execute({
        capability,
        descriptor: readComments,
        arguments: { taskId: "task", agentId: "leak" },
        callIdentity: { source: "provider", id: "call-1" },
        ingressOrdinal: 0,
        mintPluginRunContext,
      }),
    ).rejects.toBeInstanceOf(RuntimeToolArgumentsInvalid);
    expect(claim).not.toHaveBeenCalled();
    expect(registerTerminalInvalid).toHaveBeenCalledOnce();
  });

  it("accepts any canonical configure target for domain authorization after dispatch", async () => {
    const { executor, agentConfigure } = setup();
    const requestedTargetId = "00000000-0000-4000-8000-000000000002";
    const descriptor = compileRuntimeInterface({
      mode: "owner",
      turn: "work",
      contextDial: resolveContextDial({ agent: {} }).effective,
      actionGrants: { agent_configure: true },
      isCurrentOwner: true,
      taskCreateDirectChildren: [],
      taskAssignTargets: [],
      creatorUpdateTargets: [],
      mentionTargets: [],
      pluginTools: [],
    }).byName.get("agent_configure")!;

    await expect(
      executor.execute({
        capability,
        descriptor,
        arguments: { agentId: "forged", title: null },
        callIdentity: { source: "provider", id: "configure-forged" },
        ingressOrdinal: 0,
        mintPluginRunContext,
      }),
    ).rejects.toBeInstanceOf(RuntimeToolArgumentsInvalid);
    expect(agentConfigure).not.toHaveBeenCalled();

    await expect(
      executor.execute({
        capability,
        descriptor,
        arguments: { agentId: requestedTargetId, title: null },
        callIdentity: { source: "provider", id: "configure-valid" },
        ingressOrdinal: 1,
        mintPluginRunContext,
      }),
    ).resolves.toEqual({
      source: "paperclip",
      value: { configured: true },
    });
    expect(agentConfigure).toHaveBeenCalledWith(
      expect.objectContaining({
        command: {
          name: "agent_configure",
          companyId: "company",
          agentId: requestedTargetId,
          configuration: { title: null },
        },
      }),
    );
  });
});
