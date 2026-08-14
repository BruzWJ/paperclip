import { Router, type NextFunction, type Request, type Response } from "express";
import { createChildTaskSchema, createTaskSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { OrdinaryTaskRuntimeRejected, type OrdinaryTaskRuntime } from "../services/ordinary-task-runtime.js";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { assertBoard, assertCompanyAccess, getAccessibleResource } from "./authz.js";

type TaskIngressParent = {
  id: string;
  companyId: string;
};

function canonicalTaskCreateError(error: unknown): never {
  if (!(error instanceof OrdinaryTaskRuntimeRejected)) {
    throw error;
  }
  const details = { code: error.reason };
  if (error.reason === "create_idempotency_conflict") {
    throw conflict(error.message, details);
  }
  if (error.reason === "parent_task_invalid") {
    throw notFound("Parent task not found");
  }
  if (error.reason === "company_inactive" || error.reason === "canonical_create_incomplete") {
    throw conflict(error.message, details);
  }
  throw unprocessable(error.message, details);
}

function requireNamedBoardTaskCreator(req: Request, _res: Response, next: NextFunction) {
  try {
    assertBoard(req);
    if (!req.actor.userId || req.actor.userId.trim() !== req.actor.userId) {
      throw forbidden("Task creation requires an exact authenticated board user ID");
    }
    next();
  } catch (error) {
    next(error);
  }
}

export function taskIngressRoutes(input: {
  ordinaryTasks: OrdinaryTaskRuntime;
  getTaskById(id: string): Promise<TaskIngressParent | null>;
}) {
  const router = Router({ caseSensitive: true, strict: true });

  router.post(
    "/companies/:companyId/tasks",
    requireNamedBoardTaskCreator,
    validate(createTaskSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const userId = req.actor.userId!;
      try {
        const created = await input.ordinaryTasks.create({
          companyId,
          request: req.body.request,
          ownerAgentId: req.body.ownerAgentId,
          creator: { kind: "user/board", userId },
          idempotencyKey: req.body.idempotencyKey,
          sourceKind: "task_request",
          title: req.body.title ?? null,
          projectId: req.body.projectId ?? null,
          projectWorkspaceId: req.body.projectWorkspaceId ?? null,
          goalId: req.body.goalId ?? null,
          parentId: req.body.parentId ?? null,
          priority: req.body.priority,
        });
        res.status(created.retried ? 200 : 201).json({
          ...created.task,
          refId: created.ref.id,
          retried: created.retried,
        });
      } catch (error) {
        canonicalTaskCreateError(error);
      }
    },
  );

  router.post(
    "/tasks/:id/children",
    requireNamedBoardTaskCreator,
    validate(createChildTaskSchema),
    async (req, res) => {
      const parentId = req.params.id as string;
      const parent = await getAccessibleResource(
        req,
        res,
        input.getTaskById(parentId),
        "Parent task not found",
      );
      if (!parent) return;
      const userId = req.actor.userId!;
      try {
        const created = await input.ordinaryTasks.create({
          companyId: parent.companyId,
          request: req.body.request,
          ownerAgentId: req.body.ownerAgentId,
          creator: { kind: "user/board", userId },
          idempotencyKey: req.body.idempotencyKey,
          sourceKind: "task_request",
          title: req.body.title ?? null,
          projectId: req.body.projectId ?? null,
          projectWorkspaceId: req.body.projectWorkspaceId ?? null,
          goalId: req.body.goalId ?? null,
          parentId: parent.id,
          priority: req.body.priority,
        });
        res.status(created.retried ? 200 : 201).json({
          ...created.task,
          refId: created.ref.id,
          retried: created.retried,
        });
      } catch (error) {
        canonicalTaskCreateError(error);
      }
    },
  );

  return router;
}
