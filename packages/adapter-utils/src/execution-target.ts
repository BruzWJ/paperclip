import path from "node:path";
import type { LocalProcessSandboxOptions } from "./local-process-sandbox.js";
import {
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  resolveCommandForLogs,
  runChildProcess,
  type RunProcessResult,
} from "./server-utils.js";

/** The only execution target supported by Paperclip's ACPX runtime. */
export interface AdapterExecutionTarget {
  readonly kind: "local";
  readonly leaseId?: string | null;
}

export type AdapterLocalExecutionTarget = AdapterExecutionTarget;

export interface AdapterExecutionTargetProcessOptions {
  cwd: string;
  env: Record<string, string>;
  stdin?: string;
  abortSignal?: AbortSignal;
  timeoutSec: number;
  graceSec: number;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  onSpawn?: (meta: {
    pid: number;
    processGroupId: number | null;
    startedAt: string;
  }) => Promise<void>;
  localProcessSandbox?: LocalProcessSandboxOptions | null;
}

export interface AdapterExecutionTargetShellOptions {
  cwd: string;
  env: Record<string, string>;
  timeoutSec?: number;
  graceSec?: number;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
}

export interface ResolveAdapterExecutionTargetExecutableInput {
  readonly runId: string;
  readonly target: AdapterExecutionTarget;
  /** Exact PATH selector from the immutable adapter launch profile. */
  readonly selector: string;
  /** Exact local Node executable already identity-probed by the caller. */
  readonly targetNodeExecutable: string;
  readonly cwd: string;
  readonly timeoutSec?: number;
}

export const ADAPTER_TARGET_NATIVE_IDENTITY_ENVIRONMENT_KEYS = Object.freeze([
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
] as const);

export type AdapterTargetNativeIdentityEnvironmentKey =
  (typeof ADAPTER_TARGET_NATIVE_IDENTITY_ENVIRONMENT_KEYS)[number];

/**
 * Select the complete non-secret identity-root environment for the local
 * operator-native CLI. Provider-prefixed variables, credentials, tokens, and
 * tool-specific homes remain outside this closed allowlist.
 */
export function resolveAdapterExecutionTargetNativeIdentityEnvironment(
  _target: AdapterExecutionTarget,
  baseEnvironment: NodeJS.ProcessEnv = process.env,
): Readonly<
  Partial<Record<AdapterTargetNativeIdentityEnvironmentKey, string>>
> {
  const identity: Partial<
    Record<AdapterTargetNativeIdentityEnvironmentKey, string>
  > = {};
  for (const key of ADAPTER_TARGET_NATIVE_IDENTITY_ENVIRONMENT_KEYS) {
    const value = baseEnvironment[key];
    if (value === undefined) continue;
    if (
      value.length === 0 ||
      value !== value.trim() ||
      !path.isAbsolute(value)
    ) {
      throw new Error(
        `Target-native identity environment ${key} must be an exact absolute path`,
      );
    }
    identity[key] = value;
  }
  return Object.freeze(identity);
}

export function resolveAdapterExecutionTargetCwd(
  _target: AdapterExecutionTarget | null | undefined,
  configuredCwd: string | null | undefined,
  localFallbackCwd: string,
): string {
  if (typeof configuredCwd === "string" && configuredCwd.trim().length > 0) {
    return configuredCwd;
  }
  return localFallbackCwd;
}

export function describeAdapterExecutionTarget(
  _target: AdapterExecutionTarget | null | undefined,
): string {
  return "local execution target";
}

export type AdapterExecutionTargetTimeoutSource = "configured" | "unlimited";

export interface AdapterExecutionTargetTimeoutResolution {
  /** Resolved wall-clock timeout in seconds; 0 means no adapter timeout. */
  timeoutSec: number;
  /** Which knob produced the resolved value, for logs and error messages. */
  source: AdapterExecutionTargetTimeoutSource;
}

