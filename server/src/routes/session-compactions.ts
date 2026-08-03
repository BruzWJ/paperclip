import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { updateSessionCompactionSettingsSchema } from "@paperclipai/shared";
import { conflict, notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import {
  SessionCompactionConflict,
  type PostgresIssueSessionCompactionRuntime,
} from "../services/issue-session-compaction-postgres.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

export function sessionCompactionRoutes(
  db: Db,
  runtime: PostgresIssueSessionCompactionRuntime,
) {
  const router = Router();

  router.get(
    "/companies/:companyId/session-compaction-settings",
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const settings = await runtime.getSettings(companyId);
      if (!settings) throw notFound("Company not found");
      res.json(settings);
    },
  );

  router.patch(
    "/companies/:companyId/session-compaction-settings",
    validate(updateSessionCompactionSettingsSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      let updated: Awaited<ReturnType<typeof runtime.updateSettings>>;
      try {
        updated = await runtime.updateSettings(companyId, req.body, {
          actorType: "user",
          actorId: req.actor.userId,
        });
      } catch (error) {
        if (error instanceof SessionCompactionConflict) {
          throw conflict(error.message, { code: error.code });
        }
        throw error;
      }
      if (!updated) throw notFound("Company not found");
      res.json(updated.current);
    },
  );

  return router;
}
