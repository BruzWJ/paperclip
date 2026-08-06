/**
 * Worker-side RPC host — runs inside the child process spawned by the host.
 *
 * This module is the worker-side counterpart to the server's
 * `PluginWorkerManager`. It:
 *
 * 1. Reads newline-delimited JSON-RPC 2.0 requests from **stdin**
 * 2. Dispatches them to the appropriate plugin handler (events, jobs, tools, …)
 * 3. Writes JSON-RPC 2.0 responses back on **stdout**
 * 4. Provides a concrete `PluginContext` whose SDK client methods (e.g.
 *    `ctx.state.get()`, `ctx.events.emit()`) send JSON-RPC requests to the
 *    host on stdout and await responses on stdin.
 *
 * ## Message flow
 *
 * ```
 * Host (parent)                          Worker (this module)
 *   |                                        |
 *   |--- request(initialize) ------------->  |  → calls plugin.setup(ctx)
 *   |<-- response(ok:true) ----------------  |
 *   |                                        |
 *   |--- request(onEvent) ---------------->  |  → dispatches to registered handler
 *   |<-- response(void) -------------------  |
 *   |                                        |
 *   |<-- request(state.get) ---------------  |  ← SDK client call from plugin code
 *   |--- response(result) ---------------->  |
 *   |                                        |
 *   |--- request(shutdown) --------------->  |  → calls plugin.onShutdown()
 *   |<-- response(void) ------------------  |
 *   |                                        (process exits)
 * ```
 *
 * @see PLUGIN_SPEC.md §12 — Process Model
 * @see PLUGIN_SPEC.md §13 — Host-Worker Protocol
 * @see PLUGIN_SPEC.md §14 — SDK Surface
 */

import fs from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";

import type { PaperclipPlugin } from "./define-plugin.js";
import type {
  PluginApiRequestInput,
  PluginHealthDiagnostics,
  PluginConfigValidationResult,
  PluginWebhookInput,
} from "./define-plugin.js";
import type {
  PluginContext,
  PluginEvent,
  PluginJobContext,
  ScopeKey,
  PluginToolRunContext,
  ToolResult,
  EventFilter,
  PluginEventPattern,
} from "./types.js";
import type {
  JsonRpcMessage,
  JsonRpcRequest,
  JsonRpcResponse,
  InitializeParams,
  InitializeResult,
  ValidateConfigParams,
  OnEventParams,
  RunJobParams,
  GetDataParams,
  PerformActionParams,
  PluginPerformActionActorContext,
  PluginPerformActionContext,
  ExecuteToolParams,
  DetectExternalObjectsParams,
  ResolveExternalObjectParams,
  PluginEnvironmentAcquireLeaseParams,
  PluginEnvironmentDestroyLeaseParams,
  PluginEnvironmentExecuteParams,
  PluginEnvironmentCancelExecutionParams,
  PluginEnvironmentSyncParams,
  PluginEnvironmentRealizeWorkspaceParams,
  PluginEnvironmentReleaseLeaseParams,
  PluginEnvironmentResumeLeaseParams,
  PluginEnvironmentValidateConfigParams,
  PluginEnvironmentProbeParams,
  PluginEnvironmentStartInteractiveSetupParams,
  PluginEnvironmentGetInteractiveSetupParams,
  PluginEnvironmentCaptureTemplateParams,
  PluginEnvironmentCancelInteractiveSetupParams,
  PluginEnvironmentDeleteTemplateParams,
  PluginInvocationContext,
  HostToWorkerMethods,
  HostToWorkerOptionalMethodName,
  WorkerToHostMethodName,
  WorkerToHostMethods,
} from "./protocol.js";
import {
  JSONRPC_ERROR_CODES,
  PLUGIN_RPC_ERROR_CODES,
  createRequest,
  createSuccessResponse,
  createErrorResponse,
  parseMessage,
  serializeMessage,
  isJsonRpcResponse,
  isJsonRpcSuccessResponse,
  isJsonRpcErrorResponse,
  JsonRpcCallError,
  decodePluginPerformActionActorContext,
} from "./protocol.js";
import { pluginEventMatchesFilter } from "./event-filter.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Options for starting the worker-side RPC host.
 */
export interface WorkerRpcHostOptions {
  /**
   * The plugin definition returned by `definePlugin()`.
   *
   * The worker entrypoint should import its plugin and pass it here.
   */
  plugin: PaperclipPlugin;

  /**
   * Input stream to read JSON-RPC messages from.
   * Defaults to `process.stdin`.
   */
  stdin?: NodeJS.ReadableStream;

  /**
   * Output stream to write JSON-RPC messages to.
   * Defaults to `process.stdout`.
   */
  stdout?: NodeJS.WritableStream;

  /**
   * Default timeout (ms) for worker→host RPC calls.
   * Defaults to 30 000 ms.
   */
  rpcTimeoutMs?: number;
}

/**
 * A running worker RPC host instance.
 *
 * Returned by `startWorkerRpcHost()`. Callers (usually just the worker
 * bootstrap) hold a reference so they can inspect status or force-stop.
 */
export interface WorkerRpcHost {
  /** Whether the host is currently running and listening for messages. */
  readonly running: boolean;

  /**
   * Stop the RPC host immediately. Closes readline, rejects pending
   * outbound calls, and does NOT call the plugin's shutdown hook (that
   * should have already been called via the `shutdown` RPC method).
   */
  stop(): void;
}

// ---------------------------------------------------------------------------
// Internal: event registration
// ---------------------------------------------------------------------------

