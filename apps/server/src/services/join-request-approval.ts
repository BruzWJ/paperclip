import { and, eq } from "drizzle-orm";
import { invites, joinRequests, type Db } from "@paperclipai/db";
import { conflict, notFound } from "../errors.js";
import { accessService } from "./access.js";
import {
  persistActivityLog,
  publishCommittedActivity,
} from "./activity-log.js";
import { resolveUserInviteRole } from "./company-member-roles.js";
import { userJoinGrantsFromDefaults } from "./invite-grants.js";
import type { AuthorizationActor } from "./authorization.js";

type JoinApprovalTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface JoinRequestApprovalInput {
  companyId: string;
  requestId: string;
  actor: {
    actorId: string;
    userId: string;
    authorization: Extract<AuthorizationActor, { type: "board" }>;
  };
}

/** Activates an invite-backed user membership and grants atomically. */
export function createJoinRequestApprovalService(db: Db) {
  async function approveInTransaction(
    tx: JoinApprovalTransaction,
    input: JoinRequestApprovalInput,
  ) {
    const txDb = tx as unknown as Db;
    const joinRequest = await tx
      .select()
      .from(joinRequests)
      .where(
        and(
          eq(joinRequests.companyId, input.companyId),
          eq(joinRequests.id, input.requestId),
        ),
      )
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!joinRequest) throw notFound("Join request not found");
    if (joinRequest.status === "approved") {
      return { approved: joinRequest, activity: null };
    }
    if (joinRequest.status !== "pending_approval") {
      throw conflict("Join request is not pending");
    }
    if (!joinRequest.requestingUserId) {
      throw conflict("Join request missing user identity");
    }

    const invite = await tx
      .select()
      .from(invites)
      .where(eq(invites.id, joinRequest.inviteId))
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!invite) throw notFound("Invite not found");
    if (invite.companyId !== input.companyId) {
      throw conflict("Join request invite does not belong to this company");
    }

    const access = accessService(txDb);
    await access.ensureMembership(
      input.companyId,
      "user",
      joinRequest.requestingUserId,
      resolveUserInviteRole(
        invite.defaultsPayload as Record<string, unknown> | null,
      ),
      "active",
    );
    await access.setPrincipalGrants(
      input.companyId,
      "user",
      joinRequest.requestingUserId,
      userJoinGrantsFromDefaults(
        invite.defaultsPayload as Record<string, unknown> | null,
      ),
      input.actor.userId,
    );

    const now = new Date();
    const approved = await tx
      .update(joinRequests)
      .set({
        status: "approved",
        approvedByUserId: input.actor.userId,
        approvedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(joinRequests.id, joinRequest.id),
          eq(joinRequests.companyId, input.companyId),
          eq(joinRequests.status, "pending_approval"),
        ),
      )
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!approved) throw conflict("Join request was resolved concurrently");

    const activity = await persistActivityLog(txDb, {
      companyId: input.companyId,
      actorType: "user",
      actorId: input.actor.userId,
      action: "join.approved",
      entityType: "join_request",
      entityId: joinRequest.id,
      details: null,
    });
    return { approved, activity };
  }

  return {
    async approve(input: JoinRequestApprovalInput) {
      const committed = await db.transaction((tx) =>
        approveInTransaction(tx, input),
      );
      if (committed.activity) publishCommittedActivity(committed.activity);
      return committed.approved;
    },
  };
}
