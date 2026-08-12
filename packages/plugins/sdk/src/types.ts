/**
 * Core types for the Paperclip plugin worker-side SDK.
 *
 * These types define the stable public API surface that plugin workers import
 * from `@paperclipai/plugin-sdk`.  The host provides a concrete implementation
 * of `PluginContext` to the plugin at initialisation time.
 *
 * @see PLUGIN_SPEC.md §14 — SDK Surface
 * @see PLUGIN_SPEC.md §29.2 — SDK Versioning
 */

import type {
  PaperclipPluginManifestV1,
  PluginStateScopeKind,
  PluginJobRunTrigger,
  PluginEventType,
  Company,
  Project,
  Task,
  PluginManagedAgentResolution,
  PluginManagedProjectResolution,
  PluginManagedRoutineResolution,
  Routine,
  RoutineRun,
  RoutineStatus,
  Agent,
  Goal,
  UserCompanyMembershipRole,
  InviteSource,
  MembershipStatus,
  PermissionKey,
  PrincipalPermissionGrant,
  PrincipalType,
  ProviderSafeTaskProjection,
  ProviderSafeRunTrace,
  PluginLocalFolderProblem,
  PluginLocalFolderStatus,
  TaskExecutionSessionOperation,
  AgentContextGrantKey,
} from "@paperclipai/shared";
import type { PluginPerformActionContext } from "./protocol.js";

// ---------------------------------------------------------------------------
// Re-exports from @paperclipai/shared (plugin authors import from one place)
// ---------------------------------------------------------------------------

export type {
  PaperclipPluginManifestV1,
  PluginJobDeclaration,
  PluginWebhookDeclaration,
  PluginToolDeclaration,
  PluginManagedAgentDeclaration,
  PluginManagedAgentResolution,
  PluginManagedProjectDeclaration,
  PluginManagedProjectResolution,
  PluginManagedRoutineDeclaration,
  PluginManagedRoutineResolution,
  Routine,
  RoutineRun,
  PluginLocalFolderDeclaration,
  PluginManagedResourceKind,
  PluginManagedResourceRef,
  PluginUiSlotDeclaration,
  PluginUiDeclaration,
  PluginLauncherActionDeclaration,
  PluginLauncherRenderDeclaration,
  PluginLauncherDeclaration,
  PluginDatabaseDeclaration,
  PluginApiRouteDeclaration,
  PluginApiRouteCompanyResolution,
  JsonSchema,
  PluginCategory,
  PluginCapability,
  ProviderSafeRunTrace,
  PluginUiSlotType,
  PluginUiSlotEntityType,
  PluginLauncherPlacementZone,
  PluginLauncherAction,
  PluginLauncherBounds,
  PluginLauncherRenderEnvironment,
  PluginStateScopeKind,
  PluginJobRunTrigger,
  PluginDatabaseCoreReadTable,
  PluginApiRouteMethod,
  PluginEventType,
  PluginBridgeErrorCode,
  Company,
  Project,
  Task,
  TaskComment,
  TaskDocument,
  TaskDocumentSummary,
  TaskRelationTaskSummary,
  PluginTaskOriginKind,
  TaskSurfaceVisibility,
  Agent,
  Goal,
  UserCompanyMembershipRole,
  InviteSource,
  MembershipStatus,
  PermissionKey,
  PrincipalPermissionGrant,
  PrincipalType,
  TaskExecutionSessionOperation,
} from "@paperclipai/shared";

// ---------------------------------------------------------------------------
// Scope key — identifies where plugin state is stored
// ---------------------------------------------------------------------------

/**
 * A scope key identifies the exact location where plugin state is stored.
 * Scope is partitioned by `scopeKind` and optional `scopeId`.
 *
 * Examples:
 * - `{ scopeKind: "instance" }` — single global value for the whole instance
 * - `{ scopeKind: "project", scopeId: "proj-uuid" }` — per-project state
 * - `{ scopeKind: "task", scopeId: "task-uuid" }` — per-task state
 *
 * @see PLUGIN_SPEC.md §21.3 `plugin_state`
 */
export type PluginDataScope =
  | {
      /** Instance scope has no object identifier. */
      scopeKind: "instance";
      scopeId?: never;
    }
  | {
      /** Every object-backed scope requires its exact identifier. */
      scopeKind: Exclude<PluginStateScopeKind, "instance">;
      scopeId: string;
    };

export type ScopeKey = PluginDataScope & {
  /** Optional sub-namespace within the scope to avoid key collisions. Defaults to `"default"`. */
  namespace?: string;
  /** The state key within the namespace. */
  stateKey: string;
};

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

/**
 * Optional filter applied when subscribing to an event. The host evaluates
 * the filter server-side so filtered-out events never cross the process boundary.
 *
 * All filter fields are optional. If omitted the plugin receives every event
 * of the subscribed type.
 *
 * @see PLUGIN_SPEC.md §16.1 — Event Filtering
 */
export interface EventFilter {
  /** Only receive events for this company. */
  companyId?: string;
  /** Only receive terminal run events for this agent. */
  agentId?: string;
}

/** Exact core-event name or plugin-event pattern accepted by subscriptions. */
export type PluginEventPattern = PluginEventType | `plugin.${string}`;

/**
 * Envelope wrapping every domain event delivered to a plugin worker.
 *
 * @see PLUGIN_SPEC.md §16 — Event System
 */
export interface PluginEvent<TPayload = unknown> {
  /** Unique event identifier (UUID). */
  eventId: string;
  /** The event type (e.g. `"task.board.comment.created"`). */
  eventType: PluginEventType | `plugin.${string}`;
  /** ISO 8601 timestamp when the event occurred. */
  occurredAt: string;
  /** ID of the actor that caused the event, if applicable. */
  actorId?: string;
  /** Type of actor: `"user"`, `"agent"`, `"system"`, or `"plugin"`. */
  actorType?: "user" | "agent" | "system" | "plugin";
  /** Primary entity involved in the event. */
  entityId?: string;
  /** Type of the primary entity. */
  entityType?: string;
  /** UUID of the company this event belongs to. */
  companyId: string;
  /** Typed event payload. */
  payload: TPayload;
}

// ---------------------------------------------------------------------------
// Before-prompt lifecycle
// ---------------------------------------------------------------------------

