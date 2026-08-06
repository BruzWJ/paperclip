import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { plugins } from "./plugins.js";
import type { PluginWebhookDeliveryStatus } from "@paperclipai/shared";

/**
 * `plugin_webhook_deliveries` table — inbound webhook delivery history for plugins.
 *
 * When an external system sends an HTTP POST to a plugin's registered webhook
 * endpoint (`/api/plugins/:pluginId/webhooks/:endpointKey`), the server creates
 * a metadata row before dispatching the request to the plugin worker. Request
 * bodies and headers are not persisted.
 *
 * The `webhook_key` matches the key declared in the plugin manifest's
 * `webhooks` array.
 *
 * Status values:
 * - `pending` — received but not yet dispatched to the worker
 * - `success` — worker processed the request successfully
 * - `failed` — worker returned an error or timed out
 *
 * @see PLUGIN_SPEC.md §21.3 — `plugin_webhook_deliveries`
 */
export const pluginWebhookDeliveries = pgTable(
  "plugin_webhook_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** FK to the owning plugin. Cascades on delete. */
    pluginId: uuid("plugin_id")
      .notNull()
      .references(() => plugins.id, { onDelete: "cascade" }),
    /** Identifier matching the key in the plugin manifest's `webhooks` array. */
    webhookKey: text("webhook_key").notNull(),
    /** Current delivery state. */
    status: text("status").$type<PluginWebhookDeliveryStatus>().notNull().default("pending"),
    /** Wall-clock processing duration in milliseconds. Null until delivery finishes. */
    durationMs: integer("duration_ms"),
    /** Error message if `status === "failed"`. */
    error: text("error"),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pluginIdx: index("plugin_webhook_deliveries_plugin_idx").on(table.pluginId),
    statusIdx: index("plugin_webhook_deliveries_status_idx").on(table.status),
    keyIdx: index("plugin_webhook_deliveries_key_idx").on(table.webhookKey),
  }),
);
