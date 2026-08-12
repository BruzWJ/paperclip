import { validateAdapterModel } from "./adapter-model.js";
import type {
  AcpAdapterConfigOption,
  AcpAdapterSelectValue,
  ServerAdapterModule,
} from "./types.js";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactString(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim()
  ) {
    throw new Error(`${label} must be an exact non-empty string`);
  }
  return value;
}

function exactKeys(
  value: JsonRecord,
  required: readonly string[],
  label: string,
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  const missing = required.find(
    (key) => !Object.prototype.hasOwnProperty.call(value, key),
  );
  if (unknown) throw new Error(`${label} contains unknown field ${unknown}`);
  if (missing) throw new Error(`${label} is missing required field ${missing}`);
}

function parseSelectValue(value: unknown, label: string): AcpAdapterSelectValue {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  exactKeys(value, ["value", "label"], label);
  return {
    value: exactString(value.value, `${label}.value`),
    label: exactString(value.label, `${label}.label`),
  };
}

function parseConfigOption(value: unknown, index: number): AcpAdapterConfigOption {
  const label = `ACPX config option at index ${index}`;
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const type = exactString(value.type, `${label}.type`);
  const description =
    value.description === undefined
      ? undefined
      : exactString(value.description, `${label}.description`);
  const base = {
    id: exactString(value.id, `${label}.id`),
    label: exactString(value.label, `${label}.label`),
    ...(description === undefined ? {} : { description }),
  };

  if (type === "text") {
    exactKeys(value, ["id", "label", "type"], label, ["description", "currentValue"]);
    const currentValue =
      value.currentValue === undefined
        ? undefined
        : exactString(value.currentValue, `${label}.currentValue`);
    return {
      ...base,
      type,
      ...(currentValue === undefined ? {} : { currentValue }),
    };
  }
  if (type === "toggle") {
    exactKeys(value, ["id", "label", "type", "currentValue"], label, ["description"]);
    if (typeof value.currentValue !== "boolean") {
      throw new Error(`${label}.currentValue must be a boolean`);
    }
    return { ...base, type, currentValue: value.currentValue };
  }
  if (type === "select") {
    exactKeys(value, ["id", "label", "type", "values"], label, ["description", "currentValue"]);
    if (!Array.isArray(value.values) || value.values.length === 0) {
      throw new Error(`${label}.values must be a non-empty array`);
    }
    const values = value.values.map((entry, valueIndex) =>
      parseSelectValue(entry, `${label}.values[${valueIndex}]`),
    );
    if (new Set(values.map((entry) => entry.value)).size !== values.length) {
      throw new Error(`${label}.values contains a duplicate value`);
    }
    const currentValue =
      value.currentValue === undefined
        ? undefined
        : exactString(value.currentValue, `${label}.currentValue`);
    if (
      currentValue !== undefined &&
      !values.some((entry) => entry.value === currentValue)
    ) {
      throw new Error(`${label}.currentValue is not one of its declared values`);
    }
    return {
      ...base,
      type,
      values,
      ...(currentValue === undefined ? {} : { currentValue }),
    };
  }
  throw new Error(`${label}.type must be text, select, or toggle`);
}

/** Validate the exact native ACPX option array at an API boundary. */
export function validateAcpAdapterConfigOptions(
  value: unknown,
): readonly AcpAdapterConfigOption[] {
  if (!Array.isArray(value)) {
    throw new Error("ACPX config options must be an array");
  }
  const options = value.map(parseConfigOption);
  const ids = options.map((option) => option.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error("ACPX config options contain duplicate ids");
  }
  return options;
}

