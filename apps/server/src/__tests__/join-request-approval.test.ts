import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockDb } from "./helpers/mock-db.js";
import { testBoardSessionActor } from "./helpers/request-actor.js";

const approvalMocks = vi.hoisted(() => ({
  ensureMembership: vi.fn(async () => undefined),
  setPrincipalGrants: vi.fn(async () => undefined),
  getEnvironmentById: vi.fn(),
  createRuntimeAgent: vi.fn(),
  createAdapterRevision: vi.fn(),
  logActivity: vi.fn(async () => undefined),
}));

vi.mock("../services/access.js", () => ({
  accessService: () => ({
    ensureMembership: approvalMocks.ensureMembership,
    setPrincipalGrants: approvalMocks.setPrincipalGrants,
  }),
}));

vi.mock("../services/environments.js", () => ({
  environmentService: () => ({ getById: approvalMocks.getEnvironmentById }),
}));

vi.mock("../services/runtime-agent-configuration.js", () => ({
  createRuntimeAgentConfigurationService: () => ({
    createInTransaction: approvalMocks.createRuntimeAgent,
  }),
}));

vi.mock("../services/agent-adapter-config-revisions.js", () => ({
  createAgentAdapterConfigurationService: () => ({
    createRevision: approvalMocks.createAdapterRevision,
  }),
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: approvalMocks.logActivity,
}));

import { createJoinRequestApprovalService } from "../services/join-request-approval.js";

function createApprovalService(db: ReturnType<typeof createMockDb>["db"]) {
  return createJoinRequestApprovalService(db, {
    resolveAdapterEnvironmentDrivers: async () => ["local"],
  });
}

function approvalFixture() {
  const companyId = randomUUID();
  const requestId = randomUUID();
  const inviteId = randomUUID();
  const environmentId = randomUUID();
  const alternateEnvironmentId = randomUUID();
  const createdAgentId = randomUUID();
  const revisionId = randomUUID();
  const now = new Date("2026-01-01T00:00:00.000Z");
  const joinRequest = {
    id: requestId,
    inviteId,
    companyId,
    requestType: "agent",
    status: "pending_approval",
    requestingUserId: null,
    agentName: "Requested agent",
    adapterType: "codex",
    capabilities: "Research primary sources",
    agentDefaultsPayload: { model: "gpt-5.6" },
    createdAgentId: null,
    approvedEnvironmentId: null,
    createdAgentAdapterConfigRevisionId: null,
    approvedByUserId: null,
    approvedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  const invite = {
    id: inviteId,
    companyId,
    defaultsPayload: { agent: { grants: [] } },
  };
  const environment = {
    id: environmentId,
    name: "Join environment",
    driver: "local",
    status: "active",
    config: {},
  };
  const approved = {
    ...joinRequest,
    status: "approved",
    createdAgentId,
    approvedEnvironmentId: environmentId,
    createdAgentAdapterConfigRevisionId: revisionId,
    approvedByUserId: "board-user",
    approvedAt: now,
    updatedAt: now,
  };
  const boardActor = {
    actorId: "board-user",
    userId: "board-user",
    authorization: testBoardSessionActor({
      userId: "board-user",
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "owner", status: "active" }],
      isInstanceAdmin: true,
    }),
  };
  return {
    companyId,
    requestId,
    environmentId,
    alternateEnvironmentId,
    createdAgentId,
    revisionId,
    joinRequest,
    invite,
    environment,
    approved,
    boardActor,
  };
}

