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
  Issue,
  PluginManagedAgentResolution,
  PluginManagedProjectResolution,
  PluginManagedRoutineResolution,
  PluginManagedSkillResolution,
  Routine,
  RoutineRun,
  Agent,
  Goal,
  PrincipalPermissionGrant,
  ProviderSafeRunTrace,
  PluginWorkerLogLevel,
} from "@paperclipai/shared";
export type { PluginLauncherRenderContextSnapshot } from "@paperclipai/shared";

import type {
  PluginEvent,
  PluginIssueUpdateInput,
  PluginIssueWithdrawalResult,
  PluginCreatorCallbackAcknowledgement,
  PluginCreatorCallbackDelivery,
  PluginJobContext,
  PluginRunContextHandle,
  PluginRunIssueProjection,
  PluginRunIssueCommentProjection,
  PluginRunPage,
  ToolResult,
  PluginLocalFolderListing,
  PluginLocalFolderStatus,
  PluginAccessInvite,
  PluginAccessMember,
  PluginAssignmentPreviewInput,
  PluginAuthorizationAuditEntry,
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
   * Host-issued metadata for the top-level plugin invocation that is currently
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
  | JsonRpcSuccessResponse<TResult>
  | JsonRpcErrorResponse<TData>;

/**
 * Any well-formed JSON-RPC 2.0 message exchanged by the plugin transport.
 */
export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcResponse;

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
    readonly issueId: string;
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
 * host-issued invocation id.
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
  | (
    PluginPerformActionActorBase & {
      /** Canonical Better Auth board principal. */
      type: "user";
      userId: string;
      agentId?: never;
      runId?: never;
    }
  )
  | (
    PluginPerformActionActorBase & {
      /** Productive runtime principal. */
      type: "agent";
      agentId: string;
      runId: string;
      userId?: never;
    }
  )
  | (
    PluginPerformActionActorBase & {
      /** Host-owned action with no human or runtime principal. */
      type: "system";
      userId?: never;
      agentId?: never;
      runId?: never;
    }
  );

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

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return actual.length === canonical.length
    && actual.every((key, index) => key === canonical[index]);
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
    return invalidPerformActionActorContext("an exact actor object is required");
  }

  const actor = value as Record<string, unknown>;
  const companyId = actor.companyId;
  if (companyId !== null && !isNonBlankString(companyId)) {
    return invalidPerformActionActorContext(
      '"companyId" must be null or a non-blank string',
    );
  }

  if (actor.type === "user") {
    if (!hasExactKeys(actor, PERFORM_ACTION_ACTOR_KEYS.user)) {
      return invalidPerformActionActorContext(
        'the "user" branch accepts exactly type, userId, and companyId',
      );
    }
    if (!isNonBlankString(actor.userId)) {
      return invalidPerformActionActorContext(
        '"userId" must be a non-blank string for a user actor',
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
    if (!isNonBlankString(actor.agentId) || !isNonBlankString(actor.runId)) {
      return invalidPerformActionActorContext(
        '"agentId" and "runId" must be non-blank strings for an agent actor',
      );
    }
    return {
      type: "agent",
      agentId: actor.agentId,
      runId: actor.runId,
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

export interface PluginEnvironmentDiagnostic {
  severity: "info" | "warning" | "error";
  message: string;
  code?: string;
  details?: Record<string, unknown>;
}

export interface PluginEnvironmentDriverBaseParams {
  driverKey: string;
  companyId: string;
  environmentId: string;
  issueId?: string | null;
  config: Record<string, unknown>;
}

export interface PluginEnvironmentValidateConfigParams {
  driverKey: string;
  config: Record<string, unknown>;
}

export interface PluginEnvironmentValidationResult {
  ok: boolean;
  warnings?: string[];
  errors?: string[];
  normalizedConfig?: Record<string, unknown>;
}

export interface PluginEnvironmentProbeParams extends PluginEnvironmentDriverBaseParams {}

export interface PluginEnvironmentProbeResult {
  ok: boolean;
  summary?: string;
  diagnostics?: PluginEnvironmentDiagnostic[];
  metadata?: Record<string, unknown>;
}

export interface PluginEnvironmentLease {
  providerLeaseId: string | null;
  metadata?: Record<string, unknown>;
  expiresAt?: string | null;
}

export interface PluginEnvironmentAcquireLeaseParams extends PluginEnvironmentDriverBaseParams {
  runId: string;
  workspaceMode?: string;
  requestedCwd?: string;
  agentId?: string;
  executionWorkspaceId?: string | null;
  /**
   * The harness/adapter type for THIS run (the agent's adapter), so a single
   * environment can serve mixed harnesses. When omitted, the driver falls back to
   * the environment's configured default adapter. A provider that materializes a
   * per-run sandbox should use this to select the runtime image and per-run env.
   */
  adapterType?: string;
}

export interface PluginEnvironmentResumeLeaseParams extends PluginEnvironmentDriverBaseParams {
  providerLeaseId: string;
  leaseMetadata?: Record<string, unknown>;
}

export interface PluginEnvironmentReleaseLeaseParams extends PluginEnvironmentDriverBaseParams {
  providerLeaseId: string | null;
  leaseMetadata?: Record<string, unknown>;
}

export interface PluginEnvironmentDestroyLeaseParams extends PluginEnvironmentReleaseLeaseParams {}

export interface PluginEnvironmentRealizeWorkspaceParams extends PluginEnvironmentDriverBaseParams {
  lease: PluginEnvironmentLease;
  workspace: {
    localPath?: string;
    remotePath?: string;
    mode?: string;
    metadata?: Record<string, unknown>;
  };
}

export interface PluginEnvironmentRealizeWorkspaceResult {
  cwd: string;
  metadata?: Record<string, unknown>;
}

export interface PluginEnvironmentExecuteParams extends PluginEnvironmentDriverBaseParams {
  lease: PluginEnvironmentLease;
  /**
   * Opaque host-owned identity for this exact command invocation. Providers
   * use it only to correlate exact cancellation; it must never be copied into
   * the command environment, stdin, or provider-visible model input.
   */
  executionId: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
}

export interface PluginEnvironmentExecuteResult {
  exitCode: number | null;
  signal?: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  metadata?: Record<string, unknown>;
}

export interface PluginEnvironmentCancelExecutionParams extends PluginEnvironmentDriverBaseParams {
  lease: PluginEnvironmentLease;
  /** Exact host-owned command identity previously passed to environmentExecute. */
  executionId: string;
  /** Operator/control-plane cancellation reason. Never provider/model input. */
  reason: string;
}

export interface PluginEnvironmentCancelExecutionResult {
  executionId: string;
  /**
   * True only when the exact company/environment/lease/execution tuple was
   * acknowledged by the provider's command-level stop path. A false result
   * means that exact identity is absent/stale; scope mismatch is never widened
   * into lease-, workspace-, or provider-wide cancellation.
   */
  cancelled: boolean;
}

/**
 * A single source→target file or directory transfer within a sync operation.
 *
 * For `environmentSyncIn`, `sourcePath` is a host path and `targetPath` is a
 * sandbox path; for `environmentSyncOut` the direction is reversed. All sandbox
 * paths are POSIX. The contract is provider-agnostic: a provider may transfer a
 * directory by whatever native mechanism it prefers (bulk upload, internal tar,
 * per-file enumeration) as long as the observable result matches this mapping.
 */
export interface PluginSyncFileMapping {
  /** Absolute path of the transfer source (host for syncIn, sandbox for syncOut). */
  sourcePath: string;
  /** Absolute path of the transfer target (sandbox for syncIn, host for syncOut). */
  targetPath: string;
  /** Whether the mapping transfers a single regular file or a directory tree. */
  kind: "file" | "directory";
  /**
   * POSIX file mode to apply at the target (e.g. `0o600` for secret material).
   * When set, providers MUST create the target with this mode with no
   * world-readable window (create-with-mode or chmod-before-bytes, never after).
   */
  mode?: number;
  /** Glob patterns to exclude when `kind` is `"directory"`. */
  exclude?: string[];
  /**
   * Symlink handling for `kind: "directory"` transfers. Falsy preserves symlinks
   * as links; `true` dereferences them to their target bytes. Mirrors tar's `-h`.
   */
  followSymlinks?: boolean;
}

/**
 * An ordered, opaque unit of work handed to a sync hook. The `operationId` is an
 * opaque, non-sensitive token authored by the orchestrator; a provider MUST NOT
 * interpret it. Operations are applied in array order.
 */
export interface PluginSyncOperation {
  operationId: string;
  files: PluginSyncFileMapping[];
}

export interface PluginEnvironmentSyncParams extends PluginEnvironmentDriverBaseParams {
  lease: PluginEnvironmentLease;
  operations: PluginSyncOperation[];
}

/** Per-operation transfer accounting returned by a sync hook, for observability. */
export interface PluginEnvironmentSyncResult {
  operations: {
    operationId: string;
    filesTransferred: number;
    bytesTransferred: number;
  }[];
}

export type PluginEnvironmentInteractiveSetupStatus =
  | "starting"
  | "waiting_for_user"
  | "capturing"
  | "promoted"
  | "cancelled"
  | "timed_out"
  | "failed"
  | "missing";

export type PluginEnvironmentInteractiveSetupConnectionType =
  | "ssh"
  | (string & {});

export type PluginEnvironmentTemplateRefKind =
  | "snapshot"
  | "image"
  | "provider_template"
  | "unknown"
  | (string & {});

export interface PluginEnvironmentInteractiveSetupConnectionSummary {
  type: PluginEnvironmentInteractiveSetupConnectionType;
  username?: string | null;
  hostRedacted: boolean;
  portRedacted: boolean;
  commandRedacted?: boolean;
  expiresAt?: string | null;
  metadata?: Record<string, unknown>;
}

export interface PluginEnvironmentInteractiveSetupConnectionPayload {
  type: PluginEnvironmentInteractiveSetupConnectionType;
  command?: string | null;
  token?: string | null;
  expiresAt?: string | null;
  metadata?: Record<string, unknown>;
}

export interface PluginEnvironmentInteractiveSetupSession {
  providerLeaseId: string | null;
  status: PluginEnvironmentInteractiveSetupStatus;
  connectionSummary: PluginEnvironmentInteractiveSetupConnectionSummary | null;
  connectionPayload?: PluginEnvironmentInteractiveSetupConnectionPayload | null;
  expiresAt?: string | null;
  metadata?: Record<string, unknown>;
}

export interface PluginEnvironmentStartInteractiveSetupParams extends PluginEnvironmentDriverBaseParams {
  sessionId: string;
  sourceTemplateRef?: string | null;
  sourceTemplateKind?: PluginEnvironmentTemplateRefKind | null;
  connectionExpiresInMinutes?: number | null;
  expiresAt?: string | null;
}

export interface PluginEnvironmentGetInteractiveSetupParams extends PluginEnvironmentDriverBaseParams {
  providerLeaseId: string | null;
  setupMetadata?: Record<string, unknown>;
  includeConnectionPayload?: boolean;
  connectionExpiresInMinutes?: number | null;
}

export interface PluginEnvironmentCaptureTemplateParams extends PluginEnvironmentDriverBaseParams {
  providerLeaseId: string | null;
  setupMetadata?: Record<string, unknown>;
  sourceTemplateRef?: string | null;
  previousTemplateRef?: string | null;
  templateLabel?: string | null;
  timeoutMs?: number | null;
}

export interface PluginEnvironmentCaptureTemplateResult {
  templateRef: string;
  templateKind: PluginEnvironmentTemplateRefKind;
  metadata?: Record<string, unknown>;
}

export interface PluginEnvironmentCancelInteractiveSetupParams extends PluginEnvironmentDriverBaseParams {
  providerLeaseId: string | null;
  setupMetadata?: Record<string, unknown>;
  reason?: string | null;
}

export interface PluginEnvironmentCancelInteractiveSetupResult {
  status: Extract<PluginEnvironmentInteractiveSetupStatus, "cancelled" | "timed_out" | "failed" | "missing">;
  metadata?: Record<string, unknown>;
}

export interface PluginEnvironmentDeleteTemplateParams extends PluginEnvironmentDriverBaseParams {
  templateRef: string;
  templateKind?: PluginEnvironmentTemplateRefKind;
  metadata?: Record<string, unknown>;
  reason?: string | null;
}

export interface PluginEnvironmentDeleteTemplateResult {
  deleted: boolean;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// UI launcher / modal host interaction payloads
// ---------------------------------------------------------------------------

/**
 * Bounds request issued by a plugin UI running inside a host-managed launcher
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
  validateConfig: [params: ValidateConfigParams, result: PluginConfigValidationResult];
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
  "issues.creatorCallback.deliver": [
    params: {
      callbackKey: string;
      callbackVersion: string;
      delivery: PluginCreatorCallbackDelivery;
    },
    result: PluginCreatorCallbackAcknowledgement,
  ];
  environmentValidateConfig: [
    params: PluginEnvironmentValidateConfigParams,
    result: PluginEnvironmentValidationResult,
  ];
  environmentProbe: [
    params: PluginEnvironmentProbeParams,
    result: PluginEnvironmentProbeResult,
  ];
  environmentAcquireLease: [
    params: PluginEnvironmentAcquireLeaseParams,
    result: PluginEnvironmentLease,
  ];
  environmentResumeLease: [
    params: PluginEnvironmentResumeLeaseParams,
    result: PluginEnvironmentLease,
  ];
  environmentReleaseLease: [
    params: PluginEnvironmentReleaseLeaseParams,
    result: void,
  ];
  environmentDestroyLease: [
    params: PluginEnvironmentDestroyLeaseParams,
    result: void,
  ];
  environmentRealizeWorkspace: [
    params: PluginEnvironmentRealizeWorkspaceParams,
    result: PluginEnvironmentRealizeWorkspaceResult,
  ];
  environmentExecute: [
    params: PluginEnvironmentExecuteParams,
    result: PluginEnvironmentExecuteResult,
  ];
  environmentCancelExecution: [
    params: PluginEnvironmentCancelExecutionParams,
    result: PluginEnvironmentCancelExecutionResult,
  ];
  environmentSyncIn: [
    params: PluginEnvironmentSyncParams,
    result: PluginEnvironmentSyncResult,
  ];
  environmentSyncOut: [
    params: PluginEnvironmentSyncParams,
    result: PluginEnvironmentSyncResult,
  ];
  environmentStartInteractiveSetup: [
    params: PluginEnvironmentStartInteractiveSetupParams,
    result: PluginEnvironmentInteractiveSetupSession,
  ];
  environmentGetInteractiveSetup: [
    params: PluginEnvironmentGetInteractiveSetupParams,
    result: PluginEnvironmentInteractiveSetupSession,
  ];
  environmentCaptureTemplate: [
    params: PluginEnvironmentCaptureTemplateParams,
    result: PluginEnvironmentCaptureTemplateResult,
  ];
  environmentCancelInteractiveSetup: [
    params: PluginEnvironmentCancelInteractiveSetupParams,
    result: PluginEnvironmentCancelInteractiveSetupResult,
  ];
  environmentDeleteTemplate: [
    params: PluginEnvironmentDeleteTemplateParams,
    result: PluginEnvironmentDeleteTemplateResult,
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
  "issues.creatorCallback.deliver",
  "environmentValidateConfig",
  "environmentProbe",
  "environmentAcquireLease",
  "environmentResumeLease",
  "environmentReleaseLease",
  "environmentDestroyLease",
  "environmentRealizeWorkspace",
  "environmentExecute",
  "environmentCancelExecution",
  "environmentSyncIn",
  "environmentSyncOut",
  "environmentStartInteractiveSetup",
  "environmentGetInteractiveSetup",
  "environmentCaptureTemplate",
  "environmentCancelInteractiveSetup",
  "environmentDeleteTemplate",
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
  "config.get": [params: Record<string, never>, result: Record<string, unknown>];

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
    params: { companyId: string; folderKey: string; relativePath?: string | null; recursive?: boolean; maxEntries?: number },
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
  "state.get": [
    params: ScopeKey,
    result: unknown,
  ];
  "state.set": [
    params: ScopeKey & { value: unknown },
    result: void,
  ];
  "state.delete": [
    params: ScopeKey,
    result: void,
  ];

  // Restricted plugin database namespace
  "db.query": [
    params: { sql: string; params?: unknown[] },
    result: unknown[],
  ];
  "db.execute": [
    params: { sql: string; params?: unknown[] },
    result: { rowCount: number },
  ];

  // Entities
  "entities.upsert": [
    params: PluginEntityUpsert,
    result: PluginEntityRecord,
  ];
  "entities.list": [
    params: PluginEntityQuery,
    result: PluginEntityRecord[],
  ];

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
    result: { status: number; statusText: string; headers: Record<string, string>; body: string },
  ];

  "runtime.records.readRun": [
    params: { companyId: string; runId: string; cursor?: string },
    result: ProviderSafeRunTrace,
  ];
  "runtime.records.readIssueComments": [
    params: { companyId: string; issueId: string; cursor?: string; limit?: number },
    result: PluginRunPage<PluginRunIssueCommentProjection>,
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
    params: { eventName: string; dimensions?: Record<string, string | number | boolean> },
    result: void,
  ];

  // Logger
  "log": [
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
  "companies.get": [
    params: { companyId: string },
    result: Company | null,
  ];

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
      status?: Parameters<PluginRoutinesClient["managed"]["update"]>[2]["status"];
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
  "skills.managed.get": [
    params: { skillKey: string; companyId: string },
    result: PluginManagedSkillResolution,
  ];
  "skills.managed.reconcile": [
    params: { skillKey: string; companyId: string },
    result: PluginManagedSkillResolution,
  ];
  "skills.managed.reset": [
    params: { skillKey: string; companyId: string },
    result: PluginManagedSkillResolution,
  ];

  // Issues
  "issues.list": [
    params: {
      companyId: string;
      projectId?: string;
      ownerAgentId?: string;
      status?: "open" | "blocked" | "done" | "cancelled";
      limit?: number;
      offset?: number;
    },
    result: Issue[],
  ];
  "issues.get": [
    params: { issueId: string; companyId: string },
    result: Issue | null,
  ];
  "issues.creatorCallback.register": [
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
  "run.issues.listCompanyIssues": [
    params: {
      runContextHandle: PluginRunContextHandle;
      status?: "open" | "blocked" | "done" | "cancelled";
      priority?: "critical" | "high" | "medium" | "low";
      cursor?: string;
      limit?: number;
    },
    result: PluginRunPage<PluginRunIssueProjection>,
  ];
  "run.context.resolve": [
    params: { runContextHandle: PluginRunContextHandle },
    result: import("./types.js").PluginResolvedRunContext,
  ];
  "run.context.issueReach": [
    params: { runContextHandle: PluginRunContextHandle; issueId: string },
    result: import("./types.js").PluginRunIssueReach,
  ];
  "run.issues.listSubIssues": [
    params: {
      runContextHandle: PluginRunContextHandle;
      issueId?: string;
      cursor?: string;
      limit?: number;
    },
    result: PluginRunPage<PluginRunIssueProjection>,
  ];
  "run.issues.readIssueComments": [
    params: {
      runContextHandle: PluginRunContextHandle;
      issueId?: string;
      cursor?: string;
      limit?: number;
    },
    result: PluginRunPage<PluginRunIssueCommentProjection>,
  ];
  "run.issues.readIssueAgentRun": [
    params: {
      runContextHandle: PluginRunContextHandle;
      runId: string;
      cursor?: string;
    },
    result: ProviderSafeRunTrace,
  ];
  "issues.create": [
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
    result: Issue,
  ];
  "issues.update": [
    params: {
      issueId: string;
      input: PluginIssueUpdateInput;
      companyId: string;
    },
    result: Issue,
  ];
  "issues.withdraw": [
    params: {
      issueId: string;
      companyId: string;
      message: string;
    },
    result: PluginIssueWithdrawalResult,
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
        membershipRole?: string | null;
        status?: "pending" | "active" | "suspended";
      };
    },
    result: PluginAccessMember,
  ];
  "access.invites.list": [
    params: {
      companyId: string;
      state?: "active" | "revoked" | "accepted" | "expired";
      limit?: number;
      offset?: number;
    },
    result: { invites: PluginAccessInvite[]; nextOffset: number | null },
  ];
  "access.invites.create": [
    params: {
      companyId: string;
      allowedJoinTypes?: "human" | "agent" | "both";
      humanRole?: string | null;
      defaultsPayload?: Record<string, unknown> | null;
      agentMessage?: string | null;
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
      grants: Array<{ permissionKey: string; scope?: Record<string, unknown> | null }>;
      grantedByUserId?: string | null;
    },
    result: PrincipalPermissionGrant[],
  ];
  "authorization.policies.summary": [
    params: { companyId: string },
    result: PluginAuthorizationPolicySummary,
  ];
  "authorization.policies.get": [
    params: { companyId: string; resourceType: "company" | "agent" | "issue"; resourceId: string },
    result: PluginAuthorizationPolicyRecord | null,
  ];
  "authorization.policies.update": [
    params: {
      companyId: string;
      resourceType: "issue";
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
      decision?: string;
      limit?: number;
      offset?: number;
    },
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
    error: data !== undefined
      ? { code, message, data }
      : { code, message } as JsonRpcError<TData>,
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
  return "result" in response && !("error" in response && response.error !== undefined);
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
    throw new JsonRpcParseError("Message must be a JSON-RPC request or response");
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
