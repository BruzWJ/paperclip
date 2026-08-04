import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAcpRuntime,
  createRuntimeStore,
  type AcpAgentRegistry,
  type AcpRuntimeCapabilities,
  type AcpRuntimeEnsureInput,
  type AcpRuntimeHandle,
  type AcpRuntimeOptions,
  type AcpRuntimeStatus,
  type AcpSessionStore,
} from "acpx/runtime";
import {
  loadConfiguredAcpRegistry,
} from "./agent-registry.js";
import type { AcpSessionConfigSelection } from "./contract.js";

/** The bounded ACPX timeout used when an operator does not provide one. */
export const DEFAULT_ACPX_DISCOVERY_TIMEOUT_MS = 10_000;

export interface AcpxDiscoveredConfigOptionValue {
  readonly kind: "value";
  readonly value: string;
  readonly name: string;
  readonly description?: string;
}

export interface AcpxDiscoveredConfigOptionGroup {
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
  /** Exact, configured ACPX agent name that was probed. */
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

/**
 * Verifies each currently selected ACPX configuration value through ACPX's
 * public runtime API. This is deliberately ACPX-level—not raw ACP—because
 * ACPX adapters may translate the provider-facing option schema and values.
 */
export interface AcpxRuntimeConfigurationInput {
  readonly agentName: string;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly runtime: AcpxDiscoveryRuntime;
  readonly handle: AcpRuntimeHandle;
  readonly configSelections: readonly AcpSessionConfigSelection[];
}

/** Narrow runtime contract so tests can inject an in-memory ACPX facade. */
export interface AcpxDiscoveryRuntime {
  /** ACPX's no-prompt frontend availability probe for `probeAgent`. */
  doctor?(): Promise<{ readonly ok: boolean }>;
  ensureSession(input: AcpRuntimeEnsureInput): Promise<AcpRuntimeHandle>;
  getCapabilities?(
    input: { readonly handle: AcpRuntimeHandle },
  ): Promise<AcpRuntimeCapabilities> | AcpRuntimeCapabilities;
  getStatus(input: {
    readonly handle: AcpRuntimeHandle;
    readonly signal?: AbortSignal;
  }): Promise<AcpRuntimeStatus>;
  setConfigOption(input: {
    readonly handle: AcpRuntimeHandle;
    readonly key: string;
    /** ACPX's public runtime normalizes configuration values as strings. */
    readonly value: string;
  }): Promise<void>;
  close(input: {
    readonly handle: AcpRuntimeHandle;
    readonly reason: string;
    readonly discardPersistentState?: boolean;
  }): Promise<void>;
}

export interface AcpxDiscoveryDependencies {
  /**
   * Primarily useful for tests and execution-target-specific ACPX registry
   * suppliers. Production loads ACPX's resolved global/project configuration
   * through its own `config show` interface before creating the registry.
   */
  readonly createAgentRegistry?: () => AcpAgentRegistry;
  readonly createAcpRuntime?: (
    options: AcpRuntimeOptions,
  ) => AcpxDiscoveryRuntime;
  readonly createRuntimeStore?: (options: {
    readonly stateDir: string;
  }) => AcpSessionStore;
  /** Test seam for the private temporary ACPX state directory. */
  readonly createTemporaryStateDir?: () => Promise<string>;
  /** Test seam paired only with createTemporaryStateDir. */
  readonly removeTemporaryStateDir?: (stateDir: string) => Promise<void>;
  readonly createSessionKey?: () => string;
  /** Test seam for the generic ACPX configuration contract check. */
  readonly verifyAcpxRuntimeConfiguration?: (
    input: AcpxRuntimeConfigurationInput,
  ) => Promise<void>;
}

export interface ListAcpxAgentsInput {
  /** Host workspace that scopes ACPX's project `.acpxrc.json`. */
  readonly cwd?: string;
  readonly dependencies?: AcpxDiscoveryDependencies;
}

export interface ProbeAcpxAgentInput {
  readonly cwd: string;
  /** Must exactly match a name returned by the ACPX registry. */
  readonly agentName: string;
  readonly timeoutMs?: number;
  readonly dependencies?: AcpxDiscoveryDependencies;
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
  capabilities: AcpRuntimeCapabilities | undefined,
): Pick<AcpxAgentDiscovery, "controls" | "configOptionKeys"> {
  return Object.freeze({
    controls: distinctStrings(capabilities?.controls),
    configOptionKeys: distinctStrings(capabilities?.configOptionKeys),
  });
}

function parseStatus(
  agentName: string,
  status: AcpRuntimeStatus,
  capabilities: AcpRuntimeCapabilities | undefined,
): AcpxAgentDiscovery {
  const details = isRecord(status.details) ? status.details : undefined;
  const configOptions = parseConfigOptions(details?.configOptions);
  const currentModelId = exactNonEmptyString(status.models?.currentModelId);
  const parsedCapabilities = parseCapabilities(capabilities);
  return Object.freeze({
    agentName,
    ...parsedCapabilities,
    models: distinctStrings(status.models?.availableModelIds),
    ...(currentModelId ? { currentModelId } : {}),
    configOptions,
  });
}

function resolveTimeoutMs(value: number | undefined): number {
  if (value === undefined) return DEFAULT_ACPX_DISCOVERY_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("ACPX discovery timeout must be a positive integer");
  }
  return value;
}

