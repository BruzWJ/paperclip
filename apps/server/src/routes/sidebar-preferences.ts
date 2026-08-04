import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { upsertSidebarOrderPreferenceSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { logActivity, sidebarPreferenceService } from "../services/index.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

export function sidebarPreferenceRoutes(db: Db) {
  const router = Router();
  const svc = sidebarPreferenceService(db);

  router.get("/sidebar-preferences/me", async (req, res) => {
    assertBoard(req);
    res.json(await svc.getCompanyOrder(req.actor.userId));
  });

  router.put("/sidebar-preferences/me", validate(upsertSidebarOrderPreferenceSchema), async (req, res) => {
    assertBoard(req);
    res.json(await svc.upsertCompanyOrder(req.actor.userId, req.body.orderedIds));
  });

  router.get("/companies/:companyId/sidebar-preferences/me", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.getProjectOrder(companyId, req.actor.userId));
  });

  router.put(
    "/companies/:companyId/sidebar-preferences/me",
    validate(upsertSidebarOrderPreferenceSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const userId = req.actor.userId;

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
