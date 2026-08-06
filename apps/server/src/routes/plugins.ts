/**
 * @fileoverview Plugin management REST API routes
 *
 * This module provides Express routes for managing the complete plugin lifecycle:
 * - Listing and filtering plugins by status
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

import { randomUUID } from "node:crypto";
import { raw, Router } from "express";
import type { Request, Response } from "express";
import { and, desc, eq, gte } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  companies,
  pluginLogs,
  pluginWebhookDeliveries,
} from "@paperclipai/db";
import type {
  PluginApiRouteDeclaration,
  PluginDashboardData,
  PluginDashboardJobRun,
  PluginDashboardWebhookDelivery,
  PluginHealthCheckResult,
  PluginBridgeError,
  PaperclipPluginManifestV1,
  PluginUiContribution,
  PluginWorkerDiagnostics,
} from "@paperclipai/shared";
import {
  isUuidLike,
  pluginBridgeRequestSchema,
  pluginConfigRequestSchema,
  pluginDisableRequestSchema,
  pluginInstallRequestSchema,
  pluginJobRunsQuerySchema,
  pluginListQuerySchema,
  pluginLocalFolderPathRequestSchema,
  pluginLogsQuerySchema,
  pluginUpgradeRequestSchema,
  serializePluginConfig,
  serializePluginDetail,
  serializePluginJob,
  serializePluginJobRun,
  serializePluginLog,
  serializePluginRecord,
} from "@paperclipai/shared";
import { pluginRegistryService } from "../services/plugin-registry.js";
import type { PluginLifecycleManager } from "../services/plugin-lifecycle.js";
import { logActivity } from "../services/activity-log.js";
import { issueService } from "../services/issues.js";
import type { PluginJobScheduler } from "../services/plugin-job-scheduler.js";
import type { PluginJobStore } from "../services/plugin-job-store.js";
import {
  decodePluginWorkerHealth,
  type PluginWorkerManager,
} from "../services/plugin-worker-manager.js";
import {
  JsonRpcCallError,
  PLUGIN_RPC_ERROR_CODES,
  type PluginApiRequestInput,
} from "@paperclipai/plugin-sdk";
import {
  assertBoard,
  assertBoardOrgAccess,
  assertCompanyAccess,
  assertInstanceAdmin,
} from "./authz.js";
import { validatePluginInstanceConfig } from "../services/plugin-config-validator.js";
import {
  getStoredLocalFolders,
  inspectPluginLocalFolder,
  prepareAndInspectPluginLocalFolder,
  requireLocalFolderDeclaration,
  setStoredLocalFolder,
} from "../services/plugin-local-folders.js";
import { badRequest } from "../errors.js";
import { attachErrorContext } from "../middleware/error-handler.js";
import { DEFAULT_JSON_BODY_LIMIT } from "../http/body-limits.js";

const PLUGIN_API_BODY_LIMIT_BYTES = 1_000_000;
const pluginWebhookBodyParser = raw({
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
async function resolvePlugin(
  registry: ReturnType<typeof pluginRegistryService>,
  pluginId: string,
) {
  if (!isUuidLike(pluginId)) return null;
  return registry.getById(pluginId);
}

function parsePluginRequest<T>(
  result:
    | { success: true; data: T }
    | {
        success: false;
        error: { errors: Array<{ path: (string | number)[]; message: string }> };
      },
  message: string,
): T {
  if (result.success) return result.data;
  throw badRequest(
    message,
    result.error.errors.map((issue) => ({
      path: issue.path,
      message: issue.message,
    })),
  );
}

function parsePluginInstallRequest(body: unknown) {
  return parsePluginRequest(
    pluginInstallRequestSchema.safeParse(body),
    "Invalid plugin install request",
  );
}

function parsePluginBridgeRequest(body: unknown) {
  return parsePluginRequest(
    pluginBridgeRequestSchema.safeParse(body ?? {}),
    "Invalid plugin bridge request",
  );
}

function parseLocalFolderPathInput(body: unknown): { path: string } {
  return parsePluginRequest(
    pluginLocalFolderPathRequestSchema.safeParse(body),
    "Invalid plugin local-folder path request",
  );
}

type PluginConfigRequestResult =
  | { ok: true; configJson: Record<string, unknown> }
  | {
      ok: false;
      response: {
        error: string;
        fieldErrors?: ReturnType<typeof validatePluginInstanceConfig>["errors"];
      };
    };

function parsePluginConfigRequest(
  body: unknown,
  schema: PaperclipPluginManifestV1["instanceConfigSchema"],
): PluginConfigRequestResult {
  const parsed = pluginConfigRequestSchema.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      response: {
        error: 'Request must contain exactly one object field: "configJson"',
      },
    };
  }
  const { configJson } = parsed.data;
  const validation = validatePluginInstanceConfig(configJson, schema);
  return validation.valid
    ? { ok: true, configJson }
    : {
        ok: false,
        response: {
          error: "Configuration does not match the plugin's instanceConfigSchema",
          fieldErrors: validation.errors,
        },
      };
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
interface PluginRouteDeps {
  /** The job scheduler instance. */
  scheduler: PluginJobScheduler;
  /** The job persistence store. */
  jobStore: PluginJobStore;
  /** The sole worker manager for bridge, webhook, config, and diagnostics calls. */
  workerManager: PluginWorkerManager;
}

