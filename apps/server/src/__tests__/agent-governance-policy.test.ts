import { describe, expect, it } from "vitest";
import {
  agentGovernancePolicySchema,
} from "@paperclipai/shared";
import { normalizeAgentGovernancePolicy } from "../services/agent-governance-policy.js";

describe("agent governance policy", () => {
  it("defaults to an empty independent governance document", () => {
    expect(normalizeAgentGovernancePolicy(undefined)).toEqual({});
  });

  it("preserves trust policy and extension-owned governance fields", () => {
    const governance = normalizeAgentGovernancePolicy({
      trustPreset: "standard",
      extensionPolicy: { review: true },
    });
    expect(governance).toEqual({
      trustPreset: "standard",
      extensionPolicy: { review: true },
    });
  });

  it("uses one schema for create and board governance updates", () => {
    const input = {
      trustPreset: "low_trust_review",
      authorizationPolicy: {
        trustPreset: "low_trust_review",
      },
    };
    expect(agentGovernancePolicySchema.parse(input)).toEqual(input);
  });

  it("normalizes an explicit policy clear by removing the storage key", () => {
    expect(
      normalizeAgentGovernancePolicy({
        trustPreset: "standard",
        authorizationPolicy: null,
      }),
    ).toEqual({ trustPreset: "standard" });
  });
});
