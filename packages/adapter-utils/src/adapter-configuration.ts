import { requireAdapterModel } from "./adapter-model.js";
import { validateServerAdapterModule } from "./server-adapter-contract.js";
import type {
  AcpAdapterRevisionConfiguration,
  ServerAdapterModule,
} from "./types.js";
import type { AcpSessionConfigValue } from "./acpx-runtime/contract.js";

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
    definition.configOptions.map((option) => option.id),
  );
  const unknown = Object.keys(input.config).find((key) => !expectedKeys.has(key));
  if (unknown) {
    throw new Error(
      `Adapter ${adapter.type} configuration contains unknown field ${unknown}`,
    );
  }

  const selections = definition.configOptions
    .map((option) => {
      const value = input.config[option.id];
      if (!exactConfigValue(value)) {
        throw new Error(
          `Adapter ${adapter.type} requires exact ACP config value ${option.id}`,
        );
      }
      if (option.type === "toggle" && typeof value !== "boolean") {
        throw new Error(
          `Adapter ${adapter.type} ACP config value ${option.id} must be a boolean`,
        );
      }
      if (option.type !== "toggle" && typeof value !== "string") {
        throw new Error(
          `Adapter ${adapter.type} ACP config value ${option.id} must be a string`,
        );
      }
      if (option.type === "select") {
        const legal = new Set(
          option.values.map((entry) => valueKey(entry.value)),
        );
        if (!legal.has(valueKey(value))) {
          throw new Error(
            `Adapter ${adapter.type} ACP config value ${option.id} is not declared`,
          );
        }
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

  const model =
    definition.modelConfigOptionId === null
      ? definition.models[0] ?? null
      : (() => {
          const modelOption = definition.configOptions.find(
            (option) => option.id === definition.modelConfigOptionId,
          );
          if (!modelOption) {
            throw new Error(`Adapter ${adapter.type} has no model config option`);
          }
          const modelValue = input.config[modelOption.id];
          return requireAdapterModel({
            adapterType: adapter.type,
            selection: modelValue,
            models: definition.models,
          });
        })();

  return Object.freeze({
    contractVersion: definition.version,
    launchProfile: definition.launchProfile,
    sessionConfigSelections: Object.freeze(selections),
    model:
      model === null
        ? null
        : Object.freeze({ ...model }),
  });
}
