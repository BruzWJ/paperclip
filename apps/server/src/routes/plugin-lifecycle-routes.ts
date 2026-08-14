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

import { pluginLogs } from "@paperclipai/db";
import {
  JsonRpcCallError,
  PLUGIN_RPC_ERROR_CODES,
  type PluginApiRequestInput,
} from "@paperclipai/plugin-sdk";
import {
  isCanonicalUuid,
  pluginDisableRequestSchema,
  pluginLogsQuerySchema,
  pluginUpgradeRequestSchema,
  serializePluginDetail,
  serializePluginLog,
  serializePluginRecord,
} from "@paperclipai/shared";
import { and, desc, eq, gte } from "drizzle-orm";
import { assertBoard, assertBoardOrgAccess, assertCompanyAccess, assertInstanceAdmin } from "./authz.js";
import type { PluginRouteContext } from "./plugin-route-context.js";
import { sendPluginBridgeError } from "./plugin-route-errors.js";

type PluginLifecycleRoutesContext = Pick<
  PluginRouteContext,
  | "db"
  | "lifecycle"
  | "runtime"
  | "PLUGIN_API_BODY_LIMIT_BYTES"
  | "resolvePlugin"
  | "parsePluginRequest"
  | "router"
  | "registry"
  | "matchScopedApiRoute"
  | "sanitizePluginRequestHeaders"
  | "applyPluginScopedApiResponseHeaders"
  | "parseExactPluginQuery"
  | "resolveScopedApiCompanyId"
  | "logPluginMutationActivity"
>;

export function registerPluginLifecycleRoutes(context: PluginLifecycleRoutesContext): void {
  const {
    db,
    lifecycle,
    runtime,
    PLUGIN_API_BODY_LIMIT_BYTES,
    resolvePlugin,
    parsePluginRequest,
    router,
    registry,
    matchScopedApiRoute,
    sanitizePluginRequestHeaders,
    applyPluginScopedApiResponseHeaders,
    parseExactPluginQuery,
    resolveScopedApiCompanyId,
    logPluginMutationActivity,
  } = context;

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
        {
          pluginId: plugin.id,
          pluginKey: plugin.pluginKey,
          bridgeMethod: "handleApiRequest",
        },
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
        {
          pluginId: plugin.id,
          pluginKey: plugin.pluginKey,
          bridgeMethod: "handleApiRequest",
        },
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
      .map((route) => ({
        route,
        params: matchScopedApiRoute(route, req.method, requestPath),
      }))
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
        query: parseExactPluginQuery(req.query),
        body: requestBody,
        actor: {
          type: "user",
          userId: req.actor.userId,
        },
        companyId,
        headers: sanitizePluginRequestHeaders(req),
      };

      const result = await runtime.workerManager.call(plugin.id, "handleApiRequest", input);
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
        const status =
          err.code === PLUGIN_RPC_ERROR_CODES.CAPABILITY_DENIED ||
          err.code === PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED
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
    const supportsConfigTest = worker ? worker.supportedMethods.includes("validateConfig") : false;

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
    if (!isCanonicalUuid(pluginId)) {
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

    const query = parsePluginRequest(pluginLogsQuerySchema.safeParse(req.query), "Invalid plugin logs query");
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
}