function resolveExactAgentName(value: string): string {
  const parsed = exactNonEmptyString(value);
  if (!parsed) {
    throw new Error("ACPX discovery agent name must be exact and non-empty");
  }
  return parsed;
}

function resolveCwd(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("ACPX discovery cwd is required");
  }
  return value;
}

function resolveSessionKey(value: string): string {
  const parsed = exactNonEmptyString(value);
  if (!parsed) throw new Error("ACPX discovery session key must be non-empty");
  return parsed;
}

function createDefaultSessionKey(): string {
  return `acpx-discovery-${randomUUID()}`;
}

async function createDefaultTemporaryStateDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "paperclip-acpx-discovery-"));
}

async function removeDefaultTemporaryStateDir(stateDir: string): Promise<void> {
  await rm(stateDir, { recursive: true, force: true });
}

async function registryFrom(
  input: ListAcpxAgentsInput,
  cwd: string,
): Promise<AcpAgentRegistry> {
  const supplied = input.dependencies?.createAgentRegistry;
  return supplied
    ? supplied()
    : await loadConfiguredAcpRegistry({ cwd });
}

function listedAgentNames(registry: AcpAgentRegistry): readonly string[] {
  return distinctStrings(registry.list());
}

/**
 * Lists exactly the names ACPX's resolved `agents` configuration exposes.
 * Paperclip adds no catalog entries, aliases, launch argv, or model data here.
 */
export async function listAcpxAgentNames(
  input: ListAcpxAgentsInput = {},
): Promise<readonly string[]> {
  const cwd = resolveCwd(input.cwd ?? process.cwd());
  return listedAgentNames(await registryFrom(input, cwd));
}

async function closeProbeSession(
  runtime: AcpxDiscoveryRuntime,
  handle: AcpRuntimeHandle,
): Promise<void> {
  try {
    await runtime.close({
      handle,
      reason: "temporary ACPX discovery session",
      discardPersistentState: true,
    });
  } catch (discardError) {
    try {
      await runtime.close({
        handle,
        reason: "temporary ACPX discovery session",
        discardPersistentState: false,
      });
    } catch (closeError) {
      throw new AggregateError(
        [discardError, closeError],
        "ACPX discovery session cleanup failed",
      );
    }
  }
}

function throwWithCleanupFailure(
  operationError: unknown,
  cleanupErrors: readonly unknown[],
): never {
  if (cleanupErrors.length === 0) throw operationError;
  throw new AggregateError(
    [operationError, ...cleanupErrors],
    "ACPX discovery failed and cleanup was incomplete",
  );
}

function discoveredOptionValues(
  option: AcpxDiscoveredConfigOption,
): readonly AcpxDiscoveredConfigOptionValue[] {
  return Object.freeze(
    option.options.flatMap((entry) =>
      entry.kind === "group" ? entry.options : [entry],
    ),
  );
}

/**
 * Use the exact current ACPX values to exercise every field Paperclip will
 * make selectable. This rejects an incomplete/contradictory advertised
 * schema before it can become a persisted agent revision.
 */
function currentConfigSelections(
  discovery: AcpxAgentDiscovery,
): readonly AcpSessionConfigSelection[] {
  const selections: AcpSessionConfigSelection[] = [];
  for (const option of discovery.configOptions) {
    if (option.type === "boolean") {
      if (typeof option.currentValue !== "boolean") {
        throw new Error(
          `ACPX agent ${discovery.agentName} omitted a boolean current value for ${option.id}`,
        );
      }
      selections.push(Object.freeze({
        configId: option.id,
        value: option.currentValue,
      }));
      continue;
    }
    const values = discoveredOptionValues(option);
    if (typeof option.currentValue !== "string") {
      // A future ACPX string-like setting may intentionally have no default.
      // Paperclip can render it as required freeform text and ACPX will verify
      // the operator's explicit value during readiness. Closed selections,
      // however, must have a current valid value for this probe to admit them.
      if (option.type !== "select" && values.length === 0) continue;
      throw new Error(
        `ACPX agent ${discovery.agentName} omitted a string current value for ${option.id}`,
      );
    }
    if (
      values.length > 0 &&
      !values.some((value) => value.value === option.currentValue)
    ) {
      throw new Error(
        `ACPX agent ${discovery.agentName} omitted a valid selected value for ${option.id}`,
      );
    }
    selections.push(Object.freeze({
      configId: option.id,
      value: option.currentValue,
    }));
  }
  return Object.freeze(
    selections.sort((left, right) =>
      left.configId.localeCompare(right.configId),
    ),
  );
}

