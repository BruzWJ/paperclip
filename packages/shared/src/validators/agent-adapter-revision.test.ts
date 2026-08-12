import { describe, expect, it } from "vitest";
import {
  agentAdapterAcpConfigurationSchema,
} from "./agent-adapter-revision.js";

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
      value: "runtime-model",
      label: "Runtime model",
    },
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

  it("rejects retired model limit metadata", () => {
    expect(
      agentAdapterAcpConfigurationSchema.safeParse({
        ...configuration(),
        model: { ...configuration().model, limits: null },
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

  it("rejects aliases and extra fields", () => {
    const base = configuration();
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
    expect(
      agentAdapterAcpConfigurationSchema.safeParse({
        ...base,
        model: {
          ...base.model,
          id: base.model.value,
        },
      }).success,
    ).toBe(false);
  });

});
