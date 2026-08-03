import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { buildHostServices } from "../services/plugin-host-services.js";
import { createMockDb } from "./helpers/mock-db.js";

const mocks = vi.hoisted(() => ({
  assertPluginAvailable: vi.fn(),
  agentGetById: vi.fn(),
  authorizationDecide: vi.fn(),
  logActivity: vi.fn(),
}));

vi.mock("../services/plugin-issue-authorization.js", async () => ({
  ...await vi.importActual<typeof import("../services/plugin-issue-authorization.js")>("../services/plugin-issue-authorization.js"),
  assertPluginInstallationAvailableForCompany: mocks.assertPluginAvailable,
}));

vi.mock("../services/agents.js", async () => ({
  ...await vi.importActual<typeof import("../services/agents.js")>("../services/agents.js"),
  agentService: () => ({ getById: mocks.agentGetById }),
}));

vi.mock("../services/authorization.js", async () => ({
  ...await vi.importActual<typeof import("../services/authorization.js")>("../services/authorization.js"),
  authorizationService: () => ({ decide: mocks.authorizationDecide }),
}));

vi.mock("../services/activity-log.js", async () => ({
  ...await vi.importActual<typeof import("../services/activity-log.js")>("../services/activity-log.js"),
  logActivity: mocks.logActivity,
}));

const pluginId = "00000000-0000-4000-8000-000000000100";
const pluginKey = "permissions-extension";
const companyId = "00000000-0000-4000-8000-000000000001";
const actorAgentId = "00000000-0000-4000-8000-000000000010";
const targetAgentId = "00000000-0000-4000-8000-000000000011";
const createdAt = new Date("2026-01-02T00:00:00.000Z");

function createEventBusStub() {
  return {
    forPlugin() {
      return { emit: vi.fn(), subscribe: vi.fn(), clear: vi.fn() };
    },
  } as never;
}

function services(db: Db) {
  return buildHostServices(db, pluginId, pluginKey, createEventBusStub(), undefined, {
    ordinaryIssues: {} as never,
    pluginIssueControlPlane: {} as never,
    issueExecutionCancellation: {} as never,
  });
}

