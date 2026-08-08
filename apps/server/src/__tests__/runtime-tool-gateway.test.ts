import { describe, expect, it, vi } from "vitest";
import { resolveContextDial } from "../services/context-dial-resolver.js";
import { createContextRetrievalService } from "../services/context-retrieval.js";
import type {
  AgentRunToolAuthority,
  PaperclipManagedToolRouteContext,
  PaperclipManagedToolRouter,
} from "../services/paperclip-managed-tool-router.js";
import type { PaperclipManagedToolCommand } from "../services/paperclip-managed-tool-registry.js";
import {
  createRuntimePluginToolPort,
  createRuntimeToolGateway,
} from "../services/runtime-tool-gateway.js";
import {
  compileRuntimeInterface,
  type CompiledRunToolDescriptor,
} from "../services/runtime-interface-compiler.js";
import {
  RuntimeInterfaceConflict,
  RuntimeToolArgumentsInvalid,
} from "../services/runtime-tool-errors.js";
import type { PromptCapabilityBinding } from "../services/prompt-capability-gateway.js";

const capability: PromptCapabilityBinding = {
  companyId: "company",
  capabilityConnectionId: "capability-connection",
  capabilityGeneration: 1,
  issueId: "issue",
  sessionId: "issue-session",
  runId: "run",
  runBatchDigest: "a".repeat(64),
  refId: "ref",
  refOrdinal: 0,
  segmentOrdinal: 0,
  attemptId: "attempt",
  workerProcessIdentity: "worker",
  issueExecutionAuthorityId: "authority",
  consultExecutionId: null,
  laneKind: "owner",
  executionMode: "owner",
  ownershipEpoch: 1,
  targetAgentId: "agent",
  adapterConfigIdentity: "revision",
  workspaceIdentity: "workspace",
  targetSessionCorrelationId: "correlation",
  effectiveContextExposureDigest: "b".repeat(64),
  effectiveToolsDigest: "c".repeat(64),
  bootstrapToolGate: false,
  leaseId: "lease",
  leaseGeneration: 1,
  expiresAt: new Date("2026-07-25T01:00:00.000Z"),
  activatedAt: new Date("2026-07-25T00:00:00.000Z"),
  createdAt: new Date("2026-07-25T00:00:00.000Z"),
};

function paperclipDescriptor(
  name: string,
  overrides: Partial<Parameters<typeof compileRuntimeInterface>[0]> = {},
): CompiledRunToolDescriptor {
  const descriptor = compileRuntimeInterface({
    mode: "owner",
    contextDial: resolveContextDial({
      agent: { read_issue_comments: true },
    }).effective,
    actionGrants: {},
    isCurrentOwner: true,
    issueCreateDirectChildren: [],
    issueAssignTargets: [],
    creatorUpdateTargets: [],
    mentionTargets: [],
    configureTargets: [],
    pluginTools: [],
    ...overrides,
  }).byName.get(name);
  if (!descriptor) throw new Error(`Missing compiled Paperclip tool ${name}`);
  return descriptor;
}

const readComments = paperclipDescriptor("read_issue_comments");

