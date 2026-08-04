import {
  AGENT_CONTEXT_GRANT_KEYS,
  AGENT_MENTION_REACH_GRANT_KEYS,
  PAPERCLIP_ACTION_KEYS,
  type RuntimeAgentConfigurationSnapshot,
} from "@paperclipai/shared";
import { describe, expect, it, vi } from "vitest";
import { createRuntimeAgentActionPort } from "../services/runtime-agent-action-port.js";
import {
  createRuntimeAgentConfigurationService,
  listRuntimeAgentCreateCompanyToolOptions,
  listRuntimeAgentEditCompanyToolOptions,
  parseRuntimeAgentCreateConfiguration,
  parseRuntimeAgentUpdateConfiguration,
  RuntimeAgentConfigurationConsentRequired,
  RuntimeAgentConfigurationDenied,
  RuntimeAgentConfigurationInvalid,
  runtimeAgentConfigurationDisplayedDiff,
  type RuntimeAgentConfigurationService,
} from "../services/runtime-agent-configuration.js";
import { RuntimeToolArgumentsInvalid } from "../services/runtime-tool-executor.js";
import { createMockDb } from "./helpers/mock-db.js";
import { testBoardSessionActor } from "./helpers/request-actor.js";

const companyId = "00000000-0000-4000-8000-000000000001";
const agentId = "00000000-0000-4000-8000-000000000002";
const toolIdA = "00000000-0000-4000-8000-000000000003";
const toolIdB = "00000000-0000-4000-8000-000000000004";

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
    issueId: "00000000-0000-4000-8000-000000000010",
    runId: "00000000-0000-4000-8000-000000000011",
    refId: "00000000-0000-4000-8000-000000000012",
  } as never;
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

function snapshot(): RuntimeAgentConfigurationSnapshot {
  return {
    identity: {
      name: "Research Agent",
      title: "Researcher",
      capabilities: "Find primary sources",
      reportsTo: null,
    },
    contextGrants: { read_issue_comments: true },
    actionGrants: { issue_create: true },
    mentionReachGrants: { mention_any_ancestor: true },
    companyToolIds: [toolIdA],
  };
}

describe("runtime-agent configuration canonical contracts", () => {
  it("parses only exact runtime-owned identity, grants, reach, and tool fields", () => {
    const parsed = parseRuntimeAgentCreateConfiguration({
      name: "  Research Agent  ",
      title: "Researcher",
      capabilities: "Find primary sources",
      reportsTo: null,
      contextGrants: {
        read_issue_comments: true,
        list_company_issues: false,
      },
      actionGrants: {
        issue_create: true,
        issue_update: false,
      },
      mentionReachGrants: { mention_any_ancestor: true },
      companyToolIds: [toolIdB, toolIdA],
    });

    expect(parsed).toEqual({
      name: "Research Agent",
      title: "Researcher",
      capabilities: "Find primary sources",
      reportsTo: null,
      contextGrants: {
        read_issue_comments: true,
        list_company_issues: false,
      },
      actionGrants: { issue_create: true, issue_update: false },
      mentionReachGrants: { mention_any_ancestor: true },
      companyToolIds: [toolIdA, toolIdB],
    });
    expect(JSON.stringify(parsed)).not.toMatch(
      /adapter|provider|runtimeConfig|skill|icon|environment|budget|cost/i,
    );
  });

  it.each([
    ["role", { name: "Unsafe", role: "retired" }],
    ["adapterConfig", { name: "Unsafe", adapterConfig: { model: "forbidden" } }],
    ["provider", { name: "Unsafe", provider: "forbidden" }],
    ["runtimeConfig", { name: "Unsafe", runtimeConfig: {} }],
    ["skills", { name: "Unsafe", skills: ["forbidden"] }],
  ])("rejects the non-canonical %s field", (_field, value) => {
    expect(() => parseRuntimeAgentCreateConfiguration(value))
      .toThrow(RuntimeAgentConfigurationInvalid);
  });

  it("rejects malformed grants, duplicate tools, and invalid reporting identities", () => {
    expect(() => parseRuntimeAgentCreateConfiguration({
      name: "Bad grant",
      contextGrants: { invented_context: true },
    })).toThrow(/unsupported fields/i);
    expect(() => parseRuntimeAgentCreateConfiguration({
      name: "Duplicate tools",
      companyToolIds: [toolIdA, toolIdA],
    })).toThrow(/duplicates/i);
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
        read_issue_comments: true,
      },
    })).toEqual({
      title: null,
      contextGrants: {
        carry_context: false,
        read_issue_comments: true,
      },
    });
  });

  it("renders a deterministic consent diff containing only requested fields", () => {
    const diff = runtimeAgentConfigurationDisplayedDiff(
      agentId,
      snapshot(),
      {
        title: "Board consented",
        contextGrants: { carry_context: true },
      },
    );

    expect(diff).toBe([
      `--- agent:${agentId}:configuration`,
      `+++ agent:${agentId}:configuration`,
      "-{\"contextGrants\":{\"read_issue_comments\":true},\"title\":\"Researcher\"}",
      "+{\"contextGrants\":{\"carry_context\":true},\"title\":\"Board consented\"}",
    ].join("\n"));
    expect(diff).not.toContain("companyToolIds");
    expect(diff).not.toContain("capabilities");
  });
});

