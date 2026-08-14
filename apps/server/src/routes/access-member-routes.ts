import { companyMemberships, principalPermissionGrants } from "@paperclipai/db";
import {
  archiveCompanyMemberSchema,
  isCanonicalUuid,
  updateCompanyMemberSchema,
  updateCompanyMemberWithPermissionsSchema,
  updateMemberPermissionsSchema,
} from "@paperclipai/shared";
import { and, eq, sql } from "drizzle-orm";
import type { Request, Response } from "express";
import { conflict, notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { logActivity } from "../services/index.js";
import type { AccessRouteContext } from "./access-route-context.js";
import type { MemberGrantPayload } from "./access-route-shared-a.js";
import { assertCompanyAccess, getBoardUserId } from "./authz.js";

type AccessMemberRoutesContext = Pick<
  AccessRouteContext,
  | "db"
  | "loadCompanyAccessSummary"
  | "loadCompanyMemberRecords"
  | "assertCanManageCompanyMember"
  | "addCompanyMemberRemovalAccess"
  | "loadCompanyUserDirectory"
  | "router"
  | "access"
  | "assertCompanyPermission"
>;

export function registerAccessMemberRoutes(context: AccessMemberRoutesContext): void {
  const {
    db,
    loadCompanyAccessSummary,
    loadCompanyMemberRecords,
    assertCanManageCompanyMember,
    addCompanyMemberRemovalAccess,
    loadCompanyUserDirectory,
    router,
    access,
    assertCompanyPermission,
  } = context;

  router.get("/companies/:companyId/members", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyPermission(req, companyId, "users:manage_permissions");
    const [members, currentAccess] = await Promise.all([
      loadCompanyMemberRecords(db, companyId),
      loadCompanyAccessSummary(req, access, companyId),
    ]);
    res.json({
      members: await addCompanyMemberRemovalAccess(req, db, access, companyId, members),
      access: currentAccess,
    });
  });

  router.get("/companies/:companyId/user-directory", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const users = await loadCompanyUserDirectory(db, companyId);
    res.json({ users });
  });

  async function handleUpdateCompanyMember(req: Request, res: Response, options: { withGrants: boolean }) {
    const companyId = req.params.companyId as string;
    const memberId = req.params.memberId as string;
    if (!isCanonicalUuid(memberId)) throw notFound("Member not found");
    await assertCompanyPermission(req, companyId, "users:manage_permissions");
    const memberToUpdate = await access.getMemberById(companyId, memberId);
    if (!memberToUpdate || memberToUpdate.principalType !== "user") {
      throw notFound("Member not found");
    }
    await assertCanManageCompanyMember(req, access, companyId, memberToUpdate);

    const updated = await db.transaction(async (tx) => {
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
      if (existing.principalType !== "user" || !existing.principalUserId) {
        throw conflict("Only user company members can be updated");
      }
      const principalUserId = existing.principalUserId;

      const nextMembershipRole =
        req.body.membershipRole !== undefined ? req.body.membershipRole : existing.membershipRole;
      const nextStatus = req.body.status ?? existing.status;

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
      const updatedMember = await tx
        .update(companyMemberships)
        .set({
          membershipRole: nextMembershipRole,
          status: nextStatus,
          updatedAt: now,
        })
        .where(eq(companyMemberships.id, existing.id))
        .returning()
        .then((rows) => rows[0] ?? existing);

      if (options.withGrants) {
        await tx
          .delete(principalPermissionGrants)
          .where(
            and(
              eq(principalPermissionGrants.companyId, companyId),
              eq(principalPermissionGrants.principalType, "user"),
              eq(principalPermissionGrants.principalUserId, principalUserId),
            ),
          );

        const grants = (req.body.grants ?? []) as MemberGrantPayload[];
        if (grants.length > 0) {
          await tx.insert(principalPermissionGrants).values(
            grants.map((grant) => ({
              companyId,
              principalType: "user" as const,
              principalUserId,
              principalAgentId: null,
              permissionKey: grant.permissionKey,
              scope: grant.scope ?? null,
              grantedByUserId: getBoardUserId(req),
              createdAt: now,
              updatedAt: now,
            })),
          );
        }
      }

      return updatedMember;
    });
    if (!updated) throw notFound("Member not found");

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: getBoardUserId(req),
      action: options.withGrants ? "company_member.access_updated" : "company_member.updated",
      entityType: "company_membership",
      entityId: memberId,
      details: {
        membershipRole: updated.membershipRole,
        status: updated.status,
        ...(options.withGrants ? { grantCount: req.body.grants?.length ?? 0 } : {}),
      },
    });

    const member = (await loadCompanyMemberRecords(db, companyId)).find((entry) => entry.id === memberId);
    if (!member) throw notFound("Member not found");
    res.json(member);
  }

  router.patch(
    "/companies/:companyId/members/:memberId",
    validate(updateCompanyMemberSchema),
    async (req, res) => {
      await handleUpdateCompanyMember(req, res, { withGrants: false });
    },
  );

  router.patch(
    "/companies/:companyId/members/:memberId/role-and-grants",
    validate(updateCompanyMemberWithPermissionsSchema),
    async (req, res) => {
      await handleUpdateCompanyMember(req, res, { withGrants: true });
    },
  );

  router.post(
    "/companies/:companyId/members/:memberId/archive",
    validate(archiveCompanyMemberSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const memberId = req.params.memberId as string;
      if (!isCanonicalUuid(memberId)) throw notFound("Member not found");
      await assertCompanyPermission(req, companyId, "users:manage_permissions");
      const memberToArchive = await access.getMemberById(companyId, memberId);
      if (!memberToArchive || memberToArchive.principalType !== "user") {
        throw notFound("Member not found");
      }
      await assertCanManageCompanyMember(req, access, companyId, memberToArchive, "archive");

      const result = await access.archiveMember(companyId, memberId);
      if (!result) throw notFound("Member not found");

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: getBoardUserId(req),
        action: "company_member.archived",
        entityType: "company_membership",
        entityId: memberId,
        details: {
          principalId: result.member.principalId,
        },
      });

      const member = (await loadCompanyMemberRecords(db, companyId, { includeArchived: true })).find(
        (entry) => entry.id === memberId,
      );
      if (!member) throw notFound("Member not found");
      res.json({ member });
    },
  );

  router.patch(
    "/companies/:companyId/members/:memberId/permissions",
    validate(updateMemberPermissionsSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const memberId = req.params.memberId as string;
      if (!isCanonicalUuid(memberId)) throw notFound("Member not found");
      await assertCompanyPermission(req, companyId, "users:manage_permissions");
      const memberToUpdate = await access.getMemberById(companyId, memberId);
      if (!memberToUpdate || memberToUpdate.principalType !== "user") {
        throw notFound("Member not found");
      }
      await assertCanManageCompanyMember(req, access, companyId, memberToUpdate);
      const updated = await access.setMemberPermissions(
        companyId,
        memberId,
        req.body.grants ?? [],
        getBoardUserId(req),
      );
      if (!updated) throw notFound("Member not found");
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: getBoardUserId(req),
        action: "company_member.permissions_updated",
        entityType: "company_membership",
        entityId: memberId,
        details: {
          grantCount: req.body.grants?.length ?? 0,
        },
      });
      const member = (await loadCompanyMemberRecords(db, companyId)).find((entry) => entry.id === memberId);
      if (!member) throw notFound("Member not found");
      res.json(member);
    },
  );
}
