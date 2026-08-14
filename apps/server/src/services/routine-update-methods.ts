import { type Db, routineRevisions, routines, routineTriggers } from "@paperclipai/db";
import {
  type Routine,
  type RoutineRevisionSnapshotV1,
  type UpdateRoutine,
  syncRoutineVariablesWithTemplate,
} from "@paperclipai/shared";
import { and, eq, sql } from "drizzle-orm";
import { conflict, unprocessable } from "../errors.js";
import {
  Actor,
  resolveRoutineResponsibleUserId,
  RoutineRow,
  routineSecretMutationActor,
} from "./routine-ownership-and-secrets.js";
import {
  buildRoutineRevisionSnapshot,
  routineCurrentFieldsMatch,
  snapshotsMatch,
} from "./routine-projections.js";
import {
  assertRoutineCanEnable,
  assertRoutineVariableDefinitions,
  assertScheduleCompatibleVariables,
  normalizeDraftRoutineStatus,
  sanitizeRoutineVariableInputs,
} from "./routine-scheduling-and-variables.js";
import type { RoutineServiceScope } from "./routines.js";
import { terminalizeRoutineCreatorEdgesInTransaction } from "./system-escalation-postgres.js";
import type { TaskSessionDbTransaction } from "./task-session/event-store.js";

