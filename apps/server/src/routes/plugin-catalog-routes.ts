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
  pluginListQuerySchema,
  serializePluginRecord,
  type PluginBridgeError,
  type PluginUiContribution,
} from "@paperclipai/shared";
import type { Request, Response } from "express";
import { attachErrorContext } from "../middleware/error-handler.js";
import { logger } from "../middleware/logger.js";
import { PluginCatalogOperationError } from "../services/plugin-catalog.js";
import { assertBoardOrgAccess, assertInstanceAdmin } from "./authz.js";
import type { PluginRouteContext } from "./plugin-route-context.js";

type PluginCatalogRoutesContext = Pick<
  PluginRouteContext,
  | "lifecycle"
  | "parsePluginRequest"
  | "parsePluginInstallRequest"
  | "parsePluginCatalogInstallRequest"
  | "router"
  | "registry"
  | "catalog"
  | "logPluginMutationActivity"
>;

export function registerPluginCatalogRoutes(context: PluginCatalogRoutesContext): void {
  const {
    lifecycle,
    parsePluginRequest,
    parsePluginInstallRequest,
    parsePluginCatalogInstallRequest,
    router,
    registry,
    catalog,
    logPluginMutationActivity,
  } = context;

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
    const plugins = status ? await registry.listByStatus(status) : await registry.list();
    res.json(plugins.map(serializePluginRecord));
  });

  /** List installable plugin packages from this source checkout. */
  router.get("/plugins/catalog", async (req, res) => {
    assertInstanceAdmin(req);
    res.json(await catalog.list());
  });

  /** Build and install one exact package selected from the repo plugin catalog. */
  router.post("/plugins/catalog/install", async (req, res) => {
    assertInstanceAdmin(req);
    const { packageName } = parsePluginCatalogInstallRequest(req.body);

    let installed;
    try {
      installed = await catalog.install(packageName, {
        isInstalled: async () => (await registry.list()).some((plugin) => plugin.packageName === packageName),
        install: (packageRoot) =>
          lifecycle.install({
            source: "local",
            path: packageRoot,
          }),
      });
    } catch (error) {
      const message =
        error instanceof PluginCatalogOperationError
          ? error.message
          : `Failed to install catalog plugin: ${packageName}`;
      res.status(400).json({ error: message });
      return;
    }

    try {
      await logPluginMutationActivity(req, "plugin.installed", installed.id, {
        pluginId: installed.id,
        pluginKey: installed.pluginKey,
        packageName: installed.packageName,
        version: installed.manifestJson.version,
        source: "local",
      });
    } catch (error) {
      logger.error(
        {
          err: error,
          pluginId: installed.id,
          packageName,
        },
        "failed to log catalog plugin installation activity",
      );
    }

    res.status(201).json(serializePluginRecord(installed));
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
    attachErrorContext(
      req,
      res,
      {
        message: bridgeError.message,
        stack: rootError.stack,
        name: rootError.name,
        details: {
          ...metadata,
          bridgeCode: bridgeError.code,
          bridgeDetails: bridgeError.details,
        },
      },
      rootError,
    );
    res.status(status).json(bridgeError);
  }
}
