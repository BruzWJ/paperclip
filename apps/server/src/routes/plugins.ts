import { type Db, pluginWebhookDeliveries } from "@paperclipai/db";
import { registerPluginCatalogRoutes } from "./plugin-catalog-routes.js";
import { registerPluginConfigAndJobRoutes } from "./plugin-config-job-routes.js";
import { registerPluginLifecycleRoutes } from "./plugin-lifecycle-routes.js";
import {
  createPluginRouteContext,
  type PluginRouteLifecycle,
  type PluginRouteOptions,
  type PluginRouteContext,
} from "./plugin-route-context.js";
import { registerPluginWebhookAndFolderRoutes } from "./plugin-webhook-folder-routes.js";

import { JsonRpcCallError, PLUGIN_RPC_ERROR_CODES } from "@paperclipai/plugin-sdk";
import { assertBoardOrgAccess, assertInstanceAdmin } from "./authz.js";
import { sendPluginBridgeError, mapRpcErrorToBridgeError } from "./plugin-route-errors.js";

import type {
  PluginDashboardData,
  PluginDashboardJobRun,
  PluginDashboardWebhookDelivery,
  PluginWorkerDiagnostics,
} from "@paperclipai/shared";
import { desc, eq } from "drizzle-orm";
import { decodePluginWorkerHealth } from "../services/plugin-worker-manager.js";

type PluginDashboardRoutesContext = Pick<
  PluginRouteContext,
  "db" | "runtime" | "resolvePlugin" | "buildPluginHealthResult" | "router" | "registry"
>;

export function registerPluginDashboardRoutes(context: PluginDashboardRoutesContext): void {
  const { db, runtime, resolvePlugin, buildPluginHealthResult, router, registry } = context;

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
        const reportedHealth = decodePluginWorkerHealth(
          await runtime.workerManager.call(plugin.id, "health", {}),
        );
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
}

type PluginDataActionRoutesContext = Pick<
  PluginRouteContext,
  | "runtime"
  | "resolvePlugin"
  | "parsePluginBridgeRequest"
  | "router"
  | "registry"
  | "assertPluginBridgeScope"
  | "performActionActorContext"
>;

export function registerPluginDataActionRoutes(context: PluginDataActionRoutesContext): void {
  const {
    runtime,
    resolvePlugin,
    parsePluginBridgeRequest,
    router,
    registry,
    assertPluginBridgeScope,
    performActionActorContext,
  } = context;

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
      const result = await runtime.workerManager.call(plugin.id, "getData", {
        key,
        ...(companyId ? { companyId } : {}),
        params: body.params ?? {},
        renderEnvironment: body.renderEnvironment ?? null,
      });
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
      const result = await runtime.workerManager.call(plugin.id, "performAction", {
        key,
        params: {
          ...(body.params ?? {}),
          ...(companyId ? { companyId } : {}),
        },
        actorContext: performActionActorContext(req, companyId),
        renderEnvironment: body.renderEnvironment ?? null,
      });
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
}

export function pluginRoutes(db: Db, lifecycle: PluginRouteLifecycle, options: PluginRouteOptions) {
  const context = createPluginRouteContext(db, lifecycle, options);
  registerPluginCatalogRoutes(context);
  registerPluginDataActionRoutes(context);
  registerPluginLifecycleRoutes(context);
  registerPluginConfigAndJobRoutes(context);
  registerPluginWebhookAndFolderRoutes(context);
  registerPluginDashboardRoutes(context);
  return context.router;
}
