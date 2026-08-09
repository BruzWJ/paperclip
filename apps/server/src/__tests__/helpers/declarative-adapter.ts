import type {
  AdapterModel,
  AdapterModelProfileDefinition,
  ServerAdapterModule,
} from "@paperclipai/adapter-utils";

export function createDeclarativeTestAdapter(input: {
  type: string;
  label?: string;
  models?: readonly AdapterModel[];
  modelProfiles?: readonly AdapterModelProfileDefinition[];
}): ServerAdapterModule {
  const models = input.models ?? [{
    id: `${input.type}-model`,
    label: `${input.type} model`,
    value: `${input.type}-model`,
    limits: {
      contextTokenLimit: 200_000,
      outputTokenLimit: 16_000,
    },
  }];
  const options = models.map((model) => ({
    label: model.label,
    value: model.value,
  }));
  return {
    type: input.type,
    definition: {
      version: "acpx-runtime/v1",
      // Test fixtures deliberately model only ACPX's public registry name.
      // Paperclip must not inject a provider-specific command, package, or
      // model catalog into declarative adapter definitions.
      launchProfile: { registryName: input.type },
      environment: {
        cwd: "execution-workspace",
        additionalDirectories: "authorized-workspace-only",
        environmentKeys: [],
      },
      runtime: {
        controls: ["session/status", "session/set_config_option"],
      },
      ui: {
        label: input.label ?? input.type,
        description: `${input.type} declarative ACP test adapter`,
      },
      configSchema: {
        fields: [{
          key: "model",
          label: "Model",
          type: "select",
          required: true,
          options,
        }],
      },
      configOptions: [{
        id: "model",
        configKey: "model",
        label: "Model",
        required: true,
        values: options,
      }],
      modelConfigOptionId: "model",
      models,
      modelProfiles: input.modelProfiles ?? [],
      configurationDoc: "Authenticate through the target CLI.",
    },
  };
}