export function resolveAdapterExecutionTargetTimeout(
  _target: AdapterExecutionTarget | null | undefined,
  configuredTimeoutSec: number | null | undefined,
): AdapterExecutionTargetTimeoutResolution {
  if (
    typeof configuredTimeoutSec === "number" &&
    Number.isFinite(configuredTimeoutSec)
  ) {
    if (configuredTimeoutSec > 0) {
      return { timeoutSec: configuredTimeoutSec, source: "configured" };
    }
    if (configuredTimeoutSec < 0) {
      return { timeoutSec: 0, source: "configured" };
    }
  }
  return { timeoutSec: 0, source: "unlimited" };
}

export function resolveAdapterExecutionTargetTimeoutSec(
  target: AdapterExecutionTarget | null | undefined,
  configuredTimeoutSec: number | null | undefined,
): number {
  return resolveAdapterExecutionTargetTimeout(
    target,
    configuredTimeoutSec,
  ).timeoutSec;
}

function describeAdapterExecutionTimeoutSource(
  source: AdapterExecutionTargetTimeoutSource,
): string {
  return source === "configured"
    ? "configured via adapterConfig.timeoutSec"
    : "no adapter wall-clock timeout";
}

export function formatAdapterExecutionTimeoutErrorMessage(
  resolution: AdapterExecutionTargetTimeoutResolution,
): string {
  return (
    `Run exceeded the adapter execution timeout ` +
    `(timeoutSec=${resolution.timeoutSec}, ${describeAdapterExecutionTimeoutSource(resolution.source)}). ` +
    `Set adapterConfig.timeoutSec to raise it.`
  );
}

export function formatAdapterExecutionTimeoutStartLogLine(
  resolution: AdapterExecutionTargetTimeoutResolution,
): string {
  if (resolution.timeoutSec <= 0) {
    if (resolution.source === "configured") {
      return (
        "Adapter execution timeout: none " +
        "(explicitly disabled via adapterConfig.timeoutSec; set it to a positive value to add one)."
      );
    }
    return (
      "Adapter execution timeout: none " +
      "(no adapter wall-clock timeout for this target; set adapterConfig.timeoutSec to add one)."
    );
  }
  return (
    `Adapter execution timeout: timeoutSec=${resolution.timeoutSec} ` +
    `(${describeAdapterExecutionTimeoutSource(resolution.source)}; set adapterConfig.timeoutSec to override).`
  );
}

export async function ensureAdapterExecutionTargetCommandResolvable(
  command: string,
  _target: AdapterExecutionTarget | null | undefined,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  await ensureCommandResolvable(command, cwd, env);
}

export async function resolveAdapterExecutionTargetCommandForLogs(
  command: string,
  _target: AdapterExecutionTarget | null | undefined,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  return await resolveCommandForLogs(command, cwd, env);
}

export async function runAdapterExecutionTargetProcess(
  runId: string,
  _target: AdapterExecutionTarget | null | undefined,
  command: string,
  args: string[],
  options: AdapterExecutionTargetProcessOptions,
): Promise<RunProcessResult> {
  return await runChildProcess(runId, command, args, {
    cwd: options.cwd,
    env: options.env,
    stdin: options.stdin,
    abortSignal: options.abortSignal,
    timeoutSec: options.timeoutSec,
    graceSec: options.graceSec,
    onLog: options.onLog,
    onSpawn: options.onSpawn,
    localProcessSandbox: options.localProcessSandbox,
  });
}

export async function runAdapterExecutionTargetShellCommand(
  runId: string,
  target: AdapterExecutionTarget | null | undefined,
  command: string,
  options: AdapterExecutionTargetShellOptions,
): Promise<RunProcessResult> {
  return await runAdapterExecutionTargetProcess(
    runId,
    target,
    "sh",
    ["-c", command],
    {
      cwd: options.cwd,
      env: options.env,
      timeoutSec: options.timeoutSec ?? 15,
      graceSec: options.graceSec ?? 5,
      onLog: options.onLog ?? (async () => {}),
    },
  );
}

