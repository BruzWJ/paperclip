import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { approvals, taskApprovals, taskExecutionAuthorities, tasks } from "@paperclipai/db";
import { notFound, unprocessable } from "../errors.js";
import { redactEventPayload } from "../redaction.js";

interface LinkActor {
  agentId?: string | null;
  userId?: string | null;
}

export function taskApprovalService(db: Db) {
  async function getTask(taskId: string) {
    return db
      .select()
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .then((rows) => rows[0] ?? null);
  }

  async function getApproval(approvalId: string) {
    return db
      .select()
      .from(approvals)
      .where(eq(approvals.id, approvalId))
      .then((rows) => rows[0] ?? null);
  }

  async function assertTaskAndApprovalSameCompany(taskId: string, approvalId: string) {
    const task = await getTask(taskId);
    if (!task) throw notFound("Task not found");

    const approval = await getApproval(approvalId);
    if (!approval) throw notFound("Approval not found");

    if (task.companyId !== approval.companyId) {
      throw unprocessable("Task and approval must belong to the same company");
    }

    return { task, approval };
  }

  return {
    listApprovalsForTask: async (taskId: string) => {
      const task = await getTask(taskId);
      if (!task) throw notFound("Task not found");

      const result = await db
        .select({
          id: approvals.id,
          companyId: approvals.companyId,
          type: approvals.type,
          requestedByAgentId: approvals.requestedByAgentId,
          requestedByUserId: approvals.requestedByUserId,
          status: approvals.status,
          payload: approvals.payload,
          decisionNote: approvals.decisionNote,
          decidedByUserId: approvals.decidedByUserId,
          decidedAt: approvals.decidedAt,
          createdAt: approvals.createdAt,
          updatedAt: approvals.updatedAt,
        })
        .from(taskApprovals)
        .innerJoin(approvals, eq(taskApprovals.approvalId, approvals.id))
        .where(eq(taskApprovals.taskId, taskId))
        .orderBy(desc(taskApprovals.createdAt));
      return result.map((approval) => ({
        ...approval,
        payload: redactEventPayload(approval.payload) ?? {},
      }));
    },

    listTasksForApproval: async (approvalId: string) => {
      const approval = await getApproval(approvalId);
      if (!approval) throw notFound("Approval not found");

      return db
        .select({
          id: tasks.id,
          companyId: tasks.companyId,
          projectId: tasks.projectId,
          goalId: tasks.goalId,
          parentId: tasks.parentId,
          title: tasks.title,
          request: tasks.request,
          boardPresentationStatus: tasks.boardPresentationStatus,
          priority: tasks.priority,
          ownerKind: tasks.ownerKind,
          ownerAgentId: tasks.ownerAgentId,
          ownerUserId: tasks.ownerUserId,
          creatorKind: tasks.creatorKind,
          creatorAgentId: taskExecutionAuthorities.agentId,
          creatorUserId: tasks.creatorUserId,
          taskNumber: tasks.taskNumber,
          identifier: tasks.identifier,
          requestDepth: tasks.requestDepth,
          billingCode: tasks.billingCode,
          startedAt: tasks.startedAt,
          completedAt: tasks.completedAt,
          cancelledAt: tasks.cancelledAt,
          createdAt: tasks.createdAt,
          updatedAt: tasks.updatedAt,
        })
        .from(taskApprovals)
        .innerJoin(tasks, eq(taskApprovals.taskId, tasks.id))
        .leftJoin(
          taskExecutionAuthorities,
          eq(taskExecutionAuthorities.id, tasks.creatorAuthorityId),
        )
        .where(eq(taskApprovals.approvalId, approvalId))
        .orderBy(desc(taskApprovals.createdAt));
    },

    link: async (taskId: string, approvalId: string, actor?: LinkActor) => {
      const { task } = await assertTaskAndApprovalSameCompany(taskId, approvalId);

      await db
        .insert(taskApprovals)
        .values({
          companyId: task.companyId,
          taskId,
          approvalId,
          linkedByAgentId: actor?.agentId ?? null,
          linkedByUserId: actor?.userId ?? null,
        })
        .onConflictDoNothing();

      return db
        .select()
        .from(taskApprovals)
        .where(and(eq(taskApprovals.taskId, taskId), eq(taskApprovals.approvalId, approvalId)))
        .then((rows) => rows[0] ?? null);
    },

    unlink: async (taskId: string, approvalId: string) => {
      await assertTaskAndApprovalSameCompany(taskId, approvalId);
      await db
        .delete(taskApprovals)
        .where(and(eq(taskApprovals.taskId, taskId), eq(taskApprovals.approvalId, approvalId)));
    },

    linkManyForApproval: async (approvalId: string, taskIds: string[], actor?: LinkActor) => {
      if (taskIds.length === 0) return;

      const approval = await getApproval(approvalId);
      if (!approval) throw notFound("Approval not found");

      const uniqueTaskIds = Array.from(new Set(taskIds));
      const rows = await db
        .select({
          id: tasks.id,
          companyId: tasks.companyId,
        })
        .from(tasks)
        .where(inArray(tasks.id, uniqueTaskIds));

      if (rows.length !== uniqueTaskIds.length) {
        throw notFound("One or more tasks not found");
      }

      for (const row of rows) {
        if (row.companyId !== approval.companyId) {
          throw unprocessable("Task and approval must belong to the same company");
        }
      }

      await db
        .insert(taskApprovals)
        .values(
          uniqueTaskIds.map((taskId) => ({
            companyId: approval.companyId,
            taskId,
            approvalId,
            linkedByAgentId: actor?.agentId ?? null,
            linkedByUserId: actor?.userId ?? null,
          })),
        )
        .onConflictDoNothing();
    },
  };
}
