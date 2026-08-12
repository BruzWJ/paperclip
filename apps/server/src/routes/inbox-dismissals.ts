import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { addValidationDetail } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { assertCompanyAccess } from "./authz.js";
import { inboxDismissalService, logActivity } from "../services/index.js";

const ITEM_KEY_RE = /^(approval|join|run|attention):.+$/;

const exactItemKeySchema = z.string().min(1)
  .regex(ITEM_KEY_RE, "Unsupported inbox item key")
  .refine((value) => value.trim() === value);

const inboxDismissalSchema = z.object({
  itemKey: exactItemKeySchema,
  kind: z.enum(["dismiss", "snooze"]).default("dismiss"),
  snoozedUntil: z.string().datetime().refine((value) => new Date(value).toISOString() === value).optional(),
}).superRefine((value, ctx) => {
  if (value.kind === "dismiss") {
    if (value.snoozedUntil != null) {
      addValidationDetail(ctx, { path: ["snoozedUntil"], message: "Dismissals must not include snoozedUntil" });
    }
    return;
  }

  if (!value.snoozedUntil) {
    addValidationDetail(ctx, { path: ["snoozedUntil"], message: "Snooze requires snoozedUntil" });
    return;
  }
  const timestamp = new Date(value.snoozedUntil).getTime();
  if (!Number.isFinite(timestamp)) {
    addValidationDetail(ctx, { path: ["snoozedUntil"], message: "snoozedUntil must be an ISO timestamp" });
    return;
  }
  if (timestamp <= Date.now()) {
    addValidationDetail(ctx, { path: ["snoozedUntil"], message: "snoozedUntil must be in the future" });
  }
});

export function inboxDismissalRoutes(db: Db) {
  const router = Router({ caseSensitive: true, strict: true });
  const svc = inboxDismissalService(db);

  router.get("/companies/:companyId/inbox-dismissals", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const userId = req.actor.userId;

    const dismissals = await svc.list(companyId, userId);
    res.json(dismissals);
  });

  router.post(
    "/companies/:companyId/inbox-dismissals",
    validate(inboxDismissalSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const userId = req.actor.userId;

      const dismissal = req.body.kind === "snooze"
        ? await svc.snooze(companyId, userId, req.body.itemKey, new Date(req.body.snoozedUntil))
        : await svc.dismiss(companyId, userId, req.body.itemKey, new Date());
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId,
        action: dismissal.kind === "snooze" ? "inbox.snoozed" : "inbox.dismissed",
        entityType: "company",
        entityId: companyId,
        details: {
          userId,
          itemKey: dismissal.itemKey,
          kind: dismissal.kind,
          dismissedAt: dismissal.dismissedAt,
          snoozedUntil: dismissal.snoozedUntil,
        },
      });

      res.status(201).json(dismissal);
    },
  );

  router.delete("/companies/:companyId/inbox-dismissals/:itemKey", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const userId = req.actor.userId;

    const itemKey = req.params.itemKey as string;
    if (!ITEM_KEY_RE.test(itemKey)) {
      res.status(400).json({ error: "Unsupported inbox item key" });
      return;
    }

    const restored = await svc.restore(companyId, userId, itemKey);
    if (restored) {
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId,
        action: "inbox.restored",
        entityType: "company",
        entityId: companyId,
        details: {
          userId,
          itemKey: restored.itemKey,
          kind: restored.kind,
          dismissedAt: restored.dismissedAt,
          snoozedUntil: restored.snoozedUntil,
        },
      });
    }

    res.status(204).send();
  });

  return router;
}
