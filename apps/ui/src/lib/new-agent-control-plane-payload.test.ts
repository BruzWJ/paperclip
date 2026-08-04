// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseMoneyAmount } from "@paperclipai/shared";
import { defaultCreateValues } from "../components/agent-config-defaults";
import { createEmptyRuntimeAgentConfigurationValues } from "../components/RuntimeAgentConfigurationFields";
import { buildNewAgentControlPlanePayloads } from "./new-agent-control-plane-payload";

describe("buildNewAgentControlPlanePayloads", () => {
  it("keeps runtime identity, adapter revision, and operational fields separate", () => {
    const runtimeAccess = createEmptyRuntimeAgentConfigurationValues();
    runtimeAccess.contextGrants.read_issue_comments = true;
    runtimeAccess.actionGrants.issue_update = true;
    runtimeAccess.mentionReachGrants.mention_any_ancestor = true;
    runtimeAccess.companyToolIds = [
      "11111111-1111-4111-8111-111111111111",
    ];

    const payloads = buildNewAgentControlPlanePayloads({
      name: "  Builder  ",
      title: " Engineer ",
      capabilities: " Builds product ",
      reportsTo: "22222222-2222-4222-8222-222222222222",
      runtimeAccess,
      configValues: {
        ...defaultCreateValues,
        adapterType: "codex",
        defaultEnvironmentId: "33333333-3333-4333-8333-333333333333",
      },
      adapterConfig: { model: "gpt-5.6" },
      companySkillPins: [
        {
          key: "research",
          versionId: "44444444-4444-4444-8444-444444444444",
        },
      ],
      skillChannel: "isolated_skills_home",
    });

    expect(payloads.runtimeAgent).toEqual({
      name: "Builder",
      title: "Engineer",
      capabilities: "Builds product",
      reportsTo: "22222222-2222-4222-8222-222222222222",
      contextGrants: runtimeAccess.contextGrants,
      actionGrants: runtimeAccess.actionGrants,
      mentionReachGrants: runtimeAccess.mentionReachGrants,
      companyToolIds: runtimeAccess.companyToolIds,
    });
    expect(payloads.adapterRevision).toEqual({
      adapterType: "codex",
      adapterConfig: { model: "gpt-5.6" },
      defaultEnvironmentId: "33333333-3333-4333-8333-333333333333",
      runtimeConfig: {},
      companySkillPins: [
        {
          key: "research",
          versionId: "44444444-4444-4444-8444-444444444444",
        },
      ],
      skillChannel: "isolated_skills_home",
    });
    expect(payloads.operational).toEqual({
      budgetMonthlyAmount: parseMoneyAmount("0"),
    });
  });

  it("requires an explicit execution environment instead of inferring a target", () => {
    expect(() =>
      buildNewAgentControlPlanePayloads({
        name: "Worker",
        runtimeAccess: createEmptyRuntimeAgentConfigurationValues(),
        configValues: {
          ...defaultCreateValues,
          adapterType: "codex",
        },
        adapterConfig: { model: "fixture/large" },
        companySkillPins: [],
        skillChannel: "operator_native",
      }),
    ).toThrow("Select an explicit execution environment");
  });
});
