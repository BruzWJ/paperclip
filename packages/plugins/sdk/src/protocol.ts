/**
 * JSON-RPC 2.0 message types and protocol helpers for the host ↔ worker IPC
 * channel.
 *
 * The Paperclip plugin runtime uses JSON-RPC 2.0 over stdio to communicate
 * between the host process and each plugin worker process. This module defines:
 *
 * - Core JSON-RPC 2.0 request and response envelope types
 * - Standard and plugin-specific error codes
 * - Typed method maps for host→worker and worker→host calls
 * - Helper functions for creating well-formed messages
 *
 * @see PLUGIN_SPEC.md §12.1 — Process Model
 * @see PLUGIN_SPEC.md §13 — Host-Worker Protocol
 * @see https://www.jsonrpc.org/specification
 */

import type {
  PaperclipPluginManifestV1,
  PluginLauncherBounds,
  PluginLauncherRenderContextSnapshot,
  Company,
  Project,
  Task,
  PluginManagedAgentResolution,
  PluginManagedProjectResolution,
  PluginManagedRoutineResolution,
  Routine,
  RoutineRun,
  Agent,
  Goal,
  PrincipalPermissionGrant,
  ProviderSafeRunTrace,
  PluginWorkerLogLevel,
  UserCompanyMembershipRole,
} from "@paperclipai/shared";
import { isCanonicalUuid } from "@paperclipai/shared";
export type { PluginLauncherRenderContextSnapshot } from "@paperclipai/shared";

import type {
  PluginEvent,
  PluginTaskUpdateInput,
  PluginTaskWithdrawalResult,
  PluginCreatorCallbackAcknowledgement,
  PluginCreatorCallbackDelivery,
  PluginJobContext,
  PluginRunContextHandle,
  PluginRunTaskProjection,
  PluginRunTaskCommentProjection,
  PluginRunPage,
  ToolResult,
  PluginLocalFolderListing,
  PluginLocalFolderStatus,
  PluginAccessInvite,
  PluginAccessMember,
  PluginAssignmentPreviewInput,
  PluginAuthorizationAuditEntry,
  PluginAuthorizationAuditDecision,
  PluginAuthorizationDecisionResult,
  PluginAuthorizationPolicyRecord,
  PluginAuthorizationPolicySummary,
  PluginBeforePromptInput,
  PluginBeforePromptResult,
  PluginCanonicalSessionReadInput,
  PluginCanonicalSessionReadResult,
  ScopeKey,
  PluginEntityUpsert,
  PluginEntityRecord,
  PluginEntityQuery,
  EventFilter,
  PluginEventPattern,
  PluginGoalsClient,
  PluginCompaniesClient,
  PluginProjectsClient,
  PluginAgentsClient,
  PluginRoutinesClient,
  PluginListWindow,
} from "./types.js";
import type {
  PluginHealthDiagnostics,
  PluginApiRequestInput,
  PluginApiResponse,
  PluginConfigValidationResult,
  PluginWebhookInput,
} from "./define-plugin.js";

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 — Core Protocol Types
// ---------------------------------------------------------------------------

/** The JSON-RPC protocol version. Always `"2.0"`. */
export const JSONRPC_VERSION = "2.0" as const;

/**
 * A unique request identifier. JSON-RPC 2.0 allows strings or numbers;
 * we use strings (UUIDs or monotonic counters) for all Paperclip messages.
 */
export type JsonRpcId = string | number;

/**
 * Host-owned scope attached to a host→worker invocation. Workers may echo the
 * invocation id on nested worker→host calls, but they never author this scope.
 */
/**
 * A JSON-RPC 2.0 request message.
 *
 * The host sends requests to the worker (or vice versa) and expects a
 * matching response with the same `id`.
 */
export interface JsonRpcRequest<
  TMethod extends string = string,
  TParams = unknown,
> {
  readonly jsonrpc: typeof JSONRPC_VERSION;
  /** Unique request identifier. Must be echoed in the response. */
  readonly id: JsonRpcId;
  /** The RPC method name to invoke. */
  readonly method: TMethod;
  /** Structured parameters for the method call. */
  readonly params: TParams;
  /**
   * Host-minted metadata for the top-level plugin invocation that is currently
   * executing. The worker treats this as opaque and echoes only the id on
   * worker→host calls made from the same async execution context.
   */
  readonly paperclipInvocation?: PluginInvocationContext;
  /** Opaque top-level invocation id echoed by worker→host requests. */
  readonly paperclipInvocationId?: string;
}

/**
 * A JSON-RPC 2.0 success response.
 */
export interface JsonRpcSuccessResponse<TResult = unknown> {
  readonly jsonrpc: typeof JSONRPC_VERSION;
  /** Echoed request identifier. */
  readonly id: JsonRpcId;
  /** The method return value. */
  readonly result: TResult;
  readonly error?: never;
}

/**
 * A JSON-RPC 2.0 error object embedded in an error response.
 */
