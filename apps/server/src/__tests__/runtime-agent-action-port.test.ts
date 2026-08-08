import { describe, expect, it, vi } from "vitest";
import {
  AGENT_CONTEXT_GRANT_KEYS,
  AGENT_MENTION_REACH_GRANT_KEYS,
  PAPERCLIP_ACTION_KEYS,
} from "@paperclipai/shared";
import {
  RuntimeAgentConfigurationConsentRequired,
  type RuntimeAgentConfigurationService,
} from "../services/runtime-agent-configuration.js";
import { createRuntimeAgentActionPort } from "../services/runtime-agent-action-port.js";
import { createRuntimeToolGateway } from "../services/runtime-tool-gateway.js";
import {
  agentRunManagedActionInvocation,
  type AgentRunToolAuthority,
} from "../services/paperclip-managed-tool-router.js";
import type {
  PaperclipManagedToolRouteContext,
  PaperclipManagedToolRouter,
} from "../services/paperclip-managed-tool-router.js";
import type { PaperclipManagedToolCommand } from "../services/paperclip-managed-tool-registry.js";
import type { PromptCapabilityBinding } from "../services/prompt-capability-gateway.js";
import { compileRuntimeInterface } from "../services/runtime-interface-compiler.js";
import { resolveContextDial } from "../services/context-dial-resolver.js";

const TARGET_AGENT_ID = "20000000-0000-4000-8000-000000000002";
const DISPLAYED_DIFF = [
  `--- agent:${TARGET_AGENT_ID}:configuration`,
  `+++ agent:${TARGET_AGENT_ID}:configuration`,
  '-{"title":"Before"}',
  '+{"title":"After"}',
].join("\n");

const capability = {
  capabilityConnectionId: "prompt-capability-1",
  capabilityGeneration: 1,
  companyId: "company-1",
  targetAgentId: "10000000-0000-4000-8000-000000000001",
  runId: "run-1",
  bootstrapToolGate: false,
} as PromptCapabilityBinding;

function actionAuthority(invocationId: string): AgentRunToolAuthority {
  return {
    kind: "agent_run",
    capability,
    invocation: {
      id: invocationId,
      runInterfaceToolCallId: `ledger-${invocationId}`,
      ingressOrdinal: 0,
      async commitMentionAction(_transaction, result) {
        return result;
      },
    },
  };
}

function deniedService() {
  return {
    configureFromRun: vi.fn().mockRejectedValue(
      new RuntimeAgentConfigurationConsentRequired(
        "Board consent is required",
        TARGET_AGENT_ID,
        DISPLAYED_DIFF,
      ),
    ),
  } as unknown as RuntimeAgentConfigurationService;
}

const sensitiveConfigurationResult = {
  companyId: "company-1",
  agentId: TARGET_AGENT_ID,
  auditId: "audit-1",
  approvalId: "approval-1",
  retried: false,
  configuration: {
    identity: {
      name: "Internal target",
      title: "Internal title",
      capabilities: "Internal capabilities",
      reportsTo: capability.targetAgentId,
    },
    contextGrants: { carry_context: true },
    actionGrants: { agent_configure: true },
    mentionReachGrants: { mention_any_ancestor: true },
  },
};

function replayingExecutor(
  actions: ReturnType<typeof createRuntimeAgentActionPort>,
) {
  let completed = false;
  let completedResult: unknown;
  const callLedger = {
    claim: vi.fn(async () => completed
      ? { state: "completed" as const, result: completedResult }
      : { state: "claimed" as const, id: "ledger-call-1" }),
    registerTerminalInvalid: vi.fn(async () => undefined),
    classify: vi.fn(async () => undefined),
    commitMentionAction: vi.fn(),
    complete: vi.fn(async ({ result }: { result: unknown }) => {
      completedResult = result;
      completed = true;
    }),
    fail: vi.fn(async () => undefined),
  };
  const managedTools = {
    async routeExecution(
      command: PaperclipManagedToolCommand,
      context: PaperclipManagedToolRouteContext,
    ) {
      if (context.authority.kind !== "agent_run") throw new Error("expected agent authority");
      if (command.name === "agent_hire") {
        return actions.agentHire(
          agentRunManagedActionInvocation(command, context.authority),
        );
      }
      if (command.name === "agent_configure") {
        return actions.agentConfigure(
          agentRunManagedActionInvocation(command, context.authority),
        );
      }
      throw new Error(`Unexpected managed tool ${command.name}`);
    },
  } as unknown as PaperclipManagedToolRouter;
  const gateway = createRuntimeToolGateway({
    retrievalScope: {
      async resolve() {
        throw new Error("retrieval is not used by agent actions");
      },
    },
    managedTools,
    pluginTools: {} as never,
    callLedger: callLedger as never,
  });

  async function call(
    name: "agent_hire" | "agent_configure",
    arguments_: Record<string, unknown>,
  ) {
    const descriptor = compileRuntimeInterface({
      mode: "owner",
      contextDial: resolveContextDial({ agent: {} }).effective,
      actionGrants: { agent_hire: true, agent_configure: true },
      isCurrentOwner: true,
      issueCreateDirectChildren: [],
      issueAssignTargets: [],
      creatorUpdateTargets: [],
      mentionTargets: [],
      configureTargets: [
        { id: capability.targetAgentId },
        { id: TARGET_AGENT_ID },
      ],
      pluginTools: [],
    }).byName.get(name);
    if (!descriptor) throw new Error(`Missing compiled tool ${name}`);
    return gateway.execute({
      capability,
      descriptor,
      arguments: arguments_,
      callIdentity: { source: "jsonrpc", id: "provider-call-1" },
      ingressOrdinal: 0,
      mintPluginRunContext: async () => "unused",
    });
  }

  return { call, callLedger };
}

