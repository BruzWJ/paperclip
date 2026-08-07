import type { Db } from "@paperclipai/db";
import {
  activityLog,
  authUsers,
  invites,
  issues as issuesTable,
  pluginLogs,
  principalPermissionGrants,
} from "@paperclipai/db";
import { eq, and, desc, sql, isNull, isNotNull, gt, lte, or } from "drizzle-orm";
import type {
  HostServices,
  HostToWorkerMethods,
  WorkerToHostMethods,
} from "@paperclipai/plugin-sdk";
import { normalizePluginScopeId } from "@paperclipai/plugin-sdk";
import {
  isUuidLike,
  type InviteJoinType,
  type PermissionKey,
  type PrincipalType,
} from "@paperclipai/shared";
import { companyService } from "./companies.js";
import {
  agentService,
  type AgentControlLifecycleService,
} from "./agents.js";
import { projectService, toPublicProject } from "./projects.js";
import { issueService } from "./issues.js";
import { goalService } from "./goals.js";
import { createCompanyInvite } from "./company-invite-creation.js";
import { pluginRegistryService } from "./plugin-registry.js";
import { pluginStateStore } from "./plugin-state-store.js";
import { pluginDatabaseService } from "./plugin-database.js";
import { pluginManagedAgentService } from "./plugin-managed-agents.js";
import { pluginManagedRoutineService } from "./plugin-managed-routines.js";
import { pluginManagedSkillService } from "./plugin-managed-skills.js";
import {
  assertConfiguredLocalFolder,
  assertWritableConfiguredLocalFolder,
  getStoredLocalFolders,
  deletePluginLocalFolderFile,
  inspectPluginLocalFolder,
  listPluginLocalFolderEntries,
  prepareAndInspectPluginLocalFolder,
  preparePluginLocalFolder,
  readPluginLocalFolderText,
  requireLocalFolderDeclaration,
  setStoredLocalFolder,
  writePluginLocalFolderTextAtomic,
} from "./plugin-local-folders.js";
import { logActivity } from "./activity-log.js";
import type { PluginEventBus } from "./plugin-event-bus.js";
import { lookup as dnsLookup } from "node:dns/promises";
import type { IncomingMessage, RequestOptions as HttpRequestOptions } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { logger } from "../middleware/logger.js";
import { getTelemetryClient } from "../telemetry.js";
import { accessService } from "./access.js";
import { authorizationService, type AuthorizationActor } from "./authorization.js";
import { sanitizeRecord } from "../redaction.js";
import {
  assertPluginInstallationRequestScope,
  PluginIssueAuthorizationRejected,
} from "./plugin-issue-authorization.js";
import type { OrdinaryIssueRuntime } from "./ordinary-issue-runtime.js";
import { badRequest } from "../errors.js";

// ---------------------------------------------------------------------------
// SSRF protection for plugin HTTP fetch
// ---------------------------------------------------------------------------

/** Maximum time (ms) a plugin fetch request may take before being aborted. */
const PLUGIN_FETCH_TIMEOUT_MS = 30_000;

/** Maximum response body retained for one managed plugin HTTP request. */
const PLUGIN_FETCH_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/** Maximum time (ms) to wait for a DNS lookup before aborting. */
const DNS_LOOKUP_TIMEOUT_MS = 5_000;

/** Only these protocols are allowed for plugin HTTP requests. */
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);
const TELEMETRY_EVENT_NAME_REGEX = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * Check if an IP address is in a private/reserved range (RFC 1918, loopback,
 * link-local, etc.) that plugins should never be able to reach.
 *
 * Handles IPv4-mapped IPv6 addresses (e.g. ::ffff:127.0.0.1) which Node's
 * dns.lookup may return depending on OS configuration.
 */
function isPrivateIP(ip: string): boolean {
  const lower = ip.toLowerCase();

  // Unwrap IPv4-mapped IPv6 addresses (::ffff:x.x.x.x) and re-check as IPv4
  const v4MappedMatch = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4MappedMatch && v4MappedMatch[1]) return isPrivateIP(v4MappedMatch[1]);

  // IPv4 patterns
  if (ip.startsWith("10.")) return true;
  if (ip.startsWith("172.")) {
    const second = parseInt(ip.split(".")[1]!, 10);
    if (second >= 16 && second <= 31) return true;
  }
  if (ip.startsWith("192.168.")) return true;
  if (ip.startsWith("127.")) return true;                   // loopback
  if (ip.startsWith("169.254.")) return true;               // link-local
  if (ip === "0.0.0.0") return true;

  // IPv6 patterns
  if (lower === "::1") return true;                          // loopback
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA
  if (lower.startsWith("fe80")) return true;                 // link-local
  if (lower === "::") return true;

  return false;
}

/**
 * Validate a URL for plugin fetch: protocol whitelist + private IP blocking.
 *
 * SSRF Prevention Strategy:
 * 1. Parse and validate the URL syntax
 * 2. Enforce protocol whitelist (http/https only)
 * 3. Resolve the hostname to IP(s) via DNS
 * 4. Validate that ALL resolved IPs are non-private
 * 5. Pin the first safe IP into the URL so fetch() does not re-resolve DNS
 *
 * This prevents DNS rebinding attacks where an attacker controls DNS to
 * resolve to a safe IP during validation, then to a private IP when fetch() runs.
 *
 * @returns Request-routing metadata used to connect directly to the resolved IP
 *          while preserving the original hostname for HTTP Host and TLS SNI.
 */
interface ValidatedFetchTarget {
  parsedUrl: URL;
  resolvedAddress: string;
  hostHeader: string;
  tlsServername?: string;
  useTls: boolean;
}

async function validateAndResolveFetchUrl(
  urlString: string,
  options: { allowPrivateNetwork?: boolean } = {},
): Promise<ValidatedFetchTarget> {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new Error(`Invalid URL: ${urlString}`);
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(
      `Disallowed protocol "${parsed.protocol}" — only http: and https: are permitted`,
    );
  }

  // Resolve the hostname to an IP and check for private ranges.
  // We pin the resolved IP into the URL to eliminate the TOCTOU window
  // between DNS resolution here and the second resolution fetch() would do.
  const originalHostname = parsed.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  const hostHeader = parsed.host; // includes port if non-default

  // Race the DNS lookup against a timeout to prevent indefinite hangs
  // when DNS is misconfigured or unresponsive.
  const dnsPromise = dnsLookup(originalHostname, { all: true });
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(
      () => reject(new Error(`DNS lookup timed out after ${DNS_LOOKUP_TIMEOUT_MS}ms for ${originalHostname}`)),
      DNS_LOOKUP_TIMEOUT_MS,
    );
  });

  try {
    const results = await Promise.race([dnsPromise, timeoutPromise]);
    if (results.length === 0) {
      throw new Error(`DNS resolution returned no results for ${originalHostname}`);
    }

    // Filter to only non-private IPs instead of rejecting the entire request
    // when some IPs are private. This handles multi-homed hosts that resolve
    // to both private and public addresses.
    const safeResults = options.allowPrivateNetwork
      ? results
      : results.filter((entry) => !isPrivateIP(entry.address));
    if (safeResults.length === 0) {
      throw new Error(
        `All resolved IPs for ${originalHostname} are in private/reserved ranges`,
      );
    }

    const resolved = safeResults[0]!;
    return {
      parsedUrl: parsed,
      resolvedAddress: resolved.address,
      hostHeader,
      tlsServername: parsed.protocol === "https:" && isIP(originalHostname) === 0
        ? originalHostname
        : undefined,
      useTls: parsed.protocol === "https:",
    };
  } catch (err) {
    // Re-throw our own errors; wrap DNS failures
    if (err instanceof Error && (
      err.message.startsWith("All resolved IPs") ||
      err.message.startsWith("DNS resolution returned") ||
      err.message.startsWith("DNS lookup timed out")
    )) throw err;
    throw new Error(`DNS resolution failed for ${originalHostname}: ${(err as Error).message}`);
  }
}

