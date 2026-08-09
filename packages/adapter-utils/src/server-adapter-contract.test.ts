import { describe, expect, it } from "vitest";
import { resolveAcpAdapterRevisionConfiguration } from "./adapter-configuration.js";
import { validateServerAdapterModule } from "./server-adapter-contract.js";
import type { ServerAdapterModule } from "./types.js";

function fixture(): ServerAdapterModule {
  const model = {
    id: "fixture-model",
    label: "Fixture model",
    value: "fixture-model",
    limits: {
      contextTokenLimit: 10_000,
      outputTokenLimit: 2_000,
    },
  } as const;
  return {
    type: "fixture",
    definition: {
      version: "acpx-runtime/v1",
      launchProfile: { registryName: "fixture-agent" },
      environment: {
        cwd: "execution-workspace",
        additionalDirectories: "authorized-workspace-only",
        environmentKeys: [],
      },
      runtime: {
        controls: ["session/status", "session/set_config_option"],
      },
      ui: {
        label: "Fixture",
        description: "Fixture ACP adapter",
      },
      configSchema: {
        fields: [
          {
            key: "model",
            label: "Model",
            type: "select",
            required: true,
            options: [{ label: model.label, value: model.value }],
          },
        ],
      },
      configOptions: [
        {
          id: "model",
          configKey: "model",
          label: "Model",
          required: true,
          values: [{ label: model.label, value: model.value }],
        },
      ],
      modelConfigOptionId: "model",
      models: [model],
      modelProfiles: [],
      configurationDoc: "Authenticate through the target CLI.",
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

  it("derives sorted, nonempty stable ACP config selections and model limits", () => {
    const adapter = fixture();
    const modelField = adapter.definition.configSchema.fields[0]!;
    const modelOption = adapter.definition.configOptions[0]!;
    const resolved = resolveAcpAdapterRevisionConfiguration({
      adapter: {
        ...adapter,
        definition: {
          ...adapter.definition,
          configSchema: {
            fields: [
              modelField,
              {
                key: "enabled",
                label: "Enabled",
                type: "toggle",
                required: true,
              },
            ],
          },
          configOptions: [
            { ...modelOption, id: "a" },
            {
              id: "Z",
              configKey: "enabled",
              label: "Enabled",
              required: true,
              values: [{ label: "Enabled", value: true }],
            },
          ],
          modelConfigOptionId: "a",
        },
      },
      config: { model: "fixture-model", enabled: true },
    });
    expect(resolved).toMatchObject({
      contractVersion: "acpx-runtime/v1",
      sessionConfigSelections: [
        { configId: "Z", value: true },
        { configId: "a", value: "fixture-model" },
      ],
      model: {
        id: "fixture-model",
        limits: {
          contextTokenLimit: 10_000,
          outputTokenLimit: 2_000,
        },
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
