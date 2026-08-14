import { type Db, authUsers, companies, invites, joinRequests } from "@paperclipai/db";
import { and, desc, eq, gt, inArray, isNotNull, isNull, lte } from "drizzle-orm";
import type { Request } from "express";
import {
  collapseDuplicatePendingUserJoinRequests,
  findReusableUserJoinRequest,
} from "../lib/join-request-dedupe.js";
import { accessService } from "../services/index.js";
import {
  extractInviteUserRole,
  loadUsersById,
  toJoinRequestResponse,
  toUserProfile,
} from "./access-route-records.js";

export { extractInviteUserRole, toUserProfile };

export function inviteStateWhereClause(state: "active" | "accepted" | "expired" | "revoked" | undefined) {
  const now = new Date();
  switch (state) {
    case "active":
      return and(isNull(invites.revokedAt), isNull(invites.acceptedAt), gt(invites.expiresAt, now));
    case "accepted":
      return isNotNull(invites.acceptedAt);
    case "expired":
      return and(isNull(invites.revokedAt), isNull(invites.acceptedAt), lte(invites.expiresAt, now));
    case "revoked":
      return isNotNull(invites.revokedAt);
    default:
      return undefined;
  }
}

export async function loadCompanyInviteRecords(
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
      whereClause ? and(eq(invites.companyId, companyId), whereClause) : eq(invites.companyId, companyId),
    )
    .orderBy(desc(invites.createdAt))
    .limit(options.limit + 1)
    .offset(options.offset);
  const hasMore = rows.length > options.limit;
  const visibleRows = hasMore ? rows.slice(0, options.limit) : rows;
  const userIds = [
    ...new Set(
      visibleRows.map((invite) => invite.invitedByUserId).filter((value): value is string => Boolean(value)),
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
    joinRows.map((row: { inviteId: string; id: string }) => [row.inviteId, row.id]),
  );

  return {
    invites: visibleRows.map((invite) => ({
      ...invite,
      companyName,
      userRole: extractInviteUserRole(invite),
      state: inviteState(invite),
      invitedByUser: invite.invitedByUserId ? (userMap.get(invite.invitedByUserId) ?? null) : null,
      relatedJoinRequestId: joinRequestIdByInviteId.get(invite.id) ?? null,
    })),
    nextOffset: hasMore ? options.offset + options.limit : null,
  };
}

export async function loadJoinRequestRecords(db: Db, companyId: string) {
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
      requesterUser: row.requestingUserId ? (userMap.get(row.requestingUserId) ?? null) : null,
      approvedByUser: row.approvedByUserId ? (userMap.get(row.approvedByUserId) ?? null) : null,
      rejectedByUser: row.rejectedByUserId ? (userMap.get(row.rejectedByUserId) ?? null) : null,
      invite: invite
        ? {
            id: invite.id,
            inviteType: invite.inviteType,
            userRole: extractInviteUserRole(invite),
            createdAt: invite.createdAt,
            expiresAt: invite.expiresAt,
            revokedAt: invite.revokedAt,
            acceptedAt: invite.acceptedAt,
            invitedByUser: invite.invitedByUserId ? (userMap.get(invite.invitedByUserId) ?? null) : null,
          }
        : null,
    };
  });
}

export async function loadUserCompanyAccessResponse(
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
  const companyIds = [...new Set(memberships.map((membership) => membership.companyId))];
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
  const companyMap = new Map(companyRows.map((company) => [company.id, company]));

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

export function requestIp(req: Request) {
  const forwarded = req.header("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.ip || "unknown";
}

export function inviteExpired(invite: typeof invites.$inferSelect) {
  return invite.expiresAt.getTime() <= Date.now();
}

export function inviteState(invite: typeof invites.$inferSelect) {
  if (invite.revokedAt) return "revoked" as const;
  if (invite.acceptedAt) return "accepted" as const;
  if (inviteExpired(invite)) return "expired" as const;
  return "active" as const;
}

export async function resolveActorEmail(db: Db, req: Request): Promise<string | null> {
  const userId = req.actor.userId;
  if (!userId) return null;
  const user = await db
    .select({ email: authUsers.email })
    .from(authUsers)
    .where(eq(authUsers.id, userId))
    .then((rows) => rows[0] ?? null);
  return user?.email ?? null;
}

export async function resolveAcceptedInviteJoinRequest(
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
