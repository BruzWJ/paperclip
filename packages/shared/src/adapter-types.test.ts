import { describe, expect, expectTypeOf, it } from "vitest";
import {
  acceptInviteSchema,
  createCompanyInviteSchema,
  agentAdapterRevisionConfigurationSchema,
  runtimeAgentCreateConfigurationSchema,
  AGENT_CONTEXT_GRANT_KEYS,
  AGENT_MENTION_REACH_GRANT_KEYS,
  PAPERCLIP_ACTION_KEYS,
} from "./index.js";
import type { Agent, CompanyPortabilityAgentManifestEntry } from "./index.js";

function allFalse(keys: readonly string[]) {
  return Object.fromEntries(keys.map((key) => [key, false]));
}

describe("dynamic adapter type validation schemas", () => {
  it("accepts external adapter types in the adapter revision contract", () => {
    expect(
      agentAdapterRevisionConfigurationSchema.parse({
        adapterType: "external_adapter",
        adapterConfig: {},
      }).adapterType,
    ).toBe("external_adapter");
  });

  it("rejects blank or implicit adapter configuration revisions", () => {
    expect(
      agentAdapterRevisionConfigurationSchema.safeParse({
        adapterType: "   ",
        adapterConfig: {},
      }).success,
    ).toBe(false);
    expect(
      agentAdapterRevisionConfigurationSchema.safeParse({
        adapterType: "external_adapter",
      }).success,
    ).toBe(false);
    expect(
      agentAdapterRevisionConfigurationSchema.safeParse({
        adapterType: " external_adapter ",
        adapterConfig: {},
      }).success,
    ).toBe(false);
  });

  it("represents an agent through one current revision identity", () => {
    expectTypeOf<Agent["currentAdapterConfigRevisionId"]>().toEqualTypeOf<
      string | null
    >();
    expectTypeOf<
      CompanyPortabilityAgentManifestEntry["adapterRevision"]["acpConfiguration"]
    >().toMatchTypeOf<{ launchProfile: { registryName: string } }>();
  });

  it("keeps invite payloads exact", () => {
    expect(
      createCompanyInviteSchema.safeParse({
        userRole: "operator",
        obsoleteField: "operator",
      }).success,
    ).toBe(false);
    expect(
      acceptInviteSchema.safeParse({
        obsoleteField: "user",
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
        instruction: null,
        contextGrants: allFalse(AGENT_CONTEXT_GRANT_KEYS),
        actionGrants: allFalse(PAPERCLIP_ACTION_KEYS),
        mentionReachGrants: allFalse(AGENT_MENTION_REACH_GRANT_KEYS),
        role: "security",
      }).success,
    ).toBe(false);
  });
});
