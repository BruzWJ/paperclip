import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { upsertSidebarOrderPreferenceSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { logActivity, sidebarPreferenceService } from "../services/index.js";
import { assertCompanyAccess, assertCurrentBoardUser } from "./authz.js";

export function sidebarPreferenceRoutes(db: Db) {
  const router = Router({ caseSensitive: true, strict: true });
  const svc = sidebarPreferenceService(db);

  router.get("/users/:userId/sidebar-preferences", async (req, res) => {
    const userId = req.params.userId as string;
    assertCurrentBoardUser(req, userId);
    res.json(await svc.getCompanyOrder(userId));
  });

  router.put(
    "/users/:userId/sidebar-preferences",
    validate(upsertSidebarOrderPreferenceSchema),
    async (req, res) => {
      const userId = req.params.userId as string;
      assertCurrentBoardUser(req, userId);
      res.json(await svc.upsertCompanyOrder(userId, req.body.orderedIds));
    },
  );

  router.get("/companies/:companyId/users/:userId/sidebar-preferences", async (req, res) => {
    const companyId = req.params.companyId as string;
    const userId = req.params.userId as string;
    assertCurrentBoardUser(req, userId);
    assertCompanyAccess(req, companyId);
    res.json(await svc.getProjectOrder(companyId, userId));
  });

  router.put(
    "/companies/:companyId/users/:userId/sidebar-preferences",
    validate(upsertSidebarOrderPreferenceSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const userId = req.params.userId as string;
      assertCurrentBoardUser(req, userId);
      assertCompanyAccess(req, companyId);

      const result = await svc.upsertProjectOrder(companyId, userId, req.body.orderedIds);
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId,
        action: "sidebar_preferences.project_order_updated",
        entityType: "company",
        entityId: companyId,
        details: {
          userId,
          orderedIds: result.orderedIds,
        },
      });
      res.json(result);
    },
  );

  return router;
}
