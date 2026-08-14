import { createTaskUserCommentSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { OrdinaryTaskRuntimeRejected } from "../services/index.js";
import { authorizeHumanTaskSteering, getAccessibleResource } from "./authz.js";
import type { TaskRouteContext } from "./task-route-context.js";

type TaskCommentRoutesContext = Pick<
  TaskRouteContext,
  | "db"
  | "opts"
  | "router"
  | "svc"
  | "ordinaryTasks"
  | "assertTaskReadAllowed"
  | "taskCommentRootPageQuerySchema"
  | "taskCommentThreadPageQuerySchema"
  | "requireNamedBoardUser"
  | "canonicalTaskMutationError"
>;

export function registerTaskCommentRoutes(context: TaskCommentRoutesContext): void {
  const {
    db,
    opts,
    router,
    svc,
    ordinaryTasks,
    assertTaskReadAllowed,
    taskCommentRootPageQuerySchema,
    taskCommentThreadPageQuerySchema,
    requireNamedBoardUser,
    canonicalTaskMutationError,
  } = context;
  router.get("/tasks/:id/comments", async (req, res) => {
    const id = req.params.id as string;
    const task = await getAccessibleResource(req, res, svc.getById(id), "Task not found");
    if (!task) return;
    if (!(await assertTaskReadAllowed(req, res, task))) return;
    const query = taskCommentRootPageQuerySchema.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: "Invalid task comment page query" });
      return;
    }
    const page = await svc.listBoardCommentGroups(task.companyId, id, {
      cursor: query.data.cursor ?? null,
      limit: query.data.limit ?? null,
      entryLimit: query.data.entryLimit ?? null,
    });
    res.json(page);
  });

  router.get("/tasks/:id/comments/:commentId", async (req, res) => {
    const id = req.params.id as string;
    const commentId = req.params.commentId as string;
    const task = await getAccessibleResource(req, res, svc.getById(id), "Task not found");
    if (!task) return;
    if (!(await assertTaskReadAllowed(req, res, task))) return;
    const comment = await svc.getBoardComment(task.companyId, id, commentId);
    if (!comment) {
      res.status(404).json({ error: "Comment not found" });
      return;
    }
    res.json(comment);
  });

  router.get("/tasks/:id/comments/:rootCommentId/thread", async (req, res) => {
    const id = req.params.id as string;
    const rootCommentId = req.params.rootCommentId as string;
    const task = await getAccessibleResource(req, res, svc.getById(id), "Task not found");
    if (!task) return;
    if (!(await assertTaskReadAllowed(req, res, task))) return;
    const query = taskCommentThreadPageQuerySchema.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: "Invalid task comment thread page query" });
      return;
    }
    const page = await svc.getBoardCommentThread(task.companyId, id, rootCommentId, {
      cursor: query.data.cursor ?? null,
      limit: query.data.limit ?? null,
    });
    if (!page) {
      res.status(404).json({ error: "Comment thread not found" });
      return;
    }
    res.json(page);
  });

  router.post("/tasks/:id/comments", validate(createTaskUserCommentSchema), async (req, res) => {
    const actorUserId = requireNamedBoardUser(req);
    const id = req.params.id as string;
    const existing = await getAccessibleResource(req, res, svc.getById(id), "Task not found");
    if (!existing) return;

    try {
      if (req.body.replyToCommentId) {
        await authorizeHumanTaskSteering(db, req, existing.companyId);
      }
      const result = await ordinaryTasks.userComment({
        companyId: existing.companyId,
        taskId: existing.id,
        actorUserId,
        message: req.body.message,
        idempotencyKey: req.body.idempotencyKey,
        mention: req.body.mention ?? null,
        replyToCommentId: req.body.replyToCommentId ?? null,
      });
      const comment = await svc.getBoardComment(existing.companyId, existing.id, result.comment.id);
      if (!comment) {
        throw new OrdinaryTaskRuntimeRejected(
          "Board comment projection is missing after commit",
          "board_comment_projection_missing",
        );
      }
      await opts.pluginDomainEvents.publish({
        eventId: comment.id,
        eventType: "task.board.comment.created",
        occurredAt: new Date().toISOString(),
        actorId: actorUserId,
        actorType: "user",
        entityId: comment.id,
        entityType: "task_comment",
        companyId: existing.companyId,
        payload: {
          companyId: existing.companyId,
          taskId: existing.id,
          commentId: comment.id,
        },
      });
      res.status(result.retried ? 200 : 201).json({
        comment,
        retried: result.retried,
      });
    } catch (error) {
      canonicalTaskMutationError(error);
    }
  });
}
