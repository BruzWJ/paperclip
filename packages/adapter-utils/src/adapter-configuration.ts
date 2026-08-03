import { requireAdapterCatalogModel } from "./adapter-model.js";
import { validateServerAdapterModule } from "./server-adapter-contract.js";
import type {
  AcpAdapterRevisionConfiguration,
  ServerAdapterModule,
} from "./types.js";
import type { AcpSessionConfigValue } from "./acp-subprocess/contract.js";

function exactConfigValue(value: unknown): value is AcpSessionConfigValue {
  return (
    typeof value === "boolean" ||
    (typeof value === "string" && value.length > 0 && value === value.trim())
  );
}

function valueKey(value: AcpSessionConfigValue): string {
  return `${typeof value}:${String(value)}`;
}

/**
 * Resolve one schema-valid operator configuration into the immutable ACP
 * launch/config/model portion of an adapter revision. No executable runs and
 * no provider or CLI credential is inspected here.
 */
export function resolveAcpAdapterRevisionConfiguration(input: {
  adapter: ServerAdapterModule;
  config: Readonly<Record<string, unknown>>;
}): AcpAdapterRevisionConfiguration {
  const adapter = validateServerAdapterModule(input.adapter);
  const definition = adapter.definition;
  const expectedKeys = new Set(
    definition.configOptions.map((option) => option.configKey),
  );
  const unknown = Object.keys(input.config).find((key) => !expectedKeys.has(key));
  if (unknown) {
    throw new Error(
      `Adapter ${adapter.type} configuration contains unknown field ${unknown}`,
    );
  }

  const selections = definition.configOptions
    .map((option) => {
      const value = input.config[option.configKey];
      if (!exactConfigValue(value)) {
        throw new Error(
          `Adapter ${adapter.type} requires exact ACP config value ${option.configKey}`,
        );
      }
      const legal = new Set(option.values.map((entry) => valueKey(entry.value)));
      if (!legal.has(valueKey(value))) {
        throw new Error(
          `Adapter ${adapter.type} ACP config value ${option.configKey} is not declared`,
        );
      }
      return Object.freeze({ configId: option.id, value });
    })
    .sort((left, right) =>
      left.configId < right.configId
        ? -1
        : left.configId > right.configId
          ? 1
          : 0,
    );

  const modelOption = definition.configOptions.find(
    (option) => option.id === definition.modelConfigOptionId,
  );
  if (!modelOption) {
    throw new Error(`Adapter ${adapter.type} has no model config option`);
  }
  const modelValue = input.config[modelOption.configKey];
  const model = requireAdapterCatalogModel({
    adapterType: adapter.type,
    selection: definition.models.find((entry) => entry.value === modelValue)?.id,
    models: definition.models,
  });

  return Object.freeze({
    contractVersion: definition.version,
    launchProfile: definition.launchProfile,
    sessionConfigSelections: Object.freeze(selections),
    model: Object.freeze({
      ...model,
      limits: Object.freeze({ ...model.limits }),
    }),
  });
}
