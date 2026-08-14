import { logger } from "../middleware/logger.js";
import {
  JsonRpcCallError,
  type HostToWorkerMethodName,
  type HostToWorkerMethods,
  type PluginInvocationScope,
  PLUGIN_RPC_ERROR_CODES,
  type HostToWorkerOptionalMethodName,
} from "@paperclipai/plugin-sdk";
import {
  type PluginWorkerHandle,
  type PluginWorkerManager,
  type WorkerStartOptions,
  DEFAULT_RPC_TIMEOUT_MS,
  NO_OPTIONAL_WORKER_METHODS,
  REQUIRED_WORKER_METHODS,
  type ActiveInvocation,
  type PendingRequest,
  type WorkerDiagnostics,
} from "./plugin-worker-foundation.js";

import { type ChildProcess } from "node:child_process";
import { type Interface as ReadlineInterface } from "node:readline";
import type { PluginWorkerStatus } from "@paperclipai/shared";
import { pluginManifestIdentity } from "./plugin-manifest-identity.js";
import { buildPluginWorkerRpcCore } from "./plugin-worker-rpc-core.js";
import { buildPluginWorkerProcessCore } from "./plugin-worker-process-core.js";
import { buildPluginWorkerControlCore } from "./plugin-worker-control-core.js";

export function createPluginWorkerHandle(pluginId: string, options: WorkerStartOptions): PluginWorkerHandle {
  const log = logger.child({ service: "plugin-worker", pluginId });
  const manifestIdentity = pluginManifestIdentity(options.manifest);
  const pendingRequests = new Map<string | number, PendingRequest>();
  const activeInvocations = new Map<string, ActiveInvocation>();
  const rpcTimeoutMs = options.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
  const state = {
    childProcess: null as ChildProcess | null,
    readline: null as ReadlineInterface | null,
    stderrReadline: null as ReadlineInterface | null,
    status: "stopped" as PluginWorkerStatus,
    startedAt: null as number | null,
    stderrExcerpt: "",
    workerRpcIncarnationId: "",
    protocolViolationError: null as Error | null,
    nextRequestId: 1,
    supportedMethods: NO_OPTIONAL_WORKER_METHODS as readonly HostToWorkerOptionalMethodName[],
    consecutiveCrashes: 0,
    totalCrashes: 0,
    lastCrashAt: null as number | null,
    backoffTimer: null as ReturnType<typeof setTimeout> | null,
    nextRestartAt: null as number | null,
    terminalCrashReported: false,
    terminalCrashPersistence: null as Promise<void> | null,
    terminalCrashFailure: null as Parameters<WorkerStartOptions["onTerminalCrash"]>[0] | null,
    intentionalStop: false,
    explicitStopRequested: false,
    stopAttempt: null as Promise<void> | null,
  };
  const base = {
    pluginId,
    options,
    log,
    manifestIdentity,
    pendingRequests,
    activeInvocations,
    rpcTimeoutMs,
    state,
  };
  const rpc = buildPluginWorkerRpcCore(base);
  let restartWorker: () => Promise<void> = () =>
    Promise.reject(new Error("Plugin worker control core is not initialized"));
  const process = buildPluginWorkerProcessCore({
    ...base,
    ...rpc,
    startInternal: () => restartWorker(),
  });
  const control = buildPluginWorkerControlCore({ ...base, ...rpc, ...process });
  restartWorker = control.startInternal;
  const scope = { ...base, ...rpc, ...process, ...control };

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  const handle: PluginWorkerHandle = {
    get pluginId() {
      return pluginId;
    },

    get manifestIdentity() {
      return manifestIdentity;
    },

    get status() {
      return state.status;
    },

    get supportedMethods() {
      return state.supportedMethods;
    },

    async start() {
      await scope.startInternal();
    },

    async stop() {
      await scope.stopInternal();
    },

    call<M extends HostToWorkerMethodName>(
      method: M,
      params: HostToWorkerMethods[M][0],
      timeoutMs?: number,
      invocationScope?: PluginInvocationScope,
    ): Promise<HostToWorkerMethods[M][1]> {
      if (state.status !== "running" && state.status !== "starting") {
        return Promise.reject(
          new JsonRpcCallError({
            code: PLUGIN_RPC_ERROR_CODES.WORKER_UNAVAILABLE,
            message: `Cannot call "${method}" — worker for "${pluginId}" is ${state.status}`,
          }),
        );
      }
      if (
        !REQUIRED_WORKER_METHODS.has(method) &&
        !state.supportedMethods.includes(method as HostToWorkerOptionalMethodName)
      ) {
        return Promise.reject(
          new JsonRpcCallError({
            code: PLUGIN_RPC_ERROR_CODES.METHOD_NOT_IMPLEMENTED,
            message: `Cannot call "${method}" — worker for "${pluginId}" did not advertise it during initialization`,
          }),
        );
      }
      return scope.callInternal(method, params, timeoutMs, invocationScope);
    },

    diagnostics(): WorkerDiagnostics {
      return {
        pluginId,
        status: state.status,
        pid: state.childProcess?.pid ?? null,
        uptime: state.startedAt !== null && state.status === "running" ? Date.now() - state.startedAt : null,
        consecutiveCrashes: state.consecutiveCrashes,
        totalCrashes: state.totalCrashes,
        pendingRequests: pendingRequests.size,
        lastCrashAt: state.lastCrashAt,
        nextRestartAt: state.nextRestartAt,
      };
    },
  };

  return handle;
}
export {
  decodePluginWorkerHealth,
  appendStderrExcerpt,
  formatWorkerFailureMessage,
  type WorkerStartOptions,
  type PluginWorkerHandle,
  type PluginWorkerManager,
} from "./plugin-worker-foundation.js";