export interface JsonRpcError<TData = unknown> {
  /** Machine-readable error code. */
  readonly code: number;
  /** Human-readable error message. */
  readonly message: string;
  /** Optional structured error data. */
  readonly data?: TData;
}

/**
 * A JSON-RPC 2.0 error response.
 */
export interface JsonRpcErrorResponse<TData = unknown> {
  readonly jsonrpc: typeof JSONRPC_VERSION;
  /** Echoed request identifier. */
  readonly id: JsonRpcId | null;
  readonly result?: never;
  /** The error object. */
  readonly error: JsonRpcError<TData>;
}

/**
 * A JSON-RPC 2.0 response — either success or error.
 */
export type JsonRpcResponse<TResult = unknown, TData = unknown> =
  JsonRpcSuccessResponse<TResult> | JsonRpcErrorResponse<TData>;

/**
 * Any well-formed JSON-RPC 2.0 message exchanged by the plugin transport.
 */
export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse;

// ---------------------------------------------------------------------------
// Error Codes
// ---------------------------------------------------------------------------

/**
 * Standard JSON-RPC 2.0 error codes.
 *
 * @see https://www.jsonrpc.org/specification#error_object
 */
export const JSONRPC_ERROR_CODES = {
  /** Invalid JSON was received by the server. */
  PARSE_ERROR: -32700,
  /** The JSON sent is not a valid Request object. */
  INVALID_REQUEST: -32600,
  /** The method does not exist or is not available. */
  METHOD_NOT_FOUND: -32601,
  /** Invalid method parameter(s). */
  INVALID_PARAMS: -32602,
  /** Internal JSON-RPC error. */
  INTERNAL_ERROR: -32603,
} as const;

export type JsonRpcErrorCode =
  (typeof JSONRPC_ERROR_CODES)[keyof typeof JSONRPC_ERROR_CODES];

/**
 * Paperclip plugin-specific error codes.
 *
 * These live in the JSON-RPC "server error" reserved range (-32000 to -32099)
 * as specified by JSON-RPC 2.0 for implementation-defined server errors.
 *
 * @see PLUGIN_SPEC.md §19.7 — Error Propagation Through The Bridge
 */
export const PLUGIN_RPC_ERROR_CODES = {
  /** The worker process is not running or not reachable. */
  WORKER_UNAVAILABLE: -32000,
  /** The plugin does not have the required capability for this operation. */
  CAPABILITY_DENIED: -32001,
  /** The worker reported an unhandled error during method execution. */
  WORKER_ERROR: -32002,
  /** The method call timed out waiting for the worker response. */
  TIMEOUT: -32003,
  /** The worker does not implement the requested optional method. */
  METHOD_NOT_IMPLEMENTED: -32004,
  /** The worker→host call attempted to escape the current invocation company scope. */
  INVOCATION_SCOPE_DENIED: -32005,
  /** A catch-all for errors that do not fit other categories. */
  UNKNOWN: -32099,
} as const;

export type PluginRpcErrorCode =
  (typeof PLUGIN_RPC_ERROR_CODES)[keyof typeof PLUGIN_RPC_ERROR_CODES];

// ---------------------------------------------------------------------------
// Invocation scope metadata
// ---------------------------------------------------------------------------

/**
 * Company scope attached by the host to one top-level plugin invocation.
 * Absence of this metadata means the invocation is instance/global scoped.
 */
export interface PluginInvocationScope {
  companyId: string;
  /**
   * Host-stamped boundary for canonical Session reads made while observing a
   * provider prompt. Workers cannot widen or move this boundary.
   */
  canonicalSession?: {
    readonly taskId: string;
    readonly sessionId: string;
    readonly snapshotHighWaterSeq: number;
  };
  /**
   * Present only for a direct plugin-tool invocation. The worker may echo
   * only the enclosing invocation id; run-serving host calls must also carry
   * the exact opaque handle from `ExecuteToolParams`.
   */
  pluginRunContextHandle?: PluginRunContextHandle;
}

/**
 * Opaque invocation metadata generated by the host. Workers must not derive or
 * mutate this. They only echo the id on nested worker→host RPC calls.
 */
export interface PluginInvocationContext {
  id: string;
  scope: PluginInvocationScope;
}

/**
 * Context provided to host-side worker→host handlers after the worker echoes a
 * host-minted invocation id.
 */
export interface WorkerHostCallContext {
  invocationScope?: PluginInvocationScope | null;
  invalidInvocationScope?: boolean;
  /**
   * Opaque host-owned identity for this exact worker→host JSON-RPC request.
   * Replaying the exact request retains this identity; a distinct request gets
   * a distinct identity. Workers cannot supply or override it.
   */
  rpcOperationId?: string;
}

// ---------------------------------------------------------------------------
// Host → Worker Method Signatures (§13 Host-Worker Protocol)
// ---------------------------------------------------------------------------

/**
 * Input for the `initialize` RPC method.
 *
 * @see PLUGIN_SPEC.md §13.1 — `initialize`
 */
