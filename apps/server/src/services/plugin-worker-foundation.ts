import type { PaperclipPluginManifestV1, PluginWorkerStatus } from "@paperclipai/shared";
import {
  HOST_TO_WORKER_OPTIONAL_METHODS,
  HOST_TO_WORKER_REQUIRED_METHODS,
  type HostClientHandlers,
  type HostToWorkerMethodName,
  type HostToWorkerMethods,
  type HostToWorkerOptionalMethodName,
  type JsonRpcId,
  type JsonRpcResponse,
  type PluginHealthDiagnostics,
  type PluginInvocationScope,
} from "@paperclipai/plugin-sdk";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default timeout for RPC calls in milliseconds. */
export const DEFAULT_RPC_TIMEOUT_MS = 30_000;

/** Hard upper bound for any RPC timeout (15 minutes). Prevents unbounded waits. */
export const MAX_RPC_TIMEOUT_MS = 15 * 60 * 1_000;

/** Timeout for the initialize RPC call. */
export const INITIALIZE_TIMEOUT_MS = 15_000;

/** Timeout for the shutdown RPC call before escalating to SIGTERM. */
export const SHUTDOWN_DRAIN_MS = 10_000;

/** Time to wait after SIGTERM before sending SIGKILL. */
export const SIGTERM_GRACE_MS = 5_000;

/** Minimum backoff delay for crash recovery (1 second). */
export const MIN_BACKOFF_MS = 1_000;

/** Maximum backoff delay for crash recovery (5 minutes). */
export const MAX_BACKOFF_MS = 5 * 60 * 1_000;

/** Backoff multiplier on each consecutive crash. */
export const BACKOFF_MULTIPLIER = 2;

/** Maximum number of consecutive crashes before giving up on auto-restart. */
export const MAX_CONSECUTIVE_CRASHES = 10;

/** Time window in which crashes are considered consecutive (10 minutes). */
export const CRASH_WINDOW_MS = 10 * 60 * 1_000;

/** Maximum number of stderr characters retained for worker failure context. */
export const MAX_STDERR_EXCERPT_CHARS = 8_000;

/** Privileged prompt hook whose manifest grant and worker method must agree. */
export const PROMPT_OBSERVE_CAPABILITY = "runtime.prompt.observe";
export const BEFORE_PROMPT_METHOD = "beforePrompt";
export const REQUIRED_WORKER_METHODS = new Set<string>(HOST_TO_WORKER_REQUIRED_METHODS);
export const OPTIONAL_WORKER_METHODS = new Set<string>(HOST_TO_WORKER_OPTIONAL_METHODS);
export const NO_OPTIONAL_WORKER_METHODS = Object.freeze([] as HostToWorkerOptionalMethodName[]);

export interface ManifestWorkerMethodRule {
  readonly method: HostToWorkerOptionalMethodName;
  readonly declared: boolean;
  readonly requiredMessage: string;
  readonly undeclaredMessage: string;
}

export function manifestWorkerMethodRules(
  manifest: PaperclipPluginManifestV1,
): readonly ManifestWorkerMethodRule[] {
  const declaresPromptObserve = manifest.capabilities.includes(PROMPT_OBSERVE_CAPABILITY);
  const declaresTools = (manifest.tools?.length ?? 0) > 0;
  const declaresJobs = (manifest.jobs?.length ?? 0) > 0;
  const declaresWebhooks = (manifest.webhooks?.length ?? 0) > 0;
  const declaresApiRoutes = (manifest.apiRoutes?.length ?? 0) > 0;

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
  ];
}

export function assertManifestWorkerMethodAgreement(
  manifest: PaperclipPluginManifestV1,
  supportedMethods: readonly HostToWorkerOptionalMethodName[],
): void {
  for (const rule of manifestWorkerMethodRules(manifest)) {
    const advertised = supportedMethods.includes(rule.method);
    if (rule.declared !== advertised) {
      throw new Error(rule.declared ? rule.requiredMessage : rule.undeclaredMessage);
    }
  }
  for (const [method, capability] of [
    ["onEvent", "events.subscribe"],
    ["tasks.creatorCallback.deliver", "tasks.create"],
  ] as const) {
    if (supportedMethods.includes(method) && !manifest.capabilities.includes(capability)) {
      throw new Error(`Worker advertised "${method}" without manifest capability "${capability}"`);
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
  if (health.status !== "ok" && health.status !== "degraded" && health.status !== "error") {
    throw new Error('Worker health status must be "ok", "degraded", or "error"');
  }
  if ("message" in health && typeof health.message !== "string") {
    throw new Error("Worker health message must be a string");
  }
  if (
    "details" in health &&
    (typeof health.details !== "object" || health.details === null || Array.isArray(health.details))
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
  return next.length <= MAX_STDERR_EXCERPT_CHARS ? next : next.slice(-MAX_STDERR_EXCERPT_CHARS);
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
export interface PendingRequest {
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

export interface ActiveInvocation {
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
export interface WorkerDiagnostics {
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
