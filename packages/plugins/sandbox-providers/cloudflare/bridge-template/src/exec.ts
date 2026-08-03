import type { Sandbox as CloudflareSandbox } from "@cloudflare/sandbox";
import { shellQuote } from "./helpers.js";
import { isTimeoutError } from "./sandboxes.js";
import { cleanupTimedOutExecution, resolveExecutionTarget, type SessionStrategy } from "./sessions.js";

export interface BridgeExecuteParams {
  sandbox: CloudflareSandbox;
  executionId?: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string | null;
  timeoutMs?: number;
  sessionStrategy: SessionStrategy;
  sessionId?: string;
  onOutput?: (stream: "stdout" | "stderr", data: string) => void | Promise<void>;
}

function requireExecutionId(executionId: string): string {
  if (typeof executionId !== "string" || executionId.length === 0 || executionId.length > 512) {
    throw new Error("Cloudflare bridge executionId must be 1-512 characters.");
  }
  return executionId;
}

function executionControlDir(executionId: string): string {
  const bytes = new TextEncoder().encode(requireExecutionId(executionId));
  const token = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `/tmp/.paperclip-execution-${token}`;
}

function wrapCancellableCommand(executionId: string, commandScript: string): string {
  const controlDir = executionControlDir(executionId);
  const commandRunner = (kind: "group" | "process") => [
    `paperclip_control=${shellQuote(controlDir)}`,
    `printf ${shellQuote(`${kind}:%s\\n`)} "$$" > "$paperclip_control/pid"`,
    'if [ -f "$paperclip_control/cancelled" ]; then exit 130; fi',
    `exec sh -c ${shellQuote(commandScript)}`,
  ].join("\n");
  return [
    `paperclip_control=${shellQuote(controlDir)}`,
    'mkdir -p "$paperclip_control"',
    'paperclip_cleanup() { rm -rf -- "$paperclip_control"; }',
    "trap paperclip_cleanup EXIT",
    'if [ -f "$paperclip_control/cancelled" ]; then exit 130; fi',
    "if command -v setsid >/dev/null 2>&1; then",
    `  setsid sh -c ${shellQuote(commandRunner("group"))} &`,
    "else",
    `  sh -c ${shellQuote(commandRunner("process"))} &`,
    "fi",
    "paperclip_pid=$!",
    'wait "$paperclip_pid"',
    "exit $?",
  ].join("\n");
}

function buildCancelCommand(executionId: string): string {
  const controlDir = executionControlDir(executionId);
  return [
    `paperclip_control=${shellQuote(controlDir)}`,
    'mkdir -p "$paperclip_control"',
    ': > "$paperclip_control/cancelled"',
    "paperclip_wait=0",
    'while [ ! -s "$paperclip_control/pid" ] && [ "$paperclip_wait" -lt 100 ]; do sleep 0.02; paperclip_wait=$((paperclip_wait + 1)); done',
    'if [ ! -s "$paperclip_control/pid" ]; then exit 0; fi',
    'IFS=: read -r paperclip_kind paperclip_pid < "$paperclip_control/pid"',
    'case "$paperclip_pid" in ""|*[!0-9]*) exit 0 ;; esac',
    'paperclip_alive() { if [ "$paperclip_kind" = "group" ]; then kill -0 "-$paperclip_pid" 2>/dev/null; else kill -0 "$paperclip_pid" 2>/dev/null; fi; }',
    'paperclip_signal() { if [ "$paperclip_kind" = "group" ]; then kill "-$1" "-$paperclip_pid" 2>/dev/null || true; else kill "-$1" "$paperclip_pid" 2>/dev/null || true; fi; }',
    'if paperclip_alive; then paperclip_signal TERM; fi',
    "paperclip_wait=0",
    'while paperclip_alive && [ "$paperclip_wait" -lt 50 ]; do sleep 0.1; paperclip_wait=$((paperclip_wait + 1)); done',
    'if paperclip_alive; then paperclip_signal KILL; fi',
    "exit 0",
  ].join("\n");
}

