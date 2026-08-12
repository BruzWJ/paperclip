import { Router } from "express";
import type { Request, Response } from "express";
import {
  and,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  sql,
} from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  assets,
  authUsers,
  companies,
  companyLogos,
  companyMemberships,
  instanceUserRoles,
  invites,
  joinRequests,
  principalPermissionGrants,
} from "@paperclipai/db";
import {
  acceptInviteSchema,
  approveJoinRequestSchema,
  createCliAuthChallengeSchema,
  createBoardApiKeySchema,
  createCompanyInviteSchema,
  listCompanyInvitesQuerySchema,
  listJoinRequestsQuerySchema,
  resolveCliAuthChallengeSchema,
  searchAdminUsersQuerySchema,
  updateCompanyMemberWithPermissionsSchema,
  updateCompanyMemberSchema,
  archiveCompanyMemberSchema,
  updateMemberPermissionsSchema,
  updateUserCompanyAccessSchema,
  isCanonicalUuid,
} from "@paperclipai/shared";
import type {
  DeploymentExposure,
  UserCompanyMembershipRole,
  PermissionKey,
} from "@paperclipai/shared";
import {
  forbidden,
  conflict,
  notFound,
  unauthorized,
  badRequest,
  tooManyRequests,
} from "../errors.js";
import {
  createInviteRateLimiter,
  type InviteRateLimiter,
} from "../services/invite-rate-limit.js";
import { logger } from "../middleware/logger.js";
import { validate } from "../middleware/validate.js";
import {
  accessService,
  boardAuthService,
  createJoinRequestApprovalService,
  logActivity,
} from "../services/index.js";
import {
  requireUserRole,
  resolveUserInviteRole,
} from "../services/company-member-roles.js";
import {
  createCompanyInvite,
  hashInviteToken,
} from "../services/company-invite-creation.js";
import { userJoinGrantsFromDefaults } from "../services/invite-grants.js";
import {
  collapseDuplicatePendingUserJoinRequests,
  findReusableUserJoinRequest,
} from "../lib/join-request-dedupe.js";
import {
  assertBoard,
  assertCompanyAccess,
  assertCurrentBoardUser,
  getBoardUserId,
} from "./authz.js";
import { assertExactQueryKeys, parseExactBooleanQuery } from "./exact-query.js";
import { claimFirstInstanceAdmin } from "../first-admin-claim.js";
import { getStorageService } from "../storage/index.js";
import { requireRequestAuthority } from "../http/request-authority.js";

type MemberGrantPayload = {
  permissionKey: PermissionKey;
  scope?: Record<string, unknown> | null;
};

function requestBaseUrl(req: Request) {
  return requireRequestAuthority(req).origin;
}

function buildCliAuthApprovalPath(challengeId: string, token: string) {
  return `/cli-auth/${challengeId}?token=${encodeURIComponent(token)}`;
}

function toJoinRequestResponse(row: typeof joinRequests.$inferSelect) {
  return row;
}

function toInviteSummaryResponse(
  req: Request,
  token: string,
  invite: typeof invites.$inferSelect,
  company:
    | string
    | {
        name: string | null;
        brandColor: string | null;
        logoUrl: string | null;
      }
    | null = null,
) {
  const companyInfo =
    typeof company === "string"
      ? { name: company, brandColor: null, logoUrl: null }
      : company;
  const baseUrl = requestBaseUrl(req);
  const invitePath = `/invite/${token}`;
  return {
    id: invite.id,
    companyId: invite.companyId,
    companyName: companyInfo?.name ?? null,
    companyLogoUrl: companyInfo?.logoUrl ?? null,
    companyBrandColor: companyInfo?.brandColor ?? null,
    inviteType: invite.inviteType,
    userRole: extractInviteUserRole(invite),
    expiresAt: invite.expiresAt,
    invitePath,
    inviteUrl: baseUrl ? `${baseUrl}${invitePath}` : invitePath,
  };
}

function actorHasActiveUserMembership(req: Request, companyId: string) {
  return (
    req.actor.type === "board" &&
    typeof req.actor.userId === "string" &&
    Array.isArray(req.actor.memberships) &&
    req.actor.memberships.some(
      (membership) =>
        membership.companyId === companyId && membership.status === "active",
    )
  );
}

async function loadUsersById(db: Db, userIds: string[]) {
  if (userIds.length === 0)
    return new Map<string, ReturnType<typeof toUserProfile>>();
  const rows = await db
    .select({
      id: authUsers.id,
      email: authUsers.email,
      name: authUsers.name,
      image: authUsers.image,
    })
    .from(authUsers)
    .where(inArray(authUsers.id, userIds));
  return new Map(rows.map((row) => [row.id, toUserProfile(row)]));
}

