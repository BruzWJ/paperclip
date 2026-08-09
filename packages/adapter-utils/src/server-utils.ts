import { spawn, type ChildProcess } from "node:child_process";
import { constants as fsConstants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildLocalProcessSandboxSpawnTarget,
  type LocalProcessSandboxOptions,
} from "./local-process-sandbox.js";

export interface RunProcessResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  pid: number | null;
  startedAt: string | null;
}

interface RunningProcess {
  child: ChildProcess;
  processGroupId: number | null;
}

interface SpawnTarget {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  cleanup?: () => Promise<void>;
}

type ChildProcessWithEvents = ChildProcess & {
  on(event: "error", listener: (err: Error) => void): ChildProcess;
  on(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): ChildProcess;
  on(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): ChildProcess;
};

function resolveProcessGroupId(child: ChildProcess) {
  if (process.platform === "win32") return null;
  return typeof child.pid === "number" && child.pid > 0 ? child.pid : null;
}

function signalRunningProcess(
  running: Pick<RunningProcess, "child" | "processGroupId">,
  signal: NodeJS.Signals,
) {
  if (process.platform !== "win32" && running.processGroupId && running.processGroupId > 0) {
    try {
      process.kill(-running.processGroupId, signal);
      return;
    } catch {
      // Fall back to the direct child signal if group signaling fails.
    }
  }
  // Gate on real liveness: `child.killed` only means a signal was sent, not that
  // the process exited, so escalating on it would suppress a follow-up SIGKILL.
  // `exitCode`/`signalCode` are null until the child actually closes.
  if (running.child.exitCode === null && running.child.signalCode === null) {
    running.child.kill(signal);
  }
}

function abortedProcessError(): Error {
  const error = new Error("Adapter execution was cancelled");
  error.name = "AbortError";
  return error;
}

const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;

export function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

export function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

export function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function appendWithCap(prev: string, chunk: string, cap = MAX_CAPTURE_BYTES) {
  const combined = prev + chunk;
  return combined.length > cap ? combined.slice(combined.length - cap) : combined;
}

function resumeReadable(readable: { resume: () => unknown; destroyed?: boolean } | null | undefined) {
  if (!readable || readable.destroyed) return;
  readable.resume();
}

function resolvePathValue(obj: Record<string, unknown>, dottedPath: string) {
  const parts = dottedPath.split(".");
  let cursor: unknown = obj;

  for (const part of parts) {
    if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) {
      return "";
    }
    cursor = (cursor as Record<string, unknown>)[part];
  }

  if (cursor === null || cursor === undefined) return "";
  if (typeof cursor === "string") return cursor;
  if (typeof cursor === "number" || typeof cursor === "boolean") return String(cursor);

  try {
    return JSON.stringify(cursor);
  } catch {
    return "";
  }
}

export function renderTemplate(template: string, data: Record<string, unknown>) {
  return template.replace(/{{\s*([a-zA-Z0-9_.-]+)\s*}}/g, (_, path) => resolvePathValue(data, path));
}

const PROVIDER_NATIVE_INHERITED_ENV_PREFIX =
  /^(?:AI21|ANTHROPIC|AWS|AZURE|CLAUDE|CLOUDSDK|CODEX|COHERE|CURSOR|DEEPSEEK|FIREWORKS|GCLOUD|GEMINI|GOOGLE|GROK|GROQ|HF|HUGGINGFACE|HUGGING_FACE|MISTRAL|OLLAMA|OPENAI|OPENCODE|OPENROUTER|PERPLEXITY|PI_CODING_AGENT|REPLICATE|TOGETHER|VERTEX|XAI)_/i;
const PROVIDER_NATIVE_INHERITED_HOME_KEYS = new Set([
  "APPDATA",
  "HOME",
  "LOCALAPPDATA",
  "USERPROFILE",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
]);
const SENSITIVE_INHERITED_ENV_KEY =
  /(?:^|_)(?:API_?KEY|AUTHORIZATION|COOKIE|CREDENTIALS?|PASSW(?:OR)?D|SECRET|TOKEN)(?:_|$)/i;

