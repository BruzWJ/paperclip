import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { attentionService } from "../services/attention.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { assertExactQueryKeys, parseExactBooleanQuery } from "./exact-query.js";

export function attentionRoutes(db: Db) {
  const router = Router({ caseSensitive: true, strict: true });
  const svc = attentionService(db);

  router.get("/companies/:companyId/attention", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    if (!req.actor.userId) {
      res.status(403).json({ error: "Board user context required" });
      return;
    }

    assertExactQueryKeys(req.query, ["includeDismissed"]);
    const includeDismissed = parseExactBooleanQuery(
      req.query.includeDismissed,
      "includeDismissed",
    );
    const feed = await svc.list(companyId, {
      userId: req.actor.userId,
      includeDismissed,
    });
    res.json(feed);
  });

  return router;
}
