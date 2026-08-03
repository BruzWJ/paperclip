import { describe, expect, it, vi } from "vitest";
import { canonicalizeMoneyAmount } from "@paperclipai/shared";

import { createTestHarness } from "../src/testing.js";
import type { Agent, PaperclipPluginManifestV1 } from "../src/types.js";

const manifest = {
  id: "paperclip.test-actions",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Test Actions",
  description: "Test plugin",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: [],
  entrypoints: {},
} satisfies PaperclipPluginManifestV1;

describe("createTestHarness action context", () => {
  it("passes immutable authenticated actor context and overrides caller company scope", async () => {
    const harness = createTestHarness({ manifest });

    harness.ctx.actions.register("inspect", async (params, context) => ({
      paramsCompanyId: params.companyId,
      actor: context.actor,
      companyId: context.companyId,
      contextFrozen: Object.isFrozen(context),
      actorFrozen: Object.isFrozen(context.actor),
    }));

    const result = await harness.performAction<{
      paramsCompanyId: unknown;
      actor: {
        type: string;
        userId?: string;
        agentId?: string;
        runId?: string;
        companyId: string | null;
      };
      companyId: string | null;
      contextFrozen: boolean;
      actorFrozen: boolean;
    }>(
      "inspect",
      { companyId: "spoofed-company", value: true },
      {
        actor: {
          type: "user",
          userId: "board-user-1",
          companyId: "host-company",
        },
      },
    );

    expect(result.paramsCompanyId).toBe("host-company");
    expect(result.companyId).toBe("host-company");
    expect(result.actor).toEqual({
      type: "user",
      userId: "board-user-1",
      companyId: "host-company",
    });
    expect(result.contextFrozen).toBe(true);
    expect(result.actorFrozen).toBe(true);
  });

  it("keeps one-argument action handlers while requiring an explicit actor", async () => {
    const harness = createTestHarness({ manifest });
    harness.ctx.actions.register("legacy", async (params) => ({ ok: params.ok }));

    await expect(harness.performAction(
      "legacy",
      { ok: true },
      { actor: { type: "system", companyId: null } },
    )).resolves.toEqual({ ok: true });
  });

  it("uses the protocol decoder instead of accepting a mixed harness actor", async () => {
    const harness = createTestHarness({ manifest });
    const handler = vi.fn(async () => ({ ok: true }));
    harness.ctx.actions.register("strict", handler);

    await expect(harness.performAction(
      "strict",
      {},
      {
        actor: {
          type: "system",
          companyId: null,
          userId: "mixed",
        } as never,
      },
    )).rejects.toMatchObject({ code: -32602 });
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("createTestHarness issue control plane", () => {
  it("exposes only canonical plugin issue operations and terminalizes a withdrawal", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: ["issues.read", "issues.create", "issues.update", "issues.withdraw"],
    });
    const now = new Date();
    const owner: Agent = {
      id: "agent-1",
      companyId: "company-1",
      name: "Owner",
      urlKey: "owner",
      title: null,
      icon: null,
      status: "idle",
      reportsTo: null,
      capabilities: null,
      adapterType: "codex",
      adapterConfig: { model: "gpt-5.6" },
      runtimeConfig: {},
      budgetMonthlyAmount: canonicalizeMoneyAmount("0"),
      knownSpendAmount: canonicalizeMoneyAmount("0"),
      pauseReason: null,
      pausedAt: null,
      governance: {},
      metadata: null,
      createdAt: now,
      updatedAt: now,
    };
    harness.seed({ agents: [owner] });

    expect(Object.keys(harness.ctx.issues).sort()).toEqual([
      "create",
      "get",
      "list",
      "registerCreatorCallback",
      "update",
      "withdraw",
    ]);

    await harness.ctx.issues.registerCreatorCallback(
      { key: "release-files", version: "1" },
      (delivery) => ({ deliveryId: delivery.deliveryId, accepted: true }),
    );

    const issue = await harness.ctx.issues.create({
      companyId: "company-1",
      title: "Pick files",
      request: "Choose the files for the release.",
      ownerAgentId: owner.id,
      callbackKey: "release-files",
      callbackVersion: "1",
    });

    await expect(harness.ctx.issues.update(
      issue.id,
      { kind: "message", message: "Use the release manifest." },
      "company-1",
    )).resolves.toMatchObject({
      id: issue.id,
      request: "Choose the files for the release.",
      lifecycleStatus: "open",
      ownerKind: "agent",
      ownerAgentId: owner.id,
      ownershipEpoch: 1,
      creatorKind: "plugin",
      creatorCallbackKey: "release-files",
      creatorCallbackVersion: "1",
    });

    const withdrawal = await harness.ctx.issues.withdraw(
      issue.id,
      "The release no longer needs this work.",
      "company-1",
    );
    expect(withdrawal).toMatchObject({
      issue: { id: issue.id, lifecycleStatus: "cancelled" },
      retried: false,
    });

    await expect(harness.ctx.issues.update(
      issue.id,
      { kind: "message", message: "Too late" },
      "company-1",
    )).rejects.toThrow("terminal");
  });
});
