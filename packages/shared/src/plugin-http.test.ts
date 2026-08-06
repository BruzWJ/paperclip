import { describe, expect, it } from "vitest";
import type {
  PaperclipPluginManifestV1,
  PluginConfig,
  PluginJobRecord,
  PluginJobRunRecord,
  PluginRecord,
} from "./index.js";
import {
  serializePluginConfig,
  serializePluginDetail,
  serializePluginJob,
  serializePluginJobRun,
  serializePluginLog,
  serializePluginRecord,
} from "./plugin-http.js";

const manifest: PaperclipPluginManifestV1 = {
  apiVersion: 1,
  id: "paperclip.example",
  version: "1.0.0",
  displayName: "Example",
  description: "Example plugin",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: [],
  entrypoints: { worker: "dist/worker.js" },
};

describe("plugin HTTP serialization", () => {
  it("serializes installation and detail timestamps as ISO strings", () => {
    const record: PluginRecord = {
      id: "plugin-1",
      pluginKey: manifest.id,
      packageName: "@paperclipai/plugin-example",
      source: "npm",
      manifestJson: manifest,
      status: "ready",
      installOrder: 1,
      packagePath: "/plugins/example",
      lastError: null,
      installedAt: new Date("2026-08-05T01:02:03.000Z"),
      updatedAt: new Date("2026-08-06T04:05:06.000Z"),
    };

    expect(serializePluginRecord(record)).toMatchObject({
      installedAt: "2026-08-05T01:02:03.000Z",
      updatedAt: "2026-08-06T04:05:06.000Z",
    });
    expect(serializePluginDetail(record, true)).toMatchObject({
      installedAt: "2026-08-05T01:02:03.000Z",
      updatedAt: "2026-08-06T04:05:06.000Z",
      supportsConfigTest: true,
    });
  });

  it("serializes config and log timestamps as ISO strings", () => {
    const config: PluginConfig = {
      id: "config-1",
      pluginId: "plugin-1",
      configJson: { endpoint: "https://example.test" },
      createdAt: new Date("2026-08-05T01:02:03.000Z"),
      updatedAt: new Date("2026-08-06T04:05:06.000Z"),
    };

    expect(serializePluginConfig(config)).toMatchObject({
      createdAt: "2026-08-05T01:02:03.000Z",
      updatedAt: "2026-08-06T04:05:06.000Z",
    });
    expect(serializePluginLog({
      id: "log-1",
      pluginId: "plugin-1",
      companyId: null,
      level: "info",
      message: "ready",
      meta: null,
      createdAt: new Date("2026-08-05T01:02:03.000Z"),
    })).toMatchObject({ createdAt: "2026-08-05T01:02:03.000Z" });
  });

  it("serializes nullable job timestamps without changing nulls", () => {
    const job: PluginJobRecord = {
      id: "job-1",
      pluginId: "plugin-1",
      jobKey: "sync",
      schedule: "0 * * * *",
      status: "active",
      nextRunAt: new Date("2026-08-06T04:05:06.000Z"),
      createdAt: new Date("2026-08-05T01:02:03.000Z"),
      updatedAt: new Date("2026-08-05T02:03:04.000Z"),
    };
    const run: PluginJobRunRecord = {
      id: "run-1",
      jobId: job.id,
      pluginId: job.pluginId,
      trigger: "schedule",
      status: "succeeded",
      durationMs: 12,
      error: null,
      startedAt: new Date("2026-08-05T01:02:03.000Z"),
      finishedAt: null,
      createdAt: new Date("2026-08-05T01:02:03.000Z"),
    };

    expect(serializePluginJob(job)).toMatchObject({
      nextRunAt: "2026-08-06T04:05:06.000Z",
      createdAt: "2026-08-05T01:02:03.000Z",
      updatedAt: "2026-08-05T02:03:04.000Z",
    });
    expect(serializePluginJobRun(run)).toMatchObject({
      startedAt: "2026-08-05T01:02:03.000Z",
      finishedAt: null,
      createdAt: "2026-08-05T01:02:03.000Z",
    });
  });
});
