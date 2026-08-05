import { describe, expect, it, vi } from "vitest";
import { resolveContextDial } from "../services/context-dial-resolver.js";
import { createContextRetrievalService } from "../services/context-retrieval.js";
import {
  createRuntimeToolExecutor,
  type RuntimeActionInvocation,
  type RuntimeActionPort,
} from "../services/runtime-tool-executor.js";
import {
  compileRuntimeInterface,
  RuntimeDescriptorArgumentsInvalid,
  RuntimeRetrievalArgumentsInvalid,
  type CompiledRunToolDescriptor,
} from "../services/runtime-interface-compiler.js";
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
  leaseId: "lease",
  leaseGeneration: 1,
  expiresAt: new Date("2026-07-25T01:00:00.000Z"),
  activatedAt: new Date("2026-07-25T00:00:00.000Z"),
  createdAt: new Date("2026-07-25T00:00:00.000Z"),
};

const readComments: CompiledRunToolDescriptor = {
  name: "read_issue_comments",
  title: "Read comments",
  description: "",
  inputSchema: { type: "object" },
  source: "paperclip",
};

function setup(options: {
  agentDial?: Parameters<typeof resolveContextDial>[0]["agent"];
  enableRunTrace?: boolean;
} = {}) {
  const terminalTransaction = {} as never;
  const issueUpdate = vi.fn(async () => ({ ok: true }));
  const agentConfigure = vi.fn(async () => ({ configured: true }));
  const mentionAgent = vi.fn(
    async (input: RuntimeActionInvocation) =>
      input.commitTerminalAction(terminalTransaction, { consulted: true }),
  );
  const mentionBoard = vi.fn(
    async (input: RuntimeActionInvocation) =>
      input.commitTerminalAction(terminalTransaction, { requested: true }),
  );
  const no = vi.fn(async () => null);
  const actions: RuntimeActionPort = {
    issueCreate: no,
    issueAssign: no,
    issueUpdate,
    mentionAgent,
    mentionBoard,
    agentHire: no,
    agentConfigure,
  };
  const executeCompany = vi.fn(
    async (input: { mintPluginRunContext(): Promise<string> }) => ({
      company: true,
      opaqueRunContext: await input.mintPluginRunContext(),
    }),
  );
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
  const commitTerminalAction = vi.fn(
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
  const executor = createRuntimeToolExecutor({
    retrieval,
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
    actions,
    companyTools: {
      execute: executeCompany,
    },
    callLedger: {
      async claim() {
        return { state: "claimed", id: "ledger-call-1" };
      },
      async registerTerminalInvalid() {},
      classify,
      commitTerminalAction,
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
    commitTerminalAction,
    executeCompany,
    readCanonicalRunTrace,
    terminalTransaction,
  };
}

const mintPluginRunContext = vi.fn(
  async () => "pc_plugin_ctx_v1_opaque",
);

describe("runtime tool executor", () => {
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
    ).resolves.toMatchObject({ items: [{ body: "visible" }] });
  });

  it("forwards the opaque run-trace cursor through the compiled retrieval ABI", async () => {
    const { executor, readCanonicalRunTrace } = setup({
      agentDial: { read_issue_agent_run: true },
      enableRunTrace: true,
    });
    await executor.execute({
      capability,      descriptor: {
        name: "read_issue_agent_run",
        title: "Read run",
        description: "",
        inputSchema: { type: "object" },
        source: "paperclip",
      },
      arguments: {
        runId: "run-observed",
        cursor: "opaque-page-2",
      },
      callIdentity: { source: "provider", id: "call-run-page-2" },
      ingressOrdinal: 0,
      mintPluginRunContext,
    });

    expect(readCanonicalRunTrace).toHaveBeenCalledWith({
      companyId: "company",
      runId: "run-observed",
      projection: "run-trace",
      cursor: "opaque-page-2",
    });
  });

  it("routes a Paperclip action with a run-bound invocation identity", async () => {
    const { executor, issueUpdate } = setup();
    await executor.execute({
      capability,      descriptor: {
        name: "issue_update",
        title: "",
        description: "",
        inputSchema: {},
        source: "paperclip",
      },
      arguments: { form: "owner", status: "done", message: "done" },
      callIdentity: { source: "provider", id: "call-1" },
      ingressOrdinal: 0,
      mintPluginRunContext,
    });
    expect(issueUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        capability,
        invocationId: expect.stringMatching(/^call_[0-9a-f]{64}$/),
        runInterfaceToolCallId: "ledger-call-1",
        ingressOrdinal: 0,
        commitTerminalAction: expect.any(Function),
      }),
    );
  });

  it("gives company tools only an opaque run-context handle", async () => {
    const { executor, executeCompany } = setup();
    await executor.execute({
      capability,      descriptor: {
        name: "company_lookup",
        title: "",
        description: "",
        inputSchema: {},
        source: "company",
        selectedCompanyToolSelectionId: "company-tool-selection",
        pluginInstallationId: "plugin-installation",
      },
      arguments: { query: "x" },
      callIdentity: { source: "provider", id: "call-1" },
      ingressOrdinal: 0,
      mintPluginRunContext,
    });
    expect(mintPluginRunContext).toHaveBeenCalledWith(
      {
        runInterfaceToolCallId: "ledger-call-1",
        companyToolSelectionId: "company-tool-selection",
        pluginInstallationId: "plugin-installation",
      },
    );
    expect(executeCompany).toHaveBeenCalledWith(expect.objectContaining({
      capability,      companyToolSelectionId: "company-tool-selection",
      arguments: { query: "x" },
      callIdentity: { source: "provider", id: "call-1" },
      runInterfaceToolCallId: "ledger-call-1",
      mintPluginRunContext: expect.any(Function),
    }));
  });

  it("classifies and propagates the immutable mention ingress boundary", async () => {
    const {
      executor,
      mentionAgent,
      classify,
      commitTerminalAction,
      terminalTransaction,
    } = setup();
    const commitTerminalAudit = vi.fn(async () => undefined);
    const descriptor = compileRuntimeInterface({
      mode: "owner",
      contextDial: resolveContextDial({ agent: {} }).effective,
      actionGrants: { mention_agent: true },
      isCurrentOwner: true,
      issueCreateDirectChildren: [],
      issueAssignTargets: [],
      creatorUpdateTargets: [],
      mentionTargets: [
        { id: "mentioned-agent", name: "Mentioned", capabilities: null },
      ],
      configureTargets: [],
      agentHireCompanyToolOptions: [],
      selectedCompanyTools: [],
    }).byName.get("mention_agent")!;

    await executor.execute({
      capability,
      descriptor,
      arguments: { agentId: "mentioned-agent", message: "help" },
      callIdentity: { source: "jsonrpc", id: "mention-1" },
      ingressOrdinal: 7,
      mintPluginRunContext,
      commitTerminalAudit,
    });

    expect(classify).toHaveBeenCalledWith({
      capability,
      id: "ledger-call-1",
      ingressOrdinal: 7,
      classification: "validated_mention",
      targetAgentId: "mentioned-agent",
    });
    const invocation = mentionAgent.mock.calls[0]![0];
    expect(invocation).toEqual(expect.objectContaining({
      runInterfaceToolCallId: "ledger-call-1",
      ingressOrdinal: 7,
    }));
    expect(commitTerminalAction).toHaveBeenCalledWith(
      expect.objectContaining({
        capability,
        id: "ledger-call-1",
        ingressOrdinal: 7,
        toolName: "mention_agent",
        targetAgentId: "mentioned-agent",
        result: { consulted: true },
      }),
    );
    expect(commitTerminalAudit).toHaveBeenCalledWith(terminalTransaction);
  });

  it("routes a Board request as a non-mention ledger action", async () => {
    const { executor, mentionBoard, classify, commitTerminalAction } = setup();
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
      agentHireCompanyToolOptions: [],
      selectedCompanyTools: [],
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
    ).resolves.toEqual({ requested: true });

    expect(classify).toHaveBeenCalledWith({
      capability,
      id: "ledger-call-1",
      ingressOrdinal: 8,
      classification: "non_mention",
    });
    expect(mentionBoard).toHaveBeenCalledWith(expect.objectContaining({
      arguments: { message: "Please choose a rollout" },
    }));
    expect(commitTerminalAction).toHaveBeenCalledWith(
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
    ).rejects.toBeInstanceOf(RuntimeRetrievalArgumentsInvalid);
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
      agentHireCompanyToolOptions: [],
      selectedCompanyTools: [],
    }).byName.get("agent_configure")!;

    await expect(
      executor.execute({
        capability,        descriptor,
        arguments: { agentId: "forged", title: null },
        callIdentity: { source: "provider", id: "configure-forged" },
        ingressOrdinal: 0,
        mintPluginRunContext,
      }),
    ).rejects.toBeInstanceOf(RuntimeDescriptorArgumentsInvalid);
    expect(agentConfigure).not.toHaveBeenCalled();

    await expect(
      executor.execute({
        capability,        descriptor,
        arguments: { agentId: "agent", title: null },
        callIdentity: { source: "provider", id: "configure-valid" },
        ingressOrdinal: 1,
        mintPluginRunContext,
      }),
    ).resolves.toEqual({ configured: true });
    expect(agentConfigure).toHaveBeenCalledWith(
      expect.objectContaining({
        arguments: { agentId: "agent", title: null },
      }),
    );
  });
});
