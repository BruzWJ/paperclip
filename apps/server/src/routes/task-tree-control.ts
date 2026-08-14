import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  createTaskTreeHoldSchema,
  isCanonicalUuid,
  previewTaskTreeControlSchema,
  releaseTaskTreeHoldSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { taskService, taskTreeControlService, logActivity } from "../services/index.js";
import type { TaskTreeCancellationPort } from "../services/task-tree-control.js";
import { assertBoard, getAccessibleResource } from "./authz.js";
import { assertExactQueryKeys, parseExactBooleanQuery, parseExactOptionalEnum } from "./exact-query.js";

const TREE_HOLD_STATUSES = ["active", "released"] as const;
const TREE_HOLD_MODES = ["pause", "resume", "cancel", "restore"] as const;

export function taskTreeControlRoutes(db: Db, taskExecutionCancellation: TaskTreeCancellationPort) {
  const router = Router({ caseSensitive: true, strict: true });
  const tasksSvc = taskService(db);
  const treeControlSvc = taskTreeControlService(db, {
    taskExecutionCancellation,
  });

  async function resolveRootTask(req: Request) {
    const rootTaskId = req.params.id as string;
    const root = await tasksSvc.getById(rootTaskId);
    return root;
  }

  router.post("/tasks/:id/tree-control/preview", validate(previewTaskTreeControlSchema), async (req, res) => {
    assertBoard(req);
    const root = await getAccessibleResource(req, res, resolveRootTask(req), "Root task not found");
    if (!root) return;

    const preview = await treeControlSvc.preview(root.companyId, root.id, req.body);
    await logActivity(db, {
      companyId: root.companyId,
      actorType: "user",
      actorId: req.actor.userId,
      action: "task.tree_control_previewed",
      entityType: "task",
      entityId: root.id,
      details: {
        mode: preview.mode,
        totals: preview.totals,
        warningCodes: preview.warnings.map((warning) => warning.code),
      },
    });

    res.json(preview);
  });

  router.post("/tasks/:id/tree-holds", validate(createTaskTreeHoldSchema), async (req, res) => {
    assertBoard(req);
    const root = await getAccessibleResource(req, res, resolveRootTask(req), "Root task not found");
    if (!root) return;

    const actorInput = {
      actorType: "user" as const,
      actorId: req.actor.userId,
      userId: req.actor.userId,
    };
    const applied = await treeControlSvc.createHold(root.companyId, root.id, {
      ...req.body,
      actor: actorInput,
    });
    const { cancelledTaskIds, ...createdResult } = applied;
    let result = createdResult;
    await logActivity(db, {
      companyId: root.companyId,
      actorType: "user",
      actorId: req.actor.userId,
      action: "task.tree_hold_created",
      entityType: "task",
      entityId: root.id,
      details: {
        holdId: result.hold.id,
        mode: result.hold.mode,
        reason: result.hold.reason,
        totals: result.preview.totals,
        warningCodes: result.preview.warnings.map((warning) => warning.code),
      },
    });

    if (result.hold.mode === "cancel") {
      await logActivity(db, {
        companyId: root.companyId,
        actorType: "user",
        actorId: req.actor.userId,
        action: "task.tree_cancel_status_updated",
        entityType: "task",
        entityId: root.id,
        details: {
          holdId: result.hold.id,
          cancelledTaskIds,
          cancelledTaskCount: cancelledTaskIds.length,
        },
      });
    }

    if (result.hold.mode === "restore") {
      let statusUpdate;
      try {
        statusUpdate = await treeControlSvc.restoreTaskStatusesForHold(
          root.companyId,
          root.id,
          result.hold.id,
          {
            reason: result.hold.reason,
            actor: actorInput,
          },
        );
      } catch (error) {
        await treeControlSvc
          .releaseHold(root.companyId, root.id, result.hold.id, {
            reason: "Restore operation failed before subtree status updates completed",
            metadata: {
              cleanup: "restore_failed_before_apply",
            },
            actor: actorInput,
            internal: true,
          })
          .catch(() => null);
        throw error;
      }
      if (statusUpdate.restoreHold) {
        result = { ...result, hold: statusUpdate.restoreHold };
      }
      await logActivity(db, {
        companyId: root.companyId,
        actorType: "user",
        actorId: req.actor.userId,
        action: "task.tree_restore_status_updated",
        entityType: "task",
        entityId: root.id,
        details: {
          holdId: result.hold.id,
          restoredTaskIds: statusUpdate.updatedTaskIds,
          restoredTaskCount: statusUpdate.updatedTaskIds.length,
          releasedCancelHoldIds: statusUpdate.releasedCancelHoldIds,
        },
      });
    }

    res.status(result.hold.mode === "restore" || result.hold.mode === "resume" ? 200 : 201).json(result);
  });

  router.get("/tasks/:id/tree-control/state", async (req, res) => {
    assertBoard(req);
    const taskId = req.params.id as string;
    const task = await getAccessibleResource(req, res, tasksSvc.getById(taskId), "Task not found");
    if (!task) return;
    const activePauseHold = await treeControlSvc.getActivePauseHoldGate(task.companyId, task.id);
    res.json({ activePauseHold });
  });

  router.get("/tasks/:id/tree-holds", async (req, res) => {
    assertBoard(req);
    const root = await getAccessibleResource(req, res, resolveRootTask(req), "Root task not found");
    if (!root) return;
    assertExactQueryKeys(req.query, ["includeMembers", "mode", "status"]);
    const status = parseExactOptionalEnum(req.query.status, "status", TREE_HOLD_STATUSES);
    const mode = parseExactOptionalEnum(req.query.mode, "mode", TREE_HOLD_MODES);
    const includeMembers = parseExactBooleanQuery(req.query.includeMembers, "includeMembers");
    const holds = await treeControlSvc.listHolds(root.companyId, root.id, {
      status,
      mode,
      includeMembers,
    });
    res.json(holds);
  });

  router.get("/tasks/:id/tree-holds/:holdId", async (req, res) => {
    assertBoard(req);
    const root = await getAccessibleResource(req, res, resolveRootTask(req), "Root task not found");
    if (!root) return;

    const holdId = req.params.holdId as string;
    if (!isCanonicalUuid(holdId)) {
      res.status(400).json({ error: "Invalid hold ID" });
      return;
    }

    const hold = await treeControlSvc.getHold(root.companyId, holdId);
    if (!hold || hold.rootTaskId !== root.id) {
      res.status(404).json({ error: "Task tree hold not found" });
      return;
    }
    res.json(hold);
  });

  router.post(
    "/tasks/:id/tree-holds/:holdId/release",
    validate(releaseTaskTreeHoldSchema),
    async (req, res) => {
      assertBoard(req);
      const root = await getAccessibleResource(req, res, resolveRootTask(req), "Root task not found");
      if (!root) return;

      const holdId = req.params.holdId as string;
      if (!isCanonicalUuid(holdId)) {
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
        action: "task.tree_hold_released",
        entityType: "task",
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