function acpxRuntimeConfigValue(
  value: AcpSessionConfigSelection["value"],
): string {
  // ACPX's public runtime intentionally exposes config setters as strings.
  // Preserve boolean semantics without introducing a provider-specific map.
  return typeof value === "boolean" ? String(value) : value;
}

async function verifyDefaultAcpxRuntimeConfiguration(
  input: AcpxRuntimeConfigurationInput,
): Promise<void> {
  for (const selection of input.configSelections) {
    await input.runtime.setConfigOption({
      handle: input.handle,
      key: selection.configId,
      value: acpxRuntimeConfigValue(selection.value),
    });
  }
}

/**
 * Creates a disposable, no-prompt ACPX session for one configured ACPX agent
 * and returns the generic configuration it advertises. It never resolves an
 * arbitrary agent string, so ACPX's raw-command fallback is not reachable.
 *
 * ACPX owns native launch behavior. Its current runtime may still create a
 * provider-native session while obtaining these options; callers should treat
 * this as an explicit operator probe rather than a passive filesystem scan.
 */
export async function probeAcpxAgent(
  input: ProbeAcpxAgentInput,
): Promise<AcpxAgentDiscovery> {
  const agentName = resolveExactAgentName(input.agentName);
  const cwd = resolveCwd(input.cwd);
  const timeoutMs = resolveTimeoutMs(input.timeoutMs);
  const registry = await registryFrom(input, cwd);
  if (!listedAgentNames(registry).includes(agentName)) {
    throw new Error(`ACPX discovery agent is not registry-listed: ${agentName}`);
  }

  const dependencies = input.dependencies;
  const createTemporaryStateDir =
    dependencies?.createTemporaryStateDir ?? createDefaultTemporaryStateDir;
  const removeTemporaryStateDir =
    dependencies?.removeTemporaryStateDir ?? removeDefaultTemporaryStateDir;
  const stateDir = await createTemporaryStateDir();
  let runtime: AcpxDiscoveryRuntime | undefined;
  let handle: AcpRuntimeHandle | undefined;
  let result: AcpxAgentDiscovery | undefined;
  let operationError: unknown;
  const cleanupErrors: unknown[] = [];

  try {
    const sessionStore = (dependencies?.createRuntimeStore ?? createRuntimeStore)(
      { stateDir },
    );
    runtime = (dependencies?.createAcpRuntime ?? createAcpRuntime)({
      cwd,
      sessionStore,
      agentRegistry: registry,
      // Let ACPX verify this exact registry candidate before Paperclip opens
      // its disposable configuration session. Paperclip reads only `ok`, not
      // ACPX's resolved command or diagnostic details.
      probeAgent: agentName,
      mcpServers: [],
      permissionMode: "deny-all",
      nonInteractivePermissions: "deny",
      timeoutMs,
    });
    if (runtime.doctor) {
      const availability = await runtime.doctor();
      if (!availability.ok) {
        throw new Error("ACPX frontend availability probe failed");
      }
    }
    handle = await runtime.ensureSession({
      sessionKey: resolveSessionKey(
        dependencies?.createSessionKey?.() ?? createDefaultSessionKey(),
      ),
      agent: agentName,
      // Keep the ACPX client alive while validating every advertised option.
      // This is still a disposable probe: it sends no prompt, closes the
      // probe backend, and deletes the temporary ACPX state directory.
      mode: "persistent",
      cwd,
    });
    const capabilities = runtime.getCapabilities
      ? await runtime.getCapabilities({ handle })
      : undefined;
    const status = await runtime.getStatus({ handle });
    result = parseStatus(agentName, status, capabilities);
    const configSelections = currentConfigSelections(result);
    await (dependencies?.verifyAcpxRuntimeConfiguration
      ?? verifyDefaultAcpxRuntimeConfiguration)({
      agentName,
      cwd,
      timeoutMs,
      runtime,
      handle,
      configSelections,
    });
  } catch (error) {
    operationError = error;
  }

  if (runtime && handle) {
    try {
      await closeProbeSession(runtime, handle);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    await removeTemporaryStateDir(stateDir);
  } catch (error) {
    cleanupErrors.push(error);
  }

  if (operationError !== undefined) {
    throwWithCleanupFailure(operationError, cleanupErrors);
  }
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, "ACPX discovery cleanup failed");
  }
  if (!result) throw new Error("ACPX discovery returned no result");
  return result;
}
