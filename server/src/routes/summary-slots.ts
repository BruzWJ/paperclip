import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { refreshSummarySlotSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { forbidden, notFound } from "../errors.js";
import { accessService, instanceSettingsService, logActivity } from "../services/index.js";
import type { OrdinaryIssueRuntime } from "../services/ordinary-issue-runtime.js";
import { summarySlotService } from "../services/summary-slots.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

function readScopeId(req: Request): string | null {
  const raw = req.query.scopeId;
  if (typeof raw === "string" && raw.trim().length > 0) return raw;
  return null;
}

export function summarySlotRoutes(
  db: Db,
  opts: { ordinaryIssues: OrdinaryIssueRuntime },
) {
  const router = Router();
  const access = accessService(db);
  const settings = instanceSettingsService(db);
  const svc = summarySlotService(db, {
    ordinaryIssues: opts.ordinaryIssues,
  });

  async function assertSummariesEnabled() {
    const experimental = await settings.getExperimental();
    if (experimental.enableSummaries !== true) {
      throw notFound("Summaries are not enabled");
    }
  }

  /** Manual refresh is a board/user action; agents cannot trigger it. */
  async function assertCanRefreshSummary(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    if (req.actor.type !== "board") {
      throw forbidden("Only board operators can refresh summaries.");
    }
    const decision = await access.decide({
      actor: req.actor,
      action: "issue:mutate",
      resource: { type: "company", companyId },
    });
    if (!decision.allowed) throw forbidden(decision.explanation);
  }

  async function logSummaryMutation(
    req: Request,
    input: {
      companyId: string;
      action: "summary_slot.refresh_requested";
      slotId: string;
      details: Record<string, unknown>;
    },
  ) {
    assertBoard(req);
    await logActivity(db, {
      companyId: input.companyId,
      actorType: "user",
      actorId: req.actor.userId,
      action: input.action,
      entityType: "summary_slot",
      entityId: input.slotId,
      details: input.details,
    });
  }

  router.get("/companies/:companyId/summary-slots/:scopeKind/:slotKey", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    await assertSummariesEnabled();
    const result = await svc.getSlot({
      companyId,
      scopeKind: req.params.scopeKind as string,
      slotKey: req.params.slotKey as string,
      scopeId: readScopeId(req),
    });
    res.json(result);
  });

  router.get("/companies/:companyId/summary-slots/:scopeKind/:slotKey/revisions", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    await assertSummariesEnabled();
    const result = await svc.listRevisions({
      companyId,
      scopeKind: req.params.scopeKind as string,
      slotKey: req.params.slotKey as string,
      scopeId: readScopeId(req),
    });
    res.json(result);
  });

  router.post(
    "/companies/:companyId/summary-slots/:scopeKind/:slotKey/refresh",
    validate(refreshSummarySlotSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertSummariesEnabled();
      await assertCanRefreshSummary(req, companyId);
      assertBoard(req);
      const result = await svc.dispatchRefresh(
        {
          companyId,
          scopeKind: req.params.scopeKind as string,
          slotKey: req.params.slotKey as string,
          scopeId: (req.body?.scopeId as string | null | undefined) ?? readScopeId(req),
          ownerAgentId: (req.body.ownerAgentId as string | undefined) ?? null,
        },
        {
          type: "user",
          userId: req.actor.userId,
        },
      );
      await logSummaryMutation(req, {
        companyId,
        action: "summary_slot.refresh_requested",
        slotId: result.slot.id,
        details: {
          scopeKind: result.slot.scopeKind,
          scopeId: result.slot.scopeId,
          slotKey: result.slot.slotKey,
          generatingIssueId: result.generatingIssue.id,
          alreadyGenerating: result.alreadyGenerating,
        },
      });
      res.status(result.alreadyGenerating ? 200 : 202).json(result);
    },
  );

  return router;
}
