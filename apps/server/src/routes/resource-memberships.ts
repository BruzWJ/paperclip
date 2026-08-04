import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { updateResourceMembershipSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { assertBoard } from "./authz.js";
import { logActivity, resourceMembershipService } from "../services/index.js";

async function logMembershipChange(
  db: Db,
  req: Request,
  input: {
    companyId: string;
    userId: string;
    resourceType: "project" | "agent";
    resourceId: string;
    state: "joined" | "left";
    starredAt: Date | null;
    changeKind: "joined" | "left" | "starred" | "unstarred";
    policySource: string;
  },
) {
  assertBoard(req);
  await logActivity(db, {
    companyId: input.companyId,
    actorType: "user",
    actorId: req.actor.userId,
    action: `resource_membership.${input.changeKind}`,
    entityType: input.resourceType,
    entityId: input.resourceId,
    details: {
      userId: input.userId,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      state: input.state,
      starredAt: input.starredAt,
      starred: input.starredAt !== null,
      policySource: input.policySource,
    },
  });
}

export function resourceMembershipRoutes(db: Db) {
  const router = Router();
  const svc = resourceMembershipService(db);

  router.get("/companies/:companyId/resource-memberships/me", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    const userId = req.actor.userId;
    res.json(await svc.listForUser(companyId, userId, req.actor));
  });

  router.put(
    "/companies/:companyId/resource-memberships/me/projects/:projectId",
    validate(updateResourceMembershipSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const projectId = req.params.projectId as string;
      assertBoard(req);
      const userId = req.actor.userId;
      const result = await svc.updateProject({
        companyId,
        projectId,
        userId,
        state: req.body.state,
        starred: req.body.starred,
        actor: req.actor,
      });
      if (result.changed && result.changeKind) {
        await logMembershipChange(db, req, {
          companyId,
          userId,
          resourceType: "project",
          resourceId: projectId,
          state: result.state,
          starredAt: result.starredAt,
          changeKind: result.changeKind,
          policySource: result.policySource,
        });
      }
      const { changed: _changed, changeKind: _changeKind, policySource: _policySource, ...response } = result;
      res.json(response);
    },
  );

  router.put(
    "/companies/:companyId/resource-memberships/me/agents/:agentId",
    validate(updateResourceMembershipSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const agentId = req.params.agentId as string;
      assertBoard(req);
      const userId = req.actor.userId;
      const result = await svc.updateAgent({
        companyId,
        agentId,
        userId,
        state: req.body.state,
        starred: req.body.starred,
        actor: req.actor,
      });
      if (result.changed && result.changeKind) {
        await logMembershipChange(db, req, {
          companyId,
          userId,
          resourceType: "agent",
          resourceId: agentId,
          state: result.state,
          starredAt: result.starredAt,
          changeKind: result.changeKind,
          policySource: result.policySource,
        });
      }
      const { changed: _changed, changeKind: _changeKind, policySource: _policySource, ...response } = result;
      res.json(response);
    },
  );

  return router;
}