/**
 * Build the ordinary host environment a provider child needs without treating
 * the Paperclip server's own environment as implicit provider configuration.
 *
 * Provider-native credentials, configuration selectors, model selectors, and
 * home/config roots must come from the explicit adapter environment layered on
 * after this function. They are never inherited from the server process.
 */
export function sanitizeInheritedProviderChildEnv(
  baseEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  for (const key of Object.keys(env)) {
    const normalizedKey = key.toUpperCase();
    if (
      normalizedKey.startsWith("PAPERCLIP_") ||
      /^(?:AGENT|PAPERCLIP)[_-]?HOME$/i.test(normalizedKey) ||
      PROVIDER_NATIVE_INHERITED_HOME_KEYS.has(normalizedKey) ||
      PROVIDER_NATIVE_INHERITED_ENV_PREFIX.test(normalizedKey) ||
      SENSITIVE_INHERITED_ENV_KEY.test(normalizedKey) ||
      /^(?:AI|LLM|MODEL)(?:_|$)/i.test(normalizedKey)
    ) {
      delete env[key];
    }
  }
  return env;
}

function defaultPathForPlatform() {
  if (process.platform === "win32") {
    return "C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\Wbem";
  }
  return "/usr/local/bin:/opt/homebrew/bin:/usr/local/sbin:/usr/bin:/bin:/usr/sbin:/sbin";
}

function windowsPathExts(env: NodeJS.ProcessEnv): string[] {
  return (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean);
}

