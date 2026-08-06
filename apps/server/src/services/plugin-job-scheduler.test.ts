import { describe, expect, it, vi } from "vitest";
import type { PluginJobRecord, PluginJobRunRecord } from "@paperclipai/shared";
import type { PluginJobStore } from "./plugin-job-store.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import { createPluginJobScheduler } from "./plugin-job-scheduler.js";

const job = {
  id: "00000000-0000-4000-8000-000000000011",
  pluginId: "00000000-0000-4000-8000-000000000012",
  jobKey: "refresh",
  schedule: "0 * * * *",
  status: "active",
  nextRunAt: new Date("2026-08-06T01:00:00.000Z"),
  createdAt: new Date("2026-08-06T00:00:00.000Z"),
  updatedAt: new Date("2026-08-06T00:00:00.000Z"),
} satisfies PluginJobRecord;

const run = {
  id: "00000000-0000-4000-8000-000000000013",
  jobId: job.id,
  pluginId: job.pluginId,
  trigger: "manual",
  status: "queued",
  durationMs: null,
  error: null,
  startedAt: null,
  finishedAt: null,
  createdAt: new Date("2026-08-06T00:01:00.000Z"),
} satisfies PluginJobRunRecord;

function createStore(overrides: Partial<PluginJobStore> = {}) {
  return {
    getJobById: vi.fn().mockResolvedValue(job),
    createRunIfIdle: vi.fn().mockResolvedValue(run),
    markRunning: vi.fn().mockResolvedValue(true),
    completeRun: vi.fn().mockResolvedValue(true),
    cancelNonTerminalRuns: vi.fn().mockResolvedValue(0),
    cancelAllNonTerminalRuns: vi.fn().mockResolvedValue(0),
    listJobs: vi.fn().mockResolvedValue([]),
    updateNextRunAt: vi.fn().mockResolvedValue(undefined),
    advanceNextRunAt: vi.fn().mockResolvedValue(true),
    ...overrides,
  } as unknown as PluginJobStore;
}

function createWorkerManager(call: ReturnType<typeof vi.fn>) {
  return {
    isRunning: vi.fn().mockReturnValue(true),
    call,
  } as unknown as PluginWorkerManager;
}

describe("plugin job scheduler", () => {
  it("admits a manual run before returning and uses the single run lifecycle", async () => {
    let finishWorker!: () => void;
    const workerCall = vi.fn().mockImplementation(() => new Promise((resolve) => {
      finishWorker = () => resolve({});
    }));
    const store = createStore();
    const scheduler = createPluginJobScheduler({
      db: {} as never,
      jobStore: store,
      workerManager: createWorkerManager(workerCall),
    });

    await expect(scheduler.triggerJob(job.id)).resolves.toEqual({
      jobId: job.id,
      runId: run.id,
    });
    expect(store.createRunIfIdle).toHaveBeenCalledWith({
      jobId: job.id,
      pluginId: job.pluginId,
      trigger: "manual",
    });

    await expect(scheduler.triggerJob(job.id)).rejects.toThrow(
      /already queued or running/,
    );
    expect(store.createRunIfIdle).toHaveBeenCalledTimes(1);

    await vi.waitFor(() => expect(workerCall).toHaveBeenCalledOnce());
    finishWorker();
    await vi.waitFor(() => expect(store.completeRun).toHaveBeenCalledWith(
      run.id,
      expect.objectContaining({ status: "succeeded" }),
    ));
    expect(scheduler.diagnostics().activeJobCount).toBe(0);
  });

  it("fences admission until registration and cancels residual durable runs", async () => {
    const store = createStore({
      cancelNonTerminalRuns: vi.fn().mockResolvedValue(1),
      listJobs: vi.fn().mockResolvedValue([job]),
    });
    const scheduler = createPluginJobScheduler({
      db: {} as never,
      jobStore: store,
      workerManager: createWorkerManager(vi.fn()),
    });

    await scheduler.unregisterPlugin(job.pluginId);

    expect(store.cancelNonTerminalRuns).toHaveBeenCalledWith(
      job.pluginId,
      "Plugin unregistered",
    );
    await expect(scheduler.triggerJob(job.id)).rejects.toThrow("is unregistering");

    await scheduler.registerPlugin(job.pluginId);
    await expect(scheduler.triggerJob(job.id)).resolves.toEqual({
      jobId: job.id,
      runId: run.id,
    });
    await vi.waitFor(() => expect(store.completeRun).toHaveBeenCalled());
  });

  it("waits for graceful execution and its terminal write before residual cancellation", async () => {
    let finishWorker!: () => void;
    const workerCall = vi.fn().mockImplementation(() => new Promise((resolve) => {
      finishWorker = () => resolve({});
    }));
    const order: string[] = [];
    const store = createStore({
      completeRun: vi.fn().mockImplementation(async () => {
        order.push("completed");
        return true;
      }),
      cancelNonTerminalRuns: vi.fn().mockImplementation(async () => {
        order.push("cancelled-residual");
        return 0;
      }),
      listJobs: vi.fn().mockResolvedValue([job]),
    });
    const scheduler = createPluginJobScheduler({
      db: {} as never,
      jobStore: store,
      workerManager: createWorkerManager(workerCall),
    });

    await scheduler.triggerJob(job.id);
    await vi.waitFor(() => expect(workerCall).toHaveBeenCalledOnce());
    const unregister = scheduler.unregisterPlugin(job.pluginId);

    await expect(scheduler.triggerJob(job.id)).rejects.toThrow("is unregistering");
    expect(store.cancelNonTerminalRuns).not.toHaveBeenCalled();

    finishWorker();
    await unregister;

    expect(store.completeRun).toHaveBeenCalledWith(
      run.id,
      expect.objectContaining({ status: "succeeded" }),
    );
    expect(order).toEqual(["completed", "cancelled-residual"]);
  });

  it("records forced execution failure before cancelling residual runs", async () => {
    let forceWorkerFailure!: (error: Error) => void;
    const workerCall = vi.fn().mockImplementation(() => new Promise((_, reject) => {
      forceWorkerFailure = reject;
    }));
    const order: string[] = [];
    const store = createStore({
      completeRun: vi.fn().mockImplementation(async (_runId, input) => {
        order.push(`completed:${input.status}`);
        return true;
      }),
      cancelNonTerminalRuns: vi.fn().mockImplementation(async () => {
        order.push("cancelled-residual");
        return 1;
      }),
      listJobs: vi.fn().mockResolvedValue([job]),
    });
    const scheduler = createPluginJobScheduler({
      db: {} as never,
      jobStore: store,
      workerManager: createWorkerManager(workerCall),
    });

    await scheduler.triggerJob(job.id);
    await vi.waitFor(() => expect(workerCall).toHaveBeenCalledOnce());
    const unregister = scheduler.unregisterPlugin(job.pluginId);

    forceWorkerFailure(new Error("worker forced to stop"));
    await unregister;

    expect(store.completeRun).toHaveBeenCalledWith(
      run.id,
      expect.objectContaining({
        status: "failed",
        error: "worker forced to stop",
      }),
    );
    expect(order).toEqual(["completed:failed", "cancelled-residual"]);
  });
});
