import { validateAdapterConfigSchema } from "./config-schema-validation.js";
import { validateAdapterModel } from "./adapter-model.js";
import type {
  AcpAdapterConfigOption,
  AcpAdapterConfigValue,
  ServerAdapterModule,
} from "./types.js";
import type { AcpSessionConfigValue } from "./acp-subprocess/contract.js";

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
): void {
  const allowedSet = new Set(allowed);
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
  exactKeys(value, ["id", "configKey", "label", "required", "values"], label);
  if (value.required !== true) {
    throw new Error(`${label}.required must be true`);
  }
  if (!Array.isArray(value.values) || value.values.length === 0) {
    throw new Error(`${label}.values must be a non-empty array`);
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
      "readiness",
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
  if (definition.version !== "acp-subprocess/v1") {
    throw new Error(
      `Server adapter "${type}" must use definition version acp-subprocess/v1`,
    );
  }

  if (!isRecord(definition.launchProfile)) {
    throw new Error(`Server adapter "${type}" launchProfile must be an object`);
  }
  const launch = definition.launchProfile;
  exactKeys(
    launch,
    [
      "registryName",
      "targetNativeCli",
      "command",
      "args",
      "frontendPackage",
      "frontendVersion",
      "frontendDigest",
    ],
    `Server adapter "${type}" launchProfile`,
  );
  exactString(
    launch.registryName,
    `Server adapter "${type}" launchProfile.registryName`,
  );
  exactString(
    launch.targetNativeCli,
    `Server adapter "${type}" launchProfile.targetNativeCli`,
  );
  if (
    typeof launch.command !== "string" ||
    launch.command.length === 0 ||
    launch.command !== launch.command.trim() ||
    !Array.isArray(launch.args) ||
    launch.args.some(
      (entry) =>
        typeof entry !== "string" ||
        entry.length === 0 ||
        entry !== entry.trim(),
    )
  ) {
    throw new Error(
      `Server adapter "${type}" launchProfile contains invalid command argv`,
    );
  }
  exactString(
    launch.frontendPackage,
    `Server adapter "${type}" launchProfile.frontendPackage`,
  );
  exactString(
    launch.frontendVersion,
    `Server adapter "${type}" launchProfile.frontendVersion`,
  );
  if (
    typeof launch.frontendDigest !== "string" ||
    !/^[0-9a-f]{64}$/.test(launch.frontendDigest)
  ) {
    throw new Error(
      `Server adapter "${type}" launchProfile.frontendDigest must be a lowercase SHA-256 digest`,
    );
  }

  if (!isRecord(definition.environment)) {
    throw new Error(`Server adapter "${type}" environment must be an object`);
  }
  const environment = definition.environment;
  exactKeys(
    environment,
    ["cwd", "additionalDirectories", "drivers", "environmentKeys"],
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
  const allowedDrivers = new Set(["local", "ssh", "sandbox", "plugin"]);
  if (
    !Array.isArray(environment.drivers) ||
    environment.drivers.length === 0 ||
    environment.drivers.some(
      (driver) => typeof driver !== "string" || !allowedDrivers.has(driver),
    ) ||
    new Set(environment.drivers).size !== environment.drivers.length
  ) {
    throw new Error(`Server adapter "${type}" declares invalid environment drivers`);
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

  if (!isRecord(definition.readiness)) {
    throw new Error(`Server adapter "${type}" readiness must be an object`);
  }
  const readiness = definition.readiness;
  exactKeys(
    readiness,
    [
      "protocolVersion",
      "resume",
      "cancel",
      "sessionConfig",
      "sessionScopedMcpReplacement",
      "cliNativeAuthentication",
    ],
    `Server adapter "${type}" readiness`,
  );
  if (
    readiness.protocolVersion !== 1 ||
    readiness.resume !== true ||
    readiness.cancel !== true ||
    readiness.sessionConfig !== true ||
    readiness.sessionScopedMcpReplacement !== true ||
    readiness.cliNativeAuthentication !== true
  ) {
    throw new Error(
      `Server adapter "${type}" does not declare every required stable ACP readiness fact`,
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
  if (!Array.isArray(definition.configOptions) || definition.configOptions.length === 0) {
    throw new Error(`Server adapter "${type}" configOptions must be non-empty`);
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

  const modelConfigOptionId = exactString(
    definition.modelConfigOptionId,
    `Server adapter "${type}" modelConfigOptionId`,
  );
  const modelOption = configOptions.find(
    (option) => option.id === modelConfigOptionId,
  );
  if (!modelOption) {
    throw new Error(
      `Server adapter "${type}" modelConfigOptionId is not declared`,
    );
  }
  if (!Array.isArray(definition.models) || definition.models.length === 0) {
    throw new Error(`Server adapter "${type}" models must be non-empty`);
  }
  const models = definition.models.map(validateAdapterModel);
  if (
    new Set(models.map((model) => model.id)).size !== models.length ||
    new Set(models.map((model) => model.value)).size !== models.length
  ) {
    throw new Error(`Server adapter "${type}" models contain duplicate ids or values`);
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
