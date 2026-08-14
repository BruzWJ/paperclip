import { type Db, authUsers, invites, joinRequests } from "@paperclipai/db";
import { inArray } from "drizzle-orm";
import { resolveUserInviteRole } from "../services/company-member-roles.js";

export function toJoinRequestResponse(row: typeof joinRequests.$inferSelect) {
  return row;
}

export function extractInviteUserRole(invite: typeof invites.$inferSelect) {
  if (invite.inviteType === "bootstrap_admin") {
    return null;
  }
  return resolveUserInviteRole(invite.defaultsPayload as Record<string, unknown> | null | undefined);
}

export function toUserProfile(
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

export async function loadUsersById(db: Db, userIds: string[]) {
  if (userIds.length === 0) return new Map<string, ReturnType<typeof toUserProfile>>();
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
