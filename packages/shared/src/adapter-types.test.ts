import {
  describe,
  expect,
  expectTypeOf,
  it,
} from "vitest";
import {
  acceptInviteSchema,
  agentAdapterRevisionConfigurationSchema,
  runtimeAgentCreateConfigurationSchema,
  AGENT_CONTEXT_GRANT_KEYS,
  AGENT_MENTION_REACH_GRANT_KEYS,
  PAPERCLIP_ACTION_KEYS,
} from "./index.js";
import type {
  Agent,
  AgentAdapterType,
  CompanyPortabilityAgentManifestEntry,
} from "./index.js";

function allFalse(keys: readonly string[]) {
  return Object.fromEntries(keys.map((key) => [key, false]));
}

describe("dynamic adapter type validation schemas", () => {
  it("accepts external adapter types in the adapter revision contract", () => {
    expect(
      agentAdapterRevisionConfigurationSchema.parse({
        adapterType: "external_adapter",
        adapterConfig: {},
        defaultEnvironmentId:
          "11111111-1111-4111-8111-111111111111",
        runtimeConfig: {},
        companySkillPins: [],
        skillChannel: "operator_native",
      }).adapterType,
    ).toBe("external_adapter");
  });

  it("rejects blank or implicit adapter configuration revisions", () => {
    expect(
      agentAdapterRevisionConfigurationSchema.safeParse({
        adapterType: "   ",
        adapterConfig: {},
        defaultEnvironmentId:
          "11111111-1111-4111-8111-111111111111",
        runtimeConfig: {},
      }).success,
    ).toBe(false);
    expect(
      agentAdapterRevisionConfigurationSchema.safeParse({
        adapterType: "external_adapter",
        defaultEnvironmentId:
          "11111111-1111-4111-8111-111111111111",
        runtimeConfig: {},
      }).success,
    ).toBe(false);
  });

  it("represents an unconfigured API agent with nullable adapter fields", () => {
    expectTypeOf<Agent["adapterType"]>().toEqualTypeOf<
      AgentAdapterType | null
    >();
    expectTypeOf<Agent["adapterConfig"]>().toEqualTypeOf<
      Record<string, unknown> | null
    >();
    expectTypeOf<
      CompanyPortabilityAgentManifestEntry["adapterRevision"]["adapterType"]
    >().toEqualTypeOf<string>();
    expectTypeOf<
      CompanyPortabilityAgentManifestEntry["adapterRevision"]["adapterConfig"]
    >().toEqualTypeOf<Record<string, unknown>>();
  });

  it("accepts external adapter types only with explicit invite config", () => {
    expect(
      acceptInviteSchema.parse({
        requestType: "agent",
        agentName: "External Joiner",
        adapterType: "external_adapter",
        agentDefaultsPayload: {},
      }).adapterType,
    ).toBe("external_adapter");
    expect(
      acceptInviteSchema.safeParse({
        requestType: "agent",
        agentName: "Implicit Joiner",
        adapterType: "external_adapter",
      }).success,
    ).toBe(false);
  });

  it("rejects the retired role field at the runtime-agent boundary", () => {
    expect(
      runtimeAgentCreateConfigurationSchema.safeParse({
        name: "Security Engineer",
        title: null,
        capabilities: null,
        reportsTo: null,
        contextGrants: allFalse(AGENT_CONTEXT_GRANT_KEYS),
        actionGrants: allFalse(PAPERCLIP_ACTION_KEYS),
        mentionReachGrants: allFalse(
          AGENT_MENTION_REACH_GRANT_KEYS,
        ),
        companyToolIds: [],
        role: "security",
      }).success,
    ).toBe(false);
  });
});
