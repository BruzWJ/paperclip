import { createTaskLabelSchema, isCanonicalUuid, parseTaskNumber } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { validate } from "../middleware/validate.js";
import { logActivity } from "../services/index.js";
import { assertBoard, assertCompanyAccess, getAccessibleResource } from "./authz.js";
import type { TaskRouteContext } from "./task-route-context.js";

type TaskLabelDiagnosticRoutesContext = Pick<
  TaskRouteContext,
  | "db"
  | "router"
  | "svc"
  | "workProductsSvc"
  | "documentsSvc"
  | "parseBooleanQuery"
  | "assertTaskReadAllowed"
  | "filterTasksForActor"
  | "respondWithTaskDetail"
  | "buildTaskBlockerDiagnosticsResponse"
  | "buildTaskSubtreeDiagnosticsResponse"
>;

export function registerTaskLabelAndDiagnosticRoutes(context: TaskLabelDiagnosticRoutesContext): void {
  const {
    db,
    router,
    svc,
    workProductsSvc,
    documentsSvc,
    parseBooleanQuery,
    assertTaskReadAllowed,
    filterTasksForActor,
    respondWithTaskDetail,
    buildTaskBlockerDiagnosticsResponse,
    buildTaskSubtreeDiagnosticsResponse,
  } = context;

  router.get("/companies/:companyId/tasks/:taskNumber", async (req, res) => {
    const companyId = req.params.companyId as string;
    const taskNumber = parseTaskNumber(req.params.taskNumber as string);
    if (!isCanonicalUuid(companyId)) {
      res.status(400).json({ error: "companyId must be a canonical UUID" });
      return;
    }
    if (taskNumber === null) {
      res.status(400).json({ error: "taskNumber must be a canonical positive integer" });
      return;
    }
    assertCompanyAccess(req, companyId);
    const task = await svc.getByCompanyTaskNumber(companyId, taskNumber);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    if (!(await assertTaskReadAllowed(req, res, task))) return;
    await respondWithTaskDetail(req, res, task);
  });

  router.get("/companies/:companyId/labels", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.listLabels(companyId);
    res.json(result);
  });

  router.post("/companies/:companyId/labels", validate(createTaskLabelSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const label = await svc.createLabel(companyId, req.body);
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId,
      action: "label.created",
      entityType: "label",
      entityId: label.id,
      details: { name: label.name, color: label.color },
    });
    res.status(201).json(label);
  });

  router.delete("/labels/:labelId", async (req, res) => {
    assertBoard(req);
    const labelId = req.params.labelId as string;
    const existing = await getAccessibleResource(req, res, svc.getLabelById(labelId), "Label not found");
    if (!existing) return;
    const removed = await svc.deleteLabel(labelId);
    if (!removed) {
      res.status(404).json({ error: "Label not found" });
      return;
    }
    await logActivity(db, {
      companyId: removed.companyId,
      actorType: "user",
      actorId: req.actor.userId,
      action: "label.deleted",
      entityType: "label",
      entityId: removed.id,
      details: { name: removed.name, color: removed.color },
    });
    res.json(removed);
  });

  router.get("/tasks/:id/diagnostics/blockers", async (req, res) => {
    const id = req.params.id as string;
    const task = await getAccessibleResource(req, res, svc.getById(id), "Task not found");
    if (!task) return;
    if (!(await assertTaskReadAllowed(req, res, task))) return;

    const diagnostic = await svc.getBlockerDiagnostics(task.id);
    const visibleBlockers = await filterTasksForActor(req, diagnostic.blockers);
    const response = buildTaskBlockerDiagnosticsResponse({
      task,
      blockers: diagnostic.blockers,
      visibleBlockers,
      readiness: diagnostic.readiness,
      truncated: diagnostic.truncated,
    });

    logger.info(
      {
        companyId: task.companyId,
        taskId: task.id,
        actorType: req.actor.type,
        visibleBlockerCount: response.blockers.length,
        omittedUnauthorizedBlockerCount: response.omittedUnauthorizedBlockerCount,
        truncated: response.truncated,
      },
      "task blocker diagnostics read",
    );

    res.json(response);
  });

  router.get("/tasks/:id/diagnostics/subtree", async (req, res) => {
    const id = req.params.id as string;
    const task = await getAccessibleResource(req, res, svc.getById(id), "Task not found");
    if (!task) return;
    if (!(await assertTaskReadAllowed(req, res, task))) return;

    const diagnostic = await svc.getSubtreeDiagnostics(task.id);
    const allBlockers = [...diagnostic.blockersByTaskId.values()].flat();
    const [visibleNodes, visibleBlockers] = await Promise.all([
      filterTasksForActor(req, diagnostic.nodes),
      filterTasksForActor(req, allBlockers),
    ]);
    const response = buildTaskSubtreeDiagnosticsResponse({
      task,
      nodes: diagnostic.nodes,
      visibleNodes,
      blockersByTaskId: diagnostic.blockersByTaskId,
      visibleBlockers,
      readinessByTaskId: diagnostic.readinessByTaskId,
      truncatedNodes: diagnostic.truncatedNodes,
      truncatedDepth: diagnostic.truncatedDepth,
      truncatedBlockerTaskIds: diagnostic.truncatedBlockerTaskIds,
      caps: diagnostic.caps,
    });

    logger.info(
      {
        companyId: task.companyId,
        taskId: task.id,
        actorType: req.actor.type,
        nodeCount: response.nodeCount,
        omittedUnauthorizedNodeCount: response.omittedUnauthorizedNodeCount,
        edgeCount: response.edges.length,
        truncated: response.truncated,
      },
      "task subtree diagnostics read",
    );

    res.json(response);
  });

  router.get("/tasks/:id", async (req, res) => {
    const id = req.params.id as string;
    const task = await getAccessibleResource(req, res, svc.getById(id), "Task not found");
    if (!task) return;
    if (!(await assertTaskReadAllowed(req, res, task))) return;
    await respondWithTaskDetail(req, res, task);
  });

  router.get("/tasks/:id/work-products", async (req, res) => {
    const id = req.params.id as string;
    const task = await getAccessibleResource(req, res, svc.getById(id), "Task not found");
    if (!task) return;
    if (!(await assertTaskReadAllowed(req, res, task))) return;
    const workProducts = await workProductsSvc.listForTask(task.id);
    res.json(workProducts);
  });

  router.get("/tasks/:id/documents", async (req, res) => {
    const id = req.params.id as string;
    const task = await getAccessibleResource(req, res, svc.getById(id), "Task not found");
    if (!task) return;
    if (!(await assertTaskReadAllowed(req, res, task))) return;
    const docs = await documentsSvc.listTaskDocuments(task.id, {
      includeSystem: parseBooleanQuery(req.query.includeSystem, "includeSystem"),
    });
    res.json(docs);
  });
}
