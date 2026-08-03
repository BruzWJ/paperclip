import { describe, expect, it } from "vitest";
import { agentAdapterAcpConfigurationSchema } from "./agent-adapter-revision.js";

const ENVIRONMENT_ID = "00000000-0000-4000-8000-000000000001";
const SKILL_VERSION_A = "00000000-0000-4000-8000-000000000002";
const SKILL_VERSION_B = "00000000-0000-4000-8000-000000000003";

function configuration() {
  return {
    contractVersion: "acp-subprocess/v1" as const,
    launchProfile: {
      registryName: "codex",
      targetNativeCli: "codex",
      command: "/opt/paperclip/bin/codex-acp",
      args: ["--acp"],
      frontendPackage: "@agentclientprotocol/codex-acp",
      frontendVersion: "1.1.7",
      frontendDigest: "0deb6b820dfed8804cd76b16a50210fe12202e5e339b5edaa23f6987f1742e0a",
    },
    sessionConfigSelections: [
      { configId: "model", value: "gpt-5.6" },
      { configId: "reasoning_effort", value: "high" },
    ],
    model: {
      id: "gpt-5.6",
      label: "GPT-5.6",
      value: "gpt-5.6",
      limits: {
        contextTokenLimit: 1_050_000,
        inputTokenLimit: 922_000,
        outputTokenLimit: 128_000,
      },
    },
    executionTargetSelector: {
      defaultEnvironmentId: ENVIRONMENT_ID,
      executionTargetDriver: "local" as const,
      executionTargetDigest: "a".repeat(64),
    },
    workspaceSelector: {
      kind: "issue_execution_workspace" as const,
    },
    companySkillPins: [
      { key: "code-review", versionId: SKILL_VERSION_A },
      { key: "research", versionId: SKILL_VERSION_B },
    ],
    skillChannel: "isolated_skills_home" as const,
  };
}

describe("agent adapter ACP revision configuration", () => {
  it("accepts the complete closed immutable configuration", () => {
    expect(agentAdapterAcpConfigurationSchema.parse(configuration())).toEqual(
      configuration(),
    );
  });

  it("requires a nonempty, unique, code-unit-sorted config selection", () => {
    expect(
      agentAdapterAcpConfigurationSchema.safeParse({
        ...configuration(),
        sessionConfigSelections: [],
      }).success,
    ).toBe(false);
    expect(
      agentAdapterAcpConfigurationSchema.safeParse({
        ...configuration(),
        sessionConfigSelections: [
          { configId: "model", value: "gpt-5.6" },
          { configId: "model", value: "gpt-5.6-sol" },
        ],
      }).success,
    ).toBe(false);
    expect(
      agentAdapterAcpConfigurationSchema.safeParse({
        ...configuration(),
        sessionConfigSelections: [
          { configId: "reasoning_effort", value: "high" },
          { configId: "model", value: "gpt-5.6" },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects missing selectors, unsorted pins, aliases, and extra fields", () => {
    const base = configuration();
    const { workspaceSelector: _workspaceSelector, ...withoutWorkspace } = base;
    expect(
      agentAdapterAcpConfigurationSchema.safeParse(withoutWorkspace).success,
    ).toBe(false);
    expect(
      agentAdapterAcpConfigurationSchema.safeParse({
        ...base,
        companySkillPins: [...base.companySkillPins].reverse(),
      }).success,
    ).toBe(false);
    expect(
      agentAdapterAcpConfigurationSchema.safeParse({
        ...base,
        skillChannel: "workspace",
      }).success,
    ).toBe(false);
    for (const [key, value] of [
      ["nativeCorrelationKind", "native/v1"],
      ["modelRef", "provider/model"],
      ["providerSelectors", {}],
      ["sessionKind", "stateful"],
      ["transport", "subprocess"],
    ] as const) {
      expect(
        agentAdapterAcpConfigurationSchema.safeParse({
          ...base,
          [key]: value,
        }).success,
      ).toBe(false);
    }
    const {
      frontendDigest: _frontendDigest,
      ...launchWithoutDigest
    } = base.launchProfile;
    expect(
      agentAdapterAcpConfigurationSchema.safeParse({
        ...base,
        launchProfile: launchWithoutDigest,
      }).success,
    ).toBe(false);
    const {
      targetNativeCli: _targetNativeCli,
      ...launchWithoutTargetNativeCli
    } = base.launchProfile;
    expect(
      agentAdapterAcpConfigurationSchema.safeParse({
        ...base,
        launchProfile: launchWithoutTargetNativeCli,
      }).success,
    ).toBe(false);
    expect(
      agentAdapterAcpConfigurationSchema.safeParse({
        ...base,
        launchProfile: {
          ...base.launchProfile,
          frontendDigest: base.launchProfile.frontendDigest.toUpperCase(),
        },
      }).success,
    ).toBe(false);
  });

  it("rejects invalid model limits and target selectors", () => {
    const base = configuration();
    expect(
      agentAdapterAcpConfigurationSchema.safeParse({
        ...base,
        model: {
          ...base.model,
          limits: {
            ...base.model.limits,
            outputTokenLimit: base.model.limits.contextTokenLimit + 1,
          },
        },
      }).success,
    ).toBe(false);
    expect(
      agentAdapterAcpConfigurationSchema.safeParse({
        ...base,
        executionTargetSelector: {
          ...base.executionTargetSelector,
          executionTargetDigest: "not-a-digest",
        },
      }).success,
    ).toBe(false);
  });
});