function buildPinnedRequestOptions(
  target: ValidatedFetchTarget,
  init?: RequestInit,
): { options: HttpRequestOptions & { servername?: string }; body: string | undefined } {
  const headers = new Headers(init?.headers);
  const method = init?.method ?? "GET";
  const body = init?.body === undefined || init?.body === null
    ? undefined
    : typeof init.body === "string"
      ? init.body
      : String(init.body);

  headers.set("Host", target.hostHeader);
  if (body !== undefined && !headers.has("content-length") && !headers.has("transfer-encoding")) {
    headers.set("content-length", String(Buffer.byteLength(body)));
  }

  const pathname = `${target.parsedUrl.pathname}${target.parsedUrl.search}`;
  const auth = target.parsedUrl.username || target.parsedUrl.password
    ? `${decodeURIComponent(target.parsedUrl.username)}:${decodeURIComponent(target.parsedUrl.password)}`
    : undefined;

  return {
    options: {
      protocol: target.parsedUrl.protocol,
      host: target.resolvedAddress,
      port: target.parsedUrl.port
        ? Number(target.parsedUrl.port)
        : target.useTls
          ? 443
          : 80,
      path: pathname,
      method,
      headers: Object.fromEntries(headers.entries()),
      auth,
      servername: target.tlsServername,
    },
    body,
  };
}

async function executePinnedHttpRequest(
  target: ValidatedFetchTarget,
  init: RequestInit | undefined,
  signal: AbortSignal,
): Promise<{ status: number; statusText: string; headers: Record<string, string>; body: string }> {
  const { options, body } = buildPinnedRequestOptions(target, init);

  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const requestFn = target.useTls ? httpsRequest : httpRequest;
    const req = requestFn({ ...options, signal }, resolve);

    req.on("error", reject);

    if (body !== undefined) {
      req.write(body);
    }
    req.end();
  });

  const declaredLength = Number(response.headers["content-length"]);
  if (
    Number.isFinite(declaredLength)
    && declaredLength > PLUGIN_FETCH_MAX_RESPONSE_BYTES
  ) {
    response.destroy();
    throw new Error(
      `Response body exceeded ${PLUGIN_FETCH_MAX_RESPONSE_BYTES} bytes`,
    );
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  await new Promise<void>((resolve, reject) => {
    response.on("data", (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buf.length;
      if (totalBytes > PLUGIN_FETCH_MAX_RESPONSE_BYTES) {
        chunks.length = 0;
        response.destroy(new Error(
          `Response body exceeded ${PLUGIN_FETCH_MAX_RESPONSE_BYTES} bytes`,
        ));
        return;
      }
      chunks.push(buf);
    });
    response.on("end", resolve);
    response.on("error", reject);
  });

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(response.headers)) {
    if (Array.isArray(value)) {
      headers[key] = value.join(", ");
    } else if (value !== undefined) {
      headers[key] = value;
    }
  }

  return {
    status: response.statusCode ?? 500,
    statusText: response.statusMessage ?? "",
    headers,
    body: Buffer.concat(chunks).toString("utf8"),
  };
}

/** Max length for a single plugin log message (bytes/chars). */
const MAX_LOG_MESSAGE_LENGTH = 10_000;

/** Max serialised JSON size for plugin log meta objects. */
const MAX_LOG_META_JSON_LENGTH = 50_000;

/** Max length for a metric name. */
const MAX_METRIC_NAME_LENGTH = 500;

/** Pino reserved field names that plugins must not overwrite. */
const PINO_RESERVED_KEYS = new Set([
  "level",
  "time",
  "pid",
  "hostname",
  "msg",
  "v",
]);

/** Truncate a string to `max` characters, appending a marker if truncated. */
function truncStr(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "...[truncated]";
}

/** Sanitise a plugin-supplied meta object: enforce size limit and strip reserved keys. */
function sanitiseMeta(meta: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (meta == null) return null;
  // Strip pino reserved keys
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (!PINO_RESERVED_KEYS.has(k)) {
      cleaned[k] = v;
    }
  }
  // Enforce total serialised size
  let json: string;
  try {
    json = JSON.stringify(cleaned);
  } catch {
    return { _sanitised: true, _error: "meta was not JSON-serialisable" };
  }
  if (json.length > MAX_LOG_META_JSON_LENGTH) {
    return { _sanitised: true, _error: `meta exceeded ${MAX_LOG_META_JSON_LENGTH} chars` };
  }
  return cleaned;
}

/**
 * buildHostServices — creates a concrete implementation of the `HostServices`
 * interface for a specific plugin.
 *
 * This implementation delegates to the core Paperclip domain services,
 * providing the bridge between the plugin worker's SDK and the host platform.
 *
 * @param db - Database connection instance.
 * @param pluginId - The UUID of the plugin installation record.
 * @param eventBus - The system-wide event bus for publishing plugin events.
 * @returns An object implementing the HostServices interface for the plugin SDK.
 */
type PluginIssueInstallationContext = {
  pluginInstallationId: string;
  pluginKey: string;
};

type PluginIssueMutationContext = PluginIssueInstallationContext & {
  hostRpcOperationId: string;
};

/**
 * Canonical installation-bound issue control plane. There is intentionally no
 * direct issue-service fallback: an unconfigured host fails closed instead of
 * bypassing issue ownership, creator, Session, or idempotency invariants.
 */
export interface PluginIssueControlPlane {
  list(
    params: WorkerToHostMethods["issues.list"][0] & PluginIssueInstallationContext,
  ): Promise<WorkerToHostMethods["issues.list"][1]>;
  get(
    params: WorkerToHostMethods["issues.get"][0] & PluginIssueInstallationContext,
  ): Promise<WorkerToHostMethods["issues.get"][1]>;
  create(
    params: WorkerToHostMethods["issues.create"][0]
      & PluginIssueMutationContext
      & { callbackRegistrationActive: true },
  ): Promise<WorkerToHostMethods["issues.create"][1]>;
  update(
    params: WorkerToHostMethods["issues.update"][0] & PluginIssueMutationContext,
  ): Promise<WorkerToHostMethods["issues.update"][1]>;
  withdraw(
    params: WorkerToHostMethods["issues.withdraw"][0] & PluginIssueMutationContext,
  ): Promise<WorkerToHostMethods["issues.withdraw"][1]>;
}

