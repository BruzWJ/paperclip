import { describe, expect, it, vi } from "vitest";
import { canonicalizeMoneyAmount } from "@paperclipai/shared";

import { createTestHarness } from "../src/testing.js";
import {
  definePlugin as defineSdkPlugin,
  type PluginDefinition,
} from "../src/define-plugin.js";
import type {
  Agent,
  Company,
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

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const TASK_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_TASK_ID = "44444444-4444-4444-8444-444444444444";
const SESSION_ID = "55555555-5555-4555-8555-555555555555";
const RUN_ID = "66666666-6666-4666-8666-666666666666";
const AGENT_ID = "77777777-7777-4777-8777-777777777777";
const REF_ID = "88888888-8888-4888-8888-888888888888";

const beforePromptInput = {
  companyId: COMPANY_ID,
  taskId: TASK_ID,
  sessionId: SESSION_ID,
  runId: RUN_ID,
  agentId: AGENT_ID,
  projectId: null,
  sourceText: "Continue the task",
  sessionOperation: "new",
  refId: REF_ID,
  refOrdinal: 0,
  sourceMessageId: "msg_source",
  sourceMessageSeq: 12,
  contextAccess: {
    carry_context: false,
    read_task_comments: true,
    read_task_agent_run: false,
    list_sub_tasks: false,
    read_sub_task_comments: false,
    read_sub_task_agent_run: false,
    list_company_tasks: false,
    read_company_task_comments: false,
    read_company_task_agent_run: false,
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
    await expect(
      allowed.beforePrompt(plugin, beforePromptInput),
    ).resolves.toEqual({
      prependText: "Plugin prelude",
    });

    const denied = createTestHarness({ manifest });
    await expect(
      denied.beforePrompt(plugin, beforePromptInput),
    ).rejects.toThrow("runtime.prompt.observe");
  });
});

describe("createTestHarness plugin entity identity", () => {
  it("upserts one record per exact type, scope, and nullable external ID", async () => {
    const harness = createTestHarness({ manifest });

    const first = await harness.ctx.entities.upsert({
      entityType: "summary",
      scopeKind: "task",
      scopeId: TASK_ID,
      data: { revision: 1 },
    });
    const updated = await harness.ctx.entities.upsert({
      entityType: "summary",
      scopeKind: "task",
      scopeId: TASK_ID,
      data: { revision: 2 },
    });
    const otherScope = await harness.ctx.entities.upsert({
      entityType: "summary",
      scopeKind: "task",
      scopeId: OTHER_TASK_ID,
      data: { revision: 1 },
    });

    expect(updated).toMatchObject({
      id: first.id,
      createdAt: first.createdAt,
      externalId: null,
      data: { revision: 2 },
    });
    expect(otherScope.id).not.toBe(first.id);
    await expect(
      harness.ctx.entities.list({
        scopeKind: "task",
        scopeId: TASK_ID,
      }),
    ).resolves.toEqual([updated]);
  });
});

describe("createTestHarness exact list and audit inputs", () => {
  it("rejects pagination coercion and authorization decision aliases", async () => {
    const harness = createTestHarness({
      manifest: {
        ...manifest,
        capabilities: ["companies.read", "authorization.audit.read"],
      },
    });

    await expect(
      harness.ctx.companies.list({
        limit: "1" as never,
      }),
    ).rejects.toThrow("limit must be an exact integer between 1 and 100");
    await expect(
      harness.ctx.companies.list({
        limit: 1.5,
      }),
    ).rejects.toThrow("limit must be an exact integer between 1 and 100");
    await expect(
      harness.ctx.companies.list({
        offset: -1,
      }),
    ).rejects.toThrow("offset must be an exact integer between 0 and");
    await expect(
      harness.ctx.authorization.audit.search({
        companyId: COMPANY_ID,
        decision: " Allow " as never,
      }),
    ).rejects.toThrow('decision must be exactly "allow" or "deny"');
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
          companyId: COMPANY_ID,
        },
      },
    );

    expect(result.paramsCompanyId).toBe("spoofed-company");
    expect(result.actorCompanyId).toBe(COMPANY_ID);
    expect(result.actor).toEqual({
      type: "user",
      userId: "board-user-1",
      companyId: COMPANY_ID,
    });
    expect(result.contextFrozen).toBe(true);
    expect(result.actorFrozen).toBe(true);
  });

  it("keeps one-argument action handlers while requiring an explicit actor", async () => {
    const harness = createTestHarness({ manifest });
    harness.ctx.actions.register("one-argument", async (params) => ({
      ok: params.ok,
    }));

    await expect(
      harness.performAction(
        "one-argument",
        { ok: true },
        { actor: { type: "system", companyId: null } },
      ),
    ).resolves.toEqual({ ok: true });
  });

  it("uses the protocol decoder instead of accepting a mixed harness actor", async () => {
    const harness = createTestHarness({ manifest });
    const handler = vi.fn(async () => ({ ok: true }));
    harness.ctx.actions.register("strict", handler);

    await expect(
      harness.performAction(
        "strict",
        {},
        {
          actor: {
            type: "system",
            companyId: null,
            userId: "mixed",
          } as never,
        },
      ),
    ).rejects.toMatchObject({ code: -32602 });
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
      companyId: COMPANY_ID,
      userRole: "viewer",
    });
    expect(created).toMatchObject({
      companyId: COMPANY_ID,
      source: "plugin_host",
      state: "active",
      userRole: "viewer",
    });
    expect(created.token).toEqual(expect.any(String));

    await expect(
      harness.ctx.access.invites.list({
        companyId: OTHER_COMPANY_ID,
      }),
    ).resolves.toEqual({ invites: [], nextOffset: null });
    await expect(
      harness.ctx.access.invites.list({
        companyId: COMPANY_ID,
        state: "active",
      }),
    ).resolves.toMatchObject({
      invites: [{ id: created.id, state: "active" }],
      nextOffset: null,
    });

    await expect(
      harness.ctx.access.invites.revoke(created.id, OTHER_COMPANY_ID),
    ).rejects.toThrow("Invite not found");
    await expect(
      harness.ctx.access.invites.revoke(created.id, COMPANY_ID),
    ).resolves.toMatchObject({ id: created.id, state: "revoked" });
    await expect(
      harness.ctx.access.invites.list({
        companyId: COMPANY_ID,
        state: "active",
      }),
    ).resolves.toEqual({ invites: [], nextOffset: null });
  });
});