export function buildRoutineUpdateMethods(scope: RoutineServiceScope) {
  const {
    db,
    deps,
    ordinaryTasks,
    secretsSvc,
    canonicalSessions,
    getRoutineById,
    appendRoutineRevision,
    assertInvokableRoutineAssigneeInTransaction,
    assertProject,
    assertGoal,
    assertParentTask,
    assertRoutineFolder,
  } = scope;
  return {
    update: async (id: string, patch: UpdateRoutine, actor: Actor): Promise<Routine | null> => {
      const secretMutationActor = routineSecretMutationActor(actor);
      const existing = await getRoutineById(id);
      if (!existing) return null;
      const nextProjectId = patch.projectId === undefined ? existing.projectId : patch.projectId;
      const nextFolderId = patch.folderId === undefined ? existing.folderId : patch.folderId;
      const nextAssigneeAgentId =
        patch.assigneeAgentId === undefined ? existing.assigneeAgentId : patch.assigneeAgentId;
      const nextTitle = patch.title ?? existing.title;
      const nextDescription = patch.description === undefined ? existing.description : patch.description;
      const nextEnv =
        patch.env === undefined
          ? existing.env
          : patch.env === null
            ? null
            : await secretsSvc.normalizeEnvBindingsForPersistence(existing.companyId, patch.env, {
                strictMode: deps.secretsRuntime.strictMode,
                fieldPath: "env",
              });
      const requestedStatus = patch.status ?? existing.status;
      if (patch.status === "active") {
        assertRoutineCanEnable(patch.status, nextAssigneeAgentId);
      }
      const nextStatus =
        patch.assigneeAgentId === undefined
          ? requestedStatus
          : normalizeDraftRoutineStatus(requestedStatus, nextAssigneeAgentId);
      const nextVariables = syncRoutineVariablesWithTemplate(
        [nextTitle, nextDescription],
        patch.variables === undefined ? existing.variables : sanitizeRoutineVariableInputs(patch.variables),
      );
      if (patch.projectId !== undefined) await assertProject(existing.companyId, nextProjectId);
      if (patch.folderId !== undefined) await assertRoutineFolder(existing.companyId, nextFolderId);
      if (patch.goalId) await assertGoal(existing.companyId, patch.goalId);
      if (patch.parentTaskId) await assertParentTask(existing.companyId, patch.parentTaskId);
      assertRoutineVariableDefinitions(nextVariables);
      const enabledScheduleTriggers = await db
        .select({ id: routineTriggers.id })
        .from(routineTriggers)
        .where(
          and(
            eq(routineTriggers.routineId, existing.id),
            eq(routineTriggers.kind, "schedule"),
            eq(routineTriggers.enabled, true),
          ),
        )
        .limit(1)
        .then((rows) => rows.length > 0);
      if (enabledScheduleTriggers) {
        assertScheduleCompatibleVariables(nextVariables);
      }
      const responsibleUserId = await resolveRoutineResponsibleUserId(
        db,
        existing.companyId,
        actor.userId,
        patch.parentTaskId === undefined ? existing.parentTaskId : patch.parentTaskId,
      );
      if (!responsibleUserId) {
        throw unprocessable("Routine requires a responsible user");
      }
      const committed = await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        await tx.execute(sql`select id from ${routines} where ${routines.id} = ${id} for update`);
        const locked = await txDb
          .select()
          .from(routines)
          .where(eq(routines.id, id))
          .then((rows) => rows[0] ?? null);
        if (!locked) {
          return {
            routine: null,
            dispatchRefIds: [] as string[],
          };
        }

        if (patch.baseRevisionId !== locked.latestRevisionId) {
          throw conflict("Routine was updated by someone else", {
            currentRevisionId: locked.latestRevisionId,
          });
        }

        const candidate: RoutineRow = {
          ...locked,
          projectId: nextProjectId,
          folderId: nextFolderId,
          goalId: patch.goalId === undefined ? locked.goalId : patch.goalId,
          parentTaskId: patch.parentTaskId === undefined ? locked.parentTaskId : patch.parentTaskId,
          title: nextTitle,
          description: nextDescription,
          assigneeAgentId: nextAssigneeAgentId,
          priority: patch.priority ?? locked.priority,
          status: nextStatus,
          concurrencyPolicy: patch.concurrencyPolicy ?? locked.concurrencyPolicy,
          catchUpPolicy: patch.catchUpPolicy ?? locked.catchUpPolicy,
          variables: nextVariables,
          env: nextEnv,
          responsibleUserId: locked.responsibleUserId ?? responsibleUserId,
          updatedByAgentId: actor.agentId ?? null,
          updatedByUserId: actor.userId ?? null,
        };

        if (patch.assigneeAgentId !== undefined || patch.status === "active") {
          await assertInvokableRoutineAssigneeInTransaction(
            tx as unknown as TaskSessionDbTransaction,
            candidate.companyId,
            candidate.assigneeAgentId,
          );
        }

        const folderChanged = patch.folderId !== undefined && locked.folderId !== candidate.folderId;
        if (locked.latestRevisionId && routineCurrentFieldsMatch(locked, candidate)) {
          if (!folderChanged) {
            return {
              routine: locked,
              dispatchRefIds: [] as string[],
            };
          }
          const [updated] = await txDb
            .update(routines)
            .set({
              folderId: candidate.folderId,
              updatedByAgentId: actor.agentId ?? null,
              updatedByUserId: actor.userId ?? null,
              updatedAt: new Date(),
            })
            .where(eq(routines.id, id))
            .returning();
          return {
            routine: updated ?? locked,
            dispatchRefIds: [] as string[],
          };
        }

        const nextSnapshot = await buildRoutineRevisionSnapshot(txDb, candidate);
        if (locked.latestRevisionId) {
          const latestRevision = await txDb
            .select({ snapshot: routineRevisions.snapshot })
            .from(routineRevisions)
            .where(
              and(
                eq(routineRevisions.companyId, locked.companyId),
                eq(routineRevisions.routineId, locked.id),
                eq(routineRevisions.id, locked.latestRevisionId),
              ),
            )
            .then((rows) => rows[0] ?? null);
          if (
            latestRevision &&
            snapshotsMatch(nextSnapshot, latestRevision.snapshot as RoutineRevisionSnapshotV1)
          ) {
            if (patch.env !== undefined) {
              await secretsSvc.syncEnvBindingsForTarget(
                locked.companyId,
                { targetType: "routine", targetId: locked.id },
                candidate.env,
                {
                  actor: secretMutationActor,
                  db: tx,
                },
              );
            }
            return {
              routine: locked,
              dispatchRefIds: [] as string[],
            };
          }
        }

        const [updated] = await txDb
          .update(routines)
          .set({
            projectId: candidate.projectId,
            folderId: candidate.folderId,
            goalId: candidate.goalId,
            parentTaskId: candidate.parentTaskId,
            title: candidate.title,
            description: candidate.description,
            assigneeAgentId: candidate.assigneeAgentId,
            priority: candidate.priority,
            status: candidate.status,
            concurrencyPolicy: candidate.concurrencyPolicy,
            catchUpPolicy: candidate.catchUpPolicy,
            variables: candidate.variables,
            env: candidate.env,
            responsibleUserId: candidate.responsibleUserId,
            updatedByAgentId: actor.agentId ?? null,
            updatedByUserId: actor.userId ?? null,
            updatedAt: new Date(),
          })
          .where(eq(routines.id, id))
          .returning();
        if (!updated) {
          return {
            routine: null,
            dispatchRefIds: [] as string[],
          };
        }
        const { routine } = await appendRoutineRevision(txDb, updated, actor, {
          changeSummary: "Updated routine",
        });
        if (patch.env !== undefined) {
          await secretsSvc.syncEnvBindingsForTarget(
            routine.companyId,
            { targetType: "routine", targetId: routine.id },
            routine.env,
            {
              actor: secretMutationActor,
              db: tx,
            },
          );
        }
        let dispatchRefIds: string[] = [];
        if (locked.status !== "archived" && routine.status === "archived") {
          const escalations = await terminalizeRoutineCreatorEdgesInTransaction(tx, canonicalSessions, {
            companyId: routine.companyId,
            routineId: routine.id,
            sourceId: `routine-archived:${routine.id}`,
            now: new Date(),
          });
          dispatchRefIds = escalations.flatMap((escalation) =>
            escalation.dispatchRefId ? [escalation.dispatchRefId] : [],
          );
        }
        return { routine, dispatchRefIds };
      });
      for (const refId of committed.dispatchRefIds) {
        await ordinaryTasks.dispatchRef(refId);
      }
      return committed.routine;
    },
  };
}
