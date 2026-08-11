import type { AcpRuntimeCapabilities, AcpRuntimeStatus } from "acpx/runtime";
import {
  listLocallyAvailableAcpRegistryAgentNames,
  loadAcpxAgentRegistry,
} from "./agent-registry.js";
import { probeAcpxRuntimeReadiness } from "./acpx-runtime-readiness.js";

export interface AcpxDiscoveredConfigOptionValue {
  readonly kind: "value";
  readonly value: string;
  readonly name: string;
  readonly description?: string;
}

interface AcpxDiscoveredConfigOptionGroup {
  readonly kind: "group";
  readonly group: string;
  readonly name: string;
  readonly options: readonly AcpxDiscoveredConfigOptionValue[];
}

/**
 * A generic ACP session option advertised after session creation. The helper
 * deliberately preserves no provider-specific metadata: callers render or
 * select from ACP's id, type, category, current value, and choices only.
 */
export interface AcpxDiscoveredConfigOption {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly description?: string;
  readonly category?: string;
  readonly currentValue?: string | boolean;
  readonly options: readonly (
    | AcpxDiscoveredConfigOptionValue
    | AcpxDiscoveredConfigOptionGroup
  )[];
}

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

function displayString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

/**
 * ACPX option identifiers and selected values are execution inputs, so they
 * must remain exact. Display names are presentation metadata only: normalize
 * them generically and, when absent, expose the exact ACPX identifier/value
 * rather than inventing a provider-specific label.
 */
function displayName(value: unknown, fallback: string): string {
  return displayString(value) ?? fallback;
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
  if (!optionValue) return undefined;
  const name = displayName(value.name, optionValue);
  const description = displayString(value.description);
  return Object.freeze({
    kind: "value",
    value: optionValue,
    name,
    ...(description ? { description } : {}),
  });
}

function parseConfigOptionValues(
  value: unknown,
): readonly (
  | AcpxDiscoveredConfigOptionValue
  | AcpxDiscoveredConfigOptionGroup
)[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  const parsed: Array<
    AcpxDiscoveredConfigOptionValue | AcpxDiscoveredConfigOptionGroup
  > = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const group = exactNonEmptyString(entry.group);
    if (group && Array.isArray(entry.options)) {
      const groupName = displayName(entry.name, group);
      const options = entry.options
        .map((candidate) => parseConfigOptionValue(candidate))
        .filter(
          (candidate): candidate is AcpxDiscoveredConfigOptionValue =>
            candidate !== undefined,
        );
      parsed.push(
        Object.freeze({
          kind: "group",
          group,
          name: groupName,
          options: Object.freeze(options),
        }),
      );
      continue;
    }
    const option = parseConfigOptionValue(entry);
    if (option) parsed.push(option);
  }
  return Object.freeze(parsed);
}

function parseConfigOptions(value: unknown): readonly AcpxDiscoveredConfigOption[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  const seenIds = new Set<string>();
  const parsed: AcpxDiscoveredConfigOption[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const id = exactNonEmptyString(entry.id);
    const type = exactNonEmptyString(entry.type);
    if (!id || !type || seenIds.has(id)) continue;
    const name = displayName(entry.name, id);
    seenIds.add(id);
    const description = displayString(entry.description);
    const category = displayString(entry.category);
    const currentValue =
      typeof entry.currentValue === "string" ||
      typeof entry.currentValue === "boolean"
        ? entry.currentValue
        : undefined;
    parsed.push(
      Object.freeze({
        id,
        name,
        type,
        ...(description ? { description } : {}),
        ...(category ? { category } : {}),
        ...(currentValue !== undefined ? { currentValue } : {}),
        options: parseConfigOptionValues(entry.options),
      }),
    );
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