/**
 * Exact host-owned context delivered immediately before one provider prompt.
 * `sourceText` is the immutable canonical Session message. A plugin may return
 * a separate prompt prelude; Paperclip composes all preludes only for the
 * outbound provider request and never writes them back to the Session.
 */
export interface PluginBeforePromptInput {
  readonly companyId: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly agentId: string;
  readonly projectId: string | null;
  readonly sourceText: string;
  readonly promptKind: "base" | "steering";
  readonly sessionOperation: TaskExecutionSessionOperation;
  readonly refId: string;
  readonly refOrdinal: number;
  readonly segmentOrdinal: number;
  /** Exact canonical source message admitted for this prompt. */
  readonly sourceMessageId: string;
  /** Non-negative safe-integer global Session sequence of `sourceMessageId`. */
  readonly sourceMessageSeq: number;
  readonly contextAccess: PluginContextAccess;
  /**
   * Stable inclusive boundary for canonical Session reads during this hook.
   * This equals `sourceMessageSeq`, so later queued or steering facts cannot
   * leak into the prompt being observed.
   */
  readonly snapshotHighWaterSeq: number;
}

/** Optional contribution from one blocking before-prompt hook. */
export type PluginBeforePromptResult = null | { readonly prependText: string };

// ---------------------------------------------------------------------------
// Job context
// ---------------------------------------------------------------------------

/**
 * Context passed to a plugin job handler when the host triggers a scheduled run.
 *
 * @see PLUGIN_SPEC.md §13.6 — `runJob`
 */
export interface PluginJobContext {
  /** Stable job key matching the declaration in the manifest. */
  jobKey: string;
  /** UUID for this specific job run instance. */
  runId: string;
  /** What triggered this run. */
  trigger: PluginJobRunTrigger;
  /** ISO 8601 timestamp when the run was scheduled to start. */
  scheduledAt: string;
}

// ---------------------------------------------------------------------------
// Plugin run-context handle
// ---------------------------------------------------------------------------

/**
 * Opaque run-context handle passed to a plugin tool handler when its direct
 * namespaced tool is invoked from a compiled run interface.
 *
 * The value has no client-derivable fields. Plugins may only echo it through
 * the active worker invocation; the host resolves and revalidates its live
 * company, task, execution-ref, ownership-epoch, mode, lease, and tool scope.
 */
export type PluginRunContextHandle = string;

/**
 * Run-serving task projection available only while handling a direct plugin
 * tool invocation. It is intentionally separate from `ctx.tasks`,
 * which remains the installation control plane.
 */
export type PluginRunTaskProjection = ProviderSafeTaskProjection;

export interface PluginRunTaskCommentProjection {
  id: string;
  taskId: string;
  body: string;
  author:
    | { kind: "agent"; agentId: string }
    | { kind: "user"; userId: string }
    | { kind: "plugin"; pluginKey: string }
    | { kind: "board" }
    | { kind: "system" };
  runId: string | null;
  sequence: number;
  createdAt: string;
}

export interface PluginRunPage<T> {
  items: T[];
  nextCursor: string | null;
}

export interface PluginRunTasksClient {
  listCompanyTasks(input?: {
    status?: "open" | "blocked" | "done" | "cancelled";
    priority?: "critical" | "high" | "medium" | "low";
    cursor?: string;
    limit?: number;
  }): Promise<PluginRunPage<PluginRunTaskProjection>>;
  listSubTasks(input?: {
    taskId?: string;
    cursor?: string;
    limit?: number;
  }): Promise<PluginRunPage<PluginRunTaskProjection>>;
  readTaskComments(input?: {
    taskId?: string;
    cursor?: string;
    limit?: number;
  }): Promise<PluginRunPage<PluginRunTaskCommentProjection>>;
  readTaskAgentRun(
    runId: string,
    input?: { cursor?: string },
  ): Promise<ProviderSafeRunTrace>;
}

/** Trusted, host-resolved identity for the exact active agent tool call. */
export interface PluginResolvedRunContext {
  companyId: string;
  taskId: string;
  agentId: string;
  runId: string;
  projectId: string | null;
  contextAccess: PluginContextAccess;
}

export interface PluginRunTaskReach {
  visible: boolean;
  relation: "active" | "descendant" | "company" | "outside";
}

/**
 * Worker-local facade for an opaque run-context handle. The handle itself has
 * no client-derived coordinates; `resolve()` asks the host for the canonical
 * identity bound to this exact live invocation.
 */
export interface PluginToolRunContext {
  readonly handle: PluginRunContextHandle;
  /** Resolve canonical identity for this exact live tool invocation. */
  resolve(): Promise<PluginResolvedRunContext>;
  /**
   * Resolve task visibility from the active agent's existing context-access
   * matrix. The host, rather than the plugin, owns the authorization decision.
   */
  taskReach(taskId: string): Promise<PluginRunTaskReach>;
  readonly tasks: PluginRunTasksClient;
}

/**
 * Result returned from a plugin tool handler.
 *
 * @see PLUGIN_SPEC.md §13.10 — `executeTool`
 */
export type PluginToolStructuredData = Readonly<
  Record<string, PluginJsonValue>
>;

export type ToolResult =
  | {
      /** Explicit successful result discriminator. */
      readonly ok: true;
      /** String content returned to the agent. */
      readonly content: string;
      /** Optional JSON object returned as MCP structured content. */
      readonly data?: PluginToolStructuredData;
    }
  | {
      /** Explicit failed result discriminator. */
      readonly ok: false;
      /** Error text returned to the agent as a failed MCP tool result. */
      readonly error: string;
      /** Optional JSON object returned as MCP structured content. */
      readonly data?: PluginToolStructuredData;
    };

// ---------------------------------------------------------------------------
// Plugin entity store
// ---------------------------------------------------------------------------

/**
 * Input for creating or updating a plugin-owned entity.
 *
 * @see PLUGIN_SPEC.md §21.3 `plugin_entities`
 */
