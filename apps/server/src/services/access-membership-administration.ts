import { conflict } from "../errors.js";
import {
  AccessContext,
  GrantInput,
  MembershipRow,
  buildAccessAccessMembershipQueries,
  grantPrincipalCondition,
  mapMembership,
  principalColumns,
  requirePrincipalMembershipRole,
  storedMembershipPrincipalId,
} from "./access-membership-mapping.js";
import * as membershipModule from "./access-membership-mapping.js";
import { requireUserRole } from "./company-member-roles.js";
import { stampUserMemberRoleGrants } from "./user-member-grants.js";
import { companyMemberships, instanceUserRoles, principalPermissionGrants } from "@paperclipai/db";
import { isCanonicalUuid } from "@paperclipai/shared";
import type { PrincipalType, UserCompanyMembershipRole } from "@paperclipai/shared";
import { and, eq, inArray, sql } from "drizzle-orm";

export function buildAccessAccessMembershipAdministration(
  scope: membershipModule.AccessContext & ReturnType<typeof buildAccessAccessMembershipQueries>,
) {
  const { db, isInstanceAdmin, getMembership, listActiveUserMemberships, assertCanRemoveActiveOwner } = scope;

  async function archiveMember(companyId: string, memberId: string) {
    if (!isCanonicalUuid(companyId) || !isCanonicalUuid(memberId)) return null;
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
        throw conflict("Only user company members can be archived");
      }
      if (existing.status === "archived") {
        return { member: membershipModule.mapMembership(existing) };
      }

      await assertCanRemoveActiveOwner(
        companyId,
        existing.principalType,
        existing.status,
        existing.membershipRole,
        tx,
      );
      const now = new Date();
      await tx
        .delete(principalPermissionGrants)
        .where(
          and(
            eq(principalPermissionGrants.companyId, companyId),
            eq(principalPermissionGrants.principalType, existing.principalType),
            membershipModule.grantPrincipalCondition(
              existing.principalType,
              membershipModule.storedMembershipPrincipalId(existing),
            ),
          ),
        );

      const archived = await tx
        .update(companyMemberships)
        .set({
          status: "archived",
          updatedAt: now,
        })
        .where(eq(companyMemberships.id, existing.id))
        .returning()
        .then((rows) => rows[0] ?? existing);

      return { member: membershipModule.mapMembership(archived) };
    });
  }

  async function promoteInstanceAdmin(userId: string) {
    const existing = await db
      .select()
      .from(instanceUserRoles)
      .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
      .then((rows) => rows[0] ?? null);
    if (existing) return existing;
    return db
      .insert(instanceUserRoles)
      .values({
        userId,
        role: "instance_admin",
      })
      .returning()
      .then((rows) => rows[0]);
  }

  async function demoteInstanceAdmin(userId: string) {
    return db
      .delete(instanceUserRoles)
      .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  async function listUserCompanyAccess(userId: string) {
    const rows = await db
      .select()
      .from(companyMemberships)
      .where(
        and(eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalUserId, userId)),
      )
      .orderBy(sql`${companyMemberships.createdAt} desc`);
    return rows.map(membershipModule.mapMembership);
  }

  async function setUserCompanyAccess(
    userId: string,
    companyIds: string[],
    options: { actorUserId?: string | null } = {},
  ) {
    const existing = await listUserCompanyAccess(userId);
    const existingByCompany = new Map(existing.map((row) => [row.companyId, row]));
    const target = new Set(companyIds);

    await db.transaction(async (tx) => {
      const toArchive = existing.filter((row) => !target.has(row.companyId) && row.status !== "archived");
      if (toArchive.length > 0 && options.actorUserId && options.actorUserId === userId) {
        throw conflict("You cannot remove yourself");
      }
      if (toArchive.length > 0 && (await isInstanceAdmin(userId))) {
        throw conflict("Instance admins cannot be removed from company access");
      }
      const protectedArchives = toArchive.filter(
        (row) => row.membershipRole === "owner" || row.membershipRole === "admin",
      );
      if (protectedArchives.length > 0) {
        throw conflict("Owners and admins cannot be removed from company access");
      }
      const activeOwnerArchives = toArchive.filter(
        (row) => row.status === "active" && row.membershipRole === "owner",
      );
      if (activeOwnerArchives.length > 0) {
        const activeOwnerRows = await tx
          .select({
            companyId: companyMemberships.companyId,
            id: companyMemberships.id,
          })
          .from(companyMemberships)
          .where(
            and(
              eq(companyMemberships.principalType, "user"),
              eq(companyMemberships.status, "active"),
              eq(companyMemberships.membershipRole, "owner"),
              inArray(
                companyMemberships.companyId,
                activeOwnerArchives.map((row) => row.companyId),
              ),
            ),
          );
        for (const row of activeOwnerArchives) {
          const remainingOwners =
            activeOwnerRows.filter((owner) => owner.companyId === row.companyId).length - 1;
          if (remainingOwners <= 0) {
            throw conflict("Cannot remove the last active owner");
          }
        }
      }
      if (toArchive.length > 0) {
        await tx
          .update(companyMemberships)
          .set({ status: "archived", updatedAt: new Date() })
          .where(
            inArray(
              companyMemberships.id,
              toArchive.map((row) => row.id),
            ),
          );
        await tx.delete(principalPermissionGrants).where(
          and(
            eq(principalPermissionGrants.principalType, "user"),
            eq(principalPermissionGrants.principalUserId, userId),
            inArray(
              principalPermissionGrants.companyId,
              toArchive.map((row) => row.companyId),
            ),
          ),
        );
      }

      for (const companyId of target) {
        const existingMembership = existingByCompany.get(companyId);
        if (existingMembership) {
          if (existingMembership.status !== "active") {
            await tx
              .update(companyMemberships)
              .set({
                status: "active",
                membershipRole: requireUserRole(existingMembership.membershipRole),
                updatedAt: new Date(),
              })
              .where(eq(companyMemberships.id, existingMembership.id));
          }
          continue;
        }
        await tx.insert(companyMemberships).values({
          companyId,
          principalType: "user",
          principalUserId: userId,
          principalAgentId: null,
          status: "active",
          membershipRole: "operator",
        });
      }
    });

    return listUserCompanyAccess(userId);
  }

  function ensureMembership(
    companyId: string,
    principalType: "user",
    principalId: string,
    membershipRole: UserCompanyMembershipRole,
    status?: "pending" | "active" | "suspended",
  ): Promise<membershipModule.MembershipRow | undefined>;

  function ensureMembership(
    companyId: string,
    principalType: "agent",
    principalId: string,
    membershipRole: "member",
    status?: "pending" | "active" | "suspended",
  ): Promise<membershipModule.MembershipRow | undefined>;

  async function ensureMembership(
    companyId: string,
    principalType: PrincipalType,
    principalId: string,
    membershipRole: UserCompanyMembershipRole | "member",
    status: "pending" | "active" | "suspended" = "active",
  ) {
    const canonicalMembershipRole = membershipModule.requirePrincipalMembershipRole(
      principalType,
      membershipRole,
    );
    const existing = await getMembership(companyId, principalType, principalId);
    if (existing) {
      if (existing.status !== status || existing.membershipRole !== canonicalMembershipRole) {
        const updated = await db
          .update(companyMemberships)
          .set({
            status,
            membershipRole: canonicalMembershipRole,
            updatedAt: new Date(),
          })
          .where(eq(companyMemberships.id, existing.id))
          .returning()
          .then((rows) => rows[0] ?? null);
        return updated ? membershipModule.mapMembership(updated) : existing;
      }
      return existing;
    }

    return db
      .insert(companyMemberships)
      .values({
        companyId,
        principalType,
        ...membershipModule.principalColumns(principalType, principalId),
        status,
        membershipRole: canonicalMembershipRole,
      })
      .returning()
      .then((rows) => (rows[0] ? membershipModule.mapMembership(rows[0]) : undefined));
  }

  async function setPrincipalGrants(
    companyId: string,
    principalType: PrincipalType,
    principalId: string,
    grants: membershipModule.GrantInput[],
    grantedByUserId: string | null,
  ) {
    await db.transaction(async (tx) => {
      await tx
        .delete(principalPermissionGrants)
        .where(
          and(
            eq(principalPermissionGrants.companyId, companyId),
            eq(principalPermissionGrants.principalType, principalType),
            membershipModule.grantPrincipalCondition(principalType, principalId),
          ),
        );
      if (grants.length === 0) return;
      await tx.insert(principalPermissionGrants).values(
        grants.map((grant) => ({
          companyId,
          principalType,
          ...membershipModule.principalColumns(principalType, principalId),
          permissionKey: grant.permissionKey,
          scope: grant.scope ?? null,
          grantedByUserId,
          createdAt: new Date(),
          updatedAt: new Date(),
        })),
      );
    });
  }

  async function copyActiveUserMemberships(sourceCompanyId: string, targetCompanyId: string) {
    const sourceMemberships = await listActiveUserMemberships(sourceCompanyId);
    for (const membership of sourceMemberships) {
      await ensureMembership(
        targetCompanyId,
        "user",
        membership.principalId,
        membership.membershipRole,
        "active",
      );
      await stampUserMemberRoleGrants(db, {
        companyId: targetCompanyId,
        principalId: membership.principalId,
        membershipRole: membership.membershipRole,
        grantedByUserId: null,
      });
    }
    return sourceMemberships;
  }

  return {
    archiveMember,
    promoteInstanceAdmin,
    demoteInstanceAdmin,
    listUserCompanyAccess,
    setUserCompanyAccess,
    ensureMembership,
    setPrincipalGrants,
    copyActiveUserMemberships,
  };
}
