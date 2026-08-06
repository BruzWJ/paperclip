/**
 * PluginJobScheduler — tick-based scheduler for plugin scheduled jobs.
 *
 * The scheduler is the central coordinator for all plugin cron jobs. It
 * periodically ticks (default every 30 seconds), queries the `plugin_jobs`
 * table for jobs whose `nextRunAt` has passed, dispatches `runJob` RPC calls
 * to the appropriate worker processes, records each execution in the
 * `plugin_job_runs` table, and advances the scheduling pointer.
 *
 * ## Responsibilities
 *
 * 1. **Tick loop** — A `setInterval`-based loop fires every `tickIntervalMs`
 *    (default 30s). Each tick scans for due jobs and dispatches them.
 *
 * 2. **Cron parsing & next-run calculation** — Uses the lightweight built-in
 *    cron parser ({@link parseCron}, {@link nextCronTick}) to compute the
 *    `nextRunAt` timestamp after each run or when a new job is registered.
 *
 * 3. **Overlap prevention** — Durable run admission serializes on the job row
 *    so queued and running executions cannot overlap across server instances.
 *
 * 4. **Job run recording** — Every execution creates a `plugin_job_runs` row:
 *    `queued` → `running` → `succeeded` | `failed`. Duration and error are
 *    captured.
 *
 * 5. **Lifecycle integration** — The scheduler exposes `registerPlugin()` and
 *    `unregisterPlugin()` so the host lifecycle manager can wire up job
 *    scheduling when plugins start/stop. On registration, the scheduler
 *    computes `nextRunAt` for all active jobs that don't already have one.
 *
 * @see PLUGIN_SPEC.md §17 — Scheduled Jobs
 * @see ./plugin-job-store.ts — Persistence layer
 * @see ./cron.ts — Cron parsing utilities
 */

import { and, eq, lte } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { pluginJobs } from "@paperclipai/db";
import type { PluginJobRunTrigger } from "@paperclipai/shared";
import type { PluginJobStore } from "./plugin-job-store.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import { parseCron, nextCronTick } from "./cron.js";
import { logger } from "../middleware/logger.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default interval between scheduler ticks (30 seconds). */
const DEFAULT_TICK_INTERVAL_MS = 30_000;

/** Default timeout for a runJob RPC call (5 minutes). */
const DEFAULT_JOB_TIMEOUT_MS = 5 * 60 * 1_000;

/** Maximum number of concurrent job executions across all plugins. */
const DEFAULT_MAX_CONCURRENT_JOBS = 10;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Options for creating a PluginJobScheduler.
 */
interface PluginJobSchedulerOptions {
  /** Drizzle database instance. */
  db: Db;
  /** Persistence layer for jobs and runs. */
  jobStore: PluginJobStore;
  /** Worker process manager for RPC calls. */
  workerManager: PluginWorkerManager;
  /** Interval between scheduler ticks in ms (default: 30s). */
  tickIntervalMs?: number;
  /** Timeout for individual job RPC calls in ms (default: 5min). */
  jobTimeoutMs?: number;
  /** Maximum number of concurrent job executions (default: 10). */
  maxConcurrentJobs?: number;
}

/**
 * Result of a manual job trigger.
 */
interface TriggerJobResult {
  /** The created run ID. */
  runId: string;
  /** The job ID that was triggered. */
  jobId: string;
}

/**
 * Diagnostic information about the scheduler.
 */
interface SchedulerDiagnostics {
  /** Whether the tick loop is running. */
  running: boolean;
  /** Number of jobs currently executing. */
  activeJobCount: number;
  /** Set of job IDs currently in-flight. */
  activeJobIds: string[];
  /** Total number of ticks executed since start. */
  tickCount: number;
  /** Timestamp of the last tick (ISO 8601). */
  lastTickAt: string | null;
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

/**
 * The public interface of the job scheduler.
 */
export interface PluginJobScheduler {
  /**
   * Start the scheduler tick loop.
   *
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  start(): void;

  /**
   * Stop the scheduler tick loop.
   *
   * In-flight job runs are NOT cancelled — they are allowed to finish
   * naturally. The tick loop simply stops firing.
   */
  stop(): void;

