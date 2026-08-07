import type { Request, RequestHandler } from "express";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  companyMemberships,
  instanceUserRoles,
} from "@paperclipai/db";
import type { BetterAuthSessionResult } from "../auth/better-auth.js";
import { isNonEmptyActorId } from "../http/request-actor.js";
import { logger } from "./logger.js";
import { boardAuthService } from "../services/board-auth.js";

interface ActorMiddlewareOptions {
  resolveSession: (req: Request) => Promise<BetterAuthSessionResult | null>;
}

export function actorMiddleware(db: Db, opts: ActorMiddlewareOptions): RequestHandler {
  const boardAuth = boardAuthService(db);
  return async (req, _res, next) => {
    req.actor = { type: "none", source: "none" };

    const authHeader = req.header("authorization");
    if (!authHeader?.toLowerCase().startsWith("bearer ")) {
      let session: BetterAuthSessionResult | null = null;
      try {
        session = await opts.resolveSession(req);
      } catch (err) {
        logger.warn(
          { err, method: req.method, url: req.originalUrl },
          "Failed to resolve auth session from request headers",
        );
      }
      if (
        isNonEmptyActorId(session?.user?.id)
        && isNonEmptyActorId(session.session?.id)
        && isNonEmptyActorId(session.session.userId)
        && session.session.userId === session.user.id
      ) {
        const userId = session.user.id.trim();
        const sessionId = session.session.id.trim();
        const [roleRow, memberships] = await Promise.all([
          db
            .select({ id: instanceUserRoles.id })
            .from(instanceUserRoles)
            .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
            .then((rows) => rows[0] ?? null),
          db
            .select({
              companyId: companyMemberships.companyId,
              membershipRole: companyMemberships.membershipRole,
              status: companyMemberships.status,
            })
            .from(companyMemberships)
            .where(
              and(
                eq(companyMemberships.principalType, "user"),
                eq(companyMemberships.principalUserId, userId),
                eq(companyMemberships.status, "active"),
              ),
            ),
        ]);
        req.actor = {
          type: "board",
          userId,
          sessionId,
          userName: session.user.name ?? null,
          userEmail: session.user.email ?? null,
          companyIds: memberships.map((row) => row.companyId),
          memberships,
          isInstanceAdmin: Boolean(roleRow),
          source: "session",
        };
        next();
        return;
      }
      next();
      return;
    }

    const token = authHeader.slice("bearer ".length).trim();
    if (!token) {
      next();
      return;
    }

    const boardKey = await boardAuth.findBoardApiKeyByToken(token);
    if (
      boardKey
      && isNonEmptyActorId(boardKey.id)
      && isNonEmptyActorId(boardKey.userId)
    ) {
      const boardKeyId = boardKey.id.trim();
      const boardUserId = boardKey.userId.trim();
      const access = await boardAuth.resolveBoardAccess(boardUserId);
      if (access.user?.id === boardUserId) {
        await boardAuth.touchBoardApiKey(boardKey.id);
        req.actor = {
          type: "board",
          userId: boardUserId,
          userName: access.user?.name ?? null,
          userEmail: access.user?.email ?? null,
          companyIds: access.companyIds,
          memberships: access.memberships,
          isInstanceAdmin: access.isInstanceAdmin,
          keyId: boardKeyId,
          source: "board_key",
        };
        next();
        return;
      }
    }

    // Authorization bearers on the generic API authenticate board keys only.
    // Run-interface bearers are verified inside their own route and must never
    // inherit local-trusted board authority.
    req.actor = { type: "none", source: "none" };
    next();
  };
}
