import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, stat } from "node:fs/promises";
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

type CachedResolvedRegistry = {
  readonly expiresAt: number;
  readonly registry: AcpAgentRegistry;
};

const resolvedRegistryCache = new Map<string, CachedResolvedRegistry>();

/**
 * Paperclip persists only the exact ACPX registry name. Resolving it again at
 * use time keeps ACPX in control of built-ins, configured overrides, upgrades,
 * and local agent launch details.
 */
export interface AcpRegistryLaunch {
  readonly registryName: string;
  readonly command: string;
  readonly args: readonly string[];
}

export interface LoadAcpxAgentRegistryInput {
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
 * ACPX registry override. Paperclip passes it back unchanged. The generic
 * availability fence may recognize only a simple executable token, but ACPX
 * remains the sole interpreter and launcher.
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
 * Loads ACPX's resolved global + project configuration through ACPX's own
 * documented CLI, then passes its `agents` map back as overrides to ACPX's
 * public registry. ACPX therefore owns the complete union of built-ins and
 * configured entries; Paperclip neither parses config files nor owns a list.
 */
export async function loadAcpxAgentRegistry(
  input: LoadAcpxAgentRegistryInput,
): Promise<AcpAgentRegistry> {
  const cwd = resolveConfiguredRegistryCwd(input.cwd);
  const timeoutMs = resolveConfigTimeout(input.timeoutMs);
  const now = Date.now();
  const cached = resolvedRegistryCache.get(cwd);
  if (cached && cached.expiresAt > now) return cached.registry;

  const overrides = await resolvedConfigOverrides({ cwd, timeoutMs });
  const registry = createAgentRegistry({ overrides });
  resolvedRegistryCache.set(cwd, {
    registry,
    expiresAt: now + ACPX_CONFIG_CACHE_MS,
  });
  return registry;
}

/** @deprecated Use `loadAcpxAgentRegistry`; configured entries are overrides. */
export const loadConfiguredAcpRegistry = loadAcpxAgentRegistry;

/** @deprecated Use `LoadAcpxAgentRegistryInput`. */
export type LoadConfiguredAcpRegistryInput = LoadAcpxAgentRegistryInput;

/**
 * Enumerates exact names supplied by ACPX's registry. This does not claim that
 * a candidate is installed or usable; local availability and the disposable
 * ACPX session probe are separate admission stages.
 */
export function listAcpRegistryAgentNames(
  candidateRegistry: AcpAgentRegistry,
): readonly string[] {
  const names = candidateRegistry.list();
  if (!Array.isArray(names)) {
    throw new Error("ACPX registry returned invalid agent names");
  }
  return Object.freeze(
    [...new Set(names.filter((name) => exactString(name) !== undefined))].sort(),
  );
}

export interface AcpRegistryLocalAvailabilityInput {
  /** Host workspace used for PATH entries that explicitly reference cwd. */
  readonly cwd: string;
  /** Test seam; production uses the server process environment. */
  readonly env?: Readonly<NodeJS.ProcessEnv>;
  /** Test seam for platform-specific executable suffix behavior. */
  readonly platform?: NodeJS.Platform;
}

const STANDALONE_MATERIALIZING_RUNNERS = new Set([
  "bunx",
  "npx",
  "pnpx",
  "uvx",
]);

const MATERIALIZING_RUNNER_SUBCOMMANDS = new Map<string, ReadonlySet<string>>([
  ["bun", new Set(["x"])],
  ["npm", new Set(["exec", "x"])],
  ["pipx", new Set(["run"])],
  ["pnpm", new Set(["dlx", "exec"])],
  ["yarn", new Set(["dlx"])],
]);

function executableName(value: string): string {
  return path.basename(value).replace(/\.(?:bat|cmd|com|exe)$/iu, "").toLowerCase();
}

/**
 * Tokenize only the simple command form needed for a non-launching executable
 * check. Ambiguous shell programs are rejected instead of being evaluated.
 */
function simpleCommandArgv(value: string): readonly string[] | undefined {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;
  let tokenStarted = false;

  for (const character of value) {
    if (escaping) {
      token += character;
      tokenStarted = true;
      escaping = false;
      continue;
    }
    if (quote === "'") {
      if (character === "'") quote = null;
      else token += character;
      tokenStarted = true;
      continue;
    }
    if (quote === '"') {
      if (character === '"') quote = null;
      else if (character === "\\") escaping = true;
      else token += character;
      tokenStarted = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      tokenStarted = true;
      continue;
    }
    if (character === "\\") {
      escaping = true;
      tokenStarted = true;
      continue;
    }
    if (/\s/u.test(character)) {
      if (tokenStarted) tokens.push(token);
      token = "";
      tokenStarted = false;
      continue;
    }
    // ACPX evaluates string registry entries as shell commands. Never execute
    // or try to predict expansion, pipelines, redirection, or command lists.
    if ("$`|&;<>\n\r".includes(character)) return undefined;
    token += character;
    tokenStarted = true;
  }
  if (escaping || quote !== null) return undefined;
  if (tokenStarted) tokens.push(token);
  return tokens.length > 0 && tokens.every((entry) => entry.length > 0)
    ? Object.freeze(tokens)
    : undefined;
}

function availabilityArgv(
  value: string | string[],
  platform: NodeJS.Platform,
): readonly string[] | undefined {
  if (typeof value === "string") {
    // ACPX delegates legacy strings to cmd.exe on Windows. Do not approximate
    // that language: only a single literal executable is safe to inspect.
    if (platform === "win32") {
      return value.length > 0 && value === value.trim() && !/[\s"'&|<>^]/u.test(value)
        ? Object.freeze([value])
        : undefined;
    }
    return simpleCommandArgv(value);
  }
  try {
    return exactStringArray(value);
  } catch {
    return undefined;
  }
}

const SHELL_COMMAND_LAUNCHERS = new Set([
  "bash",
  "cmd",
  "dash",
  "fish",
  "ksh",
  "powershell",
  "pwsh",
  "sh",
  "zsh",
]);

/**
 * `env` is a common transparent argv wrapper. Unwrap only its simple,
 * deterministic form; options whose arity or string-splitting semantics would
 * require interpreting a command language fail closed.
 */
function unwrapEnvironmentCommand(
  argv: readonly string[],
): readonly string[] | undefined {
  const [command, ...args] = argv;
  if (!command || executableName(command) !== "env") return argv;
  let cursor = 0;
  while (cursor < args.length) {
    const argument = args[cursor]!;
    if (argument === "--") {
      cursor += 1;
      break;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(argument)) {
      cursor += 1;
      continue;
    }
    if (argument.startsWith("-")) return undefined;
    break;
  }
  return args.length > cursor
    ? Object.freeze(args.slice(cursor))
    : undefined;
}

function directlyUsesMaterializingPackageRunner(
  argv: readonly string[],
): boolean {
  const [command, ...args] = argv;
  if (!command) return false;
  const runner = executableName(command);
  if (STANDALONE_MATERIALIZING_RUNNERS.has(runner)) return true;

  const subcommands = MATERIALIZING_RUNNER_SUBCOMMANDS.get(runner);
  if (subcommands && args.some((argument) => subcommands.has(argument))) return true;
  if (runner === "uv") {
    const toolIndex = args.indexOf("tool");
    return toolIndex >= 0 && args.slice(toolIndex + 1).includes("run");
  }
  // Corepack delegates to a package manager. Inspect the delegated argv with
  // the same generic runner rules rather than treating corepack as evidence
  // that the requested agent is installed.
  if (runner === "corepack") {
    const delegatedIndex = args.findIndex((argument) =>
      MATERIALIZING_RUNNER_SUBCOMMANDS.has(executableName(argument)),
    );
    if (delegatedIndex < 0) return false;
    return directlyUsesMaterializingPackageRunner([
      args[delegatedIndex]!,
      ...args.slice(delegatedIndex + 1),
    ]);
  }
  return false;
}

function usesMaterializingPackageRunner(argv: readonly string[]): boolean {
  const unwrapped = unwrapEnvironmentCommand(argv);
  if (!unwrapped) return true;
  // Scan every argv suffix. This catches transparent process wrappers such as
  // `nice`, `timeout`, `nohup`, or a future wrapper without maintaining a
  // wrapper catalog in Paperclip. An installed wrapper is not evidence that a
  // nested package-exec target is installed.
  for (let index = 0; index < unwrapped.length; index += 1) {
    const suffix = unwrapped.slice(index);
    if (directlyUsesMaterializingPackageRunner(suffix)) return true;
    const token = suffix[0];
    if (!token || !/\s/u.test(token)) continue;
    const nested = simpleCommandArgv(token);
    if (nested && usesMaterializingPackageRunner(nested)) return true;
  }
  return false;
}

function containsShellCommandLanguage(argv: readonly string[]): boolean {
  for (const token of argv) {
    if (SHELL_COMMAND_LAUNCHERS.has(executableName(token))) return true;
    if (!/\s/u.test(token)) continue;
    const nested = simpleCommandArgv(token);
    if (nested && containsShellCommandLanguage(nested)) return true;
  }
  return false;
}

function availabilityProgram(
  registryName: string,
  argv: readonly string[],
): string | undefined {
  const unwrapped = unwrapEnvironmentCommand(argv);
  if (!unwrapped) return undefined;
  const command = unwrapped[0];
  if (!command || containsShellCommandLanguage(unwrapped)) {
    return undefined;
  }
  return usesMaterializingPackageRunner(unwrapped)
    ? registryName
    : command;
}

function environmentValue(
  env: Readonly<NodeJS.ProcessEnv>,
  key: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform !== "win32") return env[key];
  const found = Object.entries(env).find(
    ([candidate]) => candidate.toLowerCase() === key.toLowerCase(),
  );
  return found?.[1];
}

function executableSuffixes(
  program: string,
  env: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform,
): readonly string[] {
  if (platform !== "win32" || path.extname(program).length > 0) return [""];
  const configured = environmentValue(env, "PATHEXT", platform)
    ?.split(";")
    .filter((entry) => entry.length > 0);
  return configured && configured.length > 0
    ? Object.freeze(configured)
    : Object.freeze([".COM", ".EXE", ".BAT", ".CMD"]);
}

async function executableFile(candidate: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    const metadata = await stat(candidate);
    if (!metadata.isFile()) return false;
    await access(
      candidate,
      platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK,
    );
    return true;
  } catch {
    return false;
  }
}

