import { invites, joinRequests } from "@paperclipai/db";
import {
  acceptInviteSchema,
  approveJoinRequestSchema,
  isCanonicalUuid,
  listCompanyInvitesQuerySchema,
  listJoinRequestsQuerySchema,
} from "@paperclipai/shared";
import { and, desc, eq, isNull } from "drizzle-orm";
import { conflict, notFound, unauthorized } from "../errors.js";
import { claimFirstInstanceAdmin } from "../first-admin-claim.js";
import { findReusableUserJoinRequest } from "../lib/join-request-dedupe.js";
import { validate } from "../middleware/validate.js";
import { hashInviteToken } from "../services/company-invite-creation.js";
import { logActivity } from "../services/index.js";
import type { AccessRouteContext } from "./access-route-context.js";
import { assertBoard, getBoardUserId } from "./authz.js";

type AccessInviteMutationRoutesContext = Pick<
  AccessRouteContext,
  | "db"
  | "toJoinRequestResponse"
  | "actorHasActiveUserMembership"
  | "loadCompanyInviteRecords"
  | "loadJoinRequestRecords"
  | "requestIp"
  | "inviteExpired"
  | "resolveActorEmail"
  | "router"
  | "joinRequestApprovals"
  | "assertInstanceAdmin"
  | "assertCompanyPermission"
  | "approveUserJoinRequestFromInvite"
>;