export interface PluginRunIssueContextReader {
  resolveContext(
    params: WorkerToHostMethods["run.context.resolve"][0]
      & PluginIssueInstallationContext,
  ): Promise<WorkerToHostMethods["run.context.resolve"][1]>;
  issueReach(
    params: WorkerToHostMethods["run.context.issueReach"][0]
      & PluginIssueInstallationContext,
  ): Promise<WorkerToHostMethods["run.context.issueReach"][1]>;
  listCompanyIssues(
    params: WorkerToHostMethods["run.issues.listCompanyIssues"][0]
      & PluginIssueInstallationContext,
  ): Promise<WorkerToHostMethods["run.issues.listCompanyIssues"][1]>;
  listSubIssues(
    params: WorkerToHostMethods["run.issues.listSubIssues"][0]
      & PluginIssueInstallationContext,
  ): Promise<WorkerToHostMethods["run.issues.listSubIssues"][1]>;
  readIssueComments(
    params: WorkerToHostMethods["run.issues.readIssueComments"][0]
      & PluginIssueInstallationContext,
  ): Promise<WorkerToHostMethods["run.issues.readIssueComments"][1]>;
  readIssueAgentRun(
    params: WorkerToHostMethods["run.issues.readIssueAgentRun"][0]
      & PluginIssueInstallationContext,
  ): Promise<WorkerToHostMethods["run.issues.readIssueAgentRun"][1]>;
}

export interface PluginRuntimeRecordsReader {
  readSession(
    params: WorkerToHostMethods["runtime.records.readSession"][0]
      & PluginIssueInstallationContext,
  ): Promise<WorkerToHostMethods["runtime.records.readSession"][1]>;
  readRun(
    params: WorkerToHostMethods["runtime.records.readRun"][0]
      & PluginIssueInstallationContext,
  ): Promise<WorkerToHostMethods["runtime.records.readRun"][1]>;
  readIssueComments(
    params: WorkerToHostMethods["runtime.records.readIssueComments"][0]
      & PluginIssueInstallationContext,
  ): Promise<WorkerToHostMethods["runtime.records.readIssueComments"][1]>;
}

export interface PluginHostServicesOptions {
  manifest: import("@paperclipai/shared").PaperclipPluginManifestV1;
  pluginIssueControlPlane: PluginIssueControlPlane;
  pluginRunIssueContextReader: PluginRunIssueContextReader;
  pluginRuntimeRecordsReader: PluginRuntimeRecordsReader;
  ordinaryIssues: OrdinaryIssueRuntime;
  issueExecutionCancellation: AgentControlLifecycleService;
}

