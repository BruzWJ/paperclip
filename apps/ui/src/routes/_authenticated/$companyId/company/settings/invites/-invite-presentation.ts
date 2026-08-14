import { accessApi } from "@/api/access";

export const inviteRoleOptions = [
  {
    value: "viewer",
    label: "Viewer",
    description: "Can view company work and follow along. View-only company membership.",
  },
  {
    value: "operator",
    label: "Operator",
    description:
      "Recommended for people who need to help run work without managing access. Can assign tasks.",
  },
  {
    value: "admin",
    label: "Admin",
    description:
      "Recommended for operators who need to invite people, create agents, and approve joins. Can create agents, invite users, assign tasks, and approve join requests.",
  },
  {
    value: "owner",
    label: "Owner",
    description:
      "Full company access, including membership management. Everything in Admin, plus managing members.",
  },
] as const;

export const INVITE_HISTORY_PAGE_SIZE = 5;

export type InviteHistoryRow = Awaited<ReturnType<typeof accessApi.listInvites>>["invites"][number];

export function isInviteHistoryRow(value: unknown): value is InviteHistoryRow {
  return Boolean(
    value && typeof value === "object" && "id" in value && "state" in value && "createdAt" in value,
  );
}

export function formatInviteState(state: "active" | "accepted" | "expired" | "revoked") {
  return state.charAt(0).toUpperCase() + state.slice(1);
}

export function formatInviteAudience(invite: InviteHistoryRow) {
  return invite.userRole ?? "User";
}