function setup(options: {
  agentDial?: Parameters<typeof resolveContextDial>[0]["agent"];
  enableRunTrace?: boolean;
  replayedPluginResult?: { value: unknown };
  restoreSessionResult?: unknown;
} = {}) {
  const mentionTransaction = {} as never;
  const issueUpdate = vi.fn(async () => ({ ok: true }));
  const agentConfigure = vi.fn(async () => ({ configured: true }));
  const mentionAgent = vi.fn(
    async (input: { authority: AgentRunToolAuthority }) =>
      input.authority.invocation.commitMentionAction(
        mentionTransaction,
        { consulted: true },
      ),
  );
  const mentionBoard = vi.fn(
    async (input: { authority: AgentRunToolAuthority }) =>
      input.authority.invocation.commitMentionAction(
        mentionTransaction,
        { requested: true },
      ),
  );
  const executePlugin = vi.fn(
    async (input: { mintPluginRunContext(): Promise<string> }) => ({
      ok: true as const,
      content: "plugin result",
      data: { opaqueRunContext: await input.mintPluginRunContext() },
    }),
  );
  const restoreSession = vi.fn(async () => (
    options.restoreSessionResult ?? { turns: [], nextCursor: null }
  ));
  const readCanonicalRunTrace = vi.fn(
    async ({ runId }: { runId: string }) => ({
      runId,
      runKind: "productive" as const,
      issueId: "issue",
      status: "succeeded",
      startedAt: null,
      finishedAt: null,
      usage: {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        knownDeltaAmount: "0",
      },
      checkpoint: null,
      turns: [],
      outcome: null,
      comments: [],
      nextCursor: null,
    }),
  );
  const classify = vi.fn(async () => undefined);
  const commitMentionAction = vi.fn(
    async (input: { result: unknown }) => input.result,
  );
  const retrieval = createContextRetrievalService({
    cursorSecret: "secret",
    repository: {
      async issueReach() {
        return { sameCompany: true, active: true, descendant: false };
      },
      async listTopLevelIssues() {
        return [];
      },
      async listDirectChildren() {
        return [];
      },
      async listIssueComments({ issueId }) {
        return [
          {
            id: "comment",
            issueId,
            body: "visible",
            author: { kind: "user", userId: "board-user" },
            runId: null,
            sequence: 1,
            createdAt: "2026-07-25T00:00:00.000Z",
          },
        ];
      },
      async runIssue() {
        return options.enableRunTrace ? { issueId: "issue" } : null;
      },
      readCanonicalRunTrace,
    },
  });
  const managedTools = {
    async routeExecution(
      command: PaperclipManagedToolCommand,
      context: PaperclipManagedToolRouteContext,
    ) {
      if (context.authority.kind !== "agent_run") throw new Error("expected agent authority");
      const scope = context.resolveRuntimeScope
        ? await context.resolveRuntimeScope()
        : null;
      switch (command.name) {
        case "read_issue_comments":
          return retrieval.readIssueComments(scope!, {
            issueId: command.issueId,
            cursor: command.cursor,
          });
        case "read_issue_agent_run":
          return retrieval.readIssueAgentRun(scope!, {
            runId: command.runId,
            cursor: command.cursor,
          });
        case "issue_update":
          return issueUpdate({
            command,
            authority: context.authority,
          });
        case "agent_configure":
          return agentConfigure({
            command,
            authority: context.authority,
          });
        case "mention_agent":
          return mentionAgent({ command, authority: context.authority });
        case "mention_board":
          return mentionBoard({ command, authority: context.authority });
        default: return null;
      }
    },
  } as unknown as PaperclipManagedToolRouter;
  const executor = createRuntimeToolGateway({
    retrievalScope: {
      async resolve() {
        return {
          companyId: "company",
          activeIssueId: "issue",
          dial: resolveContextDial({
            agent:
              options.agentDial ??
              { read_issue_comments: true },
          }).effective,
        };
      },
    },
    restoreSession: { restore: restoreSession } as never,
    managedTools,
    pluginTools: {
      execute: executePlugin,
    },
    callLedger: {
      async claim() {
        if (options.replayedPluginResult) {
          return {
            state: "completed" as const,
            result: options.replayedPluginResult.value,
          };
        }
        return { state: "claimed", id: "ledger-call-1" };
      },
      async registerTerminalInvalid() {},
      classify,
      commitMentionAction,
      async complete() {},
      async fail() {},
    },
  });
  return {
    executor,
    issueUpdate,
    agentConfigure,
    mentionAgent,
    mentionBoard,
    classify,
    commitMentionAction,
    executePlugin,
    restoreSession,
    readCanonicalRunTrace,
    mentionTransaction,
  };
}

const mintPluginRunContext = vi.fn(
  async () => "pc_plugin_ctx_v1_opaque",
);

