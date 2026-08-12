// PAPERCLIP_REMOVAL_NEGATIVE_FIXTURE: AGENT_HOME, PAPERCLIP_API_KEY, PAPERCLIP_WORKSPACE_CWD
import { describe, expect, it } from "vitest";
import {
  AGENT_CONTEXT_GRANT_KEYS,
  AGENT_MENTION_REACH_GRANT_KEYS,
  PAPERCLIP_ACTION_KEYS,
} from "../task-runtime.js";
import { adapterConfigSchema } from "./agent.js";
import {
  agentAdapterConfigurationTestInputSchema,
  agentAdapterConfigurationTestResultSchema,
  agentAdapterRevisionConfigurationSchema,
  agentContextGrantMapSchema,
  agentMentionReachGrantMapSchema,
  agentOperationalConfigurationUpdateSchema,
  paperclipActionGrantMapSchema,
  runtimeAgentConfigureActionSchema,
  runtimeAgentConfigureActionSchemaForTargets,
  runtimeAgentCreateConfigurationSchema,
  runtimeAgentHireConfigurationSchema,
  runtimeAgentUpdateConfigurationSchema,
} from "./runtime-agent-configuration.js";

const AGENT_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_AGENT_ID = "00000000-0000-4000-8000-000000000003";

function falseMap<Key extends string>(
  keys: readonly Key[],
): Record<Key, boolean> {
  return Object.fromEntries(keys.map((key) => [key, false])) as Record<
    Key,
    boolean
  >;
}

function runtimeAgentConfiguration() {
  return {
    name: "Researcher",
    title: null,
    capabilities: "Investigates a bounded question.",
    reportsTo: AGENT_ID,
    instruction: null,
    contextGrants: falseMap(AGENT_CONTEXT_GRANT_KEYS),
    actionGrants: falseMap(PAPERCLIP_ACTION_KEYS),
    mentionReachGrants: falseMap(AGENT_MENTION_REACH_GRANT_KEYS),
  };
}

describe("runtime-agent control-plane validators", () => {
  it("accepts an explicit complete runtime-agent create configuration", () => {
    const input = runtimeAgentConfiguration();

    expect(runtimeAgentCreateConfigurationSchema.parse(input)).toEqual(input);
  });

  it("requires every field and every boolean cell at creation", () => {
    const missingTopLevel = runtimeAgentConfiguration();
    delete (missingTopLevel as Partial<typeof missingTopLevel>).name;
    expect(
      runtimeAgentCreateConfigurationSchema.safeParse(missingTopLevel).success,
    ).toBe(false);

    const missingCell = runtimeAgentConfiguration();
    delete (
      missingCell.contextGrants as Partial<typeof missingCell.contextGrants>
    ).carry_context;
    expect(
      runtimeAgentCreateConfigurationSchema.safeParse(missingCell).success,
    ).toBe(false);
  });

  it.each([
    [
      "context",
      agentContextGrantMapSchema,
      falseMap(AGENT_CONTEXT_GRANT_KEYS),
    ],
    [
      "action",
      paperclipActionGrantMapSchema,
      falseMap(PAPERCLIP_ACTION_KEYS),
    ],
    [
      "mention reach",
      agentMentionReachGrantMapSchema,
      falseMap(AGENT_MENTION_REACH_GRANT_KEYS),
    ],
  ])("keeps the %s grant map closed", (_label, schema, valid) => {
    expect(schema.safeParse(valid).success).toBe(true);
    expect(
      schema.safeParse({ ...valid, invented_grant: false }).success,
    ).toBe(false);
  });

  it("rejects relationship-derived task actions as configurable grants", () => {
    const grants = falseMap(PAPERCLIP_ACTION_KEYS);

    expect(
      paperclipActionGrantMapSchema.safeParse({
        ...grants,
        task_assign: false,
      }).success,
    ).toBe(false);
    expect(
      paperclipActionGrantMapSchema.safeParse({
        ...grants,
        task_update: false,
      }).success,
    ).toBe(false);
  });

  it("accepts only a nonempty strict partial for runtime-agent updates", () => {
    expect(
      runtimeAgentUpdateConfigurationSchema.parse({
        capabilities: null,
      }),
    ).toEqual({ capabilities: null });
    expect(runtimeAgentUpdateConfigurationSchema.safeParse({}).success).toBe(
      false,
    );
    expect(
      runtimeAgentUpdateConfigurationSchema.safeParse({
        adapterType: "codex",
      }).success,
    ).toBe(false);
    expect(
      runtimeAgentUpdateConfigurationSchema.safeParse({
        contextGrants: {
          carry_context: true,
        },
      }).success,
    ).toBe(false);
  });

  it("derives a provider hire contract that cannot choose reportsTo", () => {
    const { reportsTo: _reportsTo, ...hire } = runtimeAgentConfiguration();
    expect(runtimeAgentHireConfigurationSchema.parse(hire)).toEqual(hire);
    expect(
      runtimeAgentHireConfigurationSchema.safeParse(
        runtimeAgentConfiguration(),
      ).success,
    ).toBe(false);
  });

  it("builds a nonempty id-only configure action contract", () => {
    const schema = runtimeAgentConfigureActionSchemaForTargets([AGENT_ID]);
    const contextGrants = falseMap(AGENT_CONTEXT_GRANT_KEYS);
    contextGrants.read_task_comments = true;
    const input = {
      agentId: AGENT_ID,
      title: null,
      reportsTo: null,
      contextGrants,
    };
    expect(schema.parse(input)).toEqual(input);
    expect(runtimeAgentConfigureActionSchema.safeParse(input).success).toBe(
      true,
    );
    expect(schema.safeParse({ agentId: AGENT_ID }).success).toBe(false);
    expect(
      schema.safeParse({
        agentId: AGENT_ID,
        contextGrants: { carry_context: true },
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ ...input, agentId: OTHER_AGENT_ID }).success,
    ).toBe(false);
  });

});

