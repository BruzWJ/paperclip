import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import { createAgentRegistry, type AcpAgentRegistry } from "acpx/runtime";

export type { AcpAgentRegistry } from "acpx/runtime";

const execFileAsync = promisify(execFile);
const ACPX_CONFIG_TIMEOUT_MS = 5_000;
const ACPX_CONFIG_CACHE_MS = 30_000;
const requireFromHere = createRequire(import.meta.url);

type AcpxRegistryOverride = string | string[];

type CachedConfiguredRegistry = {
  readonly expiresAt: number;
  readonly registry: AcpAgentRegistry;
};

const configuredRegistryCache = new Map<string, CachedConfiguredRegistry>();

/**
 * ACPX's resolved `agents` configuration is the sole authority for enabled
 * agent names and their launch form. Paperclip deliberately persists only the
 * exact configured name; resolving it again at use time keeps ACPX in control
 * of upgrades and local agent installation details.
 */
export interface AcpRegistryLaunch {
  readonly registryName: string;
  readonly command: string;
  readonly args: readonly string[];
}

export interface LoadConfiguredAcpRegistryInput {
  /**
   * ACPX resolves a project `.acpxrc.json` relative to this host workspace.
   * The global config and all merge/validation semantics remain ACPX-owned.
   */
  readonly cwd: string;
  /** Used only by tests or an explicit caller that needs a shorter deadline. */
  readonly timeoutMs?: number;
}

function exactName(value: string): string {
  if (value.length === 0 || value !== value.trim()) {
    throw new Error("ACP registry name must be exact and non-empty");
  }
  return value;
}

function exactStringArray(value: string | string[]): readonly string[] {
  const argv = typeof value === "string" ? [value] : value;
  if (
    argv.length === 0 ||
    argv.some(
      (entry) =>
        typeof entry !== "string" || entry.length === 0 || entry !== entry.trim(),
    )
  ) {
    throw new Error("ACPX registry returned an invalid launch argv");
  }
  return Object.freeze([...argv]);
}

function sameArgv(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => entry === right[index])
  );
}

function exactString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value === value.trim()
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function structuredArgv(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const argv = value.map(exactString);
  if (argv.some((entry) => entry === undefined)) return undefined;
  return argv as string[];
}

/**
 * ACPX's documented `config show --format json` result contains a resolved
 * `agents` map. Preserve ACPX's structured argv or legacy command form as an
 * ACPX registry override. Paperclip never parses or executes that command;
 * the ACPX runtime remains the sole interpreter and launcher.
 */
function configShowOverrides(value: unknown): Record<string, AcpxRegistryOverride> {
  if (!isRecord(value) || !isRecord(value.agents)) {
    throw new Error("ACPX config show returned no resolved agents map");
  }
  const overrides: Record<string, AcpxRegistryOverride> = {};
  for (const [name, candidate] of Object.entries(value.agents)) {
    const exactName = exactString(name);
    if (!exactName || !isRecord(candidate)) {
      throw new Error("ACPX config show returned an invalid configured agent");
    }
    const argv = structuredArgv(candidate.argv);
    if (argv) {
      overrides[exactName] = argv;
      continue;
    }
    // ACPX owns parsing of its historical command form. Passing it back to the
    // ACPX registry preserves its own compatibility semantics without giving
    // Paperclip a command parser or executable launch surface.
    const command = exactString(candidate.command);
    if (command) {
      overrides[exactName] = command;
      continue;
    }
    throw new Error(
      `ACPX configured agent ${exactName} has neither a valid argv nor command`,
    );
  }
  return overrides;
}

/**
 * Restricts ACPX's public resolver to the exact agents explicitly present in
 * its resolved configuration. ACPX's default `list()` also includes every
 * built-in, including package-exec entries that may be downloaded on demand;
 * those are not evidence that an operator enabled a local runtime.
 *
 * Resolution remains entirely ACPX-owned. This view only narrows membership
 * before discovery or execution can reach ACPX's unknown-name fallback.
 */
export function configuredAcpRegistryView(
  resolvedRegistry: AcpAgentRegistry,
  configuredNames: readonly string[],
): AcpAgentRegistry {
  const names = Object.freeze(
    [...new Set(configuredNames.map((name) => exactName(name)))].sort(),
  );
  const allowed = new Set(names);
  return Object.freeze({
    list: () => [...names],
    resolve(agentName: string) {
      const exactAgentName = exactName(agentName);
      if (!allowed.has(exactAgentName)) {
        throw new Error(
          `ACP registry name is not configured by ACPX: ${exactAgentName}`,
        );
      }
      return resolvedRegistry.resolve(exactAgentName);
    },
  });
}

