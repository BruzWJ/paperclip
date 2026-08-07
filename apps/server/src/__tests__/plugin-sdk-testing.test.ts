import { describe, expect, it } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";

describe("plugin SDK test harness", () => {
  it("requires skills.managed capability before resetting a missing declaration", async () => {
    const manifest: PaperclipPluginManifestV1 = {
      id: "paperclip.test-missing-managed-skill-capability",
      apiVersion: 1,
      version: "0.1.0",
      displayName: "Missing Managed Skill Capability",
      description: "Test plugin",
      author: "Paperclip",
      categories: ["automation"],
      capabilities: [],
      entrypoints: { worker: "./dist/worker.js" },
      skills: [{
        skillKey: "wiki-maintainer",
        displayName: "Wiki Maintainer",
      }],
    };
    const harness = createTestHarness({ manifest });

    await expect(harness.ctx.skills.managed.reset("unknown-skill", "company-1")).rejects.toThrow(
      "missing required capability 'skills.managed'",
    );
  });

  it("requires access and authorization capabilities for permission SDK calls", async () => {
    const manifest: PaperclipPluginManifestV1 = {
      id: "paperclip.test-missing-access-authz-capability",
      apiVersion: 1,
      version: "0.1.0",
      displayName: "Missing Access Capability",
      description: "Test plugin",
      author: "Paperclip",
      categories: ["automation"],
      capabilities: [],
      entrypoints: { worker: "./dist/worker.js" },
    };
    const harness = createTestHarness({ manifest });

    await expect(harness.ctx.access.members.list({ companyId: "company-1" })).rejects.toThrow(
      "missing required capability 'access.members.read'",
    );
    await expect(harness.ctx.authorization.grants.list({ companyId: "company-1" })).rejects.toThrow(
      "missing required capability 'authorization.grants.read'",
    );
    await expect(harness.ctx.authorization.audit.search({ companyId: "company-1" })).rejects.toThrow(
      "missing required capability 'authorization.audit.read'",
    );
  });

});
