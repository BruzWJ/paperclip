import { and, eq, gte, inArray, lte } from "drizzle-orm";
import {
  activityLog,
  agents,
  approvals,
  authUsers,
  taskApprovals,
  taskComments,
  taskExecutionAuthorities,
  tasks,
} from "@paperclipai/db";
import { visibleTaskCondition } from "./task-visibility.js";
import {
  actorId,
  maybeUuidList,
  type TaskRow,
  type WorkTimelineQuery,
  type WorkTimelineContext,
} from "./work-timeline-contracts.js";
import { buildWorkTimelineRunQueries } from "./work-timeline-run-queries.js";

export function buildWorkTimelineTaskLens(
  scope: WorkTimelineContext & ReturnType<typeof buildWorkTimelineRunQueries>,
) {
  const { db } = scope;

  async function loadTasks(input: WorkTimelineQuery, taskIds: string[]) {
    if (taskIds.length === 0) return [];
    return db
      .select({
        id: tasks.id,
        companyId: tasks.companyId,
        projectId: tasks.projectId,
        goalId: tasks.goalId,
        parentId: tasks.parentId,
        taskNumber: tasks.taskNumber,
        identifier: tasks.identifier,
        title: tasks.title,
        creatorKind: tasks.creatorKind,
        creatorAgentId: taskExecutionAuthorities.agentId,
        creatorUserId: tasks.creatorUserId,
        ownerAgentId: tasks.ownerAgentId,
        ownerUserId: tasks.ownerUserId,
        boardPresentationStatus: tasks.boardPresentationStatus,
        createdAt: tasks.createdAt,
      })
      .from(tasks)
      .leftJoin(taskExecutionAuthorities, eq(taskExecutionAuthorities.id, tasks.creatorAuthorityId))
      .where(
        and(
          eq(tasks.companyId, input.companyId),
          visibleTaskCondition(),
          inArray(tasks.id, taskIds),
          input.goalId ? eq(tasks.goalId, input.goalId) : undefined,
          input.projectId ? eq(tasks.projectId, input.projectId) : undefined,
          input.taskId ? eq(tasks.id, input.taskId) : undefined,
        ),
      );
  }

  async function applyUserLens(input: WorkTimelineQuery, rows: TaskRow[], from: Date, to: Date) {
    if (!input.userId) return rows;

    const byId = new Map(rows.map((task) => [task.id, task]));
    const selected = new Set<string>();
    for (const task of rows) {
      if (
        (task.creatorKind === "user/board" && task.creatorUserId === input.userId) ||
        task.ownerUserId === input.userId
      ) {
        selected.add(task.id);
      }
    }

    const [commentRows, approvalRows, activityRows] = await Promise.all([
      db
        .select({ taskId: taskComments.taskId })
        .from(taskComments)
        .where(
          and(
            eq(taskComments.companyId, input.companyId),
            eq(taskComments.authorUserId, input.userId),
            gte(taskComments.createdAt, from),
            lte(taskComments.createdAt, to),
          ),
        ),
      db
        .select({ taskId: taskApprovals.taskId })
        .from(taskApprovals)
        .innerJoin(approvals, eq(taskApprovals.approvalId, approvals.id))
        .where(
          and(
            eq(taskApprovals.companyId, input.companyId),
            eq(approvals.decidedByUserId, input.userId),
            gte(approvals.decidedAt, from),
            lte(approvals.decidedAt, to),
          ),
        ),
      db
        .select({ taskId: activityLog.entityId })
        .from(activityLog)
        .where(
          and(
            eq(activityLog.companyId, input.companyId),
            eq(activityLog.actorType, "user"),
            eq(activityLog.actorId, input.userId),
            eq(activityLog.entityType, "task"),
            gte(activityLog.createdAt, from),
            lte(activityLog.createdAt, to),
          ),
        ),
    ]);

    for (const row of [...commentRows, ...approvalRows, ...activityRows]) {
      selected.add(row.taskId);
    }

    let changed = true;
    while (changed) {
      changed = false;
      for (const task of rows) {
        if (task.parentId && selected.has(task.parentId) && !selected.has(task.id)) {
          selected.add(task.id);
          changed = true;
        }
      }
    }

    return rows.filter(
      (task) => selected.has(task.id) || (byId.get(task.parentId ?? "") && selected.has(task.parentId ?? "")),
    );
  }

  async function loadActorMaps(companyId: string, actorIds: Set<string>) {
    const agentIds = Array.from(actorIds)
      .filter((id) => id.startsWith("agent:"))
      .map((id) => id.slice("agent:".length));
    const userIds = Array.from(actorIds)
      .filter((id) => id.startsWith("user:"))
      .map((id) => id.slice("user:".length));

    const [agentRows, userRows] = await Promise.all([
      agentIds.length > 0
        ? db
            .select({
              id: agents.id,
              name: agents.name,
              icon: agents.icon,
            })
            .from(agents)
            .where(and(eq(agents.companyId, companyId), inArray(agents.id, maybeUuidList(agentIds))))
        : [],
      userIds.length > 0
        ? db
            .select({
              id: authUsers.id,
              name: authUsers.name,
              image: authUsers.image,
            })
            .from(authUsers)
            .where(inArray(authUsers.id, maybeUuidList(userIds)))
        : [],
    ]);

    return {
      agents: new Map(agentRows.map((agent) => [agent.id, agent])),
      users: new Map(userRows.map((user) => [user.id, user])),
    };
  }

  return { loadTasks, applyUserLens, loadActorMaps };
}
