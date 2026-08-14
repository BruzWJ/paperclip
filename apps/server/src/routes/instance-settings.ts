import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { patchInstanceGeneralSettingsSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { instanceSettingsService, logActivity } from "../services/index.js";
import { assertBoardOrgAccess, assertInstanceAdmin } from "./authz.js";

export function instanceSettingsRoutes(db: Db) {
  const router = Router({ caseSensitive: true, strict: true });
  const svc = instanceSettingsService(db);

  router.get("/instance/settings/general", async (req, res) => {
    // General settings (e.g. keyboardShortcuts) are readable by any
    // authenticated org member or instance admin. Only PATCH requires instance-admin.
    assertBoardOrgAccess(req);
    res.json(await svc.getGeneral());
  });

  router.patch(
    "/instance/settings/general",
    validate(patchInstanceGeneralSettingsSchema),
    async (req, res) => {
      assertInstanceAdmin(req);
      const updated = await svc.updateGeneral(req.body);
      const companyIds = await svc.listCompanyIds();
      await Promise.all(
        companyIds.map((companyId) =>
          logActivity(db, {
            companyId,
            actorType: "user",
            actorId: req.actor.userId,
            action: "instance.settings.general_updated",
            entityType: "instance_settings",
            entityId: updated.id,
            details: {
              general: updated.general,
              changedKeys: Object.keys(req.body).sort(),
            },
          }),
        ),
      );
      res.json(updated.general);
    },
  );

  return router;
}
