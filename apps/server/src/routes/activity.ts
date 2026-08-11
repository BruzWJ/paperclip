import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { normalizeTaskIdentifier } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { activityService, normalizeActivityLimit } from "../services/activity.js";
import { assertBoard, assertCompanyAccess, getAccessibleResource } from "./authz.js";
import { accessService, taskService } from "../services/index.js";
import { sanitizeRecord } from "../redaction.js";

const createActivitySchema = z.object({
  actorType: z.enum(["agent", "user", "system", "plugin"]).optional().default("system"),
  actorId: z.string().min(1),
  action: z.string().min(1),
  entityType: z.string().min(1),
  entityId: z.string().min(1),
  agentId: z.string().uuid().optional().nullable(),
  details: z.record(z.unknown()).optional().nullable(),
});

export function activityRoutes(db: Db) {
  const router = Router();
  const svc = activityService(db);
  const access = accessService(db);
  const taskSvc = taskService(db);

  async function assertCompanyScopeReadAllowed(req: Parameters<typeof assertCompanyAccess>[0], res: any, companyId: string) {
    const decision = await access.decide({
      actor: req.actor,
      action: "company_scope:read",
      resource: { type: "company", companyId },
    });
    if (decision.allowed) return true;
    res.status(403).json({ error: "Activity is outside this actor's authorization boundary" });
    return false;
  }

  async function assertTaskReadAllowed(req: Parameters<typeof assertCompanyAccess>[0], res: any, task: {
    id: string;
    companyId: string;
    projectId: string | null;
    parentId: string | null;
    ownerAgentId: string | null;
    ownerUserId: string | null;
    boardPresentationStatus: string;
  }) {
    const decision = await access.decide({
      actor: req.actor,
      action: "task:read",
      resource: {
        type: "task",
        companyId: task.companyId,
        taskId: task.id,
        projectId: task.projectId,
        parentTaskId: task.parentId,
        ownerAgentId: task.ownerAgentId,
        ownerUserId: task.ownerUserId,
      },
    });
    if (decision.allowed) return true;
    res.status(403).json({ error: "Task activity is outside this actor's authorization boundary" });
    return false;
  }

  async function resolveTaskByRef(rawId: string) {
    const identifier = normalizeTaskIdentifier(rawId);
    if (identifier) {
      return taskSvc.getByIdentifier(identifier);
    }
    return taskSvc.getById(rawId);
  }

  router.get("/companies/:companyId/activity", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!(await assertCompanyScopeReadAllowed(req, res, companyId))) return;

    const filters = {
      companyId,
      agentId: req.query.agentId as string | undefined,
      entityType: req.query.entityType as string | undefined,
      entityId: req.query.entityId as string | undefined,
      limit: normalizeActivityLimit(Number(req.query.limit)),
    };
    const result = await svc.list(filters);
    res.json(result);
  });

  router.post("/companies/:companyId/activity", validate(createActivitySchema), async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const event = await svc.create({
      companyId,
      ...req.body,
      details: req.body.details ? sanitizeRecord(req.body.details) : null,
    });
    res.status(201).json(event);
  });

  router.get("/tasks/:id/activity", async (req, res) => {
    const rawId = req.params.id as string;
    const task = await getAccessibleResource(req, res, resolveTaskByRef(rawId), "Task not found");
    if (!task) return;
    if (!(await assertTaskReadAllowed(req, res, task))) return;
    const result = await svc.forTask(task.id);
    res.json(result);
  });

  return router;
}