async function loadCompanyAccessSummary(
  req: Request,
  access: ReturnType<typeof accessService>,
  companyId: string,
) {
  if (req.actor.type !== "board") {
    return {
      currentUserRole: null,
      canManageMembers: false,
      canInviteUsers: false,
      canApproveJoinRequests: false,
    };
  }
  const userId = req.actor.userId;
  const membership = userId
    ? await access.getMembership(companyId, "user", userId)
    : null;
  const [canManageMembers, canInviteUsers, canApproveJoinRequests] =
    await Promise.all([
      access.canUser(companyId, userId, "users:manage_permissions"),
      access.canUser(companyId, userId, "users:invite"),
      access.canUser(companyId, userId, "joins:approve"),
    ]);

  return {
    currentUserRole:
      membership?.status === "active" && membership.membershipRole
        ? requireUserRole(membership.membershipRole)
        : null,
    canManageMembers,
    canInviteUsers,
    canApproveJoinRequests,
  };
}

async function loadCompanyMemberRecords(
  db: Db,
  companyId: string,
  options: { includeArchived?: boolean } = {},
) {
  const members = await db
    .select()
    .from(companyMemberships)
    .where(
      and(
        eq(companyMemberships.companyId, companyId),
        eq(companyMemberships.principalType, "user"),
        options.includeArchived
          ? undefined
          : ne(companyMemberships.status, "archived"),
      ),
    )
    .orderBy(desc(companyMemberships.updatedAt));

  const userIds = [
    ...new Set(
      members
        .map((member) => member.principalUserId)
        .filter((userId): userId is string => typeof userId === "string"),
    ),
  ];
  const [userMap, grants] = await Promise.all([
    loadUsersById(db, userIds),
    userIds.length > 0
      ? db
          .select()
          .from(principalPermissionGrants)
          .where(
            and(
              eq(principalPermissionGrants.companyId, companyId),
              eq(principalPermissionGrants.principalType, "user"),
              inArray(principalPermissionGrants.principalUserId, userIds),
            ),
          )
      : Promise.resolve([]),
  ]);

  const grantsByPrincipalId = new Map<string, typeof grants>();
  for (const grant of grants) {
    if (!grant.principalUserId) continue;
    const existing = grantsByPrincipalId.get(grant.principalUserId) ?? [];
    existing.push(grant);
    grantsByPrincipalId.set(grant.principalUserId, existing);
  }

  return members.flatMap((member) => {
    const principalId = member.principalUserId;
    if (!principalId) return [];
    const {
      principalUserId: _principalUserId,
      principalAgentId: _principalAgentId,
      ...publicMember
    } = member;
    return [
      {
        ...publicMember,
        principalId,
        principalType: "user" as const,
        membershipRole: requireUserRole(member.membershipRole),
        user: userMap.get(principalId) ?? null,
        grants: (grantsByPrincipalId.get(principalId) ?? []).map((grant) => {
          const {
            principalUserId: _grantPrincipalUserId,
            principalAgentId: _grantPrincipalAgentId,
            ...publicGrant
          } = grant;
          return { ...publicGrant, principalId };
        }),
      },
    ];
  });
}

type CompanyMemberRecord = Awaited<
  ReturnType<typeof loadCompanyMemberRecords>
>[number];

const userRoleRank: Record<UserCompanyMembershipRole, number> = {
  viewer: 1,
  operator: 2,
  admin: 3,
  owner: 4,
};

async function resolveActorUserRole(
  req: Request,
  access: ReturnType<typeof accessService>,
  companyId: string,
): Promise<UserCompanyMembershipRole | null> {
  if (req.actor.type !== "board") return null;
  if (req.actor.isInstanceAdmin) return "owner";
  const userId = req.actor.userId;
  if (!userId) return null;
  const membership = await access.getMembership(companyId, "user", userId);
  if (membership?.status !== "active") return null;
  return requireUserRole(membership.membershipRole);
}

async function getProtectedMemberReason(
  req: Request,
  access: ReturnType<typeof accessService>,
  companyId: string,
  member: {
    principalId: string;
    principalType: "user";
    membershipRole: UserCompanyMembershipRole;
  },
  opts?: {
    actorRole?: UserCompanyMembershipRole | null;
    instanceAdminUserIds?: ReadonlySet<string>;
    operation?: "archive" | "update";
  },
): Promise<string | null> {
  if (member.principalType !== "user")
    return "Only user company members can be removed.";
  if (req.actor.type !== "board")
    return "Board access is required to remove members.";
  if (member.principalId === req.actor.userId)
    return "You cannot remove yourself.";
  const isTargetInstanceAdmin = opts?.instanceAdminUserIds
    ? opts.instanceAdminUserIds.has(member.principalId)
    : await access.isInstanceAdmin(member.principalId);
  if (isTargetInstanceAdmin) {
    return "Instance admins cannot be removed from company access.";
  }

  const targetRole = requireUserRole(member.membershipRole);
  if (opts?.operation === "archive") {
    if (targetRole === "owner")
      return "Board owners cannot be removed from company access.";
    if (targetRole === "admin")
      return "Company admins cannot be removed from company access.";
  }

  const actorRole =
    opts?.actorRole ?? (await resolveActorUserRole(req, access, companyId));
  if (!actorRole) return "Only active company members can remove users.";
  if (userRoleRank[targetRole] >= userRoleRank[actorRole]) {
    return "You can only remove users below your company role.";
  }

  return null;
}

