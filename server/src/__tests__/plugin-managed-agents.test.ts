import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  pluginEntities,
  pluginManagedResources,
} from "@paperclipai/db";
import {
  pluginManifestV1Schema,
  type PaperclipPluginManifestV1,
} from "@paperclipai/shared";
import {
  adoptPluginManagedAgentFromBoard,
  pausePluginManagedAgentsIntoTriageInTransaction,
  pluginManagedAgentService,
} from "../services/plugin-managed-agents.js";
import { createMockDb } from "./helpers/mock-db.js";

const mocks = vi.hoisted(() => ({
  getAgentById: vi.fn(),
  lockCompanyAgentGraph: vi.fn(),
  logActivity: vi.fn(),
}));

vi.mock("../services/agents.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/agents.js")>();
  return {
    ...actual,
    agentService: vi.fn(() => ({ getById: mocks.getAgentById })),
  };
});

vi.mock("../services/agent-org-graph-lock.js", () => ({
  lockCompanyAgentGraph: mocks.lockCompanyAgentGraph,
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mocks.logActivity,
}));

const now = new Date("2026-01-02T03:04:05.000Z");
const companyId = "00000000-0000-4000-8000-000000000001";
const pluginId = "00000000-0000-4000-8000-000000000002";
const agentId = "00000000-0000-4000-8000-000000000003";
const entityId = "00000000-0000-4000-8000-000000000004";
const bindingId = "00000000-0000-4000-8000-000000000005";
const pluginKey = "paperclip.managed-agents-test";

function manifest(): PaperclipPluginManifestV1 {
  return {
    id: pluginKey,
    apiVersion: 1,
    version: "0.1.0",
    displayName: "Managed Agents Test",
    description: "Test plugin",
    author: "Paperclip",
    categories: ["automation"],
    capabilities: ["agents.managed"],
    entrypoints: { worker: "./dist/worker.js" },
    agents: [{
      agentKey: "wiki-maintainer",
      displayName: "Wiki Maintainer",
      title: "Maintains plugin-owned knowledge",
      capabilities: "Maintains a plugin-owned wiki.",
    }],
  };
}