describe("join request approval", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("requires an explicit environment before creating any agent state", async () => {
    const fixture = approvalFixture();
    const harness = createMockDb({
      select: [[fixture.joinRequest], [fixture.invite]],
    });
    const service = createApprovalService(harness.db);

    await expect(service.approve({
      companyId: fixture.companyId,
      requestId: fixture.requestId,
      actor: fixture.boardActor,
    })).rejects.toMatchObject({
      status: 422,
      details: { code: "agent_join_environment_required" },
    });

    expect(approvalMocks.createRuntimeAgent).not.toHaveBeenCalled();
    expect(approvalMocks.createAdapterRevision).not.toHaveBeenCalled();
    expect(approvalMocks.ensureMembership).not.toHaveBeenCalled();
    expect(harness.calls.some((call) => call.operation === "insert")).toBe(false);
    expect(harness.calls.some((call) => call.operation === "update")).toBe(false);
    expect(harness.remaining("select")).toBe(0);
  });

  it("atomically creates the ordinary agent and its first adapter revision", async () => {
    const fixture = approvalFixture();
    approvalMocks.getEnvironmentById.mockResolvedValue(fixture.environment);
    approvalMocks.createRuntimeAgent.mockResolvedValue({ agentId: fixture.createdAgentId });
    approvalMocks.createAdapterRevision.mockResolvedValue({
      revision: { id: fixture.revisionId },
    });
    const harness = createMockDb({
      select: [
        [fixture.joinRequest],
        [fixture.invite],
        [fixture.environment],
        [],
        [fixture.approved],
        [fixture.approved],
      ],
      update: [[fixture.approved]],
    });
    const service = createApprovalService(harness.db);

    const approved = await service.approve({
      companyId: fixture.companyId,
      requestId: fixture.requestId,
      actor: fixture.boardActor,
      defaultEnvironmentId: fixture.environmentId,
      skillChannel: "operator_native",
    });

    expect(approved).toMatchObject({
      id: fixture.requestId,
      status: "approved",
      createdAgentId: fixture.createdAgentId,
      approvedEnvironmentId: fixture.environmentId,
      createdAgentAdapterConfigRevisionId: fixture.revisionId,
      approvedByUserId: "board-user",
    });
    expect(approvalMocks.createRuntimeAgent).toHaveBeenCalledWith(expect.objectContaining({
      transaction: harness.db,
      companyId: fixture.companyId,
      idempotencyKey: `join-request:${fixture.requestId}:runtime-agent`,
      configuration: expect.objectContaining({
        name: "Requested agent",
        capabilities: "Research primary sources",
      }),
    }));
    expect(approvalMocks.createAdapterRevision).toHaveBeenCalledWith(expect.objectContaining({
      companyId: fixture.companyId,
      agentId: fixture.createdAgentId,
      configuration: expect.objectContaining({
        adapterType: "codex",
        adapterConfig: { model: "gpt-5.6" },
        defaultEnvironmentId: fixture.environmentId,
        skillChannel: "operator_native",
      }),
    }));
    expect(approvalMocks.ensureMembership).toHaveBeenCalledWith(
      fixture.companyId,
      "agent",
      fixture.createdAgentId,
      "member",
      "active",
    );
    expect(approvalMocks.logActivity).toHaveBeenCalledWith(harness.db, expect.objectContaining({
      companyId: fixture.companyId,
      action: "join.approved",
      entityId: fixture.requestId,
      details: expect.objectContaining({
        createdAgentId: fixture.createdAgentId,
        approvedEnvironmentId: fixture.environmentId,
        createdAgentAdapterConfigRevisionId: fixture.revisionId,
      }),
    }));

    await expect(service.approve({
      companyId: fixture.companyId,
      requestId: fixture.requestId,
      actor: fixture.boardActor,
      defaultEnvironmentId: fixture.environmentId,
      skillChannel: "operator_native",
    })).resolves.toMatchObject({ createdAgentId: fixture.createdAgentId });
    await expect(service.approve({
      companyId: fixture.companyId,
      requestId: fixture.requestId,
      actor: fixture.boardActor,
      defaultEnvironmentId: fixture.alternateEnvironmentId,
      skillChannel: "operator_native",
    })).rejects.toMatchObject({ status: 409 });

    expect(harness.remaining("select")).toBe(0);
    expect(harness.remaining("update")).toBe(0);
    expect((harness.db.transaction as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(3);
  });

  it("rejects an environment driver absent from the current ACPX adapter definition", async () => {
    const fixture = approvalFixture();
    approvalMocks.getEnvironmentById.mockResolvedValue(fixture.environment);
    const harness = createMockDb({
      select: [[fixture.joinRequest], [fixture.invite]],
    });
    const service = createJoinRequestApprovalService(harness.db, {
      // The request fixture targets a local environment, but ACPX currently
      // admits only a different transport for this exact adapter.
      resolveAdapterEnvironmentDrivers: async () => ["ssh"],
    });

    await expect(service.approve({
      companyId: fixture.companyId,
      requestId: fixture.requestId,
      actor: fixture.boardActor,
      defaultEnvironmentId: fixture.environmentId,
      skillChannel: "operator_native",
    })).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('Environment driver "local" is not allowed'),
    });

    expect(approvalMocks.createRuntimeAgent).not.toHaveBeenCalled();
    expect(approvalMocks.createAdapterRevision).not.toHaveBeenCalled();
  });
});
