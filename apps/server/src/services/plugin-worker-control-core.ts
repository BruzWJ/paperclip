import { randomUUID } from "node:crypto";
import {
  JsonRpcCallError,
  PLUGIN_RPC_ERROR_CODES,
  createRequest,
  isJsonRpcSuccessResponse,
  type HostToWorkerMethodName,
  type HostToWorkerMethods,
  type HostToWorkerOptionalMethodName,
  type InitializeParams,
  type JsonRpcResponse,
  type PluginInvocationScope,
} from "@paperclipai/plugin-sdk";
import * as workerCore from "./plugin-worker-foundation.js";

export function buildPluginWorkerControlCore(scope: any) {
  const {
    pluginId,
    options,
    log,
    state,
    pendingRequests,
    rpcTimeoutMs,
    setStatus,
    sendMessage,
    deriveInvocationScope,
    registerInvocation,
    clearInvocation,
    spawnProcess,
    attachStdioHandlers,
    persistTerminalCrash,
    cancelPendingRestart,
  } = scope;

  // -----------------------------------------------------------------------
  // Start / Stop
  // -----------------------------------------------------------------------

  async function startInternal(): Promise<void> {
    if (
      state.status === "running" ||
      state.status === "starting" ||
      state.status === "stopping" ||
      (state.status === "backoff" && state.backoffTimer !== null)
    ) {
      throw new Error(`Worker for plugin "${pluginId}" is already ${state.status}`);
    }
    if (state.childProcess) {
      throw new Error(
        `Worker for plugin "${pluginId}" already owns process ${state.childProcess.pid ?? "unknown"}`,
      );
    }

    state.intentionalStop = false;
    state.explicitStopRequested = false;
    setStatus("starting");
    state.supportedMethods = workerCore.NO_OPTIONAL_WORKER_METHODS;
    state.stderrExcerpt = "";
    state.protocolViolationError = null;
    state.workerRpcIncarnationId = randomUUID();

    const child = spawnProcess();
    state.childProcess = child;
    attachStdioHandlers(child);
    state.startedAt = Date.now();

    const initParams: InitializeParams = {
      manifest: options.manifest,
      instanceInfo: options.instanceInfo,
      apiVersion: options.apiVersion,
      databaseNamespace: options.databaseNamespace,
    };

    try {
      const result: unknown = await callInternal("initialize", initParams, workerCore.INITIALIZE_TIMEOUT_MS);
      if (typeof result !== "object" || result === null || Array.isArray(result)) {
        throw new Error("Worker initialize must return an object");
      }
      const resultKeys = Object.keys(result);
      if (resultKeys.length !== 1 || resultKeys[0] !== "supportedMethods") {
        throw new Error("Worker initialize must return exactly supportedMethods");
      }
      const reportedMethods: unknown = (result as { supportedMethods: unknown }).supportedMethods;
      if (!Array.isArray(reportedMethods)) {
        throw new Error("Worker initialize must return a supportedMethods array");
      }
      const unknownMethod = reportedMethods.find(
        (method) => typeof method !== "string" || !workerCore.OPTIONAL_WORKER_METHODS.has(method),
      );
      if (unknownMethod !== undefined) {
        throw new Error(`Worker initialize reported unknown optional method: ${String(unknownMethod)}`);
      }
      if (new Set(reportedMethods).size !== reportedMethods.length) {
        throw new Error("Worker initialize reported duplicate supportedMethods");
      }
      state.supportedMethods = Object.freeze([...reportedMethods] as HostToWorkerOptionalMethodName[]);

      workerCore.assertManifestWorkerMethodAgreement(options.manifest, state.supportedMethods);

      const health = workerCore.decodePluginWorkerHealth(
        await callInternal("health", {}, workerCore.INITIALIZE_TIMEOUT_MS),
      );
      if (health.status !== "ok") {
        throw new Error(
          `Worker health check failed with status "${health.status}"${
            health.message ? `: ${health.message}` : ""
          }`,
        );
      }
    } catch (err) {
      // Activation failed — kill the process and propagate.
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, "worker activation failed");
      await killProcess();
      state.supportedMethods = workerCore.NO_OPTIONAL_WORKER_METHODS;
      if (state.backoffTimer === null) setStatus("crashed");
      throw new Error(`Worker activation failed for "${pluginId}": ${msg}`);
    }

    setStatus("running");
    log.info({ pid: child.pid }, "worker process started and initialized");
  }

  async function performStop(): Promise<void> {
    state.explicitStopRequested = true;
    cancelPendingRestart();

    if (state.status === "stopped" && !state.childProcess) {
      return;
    }

    state.intentionalStop = true;
    setStatus("stopping");

    if (!state.childProcess) {
      if (state.terminalCrashFailure) {
        await persistTerminalCrash(state.terminalCrashFailure);
      }
      setStatus("stopped");
      return;
    }

    // Step 1: Send shutdown RPC and wait for the worker to exit gracefully.
    // We race the shutdown call against a timeout. The worker should process
    // the shutdown and exit on its own within the drain period.
    try {
      await Promise.race([
        callInternal("shutdown", {} as Record<string, never>, workerCore.SHUTDOWN_DRAIN_MS),
        waitForExit(workerCore.SHUTDOWN_DRAIN_MS),
      ]);
    } catch {
      // Shutdown call failed or timed out — proceed to kill
      log.warn("shutdown RPC failed or timed out, escalating to SIGTERM");
    }

    // Give the process a brief moment to exit after the shutdown response
    if (state.childProcess) {
      await waitForExit(500);
    }

    // Check if process already exited
    if (!state.childProcess) {
      setStatus("stopped");
      return;
    }

    // Step 2: Send SIGTERM and wait
    log.info("worker did not exit after shutdown RPC, sending SIGTERM");
    await killWithSignal("SIGTERM", workerCore.SIGTERM_GRACE_MS);

    if (!state.childProcess) {
      setStatus("stopped");
      return;
    }

    // Step 3: Forcefully kill with SIGKILL
    log.warn("worker did not exit after SIGTERM, sending SIGKILL");
    await killWithSignal("SIGKILL", 2_000);
    assertProcessExitedAfterSigkill();

    setStatus("stopped");
  }

  function stopInternal(): Promise<void> {
    if (state.stopAttempt) return state.stopAttempt;

    const attempt = performStop();
    state.stopAttempt = attempt;
    const clearAttempt = () => {
      if (state.stopAttempt === attempt) state.stopAttempt = null;
    };
    void attempt.then(clearAttempt, clearAttempt);
    return attempt;
  }

  /**
   * Wait for the child process to exit, up to `timeoutMs`.
   * Resolves immediately if the process is already gone.
   */
  function waitForExit(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const child = state.childProcess;
      if (!child) {
        resolve();
        return;
      }

      let settled = false;
      const onExit = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.off("exit", onExit);
        resolve();
      }, timeoutMs);

      child.once("exit", onExit);
    });
  }

  function killWithSignal(signal: NodeJS.Signals, waitMs: number): Promise<void> {
    if (!state.childProcess) return Promise.resolve();
    try {
      state.childProcess.kill(signal);
    } catch {
      return Promise.resolve();
    }
    return waitForExit(waitMs);
  }

  async function killProcess(): Promise<void> {
    if (!state.childProcess) return;
    state.intentionalStop = true;
    await killWithSignal("SIGKILL", 1_000);
    assertProcessExitedAfterSigkill();
  }

  function assertProcessExitedAfterSigkill(): void {
    if (state.childProcess) {
      throw new Error(`Worker process for plugin "${pluginId}" is still alive after SIGKILL`);
    }
  }

  // -----------------------------------------------------------------------
  // RPC call implementation
  // -----------------------------------------------------------------------

  function callInternal<M extends HostToWorkerMethodName>(
    method: M,
    params: HostToWorkerMethods[M][0],
    timeoutMs?: number,
    explicitInvocationScope?: PluginInvocationScope,
  ): Promise<HostToWorkerMethods[M][1]> {
    const rpcPromise = new Promise<HostToWorkerMethods[M][1]>((resolve, reject) => {
      if (!state.childProcess?.stdin?.writable) {
        reject(
          new JsonRpcCallError({
            code: PLUGIN_RPC_ERROR_CODES.WORKER_UNAVAILABLE,
            message: `Cannot call "${method}" — worker for "${pluginId}" is not running`,
          }),
        );
        return;
      }

      const id = state.nextRequestId++;
      const timeout = Math.min(timeoutMs ?? rpcTimeoutMs, workerCore.MAX_RPC_TIMEOUT_MS);
      const invocationScope = explicitInvocationScope ?? deriveInvocationScope(method, params);
      const invocation = invocationScope ? registerInvocation(invocationScope) : null;

      // Guard against double-settlement. When a process exits all pending
      // requests are rejected via rejectAllPending(), but the timeout timer
      // may still be running. Without this guard the timer's reject fires on
      // an already-settled promise, producing an unhandled rejection.
      let settled = false;

      const settle = <T>(fn: (value: T) => void, value: T): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pendingRequests.delete(id);
        clearInvocation(invocation);
        fn(value);
      };

      const timer = setTimeout(() => {
        settle(
          reject,
          new JsonRpcCallError({
            code: PLUGIN_RPC_ERROR_CODES.TIMEOUT,
            message: `RPC call "${method}" timed out after ${timeout}ms`,
          }),
        );
      }, timeout);

      const pending: workerCore.PendingRequest = {
        id,
        method,
        resolve: (response: JsonRpcResponse) => {
          if (isJsonRpcSuccessResponse(response)) {
            settle(resolve, response.result as HostToWorkerMethods[M][1]);
          } else if ("error" in response && response.error) {
            settle(reject, new JsonRpcCallError(response.error));
          } else {
            settle(reject, new Error(`Unexpected response format for "${method}"`));
          }
        },
        timer,
        sentAt: Date.now(),
        invocationId: invocation?.id,
      };

      pendingRequests.set(id, pending);

      try {
        const request = {
          ...createRequest(method, params, id),
          ...(invocation ? { paperclipInvocation: invocation } : {}),
        };
        sendMessage(request);
      } catch (err) {
        clearTimeout(timer);
        pendingRequests.delete(id);
        clearInvocation(invocation);
        reject(
          new Error(
            `Failed to send "${method}" to worker: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      }
    });

    // Some call sites hand these promises across async boundaries before
    // attaching their own handlers. Mark the promise as handled here so a
    // worker-side JSON-RPC error can fail the caller without killing the host
    // process via an unhandled rejection.
    void rpcPromise.catch(() => undefined);

    return rpcPromise;
  }

  return {
    startInternal,
    performStop,
    stopInternal,
    waitForExit,
    killWithSignal,
    killProcess,
    assertProcessExitedAfterSigkill,
    callInternal,
  };
}
