import { Router } from "express";
import type { Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  createIssueTreeHoldSchema,
  isUuidLike,
  previewIssueTreeControlSchema,
  releaseIssueTreeHoldSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { issueService, issueTreeControlService, logActivity } from "../services/index.js";
import type { IssueExecutionCancellationService } from "../services/issue-execution-cancellation.js";
import { assertBoard, getAccessibleResource } from "./authz.js";

const TREE_RUN_CANCELLATION_RESPONSE_WAIT_MS = 1_000;

function errorToMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function waitForRunCancellationTasks(tasks: Promise<void>[]) {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      Promise.all(tasks),
      new Promise((resolve) => {
        timeout = setTimeout(resolve, TREE_RUN_CANCELLATION_RESPONSE_WAIT_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function issueTreeControlRoutes(
  db: Db,
  issueExecutionCancellation: Pick<
    IssueExecutionCancellationService,
    "cancelRun"
  >,
) {
  const router = Router();
  const issuesSvc = issueService(db);
  const treeControlSvc = issueTreeControlService(db);

  async function resolveRootIssue(req: Request) {
    const rootIssueId = req.params.id as string;
    const root = await issuesSvc.getById(rootIssueId);
    return root;
  }

  router.post("/issues/:id/tree-control/preview", validate(previewIssueTreeControlSchema), async (req, res) => {
    assertBoard(req);
    const root = await getAccessibleResource(req, res, resolveRootIssue(req), "Root issue not found");
    if (!root) return;

    const preview = await treeControlSvc.preview(root.companyId, root.id, req.body);
    await logActivity(db, {
      companyId: root.companyId,
      actorType: "user",
      actorId: req.actor.userId,
      action: "issue.tree_control_previewed",
      entityType: "issue",
      entityId: root.id,
      details: {
        mode: preview.mode,
        totals: preview.totals,
        warningCodes: preview.warnings.map((warning) => warning.code),
      },
    });

    res.json(preview);
  });

  router.post("/issues/:id/tree-holds", validate(createIssueTreeHoldSchema), async (req, res) => {
    assertBoard(req);
    const root = await getAccessibleResource(req, res, resolveRootIssue(req), "Root issue not found");
    if (!root) return;

    const actorInput = {
      actorType: "user" as const,
      actorId: req.actor.userId,
      userId: req.actor.userId,
    };
    let result = await treeControlSvc.createHold(root.companyId, root.id, {
      ...req.body,
      actor: actorInput,
    });
    await logActivity(db, {
      companyId: root.companyId,
      actorType: "user",
      actorId: req.actor.userId,
      action: "issue.tree_hold_created",
      entityType: "issue",
      entityId: root.id,
      details: {
        holdId: result.hold.id,
        mode: result.hold.mode,
        reason: result.hold.reason,
        totals: result.preview.totals,
        warningCodes: result.preview.warnings.map((warning) => warning.code),
      },
    });

    const runCancellationTasks: Promise<void>[] = [];
    if (result.hold.mode === "pause" || result.hold.mode === "cancel") {
      const interruptedRunIds = [...new Set(result.preview.activeRuns.map((run) => run.id))];
      for (const runId of interruptedRunIds) {
        const cancellationTask = (async () => {
          try {
            await issueExecutionCancellation.cancelRun(runId);
            await logActivity(db, {
              companyId: root.companyId,
              actorType: "user",
              actorId: req.actor.userId,
              action: "issue.tree_hold_run_interrupted",
              entityType: "issue_execution_run",
              entityId: runId,
              details: {
                holdId: result.hold.id,
                rootIssueId: root.id,
                reason: result.hold.mode === "pause" ? "active_subtree_pause_hold" : "subtree_cancel_operation",
              },
            });
          } catch (error) {
            await Promise.resolve(logActivity(db, {
              companyId: root.companyId,
              actorType: "user",
              actorId: req.actor.userId,
              action: "issue.tree_hold_run_interrupt_failed",
              entityType: "issue_execution_run",
              entityId: runId,
              details: {
                holdId: result.hold.id,
                rootIssueId: root.id,
                reason: result.hold.mode === "pause" ? "active_subtree_pause_hold" : "subtree_cancel_operation",
                error: errorToMessage(error),
              },
            })).catch(() => null);
          }
        })();
        runCancellationTasks.push(cancellationTask);
      }

    }

    if (result.hold.mode === "cancel") {
      const statusUpdate = await treeControlSvc.cancelIssueStatusesForHold(root.companyId, root.id, result.hold.id);
      await logActivity(db, {
        companyId: root.companyId,
        actorType: "user",
        actorId: req.actor.userId,
        action: "issue.tree_cancel_status_updated",
        entityType: "issue",
        entityId: root.id,
        details: {
          holdId: result.hold.id,
          cancelledIssueIds: statusUpdate.updatedIssueIds,
          cancelledIssueCount: statusUpdate.updatedIssueIds.length,
        },
      });
    }

    if (runCancellationTasks.length > 0) {
      await waitForRunCancellationTasks(runCancellationTasks);
    }

    if (result.hold.mode === "restore") {
      let statusUpdate;
      try {
        statusUpdate = await treeControlSvc.restoreIssueStatusesForHold(root.companyId, root.id, result.hold.id, {
          reason: result.hold.reason,
          actor: actorInput,
        });
      } catch (error) {
        await treeControlSvc.releaseHold(root.companyId, root.id, result.hold.id, {
          reason: "Restore operation failed before subtree status updates completed",
          metadata: {
            cleanup: "restore_failed_before_apply",
          },
          actor: actorInput,
          internal: true,
        }).catch(() => null);
        throw error;
      }
      if (statusUpdate.restoreHold) {
        result = { ...result, hold: statusUpdate.restoreHold };
      }
      await logActivity(db, {
        companyId: root.companyId,
        actorType: "user",
        actorId: req.actor.userId,
        action: "issue.tree_restore_status_updated",
        entityType: "issue",
        entityId: root.id,
        details: {
          holdId: result.hold.id,
          restoredIssueIds: statusUpdate.updatedIssueIds,
          restoredIssueCount: statusUpdate.updatedIssueIds.length,
          releasedCancelHoldIds: statusUpdate.releasedCancelHoldIds,
        },
      });

    }

    res
      .status(result.hold.mode === "restore" || result.hold.mode === "resume" ? 200 : 201)
      .json(result);
  });

  router.get("/issues/:id/tree-control/state", async (req, res) => {
    assertBoard(req);
    const issueId = req.params.id as string;
    const issue = await getAccessibleResource(req, res, issuesSvc.getById(issueId), "Issue not found");
    if (!issue) return;
    const activePauseHold = await treeControlSvc.getActivePauseHoldGate(issue.companyId, issue.id);
    res.json({ activePauseHold });
  });

  router.get("/issues/:id/tree-holds", async (req, res) => {
    assertBoard(req);
    const root = await getAccessibleResource(req, res, resolveRootIssue(req), "Root issue not found");
    if (!root) return;
    const statusParam = typeof req.query.status === "string" ? req.query.status : null;
    const modeParam = typeof req.query.mode === "string" ? req.query.mode : null;
    const includeMembers = req.query.includeMembers === "true";
    const holds = await treeControlSvc.listHolds(root.companyId, root.id, {
      status: statusParam === "active" || statusParam === "released" ? statusParam : undefined,
      mode:
        modeParam === "pause" || modeParam === "resume" || modeParam === "cancel" || modeParam === "restore"
          ? modeParam
          : undefined,
      includeMembers,
    });
    res.json(holds);
  });

  router.get("/issues/:id/tree-holds/:holdId", async (req, res) => {
    assertBoard(req);
    const root = await getAccessibleResource(req, res, resolveRootIssue(req), "Root issue not found");
    if (!root) return;

    const holdId = req.params.holdId as string;
    if (!isUuidLike(holdId)) {
      res.status(400).json({ error: "Invalid hold ID" });
      return;
    }

    const hold = await treeControlSvc.getHold(root.companyId, holdId);
    if (!hold || hold.rootIssueId !== root.id) {
      res.status(404).json({ error: "Issue tree hold not found" });
      return;
    }
    res.json(hold);
  });

  router.post(
    "/issues/:id/tree-holds/:holdId/release",
    validate(releaseIssueTreeHoldSchema),
    async (req, res) => {
      assertBoard(req);
      const root = await getAccessibleResource(req, res, resolveRootIssue(req), "Root issue not found");
      if (!root) return;

      const holdId = req.params.holdId as string;
      if (!isUuidLike(holdId)) {
        res.status(400).json({ error: "Invalid hold ID" });
        return;
      }

      const hold = await treeControlSvc.releaseHold(root.companyId, root.id, holdId, {
        ...req.body,
        actor: {
          actorType: "user",
          actorId: req.actor.userId,
          userId: req.actor.userId,
        },
      });
      await logActivity(db, {
        companyId: root.companyId,
        actorType: "user",
        actorId: req.actor.userId,
        action: "issue.tree_hold_released",
        entityType: "issue",
        entityId: root.id,
        details: {
          holdId: hold.id,
          mode: hold.mode,
          reason: hold.releaseReason,
          memberCount: hold.members?.length ?? 0,
        },
      });

      res.json(hold);
    },
  );

  return router;
}