describe("plugin access and authorization host services", () => {
  beforeEach(() => {
    mocks.assertPluginAvailable.mockReset().mockResolvedValue(undefined);
    mocks.agentGetById.mockReset();
    mocks.authorizationDecide.mockReset();
    mocks.logActivity.mockReset().mockResolvedValue(undefined);
  });

  it("rejects grant writes for agents outside the requested company", async () => {
    const harness = createMockDb();
    mocks.agentGetById.mockResolvedValue({
      id: actorAgentId,
      companyId: "00000000-0000-4000-8000-000000000099",
    });
    const host = services(harness.db);

    await expect(host.authorization.setGrants({
      companyId,
      principalType: "agent",
      principalId: actorAgentId,
      grants: [{ permissionKey: "agents:configure" }],
    })).rejects.toThrow("Agent not found");

    expect(harness.calls).toEqual([]);
    expect(mocks.logActivity).not.toHaveBeenCalled();
    host.dispose();
  });

  it("redacts invite hashes, tokens, and sensitive defaults at the plugin boundary", async () => {
    const invite = {
      id: "00000000-0000-4000-8000-000000000020",
      companyId,
      inviteType: "company_join",
      tokenHash: "sha256-secret-token-hash",
      allowedJoinTypes: "human",
      defaultsPayload: {
        human: { role: "operator", apiKey: "secret-value" },
        secret: "top-secret",
      },
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      source: "plugin_host",
      invitedByUserId: null,
      revokedAt: null,
      acceptedAt: null,
      createdAt,
      updatedAt: createdAt,
    };
    const harness = createMockDb({ insert: [[invite]], select: [[invite]] });
    const host = services(harness.db);

    const created = await host.access.createInvite({
      companyId,
      allowedJoinTypes: "human",
      defaultsPayload: invite.defaultsPayload,
    });
    const listed = await host.access.listInvites({ companyId });

    expect(created.token).toMatch(/^pcp_invite_/);
    expect(created).not.toHaveProperty("tokenHash");
    expect(created.defaultsPayload).toMatchObject({
      human: { role: "operator", apiKey: "***REDACTED***" },
      secret: "***REDACTED***",
    });
    expect(listed.invites).toHaveLength(1);
    expect(listed.invites[0]).not.toHaveProperty("token");
    expect(listed.invites[0]).not.toHaveProperty("tokenHash");
    expect(mocks.logActivity).toHaveBeenCalledWith(harness.db, expect.objectContaining({
      action: "invite.created_by_plugin",
      entityType: "invite",
      entityId: invite.id,
    }));
    host.dispose();
  });

  it("returns bounded, redacted authorization audit results for each decision filter", async () => {
    const allowRow = {
      id: "00000000-0000-4000-8000-000000000030",
      companyId,
      actorType: "agent",
      actorId: actorAgentId,
      agentId: actorAgentId,
      runId: null,
      action: "authorization.assignment_preview",
      entityType: "issue",
      entityId: "issue-1",
      details: { decision: "allow", secret: "do-not-leak" },
      createdAt,
    };
    const denyRow = {
      ...allowRow,
      id: "00000000-0000-4000-8000-000000000031",
      entityId: "issue-2",
      details: { reason: "deny_scope", authorization: "Bearer should-not-leak" },
    };
    const harness = createMockDb({ select: [[allowRow], [denyRow]] });
    const host = services(harness.db);

    const allowed = await host.authorization.searchAudit({
      companyId,
      action: "authorization.assignment_preview",
      decision: "allow",
      limit: 1,
    });
    const denied = await host.authorization.searchAudit({
      companyId,
      action: "authorization.assignment_preview",
      decision: "deny",
    });

    expect(allowed).toHaveLength(1);
    expect(allowed[0]).toMatchObject({ entityId: "issue-1", details: { decision: "allow", secret: "***REDACTED***" } });
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({ entityId: "issue-2", details: { authorization: "***REDACTED***" } });
    host.dispose();
  });

  it("resolves persisted subjects before previewing or explaining target-agent authority", async () => {
    const unknownUserId = "unknown-user";
    const persistedAdminId = "persisted-admin";
    mocks.agentGetById.mockResolvedValue({ id: actorAgentId, companyId });
    mocks.authorizationDecide.mockImplementation(async (input: { actor: { type: string; userId?: string } }) => {
      if (input.actor.type === "none") {
        return { allowed: false, reason: "deny_unauthenticated", action: "agent_config:update", explanation: "Unauthenticated" };
      }
      if (input.actor.type === "board" && input.actor.userId === persistedAdminId) {
        return { allowed: true, reason: "allow_instance_admin", action: "agent_config:update", explanation: "Instance admin" };
      }
      return { allowed: false, reason: "deny_no_grant", action: "agent_config:update", explanation: "No grant" };
    });
    const harness = createMockDb({ select: [[], [{ id: persistedAdminId }]] });
    const host = services(harness.db);
    const agentInput = {
      companyId,
      subject: { type: "agent" as const, agentId: actorAgentId },
      targetAgentId,
    };

    const preview = await host.authorization.previewAssignment(agentInput);
    const explanation = await host.authorization.explainAssignment(agentInput);
    const injectedBoardPreview = await host.authorization.previewAssignment({
      companyId,
      subject: { type: "user", userId: unknownUserId },
      targetAgentId,
    });
    const persistedAdminPreview = await host.authorization.previewAssignment({
      companyId,
      subject: { type: "user", userId: persistedAdminId },
      targetAgentId,
    });

    expect(preview).toMatchObject({ allowed: false, reason: "deny_no_grant" });
    expect(explanation).toMatchObject(preview);
    expect(injectedBoardPreview).toMatchObject({ allowed: false, reason: "deny_unauthenticated" });
    expect(persistedAdminPreview).toMatchObject({ allowed: true, reason: "allow_instance_admin" });
    expect(mocks.authorizationDecide).toHaveBeenCalledWith(expect.objectContaining({
      actor: { type: "agent", agentId: actorAgentId, companyId, source: "internal" },
      resource: { type: "agent", companyId, agentId: targetAgentId },
    }));
    host.dispose();
  });

  it("rejects plugin attempts to overwrite board-owned agent governance before any write", async () => {
    const harness = createMockDb();
    const host = services(harness.db);

    await expect(host.authorization.updatePolicy({
      companyId,
      resourceType: "agent",
      resourceId: targetAgentId,
      policy: {
        reviewLabel: "protected",
        apiKey: "sk-test-secret",
        nested: { authorization: "Bearer should-not-persist", safeLabel: "kept" },
      },
    })).rejects.toThrow("Plugins cannot overwrite board-owned agent governance or grants.");

    expect(harness.calls).toEqual([]);
    expect(mocks.logActivity).not.toHaveBeenCalled();
    host.dispose();
  });
});