describe("runtime-agent tool option projection without a database process", () => {
  const activeRow = {
    catalogEntryId: toolIdA,
    connectionId: "00000000-0000-4000-8000-000000000020",
    connectionName: "Research MCP",
    entryName: "lookup_record",
    toolName: "lookup_record",
    title: null,
    description: null,
    catalogVersionHash: "catalog-v1",
    entryKind: "tool",
    entryStatus: "active",
    connectionStatus: "active",
    connectionEnabled: true,
    applicationStatus: "active",
    pluginId: null,
    pluginStatus: null,
  };

  it("projects only concrete active tools and hides connection-install identity", async () => {
    const harness = createMockDb({
      select: [[
        activeRow,
        { ...activeRow, catalogEntryId: toolIdB, entryStatus: "disabled" },
        { ...activeRow, catalogEntryId: toolIdB, pluginId: "plugin-1", pluginStatus: "error" },
      ]],
    });

    const options = await listRuntimeAgentCreateCompanyToolOptions(
      harness.db,
      companyId,
    );

    expect(options).toEqual([{
      catalogEntryId: toolIdA,
      connectionId: activeRow.connectionId,
      connectionName: "Research MCP",
      title: "lookup_record",
      description: "",
      catalogVersionHash: "catalog-v1",
    }]);
    expect(options[0]).not.toHaveProperty("connectionInstallId");
    expect(harness.remaining("select")).toBe(0);
  });

  it("uses the same canonical projection for an agent-scoped connection", async () => {
    const harness = createMockDb({ select: [[activeRow]] });

    await expect(listRuntimeAgentEditCompanyToolOptions(
      harness.db,
      companyId,
      agentId,
    )).resolves.toEqual([
      expect.objectContaining({ catalogEntryId: toolIdA }),
    ]);
  });

  it("fails closed before listing tools for a missing or inactive company", async () => {
    const missing = createMockDb({ select: [[]] });
    await expect(
      createRuntimeAgentConfigurationService(missing.db)
        .listCreateCompanyToolOptions(companyId),
    ).rejects.toThrow("Company must exist and be active");

    const inactive = createMockDb({
      select: [[{ id: companyId, status: "archived" }]],
    });
    await expect(
      createRuntimeAgentConfigurationService(inactive.db)
        .listCreateCompanyToolOptions(companyId),
    ).rejects.toThrow("Company must exist and be active");
  });

  it("lists tools only after locking the exact non-terminated target", async () => {
    const harness = createMockDb({
      select: [[{ id: agentId, status: "idle" }], [activeRow]],
    });

    await expect(
      createRuntimeAgentConfigurationService(harness.db)
        .listAgentCompanyToolOptions({ companyId, agentId }),
    ).resolves.toEqual([
      expect.objectContaining({ catalogEntryId: toolIdA }),
    ]);
    expect(harness.remaining("select")).toBe(0);

    const terminated = createMockDb({
      select: [[{ id: agentId, status: "terminated" }]],
    });
    await expect(
      createRuntimeAgentConfigurationService(terminated.db)
        .listAgentCompanyToolOptions({ companyId, agentId }),
    ).rejects.toThrow(/non-terminated agent/i);
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

  it("rejects retired or provider-owned hire fields before calling the service", async () => {
    const hireFromRun = vi.fn();
    const actions = createRuntimeAgentActionPort(fakeService({
      hireFromRun: hireFromRun as never,
    }));

    for (const argumentsValue of [
      { name: "Unsafe child", role: "retired" },
      { name: "Unsafe child", adapterType: "codex" },
      { name: "Unsafe child", adapterConfig: { model: "forbidden" } },
      { name: "Unsafe child", reportsTo: agentId },
    ]) {
      await expect(actions.agentHire({
        capability: capability(),
        invocationId: "hire-invalid",
        arguments: argumentsValue,
      })).rejects.toBeInstanceOf(RuntimeToolArgumentsInvalid);
    }
    expect(hireFromRun).not.toHaveBeenCalled();
  });

  it("forwards the complete canonical hire contract and injects no reporting edge", async () => {
    const hireFromRun = vi.fn(async () => ({ status: "ok" } as never));
    const actions = createRuntimeAgentActionPort(fakeService({
      hireFromRun: hireFromRun as never,
    }));
    const argumentsValue = {
      name: "Direct Child",
      title: null,
      capabilities: null,
      contextGrants: completeBooleanMap(AGENT_CONTEXT_GRANT_KEYS, {
        read_issue_comments: true,
      }),
      actionGrants: completeBooleanMap(PAPERCLIP_ACTION_KEYS, {
        issue_create: true,
      }),
      mentionReachGrants: completeBooleanMap(AGENT_MENTION_REACH_GRANT_KEYS),
      companyToolIds: [toolIdA],
    };

    await expect(actions.agentHire({
      capability: capability(),
      invocationId: "hire-1",
      arguments: argumentsValue,
    })).resolves.toEqual({ status: "created" });
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

    await expect(actions.agentHire({
      capability: capability(),
      invocationId: "hire-invalid-service",
      arguments: {
        name: "Direct Child",
        title: null,
        capabilities: null,
        contextGrants: completeBooleanMap(AGENT_CONTEXT_GRANT_KEYS),
        actionGrants: completeBooleanMap(PAPERCLIP_ACTION_KEYS),
        mentionReachGrants: completeBooleanMap(AGENT_MENTION_REACH_GRANT_KEYS),
        companyToolIds: [],
      },
    })).rejects.toBeInstanceOf(RuntimeToolArgumentsInvalid);
  });

  it("turns explicit consent-required configuration into one consent request", async () => {
    const displayedDiff = runtimeAgentConfigurationDisplayedDiff(
      agentId,
      snapshot(),
      { title: "Board consented" },
    );
    const configureFromRun = vi.fn(async () => {
      throw new RuntimeAgentConfigurationConsentRequired(
        "Consent required",
        agentId,
        displayedDiff,
      );
    });
    const requestChangeConsent = vi.fn(async () => undefined);
    const actions = createRuntimeAgentActionPort(fakeService({
      configureFromRun: configureFromRun as never,
    }), { requestChangeConsent });

    await expect(actions.agentConfigure({
      capability: capability(),
      invocationId: "configure-consent",
      arguments: { agentId, title: "Board consented" },
    })).resolves.toEqual({ status: "change_consent_requested" });
    expect(requestChangeConsent).toHaveBeenCalledExactlyOnceWith({
      capability: capability(),
      targetAgentId: agentId,
      displayedDiff,
    });
  });

  it("does not swallow an ordinary configure denial", async () => {
    const actions = createRuntimeAgentActionPort(fakeService({
      configureFromRun: vi.fn(async () => {
        throw new RuntimeAgentConfigurationDenied(
          "Action grant missing",
          "action_grant_missing",
        );
      }) as never,
    }), {
      requestChangeConsent: vi.fn(async () => undefined),
    });

    await expect(actions.agentConfigure({
      capability: capability(),
      invocationId: "configure-denied",
      arguments: { agentId, title: "Denied" },
    })).rejects.toMatchObject({ reason: "action_grant_missing" });
  });

  it("rejects changed stable action identity arguments at the canonical schema edge", async () => {
    const configureFromRun = vi.fn(async () => ({ status: "ok" } as never));
    const actions = createRuntimeAgentActionPort(fakeService({
      configureFromRun: configureFromRun as never,
    }));

    await expect(actions.agentConfigure({
      capability: capability(),
      invocationId: "configure-invalid",
      arguments: {
        agentId,
        title: "Allowed",
        provider: "forbidden",
      },
    })).rejects.toBeInstanceOf(RuntimeToolArgumentsInvalid);
    expect(configureFromRun).not.toHaveBeenCalled();
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