function isValidShellEnvKey(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function randomToken(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (typeof uuid === "string" && uuid.length > 0) return uuid.replace(/[^a-zA-Z0-9-]/g, "");
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function buildLoginShellScript(input: {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdinFile?: string | null;
}): string {
  const env = input.env ?? {};
  for (const key of Object.keys(env)) {
    if (!isValidShellEnvKey(key)) {
      throw new Error(`Invalid sandbox environment variable key: ${key}`);
    }
  }

  const configuredHome =
    env.HOME?.trim() || env.USERPROFILE?.trim() || null;
  const effectiveEnv = { ...env };
  if (configuredHome) {
    effectiveEnv.HOME ??= configuredHome;
    effectiveEnv.USERPROFILE ??= configuredHome;
  }
  const envArgs = Object.entries(effectiveEnv)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([key, value]) => `${key}=${shellQuote(value)}`);
  const commandParts = [shellQuote(input.command), ...input.args.map(shellQuote)].join(" ");
  const stdinRedirect = input.stdinFile ? ` < ${shellQuote(input.stdinFile)}` : "";
  const lines = [
    'if [ -f /etc/profile ]; then . /etc/profile >/dev/null 2>&1 || true; fi',
  ];
  if (input.cwd) {
    lines.push(`cd ${shellQuote(input.cwd)}`);
  }
  if (!configuredHome) {
    lines.push(
      'paperclip_provider_home="$(mktemp -d /tmp/paperclip-provider-home.XXXXXX)"',
      'trap \'rm -rf -- "$paperclip_provider_home"\' EXIT',
    );
  }
  const privateHomeArgs = configuredHome
    ? ""
    : ' HOME="$paperclip_provider_home" USERPROFILE="$paperclip_provider_home"';
  const execPrefix = configuredHome ? "exec " : "";
  const execLine =
    `${execPrefix}env -i PATH="$PATH"${privateHomeArgs}` +
    `${envArgs.length > 0 ? ` ${envArgs.join(" ")}` : ""} ${commandParts}${stdinRedirect}`;
  lines.push(execLine);
  return lines.join(" && ");
}

function coerceExecuteResult(result: {
  success?: boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
}) {
  return {
    exitCode:
      typeof result.exitCode === "number" || result.exitCode === null
        ? result.exitCode
        : result.success === false
          ? 1
          : 0,
    signal: null,
    timedOut: false,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export async function executeInSandbox(params: BridgeExecuteParams) {
  // The @cloudflare/sandbox SDK's exec() takes a single command string and a
  // narrow option set ({ cwd, env, timeout, ... }) — it does not accept `args`
  // or `stdin`. We compose the full shell command ourselves and stage stdin
  // through a temp file in the sandbox when the caller provides one.
  const stdinPayload = typeof params.stdin === "string" && params.stdin.length > 0
    ? params.stdin
    : null;
  const stdinFile = stdinPayload ? `/tmp/.paperclip-bridge-stdin-${randomToken()}` : null;

  if (stdinFile && stdinPayload) {
    await params.sandbox.writeFile(stdinFile, stdinPayload, { encoding: "utf8" });
  }

  try {
    const target = await resolveExecutionTarget(params.sandbox, {
      sessionStrategy: params.sessionStrategy,
      sessionId: params.sessionId,
      cwd: params.cwd,
      env: params.env,
      timeoutMs: params.timeoutMs,
    });
    const script = buildLoginShellScript({
      command: params.command,
      args: params.args ?? [],
      cwd: params.cwd,
      env: params.env,
      stdinFile,
    });
    const fullCommand = `sh -lc ${shellQuote(
      wrapCancellableCommand(params.executionId ?? `bridge-${randomToken()}`, script),
    )}`;
    const result = await target.exec(fullCommand, {
      cwd: "/",
      timeout: params.timeoutMs,
      ...(typeof params.onOutput === "function"
        ? {
            stream: true,
            onOutput: params.onOutput,
          }
        : {}),
    });
    return coerceExecuteResult(result);
  } catch (error) {
    if (isTimeoutError(error)) {
      await cleanupTimedOutExecution(params.sandbox, {
        sessionStrategy: params.sessionStrategy,
        sessionId: params.sessionId,
      });
      return {
        exitCode: null,
        signal: null,
        timedOut: true,
        stdout: typeof (error as { stdout?: unknown }).stdout === "string" ? (error as { stdout: string }).stdout : "",
        stderr: `${error instanceof Error ? error.message : String(error)}\n`,
      };
    }
    throw error;
  } finally {
    if (stdinFile) {
      await params.sandbox.deleteFile?.(stdinFile).catch(() => undefined);
    }
  }
}

export async function cancelExecutionInSandbox(params: {
  sandbox: CloudflareSandbox;
  executionId: string;
  timeoutMs?: number;
}): Promise<boolean> {
  const result = await params.sandbox.exec(
    `sh -lc ${shellQuote(buildCancelCommand(params.executionId))}`,
    {
      cwd: "/",
      timeout: params.timeoutMs,
    },
  );
  const coerced = coerceExecuteResult(result);
  return !coerced.timedOut && coerced.exitCode === 0;
}
