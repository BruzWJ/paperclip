import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockDb } from "./helpers/mock-db.js";
import { testBoardSessionActor } from "./helpers/request-actor.js";

const approvalMocks = vi.hoisted(() => ({
  ensureMembership: vi.fn(async () => undefined),
  setPrincipalGrants: vi.fn(async () => undefined),
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
  return createJoinRequestApprovalService(db);
}

function approvalFixture() {
  const companyId = randomUUID();
  const requestId = randomUUID();
  const inviteId = randomUUID();
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
  const approved = {
    ...joinRequest,
    status: "approved",
    createdAgentId,
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
    createdAgentId,
    revisionId,
    joinRequest,
    invite,
    approved,
    boardActor,
  };
}

describe("join request approval", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("atomically creates the ordinary agent and its first adapter revision", async () => {
    const fixture = approvalFixture();
    approvalMocks.createRuntimeAgent.mockResolvedValue({ agentId: fixture.createdAgentId });
    approvalMocks.createAdapterRevision.mockResolvedValue({
      revision: { id: fixture.revisionId },
    });
    const harness = createMockDb({
      select: [
        [fixture.joinRequest],
        [fixture.invite],
        [],
        [fixture.approved],
      ],
      update: [[fixture.approved]],
    });
    const service = createApprovalService(harness.db);

    const approved = await service.approve({
      companyId: fixture.companyId,
      requestId: fixture.requestId,
      actor: fixture.boardActor,
    });

    expect(approved).toMatchObject({
      id: fixture.requestId,
      status: "approved",
      createdAgentId: fixture.createdAgentId,
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
        createdAgentAdapterConfigRevisionId: fixture.revisionId,
      }),
    }));

    await expect(service.approve({
      companyId: fixture.companyId,
      requestId: fixture.requestId,
      actor: fixture.boardActor,
    })).resolves.toMatchObject({ createdAgentId: fixture.createdAgentId });

    expect(harness.remaining("select")).toBe(0);
    expect(harness.remaining("update")).toBe(0);
    expect((harness.db.transaction as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(2);
  });
});
