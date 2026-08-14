import { and, desc, eq, gte, lte, or } from "drizzle-orm";
import { activityLog, approvals, taskApprovals, taskComments, tasks } from "@paperclipai/db";
import { visibleTaskCondition } from "./task-visibility.js";
import {
  listTaskExecutionRunsForActivity,
  listTaskExecutionRunsForWorkTimeline,
  type TaskExecutionRunEnvelope,
  type TaskExecutionRunListCursor,
} from "./task-execution-run-service.js";
import {
  ACL_FILTER_CONCURRENCY,
  MAX_SOURCE_ROWS,
  maybeUuidList,
  runOverlapsWindow,
  type WorkTimelineContext,
  type TaskRow,
  type WorkTimelineQuery,
} from "./work-timeline-contracts.js";

export function buildWorkTimelineRunQueries(scope: WorkTimelineContext) {
  const { db } = scope;

  async function listCompanyRunsInWindow(companyId: string, from: Date, to: Date, maximum: number) {
    const runs: TaskExecutionRunEnvelope[] = [];
    let cursor: TaskExecutionRunListCursor | null = null;
    do {
      const page = await listTaskExecutionRunsForActivity(db, {
        companyId,
        cursor,
        limit: 200,
      });
      for (const run of page.items) {
        if (runOverlapsWindow(run, from, to)) runs.push(run);
        if (runs.length === maximum) return runs;
      }
      cursor = page.nextCursor;
    } while (cursor !== null);
    return runs;
  }

  async function listTaskRunsInWindow(companyId: string, taskId: string, from: Date, to: Date) {
    const runs: TaskExecutionRunEnvelope[] = [];
    let cursor: TaskExecutionRunListCursor | null = null;
    do {
      const page = await listTaskExecutionRunsForWorkTimeline(db, {
        companyId,
        taskId,
        cursor,
        limit: 200,
      });
      runs.push(...page.items.filter((run) => runOverlapsWindow(run, from, to)));
      cursor = page.nextCursor;
    } while (cursor !== null);
    return runs;
  }

  async function filterReadableTasks(
    rows: TaskRow[],
    canReadTask: NonNullable<WorkTimelineQuery["canReadTask"]> | undefined,
  ) {
    if (!canReadTask) return rows;

    const allowedRows: TaskRow[] = [];
    for (let index = 0; index < rows.length; index += ACL_FILTER_CONCURRENCY) {
      const batch = rows.slice(index, index + ACL_FILTER_CONCURRENCY);
      const decisions = await Promise.all(
        batch.map(async (task) => ({
          task,
          allowed: await canReadTask({
            id: task.id,
            companyId: task.companyId,
            projectId: task.projectId,
            parentId: task.parentId,
            ownerAgentId: task.ownerAgentId,
            ownerUserId: task.ownerUserId,
            boardPresentationStatus: task.boardPresentationStatus,
          }),
        })),
      );
      for (const decision of decisions) {
        if (decision.allowed) allowedRows.push(decision.task);
      }
    }
    return allowedRows;
  }

  async function collectTaskIds(input: WorkTimelineQuery, from: Date, to: Date) {
    const ids = new Set<string>();

    if (input.taskId) {
      ids.add(input.taskId);
    }

    const filterConditions = [
      eq(tasks.companyId, input.companyId),
      visibleTaskCondition(),
      input.goalId ? eq(tasks.goalId, input.goalId) : undefined,
      input.projectId ? eq(tasks.projectId, input.projectId) : undefined,
      input.taskId ? eq(tasks.id, input.taskId) : undefined,
    ].filter(Boolean);

    const recentlyTouched = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          ...filterConditions,
          or(
            and(gte(tasks.createdAt, from), lte(tasks.createdAt, to)),
            and(gte(tasks.updatedAt, from), lte(tasks.updatedAt, to)),
          ),
        ),
      )
      .orderBy(desc(tasks.updatedAt))
      .limit(MAX_SOURCE_ROWS);
    for (const row of recentlyTouched) ids.add(row.id);

    const runRows = await listCompanyRunsInWindow(input.companyId, from, to, MAX_SOURCE_ROWS);
    for (const row of runRows) {
      ids.add(row.taskId);
    }

    const activityTaskRows = await db
      .select({ taskId: activityLog.entityId })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, input.companyId),
          eq(activityLog.entityType, "task"),
          gte(activityLog.createdAt, from),
          lte(activityLog.createdAt, to),
        ),
      )
      .orderBy(desc(activityLog.createdAt))
      .limit(MAX_SOURCE_ROWS);
    for (const row of activityTaskRows) ids.add(row.taskId);

    const commentTaskRows = await db
      .select({ taskId: taskComments.taskId })
      .from(taskComments)
      .where(
        and(
          eq(taskComments.companyId, input.companyId),
          gte(taskComments.createdAt, from),
          lte(taskComments.createdAt, to),
        ),
      )
      .orderBy(desc(taskComments.createdAt))
      .limit(MAX_SOURCE_ROWS);
    for (const row of commentTaskRows) ids.add(row.taskId);

    const approvalTaskRows = await db
      .select({ taskId: taskApprovals.taskId })
      .from(taskApprovals)
      .innerJoin(approvals, eq(taskApprovals.approvalId, approvals.id))
      .where(
        and(
          eq(taskApprovals.companyId, input.companyId),
          or(
            and(gte(approvals.createdAt, from), lte(approvals.createdAt, to)),
            and(gte(approvals.decidedAt, from), lte(approvals.decidedAt, to)),
          ),
        ),
      )
      .orderBy(desc(approvals.createdAt))
      .limit(MAX_SOURCE_ROWS);
    for (const row of approvalTaskRows) ids.add(row.taskId);

    return maybeUuidList(ids);
  }

  return {
    listCompanyRunsInWindow,
    listTaskRunsInWindow,
    filterReadableTasks,
    collectTaskIds,
  };
}
