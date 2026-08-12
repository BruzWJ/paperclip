import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockDb } from "./helpers/mock-db.js";
import { testBoardSessionActor } from "./helpers/request-actor.js";

const approvalMocks = vi.hoisted(() => ({
  ensureMembership: vi.fn(async () => undefined),
  setPrincipalGrants: vi.fn(async () => undefined),
  persistedActivity: { row: { id: "activity-1" }, taskId: null },
  persistActivityLog: vi.fn(),
  publishCommittedActivity: vi.fn(),
}));

vi.mock("../services/access.js", () => ({
  accessService: () => ({
    ensureMembership: approvalMocks.ensureMembership,
    setPrincipalGrants: approvalMocks.setPrincipalGrants,
  }),
}));

vi.mock("../services/activity-log.js", () => ({
  persistActivityLog: approvalMocks.persistActivityLog,
  publishCommittedActivity: approvalMocks.publishCommittedActivity,
}));

import { createJoinRequestApprovalService } from "../services/join-request-approval.js";

describe("join request approval", () => {
  afterEach(() => vi.clearAllMocks());

  it("atomically activates the invited user membership and grants", async () => {
    const companyId = randomUUID();
    const requestId = randomUUID();
    const inviteId = randomUUID();
    const now = new Date("2026-01-01T00:00:00.000Z");
    const joinRequest = {
      id: requestId,
      inviteId,
      companyId,
      status: "pending_approval",
      requestIp: "127.0.0.1",
      requestingUserId: "invited-user",
      requestEmailSnapshot: "user@example.com",
      approvedByUserId: null,
      approvedAt: null,
      rejectedByUserId: null,
      rejectedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    const invite = {
      id: inviteId,
      companyId,
      defaultsPayload: { user: { role: "viewer", grants: [] } },
    };
    const approved = {
      ...joinRequest,
      status: "approved",
      approvedByUserId: "board-user",
      approvedAt: now,
    };
    const harness = createMockDb({
      select: [[joinRequest], [invite], [approved]],
      update: [[approved]],
    });
    approvalMocks.persistActivityLog.mockResolvedValue(
      approvalMocks.persistedActivity,
    );
    const service = createJoinRequestApprovalService(harness.db);
    const actor = {
      actorId: "board-user",
      userId: "board-user",
      authorization: testBoardSessionActor({
        userId: "board-user",
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }],
        isInstanceAdmin: true,
      }),
    };

    await expect(
      service.approve({ companyId, requestId, actor }),
    ).resolves.toMatchObject({ id: requestId, status: "approved" });
    expect(approvalMocks.ensureMembership).toHaveBeenCalledWith(
      companyId,
      "user",
      "invited-user",
      "viewer",
      "active",
    );
    expect(approvalMocks.setPrincipalGrants).toHaveBeenCalledWith(
      companyId,
      "user",
      "invited-user",
      [],
      "board-user",
    );
    expect(approvalMocks.persistActivityLog).toHaveBeenCalledWith(
      harness.db,
      expect.objectContaining({
        companyId,
        action: "join.approved",
        entityId: requestId,
        details: null,
      }),
    );
    expect(approvalMocks.publishCommittedActivity).toHaveBeenCalledWith(
      approvalMocks.persistedActivity,
    );

    await expect(
      service.approve({ companyId, requestId, actor }),
    ).resolves.toMatchObject({ status: "approved" });
    expect(harness.remaining("select")).toBe(0);
    expect(harness.remaining("update")).toBe(0);
  });
});
