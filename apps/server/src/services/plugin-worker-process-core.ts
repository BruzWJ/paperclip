import { fork, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { PLUGIN_RPC_ERROR_CODES, createErrorResponse } from "@paperclipai/plugin-sdk";
import * as workerCore from "./plugin-worker-foundation.js";

export function buildPluginWorkerProcessCore(scope: any) {
  const {
    pluginId,
    options,
    log,
    state,
    pendingRequests,
    activeInvocations,
    setStatus,
    handleLine,
    startInternal,
  } = scope;

  // -----------------------------------------------------------------------
  // Process lifecycle
  // -----------------------------------------------------------------------

  function spawnProcess(): ChildProcess {
    // Security: Do NOT spread process.env into the worker. Plugins should only
    // receive a minimal, controlled environment to prevent leaking host
    // secrets (like DATABASE_URL, internal API keys, etc.).
    const workerEnv: Record<string, string> = {
      ...options.env,
      PATH: process.env.PATH ?? "",
      NODE_PATH: process.env.NODE_PATH ?? "",
      PAPERCLIP_PLUGIN_ID: pluginId,
      NODE_ENV: process.env.NODE_ENV ?? "production",
      TZ: process.env.TZ ?? "UTC",
    };

    const child = fork(options.entrypointPath, [], {
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      env: workerEnv,
      // Don't let the child keep the parent alive
      detached: false,
    });

    return child;
  }

  function attachStdioHandlers(child: ChildProcess): void {
    // Read NDJSON from stdout
    if (child.stdout) {
      state.readline = createInterface({ input: child.stdout });
      state.readline.on("line", handleLine);
    }

    // Capture stderr for logging
    if (child.stderr) {
      state.stderrReadline = createInterface({ input: child.stderr });
      state.stderrReadline.on("line", (line: string) => {
        state.stderrExcerpt = workerCore.appendStderrExcerpt(state.stderrExcerpt, line);
        log.warn({ stream: "stderr" }, `[plugin stderr] ${line}`);
      });
    }

    // Handle process exit
    child.on("exit", (code, signal) => {
      void handleProcessExit(code, signal).catch((err) => {
        log.error({ err: err instanceof Error ? err.message : String(err) }, "worker exit handling failed");
      });
    });

    // Handle process errors (e.g. spawn failure)
    child.on("error", (err) => {
      log.error({ err: err.message }, "worker process error");
      if (state.status === "starting") {
        setStatus("crashed");
        rejectAllPending(
          new Error(
            workerCore.formatWorkerFailureMessage(
              `Worker process failed to start: ${err.message}`,
              state.stderrExcerpt,
            ),
          ),
        );
      }
    });
  }

  async function handleProcessExit(code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    const wasIntentional = state.intentionalStop;

    // Clean up state.readline interfaces
    if (state.readline) {
      state.readline.close();
      state.readline = null;
    }
    if (state.stderrReadline) {
      state.stderrReadline.close();
      state.stderrReadline = null;
    }
    state.childProcess = null;
    state.startedAt = null;
    state.supportedMethods = workerCore.NO_OPTIONAL_WORKER_METHODS;

    // Reject all pending requests
    const exitError =
      state.protocolViolationError ??
      new Error(
        workerCore.formatWorkerFailureMessage(
          `Worker process exited (code=${code}, signal=${signal})`,
          state.stderrExcerpt,
        ),
      );
    state.protocolViolationError = null;
    rejectAllPending(exitError);

    if (wasIntentional) {
      // Graceful stop — state.status is already "stopping" or will be set to "stopped"
      setStatus("stopped");
      log.info({ code, signal }, "worker process stopped");
      return;
    }

    await recordUnexpectedCrash(code, signal);
  }

  async function recordUnexpectedCrash(code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    state.totalCrashes++;
    const now = Date.now();

    // Reset consecutive crash counter if enough time passed
    if (state.lastCrashAt !== null && now - state.lastCrashAt > workerCore.CRASH_WINDOW_MS) {
      state.consecutiveCrashes = 0;
    }
    state.consecutiveCrashes++;
    state.lastCrashAt = now;

    log.error(
      {
        code,
        signal,
        consecutiveCrashes: state.consecutiveCrashes,
        totalCrashes: state.totalCrashes,
      },
      "worker process crashed",
    );

    const willRestart = state.consecutiveCrashes <= workerCore.MAX_CONSECUTIVE_CRASHES;

    setStatus("crashed");

    if (willRestart) {
      scheduleRestart();
    } else {
      log.error(
        {
          consecutiveCrashes: state.consecutiveCrashes,
          maxCrashes: workerCore.MAX_CONSECUTIVE_CRASHES,
        },
        "max consecutive crashes reached, not restarting",
      );
      state.terminalCrashFailure = {
        code,
        signal,
        stderrExcerpt: state.stderrExcerpt,
      };
      await persistTerminalCrash(state.terminalCrashFailure);
    }
  }

  async function persistTerminalCrash(
    failure: Parameters<workerCore.WorkerStartOptions["onTerminalCrash"]>[0],
  ): Promise<void> {
    if (state.terminalCrashReported) return;
    if (state.terminalCrashPersistence) {
      await state.terminalCrashPersistence;
      return;
    }

    const attempt = Promise.resolve().then(() => options.onTerminalCrash(failure));
    state.terminalCrashPersistence = attempt;
    try {
      await attempt;
      state.terminalCrashReported = true;
      state.terminalCrashFailure = null;
    } finally {
      if (state.terminalCrashPersistence === attempt) {
        state.terminalCrashPersistence = null;
      }
    }
  }

  function rejectAllPending(error: Error): void {
    for (const pending of pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.resolve(
        createErrorResponse(pending.id, PLUGIN_RPC_ERROR_CODES.WORKER_UNAVAILABLE, error.message),
      );
    }
    pendingRequests.clear();
    for (const invocation of activeInvocations.values()) {
      if (invocation.timer) clearTimeout(invocation.timer);
    }
    activeInvocations.clear();
  }

  // -----------------------------------------------------------------------
  // Crash recovery with exponential backoff
  // -----------------------------------------------------------------------

  function computeBackoffMs(): number {
    // Exponential backoff: MIN_BACKOFF * MULTIPLIER^(state.consecutiveCrashes - 1)
    const delay =
      workerCore.MIN_BACKOFF_MS * Math.pow(workerCore.BACKOFF_MULTIPLIER, state.consecutiveCrashes - 1);
    // Add jitter: ±25%
    const jitter = delay * 0.25 * (Math.random() * 2 - 1);
    return Math.min(Math.round(delay + jitter), workerCore.MAX_BACKOFF_MS);
  }

  function scheduleRestart(): void {
    if (state.explicitStopRequested || state.backoffTimer !== null) return;

    const delay = computeBackoffMs();
    state.nextRestartAt = Date.now() + delay;

    setStatus("backoff");

    log.info(
      { delayMs: delay, consecutiveCrashes: state.consecutiveCrashes },
      "scheduling restart with backoff",
    );

    state.backoffTimer = setTimeout(async () => {
      state.backoffTimer = null;
      state.nextRestartAt = null;
      const crashCountBeforeStart = state.totalCrashes;
      try {
        await startInternal();
      } catch (err) {
        log.error({ err: err instanceof Error ? err.message : String(err) }, "restart after backoff failed");
        if (!state.explicitStopRequested && state.totalCrashes === crashCountBeforeStart) {
          try {
            await recordUnexpectedCrash(null, null);
          } catch (persistenceError) {
            log.error(
              {
                err: persistenceError instanceof Error ? persistenceError.message : String(persistenceError),
              },
              "worker restart failure persistence failed",
            );
          }
        }
      }
    }, delay);
  }

  function cancelPendingRestart(): void {
    if (state.backoffTimer !== null) {
      clearTimeout(state.backoffTimer);
      state.backoffTimer = null;
      state.nextRestartAt = null;
    }
  }

  return {
    spawnProcess,
    attachStdioHandlers,
    handleProcessExit,
    recordUnexpectedCrash,
    persistTerminalCrash,
    rejectAllPending,
    computeBackoffMs,
    scheduleRestart,
    cancelPendingRestart,
  };
}