async function assertCanManageCompanyMember(
  req: Request,
  access: ReturnType<typeof accessService>,
  companyId: string,
  member: {
    principalId: string;
    principalType: "user";
    membershipRole: UserCompanyMembershipRole;
  },
  operation: "archive" | "update" = "update",
) {
  const reason = await getProtectedMemberReason(
    req,
    access,
    companyId,
    member,
    { operation },
  );
  if (reason) throw forbidden(reason);
}

async function addCompanyMemberRemovalAccess(
  req: Request,
  db: Db,
  access: ReturnType<typeof accessService>,
  companyId: string,
  members: CompanyMemberRecord[],
) {
  const actorRole = await resolveActorUserRole(req, access, companyId);
  const userIds = [
    ...new Set(
      members
        .filter((member) => member.principalType === "user")
        .map((member) => member.principalId),
    ),
  ];
  const instanceAdminUserIds =
    userIds.length > 0
      ? new Set(
          await db
            .select({ userId: instanceUserRoles.userId })
            .from(instanceUserRoles)
            .where(
              and(
                inArray(instanceUserRoles.userId, userIds),
                eq(instanceUserRoles.role, "instance_admin"),
              ),
            )
            .then((rows) => rows.map((row) => row.userId)),
        )
      : new Set<string>();
  return Promise.all(
    members.map(async (member) => {
      const reason = await getProtectedMemberReason(
        req,
        access,
        companyId,
        member,
        {
          actorRole,
          instanceAdminUserIds,
          operation: "archive",
        },
      );
      return {
        ...member,
        removal: {
          canArchive: !reason,
          reason,
        },
      };
    }),
  );
}

async function loadCompanyUserDirectory(db: Db, companyId: string) {
  const members = await db
    .select({
      principalId: companyMemberships.principalUserId,
      status: companyMemberships.status,
    })
    .from(companyMemberships)
    .where(
      and(
        eq(companyMemberships.companyId, companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.status, "active"),
      ),
    )
    .orderBy(desc(companyMemberships.updatedAt));

  const userIds = [
    ...new Set(
      members
        .map((member) => member.principalId)
        .filter((userId): userId is string => typeof userId === "string"),
    ),
  ];
  const userMap = await loadUsersById(db, userIds);

  return members.flatMap((member) =>
    member.principalId
      ? [
          {
            principalId: member.principalId,
            status: "active" as const,
            user: userMap.get(member.principalId) ?? null,
          },
        ]
      : [],
  );
}

function inviteStateWhereClause(
  state: "active" | "accepted" | "expired" | "revoked" | undefined,
) {
  const now = new Date();
  switch (state) {
    case "active":
      return and(
        isNull(invites.revokedAt),
        isNull(invites.acceptedAt),
        gt(invites.expiresAt, now),
      );
    case "accepted":
      return isNotNull(invites.acceptedAt);
    case "expired":
      return and(
        isNull(invites.revokedAt),
        isNull(invites.acceptedAt),
        lte(invites.expiresAt, now),
      );
    case "revoked":
      return isNotNull(invites.revokedAt);
    default:
      return undefined;
  }
}

