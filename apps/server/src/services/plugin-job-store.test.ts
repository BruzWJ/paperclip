import { describe, expect, it } from "vitest";
import type { PluginJobRecord, PluginJobRunRecord } from "@paperclipai/shared";
import { createMockDb } from "../__tests__/helpers/mock-db.js";
import { pluginJobStore } from "./plugin-job-store.js";

const job = {
  id: "00000000-0000-4000-8000-000000000001",
  pluginId: "00000000-0000-4000-8000-000000000002",
  jobKey: "refresh",
  schedule: "0 * * * *",
  status: "active",
  nextRunAt: new Date("2026-08-06T01:00:00.000Z"),
  createdAt: new Date("2026-08-06T00:00:00.000Z"),
  updatedAt: new Date("2026-08-06T00:00:00.000Z"),
} satisfies PluginJobRecord;

const run = {
  id: "00000000-0000-4000-8000-000000000003",
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

describe("pluginJobStore run lifecycle", () => {
  it("clears the schedule pointer when a manifest changes a cron expression", async () => {
    const harness = createMockDb({
      select: [
        [{ id: job.pluginId, status: "ready" }],
        [job],
      ],
      update: [[]],
    });

    await pluginJobStore(harness.db).syncJobDeclarations(job.pluginId, [{
      jobKey: job.jobKey,
      displayName: "Refresh",
      schedule: "15 * * * *",
    }]);

    expect(harness.calls.find((call) =>
      call.operation === "update" && call.method === "set"
    )?.args[0]).toMatchObject({
      schedule: "15 * * * *",
      nextRunAt: null,
      updatedAt: expect.any(Date),
    });
  });

  it("restores a re-declared job and requires a new schedule pointer", async () => {
    const harness = createMockDb({
      select: [
        [{ id: job.pluginId, status: "ready" }],
        [{ ...job, status: "removed" }],
      ],
      update: [[]],
    });

    await pluginJobStore(harness.db).syncJobDeclarations(job.pluginId, [{
      jobKey: job.jobKey,
      displayName: "Refresh",
      schedule: job.schedule,
    }]);

    expect(harness.calls.find((call) =>
      call.operation === "update" && call.method === "set"
    )?.args[0]).toMatchObject({
      status: "active",
      nextRunAt: null,
      updatedAt: expect.any(Date),
    });
  });

  it("locks the job and creates the only queued run when no run is active", async () => {
    const harness = createMockDb({
      select: [[{ id: job.id, status: "active" }], []],
      insert: [[run]],
    });

    await expect(pluginJobStore(harness.db).createRunIfIdle({
      jobId: job.id,
      pluginId: job.pluginId,
      trigger: "manual",
    })).resolves.toEqual(run);

    expect(harness.calls.some((call) =>
      call.operation === "select" && call.method === "for"
    )).toBe(true);
    expect(harness.remaining("insert")).toBe(0);
  });

  it("does not insert when a queued or running execution already exists", async () => {
    const harness = createMockDb({
      select: [
        [{ id: job.id, status: "active" }],
        [{ id: run.id }],
      ],
    });

    await expect(pluginJobStore(harness.db).createRunIfIdle({
      jobId: job.id,
      pluginId: job.pluginId,
      trigger: "schedule",
    })).resolves.toBeNull();

    expect(harness.calls.some((call) => call.operation === "insert")).toBe(false);
  });

  it("reports whether a non-terminal run accepted a terminal update", async () => {
    const harness = createMockDb({ update: [[{ id: run.id }], []] });
    const store = pluginJobStore(harness.db);

    await expect(store.completeRun(run.id, { status: "succeeded" })).resolves.toBe(true);
    await expect(store.completeRun(run.id, { status: "failed" })).resolves.toBe(false);
  });

  it("reports whether the exact active schedule pointer advanced", async () => {
    const next = new Date("2026-08-06T02:00:00.000Z");
    const harness = createMockDb({ update: [[{ id: job.id }], []] });
    const store = pluginJobStore(harness.db);

    await expect(store.advanceNextRunAt({
      jobId: job.id,
      schedule: job.schedule,
      currentNextRunAt: job.nextRunAt!,
      nextRunAt: next,
    })).resolves.toBe(true);
    await expect(store.advanceNextRunAt({
      jobId: job.id,
      schedule: job.schedule,
      currentNextRunAt: job.nextRunAt!,
      nextRunAt: next,
    })).resolves.toBe(false);

    expect(harness.calls.filter((call) =>
      call.operation === "update" && call.method === "set"
    ).map((call) => call.args[0])).toEqual([
      expect.objectContaining({ nextRunAt: next, updatedAt: expect.any(Date) }),
      expect.objectContaining({ nextRunAt: next, updatedAt: expect.any(Date) }),
    ]);
  });

  it("cancels all interrupted runs in one update", async () => {
    const harness = createMockDb({
      update: [[{ id: run.id }, { id: "00000000-0000-4000-8000-000000000004" }]],
    });

    await expect(pluginJobStore(harness.db).cancelNonTerminalRuns(
      job.pluginId,
      "runtime restarted",
    )).resolves.toBe(2);

    expect(harness.calls.find((call) =>
      call.operation === "update" && call.method === "set"
    )?.args[0]).toMatchObject({
      status: "cancelled",
      error: "runtime restarted",
      durationMs: null,
      finishedAt: expect.any(Date),
    });
  });

  it("cancels interrupted runs across every plugin during startup", async () => {
    const harness = createMockDb({ update: [[{ id: run.id }]] });

    await expect(pluginJobStore(harness.db).cancelAllNonTerminalRuns(
      "server restarted",
    )).resolves.toBe(1);

    expect(harness.calls.find((call) =>
      call.operation === "update" && call.method === "set"
    )?.args[0]).toMatchObject({
      status: "cancelled",
      error: "server restarted",
    });
  });
});