export function buildHostServices(
  db: Db,
  pluginId: string,
  eventBus: PluginEventBus,
  deliverEvent: (params: HostToWorkerMethods["onEvent"][0]) => Promise<void>,
  options: PluginHostServicesOptions,
): HostServices & { dispose(): Promise<void> } {
  const pluginKey = options.manifest.id;
  const registry = pluginRegistryService(db);
  const stateStore = pluginStateStore(db);
  const pluginDb = pluginDatabaseService(db);
  const companies = companyService(db);
  const agents = agentService(db);
  const managedAgents = pluginManagedAgentService(db, {
    pluginId,
    manifest: options.manifest,
  });
  const managedRoutines = pluginManagedRoutineService(db, {
    pluginId,
    manifest: options.manifest,
    ordinaryIssues: options.ordinaryIssues,
  });
  const managedSkills = pluginManagedSkillService(db, {
    pluginId,
    manifest: options.manifest,
  });
  const registeredCreatorCallbacks = new Set<string>();
  const projects = projectService(db);
  const issues = issueService(db);
  const goals = goalService(db);
  const access = accessService(db);
  const authorization = authorizationService(db);
  const scopedBus = eventBus.forPlugin(pluginKey);

  const pluginIssueRuntime = options.pluginIssueControlPlane;

  const toPluginEntityRecord = (
    entity: NonNullable<Awaited<ReturnType<typeof registry.upsertEntity>>>,
  ): WorkerToHostMethods["entities.upsert"][1] => ({
    id: entity.id,
    entityType: entity.entityType,
    scopeKind: entity.scopeKind,
    scopeId: entity.scopeId,
    externalId: entity.externalId,
    title: entity.title,
    status: entity.status,
    data: entity.data,
    createdAt: entity.createdAt.toISOString(),
    updatedAt: entity.updatedAt.toISOString(),
  });

  const ensureCompanyId = (companyId?: string) => {
    if (!companyId) throw new Error("companyId is required for this operation");
    return companyId;
  };

  const parseWindowValue = (value: unknown): number | null => {
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.max(0, Math.floor(value));
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return Math.max(0, Math.floor(parsed));
      }
    }
    return null;
  };

  const applyWindow = <T>(rows: T[], params?: { limit?: unknown; offset?: unknown }): T[] => {
    const offset = parseWindowValue(params?.offset) ?? 0;
    const limit = parseWindowValue(params?.limit);
    if (limit == null) return rows.slice(offset);
    return rows.slice(offset, offset + limit);
  };

  const authorizationAuditDecisionCondition = (decisionFilter: string) => {
    const conditions = [
      sql`lower(${activityLog.details}->>'decision') = ${decisionFilter}`,
      decisionFilter === "allow" ? sql`left(coalesce(${activityLog.details}->>'reason', ''), 6) = 'allow_'` : undefined,
      decisionFilter === "deny" ? sql`left(coalesce(${activityLog.details}->>'reason', ''), 5) = 'deny_'` : undefined,
      decisionFilter === "allow" ? sql`${activityLog.details}->>'allowed' = 'true'` : undefined,
      decisionFilter === "deny" ? sql`${activityLog.details}->>'allowed' = 'false'` : undefined,
    ].filter((condition): condition is NonNullable<typeof condition> => Boolean(condition));
    return sql`(${sql.join(conditions, sql` OR `)})`;
  };

  const ensurePluginAvailableForCompany = async (companyId: string) => {
    await assertPluginInstallationRequestScope(db, {
      companyId,
      pluginInstallationId: pluginId,
      pluginKey,
    });
  };

  const deliverSubscribedEvent = async (
    event: import("@paperclipai/plugin-sdk").PluginEvent,
  ) => {
    if (event.companyId) {
      try {
        await ensurePluginAvailableForCompany(event.companyId);
      } catch (error) {
        if (error instanceof PluginIssueAuthorizationRejected) return;
        throw error;
      }
    }
    await deliverEvent({ event });
  };

  const getLocalFolderDeclaration = (folderKey: string) =>
    requireLocalFolderDeclaration(options.manifest.localFolders ?? [], folderKey);

  const getStoredLocalFolderConfig = async (companyId: string, folderKey: string) => {
    ensureCompanyId(companyId);
    await ensurePluginAvailableForCompany(companyId);
    const settings = await registry.getCompanySettings(pluginId, companyId);
    return getStoredLocalFolders(settings?.settingsJson)[folderKey] ?? null;
  };

  const inspectStoredLocalFolder = async (companyId: string, folderKey: string) => {
    const declaration = getLocalFolderDeclaration(folderKey);
    const stored = await getStoredLocalFolderConfig(companyId, folderKey);
    return inspectPluginLocalFolder({ declaration, path: stored?.path ?? null });
  };

  const inCompany = <T extends { companyId: string | null | undefined }>(
    record: T | null | undefined,
    companyId: string,
  ): record is T => Boolean(record && record.companyId === companyId);

  const requireInCompany = <T extends { companyId: string | null | undefined }>(
    entityName: string,
    record: T | null | undefined,
    companyId: string,
  ): T => {
    if (!inCompany(record, companyId)) {
      throw new Error(`${entityName} not found`);
    }
    return record;
  };

  const pluginActivityDetails = (
    details: Record<string, unknown> | null | undefined,
    actor?: { actorAgentId?: string | null; actorUserId?: string | null; actorRunId?: string | null },
  ) => {
    const initiatingActorType = actor?.actorAgentId ? "agent" : actor?.actorUserId ? "user" : null;
    const initiatingActorId = actor?.actorAgentId ?? actor?.actorUserId ?? null;
    return {
      ...(details ?? {}),
      sourcePluginId: pluginId,
      sourcePluginKey: pluginKey,
      initiatingActorType,
      initiatingActorId,
      initiatingAgentId: actor?.actorAgentId ?? null,
      initiatingUserId: actor?.actorUserId ?? null,
      initiatingRunId: actor?.actorRunId ?? null,
    };
  };

  const logPluginActivity = async (input: {
    companyId: string;
    action: string;
    entityType: string;
    entityId: string;
    details?: Record<string, unknown> | null;
    actor?: { actorAgentId?: string | null; actorUserId?: string | null; actorRunId?: string | null };
  }) => {
    await logActivity(db, {
      companyId: input.companyId,
      actorType: "plugin",
      actorId: pluginId,
      agentId: input.actor?.actorAgentId ?? null,
      runId: input.actor?.actorRunId ?? null,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      details: pluginActivityDetails(input.details, input.actor),
    });
  };

  const inviteState = (invite: typeof invites.$inferSelect) => {
    if (invite.revokedAt) return "revoked" as const;
    if (invite.acceptedAt) return "accepted" as const;
    if (invite.expiresAt <= new Date()) return "expired" as const;
    return "active" as const;
  };

  const redactInvite = (invite: typeof invites.$inferSelect) => {
    const { tokenHash: _tokenHash, defaultsPayload, ...safeInvite } = invite;
    return {
      ...safeInvite,
      allowedJoinTypes: safeInvite.allowedJoinTypes as InviteJoinType,
      defaultsPayload: defaultsPayload && typeof defaultsPayload === "object"
        ? sanitizeRecord(defaultsPayload)
        : defaultsPayload ?? null,
      state: inviteState(invite),
    };
  };

  const inviteStateWhereClause = (state: unknown) => {
    const now = new Date();
    switch (state) {
      case "active":
        return and(isNull(invites.revokedAt), isNull(invites.acceptedAt), gt(invites.expiresAt, now));
      case "accepted":
        return isNotNull(invites.acceptedAt);
      case "expired":
        return and(isNull(invites.revokedAt), isNull(invites.acceptedAt), lte(invites.expiresAt, now));
      case "revoked":
        return isNotNull(invites.revokedAt);
      default:
        return undefined;
    }
  };

  type StoredGrant = typeof principalPermissionGrants.$inferSelect;
  type PublicGrant = Omit<StoredGrant, "principalUserId" | "principalAgentId"> & {
    principalId: string;
  };
  const redactGrant = (grant: StoredGrant | PublicGrant) => {
    const principalId = "principalId" in grant
      ? grant.principalId
      : grant.principalType === "user"
        ? grant.principalUserId
        : grant.principalAgentId;
    if (!principalId) {
      throw new Error(`Invalid ${grant.principalType} permission grant ${grant.id}`);
    }
    const {
      principalUserId: _principalUserId,
      principalAgentId: _principalAgentId,
      ...stored
    } = grant as StoredGrant & { principalId?: string };
    return {
      ...stored,
      principalId,
      principalType: grant.principalType as PrincipalType,
      permissionKey: grant.permissionKey as PermissionKey,
      scope: grant.scope && typeof grant.scope === "object"
        ? sanitizeRecord(grant.scope)
        : grant.scope ?? null,
    };
  };

  const loadPluginMember = async (companyId: string, memberId: string) => {
    const member = await access.getMemberById(companyId, memberId);
    if (!member) return null;
    const grants = await access.listPrincipalGrants(
      companyId,
      member.principalType as PrincipalType,
      member.principalId,
    );
    return {
      ...member,
      principalType: member.principalType as PrincipalType,
      status: member.status as "pending" | "active" | "suspended" | "archived",
      grants: grants.map(redactGrant),
    };
  };

  const resolvePluginTargetManagementSubject = async (
    subject:
      | { type: "user"; userId: string }
      | { type: "agent"; agentId: string },
  ): Promise<AuthorizationActor> => {
    if (subject.type === "agent") {
      const persistedAgent = await agents.getById(subject.agentId);
      if (!persistedAgent) {
        return { type: "none", source: "none" };
      }
      return {
        type: "agent",
        agentId: persistedAgent.id,
        companyId: persistedAgent.companyId,
        source: "internal",
      };
    }
    const persistedUser = await db
      .select({ id: authUsers.id })
      .from(authUsers)
      .where(eq(authUsers.id, subject.userId))
      .then((rows) => rows[0] ?? null);
    if (!persistedUser) {
      return { type: "none", source: "none" };
    }
    return {
      type: "board",
      userId: persistedUser.id,
    };
  };

  const policyPathForResource = (resourceType: "company" | "agent" | "issue") => {
    switch (resourceType) {
      case "agent":
        return { table: "agent" as const };
      case "issue":
        return { table: "issue" as const };
      case "company":
        return { table: "company" as const };
    }
  };

  const readAuthorizationPolicy = async (companyId: string, resourceType: "company" | "agent" | "issue", resourceId: string) => {
    const pathInfo = policyPathForResource(resourceType);
    if (pathInfo.table === "agent") {
      const agent = await agents.getById(resourceId);
      if (!inCompany(agent, companyId)) return null;
      const governance =
        agent.governance && typeof agent.governance === "object"
          ? agent.governance as Record<string, unknown>
          : {};
      return {
        resourceType,
        resourceId,
        companyId,
        policy: governance.authorizationPolicy && typeof governance.authorizationPolicy === "object"
          ? sanitizeRecord(governance.authorizationPolicy as Record<string, unknown>)
          : null,
        updatedAt: agent.updatedAt,
      };
    }
    if (pathInfo.table === "issue") {
      const issue = await issues.getById(resourceId);
      if (!inCompany(issue, companyId)) return null;
      const policy = issue.executionPolicy && typeof issue.executionPolicy === "object"
        ? (issue.executionPolicy as Record<string, unknown>).authorizationPolicy
        : null;
      return {
        resourceType,
        resourceId,
        companyId,
        policy: policy && typeof policy === "object" ? sanitizeRecord(policy as Record<string, unknown>) : null,
        updatedAt: issue.updatedAt,
      };
    }
    const company = await companies.getById(resourceId);
    if (!company || company.id !== companyId) return null;
    return { resourceType, resourceId, companyId, policy: null, updatedAt: company.updatedAt };
  };

  return {
    config: {
      async get() {
        const configRow = await registry.getConfig(pluginId);
        return configRow?.configJson ?? {};
      },
    },

    localFolders: {
      async configure(params) {
        if (
          typeof params !== "object"
          || params === null
          || Array.isArray(params)
          || Object.keys(params).some((key) => key !== "companyId" && key !== "folderKey" && key !== "path")
          || typeof params.path !== "string"
          || params.path.trim().length === 0
        ) {
          throw badRequest("Local folder configuration accepts only companyId, folderKey, and a non-empty path");
        }
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        const declaration = getLocalFolderDeclaration(params.folderKey);
        const existing = await registry.getCompanySettings(pluginId, companyId);
        const status = await prepareAndInspectPluginLocalFolder({
          declaration,
          path: params.path,
        });

        const nextSettings = setStoredLocalFolder(existing?.settingsJson, params.folderKey, params.path);
        await registry.upsertCompanySettings(pluginId, companyId, {
          settingsJson: nextSettings,
        });
        return status;
      },

      async status(params) {
        return inspectStoredLocalFolder(params.companyId, params.folderKey);
      },

      async list(params) {
        const status = await inspectStoredLocalFolder(params.companyId, params.folderKey);
        assertConfiguredLocalFolder(status);
        const listing = await listPluginLocalFolderEntries(status.realPath!, {
          relativePath: params.relativePath,
          recursive: params.recursive,
          maxEntries: params.maxEntries,
        });
        return { ...listing, folderKey: params.folderKey };
      },

      async readText(params) {
        const status = await inspectStoredLocalFolder(params.companyId, params.folderKey);
        assertConfiguredLocalFolder(status);
        return readPluginLocalFolderText(status.realPath!, params.relativePath);
      },

      async writeTextAtomic(params) {
        const companyId = ensureCompanyId(params.companyId);
        const declaration = getLocalFolderDeclaration(params.folderKey);
        const stored = await getStoredLocalFolderConfig(companyId, params.folderKey);
        if (stored) {
          await preparePluginLocalFolder({
            declaration,
            path: stored.path,
          });
        }
        const status = await inspectPluginLocalFolder({
          declaration,
          path: stored?.path ?? null,
        });
        assertWritableConfiguredLocalFolder(status);
        await writePluginLocalFolderTextAtomic(status.realPath!, params.relativePath, params.contents);
        return inspectPluginLocalFolder({ declaration, path: stored!.path });
      },

      async deleteFile(params) {
        const companyId = ensureCompanyId(params.companyId);
        const declaration = getLocalFolderDeclaration(params.folderKey);
        const stored = await getStoredLocalFolderConfig(companyId, params.folderKey);
        const status = await inspectPluginLocalFolder({
          declaration,
          path: stored?.path ?? null,
        });
        assertWritableConfiguredLocalFolder(status);
        await deletePluginLocalFolderFile(status.realPath!, params.relativePath);
        return inspectPluginLocalFolder({ declaration, path: stored!.path });
      },
    },

    state: {
      async get(params) {
        const scopeId = normalizePluginScopeId(params.scopeKind, params.scopeId);
        if (params.scopeKind === "company") await ensurePluginAvailableForCompany(scopeId!);
        return stateStore.get(pluginId, params.scopeKind, params.stateKey, {
          scopeId: scopeId ?? undefined,
          namespace: params.namespace,
        });
      },
      async set(params) {
        const scopeId = normalizePluginScopeId(params.scopeKind, params.scopeId);
        if (params.scopeKind === "company") await ensurePluginAvailableForCompany(scopeId!);
        await stateStore.set(pluginId, params);
      },
      async delete(params) {
        const scopeId = normalizePluginScopeId(params.scopeKind, params.scopeId);
        if (params.scopeKind === "company") await ensurePluginAvailableForCompany(scopeId!);
        await stateStore.delete(pluginId, params.scopeKind, params.stateKey, {
          scopeId: scopeId ?? undefined,
          namespace: params.namespace,
        });
      },
    },

    db: {
      async query(params) {
        return pluginDb.query(pluginId, params.sql, params.params);
      },
      async execute(params) {
        return pluginDb.execute(pluginId, params.sql, params.params);
      },
    },

    entities: {
      async upsert(params) {
        const scopeId = normalizePluginScopeId(params.scopeKind, params.scopeId);
        const companyId = params.scopeKind === "company" ? scopeId : null;
        if (companyId) await ensurePluginAvailableForCompany(companyId);
        const entity = await registry.upsertEntity(pluginId, {
          ...params,
          companyId,
        });
        return toPluginEntityRecord(entity);
      },
      async list(params) {
        if (params.scopeId !== undefined && params.scopeKind === undefined) {
          throw new Error("Plugin entity scopeId requires scopeKind");
        }
        if (params.scopeKind !== undefined) {
          const scopeId = normalizePluginScopeId(params.scopeKind, params.scopeId);
          if (params.scopeKind === "company") await ensurePluginAvailableForCompany(scopeId!);
        }
        const entities = await registry.listEntities(pluginId, params);
        return entities.map(toPluginEntityRecord);
      },
    },

    events: {
      async emit(params) {
        if (params.companyId) {
          await ensurePluginAvailableForCompany(params.companyId);
        }
        const { errors } = await scopedBus.emit(
          params.name,
          params.companyId,
          params.payload,
        );
        for (const { pluginId: subscriberPluginId, error } of errors) {
          logger.warn(
            {
              pluginId: subscriberPluginId,
              sourcePluginId: pluginId,
              eventName: params.name,
              err: error,
            },
            "plugin event handler failed",
          );
        }
      },
      async subscribe(params) {
        if (params.filter) {
          scopedBus.subscribe(
            params.eventPattern,
            params.filter,
            deliverSubscribedEvent,
          );
        } else {
          scopedBus.subscribe(params.eventPattern, deliverSubscribedEvent);
        }
      },
    },

    http: {
      async fetch(params) {
        // SSRF protection: validate protocol whitelist + block private IPs.
        // Resolve once, then connect directly to that IP to prevent DNS rebinding.
        const target = await validateAndResolveFetchUrl(params.url, {
          allowPrivateNetwork:
            options.manifest.capabilities.includes("http.private-network"),
        });

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), PLUGIN_FETCH_TIMEOUT_MS);

        try {
          const init = params.init as RequestInit | undefined;
          return await executePinnedHttpRequest(target, init, controller.signal);
        } finally {
          clearTimeout(timeout);
        }
      },
    },

    runtimeRecords: {
      async readSession(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        return options.pluginRuntimeRecordsReader.readSession({
          ...params,
          companyId,
          pluginInstallationId: pluginId,
          pluginKey,
        });
      },
      async readRun(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        return options.pluginRuntimeRecordsReader.readRun({
          ...params,
          companyId,
          pluginInstallationId: pluginId,
          pluginKey,
        });
      },
      async readIssueComments(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        return options.pluginRuntimeRecordsReader.readIssueComments({
          ...params,
          companyId,
          pluginInstallationId: pluginId,
          pluginKey,
        });
      },
    },

    activity: {
      async log(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        await logActivity(db, {
          companyId,
          actorType: "plugin",
          actorId: pluginId,
          action: "activity.logged",
          entityType: params.entityType ?? "plugin",
          entityId: params.entityId ?? pluginId,
          details: pluginActivityDetails({
            ...(params.metadata ?? {}),
            message: params.message,
          }),
        });
      },
    },

    metrics: {
      async write(params) {
        const safeName = truncStr(String(params.name ?? ""), MAX_METRIC_NAME_LENGTH);
        logger.debug({ pluginId, name: safeName, value: params.value, tags: params.tags }, "Plugin metric write");

        // The RPC acknowledgement follows the durable write. Using level
        // "metric" keeps metrics queryable through the same operator surface.
        await db.insert(pluginLogs).values({
          pluginId,
          companyId: params.companyId ?? null,
          level: "metric",
          message: safeName,
          meta: sanitiseMeta({ value: params.value, tags: params.tags ?? null }),
        });
      },
    },

    telemetry: {
      async track(params) {
        const eventName = String(params.eventName ?? "").trim();
        if (!TELEMETRY_EVENT_NAME_REGEX.test(eventName)) {
          throw new Error(
            'Plugin telemetry event names must be lowercase slugs using letters, numbers, "_" or "-".',
          );
        }
        const telemetryClient = getTelemetryClient();
        if (!telemetryClient) return;
        telemetryClient.trackDynamic(`plugin.${pluginKey}.${eventName}`, params.dimensions);
      },
    },

    logger: {
      async log(params) {
        const { level, meta } = params;
        const safeMessage = truncStr(String(params.message ?? ""), MAX_LOG_MESSAGE_LENGTH);
        const safeMeta = sanitiseMeta(meta);
        const pluginLogger = logger.child({ service: "plugin-worker", pluginId });
        const logFields = {
          ...safeMeta,
          pluginLogLevel: level,
          pluginTimestamp: new Date().toISOString(),
        };

        if (level === "error") pluginLogger.error(logFields, `[plugin] ${safeMessage}`);
        else if (level === "warn") pluginLogger.warn(logFields, `[plugin] ${safeMessage}`);
        else if (level === "debug") pluginLogger.debug(logFields, `[plugin] ${safeMessage}`);
        else pluginLogger.info(logFields, `[plugin] ${safeMessage}`);

        // A worker log request is acknowledged only after its row is durable.
        await db.insert(pluginLogs).values({
          pluginId,
          companyId: params.companyId ?? null,
          level,
          message: safeMessage,
          meta: safeMeta,
        });
      },
    },

    companies: {
      async list(params) {
        return applyWindow(await companies.list(), params);
      },
      async get(params) {
        await ensurePluginAvailableForCompany(params.companyId);
        return companies.getById(params.companyId);
      },
    },

    projects: {
      async list(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        return applyWindow(
          (await projects.list(companyId)).map((project) => toPublicProject(project)),
          params,
        );
      },
      async get(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        const project = await projects.getById(params.projectId);
        return inCompany(project, companyId) ? toPublicProject(project) : null;
      },
      async getManaged(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        return projects.resolveManagedProject({
          companyId,
          pluginId,
          pluginKey,
          projectKey: params.projectKey,
          createIfMissing: false,
        });
      },
      async reconcileManaged(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        return projects.resolveManagedProject({
          companyId,
          pluginId,
          pluginKey,
          projectKey: params.projectKey,
        });
      },
      async resetManaged(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        return projects.resolveManagedProject({
          companyId,
          pluginId,
          pluginKey,
          projectKey: params.projectKey,
          reset: true,
        });
      },
    },

    routines: {
      async managedGet(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        return managedRoutines.get(params.routineKey, companyId);
      },
      async managedReconcile(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        return managedRoutines.reconcile(params.routineKey, companyId, {
          assigneeAgentId: params.assigneeAgentId,
          projectId: params.projectId,
        });
      },
      async managedReset(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        return managedRoutines.reset(params.routineKey, companyId, {
          assigneeAgentId: params.assigneeAgentId,
          projectId: params.projectId,
        });
      },
      async managedUpdate(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        return managedRoutines.update(params.routineKey, companyId, {
          status: params.status,
        });
      },
      async managedRun(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        return managedRoutines.run(params.routineKey, companyId, {
          assigneeAgentId: params.assigneeAgentId,
          projectId: params.projectId,
        });
      },
    },

    skills: {
      async managedGet(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        return managedSkills.get(params.skillKey, companyId);
      },
      async managedReconcile(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        return managedSkills.reconcile(params.skillKey, companyId);
      },
      async managedReset(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        return managedSkills.reset(params.skillKey, companyId);
      },
    },

    issues: {
      async list(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        return pluginIssueRuntime.list({
          ...params,
          companyId,
          pluginInstallationId: pluginId,
          pluginKey,
        });
      },
      async get(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        return pluginIssueRuntime.get({
          ...params,
          companyId,
          pluginInstallationId: pluginId,
          pluginKey,
        });
      },
      async registerCreatorCallback(params) {
        const callbackKey = params.callbackKey.trim();
        const callbackVersion = params.callbackVersion.trim();
        if (!callbackKey || !callbackVersion) {
          throw new Error("Creator callback key and version are required");
        }
        registeredCreatorCallbacks.add(`${callbackKey}\u0000${callbackVersion}`);
        return {
          callbackKey,
          callbackVersion,
          registered: true as const,
        };
      },
      async create(params, operation) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        if (
          !registeredCreatorCallbacks.has(
            `${params.callbackKey}\u0000${params.callbackVersion}`,
          )
        ) {
          throw new Error(
            `Creator callback is not registered: ${params.callbackKey}@${params.callbackVersion}`,
          );
        }
        return pluginIssueRuntime.create({
          ...params,
          companyId,
          pluginInstallationId: pluginId,
          pluginKey,
          hostRpcOperationId: operation.hostRpcOperationId,
          callbackRegistrationActive: true,
        });
      },
      async update(params, operation) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        return pluginIssueRuntime.update({
          ...params,
          companyId,
          pluginInstallationId: pluginId,
          pluginKey,
          hostRpcOperationId: operation.hostRpcOperationId,
        });
      },
      async withdraw(params, operation) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        return pluginIssueRuntime.withdraw({
          ...params,
          companyId,
          pluginInstallationId: pluginId,
          pluginKey,
          hostRpcOperationId: operation.hostRpcOperationId,
        });
      },
    },

    runIssues: {
      async resolveContext(params) {
        return options.pluginRunIssueContextReader.resolveContext({
          ...params,
          pluginInstallationId: pluginId,
          pluginKey,
        });
      },
      async issueReach(params) {
        return options.pluginRunIssueContextReader.issueReach({
          ...params,
          pluginInstallationId: pluginId,
          pluginKey,
        });
      },
      async listCompanyIssues(params) {
        return options.pluginRunIssueContextReader.listCompanyIssues({
          ...params,
          pluginInstallationId: pluginId,
          pluginKey,
        });
      },
      async listSubIssues(params) {
        return options.pluginRunIssueContextReader.listSubIssues({
          ...params,
          pluginInstallationId: pluginId,
          pluginKey,
        });
      },
      async readIssueComments(params) {
        return options.pluginRunIssueContextReader.readIssueComments({
          ...params,
          pluginInstallationId: pluginId,
          pluginKey,
        });
      },
      async readIssueAgentRun(params) {
        return options.pluginRunIssueContextReader.readIssueAgentRun({
          ...params,
          pluginInstallationId: pluginId,
          pluginKey,
        });
      },
    },

    agents: {
      async list(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        const rows = await agents.list(companyId);
        return applyWindow(
          rows.filter((agent) => !params.status || agent.status === params.status),
          params,
        );
      },
      async get(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        const agent = await agents.getById(params.agentId);
        return inCompany(agent, companyId) ? agent : null;
      },
      async pause(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        const agent = await agents.getById(params.agentId);
        requireInCompany("Agent", agent, companyId);
        const updated = await agents.pause(params.agentId, {
          actor: { kind: "system" },
          issueExecutionCancellation: options.issueExecutionCancellation,
        });
        if (!updated) throw new Error("Agent not found after pause");
        return updated;
      },
      async resume(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        const agent = await agents.getById(params.agentId);
        requireInCompany("Agent", agent, companyId);
        const updated = await agents.resume(
          params.agentId,
          options.issueExecutionCancellation,
        );
        if (!updated) throw new Error("Agent not found after resume");
        return updated;
      },
      async managedGet(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        return managedAgents.get(params.agentKey, companyId);
      },
      async managedReconcile(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        return managedAgents.reconcile(params.agentKey, companyId);
      },
      async managedReset(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        return managedAgents.reset(params.agentKey, companyId);
      },
    },

    goals: {
      async list(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        const rows = await goals.list(companyId);
        return applyWindow(
          rows.filter((goal) =>
            (!params.level || goal.level === params.level) &&
            (!params.status || goal.status === params.status),
          ),
          params,
        );
      },
      async get(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        const goal = await goals.getById(params.goalId);
        return inCompany(goal, companyId) ? goal : null;
      },
      async create(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        return goals.create(companyId, {
          title: params.title,
          description: params.description,
          level: params.level,
          status: params.status,
          parentId: params.parentId,
          ownerAgentId: params.ownerAgentId,
        });
      },
      async update(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        requireInCompany("Goal", await goals.getById(params.goalId), companyId);
        const updated = await goals.update(params.goalId, params.patch);
        if (!updated) throw new Error("Goal not found");
        return updated;
      },
    },

    access: {
      async listMembers(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        const rows = await access.listMembers(companyId);
        const visibleRows = params.includeArchived ? rows : rows.filter((row) => row.status !== "archived");
        const grants = await db
          .select()
          .from(principalPermissionGrants)
          .where(eq(principalPermissionGrants.companyId, companyId));
        const grantsByPrincipal = new Map<string, typeof grants>();
        for (const grant of grants) {
          const principalId = grant.principalType === "user"
            ? grant.principalUserId
            : grant.principalAgentId;
          if (!principalId) {
            throw new Error(`Invalid ${grant.principalType} permission grant ${grant.id}`);
          }
          const key = `${grant.principalType}:${principalId}`;
          const existing = grantsByPrincipal.get(key) ?? [];
          existing.push(grant);
          grantsByPrincipal.set(key, existing);
        }
        return visibleRows.map((member) => ({
          ...member,
          principalType: member.principalType as PrincipalType,
          status: member.status as "pending" | "active" | "suspended" | "archived",
          grants: (grantsByPrincipal.get(`${member.principalType}:${member.principalId}`) ?? []).map(redactGrant),
        }));
      },
      async getMember(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        return loadPluginMember(companyId, params.memberId);
      },
      async updateMember(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        const updated = await access.updateMember(companyId, params.memberId, params.patch);
        if (!updated) throw new Error("Member not found");
        await logPluginActivity({
          companyId,
          action: "company_member.updated_by_plugin",
          entityType: "company_membership",
          entityId: params.memberId,
          details: {
            patch: sanitizeRecord(params.patch as Record<string, unknown>),
          },
        });
        return (await loadPluginMember(companyId, params.memberId))!;
      },
      async listInvites(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        const limit = Math.min(Math.max(Number(params.limit ?? 20), 1), 100);
        const offset = Math.max(Number(params.offset ?? 0), 0);
        const stateClause = inviteStateWhereClause(params.state);
        const rows = await db
          .select()
          .from(invites)
          .where(stateClause ? and(eq(invites.companyId, companyId), stateClause) : eq(invites.companyId, companyId))
          .orderBy(desc(invites.createdAt))
          .limit(limit + 1)
          .offset(offset);
        const hasMore = rows.length > limit;
        return {
          invites: rows.slice(0, limit).map(redactInvite),
          nextOffset: hasMore ? offset + limit : null,
        };
      },
      async createInvite(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        const { token, invite: created, normalizedAgentMessage } =
          await createCompanyInvite(db, {
            companyId,
            provenance: { source: "plugin_host" },
            allowedJoinTypes: params.allowedJoinTypes,
            humanRole: params.humanRole,
            defaultsPayload: params.defaultsPayload,
            agentMessage: params.agentMessage,
          });
        await logPluginActivity({
          companyId,
          action: "invite.created_by_plugin",
          entityType: "invite",
          entityId: created.id,
          details: {
            allowedJoinTypes: created.allowedJoinTypes,
            expiresAt: created.expiresAt.toISOString(),
            hasAgentMessage: Boolean(normalizedAgentMessage),
          },
        });
        return { ...redactInvite(created), token };
      },
      async revokeInvite(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        const invite = await db
          .select()
          .from(invites)
          .where(and(eq(invites.id, params.inviteId), eq(invites.companyId, companyId)))
          .then((rows) => rows[0] ?? null);
        if (!invite) throw new Error("Invite not found");
        if (invite.acceptedAt) throw new Error("Invite already consumed");
        if (invite.revokedAt) return redactInvite(invite);
        const revoked = await db
          .update(invites)
          .set({ revokedAt: new Date(), updatedAt: new Date() })
          .where(and(
            eq(invites.id, invite.id),
            eq(invites.companyId, companyId),
            isNull(invites.revokedAt),
            isNull(invites.acceptedAt),
          ))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!revoked) throw new Error("Invite was not revoked");
        await logPluginActivity({
          companyId,
          action: "invite.revoked_by_plugin",
          entityType: "invite",
          entityId: invite.id,
        });
        return redactInvite(revoked);
      },
    },

    authorization: {
      async listGrants(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        const principalType = params.principalType === "user" || params.principalType === "agent"
          ? params.principalType
          : null;
        if (params.principalType && !principalType) {
          throw new Error("principalType must be 'agent' or 'user'");
        }
        const conditions = [
          eq(principalPermissionGrants.companyId, companyId),
          principalType ? eq(principalPermissionGrants.principalType, principalType) : undefined,
          params.principalId
            ? principalType === "user"
              ? eq(principalPermissionGrants.principalUserId, params.principalId)
              : principalType === "agent"
                ? eq(principalPermissionGrants.principalAgentId, params.principalId)
                : isUuidLike(params.principalId)
                  ? or(
                      eq(principalPermissionGrants.principalUserId, params.principalId),
                      eq(principalPermissionGrants.principalAgentId, params.principalId),
                    )
                  : eq(principalPermissionGrants.principalUserId, params.principalId)
            : undefined,
        ].filter((condition): condition is NonNullable<typeof condition> => Boolean(condition));
        const rows = await db
          .select()
          .from(principalPermissionGrants)
          .where(and(...conditions))
          .orderBy(
            principalPermissionGrants.principalType,
            principalPermissionGrants.principalUserId,
            principalPermissionGrants.principalAgentId,
            principalPermissionGrants.permissionKey,
          );
        return rows.map(redactGrant);
      },
      async setGrants(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        if (params.principalType !== "agent" && params.principalType !== "user") {
          throw new Error("principalType must be 'agent' or 'user'");
        }
        if (params.principalType === "agent") {
          requireInCompany("Agent", await agents.getById(params.principalId), companyId);
        } else {
          const membership = await access.getMembership(companyId, params.principalType as PrincipalType, params.principalId);
          if (!membership) throw new Error("Principal is not a member of this company");
        }
        await access.setPrincipalGrants(
          companyId,
          params.principalType as PrincipalType,
          params.principalId,
          params.grants.map((grant) => ({
            permissionKey: grant.permissionKey as PermissionKey,
            scope: grant.scope ? sanitizeRecord(grant.scope) : null,
          })),
          params.grantedByUserId ?? null,
        );
        await logPluginActivity({
          companyId,
          action: "authorization.grants_updated_by_plugin",
          entityType: "principal_permission_grants",
          entityId: `${params.principalType}:${params.principalId}`,
          details: { grantCount: params.grants.length },
        });
        return access
          .listPrincipalGrants(companyId, params.principalType as PrincipalType, params.principalId)
          .then((rows) => rows.map(redactGrant));
      },
      async policySummary(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        const [members, grants] = await Promise.all([
          access.listMembers(companyId),
          db
            .select({ id: principalPermissionGrants.id })
            .from(principalPermissionGrants)
            .where(eq(principalPermissionGrants.companyId, companyId)),
        ]);
        return {
          companyId,
          permissionsMode: "simple" as const,
          memberCount: members.length,
          activeMemberCount: members.filter((member) => member.status === "active").length,
          grantCount: grants.length,
          advancedPolicyAvailable: false as const,
        };
      },
      async getPolicy(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        return readAuthorizationPolicy(companyId, params.resourceType, params.resourceId);
      },
      async updatePolicy(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        if (params.resourceType !== "issue") {
          throw new Error(
            "Plugin authorization policy updates only support issue resources.",
          );
        }
        const policy = params.policy ? sanitizeRecord(params.policy) : null;
        const issue = requireInCompany("Issue", await issues.getById(params.resourceId), companyId);
        const executionPolicy = issue.executionPolicy && typeof issue.executionPolicy === "object"
          ? { ...(issue.executionPolicy as Record<string, unknown>) }
          : {};
        if (policy) executionPolicy.authorizationPolicy = policy;
        else delete executionPolicy.authorizationPolicy;
        await db
          .update(issuesTable)
          .set({ executionPolicy, updatedAt: new Date() })
          .where(eq(issuesTable.id, issue.id));
        await logPluginActivity({
          companyId,
          action: "authorization.policy_updated_by_plugin",
          entityType: params.resourceType,
          entityId: params.resourceId,
          details: { hasPolicy: Boolean(policy) },
        });
        const updated = await readAuthorizationPolicy(companyId, params.resourceType, params.resourceId);
        if (!updated) throw new Error("Policy resource not found");
        return updated;
      },
      async previewAssignment(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        return authorization.decide({
          actor: await resolvePluginTargetManagementSubject(params.subject),
          action: "agent_config:update",
          resource: { type: "agent", companyId, agentId: params.targetAgentId },
          scope: {
            requiresChangeGrant: true,
            targetAgentId: params.targetAgentId,
          },
        });
      },
      async searchAudit(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        const limit = Math.min(Math.max(Number(params.limit ?? 50), 1), 100);
        const offset = Math.max(Number(params.offset ?? 0), 0);
        const decisionFilter = typeof params.decision === "string" && params.decision.trim()
          ? params.decision.trim().toLowerCase()
          : null;
        const conditions = [
          eq(activityLog.companyId, companyId),
          params.action ? eq(activityLog.action, params.action) : undefined,
          params.actorType ? eq(activityLog.actorType, params.actorType) : undefined,
          params.actorId ? eq(activityLog.actorId, params.actorId) : undefined,
          params.entityType ? eq(activityLog.entityType, params.entityType) : undefined,
          params.entityId ? eq(activityLog.entityId, params.entityId) : undefined,
          decisionFilter ? authorizationAuditDecisionCondition(decisionFilter) : undefined,
        ].filter((condition): condition is NonNullable<typeof condition> => Boolean(condition));
        const rows = await db
          .select()
          .from(activityLog)
          .where(and(...conditions))
          .orderBy(desc(activityLog.createdAt))
          .limit(limit)
          .offset(offset);
        return rows.map((row) => ({
          ...row,
          details: row.details && typeof row.details === "object"
            ? sanitizeRecord(row.details)
            : row.details ?? null,
        }));
      },
    },

    /** Release plugin event subscriptions owned by this worker runtime. */
    async dispose() {
      registeredCreatorCallbacks.clear();
      // Clear event bus subscriptions to prevent accumulation on worker restart.
      // Without this, each crash/restart cycle adds duplicate subscriptions.
      scopedBus.clear();
    },
  };
}
