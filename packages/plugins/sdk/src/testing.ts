import { randomUUID } from "node:crypto";
import {
  AGENT_CONTEXT_GRANT_KEYS,
  canonicalizeMoneyAmount,
  grantsForHumanRole,
} from "@paperclipai/shared";
import type {
  PaperclipPluginManifestV1,
  PluginCapability,
  PluginManagedAgentResolution,
  PluginManagedRoutineResolution,
  PluginManagedSkillResolution,
  CompanySkill,
  Company,
  Project,
  Routine,
  RoutineRun,
  Issue,
  Agent,
  Goal,
  PluginWorkerLogLevel,
} from "@paperclipai/shared";
import type {
  EventFilter,
  PluginEventPattern,
  PluginDataScope,
  PluginContext,
  PluginEntityRecord,
  PluginEntityUpsert,
  PluginJobContext,
  PluginEvent,
  ScopeKey,
  ToolResult,
  PluginToolRunContext,
  PluginLocalFolderEntry,
  PluginLocalFolderStatus,
  PluginAccessMember,
  PluginAccessInvite,
  PrincipalPermissionGrant,
  PermissionKey,
  PrincipalType,
  PluginBeforePromptInput,
  PluginBeforePromptResult,
  PluginContextAccess,
} from "./types.js";
import {
  assertPluginEventSubscription,
  pluginEventMatchesFilter,
} from "./event-filter.js";
import { normalizePluginScopeId } from "./plugin-scope.js";
import type { PaperclipPlugin } from "./define-plugin.js";
import type {
  PluginPerformActionActorContext,
  PluginPerformActionContext,
} from "./protocol.js";
import { decodePluginPerformActionActorContext } from "./protocol.js";

const TEST_CONTEXT_ACCESS = Object.freeze(Object.fromEntries(
  AGENT_CONTEXT_GRANT_KEYS.map((key) => [key, false]),
)) as PluginContextAccess;

export interface TestHarnessOptions {
  /** Plugin manifest used to seed capability checks and metadata. */
  manifest: PaperclipPluginManifestV1;
  /** Initial config returned by `ctx.config.get()`. */
  config?: Record<string, unknown>;
}

export interface TestHarnessLogEntry {
  level: PluginWorkerLogLevel;
  message: string;
  meta?: Record<string, unknown>;
}

export interface TestHarnessPerformActionOptions {
  /**
   * Exact authenticated actor context to expose to the action handler.
   */
  actor: PluginPerformActionActorContext;
}

export interface TestHarness {
  /** Fully-typed in-memory plugin context passed to `plugin.setup(ctx)`. */
  ctx: PluginContext;
  /** Seed host entities for `ctx.companies/projects/issues/agents/goals/access/authorization` reads. */
  seed(input: {
    companies?: Company[];
    projects?: Project[];
    issues?: Issue[];
    agents?: Agent[];
    goals?: Goal[];
    accessMembers?: PluginAccessMember[];
    principalGrants?: PrincipalPermissionGrant[];
  }): void;
  setConfig(config: Record<string, unknown>): void;
  /** Dispatch a host or plugin event to registered handlers. */
  emit(eventType: PluginEventPattern, payload: unknown, base?: Partial<PluginEvent>): Promise<void>;
  /** Execute a previously-registered scheduled job handler. */
  runJob(jobKey: string, partial?: Partial<PluginJobContext>): Promise<void>;
  /** Invoke a `ctx.data.register(...)` handler by key. */
  getData<T = unknown>(key: string, params?: Record<string, unknown>): Promise<T>;
  /** Invoke a `ctx.actions.register(...)` handler by key. */
  performAction<T = unknown>(
    key: string,
    params: Record<string, unknown>,
    options: TestHarnessPerformActionOptions,
  ): Promise<T>;
  /** Execute a registered tool handler via `ctx.tools.execute(...)`. */
  executeTool<T = ToolResult>(
    name: string,
    params: unknown,
    runContextHandle?: string,
  ): Promise<T>;
  /** Invoke a plugin's blocking before-prompt hook. */
  beforePrompt(
    plugin: PaperclipPlugin,
    input: PluginBeforePromptInput,
  ): Promise<PluginBeforePromptResult>;
  /** Read raw in-memory state for assertions. */
  getState(input: ScopeKey): unknown;
  logs: TestHarnessLogEntry[];
  activity: Array<{ message: string; entityType?: string; entityId?: string; metadata?: Record<string, unknown> }>;
  metrics: Array<{ name: string; value: number; tags?: Record<string, string> }>;
  telemetry: Array<{ eventName: string; dimensions?: Record<string, string | number | boolean> }>;
  dbQueries: Array<{ sql: string; params?: unknown[] }>;
  dbExecutes: Array<{ sql: string; params?: unknown[] }>;
}

type EventRegistration = {
  name: PluginEventPattern;
  filter?: EventFilter;
  fn: (event: PluginEvent) => Promise<void>;
};

function normalizeScope(input: ScopeKey): {
  scopeKind: PluginDataScope["scopeKind"];
  scopeId?: string;
  namespace: string;
  stateKey: string;
} {
  const scopeId = normalizePluginScopeId(input.scopeKind, input.scopeId);
  return {
    scopeKind: input.scopeKind,
    scopeId: scopeId ?? undefined,
    namespace: input.namespace ?? "default",
    stateKey: input.stateKey,
  };
}

function stateMapKey(input: ScopeKey): string {
  const normalized = normalizeScope(input);
  return `${normalized.scopeKind}|${normalized.scopeId ?? ""}|${normalized.namespace}|${normalized.stateKey}`;
}

function requireCapability(manifest: PaperclipPluginManifestV1, allowed: Set<PluginCapability>, capability: PluginCapability) {
  if (allowed.has(capability)) return;
  throw new Error(`Plugin '${manifest.id}' is missing required capability '${capability}' in test harness`);
}

function requireCompanyId(companyId?: string): string {
  if (!companyId) throw new Error("companyId is required for this operation");
  return companyId;
}

function isInCompany<T extends { companyId: string | null | undefined }>(
  record: T | null | undefined,
  companyId: string,
): record is T {
  return Boolean(record && record.companyId === companyId);
}

/**
 * Create an in-memory host harness for plugin worker tests.
 *
 * The harness enforces declared capabilities and simulates host APIs, so tests
 * can validate plugin behavior without spinning up the Paperclip server runtime.
 */