export interface InitializeParams {
  /** Full plugin manifest snapshot. */
  manifest: PaperclipPluginManifestV1;
  /** Instance-level metadata. */
  instanceInfo: {
    /** UUID of this Paperclip instance. */
    instanceId: string;
    /** Semver version of the running Paperclip host. */
    hostVersion: string;
  };
  /** Host API version. */
  apiVersion: number;
  /** Host-derived plugin database namespace, or `null` when no database is declared. */
  databaseNamespace: string | null;
}

/**
 * Result returned by the `initialize` RPC method.
 */
export interface InitializeResult {
  /** Exact optional methods implemented by this initialized worker. */
  supportedMethods: HostToWorkerOptionalMethodName[];
}

/**
 * Input for the `validateConfig` RPC method.
 *
 * @see PLUGIN_SPEC.md §13.3 — `validateConfig`
 */
export interface ValidateConfigParams {
  /** The configuration to validate. */
  config: Record<string, unknown>;
}

/**
 * Input for the `onEvent` RPC method.
 *
 * @see PLUGIN_SPEC.md §13.5 — `onEvent`
 */
export interface OnEventParams {
  /** The domain event to deliver. */
  event: PluginEvent;
}

/**
 * Input for the `runJob` RPC method.
 *
 * @see PLUGIN_SPEC.md §13.6 — `runJob`
 */
export interface RunJobParams {
  /** Job execution context. */
  job: PluginJobContext;
}

/**
 * Input for the `getData` RPC method.
 *
 * @see PLUGIN_SPEC.md §13.8 — `getData`
 */
export interface GetDataParams {
  /** Plugin-defined data key (e.g. `"sync-health"`). */
  key: string;
  /** Host-authorized active company scope, when this bridge call is company-scoped. */
  companyId?: string | null;
  /** Context and query parameters from the UI. */
  params: Record<string, unknown>;
  /** Optional launcher/container metadata from the host render environment. */
  renderEnvironment?: PluginLauncherRenderContextSnapshot | null;
}

/**
 * Input for the `performAction` RPC method.
 *
 * @see PLUGIN_SPEC.md §13.9 — `performAction`
 */
export type PluginPerformActionActorType = "user" | "agent" | "system";

interface PluginPerformActionActorBase {
  /** Company id authorized by the host bridge for this action, when applicable. */
  companyId: string | null;
}

export type PluginPerformActionActorContext =
  | (PluginPerformActionActorBase & {
      /** Canonical Better Auth board principal. */
      type: "user";
      userId: string;
      agentId?: never;
      runId?: never;
    })
  | (PluginPerformActionActorBase & {
      /** Productive runtime principal. */
      type: "agent";
      agentId: string;
      runId: string;
      userId?: never;
    })
  | (PluginPerformActionActorBase & {
      /** Host-owned action with no user or runtime principal. */
      type: "system";
      userId?: never;
      agentId?: never;
      runId?: never;
    });

export interface PluginPerformActionContext {
  /** Immutable authenticated actor context supplied by the host. */
  actor: Readonly<PluginPerformActionActorContext>;
}

export interface PerformActionParams {
  /** Plugin-defined action key (e.g. `"resync"`). */
  key: string;
  /** Action parameters from the UI. */
  params: Record<string, unknown>;
  /** Authenticated actor context resolved by the host, never by caller params. */
  actorContext: PluginPerformActionActorContext;
  /** Optional launcher/container metadata from the host render environment. */
  renderEnvironment?: PluginLauncherRenderContextSnapshot | null;
}

const PERFORM_ACTION_ACTOR_KEYS = {
  user: ["type", "userId", "companyId"],
  agent: ["type", "agentId", "runId", "companyId"],
  system: ["type", "companyId"],
} as const satisfies Record<PluginPerformActionActorType, readonly string[]>;

function invalidPerformActionActorContext(message: string): never {
  throw Object.assign(
    new Error(`Invalid performAction actorContext: ${message}`),
    { code: JSONRPC_ERROR_CODES.INVALID_PARAMS },
  );
}

function isExactNonBlankString(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value === value.trim()
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return (
    actual.length === canonical.length &&
    actual.every((key, index) => key === canonical[index])
  );
}

/**
 * Decode the host-authenticated actor supplied to `performAction`.
 *
 * The three branches are deliberately exact. Missing, nullable, mixed, blank,
 * or extended actor shapes are invalid JSON-RPC parameters and never reach a
 * plugin action handler.
 */
