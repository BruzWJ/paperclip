import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { validate } from "../middleware/validate.js";
import { badRequest } from "../errors.js";
import {
  changeConsentGateService,
  type ChangeConsentStatus,
} from "../services/change-consent-gate.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

const decideChangeConsentSchema = z.object({
  decision: z.enum(["accepted", "rejected"]),
  reason: z.string().trim().max(4_000).nullable().optional(),
}).strict();

const statuses = new Set<ChangeConsentStatus>(["pending", "accepted", "rejected", "expired"]);

export function changeConsentRoutes(db: Db) {
  const router = Router();
  const service = changeConsentGateService(db);

  router.get("/companies/:companyId/change-consents", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const rawStatus = typeof req.query.status === "string" ? req.query.status : undefined;
    if (rawStatus && !statuses.has(rawStatus as ChangeConsentStatus)) {
      throw badRequest("Invalid change consent status");
    }
    res.json(await service.list(companyId, rawStatus as ChangeConsentStatus | undefined));
  });

  router.post(
    "/companies/:companyId/change-consents/:consentId/decision",
    validate(decideChangeConsentSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      assertBoard(req);
      assertBoard(req);
      res.json(await service.decide({
        companyId,
        consentId: req.params.consentId as string,
        decision: req.body.decision,
        decidedByBoardId: req.actor.userId,
        reason: req.body.reason,
      }));
    },
  );

  return router;
}