export function createTestHarness(options: TestHarnessOptions): TestHarness {
  const manifest = options.manifest;
  const pluginInstallationId = randomUUID();
  const capabilitySet = new Set(manifest.capabilities);
  let currentConfig = { ...(options.config ?? {}) };

  const logs: TestHarnessLogEntry[] = [];
  const activity: TestHarness["activity"] = [];
  const metrics: TestHarness["metrics"] = [];
  const telemetry: TestHarness["telemetry"] = [];
  const dbQueries: TestHarness["dbQueries"] = [];
  const dbExecutes: TestHarness["dbExecutes"] = [];

  const state = new Map<string, unknown>();
  const entities = new Map<string, PluginEntityRecord>();
  const entityExternalIndex = new Map<string, string>();
  const companies = new Map<string, Company>();
  const projects = new Map<string, Project>();
  const routines = new Map<string, Routine>();
  const routineRuns = new Map<string, RoutineRun>();
  const issues = new Map<string, Issue>();
  const pluginOwnedIssueIds = new Set<string>();
  const pluginIssueMessages = new Map<string, string[]>();
  const pluginCreatorCallbacks = new Map<
    string,
    import("./types.js").PluginCreatorCallbackHandler
  >();
  const agents = new Map<string, Agent>();
  const goals = new Map<string, Goal>();
  const accessMembers = new Map<string, PluginAccessMember>();
  const accessInvites = new Map<string, PluginAccessInvite>();
  const principalGrants = new Map<string, PrincipalPermissionGrant[]>();

  function principalGrantsKey(companyId: string, principalType: PrincipalType, principalId: string) {
    return `${companyId}:${principalType}:${principalId}`;
  }
  function getPrincipalGrants(companyId: string, principalType: PrincipalType, principalId: string) {
    return principalGrants.get(principalGrantsKey(companyId, principalType, principalId)) ?? [];
  }
  function setPrincipalGrants(
    companyId: string,
    principalType: PrincipalType,
    principalId: string,
    grants: Array<{ permissionKey: PermissionKey; scope?: Record<string, unknown> | null }>,
  ) {
    const stamped = grants.map((grant) => ({
      principalType,
      principalId,
      permissionKey: grant.permissionKey,
      scope: grant.scope && typeof grant.scope === "object" ? grant.scope : null,
    })) as PrincipalPermissionGrant[];
    principalGrants.set(principalGrantsKey(companyId, principalType, principalId), stamped);
    const member = [...accessMembers.values()].find(
      (entry) =>
        entry.companyId === companyId
        && entry.principalType === principalType
        && entry.principalId === principalId,
    );
    if (member) {
      accessMembers.set(member.id, { ...member, grants: stamped, updatedAt: new Date().toISOString() });
    }
    return stamped;
  }
  const localFolderStatuses = new Map<string, PluginLocalFolderStatus>();
  const localFolderFiles = new Map<string, string>();

  const events: EventRegistration[] = [];
  const jobs = new Map<string, (job: PluginJobContext) => Promise<void>>();
  const dataHandlers = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>();
  const actionHandlers = new Map<
    string,
    (params: Record<string, unknown>, context: PluginPerformActionContext) => Promise<unknown>
  >();
  const toolHandlers = new Map<
    string,
    (params: unknown, runContext: PluginToolRunContext) => Promise<ToolResult>
  >();

  function localFolderKey(companyId: string, folderKey: string): string {
    return `${companyId}:${folderKey}`;
  }

  function localFolderFileKey(companyId: string, folderKey: string, relativePath: string): string {
    return `${localFolderKey(companyId, folderKey)}:${relativePath}`;
  }

  function actionContextFor(
    options: TestHarnessPerformActionOptions,
  ): PluginPerformActionContext {
    const actor: Readonly<PluginPerformActionActorContext> = Object.freeze(
      decodePluginPerformActionActorContext(
        (options as TestHarnessPerformActionOptions | undefined)?.actor,
      ),
    );
    return Object.freeze({ actor });
  }

  function normalizeLocalFolderRelativePath(relativePath: string): string {
    const parts: string[] = [];
    for (const segment of relativePath.split(/[\\/]+/)) {
      if (!segment || segment === ".") continue;
      if (segment === "..") throw new Error("Local folder path traversal is not allowed");
      parts.push(segment);
    }
    return parts.join("/");
  }

  function localFolderDeclaration(folderKey: string) {
    const declaration = manifest.localFolders?.find((candidate) => candidate.folderKey === folderKey);
    if (!declaration) throw new Error(`Local folder declaration not found: ${folderKey}`);
    return declaration;
  }

  function notConfiguredLocalFolderStatus(folderKey: string): PluginLocalFolderStatus {
    const declaration = localFolderDeclaration(folderKey);
    const access = declaration.access ?? "readWrite";
    const requiredDirectories = declaration.requiredDirectories ?? [];
    const requiredFiles = declaration.requiredFiles ?? [];
    return {
      folderKey,
      configured: false,
      path: null,
      realPath: null,
      access,
      readable: false,
      writable: false,
      requiredDirectories,
      requiredFiles,
      missingDirectories: requiredDirectories,
      missingFiles: requiredFiles,
      healthy: false,
      problems: [{ code: "not_configured", message: "No local folder path is configured." }],
      checkedAt: new Date().toISOString(),
    };
  }

  function managedAgentDeclaration(agentKey: string) {
    const declaration = manifest.agents?.find((agent) => agent.agentKey === agentKey);
    if (!declaration) throw new Error(`Managed agent declaration not found: ${agentKey}`);
    return declaration;
  }

  function managedAgentEntity(companyId: string, agentKey: string) {
    const externalId = `${manifest.id}:agent:${agentKey}`;
    return [...entities.values()].find((entity) =>
      entity.entityType === "managed_resource"
      && entity.scopeKind === "company"
      && entity.scopeId === companyId
      && entity.externalId === externalId,
    ) ?? null;
  }

  function managedAgentFor(companyId: string, agentKey: string) {
    const entity = managedAgentEntity(companyId, agentKey);
    const agent = entity ? agents.get(String(entity.data?.agentId ?? "")) : null;
    return agent && isInCompany(agent, companyId) && agent.status !== "terminated"
      ? agent
      : null;
  }

  function recordManagedAgent(
    companyId: string,
    agentKey: string,
    agent: Agent,
    now: Date,
  ) {
    const existingEntity = managedAgentEntity(companyId, agentKey);
    const externalId = `${manifest.id}:agent:${agentKey}`;
    const nowIso = now.toISOString();
    const record: PluginEntityRecord = {
      id: existingEntity?.id ?? randomUUID(),
      entityType: "managed_resource",
      scopeKind: "company",
      scopeId: companyId,
      externalId,
      title: agent.name,
      status: null,
      data: { resourceKind: "agent", resourceKey: agentKey, agentId: agent.id },
      createdAt: existingEntity?.createdAt ?? nowIso,
      updatedAt: nowIso,
    };
    entities.set(record.id, record);
    entityExternalIndex.set(
      JSON.stringify(["managed_resource", "company", companyId, externalId]),
      record.id,
    );
  }

  function managedResolution(
    agentKey: string,
    companyId: string,
    agent: Agent | null,
    status: PluginManagedAgentResolution["status"],
  ): PluginManagedAgentResolution {
    return {
      pluginKey: manifest.id,
      resourceKind: "agent",
      resourceKey: agentKey,
      companyId,
      agentId: agent?.id ?? null,
      agent,
      status,
      approvalId: null,
    };
  }
  function assertInvokableIssueOwner(ownerAgentId: string, companyId: string): Agent {
    const owner = agents.get(ownerAgentId);
    if (!isInCompany(owner, companyId)) {
      throw new Error(`Issue owner agent not found: ${ownerAgentId}`);
    }
    if (
      owner.status === "paused"
      || owner.status === "terminated"
      || owner.status === "pending_approval"
    ) {
      throw new Error(`Issue owner agent is not invokable: ${owner.status}`);
    }
    return owner;
  }

  function assertMutablePluginIssue(issueId: string, companyId: string): Issue {
    const issue = issues.get(issueId);
    if (!isInCompany(issue, companyId) || !pluginOwnedIssueIds.has(issueId)) {
      throw new Error(`Plugin-owned issue not found: ${issueId}`);
    }
    if (issue.lifecycleStatus === "done" || issue.lifecycleStatus === "cancelled") {
      throw new Error(`Plugin-owned issue is terminal: ${issue.lifecycleStatus}`);
    }
    return issue;
  }

  function previewTargetAgentManagement(input: import("./types.js").PluginAssignmentPreviewInput) {
    const target = agents.get(input.targetAgentId);
    if (!isInCompany(target, input.companyId)) {
      return {
        allowed: false,
        action: "agent_config:update",
        explanation: "Target agent was not found in the target company.",
        reason: "deny_company_boundary",
      };
    }
    if (input.subject.type === "agent") {
      const persistedAgent = agents.get(input.subject.agentId);
      if (!isInCompany(persistedAgent, input.companyId)) {
        return {
          allowed: false,
          action: "agent_config:update",
          explanation: "Agent subject was not found in the target company.",
          reason: "deny_company_boundary",
        };
      }
    }

    const principalType = input.subject.type;
    const principalId =
      input.subject.type === "user"
        ? input.subject.userId
        : input.subject.agentId;
    const membership = [...accessMembers.values()].find(
      (candidate) =>
        candidate.companyId === input.companyId
        && candidate.principalType === principalType
        && candidate.principalId === principalId
        && candidate.status === "active",
    );
    if (!membership) {
      return {
        allowed: false,
        action: "agent_config:update",
        explanation: `${principalType} principal ${principalId} is not an active company member.`,
        reason: "deny_missing_membership",
      };
    }

    const grantCoversTarget = (candidate: PrincipalPermissionGrant) => {
        if (!candidate.scope || Object.keys(candidate.scope).length === 0) return true;
        if (candidate.scope.targetAgentId === input.targetAgentId) return true;
        return Array.isArray(candidate.scope.targetAgentIds) &&
          candidate.scope.targetAgentIds.includes(input.targetAgentId);
    };
    const grants = getPrincipalGrants(input.companyId, principalType, principalId);
    const directGrant = grants.find(
      (candidate) => candidate.permissionKey === "agents:configure" && grantCoversTarget(candidate),
    );
    if (directGrant) {
      return {
        allowed: true,
        action: "agent_config:update",
        explanation: "Allowed by an explicit agents:configure grant.",
        reason: "allow_direct_change",
        grant: directGrant,
      };
    }
    const suggestionGrant = grants.find(
      (candidate) =>
        candidate.permissionKey === "agents:suggest-changes"
        && grantCoversTarget(candidate),
    );
    if (suggestionGrant) {
      return {
        allowed: false,
        action: "agent_config:update",
        explanation:
          "Permission agents:suggest-changes requires accepted change consent before applying this mutation.",
        reason: "deny_missing_consent",
        grant: suggestionGrant,
      };
    }
    return {
      allowed: false,
      action: "agent_config:update",
      explanation: "Missing permission: agents:configure.",
      reason: "deny_no_grant",
    };
  }

  const ctx: PluginContext = {
    manifest,
    config: {
      async get() {
        return { ...currentConfig };
      },
    },
    localFolders: {
      async configure(input) {
        requireCapability(manifest, capabilitySet, "local.folders");
        const declaration = localFolderDeclaration(input.folderKey);
        const access = declaration.access ?? "readWrite";
        const status = {
          folderKey: input.folderKey,
          configured: true,
          path: input.path,
          realPath: input.path,
          access,
          readable: true,
          writable: access === "readWrite",
          requiredDirectories: declaration.requiredDirectories ?? [],
          requiredFiles: declaration.requiredFiles ?? [],
          missingDirectories: [],
          missingFiles: [],
          healthy: true,
          problems: [],
          checkedAt: new Date().toISOString(),
        } satisfies PluginLocalFolderStatus;
        localFolderStatuses.set(localFolderKey(input.companyId, input.folderKey), status);
        return status;
      },
      async status(companyId, folderKey) {
        requireCapability(manifest, capabilitySet, "local.folders");
        return localFolderStatuses.get(localFolderKey(companyId, folderKey)) ?? notConfiguredLocalFolderStatus(folderKey);
      },
      async list(companyId, folderKey, options) {
        requireCapability(manifest, capabilitySet, "local.folders");
        localFolderDeclaration(folderKey);
        const status = localFolderStatuses.get(localFolderKey(companyId, folderKey));
        if (!status?.configured) throw new Error("Local folder is not configured");
        const prefix = normalizeLocalFolderRelativePath(options?.relativePath ?? "");
        const prefixWithSlash = prefix ? `${prefix}/` : "";
        const entries = new Map<string, PluginLocalFolderEntry>();
        for (const [key, contents] of localFolderFiles) {
          const filePrefix = `${localFolderKey(companyId, folderKey)}:`;
          if (!key.startsWith(filePrefix)) continue;
          const filePath = key.slice(filePrefix.length);
          if (prefix && filePath !== prefix && !filePath.startsWith(prefixWithSlash)) continue;
          const remainder = prefix ? filePath.slice(prefixWithSlash.length) : filePath;
          const [name] = remainder.split("/");
          if (!name) continue;
          const entryPath = prefix ? `${prefix}/${name}` : name;
          const isNested = remainder.includes("/");
          if (!options?.recursive && isNested) {
            entries.set(entryPath, {
              path: entryPath,
              name,
              kind: "directory",
              size: null,
              modifiedAt: null,
            });
            continue;
          }
          entries.set(filePath, {
            path: filePath,
            name: filePath.split("/").pop() ?? filePath,
            kind: "file",
            size: Buffer.byteLength(contents, "utf8"),
            modifiedAt: null,
          });
        }
        const maxEntries = options?.maxEntries && options.maxEntries > 0 ? options.maxEntries : entries.size;
        const allEntries = [...entries.values()].sort((a, b) => a.path.localeCompare(b.path));
        return {
          folderKey,
          relativePath: options?.relativePath ?? null,
          entries: allEntries.slice(0, maxEntries),
          truncated: allEntries.length > maxEntries,
        };
      },
      async readText(companyId, folderKey, relativePath) {
        requireCapability(manifest, capabilitySet, "local.folders");
        localFolderDeclaration(folderKey);
        const normalizedPath = normalizeLocalFolderRelativePath(relativePath);
        const contents = localFolderFiles.get(localFolderFileKey(companyId, folderKey, normalizedPath));
        if (contents === undefined) throw new Error(`Local folder file not found: ${relativePath}`);
        return contents;
      },
      async writeTextAtomic(companyId, folderKey, relativePath, contents) {
        requireCapability(manifest, capabilitySet, "local.folders");
        localFolderDeclaration(folderKey);
        const status = localFolderStatuses.get(localFolderKey(companyId, folderKey));
        if (!status?.configured) throw new Error("Local folder is not configured");
        if (status.access !== "readWrite" || !status.writable) {
          throw new Error("Local folder is not configured for writes");
        }
        localFolderFiles.set(localFolderFileKey(companyId, folderKey, normalizeLocalFolderRelativePath(relativePath)), contents);
        return status;
      },
      async deleteFile(companyId, folderKey, relativePath) {
        requireCapability(manifest, capabilitySet, "local.folders");
        localFolderDeclaration(folderKey);
        const status = localFolderStatuses.get(localFolderKey(companyId, folderKey));
        if (!status?.configured) throw new Error("Local folder is not configured");
        if (status.access !== "readWrite" || !status.writable) {
          throw new Error("Local folder is not configured for writes");
        }
        localFolderFiles.delete(localFolderFileKey(companyId, folderKey, normalizeLocalFolderRelativePath(relativePath)));
        return status;
      },
    },
    events: {
      on(name: PluginEventPattern, filterOrFn: EventFilter | ((event: PluginEvent) => Promise<void>), maybeFn?: (event: PluginEvent) => Promise<void>): () => void {
        requireCapability(manifest, capabilitySet, "events.subscribe");
        let registration: EventRegistration;
        if (typeof filterOrFn === "function") {
          registration = { name, fn: filterOrFn };
        } else {
          if (!maybeFn) throw new Error("event handler is required");
          registration = { name, filter: filterOrFn, fn: maybeFn };
        }
        assertPluginEventSubscription(name, registration.filter);
        events.push(registration);
        return () => {
          const idx = events.indexOf(registration);
          if (idx !== -1) events.splice(idx, 1);
        };
      },
      async emit(name, companyId, payload) {
        requireCapability(manifest, capabilitySet, "events.emit");
        await harness.emit(`plugin.${manifest.id}.${name}`, payload, { companyId });
      },
    },
    jobs: {
      register(key, fn) {
        requireCapability(manifest, capabilitySet, "jobs.schedule");
        if (!(manifest.jobs ?? []).some((job) => job.jobKey === key)) {
          throw new Error(`Job handler "${key}" is not declared in manifest.jobs`);
        }
        if (jobs.has(key)) {
          throw new Error(`Job handler "${key}" is registered more than once`);
        }
        jobs.set(key, fn);
      },
    },
    db: {
      get namespace() {
        if (!manifest.database) {
          throw new Error(
            "Plugin database namespace is unavailable because the manifest does not declare a database",
          );
        }
        return `test_${manifest.id.replace(/[^a-z0-9_]+/g, "_")}`;
      },
      async query(sql, params) {
        requireCapability(manifest, capabilitySet, "database.namespace.read");
        dbQueries.push({ sql, params });
        return [];
      },
      async execute(sql, params) {
        requireCapability(manifest, capabilitySet, "database.namespace.write");
        dbExecutes.push({ sql, params });
        return { rowCount: 0 };
      },
    },
    http: {
      async fetch(url, init) {
        requireCapability(manifest, capabilitySet, "http.outbound");
        return fetch(url, init);
      },
    },
    runtime: {
      records: {
        async readSession() {
          requireCapability(manifest, capabilitySet, "runtime.records.read");
          throw new Error(
            "No canonical Session record is configured in the plugin test harness",
          );
        },
        async readRun() {
          requireCapability(manifest, capabilitySet, "runtime.records.read");
          throw new Error(
            "No runtime run record is configured in the plugin test harness",
          );
        },
        async readIssueComments() {
          requireCapability(manifest, capabilitySet, "runtime.records.read");
          return { items: [], nextCursor: null };
        },
      },
    },
    activity: {
      async log(entry) {
        requireCapability(manifest, capabilitySet, "activity.log.write");
        activity.push(entry);
      },
    },
    state: {
      async get(input) {
        requireCapability(manifest, capabilitySet, "plugin.state.read");
        return state.has(stateMapKey(input)) ? state.get(stateMapKey(input)) : null;
      },
      async set(input, value) {
        requireCapability(manifest, capabilitySet, "plugin.state.write");
        state.set(stateMapKey(input), value);
      },
      async delete(input) {
        requireCapability(manifest, capabilitySet, "plugin.state.write");
        state.delete(stateMapKey(input));
      },
    },
    entities: {
      async upsert(input: PluginEntityUpsert) {
        const scopeId = normalizePluginScopeId(input.scopeKind, input.scopeId);
        const externalKey = JSON.stringify([
          input.entityType,
          input.scopeKind,
          scopeId,
          input.externalId ?? null,
        ]);
        const existingId = entityExternalIndex.get(externalKey);
        const existing = existingId ? entities.get(existingId) : undefined;
        const now = new Date().toISOString();
        const previousExternalKey = existing
          ? JSON.stringify([
              existing.entityType,
              existing.scopeKind,
              existing.scopeId,
              existing.externalId,
            ])
          : null;
        const record: PluginEntityRecord = existing
          ? {
            ...existing,
            entityType: input.entityType,
            scopeKind: input.scopeKind,
            scopeId,
            externalId: input.externalId ?? null,
            title: input.title ?? null,
            status: input.status ?? null,
            data: input.data,
            updatedAt: now,
          }
          : {
            id: randomUUID(),
            entityType: input.entityType,
            scopeKind: input.scopeKind,
            scopeId,
            externalId: input.externalId ?? null,
            title: input.title ?? null,
            status: input.status ?? null,
            data: input.data,
            createdAt: now,
            updatedAt: now,
          };
        entities.set(record.id, record);
        if (previousExternalKey && previousExternalKey !== externalKey) {
          entityExternalIndex.delete(previousExternalKey);
        }
        entityExternalIndex.set(externalKey, record.id);
        return record;
      },
      async list(query) {
        let out = [...entities.values()];
        if (query.entityType) out = out.filter((r) => r.entityType === query.entityType);
        if (query.scopeId !== undefined && query.scopeKind === undefined) {
          throw new Error("Plugin entity scopeId requires scopeKind");
        }
        if (query.scopeKind !== undefined) {
          const scopeId = normalizePluginScopeId(query.scopeKind, query.scopeId);
          out = out.filter((record) =>
            record.scopeKind === query.scopeKind && record.scopeId === scopeId
          );
        }
        if (query.externalId !== undefined) out = out.filter((r) => r.externalId === query.externalId);
        if (query.offset) out = out.slice(query.offset);
        if (query.limit) out = out.slice(0, query.limit);
        return out;
      },
    },
    projects: {
      async list(input) {
        requireCapability(manifest, capabilitySet, "projects.read");
        const companyId = requireCompanyId(input?.companyId);
        let out = [...projects.values()];
        out = out.filter((project) => project.companyId === companyId);
        if (input?.offset) out = out.slice(input.offset);
        if (input?.limit) out = out.slice(0, input.limit);
        return out;
      },
      async get(projectId, companyId) {
        requireCapability(manifest, capabilitySet, "projects.read");
        const project = projects.get(projectId);
        return isInCompany(project, companyId) ? project : null;
      },
      managed: {
        async get(projectKey, companyId) {
          requireCapability(manifest, capabilitySet, "projects.managed");
          const declaration = manifest.projects?.find((project) => project.projectKey === projectKey);
          if (!declaration) {
            return {
              pluginKey: manifest.id,
              resourceKind: "project",
              resourceKey: projectKey,
              companyId,
              projectId: null,
              project: null,
              status: "missing",
            };
          }
          const externalId = `${manifest.id}:project:${projectKey}`;
          const existingEntity = [...entities.values()].find((entity) =>
            entity.entityType === "managed_resource"
            && entity.scopeKind === "company"
            && entity.scopeId === companyId
            && entity.externalId === externalId
          );
          const existingProject = existingEntity ? projects.get(String(existingEntity.data?.projectId ?? "")) : null;
          if (existingProject && isInCompany(existingProject, companyId)) {
            return {
              pluginKey: manifest.id,
              resourceKind: "project",
              resourceKey: projectKey,
              companyId,
              projectId: existingProject.id,
              project: existingProject,
              status: "resolved",
            };
          }
          const now = new Date();
          const project = {
            id: `project-${projects.size + 1}`,
            companyId,
            urlKey: declaration.projectKey,
            goalId: null,
            goalIds: [],
            goals: [],
            name: declaration.displayName,
            description: declaration.description ?? null,
            status: declaration.status ?? "in_progress",
            leadAgentId: null,
            targetDate: null,
            color: declaration.color ?? null,
            icon: null,
            env: null,
            pauseReason: null,
            pausedAt: null,
            codebase: {
              workspaceId: null,
              repoUrl: null,
              localFolder: null,
            },
            workspaces: [],
            primaryWorkspace: null,
            managedByPlugin: {
              id: `managed-${projects.size + 1}`,
              pluginId: manifest.id,
              pluginKey: manifest.id,
              pluginDisplayName: manifest.displayName,
              resourceKind: "project",
              resourceKey: projectKey,
              defaultsJson: { displayName: declaration.displayName, settings: declaration.settings ?? {} },
              createdAt: now,
              updatedAt: now,
            },
            archivedAt: null,
            createdAt: now,
            updatedAt: now,
          } as Project;
          projects.set(project.id, project);
          const externalKey = JSON.stringify([
            "managed_resource",
            "company",
            companyId,
            externalId,
          ]);
          const nowIso = now.toISOString();
          const record: PluginEntityRecord = {
            id: randomUUID(),
            entityType: "managed_resource",
            scopeKind: "company",
            scopeId: companyId,
            externalId,
            title: declaration.displayName,
            status: null,
            data: { resourceKind: "project", resourceKey: projectKey, projectId: project.id },
            createdAt: nowIso,
            updatedAt: nowIso,
          };
          entities.set(record.id, record);
          entityExternalIndex.set(externalKey, record.id);
          return {
            pluginKey: manifest.id,
            resourceKind: "project",
            resourceKey: projectKey,
            companyId,
            projectId: project.id,
            project,
            status: "created",
          };
        },
        async reconcile(projectKey, companyId) {
          return this.get(projectKey, companyId);
        },
        async reset(projectKey, companyId) {
          const resolved = await this.get(projectKey, companyId);
          return { ...resolved, status: resolved.project ? "reset" : resolved.status };
        },
      },
    },
    routines: {
      managed: {
        async get(routineKey, companyId) {
          requireCapability(manifest, capabilitySet, "routines.managed");
          const declaration = manifest.routines?.find((routine) => routine.routineKey === routineKey);
          if (!declaration) {
            return {
              pluginKey: manifest.id,
              resourceKind: "routine",
              resourceKey: routineKey,
              companyId,
              routineId: null,
              routine: null,
              status: "missing",
              missingRefs: [],
            } satisfies PluginManagedRoutineResolution;
          }
          const externalId = `${manifest.id}:routine:${routineKey}`;
          const existingEntity = [...entities.values()].find((entity) =>
            entity.entityType === "managed_resource"
            && entity.scopeKind === "company"
            && entity.scopeId === companyId
            && entity.externalId === externalId
          );
          const existingRoutine = existingEntity ? routines.get(String(existingEntity.data?.routineId ?? "")) : null;
          if (existingRoutine && isInCompany(existingRoutine, companyId)) {
            return {
              pluginKey: manifest.id,
              resourceKind: "routine",
              resourceKey: routineKey,
              companyId,
              routineId: existingRoutine.id,
              routine: existingRoutine,
              status: "resolved",
              missingRefs: [],
            } satisfies PluginManagedRoutineResolution;
          }
          return {
            pluginKey: manifest.id,
            resourceKind: "routine",
            resourceKey: routineKey,
            companyId,
            routineId: null,
            routine: null,
            status: "missing",
            missingRefs: [],
          } satisfies PluginManagedRoutineResolution;
        },
        async reconcile(routineKey, companyId, overrides) {
          const existing = await this.get(routineKey, companyId);
          if (existing.routine) return existing;
          const declaration = manifest.routines?.find((routine) => routine.routineKey === routineKey);
          if (!declaration) return existing;
          const now = new Date();
          const agentRef = declaration.assigneeRef;
          const projectRef = declaration.projectRef;
          const assigneeAgentId = overrides?.assigneeAgentId
            ?? (agentRef?.resourceKind === "agent"
              ? managedAgentFor(companyId, agentRef.resourceKey)?.id
              : null)
            ?? null;
          const projectId = overrides?.projectId
            ?? (projectRef?.resourceKind === "project"
              ? [...projects.values()].find((project) => (
                isInCompany(project, companyId)
                && project.managedByPlugin?.pluginKey === manifest.id
                && project.managedByPlugin?.resourceKey === projectRef.resourceKey
              ))?.id
              : null)
            ?? null;
          const missingRefs: NonNullable<PluginManagedRoutineResolution["missingRefs"]> = [];
          if (agentRef && !assigneeAgentId) missingRefs.push({ ...agentRef, pluginKey: manifest.id });
          if (projectRef && !projectId) missingRefs.push({ ...projectRef, pluginKey: manifest.id });
          if (missingRefs.length > 0) {
            return {
              pluginKey: manifest.id,
              resourceKind: "routine",
              resourceKey: routineKey,
              companyId,
              routineId: null,
              routine: null,
              status: "missing_refs",
              missingRefs,
            } satisfies PluginManagedRoutineResolution;
          }
          const routine = {
            id: `routine-${routines.size + 1}`,
            companyId,
            projectId,
            goalId: declaration.goalId ?? null,
            parentIssueId: null,
            title: declaration.title,
            description: declaration.description ?? null,
            responsibleUserId: null,
            assigneeAgentId,
            priority: declaration.priority ?? "medium",
            status: declaration.status ?? (assigneeAgentId ? "active" : "paused"),
            concurrencyPolicy: declaration.concurrencyPolicy ?? "coalesce_if_active",
            catchUpPolicy: declaration.catchUpPolicy ?? "skip_missed",
            variables: declaration.variables ?? [],
            latestRevisionId: null,
            latestRevisionNumber: 1,
            createdByAgentId: null,
            createdByUserId: null,
            updatedByAgentId: null,
            updatedByUserId: null,
            lastTriggeredAt: null,
            lastEnqueuedAt: null,
            createdAt: now,
            updatedAt: now,
            managedByPlugin: {
              id: `managed-routine-${routines.size + 1}`,
              pluginId: manifest.id,
              pluginKey: manifest.id,
              pluginDisplayName: manifest.displayName,
              resourceKind: "routine",
              resourceKey: routineKey,
              defaultsJson: { title: declaration.title, issueTemplate: declaration.issueTemplate ?? null },
              createdAt: now,
              updatedAt: now,
            },
          } as Routine;
          routines.set(routine.id, routine);
          const nowIso = now.toISOString();
          const record: PluginEntityRecord = {
            id: randomUUID(),
            entityType: "managed_resource",
            scopeKind: "company",
            scopeId: companyId,
            externalId: `${manifest.id}:routine:${routineKey}`,
            title: declaration.title,
            status: null,
            data: { resourceKind: "routine", resourceKey: routineKey, routineId: routine.id },
            createdAt: nowIso,
            updatedAt: nowIso,
          };
          entities.set(record.id, record);
          return {
            pluginKey: manifest.id,
            resourceKind: "routine",
            resourceKey: routineKey,
            companyId,
            routineId: routine.id,
            routine,
            status: "created",
            missingRefs: [],
          } satisfies PluginManagedRoutineResolution;
        },
        async reset(routineKey, companyId, overrides) {
          const resolved = await this.reconcile(routineKey, companyId, overrides);
          return { ...resolved, status: resolved.routine ? "reset" : resolved.status } satisfies PluginManagedRoutineResolution;
        },
        async update(routineKey, companyId, patch) {
          const resolved = await this.get(routineKey, companyId);
          if (!resolved.routine) throw new Error(`Managed routine not found: ${routineKey}`);
          const next = {
            ...resolved.routine,
            ...(patch.status !== undefined ? { status: patch.status } : {}),
            updatedAt: new Date(),
          };
          routines.set(next.id, next);
          return next;
        },
        async run(routineKey, companyId) {
          const resolved = await this.get(routineKey, companyId);
          if (!resolved.routine) throw new Error(`Managed routine not found: ${routineKey}`);
          const now = new Date();
          const run = {
            id: `routine-run-${routineRuns.size + 1}`,
            companyId,
            routineId: resolved.routine.id,
            triggerId: null,
            source: "manual",
            status: "queued",
            triggeredAt: now,
            idempotencyKey: null,
            triggerPayload: null,
            dispatchFingerprint: null,
            linkedIssueId: null,
            coalescedIntoRunId: null,
            failureReason: null,
            completedAt: null,
            createdAt: now,
            updatedAt: now,
          } satisfies RoutineRun;
          routineRuns.set(run.id, run);
          routines.set(resolved.routine.id, {
            ...resolved.routine,
            lastTriggeredAt: now,
            lastEnqueuedAt: now,
            updatedAt: now,
          });
          return run;
        },
      },
    },
    skills: {
      managed: {
        async get(skillKey, companyId) {
          requireCapability(manifest, capabilitySet, "skills.managed");
          const declaration = manifest.skills?.find((skill) => skill.skillKey === skillKey);
          if (!declaration) {
            return {
              pluginKey: manifest.id,
              resourceKind: "skill",
              resourceKey: skillKey,
              companyId,
              skillId: null,
              skill: null,
              status: "missing",
              defaultDrift: null,
            } satisfies PluginManagedSkillResolution;
          }
          const externalId = `${manifest.id}:skill:${skillKey}`;
          const existingEntity = [...entities.values()].find((entity) =>
            entity.entityType === "managed_resource"
            && entity.scopeKind === "company"
            && entity.scopeId === companyId
            && entity.externalId === externalId
          );
          const existingSkill = existingEntity?.data?.skill as CompanySkill | undefined;
          if (existingSkill && existingSkill.companyId === companyId) {
            return {
              pluginKey: manifest.id,
              resourceKind: "skill",
              resourceKey: skillKey,
              companyId,
              skillId: existingSkill.id,
              skill: existingSkill,
              status: "resolved",
              defaultDrift: null,
            } satisfies PluginManagedSkillResolution;
          }
          return {
            pluginKey: manifest.id,
            resourceKind: "skill",
            resourceKey: skillKey,
            companyId,
            skillId: null,
            skill: null,
            status: "missing",
            defaultDrift: null,
          } satisfies PluginManagedSkillResolution;
        },
        async reconcile(skillKey, companyId) {
          const existing = await this.get(skillKey, companyId);
          if (existing.skill) return existing;
          const declaration = manifest.skills?.find((skill) => skill.skillKey === skillKey);
          if (!declaration) return existing;
          const now = new Date();
          const skill = {
            id: randomUUID(),
            companyId,
            key: `plugin/${manifest.id.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}/${skillKey}`,
            slug: declaration.slug ?? skillKey,
            name: declaration.displayName,
            description: declaration.description ?? null,
            markdown: declaration.markdown ?? `# ${declaration.displayName}\n`,
            sourceType: "catalog",
            sourceLocator: null,
            sourceRef: null,
            trustLevel: "markdown_only",
            compatibility: "compatible",
            fileInventory: [{ path: "SKILL.md", kind: "skill" }],
            iconUrl: null,
            color: null,
            tagline: declaration.description?.slice(0, 120) ?? null,
            authorName: null,
            homepageUrl: null,
            categories: [],
            sharingScope: "company",
            publicShareToken: null,
            forkedFromSkillId: null,
            forkedFromCompanyId: null,
            starCount: 0,
            installCount: 1,
            forkCount: 0,
            currentVersionId: null,
            metadata: {
              sourceKind: "catalog",
              pluginManagedResource: {
                pluginKey: manifest.id,
                resourceKind: "skill",
                resourceKey: skillKey,
              },
            },
            createdAt: now,
            updatedAt: now,
          } satisfies CompanySkill;
          const nowIso = now.toISOString();
          const record: PluginEntityRecord = {
            id: randomUUID(),
            entityType: "managed_resource",
            scopeKind: "company",
            scopeId: companyId,
            externalId: `${manifest.id}:skill:${skillKey}`,
            title: declaration.displayName,
            status: null,
            data: { resourceKind: "skill", resourceKey: skillKey, skillId: skill.id, skill },
            createdAt: nowIso,
            updatedAt: nowIso,
          };
          entities.set(record.id, record);
          return {
            pluginKey: manifest.id,
            resourceKind: "skill",
            resourceKey: skillKey,
            companyId,
            skillId: skill.id,
            skill,
            status: "created",
            defaultDrift: null,
          } satisfies PluginManagedSkillResolution;
        },
        async reset(skillKey, companyId) {
          requireCapability(manifest, capabilitySet, "skills.managed");
          const existing = await this.get(skillKey, companyId);
          const declaration = manifest.skills?.find((skill) => skill.skillKey === skillKey);
          if (!declaration) return existing;
          const now = new Date();
          const skill = {
            id: existing.skill?.id ?? randomUUID(),
            companyId,
            key: `plugin/${manifest.id.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}/${skillKey}`,
            slug: declaration.slug ?? skillKey,
            name: declaration.displayName,
            description: declaration.description ?? null,
            markdown: declaration.markdown ?? `# ${declaration.displayName}\n`,
            sourceType: "catalog",
            sourceLocator: null,
            sourceRef: null,
            trustLevel: "markdown_only",
            compatibility: "compatible",
            fileInventory: [{ path: "SKILL.md", kind: "skill" }],
            iconUrl: null,
            color: null,
            tagline: declaration.description?.slice(0, 120) ?? null,
            authorName: null,
            homepageUrl: null,
            categories: [],
            sharingScope: "company",
            publicShareToken: null,
            forkedFromSkillId: null,
            forkedFromCompanyId: null,
            starCount: existing.skill?.starCount ?? 0,
            installCount: existing.skill?.installCount ?? 1,
            forkCount: existing.skill?.forkCount ?? 0,
            currentVersionId: existing.skill?.currentVersionId ?? null,
            metadata: {
              sourceKind: "catalog",
              pluginManagedResource: {
                pluginKey: manifest.id,
                resourceKind: "skill",
                resourceKey: skillKey,
              },
            },
            createdAt: existing.skill?.createdAt ?? now,
            updatedAt: now,
          } satisfies CompanySkill;
          const nowIso = now.toISOString();
          const existingEntity = [...entities.values()].find((entity) =>
            entity.entityType === "managed_resource" &&
            entity.scopeKind === "company" &&
            entity.scopeId === companyId &&
            entity.externalId === `${manifest.id}:skill:${skillKey}`,
          );
          const record: PluginEntityRecord = {
            id: existingEntity?.id ?? randomUUID(),
            entityType: "managed_resource",
            scopeKind: "company",
            scopeId: companyId,
            externalId: `${manifest.id}:skill:${skillKey}`,
            title: declaration.displayName,
            status: null,
            data: { resourceKind: "skill", resourceKey: skillKey, skillId: skill.id, skill },
            createdAt: existingEntity?.createdAt ?? nowIso,
            updatedAt: nowIso,
          };
          entities.set(record.id, record);
          return {
            pluginKey: manifest.id,
            resourceKind: "skill",
            resourceKey: skillKey,
            companyId,
            skillId: skill.id,
            skill,
            status: "reset",
            defaultDrift: null,
          } satisfies PluginManagedSkillResolution;
        },
      },
    },
    companies: {
      async list(input) {
        requireCapability(manifest, capabilitySet, "companies.read");
        let out = [...companies.values()];
        if (input?.offset) out = out.slice(input.offset);
        if (input?.limit) out = out.slice(0, input.limit);
        return out;
      },
      async get(companyId) {
        requireCapability(manifest, capabilitySet, "companies.read");
        return companies.get(companyId) ?? null;
      },
    },
    issues: {
      async list(input) {
        requireCapability(manifest, capabilitySet, "issues.read");
        const companyId = requireCompanyId(input.companyId);
        let out = [...issues.values()].filter((issue) => issue.companyId === companyId);
        if (input.projectId) out = out.filter((issue) => issue.projectId === input.projectId);
        if (input.ownerAgentId) {
          out = out.filter((issue) => issue.ownerAgentId === input.ownerAgentId);
        }
        if (input.status) out = out.filter((issue) => issue.lifecycleStatus === input.status);
        if (input.offset) out = out.slice(input.offset);
        if (input.limit) out = out.slice(0, input.limit);
        return out;
      },
      async get(issueId, companyId) {
        requireCapability(manifest, capabilitySet, "issues.read");
        const issue = issues.get(issueId);
        return isInCompany(issue, companyId) ? issue : null;
      },
      async registerCreatorCallback(registration, handler) {
        requireCapability(manifest, capabilitySet, "issues.create");
        const key = registration.key.trim();
        const version = registration.version.trim();
        if (!key || !version) {
          throw new Error("Creator callback key and version are required");
        }
        const identity = `${key}\u0000${version}`;
        if (pluginCreatorCallbacks.has(identity)) {
          throw new Error(`Creator callback is already registered: ${key}@${version}`);
        }
        pluginCreatorCallbacks.set(identity, handler);
      },
      async create(input) {
        requireCapability(manifest, capabilitySet, "issues.create");
        if (!pluginCreatorCallbacks.has(`${input.callbackKey}\u0000${input.callbackVersion}`)) {
          throw new Error(
            `Creator callback is not registered: ${input.callbackKey}@${input.callbackVersion}`,
          );
        }
        assertInvokableIssueOwner(input.ownerAgentId, input.companyId);
        const now = new Date();
        const title = input.title?.trim()
          || input.request.trim().split(/\r?\n/, 1)[0]?.slice(0, 200)
          || "Plugin request";
        const record: Issue = {
          id: randomUUID(),
          companyId: input.companyId,
          projectId: input.projectId ?? null,
          projectWorkspaceId: null,
          goalId: input.goalId ?? null,
          parentId: input.parentId ?? null,
          title,
          request: input.request,
          lifecycleStatus: "open",
          boardPresentationStatus: "todo",
          workMode: "standard",
          priority: input.priority ?? "medium",
          ownerKind: "agent",
          ownerAgentId: input.ownerAgentId,
          ownerUserId: null,
          ownerAssignmentSource: null,
          ownershipEpoch: 1,
          creatorKind: "plugin",
          creatorAuthorityId: null,
          creatorAdapterConfigRevisionId: null,
          creatorUserId: null,
          creatorPluginInstallationId: pluginInstallationId,
          creatorPluginKey: manifest.id,
          creatorCallbackKey: input.callbackKey,
          creatorCallbackVersion: input.callbackVersion,
          creatorRoutineId: null,
          creatorRoutineDispatchId: null,
          creatorSystemSourceKind: null,
          creatorSystemSourceId: null,
          responsibleUserId: null,
          issueNumber: null,
          identifier: null,
          requestDepth: 0,
          billingCode: null,
          startedAt: null,
          completedAt: null,
          cancelledAt: null,
          hiddenAt: null,
          createdAt: now,
          updatedAt: now,
        };
        issues.set(record.id, record);
        pluginOwnedIssueIds.add(record.id);
        pluginIssueMessages.set(record.id, [input.request]);
        return record;
      },
      async update(issueId, input, companyId) {
        requireCapability(manifest, capabilitySet, "issues.update");
        const record = assertMutablePluginIssue(issueId, companyId);
        if (input.kind === "message") {
          const messages = pluginIssueMessages.get(issueId) ?? [];
          messages.push(input.message);
          pluginIssueMessages.set(issueId, messages);
          const updated = { ...record, updatedAt: new Date() };
          issues.set(issueId, updated);
          return updated;
        }
        assertInvokableIssueOwner(input.ownerAgentId, companyId);
        const updated = {
          ...record,
          ownerKind: "agent" as const,
          ownerAgentId: input.ownerAgentId,
          ownerUserId: null,
          ownerAssignmentSource: null,
          ownershipEpoch: record.ownershipEpoch + 1,
          updatedAt: new Date(),
        };
        issues.set(issueId, updated);
        return updated;
      },
      async withdraw(issueId, message, companyId) {
        requireCapability(manifest, capabilitySet, "issues.withdraw");
        const record = assertMutablePluginIssue(issueId, companyId);
        const messages = pluginIssueMessages.get(issueId) ?? [];
        messages.push(message);
        pluginIssueMessages.set(issueId, messages);
        const now = new Date();
        const issue = {
          ...record,
          lifecycleStatus: "cancelled" as const,
          boardPresentationStatus: "cancelled" as const,
          disposition: { message },
          cancelledAt: now,
          updatedAt: now,
        };
        issues.set(issueId, issue);
        return {
          operationId: randomUUID(),
          issue,
          retried: false,
        };
      },
    },
    agents: {
      async list(input) {
        requireCapability(manifest, capabilitySet, "agents.read");
        const companyId = requireCompanyId(input?.companyId);
        let out = [...agents.values()];
        out = out.filter((agent) => agent.companyId === companyId);
        if (input?.status) out = out.filter((agent) => agent.status === input.status);
        if (input?.offset) out = out.slice(input.offset);
        if (input?.limit) out = out.slice(0, input.limit);
        return out;
      },
      async get(agentId, companyId) {
        requireCapability(manifest, capabilitySet, "agents.read");
        const agent = agents.get(agentId);
        return isInCompany(agent, companyId) ? agent : null;
      },
      async pause(agentId, companyId) {
        requireCapability(manifest, capabilitySet, "agents.pause");
        const cid = requireCompanyId(companyId);
        const agent = agents.get(agentId);
        if (!isInCompany(agent, cid)) throw new Error(`Agent not found: ${agentId}`);
        if (agent!.status === "terminated") throw new Error("Cannot pause terminated agent");
        const updated: Agent = { ...agent!, status: "paused", updatedAt: new Date() };
        agents.set(agentId, updated);
        return updated;
      },
      async resume(agentId, companyId) {
        requireCapability(manifest, capabilitySet, "agents.resume");
        const cid = requireCompanyId(companyId);
        const agent = agents.get(agentId);
        if (!isInCompany(agent, cid)) throw new Error(`Agent not found: ${agentId}`);
        if (agent!.status === "terminated") throw new Error("Cannot resume terminated agent");
        if (agent!.status === "pending_approval") throw new Error("Pending approval agents cannot be resumed");
        const updated: Agent = { ...agent!, status: "idle", updatedAt: new Date() };
        agents.set(agentId, updated);
        return updated;
      },
      managed: {
        async get(agentKey, companyId) {
          requireCapability(manifest, capabilitySet, "agents.managed");
          const cid = requireCompanyId(companyId);
          managedAgentDeclaration(agentKey);
          const agent = managedAgentFor(cid, agentKey);
          return managedResolution(agentKey, cid, agent, agent ? "resolved" : "missing");
        },
        async reconcile(agentKey, companyId) {
          requireCapability(manifest, capabilitySet, "agents.managed");
          const cid = requireCompanyId(companyId);
          const declaration = managedAgentDeclaration(agentKey);
          const existingAgent = managedAgentFor(cid, agentKey);
          const existing = managedResolution(agentKey, cid, existingAgent, existingAgent ? "resolved" : "missing");
          if (existing.agent) return existing;
          const now = new Date();
          const created: Agent = {
            id: randomUUID(),
            companyId: cid,
            name: declaration.displayName,
            urlKey: declaration.displayName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
            title: declaration.title ?? null,
            icon: null,
            status: "idle",
            reportsTo: null,
            capabilities: declaration.capabilities ?? null,
            adapterType: null,
            adapterConfig: null,
            currentAdapterConfigRevisionId: null,
            runtimeConfig: {},
            budgetMonthlyAmount: canonicalizeMoneyAmount("0"),
            knownSpendAmount: canonicalizeMoneyAmount("0"),
            pauseReason: null,
            pausedAt: null,
            instruction: null,
            createdAt: now,
            updatedAt: now,
          };
          agents.set(created.id, created);
          recordManagedAgent(cid, agentKey, created, now);
          return managedResolution(agentKey, cid, created, "created");
        },
        async reset(agentKey, companyId) {
          const resolved = await this.reconcile(agentKey, companyId);
          return resolved.agent
            ? managedResolution(agentKey, resolved.companyId, resolved.agent, "reset")
            : resolved;
        },
      },
    },
    goals: {
      async list(input) {
        requireCapability(manifest, capabilitySet, "goals.read");
        const companyId = requireCompanyId(input?.companyId);
        let out = [...goals.values()];
        out = out.filter((goal) => goal.companyId === companyId);
        if (input?.level) out = out.filter((goal) => goal.level === input.level);
        if (input?.status) out = out.filter((goal) => goal.status === input.status);
        if (input?.offset) out = out.slice(input.offset);
        if (input?.limit) out = out.slice(0, input.limit);
        return out;
      },
      async get(goalId, companyId) {
        requireCapability(manifest, capabilitySet, "goals.read");
        const goal = goals.get(goalId);
        return isInCompany(goal, companyId) ? goal : null;
      },
      async create(input) {
        requireCapability(manifest, capabilitySet, "goals.create");
        const now = new Date();
        const record: Goal = {
          id: randomUUID(),
          companyId: input.companyId,
          title: input.title,
          description: input.description ?? null,
          level: input.level ?? "issue",
          status: input.status ?? "planned",
          parentId: input.parentId ?? null,
          ownerAgentId: input.ownerAgentId ?? null,
          createdAt: now,
          updatedAt: now,
        };
        goals.set(record.id, record);
        return record;
      },
      async update(goalId, patch, companyId) {
        requireCapability(manifest, capabilitySet, "goals.update");
        const record = goals.get(goalId);
        if (!isInCompany(record, companyId)) throw new Error(`Goal not found: ${goalId}`);
        const updated: Goal = {
          ...record,
          ...patch,
          updatedAt: new Date(),
        };
        goals.set(goalId, updated);
        return updated;
      },
    },
    access: {
      members: {
        async list(input) {
          requireCapability(manifest, capabilitySet, "access.members.read");
          const cid = requireCompanyId(input.companyId);
          const includeArchived = input.includeArchived === true;
          return [...accessMembers.values()]
            .filter((member) => member.companyId === cid)
            .filter((member) => includeArchived || member.status !== ("archived" as PluginAccessMember["status"]))
            .map((member) => ({
              ...member,
              grants: getPrincipalGrants(cid, member.principalType, member.principalId),
            }));
        },
        async get(memberId, companyId) {
          requireCapability(manifest, capabilitySet, "access.members.read");
          const cid = requireCompanyId(companyId);
          const member = accessMembers.get(memberId);
          if (!member || member.companyId !== cid) return null;
          return {
            ...member,
            grants: getPrincipalGrants(cid, member.principalType, member.principalId),
          };
        },
        async update(memberId, patch, companyId) {
          requireCapability(manifest, capabilitySet, "access.members.write");
          const cid = requireCompanyId(companyId);
          const member = accessMembers.get(memberId);
          if (!member || member.companyId !== cid) {
            throw new Error(`Membership not found: ${memberId}`);
          }
          const updated: PluginAccessMember = {
            ...member,
            membershipRole: patch.membershipRole === undefined ? member.membershipRole : patch.membershipRole,
            status: patch.status === undefined ? member.status : patch.status,
            updatedAt: new Date().toISOString(),
          };
          accessMembers.set(memberId, updated);
          return {
            ...updated,
            grants: getPrincipalGrants(cid, updated.principalType, updated.principalId),
          };
        },
      },
      invites: {
        async list(input) {
          requireCapability(manifest, capabilitySet, "access.invites.read");
          const companyId = requireCompanyId(input.companyId);
          const now = Date.now();
          const state = (invite: PluginAccessInvite): PluginAccessInvite["state"] => {
            if (invite.revokedAt) return "revoked";
            if (invite.acceptedAt) return "accepted";
            return new Date(invite.expiresAt).getTime() <= now ? "expired" : "active";
          };
          const offset = Math.max(0, input.offset ?? 0);
          const limit = Math.min(100, Math.max(1, input.limit ?? 20));
          const matching = [...accessInvites.values()]
            .filter((invite) => invite.companyId === companyId)
            .map((invite) => ({ ...invite, state: state(invite) }))
            .filter((invite) => input.state === undefined || invite.state === input.state)
            .sort((left, right) =>
              new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()
              || right.id.localeCompare(left.id),
            );
          const invites = matching.slice(offset, offset + limit);
          return {
            invites,
            nextOffset: offset + limit < matching.length ? offset + limit : null,
          };
        },
        async create(input) {
          requireCapability(manifest, capabilitySet, "access.invites.write");
          const companyId = requireCompanyId(input.companyId);
          const allowedJoinTypes = input.allowedJoinTypes ?? "both";
          const humanRole = allowedJoinTypes === "agent"
            ? null
            : input.humanRole ?? "operator";
          const defaultsPayload = { ...(input.defaultsPayload ?? {}) };
          if (humanRole) {
            defaultsPayload.human = {
              ...(defaultsPayload.human && typeof defaultsPayload.human === "object"
                ? defaultsPayload.human as Record<string, unknown>
                : {}),
              role: humanRole,
              grants: grantsForHumanRole(humanRole),
            };
          }
          const agentMessage = input.agentMessage?.trim();
          if (agentMessage) {
            defaultsPayload.agentMessage = agentMessage;
          }
          const now = new Date();
          const invite: PluginAccessInvite = {
            id: randomUUID(),
            companyId,
            inviteType: "company_join",
            allowedJoinTypes,
            defaultsPayload,
            expiresAt: new Date(now.getTime() + 72 * 60 * 60 * 1000).toISOString(),
            source: "plugin_host",
            invitedByUserId: null,
            revokedAt: null,
            acceptedAt: null,
            createdAt: now.toISOString(),
            updatedAt: now.toISOString(),
            state: "active",
          };
          accessInvites.set(invite.id, invite);
          return { ...invite, token: randomUUID() };
        },
        async revoke(inviteId, companyId) {
          requireCapability(manifest, capabilitySet, "access.invites.write");
          const scopedCompanyId = requireCompanyId(companyId);
          const invite = accessInvites.get(inviteId);
          if (!invite || invite.companyId !== scopedCompanyId) {
            throw new Error(`Invite not found: ${inviteId}`);
          }
          if (invite.acceptedAt) throw new Error("Invite already consumed");
          if (invite.revokedAt) return invite;
          const now = new Date().toISOString();
          const revoked: PluginAccessInvite = {
            ...invite,
            revokedAt: now,
            updatedAt: now,
            state: "revoked",
          };
          accessInvites.set(invite.id, revoked);
          return revoked;
        },
      },
    },
    authorization: {
      grants: {
        async list(input) {
          requireCapability(manifest, capabilitySet, "authorization.grants.read");
          const cid = requireCompanyId(input.companyId);
          if (input.principalType && input.principalId) {
            return getPrincipalGrants(cid, input.principalType, input.principalId);
          }
          const out: PrincipalPermissionGrant[] = [];
          for (const [key, grants] of principalGrants.entries()) {
            if (!key.startsWith(`${cid}:`)) continue;
            for (const grant of grants) {
              if (input.principalType && grant.principalType !== input.principalType) continue;
              if (input.principalId && grant.principalId !== input.principalId) continue;
              out.push(grant);
            }
          }
          return out;
        },
        async set(input) {
          requireCapability(manifest, capabilitySet, "authorization.grants.write");
          const cid = requireCompanyId(input.companyId);
          return setPrincipalGrants(cid, input.principalType, input.principalId, input.grants);
        },
      },
      policies: {
        async summary(companyId) {
          requireCapability(manifest, capabilitySet, "authorization.policies.read");
          const cid = requireCompanyId(companyId);
          const members = [...accessMembers.values()].filter((member) => member.companyId === cid);
          let grantCount = 0;
          for (const [key, grants] of principalGrants.entries()) {
            if (key.startsWith(`${cid}:`)) grantCount += grants.length;
          }
          return {
            companyId: cid,
            permissionsMode: "simple",
            memberCount: members.length,
            activeMemberCount: members.filter((member) => member.status === "active").length,
            grantCount,
            advancedPolicyAvailable: false,
          };
        },
        async get(input) {
          requireCapability(manifest, capabilitySet, "authorization.policies.read");
          requireCompanyId(input.companyId);
          return null;
        },
        async update(input) {
          requireCapability(manifest, capabilitySet, "authorization.policies.write");
          const cid = requireCompanyId(input.companyId);
          return {
            companyId: cid,
            resourceType: input.resourceType,
            resourceId: input.resourceId,
            policy: input.policy,
            updatedAt: new Date().toISOString(),
          };
        },
        async previewAssignment(input) {
          requireCapability(manifest, capabilitySet, "authorization.policies.read");
          requireCompanyId(input.companyId);
          return previewTargetAgentManagement(input);
        },
      },
      audit: {
        async search(input) {
          requireCapability(manifest, capabilitySet, "authorization.audit.read");
          requireCompanyId(input.companyId);
          return [];
        },
      },
    },
    data: {
      register(key, handler) {
        if (dataHandlers.has(key)) {
          throw new Error(`Data handler "${key}" is registered more than once`);
        }
        dataHandlers.set(key, handler);
      },
    },
    actions: {
      register(key, handler) {
        if (actionHandlers.has(key)) {
          throw new Error(`Action handler "${key}" is registered more than once`);
        }
        actionHandlers.set(key, handler);
      },
    },
    tools: {
      register(name, handler) {
        requireCapability(manifest, capabilitySet, "agent.tools.register");
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
      async write(name, value, tags) {
        requireCapability(manifest, capabilitySet, "metrics.write");
        metrics.push({ name, value, tags });
      },
    },
    telemetry: {
      async track(eventName, dimensions) {
        requireCapability(manifest, capabilitySet, "telemetry.track");
        telemetry.push({ eventName, dimensions });
      },
    },
    logger: {
      async info(message, meta) {
        logs.push({ level: "info", message, meta });
      },
      async warn(message, meta) {
        logs.push({ level: "warn", message, meta });
      },
      async error(message, meta) {
        logs.push({ level: "error", message, meta });
      },
      async debug(message, meta) {
        logs.push({ level: "debug", message, meta });
      },
    },
  };

  const harness: TestHarness = {
    ctx,
    seed(input) {
      for (const row of input.companies ?? []) companies.set(row.id, row);
      for (const row of input.projects ?? []) projects.set(row.id, row);
      for (const row of input.issues ?? []) {
        issues.set(row.id, row);
        if (row.originKind === `plugin:${manifest.id}`) {
          pluginOwnedIssueIds.add(row.id);
        }
      }
      for (const row of input.agents ?? []) agents.set(row.id, row);
      for (const row of input.goals ?? []) goals.set(row.id, row);
      for (const row of input.accessMembers ?? []) accessMembers.set(row.id, row);
      for (const row of input.principalGrants ?? []) {
        const list = principalGrants.get(principalGrantsKey(row.companyId, row.principalType, row.principalId)) ?? [];
        list.push(row);
        principalGrants.set(principalGrantsKey(row.companyId, row.principalType, row.principalId), list);
      }
    },
    setConfig(config) {
      currentConfig = { ...config };
    },
    async emit(eventType, payload, base) {
      const event: PluginEvent = {
        eventId: base?.eventId ?? randomUUID(),
        eventType,
        companyId: base?.companyId ?? "test-company",
        occurredAt: base?.occurredAt ?? new Date().toISOString(),
        actorId: base?.actorId,
        actorType: base?.actorType,
        entityId: base?.entityId,
        entityType: base?.entityType,
        payload,
      };

      for (const handler of events) {
        const exactMatch = handler.name === event.eventType;
        const wildcardPluginAll = handler.name === "plugin.*" && String(event.eventType).startsWith("plugin.");
        const wildcardPluginOne = String(handler.name).endsWith(".*")
          && String(event.eventType).startsWith(String(handler.name).slice(0, -1));
        if (!exactMatch && !wildcardPluginAll && !wildcardPluginOne) continue;
        if (!pluginEventMatchesFilter(event, handler.filter)) continue;
        await handler.fn(event);
      }
    },
    async runJob(jobKey, partial = {}) {
      const handler = jobs.get(jobKey);
      if (!handler) throw new Error(`No job handler registered for '${jobKey}'`);
      await handler({
        jobKey,
        runId: partial.runId ?? randomUUID(),
        trigger: partial.trigger ?? "manual",
        scheduledAt: partial.scheduledAt ?? new Date().toISOString(),
      });
    },
    async getData<T = unknown>(key: string, params: Record<string, unknown> = {}) {
      const handler = dataHandlers.get(key);
      if (!handler) throw new Error(`No data handler registered for '${key}'`);
      return await handler(params) as T;
    },
    async performAction<T = unknown>(
      key: string,
      params: Record<string, unknown>,
      options: TestHarnessPerformActionOptions,
    ) {
      const context = actionContextFor(options);
      const handler = actionHandlers.get(key);
      if (!handler) throw new Error(`No action handler registered for '${key}'`);
      return await handler(params, context) as T;
    },
    async executeTool<T = ToolResult>(
      name: string,
      params: unknown,
      runContextHandle = "pc_plugin_ctx_v1_test",
    ) {
      const handler = toolHandlers.get(name);
      if (!handler) throw new Error(`No tool handler registered for '${name}'`);
      const ctxToPass: PluginToolRunContext = {
        handle: runContextHandle,
        async resolve() {
          requireCapability(manifest, capabilitySet, "runtime.context.read");
          return {
            companyId: "00000000-0000-4000-8000-000000000001",
            issueId: "00000000-0000-4000-8000-000000000002",
            agentId: "00000000-0000-4000-8000-000000000003",
            runId: "00000000-0000-4000-8000-000000000004",
            projectId: null,
            contextAccess: TEST_CONTEXT_ACCESS,
          };
        },
        async issueReach(issueId) {
          requireCapability(manifest, capabilitySet, "runtime.context.read");
          const activeIssueId = "00000000-0000-4000-8000-000000000002";
          return issueId === activeIssueId
            ? { visible: true, relation: "active" }
            : { visible: false, relation: "outside" };
        },
        issues: {
          async listCompanyIssues() {
            return { items: [], nextCursor: null };
          },
          async listSubIssues() {
            return { items: [], nextCursor: null };
          },
          async readIssueComments() {
            return { items: [], nextCursor: null };
          },
          async readIssueAgentRun() {
            throw new Error(
              "No run-serving issue trace is configured in the plugin test harness",
            );
          },
        },
      };
      return await handler(params, ctxToPass) as T;
    },
    async beforePrompt(plugin, input) {
      requireCapability(manifest, capabilitySet, "runtime.prompt.observe");
      const handler = plugin.definition.onBeforePrompt;
      if (!handler) throw new Error("Plugin does not implement onBeforePrompt");
      return handler(input);
    },
    getState(input) {
      return state.get(stateMapKey(input));
    },
    logs,
    activity,
    metrics,
    telemetry,
    dbQueries,
    dbExecutes,
  };

  return harness;
}