export type PluginEntityUpsert = PluginDataScope & {
  /** Plugin-defined entity type (e.g. `"linear-ticket"`, `"github-pr"`). */
  entityType: string;
  /** External identifier in the remote system (e.g. Linear ticket ID). */
  externalId?: string;
  /** Human-readable title for display in the Paperclip UI. */
  title?: string;
  /** Optional status string. */
  status?: string;
  /** Full entity data blob. Must be JSON-serializable. */
  data: Record<string, unknown>;
};

/**
 * A plugin-owned entity record as returned by `ctx.entities.list()`.
 *
 * @see PLUGIN_SPEC.md §21.3 `plugin_entities`
 */
export interface PluginEntityRecord {
  /** UUID primary key. */
  id: string;
  /** Plugin-defined entity type. */
  entityType: string;
  /** Scope kind. */
  scopeKind: PluginStateScopeKind;
  /** Scope ID, if any. */
  scopeId: string | null;
  /** External identifier, if any. */
  externalId: string | null;
  /** Human-readable title. */
  title: string | null;
  /** Status string. */
  status: string | null;
  /** Full entity data. */
  data: Record<string, unknown>;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
  /** ISO 8601 last-updated timestamp. */
  updatedAt: string;
}

/**
 * Query parameters for `ctx.entities.list()`.
 */
type PluginEntityQueryFilters = {
  /** Filter by entity type. */
  entityType?: string;
  /** Filter by external ID. */
  externalId?: string;
  /** Maximum number of results to return. */
  limit?: number;
  /** Number of results to skip (for pagination). */
  offset?: number;
};

export type PluginEntityQuery = PluginEntityQueryFilters &
  (
    | { scopeKind?: undefined; scopeId?: never }
    | { scopeKind: "instance"; scopeId?: never }
    | { scopeKind: Exclude<PluginStateScopeKind, "instance">; scopeId: string }
  );

// ---------------------------------------------------------------------------
// Host API surfaces exposed via PluginContext
// ---------------------------------------------------------------------------

/**
 * `ctx.config` — read resolved operator configuration for this plugin.
 *
 * Plugin workers receive the resolved config at initialisation. Use `get()`
 * to access the current configuration. A saved configuration replaces the
 * worker process so setup always observes one coherent configuration.
 *
 * @see PLUGIN_SPEC.md §13.3 — `validateConfig`
 */
export interface PluginConfigClient {
  /** Returns the resolved instance configuration for this installed plugin. */
  get(): Promise<Record<string, unknown>>;
}

export type { PluginLocalFolderProblem, PluginLocalFolderStatus };

export interface PluginLocalFolderConfigureInput {
  companyId: string;
  folderKey: string;
  path: string;
}

export interface PluginLocalFolderListOptions {
  relativePath?: string | null;
  recursive?: boolean;
  maxEntries?: number;
}

export interface PluginLocalFolderEntry {
  path: string;
  name: string;
  kind: "file" | "directory";
  size: number | null;
  modifiedAt: string | null;
}

export interface PluginLocalFolderListing {
  folderKey: string;
  relativePath: string | null;
  entries: PluginLocalFolderEntry[];
  truncated: boolean;
}

export interface PluginLocalFoldersClient {
  /** Persist a company-scoped local folder path after validating it. */
  configure(
    input: PluginLocalFolderConfigureInput,
  ): Promise<PluginLocalFolderStatus>;
  /** Check the stored folder readiness for a company and folder key. */
  status(
    companyId: string,
    folderKey: string,
  ): Promise<PluginLocalFolderStatus>;
  /** List entries below a configured folder after containment checks. */
  list(
    companyId: string,
    folderKey: string,
    options?: PluginLocalFolderListOptions,
  ): Promise<PluginLocalFolderListing>;
  /** Read a UTF-8 text file below a configured folder after containment checks. */
  readText(
    companyId: string,
    folderKey: string,
    relativePath: string,
  ): Promise<string>;
  /** Write a UTF-8 text file below a configured folder using atomic rename. */
  writeTextAtomic(
    companyId: string,
    folderKey: string,
    relativePath: string,
    contents: string,
  ): Promise<PluginLocalFolderStatus>;
  /** Delete a file below a configured folder after containment checks. Missing files are treated as already deleted. */
  deleteFile(
    companyId: string,
    folderKey: string,
    relativePath: string,
  ): Promise<PluginLocalFolderStatus>;
}

/**
 * `ctx.events` — subscribe to and emit Paperclip domain events.
 *
 * Requires `events.subscribe` capability for `on()`.
 * Requires `events.emit` capability for `emit()`.
 *
 * @see PLUGIN_SPEC.md §16 — Event System
 */
export interface PluginEventsClient {
  /**
   * Subscribe to a core Paperclip domain event or a plugin-namespaced event.
   *
   * @param name - Event type, e.g. `"task.board.comment.created"` or `"plugin.@acme/linear.sync-done"`
   * @param fn - Async event handler
   */
  on(
    name: PluginEventPattern,
    fn: (event: PluginEvent) => Promise<void>,
  ): () => void;

  /**
   * Subscribe to an event with an optional server-side filter.
   *
   * @param name - Event type
   * @param filter - Server-side filter evaluated before dispatching to the worker
   * @param fn - Async event handler
   * @returns An unsubscribe function that removes the handler
   */
  on(
    name: PluginEventPattern,
    filter: EventFilter,
    fn: (event: PluginEvent) => Promise<void>,
  ): () => void;

  /**
   * Emit a plugin-namespaced event. Other plugins with `events.subscribe` can
   * subscribe to it using `"plugin.<pluginKey>.<eventName>"`.
   *
   * Requires the `events.emit` capability.
   *
   * Plugin-emitted events are automatically namespaced: if the plugin key is
   * `"acme.linear"` and the event name is `"sync-done"`, the full event type
   * becomes `"plugin.acme.linear.sync-done"`.
   *
   * @see PLUGIN_SPEC.md §16.2 — Plugin-to-Plugin Events
   *
   * @param name - Bare event name (e.g. `"sync-done"`)
   * @param companyId - UUID of the company this event belongs to
   * @param payload - JSON-serializable event payload
   */
  emit(name: string, companyId: string, payload: unknown): Promise<void>;
}

/**
 * `ctx.jobs` — register handlers for scheduled jobs declared in the manifest.
 *
 * Requires `jobs.schedule` capability.
 *
 * @see PLUGIN_SPEC.md §17 — Scheduled Jobs
 */