async function loadCompanyInviteRecords(
  db: Db,
  companyId: string,
  options: {
    state?: "active" | "accepted" | "expired" | "revoked";
    limit: number;
    offset: number;
  },
) {
  const whereClause = inviteStateWhereClause(options.state);
  const rows = await db
    .select()
    .from(invites)
    .where(
      whereClause
        ? and(eq(invites.companyId, companyId), whereClause)
        : eq(invites.companyId, companyId),
    )
    .orderBy(desc(invites.createdAt))
    .limit(options.limit + 1)
    .offset(options.offset);
  const hasMore = rows.length > options.limit;
  const visibleRows = hasMore ? rows.slice(0, options.limit) : rows;
  const userIds = [
    ...new Set(
      visibleRows
        .map((invite) => invite.invitedByUserId)
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  const [userMap, joinRows, companyName] = await Promise.all([
    loadUsersById(db, userIds),
    visibleRows.length
      ? db
          .select({ id: joinRequests.id, inviteId: joinRequests.inviteId })
          .from(joinRequests)
          .where(
            and(
              eq(joinRequests.companyId, companyId),
              inArray(
                joinRequests.inviteId,
                visibleRows.map((invite) => invite.id),
              ),
            ),
          )
      : Promise.resolve([]),
    db
      .select({ name: companies.name })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((companyRows) => companyRows[0]?.name ?? null),
  ]);
  const joinRequestIdByInviteId = new Map(
    joinRows.map((row: { inviteId: string; id: string }) => [
      row.inviteId,
      row.id,
    ]),
  );

  return {
    invites: visibleRows.map((invite) => ({
      ...invite,
      companyName,
      userRole: extractInviteUserRole(invite),
      state: inviteState(invite),
      invitedByUser: invite.invitedByUserId
        ? (userMap.get(invite.invitedByUserId) ?? null)
        : null,
      relatedJoinRequestId: joinRequestIdByInviteId.get(invite.id) ?? null,
    })),
    nextOffset: hasMore ? options.offset + options.limit : null,
  };
}

async function loadJoinRequestRecords(db: Db, companyId: string) {
  const rows = collapseDuplicatePendingUserJoinRequests(
    await db
      .select()
      .from(joinRequests)
      .where(eq(joinRequests.companyId, companyId))
      .orderBy(desc(joinRequests.createdAt)),
  );
  const inviteIds = [...new Set(rows.map((row) => row.inviteId))];
  const inviteRows = inviteIds.length
    ? await db.select().from(invites).where(inArray(invites.id, inviteIds))
    : [];
  const userIds = [
    ...new Set(
      [
        ...rows.map((row) => row.requestingUserId),
        ...rows.map((row) => row.approvedByUserId),
        ...rows.map((row) => row.rejectedByUserId),
        ...inviteRows.map((invite) => invite.invitedByUserId),
      ].filter((value): value is string => Boolean(value)),
    ),
  ];
  const userMap = await loadUsersById(db, userIds);
  const inviteMap = new Map(inviteRows.map((invite) => [invite.id, invite]));

  return rows.map((row) => {
    const invite = inviteMap.get(row.inviteId) ?? null;
    return {
      ...toJoinRequestResponse(row),
      requesterUser: row.requestingUserId
        ? (userMap.get(row.requestingUserId) ?? null)
        : null,
      approvedByUser: row.approvedByUserId
        ? (userMap.get(row.approvedByUserId) ?? null)
        : null,
      rejectedByUser: row.rejectedByUserId
        ? (userMap.get(row.rejectedByUserId) ?? null)
        : null,
      invite: invite
        ? {
            id: invite.id,
            inviteType: invite.inviteType,
            userRole: extractInviteUserRole(invite),
            createdAt: invite.createdAt,
            expiresAt: invite.expiresAt,
            revokedAt: invite.revokedAt,
            acceptedAt: invite.acceptedAt,
            invitedByUser: invite.invitedByUserId
              ? (userMap.get(invite.invitedByUserId) ?? null)
              : null,
          }
        : null,
    };
  });
}

async function loadUserCompanyAccessResponse(
  db: Db,
  access: ReturnType<typeof accessService>,
  userId: string,
) {
  const [memberships, user, isInstanceAdmin] = await Promise.all([
    access.listUserCompanyAccess(userId),
    db
      .select({
        id: authUsers.id,
        email: authUsers.email,
        name: authUsers.name,
        image: authUsers.image,
      })
      .from(authUsers)
      .where(eq(authUsers.id, userId))
      .then((rows) => rows[0] ?? null),
    access.isInstanceAdmin(userId),
  ]);
  const companyIds = [
    ...new Set(memberships.map((membership) => membership.companyId)),
  ];
  const companyRows = companyIds.length
    ? await db
        .select({
          id: companies.id,
          name: companies.name,
          status: companies.status,
        })
        .from(companies)
        .where(inArray(companies.id, companyIds))
    : [];
  const companyMap = new Map(
    companyRows.map((company) => [company.id, company]),
  );

  return {
    user: user
      ? {
          ...toUserProfile(user),
          isInstanceAdmin,
        }
      : null,
    companyAccess: memberships.map((membership) => {
      const company = companyMap.get(membership.companyId) ?? null;
      return {
        ...membership,
        principalType: "user" as const,
        companyName: company?.name ?? null,
        companyStatus: company?.status ?? null,
      };
    }),
  };
}

function requestIp(req: Request) {
  const forwarded = req.header("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.ip || "unknown";
}

function inviteExpired(invite: typeof invites.$inferSelect) {
  return invite.expiresAt.getTime() <= Date.now();
}

function inviteState(invite: typeof invites.$inferSelect) {
  if (invite.revokedAt) return "revoked" as const;
  if (invite.acceptedAt) return "accepted" as const;
  if (inviteExpired(invite)) return "expired" as const;
  return "active" as const;
}

function extractInviteUserRole(invite: typeof invites.$inferSelect) {
  if (invite.inviteType === "bootstrap_admin") {
    return null;
  }
  return resolveUserInviteRole(
    invite.defaultsPayload as Record<string, unknown> | null | undefined,
  );
}

function toUserProfile(
  user:
    | {
        id: string;
        email: string | null;
        name: string | null;
        image?: string | null;
      }
    | null
    | undefined,
) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email ?? null,
    name: user.name ?? null,
    image: user.image ?? null,
  };
}

async function resolveActorEmail(db: Db, req: Request): Promise<string | null> {
  const userId = req.actor.userId;
  if (!userId) return null;
  const user = await db
    .select({ email: authUsers.email })
    .from(authUsers)
    .where(eq(authUsers.id, userId))
    .then((rows) => rows[0] ?? null);
  return user?.email ?? null;
}

async function resolveAcceptedInviteJoinRequest(
  db: Db,
  req: Request,
  invite: typeof invites.$inferSelect | null,
) {
  if (!invite?.acceptedAt) return null;

  const directJoinRequest = await db
    .select({
      status: joinRequests.status,
      requestingUserId: joinRequests.requestingUserId,
      requestEmailSnapshot: joinRequests.requestEmailSnapshot,
    })
    .from(joinRequests)
    .where(eq(joinRequests.inviteId, invite.id))
    .then((rows) => rows[0] ?? null);
  if (directJoinRequest) return directJoinRequest;

  if (!invite.companyId) return null;

  const actorRequestingUserId = req.actor.userId;
  const actorEmail = await resolveActorEmail(db, req);
  if (!actorRequestingUserId && !actorEmail) return null;

  return findReusableUserJoinRequest(
    await db
      .select({
        id: joinRequests.id,
        status: joinRequests.status,
        requestingUserId: joinRequests.requestingUserId,
        requestEmailSnapshot: joinRequests.requestEmailSnapshot,
      })
      .from(joinRequests)
      .where(eq(joinRequests.companyId, invite.companyId))
      .orderBy(desc(joinRequests.createdAt)),
    {
      requestingUserId: actorRequestingUserId,
      requestEmailSnapshot: actorEmail,
    },
  );
}

export function accessRoutes(
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
  router.use("/invites/:token", (req, res, next) => {
    const result = inviteRateLimiter.consume(
      req.ip || req.socket?.remoteAddress || "unknown",
    );
    res.setHeader("X-RateLimit-Limit", String(result.limit));
    res.setHeader("X-RateLimit-Remaining", String(result.remaining));
    if (!result.allowed) {
      res.setHeader("Retry-After", String(result.retryAfterSeconds));
      next(
        tooManyRequests("Too many invite requests", {
          retryAfterSeconds: result.retryAfterSeconds,
        }),
      );
      return;
    }
    next();
  });

  async function assertInstanceAdmin(req: Request) {
    assertBoard(req);
    const allowed = await access.isInstanceAdmin(req.actor.userId);
    if (!allowed) throw forbidden("Instance admin required");
  }

  router.post("/bootstrap/claim", async (req, res) => {
    if (opts.deploymentExposure !== "private") {
      throw notFound("Browser first-admin claim is not available");
    }
    if (
      req.actor.type !== "board" ||
      req.actor.source !== "session" ||
      !req.actor.userId
    ) {
      throw unauthorized(
        "Sign in from a browser session before claiming first admin",
      );
    }

    const claimed = await claimFirstInstanceAdmin(db, {
      userId: req.actor.userId,
    });
    if (claimed.status === "already_claimed") {
      throw conflict("Someone else has already claimed this instance");
    }

    res.json({ claimed: true, userId: claimed.userId });
  });

  router.post(
    "/cli-auth/challenges",
    validate(createCliAuthChallengeSchema),
    async (req, res) => {
      const created = await boardAuth.createCliAuthChallenge(req.body);
      const approvalPath = buildCliAuthApprovalPath(
        created.challenge.id,
        created.challengeSecret,
      );
      const baseUrl = requestBaseUrl(req);
      res.status(201).json({
        id: created.challenge.id,
        token: created.challengeSecret,
        boardApiToken: created.pendingBoardToken,
        approvalPath,
        approvalUrl: baseUrl ? `${baseUrl}${approvalPath}` : null,
        pollPath: `/cli-auth/challenges/${created.challenge.id}`,
        expiresAt: created.challenge.expiresAt.toISOString(),
        suggestedPollIntervalMs: 1000,
      });
    },
  );

  router.get("/cli-auth/challenges/:id", async (req, res) => {
    const id = req.params.id as string;
    assertExactQueryKeys(req.query, ["token"]);
    const token = req.query.token;
    if (
      !isCanonicalUuid(id) ||
      typeof token !== "string" ||
      token.length === 0
    ) {
      throw notFound("CLI auth challenge not found");
    }
    const challenge = await boardAuth.describeCliAuthChallenge(id, token);
    if (!challenge) throw notFound("CLI auth challenge not found");

    const isSignedInBoardUser =
      req.actor.type === "board" &&
      req.actor.source === "session" &&
      Boolean(req.actor.userId);
    const canApprove =
      isSignedInBoardUser &&
      (challenge.requestedAccess !== "instance_admin_required" ||
        Boolean(req.actor.isInstanceAdmin));

    res.json({
      ...challenge,
      requiresSignIn: !isSignedInBoardUser,
      canApprove,
      currentUserId: req.actor.type === "board" ? req.actor.userId : null,
    });
  });

  router.post(
    "/cli-auth/challenges/:id/approve",
    validate(resolveCliAuthChallengeSchema),
    async (req, res) => {
      const id = req.params.id as string;
      if (req.actor.type !== "board" || !req.actor.userId) {
        throw unauthorized("Sign in before approving CLI access");
      }

      const userId = req.actor.userId;
      const approved = await boardAuth.approveCliAuthChallenge(
        id,
        req.body.token,
        userId,
      );

      if (approved.status === "approved") {
        const companyIds = await boardAuth.resolveBoardActivityCompanyIds({
          userId,
          requestedCompanyId: approved.challenge.requestedCompanyId,
          boardApiKeyId: approved.challenge.boardApiKeyId,
        });
        for (const companyId of companyIds) {
          await logActivity(db, {
            companyId,
            actorType: "user",
            actorId: userId,
            action: "board_api_key.created",
            entityType: "user",
            entityId: userId,
            details: {
              boardApiKeyId: approved.challenge.boardApiKeyId,
              requestedAccess: approved.challenge.requestedAccess,
              requestedCompanyId: approved.challenge.requestedCompanyId,
              challengeId: approved.challenge.id,
            },
          });
        }
      }

      res.json({
        approved: approved.status === "approved",
        status: approved.status,
        userId,
        keyId: approved.challenge.boardApiKeyId ?? null,
        expiresAt: approved.challenge.expiresAt.toISOString(),
      });
    },
  );

  router.post(
    "/cli-auth/challenges/:id/cancel",
    validate(resolveCliAuthChallengeSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const cancelled = await boardAuth.cancelCliAuthChallenge(
        id,
        req.body.token,
      );
      res.json({
        status: cancelled.status,
        cancelled: cancelled.status === "cancelled",
      });
    },
  );

  router.get("/cli-auth/users/:userId", async (req, res) => {
    const userId = req.params.userId as string;
    assertCurrentBoardUser(req, userId);
    const accessSnapshot = await boardAuth.resolveBoardAccess(userId);
    res.json({
      user: accessSnapshot.user,
      userId,
      isInstanceAdmin: accessSnapshot.isInstanceAdmin,
      companyIds: accessSnapshot.companyIds,
      memberships: accessSnapshot.memberships,
      source: req.actor.source,
      keyId:
        req.actor.source === "board_key" ? (req.actor.keyId ?? null) : null,
    });
  });

  router.get("/board-api-keys", async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("Board authentication required");
    }
    assertExactQueryKeys(req.query, ["includeInactive"]);
    const keys = await boardAuth.listBoardApiKeys(req.actor.userId, {
      includeInactive: parseExactBooleanQuery(
        req.query.includeInactive,
        "includeInactive",
      ),
    });
    res.json(keys);
  });

  router.post(
    "/board-api-keys",
    validate(createBoardApiKeySchema),
    async (req, res) => {
      if (req.actor.type !== "board" || !req.actor.userId) {
        throw unauthorized("Board authentication required");
      }

      if (req.body.requestedCompanyId) {
        assertCompanyAccess(req, req.body.requestedCompanyId);
      }

      const key = await boardAuth.createNamedBoardApiKey({
        userId: req.actor.userId,
        name: req.body.name,
        expiresAt:
          req.body.expiresAt === undefined ? undefined : req.body.expiresAt,
      });
      const companyIds = await boardAuth.resolveBoardActivityCompanyIds({
        userId: req.actor.userId,
        requestedCompanyId: req.body.requestedCompanyId ?? null,
        boardApiKeyId: key.id,
      });
      for (const companyId of companyIds) {
        await logActivity(db, {
          companyId,
          actorType: "user",
          actorId: req.actor.userId,
          action: "board_api_key.created",
          entityType: "user",
          entityId: req.actor.userId,
          details: {
            boardApiKeyId: key.id,
            name: key.name,
            requestedCompanyId: req.body.requestedCompanyId ?? null,
            expiresAt: key.expiresAt?.toISOString() ?? null,
          },
        });
      }

      res.status(201).json(key);
    },
  );

  router.delete("/board-api-keys/:keyId", async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("Board authentication required");
    }
    const keyId = req.params.keyId as string;
    if (!isCanonicalUuid(keyId)) {
      throw badRequest("Invalid board API key ID");
    }
    const key = await boardAuth.getBoardApiKeyForUser(keyId, req.actor.userId);
    if (!key) throw notFound("Board API key not found");
    const revoked = await boardAuth.revokeBoardApiKey(key.id);
    if (!revoked) throw notFound("Board API key not found");

    const companyIds = await boardAuth.resolveBoardActivityCompanyIds({
      userId: req.actor.userId,
      boardApiKeyId: key.id,
    });
    for (const companyId of companyIds) {
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId,
        action: "board_api_key.revoked",
        entityType: "user",
        entityId: req.actor.userId,
        details: {
          boardApiKeyId: key.id,
          name: key.name,
          revokedVia: "board_api_key_lifecycle",
        },
      });
    }

    res.json({ ok: true, keyId: key.id });
  });

  router.post("/cli-auth/revoke-current", async (req, res) => {
    if (req.actor.type !== "board" || req.actor.source !== "board_key") {
      throw badRequest("Current board API key context is required");
    }
    const key = await boardAuth.assertCurrentBoardKey(
      req.actor.keyId,
      req.actor.userId,
    );
    await boardAuth.revokeBoardApiKey(key.id);
    const companyIds = await boardAuth.resolveBoardActivityCompanyIds({
      userId: key.userId,
      boardApiKeyId: key.id,
    });
    for (const companyId of companyIds) {
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: key.userId,
        action: "board_api_key.revoked",
        entityType: "user",
        entityId: key.userId,
        details: {
          boardApiKeyId: key.id,
          revokedVia: "cli_auth_logout",
        },
      });
    }
    res.json({ revoked: true, keyId: key.id });
  });

  async function assertCompanyPermission(
    req: Request,
    companyId: string,
    permissionKey: PermissionKey,
  ) {
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    const allowed = await access.canUser(
      companyId,
      req.actor.userId,
      permissionKey,
    );
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
    const grants = userJoinGrantsFromDefaults(
      input.invite.defaultsPayload as Record<string, unknown> | null,
    );
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
          const logoObject = await storage.headObject(
            logoAsset.companyId,
            logoAsset.objectKey,
          );
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

  router.post(
    "/companies/:companyId/invites",
    validate(createCompanyInviteSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const invitedByUserId = await assertCompanyPermission(
        req,
        companyId,
        "users:invite",
      );
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

      const companyBranding = await getInviteCompanyBranding(
        created.companyId,
        token,
      );
      const inviteSummary = toInviteSummaryResponse(
        req,
        token,
        created,
        companyBranding,
      );
      res.status(201).json({
        ...created,
        token,
        invitePath: inviteSummary.invitePath,
        inviteUrl: inviteSummary.inviteUrl,
        companyName: companyBranding.name,
      });
    },
  );

  router.get("/invites/:token", async (req, res) => {
    const token = req.params.token as string;
    if (!token) throw notFound("Invite not found");
    const invite = await db
      .select()
      .from(invites)
      .where(eq(invites.tokenHash, hashInviteToken(token)))
      .then((rows) => rows[0] ?? null);
    const inviteJoinRequest = await resolveAcceptedInviteJoinRequest(
      db,
      req,
      invite,
    );
    if (
      !invite ||
      invite.revokedAt ||
      inviteExpired(invite) ||
      (invite.acceptedAt && !inviteJoinRequest)
    ) {
      throw notFound("Invite not found");
    }

    const companyBranding = await getInviteCompanyBranding(
      invite.companyId,
      token,
    );
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
    const inviteJoinRequest = await resolveAcceptedInviteJoinRequest(
      db,
      req,
      invite,
    );
    if (
      !invite ||
      invite.revokedAt ||
      inviteExpired(invite) ||
      (invite.acceptedAt && !inviteJoinRequest)
    ) {
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
      logoAsset.contentType ||
      logoHead.contentType ||
      object.contentType ||
      "application/octet-stream";
    res.setHeader("Content-Type", responseContentType);
    res.setHeader(
      "Content-Length",
      String(
        logoAsset.byteSize ||
          logoHead.contentLength ||
          object.contentLength ||
          0,
      ),
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
    res.setHeader(
      "Content-Disposition",
      `inline; filename=\"${filename.replaceAll('"', "")}\"`,
    );

    object.stream.on("error", (err) => {
      next(err);
    });
    object.stream.pipe(res);
  });

  router.post(
    "/invites/:token/accept",
    validate(acceptInviteSchema),
    async (req, res) => {
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
          throw unauthorized(
            "Authenticated user required for bootstrap acceptance",
          );
        }
        const userId = req.actor.userId;
        const claimed = await claimFirstInstanceAdmin(db, {
          userId,
          onClaim: async (tx) => {
            const updatedInvite = await tx
              .update(invites)
              .set({ acceptedAt: new Date(), updatedAt: new Date() })
              .where(
                and(
                  eq(invites.id, invite.id),
                  isNull(invites.acceptedAt),
                  isNull(invites.revokedAt),
                ),
              )
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
      const replayJoinRequestId = inviteAlreadyAccepted
        ? (existingJoinRequestForInvite?.id ?? null)
        : null;
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
                .where(
                  and(
                    eq(invites.id, invite.id),
                    isNull(invites.acceptedAt),
                    isNull(invites.revokedAt),
                  ),
                );
              return existingUserJoinRequest;
            })
          : await db.transaction(async (tx) => {
              await tx
                .update(invites)
                .set({ acceptedAt: new Date(), updatedAt: new Date() })
                .where(
                  and(
                    eq(invites.id, invite.id),
                    isNull(invites.acceptedAt),
                    isNull(invites.revokedAt),
                  ),
                );

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
        action: inviteAlreadyAccepted
          ? "join.request_replayed"
          : "join.requested",
        entityType: "join_request",
        entityId: created.id,
        details: {
          requestIp: requestIp(req),
          inviteReplay: inviteAlreadyAccepted,
          reusedExistingJoinRequest:
            Boolean(existingUserJoinRequest) && !inviteAlreadyAccepted,
        },
      });

      created = await approveUserJoinRequestFromInvite({
        req,
        invite,
        joinRequest: created,
        companyId,
      });
      res.status(202).json(toJoinRequestResponse(created));
    },
  );

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
    const invitesForCompany = await loadCompanyInviteRecords(
      db,
      companyId,
      query,
    );
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

  router.post(
    "/companies/:companyId/join-requests/:requestId/approve",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const requestId = req.params.requestId as string;
      if (!isCanonicalUuid(requestId)) {
        throw notFound("Join request not found");
      }
      const actorId = await assertCompanyPermission(
        req,
        companyId,
        "joins:approve",
      );
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
    },
  );

  router.post(
    "/companies/:companyId/join-requests/:requestId/reject",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const requestId = req.params.requestId as string;
      if (!isCanonicalUuid(requestId)) {
        throw notFound("Join request not found");
      }
      const actorId = await assertCompanyPermission(
        req,
        companyId,
        "joins:approve",
      );

      const existing = await db
        .select()
        .from(joinRequests)
        .where(
          and(
            eq(joinRequests.companyId, companyId),
            eq(joinRequests.id, requestId),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (!existing) throw notFound("Join request not found");
      if (existing.status !== "pending_approval")
        throw conflict("Join request is not pending");

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
    },
  );

  router.get("/companies/:companyId/members", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyPermission(req, companyId, "users:manage_permissions");
    const [members, currentAccess] = await Promise.all([
      loadCompanyMemberRecords(db, companyId),
      loadCompanyAccessSummary(req, access, companyId),
    ]);
    res.json({
      members: await addCompanyMemberRemovalAccess(
        req,
        db,
        access,
        companyId,
        members,
      ),
      access: currentAccess,
    });
  });

  router.get("/companies/:companyId/user-directory", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const users = await loadCompanyUserDirectory(db, companyId);
    res.json({ users });
  });

  async function handleUpdateCompanyMember(
    req: Request,
    res: Response,
    options: { withGrants: boolean },
  ) {
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
        .where(
          and(
            eq(companyMemberships.companyId, companyId),
            eq(companyMemberships.id, memberId),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (!existing) return null;
      if (existing.principalType !== "user" || !existing.principalUserId) {
        throw conflict("Only user company members can be updated");
      }
      const principalUserId = existing.principalUserId;

      const nextMembershipRole =
        req.body.membershipRole !== undefined
          ? req.body.membershipRole
          : existing.membershipRole;
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
      action: options.withGrants
        ? "company_member.access_updated"
        : "company_member.updated",
      entityType: "company_membership",
      entityId: memberId,
      details: {
        membershipRole: updated.membershipRole,
        status: updated.status,
        ...(options.withGrants
          ? { grantCount: req.body.grants?.length ?? 0 }
          : {}),
      },
    });

    const member = (await loadCompanyMemberRecords(db, companyId)).find(
      (entry) => entry.id === memberId,
    );
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
      await assertCanManageCompanyMember(
        req,
        access,
        companyId,
        memberToArchive,
        "archive",
      );

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

      const member = (
        await loadCompanyMemberRecords(db, companyId, { includeArchived: true })
      ).find((entry) => entry.id === memberId);
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
      await assertCanManageCompanyMember(
        req,
        access,
        companyId,
        memberToUpdate,
      );
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
      const member = (await loadCompanyMemberRecords(db, companyId)).find(
        (entry) => entry.id === memberId,
      );
      if (!member) throw notFound("Member not found");
      res.json(member);
    },
  );

  router.post(
    "/admin/users/:userId/promote-instance-admin",
    async (req, res) => {
      await assertInstanceAdmin(req);
      const userId = req.params.userId as string;
      const result = await access.promoteInstanceAdmin(userId);
      res.status(201).json(result);
    },
  );

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
        userIds.map(async (userId) =>
          (await access.isInstanceAdmin(userId)) ? userId : null,
        ),
      ).then((values) =>
        values.filter((value): value is string => Boolean(value)),
      ),
    );

    res.json(
      filteredUsers.slice(0, 50).map((user) => ({
        ...toUserProfile(user),
        isInstanceAdmin: adminIds.has(user.id),
        activeCompanyMembershipCount: membershipCountByUserId.get(user.id) ?? 0,
      })),
    );
  });

  router.post(
    "/admin/users/:userId/demote-instance-admin",
    async (req, res) => {
      await assertInstanceAdmin(req);
      const userId = req.params.userId as string;
      const removed = await access.demoteInstanceAdmin(userId);
      if (!removed) throw notFound("Instance admin role not found");
      res.json(removed);
    },
  );

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

  return router;
}
