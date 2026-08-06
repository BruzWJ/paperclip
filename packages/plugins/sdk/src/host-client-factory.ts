/**
 * Host-side client factory — creates capability-gated handler maps for
 * servicing worker→host JSON-RPC calls.
 *
 * When a plugin worker calls `ctx.state.get(...)` inside its process, the
 * SDK serializes the call as a JSON-RPC request over stdio. On the host side,
 * the `PluginWorkerManager` receives the request and dispatches it to the
 * handler registered for that method. This module provides a factory that
 * creates those handlers for all `WorkerToHostMethods`, with automatic
 * capability enforcement.
 *
 * ## Design
 *
 * 1. **Capability gating**: Each handler checks the plugin's declared
 *    capabilities before executing. If the plugin lacks a required capability,
 *    the handler throws a `CapabilityDeniedError` (which the worker manager
 *    translates into a JSON-RPC error response with code
 *    `CAPABILITY_DENIED`).
 *
 * 2. **Service adapters**: The caller provides a `HostServices` object with
 *    concrete implementations of each platform service. The factory wires
 *    each handler to the appropriate service method.
 *
 * 3. **Type safety**: The returned `HostClientHandlers` map is the complete
 *    worker→host surface consumed by the host transport.
 *
 * @example
 * ```ts
 * const handlers = createHostClientHandlers({
 *   pluginId: "acme.linear",
 *   capabilities: manifest.capabilities,
 *   services: {
 *     config:    { get: () => registry.getConfig(pluginId) },
 *     state:     { get: ..., set: ..., delete: ... },
 *     entities:  { upsert: ..., list: ... },
 *     // ... all services
 *   },
 * });
 *
 * await workerManager.startWorker("acme.linear", {
 *   // ...
 *   hostHandlers: handlers,
 * });
 * ```
 *
 * @see PLUGIN_SPEC.md §13 — Host-Worker Protocol
 * @see PLUGIN_SPEC.md §15 — Capability Model
 */

import type { PluginCapability } from "@paperclipai/shared";
import type { WorkerHostCallContext, WorkerToHostMethods, WorkerToHostMethodName } from "./protocol.js";
import { PLUGIN_RPC_ERROR_CODES } from "./protocol.js";

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/**
 * Thrown when a plugin calls a host method it does not have the capability for.
 *
 * The `code` field is set to `PLUGIN_RPC_ERROR_CODES.CAPABILITY_DENIED` so
 * the worker manager can propagate it as the correct JSON-RPC error code.
 */
export class CapabilityDeniedError extends Error {
  override readonly name = "CapabilityDeniedError";
  readonly code = PLUGIN_RPC_ERROR_CODES.CAPABILITY_DENIED;

  constructor(pluginId: string, method: string, capability: PluginCapability) {
    super(
      `Plugin "${pluginId}" is missing required capability "${capability}" for method "${method}"`,
    );
  }
}

/**
 * Thrown when a worker→host call asks for company-scoped data outside the
 * company authorized for the current top-level plugin invocation.
 */
export class InvocationScopeDeniedError extends Error {
  override readonly name = "InvocationScopeDeniedError";
  readonly code = PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED;