export function decodePluginPerformActionActorContext(
  value: unknown,
): PluginPerformActionActorContext {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalidPerformActionActorContext(
      "an exact actor object is required",
    );
  }

  const actor = value as Record<string, unknown>;
  const rawCompanyId = actor.companyId;
  let companyId: string | null;
  if (rawCompanyId === null) {
    companyId = null;
  } else if (
    typeof rawCompanyId === "string" &&
    isCanonicalUuid(rawCompanyId)
  ) {
    companyId = rawCompanyId;
  } else {
    return invalidPerformActionActorContext(
      '"companyId" must be null or an exact canonical UUID',
    );
  }

  if (actor.type === "user") {
    if (!hasExactKeys(actor, PERFORM_ACTION_ACTOR_KEYS.user)) {
      return invalidPerformActionActorContext(
        'the "user" branch accepts exactly type, userId, and companyId',
      );
    }
    if (!isExactNonBlankString(actor.userId)) {
      return invalidPerformActionActorContext(
        '"userId" must be an exact non-blank string for a user actor',
      );
    }
    return {
      type: "user",
      userId: actor.userId,
      companyId,
    };
  }

  if (actor.type === "agent") {
    if (!hasExactKeys(actor, PERFORM_ACTION_ACTOR_KEYS.agent)) {
      return invalidPerformActionActorContext(
        'the "agent" branch accepts exactly type, agentId, runId, and companyId',
      );
    }
    const agentId = actor.agentId;
    if (typeof agentId !== "string" || !isCanonicalUuid(agentId)) {
      return invalidPerformActionActorContext(
        '"agentId" and "runId" must be exact canonical UUIDs for an agent actor',
      );
    }
    const runId = actor.runId;
    if (typeof runId !== "string" || !isCanonicalUuid(runId)) {
      return invalidPerformActionActorContext(
        '"agentId" and "runId" must be exact canonical UUIDs for an agent actor',
      );
    }
    return {
      type: "agent",
      agentId,
      runId,
      companyId,
    };
  }

  if (actor.type === "system") {
    if (!hasExactKeys(actor, PERFORM_ACTION_ACTOR_KEYS.system)) {
      return invalidPerformActionActorContext(
        'the "system" branch accepts exactly type and companyId',
      );
    }
    return {
      type: "system",
      companyId,
    };
  }

  return invalidPerformActionActorContext(
    '"type" must be exactly "user", "agent", or "system"',
  );
}

/**
 * Input for the `executeTool` RPC method.
 *
 * @see PLUGIN_SPEC.md §13.10 — `executeTool`
 */
export interface ExecuteToolParams {
  /** Tool name (without plugin namespace prefix). */
  toolName: string;
  /** Parsed parameters matching the tool's declared schema. */
  parameters: unknown;
  /** Opaque host-minted context for this exact compiled plugin-tool call. */
  runContextHandle: PluginRunContextHandle;
}

// ---------------------------------------------------------------------------
// UI launcher / modal host interaction payloads
// ---------------------------------------------------------------------------

/**
 * Bounds request sent by a plugin UI running inside a host-managed launcher
 * container such as a modal, drawer, or popover.
 */
export interface PluginModalBoundsRequest {
  /** High-level size preset requested from the host. */
  bounds: PluginLauncherBounds;
  /** Optional explicit width override in CSS pixels. */
  width?: number;
  /** Optional explicit height override in CSS pixels. */
  height?: number;
  /** Optional lower bounds for host resizing decisions. */
  minWidth?: number;
  minHeight?: number;
  /** Optional upper bounds for host resizing decisions. */
  maxWidth?: number;
  maxHeight?: number;
}

/**
 * Reason metadata supplied by host-managed close lifecycle callbacks.
 */
export interface PluginRenderCloseEvent {
  reason:
    | "escapeKey"
    | "backdrop"
    | "hostNavigation"
    | "programmatic"
    | "submit"
    | "unknown";
  nativeEvent?: unknown;
}

/**
 * Map of host→worker RPC method names to their `[params, result]` types.
 *
 * This type is the single source of truth for all methods the host can call
 * on a worker. Used by both the host dispatcher and the worker handler to
 * ensure type safety across the IPC boundary.
 */
export interface HostToWorkerMethods {
  /** @see PLUGIN_SPEC.md §13.1 */
  initialize: [params: InitializeParams, result: InitializeResult];
  /** @see PLUGIN_SPEC.md §13.2 */
  health: [params: Record<string, never>, result: PluginHealthDiagnostics];
  /** @see PLUGIN_SPEC.md §12.5 */
  shutdown: [params: Record<string, never>, result: void];
  /** @see PLUGIN_SPEC.md §13.3 */
  validateConfig: [
    params: ValidateConfigParams,
    result: PluginConfigValidationResult,
  ];
  /** Blocking hook before one exact provider prompt. */
  beforePrompt: [
    params: PluginBeforePromptInput,
    result: PluginBeforePromptResult,
  ];
  /** @see PLUGIN_SPEC.md §13.5 */
  onEvent: [params: OnEventParams, result: void];
  /** @see PLUGIN_SPEC.md §13.6 */
  runJob: [params: RunJobParams, result: void];
  /** @see PLUGIN_SPEC.md §13.7 */
  handleWebhook: [params: PluginWebhookInput, result: void];
  /** Scoped plugin API route dispatch. */
  handleApiRequest: [params: PluginApiRequestInput, result: PluginApiResponse];
  /** @see PLUGIN_SPEC.md §13.8 */
  getData: [params: GetDataParams, result: unknown];
  /** @see PLUGIN_SPEC.md §13.9 */
  performAction: [params: PerformActionParams, result: unknown];
  /** @see PLUGIN_SPEC.md §13.10 */
  executeTool: [params: ExecuteToolParams, result: ToolResult];
  "tasks.creatorCallback.deliver": [
    params: {
      callbackKey: string;
      callbackVersion: string;
      delivery: PluginCreatorCallbackDelivery;
    },
    result: PluginCreatorCallbackAcknowledgement,
  ];
}

