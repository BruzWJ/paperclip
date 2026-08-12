import { describe, expect, it } from "vitest";
import { resolveAcpAdapterRevisionConfiguration } from "./adapter-configuration.js";
import { validateServerAdapterModule } from "./server-adapter-contract.js";
import type { ServerAdapterModule } from "./types.js";

function fixture(): ServerAdapterModule {
  const model = {
    value: "fixture-model",
    label: "Fixture model",
  } as const;
  return {
    type: "fixture",
    definition: {
      version: "acpx-runtime/v1",
      launchProfile: { registryName: "fixture" },
      runtime: {
        controls: ["session/status", "session/set_config_option"],
      },
      ui: {
        label: "Fixture",
      },
      configOptions: [
        {
          id: "model",
          label: "Model",
          type: "select",
          values: [{ label: model.label, value: model.value }],
          currentValue: model.value,
        },
      ],
      modelConfigOptionId: "model",
      models: [model],
    },
  };
}

describe("declarative ACP adapter contract", () => {
  it("accepts only the closed acpx-runtime/v1 shape", () => {
    const adapter = fixture();
    expect(validateServerAdapterModule(adapter)).toBe(adapter);
    expect(() =>
      validateServerAdapterModule({ ...adapter, execute: () => undefined }),
    ).toThrow(/unknown field execute/);
    expect(() =>
      validateServerAdapterModule({
        ...adapter,
        providerInputKind: "native-turn",
      }),
    ).toThrow(/unknown field providerInputKind/);
  });

  it("keeps the persisted launch profile to an exact ACPX registry name", () => {
    const adapter = fixture();
    expect(() =>
      validateServerAdapterModule({
        ...adapter,
        definition: {
          ...adapter.definition,
          launchProfile: {
            ...adapter.definition.launchProfile,
            registryName: " Codex",
          },
        },
      }),
    ).toThrow(/registryName must be an exact non-empty string/);
    expect(() =>
      validateServerAdapterModule({
        ...adapter,
        definition: {
          ...adapter.definition,
          launchProfile: {
            ...adapter.definition.launchProfile,
            command: "npx",
          },
        },
      }),
    ).toThrow(/unknown field command/);
  });

  it("derives sorted, nonempty stable ACP config selections and model", () => {
    const adapter = fixture();
    const modelOption = adapter.definition.configOptions[0]!;
    const resolved = resolveAcpAdapterRevisionConfiguration({
      adapter: {
        ...adapter,
        definition: {
          ...adapter.definition,
          configOptions: [
            { ...modelOption, id: "a" },
            {
              id: "Z",
              label: "Enabled",
              type: "toggle",
              currentValue: true,
            },
          ],
          modelConfigOptionId: "a",
        },
      },
      config: { Z: true, a: "fixture-model" },
    });
    expect(resolved).toMatchObject({
      contractVersion: "acpx-runtime/v1",
      sessionConfigSelections: [
        { configId: "Z", value: true },
        { configId: "a", value: "fixture-model" },
      ],
      model: {
        value: "fixture-model",
      },
    });
  });

  it("rejects implicit, unknown, and illegal config values", () => {
    const adapter = fixture();
    expect(() =>
      resolveAcpAdapterRevisionConfiguration({ adapter, config: {} }),
    ).toThrow(/requires exact ACP config value model/);
    expect(() =>
      resolveAcpAdapterRevisionConfiguration({
        adapter,
        config: { model: "fixture-model", command: "codex" },
      }),
    ).toThrow(/unknown field command/);
    expect(() =>
      resolveAcpAdapterRevisionConfiguration({
        adapter,
        config: { model: "other" },
      }),
    ).toThrow(/is not declared/);
  });
});
