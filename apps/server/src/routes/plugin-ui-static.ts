/**
 * @fileoverview Plugin UI static file serving route
 *
 * Serves plugin UI bundles from the plugin's dist/ui/ directory under the
 * `/_plugins/:pluginId/ui/*` namespace. This is specified in PLUGIN_SPEC.md
 * §19.0.3 (Bundle Serving).
 *
 * Plugin UI bundles are pre-built ESM that the host serves as static assets.
 * The host dynamically imports the plugin's UI entry module from this path,
 * resolves the named export declared in `ui.slots[].exportName`, and mounts
 * it into the extension slot.
 *
 * Security:
 * - Path traversal is prevented by resolving the requested path and verifying
 *   it stays within the plugin's UI directory.
 * - Only plugins in 'ready' status have their UI served.
 * - Only plugins that declare `entrypoints.ui` serve UI bundles.
 *
 * Cache Headers:
 * - Files with content-hash patterns in their name (e.g., `index-a1b2c3d4.js`)
 *   receive `Cache-Control: public, max-age=31536000, immutable`.
 * - Other files receive `Cache-Control: public, max-age=0, must-revalidate`
 *   with ETag-based conditional request support.
 *
 * @module apps/server/routes/plugin-ui-static
 * @see doc/plugins/PLUGIN_SPEC.md §19.0.3 — Bundle Serving
 * @see doc/plugins/PLUGIN_SPEC.md §25.4.5 — Frontend Cache Invalidation
 */

import { Router } from "express";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import type { Db } from "@paperclipai/db";
import { isCanonicalUuid } from "@paperclipai/shared";
import { pluginRegistryService } from "../services/plugin-registry.js";
import { logger } from "../middleware/logger.js";
import {
  PluginPathError,
  resolvePluginPath,
} from "../services/plugin-paths.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Regex to detect content-hashed filenames.
 *
 * Matches patterns like:
 * - `index-a1b2c3d4.js`
 * - `styles.abc123def.css`
 * - `chunk-ABCDEF01.mjs`
 *
 * The hash portion must be at least 8 hex characters to avoid false positives.
 */
const CONTENT_HASH_PATTERN = /[.-][a-fA-F0-9]{8,}\.\w+$/;

/**
 * Cache-Control header for content-hashed files.
 * These files are immutable by definition (the hash changes when content changes).
 */
/** 1 year in seconds — standard for content-hashed immutable resources. */
const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60; // 31_536_000
const CACHE_CONTROL_IMMUTABLE = `public, max-age=${ONE_YEAR_SECONDS}, immutable`;

/**
 * Cache-Control header for non-hashed files.
 * These files must be revalidated on each request (ETag-based).
 */
const CACHE_CONTROL_REVALIDATE = "public, max-age=0, must-revalidate";

/**
 * MIME types for common plugin UI bundle file extensions.
 */
