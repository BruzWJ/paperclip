import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { validate } from "../middleware/validate.js";
import {
  changeConsentGateService,
  type ChangeConsentStatus,
} from "../services/change-consent-gate.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { assertExactQueryKeys, parseExactOptionalEnum } from "./exact-query.js";

const decideChangeConsentSchema = z.object({
  decision: z.enum(["accepted", "rejected"]),
  reason: z.string().trim().max(4_000).nullable().optional(),
}).strict();

const statuses = ["pending", "accepted", "rejected", "expired"] as const satisfies readonly ChangeConsentStatus[];

export function changeConsentRoutes(db: Db) {
  const router = Router({ caseSensitive: true, strict: true });
  const service = changeConsentGateService(db);

  router.get("/companies/:companyId/change-consents", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    assertExactQueryKeys(req.query, ["status"]);
    const status = parseExactOptionalEnum(req.query.status, "status", statuses);
    res.json(await service.list(companyId, status));
  });

  router.post(
    "/companies/:companyId/change-consents/:consentId/decision",
    validate(decideChangeConsentSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
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