export interface PluginJobsClient {
  /**
   * Register a handler for a scheduled job.
   *
   * The `key` must match a `jobKey` declared in the plugin manifest.
   * Every declared job must have exactly one registered handler.
   * The host calls this handler according to the job's declared `schedule`.
   *
   * @param key - Job key matching the manifest declaration
   * @param fn - Async job handler
   */
  register(key: string, fn: (job: PluginJobContext) => Promise<void>): void;
}

export interface PluginDatabaseClient {
  /** Host-derived PostgreSQL schema name for this plugin's namespace. */
  namespace: string;

  /** Run a restricted SELECT against the plugin namespace and whitelisted core tables. */
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]>;

  /** Run a restricted INSERT, UPDATE, or DELETE against the plugin namespace. */
  execute(sql: string, params?: unknown[]): Promise<{ rowCount: number }>;
}

/**
 * `ctx.http` — make outbound HTTP requests.
 *
 * Requires `http.outbound` capability.
 *
 * @see PLUGIN_SPEC.md §15.1 — Capabilities: Runtime/Integration
 */
export interface PluginHttpClient {
  /**
   * Perform an outbound HTTP request.
   *
   * The host enforces `http.outbound` capability before allowing the call.
   * Plugins may also use standard Node `fetch` or other libraries directly —
   * this client exists for host-managed tracing and audit logging.
   *
   * @param url - Target URL
   * @param init - Standard `RequestInit` options
   * @returns The response
   */
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

/** JSON value accepted across the host/worker RPC boundary. */
export type PluginJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly PluginJsonValue[]
  | { readonly [key: string]: PluginJsonValue };

/**
 * Snapshot-safe identity for one canonical Paperclip task Session.
 * Mutable head-derived metadata is deliberately excluded because it cannot be
 * represented truthfully at an older `snapshotHighWaterSeq`.
 */
export interface PluginCanonicalSessionIdentity {
  readonly companyId: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly parentSessionId: string | null;
  readonly projectId: string;
  readonly createdAt: string;
}

/** Physical row attribution retained beside a canonical Session message. */
export interface PluginCanonicalSessionMessageRow {
  readonly id: string;
  readonly companyId: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly seq: number;
  readonly modelStateSeq: number;
  readonly type: string;
  readonly runId: string | null;
  readonly ownershipEpoch: number | null;
  readonly agentId: string | null;
  readonly adapterConfigRevisionId: string | null;
  readonly timeCreated: string;
  readonly timeUpdated: string;
}

/** Canonical JSON encoding plus exact persisted attribution for one message. */
export interface PluginCanonicalSessionMessage {
  readonly row: PluginCanonicalSessionMessageRow;
  readonly message: PluginJsonValue;
}

/** Physical row attribution retained beside a canonical durable Session event. */
export interface PluginCanonicalSessionEventRow {
  readonly id: string;
  readonly companyId: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly seq: number;
  readonly versionedType: string;
  readonly runId: string | null;
  readonly ownershipEpoch: number | null;
  readonly agentId: string | null;
  readonly adapterConfigRevisionId: string | null;
  readonly sourceKind: string | null;
  readonly sourceId: string | null;
  readonly immutableSourceKey: string | null;
  readonly sourceRecordId: string | null;
  readonly sourceIdentityDigest: string | null;
  readonly createdAt: string;
}

/** Canonical JSON encoding plus exact persisted attribution for one event. */
export interface PluginCanonicalSessionEvent {
  readonly row: PluginCanonicalSessionEventRow;
  readonly event: PluginJsonValue;
}

export interface PluginCanonicalSessionReadInput {
  readonly companyId: string;
  readonly sessionId: string;
  /** Inclusive non-negative safe-integer global Session sequence bound. */
  readonly snapshotHighWaterSeq: number;
  readonly messages?: {
    /**
     * Exclusive message-creation sequence bound. Pages order by `(seq, id)`.
     * Mutually exclusive with `changedAfterSeq`; defaults to `-1` when neither
     * bound is supplied.
     */
    readonly afterSeq?: number;
    /**
     * Exclusive model-visible update sequence bound. Pages order by
     * `(modelStateSeq, id)` and can re-emit a message whose state changed after
     * an earlier checkpoint. Mutually exclusive with `afterSeq`.
     */
    readonly changedAfterSeq?: number;
    readonly cursor?: string;
    readonly limit?: number;
  };
  readonly events?: {
    /** Exclusive safe-integer lower sequence bound, at least `-1`. Defaults to `-1`. */
    readonly afterSeq?: number;
    readonly cursor?: string;
    readonly limit?: number;
  };
}

export interface PluginCanonicalSessionReadResult {
  readonly session: PluginCanonicalSessionIdentity;
  readonly snapshotHighWaterSeq: number;
  readonly messages: PluginRunPage<PluginCanonicalSessionMessage>;
  readonly events: PluginRunPage<PluginCanonicalSessionEvent>;
}

/**
 * Canonical, redacted runtime records exposed to privileged infrastructure
 * plugins. Every request is company-scoped by the host invocation boundary.
 */
export interface PluginRuntimeRecordsClient {
  readSession(
    input: PluginCanonicalSessionReadInput,
  ): Promise<PluginCanonicalSessionReadResult>;
  readRun(input: {
    companyId: string;
    runId: string;
    cursor?: string;
  }): Promise<ProviderSafeRunTrace>;
  readTaskComments(input: {
    companyId: string;
    taskId: string;
    cursor?: string;
    limit?: number;
  }): Promise<PluginRunPage<PluginRunTaskCommentProjection>>;
}

export interface PluginRuntimeClient {
  readonly records: PluginRuntimeRecordsClient;
}

/**
 * Input for writing a plugin activity log entry.
 *
 * @see PLUGIN_SPEC.md §21.4 — Activity Log Changes
 */
export interface PluginActivityLogEntry {
  /** UUID of the company this activity belongs to. Required for auditing. */
  companyId: string;
  /** Human-readable description stored in the canonical activity details. */
  message: string;
  /** Optional entity type this activity relates to. */
  entityType?: string;
  /** Optional entity ID this activity relates to. */
  entityId?: string;
  /** Optional additional metadata. */
  metadata?: Record<string, unknown>;
}

/**
 * `ctx.activity` — write plugin-originated activity log entries.
 *
 * Requires `activity.log.write` capability.
 *
 * @see PLUGIN_SPEC.md §21.4 — Activity Log Changes
 */
export interface PluginActivityClient {
  /**
   * Write an activity log entry attributed to this plugin.
   *
   * The host writes the entry with `actor_type = plugin` and
   * `actor_id = <pluginId>`.
   *
   * @param entry - The activity log entry to write
   */
  log(entry: PluginActivityLogEntry): Promise<void>;
}

/**
 * `ctx.state` — read and write plugin-scoped key-value state.
 *
 * Each plugin gets an isolated namespace: state written by plugin A can never
 * be read or overwritten by plugin B. Within a plugin, state is partitioned by
 * a five-part composite key: `(pluginId, scopeKind, scopeId, namespace, stateKey)`.
 *
 * **Scope kinds**
 *
 * | `scopeKind` | `scopeId` | Typical use |
 * |-------------|-----------|-------------|
 * | `"instance"` | omit | Global flags, last full-sync timestamps |
 * | `"company"` | company UUID | Per-company sync cursors |
 * | `"project"` | project UUID | Per-project settings, branch tracking |
 * | `"agent"` | agent UUID | Per-agent checkpoints |
 * | `"task"` | task UUID | Idempotency keys, linked external IDs |
 * | `"goal"` | goal UUID | Per-goal progress |
 * | `"run"` | run UUID | Per-run checkpoints |
 *
 * **Namespaces**
 *
 * The optional `namespace` field (default: `"default"`) lets you group related
 * keys within a scope without risking collisions between different logical
 * subsystems inside the same plugin.
 *
 * @example
 * ```ts
 * // Instance-global flag
 * await ctx.state.set({ scopeKind: "instance", stateKey: "schema-version" }, 2);
 *
 * // Idempotency key per task
 * const synced = await ctx.state.get({ scopeKind: "task", scopeId: taskId, stateKey: "synced-to-linear" });
 * if (!synced) {
 *   await syncToLinear(taskId);
 *   await ctx.state.set({ scopeKind: "task", scopeId: taskId, stateKey: "synced-to-linear" }, true);
 * }
 *
 * // Per-project, namespaced for two integrations
 * await ctx.state.set({ scopeKind: "project", scopeId: projectId, namespace: "linear", stateKey: "cursor" }, cursor);
 * await ctx.state.set({ scopeKind: "project", scopeId: projectId, namespace: "github", stateKey: "last-event" }, eventId);
 * ```
 *
 * `plugin.state.read` capability required for `get()`.
 * `plugin.state.write` capability required for `set()` and `delete()`.
 *
 * @see PLUGIN_SPEC.md §21.3 `plugin_state`
 */
export interface PluginStateClient {
  /**
   * Read a state value.
   *
   * Returns the stored JSON value as-is, or `null` if no entry has been set
   * for this scope+key combination. Falsy values (`false`, `0`, `""`) are
   * returned correctly and are not confused with "not set".
   *
   * @param input - Scope key identifying the entry to read
   * @returns The stored JSON value, or `null` if no value has been set
   */
  get(input: ScopeKey): Promise<unknown>;

