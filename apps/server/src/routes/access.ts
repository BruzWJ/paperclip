import { type Db, authUsers, companyMemberships, invites } from "@paperclipai/db";
import { registerAccessAuthAndKeyRoutes } from "./access-auth-key-routes.js";
import { registerAccessInviteMutationRoutes } from "./access-invite-mutation-routes.js";
import { registerAccessMemberRoutes } from "./access-member-routes.js";
import {
  createAccessRouteContext,
  type AccessRouteOptions,
  type AccessRouteContext,
} from "./access-route-context.js";

import {
  searchAdminUsersQuerySchema,
  updateUserCompanyAccessSchema,
  createCompanyInviteSchema,
} from "@paperclipai/shared";
import { and, desc, eq, inArray } from "drizzle-orm";
import { notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { getBoardUserId } from "./authz.js";

import { createCompanyInvite, hashInviteToken } from "../services/company-invite-creation.js";
import { logActivity } from "../services/index.js";
import { getStorageService } from "../storage/index.js";

type AccessInviteReadRoutesContext = Pick<
  AccessRouteContext,
  | "db"
  | "toInviteSummaryResponse"
  | "loadUsersById"
  | "inviteExpired"
  | "extractInviteUserRole"
  | "resolveAcceptedInviteJoinRequest"
  | "router"
  | "assertCompanyPermission"
  | "getInviteCompanyBranding"
  | "getInviteLogoAsset"
>;

export function registerAccessInviteReadRoutes(context: AccessInviteReadRoutesContext): void {
  const {
    db,
    toInviteSummaryResponse,
    loadUsersById,
    inviteExpired,
    extractInviteUserRole,
    resolveAcceptedInviteJoinRequest,
    router,
    assertCompanyPermission,
    getInviteCompanyBranding,
    getInviteLogoAsset,
  } = context;

  router.post("/companies/:companyId/invites", validate(createCompanyInviteSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const invitedByUserId = await assertCompanyPermission(req, companyId, "users:invite");
    const { token, invite: created } = await createCompanyInvite(db, {
      companyId,
      provenance: { source: "board_api", invitedByUserId },
      userRole: req.body.userRole ?? null,
    });

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: invitedByUserId,
      action: "invite.created",
      entityType: "invite",
      entityId: created.id,
      details: {
        inviteType: created.inviteType,
        expiresAt: created.expiresAt.toISOString(),
        userRole: extractInviteUserRole(created),
      },
    });

    const companyBranding = await getInviteCompanyBranding(created.companyId, token);
    const inviteSummary = toInviteSummaryResponse(req, token, created, companyBranding);
    res.status(201).json({
      ...created,
      token,
      invitePath: inviteSummary.invitePath,
      inviteUrl: inviteSummary.inviteUrl,
      companyName: companyBranding.name,
    });
  });

  router.get("/invites/:token", async (req, res) => {
    const token = req.params.token as string;
    if (!token) throw notFound("Invite not found");
    const invite = await db
      .select()
      .from(invites)
      .where(eq(invites.tokenHash, hashInviteToken(token)))
      .then((rows) => rows[0] ?? null);
    const inviteJoinRequest = await resolveAcceptedInviteJoinRequest(db, req, invite);
    if (!invite || invite.revokedAt || inviteExpired(invite) || (invite.acceptedAt && !inviteJoinRequest)) {
      throw notFound("Invite not found");
    }

    const companyBranding = await getInviteCompanyBranding(invite.companyId, token);
    const inviterName = invite.invitedByUserId
      ? await loadUsersById(db, [invite.invitedByUserId]).then(
          (m) => m.get(invite.invitedByUserId!)?.name ?? null,
        )
      : null;
    res.json({
      ...toInviteSummaryResponse(req, token, invite, companyBranding),
      invitedByUserName: inviterName,
      joinRequestStatus: inviteJoinRequest?.status ?? null,
    });
  });

  router.get("/invites/:token/logo", async (req, res, next) => {
    const token = req.params.token as string;
    if (!token) throw notFound("Invite not found");
    const invite = await db
      .select()
      .from(invites)
      .where(eq(invites.tokenHash, hashInviteToken(token)))
      .then((rows) => rows[0] ?? null);
    const inviteJoinRequest = await resolveAcceptedInviteJoinRequest(db, req, invite);
    if (!invite || invite.revokedAt || inviteExpired(invite) || (invite.acceptedAt && !inviteJoinRequest)) {
      throw notFound("Invite not found");
    }

    const logoAsset = await getInviteLogoAsset(invite.companyId);
    if (!logoAsset || !logoAsset.companyId) {
      throw notFound("Invite logo not found");
    }
    const companyId = logoAsset.companyId;

    const storage = getStorageService();
    const logoHead = await storage.headObject(companyId, logoAsset.objectKey);
    if (!logoHead.exists) {
      throw notFound("Invite logo not found");
    }
    const object = await storage.getObject(companyId, logoAsset.objectKey);
    const responseContentType =
      logoAsset.contentType || logoHead.contentType || object.contentType || "application/octet-stream";
    res.setHeader("Content-Type", responseContentType);
    res.setHeader(
      "Content-Length",
      String(logoAsset.byteSize || logoHead.contentLength || object.contentLength || 0),
    );
    res.setHeader("Cache-Control", "private, max-age=60");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (responseContentType === "image/svg+xml") {
      res.setHeader(
        "Content-Security-Policy",
        "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
      );
    }
    const filename = logoAsset.originalFilename ?? "company-logo";
    res.setHeader("Content-Disposition", `inline; filename=\"${filename.replaceAll('"', "")}\"`);

    object.stream.on("error", (err) => {
      next(err);
    });
    object.stream.pipe(res);
  });
}

