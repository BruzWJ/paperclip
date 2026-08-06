import { describe, expect, it, vi } from "vitest";
import { canonicalizeMoneyAmount } from "@paperclipai/shared";

import { createTestHarness } from "../src/testing.js";
import {
  definePlugin as defineSdkPlugin,
  type PluginDefinition,
} from "../src/define-plugin.js";
import type {
  Agent,
  PaperclipPluginManifestV1,
  PluginBeforePromptInput,
} from "../src/types.js";

function definePlugin(definition: Omit<PluginDefinition, "onHealth">) {
  return defineSdkPlugin({
    ...definition,
    async onHealth() {
      return { status: "ok" };
    },
  });
}

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

const beforePromptInput = {
  companyId: "company-1",
  issueId: "issue-1",
  sessionId: "session-1",
  runId: "run-1",
  agentId: "agent-1",
  projectId: null,
  sourceText: "Continue the issue",
  promptKind: "base",
  sessionOperation: "new",
  refId: "ref-1",
  refOrdinal: 0,
  segmentOrdinal: 0,
  sourceMessageId: "msg_source",
  sourceMessageSeq: 12,
  contextAccess: {
    carry_context: false,
    read_issue_comments: true,
    read_issue_agent_run: false,
    list_sub_issues: false,
    read_sub_issue_comments: false,
    read_sub_issue_agent_run: false,
    list_company_issues: false,
    read_company_issue_comments: false,
    read_company_issue_agent_run: false,
  },
  snapshotHighWaterSeq: 12,
} satisfies PluginBeforePromptInput;

describe("createTestHarness before-prompt lifecycle", () => {
  it("requires the install-visible capability and returns the hook result", async () => {
    const plugin = definePlugin({
      async setup() {},
      async onBeforePrompt() {
        return { prependText: "Plugin prelude" };
      },
    });
    const allowed = createTestHarness({
      manifest: {
        ...manifest,
        capabilities: ["runtime.prompt.observe"],
      },
    });
    await expect(allowed.beforePrompt(plugin, beforePromptInput)).resolves.toEqual({
      prependText: "Plugin prelude",
    });

    const denied = createTestHarness({ manifest });
    await expect(denied.beforePrompt(plugin, beforePromptInput)).rejects.toThrow(
      "runtime.prompt.observe",
    );
  });
});

describe("createTestHarness plugin entity identity", () => {
  it("upserts one record per exact type, scope, and nullable external ID", async () => {
    const harness = createTestHarness({ manifest });

    const first = await harness.ctx.entities.upsert({
      entityType: "summary",
      scopeKind: "issue",
      scopeId: "issue-1",
      data: { revision: 1 },
    });
    const updated = await harness.ctx.entities.upsert({
      entityType: "summary",
      scopeKind: "issue",
      scopeId: "issue-1",
      data: { revision: 2 },
    });
    const otherScope = await harness.ctx.entities.upsert({
      entityType: "summary",
      scopeKind: "issue",
      scopeId: "issue-2",
      data: { revision: 1 },
    });

    expect(updated).toMatchObject({
      id: first.id,
      createdAt: first.createdAt,
      externalId: null,
      data: { revision: 2 },
    });
    expect(otherScope.id).not.toBe(first.id);
    await expect(harness.ctx.entities.list({
      scopeKind: "issue",
      scopeId: "issue-1",
    })).resolves.toEqual([updated]);
  });
});

describe("createTestHarness action context", () => {
  it("passes one immutable authenticated actor context without rewriting plugin params", async () => {
    const harness = createTestHarness({ manifest });

    harness.ctx.actions.register("inspect", async (params, context) => ({
      paramsCompanyId: params.companyId,
      actor: context.actor,
      actorCompanyId: context.actor.companyId,
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
      actorCompanyId: string | null;
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

    expect(result.paramsCompanyId).toBe("spoofed-company");
    expect(result.actorCompanyId).toBe("host-company");
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
    harness.ctx.actions.register("one-argument", async (params) => ({ ok: params.ok }));

    await expect(harness.performAction(
      "one-argument",
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

describe("createTestHarness invite contract", () => {
  it("creates, lists, scopes, and revokes invites in memory", async () => {
    const harness = createTestHarness({
      manifest: {
        ...manifest,
        capabilities: ["access.invites.read", "access.invites.write"],
      },
    });

    const created = await harness.ctx.access.invites.create({
      companyId: "company-1",
      allowedJoinTypes: "both",
      humanRole: "viewer",
      defaultsPayload: { source: "test" },
      agentMessage: "Join the test company",
    });
    expect(created).toMatchObject({
      companyId: "company-1",
      source: "plugin_host",
      state: "active",
      defaultsPayload: {
        source: "test",
        human: { role: "viewer", grants: [] },
        agentMessage: "Join the test company",
      },
    });
    expect(created.token).toEqual(expect.any(String));

    await expect(harness.ctx.access.invites.list({
      companyId: "company-2",
    })).resolves.toEqual({ invites: [], nextOffset: null });
    await expect(harness.ctx.access.invites.list({
      companyId: "company-1",
      state: "active",
    })).resolves.toMatchObject({
      invites: [{ id: created.id, state: "active" }],
      nextOffset: null,
    });

    await expect(harness.ctx.access.invites.revoke(
      created.id,
      "company-2",
    )).rejects.toThrow("Invite not found");
    await expect(harness.ctx.access.invites.revoke(
      created.id,
      "company-1",
    )).resolves.toMatchObject({ id: created.id, state: "revoked" });
    await expect(harness.ctx.access.invites.list({
      companyId: "company-1",
      state: "active",
    })).resolves.toEqual({ invites: [], nextOffset: null });
  });
});

describe("createTestHarness issue control plane", () => {
  it("exposes only canonical plugin issue operations and terminalizes a withdrawal", async () => {
    const harness = createTestHarness({
      manifest: {
        ...manifest,
        capabilities: ["issues.read", "issues.create", "issues.update", "issues.withdraw"],
      },
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