  /**
   * Write a state value. Creates the row if it does not exist; replaces it
   * atomically (upsert) if it does. Safe to call concurrently.
   *
   * Any JSON-serializable value is accepted: objects, arrays, strings,
   * numbers, booleans, and `null`.
   *
   * @param input - Scope key identifying the entry to write
   * @param value - JSON-serializable value to store
   */
  set(input: ScopeKey, value: unknown): Promise<void>;

  /**
   * Delete a state value. No-ops silently if the entry does not exist
   * (idempotent by design — safe to call without prior `get()`).
   *
   * @param input - Scope key identifying the entry to delete
   */
  delete(input: ScopeKey): Promise<void>;
}

/**
 * `ctx.entities` — create and query plugin-owned entity records.
 *
 * @see PLUGIN_SPEC.md §21.3 `plugin_entities`
 */
export interface PluginEntitiesClient {
  /**
   * Create or update the exact `(entityType, scope, externalId | null)`
   * plugin entity record.
   *
   * @param input - Entity data to upsert
   */
  upsert(input: PluginEntityUpsert): Promise<PluginEntityRecord>;

  /**
   * Query plugin entity records.
   *
   * @param query - Filter criteria
   * @returns Matching entity records
   */
  list(query: PluginEntityQuery): Promise<PluginEntityRecord[]>;
}

/**
 * Canonical offset window accepted by bounded plugin host list APIs.
 *
 * Both values are exact JSON numbers. The host rejects strings, fractional
 * values, non-finite values, limits outside `1..100`, and offsets outside the
 * non-negative safe-integer range.
 */
export interface PluginListWindow {
  limit?: number;
  offset?: number;
}

/**
 * `ctx.projects` — read project metadata.
 *
 * Requires `projects.read` capability.
 */
export interface PluginProjectsClient {
  /**
   * List projects visible to the plugin.
   *
   * Requires the `projects.read` capability.
   */
  list(input: { companyId: string } & PluginListWindow): Promise<Project[]>;

  /**
   * Get a single project by ID.
   *
   * Requires the `projects.read` capability.
   */
  get(projectId: string, companyId: string): Promise<Project | null>;