/**
 * Create Express router for plugin management API.
 *
 * Routes provided:
 *
 * | Method | Path | Description |
 * |--------|------|-------------|
 * | GET | /plugins | List all plugins (optional ?status= filter) |
 * | GET | /plugins/ui-contributions | Get UI slots from ready plugins |
 * | GET | /plugins/:pluginId | Get one installation by UUID |
 * | POST | /plugins/install | Install from npm or local path |
 * | DELETE | /plugins/:pluginId | Uninstall and delete installation data |
 * | POST | /plugins/:pluginId/enable | Enable a plugin |
 * | POST | /plugins/:pluginId/disable | Disable a plugin |
 * | POST | /plugins/:pluginId/upgrade | Upgrade to newer version |
 * | GET | /plugins/:pluginId/jobs | List jobs for a plugin |
 * | GET | /plugins/:pluginId/jobs/:jobId/runs | List runs for a job |
 * | POST | /plugins/:pluginId/jobs/:jobId/trigger | Manually trigger a job |
 * | POST | /plugins/:pluginId/webhooks/:endpointKey | Receive inbound webhook |
 * | GET | /plugins/:pluginId/config | Get current plugin config |
 * | POST | /plugins/:pluginId/config | Save (upsert) plugin config |
 * | POST | /plugins/:pluginId/config/test | Test config via validateConfig RPC |
 * | POST | /plugins/:pluginId/data/:key | Proxy getData to plugin worker (key in URL) |
 * | POST | /plugins/:pluginId/actions/:key | Proxy performAction to plugin worker (key in URL) |
 * | GET | /plugins/:pluginId/dashboard | Aggregated health dashboard data |
 *
 * **Route Ordering Note:** Static routes (like /ui-contributions) must be
 * registered before parameterized routes (like /:pluginId) to prevent Express from
 * matching them as a plugin ID.
 *
 * @param db - Database connection instance
 * @param lifecycle - The app-owned plugin lifecycle paired with this loader
 * @param runtime - Required runtime services for jobs and worker calls
 * @returns Express router with plugin routes mounted
 */
