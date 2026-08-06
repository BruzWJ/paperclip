import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { plugins } from "./plugins.js";
import type { PluginJobStatus, PluginJobRunStatus, PluginJobRunTrigger } from "@paperclipai/shared";

/**
 * `plugin_jobs` table — registration and runtime configuration for
 * scheduled jobs declared by plugins in their manifests.
 *
 * Each row represents one scheduled job entry for a plugin. The
 * `job_key` matches the key declared in the manifest's `jobs` array.
 * The `schedule` column stores the required five-field cron expression
 * used by the job scheduler to decide when to fire the job.
 *
 * Status values:
 * - `active` — job is enabled and will run on schedule
 * - `removed` — the key is absent from the current manifest but retained so
 *   its execution history remains inspectable
 *
 * @see PLUGIN_SPEC.md §21.3 — `plugin_jobs`
 */
export const pluginJobs = pgTable(
  "plugin_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** FK to the owning plugin. Cascades on delete. */
    pluginId: uuid("plugin_id")
      .notNull()
      .references(() => plugins.id, { onDelete: "cascade" }),
    /** Identifier matching the key in the plugin manifest's `jobs` array. */
    jobKey: text("job_key").notNull(),
    /** Required five-field cron expression (e.g. `"0 * * * *"`). */
    schedule: text("schedule").notNull(),
    /** Current scheduling state. */
    status: text("status").$type<PluginJobStatus>().notNull().default("active"),
    /** Pre-computed timestamp of the next scheduled execution. */
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pluginIdx: index("plugin_jobs_plugin_idx").on(table.pluginId),
    nextRunIdx: index("plugin_jobs_next_run_idx").on(table.nextRunAt),
    uniqueJobIdx: uniqueIndex("plugin_jobs_unique_idx").on(table.pluginId, table.jobKey),
  }),
);

/**
 * `plugin_job_runs` table — immutable execution history for plugin-owned jobs.
 *
 * Each row is created when a job run begins and updated when it completes.
 * Rows are never modified after `status` reaches a terminal value
 * (`succeeded` | `failed` | `cancelled`).
 *
 * Trigger values:
 * - `schedule` — fired automatically by the cron scheduler
 * - `manual` — triggered by an instance administrator through the API
 *
 * @see PLUGIN_SPEC.md §21.3 — `plugin_job_runs`
 */
export const pluginJobRuns = pgTable(
  "plugin_job_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** FK to the parent job definition. Cascades on delete. */
    jobId: uuid("job_id")
      .notNull()
      .references(() => pluginJobs.id, { onDelete: "cascade" }),
    /** Denormalized FK to the owning plugin for efficient querying. Cascades on delete. */
    pluginId: uuid("plugin_id")
      .notNull()
      .references(() => plugins.id, { onDelete: "cascade" }),
    /** What caused this run to start (`"schedule"` or `"manual"`). */
    trigger: text("trigger").$type<PluginJobRunTrigger>().notNull(),
    /** Current lifecycle state of this run. */
    status: text("status").$type<PluginJobRunStatus>().notNull().default("queued"),
    /** Wall-clock duration in milliseconds. Null until the run finishes. */
    durationMs: integer("duration_ms"),
    /** Error message if `status === "failed"`. */
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    jobIdx: index("plugin_job_runs_job_idx").on(table.jobId),
    pluginIdx: index("plugin_job_runs_plugin_idx").on(table.pluginId),
    statusIdx: index("plugin_job_runs_status_idx").on(table.status),
  }),
);