type AccessAdminRoutesContext = Pick<
  AccessRouteContext,
  "db" | "loadUserCompanyAccessResponse" | "toUserProfile" | "router" | "access" | "assertInstanceAdmin"
>;

export function registerAccessAdminRoutes(context: AccessAdminRoutesContext): void {
  const { db, loadUserCompanyAccessResponse, toUserProfile, router, access, assertInstanceAdmin } = context;

  router.post("/admin/users/:userId/promote-instance-admin", async (req, res) => {
    await assertInstanceAdmin(req);
    const userId = req.params.userId as string;
    const result = await access.promoteInstanceAdmin(userId);
    res.status(201).json(result);
  });

  router.get("/admin/users", async (req, res) => {
    await assertInstanceAdmin(req);
    const query = searchAdminUsersQuerySchema.parse(req.query);
    const needle = query.query.toLowerCase();
    const users = await db
      .select({
        id: authUsers.id,
        email: authUsers.email,
        name: authUsers.name,
        image: authUsers.image,
      })
      .from(authUsers)
      .orderBy(desc(authUsers.updatedAt));
    const filteredUsers = needle
      ? users.filter((user) =>
          [user.name, user.email]
            .filter((value): value is string => Boolean(value))
            .some((value) => value.toLowerCase().includes(needle)),
        )
      : users;
    const userIds = filteredUsers.slice(0, 50).map((user) => user.id);
    const memberships = userIds.length
      ? await db
          .select({
            principalId: companyMemberships.principalUserId,
          })
          .from(companyMemberships)
          .where(
            and(
              eq(companyMemberships.principalType, "user"),
              eq(companyMemberships.status, "active"),
              inArray(companyMemberships.principalUserId, userIds),
            ),
          )
      : [];
    const membershipCountByUserId = new Map<string, number>();
    for (const membership of memberships) {
      if (!membership.principalId) continue;
      membershipCountByUserId.set(
        membership.principalId,
        (membershipCountByUserId.get(membership.principalId) ?? 0) + 1,
      );
    }
    const adminIds = new Set(
      await Promise.all(
        userIds.map(async (userId) => ((await access.isInstanceAdmin(userId)) ? userId : null)),
      ).then((values) => values.filter((value): value is string => Boolean(value))),
    );

    res.json(
      filteredUsers.slice(0, 50).map((user) => ({
        ...toUserProfile(user),
        isInstanceAdmin: adminIds.has(user.id),
        activeCompanyMembershipCount: membershipCountByUserId.get(user.id) ?? 0,
      })),
    );
  });

  router.post("/admin/users/:userId/demote-instance-admin", async (req, res) => {
    await assertInstanceAdmin(req);
    const userId = req.params.userId as string;
    const removed = await access.demoteInstanceAdmin(userId);
    if (!removed) throw notFound("Instance admin role not found");
    res.json(removed);
  });

  router.get("/admin/users/:userId/company-access", async (req, res) => {
    await assertInstanceAdmin(req);
    const userId = req.params.userId as string;
    res.json(await loadUserCompanyAccessResponse(db, access, userId));
  });

  router.put(
    "/admin/users/:userId/company-access",
    validate(updateUserCompanyAccessSchema),
    async (req, res) => {
      await assertInstanceAdmin(req);
      const userId = req.params.userId as string;
      await access.setUserCompanyAccess(userId, req.body.companyIds ?? [], {
        actorUserId: getBoardUserId(req),
      });
      res.json(await loadUserCompanyAccessResponse(db, access, userId));
    },
  );
}

export function accessRoutes(db: Db, options: AccessRouteOptions) {
  const context = createAccessRouteContext(db, options);
  registerAccessAuthAndKeyRoutes(context);
  registerAccessInviteReadRoutes(context);
  registerAccessInviteMutationRoutes(context);
  registerAccessMemberRoutes(context);
  registerAccessAdminRoutes(context);
  return context.router;
}
