import {
  USER_COMPANY_MEMBERSHIP_ROLES,
  type UserCompanyMembershipRole,
} from "@paperclipai/shared";

export function requireUserRole(value: unknown): UserCompanyMembershipRole {
  if (
    !USER_COMPANY_MEMBERSHIP_ROLES.includes(value as UserCompanyMembershipRole)
  ) {
    throw new Error(`Invalid user company membership role: ${String(value)}`);
  }
  return value as UserCompanyMembershipRole;
}

export function resolveUserInviteRole(
  defaultsPayload: Record<string, unknown> | null | undefined,
): UserCompanyMembershipRole {
  if (!defaultsPayload || typeof defaultsPayload !== "object") {
    throw new Error("User invite defaults are missing");
  }
  const scoped = defaultsPayload.user;
  if (!scoped || typeof scoped !== "object" || Array.isArray(scoped)) {
    throw new Error("User invite defaults are missing a role");
  }
  return requireUserRole((scoped as Record<string, unknown>).role);
}
