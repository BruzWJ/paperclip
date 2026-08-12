import type {
  AdapterModel,
  ServerAdapterModule,
} from "@paperclipai/adapter-utils";

export function createDeclarativeTestAdapter(input: {
  type: string;
  label?: string;
  models?: readonly AdapterModel[];
}): ServerAdapterModule {
  const models = input.models ?? [{
    value: `${input.type}-model`,
    label: `${input.type} model`,
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
      runtime: {
        controls: ["session/status", "session/set_config_option"],
      },
      ui: {
        label: input.label ?? input.type,
      },
      configOptions: [{
        id: "model",
        label: "Model",
        type: "select",
        values: options,
        currentValue: options[0]?.value,
      }],
      modelConfigOptionId: "model",
      models,
    },
  };
}
