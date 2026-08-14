import { decideTaskExecutionStageSchema, updateTaskExecutionPolicySchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { logActivity } from "../services/index.js";
import { normalizeTaskExecutionPolicy } from "../services/task-execution-policy.js";
import { getAccessibleResource } from "./authz.js";
import type { TaskRouteContext } from "./task-route-context.js";

type TaskExecutionPolicyRoutesContext = Pick<
  TaskRouteContext,
  | "db"
  | "router"
  | "svc"
  | "executionPolicyControl"
  | "summarizeTaskMonitor"
  | "diffExecutionParticipants"
  | "requireNamedBoardUser"
>;

export function registerTaskExecutionPolicyRoutes(context: TaskExecutionPolicyRoutesContext): void {
  const {
    db,
    router,
    svc,
    executionPolicyControl,
    summarizeTaskMonitor,
    diffExecutionParticipants,
    requireNamedBoardUser,
  } = context;

  router.put("/tasks/:id/execution-policy", validate(updateTaskExecutionPolicySchema), async (req, res) => {
    const actorUserId = requireNamedBoardUser(req);
    const id = req.params.id as string;
    const existing = await getAccessibleResource(req, res, svc.getById(id), "Task not found");
    if (!existing) return;

    const previousPolicy = normalizeTaskExecutionPolicy(existing.executionPolicy);
    const task = await executionPolicyControl.configure({
      companyId: existing.companyId,
      taskId: existing.id,
      executionPolicy: req.body.executionPolicy,
      actorUserId,
    });
    const nextPolicy = normalizeTaskExecutionPolicy(task.executionPolicy);

    await logActivity(db, {
      companyId: task.companyId,
      actorType: "user",
      actorId: actorUserId,
      action: "task.execution_policy_updated",
      entityType: "task",
      entityId: task.id,
      details: {
        identifier: task.identifier,
        executionPolicy: nextPolicy,
        executionState: task.executionState,
        _previous: {
          executionPolicy: previousPolicy,
          executionState: existing.executionState,
        },
      },
    });

    for (const stageType of ["review", "approval"] as const) {
      const changes = diffExecutionParticipants(previousPolicy, nextPolicy, stageType);
      if (changes.addedParticipants.length === 0 && changes.removedParticipants.length === 0) {
        continue;
      }
      await logActivity(db, {
        companyId: task.companyId,
        actorType: "user",
        actorId: actorUserId,
        action: stageType === "review" ? "task.reviewers_updated" : "task.approvers_updated",
        entityType: "task",
        entityId: task.id,
        details: {
          identifier: task.identifier,
          participants: changes.participants,
          addedParticipants: changes.addedParticipants,
          removedParticipants: changes.removedParticipants,
        },
      });
    }

    const previousMonitor = summarizeTaskMonitor(existing, previousPolicy);
    const nextMonitor = summarizeTaskMonitor(task, nextPolicy);
    if (
      nextMonitor.nextCheckAt &&
      (previousMonitor.nextCheckAt !== nextMonitor.nextCheckAt || previousMonitor.notes !== nextMonitor.notes)
    ) {
      await logActivity(db, {
        companyId: task.companyId,
        actorType: "user",
        actorId: actorUserId,
        action: "task.monitor_scheduled",
        entityType: "task",
        entityId: task.id,
        details: {
          identifier: task.identifier,
          nextCheckAt: nextMonitor.nextCheckAt,
          previousNextCheckAt: previousMonitor.nextCheckAt,
          notes: nextMonitor.notes,
          scheduledBy: nextMonitor.scheduledBy,
          serviceName: nextMonitor.serviceName,
          timeoutAt: nextMonitor.timeoutAt,
          maxAttempts: nextMonitor.maxAttempts,
          recoveryPolicy: nextMonitor.recoveryPolicy,
        },
      });
    } else if (!nextMonitor.nextCheckAt && previousMonitor.nextCheckAt) {
      await logActivity(db, {
        companyId: task.companyId,
        actorType: "user",
        actorId: actorUserId,
        action: "task.monitor_cleared",
        entityType: "task",
        entityId: task.id,
        details: {
          identifier: task.identifier,
          previousNextCheckAt: previousMonitor.nextCheckAt,
          reason: nextMonitor.clearReason ?? "manual",
          notes: previousMonitor.notes,
        },
      });
    }

    res.json(task);
  });

  router.post(
    "/tasks/:id/execution-policy/decisions",
    validate(decideTaskExecutionStageSchema),
    async (req, res) => {
      const actorUserId = requireNamedBoardUser(req);
      const id = req.params.id as string;
      const existing = await getAccessibleResource(req, res, svc.getById(id), "Task not found");
      if (!existing) return;

      const result = await executionPolicyControl.decide({
        companyId: existing.companyId,
        taskId: existing.id,
        outcome: req.body.outcome,
        body: req.body.body,
        reviewRequest: req.body.reviewRequest,
        idempotencyKey: req.body.idempotencyKey,
        actor: { userId: actorUserId },
      });

      if (!result.retried) {
        await logActivity(db, {
          companyId: result.task.companyId,
          actorType: "user",
          actorId: actorUserId,
          action: "task.execution_policy_decided",
          entityType: "task",
          entityId: result.task.id,
          details: {
            identifier: result.task.identifier,
            decisionId: result.decision.id,
            stageId: result.decision.stageId,
            stageType: result.decision.stageType,
            outcome: result.decision.outcome,
            lifecycleStatus: result.task.lifecycleStatus,
            boardStatus: result.task.boardPresentationStatus,
          },
        });
      }

      res.status(result.retried ? 200 : 201).json(result);
    },
  );
}
