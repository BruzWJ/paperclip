import { validateAdapterConfigSchema } from "./config-schema-validation.js";
import { validateAdapterModel } from "./adapter-model.js";
import type {
  AcpAdapterConfigOption,
  AcpAdapterConfigValue,
  ServerAdapterModule,
} from "./types.js";
import type { AcpSessionConfigValue } from "./acpx-runtime/contract.js";

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
  allowed: readonly string[],
  label: string,
  optional: readonly string[] = [],
): void {
  const allowedSet = new Set([...allowed, ...optional]);
  const unknown = Object.keys(value).find((key) => !allowedSet.has(key));
  const missing = allowed.find(
    (key) => !Object.prototype.hasOwnProperty.call(value, key),
  );
  if (unknown) throw new Error(`${label} contains unknown field ${unknown}`);
  if (missing) throw new Error(`${label} is missing required field ${missing}`);
}

function configValueKey(value: AcpSessionConfigValue): string {
  return `${typeof value}:${String(value)}`;
}

function parseConfigValue(value: unknown, label: string): AcpAdapterConfigValue {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  exactKeys(value, ["value", "label"], label);
  if (typeof value.value !== "string" && typeof value.value !== "boolean") {
    throw new Error(`${label}.value must be a string or boolean`);
  }
  if (typeof value.value === "string") {
    exactString(value.value, `${label}.value`);
  }
  return {
    value: value.value,
    label: exactString(value.label, `${label}.label`),
  };
}