  /** Resolve and reconcile manifest-declared plugin-managed projects by stable key. Requires `projects.managed`. */
  managed: {
    get(
      projectKey: string,
      companyId: string,
    ): Promise<PluginManagedProjectResolution>;
    reconcile(
      projectKey: string,
      companyId: string,
    ): Promise<PluginManagedProjectResolution>;
    reset(
      projectKey: string,
      companyId: string,
    ): Promise<PluginManagedProjectResolution>;
  };
}

/**
 * `ctx.routines` — resolve and reconcile plugin-managed Paperclip routines.
 *
 * Requires `routines.managed` capability.
 */
export interface PluginRoutinesClient {
  managed: {
    get(
      routineKey: string,
      companyId: string,
    ): Promise<PluginManagedRoutineResolution>;
    reconcile(
      routineKey: string,
      companyId: string,
      overrides?: {
        assigneeAgentId?: string | null;
        projectId?: string | null;
      },
    ): Promise<PluginManagedRoutineResolution>;
    reset(
      routineKey: string,
      companyId: string,
      overrides?: {
        assigneeAgentId?: string | null;
        projectId?: string | null;
      },
    ): Promise<PluginManagedRoutineResolution>;
    update(
      routineKey: string,
      companyId: string,
      patch: { status?: RoutineStatus },
    ): Promise<Routine>;
    run(
      routineKey: string,
      companyId: string,
      overrides?: {
        assigneeAgentId?: string | null;
        projectId?: string | null;
      },
    ): Promise<RoutineRun>;
  };
}

/**
 * `ctx.data` — register `getData` handlers that back `usePluginData()` in the
 * plugin's frontend components.
 *
 * The plugin's UI calls `usePluginData(key, params)` which routes through the
 * host bridge to the worker's registered handler.
 *
 * @see PLUGIN_SPEC.md §13.8 — `getData`
 */
export interface PluginDataClient {
  /**
   * Register a handler for a plugin-defined data key.
   * Registering the same key more than once is an error.
   *
   * @param key - Stable string identifier for this data type (e.g. `"sync-health"`)
   * @param handler - Async function that receives request params and returns JSON-serializable data
   */
  register(
    key: string,
    handler: (params: Record<string, unknown>) => Promise<unknown>,
  ): void;
}

/**
 * `ctx.actions` — register `performAction` handlers that back
 * `usePluginAction()` in the plugin's frontend components.
 *
 * @see PLUGIN_SPEC.md §13.9 — `performAction`
 */
export interface PluginActionsClient {
  /**
   * Register a handler for a plugin-defined action key.
   * Registering the same key more than once is an error.
   *
   * @param key - Stable string identifier for this action (e.g. `"resync"`)
   * @param handler - Async function that receives action params plus immutable host actor context and returns a result
   */
  register(
    key: string,
    handler: (
      params: Record<string, unknown>,
      context: PluginPerformActionContext,
    ) => Promise<unknown>,
  ): void;
}

/**
 * `ctx.tools` — register handlers for agent tools declared in the manifest.
 *
 * Requires `agent.tools.register` capability.
 *
 * The provider-visible name is the MCP-safe `pluginId__toolName`; `__` is
 * reserved and the combined name is limited to 128 characters.
 *
 * @see PLUGIN_SPEC.md §11 — Agent Tools
 */
export interface PluginToolsClient {
  /**
   * Register a handler for a plugin-contributed agent tool.
   *
   * Tool metadata and the parameter schema come exclusively from the matching
   * `manifest.tools` declaration.
   *
   * @param name - Tool name matching the manifest declaration (without namespace prefix)
   * @param handler - Async handler that executes the tool
   */
  register(
    name: string,
    handler: (
      params: unknown,
      runContext: PluginToolRunContext,
    ) => Promise<ToolResult>,
  ): void;
}

/**
 * `ctx.logger` — structured logging from the plugin worker.
 *
 * Log output is captured by the host, stored, and surfaced in the plugin
 * health dashboard.
 *
 * @see PLUGIN_SPEC.md §26.1 — Logging
 */
export interface PluginLogger {
  /** Log an informational message. */
  info(message: string, meta?: Record<string, unknown>): Promise<void>;
  /** Log a warning. */
  warn(message: string, meta?: Record<string, unknown>): Promise<void>;
  /** Log an error. */
  error(message: string, meta?: Record<string, unknown>): Promise<void>;
  /** Log a debug message (may be suppressed in production). */
  debug(message: string, meta?: Record<string, unknown>): Promise<void>;
}

// ---------------------------------------------------------------------------
// Plugin metrics
// ---------------------------------------------------------------------------

/**
 * `ctx.metrics` — write plugin-contributed metrics.
 *
 * Requires `metrics.write` capability.
 *
 * @see PLUGIN_SPEC.md §15.1 — Capabilities: Data Write
 */
export interface PluginMetricsClient {
  /**
   * Write a numeric metric data point.
   *
   * @param name - Metric name (plugin-namespaced by the host)
   * @param value - Numeric value
   * @param tags - Optional key-value tags for filtering
   */
  write(
    name: string,
    value: number,
    tags?: Record<string, string>,
  ): Promise<void>;
}

/**
 * `ctx.telemetry` — emit plugin-scoped telemetry to the host's external
 * telemetry pipeline.
 *
 * Requires `telemetry.track` capability.
 */
export interface PluginTelemetryClient {
  /**
   * Track a plugin telemetry event.
   *
   * The host prefixes the final event name as `plugin.<pluginKey>.<eventName>`
   * before forwarding it to the shared telemetry client.
   *
   * @param eventName - Bare plugin event slug (for example `"sync_completed"`)
   * @param dimensions - Optional structured dimensions
   */
  track(
    eventName: string,
    dimensions?: Record<string, string | number | boolean>,
  ): Promise<void>;
}

/**
 * `ctx.companies` — read company metadata.
 *
 * Requires `companies.read` capability.
 */
export interface PluginCompaniesClient {
  /**
   * List companies visible to this plugin.
   */
  list(input?: PluginListWindow): Promise<Company[]>;

