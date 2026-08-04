import { randomUUID } from "node:crypto";
import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  normalizeContextAccess,
} from "@paperclipai/shared";
import {
  instanceSettingsService,
  type OrdinaryIssueRuntime,
} from "../services/index.js";
import {
  assertBoard,
  assertCompanyAccess,
} from "./authz.js";

/**
 * Board Chat is a presentation over an ordinary issue. There is no standing
 * concierge issue, replay prompt, provider subprocess, sentinel author, or
 * special response stream: the selected owner works the canonical issue and
 * its normal comment-of-record is the reply.
 */
export function boardChatRoutes(
  db: Db,
  opts: {
    ordinaryIssues: OrdinaryIssueRuntime;
  },
) {
  const router = Router();
  const ordinaryIssues = opts.ordinaryIssues;

  router.post("/board/chat/messages", async (req, res) => {
    const experimental =
      await instanceSettingsService(db).getExperimental();
    if (experimental.enableConferenceRoomChat !== true) {
      res.status(403).json({
        error: "Conference Room Chat is not enabled",
        code: "FEATURE_DISABLED",
      });
      return;
    }

    assertBoard(req);
    const body = req.body as {
      companyId?: unknown;
      message?: unknown;
      agentId?: unknown;
      idempotencyKey?: unknown;
      contextAccessMask?: unknown;
    };
    const allowedBodyKeys = new Set([
      "companyId",
      "message",
      "agentId",
      "idempotencyKey",
      "contextAccessMask",
    ]);
    if (
      !req.body ||
      typeof req.body !== "object" ||
      Array.isArray(req.body) ||
      Object.keys(req.body as Record<string, unknown>).some(
        (key) => !allowedBodyKeys.has(key),
      )
    ) {
      res.status(400).json({
        error: "Board Chat accepts creation fields only",
        code: "BOARD_CHAT_CREATION_ONLY",
      });
      return;
    }
    const companyId =
      typeof body.companyId === "string" ? body.companyId.trim() : "";
    const message =
      typeof body.message === "string" ? body.message : "";
    const agentId =
      typeof body.agentId === "string" ? body.agentId.trim() : "";
    const idempotencyKey =
      typeof body.idempotencyKey === "string" &&
      body.idempotencyKey.trim()
        ? body.idempotencyKey.trim()
        : randomUUID();
    if (!companyId || !message.trim() || !agentId) {
      res.status(400).json({
        error: "companyId, agentId, and message are required",
      });
      return;
    }
    let contextAccessMask;
    try {
      contextAccessMask = normalizeContextAccess(body.contextAccessMask);
    } catch {
      res.status(400).json({
        error:
          "contextAccessMask accepts only known boolean context-grant keys",
      });
      return;
    }
    assertCompanyAccess(req, companyId);

    const created = await ordinaryIssues.create({
      companyId,
      creator: {
        kind: "user/board",
        userId: req.actor.userId,
      },
      request: message,
      ownerAgentId: agentId,
      idempotencyKey,
      sourceKind: "board_chat",
      title: "Board Chat",
      priority: "medium",
      contextAccessMask,
    });
    res.status(created.retried ? 200 : 201).json({
      issue: created.issue,
      issueId: created.issue.id,
      refId: created.ref.id,
      retried: created.retried,
    });
  });

  return router;
}
