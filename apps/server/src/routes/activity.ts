import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { canonicalUuidSchema, isCanonicalUuid } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { activityService } from "../services/activity.js";
import { logActivity } from "../services/activity-log.js";
import { assertBoard, assertCompanyAccess, getAccessibleResource } from "./authz.js";
import { accessService, taskService } from "../services/index.js";
import {
  assertExactQueryKeys,
  parseExactOptionalNonBlankQuery,
  parseExactPositiveIntegerQuery,
} from "./exact-query.js";

const createActivitySchema = z.object({
  actorType: z.enum(["agent", "user", "system", "plugin"]).optional().default("system"),
  actorId: z.string().min(1),
  action: z.string().min(1),
  entityType: z.string().min(1),
  entityId: z.string().min(1),
  agentId: canonicalUuidSchema.optional().nullable(),
  details: z.record(z.unknown()).optional().nullable(),
});

export function activityRoutes(db: Db) {
  const router = Router({ caseSensitive: true, strict: true });
  const svc = activityService(db);
  const access = accessService(db);
  const taskSvc = taskService(db);

  async function assertCompanyScopeReadAllowed(
    req: Parameters<typeof assertCompanyAccess>[0],
    res: any,
    companyId: string,
  ) {
    const decision = await access.decide({
      actor: req.actor,
      action: "company_scope:read",
      resource: { type: "company", companyId },
    });
    if (decision.allowed) return true;
    res.status(403).json({
      error: "Activity is outside this actor's authorization boundary",
    });
    return false;
  }

  async function assertTaskReadAllowed(
    req: Parameters<typeof assertCompanyAccess>[0],
    res: any,
    task: {
      id: string;
      companyId: string;
      projectId: string | null;
      parentId: string | null;
      ownerAgentId: string | null;
      ownerUserId: string | null;
      boardPresentationStatus: string;
    },
  ) {
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
    res.status(403).json({
      error: "Task activity is outside this actor's authorization boundary",
    });
    return false;
  }

  router.get("/companies/:companyId/activity", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!(await assertCompanyScopeReadAllowed(req, res, companyId))) return;

    assertExactQueryKeys(req.query, ["agentId", "entityId", "entityType", "limit"]);
    const agentId = req.query.agentId;
    if (agentId !== undefined && (typeof agentId !== "string" || !isCanonicalUuid(agentId))) {
      res.status(400).json({ error: "agentId must be an exact canonical UUID" });
      return;
    }

    const filters = {
      companyId,
      agentId,
      entityType: parseExactOptionalNonBlankQuery(req.query.entityType, "entityType", 100),
      entityId: parseExactOptionalNonBlankQuery(req.query.entityId, "entityId", 500),
      limit: parseExactPositiveIntegerQuery(req.query.limit, "limit", {
        defaultValue: 100,
        max: 500,
      }),
    };
    const result = await svc.list(filters);
    res.json(result);
  });

  router.post("/companies/:companyId/activity", validate(createActivitySchema), async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const event = await logActivity(db, {
      companyId,
      ...req.body,
    });
    res.status(201).json(event);
  });

  router.get("/tasks/:id/activity", async (req, res) => {
    const taskId = req.params.id as string;
    const task = await getAccessibleResource(req, res, taskSvc.getById(taskId), "Task not found");
    if (!task) return;
    if (!(await assertTaskReadAllowed(req, res, task))) return;
    const result = await svc.forTask(task.id);
    res.json(result);
  });

  return router;
}