describe("runtime plugin tool port", () => {
  it("dispatches the compiler-bound bare name directly to the exact installation worker", async () => {
    const call = vi.fn(async () => ({ ok: true, content: "found" }));
    const mint = vi.fn(async () => "pc_plugin_ctx_v1_direct");
    const port = createRuntimePluginToolPort({
      getWorker: vi.fn(() => ({
        status: "running",
        manifestIdentity: "manifest-1",
        call,
      })),
    } as never);

    await expect(port.execute({
      capability,
      toolName: "lookup",
      pluginInstallationId: "plugin-installation",
      pluginManifestIdentity: "manifest-1",
      arguments: { query: "x" },
      mintPluginRunContext: mint,
    })).resolves.toEqual({ ok: true, content: "found" });

    expect(call).toHaveBeenCalledWith(
      "executeTool",
      {
        toolName: "lookup",
        parameters: { query: "x" },
        runContextHandle: "pc_plugin_ctx_v1_direct",
      },
      undefined,
      {
        companyId: "company",
        pluginRunContextHandle: "pc_plugin_ctx_v1_direct",
      },
    );
  });

  it("does not mint a run context when the exact installation worker is unavailable", async () => {
    const call = vi.fn();
    const mint = vi.fn(async () => "pc_plugin_ctx_v1_unused");
    const port = createRuntimePluginToolPort({
      getWorker: vi.fn(() => undefined),
    } as never);

    await expect(port.execute({
      capability,
      toolName: "lookup",
      pluginInstallationId: "plugin-installation",
      pluginManifestIdentity: "manifest-1",
      arguments: {},
      mintPluginRunContext: mint,
    })).rejects.toThrow(/exact compiled plugin runtime is not running/);
    expect(mint).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
  });

  it("rejects a replacement worker with a different manifest identity", async () => {
    const call = vi.fn();
    const mint = vi.fn(async () => "pc_plugin_ctx_v1_unused");
    const port = createRuntimePluginToolPort({
      getWorker: vi.fn(() => ({
        status: "running",
        manifestIdentity: "manifest-2",
        call,
      })),
    } as never);

    await expect(port.execute({
      capability,
      toolName: "lookup",
      pluginInstallationId: "plugin-installation",
      pluginManifestIdentity: "manifest-1",
      arguments: {},
      mintPluginRunContext: mint,
    })).rejects.toThrow(/exact compiled plugin runtime is not running/);
    expect(mint).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
  });

  it("preserves a declared plugin tool failure as a ToolResult", async () => {
    const call = vi.fn(async () => ({ ok: false, error: "query is required" }));
    const port = createRuntimePluginToolPort({
      getWorker: vi.fn(() => ({
        status: "running",
        manifestIdentity: "manifest-1",
        call,
      })),
    } as never);

    await expect(port.execute({
      capability,
      toolName: "lookup",
      pluginInstallationId: "plugin-installation",
      pluginManifestIdentity: "manifest-1",
      arguments: {},
      mintPluginRunContext: vi.fn(async () => "pc_plugin_ctx_v1_direct"),
    })).resolves.toEqual({ ok: false, error: "query is required" });
  });

  it("rejects a worker response outside the plugin ToolResult contract", async () => {
    const call = vi.fn(async () => ({ legacyResult: true }));
    const port = createRuntimePluginToolPort({
      getWorker: vi.fn(() => ({
        status: "running",
        manifestIdentity: "manifest-1",
        call,
      })),
    } as never);

    await expect(port.execute({
      capability,
      toolName: "lookup",
      pluginInstallationId: "plugin-installation",
      pluginManifestIdentity: "manifest-1",
      arguments: {},
      mintPluginRunContext: vi.fn(async () => "pc_plugin_ctx_v1_direct"),
    })).rejects.toThrow("Invalid plugin ToolResult");
  });

  it("never rebinds a compiled call to a replacement worker during context mint", async () => {
    const oldCall = vi.fn(async () => ({ ok: true, content: "old" }));
    const newCall = vi.fn(async () => ({ ok: true, content: "new" }));
    let currentWorker = {
      status: "running",
      manifestIdentity: "manifest-1",
      call: oldCall,
    };
    const port = createRuntimePluginToolPort({
      getWorker: vi.fn(() => currentWorker),
    } as never);

    await expect(port.execute({
      capability,
      toolName: "lookup",
      pluginInstallationId: "plugin-installation",
      pluginManifestIdentity: "manifest-1",
      arguments: {},
      mintPluginRunContext: vi.fn(async () => {
        currentWorker = {
          status: "running",
          manifestIdentity: "manifest-2",
          call: newCall,
        };
        return "pc_plugin_ctx_v1_direct";
      }),
    })).resolves.toEqual({ ok: true, content: "old" });

    expect(oldCall).toHaveBeenCalledOnce();
    expect(newCall).not.toHaveBeenCalled();
  });

  it("decodes completed plugin-tool replays through the same ToolResult contract", async () => {
    const descriptor = {
      name: "paperclip.example__lookup",
      title: "Lookup",
      description: "",
      inputSchema: {},
      source: "plugin" as const,
      pluginInstallationId: "plugin-installation",
      pluginToolName: "lookup",
    };
    const valid = setup({
      replayedPluginResult: {
        value: { ok: true, content: "replayed", data: { record: 1 } },
      },
    });
    await expect(valid.executor.execute({
      capability,
      descriptor,
      arguments: {},
      callIdentity: { source: "provider", id: "replayed-valid" },
      ingressOrdinal: 0,
      mintPluginRunContext,
    })).resolves.toEqual({
      source: "plugin",
      value: { ok: true, content: "replayed", data: { record: 1 } },
    });
    expect(valid.executePlugin).not.toHaveBeenCalled();

    const invalid = setup({
      replayedPluginResult: { value: { content: "legacy replay" } },
    });
    await expect(invalid.executor.execute({
      capability,
      descriptor,
      arguments: {},
      callIdentity: { source: "provider", id: "replayed-invalid" },
      ingressOrdinal: 0,
      mintPluginRunContext,
    })).rejects.toThrow("Invalid plugin ToolResult");
    expect(invalid.executePlugin).not.toHaveBeenCalled();
  });
});

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
  ])("rejects a host-invalid $label as an interface conflict", async ({
    descriptor,
    message,
  }) => {
    const { executor } = setup();
    await expect(executor.execute({
      capability,
      descriptor,
      arguments: {},
      callIdentity: { source: "provider", id: descriptor.name },
      ingressOrdinal: 0,
      mintPluginRunContext,
    })).rejects.toMatchObject({
      name: "RuntimeInterfaceConflict",
      code: "runtime_interface_conflict",
      message,
    } satisfies Partial<RuntimeInterfaceConflict>);
  });

  it("routes retrieval through the effective issue scope", async () => {
    const { executor } = setup();
    await expect(
      executor.execute({
        capability,        descriptor: readComments,
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

  it("routes restore_session only through its dedicated recovery reader", async () => {
    const restored = { runs: [{ runId: "prior-run", turns: [] }] };
    const { executor, restoreSession } = setup({
      restoreSessionResult: restored,
    });
    const descriptor = compileRuntimeInterface({
      mode: "owner",
      contextDial: resolveContextDial({ agent: {} }).effective,
      actionGrants: {},
      isCurrentOwner: true,
      issueCreateDirectChildren: [],
      issueAssignTargets: [],
      creatorUpdateTargets: [],
      mentionTargets: [],
      configureTargets: [],
      pluginTools: [],
      restoreSession: true,
    }).byName.get("restore_session")!;

    await expect(executor.execute({
      capability,
      descriptor,
      arguments: { runId: "prior-run", cursor: "run-trace-cursor" },
      callIdentity: { source: "provider", id: "restore-page-2" },
      ingressOrdinal: 0,
      mintPluginRunContext,
    })).resolves.toEqual({ source: "paperclip", value: restored });

    expect(restoreSession).toHaveBeenCalledWith({
      capability,
      runId: "prior-run",
      cursor: "run-trace-cursor",
    });
  });

  it("uses a signed run-trace cursor through the compiled retrieval ABI", async () => {
    const { executor, readCanonicalRunTrace } = setup({
      agentDial: { read_issue_agent_run: true },
      enableRunTrace: true,
    });
    const first = await executor.execute({
      capability,
      descriptor: paperclipDescriptor("read_issue_agent_run", {
        contextDial: resolveContextDial({
          agent: { read_issue_agent_run: true },
        }).effective,
      }),
      arguments: { runId: "run-observed" },
      callIdentity: { source: "provider", id: "call-run-page-2" },
      ingressOrdinal: 0,
      mintPluginRunContext,
    });

    expect(first).toMatchObject({ source: "paperclip" });
    expect(readCanonicalRunTrace).toHaveBeenCalledWith(expect.objectContaining({
      companyId: "company",
      runId: "run-observed",
      after: null,
    }));
  });

  it("routes a Paperclip action with a run-bound canonical authority", async () => {
    const { executor, issueUpdate } = setup();
    await executor.execute({
      capability,
      descriptor: paperclipDescriptor("issue_update"),
      arguments: { status: "done", message: "done" },
      callIdentity: { source: "provider", id: "call-1" },
      ingressOrdinal: 0,
      mintPluginRunContext,
    });
    expect(issueUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({
          name: "issue_update",
          companyId: capability.companyId,
          issueId: capability.issueId,
          issueTarget: "active",
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
      capability,      descriptor: {
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
    expect(mintPluginRunContext).toHaveBeenCalledWith(
      {
        runInterfaceToolCallId: "ledger-call-1",
        pluginInstallationId: "plugin-installation",
        pluginManifestIdentity: "manifest-1",
      },
    );
    expect(executePlugin).toHaveBeenCalledWith(expect.objectContaining({
      capability,
      toolName: "lookup",
      pluginInstallationId: "plugin-installation",
      pluginManifestIdentity: "manifest-1",
      arguments: { query: "x" },
      mintPluginRunContext: expect.any(Function),
    }));
  });

  it("rejects invalid plugin arguments before minting context or calling the worker", async () => {
    const { executor, executePlugin } = setup();
    const mintRunContext = vi.fn(async () => "opaque");
    const descriptor = compileRuntimeInterface({
      mode: "owner",
      contextDial: resolveContextDial({ agent: {} }).effective,
      actionGrants: {},
      isCurrentOwner: true,
      issueCreateDirectChildren: [],
      issueAssignTargets: [],
      creatorUpdateTargets: [],
      mentionTargets: [],
      configureTargets: [],
      pluginTools: [{
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
      }],
    }).byName.get("paperclip.example__lookup")!;

    await expect(executor.execute({
      capability,
      descriptor,
      arguments: { query: "", unexpected: true },
      callIdentity: { source: "provider", id: "invalid-plugin-call" },
      ingressOrdinal: 0,
      mintPluginRunContext: mintRunContext,
    })).rejects.toThrow(RuntimeToolArgumentsInvalid);
    expect(mintRunContext).not.toHaveBeenCalled();
    expect(executePlugin).not.toHaveBeenCalled();
  });

  it("classifies and propagates the immutable mention ingress boundary", async () => {
    const {
      executor,
      mentionAgent,
      classify,
      commitMentionAction,
    } = setup();
    const descriptor = compileRuntimeInterface({
      mode: "owner",
      contextDial: resolveContextDial({ agent: {} }).effective,
      actionGrants: {},
      isCurrentOwner: true,
      issueCreateDirectChildren: [],
      issueAssignTargets: [],
      creatorUpdateTargets: [],
      mentionTargets: [
        { id: "mentioned-agent", name: "Mentioned", capabilities: null },
      ],
      configureTargets: [],
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

    expect(classify).toHaveBeenCalledWith({
      capability,
      id: "ledger-call-1",
      ingressOrdinal: 7,
      classification: "validated_mention",
      targetAgentId: "mentioned-agent",
    });
    const mention = mentionAgent.mock.calls[0]![0];
    expect(mention).toEqual(expect.objectContaining({
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
    }));
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
    const { executor, mentionBoard, classify, commitMentionAction } = setup();
    const descriptor = compileRuntimeInterface({
      mode: "owner",
      contextDial: resolveContextDial({ agent: {} }).effective,
      actionGrants: { mention_board: true },
      isCurrentOwner: true,
      issueCreateDirectChildren: [],
      issueAssignTargets: [],
      creatorUpdateTargets: [],
      mentionTargets: [],
      configureTargets: [],
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

    expect(classify).toHaveBeenCalledWith({
      capability,
      id: "ledger-call-1",
      ingressOrdinal: 8,
      classification: "non_mention",
    });
    expect(mentionBoard).toHaveBeenCalledWith(expect.objectContaining({
      command: expect.objectContaining({ name: "mention_board" }),
      authority: expect.objectContaining({
        invocation: expect.objectContaining({
          runInterfaceToolCallId: "ledger-call-1",
          ingressOrdinal: 8,
        }),
      }),
    }));
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
    const { executor } = setup();
    await expect(
      executor.execute({
        capability,        descriptor: readComments,
        arguments: { issueId: "issue", agentId: "leak" },
        callIdentity: { source: "provider", id: "call-1" },
        ingressOrdinal: 0,
        mintPluginRunContext,
      }),
    ).rejects.toBeInstanceOf(RuntimeToolArgumentsInvalid);
  });

  it("enforces the dynamically compiled configure catalog before dispatch", async () => {
    const { executor, agentConfigure } = setup();
    const descriptor = compileRuntimeInterface({
      mode: "owner",
      contextDial: resolveContextDial({ agent: {} }).effective,
      actionGrants: { agent_configure: true },
      isCurrentOwner: true,
      issueCreateDirectChildren: [],
      issueAssignTargets: [],
      creatorUpdateTargets: [],
      mentionTargets: [],
      configureTargets: [{ id: "agent" }],
      pluginTools: [],
    }).byName.get("agent_configure")!;

    await expect(
      executor.execute({
        capability,        descriptor,
        arguments: { agentId: "forged", title: null },
        callIdentity: { source: "provider", id: "configure-forged" },
        ingressOrdinal: 0,
        mintPluginRunContext,
      }),
    ).rejects.toBeInstanceOf(RuntimeToolArgumentsInvalid);
    expect(agentConfigure).not.toHaveBeenCalled();

    await expect(
      executor.execute({
        capability,        descriptor,
        arguments: { agentId: "agent", title: null },
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
          agentId: "agent",
          configuration: { title: null },
        },
      }),
    );
  });
});
