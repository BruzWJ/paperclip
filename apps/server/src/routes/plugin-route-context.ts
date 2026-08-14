/**
 * @fileoverview Plugin management REST API routes
 *
 * This module provides Express routes for managing the complete plugin lifecycle:
 * - Listing and filtering plugins by status
 * - Listing and installing trusted plugins from a source checkout
 * - Installing plugins from npm or local paths
 * - Uninstalling plugins and their installation-owned operational data
 * - Enabling/disabling plugins
 * - Running health diagnostics
 * - Upgrading plugins
 * - Retrieving UI slot contributions for frontend rendering
 *
 * Most routes require board-level authentication, and sensitive instance-wide
 * mutations such as install/upgrade require instance-admin privileges.
 * Agent tool execution is available only through the compiler-owned run interface.
 *
 * @module apps/server/routes/plugins
 * @see doc/plugins/PLUGIN_SPEC.md for the full plugin specification
 */

import { type Db, companies } from "@paperclipai/db";
import {
  type PluginApiRouteDeclaration,
  type PluginHealthCheckResult,
  isCanonicalUuid,
} from "@paperclipai/shared";
import {
  type Request,
  type RequestHandler,
  type Response,
  type Router as ExpressRouter,
  raw,
  Router,
} from "express";
import { badRequest } from "../errors.js";
import { DEFAULT_JSON_BODY_LIMIT } from "../http/body-limits.js";
import { logActivity } from "../services/activity-log.js";
import { pluginCatalogService } from "../services/plugin-catalog.js";
import type { PluginJobScheduler } from "../services/plugin-job-scheduler.js";
import type { PluginJobStore } from "../services/plugin-job-store.js";
import type { PluginLifecycleManager } from "../services/plugin-lifecycle.js";
import { pluginRegistryService } from "../services/plugin-registry.js";
import { type PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { taskService } from "../services/tasks.js";
import { assertBoard, assertCompanyAccess, assertInstanceAdmin } from "./authz.js";
import {
  parseLocalFolderPathInput,
  parsePluginBridgeRequest,
  parsePluginCatalogInstallRequest,
  parsePluginConfigRequest,
  parsePluginInstallRequest,
  parsePluginRequest,
} from "./plugin-route-request-parsers.js";

const PLUGIN_API_BODY_LIMIT_BYTES = 1_000_000;
const pluginWebhookBodyParser: RequestHandler = raw({
  limit: DEFAULT_JSON_BODY_LIMIT,
  type: () => true,
});
const PLUGIN_SCOPED_API_RESPONSE_HEADER_ALLOWLIST = new Set([
  "cache-control",
  "etag",
  "last-modified",
  "x-request-id",
]);

/**
 * Resolve one immutable plugin installation by its database UUID.
 *
 * @param registry - The plugin registry service instance
 * @param pluginId - Installation UUID
 * @returns Plugin record or null if not found
 */
async function resolvePlugin(registry: ReturnType<typeof pluginRegistryService>, pluginId: string) {
  if (!isCanonicalUuid(pluginId)) return null;
  return registry.getById(pluginId);
}

function buildPluginHealthResult(
  plugin: NonNullable<Awaited<ReturnType<typeof resolvePlugin>>>,
): PluginHealthCheckResult {
  const checks: PluginHealthCheckResult["checks"] = [];

  // Persisted manifest integrity
  const hasValidManifest = plugin.manifestJson.id === plugin.pluginKey;
  checks.push({
    name: "manifest",
    passed: hasValidManifest,
    message: hasValidManifest ? "Manifest is valid" : "Manifest is invalid or missing",
  });

  // Lifecycle status
  const isHealthy = plugin.status === "ready";
  checks.push({
    name: "status",
    passed: isHealthy,
    message: `Current status: ${plugin.status}`,
  });

  // Last lifecycle/runtime error
  const hasNoError = !plugin.lastError;
  if (!hasNoError) {
    checks.push({
      name: "error_state",
      passed: false,
      message: plugin.lastError ?? undefined,
    });
  }

  return {
    pluginId: plugin.id,
    status: plugin.status,
    healthy: isHealthy && hasValidManifest && hasNoError,
    checks,
    lastError: plugin.lastError ?? undefined,
  };
}

/** Runtime services used by every plugin route. */
export interface PluginRouteDeps {
  /** The job scheduler instance. */
  scheduler: PluginJobScheduler;
  /** The job persistence store. */
  jobStore: PluginJobStore;
  /** The sole worker manager for bridge, webhook, config, and diagnostics calls. */
  workerManager: PluginWorkerManager;
}

/** Shared dependencies and helpers consumed by the split plugin route modules. */
export interface PluginRouteContext {
  db: Db;
  lifecycle: PluginLifecycleManager;
  runtime: PluginRouteDeps;
  PLUGIN_API_BODY_LIMIT_BYTES: number;
  pluginWebhookBodyParser: RequestHandler;
  PLUGIN_SCOPED_API_RESPONSE_HEADER_ALLOWLIST: Set<string>;
  resolvePlugin: typeof resolvePlugin;
  parsePluginRequest: typeof parsePluginRequest;
  parsePluginInstallRequest: typeof parsePluginInstallRequest;
  parsePluginCatalogInstallRequest: typeof parsePluginCatalogInstallRequest;
  parsePluginBridgeRequest: typeof parsePluginBridgeRequest;
  parseLocalFolderPathInput: typeof parseLocalFolderPathInput;
  parsePluginConfigRequest: typeof parsePluginConfigRequest;
  buildPluginHealthResult: typeof buildPluginHealthResult;
  router: ExpressRouter;
  registry: ReturnType<typeof pluginRegistryService>;
  catalog: ReturnType<typeof pluginCatalogService>;
  tasksSvc: ReturnType<typeof taskService>;
  matchScopedApiRoute: (
    route: PluginApiRouteDeclaration,
    method: string,
    requestPath: string,
  ) => Record<string, string> | null;
  sanitizePluginRequestHeaders: (req: Request) => Record<string, string>;
  applyPluginScopedApiResponseHeaders: (res: Response, headers: Record<string, string> | undefined) => void;
  parseExactPluginQuery: (query: Record<string, unknown>) => Record<string, string | string[]>;
  resolveScopedApiCompanyId: (
    route: PluginApiRouteDeclaration,
    params: Record<string, string>,
    req: Request,
  ) => Promise<string>;
  resolvePluginAuditCompanyIds: () => Promise<string[]>;
  logPluginMutationActivity: (
    req: Request,
    action: string,
    entityId: string,
    details: Record<string, unknown>,
  ) => Promise<void>;
  assertPluginBridgeScope: (req: Request, companyId: unknown) => string | undefined;
  performActionActorContext: (
    req: Request,
    companyId: string | undefined,
  ) => {
    type: "user";
    userId: string;
    companyId: string | null;
  };
}

export function createPluginRouteContext(
  db: Db,
  lifecycle: PluginLifecycleManager,
  runtime: PluginRouteDeps,
): PluginRouteContext {
  const router: ExpressRouter = Router({ caseSensitive: true, strict: true });
  const registry = pluginRegistryService(db);
  const catalog = pluginCatalogService();
  const tasksSvc = taskService(db);

  function matchScopedApiRoute(route: PluginApiRouteDeclaration, method: string, requestPath: string) {
    if (route.method !== method) return null;
    if (
      !requestPath.startsWith("/") ||
      (requestPath !== "/" && requestPath.endsWith("/")) ||
      requestPath.includes("//")
    ) {
      return null;
    }
    const routeSegments = route.path === "/" ? [] : route.path.slice(1).split("/");
    const requestSegments = requestPath === "/" ? [] : requestPath.slice(1).split("/");
    if (routeSegments.length !== requestSegments.length) return null;
    const params: Record<string, string> = {};
    for (let i = 0; i < routeSegments.length; i += 1) {
      const routeSegment = routeSegments[i]!;
      const requestSegment = requestSegments[i]!;
      if (routeSegment.startsWith(":")) {
        let decodedSegment: string;
        try {
          decodedSegment = decodeURIComponent(requestSegment);
        } catch {
          return null;
        }
        if (
          decodedSegment.length === 0 ||
          decodedSegment === "." ||
          decodedSegment === ".." ||
          decodedSegment.includes("/") ||
          decodedSegment.includes("\\") ||
          /[\u0000-\u001f\u007f]/.test(decodedSegment)
        ) {
          return null;
        }
        params[routeSegment.slice(1)] = decodedSegment;
        continue;
      }
      if (routeSegment !== requestSegment) return null;
    }
    return params;
  }

  function sanitizePluginRequestHeaders(req: Request): Record<string, string> {
    const safeHeaderNames = new Set(["accept", "content-type", "user-agent", "x-request-id"]);
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      const lower = name.toLowerCase();
      if (!safeHeaderNames.has(lower)) continue;
      if (Array.isArray(value)) {
        headers[lower] = value.join(", ");
      } else if (typeof value === "string") {
        headers[lower] = value;
      }
    }
    return headers;
  }

  function applyPluginScopedApiResponseHeaders(
    res: Response,
    headers: Record<string, string> | undefined,
  ): void {
    for (const [name, value] of Object.entries(headers ?? {})) {
      const lower = name.toLowerCase();
      if (!PLUGIN_SCOPED_API_RESPONSE_HEADER_ALLOWLIST.has(lower)) continue;
      res.setHeader(lower, value);
    }
  }

  function parseExactPluginQuery(query: Record<string, unknown>): Record<string, string | string[]> {
    const parsed: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(query)) {
      if (!/^[A-Za-z0-9_.-]+$/.test(key)) {
        throw badRequest(`Plugin API query parameter ${key} has an unsupported name`);
      }
      if (typeof value === "string") {
        parsed[key] = value;
        continue;
      }
      if (Array.isArray(value) && value.every((entry): entry is string => typeof entry === "string")) {
        parsed[key] = value;
        continue;
      }
      throw badRequest(`Plugin API query parameter ${key} must contain only exact string values`);
    }
    return parsed;
  }

  async function resolveScopedApiCompanyId(
    route: PluginApiRouteDeclaration,
    params: Record<string, string>,
    req: Request,
  ): Promise<string> {
    const resolution = route.companyResolution;

    if (resolution.from === "body") {
      const body = req.body;
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw badRequest(`Plugin API request body must contain ${resolution.key}`);
      }
      const companyId = (body as Record<string, unknown>)[resolution.key];
      if (typeof companyId !== "string" || !isCanonicalUuid(companyId)) {
        throw badRequest(
          `Plugin API request body field ${resolution.key} must be an exact canonical company UUID`,
        );
      }
      return companyId;
    }

    if (resolution.from === "query") {
      const companyId = req.query[resolution.key];
      if (typeof companyId !== "string" || !isCanonicalUuid(companyId)) {
        throw badRequest(`Plugin API query field ${resolution.key} must be an exact canonical company UUID`);
      }
      return companyId;
    }

    const taskId = params[resolution.param];
    if (!isCanonicalUuid(taskId)) {
      throw badRequest(
        `Plugin API route ${route.routeKey} requires an exact canonical task UUID in ${resolution.param}`,
      );
    }
    const task = await tasksSvc.getById(taskId);
    if (!task) throw badRequest(`Plugin API task does not exist: ${taskId}`);
    return task.companyId;
  }

  async function resolvePluginAuditCompanyIds(): Promise<string[]> {
    const rows = await db.select({ id: companies.id }).from(companies);
    return rows.map((row) => row.id);
  }

  async function logPluginMutationActivity(
    req: Request,
    action: string,
    entityId: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    assertBoard(req);
    const companyIds = await resolvePluginAuditCompanyIds();
    if (companyIds.length === 0) return;

    await Promise.all(
      companyIds.map((companyId) =>
        logActivity(db, {
          companyId,
          actorType: "user",
          actorId: req.actor.userId,
          action,
          entityType: "plugin",
          entityId,
          details,
        }),
      ),
    );
  }

  function assertPluginBridgeScope(req: Request, companyId: unknown): string | undefined {
    if (companyId === undefined || companyId === null) {
      assertInstanceAdmin(req);
      return undefined;
    }
    if (typeof companyId !== "string" || !isCanonicalUuid(companyId)) {
      throw badRequest('"companyId" must be an exact canonical UUID when provided');
    }
    assertCompanyAccess(req, companyId);
    return companyId;
  }

  function performActionActorContext(req: Request, companyId: string | undefined) {
    assertBoard(req);
    return {
      type: "user" as const,
      userId: req.actor.userId,
      companyId: companyId ?? null,
    };
  }
  return {
    db,
    lifecycle,
    runtime,
    PLUGIN_API_BODY_LIMIT_BYTES,
    pluginWebhookBodyParser,
    PLUGIN_SCOPED_API_RESPONSE_HEADER_ALLOWLIST,
    resolvePlugin,
    parsePluginRequest,
    parsePluginInstallRequest,
    parsePluginCatalogInstallRequest,
    parsePluginBridgeRequest,
    parseLocalFolderPathInput,
    parsePluginConfigRequest,
    buildPluginHealthResult,
    router,
    registry,
    catalog,
    tasksSvc,
    matchScopedApiRoute,
    sanitizePluginRequestHeaders,
    applyPluginScopedApiResponseHeaders,
    parseExactPluginQuery,
    resolveScopedApiCompanyId,
    resolvePluginAuditCompanyIds,
    logPluginMutationActivity,
    assertPluginBridgeScope,
    performActionActorContext,
  };
}

export type PluginRouteLifecycle = PluginLifecycleManager;
export type PluginRouteOptions = PluginRouteDeps;
