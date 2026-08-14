import { assets, companies, companyLogos, joinRequests, type Db, type invites } from "@paperclipai/db";
import type { DeploymentExposure, PermissionKey } from "@paperclipai/shared";
import { eq } from "drizzle-orm";
import { type Request, Router } from "express";
import { conflict, forbidden } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { resolveUserInviteRole } from "../services/company-member-roles.js";
import {
  accessService,
  boardAuthService,
  createJoinRequestApprovalService,
  logActivity,
} from "../services/index.js";
import { userJoinGrantsFromDefaults } from "../services/invite-grants.js";
import { createInviteRateLimiter, type InviteRateLimiter } from "../services/invite-rate-limit.js";
import { getStorageService } from "../storage/index.js";
import {
  actorHasActiveUserMembership,
  addCompanyMemberRemovalAccess,
  assertCanManageCompanyMember,
  buildCliAuthApprovalPath,
  getProtectedMemberReason,
  loadCompanyAccessSummary,
  loadCompanyMemberRecords,
  loadCompanyUserDirectory,
  loadUsersById,
  requestBaseUrl,
  resolveActorUserRole,
  toInviteSummaryResponse,
  toJoinRequestResponse,
  userRoleRank,
} from "./access-route-shared-a.js";
import {
  extractInviteUserRole,
  inviteExpired,
  inviteState,
  inviteStateWhereClause,
  loadCompanyInviteRecords,
  loadJoinRequestRecords,
  loadUserCompanyAccessResponse,
  requestIp,
  resolveAcceptedInviteJoinRequest,
  resolveActorEmail,
  toUserProfile,
} from "./access-route-shared-b.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