/** Union of all host→worker method names. */
export type HostToWorkerMethodName = keyof HostToWorkerMethods;

/** Required methods the worker MUST implement. */
export const HOST_TO_WORKER_REQUIRED_METHODS = [
  "initialize",
  "health",
  "shutdown",
] as const satisfies readonly HostToWorkerMethodName[];

export type HostToWorkerRequiredMethodName =
  (typeof HOST_TO_WORKER_REQUIRED_METHODS)[number];

/** Optional methods the worker MAY implement. */
export const HOST_TO_WORKER_OPTIONAL_METHODS = [
  "validateConfig",
  "beforePrompt",
  "onEvent",
  "runJob",
  "handleWebhook",
  "handleApiRequest",
  "getData",
  "performAction",
  "executeTool",
  "tasks.creatorCallback.deliver",
] as const satisfies readonly HostToWorkerMethodName[];

export type HostToWorkerOptionalMethodName =
  (typeof HOST_TO_WORKER_OPTIONAL_METHODS)[number];

// ---------------------------------------------------------------------------
// Worker → Host Method Signatures (SDK client calls)
// ---------------------------------------------------------------------------

/**
 * Map of worker→host RPC method names to their `[params, result]` types.
 *
 * These represent the SDK client calls that the worker makes back to the
 * host to access platform services (state, entities, config, etc.).
 */
export interface WorkerToHostMethods {
  // Config
  "config.get": [
    params: Record<string, never>,
    result: Record<string, unknown>,
  ];

  // Trusted local folders
  "localFolders.configure": [
    params: {
      companyId: string;
      folderKey: string;
      path: string;
    },
    result: PluginLocalFolderStatus,
  ];
  "localFolders.status": [
    params: { companyId: string; folderKey: string },
    result: PluginLocalFolderStatus,
  ];
  "localFolders.list": [
    params: {
      companyId: string;
      folderKey: string;
      relativePath?: string | null;
      recursive?: boolean;
      maxEntries?: number;
    },
    result: PluginLocalFolderListing,
  ];
  "localFolders.readText": [
    params: { companyId: string; folderKey: string; relativePath: string },
    result: string,
  ];
  "localFolders.writeTextAtomic": [
    params: {
      companyId: string;
      folderKey: string;
      relativePath: string;
      contents: string;
    },
    result: PluginLocalFolderStatus,
  ];
  "localFolders.deleteFile": [
    params: { companyId: string; folderKey: string; relativePath: string },
    result: PluginLocalFolderStatus,
  ];

  // State
  "state.get": [params: ScopeKey, result: unknown];
  "state.set": [params: ScopeKey & { value: unknown }, result: void];
  "state.delete": [params: ScopeKey, result: void];

  // Restricted plugin database namespace
  "db.query": [params: { sql: string; params?: unknown[] }, result: unknown[]];
  "db.execute": [
    params: { sql: string; params?: unknown[] },
    result: { rowCount: number },
  ];

  // Entities
  "entities.upsert": [params: PluginEntityUpsert, result: PluginEntityRecord];
  "entities.list": [params: PluginEntityQuery, result: PluginEntityRecord[]];

  // Events
  "events.emit": [
    params: { name: string; companyId: string; payload: unknown },
    result: void,
  ];
  "events.subscribe": [
    params: { eventPattern: PluginEventPattern; filter?: EventFilter | null },
    result: void,
  ];

  // HTTP
  "http.fetch": [
    params: { url: string; init?: Record<string, unknown> },
    result: {
      status: number;
      statusText: string;
      headers: Record<string, string>;
      body: string;
    },
  ];

  "runtime.records.readRun": [
    params: { companyId: string; runId: string; cursor?: string },
    result: ProviderSafeRunTrace,
  ];
  "runtime.records.readTaskComments": [
    params: {
      companyId: string;
      taskId: string;
      cursor?: string;
      limit?: number;
    },
    result: PluginRunPage<PluginRunTaskCommentProjection>,
  ];
  "runtime.records.readSession": [
    params: PluginCanonicalSessionReadInput,
    result: PluginCanonicalSessionReadResult,
  ];

  // Activity
  "activity.log": [
    params: {
      companyId: string;
      message: string;
      entityType?: string;
      entityId?: string;
      metadata?: Record<string, unknown>;
    },
    result: void,
  ];

  // Metrics
  "metrics.write": [
    params: {
      name: string;
      value: number;
      tags?: Record<string, string>;
      /** Owning tenant for `plugin_logs.company_id` (cascade-delete scope). `null`/omitted = instance-scope. */
      companyId?: string | null;
    },
    result: void,
  ];

