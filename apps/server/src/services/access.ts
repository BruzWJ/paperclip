import { conflict } from "../errors.js";
import { buildAccessAccessMembershipAdministration } from "./access-membership-administration.js";
import {
  AccessContext,
  buildAccessAccessMembershipQueries,
  createAccessContext,
  grantPrincipalCondition,
  mapMembership,
  mapPrincipalGrant,
  principalColumns,
} from "./access-membership-mapping.js";
import { stampUserMemberRoleGrants } from "./user-member-grants.js";
import { companyMemberships, principalPermissionGrants } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import type { PermissionKey, PrincipalType, UserCompanyMembershipRole } from "@paperclipai/shared";
import { and, eq, sql } from "drizzle-orm";

export function buildAccessAccessPrincipalGrants(
  scope: AccessContext &
    ReturnType<typeof buildAccessAccessMembershipQueries> &
    ReturnType<typeof buildAccessAccessMembershipAdministration>,
) {
  const { db, ensureMembership } = scope;

  async function stampRoleGrants(
    companyId: string,
    principalId: string,
    membershipRole: UserCompanyMembershipRole,
    grantedByUserId: string | null,
  ) {
    return stampUserMemberRoleGrants(db, {
      companyId,
      principalId,
      membershipRole,
      grantedByUserId,
    });
  }

  async function listPrincipalGrants(companyId: string, principalType: PrincipalType, principalId: string) {
    const rows = await db
      .select()
      .from(principalPermissionGrants)
      .where(
        and(
          eq(principalPermissionGrants.companyId, companyId),
          eq(principalPermissionGrants.principalType, principalType),
          grantPrincipalCondition(principalType, principalId),
        ),
      )
      .orderBy(principalPermissionGrants.permissionKey);
    return rows.map(mapPrincipalGrant);
  }

  async function setPrincipalPermission(
    companyId: string,
    principalType: "agent",
    principalId: string,
    permissionKey: PermissionKey,
    enabled: boolean,
    grantedByUserId: string | null,
    scope: Record<string, unknown> | null = null,
  ) {
    if (!enabled) {
      await db
        .delete(principalPermissionGrants)
        .where(
          and(
            eq(principalPermissionGrants.companyId, companyId),
            eq(principalPermissionGrants.principalType, principalType),
            grantPrincipalCondition(principalType, principalId),
            eq(principalPermissionGrants.permissionKey, permissionKey),
          ),
        );
      return;
    }

    await ensureMembership(companyId, principalType, principalId, "member", "active");

    const existing = await db
      .select()
      .from(principalPermissionGrants)
      .where(
        and(
          eq(principalPermissionGrants.companyId, companyId),
          eq(principalPermissionGrants.principalType, principalType),
          grantPrincipalCondition(principalType, principalId),
          eq(principalPermissionGrants.permissionKey, permissionKey),
        ),
      )
      .then((rows) => rows[0] ?? null);

    if (existing) {
      await db
        .update(principalPermissionGrants)
        .set({
          scope,
          grantedByUserId,
          updatedAt: new Date(),
        })
        .where(eq(principalPermissionGrants.id, existing.id));
      return;
    }

    await db.insert(principalPermissionGrants).values({
      companyId,
      principalType,
      ...principalColumns(principalType, principalId),
      permissionKey,
      scope,
      grantedByUserId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  async function updateMember(
    companyId: string,
    memberId: string,
    data: {
      membershipRole?: UserCompanyMembershipRole;
      status?: "pending" | "active" | "suspended";
    },
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

      const updated = await tx
        .update(companyMemberships)
        .set({
          membershipRole: nextMembershipRole,
          status: nextStatus,
          updatedAt: new Date(),
        })
        .where(eq(companyMemberships.id, existing.id))
        .returning()
        .then((rows) => rows[0] ?? existing);
      return mapMembership(updated);
    });
  }

  return {
    stampRoleGrants,
    listPrincipalGrants,
    setPrincipalPermission,
    updateMember,
  };
}

export function createAccessMethods1(
  scope: AccessContext &
    ReturnType<typeof buildAccessAccessMembershipQueries> &
    ReturnType<typeof buildAccessAccessMembershipAdministration> &
    ReturnType<typeof buildAccessAccessPrincipalGrants>,
) {
  const {
    isInstanceAdmin,
    getMembership,
    hasPermission,
    canUser,
    decide,
    listMembers,
    getMemberById,
    listActiveUserMemberships,
    setMemberPermissions,
    updateMemberAndPermissions,
    archiveMember,
    promoteInstanceAdmin,
    demoteInstanceAdmin,
    listUserCompanyAccess,
    setUserCompanyAccess,
    ensureMembership,
    setPrincipalGrants,
    copyActiveUserMemberships,
    stampRoleGrants,
    listPrincipalGrants,
    setPrincipalPermission,
    updateMember,
  } = scope;

  return {
    isInstanceAdmin,

    decide,

    canUser,

    hasPermission,

    getMembership,

    getMemberById,

    ensureMembership,

    listMembers,

    listActiveUserMemberships,

    copyActiveUserMemberships,

    stampRoleGrants,

    archiveMember,

    setMemberPermissions,

    updateMemberAndPermissions,

    promoteInstanceAdmin,

    demoteInstanceAdmin,

    listUserCompanyAccess,

    setUserCompanyAccess,

    setPrincipalGrants,

    listPrincipalGrants,

    setPrincipalPermission,

    updateMember,
  };
}

export function accessService(db: Db) {
  const context = createAccessContext(db);
  const helpers1 = buildAccessAccessMembershipQueries(context);
  const helpers2 = buildAccessAccessMembershipAdministration({
    ...context,
    ...helpers1,
  });
  const helpers3 = buildAccessAccessPrincipalGrants({
    ...{ ...context, ...helpers1 },
    ...helpers2,
  });
  const scope = {
    ...{ ...{ ...context, ...helpers1 }, ...helpers2 },
    ...helpers3,
  };
  const methods1 = createAccessMethods1(scope);
  return { ...methods1 };
}
