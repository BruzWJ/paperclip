import type { Request, Response } from "express";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { authUsers, companyMemberships } from "@paperclipai/db";
import { forbidden, unauthorized } from "../errors.js";
import {
  isBoardActor,
  type BoardActor,
  type RequestActor,
} from "../http/request-actor.js";

type RequestWithActor<TActor extends RequestActor> =
  Request & { actor: TActor };

export function assertAuthenticated(
  req: Request,
): asserts req is RequestWithActor<BoardActor> {
  if (req.actor.type === "none") {
    throw unauthorized();
  }
  if (!isBoardActor(req.actor)) {
    throw forbidden("Board access required");
  }
}

export function assertBoard(
  req: Request,
): asserts req is RequestWithActor<BoardActor> {
  if (!isBoardActor(req.actor)) {
    throw forbidden("Board access required");
  }
}

export function getBoardUserId(req: Request): string {
  assertBoard(req);
  return req.actor.userId;
}

export function hasBoardOrgAccess(req: Request) {
  if (req.actor.type !== "board") {
    return false;
  }
  if (req.actor.isInstanceAdmin) {
    return true;
  }
  return Array.isArray(req.actor.companyIds) && req.actor.companyIds.length > 0;
}

export function assertBoardOrgAccess(
  req: Request,
): asserts req is RequestWithActor<BoardActor> {
  assertBoard(req);
  if (hasBoardOrgAccess(req)) {
    return;
  }
  throw forbidden("Company membership or instance admin access required");
}

export function assertInstanceAdmin(
  req: Request,
): asserts req is RequestWithActor<BoardActor> {
  assertBoard(req);
  if (req.actor.isInstanceAdmin) {
    return;
  }
  throw forbidden("Instance admin access required");
}

export function assertCompanyAccess(
  req: Request,
  companyId: string,
): asserts req is RequestWithActor<BoardActor> {
  assertAuthenticated(req);
  const allowedCompanies = req.actor.companyIds;
  if (!allowedCompanies.includes(companyId)) {
    throw forbidden("User does not have access to this company");
  }
  const method = typeof req.method === "string" ? req.method.toUpperCase() : "GET";
  const isSafeMethod = ["GET", "HEAD", "OPTIONS"].includes(method);
  if (!isSafeMethod && !req.actor.isInstanceAdmin) {
    const membership = req.actor.memberships.find((item) => item.companyId === companyId);
    if (!membership || membership.status !== "active") {
      throw forbidden("User does not have active company access");
    }
    if (membership.membershipRole === "viewer") {
      throw forbidden("Viewer access is read-only");
    }
  }
}

/**
 * Canonical human-steering authorization shared by run-detail and reply
 * routes. A board key is accepted only after middleware has resolved it to a
 * real Better Auth user; raw/provider identities never satisfy this shape.
 */
export async function authorizeHumanTaskSteering(
  db: Db,
  req: Request,
  companyId: string,
): Promise<string> {
  assertCompanyAccess(req, companyId);
  assertBoard(req);
  const userId = req.actor.userId.trim();
  if (!userId) throw forbidden("Human steering requires a named user");
  const [user, membership] = await Promise.all([
    db
      .select({ id: authUsers.id })
      .from(authUsers)
      .where(eq(authUsers.id, userId))
      .limit(1)
      .then((rows) => rows[0] ?? null),
    db
      .select({
        id: companyMemberships.id,
        status: companyMemberships.status,
        membershipRole: companyMemberships.membershipRole,
      })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalUserId, userId),
          eq(companyMemberships.status, "active"),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null),
  ]);
  if (!user || !membership || membership.membershipRole === "viewer") {
    throw forbidden("Human steering requires active comment permission");
  }
  return userId;
}

/**
 * Preferred way to fetch a company-scoped resource by id inside a route
 * handler without exposing whether a cross-company resource exists:
 *
 *   - missing resource          → 404 `{ error: notFoundMessage }`, returns null
 *   - exists but cross-tenant   → identical 404, returns null
 *   - accessible                → runs `assertCompanyAccess` (write-path
 *     membership checks on non-safe methods) and returns the resource
 *
 * Usage:
 *
 *     const goal = await getAccessibleResource(req, res, svc.getById(id), "Goal not found");
 *     if (!goal) return;
 *
 */
export async function getAccessibleResource<T extends { companyId: string }>(
  req: Request,
  res: Response,
  resource: T | null | undefined | Promise<T | null | undefined>,
  notFoundMessage: string,
): Promise<T | null> {
  const resolved = await resource;
  if (
    !resolved
    || !isBoardActor(req.actor)
    || !req.actor.companyIds.includes(resolved.companyId)
  ) {
    res.status(404).json({ error: notFoundMessage });
    return null;
  }
  assertCompanyAccess(req, resolved.companyId);
  return resolved;
}
