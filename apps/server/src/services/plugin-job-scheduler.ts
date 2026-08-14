import { logger } from "../middleware/logger.js";
import {
  buildPluginJobSchedulerExecution,
  type PluginJobSchedulerExecution,
} from "./plugin-job-scheduler-execution.js";
import {
  DEFAULT_JOB_TIMEOUT_MS,
  DEFAULT_MAX_CONCURRENT_JOBS,
  DEFAULT_TICK_INTERVAL_MS,
  createPluginJobSchedulerState,
  type PluginJobScheduler,
  type PluginJobSchedulerContext,
  type PluginJobSchedulerOptions,
  type SchedulerDiagnostics,
} from "./plugin-job-scheduler-execution.js";

export interface PluginJobSchedulerLifecycle {
  start(): void;
  stop(): void;
  registerPlugin(pluginId: string): Promise<void>;
  unregisterPlugin(pluginId: string): Promise<void>;
  diagnostics(): SchedulerDiagnostics;
}

export function buildPluginJobSchedulerLifecycle(
  context: PluginJobSchedulerContext,
  execution: PluginJobSchedulerExecution,
): PluginJobSchedulerLifecycle {
  const { jobStore, tickIntervalMs, maxConcurrentJobs, log, state } = context;

  async function registerPlugin(pluginId: string): Promise<void> {
    log.info({ pluginId }, "registering plugin with job scheduler");
    await execution.ensureNextRunTimestamps(pluginId);
    state.fencedPlugins.delete(pluginId);
  }

  async function unregisterPlugin(pluginId: string): Promise<void> {
    log.info({ pluginId }, "unregistering plugin from job scheduler");
    state.fencedPlugins.add(pluginId);

    const localCompletions = [...state.activeExecutions.values()]
      .filter((active) => active.pluginId === pluginId)
      .map((active) => active.completion);
    await Promise.all(localCompletions);

    const jobs = await jobStore.listJobs(pluginId);
    try {
      await jobStore.cancelNonTerminalRuns(pluginId, "Plugin unregistered");
    } finally {
      for (const job of jobs) state.activeJobs.delete(job.id);
    }
  }

  function start(): void {
    if (state.running) {
      log.debug("scheduler already running");
      return;
    }
    state.running = true;
    state.tickTimer = setInterval(() => {
      void execution.tick();
    }, tickIntervalMs);
    log.info({ tickIntervalMs, maxConcurrentJobs }, "plugin job scheduler started");
  }

  function stop(): void {
    if (state.tickTimer !== null) {
      clearInterval(state.tickTimer);
      state.tickTimer = null;
    }
    if (!state.running) return;
    state.running = false;
    log.info({ activeJobCount: state.activeJobs.size }, "plugin job scheduler stopped");
  }

  function diagnostics(): SchedulerDiagnostics {
    return {
      running: state.running,
      activeJobCount: state.activeJobs.size,
      activeJobIds: [...state.activeJobs],
      tickCount: state.tickCount,
      lastTickAt: state.lastTickAt?.toISOString() ?? null,
    };
  }

  return { start, stop, registerPlugin, unregisterPlugin, diagnostics };
}

export type {
  PluginJobScheduler,
  PluginJobSchedulerOptions,
  SchedulerDiagnostics,
  TriggerJobResult,
} from "./plugin-job-scheduler-execution.js";

/**
 * Creates the tick-based scheduler for manifest-declared plugin jobs.
 * Execution admission and lifecycle coordination live in focused modules so
 * they can be tested and maintained independently.
 */
export function createPluginJobScheduler(options: PluginJobSchedulerOptions): PluginJobScheduler {
  const context: PluginJobSchedulerContext = {
    db: options.db,
    jobStore: options.jobStore,
    workerManager: options.workerManager,
    tickIntervalMs: options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS,
    jobTimeoutMs: options.jobTimeoutMs ?? DEFAULT_JOB_TIMEOUT_MS,
    maxConcurrentJobs: options.maxConcurrentJobs ?? DEFAULT_MAX_CONCURRENT_JOBS,
    log: logger.child({ service: "plugin-job-scheduler" }),
    state: createPluginJobSchedulerState(),
  };
  const execution = buildPluginJobSchedulerExecution(context);
  const lifecycle = buildPluginJobSchedulerLifecycle(context, execution);

  return {
    ...lifecycle,
    tick: execution.tick,
    triggerJob: execution.triggerJob,
  };
}