  /**
   * Get one company by ID.
   */
  get(companyId: string): Promise<Company | null>;
}

/** Complete effective context-access matrix for one active agent run. */
export type PluginContextAccess = Readonly<
  Record<AgentContextGrantKey, boolean>
>;

export interface PluginTaskCreateInput {
  companyId: string;
  request: string;
  ownerAgentId: string;
  callbackKey: string;
  callbackVersion: string;
  title?: string;
  projectId?: string;
  goalId?: string;
  parentId?: string;
  priority?: Task["priority"];
}

export type PluginTaskUpdateInput =
  | {
      kind: "message";
      message: string;
    }
  | {
      kind: "reassign";
      ownerAgentId: string;
    };

export interface PluginTaskWithdrawalResult {
  operationId: string;
  task: Task;
  retried: boolean;
}

export interface PluginCreatorCallbackRegistration {
  key: string;
  version: string;
}

export interface PluginCreatorCallbackDelivery {
  deliveryId: string;
  taskId: string;
  companyId: string;
  ownershipEpoch: number;
  updateId: string;
  commentId: string;
  message: string;
  /** Null for an owner message that intentionally preserves lifecycle state. */
  status: "open" | "blocked" | "done" | "cancelled" | null;
  disposition: {
    message: string;
    structuredResult?: unknown;
  } | null;
  committedSequence: number;
}

export interface PluginCreatorCallbackAcknowledgement {
  deliveryId: string;
  accepted: true;
}

export type PluginCreatorCallbackHandler = (
  delivery: PluginCreatorCallbackDelivery,
) =>
  | Promise<PluginCreatorCallbackAcknowledgement>
  | PluginCreatorCallbackAcknowledgement;

/**
 * `ctx.tasks` is a capability-gated control-plane surface. It is not an
 * agent runtime/context API and it cannot wake an agent except by creating or
 * reassigning an ordinary task through the canonical task runtime.
 */
export interface PluginTasksClient {
  list(input: {
    companyId: string;
    projectId?: string;
    ownerAgentId?: string;
    status?: "open" | "blocked" | "done" | "cancelled";
    limit?: number;
    offset?: number;
  }): Promise<Task[]>;
  get(taskId: string, companyId: string): Promise<Task | null>;
  registerCreatorCallback(
    registration: PluginCreatorCallbackRegistration,
    handler: PluginCreatorCallbackHandler,
  ): Promise<void>;
  create(input: PluginTaskCreateInput): Promise<Task>;
  update(
    taskId: string,
    input: PluginTaskUpdateInput,
    companyId: string,
  ): Promise<Task>;
  withdraw(
    taskId: string,
    message: string,
    companyId: string,
  ): Promise<PluginTaskWithdrawalResult>;
}

/**
 * `ctx.agents` — read and manage agents.
 *
 * Requires `agents.read` for reads and `agents.pause` / `agents.resume` for
 * lifecycle operations. Provider invocation is task-only.
 */
export interface PluginAgentsClient {
  list(
    input: {
      companyId: string;
      status?: Agent["status"];
    } & PluginListWindow,
  ): Promise<Agent[]>;
  get(agentId: string, companyId: string): Promise<Agent | null>;
  /** Pause an agent. Throws if agent is terminated or not found. Requires `agents.pause`. */
  pause(agentId: string, companyId: string): Promise<Agent>;
  /** Resume a paused agent (sets status to idle). Throws if terminated, pending_approval, or not found. Requires `agents.resume`. */
  resume(agentId: string, companyId: string): Promise<Agent>;
  /** Resolve and reconcile manifest-declared plugin-managed agents by stable key. Requires `agents.managed`. */
  managed: {
    get(
      agentKey: string,
      companyId: string,
    ): Promise<PluginManagedAgentResolution>;
    reconcile(
      agentKey: string,
      companyId: string,
    ): Promise<PluginManagedAgentResolution>;
    reset(
      agentKey: string,
      companyId: string,
    ): Promise<PluginManagedAgentResolution>;
  };
}

/**
 * `ctx.goals` — read and mutate goals.
 *
 * Requires:
 * - `goals.read` for read operations
 * - `goals.create` for create
 * - `goals.update` for update
 */
export interface PluginGoalsClient {
  list(
    input: {
      companyId: string;
      level?: Goal["level"];
      status?: Goal["status"];
    } & PluginListWindow,
  ): Promise<Goal[]>;
  get(goalId: string, companyId: string): Promise<Goal | null>;
  create(input: {
    companyId: string;
    title: string;
    description?: string;
    level?: Goal["level"];
    status?: Goal["status"];
    parentId?: string;
    ownerAgentId?: string;
  }): Promise<Goal>;
  update(
    goalId: string,
    patch: Partial<
      Pick<
        Goal,
        | "title"
        | "description"
        | "level"
        | "status"
        | "parentId"
        | "ownerAgentId"
      >
    >,
    companyId: string,
  ): Promise<Goal>;
}

// ---------------------------------------------------------------------------
// Access and Authorization
// ---------------------------------------------------------------------------

export interface PluginAccessMember {
  id: string;
  companyId: string;
  principalType: PrincipalType;
  principalId: string;
  status: MembershipStatus;
  membershipRole: UserCompanyMembershipRole | "member";
  grants: PrincipalPermissionGrant[];
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface PluginAccessInvite {
  id: string;
  companyId: string;
  inviteType: "company_join";
  userRole: UserCompanyMembershipRole;
  expiresAt: Date | string;
  source: Exclude<InviteSource, "bootstrap_admin_cli">;
  invitedByUserId: string | null;
  revokedAt: Date | string | null;
  acceptedAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  state: "active" | "revoked" | "accepted" | "expired";
}

export interface PluginAccessMembersClient {
  list(input: {
    companyId: string;
    includeArchived?: boolean;
  }): Promise<PluginAccessMember[]>;
  get(memberId: string, companyId: string): Promise<PluginAccessMember | null>;
  update(
    memberId: string,
    patch: {
      membershipRole?: UserCompanyMembershipRole;
      status?: Extract<MembershipStatus, "pending" | "active" | "suspended">;
    },
    companyId: string,
  ): Promise<PluginAccessMember>;
}

export interface PluginAccessInvitesClient {
  list(
    input: {
      companyId: string;
      state?: PluginAccessInvite["state"];
    } & PluginListWindow,
  ): Promise<{ invites: PluginAccessInvite[]; nextOffset: number | null }>;
  create(input: {
    companyId: string;
    userRole?: UserCompanyMembershipRole | null;
  }): Promise<PluginAccessInvite & { token: string }>;
  revoke(inviteId: string, companyId: string): Promise<PluginAccessInvite>;
}

export interface PluginAccessClient {
  /** Read and update company memberships. Requires `access.members.*`. */
  members: PluginAccessMembersClient;
  /** Read, create, and revoke company invites. Requires `access.invites.*`. */
  invites: PluginAccessInvitesClient;
}

export interface PluginAuthorizationPolicySummary {
  companyId: string;
  permissionsMode: "simple";
  memberCount: number;
  activeMemberCount: number;
  grantCount: number;
  advancedPolicyAvailable: false;
}

export interface PluginAuthorizationPolicyRecord {
  resourceType: "company" | "agent" | "task";
  resourceId: string;
  companyId: string;
  policy: Record<string, unknown> | null;
  updatedAt: Date | string | null;
}

export interface PluginAssignmentPreviewInput {
  companyId: string;
  subject:
    { type: "user"; userId: string } | { type: "agent"; agentId: string };
  targetAgentId: string;
}

export interface PluginAuthorizationDecisionResult {
  allowed: boolean;
  action: string;
  explanation: string;
  reason: string;
  grant?: {
    principalType: PrincipalType;
    principalId: string;
    permissionKey: PermissionKey;
    scope: Record<string, unknown> | null;
  };
}

export interface PluginAuthorizationAuditEntry {
  id: string;
  companyId: string;
  actorType: string;
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  details: Record<string, unknown> | null;
  createdAt: Date | string;
}

/** Exact authorization outcome accepted by audit search. */
export type PluginAuthorizationAuditDecision = "allow" | "deny";

export interface PluginAuthorizationClient {
  grants: {
    list(input: {
      companyId: string;
      principalType?: PrincipalType;
      principalId?: string;
    }): Promise<PrincipalPermissionGrant[]>;
    set(input: {
      companyId: string;
      principalType: PrincipalType;
      principalId: string;
      grants: Array<{
        permissionKey: PermissionKey;
        scope?: Record<string, unknown> | null;
      }>;
      grantedByUserId?: string | null;
    }): Promise<PrincipalPermissionGrant[]>;
  };
  policies: {
    summary(companyId: string): Promise<PluginAuthorizationPolicySummary>;
    get(input: {
      companyId: string;
      resourceType: PluginAuthorizationPolicyRecord["resourceType"];
      resourceId: string;
    }): Promise<PluginAuthorizationPolicyRecord | null>;
    update(input: {
      companyId: string;
      resourceType: "task";
      resourceId: string;
      policy: Record<string, unknown> | null;
    }): Promise<PluginAuthorizationPolicyRecord>;
    previewAssignment(
      input: PluginAssignmentPreviewInput,
    ): Promise<PluginAuthorizationDecisionResult>;
  };
  audit: {
    search(
      input: {
        companyId: string;
        action?: string;
        actorType?: string;
        actorId?: string;
        entityType?: string;
        entityId?: string;
        decision?: PluginAuthorizationAuditDecision;
      } & PluginListWindow,
    ): Promise<PluginAuthorizationAuditEntry[]>;
  };
}

// ---------------------------------------------------------------------------
// Full plugin context
// ---------------------------------------------------------------------------

/**
 * The full plugin context object passed to the plugin worker at initialisation.
 *
 * This is the central interface plugin authors use to interact with the host.
 * Every client is capability-gated: calling a client method without the
 * required capability declared in the manifest results in a runtime error.
 *
 * @example
 * ```ts
 * import { definePlugin } from "@paperclipai/plugin-sdk";
 *
 * export default definePlugin({
 *   async setup(ctx) {
 *     ctx.events.on("task.board.comment.created", async (event) => {
 *       await ctx.logger.info("Task created", { taskId: event.entityId });
 *     });
 *
 *     ctx.data.register("sync-health", async ({ companyId }) => {
 *       const state = await ctx.state.get({ scopeKind: "company", scopeId: String(companyId), stateKey: "last-sync" });
 *       return { lastSync: state };
 *     });
 *   },
 * });
 * ```
 *
 * @see PLUGIN_SPEC.md §14 — SDK Surface
 */
export interface PluginContext {
  /** The plugin's manifest as validated at install time. */
  manifest: PaperclipPluginManifestV1;