// ---------------------------------------------------------------------------
// Implementation: createPluginWorkerManager
// ---------------------------------------------------------------------------

/**
 * Create a new PluginWorkerManager.
 *
 * The manager holds all plugin worker handles and provides a unified API for
 * starting, stopping, and communicating with plugin workers.
 *
 * @example
 * ```ts
 * const manager = createPluginWorkerManager();
 *
 * const handle = await manager.startWorker("acme.linear", {
 *   entrypointPath: "/path/to/worker.cjs",
 *   manifest,
 *   instanceInfo: { instanceId: "inst-1", hostVersion: "1.0.0" },
 *   apiVersion: 1,
 *   hostHandlers: createHostClientHandlers({ pluginKey: "acme.linear", capabilities, services }),
 * });
 *
 * // Send RPC call to the worker
 * const health = await manager.call("acme.linear", "health", {});
 *
 * // Shutdown all workers on server exit
 * await manager.stopAll();
 * ```
 */
export function createPluginWorkerManager(): PluginWorkerManager {
  const log = logger.child({ service: "plugin-worker-manager" });
  const workers = new Map<string, PluginWorkerHandle>();
  /** Per-plugin startup locks to prevent concurrent spawn races. */
  const startupLocks = new Map<string, Promise<PluginWorkerHandle>>();

  return {
    async startWorker(pluginId: string, options: WorkerStartOptions): Promise<PluginWorkerHandle> {
      // Mutex: if a start is already in-flight for this plugin, wait for it
      const inFlight = startupLocks.get(pluginId);
      if (inFlight) {
        log.warn({ pluginId }, "concurrent startWorker call — waiting for in-flight start");
        return inFlight;
      }

      const existing = workers.get(pluginId);
      if (existing && existing.status !== "stopped") {
        throw new Error(`Worker already registered for plugin "${pluginId}" (status: ${existing.status})`);
      }

      const handle = createPluginWorkerHandle(pluginId, options);
      workers.set(pluginId, handle);

      log.info({ pluginId }, "starting plugin worker");

      // Set the lock before awaiting start() to prevent concurrent spawns
      const startPromise = handle
        .start()
        .then(() => handle)
        .finally(() => {
          startupLocks.delete(pluginId);
        });
      startupLocks.set(pluginId, startPromise);

      return startPromise;
    },

    async stopWorker(pluginId: string): Promise<void> {
      const handle = workers.get(pluginId);
      if (!handle) {
        log.warn({ pluginId }, "no worker registered for plugin, nothing to stop");
        return;
      }

      log.info({ pluginId }, "stopping plugin worker");
      await handle.stop();
      workers.delete(pluginId);
    },

    getWorker(pluginId: string): PluginWorkerHandle | undefined {
      return workers.get(pluginId);
    },

    isRunning(pluginId: string): boolean {
      const handle = workers.get(pluginId);
      return handle?.status === "running";
    },

    async stopAll(): Promise<void> {
      log.info({ count: workers.size }, "stopping all plugin workers");
      const errors: unknown[] = [];
      await Promise.all(
        Array.from(workers.entries()).map(async ([pluginId, handle]) => {
          try {
            await handle.stop();
            workers.delete(pluginId);
          } catch (err) {
            errors.push(err);
          }
        }),
      );
      if (errors.length > 0) {
        throw new AggregateError(errors, "Failed to stop all plugin workers");
      }
    },

    call<M extends HostToWorkerMethodName>(
      pluginId: string,
      method: M,
      params: HostToWorkerMethods[M][0],
      timeoutMs?: number,
      invocationScope?: PluginInvocationScope,
    ): Promise<HostToWorkerMethods[M][1]> {
      const handle = workers.get(pluginId);
      if (!handle) {
        return Promise.reject(
          new JsonRpcCallError({
            code: PLUGIN_RPC_ERROR_CODES.WORKER_UNAVAILABLE,
            message: `No worker registered for plugin "${pluginId}"`,
          }),
        );
      }
      return handle.call(method, params, timeoutMs, invocationScope);
    },
  };
}
