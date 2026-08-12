import {
  resolveAcpAdapterRevisionConfiguration,
  validateServerAdapterModule,
} from "@paperclipai/adapter-utils";
import type { AcpxAgentDiscovery } from "@paperclipai/adapter-utils/acpx-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  acpxDiscoveryToServerAdapter,
  discoverLocalAcpxAdapterCatalog,
} from "./acpx-catalog.js";

const acpxMocks = vi.hoisted(() => ({
  listAgentNames: vi.fn(),
  probeAgent: vi.fn(),
}));

vi.mock("@paperclipai/adapter-utils/acpx-runtime", async (importOriginal) => ({
  ...await importOriginal<
    typeof import("@paperclipai/adapter-utils/acpx-runtime")
  >(),
  listAcpxAgentNames: acpxMocks.listAgentNames,
  probeAcpxAgent: acpxMocks.probeAgent,
}));

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
      category: "model",
      currentValue: "fixture-model",
      options: Object.freeze([
        Object.freeze({
          name: "Fixture model",
          value: "fixture-model",
        }),
        Object.freeze({
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
        Object.freeze({ name: "Low", value: "low" }),
        Object.freeze({ name: "High", value: "high" }),
      ]),
    }),
  ]),
});

beforeEach(() => {
  acpxMocks.listAgentNames.mockReset();
  acpxMocks.probeAgent.mockReset();
});

describe("ACPX adapter catalog conversion", () => {
  it("probes only the locally available names returned by ACPX", async () => {
    acpxMocks.listAgentNames.mockResolvedValue(["fixture"]);
    acpxMocks.probeAgent.mockResolvedValue({
      ...discovery,
      agentName: "fixture",
    });

    const snapshot = await discoverLocalAcpxAdapterCatalog(process.cwd());

    expect(snapshot.adapters.map((adapter) => adapter.type)).toEqual([
      "fixture",
    ]);
    expect(snapshot.unavailable).toEqual({});
    expect(acpxMocks.probeAgent).toHaveBeenCalledWith({
      cwd: process.cwd(),
      agentName: "fixture",
    });
  });

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
          { value: "fixture-model" },
          { value: "alternate-model" },
        ],
      },
    });
    expect(adapter.definition.configOptions.map((option) => option.id)).toEqual([
      "model",
      "reasoning_effort",
    ]);
  });

  it("quarantines an invalid ACPX projection at the catalog boundary", async () => {
    acpxMocks.listAgentNames.mockResolvedValue([" invalid-agent "]);
    acpxMocks.probeAgent.mockResolvedValue({
      ...discovery,
      agentName: " invalid-agent ",
    });

    const snapshot = await discoverLocalAcpxAdapterCatalog(process.cwd());

    expect(snapshot.adapters).toEqual([]);
    expect(snapshot.unavailable[" invalid-agent "]).toMatchObject({
      code: "acpx_catalog_invalid",
    });
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
        value: "fixture-model",
        label: "Fixture model",
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

  it("preserves ACPX's fixed current model without inventing a selectable setting", () => {
    const adapter = validateServerAdapterModule(
      acpxDiscoveryToServerAdapter({
        agentName: "fixed-model-agent",
        controls: ["session/status"],
        configOptionKeys: [],
        models: ["fixed-model"],
        currentModelId: "fixed-model",
        configOptions: [],
      }),
    );

    expect(adapter.definition.modelConfigOptionId).toBeNull();
    expect(adapter.definition.configOptions).toEqual([]);
    expect(adapter.definition.models).toEqual([
      {
        value: "fixed-model",
        label: "fixed-model",
      },
    ]);
    expect(
      resolveAcpAdapterRevisionConfiguration({ adapter, config: {} }),
    ).toMatchObject({
      sessionConfigSelections: [],
      model: { value: "fixed-model" },
    });
  });

  it("preserves an ACPX text setting as one native text option", () => {
    const adapter = validateServerAdapterModule(
      acpxDiscoveryToServerAdapter({
        ...discovery,
        configOptions: [
          ...discovery.configOptions,
          {
            id: "runtime_hint",
            name: "Runtime hint",
            type: "text",
            currentValue: "balanced",
            description: "Supplied by a newer ACPX adapter.",
          },
        ],
      }),
    );

    expect(adapter.definition.configOptions.at(-1)).toEqual({
      id: "runtime_hint",
      label: "Runtime hint",
      type: "text",
      currentValue: "balanced",
      description: "Supplied by a newer ACPX adapter.",
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