  constructor(pluginId: string, method: string, message: string) {
    super(`Plugin "${pluginId}" is not allowed to perform "${method}": ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Host service interfaces
// ---------------------------------------------------------------------------

/**
 * Service adapters that the host must provide. Each property maps to a group
 * of `WorkerToHostMethods`. The factory wires JSON-RPC params to these
 * function signatures.
 *
 * All methods return promises to support async I/O (database, HTTP, etc.).
 */
export interface HostServices {
  /** Provides `config.get`. */
  config: {
    get(
      params: WorkerToHostMethods["config.get"][0],
      context?: WorkerHostCallContext,
    ): Promise<Record<string, unknown>>;
  };

  /** Provides trusted company-scoped local folder helpers. */
  localFolders: {
    configure(params: WorkerToHostMethods["localFolders.configure"][0]): Promise<WorkerToHostMethods["localFolders.configure"][1]>;
    status(params: WorkerToHostMethods["localFolders.status"][0]): Promise<WorkerToHostMethods["localFolders.status"][1]>;
    list(params: WorkerToHostMethods["localFolders.list"][0]): Promise<WorkerToHostMethods["localFolders.list"][1]>;
    readText(params: WorkerToHostMethods["localFolders.readText"][0]): Promise<WorkerToHostMethods["localFolders.readText"][1]>;
    writeTextAtomic(params: WorkerToHostMethods["localFolders.writeTextAtomic"][0]): Promise<WorkerToHostMethods["localFolders.writeTextAtomic"][1]>;
    deleteFile(params: WorkerToHostMethods["localFolders.deleteFile"][0]): Promise<WorkerToHostMethods["localFolders.deleteFile"][1]>;
  };

  /** Provides `state.get`, `state.set`, `state.delete`. */
  state: {
    get(params: WorkerToHostMethods["state.get"][0]): Promise<WorkerToHostMethods["state.get"][1]>;
    set(params: WorkerToHostMethods["state.set"][0]): Promise<void>;
    delete(params: WorkerToHostMethods["state.delete"][0]): Promise<void>;
  };

  /** Provides restricted plugin database namespace methods. */
  db: {
    query(params: WorkerToHostMethods["db.query"][0]): Promise<WorkerToHostMethods["db.query"][1]>;
    execute(params: WorkerToHostMethods["db.execute"][0]): Promise<WorkerToHostMethods["db.execute"][1]>;
  };

  /** Provides `entities.upsert`, `entities.list`. */
  entities: {
    upsert(params: WorkerToHostMethods["entities.upsert"][0]): Promise<WorkerToHostMethods["entities.upsert"][1]>;
    list(params: WorkerToHostMethods["entities.list"][0]): Promise<WorkerToHostMethods["entities.list"][1]>;
  };

  /** Provides `events.emit` and `events.subscribe`. */
  events: {
    emit(params: WorkerToHostMethods["events.emit"][0]): Promise<void>;
    subscribe(params: WorkerToHostMethods["events.subscribe"][0]): Promise<void>;
  };

  /** Provides `http.fetch`. */
  http: {
    fetch(params: WorkerToHostMethods["http.fetch"][0]): Promise<WorkerToHostMethods["http.fetch"][1]>;
  };

  /** Provides privileged, company-scoped canonical runtime records. */
  runtimeRecords: {
    readSession(params: WorkerToHostMethods["runtime.records.readSession"][0]): Promise<WorkerToHostMethods["runtime.records.readSession"][1]>;
    readRun(params: WorkerToHostMethods["runtime.records.readRun"][0]): Promise<WorkerToHostMethods["runtime.records.readRun"][1]>;
    readIssueComments(params: WorkerToHostMethods["runtime.records.readIssueComments"][0]): Promise<WorkerToHostMethods["runtime.records.readIssueComments"][1]>;
  };

  /** Provides `activity.log`. */
  activity: {
    log(params: {
      companyId: string;
      message: string;
      entityType?: string;
      entityId?: string;
      metadata?: Record<string, unknown>;
    }): Promise<void>;
  };

  /** Provides `metrics.write`. */
  metrics: {
    write(params: WorkerToHostMethods["metrics.write"][0]): Promise<void>;
  };

  /** Provides `telemetry.track`. */
  telemetry: {
    track(params: WorkerToHostMethods["telemetry.track"][0]): Promise<void>;
  };

  /** Provides `log`. */
  logger: {
    log(params: WorkerToHostMethods["log"][0]): Promise<void>;
  };

  /** Provides `companies.list`, `companies.get`. */
  companies: {
    list(params: WorkerToHostMethods["companies.list"][0]): Promise<WorkerToHostMethods["companies.list"][1]>;
    get(params: WorkerToHostMethods["companies.get"][0]): Promise<WorkerToHostMethods["companies.get"][1]>;
  };

  /** Provides project reads, workspace reads, and managed project operations. */
  projects: {
    list(params: WorkerToHostMethods["projects.list"][0]): Promise<WorkerToHostMethods["projects.list"][1]>;
    get(params: WorkerToHostMethods["projects.get"][0]): Promise<WorkerToHostMethods["projects.get"][1]>;
    listWorkspaces(params: WorkerToHostMethods["projects.listWorkspaces"][0]): Promise<WorkerToHostMethods["projects.listWorkspaces"][1]>;
    getPrimaryWorkspace(params: WorkerToHostMethods["projects.getPrimaryWorkspace"][0]): Promise<WorkerToHostMethods["projects.getPrimaryWorkspace"][1]>;
    getManaged(params: WorkerToHostMethods["projects.managed.get"][0]): Promise<WorkerToHostMethods["projects.managed.get"][1]>;
    reconcileManaged(params: WorkerToHostMethods["projects.managed.reconcile"][0]): Promise<WorkerToHostMethods["projects.managed.reconcile"][1]>;
    resetManaged(params: WorkerToHostMethods["projects.managed.reset"][0]): Promise<WorkerToHostMethods["projects.managed.reset"][1]>;
  };

  /** Provides `executionWorkspaces.get`. */
  executionWorkspaces: {
    get(params: WorkerToHostMethods["executionWorkspaces.get"][0]): Promise<WorkerToHostMethods["executionWorkspaces.get"][1]>;
  };

  /** Provides `routines.managed.*`. */
  routines: {
    managedGet(params: WorkerToHostMethods["routines.managed.get"][0]): Promise<WorkerToHostMethods["routines.managed.get"][1]>;
    managedReconcile(params: WorkerToHostMethods["routines.managed.reconcile"][0]): Promise<WorkerToHostMethods["routines.managed.reconcile"][1]>;
    managedReset(params: WorkerToHostMethods["routines.managed.reset"][0]): Promise<WorkerToHostMethods["routines.managed.reset"][1]>;
    managedUpdate(params: WorkerToHostMethods["routines.managed.update"][0]): Promise<WorkerToHostMethods["routines.managed.update"][1]>;
    managedRun(params: WorkerToHostMethods["routines.managed.run"][0]): Promise<WorkerToHostMethods["routines.managed.run"][1]>;
  };

  /** Provides `skills.managed.*`. */
  skills: {
    managedGet(params: WorkerToHostMethods["skills.managed.get"][0]): Promise<WorkerToHostMethods["skills.managed.get"][1]>;
    managedReconcile(params: WorkerToHostMethods["skills.managed.reconcile"][0]): Promise<WorkerToHostMethods["skills.managed.reconcile"][1]>;
    managedReset(params: WorkerToHostMethods["skills.managed.reset"][0]): Promise<WorkerToHostMethods["skills.managed.reset"][1]>;
  };

  /** Provides the installation-bound issue control plane. */
  issues: {
    list(params: WorkerToHostMethods["issues.list"][0]): Promise<WorkerToHostMethods["issues.list"][1]>;
    get(params: WorkerToHostMethods["issues.get"][0]): Promise<WorkerToHostMethods["issues.get"][1]>;
    registerCreatorCallback(params: WorkerToHostMethods["issues.creatorCallback.register"][0]): Promise<WorkerToHostMethods["issues.creatorCallback.register"][1]>;
    create(
      params: WorkerToHostMethods["issues.create"][0],
      operation: HostRpcOperationContext,
    ): Promise<WorkerToHostMethods["issues.create"][1]>;
    update(
      params: WorkerToHostMethods["issues.update"][0],
      operation: HostRpcOperationContext,
    ): Promise<WorkerToHostMethods["issues.update"][1]>;
    withdraw(
      params: WorkerToHostMethods["issues.withdraw"][0],
      operation: HostRpcOperationContext,
    ): Promise<WorkerToHostMethods["issues.withdraw"][1]>;
  };

  /** Provides run-scoped issue projections for direct plugin tools. */
  runIssues: {
    resolveContext(params: WorkerToHostMethods["run.context.resolve"][0]): Promise<WorkerToHostMethods["run.context.resolve"][1]>;
    issueReach(params: WorkerToHostMethods["run.context.issueReach"][0]): Promise<WorkerToHostMethods["run.context.issueReach"][1]>;
    listCompanyIssues(params: WorkerToHostMethods["run.issues.listCompanyIssues"][0]): Promise<WorkerToHostMethods["run.issues.listCompanyIssues"][1]>;
    listSubIssues(params: WorkerToHostMethods["run.issues.listSubIssues"][0]): Promise<WorkerToHostMethods["run.issues.listSubIssues"][1]>;
    readIssueComments(params: WorkerToHostMethods["run.issues.readIssueComments"][0]): Promise<WorkerToHostMethods["run.issues.readIssueComments"][1]>;
    readIssueAgentRun(params: WorkerToHostMethods["run.issues.readIssueAgentRun"][0]): Promise<WorkerToHostMethods["run.issues.readIssueAgentRun"][1]>;
  };

  /** Provides `agents.list`, `agents.get`, `agents.pause`, `agents.resume`. */
  agents: {
    list(params: WorkerToHostMethods["agents.list"][0]): Promise<WorkerToHostMethods["agents.list"][1]>;
    get(params: WorkerToHostMethods["agents.get"][0]): Promise<WorkerToHostMethods["agents.get"][1]>;
    pause(params: WorkerToHostMethods["agents.pause"][0]): Promise<WorkerToHostMethods["agents.pause"][1]>;
    resume(params: WorkerToHostMethods["agents.resume"][0]): Promise<WorkerToHostMethods["agents.resume"][1]>;
    managedGet(params: WorkerToHostMethods["agents.managed.get"][0]): Promise<WorkerToHostMethods["agents.managed.get"][1]>;
    managedReconcile(params: WorkerToHostMethods["agents.managed.reconcile"][0]): Promise<WorkerToHostMethods["agents.managed.reconcile"][1]>;
    managedReset(params: WorkerToHostMethods["agents.managed.reset"][0]): Promise<WorkerToHostMethods["agents.managed.reset"][1]>;
  };

  /** Provides `goals.list`, `goals.get`, `goals.create`, `goals.update`. */
  goals: {
    list(params: WorkerToHostMethods["goals.list"][0]): Promise<WorkerToHostMethods["goals.list"][1]>;
    get(params: WorkerToHostMethods["goals.get"][0]): Promise<WorkerToHostMethods["goals.get"][1]>;
    create(params: WorkerToHostMethods["goals.create"][0]): Promise<WorkerToHostMethods["goals.create"][1]>;
    update(params: WorkerToHostMethods["goals.update"][0]): Promise<WorkerToHostMethods["goals.update"][1]>;
  };

  /** Provides `access.members.*` and `access.invites.*`. */
  access: {
    listMembers(params: WorkerToHostMethods["access.members.list"][0]): Promise<WorkerToHostMethods["access.members.list"][1]>;
    getMember(params: WorkerToHostMethods["access.members.get"][0]): Promise<WorkerToHostMethods["access.members.get"][1]>;
    updateMember(params: WorkerToHostMethods["access.members.update"][0]): Promise<WorkerToHostMethods["access.members.update"][1]>;
    listInvites(params: WorkerToHostMethods["access.invites.list"][0]): Promise<WorkerToHostMethods["access.invites.list"][1]>;
    createInvite(params: WorkerToHostMethods["access.invites.create"][0]): Promise<WorkerToHostMethods["access.invites.create"][1]>;
    revokeInvite(params: WorkerToHostMethods["access.invites.revoke"][0]): Promise<WorkerToHostMethods["access.invites.revoke"][1]>;
  };

  /** Provides authorization grant, policy, preview, and audit helpers. */
  authorization: {
    listGrants(params: WorkerToHostMethods["authorization.grants.list"][0]): Promise<WorkerToHostMethods["authorization.grants.list"][1]>;
    setGrants(params: WorkerToHostMethods["authorization.grants.set"][0]): Promise<WorkerToHostMethods["authorization.grants.set"][1]>;
    policySummary(params: WorkerToHostMethods["authorization.policies.summary"][0]): Promise<WorkerToHostMethods["authorization.policies.summary"][1]>;
    getPolicy(params: WorkerToHostMethods["authorization.policies.get"][0]): Promise<WorkerToHostMethods["authorization.policies.get"][1]>;
    updatePolicy(params: WorkerToHostMethods["authorization.policies.update"][0]): Promise<WorkerToHostMethods["authorization.policies.update"][1]>;
    previewAssignment(params: WorkerToHostMethods["authorization.policies.previewAssignment"][0]): Promise<WorkerToHostMethods["authorization.policies.previewAssignment"][1]>;
    searchAudit(params: WorkerToHostMethods["authorization.audit.search"][0]): Promise<WorkerToHostMethods["authorization.audit.search"][1]>;
  };
}

export interface HostRpcOperationContext {
  readonly hostRpcOperationId: string;
}

// ---------------------------------------------------------------------------
// Factory input
// ---------------------------------------------------------------------------

/**
 * Options for `createHostClientHandlers`.
 */
export interface HostClientFactoryOptions {
  /** The plugin ID. Used for error messages and logging. */
  pluginId: string;

  /**
   * The capabilities declared by the plugin in its manifest. The factory
   * enforces these at runtime before delegating to the service adapter.
   */
  capabilities: readonly PluginCapability[];

  /**
   * Concrete implementations of host platform services. Each handler in the
   * returned map delegates to the corresponding service method.
   */
  services: HostServices;
}

// ---------------------------------------------------------------------------
// Handler map type
// ---------------------------------------------------------------------------

/**
 * A handler function for a specific worker→host method.
 */
type HostHandler<M extends WorkerToHostMethodName> = (
  params: WorkerToHostMethods[M][0],
  context?: WorkerHostCallContext,
) => Promise<WorkerToHostMethods[M][1]>;

/**
 * A complete map of all worker→host method handlers. The factory always
 * provides every method, including capability-denied handlers.
 */
export type HostClientHandlers = {
  [M in WorkerToHostMethodName]: HostHandler<M>;
};

// ---------------------------------------------------------------------------
// Capability → method mapping
// ---------------------------------------------------------------------------

/**
 * Maps each worker→host RPC method to the capability required to invoke it.
 * Methods without a capability requirement (e.g. `config.get`, `log`) are
 * mapped to `null`.
 *
 * @see PLUGIN_SPEC.md §15 — Capability Model
 */
const METHOD_CAPABILITY_MAP: Record<WorkerToHostMethodName, PluginCapability | null> = {
  // Config — always allowed
  "config.get": null,

  // Trusted local folders
  "localFolders.configure": "local.folders",
  "localFolders.status": "local.folders",
  "localFolders.list": "local.folders",
  "localFolders.readText": "local.folders",
  "localFolders.writeTextAtomic": "local.folders",
  "localFolders.deleteFile": "local.folders",

  // State
  "state.get": "plugin.state.read",
  "state.set": "plugin.state.write",
  "state.delete": "plugin.state.write",

  "db.query": "database.namespace.read",
  "db.execute": "database.namespace.write",

  // Entities — no specific capability required (plugin-scoped by design)
  "entities.upsert": null,
  "entities.list": null,

  // Events
  "events.emit": "events.emit",
  "events.subscribe": "events.subscribe",

  // HTTP
  "http.fetch": "http.outbound",

  // Privileged runtime records
  "runtime.records.readSession": "runtime.records.read",
  "runtime.records.readRun": "runtime.records.read",
  "runtime.records.readIssueComments": "runtime.records.read",

  // Activity
  "activity.log": "activity.log.write",

  // Metrics
  "metrics.write": "metrics.write",

  // Telemetry
  "telemetry.track": "telemetry.track",

  // Logger — always allowed
  "log": null,

  // Companies
  "companies.list": "companies.read",
  "companies.get": "companies.read",

  // Projects
  "projects.list": "projects.read",
  "projects.get": "projects.read",
  "projects.listWorkspaces": "project.workspaces.read",
  "projects.getPrimaryWorkspace": "project.workspaces.read",
  "executionWorkspaces.get": "execution.workspaces.read",
  "projects.managed.get": "projects.managed",
  "projects.managed.reconcile": "projects.managed",
    "projects.managed.reset": "projects.managed",
    "routines.managed.get": "routines.managed",
    "routines.managed.reconcile": "routines.managed",
    "routines.managed.reset": "routines.managed",
    "routines.managed.update": "routines.managed",
    "routines.managed.run": "routines.managed",
    "skills.managed.get": "skills.managed",
    "skills.managed.reconcile": "skills.managed",
    "skills.managed.reset": "skills.managed",

  // Issues
  "issues.list": "issues.read",
  "issues.get": "issues.read",
  "issues.creatorCallback.register": "issues.create",
  "issues.create": "issues.create",
  "issues.update": "issues.update",
  "issues.withdraw": "issues.withdraw",
  "run.context.resolve": "runtime.context.read",
  "run.context.issueReach": "runtime.context.read",
  "run.issues.listCompanyIssues": "issues.read",
  "run.issues.listSubIssues": "issues.read",
  "run.issues.readIssueComments": "issues.read",
  "run.issues.readIssueAgentRun": "issues.read",

  // Agents
  "agents.list": "agents.read",
  "agents.get": "agents.read",
  "agents.pause": "agents.pause",
  "agents.resume": "agents.resume",
  "agents.managed.get": "agents.managed",
  "agents.managed.reconcile": "agents.managed",
  "agents.managed.reset": "agents.managed",

  // Goals
  "goals.list": "goals.read",
  "goals.get": "goals.read",
  "goals.create": "goals.create",
  "goals.update": "goals.update",

  // Access
  "access.members.list": "access.members.read",
  "access.members.get": "access.members.read",
  "access.members.update": "access.members.write",
  "access.invites.list": "access.invites.read",
  "access.invites.create": "access.invites.write",
  "access.invites.revoke": "access.invites.write",

  // Authorization
  "authorization.grants.list": "authorization.grants.read",
  "authorization.grants.set": "authorization.grants.write",
  "authorization.policies.summary": "authorization.policies.read",
  "authorization.policies.get": "authorization.policies.read",
  "authorization.policies.update": "authorization.policies.write",
  "authorization.policies.previewAssignment": "authorization.policies.read",
  "authorization.audit.search": "authorization.audit.read",
};

const INSTALLATION_ISSUE_CONTROL_PLANE_METHODS: ReadonlySet<WorkerToHostMethodName> =
  new Set([
    "issues.list",
    "issues.get",
    "issues.creatorCallback.register",
    "issues.create",
    "issues.update",
    "issues.withdraw",
  ]);

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a complete handler map for all worker→host JSON-RPC methods.
 *
 * Each handler:
 * 1. Checks the plugin's declared capabilities against the required capability
 *    for the method (if any).
 * 2. Delegates to the corresponding service adapter method.
 * 3. Returns the service result, which is serialized as the JSON-RPC response
 *    by the worker manager.
 *
 * If a capability check fails, the handler throws a `CapabilityDeniedError`
 * with code `CAPABILITY_DENIED`. The worker manager catches this and sends a
 * JSON-RPC error response to the worker, which surfaces as a `JsonRpcCallError`
 * in the plugin's SDK client.
 *
 * @param options - Plugin ID, capabilities, and service adapters
 * @returns A handler map suitable for `WorkerStartOptions.hostHandlers`
 */
export function createHostClientHandlers(
  options: HostClientFactoryOptions,
): HostClientHandlers {
  const { pluginId, services } = options;
  const capabilitySet = new Set<PluginCapability>(options.capabilities);

  type CompanyScopeRequest =
    | { kind: "none" }
    | { kind: "single"; companyId: string }
    | { kind: "all" };

  const noCompanyScope: CompanyScopeRequest = { kind: "none" };

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  function readNonEmptyString(value: unknown): string | null {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  }

  function requestedCompanyScope(
    method: WorkerToHostMethodName,
    params: unknown,
  ): CompanyScopeRequest {
    if (method === "config.get") {
      return noCompanyScope;
    }
    if (method === "companies.list") return { kind: "all" };
    if (!isRecord(params)) return noCompanyScope;

    const companyId = readNonEmptyString(params.companyId);
    if (companyId) return { kind: "single", companyId };

    if (params.scopeKind === "company") {
      const scopeId = readNonEmptyString(params.scopeId);
      return scopeId ? { kind: "single", companyId: scopeId } : { kind: "all" };
    }

    if (method === "events.subscribe" && isRecord(params.filter)) {
      const filterCompanyId = readNonEmptyString(params.filter.companyId);
      if (filterCompanyId) return { kind: "single", companyId: filterCompanyId };
    }

    return noCompanyScope;
  }

  function requireInvocationCompanyScope(
    method: WorkerToHostMethodName,
    params: unknown,
    context?: WorkerHostCallContext,
  ): void {
    const requested = requestedCompanyScope(method, params);
    if (requested.kind === "none") return;

    if (context?.invalidInvocationScope) {
      throw new InvocationScopeDeniedError(
        pluginId,
        method,
        "the worker referenced a missing, expired, or unknown invocation scope",
      );
    }

    const allowedCompanyId = readNonEmptyString(context?.invocationScope?.companyId);

    if (requested.kind === "all") {
      if (method === "companies.list") return;
      if (!allowedCompanyId) {
        throw new InvocationScopeDeniedError(pluginId, method, "company context is required");
      }
      throw new InvocationScopeDeniedError(
        pluginId,
        method,
        `the current invocation is scoped to company "${allowedCompanyId}"`,
      );
    }

    if (!allowedCompanyId) {
      throw new InvocationScopeDeniedError(pluginId, method, "company context is required");
    }

    if (requested.companyId !== allowedCompanyId) {
      throw new InvocationScopeDeniedError(
        pluginId,
        method,
        `requested company "${requested.companyId}" but the current invocation is scoped to company "${allowedCompanyId}"`,
      );
    }
  }

  function resolveRequiredCompanyId(
    method: WorkerToHostMethodName,
    params: unknown,
    context?: WorkerHostCallContext,
  ): string {
    if (context?.invalidInvocationScope) {
      throw new InvocationScopeDeniedError(
        pluginId,
        method,
        "the worker referenced a missing, expired, or unknown invocation scope",
      );
    }

    const requested = requestedCompanyScope(method, params);
    const scopedCompanyId = readNonEmptyString(context?.invocationScope?.companyId);
    if (requested.kind === "single") {
      if (!scopedCompanyId) {
        throw new InvocationScopeDeniedError(pluginId, method, "company context is required");
      }
      if (requested.companyId !== scopedCompanyId) {
        throw new InvocationScopeDeniedError(
          pluginId,
          method,
          `requested company "${requested.companyId}" but the current invocation is scoped to company "${scopedCompanyId}"`,
        );
      }
      return scopedCompanyId;
    }

    if (scopedCompanyId) return scopedCompanyId;

    throw new InvocationScopeDeniedError(pluginId, method, "company context is required");
  }

  function requireExactRunContextHandle(
    method:
      | "run.context.resolve"
      | "run.context.issueReach"
      | "run.issues.listCompanyIssues"
      | "run.issues.listSubIssues"
      | "run.issues.readIssueComments"
      | "run.issues.readIssueAgentRun",
    params: WorkerToHostMethods[typeof method][0],
    context?: WorkerHostCallContext,
  ): void {
    if (context?.invalidInvocationScope) {
      throw new InvocationScopeDeniedError(
        pluginId,
        method,
        "the worker referenced a missing, expired, or unknown invocation scope",
      );
    }
    const supplied = readNonEmptyString(params.runContextHandle);
    const active = readNonEmptyString(
      context?.invocationScope?.pluginRunContextHandle,
    );
    if (!supplied || !active || supplied !== active) {
      throw new InvocationScopeDeniedError(
        pluginId,
        method,
        "an exact active plugin run-context handle is required",
      );
    }
  }

  function requireRunIssueContextBoundary(
    method: WorkerToHostMethodName,
    context?: WorkerHostCallContext,
  ): void {
    if (!INSTALLATION_ISSUE_CONTROL_PLANE_METHODS.has(method)) return;
    const activeRunContextHandle = readNonEmptyString(
      context?.invocationScope?.pluginRunContextHandle,
    );
    if (!activeRunContextHandle) return;
    throw new InvocationScopeDeniedError(
      pluginId,
      method,
      "the installation issue control plane is unavailable while serving an agent run; use only run.issues.* with the exact active run-context handle",
    );
  }

  function requireHostRpcOperation(
    method: "issues.create" | "issues.update" | "issues.withdraw",
    context?: WorkerHostCallContext,
  ): HostRpcOperationContext {
    const hostRpcOperationId = readNonEmptyString(context?.rpcOperationId);
    if (!hostRpcOperationId) {
      throw new Error(
        `Host-assigned RPC operation identity is required for "${method}"`,
      );
    }
    return { hostRpcOperationId };
  }

  /**
   * Assert that the plugin has the required capability for a method.
   * Throws `CapabilityDeniedError` if the capability is missing.
   */
  function requireCapability(
    method: WorkerToHostMethodName,
  ): void {
    const required = METHOD_CAPABILITY_MAP[method];
    if (required === null) return; // No capability required
    if (capabilitySet.has(required)) return;
    throw new CapabilityDeniedError(pluginId, method, required);
  }

  /**
   * Create a capability-gated proxy handler for a method.
   *
   * @param method - The RPC method name (used for capability lookup)
   * @param handler - The actual handler implementation
   * @returns A wrapper that checks capabilities before delegating
   */
  function gated<M extends WorkerToHostMethodName>(
    method: M,
    handler: HostHandler<M>,
  ): HostHandler<M> {
    return async (params: WorkerToHostMethods[M][0], context?: WorkerHostCallContext) => {
      requireCapability(method);
      requireRunIssueContextBoundary(method, context);
      requireInvocationCompanyScope(method, params, context);
      return handler(params, context);
    };
  }

  // -------------------------------------------------------------------------
  // Build the complete handler map
  // -------------------------------------------------------------------------

  return {
    // Config
    "config.get": gated("config.get", async (_params, context) => {
      return services.config.get({}, context);
    }),

    "localFolders.configure": gated("localFolders.configure", async (params) => {
      return services.localFolders.configure(params);
    }),
    "localFolders.status": gated("localFolders.status", async (params) => {
      return services.localFolders.status(params);
    }),
    "localFolders.list": gated("localFolders.list", async (params) => {
      return services.localFolders.list(params);
    }),
    "localFolders.readText": gated("localFolders.readText", async (params) => {
      return services.localFolders.readText(params);
    }),
    "localFolders.writeTextAtomic": gated("localFolders.writeTextAtomic", async (params) => {
      return services.localFolders.writeTextAtomic(params);
    }),
    "localFolders.deleteFile": gated("localFolders.deleteFile", async (params) => {
      return services.localFolders.deleteFile(params);
    }),

    // State
    "state.get": gated("state.get", async (params) => {
      return services.state.get(params);
    }),
    "state.set": gated("state.set", async (params) => {
      return services.state.set(params);
    }),
    "state.delete": gated("state.delete", async (params) => {
      return services.state.delete(params);
    }),

    "db.query": gated("db.query", async (params) => {
      return services.db.query(params);
    }),
    "db.execute": gated("db.execute", async (params) => {
      return services.db.execute(params);
    }),

    // Entities
    "entities.upsert": gated("entities.upsert", async (params) => {
      return services.entities.upsert(params);
    }),
    "entities.list": gated("entities.list", async (params) => {
      return services.entities.list(params);
    }),

    // Events
    "events.emit": gated("events.emit", async (params) => {
      return services.events.emit(params);
    }),
    "events.subscribe": gated("events.subscribe", async (params) => {
      return services.events.subscribe(params);
    }),

    // HTTP
    "http.fetch": gated("http.fetch", async (params) => {
      return services.http.fetch(params);
    }),

    "runtime.records.readSession": gated("runtime.records.readSession", async (params, context) => {
      const companyId = resolveRequiredCompanyId("runtime.records.readSession", params, context);
      const canonicalSession = context?.invocationScope?.canonicalSession;
      if (
        canonicalSession &&
        (params.sessionId !== canonicalSession.sessionId ||
          params.snapshotHighWaterSeq !== canonicalSession.snapshotHighWaterSeq)
      ) {
        throw new InvocationScopeDeniedError(
          pluginId,
          "runtime.records.readSession",
          "the requested Session snapshot is outside the host-stamped invocation boundary",
        );
      }
      const result = await services.runtimeRecords.readSession({ ...params, companyId });
      if (
        result.session.companyId !== companyId ||
        result.session.sessionId !== params.sessionId ||
        result.snapshotHighWaterSeq !== params.snapshotHighWaterSeq
      ) {
        throw new InvocationScopeDeniedError(
          pluginId,
          "runtime.records.readSession",
          "the canonical Session result is outside the requested snapshot",
        );
      }
      if (
        canonicalSession &&
        result.session.issueId !== canonicalSession.issueId
      ) {
        throw new InvocationScopeDeniedError(
          pluginId,
          "runtime.records.readSession",
          "the canonical Session does not belong to the host-stamped invocation issue",
        );
      }
      return result;
    }),
    "runtime.records.readRun": gated("runtime.records.readRun", async (params, context) => {
      const companyId = resolveRequiredCompanyId("runtime.records.readRun", params, context);
      return services.runtimeRecords.readRun({ ...params, companyId });
    }),
    "runtime.records.readIssueComments": gated("runtime.records.readIssueComments", async (params, context) => {
      const companyId = resolveRequiredCompanyId("runtime.records.readIssueComments", params, context);
      return services.runtimeRecords.readIssueComments({ ...params, companyId });
    }),

    // Activity
    "activity.log": gated("activity.log", async (params) => {
      return services.activity.log(params);
    }),

    // Metrics
    "metrics.write": gated("metrics.write", async (params) => {
      return services.metrics.write(params);
    }),

    // Telemetry
    "telemetry.track": gated("telemetry.track", async (params) => {
      return services.telemetry.track(params);
    }),

    // Logger
    "log": gated("log", async (params) => {
      return services.logger.log(params);
    }),

    // Companies
    "companies.list": gated("companies.list", async (params, context) => {
      const rows = await services.companies.list(params);
      const allowedCompanyId = readNonEmptyString(context?.invocationScope?.companyId);
      if (!allowedCompanyId) return rows;
      return rows.filter((company) =>
        isRecord(company) && company.id === allowedCompanyId,
      ) as WorkerToHostMethods["companies.list"][1];
    }),
    "companies.get": gated("companies.get", async (params) => {
      return services.companies.get(params);
    }),

    // Projects
    "projects.list": gated("projects.list", async (params) => {
      return services.projects.list(params);
    }),
    "projects.get": gated("projects.get", async (params) => {
      return services.projects.get(params);
    }),
    "projects.listWorkspaces": gated("projects.listWorkspaces", async (params) => {
      return services.projects.listWorkspaces(params);
    }),
    "projects.getPrimaryWorkspace": gated("projects.getPrimaryWorkspace", async (params) => {
      return services.projects.getPrimaryWorkspace(params);
    }),
    "executionWorkspaces.get": gated("executionWorkspaces.get", async (params) => {
      return services.executionWorkspaces.get(params);
    }),
    "projects.managed.get": gated("projects.managed.get", async (params) => {
      return services.projects.getManaged(params);
    }),
    "projects.managed.reconcile": gated("projects.managed.reconcile", async (params) => {
      return services.projects.reconcileManaged(params);
    }),
    "projects.managed.reset": gated("projects.managed.reset", async (params) => {
      return services.projects.resetManaged(params);
    }),

    // Routines
    "routines.managed.get": gated("routines.managed.get", async (params) => {
      return services.routines.managedGet(params);
    }),
    "routines.managed.reconcile": gated("routines.managed.reconcile", async (params) => {
      return services.routines.managedReconcile(params);
    }),
    "routines.managed.reset": gated("routines.managed.reset", async (params) => {
      return services.routines.managedReset(params);
    }),
    "routines.managed.update": gated("routines.managed.update", async (params) => {
      return services.routines.managedUpdate(params);
    }),
    "routines.managed.run": gated("routines.managed.run", async (params) => {
      return services.routines.managedRun(params);
    }),

    // Skills
    "skills.managed.get": gated("skills.managed.get", async (params) => {
      return services.skills.managedGet(params);
    }),
    "skills.managed.reconcile": gated("skills.managed.reconcile", async (params) => {
      return services.skills.managedReconcile(params);
    }),
    "skills.managed.reset": gated("skills.managed.reset", async (params) => {
      return services.skills.managedReset(params);
    }),

    // Issues
    "issues.list": gated("issues.list", async (params) => {
      return services.issues.list(params);
    }),
    "issues.get": gated("issues.get", async (params) => {
      return services.issues.get(params);
    }),
    "issues.creatorCallback.register": gated("issues.creatorCallback.register", async (params) => {
      return services.issues.registerCreatorCallback(params);
    }),
    "run.context.resolve": gated("run.context.resolve", async (params, context) => {
      requireExactRunContextHandle("run.context.resolve", params, context);
      return services.runIssues.resolveContext(params);
    }),
    "run.context.issueReach": gated("run.context.issueReach", async (params, context) => {
      requireExactRunContextHandle("run.context.issueReach", params, context);
      return services.runIssues.issueReach(params);
    }),
    "run.issues.listCompanyIssues": gated("run.issues.listCompanyIssues", async (params, context) => {
      requireExactRunContextHandle("run.issues.listCompanyIssues", params, context);
      return services.runIssues.listCompanyIssues(params);
    }),
    "run.issues.listSubIssues": gated("run.issues.listSubIssues", async (params, context) => {
      requireExactRunContextHandle("run.issues.listSubIssues", params, context);
      return services.runIssues.listSubIssues(params);
    }),
    "run.issues.readIssueComments": gated("run.issues.readIssueComments", async (params, context) => {
      requireExactRunContextHandle("run.issues.readIssueComments", params, context);
      return services.runIssues.readIssueComments(params);
    }),
    "run.issues.readIssueAgentRun": gated("run.issues.readIssueAgentRun", async (params, context) => {
      requireExactRunContextHandle("run.issues.readIssueAgentRun", params, context);
      return services.runIssues.readIssueAgentRun(params);
    }),
    "issues.create": gated("issues.create", async (params, context) => {
      return services.issues.create(
        params,
        requireHostRpcOperation("issues.create", context),
      );
    }),
    "issues.update": gated("issues.update", async (params, context) => {
      return services.issues.update(
        params,
        requireHostRpcOperation("issues.update", context),
      );
    }),
    "issues.withdraw": gated("issues.withdraw", async (params, context) => {
      return services.issues.withdraw(
        params,
        requireHostRpcOperation("issues.withdraw", context),
      );
    }),

    // Agents
    "agents.list": gated("agents.list", async (params) => {
      return services.agents.list(params);
    }),
    "agents.get": gated("agents.get", async (params) => {
      return services.agents.get(params);
    }),
    "agents.pause": gated("agents.pause", async (params) => {
      return services.agents.pause(params);
    }),
    "agents.resume": gated("agents.resume", async (params) => {
      return services.agents.resume(params);
    }),
    "agents.managed.get": gated("agents.managed.get", async (params) => {
      return services.agents.managedGet(params);
    }),
    "agents.managed.reconcile": gated("agents.managed.reconcile", async (params) => {
      return services.agents.managedReconcile(params);
    }),
    "agents.managed.reset": gated("agents.managed.reset", async (params) => {
      return services.agents.managedReset(params);
    }),

    // Goals
    "goals.list": gated("goals.list", async (params) => {
      return services.goals.list(params);
    }),
    "goals.get": gated("goals.get", async (params) => {
      return services.goals.get(params);
    }),
    "goals.create": gated("goals.create", async (params) => {
      return services.goals.create(params);
    }),
    "goals.update": gated("goals.update", async (params) => {
      return services.goals.update(params);
    }),

    // Access
    "access.members.list": gated("access.members.list", async (params) => {
      return services.access.listMembers(params);
    }),
    "access.members.get": gated("access.members.get", async (params) => {
      return services.access.getMember(params);
    }),
    "access.members.update": gated("access.members.update", async (params) => {
      return services.access.updateMember(params);
    }),
    "access.invites.list": gated("access.invites.list", async (params) => {
      return services.access.listInvites(params);
    }),
    "access.invites.create": gated("access.invites.create", async (params) => {
      return services.access.createInvite(params);
    }),
    "access.invites.revoke": gated("access.invites.revoke", async (params) => {
      return services.access.revokeInvite(params);
    }),

    // Authorization
    "authorization.grants.list": gated("authorization.grants.list", async (params) => {
      return services.authorization.listGrants(params);
    }),
    "authorization.grants.set": gated("authorization.grants.set", async (params) => {
      return services.authorization.setGrants(params);
    }),
    "authorization.policies.summary": gated("authorization.policies.summary", async (params) => {
      return services.authorization.policySummary(params);
    }),
    "authorization.policies.get": gated("authorization.policies.get", async (params) => {
      return services.authorization.getPolicy(params);
    }),
    "authorization.policies.update": gated("authorization.policies.update", async (params) => {
      return services.authorization.updatePolicy(params);
    }),
    "authorization.policies.previewAssignment": gated("authorization.policies.previewAssignment", async (params) => {
      return services.authorization.previewAssignment(params);
    }),
    "authorization.audit.search": gated("authorization.audit.search", async (params) => {
      return services.authorization.searchAudit(params);
    }),
  };
}