async function pathExists(candidate: string) {
  try {
    await fs.access(candidate, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveCommandPath(command: string, cwd: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const hasPathSeparator = command.includes("/") || command.includes("\\");
  if (hasPathSeparator) {
    const absolute = path.isAbsolute(command) ? command : path.resolve(cwd, command);
    return (await pathExists(absolute)) ? absolute : null;
  }

  const pathValue = env.PATH ?? env.Path ?? "";
  const delimiter = process.platform === "win32" ? ";" : ":";
  const dirs = pathValue.split(delimiter).filter(Boolean);
  const exts = process.platform === "win32" ? windowsPathExts(env) : [""];
  const hasExtension = process.platform === "win32" && path.extname(command).length > 0;

  for (const dir of dirs) {
    const candidates =
      process.platform === "win32"
        ? hasExtension
          ? [path.join(dir, command)]
          : exts.map((ext) => path.join(dir, `${command}${ext}`))
        : [path.join(dir, command)];
    for (const candidate of candidates) {
      if (await pathExists(candidate)) return candidate;
    }
  }

  return null;
}

export async function resolveCommandForLogs(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  return (await resolveCommandPath(command, cwd, env)) ?? command;
}

function quoteForCmd(arg: string) {
  if (!arg.length) return '""';
  const escaped = arg.replace(/"/g, '""');
  return /[\s"&<>|^()]/.test(escaped) ? `"${escaped}"` : escaped;
}

function resolveWindowsCmdShell(env: NodeJS.ProcessEnv): string {
  const fallbackRoot = env.SystemRoot || process.env.SystemRoot || "C:\\Windows";
  return path.join(fallbackRoot, "System32", "cmd.exe");
}

async function resolveSpawnTarget(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  options: {
    localProcessSandbox?: LocalProcessSandboxOptions | null;
  } = {},
): Promise<SpawnTarget> {
  const resolved = await resolveCommandPath(command, cwd, env);
  const executable = resolved ?? command;

  if (options.localProcessSandbox) {
    if (!resolved) {
      throw new Error(`Command not found in PATH: "${command}"`);
    }
    const requestedSandboxCommand = options.localProcessSandbox.command?.trim() || "bwrap";
    const sandboxCommand = await resolveCommandPath(requestedSandboxCommand, cwd, env);
    if (!sandboxCommand) {
      throw new Error(
        `Local process confinement requires Bubblewrap, but "${requestedSandboxCommand}" was not found in PATH. Install bwrap or configure filesystemSandboxCommand.`,
      );
    }
    const sandboxTarget = await buildLocalProcessSandboxSpawnTarget({
      executable,
      args,
      cwd,
      options: options.localProcessSandbox,
    });
    return { ...sandboxTarget, command: sandboxCommand };
  }

  if (process.platform !== "win32") {
    return { command: executable, args };
  }

  if (/\.(cmd|bat)$/i.test(executable)) {
    // Always use cmd.exe for .cmd/.bat wrappers. Some environments override
    // ComSpec to PowerShell, which breaks cmd-specific flags like /d /s /c.
    const shell = resolveWindowsCmdShell(env);
    const commandLine = [quoteForCmd(executable), ...args.map(quoteForCmd)].join(" ");
    return {
      command: shell,
      args: ["/d", "/s", "/c", commandLine],
    };
  }

  return { command: executable, args };
}

function ensurePathInEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (typeof env.PATH === "string" && env.PATH.length > 0) return env;
  if (typeof env.Path === "string" && env.Path.length > 0) return env;
  return { ...env, PATH: defaultPathForPlatform() };
}

export async function ensureAbsoluteDirectory(
  cwd: string,
  opts: { createIfMissing?: boolean } = {},
) {
  if (!path.isAbsolute(cwd)) {
    throw new Error(`Working directory must be an absolute path: "${cwd}"`);
  }

  const assertDirectory = async () => {
    const stats = await fs.stat(cwd);
    if (!stats.isDirectory()) {
      throw new Error(`Working directory is not a directory: "${cwd}"`);
    }
  };

  try {
    await assertDirectory();
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (!opts.createIfMissing || code !== "ENOENT") {
      if (code === "ENOENT") {
        throw new Error(`Working directory does not exist: "${cwd}"`);
      }
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  try {
    await fs.mkdir(cwd, { recursive: true });
    await assertDirectory();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not create working directory "${cwd}": ${reason}`);
  }
}


export async function ensureCommandResolvable(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
) {
  const resolved = await resolveCommandPath(command, cwd, env);
  if (resolved) return;
  if (command.includes("/") || command.includes("\\")) {
    const absolute = path.isAbsolute(command) ? command : path.resolve(cwd, command);
    throw new Error(`Command is not executable: "${command}" (resolved: "${absolute}")`);
  }
  throw new Error(`Command not found in PATH: "${command}"`);
}

export async function runChildProcess(
  runId: string,
  command: string,
  args: string[],
  opts: {
    cwd: string;
    env: Record<string, string>;
    timeoutSec: number;
    graceSec: number;
    onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
    onLogError?: (err: unknown, runId: string, message: string) => void;
    onSpawn?: (meta: { pid: number; processGroupId: number | null; startedAt: string }) => Promise<void>;
    abortSignal?: AbortSignal;
    stdin?: string;
    localProcessSandbox?: LocalProcessSandboxOptions | null;
  },
): Promise<RunProcessResult> {
  if (opts.abortSignal?.aborted) {
    throw abortedProcessError();
  }
  const onLogError = opts.onLogError ?? ((err, id, msg) => console.warn({ err, runId: id }, msg));
  const configuredHome =
    opts.localProcessSandbox?.homeDir?.trim() ||
    opts.env.HOME?.trim() ||
    opts.env.USERPROFILE?.trim() ||
    null;
  const temporaryHome = configuredHome
    ? null
    : await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-provider-home-"));
  const invocationHome = configuredHome ?? temporaryHome!;

  try {
    return await new Promise<RunProcessResult>((resolve, reject) => {
      const rawMerged: NodeJS.ProcessEnv = {
        ...sanitizeInheritedProviderChildEnv(process.env),
        ...opts.env,
      };

      const mergedEnv = ensurePathInEnv(rawMerged);
      mergedEnv.HOME ??= invocationHome;
      mergedEnv.USERPROFILE ??= invocationHome;
      void resolveSpawnTarget(command, args, opts.cwd, mergedEnv, {
        localProcessSandbox: opts.localProcessSandbox ?? null,
      })
      .then((target) => {
        if (opts.abortSignal?.aborted) {
          void target.cleanup?.();
          throw abortedProcessError();
        }
        const childEnv = { ...mergedEnv, ...target.env };
        for (const [key, value] of Object.entries(childEnv)) {
          if (value === undefined) delete childEnv[key];
        }
        const child = spawn(target.command, target.args, {
          cwd: target.cwd ?? opts.cwd,
          env: childEnv,
          detached: process.platform !== "win32",
          shell: false,
          stdio: [opts.stdin != null ? "pipe" : "ignore", "pipe", "pipe"],
        }) as ChildProcessWithEvents;
        const startedAt = new Date().toISOString();
        const processGroupId = resolveProcessGroupId(child);

        const spawnPersistPromise =
          typeof child.pid === "number" && child.pid > 0 && opts.onSpawn
            ? opts.onSpawn({ pid: child.pid, processGroupId, startedAt }).catch((err) => {
              onLogError(err, runId, "failed to record child process metadata");
            })
            : Promise.resolve();

        const runningProcess = {
          child,
          processGroupId,
        };

        let timedOut = false;
        let stdout = "";
        let stderr = "";
        let logChain: Promise<void> = Promise.resolve();
        let abortKillTimer: NodeJS.Timeout | null = null;

        const stopForAbort = () => {
          if (abortKillTimer) return;
          signalRunningProcess(runningProcess, "SIGTERM");
          abortKillTimer = setTimeout(() => {
            abortKillTimer = null;
            signalRunningProcess(runningProcess, "SIGKILL");
          }, Math.max(1, opts.graceSec) * 1_000);
          abortKillTimer.unref?.();
        };

        const clearAbortCancellation = () => {
          opts.abortSignal?.removeEventListener("abort", stopForAbort);
          if (abortKillTimer) clearTimeout(abortKillTimer);
          abortKillTimer = null;
        };

        const timeout =
          opts.timeoutSec > 0
            ? setTimeout(() => {
                timedOut = true;
                signalRunningProcess({ child, processGroupId }, "SIGTERM");
                setTimeout(() => {
                  signalRunningProcess({ child, processGroupId }, "SIGKILL");
                }, Math.max(1, opts.graceSec) * 1000);
              }, opts.timeoutSec * 1000)
            : null;

        child.stdout?.on("data", (chunk: unknown) => {
          const readable = child.stdout;
          if (!readable) return;
          readable.pause();
          const text = String(chunk);
          stdout = appendWithCap(stdout, text);
          logChain = logChain
            .then(() => opts.onLog("stdout", text))
            .catch((err) => onLogError(err, runId, "failed to append stdout log chunk"))
            .finally(() => {
              resumeReadable(readable);
            });
        });

        child.stderr?.on("data", (chunk: unknown) => {
          const readable = child.stderr;
          if (!readable) return;
          readable.pause();
          const text = String(chunk);
          stderr = appendWithCap(stderr, text);
          logChain = logChain
            .then(() => opts.onLog("stderr", text))
            .catch((err) => onLogError(err, runId, "failed to append stderr log chunk"))
            .finally(() => {
              resumeReadable(readable);
            });
        });

        const stdin = child.stdin;
        if (opts.stdin != null && stdin) {
          void spawnPersistPromise.finally(() => {
            if (
              child.killed ||
              stdin.destroyed ||
              opts.abortSignal?.aborted
            ) {
              return;
            }
            stdin.write(opts.stdin as string);
            stdin.end();
          });
        }

        child.on("error", (err: Error) => {
          if (timeout) clearTimeout(timeout);
          clearAbortCancellation();
          void target.cleanup?.();
          const errno = (err as NodeJS.ErrnoException).code;
          const pathValue = mergedEnv.PATH ?? mergedEnv.Path ?? "";
          const msg =
            errno === "ENOENT"
              ? `Failed to start command "${command}" in "${opts.cwd}". Verify adapter command, working directory, and PATH (${pathValue}).`
              : `Failed to start command "${command}" in "${opts.cwd}": ${err.message}`;
          reject(new Error(msg));
        });

        child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
          if (timeout) clearTimeout(timeout);
          clearAbortCancellation();
          void logChain.finally(() => {
            void Promise.resolve()
              .then(() => target.cleanup?.())
              .finally(() => {
                resolve({
                  exitCode: code,
                  signal,
                  timedOut,
                  stdout,
                  stderr,
                  pid: child.pid ?? null,
                  startedAt,
                });
              });
          });
        });
        if (opts.abortSignal?.aborted) {
          stopForAbort();
        } else {
          opts.abortSignal?.addEventListener("abort", stopForAbort, {
            once: true,
          });
        }
      })
      .catch(reject);
    });
  } finally {
    if (temporaryHome) {
      await fs.rm(temporaryHome, { recursive: true, force: true });
    }
  }
}
