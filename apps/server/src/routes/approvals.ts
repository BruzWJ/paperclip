import { Router, type Request, type RequestHandler, type Response } from "express";
import type { Db } from "@paperclipai/db";
import {
  APPROVAL_STATUSES,
  addApprovalCommentSchema,
  createApprovalSchema,
  requestApprovalRevisionSchema,
  resolveApprovalSchema,
  resubmitApprovalSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { approvalService, accessService, taskApprovalService, logActivity } from "../services/index.js";
import { assertBoard, assertCompanyAccess, getAccessibleResource, getBoardUserId } from "./authz.js";
import { redactEventPayload } from "../redaction.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import type { OrdinaryTaskRuntime } from "../services/ordinary-task-runtime.js";
import type { AgentLifecycleCancellationService } from "../services/agents.js";
import { terminateAgentForHireRejectionInTransaction } from "../services/plugin-managed-agents.js";
import { unprocessable } from "../errors.js";
import { assertExactQueryKeys, parseExactOptionalEnum } from "./exact-query.js";

function redactApprovalPayload<T extends { payload: Record<string, unknown> }>(approval: T): T {
  return {
    ...approval,
    payload: redactEventPayload(approval.payload) ?? {},
  };
}

export function approvalRoutes(
  db: Db,
  options: {
    pluginWorkerManager?: PluginWorkerManager;
    ordinaryTasks: OrdinaryTaskRuntime;
    taskExecutionCancellation: AgentLifecycleCancellationService;
  },
) {
  const router = Router({ caseSensitive: true, strict: true });
  const requireBoard: RequestHandler = (req, _res, next) => {
    assertBoard(req);
    next();
  };
  router.use("/approvals", requireBoard);
  router.use("/companies/:companyId/approvals", requireBoard);
  const svc = approvalService(db, {
    taskExecutionCancellation: options.taskExecutionCancellation,
    terminateHireRejectionAgentInTransaction: terminateAgentForHireRejectionInTransaction,
    dispatchRef: options.ordinaryTasks.dispatchRef,
  });
  const access = accessService(db);
  const taskApprovalsSvc = taskApprovalService(db);

  async function requireApprovalAccess(req: Request, res: Response, id: string) {
    return getAccessibleResource(req, res, svc.getById(id), "Approval not found");
  }

  async function assertApprovalAccessAllowed(req: Request, res: any, companyId: string) {
    const decision = await access.decide({
      actor: req.actor,
      action: "company_scope:read",
      resource: { type: "company", companyId },
    });
    if (decision.allowed) return true;
    res.status(403).json({
      error: "Approvals are outside this actor's authorization boundary",
    });
    return false;
  }

  router.get("/companies/:companyId/approvals", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!(await assertApprovalAccessAllowed(req, res, companyId))) return;
    assertExactQueryKeys(req.query, ["status"]);
    const status = parseExactOptionalEnum(req.query.status, "status", APPROVAL_STATUSES);
    const result = await svc.list(companyId, status);
    res.json(result.map((approval) => redactApprovalPayload(approval)));
  });

  router.get("/approvals/:id", async (req, res) => {
    const id = req.params.id as string;
    const approval = await getAccessibleResource(req, res, svc.getById(id), "Approval not found");
    if (!approval) return;
    if (!(await assertApprovalAccessAllowed(req, res, approval.companyId))) return;
    res.json(redactApprovalPayload(approval));
  });

  router.post("/companies/:companyId/approvals", validate(createApprovalSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!(await assertApprovalAccessAllowed(req, res, companyId))) return;
    const taskIds = req.body.taskIds ?? [];
    const { taskIds: _taskIds, ...approvalInput } = req.body;
    const approval = await svc.create(companyId, {
      ...approvalInput,
      requestedByUserId: req.actor.userId,
      requestedByAgentId: approvalInput.requestedByAgentId ?? null,
      status: "pending",
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      updatedAt: new Date(),
    });

    if (taskIds.length > 0) {
      await taskApprovalsSvc.linkManyForApproval(approval.id, taskIds, {
        userId: req.actor.userId,
      });
    }

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId,
      action: "approval.created",
      entityType: "approval",
      entityId: approval.id,
      details: { type: approval.type, taskIds },
    });

    res.status(201).json(redactApprovalPayload(approval));
  });

  router.get("/approvals/:id/tasks", async (req, res) => {
    const id = req.params.id as string;
    const approval = await getAccessibleResource(req, res, svc.getById(id), "Approval not found");
    if (!approval) return;
    if (!(await assertApprovalAccessAllowed(req, res, approval.companyId))) return;
    const tasks = await taskApprovalsSvc.listTasksForApproval(id);
    res.json(tasks);
  });

  router.post("/approvals/:id/approve", validate(resolveApprovalSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    if (!(await requireApprovalAccess(req, res, id))) return;
    const decidedByUserId = getBoardUserId(req);
    const { approval, applied } = await svc.approve(id, decidedByUserId, req.body.decisionNote);

    if (applied) {
      const linkedTasks = await taskApprovalsSvc.listTasksForApproval(approval.id);
      const linkedTaskIds = linkedTasks.map((task) => task.id);
      await logActivity(db, {
        companyId: approval.companyId,
        actorType: "user",
        actorId: getBoardUserId(req),
        action: "approval.approved",
        entityType: "approval",
        entityId: approval.id,
        details: {
          type: approval.type,
          requestedByAgentId: approval.requestedByAgentId,
          linkedTaskIds,
        },
      });

      // Approval resolution is a control-plane transition. It never creates a
      // provider input or re-invokes the requesting agent.
    }

    res.json(redactApprovalPayload(approval));
  });

  router.post("/approvals/:id/reject", validate(resolveApprovalSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    if (!(await requireApprovalAccess(req, res, id))) return;
    const decidedByUserId = getBoardUserId(req);
    const { approval, applied } = await svc.reject(id, decidedByUserId, req.body.decisionNote);

    if (applied) {
      await logActivity(db, {
        companyId: approval.companyId,
        actorType: "user",
        actorId: getBoardUserId(req),
        action: "approval.rejected",
        entityType: "approval",
        entityId: approval.id,
        details: { type: approval.type },
      });
    }

    res.json(redactApprovalPayload(approval));
  });

  router.post(
    "/approvals/:id/request-revision",
    validate(requestApprovalRevisionSchema),
    async (req, res) => {
      assertBoard(req);
      const id = req.params.id as string;
      if (!(await requireApprovalAccess(req, res, id))) return;
      const decidedByUserId = getBoardUserId(req);
      const approval = await svc.requestRevision(id, decidedByUserId, req.body.decisionNote);

      await logActivity(db, {
        companyId: approval.companyId,
        actorType: "user",
        actorId: getBoardUserId(req),
        action: "approval.revision_requested",
        entityType: "approval",
        entityId: approval.id,
        details: { type: approval.type },
      });

      res.json(redactApprovalPayload(approval));
    },
  );

  router.post("/approvals/:id/resubmit", validate(resubmitApprovalSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await getAccessibleResource(req, res, svc.getById(id), "Approval not found");
    if (!existing) return;

    let approval;
    if (existing.type === "hire_agent") {
      if (!req.body.hireAgent || req.body.payload !== undefined) {
        throw unprocessable(
          "Hire approval resubmission requires only the exact hireAgent audit/digest contract",
        );
      }
      approval = await svc.resubmitHire({
        approvalId: id,
        actor: {
          kind: "board",
          actorId: getBoardUserId(req),
          authorization: req.actor,
        },
        agentId: req.body.hireAgent.agentId,
        runtimeAgentConfigurationAuditId: req.body.hireAgent.runtimeAgentConfigurationAuditId,
        runtimeAgentConfigurationRequestDigest: req.body.hireAgent.runtimeAgentConfigurationRequestDigest,
        configuration: req.body.hireAgent.configuration,
      });
    } else {
      if (req.body.hireAgent) {
        throw unprocessable("hireAgent is valid only for a hire approval");
      }
      approval = await svc.resubmit(id, req.body.payload);
    }
    await logActivity(db, {
      companyId: approval.companyId,
      actorType: "user",
      actorId: req.actor.userId,
      action: "approval.resubmitted",
      entityType: "approval",
      entityId: approval.id,
      details: { type: approval.type },
    });
    res.json(redactApprovalPayload(approval));
  });

  router.get("/approvals/:id/comments", async (req, res) => {
    const id = req.params.id as string;
    const approval = await getAccessibleResource(req, res, svc.getById(id), "Approval not found");
    if (!approval) return;
    const comments = await svc.listComments(id);
    res.json(comments);
  });

  router.post("/approvals/:id/comments", validate(addApprovalCommentSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const approval = await getAccessibleResource(req, res, svc.getById(id), "Approval not found");
    if (!approval) return;
    const comment = await svc.addComment(id, req.body.body, {
      userId: req.actor.userId,
    });

    await logActivity(db, {
      companyId: approval.companyId,
      actorType: "user",
      actorId: req.actor.userId,
      action: "approval.comment_added",
      entityType: "approval",
      entityId: approval.id,
      details: { commentId: comment.id },
    });

    res.status(201).json(comment);
  });

  return router;
}
