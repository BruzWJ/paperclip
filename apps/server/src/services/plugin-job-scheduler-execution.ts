import { and, eq, lte } from "drizzle-orm";
import { pluginJobs, type Db } from "@paperclipai/db";
import type { PluginJobRunTrigger } from "@paperclipai/shared";
import { nextCronTick, parseCron } from "./cron.js";
import type { Logger } from "pino";
import type { PluginJobStore } from "./plugin-job-store.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";

export interface PluginJobSchedulerExecution {
  tick(): Promise<void>;
  triggerJob(jobId: string): Promise<TriggerJobResult>;
  ensureNextRunTimestamps(pluginId: string): Promise<void>;
}

export function buildPluginJobSchedulerExecution(
  context: PluginJobSchedulerContext,
): PluginJobSchedulerExecution {
  const { db, jobStore, workerManager, jobTimeoutMs, maxConcurrentJobs, log, state } = context;

  function computeNextRunAt(job: PluginJobRecord, after: Date): Date {
    const nextRunAt = nextCronTick(parseCron(job.schedule), after);
    if (nextRunAt === null) {
      throw new Error(`Job "${job.jobKey}" has no cron occurrence in the supported search window`);
    }
    return nextRunAt;
  }

  function beginExecution(job: PluginJobRecord): ActiveExecution | null {
    if (state.fencedPlugins.has(job.pluginId) || state.activeJobs.has(job.id)) {
      return null;
    }

    state.activeJobs.add(job.id);
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
        state.activeJobs.delete(job.id);
        if (state.activeExecutions.get(job.id) === execution) {
          state.activeExecutions.delete(job.id);
        }
        resolveCompletion();
      },
    };
    state.activeExecutions.set(job.id, execution);
    return execution;
  }

  async function reserveRun(job: PluginJobRecord, trigger: PluginJobRunTrigger) {
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

  async function advanceSchedulePointer(job: PluginJobRecord): Promise<void> {
    if (job.nextRunAt === null) {
      throw new Error(`Scheduled job "${job.jobKey}" has no nextRunAt pointer`);
    }
    const advanced = await jobStore.advanceNextRunAt({
      jobId: job.id,
      schedule: job.schedule,
      currentNextRunAt: job.nextRunAt,
      nextRunAt: computeNextRunAt(job, new Date()),
    });
    if (!advanced) {
      log.debug(
        { jobId: job.id, jobKey: job.jobKey },
        "schedule changed while the job was running; leaving its new pointer untouched",
      );
    }
  }

  async function executeReservedRun(input: ExecuteReservedRunInput): Promise<void> {
    const { job, runId, trigger } = input;
    const { id: jobId, pluginId, jobKey } = job;
    const jobLog = log.child({ jobId, pluginId, jobKey, runId, trigger });
    const startedAt = Date.now();

    try {
      if (!(await jobStore.markRunning(runId))) {
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
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const errorMessage = error instanceof Error ? error.message : String(error);
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
      } catch (completionError) {
        jobLog.error(
          {
            durationMs,
            err: errorMessage,
            completionError:
              completionError instanceof Error ? completionError.message : String(completionError),
          },
          "job execution failed and its failure could not be recorded",
        );
      }
    } finally {
      if (input.advanceSchedule) {
        try {
          await advanceSchedulePointer(job);
        } catch (error) {
          jobLog.error(
            { err: error instanceof Error ? error.message : String(error) },
            "failed to advance schedule pointer",
          );
        }
      }
      input.execution.finish();
    }
  }

  async function dispatchScheduledJob(job: PluginJobRecord): Promise<void> {
    if (job.nextRunAt === null) {
      throw new Error(`Due job "${job.jobKey}" has no nextRunAt pointer`);
    }
    const reserved = await reserveRun(job, "schedule");
    if (!reserved) {
      log.debug(
        { jobId: job.id, jobKey: job.jobKey, pluginId: job.pluginId },
        "skipping job — another run is already queued or running",
      );
      return;
    }
    await executeReservedRun({
      job,
      runId: reserved.run.id,
      trigger: "schedule",
      scheduledAt: job.nextRunAt,
      advanceSchedule: true,
      execution: reserved.execution,
    });
  }

  async function tick(): Promise<void> {
    if (state.tickInProgress) {
      log.debug("skipping tick — previous tick still in progress");
      return;
    }

    state.tickInProgress = true;
    state.tickCount += 1;
    state.lastTickAt = new Date();

    try {
      const dueJobs = await db
        .select()
        .from(pluginJobs)
        .where(and(eq(pluginJobs.status, "active"), lte(pluginJobs.nextRunAt, new Date())));
      if (dueJobs.length === 0) return;

      log.debug({ count: dueJobs.length }, "found due jobs");
      const dispatches: Promise<void>[] = [];
      for (const job of dueJobs) {
        if (state.fencedPlugins.has(job.pluginId)) continue;
        if (state.activeJobs.size >= maxConcurrentJobs) {
          log.warn(
            {
              maxConcurrentJobs,
              activeJobCount: state.activeJobs.size,
            },
            "max concurrent jobs reached, deferring remaining jobs",
          );
          break;
        }
        if (state.activeJobs.has(job.id)) {
          log.debug(
            { jobId: job.id, jobKey: job.jobKey, pluginId: job.pluginId },
            "skipping job — already running (overlap prevention)",
          );
          continue;
        }
        if (!workerManager.isRunning(job.pluginId)) {
          log.debug({ jobId: job.id, pluginId: job.pluginId }, "skipping job — worker not running");
          continue;
        }
        dispatches.push(dispatchScheduledJob(job));
      }
      if (dispatches.length > 0) await Promise.allSettled(dispatches);
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error) }, "scheduler tick error");
    } finally {
      state.tickInProgress = false;
    }
  }

  async function triggerJob(jobId: string): Promise<TriggerJobResult> {
    const job = await jobStore.getJobById(jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);
    if (job.status !== "active") {
      throw new Error(`Job "${job.jobKey}" is not active (status: ${job.status})`);
    }
    if (state.fencedPlugins.has(job.pluginId)) {
      throw new Error(`Plugin "${job.pluginId}" is unregistering — cannot trigger job`);
    }
    if (!workerManager.isRunning(job.pluginId)) {
      throw new Error(`Worker for plugin "${job.pluginId}" is not running — cannot trigger job`);
    }

    const reserved = await reserveRun(job, "manual");
    if (!reserved) {
      throw new Error(`Job "${job.jobKey}" is already queued or running — cannot trigger while in progress`);
    }
    void executeReservedRun({
      job,
      runId: reserved.run.id,
      trigger: "manual",
      scheduledAt: new Date(),
      advanceSchedule: false,
      execution: reserved.execution,
    });
    return { runId: reserved.run.id, jobId };
  }

  async function ensureNextRunTimestamps(pluginId: string): Promise<void> {
    const jobs = await jobStore.listJobs(pluginId, "active");
    for (const job of jobs) {
      if (job.nextRunAt && job.nextRunAt.getTime() > Date.now()) continue;
      const nextRunAt = computeNextRunAt(job, new Date());
      await jobStore.updateNextRunAt(job.id, nextRunAt);
      log.debug(
        {
          jobId: job.id,
          jobKey: job.jobKey,
          nextRunAt: nextRunAt.toISOString(),
        },
        "computed nextRunAt for job",
      );
    }
  }

  return { tick, triggerJob, ensureNextRunTimestamps };
}