function parseConfigOption(value: unknown, index: number): AcpAdapterConfigOption {
  const label = `ACP config option at index ${index}`;
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  exactKeys(
    value,
    ["id", "configKey", "label", "required", "values"],
    label,
    ["freeform"],
  );
  if (value.required !== true) {
    throw new Error(`${label}.required must be true`);
  }
  if (value.freeform !== undefined && value.freeform !== true) {
    throw new Error(`${label}.freeform must be true when present`);
  }
  const freeform = value.freeform === true;
  if (!Array.isArray(value.values) || (!freeform && value.values.length === 0)) {
    throw new Error(
      `${label}.values must be non-empty unless the ACPX option is freeform`,
    );
  }
  if (freeform && value.values.length !== 0) {
    throw new Error(`${label}.freeform must not declare closed values`);
  }
  const values = value.values.map((entry, valueIndex) =>
    parseConfigValue(entry, `${label}.values[${valueIndex}]`),
  );
  const keys = values.map((entry) => configValueKey(entry.value));
  if (new Set(keys).size !== keys.length) {
    throw new Error(`${label}.values contains a duplicate value`);
  }
  return {
    id: exactString(value.id, `${label}.id`),
    configKey: exactString(value.configKey, `${label}.configKey`),
    label: exactString(value.label, `${label}.label`),
    required: true,
    values,
    ...(freeform ? { freeform: true as const } : {}),
  };
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
      "environment",
      "runtime",
      "ui",
      "configSchema",
      "configOptions",
      "modelConfigOptionId",
      "models",
      "modelProfiles",
      "configurationDoc",
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
  const launch = definition.launchProfile;
  exactKeys(
    launch,
    ["registryName"],
    `Server adapter "${type}" launchProfile`,
  );
  exactString(
    launch.registryName,
    `Server adapter "${type}" launchProfile.registryName`,
  );

  if (!isRecord(definition.environment)) {
    throw new Error(`Server adapter "${type}" environment must be an object`);
  }
  const environment = definition.environment;
  exactKeys(
    environment,
    ["cwd", "additionalDirectories", "environmentKeys"],
    `Server adapter "${type}" environment`,
  );
  if (
    environment.cwd !== "execution-workspace" ||
    environment.additionalDirectories !== "authorized-workspace-only"
  ) {
    throw new Error(
      `Server adapter "${type}" must use the execution workspace boundary`,
    );
  }
  if (
    !Array.isArray(environment.environmentKeys) ||
    environment.environmentKeys.some(
      (key) =>
        typeof key !== "string" ||
        key.length === 0 ||
        key !== key.trim() ||
        /^PAPERCLIP_/i.test(key),
    ) ||
    new Set(environment.environmentKeys).size !== environment.environmentKeys.length
  ) {
    throw new Error(
      `Server adapter "${type}" declares invalid non-secret environment requirements`,
    );
  }

  if (!isRecord(definition.runtime)) {
    throw new Error(`Server adapter "${type}" runtime must be an object`);
  }
  const runtime = definition.runtime;
  exactKeys(
    runtime,
    ["controls"],
    `Server adapter "${type}" runtime`,
  );
  if (
    !Array.isArray(runtime.controls) ||
    runtime.controls.some(
      (control) =>
        typeof control !== "string" ||
        control.length === 0 ||
        control !== control.trim(),
    ) ||
    new Set(runtime.controls).size !== runtime.controls.length
  ) {
    throw new Error(
      `Server adapter "${type}" declares invalid ACPX runtime controls`,
    );
  }

  if (!isRecord(definition.ui)) {
    throw new Error(`Server adapter "${type}" ui metadata must be an object`);
  }
  const ui = definition.ui;
  const allowedUiKeys = ["label", "description", "recommended"];
  const unknownUi = Object.keys(ui).find((key) => !allowedUiKeys.includes(key));
  if (unknownUi) {
    throw new Error(`Server adapter "${type}" ui contains unknown field ${unknownUi}`);
  }
  exactString(ui.label, `Server adapter "${type}" ui.label`);
  exactString(ui.description, `Server adapter "${type}" ui.description`);
  if (ui.recommended !== undefined && typeof ui.recommended !== "boolean") {
    throw new Error(`Server adapter "${type}" ui.recommended must be boolean`);
  }

  const parsedSchema = validateAdapterConfigSchema(definition.configSchema);
  if (!parsedSchema.success) {
    throw new Error(
      `Server adapter "${type}" configSchema is invalid: ${parsedSchema.errors.join("; ")}`,
    );
  }
  if (!Array.isArray(definition.configOptions)) {
    throw new Error(`Server adapter "${type}" configOptions must be an array`);
  }
  const configOptions = definition.configOptions.map(parseConfigOption);
  const optionIds = configOptions.map((option) => option.id);
  const configKeys = configOptions.map((option) => option.configKey);
  if (new Set(optionIds).size !== optionIds.length) {
    throw new Error(`Server adapter "${type}" configOptions contain duplicate ids`);
  }
  if (new Set(configKeys).size !== configKeys.length) {
    throw new Error(`Server adapter "${type}" configOptions contain duplicate config keys`);
  }
  const schemaKeys = parsedSchema.data.fields.map((field) => field.key);
  if (
    schemaKeys.length !== configKeys.length ||
    schemaKeys.some((key) => !configKeys.includes(key))
  ) {
    throw new Error(
      `Server adapter "${type}" configSchema must expose exactly its ACP config option keys`,
    );
  }

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
  if (
    new Set(models.map((model) => model.id)).size !== models.length ||
    new Set(models.map((model) => model.value)).size !== models.length
  ) {
    throw new Error(`Server adapter "${type}" models contain duplicate ids or values`);
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
    if (!modelOption) {
      throw new Error(
        `Server adapter "${type}" modelConfigOptionId is not declared`,
      );
    }
    const allowedModelValues = new Set(
      modelOption.values
        .filter((entry) => typeof entry.value === "string")
        .map((entry) => entry.value),
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

  if (!Array.isArray(definition.modelProfiles)) {
    throw new Error(`Server adapter "${type}" modelProfiles must be an array`);
  }
  const profileKeys = new Set<string>();
  for (const [index, profileValue] of definition.modelProfiles.entries()) {
    const label = `Server adapter "${type}" modelProfiles[${index}]`;
    if (!isRecord(profileValue)) throw new Error(`${label} must be an object`);
    const allowed = new Set(["key", "label", "description", "modelId"]);
    const unknown = Object.keys(profileValue).find((key) => !allowed.has(key));
    if (unknown) throw new Error(`${label} contains unknown field ${unknown}`);
    if (profileValue.key !== "cheap" || profileKeys.has(profileValue.key)) {
      throw new Error(`${label}.key must be the unique supported profile key`);
    }
    profileKeys.add(profileValue.key);
    exactString(profileValue.label, `${label}.label`);
    if (profileValue.description !== undefined) {
      exactString(profileValue.description, `${label}.description`);
    }
    const modelId = exactString(profileValue.modelId, `${label}.modelId`);
    if (!models.some((model) => model.id === modelId)) {
      throw new Error(`${label}.modelId is not in the adapter model catalog`);
    }
  }
  exactString(
    definition.configurationDoc,
    `Server adapter "${type}" configurationDoc`,
  );
}

/** Validate the one closed declarative ACP adapter ABI without defaults. */
export function validateServerAdapterModule(value: unknown): ServerAdapterModule {
  assertServerAdapterModule(value);
  return value;
}
