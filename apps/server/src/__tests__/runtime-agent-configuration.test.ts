import {
  AGENT_CONTEXT_GRANT_KEYS,
  AGENT_MENTION_REACH_GRANT_KEYS,
  PAPERCLIP_ACTION_KEYS,
} from "@paperclipai/shared";
import { describe, expect, it, vi } from "vitest";
import { createRuntimeAgentActionPort } from "../services/runtime-agent-action-port.js";
import * as agentConfigOps from "../services/runtime-agent-configuration-part-3.js";
import * as taskAction from "../services/runtime-task-action-port-shared-part-3.js";
import {
  agentRunManagedActionInvocation,
  type AgentRunToolAuthority,
} from "../services/paperclip-managed-tool-router.js";
import {
  createRuntimeAgentConfigurationService,
  parseRuntimeAgentCreateConfiguration,
  parseRuntimeAgentUpdateConfiguration,
  RuntimeAgentConfigurationInvalid,
  type RuntimeAgentConfigurationService,
} from "../services/runtime-agent-configuration.js";
import { RuntimeTaskActionDenied } from "../services/runtime-task-action-port.js";
import { RuntimeToolArgumentsInvalid } from "../services/runtime-tool-errors.js";
import { createMockDb } from "./helpers/mock-db.js";
import { testBoardSessionActor } from "./helpers/request-actor.js";

const companyId = "00000000-0000-4000-8000-000000000001";
const agentId = "00000000-0000-4000-8000-000000000002";
const otherAgentId = "00000000-0000-4000-8000-000000000003";
const newManagerId = "00000000-0000-4000-8000-000000000004";

function completeBooleanMap<Key extends string>(
  keys: readonly Key[],
  enabled: Partial<Record<Key, boolean>> = {},
): Record<Key, boolean> {
  return Object.fromEntries(
    keys.map((key) => [key, enabled[key] ?? false]),
  ) as Record<Key, boolean>;
}

function capability() {
  return {
    companyId,
    targetAgentId: agentId,
    taskId: "00000000-0000-4000-8000-000000000010",
    runId: "00000000-0000-4000-8000-000000000011",
    refId: "00000000-0000-4000-8000-000000000012",
  } as never;
}

