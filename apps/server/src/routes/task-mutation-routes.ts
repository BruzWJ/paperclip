import {
  reassignTaskSchema,
  updateTaskStatusSchema,
  updateTaskTitleSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { logActivity } from "../services/index.js";
import { publishBoardCommentCreated } from "../services/plugin-domain-event-publisher.js";
import { assertBoard, getAccessibleResource } from "./authz.js";
import type { TaskRouteContext } from "./task-route-context.js";

type TaskMutationRoutesContext = Pick<
  TaskRouteContext,
  | "db"
  | "opts"
  | "router"
  | "svc"
  | "ordinaryTasks"
  | "requireNamedBoardUser"
  | "canonicalTaskMutationError"
>;

export function registerTaskMutationRoutes(context: TaskMutationRoutesContext): void {
  const { db, opts, router, svc, ordinaryTasks, requireNamedBoardUser, canonicalTaskMutationError } = context;

  router.patch("/tasks/:id", validate(updateTaskTitleSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await getAccessibleResource(req, res, svc.getById(id), "Task not found");
    if (!existing) return;

    const task = await svc.updateTitle(id, req.body.title);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    await logActivity(db, {
      companyId: task.companyId,
      actorType: "user",
      actorId: req.actor.userId,
      action: "task.title_updated",
      entityType: "task",
      entityId: task.id,
      details: {
        identifier: task.identifier,
        title: task.title,
        _previous: { title: existing.title },
      },
    });

    res.json(task);
  });

  router.post("/tasks/:id/reassign", validate(reassignTaskSchema), async (req, res) => {
    const actorUserId = requireNamedBoardUser(req);
    const id = req.params.id as string;
    const existing = await getAccessibleResource(req, res, svc.getById(id), "Task not found");
    if (!existing) return;

    try {
      const result = await ordinaryTasks.boardReassign({
        companyId: existing.companyId,
        taskId: existing.id,
        ownerAgentId: req.body.ownerAgentId,
        actorUserId,
        idempotencyKey: req.body.idempotencyKey,
      });
      res.status(result.retried ? 200 : 201).json(result);
    } catch (error) {
      canonicalTaskMutationError(error);
    }
  });

  router.post("/tasks/:id/status-update", validate(updateTaskStatusSchema), async (req, res) => {
    const actorUserId = requireNamedBoardUser(req);
    const id = req.params.id as string;
    const existing = await getAccessibleResource(req, res, svc.getById(id), "Task not found");
    if (!existing) return;

    try {
      const result = await ordinaryTasks.commitOwnerFormUpdate(
        existing.id,
        { message: req.body.message, status: req.body.status },
        {
          kind: "board",
          companyId: existing.companyId,
          actorUserId,
          recipient: req.body.recipient,
          gatewayInvocationId: `board-status-update:${existing.companyId}:${req.body.idempotencyKey}`,
        },
      );
      if (!result.retried) {
        await publishBoardCommentCreated(opts.pluginDomainEvents, {
          companyId: existing.companyId,
          taskId: existing.id,
          commentId: result.comment.id,
          actorUserId,
        });
      }
      res.status(result.retried ? 200 : 201).json(result);
    } catch (error) {
      canonicalTaskMutationError(error);
    }
  });
}
