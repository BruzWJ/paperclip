// PAPERCLIP_REMOVAL_NEGATIVE_FIXTURE: AGENT_HOME, PAPERCLIP_API_KEY, PAPERCLIP_WORKSPACE_CWD
import { describe, expect, it } from "vitest";
import {
  AGENT_CONTEXT_GRANT_KEYS,
  AGENT_MENTION_REACH_GRANT_KEYS,
  PAPERCLIP_ACTION_KEYS,
} from "../issue-runtime.js";
import {
  adapterConfigSchema,
  agentRuntimeConfigSchema,
} from "./agent.js";
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
  runtimeAgentCompanyToolOptionSchema,
  runtimeAgentHireConfigurationSchema,
  runtimeAgentHireConfigurationSchemaForCompanyTools,
  runtimeAgentUpdateConfigurationSchema,
} from "./runtime-agent-configuration.js";

const AGENT_ID = "00000000-0000-4000-8000-000000000001";
const ENVIRONMENT_ID = "00000000-0000-4000-8000-000000000002";
const TOOL_ID = "00000000-0000-4000-8000-000000000003";
const SKILL_VERSION_ID = "00000000-0000-4000-8000-000000000004";

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
    contextGrants: falseMap(AGENT_CONTEXT_GRANT_KEYS),
    actionGrants: falseMap(PAPERCLIP_ACTION_KEYS),
    mentionReachGrants: falseMap(AGENT_MENTION_REACH_GRANT_KEYS),
    companyToolIds: [TOOL_ID],
  };
}