describe("adapter-revision control-plane validator", () => {
  const valid = {
    adapterType: "codex",
    adapterConfig: { model: "gpt-5.6" },
  };

  it("accepts only adapter and execution-target configuration", () => {
    expect(agentAdapterRevisionConfigurationSchema.parse(valid)).toEqual(valid);
  });

  it("reuses adapter configuration validation", () => {
    expect(
      agentAdapterRevisionConfigurationSchema.safeParse({
        ...valid,
        adapterType: "   ",
      }).success,
    ).toBe(false);
    expect(
      agentAdapterRevisionConfigurationSchema.safeParse({
        ...valid,
        adapterConfig: { env: { key: "not-a-native-option-value" } },
      }).success,
    ).toBe(false);
  });

  it("rejects runtime-agent and operational fields structurally", () => {
    for (const field of [
      { name: "Researcher" },
      { contextGrants: falseMap(AGENT_CONTEXT_GRANT_KEYS) },
      { icon: "bot" },
      { budgetMonthlyAmount: "1000" },
    ]) {
      expect(
        agentAdapterRevisionConfigurationSchema.safeParse({
          ...valid,
          ...field,
        }).success,
      ).toBe(false);
    }
  });
});

describe("ACPX option editor values", () => {
  it("accepts only exact string and boolean session values", () => {
    expect(adapterConfigSchema.parse({ model: "gpt-5.6", enabled: true })).toEqual({
      model: "gpt-5.6",
      enabled: true,
    });
    expect(adapterConfigSchema.safeParse({ nested: { value: "x" } }).success).toBe(false);
  });
});

describe("agent operational control-plane validator", () => {
  it("accepts a nonempty partial of only board-operational fields", () => {
    expect(
      agentOperationalConfigurationUpdateSchema.parse({
        icon: null,
        budgetMonthlyAmount: "1000",
      }),
    ).toEqual({
      icon: null,
      budgetMonthlyAmount: "1000",
    });
  });

  it("accepts a nullable canonical agent instruction", () => {
    expect(
      agentOperationalConfigurationUpdateSchema.parse({
        instruction: "Act as a careful reviewer.",
      }),
    ).toEqual({ instruction: "Act as a careful reviewer." });
    expect(
      agentOperationalConfigurationUpdateSchema.parse({ instruction: null }),
    ).toEqual({ instruction: null });
  });

  it("rejects empty, malformed, system-owned, and cross-owner updates", () => {
    for (const invalid of [
      {},
      { budgetMonthlyAmount: -1 },
      { knownSpendAmount: "10" },
      { status: "paused" },
      { name: "Researcher" },
      { adapterConfig: {} },
      { runtimeConfig: {} },
      { instruction: "   " },
    ]) {
      expect(
        agentOperationalConfigurationUpdateSchema.safeParse(invalid).success,
      ).toBe(false);
    }
  });
});

describe("control-plane ownership walls", () => {
  it("rejects adapter and operational fields from runtime-agent creation", () => {
    for (const field of [
      { adapterType: "codex" },
      { adapterConfig: {} },
      { runtimeConfig: {} },
      { icon: "bot" },
      { budgetMonthlyAmount: "1000" },
      { status: "idle" },
      { knownSpendAmount: "0" },
    ]) {
      expect(
        runtimeAgentCreateConfigurationSchema.safeParse({
          ...runtimeAgentConfiguration(),
          ...field,
        }).success,
      ).toBe(false);
    }
  });
});

describe("unsaved adapter configuration test contract", () => {
  it("accepts only adapter-owned configuration and an observational result", () => {
    expect(
      agentAdapterConfigurationTestInputSchema.parse({
        adapterConfig: {
          model: "gpt-5.6",
          reasoning_effort: "high",
        },
      }),
    ).toEqual({
      adapterConfig: {
        model: "gpt-5.6",
        reasoning_effort: "high",
      },
    });
    expect(
      agentAdapterConfigurationTestResultSchema.parse({
        status: "ready",
        adapterType: "codex",
        runtimeControls: ["session/status"],
        testedAt: "2026-08-04T18:00:00.000Z",
      }),
    ).toMatchObject({ status: "ready", adapterType: "codex" });
  });

  it("rejects execution scope and mismatched result variants", () => {
    expect(
      agentAdapterConfigurationTestInputSchema.safeParse({
        adapterConfig: {},
        executionTarget: "remote",
      }).success,
    ).toBe(false);
    expect(
      agentAdapterConfigurationTestResultSchema.safeParse({
        status: "failed",
        adapterType: "codex",
        runtimeControls: [],
        testedAt: "2026-08-04T18:00:00.000Z",
      }).success,
    ).toBe(false);
  });
});