const TARGET_EXECUTABLE_SELECTOR = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TARGET_EXECUTABLE_CANONICALIZER = [
  'const { constants, realpathSync, statSync, accessSync } = require("node:fs");',
  "const executable = realpathSync(process.argv[1]);",
  "if (!statSync(executable).isFile()) process.exit(66);",
  "accessSync(executable, constants.X_OK);",
  "process.stdout.write(executable);",
].join("\n");

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/**
 * Resolve one ACPX-supplied command on the local host. The result is a
 * canonical absolute executable, never a package-install fallback.
 */
export async function resolveAdapterExecutionTargetExecutable(
  input: ResolveAdapterExecutionTargetExecutableInput,
): Promise<string> {
  const absoluteSelector = path.isAbsolute(input.selector);
  if (
    input.selector.length === 0 ||
    input.selector !== input.selector.trim() ||
    (!TARGET_EXECUTABLE_SELECTOR.test(input.selector) && !absoluteSelector)
  ) {
    throw new Error(
      "Execution-target executable selector must be an exact PATH command or absolute path",
    );
  }
  const timeoutSec = input.timeoutSec ?? 15;
  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) {
    throw new Error(
      "Execution-target executable probe timeout must be positive",
    );
  }

  let candidate = input.selector;
  if (!absoluteSelector) {
    const selected = await runAdapterExecutionTargetShellCommand(
      input.runId,
      input.target,
      `command -v ${shellQuote(input.selector)}`,
      { cwd: input.cwd, env: {}, timeoutSec },
    );
    if (selected.timedOut || selected.exitCode !== 0) {
      throw new Error(
        `Execution target does not expose required executable ${JSON.stringify(input.selector)}`,
      );
    }
    candidate = /^([^\r\n]+)\r?\n?$/.exec(selected.stdout)?.[1] ?? "";
  }
  if (
    candidate.length === 0 ||
    candidate !== candidate.trim() ||
    !path.isAbsolute(candidate)
  ) {
    throw new Error("Execution target returned an ambiguous executable path");
  }

  const canonicalized = await runAdapterExecutionTargetProcess(
    input.runId,
    input.target,
    input.targetNodeExecutable,
    ["-e", TARGET_EXECUTABLE_CANONICALIZER, candidate],
    {
      cwd: input.cwd,
      env: {},
      timeoutSec,
      graceSec: 2,
      onLog: async () => {},
    },
  );
  if (canonicalized.timedOut || canonicalized.exitCode !== 0) {
    throw new Error("Execution-target executable canonicalization failed");
  }
  const executable = canonicalized.stdout;
  if (
    executable.length === 0 ||
    executable !== executable.trim() ||
    executable.includes("\n") ||
    executable.includes("\r") ||
    !path.isAbsolute(executable)
  ) {
    throw new Error(
      "Execution target returned an ambiguous canonical executable path",
    );
  }
  return executable;
}

export async function readAdapterExecutionTargetHomeDir(
  runId: string,
  target: AdapterExecutionTarget | null | undefined,
  options: AdapterExecutionTargetShellOptions,
): Promise<string | null> {
  const result = await runAdapterExecutionTargetShellCommand(
    runId,
    target,
    'printf %s "$HOME"',
    options,
  );
  const homeDir = result.stdout.trim();
  return homeDir.length > 0 ? homeDir : null;
}

export async function ensureAdapterExecutionTargetDirectory(
  _runId: string,
  _target: AdapterExecutionTarget | null | undefined,
  cwd: string,
  options: AdapterExecutionTargetShellOptions & {
    createIfMissing?: boolean;
  },
): Promise<void> {
  await ensureAbsoluteDirectory(cwd, {
    createIfMissing: options.createIfMissing ?? false,
  });
}

function parseObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

export function parseAdapterExecutionTarget(
  value: unknown,
): AdapterExecutionTarget | null {
  const parsed = parseObject(value);
  if (parsed.kind !== "local") return null;
  return {
    kind: "local",
    leaseId: readString(parsed.leaseId),
  };
}

export function readAdapterExecutionTarget(input: {
  executionTarget?: unknown;
}): AdapterExecutionTarget | null {
  return parseAdapterExecutionTarget(input.executionTarget);
}
