import {
  commitTaskCreatorFormSchema,
  commitTaskOwnerFormSchema,
  reassignTaskSchema,
  reopenTaskSchema,
  selfAssignTaskWithdrawalSchema,
  updateTaskTitleSchema,
} from "@paperclipai/shared";
import { randomUUID } from "node:crypto";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { logActivity } from "../services/index.js";
import { assertBoard, getAccessibleResource } from "./authz.js";
import type { TaskRouteContext } from "./task-route-context.js";

type TaskMutationRoutesContext = Pick<
  TaskRouteContext,
  "db" | "router" | "svc" | "ordinaryTasks" | "requireNamedBoardUser" | "canonicalTaskMutationError"
>;

export function registerTaskMutationRoutes(context: TaskMutationRoutesContext): void {
  const { db, router, svc, ordinaryTasks, requireNamedBoardUser, canonicalTaskMutationError } = context;

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

  router.post("/tasks/:id/creator-reassign", validate(reassignTaskSchema), async (req, res) => {
    const actorUserId = requireNamedBoardUser(req);
    const id = req.params.id as string;
    const existing = await getAccessibleResource(req, res, svc.getById(id), "Task not found");
    if (!existing) return;

    try {
      const result = await ordinaryTasks.reassign({
        companyId: existing.companyId,
        taskId: existing.id,
        ownerAgentId: req.body.ownerAgentId,
        idempotencyKey: req.body.idempotencyKey,
        creator: { kind: "user/board", userId: actorUserId },
      });
      res.status(result.retried ? 200 : 201).json(result);
    } catch (error) {
      canonicalTaskMutationError(error);
    }
  });

  router.post(
    "/tasks/:id/withdrawal-self-assignment",
    validate(selfAssignTaskWithdrawalSchema),
    async (req, res) => {
      const actorUserId = requireNamedBoardUser(req);
      const id = req.params.id as string;
      const existing = await getAccessibleResource(req, res, svc.getById(id), "Task not found");
      if (!existing) return;

      try {
        const result = await ordinaryTasks.userCreatorWithdrawalSelfAssign({
          companyId: existing.companyId,
          taskId: existing.id,
          actorUserId,
          idempotencyKey: req.body.idempotencyKey,
        });
        res.status(result.retried ? 200 : 201).json(result);
      } catch (error) {
        canonicalTaskMutationError(error);
      }
    },
  );

  router.post("/task-creator-form-updates", validate(commitTaskCreatorFormSchema), async (req, res) => {
    const actorUserId = requireNamedBoardUser(req);
    const existing = await getAccessibleResource(req, res, svc.getById(req.body.taskId), "Task not found");
    if (!existing) return;

    try {
      const result = await ordinaryTasks.commitCreatorFormUpdate(existing.id, req.body.message, {
        kind: "user/board",
        companyId: existing.companyId,
        userId: actorUserId,
        gatewayInvocationId: `human-creator-form:${existing.companyId}:${randomUUID()}`,
      });
      res.status(201).json(result);
    } catch (error) {
      canonicalTaskMutationError(error);
    }
  });

  router.post("/task-owner-form-updates", validate(commitTaskOwnerFormSchema), async (req, res) => {
    const actorUserId = requireNamedBoardUser(req);
    const existing = await getAccessibleResource(req, res, svc.getById(req.body.taskId), "Task not found");
    if (!existing) return;

    const ownerAuthority =
      existing.creatorKind === "system" &&
      existing.escalatedFromAffectedTaskId &&
      ((existing.ownerKind === "user" && existing.ownerUserId === actorUserId) ||
        existing.ownerKind === "board")
        ? ({
            kind: "system-escalation-human",
            companyId: existing.companyId,
            actorUserId,
            gatewayInvocationId: `human-owner-form:${existing.companyId}:${randomUUID()}`,
          } as const)
        : existing.creatorKind === "user/board" &&
            existing.creatorUserId === actorUserId &&
            existing.ownerKind === "user" &&
            existing.ownerUserId === actorUserId &&
            existing.ownerAssignmentSource === "user_creator_withdrawal"
          ? ({
              kind: "user-creator-withdrawal",
              companyId: existing.companyId,
              actorUserId,
              gatewayInvocationId: `human-owner-form:${existing.companyId}:${randomUUID()}`,
            } as const)
          : null;
    if (!ownerAuthority) {
      throw forbidden("Only a documented human escalation or withdrawal owner may use the owner form");
    }

    try {
      const result = await ordinaryTasks.commitOwnerFormUpdate(
        existing.id,
        {
          message: req.body.message,
          ...(req.body.status === undefined ? {} : { status: req.body.status }),
          ...(Object.hasOwn(req.body, "structuredResult")
            ? { structuredResult: req.body.structuredResult }
            : {}),
        },
        ownerAuthority,
      );
      res.status(201).json(result);
    } catch (error) {
      canonicalTaskMutationError(error);
    }
  });

  router.post("/tasks/:id/reopen", validate(reopenTaskSchema), async (req, res) => {
    const actorUserId = requireNamedBoardUser(req);
    const id = req.params.id as string;
    const existing = await getAccessibleResource(req, res, svc.getById(id), "Task not found");
    if (!existing) return;

    try {
      const result = await ordinaryTasks.boardReopen({
        companyId: existing.companyId,
        taskId: existing.id,
        actorUserId,
        reason: req.body.reason,
        idempotencyKey: req.body.idempotencyKey,
      });
      res.status(result.retried ? 200 : 201).json(result);
    } catch (error) {
      canonicalTaskMutationError(error);
    }
  });
}