function resolveConfiguredRegistryCwd(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("ACPX configured registry cwd is required");
  }
  return path.resolve(value);
}

function resolveConfigTimeout(value: number | undefined): number {
  if (value === undefined) return ACPX_CONFIG_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("ACPX config timeout must be a positive integer");
  }
  return value;
}

async function resolvedConfigOverrides(input: {
  readonly cwd: string;
  readonly timeoutMs: number;
}): Promise<Record<string, AcpxRegistryOverride>> {
  const cliPath = requireFromHere.resolve("acpx/dist/cli.js");
  let stdout: string;
  try {
    const result = await execFileAsync(
      process.execPath,
      [cliPath, "--cwd", input.cwd, "config", "show", "--format", "json"],
      {
        cwd: input.cwd,
        encoding: "utf8",
        timeout: input.timeoutMs,
        maxBuffer: 1_024 * 1_024,
        windowsHide: true,
      },
    );
    stdout = result.stdout;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `ACPX config show failed for ${input.cwd}: ${detail}`,
      { cause: error },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error(
      `ACPX config show returned invalid JSON for ${input.cwd}`,
      { cause: error },
    );
  }
  return configShowOverrides(parsed);
}

/**
 * Loads the ACPX-resolved global + project configuration through ACPX's own
 * documented CLI, then creates a configured-only view of ACPX's public runtime
 * registry. Paperclip neither parses ACPX config files nor persists argv.
 */
export async function loadConfiguredAcpRegistry(
  input: LoadConfiguredAcpRegistryInput,
): Promise<AcpAgentRegistry> {
  const cwd = resolveConfiguredRegistryCwd(input.cwd);
  const timeoutMs = resolveConfigTimeout(input.timeoutMs);
  const now = Date.now();
  const cached = configuredRegistryCache.get(cwd);
  if (cached && cached.expiresAt > now) return cached.registry;

  const overrides = await resolvedConfigOverrides({ cwd, timeoutMs });
  const registry = configuredAcpRegistryView(
    createAgentRegistry({ overrides }),
    Object.keys(overrides),
  );
  configuredRegistryCache.set(cwd, {
    registry,
    expiresAt: now + ACPX_CONFIG_CACHE_MS,
  });
  return registry;
}

/**
 * Enumerates exact names enabled in ACPX's resolved agent configuration. This
 * does not claim that a candidate is usable; runtime discovery performs the
 * initialize/session probe before Paperclip presents it to an operator.
 */
export function listAcpRegistryAgentNames(
  candidateRegistry: AcpAgentRegistry,
): readonly string[] {
  const names = candidateRegistry.list();
  if (
    !Array.isArray(names) ||
    names.some(
      (name) =>
        typeof name !== "string" || name.length === 0 || name !== name.trim(),
    )
  ) {
    throw new Error("ACPX registry returned invalid agent names");
  }
  return Object.freeze([...new Set(names)].sort());
}

/**
 * Accept only a byte-exact ACPX-configured name without resolving its command.
 *
 * ACPX intentionally supports a raw-command fallback for unknown input. The
 * public Paperclip bridge must prevent that fallback, while leaving the
 * resolved executable and argv entirely inside ACPX's runtime.
 */
export function assertAcpRegistryAgentName(
  requestedName: string,
  candidateRegistry: AcpAgentRegistry,
): string {
  const registryName = exactName(requestedName);
  if (!listAcpRegistryAgentNames(candidateRegistry).includes(registryName)) {
    throw new Error(`ACP registry name is not configured by ACPX: ${registryName}`);
  }
  return registryName;
}

/**
 * Legacy raw-subprocess helper retained only for private fixture support.
 * Production Paperclip code must use `assertAcpRegistryAgentName` and hand
 * the name to ACPX's public runtime without inspecting its launch argv.
 */
export function resolveAcpRegistryLaunch(
  requestedName: string,
  candidateRegistry: AcpAgentRegistry,
): AcpRegistryLaunch {
  const registryName = assertAcpRegistryAgentName(
    requestedName,
    candidateRegistry,
  );
  const argv = exactStringArray(candidateRegistry.resolve(registryName));
  const [command, ...args] = argv;
  if (!command) {
    throw new Error(`ACPX registry returned no command for ${registryName}`);
  }
  return Object.freeze({
    registryName,
    command,
    args: Object.freeze(args),
  });
}

export function sameAcpRegistryLaunch(
  left: AcpRegistryLaunch,
  right: AcpRegistryLaunch,
): boolean {
  return (
    left.registryName === right.registryName &&
    left.command === right.command &&
    sameArgv(left.args, right.args)
  );
}