async function executableAvailable(input: {
  readonly program: string;
  readonly cwd: string;
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly platform: NodeJS.Platform;
}): Promise<boolean> {
  const { program, cwd, env, platform } = input;
  const suffixes = executableSuffixes(program, env, platform);
  const hasPathSeparator = program.includes("/") || program.includes("\\");
  if (hasPathSeparator && !path.isAbsolute(program)) return false;
  if (path.isAbsolute(program)) {
    const base = program;
    return (await Promise.all(
      suffixes.map((suffix) => executableFile(`${base}${suffix}`, platform)),
    )).some(Boolean);
  }

  const searchPath = environmentValue(env, "PATH", platform) ?? "";
  const directories = searchPath.split(platform === "win32" ? ";" : ":");
  for (const directory of directories) {
    const base = path.resolve(directory.length > 0 ? directory : cwd, program);
    for (const suffix of suffixes) {
      if (await executableFile(`${base}${suffix}`, platform)) return true;
    }
  }
  return false;
}

/**
 * Performs a non-launching local check using only ACPX's resolved registry
 * value. Direct commands must resolve to an executable. Package runners that
 * can materialize a missing package are not installation evidence; for those
 * entries, the exact ACPX registry name must itself be executable on PATH.
 */
export async function isAcpRegistryAgentLocallyAvailable(
  requestedName: string,
  candidateRegistry: AcpAgentRegistry,
  input: AcpRegistryLocalAvailabilityInput,
): Promise<boolean> {
  const registryName = assertAcpRegistryAgentName(requestedName, candidateRegistry);
  const cwd = resolveConfiguredRegistryCwd(input.cwd);
  const env = input.env ?? process.env;
  const platform = input.platform ?? process.platform;
  let resolved: string | string[];
  try {
    resolved = candidateRegistry.resolve(registryName);
  } catch {
    return false;
  }
  const argv = availabilityArgv(resolved, platform);
  if (!argv) return false;
  const program = availabilityProgram(registryName, argv);
  if (!program) return false;
  return await executableAvailable({ program, cwd, env, platform });
}

/** Lists the ACPX-supplied registry entries that have local launch evidence. */
export async function listLocallyAvailableAcpRegistryAgentNames(
  candidateRegistry: AcpAgentRegistry,
  input: AcpRegistryLocalAvailabilityInput,
): Promise<readonly string[]> {
  const names = listAcpRegistryAgentNames(candidateRegistry);
  const availability = await Promise.all(
    names.map(async (name) => ({
      name,
      available: await isAcpRegistryAgentLocallyAvailable(
        name,
        candidateRegistry,
        input,
      ),
    })),
  );
  return Object.freeze(
    availability
      .filter((candidate) => candidate.available)
      .map((candidate) => candidate.name),
  );
}

/**
 * Accept only a byte-exact ACPX-listed name without resolving its command.
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
    throw new Error(`ACP registry name is not listed by ACPX: ${registryName}`);
  }
  return registryName;
}

/**
 * Legacy raw-subprocess helper retained only for private fixture support.
 * Production Paperclip code hands the exact name to ACPX's public runtime.
 * Apart from the generic non-launching availability fence, it does not inspect
 * or execute ACPX's launch argv.
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