  /** Read resolved operator configuration. */
  config: PluginConfigClient;

  /** Configure and safely access trusted company-scoped local folders. */
  localFolders: PluginLocalFoldersClient;

  /** Subscribe to and emit domain events. Requires `events.subscribe` / `events.emit`. */
  events: PluginEventsClient;

  /** Register handlers for scheduled jobs. Requires `jobs.schedule`. */
  jobs: PluginJobsClient;

  /** Restricted plugin-owned database namespace. Requires database namespace capabilities. */
  db: PluginDatabaseClient;

  /** Make outbound HTTP requests. Requires `http.outbound`. */
  http: PluginHttpClient;

  /** Read canonical provider-safe execution records. Requires `runtime.records.read`. */
  runtime: PluginRuntimeClient;

  /** Write activity log entries. Requires `activity.log.write`. */
  activity: PluginActivityClient;

  /** Read and write scoped plugin state. Requires `plugin.state.read` / `plugin.state.write`. */
  state: PluginStateClient;

  /** Create and query plugin-owned entity records. */
  entities: PluginEntitiesClient;

  /** Read project metadata. Requires `projects.read`. */
  projects: PluginProjectsClient;

  /** Resolve and reconcile plugin-managed routines. Requires `routines.managed`. */
  routines: PluginRoutinesClient;

  /** Read company metadata. Requires `companies.read`. */
  companies: PluginCompaniesClient;

  /** Use the installation-bound task control plane. */
  tasks: PluginTasksClient;

  /** Read and manage agents. Provider invocation is task-only. */
  agents: PluginAgentsClient;

  /** Read and mutate goals. Requires `goals.read` for reads; `goals.create` / `goals.update` for write ops. */
  goals: PluginGoalsClient;

  /** Read and manage access memberships and invites. Requires `access.*` capabilities. */
  access: PluginAccessClient;

  /** Read and manage authorization grants, policy summaries, previews, and audit entries. Requires `authorization.*` capabilities. */
  authorization: PluginAuthorizationClient;

  /** Register getData handlers for the plugin's UI components. */
  data: PluginDataClient;

  /** Register performAction handlers for the plugin's UI components. */
  actions: PluginActionsClient;

  /** Register agent tool handlers. Requires `agent.tools.register`. */
  tools: PluginToolsClient;

  /** Write plugin metrics. Requires `metrics.write`. */
  metrics: PluginMetricsClient;

  /** Emit plugin-scoped external telemetry. Requires `telemetry.track`. */
  telemetry: PluginTelemetryClient;

  /** Structured logger. Output is captured and surfaced in the plugin health dashboard. */
  logger: PluginLogger;
}
