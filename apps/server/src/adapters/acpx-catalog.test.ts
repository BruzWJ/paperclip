import {
  resolveAcpAdapterRevisionConfiguration,
  validateServerAdapterModule,
} from "@paperclipai/adapter-utils";
import type { AcpxAgentDiscovery } from "@paperclipai/adapter-utils/acp-subprocess";
import { describe, expect, it } from "vitest";
import { acpxDiscoveryToServerAdapter } from "./acpx-catalog.js";

const discovery: AcpxAgentDiscovery = Object.freeze({
  agentName: "fixture-agent",
  controls: Object.freeze(["session/status", "session/set_config_option"]),
  configOptionKeys: Object.freeze(["model", "reasoning_effort"]),
  models: Object.freeze(["fixture-model", "alternate-model"]),
  currentModelId: "fixture-model",
  configOptions: Object.freeze([
    Object.freeze({
      id: "model",
      name: "Model",
      type: "select",
      currentValue: "fixture-model",
      options: Object.freeze([
        Object.freeze({
          kind: "value" as const,
          name: "Fixture model",
          value: "fixture-model",
        }),
        Object.freeze({
          kind: "value" as const,
          name: "Alternate model",
          value: "alternate-model",
        }),
      ]),
    }),
    Object.freeze({
      id: "reasoning_effort",
      name: "Reasoning effort",
      type: "select",
      currentValue: "high",
      options: Object.freeze([
        Object.freeze({ kind: "value" as const, name: "Low", value: "low" }),
        Object.freeze({ kind: "value" as const, name: "High", value: "high" }),
      ]),
    }),
  ]),
});

describe("ACPX adapter catalog conversion", () => {
  it("copies the ACPX agent name, selectable options, and models without provider assumptions", () => {
    const adapter = validateServerAdapterModule(
      acpxDiscoveryToServerAdapter(discovery),
    );

    expect(adapter).toMatchObject({
      type: "fixture-agent",
      definition: {
        launchProfile: { registryName: "fixture-agent" },
        modelConfigOptionId: "model",
        models: [
          { id: "fixture-model", value: "fixture-model", limits: null },
          { id: "alternate-model", value: "alternate-model", limits: null },
        ],
      },
    });
    expect(adapter.definition.configSchema.fields.map((field) => field.key)).toEqual([
      "model",
      "reasoning_effort",
    ]);
  });

  it("persists every ACPX config selection, including reasoning effort", () => {
    const adapter = acpxDiscoveryToServerAdapter(discovery);
    const resolved = resolveAcpAdapterRevisionConfiguration({
      adapter,
      config: { model: "fixture-model", reasoning_effort: "high" },
    });

    expect(resolved).toEqual({
      contractVersion: "acpx-runtime/v1",
      launchProfile: { registryName: "fixture-agent" },
      sessionConfigSelections: [
        { configId: "model", value: "fixture-model" },
        { configId: "reasoning_effort", value: "high" },
      ],
      model: {
        id: "fixture-model",
        label: "Fixture model",
        value: "fixture-model",
        limits: null,
      },
    });
  });

  it("uses ACPX's model category when status and option values are not identical", () => {
    const categorisedDiscovery: AcpxAgentDiscovery = {
      ...discovery,
      models: ["status-only-model"],
      configOptions: discovery.configOptions.map((option) =>
        option.id === "model" ? { ...option, category: "model" } : option,
      ),
    };

    const adapter = acpxDiscoveryToServerAdapter(categorisedDiscovery);

    expect(adapter.definition.modelConfigOptionId).toBe("model");
    expect(adapter.definition.models.map((model) => model.value)).toEqual([
      "fixture-model",
      "alternate-model",
    ]);
  });

  it("preserves an ACPX string setting with no declared choices as generic freeform configuration", () => {
    const adapter = validateServerAdapterModule(
      acpxDiscoveryToServerAdapter({
        ...discovery,
        configOptions: [
          ...discovery.configOptions,
          {
            id: "runtime_hint",
            name: "Runtime hint",
            type: "future_string_type",
            currentValue: "balanced",
            description: "Supplied by a newer ACPX adapter.",
            options: [],
          },
        ],
      }),
    );

    expect(adapter.definition.configSchema.fields.at(-1)).toMatchObject({
      key: "runtime_hint",
      type: "text",
      default: "balanced",
    });
    expect(adapter.definition.configOptions.at(-1)).toEqual({
      id: "runtime_hint",
      configKey: "runtime_hint",
      label: "Runtime hint",
      required: true,
      values: [],
      freeform: true,
    });
    expect(
      resolveAcpAdapterRevisionConfiguration({
        adapter,
        config: {
          model: "fixture-model",
          reasoning_effort: "high",
          runtime_hint: "custom-value",
        },
      }).sessionConfigSelections,
    ).toContainEqual({ configId: "runtime_hint", value: "custom-value" });
  });
});
