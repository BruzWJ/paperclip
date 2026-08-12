import type { AcpRuntimeCapabilities, AcpRuntimeStatus } from "acpx/runtime";
import {
  listLocallyAvailableAcpRegistryAgentNames,
  loadAcpxAgentRegistry,
} from "./agent-registry.js";
import { probeAcpxRuntimeReadiness } from "./acpx-runtime-readiness.js";

export interface AcpxDiscoveredConfigOptionValue {
  readonly value: string;
  readonly name: string;
  readonly description?: string;
}

interface AcpxDiscoveredConfigOptionBase {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly category?: string;
}

/**
 * A generic ACP session option advertised after session creation. The helper
 * deliberately exposes only the closed ACPX option types Paperclip can apply
 * without provider-specific interpretation.
 */
export type AcpxDiscoveredConfigOption =
  | (AcpxDiscoveredConfigOptionBase & {
    readonly type: "select";
    readonly currentValue: string;
    readonly options: readonly AcpxDiscoveredConfigOptionValue[];
  })
  | (AcpxDiscoveredConfigOptionBase & {
    readonly type: "boolean";
    readonly currentValue: boolean;
  })
  | (AcpxDiscoveredConfigOptionBase & {
    readonly type: "text";
    readonly currentValue?: string;
  });

export interface AcpxAgentDiscovery {
  /** Exact ACPX registry name that was probed. */
  readonly agentName: string;
  /** ACPX runtime controls advertised for the temporary session. */
  readonly controls: readonly string[];
  /** ACPX runtime's known configuration ids, when it advertises them. */
  readonly configOptionKeys: readonly string[];
  /** ACPX's advertised selectable model ids. Empty is a valid result. */
  readonly models: readonly string[];
  readonly currentModelId?: string;
  /** All valid advertised ACP options, including non-model options. */
  readonly configOptions: readonly AcpxDiscoveredConfigOption[];
}

interface ProbeAcpxAgentInput {
  readonly cwd: string;
  /** Must exactly match a name returned by the ACPX registry. */
  readonly agentName: string;
  readonly timeoutMs?: number;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactNonEmptyString(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim()
  ) {
    return undefined;
  }
  return value;
}

function distinctStrings(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  const values = new Set<string>();
  for (const entry of value) {
    const parsed = exactNonEmptyString(entry);
    if (parsed) values.add(parsed);
  }
  return Object.freeze([...values]);
}

function parseConfigOptionValue(
  value: unknown,
): AcpxDiscoveredConfigOptionValue | undefined {
  if (!isRecord(value)) return undefined;
  const optionValue = exactNonEmptyString(value.value);
  const name = exactNonEmptyString(value.name);
  if (!optionValue || !name) return undefined;
  const description = value.description === undefined
    ? undefined
    : exactNonEmptyString(value.description);
  if (value.description !== undefined && !description) return undefined;
  return Object.freeze({
    value: optionValue,
    name,
    ...(description ? { description } : {}),
  });
}

function parseConfigOptionValues(
  value: unknown,
): readonly AcpxDiscoveredConfigOptionValue[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("ACPX select option values must be a non-empty array");
  }
  const parsed: AcpxDiscoveredConfigOptionValue[] = [];
  for (const entry of value) {
    const option = parseConfigOptionValue(entry);
    if (!option) {
      throw new Error("ACPX select option value must use exact value and name strings");
    }
    parsed.push(option);
  }
  if (new Set(parsed.map((entry) => entry.value)).size !== parsed.length) {
    throw new Error("ACPX select option values must be unique");
  }
  return Object.freeze(parsed);
}