describe("runtime-agent control-plane validators", () => {
  it("accepts an explicit complete runtime-agent create configuration", () => {
    const input = runtimeAgentConfiguration();

    expect(runtimeAgentCreateConfigurationSchema.parse(input)).toEqual(input);
  });

  it("requires every field and every boolean cell at creation", () => {
    const missingTopLevel = runtimeAgentConfiguration();
    delete (missingTopLevel as Partial<typeof missingTopLevel>).companyToolIds;
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

  it("binds provider hire company-tool ids to the live create catalog", () => {
    const { reportsTo: _reportsTo, ...hire } = runtimeAgentConfiguration();
    const withOption =
      runtimeAgentHireConfigurationSchemaForCompanyTools([TOOL_ID]);
    expect(withOption.safeParse(hire).success).toBe(true);
    expect(
      withOption.safeParse({
        ...hire,
        companyToolIds: [ENVIRONMENT_ID],
      }).success,
    ).toBe(false);
    const withoutOptions =
      runtimeAgentHireConfigurationSchemaForCompanyTools([]);
    expect(
      withoutOptions.safeParse({ ...hire, companyToolIds: [] }).success,
    ).toBe(true);
    expect(withoutOptions.safeParse(hire).success).toBe(false);
  });

  it("keeps company-tool option projection strict and install-id free", () => {
    const option = {
      catalogEntryId: TOOL_ID,
      connectionId: ENVIRONMENT_ID,
      connectionName: "Records",
      title: "Lookup record",
      description: "Look up a record",
      catalogVersionHash: "catalog-v1",
    };
    expect(runtimeAgentCompanyToolOptionSchema.parse(option)).toEqual(option);
    expect(
      runtimeAgentCompanyToolOptionSchema.safeParse({
        ...option,
        connectionInstallId: AGENT_ID,
      }).success,
    ).toBe(false);
  });

  it("builds a nonempty id-only configure action contract", () => {
    const schema = runtimeAgentConfigureActionSchemaForTargets([AGENT_ID]);
    const contextGrants = falseMap(AGENT_CONTEXT_GRANT_KEYS);
    contextGrants.read_issue_comments = true;
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
      schema.safeParse({ ...input, agentId: TOOL_ID }).success,
    ).toBe(false);
  });

  it("rejects duplicate or malformed company-tool selections", () => {
    expect(
      runtimeAgentCreateConfigurationSchema.safeParse({
        ...runtimeAgentConfiguration(),
        companyToolIds: [TOOL_ID, TOOL_ID],
      }).success,
    ).toBe(false);
    expect(
      runtimeAgentCreateConfigurationSchema.safeParse({
        ...runtimeAgentConfiguration(),
        companyToolIds: ["not-a-uuid"],
      }).success,
    ).toBe(false);
  });
});

describe("adapter-revision control-plane validator", () => {
  const valid = {
    adapterType: "codex",
    adapterConfig: { model: "gpt-5.6" },
    defaultEnvironmentId: ENVIRONMENT_ID,
    runtimeConfig: {},
    companySkillPins: [],
    skillChannel: "operator_native" as const,
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
        adapterConfig: { env: "not-an-env-map" },
      }).success,
    ).toBe(false);
  });

  it("accepts only an exact root company-skill pin block", () => {
    const withPins = {
      ...valid,
      companySkillPins: [
        {
          key: "code-review",
          versionId: SKILL_VERSION_ID,
        },
      ],
      skillChannel: "isolated_skills_home" as const,
    };
    expect(
      agentAdapterRevisionConfigurationSchema.parse(withPins),
    ).toEqual(withPins);

    for (const adapterConfig of [
      {
        paperclipSkillSync: {
          desiredSkills: ["code-review"],
        },
      },
      {
        paperclipSkillSync: {
          desiredSkills: [],
          fallback: "latest",
        },
      },
      {
        nested: {
          paperclipSkillSync: {
            desiredSkills: [],
          },
        },
      },
    ]) {
      expect(
        agentAdapterRevisionConfigurationSchema.safeParse({
          ...valid,
          adapterConfig,
        }).success,
      ).toBe(false);
    }
    expect(
      agentAdapterRevisionConfigurationSchema.safeParse({
        ...valid,
        runtimeConfig: {
          paperclipSkillSync: { desiredSkills: [] },
        },
      }).success,
    ).toBe(false);
    expect(
      agentAdapterRevisionConfigurationSchema.safeParse({
        ...valid,
        skillChannel: "workspace",
      }).success,
    ).toBe(false);
  });

  it("keeps company-skill control fields out of revision provider remainders", () => {
    expect(
      agentAdapterRevisionConfigurationSchema.safeParse({
        ...valid,
        adapterConfig: {
          paperclipSkillSync: { desiredSkills: [] },
        },
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

describe("provider-only agent configuration", () => {
  it("keeps explicit provider-native configuration opaque without a prefix ban", () => {
    const adapterConfig = {
      env: {
        HOME: "/operator/home",
        CODEX_HOME: "/operator/codex",
        PAPERCLIP_CLOUD_PROD_PROVIDER_TOKEN: "operator-selected",
      },
      providerNative: {
        documentation: "https://provider.invalid/native/configuration",
      },
    };

    expect(adapterConfigSchema.parse(adapterConfig)).toEqual(adapterConfig);
  });

  it("rejects exact control-plane environment keys", () => {
    for (const key of [
      "PAPERCLIP_API_KEY",
      "paperclip_workspace_cwd",
      "AGENT_HOME",
      "BETTER_AUTH_SECRET",
      "DATABASE_URL",
    ]) {
      expect(
        adapterConfigSchema.safeParse({ env: { [key]: "forbidden" } })
          .success,
      ).toBe(false);
    }
  });

  it("recursively rejects the reserved company-skill block", () => {
    for (const adapterConfig of [
      { paperclipSkillSync: { desiredSkills: [] } },
      {
        provider: {
          paperclipSkillSync: { desiredSkills: [] },
        },
      },
    ]) {
      expect(adapterConfigSchema.safeParse(adapterConfig).success).toBe(false);
    }
    expect(
      agentRuntimeConfigSchema.safeParse({
        extension: {
          paperclipSkillSync: { desiredSkills: [] },
        },
      }).success,
    ).toBe(false);
  });

  it("rejects unknown runtime fields through the closed schema", () => {
    expect(
      agentRuntimeConfigSchema.safeParse({
        extension: {
          unsupportedRuntimeControl: { enabled: true },
        },
      }).success,
    ).toBe(false);
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

  it("rejects empty, malformed, system-owned, and cross-owner updates", () => {
    for (const invalid of [
      {},
      { defaultEnvironmentId: ENVIRONMENT_ID },
      { defaultEnvironmentId: "not-a-uuid" },
      { budgetMonthlyAmount: -1 },
      { knownSpendAmount: "10" },
      { status: "paused" },
      { name: "Researcher" },
      { adapterConfig: {} },
      { runtimeConfig: {} },
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
      { defaultEnvironmentId: ENVIRONMENT_ID },
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
        environmentId: ENVIRONMENT_ID,
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