export const DEFAULT_TICK_INTERVAL_MS = 30_000;
export const DEFAULT_JOB_TIMEOUT_MS = 5 * 60 * 1_000;
export const DEFAULT_MAX_CONCURRENT_JOBS = 10;

export interface PluginJobSchedulerOptions {
  db: Db;
  jobStore: PluginJobStore;
  workerManager: PluginWorkerManager;
  tickIntervalMs?: number;
  jobTimeoutMs?: number;
  maxConcurrentJobs?: number;
}

export interface TriggerJobResult {
  runId: string;
  jobId: string;
}

export interface SchedulerDiagnostics {
  running: boolean;
  activeJobCount: number;
  activeJobIds: string[];
  tickCount: number;
  lastTickAt: string | null;
}

export interface PluginJobScheduler {
  start(): void;
  stop(): void;
  registerPlugin(pluginId: string): Promise<void>;
  unregisterPlugin(pluginId: string): Promise<void>;
  triggerJob(jobId: string): Promise<TriggerJobResult>;
  tick(): Promise<void>;
  diagnostics(): SchedulerDiagnostics;
}

export interface ActiveExecution {
  readonly pluginId: string;
  readonly completion: Promise<void>;
  finish(): void;
}

export interface PluginJobSchedulerState {
  tickTimer: ReturnType<typeof setInterval> | null;
  running: boolean;
  readonly activeJobs: Set<string>;
  readonly fencedPlugins: Set<string>;
  readonly activeExecutions: Map<string, ActiveExecution>;
  tickCount: number;
  lastTickAt: Date | null;
  tickInProgress: boolean;
}

export interface PluginJobSchedulerContext {
  readonly db: Db;
  readonly jobStore: PluginJobStore;
  readonly workerManager: PluginWorkerManager;
  readonly tickIntervalMs: number;
  readonly jobTimeoutMs: number;
  readonly maxConcurrentJobs: number;
  readonly log: Logger;
  readonly state: PluginJobSchedulerState;
}

export type PluginJobRecord = typeof pluginJobs.$inferSelect;

export interface ReservedPluginJobRun {
  run: Awaited<ReturnType<PluginJobStore["createRunIfIdle"]>> & {};
  execution: ActiveExecution;
}

export interface ExecuteReservedRunInput {
  job: PluginJobRecord;
  runId: string;
  trigger: PluginJobRunTrigger;
  scheduledAt: Date;
  advanceSchedule: boolean;
  execution: ActiveExecution;
}

export function createPluginJobSchedulerState(): PluginJobSchedulerState {
  return {
    tickTimer: null,
    running: false,
    activeJobs: new Set(),
    fencedPlugins: new Set(),
    activeExecutions: new Map(),
    tickCount: 0,
    lastTickAt: null,
    tickInProgress: false,
  };
}
