import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { accessService } from "../services/access.js";
import { createMockDb } from "./helpers/mock-db.js";

const mocks = vi.hoisted(() => ({
  decide: vi.fn(),
  decidePrincipalGrant: vi.fn(),
  stampUserMemberRoleGrants: vi.fn(),
}));

vi.mock("../services/authorization.js", () => ({
  authorizationService: vi.fn(() => ({
    decide: mocks.decide,
    decidePrincipalGrant: mocks.decidePrincipalGrant,
  })),
}));

vi.mock("../services/user-member-grants.js", () => ({
  stampUserMemberRoleGrants: mocks.stampUserMemberRoleGrants,
}));

function membershipRow(input: {
  companyId: string;
  userId: string;
  role: "owner" | "admin" | "operator" | "viewer";
  status?: "pending" | "active" | "suspended" | "archived";
  id?: string;
}) {
  const now = new Date("2026-03-11T00:00:00.000Z");
  return {
    id: input.id ?? randomUUID(),
    companyId: input.companyId,
    principalType: "user" as const,
    principalUserId: input.userId,
    principalAgentId: null,
    membershipRole: input.role,
    status: input.status ?? "active",
    createdAt: now,
    updatedAt: now,
  };
}

describe("access service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.decide.mockResolvedValue({ allowed: false });
    mocks.decidePrincipalGrant.mockResolvedValue({ allowed: false });
    mocks.stampUserMemberRoleGrants.mockResolvedValue(undefined);
  });

  it("rejects combined access updates that would demote the last active owner", async () => {
    const companyId = randomUUID();
    const owner = membershipRow({ companyId, userId: "owner-user", role: "owner" });
    const { db, calls } = createMockDb({
      execute: [[]],
      select: [[owner], [{ id: owner.id }]],
    });

    await expect(
      accessService(db).updateMemberAndPermissions(
        companyId,
        owner.id,
        { membershipRole: "admin", grants: [] },
        "admin-user",
      ),
    ).rejects.toThrow("Cannot remove the last active owner");

    expect(calls.some((call) => call.method === "update")).toBe(false);
    expect(calls.some((call) => call.method === "delete")).toBe(false);
  });

  it("rejects role-only updates that would suspend the last active owner", async () => {
    const companyId = randomUUID();
    const owner = membershipRow({ companyId, userId: "owner-user", role: "owner" });
    const { db, calls } = createMockDb({
      execute: [[]],
      select: [[owner], [{ id: owner.id }]],
    });

    await expect(
      accessService(db).updateMember(companyId, owner.id, { status: "suspended" }),
    ).rejects.toThrow("Cannot remove the last active owner");

    expect(calls.some((call) => call.method === "update")).toBe(false);
  });

  it("archives members and clears grants without task reassignment aliases", async () => {
    const companyId = randomUUID();
    const member = membershipRow({
      companyId,
      userId: "member-user",
      role: "operator",
    });
    const archived = { ...member, status: "archived" as const };
    const { db, calls } = createMockDb({
      execute: [[]],
      select: [[member]],
      delete: [[]],
      update: [[archived]],
    });

    await expect(accessService(db).archiveMember(companyId, member.id)).resolves.toMatchObject({
      member: { id: member.id, principalId: member.principalUserId, status: "archived" },
    });

    expect(calls.filter((call) => call.method === "delete")).toHaveLength(1);
    expect(calls.find((call) => call.method === "set")?.args[0]).toMatchObject({
      status: "archived",
    });
  });

  it("rejects instance-level company access removal for self and protected users", async () => {
    const companyId = randomUUID();
    const owner = membershipRow({ companyId, userId: "owner-user", role: "owner" });
    const selfHarness = createMockDb({ select: [[owner]] });
    await expect(
      accessService(selfHarness.db).setUserCompanyAccess(owner.principalUserId, [], {
        actorUserId: owner.principalUserId,
      }),
    ).rejects.toThrow("You cannot remove yourself");

    const admin = membershipRow({ companyId, userId: "admin-user", role: "admin" });
    const adminHarness = createMockDb({ select: [[admin], []] });
    await expect(
      accessService(adminHarness.db).setUserCompanyAccess(admin.principalUserId, [], {
        actorUserId: owner.principalUserId,
      }),
    ).rejects.toThrow("Owners and admins cannot be removed from company access");

    const operator = membershipRow({ companyId, userId: "operator-user", role: "operator" });
    const instanceAdminHarness = createMockDb({
      select: [[operator], [{ id: randomUUID() }]],
    });
    await expect(
      accessService(instanceAdminHarness.db).setUserCompanyAccess(
        operator.principalUserId,
        [],
        { actorUserId: owner.principalUserId },
      ),
    ).rejects.toThrow("Instance admins cannot be removed from company access");
  });

  it("copies active user memberships with role-default grants for safe company imports", async () => {
    const sourceCompanyId = randomUUID();
    const targetCompanyId = randomUUID();
    const sourceOwner = membershipRow({
      companyId: sourceCompanyId,
      userId: "source-owner",
      role: "owner",
    });
    const sourceAdmin = membershipRow({
      companyId: sourceCompanyId,
      userId: "source-admin",
      role: "admin",
    });
    const targetOwner = { ...sourceOwner, id: randomUUID(), companyId: targetCompanyId };
    const targetAdmin = { ...sourceAdmin, id: randomUUID(), companyId: targetCompanyId };
    const { db, calls } = createMockDb({
      select: [[sourceOwner, sourceAdmin], [], []],
      insert: [[targetOwner], [targetAdmin]],
    });

    await expect(
      accessService(db).copyActiveUserMemberships(sourceCompanyId, targetCompanyId),
    ).resolves.toEqual([
      expect.objectContaining({ principalId: sourceOwner.principalUserId, membershipRole: "owner" }),
      expect.objectContaining({ principalId: sourceAdmin.principalUserId, membershipRole: "admin" }),
    ]);

    const insertedValues = calls
      .filter((call) => call.method === "values")
      .map((call) => call.args[0]);
    expect(insertedValues).toEqual([
      expect.objectContaining({
        companyId: targetCompanyId,
        principalUserId: sourceOwner.principalUserId,
        membershipRole: "owner",
      }),
      expect.objectContaining({
        companyId: targetCompanyId,
        principalUserId: sourceAdmin.principalUserId,
        membershipRole: "admin",
      }),
    ]);
    expect(mocks.stampUserMemberRoleGrants).toHaveBeenNthCalledWith(1, db, {
      companyId: targetCompanyId,
      principalId: sourceOwner.principalUserId,
      membershipRole: "owner",
      grantedByUserId: null,
    });
    expect(mocks.stampUserMemberRoleGrants).toHaveBeenNthCalledWith(2, db, {
      companyId: targetCompanyId,
      principalId: sourceAdmin.principalUserId,
      membershipRole: "admin",
      grantedByUserId: null,
    });
  });

  it("rejects user member aliases and non-member agent roles before persistence", async () => {
    const { db, calls } = createMockDb();
    const ensureMembership = accessService(db).ensureMembership as (
      companyId: string,
      principalType: "user" | "agent",
      principalId: string,
      membershipRole: "owner" | "member",
    ) => Promise<unknown>;

    await expect(
      ensureMembership(randomUUID(), "user", "user-1", "member"),
    ).rejects.toThrow("Invalid user company membership role");
    await expect(
      ensureMembership(randomUUID(), "agent", randomUUID(), "owner"),
    ).rejects.toThrow("Invalid agent company membership role");
    expect(calls).toEqual([]);
  });
});