function parseConfigOptions(value: unknown): readonly AcpxDiscoveredConfigOption[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) {
    throw new Error("ACPX config options must be an array");
  }
  const seenIds = new Set<string>();
  const parsed: AcpxDiscoveredConfigOption[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      throw new Error("ACPX config option must be an object");
    }
    const id = exactNonEmptyString(entry.id);
    const type = exactNonEmptyString(entry.type);
    const name = exactNonEmptyString(entry.name);
    if (!id || !type || !name) {
      throw new Error("ACPX config option id, name, and type must be exact strings");
    }
    if (seenIds.has(id)) {
      throw new Error(`ACPX config option id ${id} is duplicated`);
    }
    seenIds.add(id);
    const description = entry.description === undefined
      ? undefined
      : exactNonEmptyString(entry.description);
    const category = entry.category === undefined
      ? undefined
      : exactNonEmptyString(entry.category);
    if (entry.description !== undefined && !description) {
      throw new Error(`ACPX config option ${id} has an invalid description`);
    }
    if (entry.category !== undefined && !category) {
      throw new Error(`ACPX config option ${id} has an invalid category`);
    }
    const base = {
      id,
      name,
      ...(description ? { description } : {}),
      ...(category ? { category } : {}),
    };
    if (type === "select") {
      const currentValue = exactNonEmptyString(entry.currentValue);
      if (!currentValue) {
        throw new Error(`ACPX select option ${id} must have an exact current value`);
      }
      const options = parseConfigOptionValues(entry.options);
      if (!options.some((option) => option.value === currentValue)) {
        throw new Error(`ACPX select option ${id} current value is not declared`);
      }
      parsed.push(Object.freeze({
        ...base,
        type,
        currentValue,
        options,
      }));
      continue;
    }
    if (type === "boolean") {
      if (typeof entry.currentValue !== "boolean") {
        throw new Error(`ACPX boolean option ${id} must have a boolean current value`);
      }
      parsed.push(Object.freeze({
        ...base,
        type,
        currentValue: entry.currentValue,
      }));
      continue;
    }
    if (type === "text") {
      const currentValue = entry.currentValue === undefined
        ? undefined
        : exactNonEmptyString(entry.currentValue);
      if (entry.currentValue !== undefined && !currentValue) {
        throw new Error(`ACPX text option ${id} must have an exact string current value`);
      }
      parsed.push(Object.freeze({
        ...base,
        type,
        ...(currentValue ? { currentValue } : {}),
      }));
      continue;
    }
    throw new Error(`ACPX config option ${id} has unsupported type ${type}`);
  }
  return Object.freeze(parsed);
}

function parseCapabilities(
  capabilities: AcpRuntimeCapabilities,
): Pick<AcpxAgentDiscovery, "controls" | "configOptionKeys"> {
  return Object.freeze({
    controls: distinctStrings(capabilities.controls),
    configOptionKeys: distinctStrings(capabilities.configOptionKeys),
  });
}

function parseStatus(
  agentName: string,
  status: AcpRuntimeStatus,
  capabilities: AcpRuntimeCapabilities,
): AcpxAgentDiscovery {
  const details = isRecord(status.details) ? status.details : undefined;
  const currentModelId = exactNonEmptyString(status.models?.currentModelId);
  const parsedCapabilities = parseCapabilities(capabilities);
  const configOptions = parseConfigOptions(details?.configOptions);
  return Object.freeze({
    agentName,
    ...parsedCapabilities,
    models: distinctStrings(status.models?.availableModelIds),
    ...(currentModelId ? { currentModelId } : {}),
    configOptions,
  });
}

function resolveCwd(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new Error("ACPX discovery cwd must be exact and non-empty");
  }
  return value;
}

/**
 * Lists ACPX registry names with non-launching evidence of a local executable.
 * Paperclip adds no catalog entries, aliases, launch argv, or model data.
 */
export async function listAcpxAgentNames(
  configuredCwd = process.cwd(),
): Promise<readonly string[]> {
  const cwd = resolveCwd(configuredCwd);
  return await listLocallyAvailableAcpRegistryAgentNames(
    await loadAcpxAgentRegistry(cwd),
    { cwd },
  );
}

/**
 * Projects one canonical disposable ACPX observation as catalog metadata.
 */
export async function probeAcpxAgent(
  input: ProbeAcpxAgentInput,
): Promise<AcpxAgentDiscovery> {
  const observation = await probeAcpxRuntimeReadiness({
    cwd: input.cwd,
    agentName: input.agentName,
    configSelections: [],
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  });
  return parseStatus(
    input.agentName,
    observation.status,
    observation.capabilities,
  );
}