export function pluginRoutes(
  db: Db,
  lifecycle: PluginLifecycleManager,
  runtime: PluginRouteDeps,
) {
  const router = Router();
  const registry = pluginRegistryService(db);
  const issuesSvc = issueService(db);

  function matchScopedApiRoute(route: PluginApiRouteDeclaration, method: string, requestPath: string) {
    if (route.method !== method) return null;
    const normalize = (value: string) => value.replace(/\/+$/, "") || "/";
    const routeSegments = normalize(route.path).split("/").filter(Boolean);
    const requestSegments = normalize(requestPath).split("/").filter(Boolean);
    if (routeSegments.length !== requestSegments.length) return null;
    const params: Record<string, string> = {};
    for (let i = 0; i < routeSegments.length; i += 1) {
      const routeSegment = routeSegments[i]!;
      const requestSegment = requestSegments[i]!;
      if (routeSegment.startsWith(":")) {
        params[routeSegment.slice(1)] = decodeURIComponent(requestSegment);
        continue;
      }
      if (routeSegment !== requestSegment) return null;
    }
    return params;
  }

  function sanitizePluginRequestHeaders(req: Request): Record<string, string> {
    const safeHeaderNames = new Set([
      "accept",
      "content-type",
      "user-agent",
      "x-request-id",
    ]);
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

  function normalizeQuery(query: Request["query"]): Record<string, string | string[]> {
    const normalized: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(query)) {
      if (typeof value === "string") {
        normalized[key] = value;
      } else if (Array.isArray(value)) {
        normalized[key] = value.map((entry) => String(entry));
      }
    }
    return normalized;
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
      if (typeof companyId !== "string" || companyId.trim().length === 0) {
        throw badRequest(`Plugin API request body field ${resolution.key} must be a nonblank company ID`);
      }
      return companyId;
    }

    if (resolution.from === "query") {
      const companyId = req.query[resolution.key];
      if (typeof companyId !== "string" || companyId.trim().length === 0) {
        throw badRequest(`Plugin API query field ${resolution.key} must be a nonblank company ID`);
      }
      return companyId;
    }

    const issueId = params[resolution.param];
    if (!issueId) {
      throw new Error(
        `Plugin API route ${route.routeKey} did not bind declared issue parameter ${resolution.param}`,
      );
    }
    const issue = await issuesSvc.getById(issueId);
    if (!issue) throw badRequest(`Plugin API issue does not exist: ${issueId}`);
    return issue.companyId;
  }

  async function resolvePluginAuditCompanyIds(): Promise<string[]> {
    const rows = await db
      .select({ id: companies.id })
      .from(companies);
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

    await Promise.all(companyIds.map((companyId) =>
      logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId,
        action,
        entityType: "plugin",
        entityId,
        details,
      })));
  }

  function assertPluginBridgeScope(req: Request, companyId: unknown): string | undefined {
    if (companyId === undefined || companyId === null) {
      assertInstanceAdmin(req);
      return undefined;
    }
    if (typeof companyId !== "string" || companyId.trim().length === 0) {
      throw badRequest('"companyId" must be a non-empty string when provided');
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

  /**
   * GET /api/plugins
   *
   * List all installed plugins, optionally filtered by lifecycle status.
   *
   * Query params:
   * - `status` (optional): Filter by lifecycle status. Must be one of the
   *   values in `PLUGIN_STATUSES` (`ready`, `disabled`, `error`). Returns HTTP 400 if the value is
   *   not a recognised status string.
   *
   * Response: `PluginRecordDto[]`
   */
  router.get("/plugins", async (req, res) => {
    assertBoardOrgAccess(req);
    const { status } = parsePluginRequest(
      pluginListQuerySchema.safeParse(req.query),
      "Invalid plugin list query",
    );
    const plugins = status
      ? await registry.listByStatus(status)
      : await registry.list();
    res.json(plugins.map(serializePluginRecord));
  });

  // IMPORTANT: Static routes must come before parameterized routes
  // to avoid Express matching "ui-contributions" as a :pluginId

  /**
   * GET /api/plugins/ui-contributions
   *
   * Return UI contributions from all plugins in 'ready' state.
   * Used by the frontend to discover plugin UI slots and launcher metadata.
   *
   * The response is normalized for the frontend slot host:
   * - Only includes plugins with at least one declared UI slot or launcher
   * - Slots are extracted from manifest.ui.slots
   * - Launchers are extracted from manifest.ui.launchers
   *
   * Example response:
   * ```json
   * [
   *   {
   *     "pluginId": "3aaf3e3c-2e89-4e34-a3de-5c7f0d25ee90",
   *     "pluginKey": "paperclip.claude-usage",
   *     "displayName": "Claude Usage",
   *     "version": "1.0.0",
   *     "slots": [],
   *     "launchers": [
   *       {
   *         "id": "claude-usage-toolbar",
   *         "displayName": "Claude Usage",
   *         "placementZone": "toolbarButton",
   *         "action": { "type": "openModal", "target": "ClaudeUsageView" },
   *         "render": { "environment": "hostOverlay", "bounds": "wide" }
   *       }
   *     ]
   *   }
   * ]
   * ```
   *
   * Response: PluginUiContribution[]
   */
  router.get("/plugins/ui-contributions", async (req, res) => {
    assertBoardOrgAccess(req);
    const plugins = await registry.listByStatus("ready");

    const contributions: PluginUiContribution[] = plugins
      .map((plugin) => {
        const manifest = plugin.manifestJson;
        const slots = manifest.ui?.slots ?? [];
        const launchers = manifest.ui?.launchers ?? [];
        if (slots.length === 0 && launchers.length === 0) return null;

        return {
          pluginId: plugin.id,
          pluginKey: plugin.pluginKey,
          displayName: manifest.displayName,
          version: manifest.version,
          updatedAt: plugin.updatedAt.toISOString(),
          slots,
          launchers,
        };
      })
      .filter((item): item is PluginUiContribution => item !== null);
    res.json(contributions);
  });

  /**
   * POST /api/plugins/install
   *
   * Install a plugin from npm or a local filesystem path.
   *
   * Instance-wide plugin installation is restricted to instance admins because
   * the install flow fetches and inspects package contents on the host.
   *
   * Request body is exactly one of:
   * - `{ source: "npm", packageName, version? }`
   * - `{ source: "local", path }`
   *
   * The installer:
   * 1. Downloads from npm or loads from local path
   * 2. Validates the manifest and host compatibility
   * 3. Registers in the database
   * 4. Activates the complete runtime when empty instance config is valid;
   *    otherwise leaves the installation disabled for explicit configuration
   *
   * Response: `PluginRecordDto`
   *
   * Errors:
   * - `400` — validation failure or install error (package not found, bad manifest, etc.)
   */
  router.post("/plugins/install", async (req, res) => {
    assertInstanceAdmin(req);
    const installOptions = parsePluginInstallRequest(req.body);

    try {
      const installed = await lifecycle.install(installOptions);
      await logPluginMutationActivity(req, "plugin.installed", installed.id, {
        pluginId: installed.id,
        pluginKey: installed.pluginKey,
        packageName: installed.packageName,
        version: installed.manifestJson.version,
        source: installOptions.source,
      });
      res.json(serializePluginRecord(installed));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  // ===========================================================================
  // UI Bridge proxy routes (getData / performAction)
  // ===========================================================================

  /**
   * Map a worker RPC error to a bridge-level error code.
   *
   * JsonRpcCallError carries numeric codes from the plugin RPC error code space.
   * This helper maps them to the string error codes defined in PluginBridgeErrorCode.
   *
   * @see PLUGIN_SPEC.md §19.7 — Error Propagation Through The Bridge
   */
  function mapRpcErrorToBridgeError(err: unknown): PluginBridgeError {
    if (err instanceof JsonRpcCallError) {
      const code: PluginBridgeError["code"] =
        err.code === PLUGIN_RPC_ERROR_CODES.WORKER_UNAVAILABLE
          ? "WORKER_UNAVAILABLE"
          : err.code === PLUGIN_RPC_ERROR_CODES.CAPABILITY_DENIED
            ? "CAPABILITY_DENIED"
            : err.code === PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED
              ? "INVOCATION_SCOPE_DENIED"
              : err.code === PLUGIN_RPC_ERROR_CODES.TIMEOUT
                ? "TIMEOUT"
                : err.code === PLUGIN_RPC_ERROR_CODES.WORKER_ERROR ||
                    err.code === PLUGIN_RPC_ERROR_CODES.METHOD_NOT_IMPLEMENTED ||
                    err.code === PLUGIN_RPC_ERROR_CODES.UNKNOWN
                  ? "WORKER_ERROR"
                  : "UNKNOWN";
      return {
        code,
        message: err.message,
        ...(err.data === undefined ? {} : { details: err.data }),
      };
    }

    return {
      code: "UNKNOWN",
      message: err instanceof Error ? err.message : String(err),
    };
  }

  function sendPluginBridgeError(
    req: Request,
    res: Response,
    status: number,
    err: unknown,
    metadata: Record<string, unknown>,
  ): void {
    const bridgeError = mapRpcErrorToBridgeError(err);
    const rootError = err instanceof Error ? err : new Error(String(err));
    attachErrorContext(req, res, {
      message: bridgeError.message,
      stack: rootError.stack,
      name: rootError.name,
      details: {
        ...metadata,
        bridgeCode: bridgeError.code,
        bridgeDetails: bridgeError.details,
      },
    }, rootError);
    res.status(status).json(bridgeError);
  }

  /**
   * POST /api/plugins/:pluginId/data/:key
   *
   * Proxy a `getData` call from the plugin UI to the plugin worker, with the
   * data key specified as a URL path parameter instead of in the request body.
   *
   * Request body (optional):
   * - `params`: Optional query parameters forwarded to the worker handler
   *
   * Response: The raw result from the worker's `getData` handler wrapped as `{ data: T }`
   *
   * Error response body follows the `PluginBridgeError` shape:
   * `{ code: PluginBridgeErrorCode, message: string, details?: unknown }`
   *
   * Errors:
   * - 404 if plugin not found
   * - 502 if the worker is unavailable or returns an error
   *
   * @see PLUGIN_SPEC.md §13.8 — `getData`
   * @see PLUGIN_SPEC.md §19.7 — Error Propagation Through The Bridge
   */
  router.post("/plugins/:pluginId/data/:key", async (req, res) => {
    assertBoardOrgAccess(req);

    const { pluginId, key } = req.params;

    // Resolve plugin
    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    // Validate plugin is in ready state
    if (plugin.status !== "ready") {
      const err = new JsonRpcCallError({
        code: PLUGIN_RPC_ERROR_CODES.WORKER_UNAVAILABLE,
        message: `Plugin is not ready (current status: ${plugin.status})`,
      });
      sendPluginBridgeError(req, res, 502, err, {
        pluginId: plugin.id,
        pluginKey: plugin.pluginKey,
        bridgeMethod: "getData",
        dataKey: key,
      });
      return;
    }

    const body = parsePluginBridgeRequest(req.body);

    const companyId = assertPluginBridgeScope(req, body.companyId);

    try {
      const result = await runtime.workerManager.call(
        plugin.id,
        "getData",
        {
          key,
          ...(companyId ? { companyId } : {}),
          params: body.params ?? {},
          renderEnvironment: body.renderEnvironment ?? null,
        },
      );
      res.json({ data: result });
    } catch (err) {
      sendPluginBridgeError(req, res, 502, err, {
        pluginId: plugin.id,
        pluginKey: plugin.pluginKey,
        bridgeMethod: "getData",
        dataKey: key,
      });
    }
  });

  /**
   * POST /api/plugins/:pluginId/actions/:key
   *
   * Proxy a `performAction` call from the plugin UI to the plugin worker, with
   * the action key specified as a URL path parameter instead of in the request body.
   *
   * Request body (optional):
   * - `params`: Optional parameters forwarded to the worker handler
   *
   * Response: The raw result from the worker's `performAction` handler wrapped as `{ data: T }`
   *
   * Error response body follows the `PluginBridgeError` shape:
   * `{ code: PluginBridgeErrorCode, message: string, details?: unknown }`
   *
   * Errors:
   * - 404 if plugin not found
   * - 502 if the worker is unavailable or returns an error
   *
   * @see PLUGIN_SPEC.md §13.9 — `performAction`
   * @see PLUGIN_SPEC.md §19.7 — Error Propagation Through The Bridge
   */
  router.post("/plugins/:pluginId/actions/:key", async (req, res) => {
    assertBoardOrgAccess(req);

    const { pluginId, key } = req.params;

    // Resolve plugin
    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    // Validate plugin is in ready state
    if (plugin.status !== "ready") {
      const err = new JsonRpcCallError({
        code: PLUGIN_RPC_ERROR_CODES.WORKER_UNAVAILABLE,
        message: `Plugin is not ready (current status: ${plugin.status})`,
      });
      sendPluginBridgeError(req, res, 502, err, {
        pluginId: plugin.id,
        pluginKey: plugin.pluginKey,
        bridgeMethod: "performAction",
        actionKey: key,
      });
      return;
    }

    const body = parsePluginBridgeRequest(req.body);

    const companyId = assertPluginBridgeScope(req, body.companyId);

    try {
      const result = await runtime.workerManager.call(
        plugin.id,
        "performAction",
        {
          key,
          params: {
            ...(body.params ?? {}),
            ...(companyId ? { companyId } : {}),
          },
          actorContext: performActionActorContext(req, companyId),
          renderEnvironment: body.renderEnvironment ?? null,
        },
      );
      res.json({ data: result });
    } catch (err) {
      sendPluginBridgeError(req, res, 502, err, {
        pluginId: plugin.id,
        pluginKey: plugin.pluginKey,
        bridgeMethod: "performAction",
        actionKey: key,
      });
    }
  });

  router.use("/plugins/:pluginId/api", async (req, res) => {
    const { pluginId } = req.params;
    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }
    if (plugin.status !== "ready") {
      sendPluginBridgeError(
        req,
        res,
        503,
        new JsonRpcCallError({
          code: PLUGIN_RPC_ERROR_CODES.WORKER_UNAVAILABLE,
          message: `Plugin is not ready (current status: ${plugin.status})`,
        }),
        { pluginId: plugin.id, pluginKey: plugin.pluginKey, bridgeMethod: "handleApiRequest" },
      );
      return;
    }
    if (!runtime.workerManager.isRunning(plugin.id)) {
      sendPluginBridgeError(
        req,
        res,
        503,
        new JsonRpcCallError({
          code: PLUGIN_RPC_ERROR_CODES.WORKER_UNAVAILABLE,
          message: "Plugin worker is not running",
        }),
        { pluginId: plugin.id, pluginKey: plugin.pluginKey, bridgeMethod: "handleApiRequest" },
      );
      return;
    }
    if (!plugin.manifestJson.capabilities.includes("api.routes.register")) {
      res.status(404).json({ error: "Plugin does not expose scoped API routes" });
      return;
    }

    const requestPath = req.path || "/";
    const routes = plugin.manifestJson.apiRoutes ?? [];
    const match = routes
      .map((route) => ({ route, params: matchScopedApiRoute(route, req.method, requestPath) }))
      .find((candidate) => candidate.params !== null);
    if (!match || !match.params) {
      res.status(404).json({ error: "Plugin API route not found" });
      return;
    }

    try {
      assertBoard(req);
      const companyId = await resolveScopedApiCompanyId(match.route, match.params, req);
      assertCompanyAccess(req, companyId);
      if (req.method !== "GET" && req.headers["content-type"] && !req.is("application/json")) {
        res.status(415).json({ error: "Plugin API routes accept JSON requests only" });
        return;
      }
      const requestBody = req.body ?? null;
      const bodySize = Buffer.byteLength(JSON.stringify(requestBody));
      if (bodySize > PLUGIN_API_BODY_LIMIT_BYTES) {
        res.status(413).json({ error: "Plugin API request body is too large" });
        return;
      }

      const input: PluginApiRequestInput = {
        routeKey: match.route.routeKey,
        method: req.method,
        path: requestPath,
        params: match.params,
        query: normalizeQuery(req.query),
        body: requestBody,
        actor: {
          type: "user",
          userId: req.actor.userId,
        },
        companyId,
        headers: sanitizePluginRequestHeaders(req),
      };

      const result = await runtime.workerManager.call(
        plugin.id,
        "handleApiRequest",
        input,
      );
      if (
        result.status !== undefined &&
        (!Number.isInteger(result.status) || result.status < 200 || result.status > 599)
      ) {
        throw new Error("Plugin API response status must be an integer from 200 through 599");
      }
      const status = result.status ?? 200;
      applyPluginScopedApiResponseHeaders(res, result.headers);
      if (status === 204) {
        res.status(status).end();
      } else {
        res.status(status).json(result.body ?? null);
      }
    } catch (err) {
      if (err instanceof JsonRpcCallError) {
        const status = (
          err.code === PLUGIN_RPC_ERROR_CODES.CAPABILITY_DENIED ||
          err.code === PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED
        )
          ? 403
          : 502;
        sendPluginBridgeError(req, res, status, err, {
          pluginId: plugin.id,
          pluginKey: plugin.pluginKey,
          bridgeMethod: "handleApiRequest",
          routeKey: match.route.routeKey,
        });
        return;
      }
      throw err;
    }
  });

  /**
   * GET /api/plugins/:pluginId
   *
   * Get detailed information about a single plugin.
   *
   * The :pluginId parameter is the immutable installation UUID.
   *
   * Response: PluginDetailDto
   * Errors: 404 if plugin not found
   */
  router.get("/plugins/:pluginId", async (req, res) => {
    assertBoardOrgAccess(req);
    const { pluginId } = req.params;
    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    // Enrich with worker capabilities when available
    const worker = runtime.workerManager.getWorker(plugin.id);
    const supportsConfigTest = worker
      ? worker.supportedMethods.includes("validateConfig")
      : false;

    res.json(serializePluginDetail(plugin, supportsConfigTest));
  });

  /**
   * DELETE /api/plugins/:pluginId
   *
   * Uninstall a plugin.
   *
   * Successful uninstall deletes the installation and all installation-owned
   * operational data. Repeating the same request is a successful no-op.
   *
   * Response: 204 No Content
   * Errors: 404 for a non-UUID installation identifier, 400 for lifecycle errors
   */
  router.delete("/plugins/:pluginId", async (req, res) => {
    assertInstanceAdmin(req);
    const { pluginId } = req.params;
    if (!isUuidLike(pluginId)) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }
    if (Object.keys(req.query).length > 0) {
      res.status(400).json({ error: "Plugin uninstall does not accept query parameters" });
      return;
    }

    try {
      const deleted = await lifecycle.unload(pluginId);
      if (deleted) {
        await logPluginMutationActivity(req, "plugin.uninstalled", pluginId, {
          pluginId,
          pluginKey: deleted.pluginKey,
        });
      }
      res.status(204).end();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  /**
   * POST /api/plugins/:pluginId/enable
   *
   * Enable a plugin that is currently disabled or in error state.
   *
   * Transitions the plugin to 'ready' state after loading and validation.
   *
   * Response: PluginRecordDto
   * Errors: 404 if plugin not found, 400 for lifecycle errors
   */
  router.post("/plugins/:pluginId/enable", async (req, res) => {
    assertInstanceAdmin(req);
    const { pluginId } = req.params;

    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    try {
      const result = await lifecycle.enable(plugin.id);
      await logPluginMutationActivity(req, "plugin.enabled", plugin.id, {
        pluginId: plugin.id,
        pluginKey: plugin.pluginKey,
        version: result.manifestJson.version,
      });
      res.json(serializePluginRecord(result));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  /**
   * POST /api/plugins/:pluginId/disable
   *
   * Disable a running plugin.
   *
   * Request body (optional):
   * - reason: Human-readable reason for disabling
   *
   * The plugin transitions to `disabled` and stops processing events.
   *
   * Response: PluginRecordDto
   * Errors: 404 if plugin not found, 400 for lifecycle errors
   */
  router.post("/plugins/:pluginId/disable", async (req, res) => {
    assertInstanceAdmin(req);
    const { pluginId } = req.params;
    const body = parsePluginRequest(
      pluginDisableRequestSchema.safeParse(req.body ?? {}),
      "Invalid plugin disable request",
    );
    const { reason } = body;

    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    try {
      const result = await lifecycle.disable(plugin.id, reason);
      await logPluginMutationActivity(req, "plugin.disabled", plugin.id, {
        pluginId: plugin.id,
        pluginKey: plugin.pluginKey,
        reason: reason ?? null,
      });
      res.json(serializePluginRecord(result));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  /**
   * GET /api/plugins/:pluginId/logs
   *
   * Query recent log entries for a plugin.
   *
   * Query params:
   * - limit: Maximum number of entries (default 25, max 500)
   * - level: Filter by log level (debug, info, warn, error, metric)
   * - since: ISO timestamp to filter logs newer than this time
   *
   * Response: Array of log entries, newest first.
  */
  router.get("/plugins/:pluginId/logs", async (req, res) => {
    assertInstanceAdmin(req);
    const { pluginId } = req.params;

    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    const query = parsePluginRequest(
      pluginLogsQuerySchema.safeParse(req.query),
      "Invalid plugin logs query",
    );
    const limit = Number(query.limit);

    const conditions = [eq(pluginLogs.pluginId, plugin.id)];
    if (query.level) {
      conditions.push(eq(pluginLogs.level, query.level));
    }
    if (query.since) {
      conditions.push(gte(pluginLogs.createdAt, new Date(query.since)));
    }

    const rows = await db
      .select()
      .from(pluginLogs)
      .where(and(...conditions))
      .orderBy(desc(pluginLogs.createdAt))
      .limit(limit);

    res.json(rows.map(serializePluginLog));
  });

  /**
   * POST /api/plugins/:pluginId/upgrade
   *
   * Upgrade a plugin to a newer version.
   *
   * Upgrades are restricted to instance admins because they fetch and inspect
   * new package contents on the host before activation.
   *
   * Request body (optional):
   * - version: Target version (defaults to latest)
   *
   * Capability escalation is rejected and leaves the current ready runtime
   * untouched. A compatible upgrade replaces the runtime and remains ready.
   *
   * Response: PluginRecordDto
   * Errors: 404 if plugin not found, 400 for lifecycle errors
   */
  router.post("/plugins/:pluginId/upgrade", async (req, res) => {
    assertInstanceAdmin(req);
    const { pluginId } = req.params;
    const body = parsePluginRequest(
      pluginUpgradeRequestSchema.safeParse(req.body ?? {}),
      "Invalid plugin upgrade request",
    );
    const { version } = body;

    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    try {
      const result = await lifecycle.upgrade(plugin.id, version);
      await logPluginMutationActivity(req, "plugin.upgraded", plugin.id, {
        pluginId: plugin.id,
        pluginKey: plugin.pluginKey,
        previousVersion: plugin.manifestJson.version,
        version: result.manifestJson.version,
        targetVersion: version ?? null,
      });
      res.json(serializePluginRecord(result));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  // ===========================================================================
  // Plugin configuration routes
  // ===========================================================================

  /**
   * GET /api/plugins/:pluginId/config
   *
   * Retrieve the installation-wide configuration for a plugin.
   *
   * Returns the `PluginConfigDto` if one exists, or `null` if the plugin
   * has not yet been configured.
   *
   * Response: `PluginConfigDto | null`
   * Errors: 404 if plugin not found
   */
  router.get("/plugins/:pluginId/config", async (req, res) => {
    assertInstanceAdmin(req);
    const { pluginId } = req.params;

    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    const config = await registry.getConfig(plugin.id);
    res.json(config ? serializePluginConfig(config) : null);
  });

  /**
   * POST /api/plugins/:pluginId/config
   *
   * Save (create or replace) the installation-wide configuration for a plugin.
   *
   * The caller provides the full `configJson` object. Paperclip stores it as
   * the installation's opaque plugin configuration.
   *
   * Request body:
   * - `configJson`: Configuration values matching the plugin's `instanceConfigSchema`
   *
   * Response: `PluginConfigDto`
   * Errors:
   * - 400 if request validation fails
   * - 404 if plugin not found
   */
  router.post("/plugins/:pluginId/config", async (req, res) => {
    assertInstanceAdmin(req);
    const { pluginId } = req.params;

    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    const parsedConfig = parsePluginConfigRequest(
      req.body,
      plugin.manifestJson.instanceConfigSchema,
    );
    if (!parsedConfig.ok) {
      res.status(400).json(parsedConfig.response);
      return;
    }
    const { configJson } = parsedConfig;

    try {
      const result = await lifecycle.updateConfig(plugin.id, configJson);
      await logPluginMutationActivity(req, "plugin.config.updated", plugin.id, {
        pluginId: plugin.id,
        pluginKey: plugin.pluginKey,
        configKeyCount: Object.keys(result.configJson).length,
      });

      res.json(serializePluginConfig(result));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  /**
   * POST /api/plugins/:pluginId/config/test
   *
   * Test a plugin configuration without persisting it by calling the plugin
   * worker's `validateConfig` RPC method.
   *
   * Only works when the plugin's worker implements `onValidateConfig`.
   *
   * Request body:
   * - `configJson`: Configuration values to validate
   *
   * Response: `{ valid: boolean; message?: string }`
   * Errors:
   * - 400 if request validation fails
   * - 404 if plugin not found
   * - 502 if the worker is unavailable or does not implement validation
   */
  router.post("/plugins/:pluginId/config/test", async (req, res) => {
    assertInstanceAdmin(req);

    const { pluginId } = req.params;

    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    if (plugin.status !== "ready") {
      sendPluginBridgeError(req, res, 502, new JsonRpcCallError({
        code: PLUGIN_RPC_ERROR_CODES.WORKER_UNAVAILABLE,
        message: `Plugin is not ready (current status: ${plugin.status})`,
      }), {
        pluginId: plugin.id,
        pluginKey: plugin.pluginKey,
        bridgeMethod: "validateConfig",
      });
      return;
    }

    const parsedConfig = parsePluginConfigRequest(
      req.body,
      plugin.manifestJson.instanceConfigSchema,
    );
    if (!parsedConfig.ok) {
      res.status(400).json(parsedConfig.response);
      return;
    }

    try {
      const result = await runtime.workerManager.call(
        plugin.id,
        "validateConfig",
        { config: parsedConfig.configJson },
      );

      // The worker returns PluginConfigValidationResult { ok, warnings?, errors? }
      // Map to the frontend-expected shape { valid, message? }
      if (result.ok) {
        const warningText = result.warnings?.length
          ? `Warnings: ${result.warnings.join("; ")}`
          : undefined;
        res.json({ valid: true, message: warningText });
      } else {
        const errorText = result.errors?.length
          ? result.errors.join("; ")
          : "Configuration validation failed.";
        res.json({ valid: false, message: errorText });
      }
    } catch (err) {
      sendPluginBridgeError(req, res, 502, err, {
        pluginId: plugin.id,
        pluginKey: plugin.pluginKey,
        bridgeMethod: "validateConfig",
      });
    }
  });

  // ===========================================================================
  // Job scheduling routes
  // ===========================================================================

  /**
   * GET /api/plugins/:pluginId/jobs
   *
   * List all scheduled jobs for a plugin.
   *
   * Response: PluginJobDto[]
   * Errors: 404 if plugin not found
  */
  router.get("/plugins/:pluginId/jobs", async (req, res) => {
    assertInstanceAdmin(req);
    const { pluginId } = req.params;
    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    try {
      const jobs = await runtime.jobStore.listJobs(plugin.id);
      res.json(jobs.map(serializePluginJob));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  /**
   * GET /api/plugins/:pluginId/jobs/:jobId/runs
   *
   * List execution history for a specific job.
   *
   * Query params:
   * - `limit` (optional): Maximum number of runs to return (default: 25)
   *
   * Response: PluginJobRunDto[]
   * Errors: 404 if plugin not found
  */
  router.get("/plugins/:pluginId/jobs/:jobId/runs", async (req, res) => {
    assertInstanceAdmin(req);
    const { pluginId, jobId } = req.params;
    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    const job = await runtime.jobStore.getJobByIdForPlugin(plugin.id, jobId);
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }

    const { limit: rawLimit } = parsePluginRequest(
      pluginJobRunsQuerySchema.safeParse(req.query),
      "Invalid plugin job runs query",
    );
    const limit = Number(rawLimit);

    try {
      const runs = await runtime.jobStore.listRunsByJob(jobId, limit);
      res.json(runs.map(serializePluginJobRun));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  /**
   * POST /api/plugins/:pluginId/jobs/:jobId/trigger
   *
   * Manually trigger a job execution outside its cron schedule.
   *
   * Creates a run with `trigger: "manual"` and dispatches immediately.
   * The response returns before the job completes (non-blocking).
   *
   * Response: `{ runId: string, jobId: string }`
   * Errors:
   * - 404 if plugin not found
   * - 400 if job not found, not active, already running, or worker unavailable
   */
  router.post("/plugins/:pluginId/jobs/:jobId/trigger", async (req, res) => {
    assertInstanceAdmin(req);
    const { pluginId, jobId } = req.params;
    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    const job = await runtime.jobStore.getJobByIdForPlugin(plugin.id, jobId);
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }

    try {
      const result = await runtime.scheduler.triggerJob(jobId);
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  // ===========================================================================
  // Webhook ingestion route
  // ===========================================================================

  /**
   * POST /api/plugins/:pluginId/webhooks/:endpointKey
   *
   * Receive an inbound webhook delivery for a plugin.
   *
   * This route is called by external systems (e.g. GitHub, Linear, Stripe) to
   * deliver webhook payloads to a plugin. The host validates that:
   * 1. The plugin exists and is in 'ready' state
   * 2. The plugin declares the `webhooks.receive` capability
   * 3. The `endpointKey` matches a declared webhook in the manifest
   *
   * The delivery is recorded in the `plugin_webhook_deliveries` table and
   * dispatched to the worker via the `handleWebhook` RPC method.
   *
   * **Note:** This route does NOT require board authentication — webhook
   * endpoints must be publicly accessible for external callers. Signature
   * verification is the plugin's responsibility.
   *
   * Response: `{ deliveryId: string, status: string }`
   * Errors:
   * - 404 if plugin not found or endpointKey not declared
   * - 400 if the plugin lacks webhooks.receive capability
   * - 502 if the worker is unavailable or the RPC call fails
   */
  router.post("/plugins/:pluginId/webhooks/:endpointKey", pluginWebhookBodyParser, async (req, res) => {
    const { pluginId, endpointKey } = req.params;

    // Step 1: Resolve the plugin
    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    // Step 2: Validate the plugin is in 'ready' state
    if (plugin.status !== "ready") {
      sendPluginBridgeError(req, res, 502, new JsonRpcCallError({
        code: PLUGIN_RPC_ERROR_CODES.WORKER_UNAVAILABLE,
        message: `Plugin is not ready (current status: ${plugin.status})`,
      }), {
        pluginId: plugin.id,
        pluginKey: plugin.pluginKey,
        bridgeMethod: "handleWebhook",
        endpointKey,
      });
      return;
    }

    // Step 3: Validate the plugin has webhooks.receive capability
    const manifest = plugin.manifestJson;
    const capabilities = manifest.capabilities;
    if (!capabilities.includes("webhooks.receive")) {
      res.status(400).json({
        error: "Plugin does not have the webhooks.receive capability",
      });
      return;
    }

    // Step 4: Validate the endpointKey exists in the manifest's webhook declarations
    const declaredWebhooks = manifest.webhooks ?? [];
    const webhookDecl = declaredWebhooks.find(
      (w) => w.endpointKey === endpointKey,
    );
    if (!webhookDecl) {
      res.status(404).json({
        error: `Webhook endpoint '${endpointKey}' is not declared by this plugin`,
      });
      return;
    }

    // Step 5: Extract request data
    const requestId = randomUUID();
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === "string") {
        headers[key] = value;
      } else if (Array.isArray(value)) {
        headers[key] = value.join(", ");
      }
    }

    // JSON bodies retain the buffer stashed by the global parser. The local
    // raw parser supplies every body type that the JSON parser skipped.
    const stashedRaw = (req as unknown as { rawBody?: Buffer }).rawBody;
    const bodyWasParsedAsRaw = Buffer.isBuffer(req.body);
    const rawBody = (stashedRaw ?? (bodyWasParsedAsRaw ? req.body : undefined))
      ?.toString("utf-8") ?? "";
    const parsedBody = bodyWasParsedAsRaw ? undefined : req.body as unknown;

    // Step 6: Record the delivery in the database
    const requestStartedAt = new Date();
    const [delivery] = await db
      .insert(pluginWebhookDeliveries)
      .values({
        pluginId: plugin.id,
        webhookKey: endpointKey,
        status: "pending",
      })
      .returning({ id: pluginWebhookDeliveries.id });
    if (!delivery) {
      throw new Error("Plugin webhook delivery insert returned no record");
    }

    // Step 7: Dispatch to the worker via handleWebhook RPC
    try {
      await runtime.workerManager.call(plugin.id, "handleWebhook", {
        endpointKey,
        headers,
        rawBody,
        parsedBody,
        requestId,
      });

      // Step 8: Update delivery record to success
      const finishedAt = new Date();
      const durationMs = finishedAt.getTime() - requestStartedAt.getTime();
      await db
        .update(pluginWebhookDeliveries)
        .set({
          status: "success",
          durationMs,
          finishedAt,
        })
        .where(eq(pluginWebhookDeliveries.id, delivery.id));

      res.status(200).json({
        deliveryId: delivery.id,
        status: "success",
      });
    } catch (err) {
      // Step 8 (error): Update delivery record to failed
      const finishedAt = new Date();
      const durationMs = finishedAt.getTime() - requestStartedAt.getTime();
      const errorMessage = err instanceof Error ? err.message : String(err);

      await db
        .update(pluginWebhookDeliveries)
        .set({
          status: "failed",
          durationMs,
          error: errorMessage,
          finishedAt,
        })
        .where(eq(pluginWebhookDeliveries.id, delivery.id));

      sendPluginBridgeError(req, res, 502, err, {
        pluginId: plugin.id,
        pluginKey: plugin.pluginKey,
        bridgeMethod: "handleWebhook",
        endpointKey,
        deliveryId: delivery.id,
      });
    }
  });

  // ===========================================================================
  // Company-scoped trusted local folders
  // ===========================================================================

  router.get("/plugins/:pluginId/companies/:companyId/local-folders", async (req, res) => {
    assertBoardOrgAccess(req);
    const { pluginId, companyId } = req.params;
    assertCompanyAccess(req, companyId);

    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    const settings = await registry.getCompanySettings(plugin.id, companyId);
    const storedFolders = getStoredLocalFolders(settings?.settingsJson);
    const declarations = plugin.manifestJson.localFolders ?? [];
    const statuses = await Promise.all(declarations.map((declaration) =>
      inspectPluginLocalFolder({
        declaration,
        path: storedFolders[declaration.folderKey]?.path ?? null,
      })));

    res.json({
      pluginId: plugin.id,
      companyId,
      folders: statuses,
    });
  });

  router.get("/plugins/:pluginId/companies/:companyId/local-folders/:folderKey/status", async (req, res) => {
    assertBoardOrgAccess(req);
    const { pluginId, companyId, folderKey } = req.params;
    assertCompanyAccess(req, companyId);

    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    const settings = await registry.getCompanySettings(plugin.id, companyId);
    const storedFolders = getStoredLocalFolders(settings?.settingsJson);
    const declarations = plugin.manifestJson.localFolders ?? [];
    const declaration = requireLocalFolderDeclaration(declarations, folderKey);
    const status = await inspectPluginLocalFolder({
      declaration,
      path: storedFolders[folderKey]?.path ?? null,
    });
    res.json(status);
  });

  router.post("/plugins/:pluginId/companies/:companyId/local-folders/:folderKey/validate", async (req, res) => {
    assertBoardOrgAccess(req);
    const { pluginId, companyId, folderKey } = req.params;
    assertCompanyAccess(req, companyId);

    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    const body = parseLocalFolderPathInput(req.body);

    const declaration = requireLocalFolderDeclaration(plugin.manifestJson.localFolders ?? [], folderKey);
    const status = await inspectPluginLocalFolder({
      declaration,
      path: body.path,
    });
    res.json(status);
  });

  router.put("/plugins/:pluginId/companies/:companyId/local-folders/:folderKey", async (req, res) => {
    assertBoardOrgAccess(req);
    const { pluginId, companyId, folderKey } = req.params;
    assertCompanyAccess(req, companyId);

    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    const body = parseLocalFolderPathInput(req.body);

    const existing = await registry.getCompanySettings(plugin.id, companyId);
    const declaration = requireLocalFolderDeclaration(plugin.manifestJson.localFolders ?? [], folderKey);
    const status = await prepareAndInspectPluginLocalFolder({
      declaration,
      path: body.path,
    });

    const nextSettings = setStoredLocalFolder(existing?.settingsJson, folderKey, body.path);
    await registry.upsertCompanySettings(plugin.id, companyId, {
      settingsJson: nextSettings,
    });
    await logPluginMutationActivity(req, "plugin.local_folder.configured", plugin.id, {
      pluginId: plugin.id,
      pluginKey: plugin.pluginKey,
      companyId,
      folderKey,
      healthy: status.healthy,
    });

    res.json(status);
  });

  // ===========================================================================
  // Plugin health dashboard — aggregated diagnostics for the settings page
  // ===========================================================================

  /**
   * GET /api/plugins/:pluginId/dashboard
   *
   * Aggregated health dashboard data for a plugin's settings page.
   *
   * Returns worker diagnostics (status, uptime, crash history), recent job
   * runs, recent webhook deliveries, and the current health check result —
   * all in a single response to avoid multiple round-trips.
   *
   * Response: PluginDashboardData
   * Errors: 404 if plugin not found
  */
  router.get("/plugins/:pluginId/dashboard", async (req, res) => {
    assertInstanceAdmin(req);
    const { pluginId } = req.params;

    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    // --- Worker diagnostics ---
    let worker: PluginWorkerDiagnostics | null = null;

    const workerHandle = runtime.workerManager.getWorker(plugin.id);
    if (workerHandle) {
      const diag = workerHandle.diagnostics();
      worker = {
        status: diag.status,
        pid: diag.pid,
        uptime: diag.uptime,
        consecutiveCrashes: diag.consecutiveCrashes,
        totalCrashes: diag.totalCrashes,
        pendingRequests: diag.pendingRequests,
        lastCrashAt: diag.lastCrashAt,
        nextRestartAt: diag.nextRestartAt,
      };
    }

    // --- Recent job runs (last 10, newest first) ---
    const runs = await runtime.jobStore.listRunsByPlugin(plugin.id, undefined, 10);
    const jobs = await runtime.jobStore.listJobs(plugin.id);
    const jobKeyMap = new Map(jobs.map((job) => [job.id, job.jobKey]));
    const recentJobRuns: PluginDashboardJobRun[] = runs.map((run) => {
        const jobKey = jobKeyMap.get(run.jobId);
        if (!jobKey) {
          throw new Error(`Plugin job run ${run.id} references an unavailable job`);
        }
        return {
          id: run.id,
          jobId: run.jobId,
          jobKey,
          trigger: run.trigger,
          status: run.status,
          durationMs: run.durationMs,
          error: run.error,
          startedAt: run.startedAt ? new Date(run.startedAt).toISOString() : null,
          finishedAt: run.finishedAt ? new Date(run.finishedAt).toISOString() : null,
          createdAt: new Date(run.createdAt).toISOString(),
        };
      });

    // --- Recent webhook deliveries (last 10, newest first) ---
    const deliveries = await db
      .select({
        id: pluginWebhookDeliveries.id,
        webhookKey: pluginWebhookDeliveries.webhookKey,
        status: pluginWebhookDeliveries.status,
        durationMs: pluginWebhookDeliveries.durationMs,
        error: pluginWebhookDeliveries.error,
        finishedAt: pluginWebhookDeliveries.finishedAt,
        createdAt: pluginWebhookDeliveries.createdAt,
      })
      .from(pluginWebhookDeliveries)
      .where(eq(pluginWebhookDeliveries.pluginId, plugin.id))
      .orderBy(desc(pluginWebhookDeliveries.createdAt))
      .limit(10);

    const recentWebhookDeliveries: PluginDashboardWebhookDelivery[] = deliveries.map((delivery) => ({
      id: delivery.id,
      webhookKey: delivery.webhookKey,
      status: delivery.status,
      durationMs: delivery.durationMs,
      error: delivery.error,
      finishedAt: delivery.finishedAt ? delivery.finishedAt.toISOString() : null,
      createdAt: delivery.createdAt.toISOString(),
    }));

    const health = buildPluginHealthResult(plugin);
    const workerRunning = worker?.status === "running";
    health.checks.push({
      name: "worker",
      passed: workerRunning,
      message: workerRunning
        ? "Plugin worker is running"
        : worker
          ? `Plugin worker status: ${worker.status}`
          : "Plugin worker is not registered",
    });
    health.healthy = health.healthy && workerRunning;

    if (workerRunning) {
      try {
        const reportedHealth = decodePluginWorkerHealth(await runtime.workerManager.call(
          plugin.id,
          "health",
          {},
        ));
        const passed = reportedHealth.status === "ok";
        health.checks.push({
          name: "plugin",
          passed,
          message: reportedHealth.message ?? `Plugin reported ${reportedHealth.status}`,
        });
        health.healthy = health.healthy && passed;
      } catch (err) {
        const bridgeError = mapRpcErrorToBridgeError(err);
        health.checks.push({
          name: "plugin",
          passed: false,
          message: bridgeError.message,
        });
        health.healthy = false;
      }
    }

    const dashboard: PluginDashboardData = {
      pluginId: plugin.id,
      worker,
      recentJobRuns,
      recentWebhookDeliveries,
      health,
      checkedAt: new Date().toISOString(),
    };
    res.json(dashboard);
  });

  return router;
}