  /**
   * Register a plugin with the scheduler.
   *
   * Computes `nextRunAt` for all active jobs that are missing it. This is
   * typically called after a plugin's worker process starts and
   * `syncJobDeclarations()` has been called.
   *
   * @param pluginId - UUID of the plugin
   */
  registerPlugin(pluginId: string): Promise<void>;

  /**
   * Unregister a plugin from the scheduler.
   *
   * Fences new local admission immediately, waits already-admitted local
   * executions through their terminal database writes, then cancels only
   * residual non-terminal runs and removes tracking state.
   *
   * @param pluginId - UUID of the plugin
   */
  unregisterPlugin(pluginId: string): Promise<void>;

  /**
   * Manually trigger a specific job (outside of the cron schedule).
   *
   * Creates a run with `trigger: "manual"` and dispatches immediately,
   * respecting the overlap prevention check.
   *
   * @param jobId - UUID of the job to trigger
   * @returns The created run info
   * @throws {Error} if the job is not found, not active, or already running
   */
  triggerJob(jobId: string): Promise<TriggerJobResult>;

  /**
   * Run a single scheduler tick immediately (for testing).
   *
   * @internal
   */
  tick(): Promise<void>;

  /**
   * Get diagnostic information about the scheduler state.
   */
  diagnostics(): SchedulerDiagnostics;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Create a new PluginJobScheduler.
 *
 * @example
 * ```ts
 * const scheduler = createPluginJobScheduler({
 *   db,
 *   jobStore,
 *   workerManager,
 * });
 *
 * // Start the tick loop
 * scheduler.start();
 *
 * // When a plugin comes online, register it
 * await scheduler.registerPlugin(pluginId);
 *
 * // Manually trigger a job
 * const { runId } = await scheduler.triggerJob(jobId);
 *
 * // On server shutdown
 * scheduler.stop();
 * ```
 */
export function createPluginJobScheduler(
  options: PluginJobSchedulerOptions,
): PluginJobScheduler {
  const {
    db,
    jobStore,
    workerManager,
    tickIntervalMs = DEFAULT_TICK_INTERVAL_MS,
    jobTimeoutMs = DEFAULT_JOB_TIMEOUT_MS,
    maxConcurrentJobs = DEFAULT_MAX_CONCURRENT_JOBS,
  } = options;

  const log = logger.child({ service: "plugin-job-scheduler" });

  // -----------------------------------------------------------------------
  // State
  // -----------------------------------------------------------------------

  /** Timer handle for the tick loop. */
  let tickTimer: ReturnType<typeof setInterval> | null = null;

  /** Whether the scheduler is running. */
  let running = false;

  /** Set of job IDs currently being executed (for overlap prevention). */
  const activeJobs = new Set<string>();

  /** Plugin ids whose job admission is closed during runtime teardown. */
  const fencedPlugins = new Set<string>();

  interface ActiveExecution {
    readonly pluginId: string;
    readonly completion: Promise<void>;
    finish(): void;
  }

  /** Local executions include durable admission through terminal DB write. */
  const activeExecutions = new Map<string, ActiveExecution>();

  /** Total number of ticks since start. */
  let tickCount = 0;

  /** Timestamp of the last tick. */
  let lastTickAt: Date | null = null;

  /** Guard against concurrent tick execution. */
  let tickInProgress = false;

  // -----------------------------------------------------------------------
  // Core: tick
  // -----------------------------------------------------------------------

  /**
   * A single scheduler tick. Queries for due jobs and dispatches them.
   */
  async function tick(): Promise<void> {
    // Prevent overlapping ticks (in case a tick takes longer than the interval)
    if (tickInProgress) {
      log.debug("skipping tick — previous tick still in progress");
      return;
    }

    tickInProgress = true;
    tickCount++;
    lastTickAt = new Date();

    try {
      const now = new Date();

      // Query only active scheduled jobs whose persisted nextRunAt has passed.
      // Registration computes schedule pointers. Removed jobs keep nextRunAt
      // null and are intentionally absent from this scan.
      const dueJobs = await db
        .select()
        .from(pluginJobs)
        .where(
          and(
            eq(pluginJobs.status, "active"),
            lte(pluginJobs.nextRunAt, now),
          ),
        );

      if (dueJobs.length === 0) {
        return;
      }

      log.debug({ count: dueJobs.length }, "found due jobs");

      // Dispatch each due job (respecting concurrency limits)
      const dispatches: Promise<void>[] = [];

      for (const job of dueJobs) {
        if (fencedPlugins.has(job.pluginId)) {
          continue;
        }

        // Concurrency limit
        if (activeJobs.size >= maxConcurrentJobs) {
          log.warn(
            { maxConcurrentJobs, activeJobCount: activeJobs.size },
            "max concurrent jobs reached, deferring remaining jobs",
          );
          break;
        }

        // Overlap prevention: skip if this job is already running
        if (activeJobs.has(job.id)) {
          log.debug(
            { jobId: job.id, jobKey: job.jobKey, pluginId: job.pluginId },
            "skipping job — already running (overlap prevention)",
          );
          continue;
        }

        // Check if the worker is available
        if (!workerManager.isRunning(job.pluginId)) {
          log.debug(
            { jobId: job.id, pluginId: job.pluginId },
            "skipping job — worker not running",
          );
          continue;
        }

        dispatches.push(dispatchScheduledJob(job));
      }

      if (dispatches.length > 0) {
        await Promise.allSettled(dispatches);
      }
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err) },
        "scheduler tick error",
      );
    } finally {
      tickInProgress = false;
    }
  }

  // -----------------------------------------------------------------------
  // Core: dispatch a single job
  // -----------------------------------------------------------------------

  type JobRecord = typeof pluginJobs.$inferSelect;

  function computeNextRunAt(job: JobRecord, after: Date): Date {
    const nextRunAt = nextCronTick(parseCron(job.schedule), after);
    if (nextRunAt === null) {
      throw new Error(
        `Job "${job.jobKey}" has no cron occurrence in the supported search window`,
      );
    }
    return nextRunAt;
  }

  function beginExecution(job: JobRecord): ActiveExecution | null {
    if (fencedPlugins.has(job.pluginId) || activeJobs.has(job.id)) return null;

    activeJobs.add(job.id);
    let resolveCompletion!: () => void;
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    let finished = false;
    const execution: ActiveExecution = {
      pluginId: job.pluginId,
      completion,
      finish() {
        if (finished) return;
        finished = true;
        activeJobs.delete(job.id);
        if (activeExecutions.get(job.id) === execution) {
          activeExecutions.delete(job.id);
        }
        resolveCompletion();
      },
    };
    activeExecutions.set(job.id, execution);
    return execution;
  }

  async function reserveRun(
    job: JobRecord,
    trigger: PluginJobRunTrigger,
  ) {
    const execution = beginExecution(job);
    if (!execution) return null;
    try {
      const run = await jobStore.createRunIfIdle({
        jobId: job.id,
        pluginId: job.pluginId,
        trigger,
      });
      if (!run) {
        execution.finish();
        return null;
      }
      return { run, execution };
    } catch (error) {
      execution.finish();
      throw error;
    }
  }

  /** Execute one already-admitted run through its only lifecycle path. */
  async function executeReservedRun(input: {
    job: JobRecord;
    runId: string;
    trigger: PluginJobRunTrigger;
    scheduledAt: Date;
    advanceSchedule: boolean;
    execution: ActiveExecution;
  }): Promise<void> {
    const { job, runId, trigger } = input;
    const { id: jobId, pluginId, jobKey } = job;
    const jobLog = log.child({ jobId, pluginId, jobKey, runId, trigger });
    const startedAt = Date.now();

    try {
      if (!await jobStore.markRunning(runId)) {
        jobLog.info("job run was cancelled before worker dispatch");
        return;
      }

      await workerManager.call(
        pluginId,
        "runJob",
        {
          job: {
            jobKey,
            runId,
            trigger,
            scheduledAt: input.scheduledAt.toISOString(),
          },
        },
        jobTimeoutMs,
      );

      const durationMs = Date.now() - startedAt;
      const completed = await jobStore.completeRun(runId, {
        status: "succeeded",
        durationMs,
      });
      if (completed) {
        jobLog.info({ durationMs }, "job completed successfully");
      } else {
        jobLog.info({ durationMs }, "job completed after its run was already terminal");
      }
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      const errorMessage = err instanceof Error ? err.message : String(err);

      try {
        const completed = await jobStore.completeRun(runId, {
          status: "failed",
          error: errorMessage,
          durationMs,
        });
        if (completed) {
          jobLog.error({ durationMs, err: errorMessage }, "job execution failed");
        } else {
          jobLog.info(
            { durationMs, err: errorMessage },
            "job execution ended after its run was already terminal",
          );
        }
      } catch (completeErr) {
        jobLog.error(
          {
            durationMs,
            err: errorMessage,
            completionError: completeErr instanceof Error
              ? completeErr.message
              : String(completeErr),
          },
          "job execution failed and its failure could not be recorded",
        );
      }
    } finally {
      if (input.advanceSchedule) {
        try {
          await advanceSchedulePointer(job);
        } catch (err) {
          jobLog.error(
            { err: err instanceof Error ? err.message : String(err) },
            "failed to advance schedule pointer",
          );
        }
      }
      input.execution.finish();
    }
  }

  async function dispatchScheduledJob(job: JobRecord): Promise<void> {
    if (job.nextRunAt === null) {
      throw new Error(`Due job "${job.jobKey}" has no nextRunAt pointer`);
    }
    const run = await reserveRun(job, "schedule");
    if (!run) {
      log.debug(
        { jobId: job.id, jobKey: job.jobKey, pluginId: job.pluginId },
        "skipping job — another run is already queued or running",
      );
      return;
    }
    await executeReservedRun({
      job,
      runId: run.run.id,
      trigger: "schedule",
      scheduledAt: job.nextRunAt,
      advanceSchedule: true,
      execution: run.execution,
    });
  }

  // -----------------------------------------------------------------------
  // Core: manual trigger
  // -----------------------------------------------------------------------

  async function triggerJob(jobId: string): Promise<TriggerJobResult> {
    const job = await jobStore.getJobById(jobId);
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    if (job.status !== "active") {
      throw new Error(
        `Job "${job.jobKey}" is not active (status: ${job.status})`,
      );
    }

    if (fencedPlugins.has(job.pluginId)) {
      throw new Error(
        `Plugin "${job.pluginId}" is unregistering — cannot trigger job`,
      );
    }

    // Check worker availability
    if (!workerManager.isRunning(job.pluginId)) {
      throw new Error(
        `Worker for plugin "${job.pluginId}" is not running — cannot trigger job`,
      );
    }

    const run = await reserveRun(job, "manual");
    if (!run) {
      throw new Error(
        `Job "${job.jobKey}" is already queued or running — cannot trigger while in progress`,
      );
    }

    // Execute in the background after durable admission; the caller only
    // needs the run identity.
    void executeReservedRun({
      job,
      runId: run.run.id,
      trigger: "manual",
      scheduledAt: new Date(),
      advanceSchedule: false,
      execution: run.execution,
    });

    return { runId: run.run.id, jobId };
  }

  // -----------------------------------------------------------------------
  // Schedule pointer management
  // -----------------------------------------------------------------------

  /**
   * Advance the job's next scheduled execution after one scheduled run.
   */
  async function advanceSchedulePointer(
    job: typeof pluginJobs.$inferSelect,
  ): Promise<void> {
    if (job.nextRunAt === null) {
      throw new Error(`Scheduled job "${job.jobKey}" has no nextRunAt pointer`);
    }
    const now = new Date();
    const advanced = await jobStore.advanceNextRunAt({
      jobId: job.id,
      schedule: job.schedule,
      currentNextRunAt: job.nextRunAt,
      nextRunAt: computeNextRunAt(job, now),
    });
    if (!advanced) {
      log.debug(
        { jobId: job.id, jobKey: job.jobKey },
        "schedule changed while the job was running; leaving its new pointer untouched",
      );
    }
  }

  /**
   * Ensure all active jobs for a plugin have a `nextRunAt` value.
   * Called when a plugin is registered with the scheduler.
   */
  async function ensureNextRunTimestamps(pluginId: string): Promise<void> {
    const jobs = await jobStore.listJobs(pluginId, "active");

    for (const job of jobs) {
      // Skip jobs that already have a valid nextRunAt in the future
      if (job.nextRunAt && job.nextRunAt.getTime() > Date.now()) {
        continue;
      }

      const nextRunAt = computeNextRunAt(job, new Date());
      await jobStore.updateNextRunAt(job.id, nextRunAt);
      log.debug(
        { jobId: job.id, jobKey: job.jobKey, nextRunAt: nextRunAt.toISOString() },
        "computed nextRunAt for job",
      );
    }
  }

  // -----------------------------------------------------------------------
  // Plugin registration
  // -----------------------------------------------------------------------

  async function registerPlugin(pluginId: string): Promise<void> {
    log.info({ pluginId }, "registering plugin with job scheduler");
    await ensureNextRunTimestamps(pluginId);
    fencedPlugins.delete(pluginId);
  }

  async function unregisterPlugin(pluginId: string): Promise<void> {
    log.info({ pluginId }, "unregistering plugin from job scheduler");

    // This executes synchronously before the first await, closing every local
    // admission path while preserving work that was already admitted.
    fencedPlugins.add(pluginId);

    const localCompletions = [...activeExecutions.values()]
      .filter((execution) => execution.pluginId === pluginId)
      .map((execution) => execution.completion);
    await Promise.all(localCompletions);

    const jobs = await jobStore.listJobs(pluginId);

    try {
      await jobStore.cancelNonTerminalRuns(pluginId, "Plugin unregistered");
    } finally {
      // In-memory dispatch admission must be removed even when durable run
      // cancellation fails. The durable error still propagates to the caller.
      for (const job of jobs) {
        activeJobs.delete(job.id);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Lifecycle: start / stop
  // -----------------------------------------------------------------------

  function start(): void {
    if (running) {
      log.debug("scheduler already running");
      return;
    }

    running = true;
    tickTimer = setInterval(() => {
      void tick();
    }, tickIntervalMs);

    log.info(
      { tickIntervalMs, maxConcurrentJobs },
      "plugin job scheduler started",
    );
  }

  function stop(): void {
    // Always clear the timer defensively, even if `running` is already false,
    // to prevent leaked interval timers.
    if (tickTimer !== null) {
      clearInterval(tickTimer);
      tickTimer = null;
    }

    if (!running) return;
    running = false;

    log.info(
      { activeJobCount: activeJobs.size },
      "plugin job scheduler stopped",
    );
  }

  // -----------------------------------------------------------------------
  // Diagnostics
  // -----------------------------------------------------------------------

  function diagnostics(): SchedulerDiagnostics {
    return {
      running,
      activeJobCount: activeJobs.size,
      activeJobIds: [...activeJobs],
      tickCount,
      lastTickAt: lastTickAt?.toISOString() ?? null,
    };
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  return {
    start,
    stop,
    registerPlugin,
    unregisterPlugin,
    triggerJob,
    tick,
    diagnostics,
  };
}