function binding(overrides: Record<string, unknown> = {}) {
  return {
    id: bindingId,
    companyId,
    pluginId,
    pluginKey,
    resourceKind: "agent",
    resourceKey: "wiki-maintainer",
    resourceId: agentId,
    defaultsJson: {},
    lifecycleState: "active",
    originalDeclarationRef: {
      pluginInstallationId: pluginId,
      pluginKey,
      resourceKind: "agent",
      resourceKey: "wiki-maintainer",
    },
    lifecycleReason: null,
    triagePausedAt: null,
    adoptedAt: null,
    terminatedAt: null,
    lifecycleActorType: null,
    lifecycleActorId: null,
    lifecycleAudit: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function entity(overrides: Record<string, unknown> = {}) {
  return {
    id: entityId,
    pluginId,
    companyId,
    entityType: "managed_agent",
    scopeKind: "company",
    scopeId: companyId,
    externalId: `managed:agent:${companyId}:wiki-maintainer`,
    title: "Wiki Maintainer",
    status: "active",
    data: {
      pluginKey,
      resourceKind: "agent",
      resourceKey: "wiki-maintainer",
      agentId,
    },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function agent(overrides: Record<string, unknown> = {}) {
  return {
    id: agentId,
    companyId,
    name: "Wiki Maintainer",
    title: "Maintains plugin-owned knowledge",
    status: "idle",
    pauseReason: null,
    pausedAt: null,
    adapterType: null,
    adapterConfig: null,
    currentAdapterConfigRevisionId: null,
    runtimeConfig: {},
    permissions: {},
    metadata: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function service(db: ReturnType<typeof createMockDb>["db"]) {
  return pluginManagedAgentService(db, {
    pluginId,
    pluginKey,
    manifest: manifest(),
  });
}

describe("plugin-managed agents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.logActivity.mockResolvedValue(undefined);
  });

  it("rejects managed-agent instruction declarations", () => {
    const pluginManifest = manifest();
    const parsed = pluginManifestV1Schema.safeParse({
      ...pluginManifest,
      agents: [{
        ...pluginManifest.agents![0]!,
        instructions: {
          entryFile: "AGENTS.md",
          content: "Paperclip-managed instructions are forbidden.",
        },
      }],
    });

    expect(parsed.success).toBe(false);
  });

  it("returns a canonical missing resolution only when both provenance rows are absent", async () => {
    const harness = createMockDb({ select: [[], []] });

    await expect(service(harness.db).get("wiki-maintainer", companyId))
      .resolves.toEqual({
        pluginKey,
        resourceKind: "agent",
        resourceKey: "wiki-maintainer",
        companyId,
        agentId: null,
        agent: null,
        status: "missing",
        approvalId: null,
      });
    expect(harness.remaining("select")).toBe(0);
    expect(mocks.getAgentById).not.toHaveBeenCalled();
  });

  it("resolves an active resource/entity pair to its live canonical agent", async () => {
    const canonicalAgent = agent();
    const harness = createMockDb({ select: [[binding()], [entity()]] });
    mocks.getAgentById.mockResolvedValue(canonicalAgent);

    await expect(service(harness.db).get("wiki-maintainer", companyId))
      .resolves.toMatchObject({
        status: "resolved",
        agentId,
        agent: canonicalAgent,
      });
    expect(mocks.getAgentById).toHaveBeenCalledWith(agentId);
    expect(harness.remaining("select")).toBe(0);
  });

  it("fails closed when an active binding has no live in-company agent", async () => {
    for (const unavailableAgent of [
      null,
      agent({ status: "terminated" }),
      agent({ companyId: "00000000-0000-4000-8000-000000000099" }),
    ]) {
      const harness = createMockDb({ select: [[binding()], [entity()]] });
      mocks.getAgentById.mockResolvedValueOnce(unavailableAgent);

      await expect(service(harness.db).get("wiki-maintainer", companyId))
        .rejects.toMatchObject({ status: 409 });
    }
  });

  it("fails closed when either half of the canonical provenance pair is absent or disagrees", async () => {
    const invalidPairs = [
      [[binding()], []],
      [[], [entity()]],
      [[binding()], [entity({ status: "adopted" })]],
      [[binding()], [entity({ data: { pluginKey, agentId: "other-agent" } })]],
    ] as const;

    for (const [bindings, entities] of invalidPairs) {
      const harness = createMockDb({ select: [bindings, entities] });

      await expect(service(harness.db).get("wiki-maintainer", companyId))
        .rejects.toMatchObject({ status: 409 });
      expect(mocks.getAgentById).not.toHaveBeenCalled();
    }
  });

  it("never reacquires a resource after its managed lifecycle leaves active", async () => {
    const harness = createMockDb({
      select: [[binding({ lifecycleState: "triage_paused" })]],
    });

    await expect(service(harness.db).reconcile("wiki-maintainer", companyId))
      .resolves.toMatchObject({
        status: "missing",
        agentId: null,
        agent: null,
      });
    expect(harness.calls.filter((call) => call.operation === "insert")).toEqual([]);
    expect(mocks.getAgentById).not.toHaveBeenCalled();
  });

  it("refreshes active provenance without overwriting ordinary agent configuration", async () => {
    const configuredAgent = agent({
      name: "Knowledge Lead",
      adapterConfig: { command: "custom" },
    });
    const harness = createMockDb({
      select: [
        [binding()],
        [binding()],
        [entity()],
        [binding()],
        [entity()],
      ],
      update: [[{ id: bindingId }], [entity()]],
    });
    mocks.getAgentById.mockResolvedValue(configuredAgent);

    await expect(service(harness.db).reset("wiki-maintainer", companyId))
      .resolves.toMatchObject({
        status: "resolved",
        agent: {
          name: "Knowledge Lead",
          adapterConfig: { command: "custom" },
        },
      });

    const updateTargets = harness.calls
      .filter((call) => call.operation === "update" && call.method === "update")
      .map((call) => call.args[0]);
    expect(updateTargets).toEqual([pluginManagedResources, pluginEntities]);
    expect(harness.remaining("select")).toBe(0);
    expect(harness.remaining("update")).toBe(0);
  });

  it("requires an exact authenticated board actor before triage persistence", async () => {
    const harness = createMockDb();

    await expect(pausePluginManagedAgentsIntoTriageInTransaction(
      harness.db as never,
      {
        pluginId,
        pluginKey,
        reason: "plugin_disabled",
        actorType: "user",
        actorId: null,
      },
      {} as never,
      now,
    )).rejects.toMatchObject({ status: 409 });
    expect(harness.calls).toEqual([]);
  });

  it("atomically pauses the agent, resource, and entity before requesting suspension", async () => {
    const suspensionResult = {
      companyId,
      agentIds: [agentId],
      reason: "plugin_disabled",
      fence: { refIds: [], deliveryIds: [], correlationIds: [] },
      requests: [],
    };
    const requestAgentSuspensionsInTransaction = vi.fn()
      .mockResolvedValue(suspensionResult);
    const harness = createMockDb({
      select: [[{ companyId }], [binding()], [entity()]],
      update: [[{ id: agentId }], [{ id: bindingId }], [{ id: entityId }]],
    });
    mocks.lockCompanyAgentGraph.mockResolvedValue({ agents: [agent()] });

    await expect(pausePluginManagedAgentsIntoTriageInTransaction(
      harness.db as never,
      {
        pluginId,
        pluginKey,
        reason: "plugin_disabled",
        actorType: "system",
        actorId: pluginId,
      },
      { requestAgentSuspensionsInTransaction } as never,
      now,
    )).resolves.toEqual({
      triagePausedAgentIds: [agentId],
      suspensionRequests: [suspensionResult],
    });

    expect(mocks.lockCompanyAgentGraph).toHaveBeenCalledWith(
      expect.anything(),
      companyId,
    );
    const persistedTransitions = harness.calls
      .filter((call) => call.operation === "update" && call.method === "set")
      .map((call) => call.args[0]);
    expect(persistedTransitions).toEqual([
      expect.objectContaining({ status: "paused", pauseReason: "system" }),
      expect.objectContaining({
        lifecycleState: "triage_paused",
        lifecycleReason: "plugin_disabled",
        lifecycleActorType: "system",
        lifecycleActorId: pluginId,
      }),
      expect.objectContaining({ status: "triage_paused" }),
    ]);
    expect(requestAgentSuspensionsInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ companyId, agentIds: [agentId] }),
    );
    expect(mocks.logActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId,
        actorType: "system",
        actorId: pluginId,
        action: "plugin.managed_agent.moved_to_board_triage",
        entityId: agentId,
      }),
    );
    expect(harness.remaining("select")).toBe(0);
    expect(harness.remaining("update")).toBe(0);
  });

  it("adopts only the locked triage pair and preserves the paused agent", async () => {
    const triageBinding = binding({
      lifecycleState: "triage_paused",
      lifecycleReason: "plugin_disabled",
      triagePausedAt: now,
    });
    const triageEntity = entity({ status: "triage_paused" });
    const adopted = binding({
      lifecycleState: "adopted",
      lifecycleReason: "board_adopted",
      lifecycleActorType: "user",
      lifecycleActorId: "board-user",
      adoptedAt: now,
    });
    const harness = createMockDb({
      select: [[triageBinding], [triageEntity]],
      update: [[adopted], [{ id: entityId }]],
    });
    mocks.lockCompanyAgentGraph.mockResolvedValue({
      agents: [agent({ status: "paused", pauseReason: "system" })],
    });

    await expect(adoptPluginManagedAgentFromBoard(harness.db, {
      companyId,
      agentId,
      actorUserId: "board-user",
    })).resolves.toEqual(adopted);

    const persistedTransitions = harness.calls
      .filter((call) => call.operation === "update" && call.method === "set")
      .map((call) => call.args[0]);
    expect(persistedTransitions).toEqual([
      expect.objectContaining({
        lifecycleState: "adopted",
        lifecycleReason: "board_adopted",
        lifecycleActorType: "user",
        lifecycleActorId: "board-user",
      }),
      expect.objectContaining({ status: "adopted" }),
    ]);
    expect(mocks.logActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId,
        actorType: "user",
        actorId: "board-user",
        action: "plugin.managed_agent.adopted",
        entityId: agentId,
      }),
    );
    expect(harness.remaining("select")).toBe(0);
    expect(harness.remaining("update")).toBe(0);
  });
});
