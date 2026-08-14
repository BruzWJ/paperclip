/**
 * Plugin Job Store — persistence layer for scheduled plugin jobs and their
 * execution history.
 *
 * This service manages the `plugin_jobs` and `plugin_job_runs` tables. It is
 * the server-side backing store for the `ctx.jobs` SDK surface exposed to
 * plugin workers.
 *
 * ## Responsibilities
 *
 * 1. **Sync job declarations** — When a plugin is installed or started, the
 *    host calls `syncJobDeclarations()` to upsert the manifest's declared jobs
 *    into the `plugin_jobs` table. Jobs removed from the manifest are marked
 *    `removed` (not deleted) to preserve history.
 *
 * 2. **Job reads** — List jobs and resolve exact job rows for dispatch.
 *
 * 3. **Run lifecycle** — Create job run records, update their status, and
 *    record terminal status, duration, and errors. Worker logs use the
 *    canonical `plugin_logs` table.
 *
 * 4. **Run scheduling state** — Persist the scheduler's sole next-run pointer.
 *
 * The capability check (`jobs.schedule`) is enforced upstream by the host
 * client factory and manifest validator — this store trusts that the caller
 * has already been authorised.
 *
 * @see PLUGIN_SPEC.md §17 — Scheduled Jobs
 * @see PLUGIN_SPEC.md §21.3 — `plugin_jobs` / `plugin_job_runs` tables
 */

import { and, desc, eq, inArray, type SQL } from "drizzle-orm";
import { type Db, plugins, pluginJobs, pluginJobRuns } from "@paperclipai/db";
import type { PluginJobDeclaration, PluginJobRunStatus, PluginJobRunTrigger } from "@paperclipai/shared";
import { notFound } from "../errors.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Input for creating a job run record.
 */
interface CreateJobRunInput {
  /** FK to the plugin_jobs row. */
  jobId: string;
  /** FK to the plugins row. */
  pluginId: string;
  /** What triggered this run. */
  trigger: PluginJobRunTrigger;
}

/**
 * Input for completing (or failing) a job run.
 */
