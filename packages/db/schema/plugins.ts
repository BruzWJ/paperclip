import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type {
  PaperclipPluginManifestV1,
  PluginInstallSource,
  PluginStatus,
} from "@paperclipai/shared";

/**
 * `plugins` table — stores one row per installed plugin.
 *
 * Each plugin installation is uniquely identified by `plugin_key` (derived
 * from the manifest `id`). Uninstall deletes the installation; reinstalling
 * creates a new row and installation identity. The full manifest is persisted
 * as JSONB in `manifest_json` so the host can reconstruct capability and UI
 * slot information without loading the plugin package.
 *
 * @see PLUGIN_SPEC.md §21.3
 */
export const plugins = pgTable(
  "plugins",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pluginKey: text("plugin_key").notNull(),
    packageName: text("package_name").notNull(),
    source: text("source").$type<PluginInstallSource>().notNull(),
    manifestJson: jsonb("manifest_json").$type<PaperclipPluginManifestV1>().notNull(),
    status: text("status").$type<PluginStatus>().notNull().default("ready"),
    installOrder: integer("install_order").notNull(),
    /** Canonical resolved package root for this installation. */
    packagePath: text("package_path").notNull(),
    lastError: text("last_error"),
    installedAt: timestamp("installed_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pluginKeyIdx: uniqueIndex("plugins_plugin_key_idx").on(table.pluginKey),
    installOrderIdx: uniqueIndex("plugins_install_order_idx").on(table.installOrder),
    statusIdx: index("plugins_status_idx").on(table.status),
  }),
);
