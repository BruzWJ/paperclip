import { linkTaskApprovalSchema } from "@paperclipai/shared";
import { type Request } from "express";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { logActivity } from "../services/index.js";
import { assertBoard, getAccessibleResource } from "./authz.js";
import { taskIngressRoutes } from "./task-ingress.js";
import type { TaskRouteContext } from "./task-route-context.js";

type TaskStateApprovalRoutesContext = Pick<
  TaskRouteContext,
  | "db"
  | "router"
  | "svc"
  | "ordinaryTasks"
  | "taskApprovalsSvc"
  | "assertCanManageTaskApprovalLinks"
  | "assertTaskReadAllowed"
  | "assertBoardTaskMutationAllowed"
  | "inboxArchiveBodySchema"
>;

export function registerTaskStateAndApprovalRoutes(context: TaskStateApprovalRoutesContext): void {
  const {
    db,
    router,
    svc,
    ordinaryTasks,
    taskApprovalsSvc,
    assertCanManageTaskApprovalLinks,
    assertTaskReadAllowed,
    assertBoardTaskMutationAllowed,
    inboxArchiveBodySchema,
  } = context;

  router.post("/tasks/:id/read", async (req, res) => {
    const id = req.params.id as string;
    const task = await getAccessibleResource(req, res, svc.getById(id), "Task not found");
    if (!task) return;
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    if (!req.actor.userId) {
      res.status(403).json({ error: "Board user context required" });
      return;
    }
    const readState = await svc.markRead(task.companyId, task.id, req.actor.userId, new Date());
    await logActivity(db, {
      companyId: task.companyId,
      actorType: "user",
      actorId: req.actor.userId,
      action: "task.read_marked",
      entityType: "task",
      entityId: task.id,
      details: { userId: req.actor.userId, lastReadAt: readState.lastReadAt },
    });
    res.json(readState);
  });

  router.delete("/tasks/:id/read", async (req, res) => {
    const id = req.params.id as string;
    const task = await getAccessibleResource(req, res, svc.getById(id), "Task not found");
    if (!task) return;
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    if (!req.actor.userId) {
      res.status(403).json({ error: "Board user context required" });
      return;
    }
    const removed = await svc.markUnread(task.companyId, task.id, req.actor.userId);
    await logActivity(db, {
      companyId: task.companyId,
      actorType: "user",
      actorId: req.actor.userId,
      action: "task.read_unmarked",
      entityType: "task",
      entityId: task.id,
      details: { userId: req.actor.userId },
    });
    res.json({ id: task.id, removed });
  });

  function resolveInboxArchiveTarget(req: Request) {
    assertBoard(req);
    if (!req.actor.userId) {
      throw forbidden("Board user context required", {
        code: "inbox_target_user_unresolved",
      });
    }
    return {
      userId: req.actor.userId,
      targetResolvedFrom: "responsible_user" as const,
    };
  }

  router.post("/tasks/:id/inbox-archive", validate(inboxArchiveBodySchema), async (req, res) => {
    const id = req.params.id as string;
    const task = await getAccessibleResource(req, res, svc.getById(id), "Task not found");
    if (!task) return;
    const target = resolveInboxArchiveTarget(req);
    const archiveState = await svc.archiveInbox(task.companyId, task.id, target.userId, new Date(), {
      archivedByActorType: "user",
    });
    await logActivity(db, {
      companyId: task.companyId,
      actorType: "user",
      actorId: target.userId,
      action: "task.inbox_archived",
      entityType: "task",
      entityId: task.id,
      details: {
        userId: target.userId,
        archivedAt: archiveState.archivedAt,
        targetResolvedFrom: target.targetResolvedFrom,
      },
    });
    res.json(archiveState);
  });

  router.delete("/tasks/:id/inbox-archive", validate(inboxArchiveBodySchema), async (req, res) => {
    const id = req.params.id as string;
    const task = await getAccessibleResource(req, res, svc.getById(id), "Task not found");
    if (!task) return;
    const target = resolveInboxArchiveTarget(req);
    const removed = await svc.unarchiveInbox(task.companyId, task.id, target.userId);
    await logActivity(db, {
      companyId: task.companyId,
      actorType: "user",
      actorId: target.userId,
      action: "task.inbox_unarchived",
      entityType: "task",
      entityId: task.id,
      details: {
        userId: target.userId,
        targetResolvedFrom: target.targetResolvedFrom,
      },
    });
    res.json(removed ?? { ok: true, userId: target.userId });
  });

  router.get("/tasks/:id/approvals", async (req, res) => {
    const id = req.params.id as string;
    const task = await getAccessibleResource(req, res, svc.getById(id), "Task not found");
    if (!task) return;
    if (!(await assertTaskReadAllowed(req, res, task))) return;
    const approvals = await taskApprovalsSvc.listApprovalsForTask(id);
    res.json(approvals);
  });

  router.post("/tasks/:id/approvals", validate(linkTaskApprovalSchema), async (req, res) => {
    const id = req.params.id as string;
    const task = await getAccessibleResource(req, res, svc.getById(id), "Task not found");
    if (!task) return;
    if (!(await assertBoardTaskMutationAllowed(req, res, task))) return;
    if (!(await assertCanManageTaskApprovalLinks(req, task.companyId))) return;
    assertBoard(req);

    await taskApprovalsSvc.link(id, req.body.approvalId, {
      userId: req.actor.userId,
    });

    await logActivity(db, {
      companyId: task.companyId,
      actorType: "user",
      actorId: req.actor.userId,
      action: "task.approval_linked",
      entityType: "task",
      entityId: task.id,
      details: { approvalId: req.body.approvalId },
    });

    const approvals = await taskApprovalsSvc.listApprovalsForTask(id);
    res.status(201).json(approvals);
  });

  router.delete("/tasks/:id/approvals/:approvalId", async (req, res) => {
    const id = req.params.id as string;
    const approvalId = req.params.approvalId as string;
    const task = await getAccessibleResource(req, res, svc.getById(id), "Task not found");
    if (!task) return;
    if (!(await assertBoardTaskMutationAllowed(req, res, task))) return;
    if (!(await assertCanManageTaskApprovalLinks(req, task.companyId))) return;

    await taskApprovalsSvc.unlink(id, approvalId);

    assertBoard(req);
    await logActivity(db, {
      companyId: task.companyId,
      actorType: "user",
      actorId: req.actor.userId,
      action: "task.approval_unlinked",
      entityType: "task",
      entityId: task.id,
      details: { approvalId },
    });

    res.json({ ok: true });
  });

  router.use(
    taskIngressRoutes({
      ordinaryTasks,
      getTaskById: (id) => svc.getById(id),
    }),
  );
}
