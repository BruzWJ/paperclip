import { type Db, agents, projects, routines, routineTriggers } from "@paperclipai/db";
import {
  syncRoutineVariablesWithTemplate,
  type CreateRoutine,
  type Routine,
  type RoutineDetail,
  type RoutineListItem,
  type RoutineTrigger,
} from "@paperclipai/shared";
import { and, asc, desc, eq } from "drizzle-orm";
import { unprocessable } from "../errors.js";
import {
  Actor,
  resolveRoutineResponsibleUserId,
  routineSecretMutationActor,
} from "./routine-ownership-and-secrets.js";
import {
  assertRoutineVariableDefinitions,
  normalizeDraftRoutineStatus,
  sanitizeRoutineVariableInputs,
} from "./routine-scheduling-and-variables.js";
import type { RoutineServiceScope } from "./routines.js";
import type { TaskSessionDbTransaction } from "./task-session/event-store.js";

export function buildRoutineCoreMethods(scope: RoutineServiceScope) {
  const {
    db,
    deps,
    taskSvc,
    secretsSvc,
    getRoutineById,
    listManagedRoutineMetadata,
    getTriggerById,
    getRoutineDescriptionDocument,
    appendRoutineRevision,
    assertInvokableRoutineAssigneeInTransaction,
    assertProject,
    assertGoal,
    assertParentTask,
    assertRoutineFolder,
    listTriggersForRoutineIds,
    listRoutineRunSummaries,
    listLatestRunByRoutineIds,
    listLiveTaskByRoutineIds,
    evaluateActivityGate,
    findLiveExecutionTask,
  } = scope;
  return {
    evaluateActivityGate,
    get: getRoutineById,
    getTrigger: getTriggerById,
    list: async (companyId: string, filters?: { projectId?: string | null }): Promise<RoutineListItem[]> => {
      const conditions = [eq(routines.companyId, companyId)];
      if (filters?.projectId) conditions.push(eq(routines.projectId, filters.projectId));

      const rows = await db
        .select()
        .from(routines)
        .where(and(...conditions))
        .orderBy(desc(routines.updatedAt), asc(routines.title));
      const routineIds = rows.map((row) => row.id);
      const [triggersByRoutine, latestRunByRoutine, activeTaskByRoutine, managedByRoutine] =
        await Promise.all([
          listTriggersForRoutineIds(companyId, routineIds),
          listLatestRunByRoutineIds(companyId, routineIds),
          listLiveTaskByRoutineIds(companyId, routineIds),
          listManagedRoutineMetadata(routineIds),
        ]);
      return rows.map((row) => ({
        ...row,
        managedByPlugin: managedByRoutine.get(row.id) ?? null,
        triggers: (triggersByRoutine.get(row.id) ?? []).map((trigger) => ({
          id: trigger.id,
          kind: trigger.kind as RoutineListItem["triggers"][number]["kind"],
          label: trigger.label,
          enabled: trigger.enabled,
          cronExpression: trigger.cronExpression,
          timezone: trigger.timezone,
          nextRunAt: trigger.nextRunAt,
          lastFiredAt: trigger.lastFiredAt,
          lastResult: trigger.lastResult,
        })),
        lastRun: latestRunByRoutine.get(row.id) ?? null,
        activeTask: activeTaskByRoutine.get(row.id) ?? null,
      }));
    },
    getDetail: async (id: string): Promise<RoutineDetail | null> => {
      const row = await getRoutineById(id);
      if (!row) return null;
      const [
        project,
        assignee,
        parentTask,
        descriptionDocument,
        triggers,
        recentRuns,
        activeTask,
        managedByRoutine,
      ] = await Promise.all([
        row.projectId
          ? db
              .select()
              .from(projects)
              .where(eq(projects.id, row.projectId))
              .then((rows) => rows[0] ?? null)
          : null,
        row.assigneeAgentId
          ? db
              .select()
              .from(agents)
              .where(eq(agents.id, row.assigneeAgentId))
              .then((rows) => rows[0] ?? null)
          : null,
        row.parentTaskId
          ? taskSvc.getById(row.parentTaskId).then((task) =>
              task
                ? {
                    id: task.id,
                    taskNumber: task.taskNumber,
                    identifier: task.identifier,
                    title: task.title,
                    boardPresentationStatus: task.boardPresentationStatus,
                    priority: task.priority,
                    updatedAt: task.updatedAt,
                  }
                : null,
            )
          : null,
        getRoutineDescriptionDocument(row.id),
        db
          .select()
          .from(routineTriggers)
          .where(eq(routineTriggers.routineId, row.id))
          .orderBy(asc(routineTriggers.createdAt)),
        listRoutineRunSummaries(row.id, 25),
        findLiveExecutionTask(row),
        listManagedRoutineMetadata([row.id]),
      ]);

      return {
        ...row,
        managedByPlugin: managedByRoutine.get(row.id) ?? null,
        project,
        assignee,
        parentTask,
        descriptionDocument,
        triggers: triggers as RoutineTrigger[],
        recentRuns,
        activeTask,
      };
    },
    getDescriptionDocument: async (routineId: string) => getRoutineDescriptionDocument(routineId),
    create: async (
      companyId: string,
      input: CreateRoutine,
      actor: Actor,
      internal?: {
        id: string;
        originKind: string;
        originId: string;
      },
    ): Promise<Routine> => {
      const secretMutationActor = routineSecretMutationActor(actor);
      await assertProject(companyId, input.projectId ?? null);
      await assertRoutineFolder(companyId, input.folderId ?? null);
      if (input.goalId) await assertGoal(companyId, input.goalId);
      if (input.parentTaskId) await assertParentTask(companyId, input.parentTaskId);
      const env =
        input.env === undefined || input.env === null
          ? null
          : await secretsSvc.normalizeEnvBindingsForPersistence(companyId, input.env, {
              strictMode: deps.secretsRuntime.strictMode,
              fieldPath: "env",
            });
      const variables = syncRoutineVariablesWithTemplate(
        [input.title, input.description],
        sanitizeRoutineVariableInputs(input.variables),
      );
      assertRoutineVariableDefinitions(variables);
      const status = normalizeDraftRoutineStatus(input.status, input.assigneeAgentId);
      const responsibleUserId = await resolveRoutineResponsibleUserId(
        db,
        companyId,
        actor.userId,
        input.parentTaskId ?? null,
      );
      if (!responsibleUserId) {
        throw unprocessable("Routine requires a responsible user");
      }
      const createdRoutine = await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        await assertInvokableRoutineAssigneeInTransaction(
          tx as unknown as TaskSessionDbTransaction,
          companyId,
          input.assigneeAgentId ?? null,
        );
        const [created] = await txDb
          .insert(routines)
          .values({
            ...(internal ? { id: internal.id } : {}),
            companyId,
            projectId: input.projectId ?? null,
            folderId: input.folderId ?? null,
            goalId: input.goalId ?? null,
            parentTaskId: input.parentTaskId ?? null,
            title: input.title,
            description: input.description ?? null,
            assigneeAgentId: input.assigneeAgentId ?? null,
            priority: input.priority,
            status,
            concurrencyPolicy: input.concurrencyPolicy,
            catchUpPolicy: input.catchUpPolicy,
            originKind: internal?.originKind ?? "manual",
            originId: internal?.originId ?? null,
            variables,
            env,
            responsibleUserId,
            createdByAgentId: actor.agentId ?? null,
            createdByUserId: actor.userId ?? null,
            updatedByAgentId: actor.agentId ?? null,
            updatedByUserId: actor.userId ?? null,
          })
          .returning();
        const { routine } = await appendRoutineRevision(txDb, created, actor, {
          changeSummary: "Created routine",
        });
        if (env) {
          await secretsSvc.syncEnvBindingsForTarget(
            companyId,
            { targetType: "routine", targetId: routine.id },
            env,
            {
              actor: secretMutationActor,
              db: tx,
            },
          );
        }
        return routine;
      });
      return createdRoutine;
    },
  };
}