describe("runtime agent action provider receipts", () => {
  it("persists and replays only the closed hire receipt", async () => {
    const hireFromRun = vi.fn().mockResolvedValue(sensitiveConfigurationResult);
    const actions = createRuntimeAgentActionPort({
      hireFromRun,
    } as unknown as RuntimeAgentConfigurationService);
    const { call, callLedger } = replayingExecutor(actions);

    const arguments_ = {
      name: "Direct child",
      title: null,
      capabilities: null,
      instruction: null,
      contextGrants: Object.fromEntries(
        AGENT_CONTEXT_GRANT_KEYS.map((key) => [key, false]),
      ),
      actionGrants: Object.fromEntries(
        PAPERCLIP_ACTION_KEYS.map((key) => [key, false]),
      ),
      mentionReachGrants: Object.fromEntries(
        AGENT_MENTION_REACH_GRANT_KEYS.map((key) => [key, false]),
      ),
    };
    await expect(call("agent_hire", arguments_)).resolves.toEqual({
      source: "paperclip",
      value: { status: "created" },
    });
    await expect(call("agent_hire", arguments_)).resolves.toEqual({
      source: "paperclip",
      value: { status: "created" },
    });
    expect(hireFromRun).toHaveBeenCalledTimes(1);
    expect(callLedger.complete).toHaveBeenCalledTimes(1);
    expect(callLedger.complete).toHaveBeenCalledWith(expect.objectContaining({
      result: { status: "created" },
    }));
  });

  it.each([
    ["self", capability.targetAgentId],
    ["other", TARGET_AGENT_ID],
  ] as const)(
    "persists and replays only the closed %s configure receipt",
    async (_label, agentId) => {
      const configureFromRun = vi.fn().mockResolvedValue(
        sensitiveConfigurationResult,
      );
      const actions = createRuntimeAgentActionPort({
        configureFromRun,
      } as unknown as RuntimeAgentConfigurationService);
      const { call, callLedger } = replayingExecutor(actions);

      await expect(call("agent_configure", {
        agentId,
        title: "Updated",
      })).resolves.toEqual({
        source: "paperclip",
        value: { status: "configured" },
      });
      await expect(call("agent_configure", {
        agentId,
        title: "Updated",
      })).resolves.toEqual({
        source: "paperclip",
        value: { status: "configured" },
      });
      expect(configureFromRun).toHaveBeenCalledTimes(1);
      expect(callLedger.complete).toHaveBeenCalledTimes(1);
      expect(callLedger.complete).toHaveBeenCalledWith(
        expect.objectContaining({ result: { status: "configured" } }),
      );
    },
  );

  it("persists and replays only the closed pending-consent receipt", async () => {
    const requestChangeConsent = vi.fn(async () => undefined);
    const actions = createRuntimeAgentActionPort(deniedService(), {
      requestChangeConsent,
    });
    const { call, callLedger } = replayingExecutor(actions);

    await expect(call("agent_configure", {
      agentId: TARGET_AGENT_ID,
      title: "After",
    })).resolves.toEqual({
      source: "paperclip",
      value: { status: "change_consent_requested" },
    });
    await expect(call("agent_configure", {
      agentId: TARGET_AGENT_ID,
      title: "After",
    })).resolves.toEqual({
      source: "paperclip",
      value: { status: "change_consent_requested" },
    });
    expect(requestChangeConsent).toHaveBeenCalledTimes(1);
    expect(callLedger.complete).toHaveBeenCalledTimes(1);
    expect(callLedger.complete).toHaveBeenCalledWith(expect.objectContaining({
      result: { status: "change_consent_requested" },
    }));
  });
});

describe("runtime agent action change-consent ownership", () => {
  it("creates the pending consent through agent_configure instead of generic REST", async () => {
    const requestChangeConsent = vi.fn(async () => undefined);
    const actions = createRuntimeAgentActionPort(deniedService(), {
      requestChangeConsent,
    });

    await expect(actions.agentConfigure(agentRunManagedActionInvocation({
      name: "agent_configure",
      companyId: capability.companyId,
      agentId: TARGET_AGENT_ID,
      configuration: { title: "After" },
    }, actionAuthority("configure-call-1")))).resolves.toEqual({
      status: "change_consent_requested",
    });
    expect(requestChangeConsent).toHaveBeenCalledWith({
      capability,
      targetAgentId: TARGET_AGENT_ID,
      displayedDiff: DISPLAYED_DIFF,
    });
  });

  it("fails closed when the compiled action has no consent-request owner", async () => {
    const actions = createRuntimeAgentActionPort(deniedService());
    await expect(actions.agentConfigure(agentRunManagedActionInvocation({
      name: "agent_configure",
      companyId: capability.companyId,
      agentId: TARGET_AGENT_ID,
      configuration: { title: "After" },
    }, actionAuthority("configure-call-2")))).rejects.toBeInstanceOf(
      RuntimeAgentConfigurationConsentRequired,
    );
  });
});