  // Telemetry
  "telemetry.track": [
    params: {
      eventName: string;
      dimensions?: Record<string, string | number | boolean>;
    },
    result: void,
  ];

  // Logger
  log: [
    params: {
      level: PluginWorkerLogLevel;
      message: string;
      meta?: Record<string, unknown>;
      /** Owning tenant for `plugin_logs.company_id` (cascade-delete scope). `null`/omitted = instance-scope. */
      companyId?: string | null;
    },
    result: void,
  ];

  // Companies (read)
  "companies.list": [
    params: Parameters<PluginCompaniesClient["list"]>[0],
    result: Company[],
  ];
  "companies.get": [params: { companyId: string }, result: Company | null];

  // Projects (read)
  "projects.list": [
    params: Parameters<PluginProjectsClient["list"]>[0],
    result: Project[],
  ];
  "projects.get": [
    params: { projectId: string; companyId: string },
    result: Project | null,
  ];
  "projects.managed.get": [
    params: { projectKey: string; companyId: string },
    result: PluginManagedProjectResolution,
  ];
  "projects.managed.reconcile": [
    params: { projectKey: string; companyId: string },
    result: PluginManagedProjectResolution,
  ];
  "projects.managed.reset": [
    params: { projectKey: string; companyId: string },
    result: PluginManagedProjectResolution,
  ];
  "routines.managed.get": [
    params: { routineKey: string; companyId: string },
    result: PluginManagedRoutineResolution,
  ];
  "routines.managed.reconcile": [
    params: {
      routineKey: string;
      companyId: string;
      assigneeAgentId?: string | null;
      projectId?: string | null;
    },
    result: PluginManagedRoutineResolution,
  ];
  "routines.managed.reset": [
    params: {
      routineKey: string;
      companyId: string;
      assigneeAgentId?: string | null;
      projectId?: string | null;
    },
    result: PluginManagedRoutineResolution,
  ];
  "routines.managed.update": [
    params: {
      routineKey: string;
      companyId: string;
      status?: Parameters<
        PluginRoutinesClient["managed"]["update"]
      >[2]["status"];
    },
    result: Routine,
  ];
  "routines.managed.run": [
    params: {
      routineKey: string;
      companyId: string;
      assigneeAgentId?: string | null;
      projectId?: string | null;
    },
    result: RoutineRun,
  ];
  // Tasks
  "tasks.list": [
    params: {
      companyId: string;
      projectId?: string;
      ownerAgentId?: string;
      status?: "open" | "blocked" | "done" | "cancelled";
      limit?: number;
      offset?: number;
    },
    result: Task[],
  ];
  "tasks.get": [
    params: { taskId: string; companyId: string },
    result: Task | null,
  ];
  "tasks.creatorCallback.register": [
    params: {
      callbackKey: string;
      callbackVersion: string;
    },
    result: {
      callbackKey: string;
      callbackVersion: string;
      registered: true;
    },
  ];
  "run.tasks.listCompanyTasks": [
    params: {
      runContextHandle: PluginRunContextHandle;
      status?: "open" | "blocked" | "done" | "cancelled";
      priority?: "critical" | "high" | "medium" | "low";
      cursor?: string;
      limit?: number;
    },
    result: PluginRunPage<PluginRunTaskProjection>,
  ];
  "run.context.resolve": [
    params: { runContextHandle: PluginRunContextHandle },
    result: import("./types.js").PluginResolvedRunContext,
  ];
  "run.context.taskReach": [
    params: { runContextHandle: PluginRunContextHandle; taskId: string },
    result: import("./types.js").PluginRunTaskReach,
  ];
  "run.tasks.listSubTasks": [
    params: {
      runContextHandle: PluginRunContextHandle;
      taskId?: string;
      cursor?: string;
      limit?: number;
    },
    result: PluginRunPage<PluginRunTaskProjection>,
  ];
  "run.tasks.readTaskComments": [
    params: {
      runContextHandle: PluginRunContextHandle;
      taskId?: string;
      cursor?: string;
      limit?: number;
    },
    result: PluginRunPage<PluginRunTaskCommentProjection>,
  ];
  "run.tasks.readTaskAgentRun": [
    params: {
      runContextHandle: PluginRunContextHandle;
      runId: string;
      cursor?: string;
    },
    result: ProviderSafeRunTrace,
  ];
  "tasks.create": [
    params: {
      companyId: string;
      request: string;
      ownerAgentId: string;
      callbackKey: string;
      callbackVersion: string;
      title?: string;
      projectId?: string;
      goalId?: string;
      parentId?: string;
      priority?: string;
    },
    result: Task,
  ];
  "tasks.update": [
    params: {
      taskId: string;
      input: PluginTaskUpdateInput;
      companyId: string;
    },
    result: Task,
  ];
  "tasks.withdraw": [
    params: {
      taskId: string;
      companyId: string;
      message: string;
    },
    result: PluginTaskWithdrawalResult,
  ];

  // Agents (read)
  "agents.list": [
    params: Parameters<PluginAgentsClient["list"]>[0],
    result: Agent[],
  ];
  "agents.get": [
    params: { agentId: string; companyId: string },
    result: Agent | null,
  ];

