import {
  type Db,
  companyMemberships,
  instanceUserRoles,
  invites,
  principalPermissionGrants,
} from "@paperclipai/db";
import type { PermissionKey, UserCompanyMembershipRole } from "@paperclipai/shared";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import type { Request } from "express";
import { forbidden } from "../errors.js";
import { requireRequestAuthority } from "../http/request-authority.js";
import { requireUserRole } from "../services/company-member-roles.js";
import { accessService } from "../services/index.js";
import { extractInviteUserRole, loadUsersById, toJoinRequestResponse } from "./access-route-records.js";

export { loadUsersById, toJoinRequestResponse };

export type MemberGrantPayload = {
  permissionKey: PermissionKey;
  scope?: Record<string, unknown> | null;
};

export function requestBaseUrl(req: Request) {
  return requireRequestAuthority(req).origin;
}

export function buildCliAuthApprovalPath(challengeId: string, token: string) {
  return `/cli-auth/${challengeId}?token=${encodeURIComponent(token)}`;
}

export function toInviteSummaryResponse(
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
    typeof company === "string" ? { name: company, brandColor: null, logoUrl: null } : company;
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

export function actorHasActiveUserMembership(req: Request, companyId: string) {
  return (
    req.actor.type === "board" &&
    typeof req.actor.userId === "string" &&
    Array.isArray(req.actor.memberships) &&
    req.actor.memberships.some(
      (membership) => membership.companyId === companyId && membership.status === "active",
    )
  );
}

export async function loadCompanyAccessSummary(
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
  const membership = userId ? await access.getMembership(companyId, "user", userId) : null;
  const [canManageMembers, canInviteUsers, canApproveJoinRequests] = await Promise.all([
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

export async function loadCompanyMemberRecords(
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
        options.includeArchived ? undefined : ne(companyMemberships.status, "archived"),
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

export type CompanyMemberRecord = Awaited<ReturnType<typeof loadCompanyMemberRecords>>[number];

export const userRoleRank: Record<UserCompanyMembershipRole, number> = {
  viewer: 1,
  operator: 2,
  admin: 3,
  owner: 4,
};

export async function resolveActorUserRole(
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

export async function getProtectedMemberReason(
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
  if (member.principalType !== "user") return "Only user company members can be removed.";
  if (req.actor.type !== "board") return "Board access is required to remove members.";
  if (member.principalId === req.actor.userId) return "You cannot remove yourself.";
  const isTargetInstanceAdmin = opts?.instanceAdminUserIds
    ? opts.instanceAdminUserIds.has(member.principalId)
    : await access.isInstanceAdmin(member.principalId);
  if (isTargetInstanceAdmin) {
    return "Instance admins cannot be removed from company access.";
  }

  const targetRole = requireUserRole(member.membershipRole);
  if (opts?.operation === "archive") {
    if (targetRole === "owner") return "Board owners cannot be removed from company access.";
    if (targetRole === "admin") return "Company admins cannot be removed from company access.";
  }

  const actorRole = opts?.actorRole ?? (await resolveActorUserRole(req, access, companyId));
  if (!actorRole) return "Only active company members can remove users.";
  if (userRoleRank[targetRole] >= userRoleRank[actorRole]) {
    return "You can only remove users below your company role.";
  }

  return null;
}

export async function assertCanManageCompanyMember(
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
  const reason = await getProtectedMemberReason(req, access, companyId, member, { operation });
  if (reason) throw forbidden(reason);
}

export async function addCompanyMemberRemovalAccess(
  req: Request,
  db: Db,
  access: ReturnType<typeof accessService>,
  companyId: string,
  members: CompanyMemberRecord[],
) {
  const actorRole = await resolveActorUserRole(req, access, companyId);
  const userIds = [
    ...new Set(
      members.filter((member) => member.principalType === "user").map((member) => member.principalId),
    ),
  ];
  const instanceAdminUserIds =
    userIds.length > 0
      ? new Set(
          await db
            .select({ userId: instanceUserRoles.userId })
            .from(instanceUserRoles)
            .where(
              and(inArray(instanceUserRoles.userId, userIds), eq(instanceUserRoles.role, "instance_admin")),
            )
            .then((rows) => rows.map((row) => row.userId)),
        )
      : new Set<string>();
  return Promise.all(
    members.map(async (member) => {
      const reason = await getProtectedMemberReason(req, access, companyId, member, {
        actorRole,
        instanceAdminUserIds,
        operation: "archive",
      });
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

export async function loadCompanyUserDirectory(db: Db, companyId: string) {
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
