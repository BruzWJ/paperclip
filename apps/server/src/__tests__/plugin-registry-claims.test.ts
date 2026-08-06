import { describe, expect, it } from "vitest";
import type { PaperclipPluginManifestV1, PluginRecord } from "@paperclipai/shared";
import {
  installPluginInTransaction,
  lockPluginRegistryClaimsInTransaction,
  pluginRegistryService,
} from "../services/plugin-registry.js";
import { createMockDb } from "./helpers/mock-db.js";

function manifest(
  id: string,
  slot?: { type: "page" | "companySettingsPage"; routePath: string },
): PaperclipPluginManifestV1 {
  return {
    id,
    apiVersion: 1,
    version: "1.0.0",
    displayName: id,
    description: "Plugin registry claim test.",
    author: "Paperclip",
    categories: ["automation"],
    capabilities: slot
      ? [slot.type === "page" ? "ui.page.register" : "instance.settings.register"]
      : [],
    entrypoints: { worker: "./worker.js", ...(slot ? { ui: "./ui" } : {}) },
    ...(slot
      ? {
          ui: {
            slots: [{
              ...slot,
              id: `${slot.type}-slot`,
              displayName: slot.type,
              exportName: "Page",
            }],
          },
        }
      : {}),
  };
}

function installation(
  overrides: Partial<PluginRecord> = {},
): PluginRecord {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    pluginKey: "paperclip.existing",
    packageName: "paperclip-existing",
    source: "npm",
    manifestJson: manifest("paperclip.existing"),
    status: "ready",
    installOrder: 1,
    packagePath: "/plugins/existing",
    lastError: null,
    installedAt: new Date("2026-08-05T00:00:00.000Z"),
    updatedAt: new Date("2026-08-05T00:00:00.000Z"),
    ...overrides,
  };
}

describe("plugin registry claims", () => {
  it("fails webhook deliveries interrupted by a server restart", async () => {
    const harness = createMockDb({
      update: [[{ id: "00000000-0000-4000-8000-000000000099" }]],
    });

    await expect(
      pluginRegistryService(harness.db).failInterruptedWebhookDeliveries(
        "server restarted",
      ),
    ).resolves.toBe(1);

    expect(harness.calls.find((call) =>
      call.operation === "update" && call.method === "set"
    )?.args[0]).toMatchObject({
      status: "failed",
      error: "server restarted",
      durationMs: null,
      finishedAt: expect.any(Date),
    });
  });

  it("locks before allocating the one immutable install order", async () => {
    const existing = installation({
      id: "00000000-0000-4000-8000-000000000009",
      installOrder: 9,
    });
    const inserted = installation({
      id: "00000000-0000-4000-8000-000000000010",
      pluginKey: "paperclip.new",
      manifestJson: manifest("paperclip.new"),
      installOrder: 10,
    });
    const harness = createMockDb({
      execute: [[]],
      select: [[existing]],
      insert: [[inserted]],
    });

    await expect(installPluginInTransaction(
      harness.db as never,
      {
        packageName: "paperclip-new",
        packagePath: "/plugins/new",
        source: "npm",
        status: "ready",
      },
      manifest("paperclip.new"),
    )).resolves.toEqual(inserted);

    expect(harness.calls.map((call) => call.operation)).toEqual([
      "execute",
      "select",
      "select",
      "insert",
      "insert",
      "insert",
    ]);
    expect(harness.calls.find((call) =>
      call.operation === "insert" && call.method === "values"
    )?.args[0]).toMatchObject({ installOrder: 10, pluginKey: "paperclip.new" });
  });

  it("rejects an occupied company page route while holding the claim lock", async () => {
    const existing = installation({
      manifestJson: manifest("paperclip.existing", { type: "page", routePath: "wiki" }),
    });
    const harness = createMockDb({ execute: [[]], select: [[existing]] });

    await expect(lockPluginRegistryClaimsInTransaction(
      harness.db as never,
      manifest("paperclip.new", { type: "page", routePath: "wiki" }),
    )).rejects.toThrow(/company page routePath "wiki" conflicts/);
  });

  it("keeps company pages and company settings pages in distinct route namespaces", async () => {
    const existing = installation({
      manifestJson: manifest("paperclip.existing", { type: "page", routePath: "wiki" }),
    });
    const harness = createMockDb({ execute: [[]], select: [[existing]] });

    await expect(lockPluginRegistryClaimsInTransaction(
      harness.db as never,
      manifest("paperclip.new", { type: "companySettingsPage", routePath: "wiki" }),
    )).resolves.toEqual([existing]);
  });
});