  // Agents (write)
  "agents.pause": [
    params: { agentId: string; companyId: string },
    result: Agent,
  ];
  "agents.resume": [
    params: { agentId: string; companyId: string },
    result: Agent,
  ];
  "agents.managed.get": [
    params: { agentKey: string; companyId: string },
    result: PluginManagedAgentResolution,
  ];
  "agents.managed.reconcile": [
    params: { agentKey: string; companyId: string },
    result: PluginManagedAgentResolution,
  ];
  "agents.managed.reset": [
    params: { agentKey: string; companyId: string },
    result: PluginManagedAgentResolution,
  ];

  // Goals
  "goals.list": [
    params: Parameters<PluginGoalsClient["list"]>[0],
    result: Goal[],
  ];
  "goals.get": [
    params: { goalId: string; companyId: string },
    result: Goal | null,
  ];
  "goals.create": [
    params: Parameters<PluginGoalsClient["create"]>[0],
    result: Goal,
  ];
  "goals.update": [
    params: {
      goalId: string;
      patch: Parameters<PluginGoalsClient["update"]>[1];
      companyId: string;
    },
    result: Goal,
  ];

  // Access
  "access.members.list": [
    params: { companyId: string; includeArchived?: boolean },
    result: PluginAccessMember[],
  ];
  "access.members.get": [
    params: { memberId: string; companyId: string },
    result: PluginAccessMember | null,
  ];
  "access.members.update": [
    params: {
      memberId: string;
      companyId: string;
      patch: {
        membershipRole?: UserCompanyMembershipRole;
        status?: "pending" | "active" | "suspended";
      };
    },
    result: PluginAccessMember,
  ];
  "access.invites.list": [
    params: {
      companyId: string;
      state?: "active" | "revoked" | "accepted" | "expired";
    } & PluginListWindow,
    result: { invites: PluginAccessInvite[]; nextOffset: number | null },
  ];
  "access.invites.create": [
    params: {
      companyId: string;
      userRole?: string | null;
    },
    result: PluginAccessInvite & { token: string },
  ];
  "access.invites.revoke": [
    params: { inviteId: string; companyId: string },
    result: PluginAccessInvite,
  ];

  // Authorization
  "authorization.grants.list": [
    params: { companyId: string; principalType?: string; principalId?: string },
    result: PrincipalPermissionGrant[],
  ];
  "authorization.grants.set": [
    params: {
      companyId: string;
      principalType: string;
      principalId: string;
      grants: Array<{
        permissionKey: string;
        scope?: Record<string, unknown> | null;
      }>;
      grantedByUserId?: string | null;
    },
    result: PrincipalPermissionGrant[],
  ];
  "authorization.policies.summary": [
    params: { companyId: string },
    result: PluginAuthorizationPolicySummary,
  ];
  "authorization.policies.get": [
    params: {
      companyId: string;
      resourceType: "company" | "agent" | "task";
      resourceId: string;
    },
    result: PluginAuthorizationPolicyRecord | null,
  ];
  "authorization.policies.update": [
    params: {
      companyId: string;
      resourceType: "task";
      resourceId: string;
      policy: Record<string, unknown> | null;
    },
    result: PluginAuthorizationPolicyRecord,
  ];
  "authorization.policies.previewAssignment": [
    params: PluginAssignmentPreviewInput,
    result: PluginAuthorizationDecisionResult,
  ];
  "authorization.audit.search": [
    params: {
      companyId: string;
      action?: string;
      actorType?: string;
      actorId?: string;
      entityType?: string;
      entityId?: string;
      decision?: PluginAuthorizationAuditDecision;
    } & PluginListWindow,
    result: PluginAuthorizationAuditEntry[],
  ];
}

/** Union of all worker→host method names. */
export type WorkerToHostMethodName = keyof WorkerToHostMethods;

// ---------------------------------------------------------------------------
// Message Factory Functions
// ---------------------------------------------------------------------------

/** Counter for generating unique request IDs when no explicit ID is provided. */
let _nextId = 1;

/** Wrap around before reaching Number.MAX_SAFE_INTEGER to prevent precision loss. */
const MAX_SAFE_RPC_ID = Number.MAX_SAFE_INTEGER - 1;

/**
 * Create a JSON-RPC 2.0 request message.
 *
 * @param method - The RPC method name
 * @param params - Structured parameters
 * @param id - Optional explicit request ID (auto-generated if omitted)
 */
export function createRequest<TMethod extends string>(
  method: TMethod,
  params: unknown,
  id?: JsonRpcId,
): JsonRpcRequest<TMethod> {
  if (_nextId >= MAX_SAFE_RPC_ID) {
    _nextId = 1;
  }
  return {
    jsonrpc: JSONRPC_VERSION,
    id: id ?? _nextId++,
    method,
    params,
  };
}

/**
 * Create a JSON-RPC 2.0 success response.
 *
 * @param id - The request ID being responded to
 * @param result - The result value
 */