export function registerAccessInviteMutationRoutes(context: AccessInviteMutationRoutesContext): void {
  const {
    db,
    toJoinRequestResponse,
    actorHasActiveUserMembership,
    loadCompanyInviteRecords,
    loadJoinRequestRecords,
    requestIp,
    inviteExpired,
    resolveActorEmail,
    router,
    joinRequestApprovals,
    assertInstanceAdmin,
    assertCompanyPermission,
    approveUserJoinRequestFromInvite,
  } = context;

  router.post("/invites/:token/accept", validate(acceptInviteSchema), async (req, res) => {
    const token = req.params.token as string;
    if (!token) throw notFound("Invite not found");

    const invite = await db
      .select()
      .from(invites)
      .where(eq(invites.tokenHash, hashInviteToken(token)))
      .then((rows) => rows[0] ?? null);
    if (!invite || invite.revokedAt || inviteExpired(invite)) {
      throw notFound("Invite not found");
    }
    const inviteAlreadyAccepted = Boolean(invite.acceptedAt);
    const existingJoinRequestForInvite = inviteAlreadyAccepted
      ? await db
          .select()
          .from(joinRequests)
          .where(eq(joinRequests.inviteId, invite.id))
          .then((rows) => rows[0] ?? null)
      : null;

    if (invite.inviteType === "bootstrap_admin") {
      if (inviteAlreadyAccepted) throw notFound("Invite not found");
      if (req.actor.type !== "board" || !req.actor.userId) {
        throw unauthorized("Authenticated user required for bootstrap acceptance");
      }
      const userId = req.actor.userId;
      const claimed = await claimFirstInstanceAdmin(db, {
        userId,
        onClaim: async (tx) => {
          const updatedInvite = await tx
            .update(invites)
            .set({ acceptedAt: new Date(), updatedAt: new Date() })
            .where(and(eq(invites.id, invite.id), isNull(invites.acceptedAt), isNull(invites.revokedAt)))
            .returning()
            .then((rows) => rows[0] ?? null);
          if (!updatedInvite) {
            throw conflict("Bootstrap invite is no longer available");
          }
          return updatedInvite;
        },
      });
      if (claimed.status === "already_claimed") {
        throw conflict("Someone else has already claimed this instance");
      }
      const updatedInvite = claimed.value ?? invite;
      res.status(202).json({
        inviteId: updatedInvite.id,
        inviteType: updatedInvite.inviteType,
        bootstrapAccepted: true,
        userId,
      });
      return;
    }

    const companyId = invite.companyId;
    if (!companyId) throw conflict("Invite is missing company scope");
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("Authenticated user is required");
    }
    if (actorHasActiveUserMembership(req, companyId)) {
      throw conflict("You already belong to this company");
    }

    const actorEmail = await resolveActorEmail(db, req);
    const actorRequestingUserId = req.actor.userId;
    const canReplayUserInviteAccept =
      inviteAlreadyAccepted &&
      Boolean(
        existingJoinRequestForInvite &&
        findReusableUserJoinRequest([existingJoinRequestForInvite], {
          requestingUserId: actorRequestingUserId,
          requestEmailSnapshot: actorEmail,
        }),
      );
    if (inviteAlreadyAccepted && !canReplayUserInviteAccept) {
      throw notFound("Invite not found");
    }
    const replayJoinRequestId = inviteAlreadyAccepted ? (existingJoinRequestForInvite?.id ?? null) : null;
    if (inviteAlreadyAccepted && !replayJoinRequestId) {
      throw conflict("Join request not found");
    }

    const existingUserJoinRequest = findReusableUserJoinRequest(
      await db
        .select()
        .from(joinRequests)
        .where(eq(joinRequests.companyId, companyId))
        .orderBy(desc(joinRequests.createdAt)),
      {
        requestingUserId: actorRequestingUserId,
        requestEmailSnapshot: actorEmail,
      },
    );
    let created = !inviteAlreadyAccepted
      ? existingUserJoinRequest
        ? await db.transaction(async (tx) => {
            await tx
              .update(invites)
              .set({ acceptedAt: new Date(), updatedAt: new Date() })
              .where(and(eq(invites.id, invite.id), isNull(invites.acceptedAt), isNull(invites.revokedAt)));
            return existingUserJoinRequest;
          })
        : await db.transaction(async (tx) => {
            await tx
              .update(invites)
              .set({ acceptedAt: new Date(), updatedAt: new Date() })
              .where(and(eq(invites.id, invite.id), isNull(invites.acceptedAt), isNull(invites.revokedAt)));

            const row = await tx
              .insert(joinRequests)
              .values({
                inviteId: invite.id,
                companyId,
                status: "pending_approval",
                requestIp: requestIp(req),
                requestingUserId: actorRequestingUserId,
                requestEmailSnapshot: actorEmail,
              })
              .returning()
              .then((rows) => rows[0]);
            return row;
          })
      : await db
          .update(joinRequests)
          .set({
            requestIp: requestIp(req),
            updatedAt: new Date(),
          })
          .where(eq(joinRequests.id, replayJoinRequestId as string))
          .returning()
          .then((rows) => rows[0]);

    if (!created) {
      throw conflict("Join request not found");
    }

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId,
      action: inviteAlreadyAccepted ? "join.request_replayed" : "join.requested",
      entityType: "join_request",
      entityId: created.id,
      details: {
        requestIp: requestIp(req),
        inviteReplay: inviteAlreadyAccepted,
        reusedExistingJoinRequest: Boolean(existingUserJoinRequest) && !inviteAlreadyAccepted,
      },
    });

    created = await approveUserJoinRequestFromInvite({
      req,
      invite,
      joinRequest: created,
      companyId,
    });
    res.status(202).json(toJoinRequestResponse(created));
  });

  router.post("/invites/:inviteId/revoke", async (req, res) => {
    const id = req.params.inviteId as string;
    if (!isCanonicalUuid(id)) throw notFound("Invite not found");
    const invite = await db
      .select()
      .from(invites)
      .where(eq(invites.id, id))
      .then((rows) => rows[0] ?? null);
    if (!invite) throw notFound("Invite not found");
    if (invite.inviteType === "bootstrap_admin") {
      await assertInstanceAdmin(req);
    } else {
      if (!invite.companyId) throw conflict("Invite is missing company scope");
      await assertCompanyPermission(req, invite.companyId, "users:invite");
    }
    if (invite.acceptedAt) throw conflict("Invite already consumed");
    if (invite.revokedAt) return res.json(invite);

    const revoked = await db
      .update(invites)
      .set({ revokedAt: new Date(), updatedAt: new Date() })
      .where(eq(invites.id, id))
      .returning()
      .then((rows) => rows[0]);

    if (invite.companyId) {
      await logActivity(db, {
        companyId: invite.companyId,
        actorType: "user",
        actorId: getBoardUserId(req),
        action: "invite.revoked",
        entityType: "invite",
        entityId: id,
      });
    }

    res.json(revoked);
  });

  router.get("/companies/:companyId/invites", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyPermission(req, companyId, "users:invite");
    const query = listCompanyInvitesQuerySchema.parse(req.query);
    const invitesForCompany = await loadCompanyInviteRecords(db, companyId, query);
    res.json(invitesForCompany);
  });

  router.get("/companies/:companyId/join-requests", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyPermission(req, companyId, "joins:approve");
    const query = listJoinRequestsQuerySchema.parse(req.query);
    const all = await loadJoinRequestRecords(db, companyId);
    const filtered = all.filter((row) => {
      if (query.status && row.status !== query.status) return false;
      return true;
    });
    res.json(filtered);
  });

  router.post("/companies/:companyId/join-requests/:requestId/approve", async (req, res) => {
    const companyId = req.params.companyId as string;
    const requestId = req.params.requestId as string;
    if (!isCanonicalUuid(requestId)) {
      throw notFound("Join request not found");
    }
    const actorId = await assertCompanyPermission(req, companyId, "joins:approve");
    approveJoinRequestSchema.parse(req.body);
    assertBoard(req);
    const approved = await joinRequestApprovals.approve({
      companyId,
      requestId,
      actor: {
        actorId,
        userId: req.actor.userId,
        authorization: req.actor,
      },
    });
    res.json(toJoinRequestResponse(approved));
  });

  router.post("/companies/:companyId/join-requests/:requestId/reject", async (req, res) => {
    const companyId = req.params.companyId as string;
    const requestId = req.params.requestId as string;
    if (!isCanonicalUuid(requestId)) {
      throw notFound("Join request not found");
    }
    const actorId = await assertCompanyPermission(req, companyId, "joins:approve");

    const existing = await db
      .select()
      .from(joinRequests)
      .where(and(eq(joinRequests.companyId, companyId), eq(joinRequests.id, requestId)))
      .then((rows) => rows[0] ?? null);
    if (!existing) throw notFound("Join request not found");
    if (existing.status !== "pending_approval") throw conflict("Join request is not pending");

    const rejected = await db
      .update(joinRequests)
      .set({
        status: "rejected",
        rejectedByUserId: actorId,
        rejectedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(joinRequests.id, requestId))
      .returning()
      .then((rows) => rows[0]);

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId,
      action: "join.rejected",
      entityType: "join_request",
      entityId: requestId,
      details: null,
    });

    res.json(toJoinRequestResponse(rejected));
  });
}
