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

import { pluginWebhookDeliveries } from "@paperclipai/db";
import { JsonRpcCallError, PLUGIN_RPC_ERROR_CODES } from "@paperclipai/plugin-sdk";
import { isCanonicalUuid } from "@paperclipai/shared";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { badRequest } from "../errors.js";
import {
  getStoredLocalFolders,
  inspectPluginLocalFolder,
  prepareAndInspectPluginLocalFolder,
  requireLocalFolderDeclaration,
  setStoredLocalFolder,
} from "../services/plugin-local-folders.js";
import { assertBoardOrgAccess, assertCompanyAccess } from "./authz.js";
import type { PluginRouteContext } from "./plugin-route-context.js";
import { sendPluginBridgeError } from "./plugin-route-errors.js";

type PluginWebhookFolderRoutesContext = Pick<
  PluginRouteContext,
  | "db"
  | "runtime"
  | "pluginWebhookBodyParser"
  | "resolvePlugin"
  | "parseLocalFolderPathInput"
  | "router"
  | "registry"
  | "logPluginMutationActivity"
>;

export function registerPluginWebhookAndFolderRoutes(context: PluginWebhookFolderRoutesContext): void {
  const {
    db,
    runtime,
    pluginWebhookBodyParser,
    resolvePlugin,
    parseLocalFolderPathInput,
    router,
    registry,
    logPluginMutationActivity,
  } = context;

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
    const pluginId = req.params.pluginId as string;
    const endpointKey = req.params.endpointKey as string;

    // Step 1: Resolve the plugin
    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    // Step 2: Validate the plugin is in 'ready' state
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
          bridgeMethod: "handleWebhook",
          endpointKey,
        },
      );
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
    const webhookDecl = declaredWebhooks.find((w) => w.endpointKey === endpointKey);
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
    const rawBody = (stashedRaw ?? (bodyWasParsedAsRaw ? req.body : undefined))?.toString("utf-8") ?? "";
    const parsedBody = bodyWasParsedAsRaw ? undefined : (req.body as unknown);

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
    if (!isCanonicalUuid(companyId)) throw badRequest("companyId must be an exact canonical UUID");
    assertCompanyAccess(req, companyId);

    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    const settings = await registry.getCompanySettings(plugin.id, companyId);
    const storedFolders = getStoredLocalFolders(settings?.settingsJson);
    const declarations = plugin.manifestJson.localFolders ?? [];
    const statuses = await Promise.all(
      declarations.map((declaration) =>
        inspectPluginLocalFolder({
          declaration,
          path: storedFolders[declaration.folderKey]?.path ?? null,
        }),
      ),
    );

    res.json({
      pluginId: plugin.id,
      companyId,
      folders: statuses,
    });
  });

  router.get("/plugins/:pluginId/companies/:companyId/local-folders/:folderKey/status", async (req, res) => {
    assertBoardOrgAccess(req);
    const { pluginId, companyId, folderKey } = req.params;
    if (!isCanonicalUuid(companyId)) throw badRequest("companyId must be an exact canonical UUID");
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

  router.post(
    "/plugins/:pluginId/companies/:companyId/local-folders/:folderKey/validate",
    async (req, res) => {
      assertBoardOrgAccess(req);
      const { pluginId, companyId, folderKey } = req.params;
      if (!isCanonicalUuid(companyId)) throw badRequest("companyId must be an exact canonical UUID");
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
    },
  );

  router.put("/plugins/:pluginId/companies/:companyId/local-folders/:folderKey", async (req, res) => {
    assertBoardOrgAccess(req);
    const { pluginId, companyId, folderKey } = req.params;
    if (!isCanonicalUuid(companyId)) throw badRequest("companyId must be an exact canonical UUID");
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
}