export function createSuccessResponse<TResult>(
  id: JsonRpcId,
  result: TResult,
): JsonRpcSuccessResponse<TResult> {
  return {
    jsonrpc: JSONRPC_VERSION,
    id,
    result,
  };
}

/**
 * Create a JSON-RPC 2.0 error response.
 *
 * @param id - The request ID being responded to (null if the request ID could not be determined)
 * @param code - Machine-readable error code
 * @param message - Human-readable error message
 * @param data - Optional structured error data
 */
export function createErrorResponse<TData = unknown>(
  id: JsonRpcId | null,
  code: number,
  message: string,
  data?: TData,
): JsonRpcErrorResponse<TData> {
  const response: JsonRpcErrorResponse<TData> = {
    jsonrpc: JSONRPC_VERSION,
    id,
    error:
      data !== undefined
        ? { code, message, data }
        : ({ code, message } as JsonRpcError<TData>),
  };
  return response;
}

// ---------------------------------------------------------------------------
// Type Guards
// ---------------------------------------------------------------------------

/**
 * Check whether a value is a well-formed JSON-RPC 2.0 request.
 *
 * A request has `jsonrpc: "2.0"`, a string `method`, and an `id`.
 */
export function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    obj.jsonrpc === JSONRPC_VERSION &&
    typeof obj.method === "string" &&
    "id" in obj &&
    obj.id !== undefined &&
    obj.id !== null
  );
}

/**
 * Check whether a value is a well-formed JSON-RPC 2.0 response (success or error).
 */
export function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    obj.jsonrpc === JSONRPC_VERSION &&
    "id" in obj &&
    ("result" in obj || "error" in obj)
  );
}

/**
 * Check whether a JSON-RPC response is a success response.
 */
export function isJsonRpcSuccessResponse(
  response: JsonRpcResponse,
): response is JsonRpcSuccessResponse {
  return (
    "result" in response &&
    !("error" in response && response.error !== undefined)
  );
}

/**
 * Check whether a JSON-RPC response is an error response.
 */
export function isJsonRpcErrorResponse(
  response: JsonRpcResponse,
): response is JsonRpcErrorResponse {
  return "error" in response && response.error !== undefined;
}

// ---------------------------------------------------------------------------
// Serialization Helpers
// ---------------------------------------------------------------------------

/**
 * Line delimiter for JSON-RPC messages over stdio.
 *
 * Each message is a single line of JSON terminated by a newline character.
 * This follows the newline-delimited JSON (NDJSON) convention.
 */
export const MESSAGE_DELIMITER = "\n" as const;

/**
 * Serialize a JSON-RPC message to a newline-delimited string for transmission
 * over stdio.
 *
 * @param message - A JSON-RPC request or response
 * @returns The JSON string terminated with a newline
 */
export function serializeMessage(message: JsonRpcMessage): string {
  return JSON.stringify(message) + MESSAGE_DELIMITER;
}

/**
 * Parse a JSON string into a JSON-RPC message.
 *
 * Returns the parsed message or throws a `JsonRpcParseError` if the input
 * is not valid JSON or does not conform to the JSON-RPC 2.0 structure.
 *
 * @param line - A single line of JSON text (with or without trailing newline)
 * @returns The parsed JSON-RPC message
 * @throws {JsonRpcParseError} If parsing fails
 */
export function parseMessage(line: string): JsonRpcMessage {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    throw new JsonRpcParseError("Empty message");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new JsonRpcParseError(`Invalid JSON: ${trimmed.slice(0, 200)}`);
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new JsonRpcParseError("Message must be a JSON object");
  }

  const obj = parsed as Record<string, unknown>;

  if (obj.jsonrpc !== JSONRPC_VERSION) {
    throw new JsonRpcParseError(
      `Invalid or missing jsonrpc version (expected "${JSONRPC_VERSION}", got ${JSON.stringify(obj.jsonrpc)})`,
    );
  }

  if (!isJsonRpcRequest(parsed) && !isJsonRpcResponse(parsed)) {
    throw new JsonRpcParseError(
      "Message must be a JSON-RPC request or response",
    );
  }

  return parsed as JsonRpcMessage;
}

// ---------------------------------------------------------------------------
// Error Classes
// ---------------------------------------------------------------------------

/**
 * Error thrown when a JSON-RPC message cannot be parsed.
 */
export class JsonRpcParseError extends Error {
  override readonly name = "JsonRpcParseError";
  constructor(message: string) {
    super(message);
  }
}

/**
 * Error thrown when a JSON-RPC call fails with a structured error response.
 *
 * Captures the full `JsonRpcError` so callers can inspect the code and data.
 */
export class JsonRpcCallError extends Error {
  override readonly name = "JsonRpcCallError";
  /** The JSON-RPC error code. */
  readonly code: number;
  /** Optional structured error data from the response. */
  readonly data: unknown;

  constructor(error: JsonRpcError) {
    super(error.message);
    this.code = error.code;
    this.data = error.data;
  }
}
