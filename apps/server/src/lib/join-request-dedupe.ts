import { joinRequests } from "@paperclipai/db";

type JoinRequestLike = Pick<
  typeof joinRequests.$inferSelect,
  | "id"
  | "status"
  | "requestingUserId"
  | "requestEmailSnapshot"
  | "createdAt"
  | "updatedAt"
>;

function nonEmptyTrimmed(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function normalizeJoinRequestEmail(
  email: string | null | undefined,
): string | null {
  const trimmed = nonEmptyTrimmed(email);
  return trimmed ? trimmed.toLowerCase() : null;
}

export function userJoinRequestIdentity(
  row: Pick<JoinRequestLike, "requestingUserId" | "requestEmailSnapshot">,
): string | null {
  const requestingUserId = nonEmptyTrimmed(row.requestingUserId);
  if (requestingUserId) return `user:${requestingUserId}`;
  const email = normalizeJoinRequestEmail(row.requestEmailSnapshot);
  return email ? `email:${email}` : null;
}

export function findReusableUserJoinRequest<
  T extends Pick<
    JoinRequestLike,
    "id" | "status" | "requestingUserId" | "requestEmailSnapshot"
  >,
>(
  rows: T[],
  actor: {
    requestingUserId?: string | null;
    requestEmailSnapshot?: string | null;
  },
): T | null {
  const actorUserId = nonEmptyTrimmed(actor.requestingUserId);
  if (actorUserId) {
    const sameUser = rows.find(
      (row) =>
        (row.status === "pending_approval" || row.status === "approved") &&
        row.requestingUserId === actorUserId,
    );
    if (sameUser) return sameUser;
  }

  const actorEmail = normalizeJoinRequestEmail(actor.requestEmailSnapshot);
  if (!actorEmail) return null;
  return (
    rows.find(
      (row) =>
        (row.status === "pending_approval" || row.status === "approved") &&
        normalizeJoinRequestEmail(row.requestEmailSnapshot) === actorEmail,
    ) ?? null
  );
}

export function collapseDuplicatePendingUserJoinRequests<
  T extends Pick<
    JoinRequestLike,
    "id" | "status" | "requestingUserId" | "requestEmailSnapshot"
  >,
>(rows: T[]): T[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (row.status !== "pending_approval") {
      return true;
    }
    const identity = userJoinRequestIdentity(row);
    if (!identity) return true;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}
