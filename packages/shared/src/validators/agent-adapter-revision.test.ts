import { describe, expect, it } from "vitest";
import { agentAdapterAcpConfigurationSchema } from "./agent-adapter-revision.js";

const ENVIRONMENT_ID = "00000000-0000-4000-8000-000000000001";
const SKILL_VERSION_A = "00000000-0000-4000-8000-000000000002";
const SKILL_VERSION_B = "00000000-0000-4000-8000-000000000003";

function configuration() {
  return {
    contractVersion: "acpx-runtime/v1" as const,
    launchProfile: {
      registryName: "runtime-agent",
    },
    sessionConfigSelections: [
      { configId: "model", value: "runtime-model" },
      { configId: "reasoning_effort", value: "high" },
    ],
    model: {
      id: "runtime-model",
      label: "Runtime model",
      value: "runtime-model",
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

  it("allows a target with no selected model", () => {
    const expected = {
      ...configuration(),
      model: null,
    };
    expect(agentAdapterAcpConfigurationSchema.parse(expected)).toEqual(expected);
  });

  it("preserves explicitly unknown ACP model limits as null", () => {
    const expected = {
      ...configuration(),
      model: {
        ...configuration().model,
        limits: null,
      },
    };
    expect(agentAdapterAcpConfigurationSchema.parse(expected)).toEqual(expected);
    expect(
      agentAdapterAcpConfigurationSchema.safeParse({
        ...expected,
        model: { ...expected.model, limits: undefined },
      }).success,
    ).toBe(false);
  });

  it("allows an empty and requires unique, code-unit-sorted config selections", () => {
    expect(
      agentAdapterAcpConfigurationSchema.safeParse({
        ...configuration(),
        sessionConfigSelections: [],
      }).success,
    ).toBe(true);
    expect(
      agentAdapterAcpConfigurationSchema.safeParse({
        ...configuration(),
        sessionConfigSelections: [
          { configId: "model", value: "runtime-model" },
          { configId: "model", value: "other-runtime-model" },
        ],
      }).success,
    ).toBe(false);
    expect(
      agentAdapterAcpConfigurationSchema.safeParse({
        ...configuration(),
        sessionConfigSelections: [
          { configId: "reasoning_effort", value: "high" },
          { configId: "model", value: "runtime-model" },
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
    const { registryName: _registryName, ...launchWithoutRegistryName } =
      base.launchProfile;
    expect(
      agentAdapterAcpConfigurationSchema.safeParse({
        ...base,
        launchProfile: launchWithoutRegistryName,
      }).success,
    ).toBe(false);
    expect(
      agentAdapterAcpConfigurationSchema.safeParse({
        ...base,
        launchProfile: {
          ...base.launchProfile,
          command: "not-admitted-here",
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
