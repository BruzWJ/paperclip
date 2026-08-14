import { conflict } from "../errors.js";
import { isInstanceAdminForDb } from "./authorization-core.js";
import { authorizationService } from "./authorization.js";
import type { AuthorizationActor, AuthorizationResource } from "./authorization.js";
import { requireUserRole } from "./company-member-roles.js";
import { companyMemberships, principalPermissionGrants } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { isCanonicalUuid } from "@paperclipai/shared";
import type { PermissionKey, PrincipalType, UserCompanyMembershipRole } from "@paperclipai/shared";
import { and, eq, sql } from "drizzle-orm";

export function createAccessContext(db: Db) {
  const authorization = authorizationService(db);

  return { db, authorization };
}

export type AccessContext = ReturnType<typeof createAccessContext>;

export type StoredMembershipRow = typeof companyMemberships.$inferSelect;

export type StoredGrantRow = typeof principalPermissionGrants.$inferSelect;

export type MembershipRowBase = Omit<
  StoredMembershipRow,
  "principalUserId" | "principalAgentId" | "principalType" | "membershipRole"
>;

export type MembershipRow = MembershipRowBase & {
  principalId: string;
} & (
    | { principalType: "user"; membershipRole: UserCompanyMembershipRole }
    | { principalType: "agent"; membershipRole: "member" }
  );

export type PrincipalGrantRow = Omit<StoredGrantRow, "principalUserId" | "principalAgentId"> & {
  principalId: string;
};

export type GrantInput = {
  permissionKey: PermissionKey;
  scope?: Record<string, unknown> | null;
};

export function principalColumns(principalType: PrincipalType, principalId: string) {
  return principalType === "user"
    ? { principalUserId: principalId, principalAgentId: null }
    : { principalUserId: null, principalAgentId: principalId };
}

export function membershipPrincipalCondition(principalType: PrincipalType, principalId: string) {
  return principalType === "user"
    ? eq(companyMemberships.principalUserId, principalId)
    : eq(companyMemberships.principalAgentId, principalId);
}

export function grantPrincipalCondition(principalType: PrincipalType, principalId: string) {
  return principalType === "user"
    ? eq(principalPermissionGrants.principalUserId, principalId)
    : eq(principalPermissionGrants.principalAgentId, principalId);
}

export function storedMembershipPrincipalId(row: StoredMembershipRow): string {
  const principalId = row.principalType === "user" ? row.principalUserId : row.principalAgentId;
  if (!principalId) {
    throw new Error(`Invalid ${row.principalType} company membership ${row.id}: missing typed principal id`);
  }
  return principalId;
}

export function mapMembership(row: StoredMembershipRow): MembershipRow {
  const { principalUserId: _principalUserId, principalAgentId: _principalAgentId, ...stored } = row;
  const principalId = storedMembershipPrincipalId(row);
  if (row.principalType === "user") {
    return {
      ...stored,
      principalType: "user",
      membershipRole: requireUserRole(row.membershipRole),
      principalId,
    };
  }
  if (row.membershipRole !== "member") {
    throw new Error(`Invalid agent company membership role: ${String(row.membershipRole)}`);
  }
  return {
    ...stored,
    principalType: "agent",
    membershipRole: "member",
    principalId,
  };
}

export function requirePrincipalMembershipRole(
  principalType: PrincipalType,
  membershipRole: UserCompanyMembershipRole | "member",
): UserCompanyMembershipRole | "member" {
  if (principalType === "user") return requireUserRole(membershipRole);
  if (membershipRole !== "member") {
    throw new Error(`Invalid agent company membership role: ${String(membershipRole)}`);
  }
  return membershipRole;
}

export function mapPrincipalGrant(row: StoredGrantRow): PrincipalGrantRow {
  const principalId = row.principalType === "user" ? row.principalUserId : row.principalAgentId;
  if (!principalId) {
    throw new Error(`Invalid ${row.principalType} permission grant ${row.id}: missing typed principal id`);
  }
  const { principalUserId: _principalUserId, principalAgentId: _principalAgentId, ...stored } = row;
  return { ...stored, principalId };
}

