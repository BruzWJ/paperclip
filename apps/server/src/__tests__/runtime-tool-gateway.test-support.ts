import { describe, expect, it, vi } from "vitest";
import { resolveContextDial } from "../services/context-dial-resolver.js";
import { createContextRetrievalService } from "../services/context-retrieval.js";
import type {
  AgentRunToolAuthority,
  PaperclipManagedToolRouteContext,
  PaperclipManagedToolRouter,
} from "../services/paperclip-managed-tool-router.js";
import type { PaperclipManagedToolCommand } from "../services/paperclip-managed-tool-registry.js";
import { createRuntimePluginToolPort, createRuntimeToolGateway } from "../services/runtime-tool-gateway.js";
import {
  compileRuntimeInterface,
  type CompiledRunToolDescriptor,
} from "../services/runtime-interface-compiler.js";
import { RuntimeInterfaceConflict, RuntimeToolArgumentsInvalid } from "../services/runtime-tool-errors.js";
import type { PromptCapabilityBinding } from "../services/prompt-capability-gateway.js";
export const capability: PromptCapabilityBinding = {
  companyId: "company",
  capabilityConnectionId: "capability-connection",
  capabilityGeneration: 1,
  taskId: "task",
  sessionId: "task-session",
  runId: "run",
  runBatchDigest: "a".repeat(64),
  refId: "ref",
  refOrdinal: 0,
  segmentOrdinal: 0,
  attemptId: "attempt",
  workerProcessIdentity: "worker",
  taskExecutionAuthorityId: "authority",
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

export function paperclipDescriptor(
  name: string,
  overrides: Partial<Parameters<typeof compileRuntimeInterface>[0]> = {},
): CompiledRunToolDescriptor {
  const descriptor = compileRuntimeInterface({
    mode: "owner",
    turn: "work",
    contextDial: resolveContextDial({
      agent: { read_task_comments: true },
    }).effective,
    actionGrants: {},
    isCurrentOwner: true,
    taskCreateDirectChildren: [],
    taskAssignTargets: [],
    creatorUpdateTargets: [],
    mentionTargets: [],
    pluginTools: [],
    ...overrides,
  }).byName.get(name);
  if (!descriptor) throw new Error(`Missing compiled Paperclip tool ${name}`);
  return descriptor;
}

export const readComments = paperclipDescriptor("read_task_comments");

export function setup(
  options: {
    agentDial?: Parameters<typeof resolveContextDial>[0]["agent"];
    enableRunTrace?: boolean;
    replayedPluginResult?: { value: unknown };
  } = {},
) {
  const mentionTransaction = {} as never;
  const taskUpdate = vi.fn(async () => ({ ok: true }));
  const agentConfigure = vi.fn(async () => ({ configured: true }));
  const mentionAgent = vi.fn(async (input: { authority: AgentRunToolAuthority }) =>
    input.authority.invocation.commitMentionAction(mentionTransaction, {
      consulted: true,
    }),
  );
  const mentionBoard = vi.fn(async (input: { authority: AgentRunToolAuthority }) =>
    input.authority.invocation.commitMentionAction(mentionTransaction, {
      requested: true,
    }),
  );
  const executePlugin = vi.fn(async (input: { mintPluginRunContext(): Promise<string> }) => ({
    ok: true as const,
    content: "plugin result",
    data: { opaqueRunContext: await input.mintPluginRunContext() },
  }));
  const readCanonicalRunTrace = vi.fn(async ({ runId }: { runId: string }) => ({
    runId,
    runKind: "productive" as const,
    taskId: "task",
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
  }));
  const claim = vi.fn(async () => {
    if (options.replayedPluginResult) {
      return {
        state: "completed" as const,
        result: options.replayedPluginResult.value,
      };
    }
    return { state: "claimed" as const, id: "ledger-call-1" };
  });
  const registerTerminalInvalid = vi.fn(async () => undefined);
  const commitMentionAction = vi.fn(async (input: { result: unknown }) => input.result);
  const retrieval = createContextRetrievalService({
    cursorSecret: "secret",
    repository: {
      async taskReach() {
        return { sameCompany: true, active: true, descendant: false };
      },
      async listTopLevelTasks() {
        return [];
      },
      async listDirectChildren() {
        return [];
      },
      async listTaskComments({ taskId }) {
        return [
          {
            id: "comment",
            taskId,
            body: "visible",
            author: { kind: "user", userId: "board-user" },
            runId: null,
            sequence: 1,
            createdAt: "2026-07-25T00:00:00.000Z",
          },
        ];
      },
      async runTask() {
        return options.enableRunTrace ? { taskId: "task" } : null;
      },
      readCanonicalRunTrace,
    },
  });
  const managedTools = {
    async routeExecution(command: PaperclipManagedToolCommand, context: PaperclipManagedToolRouteContext) {
      if (context.authority.kind !== "agent_run") throw new Error("expected agent authority");
      const scope = runtimeScope;
      switch (command.name) {
        case "read_task_comments":
          return retrieval.readTaskComments(scope!, {
            taskId: command.taskId,
            cursor: command.cursor,
          });
        case "read_task_agent_run":
          return retrieval.readTaskAgentRun(scope!, {
            runId: command.runId,
            cursor: command.cursor,
          });
        case "task_update":
          return taskUpdate({
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
        default:
          return null;
      }
    },
  } as unknown as PaperclipManagedToolRouter;
  const runtimeScope = {
    companyId: "company",
    activeTaskId: "task",
    dial: resolveContextDial({
      agent: options.agentDial ?? { read_task_comments: true },
    }).effective,
  };
  const runtimeGateway = createRuntimeToolGateway({
    managedTools,
    pluginTools: {
      execute: executePlugin,
    },
    callLedger: {
      claim,
      registerTerminalInvalid,
      commitMentionAction,
      async complete() {},
      async fail() {},
    },
  });
  const executor = {
    execute(input: Parameters<typeof runtimeGateway.execute>[0]) {
      return runtimeGateway.execute(input);
    },
  };
  return {
    executor,
    taskUpdate,
    agentConfigure,
    mentionAgent,
    mentionBoard,
    claim,
    registerTerminalInvalid,
    commitMentionAction,
    executePlugin,
    readCanonicalRunTrace,
    mentionTransaction,
  };
}

export const mintPluginRunContext = vi.fn(async () => "pc_plugin_ctx_v1_opaque");

export { describe, expect, it, vi, resolveContextDial, createContextRetrievalService };
export { createRuntimePluginToolPort, createRuntimeToolGateway };
export { compileRuntimeInterface, RuntimeInterfaceConflict };
export { RuntimeToolArgumentsInvalid };
export type { AgentRunToolAuthority, PaperclipManagedToolRouteContext };
export type { PaperclipManagedToolRouter, PaperclipManagedToolCommand };
export type { CompiledRunToolDescriptor, PromptCapabilityBinding };
