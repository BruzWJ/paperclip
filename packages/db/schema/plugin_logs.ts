import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { plugins } from "./plugins.js";
import type { PluginLogLevel } from "@paperclipai/shared";

/**
 * `plugin_logs` table — structured log storage for plugin workers.
 *
 * Each row stores a single log entry emitted by a plugin worker via
 * `ctx.logger.info(...)` etc. Logs are queryable by plugin, level, and
 * time range to support the operator logs panel and debugging workflows.
 *
 * Rows are inserted by the host when handling awaited `log` requests from
 * the worker process.
 *
 * @see PLUGIN_SPEC.md §26 — Observability
 */
export const pluginLogs = pgTable(
  "plugin_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pluginId: uuid("plugin_id")
      .notNull()
      .references(() => plugins.id, { onDelete: "cascade" }),
    /** Company scope — NULL for instance-level logs. */
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "cascade" }),
    level: text("level").$type<PluginLogLevel>().notNull().default("info"),
    message: text("message").notNull(),
    meta: jsonb("meta").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pluginTimeIdx: index("plugin_logs_plugin_time_idx").on(
      table.pluginId,
      table.createdAt,
    ),
    companyIdx: index("plugin_logs_company_idx").on(table.companyId),
    levelIdx: index("plugin_logs_level_idx").on(table.level),
  }),
);