const MIME_TYPES: Record<string, string> = {
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".eot": "application/vnd.ms-fontobject",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * Compute an ETag from file stat (size + mtime).
 * This is a lightweight approach that avoids reading the file content.
 */
function computeETag(size: number, mtimeMs: number): string {
  const ETAG_VERSION = "v2";
  const hash = crypto
    .createHash("md5")
    .update(`${ETAG_VERSION}:${size}-${mtimeMs}`)
    .digest("hex")
    .slice(0, 16);
  return `"${hash}"`;
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

/**
 * Create an Express router that serves plugin UI static files.
 *
 * This route handles `GET /_plugins/:pluginId/ui/*` requests by:
 * 1. Looking up the plugin installation by UUID
 * 2. Verifying the plugin is in 'ready' status with UI declared
 * 3. Resolving the file path within the plugin's dist/ui/ directory
 * 4. Serving the file with appropriate cache headers
 *
 * @param db - Database connection for plugin registry lookups
 * @returns Express router
 */
export function pluginUiStaticRoutes(db: Db) {
  const router = Router({ caseSensitive: true, strict: true });
  const registry = pluginRegistryService(db);
  const log = logger.child({ service: "plugin-ui-static" });

  /**
   * GET /_plugins/:pluginId/ui/*
   *
   * Serve a static file from a plugin's UI bundle directory.
   *
   * The :pluginId parameter is the installation's database UUID.
   *
   * The wildcard captures the relative file path within the UI directory.
   *
   * Cache strategy:
   * - Content-hashed filenames → immutable, 1-year max-age
   * - Other files → must-revalidate with ETag
   */
  router.get("/_plugins/:pluginId/ui/*filePath", async (req, res) => {
    const { pluginId } = req.params;

    // Extract the relative file path from the named wildcard.
    // In Express 5 with path-to-regexp v8, named wildcards may return
    // an array of path segments or a single string.
    const rawParam = req.params.filePath;
    const rawFilePath = Array.isArray(rawParam)
      ? rawParam.join("/")
      : rawParam as string | undefined;

    if (!rawFilePath || rawFilePath.length === 0) {
      res.status(400).json({ error: "File path is required" });
      return;
    }

    // Step 1: Look up the exact installation UUID.
    if (!isCanonicalUuid(pluginId)) {
      res.status(400).json({ error: "Invalid plugin installation ID" });
      return;
    }
    const plugin = await registry.getById(pluginId);

    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    // Step 2: Verify the plugin is ready and has UI declared
    if (plugin.status !== "ready") {
      res.status(403).json({
        error: `Plugin UI is not available (status: ${plugin.status})`,
      });
      return;
    }

    const manifest = plugin.manifestJson;
    if (!manifest.entrypoints.ui) {
      res.status(404).json({ error: "Plugin does not declare a UI bundle" });
      return;
    }

    // Step 3: Resolve the plugin's UI directory
    let uiDir: string;
    try {
      uiDir = resolvePluginPath(plugin.packagePath, manifest.entrypoints.ui, {
        label: "Plugin UI directory",
        kind: "directory",
      });
    } catch (error) {
      const accessDenied = error instanceof PluginPathError
        && (error.failure === "escape" || error.failure === "invalid_relative_path");
      log.warn(
        {
          err: error,
          pluginId: plugin.id,
          pluginKey: plugin.pluginKey,
          packageName: plugin.packageName,
        },
        "plugin-ui-static: UI directory is unavailable",
      );
      res.status(accessDenied ? 403 : 404).json({
        error: accessDenied ? "Access denied" : "Plugin UI directory not found",
      });
      return;
    }

    // Step 4: Resolve symlinks, enforce containment, and require a regular file.
    let realFilePath: string;
    let fileStat: fs.Stats;
    try {
      realFilePath = resolvePluginPath(uiDir, rawFilePath, {
        label: "Plugin UI asset",
        kind: "file",
      });
      fileStat = fs.statSync(realFilePath);
    } catch (error) {
      const accessDenied = error instanceof PluginPathError
        && (error.failure === "escape" || error.failure === "invalid_relative_path");
      res.status(accessDenied ? 403 : 404).json({
        error: accessDenied ? "Access denied" : "File not found",
      });
      return;
    }

    // Step 5: Determine cache strategy based on filename
    const basename = path.basename(realFilePath);
    const isContentHashed = CONTENT_HASH_PATTERN.test(basename);

    // Step 6: Set cache headers
    if (isContentHashed) {
      res.set("Cache-Control", CACHE_CONTROL_IMMUTABLE);
    } else {
      res.set("Cache-Control", CACHE_CONTROL_REVALIDATE);

      // Compute and set ETag for conditional request support
      const etag = computeETag(fileStat.size, fileStat.mtimeMs);
      res.set("ETag", etag);

      // Check If-None-Match for 304 Not Modified
      const ifNoneMatch = req.headers["if-none-match"];
      if (ifNoneMatch === etag) {
        res.status(304).end();
        return;
      }
    }

    // Step 7: Set Content-Type
    const ext = path.extname(realFilePath).toLowerCase();
    const contentType = MIME_TYPES[ext];
    if (contentType) {
      res.set("Content-Type", contentType);
    }

    // Step 8: Send the file
    // The plugin source can live in Git worktrees (e.g. ".worktrees/...").
    // `send` defaults to dotfiles:"ignore", which treats dot-directories as
    // not found. We already enforce traversal safety above, so allow dot paths.
    res.sendFile(realFilePath, { dotfiles: "allow" }, (err) => {
      if (err) {
        log.error(
          { err, pluginId: plugin.id, filePath: realFilePath },
          "plugin-ui-static: error sending file",
        );
        // Only send error if headers haven't been sent yet
        if (!res.headersSent) {
          res.status(500).json({ error: "Failed to serve file" });
        }
      }
    });
  });

  return router;
}