interface EventRegistration {
  name: PluginEventPattern;
  filter?: EventFilter;
  fn: (event: PluginEvent) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default timeout for worker→host RPC calls. */
const DEFAULT_RPC_TIMEOUT_MS = 30_000;

function realpathOrResolvedPath(filePath: string): string {
  const resolvedPath = path.resolve(filePath);
  try {
    return fs.realpathSync.native(resolvedPath);
  } catch {
    return resolvedPath;
  }
}

function isWorkerEntrypoint(entry: string, moduleUrl: string): boolean {
  const thisFile = realpathOrResolvedPath(fileURLToPath(moduleUrl));
  const entryPath = realpathOrResolvedPath(entry);
  return thisFile === entryPath;
}

// ---------------------------------------------------------------------------
// startWorkerRpcHost
// ---------------------------------------------------------------------------

/**
 * Start the worker when this module is the process entrypoint.
 *
 * Call this at the bottom of your worker file so that when the host runs
 * `node dist/worker.js`, the RPC host starts and the process stays alive.
 * When the module is imported (e.g. for re-exports or tests), nothing runs.
 *
 * @example
 * ```ts
 * const plugin = definePlugin({ ... });
 * export default plugin;
 * runWorker(plugin, import.meta.url);
 * ```
 */
export function runWorker(
  plugin: PaperclipPlugin,
  moduleUrl: string,
): void {
  const entry = process.argv[1];
  if (typeof entry !== "string") return;
  if (isWorkerEntrypoint(entry, moduleUrl)) {
    startWorkerRpcHost({ plugin });
  }
}

/**
 * Internal low-level worker host used by SDK conformance tests. Production
 * plugin entrypoints use `runWorker()`.
 */
export function startWorkerRpcHost(options: WorkerRpcHostOptions): WorkerRpcHost {
  const { plugin } = options;
  const stdinStream = options.stdin ?? process.stdin;
  const stdoutStream = options.stdout ?? process.stdout;
  const rpcTimeoutMs = options.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;

  // -----------------------------------------------------------------------
  // State
  // -----------------------------------------------------------------------

  let running = true;
  let acceptingHostRequests = true;
  let initialized = false;
  let manifest: PaperclipPluginManifestV1 | null = null;
  let databaseNamespace: string | null = null;
  const invocationContextStorage = new AsyncLocalStorage<PluginInvocationContext>();

  // Host requests are concurrent by design. Shutdown closes intake first,
  // then waits this exact accepted set without imposing a second deadline;
  // the parent worker manager owns timeout and forced termination.
  const activeHostRequests = new Set<Promise<void>>();

  // Plugin handler registrations (populated during setup())
  const eventHandlers: EventRegistration[] = [];
  const jobHandlers = new Map<string, (job: PluginJobContext) => Promise<void>>();
  const dataHandlers = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>();
  const actionHandlers = new Map<
    string,
    (params: Record<string, unknown>, context: PluginPerformActionContext) => Promise<unknown>
  >();
  const toolHandlers = new Map<
    string,
    (params: unknown, runContext: PluginToolRunContext) => Promise<ToolResult>
  >();
  const creatorCallbackHandlers = new Map<
    string,
    import("./types.js").PluginCreatorCallbackHandler
  >();

  // Pending outbound (worker→host) requests
  const pendingRequests = new Map<string | number, {
    resolve: (response: JsonRpcResponse) => void;
    timer: ReturnType<typeof setTimeout> | null;
  }>();
  let nextOutboundId = 1;
  const MAX_OUTBOUND_ID = Number.MAX_SAFE_INTEGER - 1;

  // -----------------------------------------------------------------------
  // Outbound messaging (worker → host)
  // -----------------------------------------------------------------------

  function sendMessage(message: JsonRpcMessage): void {
    if (!running) return;
    const serialized = serializeMessage(message);
    stdoutStream.write(serialized);
  }

  function workerErrorCode(error: unknown): number {
    const code = (error as { code?: unknown } | null)?.code;
    return typeof code === "number" ? code : PLUGIN_RPC_ERROR_CODES.WORKER_ERROR;
  }

  /**
   * Send a typed JSON-RPC request to the host and await the response.
   */
  function callHost<M extends WorkerToHostMethodName>(
    method: M,
    params: WorkerToHostMethods[M][0],
    options?: {
      timeoutMs?: number;
      retryTransportTimeout?: boolean;
    },
  ): Promise<WorkerToHostMethods[M][1]> {
    return new Promise<WorkerToHostMethods[M][1]>((resolve, reject) => {
      if (!running) {
        reject(new Error(`Cannot call "${method}" — worker RPC host is not running`));
        return;
      }

      if (nextOutboundId >= MAX_OUTBOUND_ID) {
        nextOutboundId = 1;
      }
      const id = nextOutboundId++;
      const timeout = options?.timeoutMs ?? rpcTimeoutMs;
      const maxAttempts = options?.retryTransportTimeout ? 2 : 1;
      let settled = false;
      let attemptsSent = 0;
      const activeInvocation = invocationContextStorage.getStore();
      const request = {
        ...createRequest(method, params, id),
        ...(activeInvocation ? { paperclipInvocationId: activeInvocation.id } : {}),
      };
      const serializedRequest = serializeMessage(request);

      const settle = <T>(fn: (value: T) => void, value: T): void => {
        if (settled) return;
        settled = true;
        if (pending.timer) clearTimeout(pending.timer);
        pendingRequests.delete(id);
        fn(value);
      };

      const pending = {
        resolve: (response: JsonRpcResponse) => {
          if (isJsonRpcSuccessResponse(response)) {
            settle(resolve, response.result as WorkerToHostMethods[M][1]);
          } else if (isJsonRpcErrorResponse(response)) {
            settle(reject, new JsonRpcCallError(response.error));
          } else {
            settle(reject, new Error(`Unexpected response format for "${method}"`));
          }
        },
        timer: null as ReturnType<typeof setTimeout> | null,
      };
      pendingRequests.set(id, pending);

      const sendAttempt = (): void => {
        attemptsSent += 1;
        pending.timer = setTimeout(() => {
          pending.timer = null;
          if (attemptsSent < maxAttempts) {
            sendAttempt();
            return;
          }
          settle(
            reject,
            new JsonRpcCallError({
              code: PLUGIN_RPC_ERROR_CODES.TIMEOUT,
              message: `Worker→host call "${method}" timed out after ${timeout}ms`,
            }),
          );
        }, timeout);

        try {
          stdoutStream.write(serializedRequest);
        } catch (err) {
          settle(reject, err instanceof Error ? err : new Error(String(err)));
        }
      };

      sendAttempt();
    });
  }

  // -----------------------------------------------------------------------
  // Build the PluginContext (SDK surface for plugin code)
  // -----------------------------------------------------------------------

  function buildContext(): PluginContext {
    return {
      get manifest() {
        if (!manifest) throw new Error("Plugin context accessed before initialization");
        return manifest;
      },

      config: {
        async get() {
          return callHost("config.get", {});
        },
      },

      localFolders: {
        async configure(input) {
          return callHost("localFolders.configure", {
            companyId: input.companyId,
            folderKey: input.folderKey,
            path: input.path,
          });
        },

        async status(companyId: string, folderKey: string) {
          return callHost("localFolders.status", { companyId, folderKey });
        },

        async list(companyId: string, folderKey: string, options = {}) {
          return callHost("localFolders.list", {
            companyId,
            folderKey,
            relativePath: options.relativePath,
            recursive: options.recursive,
            maxEntries: options.maxEntries,
          });
        },

        async readText(companyId: string, folderKey: string, relativePath: string) {
          return callHost("localFolders.readText", { companyId, folderKey, relativePath });
        },

        async writeTextAtomic(companyId: string, folderKey: string, relativePath: string, contents: string) {
          return callHost("localFolders.writeTextAtomic", {
            companyId,
            folderKey,
            relativePath,
            contents,
          });
        },

        async deleteFile(companyId: string, folderKey: string, relativePath: string) {
          return callHost("localFolders.deleteFile", { companyId, folderKey, relativePath });
        },
      },

      events: {
        on(
          name: PluginEventPattern,
          filterOrFn: EventFilter | ((event: PluginEvent) => Promise<void>),
          maybeFn?: (event: PluginEvent) => Promise<void>,
        ): () => void {
          if (initialized) {
            throw new Error("Event handlers may only be registered during plugin setup");
          }
          let registration: EventRegistration;
          if (typeof filterOrFn === "function") {
            registration = { name, fn: filterOrFn };
          } else {
            if (!maybeFn) throw new Error("Event handler function is required");
            registration = { name, filter: filterOrFn, fn: maybeFn };
          }
          eventHandlers.push(registration);
          return () => {
            const idx = eventHandlers.indexOf(registration);
            if (idx !== -1) eventHandlers.splice(idx, 1);
          };
        },

        async emit(name: string, companyId: string, payload: unknown): Promise<void> {
          await callHost("events.emit", { name, companyId, payload });
        },
      },

      jobs: {
        register(key: string, fn: (job: PluginJobContext) => Promise<void>): void {
          if (!manifest) {
            throw new Error("Plugin manifest is unavailable during job registration");
          }
          if (!(manifest.jobs ?? []).some((job) => job.jobKey === key)) {
            throw new Error(`Job handler "${key}" is not declared in manifest.jobs`);
          }
          if (jobHandlers.has(key)) {
            throw new Error(`Job handler "${key}" is registered more than once`);
          }
          jobHandlers.set(key, fn);
        },
      },

      db: {
        get namespace() {
          if (databaseNamespace === null) {
            throw new Error(
              "Plugin database namespace is unavailable because the manifest does not declare a database",
            );
          }
          return databaseNamespace;
        },
        async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
          return callHost("db.query", { sql, params }) as Promise<T[]>;
        },
        async execute(sql: string, params?: unknown[]) {
          return callHost("db.execute", { sql, params });
        },
      },

      http: {
        async fetch(url: string, init?: RequestInit): Promise<Response> {
          const serializedInit: Record<string, unknown> = {};
          if (init) {
            if (init.method) serializedInit.method = init.method;
            if (init.headers) {
              // Normalize headers to a plain object
              if (init.headers instanceof Headers) {
                const obj: Record<string, string> = {};
                init.headers.forEach((v, k) => { obj[k] = v; });
                serializedInit.headers = obj;
              } else if (Array.isArray(init.headers)) {
                const obj: Record<string, string> = {};
                for (const [k, v] of init.headers) obj[k] = v;
                serializedInit.headers = obj;
              } else {
                serializedInit.headers = init.headers;
              }
            }
            if (init.body !== undefined && init.body !== null) {
              serializedInit.body = typeof init.body === "string"
                ? init.body
                : String(init.body);
            }
          }

          const result = await callHost("http.fetch", {
            url,
            init: Object.keys(serializedInit).length > 0 ? serializedInit : undefined,
          });

          // Reconstruct a Response-like object from the serialized result
          return new Response(result.body, {
            status: result.status,
            statusText: result.statusText,
            headers: result.headers,
          });
        },
      },

      runtime: {
        records: {
          async readSession(input) {
            return callHost("runtime.records.readSession", input);
          },
          async readRun(input) {
            return callHost("runtime.records.readRun", input);
          },
          async readIssueComments(input) {
            return callHost("runtime.records.readIssueComments", input);
          },
        },
      },

      activity: {
        async log(entry): Promise<void> {
          await callHost("activity.log", {
            companyId: entry.companyId,
            message: entry.message,
            entityType: entry.entityType,
            entityId: entry.entityId,
            metadata: entry.metadata,
          });
        },
      },

      state: {
        async get(input: ScopeKey): Promise<unknown> {
          return callHost("state.get", input);
        },

        async set(input: ScopeKey, value: unknown): Promise<void> {
          await callHost("state.set", { ...input, value });
        },

        async delete(input: ScopeKey): Promise<void> {
          await callHost("state.delete", input);
        },
      },

      entities: {
        async upsert(input) {
          return callHost("entities.upsert", input);
        },

        async list(query) {
          return callHost("entities.list", query);
        },
      },

      projects: {
        async list(input) {
          return callHost("projects.list", {
            companyId: input.companyId,
            limit: input.limit,
            offset: input.offset,
          });
        },

        async get(projectId: string, companyId: string) {
          return callHost("projects.get", { projectId, companyId });
        },

        async listWorkspaces(projectId: string, companyId: string) {
          return callHost("projects.listWorkspaces", { projectId, companyId });
        },

        async getPrimaryWorkspace(projectId: string, companyId: string) {
          return callHost("projects.getPrimaryWorkspace", { projectId, companyId });
        },

        managed: {
          async get(projectKey: string, companyId: string) {
            return callHost("projects.managed.get", { projectKey, companyId });
          },
          async reconcile(projectKey: string, companyId: string) {
            return callHost("projects.managed.reconcile", { projectKey, companyId });
          },
          async reset(projectKey: string, companyId: string) {
            return callHost("projects.managed.reset", { projectKey, companyId });
          },
        },
      },

      executionWorkspaces: {
        async get(workspaceId: string, companyId: string) {
          return callHost("executionWorkspaces.get", { workspaceId, companyId });
        },
      },

      routines: {
        managed: {
          async get(routineKey: string, companyId: string) {
            return callHost("routines.managed.get", { routineKey, companyId });
          },
          async reconcile(
            routineKey: string,
            companyId: string,
            overrides?: { assigneeAgentId?: string | null; projectId?: string | null },
          ) {
            return callHost("routines.managed.reconcile", { routineKey, companyId, ...overrides });
          },
          async reset(
            routineKey: string,
            companyId: string,
            overrides?: { assigneeAgentId?: string | null; projectId?: string | null },
          ) {
            return callHost("routines.managed.reset", { routineKey, companyId, ...overrides });
          },
          async update(
            routineKey: string,
            companyId: string,
            patch: Parameters<PluginContext["routines"]["managed"]["update"]>[2],
          ) {
            return callHost("routines.managed.update", { routineKey, companyId, ...patch });
          },
          async run(
            routineKey: string,
            companyId: string,
            overrides?: { assigneeAgentId?: string | null; projectId?: string | null },
          ) {
            return callHost("routines.managed.run", { routineKey, companyId, ...overrides });
          },
        },
      },

      skills: {
        managed: {
          async get(skillKey: string, companyId: string) {
            return callHost("skills.managed.get", { skillKey, companyId });
          },
          async reconcile(skillKey: string, companyId: string) {
            return callHost("skills.managed.reconcile", { skillKey, companyId });
          },
          async reset(skillKey: string, companyId: string) {
            return callHost("skills.managed.reset", { skillKey, companyId });
          },
        },
      },

      companies: {
        async list(input) {
          return callHost("companies.list", {
            limit: input?.limit,
            offset: input?.offset,
          });
        },

        async get(companyId: string) {
          return callHost("companies.get", { companyId });
        },
      },

      issues: {
        async list(input) {
          return callHost("issues.list", {
            companyId: input.companyId,
            projectId: input.projectId,
            ownerAgentId: input.ownerAgentId,
            status: input.status,
            limit: input.limit,
            offset: input.offset,
          });
        },

        async get(issueId: string, companyId: string) {
          return callHost("issues.get", { issueId, companyId });
        },

        async registerCreatorCallback(registration, handler) {
          const key = registration.key.trim();
          const version = registration.version.trim();
          if (!key || !version) {
            throw new Error("Creator callback key and version are required");
          }
          const identity = `${key}\u0000${version}`;
          if (creatorCallbackHandlers.has(identity)) {
            throw new Error(`Creator callback is already registered: ${key}@${version}`);
          }
          creatorCallbackHandlers.set(identity, handler);
          try {
            await callHost("issues.creatorCallback.register", {
              callbackKey: key,
              callbackVersion: version,
            });
          } catch (error) {
            creatorCallbackHandlers.delete(identity);
            throw error;
          }
        },

        async create(input) {
          return callHost("issues.create", {
            companyId: input.companyId,
            request: input.request,
            ownerAgentId: input.ownerAgentId,
            callbackKey: input.callbackKey,
            callbackVersion: input.callbackVersion,
            title: input.title,
            projectId: input.projectId,
            goalId: input.goalId,
            parentId: input.parentId,
            priority: input.priority,
            contextAccessMask: input.contextAccessMask,
          }, {
            retryTransportTimeout: true,
          });
        },

        async update(issueId: string, input, companyId: string) {
          return callHost("issues.update", {
            issueId,
            input,
            companyId,
          }, {
            retryTransportTimeout: true,
          });
        },

        async withdraw(issueId: string, message: string, companyId: string) {
          return callHost("issues.withdraw", {
            issueId,
            companyId,
            message,
          }, {
            retryTransportTimeout: true,
          });
        },
      },

      agents: {
        async list(input) {
          return callHost("agents.list", {
            companyId: input.companyId,
            status: input.status,
            limit: input.limit,
            offset: input.offset,
          });
        },

        async get(agentId: string, companyId: string) {
          return callHost("agents.get", { agentId, companyId });
        },

        async pause(agentId: string, companyId: string) {
          return callHost("agents.pause", { agentId, companyId });
        },

        async resume(agentId: string, companyId: string) {
          return callHost("agents.resume", { agentId, companyId });
        },

        managed: {
          async get(agentKey: string, companyId: string) {
            return callHost("agents.managed.get", { agentKey, companyId });
          },

          async reconcile(agentKey: string, companyId: string) {
            return callHost("agents.managed.reconcile", { agentKey, companyId });
          },

          async reset(agentKey: string, companyId: string) {
            return callHost("agents.managed.reset", { agentKey, companyId });
          },
        },
      },

      goals: {
        async list(input) {
          return callHost("goals.list", {
            companyId: input.companyId,
            level: input.level,
            status: input.status,
            limit: input.limit,
            offset: input.offset,
          });
        },

        async get(goalId: string, companyId: string) {
          return callHost("goals.get", { goalId, companyId });
        },

        async create(input) {
          return callHost("goals.create", {
            companyId: input.companyId,
            title: input.title,
            description: input.description,
            level: input.level,
            status: input.status,
            parentId: input.parentId,
            ownerAgentId: input.ownerAgentId,
          });
        },

        async update(goalId: string, patch, companyId: string) {
          return callHost("goals.update", {
            goalId,
            patch,
            companyId,
          });
        },
      },

      access: {
        members: {
          async list(input) {
            return callHost("access.members.list", {
              companyId: input.companyId,
              includeArchived: input.includeArchived,
            });
          },

          async get(memberId: string, companyId: string) {
            return callHost("access.members.get", { memberId, companyId });
          },

          async update(memberId: string, patch, companyId: string) {
            return callHost("access.members.update", { memberId, patch, companyId });
          },
        },

        invites: {
          async list(input) {
            return callHost("access.invites.list", {
              companyId: input.companyId,
              state: input.state,
              limit: input.limit,
              offset: input.offset,
            });
          },

          async create(input) {
            return callHost("access.invites.create", {
              companyId: input.companyId,
              allowedJoinTypes: input.allowedJoinTypes,
              humanRole: input.humanRole,
              defaultsPayload: input.defaultsPayload,
              agentMessage: input.agentMessage,
            });
          },

          async revoke(inviteId: string, companyId: string) {
            return callHost("access.invites.revoke", { inviteId, companyId });
          },
        },
      },

      authorization: {
        grants: {
          async list(input) {
            return callHost("authorization.grants.list", input);
          },
          async set(input) {
            return callHost("authorization.grants.set", input);
          },
        },

        policies: {
          async summary(companyId: string) {
            return callHost("authorization.policies.summary", { companyId });
          },
          async get(input) {
            return callHost("authorization.policies.get", input);
          },
          async update(input) {
            return callHost("authorization.policies.update", input);
          },
          async previewAssignment(input) {
            return callHost("authorization.policies.previewAssignment", input);
          },
        },

        audit: {
          async search(input) {
            return callHost("authorization.audit.search", input);
          },
        },
      },

      data: {
        register(key: string, handler: (params: Record<string, unknown>) => Promise<unknown>): void {
          if (dataHandlers.has(key)) {
            throw new Error(`Data handler "${key}" is registered more than once`);
          }
          dataHandlers.set(key, handler);
        },
      },

      actions: {
        register(
          key: string,
          handler: (params: Record<string, unknown>, context: PluginPerformActionContext) => Promise<unknown>,
        ): void {
          if (actionHandlers.has(key)) {
            throw new Error(`Action handler "${key}" is registered more than once`);
          }
          actionHandlers.set(key, handler);
        },
      },

      tools: {
        register(
          name: string,
          handler: (
            params: unknown,
            runContext: PluginToolRunContext,
          ) => Promise<ToolResult>,
        ): void {
          if (!manifest) {
            throw new Error("Plugin manifest is unavailable during tool registration");
          }
          if (!(manifest.tools ?? []).some((tool) => tool.name === name)) {
            throw new Error(`Tool handler "${name}" is not declared in manifest.tools`);
          }
          if (toolHandlers.has(name)) {
            throw new Error(`Tool handler "${name}" is registered more than once`);
          }
          toolHandlers.set(name, handler);
        },
      },

      metrics: {
        async write(name: string, value: number, tags?: Record<string, string>): Promise<void> {
          await callHost("metrics.write", { name, value, tags });
        },
      },

      telemetry: {
        async track(
          eventName: string,
          dimensions?: Record<string, string | number | boolean>,
        ): Promise<void> {
          await callHost("telemetry.track", { eventName, dimensions });
        },
      },

      logger: {
        async info(message: string, meta?: Record<string, unknown>): Promise<void> {
          await callHost("log", { level: "info", message, meta });
        },
        async warn(message: string, meta?: Record<string, unknown>): Promise<void> {
          await callHost("log", { level: "warn", message, meta });
        },
        async error(message: string, meta?: Record<string, unknown>): Promise<void> {
          await callHost("log", { level: "error", message, meta });
        },
        async debug(message: string, meta?: Record<string, unknown>): Promise<void> {
          await callHost("log", { level: "debug", message, meta });
        },
      },
    };
  }