function actionAuthority(invocationId: string): AgentRunToolAuthority {
  return {
    kind: "agent_run",
    capability: capability(),
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

function boardActor() {
  return {
    kind: "board" as const,
    actorId: "board-user",
    authorization: testBoardSessionActor({
      userId: "board-user",
      companyIds: [companyId],
    }),
  };
}

describe("runtime-agent configuration canonical contracts", () => {
  it("parses only exact runtime-owned identity, grants, and reach fields", () => {
    const parsed = parseRuntimeAgentCreateConfiguration({
      name: "  Research Agent  ",
      title: "Researcher",
      capabilities: "Find primary sources",
      reportsTo: null,
      instruction: null,
      contextGrants: {
        read_task_comments: true,
        list_company_tasks: false,
      },
      actionGrants: {
        task_create: true,
      },
      mentionReachGrants: { mention_any_ancestor: true },
    });

    expect(parsed).toEqual({
      name: "Research Agent",
      title: "Researcher",
      capabilities: "Find primary sources",
      reportsTo: null,
      instruction: null,
      contextGrants: {
        read_task_comments: true,
        list_company_tasks: false,
      },
      actionGrants: { task_create: true },
      mentionReachGrants: { mention_any_ancestor: true },
    });
    expect(JSON.stringify(parsed)).not.toMatch(
      /adapter|provider|runtimeConfig|icon|environment|budget|cost/i,
    );
  });

  it.each([
    ["role", { name: "Unsafe", role: "retired" }],
    ["adapterConfig", { name: "Unsafe", adapterConfig: { model: "forbidden" } }],
    ["provider", { name: "Unsafe", provider: "forbidden" }],
    ["runtimeConfig", { name: "Unsafe", runtimeConfig: {} }],
    ["catalog", { name: "Unsafe", catalog: ["forbidden"] }],
  ])("rejects the non-canonical %s field", (_field, value) => {
    expect(() => parseRuntimeAgentCreateConfiguration(value))
      .toThrow(RuntimeAgentConfigurationInvalid);
  });

  it("rejects malformed grants and invalid reporting identities", () => {
    expect(() => parseRuntimeAgentCreateConfiguration({
      name: "Bad grant",
      contextGrants: { invented_context: true },
    })).toThrow(/unsupported fields/i);
    expect(() => parseRuntimeAgentCreateConfiguration({
      name: "Bad manager",
      reportsTo: "not-a-uuid",
    })).toThrow(/UUID/i);
  });

  it("requires a nonempty patch and preserves explicit false grant updates", () => {
    expect(() => parseRuntimeAgentUpdateConfiguration({}))
      .toThrow("At least one runtime-agent configuration field is required");

    expect(parseRuntimeAgentUpdateConfiguration({
      title: null,
      contextGrants: {
        carry_context: false,
        read_task_comments: true,
      },
    })).toEqual({
      title: null,
      contextGrants: {
        carry_context: false,
        read_task_comments: true,
      },
    });
  });

});

describe("runtime-agent action boundary", () => {
  function fakeService(input: {
    hireFromRun?: RuntimeAgentConfigurationService["hireFromRun"];
    configureFromRun?: RuntimeAgentConfigurationService["configureFromRun"];
  } = {}) {
    return {
      hireFromRun: input.hireFromRun ?? vi.fn(async () => ({ status: "ok" } as never)),
      configureFromRun:
        input.configureFromRun ?? vi.fn(async () => ({ status: "ok" } as never)),
    } as unknown as RuntimeAgentConfigurationService;
  }

  it("forwards the complete canonical hire contract and injects no reporting edge", async () => {
    const hireFromRun = vi.fn(async () => ({ status: "ok" } as never));
    const actions = createRuntimeAgentActionPort(fakeService({
      hireFromRun: hireFromRun as never,
    }));
    const argumentsValue = {
      name: "Direct Child",
      title: null,
      capabilities: null,
      instruction: null,
      contextGrants: completeBooleanMap(AGENT_CONTEXT_GRANT_KEYS, {
        read_task_comments: true,
      }),
      actionGrants: completeBooleanMap(PAPERCLIP_ACTION_KEYS, {
        task_create: true,
      }),
      mentionReachGrants: completeBooleanMap(AGENT_MENTION_REACH_GRANT_KEYS),
    };

    await expect(actions.agentHire(agentRunManagedActionInvocation({
      name: "agent_hire",
      companyId,
      configuration: { ...argumentsValue, reportsTo: agentId },
    } as never, actionAuthority("hire-1")))).resolves.toEqual({ status: "created" });
    expect(hireFromRun).toHaveBeenCalledExactlyOnceWith({
      capability: capability(),
      invocationId: "hire-1",
      configuration: argumentsValue,
    });
    expect(hireFromRun.mock.calls[0]?.[0].configuration)
      .not.toHaveProperty("reportsTo");
  });

  it("maps service parsing failures to the runtime tool argument error", async () => {
    const actions = createRuntimeAgentActionPort(fakeService({
      hireFromRun: vi.fn(async () => {
        throw new RuntimeAgentConfigurationInvalid("canonical failure");
      }) as never,
    }));

    await expect(actions.agentHire(agentRunManagedActionInvocation({
      name: "agent_hire",
      companyId,
      configuration: {
        name: "Direct Child",
        title: null,
        capabilities: null,
        instruction: null,
        contextGrants: completeBooleanMap(AGENT_CONTEXT_GRANT_KEYS),
        actionGrants: completeBooleanMap(PAPERCLIP_ACTION_KEYS),
        mentionReachGrants: completeBooleanMap(AGENT_MENTION_REACH_GRANT_KEYS),
        reportsTo: agentId,
      },
    } as never, actionAuthority("hire-invalid-service")))).rejects.toBeInstanceOf(
      RuntimeToolArgumentsInvalid,
    );
  });

  it("does not swallow the canonical runtime-tool denial", async () => {
    const actions = createRuntimeAgentActionPort(fakeService({
      configureFromRun: vi.fn(async () => {
        throw new RuntimeTaskActionDenied(
          "Current runtime catalog no longer exposes agent_configure",
          "runtime_tool_unavailable",
        );
      }) as never,
    }));

    await expect(actions.agentConfigure(agentRunManagedActionInvocation({
      name: "agent_configure",
      companyId,
      agentId,
      configuration: { title: "Denied" },
    } as never, actionAuthority("configure-denied")))).rejects.toMatchObject({
      reason: "runtime_tool_unavailable",
    });
  });

  it("uses only the canonical runtime gate to reparent an unrelated same-company agent", async () => {
    const caller = {
      id: agentId,
      companyId,
      name: "Caller",
      reportsTo: null,
      status: "idle",
    } as never;
    const target = {
      id: otherAgentId,
      companyId,
      name: "Target",
      reportsTo: null,
      status: "idle",
    } as never;
    const newManager = {
      id: newManagerId,
      companyId,
      name: "New manager",
      reportsTo: null,
      status: "idle",
    } as never;
    const beforeIdentity = {
      name: "Target",
      title: null,
      capabilities: null,
      reportsTo: null,
      instruction: null,
    };
    const afterIdentity = { ...beforeIdentity, reportsTo: newManagerId };
    const harness = createMockDb({
      select: [
        [],
        [beforeIdentity],
        [],
        [],
        [],
        [afterIdentity],
        [],
        [],
        [],
      ],
      update: [[]],
      insert: [[]],
    });
    const lockRuntimeToolAuthority = vi
      .spyOn(taskAction, "lockRuntimeToolAuthority")
      .mockResolvedValue({
        company: { id: companyId, status: "active" },
        companyAgents: [caller, target, newManager],
      } as never);
    const lockCompanyAndAgents = vi.spyOn(agentConfigOps, "lockCompanyAndAgents");

    try {
      const service = createRuntimeAgentConfigurationService(harness.db, {
        idFactory: () => "00000000-0000-4000-8000-000000000099",
      });
      const result = await service.configureFromRun({
        capability: capability(),
        invocationId: "configure-reporting",
        targetAgentId: otherAgentId,
        configuration: { reportsTo: newManagerId },
      });

      expect(result.configuration.identity.reportsTo).toBe(newManagerId);
      expect(lockRuntimeToolAuthority).toHaveBeenCalledExactlyOnceWith(
        expect.anything(),
        capability(),
        "agent_configure",
        expect.any(Date),
      );
      expect(lockCompanyAndAgents).not.toHaveBeenCalled();
      expect(harness.remaining("select")).toBe(0);
    } finally {
      lockCompanyAndAgents.mockRestore();
      lockRuntimeToolAuthority.mockRestore();
    }
  });

  it("rejects invalid board/plugin source pairing before opening a transaction", async () => {
    const harness = createMockDb();
    const service = createRuntimeAgentConfigurationService(harness.db);

    await expect(service.create({
      companyId,
      actor: boardActor(),
      source: "plugin_control",
      configuration: { name: "Invalid source" },
    })).rejects.toThrow("Board actors cannot use plugin_control source");
    expect(harness.calls).toEqual([]);
  });
});