describe("createTestHarness task control plane", () => {
  it("exposes only canonical plugin task operations and terminalizes a withdrawal", async () => {
    const harness = createTestHarness({
      manifest: {
        ...manifest,
        capabilities: [
          "tasks.read",
          "tasks.create",
          "tasks.update",
          "tasks.withdraw",
        ],
      },
    });
    const now = new Date();
    const owner: Agent = {
      id: AGENT_ID,
      companyId: COMPANY_ID,
      name: "Owner",
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
      instruction: null,
      createdAt: now,
      updatedAt: now,
    };
    const company: Company = {
      id: COMPANY_ID,
      name: "Canonical task company",
      description: null,
      status: "active",
      pauseReason: null,
      pausedAt: null,
      taskPrefix: "SDK",
      taskCounter: 0,
      budgetCurrency: "USD",
      budgetMonthlyAmount: canonicalizeMoneyAmount("0"),
      knownSpendAmount: canonicalizeMoneyAmount("0"),
      attachmentMaxBytes: 10 * 1024 * 1024,
      defaultResponsibleUserId: null,
      requireBoardApprovalForNewAgents: false,
      brandColor: null,
      logoAssetId: null,
      logoUrl: null,
      createdAt: now,
      updatedAt: now,
    };
    harness.seed({ companies: [company], agents: [owner] });

    expect(Object.keys(harness.ctx.tasks).sort()).toEqual([
      "create",
      "get",
      "list",
      "registerCreatorCallback",
      "update",
      "withdraw",
    ]);

    await expect(
      harness.ctx.tasks.registerCreatorCallback(
        { key: " release-files ", version: " 1 " },
        (delivery) => ({ deliveryId: delivery.deliveryId, accepted: true }),
      ),
    ).rejects.toThrow(
      "Creator callback key and version must be exact non-empty strings",
    );

    await harness.ctx.tasks.registerCreatorCallback(
      { key: "release-files", version: "1" },
      (delivery) => ({ deliveryId: delivery.deliveryId, accepted: true }),
    );

    const task = await harness.ctx.tasks.create({
      companyId: COMPANY_ID,
      title: "Pick files",
      request: "Choose the files for the release.",
      ownerAgentId: owner.id,
      callbackKey: "release-files",
      callbackVersion: "1",
    });
    expect(task).toMatchObject({ taskNumber: 1, identifier: "SDK-1" });

    await expect(
      harness.ctx.tasks.update(
        task.id,
        { kind: "message", message: "Use the release manifest." },
        COMPANY_ID,
      ),
    ).resolves.toMatchObject({
      id: task.id,
      request: "Choose the files for the release.",
      lifecycleStatus: "open",
      ownerKind: "agent",
      ownerAgentId: owner.id,
      ownershipEpoch: 1,
      creatorKind: "plugin",
      creatorCallbackKey: "release-files",
      creatorCallbackVersion: "1",
    });

    const withdrawal = await harness.ctx.tasks.withdraw(
      task.id,
      "The release no longer needs this work.",
      COMPANY_ID,
    );
    expect(withdrawal).toMatchObject({
      task: { id: task.id, lifecycleStatus: "cancelled" },
      retried: false,
    });

    await expect(
      harness.ctx.tasks.update(
        task.id,
        { kind: "message", message: "Too late" },
        COMPANY_ID,
      ),
    ).rejects.toThrow("terminal");
  });
});