export function buildAccessAccessMembershipQueries(scope: AccessContext) {
  const { db, authorization } = scope;

  async function getMembership(
    companyId: string,
    principalType: PrincipalType,
    principalId: string,
  ): Promise<MembershipRow | null> {
    return db
      .select()
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, principalType),
          membershipPrincipalCondition(principalType, principalId),
        ),
      )
      .then((rows) => (rows[0] ? mapMembership(rows[0]) : null));
  }

  async function hasPermission(
    companyId: string,
    principalType: PrincipalType,
    principalId: string,
    permissionKey: PermissionKey,
  ): Promise<boolean> {
    return authorization
      .decidePrincipalGrant({
        companyId,
        principalType,
        principalId,
        permissionKey,
        action: permissionKey,
      })
      .then((decision) => decision.allowed);
  }

  async function canUser(
    companyId: string,
    userId: string | null | undefined,
    permissionKey: PermissionKey,
  ): Promise<boolean> {
    if (typeof userId !== "string" || userId.length === 0 || userId !== userId.trim()) {
      return false;
    }
    return authorization
      .decide({
        actor: { type: "board", userId },
        action: permissionKey,
        resource: { type: "company", companyId },
      })
      .then((decision) => decision.allowed);
  }

  async function decide(input: {
    actor: AuthorizationActor;
    action: Parameters<typeof authorization.decide>[0]["action"];
    resource: AuthorizationResource;
    scope?: Record<string, unknown> | null;
  }) {
    return authorization.decide(input);
  }

  async function listMembers(companyId: string) {
    const rows = await db
      .select()
      .from(companyMemberships)
      .where(eq(companyMemberships.companyId, companyId))
      .orderBy(sql`${companyMemberships.createdAt} desc`);
    return rows.map(mapMembership);
  }

  async function getMemberById(companyId: string, memberId: string) {
    if (!isCanonicalUuid(companyId) || !isCanonicalUuid(memberId)) return null;
    return db
      .select()
      .from(companyMemberships)
      .where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.id, memberId)))
      .then((rows) => (rows[0] ? mapMembership(rows[0]) : null));
  }

  async function listActiveUserMemberships(companyId: string) {
    const rows = await db
      .select()
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.status, "active"),
        ),
      )
      .orderBy(sql`${companyMemberships.createdAt} asc`);
    return rows
      .map(mapMembership)
      .filter(
        (membership): membership is Extract<MembershipRow, { principalType: "user" }> =>
          membership.principalType === "user",
      );
  }

  async function setMemberPermissions(
    companyId: string,
    memberId: string,
    grants: GrantInput[],
    grantedByUserId: string | null,
  ) {
    const member = await getMemberById(companyId, memberId);
    if (!member) return null;

    await db.transaction(async (tx) => {
      await tx
        .delete(principalPermissionGrants)
        .where(
          and(
            eq(principalPermissionGrants.companyId, companyId),
            eq(principalPermissionGrants.principalType, member.principalType),
            grantPrincipalCondition(member.principalType, member.principalId),
          ),
        );
      if (grants.length > 0) {
        await tx.insert(principalPermissionGrants).values(
          grants.map((grant) => ({
            companyId,
            principalType: member.principalType,
            ...principalColumns(member.principalType, member.principalId),
            permissionKey: grant.permissionKey,
            scope: grant.scope ?? null,
            grantedByUserId,
            createdAt: new Date(),
            updatedAt: new Date(),
          })),
        );
      }
    });

    return member;
  }

  async function updateMemberAndPermissions(
    companyId: string,
    memberId: string,
    data: {
      membershipRole?: UserCompanyMembershipRole;
      status?: "pending" | "active" | "suspended";
      grants: GrantInput[];
    },
    grantedByUserId: string | null,
  ) {
    return db.transaction(async (tx) => {
      await tx.execute(sql`
        select ${companyMemberships.id}
        from ${companyMemberships}
        where ${companyMemberships.companyId} = ${companyId}
          and ${companyMemberships.principalType} = 'user'
          and ${companyMemberships.status} = 'active'
          and ${companyMemberships.membershipRole} = 'owner'
        for update
      `);

      const existing = await tx
        .select()
        .from(companyMemberships)
        .where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.id, memberId)))
        .then((rows) => rows[0] ?? null);
      if (!existing) return null;
      if (existing.principalType !== "user") {
        throw conflict("Only user company members can be updated");
      }
      const existingPrincipalId = storedMembershipPrincipalId(existing);

      const nextMembershipRole =
        data.membershipRole !== undefined ? data.membershipRole : existing.membershipRole;
      const nextStatus = data.status ?? existing.status;

      if (
        existing.principalType === "user" &&
        existing.status === "active" &&
        existing.membershipRole === "owner" &&
        (nextStatus !== "active" || nextMembershipRole !== "owner")
      ) {
        const activeOwnerCount = await tx
          .select({ id: companyMemberships.id })
          .from(companyMemberships)
          .where(
            and(
              eq(companyMemberships.companyId, companyId),
              eq(companyMemberships.principalType, "user"),
              eq(companyMemberships.status, "active"),
              eq(companyMemberships.membershipRole, "owner"),
            ),
          )
          .then((rows) => rows.length);
        if (activeOwnerCount <= 1) {
          throw conflict("Cannot remove the last active owner");
        }
      }

      const now = new Date();
      const updated = await tx
        .update(companyMemberships)
        .set({
          membershipRole: nextMembershipRole,
          status: nextStatus,
          updatedAt: now,
        })
        .where(eq(companyMemberships.id, existing.id))
        .returning()
        .then((rows) => rows[0] ?? existing);

      await tx
        .delete(principalPermissionGrants)
        .where(
          and(
            eq(principalPermissionGrants.companyId, companyId),
            eq(principalPermissionGrants.principalType, existing.principalType),
            grantPrincipalCondition(existing.principalType, existingPrincipalId),
          ),
        );
      if (data.grants.length > 0) {
        await tx.insert(principalPermissionGrants).values(
          data.grants.map((grant) => ({
            companyId,
            principalType: existing.principalType,
            ...principalColumns(existing.principalType, existingPrincipalId),
            permissionKey: grant.permissionKey,
            scope: grant.scope ?? null,
            grantedByUserId,
            createdAt: now,
            updatedAt: now,
          })),
        );
      }

      return mapMembership(updated);
    });
  }

  async function assertCanRemoveActiveOwner(
    companyId: string,
    principalType: PrincipalType,
    status: string,
    membershipRole: string | null,
    tx: Pick<Db, "select">,
  ) {
    if (principalType !== "user" || status !== "active" || membershipRole !== "owner") {
      return;
    }

    const activeOwnerCount = await tx
      .select({ id: companyMemberships.id })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.status, "active"),
          eq(companyMemberships.membershipRole, "owner"),
        ),
      )
      .then((rows) => rows.length);
    if (activeOwnerCount <= 1) {
      throw conflict("Cannot remove the last active owner");
    }
  }

  return {
    isInstanceAdmin: (userId: string | null | undefined) => isInstanceAdminForDb(db, userId),
    getMembership,
    hasPermission,
    canUser,
    decide,
    listMembers,
    getMemberById,
    listActiveUserMemberships,
    setMemberPermissions,
    updateMemberAndPermissions,
    assertCanRemoveActiveOwner,
  };
}
