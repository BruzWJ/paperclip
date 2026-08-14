import { type Db, principalPermissionGrants } from "@paperclipai/db";
import {
  grantsForUserRole,
  type UserCompanyMembershipRole,
  type PermissionKey,
  type PrincipalType,
} from "@paperclipai/shared";
import { requireUserRole } from "./company-member-roles.js";

type GrantInput = {
  permissionKey: PermissionKey;
  scope?: Record<string, unknown> | null;
};

export async function insertMissingPrincipalGrants(
  db: Db,
  input: {
    companyId: string;
    principalType: PrincipalType;
    principalId: string;
    grants: GrantInput[];
    grantedByUserId: string | null;
  },
): Promise<number> {
  if (input.grants.length === 0) return 0;
  const now = new Date();
  const inserted = await db
    .insert(principalPermissionGrants)
    .values(
      input.grants.map((grant) => ({
        companyId: input.companyId,
        principalType: input.principalType,
        principalUserId: input.principalType === "user" ? input.principalId : null,
        principalAgentId: input.principalType === "agent" ? input.principalId : null,
        permissionKey: grant.permissionKey,
        scope: grant.scope ?? null,
        grantedByUserId: input.grantedByUserId,
        createdAt: now,
        updatedAt: now,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: principalPermissionGrants.id });
  return inserted.length;
}

/**
 * Stamps the preserved user-member role grants only at an explicit
 * membership create/change boundary. Authentication never invokes this as a
 * lazy repair path.
 */
export async function stampUserMemberRoleGrants(
  db: Db,
  input: {
    companyId: string;
    principalId: string;
    membershipRole: UserCompanyMembershipRole;
    grantedByUserId: string | null;
  },
): Promise<number> {
  const role = requireUserRole(input.membershipRole);
  return insertMissingPrincipalGrants(db, {
    companyId: input.companyId,
    principalType: "user",
    principalId: input.principalId,
    grants: grantsForUserRole(role),
    grantedByUserId: input.grantedByUserId,
  });
}
