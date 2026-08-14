import { and, asc, desc, eq, gt, inArray, lte, sql } from "drizzle-orm";
import {
  activityLog,
  folders,
  routineRuns,
  routineTriggers,
  routines,
  taskExecutionRefs,
  tasks,
  type Db,
} from "@paperclipai/db";
import type { RoutineListItem, RoutineRunSummary, RoutineTrigger } from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";
import { visibleTaskCondition } from "./task-visibility.js";
import {
  isWorktreeRuntimeEnvironment,
  resolveWorktreeRunExecutionActivationState,
  type WorktreeRunExecutionActivationState,
} from "./instance-settings.js";
import {
  ACTIVITY_GATE_IGNORED_ACTIONS,
  routineRunSummarySelection,
} from "./routine-ownership-and-secrets.js";
import { nextResultText } from "./routine-scheduling-and-variables.js";
import { mapRoutineRunSummary } from "./routine-projections.js";
import type { RoutineContext } from "./routines.js";
import type { RoutineHelpers1 } from "./routine-repository-helpers.js";

export function buildRoutineQueryHelpers(scope: RoutineContext & RoutineHelpers1) {
  const { db, instanceSettings, runtimeEnv } = scope;

  async function assertRoutineFolder(companyId: string, folderId: string | null | undefined) {
    if (!folderId) return;
    const folder = await db
      .select({ id: folders.id, kind: folders.kind })
      .from(folders)
      .where(and(eq(folders.companyId, companyId), eq(folders.id, folderId)))
      .then((rows) => rows[0] ?? null);
    if (!folder) throw notFound("Folder not found");
    if (folder.kind !== "routine") throw unprocessable("Folder kind must match routine");
  }

  async function listTriggersForRoutineIds(companyId: string, routineIds: string[]) {
    if (routineIds.length === 0) return new Map<string, RoutineTrigger[]>();
    const rows = await db
      .select()
      .from(routineTriggers)
      .where(and(eq(routineTriggers.companyId, companyId), inArray(routineTriggers.routineId, routineIds)))
      .orderBy(asc(routineTriggers.createdAt), asc(routineTriggers.id));
    const map = new Map<string, RoutineTrigger[]>();
    for (const row of rows) {
      const list = map.get(row.routineId) ?? [];
      list.push(row);
      map.set(row.routineId, list);
    }
    return map;
  }

  async function listRoutineRunSummaries(routineId: string, limit: number) {
    const rows = await db
      .select(routineRunSummarySelection)
      .from(routineRuns)
      .leftJoin(routineTriggers, eq(routineRuns.triggerId, routineTriggers.id))
      .leftJoin(tasks, eq(routineRuns.linkedTaskId, tasks.id))
      .where(eq(routineRuns.routineId, routineId))
      .orderBy(desc(routineRuns.createdAt))
      .limit(limit);
    return rows.map(mapRoutineRunSummary);
  }

  async function listLatestRunByRoutineIds(companyId: string, routineIds: string[]) {
    if (routineIds.length === 0) return new Map<string, RoutineRunSummary>();
    const rows = await db
      .selectDistinctOn([routineRuns.routineId], routineRunSummarySelection)
      .from(routineRuns)
      .leftJoin(routineTriggers, eq(routineRuns.triggerId, routineTriggers.id))
      .leftJoin(tasks, eq(routineRuns.linkedTaskId, tasks.id))
      .where(and(eq(routineRuns.companyId, companyId), inArray(routineRuns.routineId, routineIds)))
      .orderBy(routineRuns.routineId, desc(routineRuns.createdAt), desc(routineRuns.id));

    const map = new Map<string, RoutineRunSummary>();
    for (const row of rows) {
      map.set(row.routineId, mapRoutineRunSummary(row));
    }
    return map;
  }

  async function listLiveTaskByRoutineIds(companyId: string, routineIds: string[]) {
    if (routineIds.length === 0) return new Map<string, RoutineListItem["activeTask"]>();
    const rows = await db
      .selectDistinctOn([tasks.creatorRoutineId], {
        routineId: tasks.creatorRoutineId,
        id: tasks.id,
        taskNumber: tasks.taskNumber,
        identifier: tasks.identifier,
        title: tasks.title,
        boardPresentationStatus: tasks.boardPresentationStatus,
        priority: tasks.priority,
        updatedAt: tasks.updatedAt,
      })
      .from(tasks)
      .where(
        and(
          eq(tasks.companyId, companyId),
          eq(tasks.creatorKind, "routine"),
          inArray(tasks.creatorRoutineId, routineIds),
          inArray(tasks.lifecycleStatus, ["open", "blocked"]),
          visibleTaskCondition(),
        ),
      )
      .orderBy(tasks.creatorRoutineId, desc(tasks.updatedAt), desc(tasks.createdAt));

    const map = new Map<string, RoutineListItem["activeTask"]>();
    for (const row of rows) {
      if (!row.routineId) continue;
      map.set(row.routineId, {
        id: row.id,
        taskNumber: row.taskNumber,
        identifier: row.identifier,
        title: row.title,
        boardPresentationStatus: row.boardPresentationStatus,
        priority: row.priority,
        updatedAt: row.updatedAt,
      });
    }
    return map;
  }

  async function updateRoutineTouchedState(
    input: {
      routineId: string;
      triggerId?: string | null;
      triggeredAt: Date;
      status: string;
      taskId?: string | null;
      nextRunAt?: Date | null;
    },
    executor: Db = db,
  ) {
    await executor
      .update(routines)
      .set({
        lastTriggeredAt: input.triggeredAt,
        lastEnqueuedAt: input.taskId ? input.triggeredAt : undefined,
        updatedAt: new Date(),
      })
      .where(eq(routines.id, input.routineId));

    if (input.triggerId) {
      await executor
        .update(routineTriggers)
        .set({
          lastFiredAt: input.triggeredAt,
          lastResult: nextResultText(input.status, input.taskId),
          nextRunAt: input.nextRunAt === undefined ? undefined : input.nextRunAt,
          updatedAt: new Date(),
        })
        .where(eq(routineTriggers.id, input.triggerId));
    }
  }

  async function getAutomaticRoutineDispatchEligibility(
    routine: typeof routines.$inferSelect,
    activation?: WorktreeRunExecutionActivationState,
  ) {
    if (!isWorktreeRuntimeEnvironment(runtimeEnv.PAPERCLIP_IN_WORKTREE)) {
      return { eligible: true };
    }

    const resolvedActivation =
      activation ??
      (await resolveWorktreeRunExecutionActivationState({
        getGeneral: instanceSettings.getGeneral,
        runtimeEnv,
      }));
    if (!resolvedActivation.armed) return { eligible: false };

    const cutoff = new Date(resolvedActivation.cutoff);
    if (Number.isNaN(cutoff.getTime()) || routine.createdAt < cutoff) {
      return { eligible: false };
    }
    return { eligible: true };
  }

  async function evaluateActivityGate(routine: typeof routines.$inferSelect, now: Date) {
    const lastDispatchedRun = await db
      .select({ triggeredAt: routineRuns.triggeredAt })
      .from(routineRuns)
      .where(
        and(
          eq(routineRuns.companyId, routine.companyId),
          eq(routineRuns.routineId, routine.id),
          sql`${routineRuns.status} not in ('skipped', 'coalesced')`,
        ),
      )
      .orderBy(desc(routineRuns.triggeredAt), desc(routineRuns.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);

    if (!lastDispatchedRun) {
      return { fire: true, windowStart: null, matchedActivity: null };
    }

    const projectScopeCondition =
      routine.activityGateScope === "project"
        ? routine.projectId
          ? sql`(
            (${activityLog.entityType} = 'project' and ${activityLog.entityId} = ${routine.projectId})
            or (${activityLog.details} ->> 'projectId') = ${routine.projectId}
            or exists (
              select 1
              from ${tasks} activity_task
              where activity_task.company_id = ${routine.companyId}
                and activity_task.project_id = ${routine.projectId}
                and activity_task.id::text = ${activityLog.entityId}
                and ${activityLog.entityType} = 'task'
            )
            or exists (
              select 1
              from ${taskExecutionRefs} activity_ref
              inner join ${tasks} run_task
                on run_task.company_id = activity_ref.company_id
                and run_task.id = activity_ref.task_id
              where activity_ref.company_id = ${routine.companyId}
                and activity_ref.run_id = ${activityLog.runId}
                and run_task.project_id = ${routine.projectId}
            )
            or exists (
              select 1
              from ${routines} activity_routine
              where activity_routine.company_id = ${routine.companyId}
                and activity_routine.project_id = ${routine.projectId}
                and activity_routine.id::text = ${activityLog.entityId}
                and ${activityLog.entityType} = 'routine'
            )
            or exists (
              select 1
              from ${routineRuns} activity_routine_run
              inner join ${routines} activity_routine
                on activity_routine.company_id = ${routine.companyId}
                and activity_routine.id = activity_routine_run.routine_id
              where activity_routine_run.company_id = ${routine.companyId}
                and activity_routine_run.id::text = ${activityLog.entityId}
                and activity_routine.project_id = ${routine.projectId}
                and ${activityLog.entityType} = 'routine_run'
            )
            )`
          : sql`false`
        : undefined;

    const matchedActivity = await db
      .select({
        id: activityLog.id,
        action: activityLog.action,
        createdAt: activityLog.createdAt,
      })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, routine.companyId),
          gt(activityLog.createdAt, lastDispatchedRun.triggeredAt),
          lte(activityLog.createdAt, now),
          sql`${activityLog.action} not in (${sql.join(
            ACTIVITY_GATE_IGNORED_ACTIONS.map((action) => sql`${action}`),
            sql`, `,
          )})`,
          sql`not (
              ${activityLog.actorId} = 'routine-scheduler'
              and (
                (${activityLog.details} ->> 'routineId') = ${routine.id}
                or (${activityLog.entityType} = 'routine' and ${activityLog.entityId} = ${routine.id})
              )
            )`,
          sql`not exists (
              select 1
              from ${taskExecutionRefs} own_ref
              inner join ${tasks} own_task
                on own_task.company_id = own_ref.company_id
                and own_task.id = own_ref.task_id
              where own_ref.company_id = ${routine.companyId}
                and own_ref.run_id = ${activityLog.runId}
                and own_task.origin_kind = 'routine_execution'
                and own_task.origin_id = ${routine.id}
            )`,
          projectScopeCondition,
        ),
      )
      .orderBy(asc(activityLog.createdAt), asc(activityLog.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);

    return {
      fire: matchedActivity !== null,
      windowStart: lastDispatchedRun.triggeredAt,
      matchedActivity,
    };
  }

  return {
    assertRoutineFolder,
    listTriggersForRoutineIds,
    listRoutineRunSummaries,
    listLatestRunByRoutineIds,
    listLiveTaskByRoutineIds,
    updateRoutineTouchedState,
    getAutomaticRoutineDispatchEligibility,
    evaluateActivityGate,
  };
}

export type RoutineHelpers2 = ReturnType<typeof buildRoutineQueryHelpers>;
