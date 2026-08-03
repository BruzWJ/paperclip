import type {
  PluginEnvironmentCancelExecutionParams,
  PluginEnvironmentCancelExecutionResult,
  PluginEnvironmentExecuteParams,
} from "./protocol.js";

interface ActiveEnvironmentExecution {
  readonly companyId: string;
  readonly environmentId: string;
  readonly providerLeaseId: string | null;
  readonly executionId: string;
  readonly cancel: (reason: string) => Promise<void>;
  cancellation: Promise<void> | null;
}

function requireExecutionId(executionId: string): string {
  if (typeof executionId !== "string" || executionId.length === 0) {
    throw new Error("Environment executionId must be a non-empty opaque string.");
  }
  if (executionId.length > 512) {
    throw new Error("Environment executionId exceeds the 512-character limit.");
  }
  return executionId;
}

function sameExecutionScope(
  entry: ActiveEnvironmentExecution,
  params: PluginEnvironmentCancelExecutionParams,
): boolean {
  return entry.companyId === params.companyId
    && entry.environmentId === params.environmentId
    && entry.providerLeaseId === params.lease.providerLeaseId
    && entry.executionId === params.executionId;
}

function executionScopeKey(input: {
  companyId: string;
  environmentId: string;
  lease: { providerLeaseId: string | null };
  executionId: string;
}): string {
  return JSON.stringify([
    input.companyId,
    input.environmentId,
    input.lease.providerLeaseId,
    requireExecutionId(input.executionId),
  ]);
}

/**
 * Worker-local exact-command registry shared by sandbox providers.
 *
 * It intentionally tracks only active command identities and cancellation
 * callbacks. It never owns, releases, or destroys provider leases. Registering
 * happens synchronously before provider work starts, which lets a concurrent
 * cancellation request win even while execution is still connecting.
 */
export function createEnvironmentExecutionCancellationRegistry() {
  const active = new Map<string, ActiveEnvironmentExecution>();

  return {
    async execute<T>(
      params: PluginEnvironmentExecuteParams,
      handlers: {
        execute(): Promise<T>;
        cancel(reason: string): Promise<void>;
      },
    ): Promise<T> {
      const executionId = requireExecutionId(params.executionId);
      const key = executionScopeKey(params);
      if (active.has(key)) {
        throw new Error(`Environment execution "${executionId}" is already active.`);
      }

      const entry: ActiveEnvironmentExecution = {
        companyId: params.companyId,
        environmentId: params.environmentId,
        providerLeaseId: params.lease.providerLeaseId,
        executionId,
        cancel: handlers.cancel,
        cancellation: null,
      };
      active.set(key, entry);
      try {
        return await handlers.execute();
      } finally {
        if (active.get(key) === entry) {
          active.delete(key);
        }
      }
    },

    async cancel(
      params: PluginEnvironmentCancelExecutionParams,
      cancelUntracked?: (
        reason: string,
      ) => Promise<boolean>,
    ): Promise<PluginEnvironmentCancelExecutionResult> {
      const executionId = requireExecutionId(params.executionId);
      const entry = active.get(executionScopeKey(params));
      if (!entry || !sameExecutionScope(entry, params)) {
        return {
          executionId,
          cancelled:
            (await cancelUntracked?.(params.reason)) ?? false,
        };
      }
      entry.cancellation ??= Promise.resolve().then(() => entry.cancel(params.reason));
      await entry.cancellation;
      return { executionId, cancelled: true };
    },

    /** Test/conformance visibility only; no provider identity is exposed. */
    has(executionId: string): boolean {
      return [...active.values()].some((entry) => entry.executionId === executionId);
    },
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function executionControlToken(executionId: string): string {
  const bytes = new TextEncoder().encode(requireExecutionId(executionId));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Wraps one provider command in its own process group when `setsid` exists and
 * publishes a control file outside the workspace. The opaque execution id is
 * represented only by reversible-free hexadecimal path bytes and is never
 * copied into the child environment or stdin.
 */
export function wrapCancellableEnvironmentShellCommand(
  executionId: string,
  commandScript: string,
): string {
  const controlDir = `/tmp/.paperclip-execution-${executionControlToken(executionId)}`;
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

/**
 * Produces an idempotent exact-process stop script for the wrapper above.
 * Missing/pre-launch PID state is handled by leaving a cancellation marker;
 * the eventual wrapper observes it before or immediately after spawn.
 */
export function buildCancelEnvironmentShellCommand(
  executionId: string,
  termGraceMs = 5_000,
): string {
  const termWaitIterations = Math.max(
    0,
    Math.ceil(termGraceMs / 100),
  );
  const controlDir = `/tmp/.paperclip-execution-${executionControlToken(executionId)}`;
  return [
    `paperclip_control=${shellQuote(controlDir)}`,
    'mkdir -p "$paperclip_control"',
    ': > "$paperclip_control/cancelled"',
    "paperclip_wait=0",
    'while [ ! -s "$paperclip_control/pid" ] && [ "$paperclip_wait" -lt 100 ]; do',
    "  sleep 0.02",
    "  paperclip_wait=$((paperclip_wait + 1))",
    "done",
    'if [ ! -s "$paperclip_control/pid" ]; then exit 0; fi',
    'IFS=: read -r paperclip_kind paperclip_pid < "$paperclip_control/pid"',
    'case "$paperclip_pid" in ""|*[!0-9]*) exit 0 ;; esac',
    'paperclip_alive() { if [ "$paperclip_kind" = "group" ]; then kill -0 "-$paperclip_pid" 2>/dev/null; else kill -0 "$paperclip_pid" 2>/dev/null; fi; }',
    'paperclip_signal() { if [ "$paperclip_kind" = "group" ]; then kill "-$1" "-$paperclip_pid" 2>/dev/null || true; else kill "-$1" "$paperclip_pid" 2>/dev/null || true; fi; }',
    'if paperclip_alive; then paperclip_signal TERM; fi',
    "paperclip_wait=0",
    `while paperclip_alive && [ "$paperclip_wait" -lt ${termWaitIterations} ]; do`,
    "  sleep 0.1",
    "  paperclip_wait=$((paperclip_wait + 1))",
    "done",
    'if paperclip_alive; then paperclip_signal KILL; fi',
    "exit 0",
  ].join("\n");
}