interface CompleteJobRunInput {
  /** Final run status. */
  status: Extract<PluginJobRunStatus, "succeeded" | "failed" | "cancelled">;
  /** Error message if the run failed. */
  error?: string | null;
  /** Run duration in milliseconds. */
  durationMs?: number | null;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Create a PluginJobStore backed by the given Drizzle database instance.
 *
 * @example
 * ```ts
 * const jobStore = pluginJobStore(db);
 *
 * // On plugin install/start — sync declared jobs into the DB
 * await jobStore.syncJobDeclarations(pluginId, manifest.jobs ?? []);
 *
 * // Before dispatching a runJob RPC — create a run record
 * const run = await jobStore.createRunIfIdle({ jobId, pluginId, trigger: "schedule" });
 * if (!run) return;
 *
 * // After the RPC completes — record the result
 * await jobStore.completeRun(run.id, {
 *   status: "succeeded",
 *   durationMs: Date.now() - startedAt,
 * });
 * ```
 */
export function pluginJobStore(db: Db) {
  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  async function assertPluginReady(pluginId: string): Promise<void> {
    const rows = await db
      .select({ id: plugins.id, status: plugins.status })
      .from(plugins)
      .where(and(eq(plugins.id, pluginId), eq(plugins.status, "ready")));
    if (rows.length === 0) {
      throw notFound(`Ready plugin installation not found: ${pluginId}`);
    }
  }

  async function cancelRuns(condition: SQL, reason: string): Promise<number> {
    const rows = await db
      .update(pluginJobRuns)
      .set({
        status: "cancelled" as PluginJobRunStatus,
        error: reason,
        durationMs: null,
        finishedAt: new Date(),
      })
      .where(condition)
      .returning({ id: pluginJobRuns.id });
    return rows.length;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  return {
    // =====================================================================
    // Job declarations (plugin_jobs)
    // =====================================================================

    /**
     * Sync declared jobs from a plugin manifest into the `plugin_jobs` table.
     *
     * This is called at plugin install and on each worker startup so the DB
     * always reflects the manifest's declared jobs:
     *
     * - **New jobs** are inserted with status `active`.
     * - **Existing jobs** have their `schedule` updated if it changed.
     * - **Removed jobs** (present in DB but absent from the manifest) are
     *   set to `removed` so their history is preserved.
     *
     * The unique constraint `(pluginId, jobKey)` is used for conflict
     * resolution.
     *
     * @param pluginId - UUID of the owning plugin
     * @param declarations - Job declarations from the plugin manifest
     */
    async syncJobDeclarations(pluginId: string, declarations: PluginJobDeclaration[]): Promise<void> {
      await assertPluginReady(pluginId);

      // Fetch existing jobs for this plugin
      const existingJobs = await db.select().from(pluginJobs).where(eq(pluginJobs.pluginId, pluginId));

      const existingByKey = new Map(existingJobs.map((j) => [j.jobKey, j]));

      const declaredKeys = new Set<string>();

      // Upsert each declared job
      for (const decl of declarations) {
        declaredKeys.add(decl.jobKey);

        const existing = existingByKey.get(decl.jobKey);
        const schedule = decl.schedule;

        if (existing) {
          // A changed or restored declaration needs a schedule pointer
          // recomputed from the new canonical cron expression.
          const updates: Record<string, unknown> = {};
          if (existing.schedule !== schedule) {
            updates.schedule = schedule;
            updates.nextRunAt = null;
          }
          if (existing.status === "removed") {
            updates.status = "active";
            updates.nextRunAt = null;
          }

          if (Object.keys(updates).length > 0) {
            updates.updatedAt = new Date();
            await db.update(pluginJobs).set(updates).where(eq(pluginJobs.id, existing.id));
          }
        } else {
          // Insert new job
          await db.insert(pluginJobs).values({
            pluginId,
            jobKey: decl.jobKey,
            schedule,
            status: "active",
          });
        }
      }

      // Retain removed job rows so their run history remains inspectable.
      for (const existing of existingJobs) {
        if (!declaredKeys.has(existing.jobKey) && existing.status !== "removed") {
          await db
            .update(pluginJobs)
            .set({
              status: "removed",
              nextRunAt: null,
              updatedAt: new Date(),
            })
            .where(eq(pluginJobs.id, existing.id));
        }
      }
    },

    /**
     * List all jobs for a plugin, optionally filtered by status.
     *
     * @param pluginId - UUID of the owning plugin
     * @param status - Optional status filter
     */
    async listJobs(
      pluginId: string,
      status?: (typeof pluginJobs.$inferSelect)["status"],
    ): Promise<(typeof pluginJobs.$inferSelect)[]> {
      const conditions = [eq(pluginJobs.pluginId, pluginId)];
      if (status) {
        conditions.push(eq(pluginJobs.status, status));
      }
      return db
        .select()
        .from(pluginJobs)
        .where(and(...conditions));
    },

    /**
     * Get a single job by its primary key (UUID).
     *
     * @param jobId - UUID of the job row
     * @returns The job row, or `null` if not found
     */
    async getJobById(jobId: string): Promise<typeof pluginJobs.$inferSelect | null> {
      const rows = await db.select().from(pluginJobs).where(eq(pluginJobs.id, jobId));
      return rows[0] ?? null;
    },

    /**
     * Fetch a single job by ID, scoped to a specific plugin.
     *
     * Returns `null` if the job does not exist or does not belong to the
     * given plugin — callers should treat both cases as "not found".
     */
    async getJobByIdForPlugin(
      pluginId: string,
      jobId: string,
    ): Promise<typeof pluginJobs.$inferSelect | null> {
      const rows = await db
        .select()
        .from(pluginJobs)
        .where(and(eq(pluginJobs.id, jobId), eq(pluginJobs.pluginId, pluginId)));
      return rows[0] ?? null;
    },

    /** Persist the scheduler's sole next-execution pointer. */
    async updateNextRunAt(jobId: string, nextRunAt: Date | null): Promise<void> {
      await db
        .update(pluginJobs)
        .set({
          nextRunAt,
          updatedAt: new Date(),
        })
        .where(eq(pluginJobs.id, jobId));
    },

    /** Advance only the exact active schedule pointer that produced a run. */
    async advanceNextRunAt(input: {
      jobId: string;
      schedule: string;
      currentNextRunAt: Date;
      nextRunAt: Date;
    }): Promise<boolean> {
      const rows = await db
        .update(pluginJobs)
        .set({
          nextRunAt: input.nextRunAt,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(pluginJobs.id, input.jobId),
            eq(pluginJobs.status, "active"),
            eq(pluginJobs.schedule, input.schedule),
            eq(pluginJobs.nextRunAt, input.currentNextRunAt),
          ),
        )
        .returning({ id: pluginJobs.id });
      return rows.length === 1;
    },

    // =====================================================================
    // Job runs (plugin_job_runs)
    // =====================================================================

    /**
     * Atomically create a queued run only when the job is active and has no
     * queued or running execution.
     *
     * Locking the parent job row serializes admission across scheduler
     * instances without a second in-memory or caller-owned overlap check.
     *
     * @returns The newly created run, or `null` when admission is unavailable.
     */
    async createRunIfIdle(input: CreateJobRunInput): Promise<typeof pluginJobRuns.$inferSelect | null> {
      return db.transaction(async (tx) => {
        const [job] = await tx
          .select({ id: pluginJobs.id, status: pluginJobs.status })
          .from(pluginJobs)
          .where(and(eq(pluginJobs.id, input.jobId), eq(pluginJobs.pluginId, input.pluginId)))
          .for("update");
        if (!job || job.status !== "active") return null;

        const activeRuns = await tx
          .select({ id: pluginJobRuns.id })
          .from(pluginJobRuns)
          .where(
            and(eq(pluginJobRuns.jobId, input.jobId), inArray(pluginJobRuns.status, ["queued", "running"])),
          );
        if (activeRuns.length > 0) return null;

        const [run] = await tx
          .insert(pluginJobRuns)
          .values({
            jobId: input.jobId,
            pluginId: input.pluginId,
            trigger: input.trigger,
            status: "queued",
          })
          .returning();
        if (!run) {
          throw new Error("Plugin job run insert returned no record");
        }
        return run;
      });
    },

    /**
     * Mark a run as `running` and set its `startedAt` timestamp.
     *
     * @param runId - UUID of the run row
     */
    async markRunning(runId: string): Promise<boolean> {
      const rows = await db
        .update(pluginJobRuns)
        .set({
          status: "running" as PluginJobRunStatus,
          startedAt: new Date(),
        })
        .where(and(eq(pluginJobRuns.id, runId), eq(pluginJobRuns.status, "queued")))
        .returning({ id: pluginJobRuns.id });
      return rows.length > 0;
    },

    /**
     * Complete a run — set its final status, error, duration, and
     * `finishedAt` timestamp.
     *
     * @param runId - UUID of the run row
     * @param input - Completion details
     */
    async completeRun(runId: string, input: CompleteJobRunInput): Promise<boolean> {
      const rows = await db
        .update(pluginJobRuns)
        .set({
          status: input.status,
          error: input.error ?? null,
          durationMs: input.durationMs ?? null,
          finishedAt: new Date(),
        })
        .where(and(eq(pluginJobRuns.id, runId), inArray(pluginJobRuns.status, ["queued", "running"])))
        .returning({ id: pluginJobRuns.id });
      return rows.length > 0;
    },

    /**
     * Cancel every non-terminal run owned by a plugin in one durable update.
     * This reconciles work that cannot survive a runtime restart or unload.
     */
    async cancelNonTerminalRuns(pluginId: string, reason: string): Promise<number> {
      return cancelRuns(
        and(eq(pluginJobRuns.pluginId, pluginId), inArray(pluginJobRuns.status, ["queued", "running"]))!,
        reason,
      );
    },

    /** Cancel every non-terminal job run during server startup recovery. */
    async cancelAllNonTerminalRuns(reason: string): Promise<number> {
      return cancelRuns(inArray(pluginJobRuns.status, ["queued", "running"]), reason);
    },

    /**
     * List runs for a specific job, ordered by creation time descending.
     *
     * @param jobId - UUID of the job
     * @param limit - Maximum number of rows to return (default: 50)
     */
    async listRunsByJob(jobId: string, limit = 50): Promise<(typeof pluginJobRuns.$inferSelect)[]> {
      return db
        .select()
        .from(pluginJobRuns)
        .where(eq(pluginJobRuns.jobId, jobId))
        .orderBy(desc(pluginJobRuns.createdAt))
        .limit(limit);
    },

    /**
     * List runs for a plugin, optionally filtered by status.
     *
     * @param pluginId - UUID of the owning plugin
     * @param status - Optional status filter
     * @param limit - Maximum number of rows to return (default: 50)
     */
    async listRunsByPlugin(
      pluginId: string,
      status?: PluginJobRunStatus,
      limit = 50,
    ): Promise<(typeof pluginJobRuns.$inferSelect)[]> {
      const conditions = [eq(pluginJobRuns.pluginId, pluginId)];
      if (status) {
        conditions.push(eq(pluginJobRuns.status, status));
      }
      return db
        .select()
        .from(pluginJobRuns)
        .where(and(...conditions))
        .orderBy(desc(pluginJobRuns.createdAt))
        .limit(limit);
    },
  };
}

/** Type alias for the return value of `pluginJobStore()`. */
export type PluginJobStore = ReturnType<typeof pluginJobStore>;