  const ctx = buildContext();

  // -----------------------------------------------------------------------
  // Inbound message handling (host → worker)
  // -----------------------------------------------------------------------

  /**
   * Handle an incoming JSON-RPC request from the host.
   *
   * Dispatches to the correct handler based on the method name.
   */
  async function handleHostRequest(request: JsonRpcRequest): Promise<void> {
    const { id, method, params } = request;

    try {
      const invoke = () => dispatchMethod(method, params);
      const result = request.paperclipInvocation
        ? await invocationContextStorage.run(request.paperclipInvocation, invoke)
        : await invoke();
      sendMessage(createSuccessResponse(id, result ?? null));
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      // Propagate specific error codes from handler errors (e.g.
      // METHOD_NOT_FOUND, METHOD_NOT_IMPLEMENTED) — fall back to
      // WORKER_ERROR for untyped exceptions.
      const errorCode = workerErrorCode(err);

      sendMessage(createErrorResponse(id, errorCode, errorMessage));
    }
  }

  /**
   * Dispatch a host→worker method call to the appropriate handler.
   */
  async function dispatchMethod(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "initialize":
        return handleInitialize(params as InitializeParams);

      case "health":
        return handleHealth();

      case "shutdown":
        return handleShutdown();

      case "validateConfig":
        return handleValidateConfig(params as ValidateConfigParams);

      case "beforePrompt":
        return handleBeforePrompt(params as HostToWorkerMethods["beforePrompt"][0]);

      case "onEvent":
        return handleOnEvent(params as OnEventParams);

      case "runJob":
        return handleRunJob(params as RunJobParams);

      case "handleWebhook":
        return handleWebhook(params as PluginWebhookInput);

      case "handleApiRequest":
        return handleApiRequest(params as PluginApiRequestInput);

      case "getData":
        return handleGetData(params as GetDataParams);

      case "performAction":
        return handlePerformAction(params as PerformActionParams);

      case "executeTool":
        return handleExecuteTool(params as ExecuteToolParams);
      case "issues.creatorCallback.deliver": {
        const input = params as HostToWorkerMethods["issues.creatorCallback.deliver"][0];
        const handler = creatorCallbackHandlers.get(
          `${input.callbackKey}\u0000${input.callbackVersion}`,
        );
        if (!handler) {
          throw Object.assign(
            new Error(
              `Creator callback is not registered: ${input.callbackKey}@${input.callbackVersion}`,
            ),
            { code: JSONRPC_ERROR_CODES.METHOD_NOT_FOUND },
          );
        }
        const acknowledgement = await handler(input.delivery);
        if (
          acknowledgement.deliveryId !== input.delivery.deliveryId ||
          acknowledgement.accepted !== true
        ) {
          throw new Error(
            "Creator callback acknowledgement must exactly accept the delivered id",
          );
        }
        return acknowledgement;
      }
      case "detectExternalObjects":
        return handleDetectExternalObjects(params as DetectExternalObjectsParams);
      case "resolveExternalObject":
        return handleResolveExternalObject(params as ResolveExternalObjectParams);
      case "environmentValidateConfig":
        return handleEnvironmentValidateConfig(params as PluginEnvironmentValidateConfigParams);

      case "environmentProbe":
        return handleEnvironmentProbe(params as PluginEnvironmentProbeParams);

      case "environmentAcquireLease":
        return handleEnvironmentAcquireLease(params as PluginEnvironmentAcquireLeaseParams);

      case "environmentResumeLease":
        return handleEnvironmentResumeLease(params as PluginEnvironmentResumeLeaseParams);

      case "environmentReleaseLease":
        return handleEnvironmentReleaseLease(params as PluginEnvironmentReleaseLeaseParams);

      case "environmentDestroyLease":
        return handleEnvironmentDestroyLease(params as PluginEnvironmentDestroyLeaseParams);

      case "environmentRealizeWorkspace":
        return handleEnvironmentRealizeWorkspace(params as PluginEnvironmentRealizeWorkspaceParams);

      case "environmentExecute":
        return handleEnvironmentExecute(params as PluginEnvironmentExecuteParams);

      case "environmentCancelExecution":
        return handleEnvironmentCancelExecution(params as PluginEnvironmentCancelExecutionParams);

      case "environmentSyncIn":
        return handleEnvironmentSyncIn(params as PluginEnvironmentSyncParams);

      case "environmentSyncOut":
        return handleEnvironmentSyncOut(params as PluginEnvironmentSyncParams);

      case "environmentStartInteractiveSetup":
        return handleEnvironmentStartInteractiveSetup(params as PluginEnvironmentStartInteractiveSetupParams);

      case "environmentGetInteractiveSetup":
        return handleEnvironmentGetInteractiveSetup(params as PluginEnvironmentGetInteractiveSetupParams);

      case "environmentCaptureTemplate":
        return handleEnvironmentCaptureTemplate(params as PluginEnvironmentCaptureTemplateParams);

      case "environmentCancelInteractiveSetup":
        return handleEnvironmentCancelInteractiveSetup(params as PluginEnvironmentCancelInteractiveSetupParams);

      case "environmentDeleteTemplate":
        return handleEnvironmentDeleteTemplate(params as PluginEnvironmentDeleteTemplateParams);

      default:
        throw Object.assign(
          new Error(`Unknown method: ${method}`),
          { code: JSONRPC_ERROR_CODES.METHOD_NOT_FOUND },
        );
    }
  }

  // -----------------------------------------------------------------------
  // Host→Worker method handlers
  // -----------------------------------------------------------------------

  async function handleInitialize(params: InitializeParams): Promise<InitializeResult> {
    if (initialized) {
      throw new Error("Worker already initialized");
    }

    manifest = params.manifest;
    databaseNamespace = params.databaseNamespace;

    // Call the plugin's setup function
    await plugin.definition.setup(ctx);

    // Event registration is part of initialization authority. Every host-side
    // subscription must be acknowledged before this worker can become ready.
    await Promise.all(eventHandlers.map((registration) =>
      callHost("events.subscribe", {
        eventPattern: registration.name,
        filter: registration.filter ?? null,
      })
    ));

    const missingToolHandlers = (params.manifest.tools ?? [])
      .map((tool) => tool.name)
      .filter((name) => !toolHandlers.has(name));
    const undeclaredToolHandlers = [...toolHandlers.keys()]
      .filter((name) => !(params.manifest.tools ?? []).some((tool) => tool.name === name));
    if (missingToolHandlers.length > 0 || undeclaredToolHandlers.length > 0) {
      const details = [
        missingToolHandlers.length > 0
          ? `missing handlers: ${missingToolHandlers.join(", ")}`
          : null,
        undeclaredToolHandlers.length > 0
          ? `undeclared handlers: ${undeclaredToolHandlers.join(", ")}`
          : null,
      ].filter((detail): detail is string => detail !== null);
      throw new Error(`Plugin tool handlers must exactly match manifest.tools (${details.join("; ")})`);
    }

    const missingJobHandlers = (params.manifest.jobs ?? [])
      .map((job) => job.jobKey)
      .filter((key) => !jobHandlers.has(key));
    const undeclaredJobHandlers = [...jobHandlers.keys()]
      .filter((key) => !(params.manifest.jobs ?? []).some((job) => job.jobKey === key));
    if (missingJobHandlers.length > 0 || undeclaredJobHandlers.length > 0) {
      const details = [
        missingJobHandlers.length > 0
          ? `missing handlers: ${missingJobHandlers.join(", ")}`
          : null,
        undeclaredJobHandlers.length > 0
          ? `undeclared handlers: ${undeclaredJobHandlers.join(", ")}`
          : null,
      ].filter((detail): detail is string => detail !== null);
      throw new Error(`Plugin job handlers must exactly match manifest.jobs (${details.join("; ")})`);
    }

    const declaresWebhooks = (params.manifest.webhooks?.length ?? 0) > 0;
    const handlesWebhooks = plugin.definition.onWebhook !== undefined;
    if (declaresWebhooks !== handlesWebhooks) {
      throw new Error(
        "manifest.webhooks and the onWebhook handler must either both be present or both be absent",
      );
    }

    const declaresApiRoutes = (params.manifest.apiRoutes?.length ?? 0) > 0;
    const handlesApiRequests = plugin.definition.onApiRequest !== undefined;
    if (declaresApiRoutes !== handlesApiRequests) {
      throw new Error(
        "manifest.apiRoutes and the onApiRequest handler must either both be present or both be absent",
      );
    }

    initialized = true;

    // Report which optional methods this plugin implements
    const supportedMethods: HostToWorkerOptionalMethodName[] = [];
    if (plugin.definition.onValidateConfig) supportedMethods.push("validateConfig");
    if (plugin.definition.onBeforePrompt) supportedMethods.push("beforePrompt");
    if (eventHandlers.length > 0) supportedMethods.push("onEvent");
    if (jobHandlers.size > 0) supportedMethods.push("runJob");
    if (handlesWebhooks) supportedMethods.push("handleWebhook");
    if (handlesApiRequests) supportedMethods.push("handleApiRequest");
    if (dataHandlers.size > 0) supportedMethods.push("getData");
    if (actionHandlers.size > 0) supportedMethods.push("performAction");
    if (toolHandlers.size > 0) supportedMethods.push("executeTool");
    if (creatorCallbackHandlers.size > 0) {
      supportedMethods.push("issues.creatorCallback.deliver");
    }
    if (plugin.definition.onDetectExternalObjects) supportedMethods.push("detectExternalObjects");
    if (plugin.definition.onResolveExternalObject) supportedMethods.push("resolveExternalObject");
    if (plugin.definition.onEnvironmentValidateConfig) supportedMethods.push("environmentValidateConfig");
    if (plugin.definition.onEnvironmentProbe) supportedMethods.push("environmentProbe");
    if (plugin.definition.onEnvironmentAcquireLease) supportedMethods.push("environmentAcquireLease");
    if (plugin.definition.onEnvironmentResumeLease) supportedMethods.push("environmentResumeLease");
    if (plugin.definition.onEnvironmentReleaseLease) supportedMethods.push("environmentReleaseLease");
    if (plugin.definition.onEnvironmentDestroyLease) supportedMethods.push("environmentDestroyLease");
    if (plugin.definition.onEnvironmentRealizeWorkspace) supportedMethods.push("environmentRealizeWorkspace");
    if (plugin.definition.onEnvironmentExecute) supportedMethods.push("environmentExecute");
    if (plugin.definition.onEnvironmentCancelExecution) supportedMethods.push("environmentCancelExecution");
    if (plugin.definition.onEnvironmentSyncIn) supportedMethods.push("environmentSyncIn");
    if (plugin.definition.onEnvironmentSyncOut) supportedMethods.push("environmentSyncOut");
    if (plugin.definition.onEnvironmentStartInteractiveSetup) supportedMethods.push("environmentStartInteractiveSetup");
    if (plugin.definition.onEnvironmentGetInteractiveSetup) supportedMethods.push("environmentGetInteractiveSetup");
    if (plugin.definition.onEnvironmentCaptureTemplate) supportedMethods.push("environmentCaptureTemplate");
    if (plugin.definition.onEnvironmentCancelInteractiveSetup) supportedMethods.push("environmentCancelInteractiveSetup");
    if (plugin.definition.onEnvironmentDeleteTemplate) supportedMethods.push("environmentDeleteTemplate");

    return { supportedMethods };
  }

  async function handleHealth(): Promise<PluginHealthDiagnostics> {
    return plugin.definition.onHealth();
  }

  async function handleShutdown(): Promise<void> {
    await Promise.allSettled([...activeHostRequests]);

    if (plugin.definition.onShutdown) {
      await plugin.definition.onShutdown();
    }

    // Schedule cleanup after we send the response.
    // Use setImmediate to let the response flush before exiting.
    // Only call process.exit() when running with real process streams.
    // When custom streams are provided (tests), just clean up.
    setImmediate(() => {
      cleanup();
      if (!options.stdin && !options.stdout) {
        process.exit(0);
      }
    });
  }

  async function handleValidateConfig(
    params: ValidateConfigParams,
  ): Promise<PluginConfigValidationResult> {
    if (!plugin.definition.onValidateConfig) {
      throw Object.assign(
        new Error("validateConfig is not implemented by this plugin"),
        { code: PLUGIN_RPC_ERROR_CODES.METHOD_NOT_IMPLEMENTED },
      );
    }
    return plugin.definition.onValidateConfig(params.config);
  }

  async function handleBeforePrompt(
    params: HostToWorkerMethods["beforePrompt"][0],
  ): Promise<HostToWorkerMethods["beforePrompt"][1]> {
    if (!plugin.definition.onBeforePrompt) {
      throw methodNotImplemented("beforePrompt");
    }
    return plugin.definition.onBeforePrompt(params);
  }

  async function handleOnEvent(params: OnEventParams): Promise<void> {
    const event = params.event;
    const errors: unknown[] = [];

    for (const registration of eventHandlers) {
      // Check event type match
      const exactMatch = registration.name === event.eventType;
      const wildcardPluginAll =
        registration.name === "plugin.*" &&
        event.eventType.startsWith("plugin.");
      const wildcardPluginOne =
        registration.name.endsWith(".*") &&
        event.eventType.startsWith(registration.name.slice(0, -1));

      if (!exactMatch && !wildcardPluginAll && !wildcardPluginOne) continue;

      // Check filter
      if (!pluginEventMatchesFilter(event, registration.filter)) continue;

      try {
        await registration.fn(event);
      } catch (err) {
        errors.push(err);
        // Log error but continue processing other handlers so one failing
        // handler doesn't prevent the rest from running.
        try {
          await ctx.logger.error(
            `Event handler for "${registration.name}" failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
            {
              eventType: event.eventType,
              stack: err instanceof Error ? err.stack : undefined,
            },
          );
        } catch (logError) {
          errors.push(logError);
        }
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        `${errors.length} plugin event handler(s) failed for ${event.eventType}`,
      );
    }
  }

  async function handleRunJob(params: RunJobParams): Promise<void> {
    const handler = jobHandlers.get(params.job.jobKey);
    if (!handler) {
      throw new Error(`No handler registered for job "${params.job.jobKey}"`);
    }
    await handler(params.job);
  }

  async function handleWebhook(params: PluginWebhookInput): Promise<void> {
    await plugin.definition.onWebhook!(params);
  }

  async function handleApiRequest(params: PluginApiRequestInput): Promise<unknown> {
    return plugin.definition.onApiRequest!(params);
  }

  async function handleGetData(params: GetDataParams): Promise<unknown> {
    const handler = dataHandlers.get(params.key);
    if (!handler) {
      throw new Error(`No data handler registered for key "${params.key}"`);
    }
    return handler({
      ...params.params,
      ...(params.companyId === undefined ? {} : { companyId: params.companyId }),
      ...(params.renderEnvironment === undefined ? {} : { renderEnvironment: params.renderEnvironment }),
    });
  }

  function actionContextFromParams(params: PerformActionParams): PluginPerformActionContext {
    const actor: Readonly<PluginPerformActionActorContext> = Object.freeze(
      decodePluginPerformActionActorContext(
        (params as PerformActionParams | null | undefined)?.actorContext,
      ),
    );
    return Object.freeze({ actor });
  }

  async function handlePerformAction(params: PerformActionParams): Promise<unknown> {
    const context = actionContextFromParams(params);
    const handler = actionHandlers.get(params.key);
    if (!handler) {
      throw new Error(`No action handler registered for key "${params.key}"`);
    }
    return handler(
      {
        ...params.params,
        ...(params.renderEnvironment === undefined ? {} : { renderEnvironment: params.renderEnvironment }),
      },
      context,
    );
  }

  async function handleExecuteTool(params: ExecuteToolParams): Promise<ToolResult> {
    const handler = toolHandlers.get(params.toolName);
    if (!handler) {
      throw new Error(`No tool handler registered for "${params.toolName}"`);
    }
    const runContext: PluginToolRunContext = Object.freeze({
      handle: params.runContextHandle,
      resolve() {
        return callHost("run.context.resolve", {
          runContextHandle: params.runContextHandle,
        });
      },
      issueReach(issueId: string) {
        return callHost("run.context.issueReach", {
          runContextHandle: params.runContextHandle,
          issueId,
        });
      },
      issues: Object.freeze({
        listCompanyIssues(input: {
          status?: "open" | "blocked" | "done" | "cancelled";
          priority?: "critical" | "high" | "medium" | "low";
          cursor?: string;
          limit?: number;
        } = {}) {
          return callHost("run.issues.listCompanyIssues", {
            runContextHandle: params.runContextHandle,
            ...input,
          });
        },
        listSubIssues(input: {
          issueId?: string;
          cursor?: string;
          limit?: number;
        } = {}) {
          return callHost("run.issues.listSubIssues", {
            runContextHandle: params.runContextHandle,
            ...input,
          });
        },
        readIssueComments(input: {
          issueId?: string;
          cursor?: string;
          limit?: number;
        } = {}) {
          return callHost("run.issues.readIssueComments", {
            runContextHandle: params.runContextHandle,
            ...input,
          });
        },
        readIssueAgentRun(
          runId: string,
          input: { cursor?: string } = {},
        ) {
          return callHost("run.issues.readIssueAgentRun", {
            runContextHandle: params.runContextHandle,
            runId,
            ...input,
          });
        },
      }),
    });
    return handler(params.parameters, runContext);
  }

  async function handleDetectExternalObjects(params: DetectExternalObjectsParams) {
    if (!plugin.definition.onDetectExternalObjects) {
      throw methodNotImplemented("detectExternalObjects");
    }
    return plugin.definition.onDetectExternalObjects(params);
  }

  async function handleResolveExternalObject(params: ResolveExternalObjectParams) {
    if (!plugin.definition.onResolveExternalObject) {
      throw methodNotImplemented("resolveExternalObject");
    }
    return plugin.definition.onResolveExternalObject(params);
  }

  function methodNotImplemented(method: string): Error & { code: number } {
    return Object.assign(
      new Error(`${method} is not implemented by this plugin`),
      { code: PLUGIN_RPC_ERROR_CODES.METHOD_NOT_IMPLEMENTED },
    );
  }

  async function handleEnvironmentValidateConfig(
    params: PluginEnvironmentValidateConfigParams,
  ) {
    if (!plugin.definition.onEnvironmentValidateConfig) {
      throw methodNotImplemented("environmentValidateConfig");
    }
    return plugin.definition.onEnvironmentValidateConfig(params);
  }

  async function handleEnvironmentProbe(params: PluginEnvironmentProbeParams) {
    if (!plugin.definition.onEnvironmentProbe) {
      throw methodNotImplemented("environmentProbe");
    }
    return plugin.definition.onEnvironmentProbe(params);
  }

  async function handleEnvironmentAcquireLease(params: PluginEnvironmentAcquireLeaseParams) {
    if (!plugin.definition.onEnvironmentAcquireLease) {
      throw methodNotImplemented("environmentAcquireLease");
    }
    return plugin.definition.onEnvironmentAcquireLease(params);
  }

  async function handleEnvironmentResumeLease(params: PluginEnvironmentResumeLeaseParams) {
    if (!plugin.definition.onEnvironmentResumeLease) {
      throw methodNotImplemented("environmentResumeLease");
    }
    return plugin.definition.onEnvironmentResumeLease(params);
  }

  async function handleEnvironmentReleaseLease(params: PluginEnvironmentReleaseLeaseParams) {
    if (!plugin.definition.onEnvironmentReleaseLease) {
      throw methodNotImplemented("environmentReleaseLease");
    }
    return plugin.definition.onEnvironmentReleaseLease(params);
  }

  async function handleEnvironmentDestroyLease(params: PluginEnvironmentDestroyLeaseParams) {
    if (!plugin.definition.onEnvironmentDestroyLease) {
      throw methodNotImplemented("environmentDestroyLease");
    }
    return plugin.definition.onEnvironmentDestroyLease(params);
  }

  async function handleEnvironmentRealizeWorkspace(params: PluginEnvironmentRealizeWorkspaceParams) {
    if (!plugin.definition.onEnvironmentRealizeWorkspace) {
      throw methodNotImplemented("environmentRealizeWorkspace");
    }
    return plugin.definition.onEnvironmentRealizeWorkspace(params);
  }

  async function handleEnvironmentExecute(params: PluginEnvironmentExecuteParams) {
    if (!plugin.definition.onEnvironmentExecute) {
      throw methodNotImplemented("environmentExecute");
    }
    return plugin.definition.onEnvironmentExecute(params);
  }

  async function handleEnvironmentCancelExecution(params: PluginEnvironmentCancelExecutionParams) {
    if (!plugin.definition.onEnvironmentCancelExecution) {
      throw methodNotImplemented("environmentCancelExecution");
    }
    return plugin.definition.onEnvironmentCancelExecution(params);
  }

  async function handleEnvironmentSyncIn(params: PluginEnvironmentSyncParams) {
    if (!plugin.definition.onEnvironmentSyncIn) {
      throw methodNotImplemented("environmentSyncIn");
    }
    return plugin.definition.onEnvironmentSyncIn(params);
  }

  async function handleEnvironmentSyncOut(params: PluginEnvironmentSyncParams) {
    if (!plugin.definition.onEnvironmentSyncOut) {
      throw methodNotImplemented("environmentSyncOut");
    }
    return plugin.definition.onEnvironmentSyncOut(params);
  }

  async function handleEnvironmentStartInteractiveSetup(params: PluginEnvironmentStartInteractiveSetupParams) {
    if (!plugin.definition.onEnvironmentStartInteractiveSetup) {
      throw methodNotImplemented("environmentStartInteractiveSetup");
    }
    return plugin.definition.onEnvironmentStartInteractiveSetup(params);
  }

  async function handleEnvironmentGetInteractiveSetup(params: PluginEnvironmentGetInteractiveSetupParams) {
    if (!plugin.definition.onEnvironmentGetInteractiveSetup) {
      throw methodNotImplemented("environmentGetInteractiveSetup");
    }
    return plugin.definition.onEnvironmentGetInteractiveSetup(params);
  }

  async function handleEnvironmentCaptureTemplate(params: PluginEnvironmentCaptureTemplateParams) {
    if (!plugin.definition.onEnvironmentCaptureTemplate) {
      throw methodNotImplemented("environmentCaptureTemplate");
    }
    return plugin.definition.onEnvironmentCaptureTemplate(params);
  }

  async function handleEnvironmentCancelInteractiveSetup(params: PluginEnvironmentCancelInteractiveSetupParams) {
    if (!plugin.definition.onEnvironmentCancelInteractiveSetup) {
      throw methodNotImplemented("environmentCancelInteractiveSetup");
    }
    return plugin.definition.onEnvironmentCancelInteractiveSetup(params);
  }

  async function handleEnvironmentDeleteTemplate(params: PluginEnvironmentDeleteTemplateParams) {
    if (!plugin.definition.onEnvironmentDeleteTemplate) {
      throw methodNotImplemented("environmentDeleteTemplate");
    }
    return plugin.definition.onEnvironmentDeleteTemplate(params);
  }

  // -----------------------------------------------------------------------
  // Inbound response handling (host → worker, response to our outbound call)
  // -----------------------------------------------------------------------

  function handleHostResponse(response: JsonRpcResponse): void {
    const id = response.id;
    if (id === null || id === undefined) return;

    const pending = pendingRequests.get(id);
    if (!pending) return;

    if (pending.timer) clearTimeout(pending.timer);
    pendingRequests.delete(id);
    pending.resolve(response);
  }

  // -----------------------------------------------------------------------
  // Incoming line handler
  // -----------------------------------------------------------------------

  function stopForProtocolViolation(error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    try {
      sendMessage(
        createErrorResponse(
          null,
          JSONRPC_ERROR_CODES.PARSE_ERROR,
          `Parse error: ${detail}`,
        ),
      );
    } finally {
      cleanup();
      if (!options.stdin && !options.stdout) {
        setImmediate(() => process.exit(1));
      }
    }
  }

  function handleLine(line: string): void {
    if (!running || !line.trim()) return;

    let message: JsonRpcMessage;
    try {
      message = parseMessage(line);
    } catch (err) {
      stopForProtocolViolation(err);
      return;
    }

    if (isJsonRpcResponse(message)) {
      // This is a response to one of our outbound worker→host calls
      handleHostResponse(message);
      return;
    }

    const stopAfterTransportFailure = () => {
      // The request handler already translates execution failures into one
      // JSON-RPC error. A remaining rejection means the response transport
      // itself failed, so a second response attempt would be a duplicate.
      stop();
    };

    if (!acceptingHostRequests) {
      try {
        sendMessage(createErrorResponse(
          message.id,
          PLUGIN_RPC_ERROR_CODES.WORKER_UNAVAILABLE,
          "Worker RPC host is draining",
        ));
      } catch {
        stop();
      }
      return;
    }

    if (message.method === "shutdown") {
      // Close intake synchronously before the shutdown handler yields. Host
      // responses remain accepted above so already-running handlers can
      // finish their worker→host calls while the worker drains.
      acceptingHostRequests = false;
      void handleHostRequest(message).catch(stopAfterTransportFailure);
      return;
    }

    const request = handleHostRequest(message);
    activeHostRequests.add(request);
    void request.then(
      () => activeHostRequests.delete(request),
      (error) => {
        activeHostRequests.delete(request);
        stopAfterTransportFailure();
        return error;
      },
    );
  }

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------

  function cleanup(): void {
    running = false;
    acceptingHostRequests = false;

    // Close readline
    if (readline) {
      readline.close();
      readline = null;
    }

    // Reject all pending outbound calls
    for (const [id, pending] of pendingRequests) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.resolve(
        createErrorResponse(
          id,
          PLUGIN_RPC_ERROR_CODES.WORKER_UNAVAILABLE,
          "Worker RPC host is shutting down",
        ),
      );
    }
    pendingRequests.clear();
  }

  // -----------------------------------------------------------------------
  // Bootstrap: wire up stdin readline
  // -----------------------------------------------------------------------

  let readline: ReadlineInterface | null = createInterface({
    input: stdinStream as NodeJS.ReadableStream,
    crlfDelay: Infinity,
  });

  readline.on("line", handleLine);

  // If stdin closes, we should exit gracefully
  readline.on("close", () => {
    if (running) {
      cleanup();
      if (!options.stdin && !options.stdout) {
        process.exit(0);
      }
    }
  });

  // Handle uncaught errors in the worker process.
  // Only install these when using the real process streams (not in tests
  // where the caller provides custom streams).
  if (!options.stdin && !options.stdout) {
    const exitForFatalError = (label: string, reason: unknown): never => {
      const detail = reason instanceof Error
        ? reason.stack ?? reason.message
        : String(reason);
      try {
        fs.writeSync(process.stderr.fd, `[paperclip plugin worker] ${label}: ${detail}\n`);
      } finally {
        process.exit(1);
      }
    };

    process.on("uncaughtException", (err) => {
      exitForFatalError("uncaught exception", err);
    });

    process.on("unhandledRejection", (reason) => {
      exitForFatalError("unhandled rejection", reason);
    });
  }

  // -----------------------------------------------------------------------
  // Return the handle
  // -----------------------------------------------------------------------

  return {
    get running() {
      return running;
    },

    stop() {
      cleanup();
    },
  };
}