function assertServerAdapterModule(
  value: unknown,
): asserts value is ServerAdapterModule {
  if (!isRecord(value)) {
    throw new Error("Server adapter module must be an object");
  }
  exactKeys(value, ["type", "definition"], "Server adapter module");
  const type = exactString(value.type, "Server adapter module type");
  if (!isRecord(value.definition)) {
    throw new Error(`Server adapter "${type}" definition must be an object`);
  }
  const definition = value.definition;
  exactKeys(
    definition,
    [
      "version",
      "launchProfile",
      "runtime",
      "ui",
      "configOptions",
      "modelConfigOptionId",
      "models",
    ],
    `Server adapter "${type}" definition`,
  );
  if (definition.version !== "acpx-runtime/v1") {
    throw new Error(
      `Server adapter "${type}" must use definition version acpx-runtime/v1`,
    );
  }

  if (!isRecord(definition.launchProfile)) {
    throw new Error(`Server adapter "${type}" launchProfile must be an object`);
  }
  exactKeys(
    definition.launchProfile,
    ["registryName"],
    `Server adapter "${type}" launchProfile`,
  );
  const registryName = exactString(
    definition.launchProfile.registryName,
    `Server adapter "${type}" launchProfile.registryName`,
  );
  if (registryName !== type) {
    throw new Error(
      `Server adapter "${type}" launchProfile.registryName must exactly match its type`,
    );
  }

  if (!isRecord(definition.runtime)) {
    throw new Error(`Server adapter "${type}" runtime must be an object`);
  }
  exactKeys(definition.runtime, ["controls"], `Server adapter "${type}" runtime`);
  if (
    !Array.isArray(definition.runtime.controls) ||
    definition.runtime.controls.some(
      (control) =>
        typeof control !== "string" ||
        control.length === 0 ||
        control !== control.trim(),
    ) ||
    new Set(definition.runtime.controls).size !== definition.runtime.controls.length
  ) {
    throw new Error(
      `Server adapter "${type}" declares invalid ACPX runtime controls`,
    );
  }

  if (!isRecord(definition.ui)) {
    throw new Error(`Server adapter "${type}" ui metadata must be an object`);
  }
  exactKeys(definition.ui, ["label"], `Server adapter "${type}" ui`);
  exactString(definition.ui.label, `Server adapter "${type}" ui.label`);

  if (!Array.isArray(definition.configOptions)) {
    throw new Error(`Server adapter "${type}" configOptions must be an array`);
  }
  const configOptions = validateAcpAdapterConfigOptions(
    definition.configOptions,
  );

  if (
    definition.modelConfigOptionId !== null &&
    (typeof definition.modelConfigOptionId !== "string" ||
      definition.modelConfigOptionId.length === 0 ||
      definition.modelConfigOptionId !== definition.modelConfigOptionId.trim())
  ) {
    throw new Error(
      `Server adapter "${type}" modelConfigOptionId must be null or an exact declared option id`,
    );
  }
  if (!Array.isArray(definition.models)) {
    throw new Error(`Server adapter "${type}" models must be an array`);
  }
  const models = definition.models.map(validateAdapterModel);
  if (new Set(models.map((model) => model.value)).size !== models.length) {
    throw new Error(`Server adapter "${type}" models contain duplicate values`);
  }
  if (definition.modelConfigOptionId === null) {
    if (models.length > 1) {
      throw new Error(
        `Server adapter "${type}" cannot declare multiple models without an ACPX model option`,
      );
    }
  } else {
    const modelOption = configOptions.find(
      (option) => option.id === definition.modelConfigOptionId,
    );
    if (!modelOption || modelOption.type !== "select") {
      throw new Error(
        `Server adapter "${type}" modelConfigOptionId must name a select option`,
      );
    }
    const allowedModelValues = new Set(
      modelOption.values.map((entry) => entry.value),
    );
    if (
      allowedModelValues.size !== models.length ||
      models.some((model) => !allowedModelValues.has(model.value))
    ) {
      throw new Error(
        `Server adapter "${type}" model values must exactly match its model config option`,
      );
    }
  }
}

/** Validate the one closed declarative ACPX adapter contract without defaults. */
export function validateServerAdapterModule(value: unknown): ServerAdapterModule {
  assertServerAdapterModule(value);
  return value;
}