export function createAccessRouteContext(
  db: Db,
  opts: {
    deploymentExposure: DeploymentExposure;
    inviteRateLimiter?: InviteRateLimiter;
  },
) {
  const router = Router({ caseSensitive: true, strict: true });
  const access = accessService(db);
  const boardAuth = boardAuthService(db);
  const joinRequestApprovals = createJoinRequestApprovalService(db);

  // Per-IP rate limit for the public, unauthenticated invite-token endpoints
  // (`/invites/:token*`). The token is looked up by hash, so without a limit the
  // token space would be online-enumerable. Applied as a router-level middleware
  // so every current and future `/invites/:token` sub-route is covered.
  //
  // The key is deliberately NOT `requestIp()`: that helper prefers the
  // client-supplied `X-Forwarded-For` header (fine for log/audit fields,
  // but trivially spoofable as a rate-limit key — rotating fake XFF values
  // would mint a fresh budget per request). `req.ip` honors Express's
  // `trust proxy` setting (configured from TRUST_PROXY in app.ts, default:
  // trust nothing), so it is the socket's remote address unless the
  // operator explicitly trusts a proxy — an unforgeable key either way.
  const inviteRateLimiter = opts.inviteRateLimiter ?? createInviteRateLimiter();

  async function assertInstanceAdmin(req: Request) {
    assertBoard(req);
    const allowed = await access.isInstanceAdmin(req.actor.userId);
    if (!allowed) throw forbidden("Instance admin required");
  }

  async function assertCompanyPermission(req: Request, companyId: string, permissionKey: PermissionKey) {
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    const allowed = await access.canUser(companyId, req.actor.userId, permissionKey);
    if (!allowed) throw forbidden("Permission denied");
    return req.actor.userId;
  }

  async function approveUserJoinRequestFromInvite(input: {
    req: Request;
    invite: typeof invites.$inferSelect;
    joinRequest: typeof joinRequests.$inferSelect;
    companyId: string;
  }) {
    if (!input.joinRequest.requestingUserId) {
      throw conflict("Join request missing user identity");
    }

    const membershipRole = resolveUserInviteRole(
      input.invite.defaultsPayload as Record<string, unknown> | null,
    );
    await access.ensureMembership(
      input.companyId,
      "user",
      input.joinRequest.requestingUserId,
      membershipRole,
      "active",
    );
    const grants = userJoinGrantsFromDefaults(input.invite.defaultsPayload as Record<string, unknown> | null);
    await access.setPrincipalGrants(
      input.companyId,
      "user",
      input.joinRequest.requestingUserId,
      grants,
      input.invite.invitedByUserId ?? null,
    );

    if (input.joinRequest.status === "approved") {
      return input.joinRequest;
    }

    const approvedAt = new Date();
    const approvedByUserId = input.invite.invitedByUserId ?? null;
    const approved = await db
      .update(joinRequests)
      .set({
        status: "approved",
        approvedByUserId,
        approvedAt,
        updatedAt: approvedAt,
      })
      .where(eq(joinRequests.id, input.joinRequest.id))
      .returning()
      .then((rows) => rows[0] ?? null);

    await logActivity(db, {
      companyId: input.companyId,
      actorType: "user",
      actorId: approvedByUserId ?? "board",
      action: "join.approved",
      entityType: "join_request",
      entityId: input.joinRequest.id,
      details: {
        inviteId: input.invite.id,
        source: "user_invite_accept",
      },
    });

    return (
      approved ?? {
        ...input.joinRequest,
        status: "approved",
        approvedByUserId,
        approvedAt,
        updatedAt: approvedAt,
      }
    );
  }

  async function getInviteCompanyBranding(
    companyId: string | null,
    inviteToken: string | null = null,
  ): Promise<{
    name: string | null;
    brandColor: string | null;
    logoAssetId: string | null;
    logoUrl: string | null;
  }> {
    if (!companyId) {
      return { name: null, brandColor: null, logoAssetId: null, logoUrl: null };
    }
    const company = await db
      .select({
        name: companies.name,
        brandColor: companies.brandColor,
        logoAssetId: companyLogos.assetId,
      })
      .from(companies)
      .leftJoin(companyLogos, eq(companyLogos.companyId, companies.id))
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    let logoUrl: string | null = null;
    if (inviteToken && company?.logoAssetId) {
      const logoAsset = await getInviteLogoAsset(companyId);
      if (logoAsset?.companyId) {
        try {
          const storage = getStorageService();
          const logoObject = await storage.headObject(logoAsset.companyId, logoAsset.objectKey);
          if (logoObject.exists) {
            logoUrl = `/api/invites/${inviteToken}/logo`;
          }
        } catch (err) {
          logger.warn(
            {
              err,
              companyId,
              logoAssetId: company.logoAssetId,
            },
            "invite logo storage check failed",
          );
        }
      }
    }

    return {
      name: company?.name ?? null,
      brandColor: company?.brandColor ?? null,
      logoAssetId: company?.logoAssetId ?? null,
      logoUrl,
    };
  }

  async function getInviteLogoAsset(companyId: string | null): Promise<{
    companyId: string | null;
    objectKey: string;
    contentType: string | null;
    byteSize: number | null;
    originalFilename: string | null;
  } | null> {
    if (!companyId) return null;
    const logoAsset = await db
      .select({
        companyId: companies.id,
        objectKey: assets.objectKey,
        contentType: assets.contentType,
        byteSize: assets.byteSize,
        originalFilename: assets.originalFilename,
      })
      .from(companies)
      .leftJoin(companyLogos, eq(companyLogos.companyId, companies.id))
      .leftJoin(assets, eq(assets.id, companyLogos.assetId))
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);

    if (!logoAsset?.objectKey) return null;
    return {
      companyId: logoAsset.companyId,
      objectKey: logoAsset.objectKey,
      contentType: logoAsset.contentType,
      byteSize: logoAsset.byteSize,
      originalFilename: logoAsset.originalFilename,
    };
  }
  return {
    db,
    opts,
    requestBaseUrl,
    buildCliAuthApprovalPath,
    toJoinRequestResponse,
    toInviteSummaryResponse,
    actorHasActiveUserMembership,
    loadUsersById,
    loadCompanyAccessSummary,
    loadCompanyMemberRecords,
    userRoleRank,
    resolveActorUserRole,
    getProtectedMemberReason,
    assertCanManageCompanyMember,
    addCompanyMemberRemovalAccess,
    loadCompanyUserDirectory,
    inviteStateWhereClause,
    loadCompanyInviteRecords,
    loadJoinRequestRecords,
    loadUserCompanyAccessResponse,
    requestIp,
    inviteExpired,
    inviteState,
    extractInviteUserRole,
    toUserProfile,
    resolveActorEmail,
    resolveAcceptedInviteJoinRequest,
    router,
    access,
    boardAuth,
    joinRequestApprovals,
    inviteRateLimiter,
    assertInstanceAdmin,
    assertCompanyPermission,
    approveUserJoinRequestFromInvite,
    getInviteCompanyBranding,
    getInviteLogoAsset,
  };
}

export type AccessRouteContext = ReturnType<typeof createAccessRouteContext>;
export type AccessRouteOptions = Parameters<typeof createAccessRouteContext>[1];
