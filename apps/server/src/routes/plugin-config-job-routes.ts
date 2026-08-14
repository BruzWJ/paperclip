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

import { JsonRpcCallError, PLUGIN_RPC_ERROR_CODES } from "@paperclipai/plugin-sdk";
import {
  isCanonicalUuid,
  pluginJobRunsQuerySchema,
  serializePluginConfig,
  serializePluginJob,
  serializePluginJobRun,
} from "@paperclipai/shared";
import { assertInstanceAdmin } from "./authz.js";
import type { PluginRouteContext } from "./plugin-route-context.js";
import { sendPluginBridgeError } from "./plugin-route-errors.js";

type PluginConfigJobRoutesContext = Pick<
  PluginRouteContext,
  | "lifecycle"
  | "runtime"
  | "resolvePlugin"
  | "parsePluginRequest"
  | "parsePluginConfigRequest"
  | "router"
  | "registry"
  | "logPluginMutationActivity"
>;

export function registerPluginConfigAndJobRoutes(context: PluginConfigJobRoutesContext): void {
  const {
    lifecycle,
    runtime,
    resolvePlugin,
    parsePluginRequest,
    parsePluginConfigRequest,
    router,
    registry,
    logPluginMutationActivity,
  } = context;

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

    const parsedConfig = parsePluginConfigRequest(req.body, plugin.manifestJson.instanceConfigSchema);
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
      sendPluginBridgeError(
        req,
        res,
        502,
        new JsonRpcCallError({
          code: PLUGIN_RPC_ERROR_CODES.WORKER_UNAVAILABLE,
          message: `Plugin is not ready (current status: ${plugin.status})`,
        }),
        {
          pluginId: plugin.id,
          pluginKey: plugin.pluginKey,
          bridgeMethod: "validateConfig",
        },
      );
      return;
    }

    const parsedConfig = parsePluginConfigRequest(req.body, plugin.manifestJson.instanceConfigSchema);
    if (!parsedConfig.ok) {
      res.status(400).json(parsedConfig.response);
      return;
    }

    try {
      const result = await runtime.workerManager.call(plugin.id, "validateConfig", {
        config: parsedConfig.configJson,
      });

      // The worker returns PluginConfigValidationResult { ok, warnings?, errors? }
      // Map to the frontend-expected shape { valid, message? }
      if (result.ok) {
        const warningText = result.warnings?.length ? `Warnings: ${result.warnings.join("; ")}` : undefined;
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
    if (!isCanonicalUuid(jobId)) {
      res.status(404).json({ error: "Job not found" });
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
    if (!isCanonicalUuid(jobId)) {
      res.status(404).json({ error: "Job not found" });
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
}
