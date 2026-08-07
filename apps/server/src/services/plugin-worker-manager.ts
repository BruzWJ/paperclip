/**
 * PluginWorkerManager — spawns and manages out-of-process plugin worker child
 * processes, routes JSON-RPC 2.0 calls over stdio, and handles lifecycle
 * management including crash recovery with exponential backoff.
 *
 * Each installed plugin gets one dedicated worker process. The host sends
 * JSON-RPC requests over the child's stdin and reads responses from stdout.
 * Worker stderr is captured and forwarded to the host logger.
 *
 * Process Model (from PLUGIN_SPEC.md §12):
 * - One worker process per installed plugin
 * - Failure isolation: plugin crashes do not affect the host
 * - Graceful shutdown: 10-second drain, then SIGTERM, then SIGKILL
 * - Automatic restart with exponential backoff on unexpected exits
 *
 * @see PLUGIN_SPEC.md §12 — Process Model
 * @see PLUGIN_SPEC.md §12.5 — Graceful Shutdown Policy
 * @see PLUGIN_SPEC.md §13 — Host-Worker Protocol
 */

import { fork, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import type {
  PaperclipPluginManifestV1,
  PluginWorkerStatus,
} from "@paperclipai/shared";
import {
  JSONRPC_VERSION,
  JSONRPC_ERROR_CODES,
  PLUGIN_RPC_ERROR_CODES,
  HOST_TO_WORKER_REQUIRED_METHODS,
  HOST_TO_WORKER_OPTIONAL_METHODS,
  createRequest,
  createErrorResponse,
  parseMessage,
  serializeMessage,
  isJsonRpcResponse,
  isJsonRpcSuccessResponse,
  JsonRpcCallError,
} from "@paperclipai/plugin-sdk";
import type {
  JsonRpcId,
  JsonRpcMessage,
  PluginInvocationContext,
  PluginInvocationScope,
  JsonRpcResponse,
  JsonRpcRequest,
  WorkerHostCallContext,
  HostToWorkerMethodName,
  HostToWorkerMethods,
  HostToWorkerOptionalMethodName,
  HostClientHandlers,
  PluginHealthDiagnostics,
  WorkerToHostMethodName,
  InitializeParams,
} from "@paperclipai/plugin-sdk";
import { logger } from "../middleware/logger.js";
import { pluginManifestIdentity } from "./plugin-manifest-identity.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default timeout for RPC calls in milliseconds. */
const DEFAULT_RPC_TIMEOUT_MS = 30_000;

/** Hard upper bound for any RPC timeout (15 minutes). Prevents unbounded waits. */
const MAX_RPC_TIMEOUT_MS = 15 * 60 * 1_000;

/** Timeout for the initialize RPC call. */
const INITIALIZE_TIMEOUT_MS = 15_000;

/** Timeout for the shutdown RPC call before escalating to SIGTERM. */
const SHUTDOWN_DRAIN_MS = 10_000;

/** Time to wait after SIGTERM before sending SIGKILL. */
const SIGTERM_GRACE_MS = 5_000;

/** Minimum backoff delay for crash recovery (1 second). */
const MIN_BACKOFF_MS = 1_000;

/** Maximum backoff delay for crash recovery (5 minutes). */
const MAX_BACKOFF_MS = 5 * 60 * 1_000;

/** Backoff multiplier on each consecutive crash. */
const BACKOFF_MULTIPLIER = 2;

/** Maximum number of consecutive crashes before giving up on auto-restart. */
const MAX_CONSECUTIVE_CRASHES = 10;

/** Time window in which crashes are considered consecutive (10 minutes). */
const CRASH_WINDOW_MS = 10 * 60 * 1_000;

/** Maximum number of stderr characters retained for worker failure context. */
const MAX_STDERR_EXCERPT_CHARS = 8_000;

/** Privileged prompt hook whose manifest grant and worker method must agree. */
const PROMPT_OBSERVE_CAPABILITY = "runtime.prompt.observe";
const BEFORE_PROMPT_METHOD = "beforePrompt";
const REQUIRED_WORKER_METHODS = new Set<string>(HOST_TO_WORKER_REQUIRED_METHODS);
const OPTIONAL_WORKER_METHODS = new Set<string>(HOST_TO_WORKER_OPTIONAL_METHODS);
const NO_OPTIONAL_WORKER_METHODS = Object.freeze(
  [] as HostToWorkerOptionalMethodName[],
);

interface ManifestWorkerMethodRule {
  readonly method: HostToWorkerOptionalMethodName;
  readonly declared: boolean;
  readonly requiredMessage: string;
  readonly undeclaredMessage: string;
}

function manifestWorkerMethodRules(
  manifest: PaperclipPluginManifestV1,
): readonly ManifestWorkerMethodRule[] {
  const declaresPromptObserve = manifest.capabilities.includes(
    PROMPT_OBSERVE_CAPABILITY,
  );
  const declaresTools = (manifest.tools?.length ?? 0) > 0;
  const declaresJobs = (manifest.jobs?.length ?? 0) > 0;
  const declaresWebhooks = (manifest.webhooks?.length ?? 0) > 0;
  const declaresApiRoutes = (manifest.apiRoutes?.length ?? 0) > 0;
  const environmentDrivers = manifest.environmentDrivers ?? [];
  const declaresEnvironmentDrivers = environmentDrivers.length > 0;
  const supportsReusableLeases = environmentDrivers.some(
    (driver) => driver.supportsReusableLeases === true,
  );
  const supportsInteractiveSetup = environmentDrivers.some(
    (driver) => driver.supportsInteractiveSetup === true,
  );
  const supportsTemplateCapture = environmentDrivers.some(
    (driver) => driver.supportsTemplateCapture === true,
  );
  const supportsTemplateDelete = environmentDrivers.some(
    (driver) => driver.supportsTemplateDelete === true,
  );

  const environmentRule = (
    method: HostToWorkerOptionalMethodName,
    declared: boolean,
    declaration: string,
  ): ManifestWorkerMethodRule => ({
    method,
    declared,
    requiredMessage: `${declaration} require the worker to advertise "${method}"`,
    undeclaredMessage: `Worker advertised "${method}" without ${declaration.toLowerCase()}`,
  });

  return [
    {
      method: BEFORE_PROMPT_METHOD,
      declared: declaresPromptObserve,
      requiredMessage: `Manifest capability "${PROMPT_OBSERVE_CAPABILITY}" requires the worker to advertise "${BEFORE_PROMPT_METHOD}"`,
      undeclaredMessage: `Worker advertised "${BEFORE_PROMPT_METHOD}" without manifest capability "${PROMPT_OBSERVE_CAPABILITY}"`,
    },
    {
      method: "executeTool",
      declared: declaresTools,
      requiredMessage: 'Manifest tool declarations require the worker to advertise "executeTool"',
      undeclaredMessage: 'Worker advertised "executeTool" without manifest tool declarations',
    },
    {
      method: "runJob",
      declared: declaresJobs,
      requiredMessage: 'Manifest job declarations require the worker to advertise "runJob"',
      undeclaredMessage: 'Worker advertised "runJob" without manifest job declarations',
    },
    {
      method: "handleWebhook",
      declared: declaresWebhooks,
      requiredMessage: 'Manifest webhook declarations require the worker to advertise "handleWebhook"',
      undeclaredMessage: 'Worker advertised "handleWebhook" without manifest webhook declarations',
    },
    {
      method: "handleApiRequest",
      declared: declaresApiRoutes,
      requiredMessage: 'Manifest API route declarations require the worker to advertise "handleApiRequest"',
      undeclaredMessage: 'Worker advertised "handleApiRequest" without manifest API route declarations',
    },
    ...([
      "environmentValidateConfig",
      "environmentProbe",
      "environmentAcquireLease",
      "environmentReleaseLease",
      "environmentDestroyLease",
      "environmentRealizeWorkspace",
      "environmentExecute",
      "environmentCancelExecution",
    ] as const).map((method) => environmentRule(
      method,
      declaresEnvironmentDrivers,
      "Manifest environment-driver declarations",
    )),
    environmentRule(
      "environmentResumeLease",
      supportsReusableLeases,
      "Manifest environment-driver reusable-lease declarations",
    ),
    ...([
      "environmentStartInteractiveSetup",
      "environmentGetInteractiveSetup",
      "environmentCancelInteractiveSetup",
    ] as const).map((method) => environmentRule(
      method,
      supportsInteractiveSetup,
      "Manifest environment-driver interactive-setup declarations",
    )),
    environmentRule(
      "environmentCaptureTemplate",
      supportsTemplateCapture,
      "Manifest environment-driver template-capture declarations",
    ),
    environmentRule(
      "environmentDeleteTemplate",
      supportsTemplateDelete,
      "Manifest environment-driver template-delete declarations",
    ),
  ];
}

function assertManifestWorkerMethodAgreement(
  manifest: PaperclipPluginManifestV1,
  supportedMethods: readonly HostToWorkerOptionalMethodName[],
): void {
  for (const rule of manifestWorkerMethodRules(manifest)) {
    const advertised = supportedMethods.includes(rule.method);
    if (rule.declared !== advertised) {
      throw new Error(rule.declared ? rule.requiredMessage : rule.undeclaredMessage);
    }
  }

  const advertisesSyncIn = supportedMethods.includes("environmentSyncIn");
  const advertisesSyncOut = supportedMethods.includes("environmentSyncOut");
  if (advertisesSyncIn !== advertisesSyncOut) {
    throw new Error(
      'Worker environment sync hooks must advertise both "environmentSyncIn" and "environmentSyncOut", or neither',
    );
  }
  if (
    advertisesSyncIn
    && (manifest.environmentDrivers?.length ?? 0) === 0
  ) {
    throw new Error(
      "Worker advertised environment sync hooks without manifest environment-driver declarations",
    );
  }

  for (const [method, capability] of [
    ["onEvent", "events.subscribe"],
    ["issues.creatorCallback.deliver", "issues.create"],
  ] as const) {
    if (
      supportedMethods.includes(method)
      && !manifest.capabilities.includes(capability)
    ) {
      throw new Error(
        `Worker advertised "${method}" without manifest capability "${capability}"`,
      );
    }
  }
}

export function decodePluginWorkerHealth(value: unknown): PluginHealthDiagnostics {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Worker health must return an object");
  }
  const health = value as Record<string, unknown>;
  const keys = Object.keys(health);
  if (keys.some((key) => key !== "status" && key !== "message" && key !== "details")) {
    throw new Error("Worker health returned unexpected fields");
  }
  if (
    health.status !== "ok"
    && health.status !== "degraded"
    && health.status !== "error"
  ) {
    throw new Error('Worker health status must be "ok", "degraded", or "error"');
  }
  if ("message" in health && typeof health.message !== "string") {
    throw new Error("Worker health message must be a string");
  }
  if (
    "details" in health
    && (
      typeof health.details !== "object"
      || health.details === null
      || Array.isArray(health.details)
    )
  ) {
    throw new Error("Worker health details must be an object");
  }
  return health as unknown as PluginHealthDiagnostics;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export function appendStderrExcerpt(current: string, chunk: string): string {
  const next = current ? `${current}\n${chunk}` : chunk;
  return next.length <= MAX_STDERR_EXCERPT_CHARS
    ? next
    : next.slice(-MAX_STDERR_EXCERPT_CHARS);
}

export function formatWorkerFailureMessage(message: string, stderrExcerpt: string): string {
  const excerpt = stderrExcerpt.trim();
  if (!excerpt) return message;
  if (message.includes(excerpt)) return message;
  return `${message}\n\nWorker stderr:\n${excerpt}`;
}

/**
 * Options for starting a worker process.
 */
export interface WorkerStartOptions {
  /** Absolute path to the plugin worker entrypoint (CJS bundle). */
  entrypointPath: string;
  /** Plugin manifest. */
  manifest: PaperclipPluginManifestV1;
  /** Host instance information for the initialize call. */
  instanceInfo: {
    instanceId: string;
    hostVersion: string;
  };
  /** Host API version. */
  apiVersion: number;
  /** Host-derived plugin database namespace, or null when not declared. */
  databaseNamespace: string | null;
  /** Complete capability-gated worker→host RPC surface. */
  hostHandlers: HostClientHandlers;
  /** Default timeout for RPC calls (ms). Defaults to 30s. */
  rpcTimeoutMs?: number;
  /** Persist the installation as errored once its restart budget is exhausted. */
  onTerminalCrash: (failure: {
    code: number | null;
    signal: NodeJS.Signals | null;
    stderrExcerpt: string;
  }) => void | Promise<void>;
  /** Environment variables passed to the child process. */
  env?: Record<string, string>;
}

/**
 * A pending RPC call waiting for a response from the worker.
 */
interface PendingRequest {
  /** The request ID. */
  id: JsonRpcId;
  /** Method name (for logging). */
  method: string;
  /** Resolve the promise with the response. */
  resolve: (response: JsonRpcResponse) => void;
  /** Timeout timer handle. */
  timer: ReturnType<typeof setTimeout>;
  /** Timestamp when the request was sent. */
  sentAt: number;
  /** Active host-owned invocation id attached to this host→worker call. */
  invocationId?: string;
}

interface ActiveInvocation {
  scope: PluginInvocationScope;
  timer?: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// PluginWorkerHandle — manages a single worker process
// ---------------------------------------------------------------------------

/**
 * Handle for a single plugin worker process.
 *
 * Callers use `start()` to spawn the worker, `call()` to send RPC requests,
 * and `stop()` to gracefully shut down. The handle manages crash recovery
 * with mandatory bounded exponential backoff.
 */
export interface PluginWorkerHandle {
  /** The plugin ID this worker serves. */
  readonly pluginId: string;

  /** Exact manifest identity used to initialize this worker process. */
  readonly manifestIdentity: string;

  /** Current worker status. */
  readonly status: PluginWorkerStatus;

  /** Start the worker process. Resolves when initialize completes. */
  start(): Promise<void>;

  /**
   * Stop the worker process gracefully.
   *
   * Sends a `shutdown` RPC call, waits up to 10 seconds for the worker to
   * exit, then escalates to SIGTERM, and finally SIGKILL if needed.
   */
  stop(): Promise<void>;

  /**
   * Send a typed host→worker RPC call.
   *
   * @param method - The RPC method name
   * @param params - Method parameters
   * @param timeoutMs - Optional per-call timeout override
   * @returns The method result
   * @throws {JsonRpcCallError} if the worker returns an error response
   * @throws {JsonRpcCallError} if the worker is unavailable or the call times out
   */
  call<M extends HostToWorkerMethodName>(
    method: M,
    params: HostToWorkerMethods[M][0],
    timeoutMs?: number,
    invocationScope?: PluginInvocationScope,
  ): Promise<HostToWorkerMethods[M][1]>;

  /** Optional methods the worker reported during initialization. */
  readonly supportedMethods: readonly HostToWorkerOptionalMethodName[];

  /** Get diagnostic info about the worker. */
  diagnostics(): WorkerDiagnostics;
}

/**
 * Diagnostic information about a worker process.
 */
interface WorkerDiagnostics {
  pluginId: string;
  status: PluginWorkerStatus;
  pid: number | null;
  uptime: number | null;
  consecutiveCrashes: number;
  totalCrashes: number;
  pendingRequests: number;
  lastCrashAt: number | null;
  nextRestartAt: number | null;
}

// ---------------------------------------------------------------------------
// PluginWorkerManager — manages all plugin workers
// ---------------------------------------------------------------------------

/**
 * The top-level manager that holds all plugin worker handles.
 *
 * Provides a registry of workers keyed by plugin ID, with convenience methods
 * for starting/stopping all workers and routing RPC calls.
 */
export interface PluginWorkerManager {
  /**
   * Register and start a worker for a plugin.
   *
   * @returns The worker handle
   * @throws if a worker is already registered for this plugin
   */
  startWorker(pluginId: string, options: WorkerStartOptions): Promise<PluginWorkerHandle>;

  /**
   * Stop and unregister a specific plugin worker.
   */
  stopWorker(pluginId: string): Promise<void>;

  /**
   * Get the worker handle for a plugin.
   */
  getWorker(pluginId: string): PluginWorkerHandle | undefined;

  /**
   * Check if a worker is registered and running for a plugin.
   */
  isRunning(pluginId: string): boolean;

  /**
   * Stop all managed workers. Called during server shutdown.
   */
  stopAll(): Promise<void>;

  /**
   * Send an RPC call to a specific plugin worker.
   *
   * @throws if the worker is not running
   */
  call<M extends HostToWorkerMethodName>(
    pluginId: string,
    method: M,
    params: HostToWorkerMethods[M][0],
    timeoutMs?: number,
    invocationScope?: PluginInvocationScope,
  ): Promise<HostToWorkerMethods[M][1]>;
}

// ---------------------------------------------------------------------------
// Implementation: createPluginWorkerHandle
// ---------------------------------------------------------------------------

/**
 * Create a handle for a single plugin worker process.
 *
 * @internal Exported for testing; consumers should use `createPluginWorkerManager`.
 */
export function createPluginWorkerHandle(
  pluginId: string,
  options: WorkerStartOptions,
): PluginWorkerHandle {
  const log = logger.child({ service: "plugin-worker", pluginId });
  const manifestIdentity = pluginManifestIdentity(options.manifest);

  // Worker process state
  let childProcess: ChildProcess | null = null;
  let readline: ReadlineInterface | null = null;
  let stderrReadline: ReadlineInterface | null = null;
  let status: PluginWorkerStatus = "stopped";
  let startedAt: number | null = null;
  let stderrExcerpt = "";
  let workerRpcIncarnationId = "";
  let protocolViolationError: Error | null = null;

  // Pending RPC requests awaiting a response
  const pendingRequests = new Map<string | number, PendingRequest>();
  let nextRequestId = 1;
  const activeInvocations = new Map<string, ActiveInvocation>();

  // Optional methods reported by the worker during initialization
  let supportedMethods: readonly HostToWorkerOptionalMethodName[] =
    NO_OPTIONAL_WORKER_METHODS;

  // Crash tracking for exponential backoff
  let consecutiveCrashes = 0;
  let totalCrashes = 0;
  let lastCrashAt: number | null = null;
  let backoffTimer: ReturnType<typeof setTimeout> | null = null;
  let nextRestartAt: number | null = null;
  let terminalCrashReported = false;
  let terminalCrashPersistence: Promise<void> | null = null;
  let terminalCrashFailure:
    | Parameters<WorkerStartOptions["onTerminalCrash"]>[0]
    | null = null;

  // Shutdown coordination
  let intentionalStop = false;
  let explicitStopRequested = false;
  let stopAttempt: Promise<void> | null = null;

  const rpcTimeoutMs = options.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;

  // -----------------------------------------------------------------------
  // Status management
  // -----------------------------------------------------------------------

  function setStatus(newStatus: PluginWorkerStatus): void {
    const prev = status;
    if (prev === newStatus) return;
    status = newStatus;
    log.debug({ from: prev, to: newStatus }, "worker status change");
  }

  // -----------------------------------------------------------------------
  // JSON-RPC message sending
  // -----------------------------------------------------------------------

  function sendMessage(message: JsonRpcMessage): void {
    if (!childProcess?.stdin?.writable) {
      throw new Error(`Worker process for plugin "${pluginId}" is not writable`);
    }
    const serialized = serializeMessage(message);
    childProcess.stdin.write(serialized);
  }

  function errorCodeForWorkerHostError(err: unknown): number {
    const code = (err as { code?: unknown } | null)?.code;
    const pluginErrorCodes: readonly number[] = Object.values(PLUGIN_RPC_ERROR_CODES);
    return typeof code === "number" && pluginErrorCodes.includes(code)
      ? code
      : JSONRPC_ERROR_CODES.INTERNAL_ERROR;
  }

  // -----------------------------------------------------------------------
  // Incoming message handling
  // -----------------------------------------------------------------------

  function terminateForProtocolViolation(line: string, error: unknown): void {
    if (protocolViolationError) return;
    const detail = error instanceof Error ? error.message : String(error);
    protocolViolationError = new Error(`Worker protocol violation: ${detail}`);
    log.error(
      { err: detail, rawLine: line.slice(0, 200) },
      "worker emitted malformed protocol output; terminating",
    );

    if (!childProcess) {
      rejectAllPending(protocolViolationError);
      return;
    }
    try {
      if (!childProcess.kill("SIGKILL")) {
        rejectAllPending(protocolViolationError);
      }
    } catch {
      rejectAllPending(protocolViolationError);
    }
  }

  function handleLine(line: string): void {
    if (!line.trim()) return;

    let message: JsonRpcMessage;
    try {
      message = parseMessage(line);
    } catch (err) {
      terminateForProtocolViolation(line, err);
      return;
    }

    if (isJsonRpcResponse(message)) {
      handleResponse(message);
    } else {
      handleWorkerRequest(message);
    }
  }

  /**
   * Handle a JSON-RPC response from the worker (matching a pending request).
   */
  function handleResponse(response: JsonRpcResponse): void {
    const id = response.id;
    if (id === null || id === undefined) {
      log.warn("received response with null/undefined id");
      return;
    }

    const pending = pendingRequests.get(id);
    if (!pending) {
      log.warn({ id }, "received response for unknown request id");
      return;
    }

    clearTimeout(pending.timer);
    pendingRequests.delete(id);
    pending.resolve(response);
  }

  function readNonEmptyString(value: unknown): string | null {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  function deriveInvocationScope(
    method: HostToWorkerMethodName | string,
    params: unknown,
  ): PluginInvocationScope | null {
    if (!isRecord(params)) return null;

    const directCompanyId = readNonEmptyString(params.companyId);
    if (directCompanyId) return { companyId: directCompanyId };

    if (method === "performAction" && isRecord(params.actorContext)) {
      const companyId = readNonEmptyString(params.actorContext.companyId);
      return companyId ? { companyId } : null;
    }

    if (method === "onEvent" && isRecord(params.event)) {
      const companyId = readNonEmptyString(params.event.companyId);
      return companyId ? { companyId } : null;
    }

    return null;
  }

  function registerInvocation(scope: PluginInvocationScope, ttlMs?: number): PluginInvocationContext {
    const invocation: PluginInvocationContext = {
      id: randomUUID(),
      scope,
    };
    const entry: ActiveInvocation = { scope };
    if (ttlMs !== undefined) {
      entry.timer = setTimeout(() => {
        activeInvocations.delete(invocation.id);
      }, ttlMs);
      if (entry.timer.unref) entry.timer.unref();
    }
    activeInvocations.set(invocation.id, entry);
    return invocation;
  }

  function clearInvocation(invocation: PluginInvocationContext | null): void {
    if (!invocation) return;
    const entry = activeInvocations.get(invocation.id);
    if (entry?.timer) clearTimeout(entry.timer);
    activeInvocations.delete(invocation.id);
  }

  function rpcOperationIdForWorkerRequest(request: JsonRpcRequest): string {
    // This is transport identity, not payload identity: the message/body is
    // deliberately excluded so distinct same-payload calls never deduplicate.
    const digest = createHash("sha256")
      .update(workerRpcIncarnationId)
      .update("\u0000")
      .update(request.method)
      .update("\u0000")
      .update(typeof request.id)
      .update("\u0000")
      .update(String(request.id))
      .digest("hex");
    return `pc_plugin_rpc_op_v1_${digest}`;
  }

  function contextForWorkerMessage(message: JsonRpcRequest): WorkerHostCallContext {
    const rpcOperationContext = {
      rpcOperationId: rpcOperationIdForWorkerRequest(message),
    };
    const invocationId = readNonEmptyString(
      (message as { paperclipInvocationId?: unknown }).paperclipInvocationId,
    );
    if (!invocationId) {
      const hasActiveInvocation = activeInvocations.size > 0 ||
        Array.from(pendingRequests.values()).some((pending) => pending.invocationId);
      return hasActiveInvocation
        ? { ...rpcOperationContext, invalidInvocationScope: true }
        : rpcOperationContext;
    }
    const entry = activeInvocations.get(invocationId);
    if (!entry) return { ...rpcOperationContext, invalidInvocationScope: true };
    return { ...rpcOperationContext, invocationScope: entry.scope };
  }

  function isWorkerToHostMethod(method: string): method is WorkerToHostMethodName {
    return Object.prototype.hasOwnProperty.call(options.hostHandlers, method);
  }

  /**
   * Handle a JSON-RPC request from the worker (worker→host call).
   */
  async function handleWorkerRequest(request: JsonRpcRequest): Promise<void> {
    const method = request.method;
    if (!isWorkerToHostMethod(method)) {
      log.warn({ method }, "worker called unknown host method");
      try {
        sendMessage(
          createErrorResponse(
            request.id,
            JSONRPC_ERROR_CODES.METHOD_NOT_FOUND,
            `Host does not handle method "${method}"`,
          ),
        );
      } catch {
        // Worker may have exited, ignore send error
      }
      return;
    }
    const handler = options.hostHandlers[method];

    try {
      const result = await handler(
        request.params as never,
        contextForWorkerMessage(request),
      );
      sendMessage({
        jsonrpc: JSONRPC_VERSION,
        id: request.id,
        result: result ?? null,
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error({ method, err: errorMessage }, "host handler error");
      try {
        sendMessage(
          createErrorResponse(
            request.id,
            errorCodeForWorkerHostError(err),
            errorMessage,
          ),
        );
      } catch {
        // Worker may have exited, ignore send error
      }
    }
  }

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
      readline = createInterface({ input: child.stdout });
      readline.on("line", handleLine);
    }

    // Capture stderr for logging
    if (child.stderr) {
      stderrReadline = createInterface({ input: child.stderr });
      stderrReadline.on("line", (line: string) => {
        stderrExcerpt = appendStderrExcerpt(stderrExcerpt, line);
        log.warn({ stream: "stderr" }, `[plugin stderr] ${line}`);
      });
    }

    // Handle process exit
    child.on("exit", (code, signal) => {
      void handleProcessExit(code, signal).catch((err) => {
        log.error(
          { err: err instanceof Error ? err.message : String(err) },
          "worker exit handling failed",
        );
      });
    });

    // Handle process errors (e.g. spawn failure)
    child.on("error", (err) => {
      log.error({ err: err.message }, "worker process error");
      if (status === "starting") {
        setStatus("crashed");
        rejectAllPending(
          new Error(formatWorkerFailureMessage(
            `Worker process failed to start: ${err.message}`,
            stderrExcerpt,
          )),
        );
      }
    });
  }

  async function handleProcessExit(
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    const wasIntentional = intentionalStop;

    // Clean up readline interfaces
    if (readline) {
      readline.close();
      readline = null;
    }
    if (stderrReadline) {
      stderrReadline.close();
      stderrReadline = null;
    }
    childProcess = null;
    startedAt = null;
    supportedMethods = NO_OPTIONAL_WORKER_METHODS;

    // Reject all pending requests
    const exitError = protocolViolationError ?? new Error(
      formatWorkerFailureMessage(
        `Worker process exited (code=${code}, signal=${signal})`,
        stderrExcerpt,
      ),
    );
    protocolViolationError = null;
    rejectAllPending(exitError);

    if (wasIntentional) {
      // Graceful stop — status is already "stopping" or will be set to "stopped"
      setStatus("stopped");
      log.info({ code, signal }, "worker process stopped");
      return;
    }

    await recordUnexpectedCrash(code, signal);
  }

  async function recordUnexpectedCrash(
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    totalCrashes++;
    const now = Date.now();

    // Reset consecutive crash counter if enough time passed
    if (lastCrashAt !== null && now - lastCrashAt > CRASH_WINDOW_MS) {
      consecutiveCrashes = 0;
    }
    consecutiveCrashes++;
    lastCrashAt = now;

    log.error(
      { code, signal, consecutiveCrashes, totalCrashes },
      "worker process crashed",
    );

    const willRestart = consecutiveCrashes <= MAX_CONSECUTIVE_CRASHES;

    setStatus("crashed");

    if (willRestart) {
      scheduleRestart();
    } else {
      log.error(
        { consecutiveCrashes, maxCrashes: MAX_CONSECUTIVE_CRASHES },
        "max consecutive crashes reached, not restarting",
      );
      terminalCrashFailure = { code, signal, stderrExcerpt };
      await persistTerminalCrash(terminalCrashFailure);
    }
  }

  async function persistTerminalCrash(
    failure: Parameters<WorkerStartOptions["onTerminalCrash"]>[0],
  ): Promise<void> {
    if (terminalCrashReported) return;
    if (terminalCrashPersistence) {
      await terminalCrashPersistence;
      return;
    }

    const attempt = Promise.resolve().then(() => options.onTerminalCrash(failure));
    terminalCrashPersistence = attempt;
    try {
      await attempt;
      terminalCrashReported = true;
      terminalCrashFailure = null;
    } finally {
      if (terminalCrashPersistence === attempt) {
        terminalCrashPersistence = null;
      }
    }
  }

  function rejectAllPending(error: Error): void {
    for (const pending of pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.resolve(
        createErrorResponse(
          pending.id,
          PLUGIN_RPC_ERROR_CODES.WORKER_UNAVAILABLE,
          error.message,
        ),
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
    // Exponential backoff: MIN_BACKOFF * MULTIPLIER^(consecutiveCrashes - 1)
    const delay =
      MIN_BACKOFF_MS * Math.pow(BACKOFF_MULTIPLIER, consecutiveCrashes - 1);
    // Add jitter: ±25%
    const jitter = delay * 0.25 * (Math.random() * 2 - 1);
    return Math.min(Math.round(delay + jitter), MAX_BACKOFF_MS);
  }

  function scheduleRestart(): void {
    if (explicitStopRequested || backoffTimer !== null) return;

    const delay = computeBackoffMs();
    nextRestartAt = Date.now() + delay;

    setStatus("backoff");

    log.info(
      { delayMs: delay, consecutiveCrashes },
      "scheduling restart with backoff",
    );

    backoffTimer = setTimeout(async () => {
      backoffTimer = null;
      nextRestartAt = null;
      const crashCountBeforeStart = totalCrashes;
      try {
        await startInternal();
      } catch (err) {
        log.error(
          { err: err instanceof Error ? err.message : String(err) },
          "restart after backoff failed",
        );
        if (!explicitStopRequested && totalCrashes === crashCountBeforeStart) {
          await recordUnexpectedCrash(null, null);
        }
      }
    }, delay);
  }

  function cancelPendingRestart(): void {
    if (backoffTimer !== null) {
      clearTimeout(backoffTimer);
      backoffTimer = null;
      nextRestartAt = null;
    }
  }

  // -----------------------------------------------------------------------
  // Start / Stop
  // -----------------------------------------------------------------------

  async function startInternal(): Promise<void> {
    if (
      status === "running"
      || status === "starting"
      || status === "stopping"
      || (status === "backoff" && backoffTimer !== null)
    ) {
      throw new Error(`Worker for plugin "${pluginId}" is already ${status}`);
    }
    if (childProcess) {
      throw new Error(
        `Worker for plugin "${pluginId}" already owns process ${childProcess.pid ?? "unknown"}`,
      );
    }

    intentionalStop = false;
    explicitStopRequested = false;
    setStatus("starting");
    supportedMethods = NO_OPTIONAL_WORKER_METHODS;
    stderrExcerpt = "";
    protocolViolationError = null;
    workerRpcIncarnationId = randomUUID();

    const child = spawnProcess();
    childProcess = child;
    attachStdioHandlers(child);
    startedAt = Date.now();

    const initParams: InitializeParams = {
      manifest: options.manifest,
      instanceInfo: options.instanceInfo,
      apiVersion: options.apiVersion,
      databaseNamespace: options.databaseNamespace,
    };

    try {
      const result: unknown = await callInternal(
        "initialize",
        initParams,
        INITIALIZE_TIMEOUT_MS,
      );
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
        (method) => typeof method !== "string" || !OPTIONAL_WORKER_METHODS.has(method),
      );
      if (unknownMethod !== undefined) {
        throw new Error(
          `Worker initialize reported unknown optional method: ${String(unknownMethod)}`,
        );
      }
      if (new Set(reportedMethods).size !== reportedMethods.length) {
        throw new Error("Worker initialize reported duplicate supportedMethods");
      }
      supportedMethods = Object.freeze(
        [...reportedMethods] as HostToWorkerOptionalMethodName[],
      );

      assertManifestWorkerMethodAgreement(options.manifest, supportedMethods);

      const health = decodePluginWorkerHealth(await callInternal(
        "health",
        {},
        INITIALIZE_TIMEOUT_MS,
      ));
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
      supportedMethods = NO_OPTIONAL_WORKER_METHODS;
      if (backoffTimer === null) setStatus("crashed");
      throw new Error(`Worker activation failed for "${pluginId}": ${msg}`);
    }

    setStatus("running");
    log.info({ pid: child.pid }, "worker process started and initialized");
  }

  async function performStop(): Promise<void> {
    explicitStopRequested = true;
    cancelPendingRestart();

    if (status === "stopped" && !childProcess) {
      return;
    }

    intentionalStop = true;
    setStatus("stopping");

    if (!childProcess) {
      if (terminalCrashFailure) {
        await persistTerminalCrash(terminalCrashFailure);
      }
      setStatus("stopped");
      return;
    }

    // Step 1: Send shutdown RPC and wait for the worker to exit gracefully.
    // We race the shutdown call against a timeout. The worker should process
    // the shutdown and exit on its own within the drain period.
    try {
      await Promise.race([
        callInternal("shutdown", {} as Record<string, never>, SHUTDOWN_DRAIN_MS),
        waitForExit(SHUTDOWN_DRAIN_MS),
      ]);
    } catch {
      // Shutdown call failed or timed out — proceed to kill
      log.warn("shutdown RPC failed or timed out, escalating to SIGTERM");
    }

    // Give the process a brief moment to exit after the shutdown response
    if (childProcess) {
      await waitForExit(500);
    }

    // Check if process already exited
    if (!childProcess) {
      setStatus("stopped");
      return;
    }

    // Step 2: Send SIGTERM and wait
    log.info("worker did not exit after shutdown RPC, sending SIGTERM");
    await killWithSignal("SIGTERM", SIGTERM_GRACE_MS);

    if (!childProcess) {
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
    if (stopAttempt) return stopAttempt;

    const attempt = performStop();
    stopAttempt = attempt;
    const clearAttempt = () => {
      if (stopAttempt === attempt) stopAttempt = null;
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
      const child = childProcess;
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

  function killWithSignal(
    signal: NodeJS.Signals,
    waitMs: number,
  ): Promise<void> {
    if (!childProcess) return Promise.resolve();
    try {
      childProcess.kill(signal);
    } catch {
      return Promise.resolve();
    }
    return waitForExit(waitMs);
  }

  async function killProcess(): Promise<void> {
    if (!childProcess) return;
    intentionalStop = true;
    await killWithSignal("SIGKILL", 1_000);
    assertProcessExitedAfterSigkill();
  }

  function assertProcessExitedAfterSigkill(): void {
    if (childProcess) {
      throw new Error(
        `Worker process for plugin "${pluginId}" is still alive after SIGKILL`,
      );
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
      if (!childProcess?.stdin?.writable) {
        reject(
          new JsonRpcCallError({
            code: PLUGIN_RPC_ERROR_CODES.WORKER_UNAVAILABLE,
            message: `Cannot call "${method}" — worker for "${pluginId}" is not running`,
          }),
        );
        return;
      }

      const id = nextRequestId++;
      const timeout = Math.min(timeoutMs ?? rpcTimeoutMs, MAX_RPC_TIMEOUT_MS);
      const invocationScope =
        explicitInvocationScope ?? deriveInvocationScope(method, params);
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

      const pending: PendingRequest = {
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
            `Failed to send "${method}" to worker: ${
              err instanceof Error ? err.message : String(err)
            }`,
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
      return status;
    },

    get supportedMethods() {
      return supportedMethods;
    },

    async start() {
      await startInternal();
    },

    async stop() {
      await stopInternal();
    },

    call<M extends HostToWorkerMethodName>(
      method: M,
      params: HostToWorkerMethods[M][0],
      timeoutMs?: number,
      invocationScope?: PluginInvocationScope,
    ): Promise<HostToWorkerMethods[M][1]> {
      if (status !== "running" && status !== "starting") {
        return Promise.reject(
          new JsonRpcCallError({
            code: PLUGIN_RPC_ERROR_CODES.WORKER_UNAVAILABLE,
            message: `Cannot call "${method}" — worker for "${pluginId}" is ${status}`,
          }),
        );
      }
      if (
        !REQUIRED_WORKER_METHODS.has(method)
        && !supportedMethods.includes(method as HostToWorkerOptionalMethodName)
      ) {
        return Promise.reject(
          new JsonRpcCallError({
            code: PLUGIN_RPC_ERROR_CODES.METHOD_NOT_IMPLEMENTED,
            message: `Cannot call "${method}" — worker for "${pluginId}" did not advertise it during initialization`,
          }),
        );
      }
      return callInternal(method, params, timeoutMs, invocationScope);
    },

    diagnostics(): WorkerDiagnostics {
      return {
        pluginId,
        status,
        pid: childProcess?.pid ?? null,
        uptime:
          startedAt !== null && status === "running"
            ? Date.now() - startedAt
            : null,
        consecutiveCrashes,
        totalCrashes,
        pendingRequests: pendingRequests.size,
        lastCrashAt,
        nextRestartAt,
      };
    },
  };

  return handle;
}

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
 *   hostHandlers: createHostClientHandlers({ pluginId: "acme.linear", capabilities, services }),
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
    async startWorker(
      pluginId: string,
      options: WorkerStartOptions,
    ): Promise<PluginWorkerHandle> {
      // Mutex: if a start is already in-flight for this plugin, wait for it
      const inFlight = startupLocks.get(pluginId);
      if (inFlight) {
        log.warn({ pluginId }, "concurrent startWorker call — waiting for in-flight start");
        return inFlight;
      }

      const existing = workers.get(pluginId);
      if (existing && existing.status !== "stopped") {
        throw new Error(
          `Worker already registered for plugin "${pluginId}" (status: ${existing.status})`,
        );
      }

      const handle = createPluginWorkerHandle(pluginId, options);
      workers.set(pluginId, handle);

      log.info({ pluginId }, "starting plugin worker");

      // Set the lock before awaiting start() to prevent concurrent spawns
      const startPromise = handle.start().then(() => handle).finally(() => {
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
      await Promise.all(Array.from(workers.entries()).map(async ([pluginId, handle]) => {
        try {
          await handle.stop();
          workers.delete(pluginId);
        } catch (err) {
          errors.push(err);
        }
      }));
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
