import { and, asc, desc, eq, isNull, ne, sql } from "drizzle-orm";
import { type Db, routineRevisions, routineRuns, routines, routineTriggers } from "@paperclipai/db";
import {
  type RoutineRevisionSnapshotV1,
  getBuiltinRoutineVariableValues,
  interpolateRoutineTemplate,
  pluginOperationTaskOriginKind,
} from "@paperclipai/shared";
import { conflict, unprocessable } from "../errors.js";
import { Actor } from "./routine-ownership-and-secrets.js";
import {
  createRoutineDispatchFingerprint,
  createRoutineEnvFingerprint,
  mergeRoutineRunPayload,
  nextCronTickInTimeZone,
  resolveRoutineVariableValues,
} from "./routine-scheduling-and-variables.js";
import { readManagedRoutineTaskTemplate } from "./routine-projections.js";
import type { RoutineContext } from "./routines.js";
import type { RoutineHelpers1 } from "./routine-repository-helpers.js";
import type { RoutineHelpers2 } from "./routine-query-helpers.js";
import type { RoutineHelpers3 } from "./routine-dispatch-helpers.js";
import { recordRoutineRunSideEffects } from "./routine-run-side-effects.js";

export function buildRoutineRunDispatch(
  scope: RoutineContext & RoutineHelpers1 & RoutineHelpers2 & RoutineHelpers3,
) {
  const {
    db,
    ordinaryTasks,
    getManagedRoutineBinding,
    updateRoutineTouchedState,
    findLiveExecutionTask,
    finalizeRun,
    touchTaskForUserInbox,
  } = scope;

  async function dispatchRoutineRun(input: {
    routine: typeof routines.$inferSelect;
    trigger: typeof routineTriggers.$inferSelect | null;
    source: "schedule" | "manual" | "api" | "webhook";
    payload?: Record<string, unknown> | null;
    variables?: Record<string, unknown> | null;
    projectId?: string | null;
    assigneeAgentId?: string | null;
    idempotencyKey?: string | null;
    nextRunAtOverride?: Date | null;
    actor?: Actor;
  }) {
    const projectId = input.projectId ?? input.routine.projectId ?? null;
    const assigneeAgentId = input.assigneeAgentId ?? input.routine.assigneeAgentId ?? null;
    if (!assigneeAgentId) {
      throw unprocessable("Default agent required");
    }
    const automaticVariables: Record<string, string | number | boolean> = {};
    const resolvedVariables = resolveRoutineVariableValues(input.routine.variables ?? [], {
      ...input,
      automaticVariables,
    });
    if (!input.routine.latestRevisionId) {
      throw conflict("Routine has no current revision");
    }
    const boundRevision = await db
      .select({ id: routineRevisions.id })
      .from(routineRevisions)
      .where(
        and(
          eq(routineRevisions.companyId, input.routine.companyId),
          eq(routineRevisions.routineId, input.routine.id),
          eq(routineRevisions.id, input.routine.latestRevisionId),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!boundRevision) {
      throw conflict("Routine current revision is unavailable");
    }
    const allVariables = {
      ...getBuiltinRoutineVariableValues(),
      ...automaticVariables,
      ...resolvedVariables,
    };
    const title = interpolateRoutineTemplate(input.routine.title, allVariables) ?? input.routine.title;
    const description = interpolateRoutineTemplate(input.routine.description, allVariables) ?? "";
    const triggerPayload = mergeRoutineRunPayload(input.payload, {
      ...automaticVariables,
      ...resolvedVariables,
    });
    const managedRoutineBinding = await getManagedRoutineBinding(input.routine);
    const managedTaskTemplate = readManagedRoutineTaskTemplate(managedRoutineBinding?.defaultsJson);
    const taskOriginKind =
      managedTaskTemplate?.surfaceVisibility === "plugin_operation" && managedRoutineBinding
        ? pluginOperationTaskOriginKind(managedRoutineBinding.pluginKey)
        : "routine_execution";
    const taskOriginId = managedTaskTemplate?.originId ?? input.routine.id;
    const dispatchFingerprint = createRoutineDispatchFingerprint({
      payload: triggerPayload,
      projectId,
      assigneeAgentId,
      routineRevisionId: input.routine.latestRevisionId,
      routineEnvFingerprint: createRoutineEnvFingerprint(input.routine.env),
      title,
      description,
    });
    const manualRunnerUserId = input.source === "manual" ? (input.actor?.userId ?? null) : null;
    let run = await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      await tx.execute(
        sql`select id from ${routines} where ${routines.id} = ${input.routine.id} and ${routines.companyId} = ${input.routine.companyId} for update`,
      );

      if (input.idempotencyKey) {
        const existing = await txDb
          .select()
          .from(routineRuns)
          .where(
            and(
              eq(routineRuns.companyId, input.routine.companyId),
              eq(routineRuns.routineId, input.routine.id),
              eq(routineRuns.source, input.source),
              eq(routineRuns.idempotencyKey, input.idempotencyKey),
              input.trigger ? eq(routineRuns.triggerId, input.trigger.id) : isNull(routineRuns.triggerId),
            ),
          )
          .orderBy(desc(routineRuns.createdAt))
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (existing) return existing;
      }

      const triggeredAt = new Date();
      const latestRevisionResponsibleUserId = input.routine.latestRevisionId
        ? await txDb
            .select({
              responsibleUserId: routineRevisions.responsibleUserId,
              snapshot: routineRevisions.snapshot,
            })
            .from(routineRevisions)
            .where(
              and(
                eq(routineRevisions.companyId, input.routine.companyId),
                eq(routineRevisions.routineId, input.routine.id),
                eq(routineRevisions.id, input.routine.latestRevisionId),
              ),
            )
            .then((rows) => {
              const row = rows[0] ?? null;
              const snapshot = row?.snapshot as RoutineRevisionSnapshotV1 | undefined;
              return row?.responsibleUserId ?? snapshot?.routine.responsibleUserId ?? null;
            })
        : null;
      const responsibleUserId =
        manualRunnerUserId ?? latestRevisionResponsibleUserId ?? input.routine.responsibleUserId ?? null;
      const [createdRun] = await txDb
        .insert(routineRuns)
        .values({
          companyId: input.routine.companyId,
          routineId: input.routine.id,
          triggerId: input.trigger?.id ?? null,
          source: input.source,
          status: "received",
          triggeredAt,
          idempotencyKey: input.idempotencyKey ?? null,
          triggerPayload,
          dispatchFingerprint,
          routineRevisionId: input.routine.latestRevisionId,
          responsibleUserId,
        })
        .returning();

      const nextRunAt =
        input.nextRunAtOverride !== undefined
          ? input.nextRunAtOverride
          : input.trigger?.kind === "schedule" && input.trigger.cronExpression && input.trigger.timezone
            ? nextCronTickInTimeZone(input.trigger.cronExpression, input.trigger.timezone, triggeredAt)
            : undefined;

      const activeTask = await findLiveExecutionTask(input.routine, txDb, dispatchFingerprint, {
        kind: taskOriginKind,
        id: taskOriginId,
      });
      if (activeTask && input.routine.concurrencyPolicy !== "always_enqueue") {
        const status = input.routine.concurrencyPolicy === "skip_if_active" ? "skipped" : "coalesced";
        if (manualRunnerUserId) {
          await touchTaskForUserInbox(txDb, {
            companyId: input.routine.companyId,
            taskId: activeTask.id,
            userId: manualRunnerUserId,
            touchedAt: triggeredAt,
          });
        }
        const updated = await finalizeRun(
          createdRun.id,
          {
            status,
            linkedTaskId: activeTask.id,
            coalescedIntoRunId: activeTask.creatorRoutineDispatchId,
            completedAt: triggeredAt,
          },
          txDb,
        );
        await updateRoutineTouchedState(
          {
            routineId: input.routine.id,
            triggerId: input.trigger?.id ?? null,
            triggeredAt,
            status,
            taskId: activeTask.id,
            nextRunAt,
          },
          txDb,
        );
        return updated ?? createdRun;
      }
      if (input.routine.concurrencyPolicy !== "always_enqueue") {
        const pendingRun = await txDb
          .select({ id: routineRuns.id })
          .from(routineRuns)
          .where(
            and(
              eq(routineRuns.companyId, input.routine.companyId),
              eq(routineRuns.routineId, input.routine.id),
              eq(routineRuns.dispatchFingerprint, dispatchFingerprint),
              eq(routineRuns.status, "received"),
              ne(routineRuns.id, createdRun.id),
            ),
          )
          .orderBy(asc(routineRuns.createdAt), asc(routineRuns.id))
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (pendingRun) {
          return txDb
            .update(routineRuns)
            .set({
              coalescedIntoRunId: pendingRun.id,
              updatedAt: triggeredAt,
            })
            .where(eq(routineRuns.id, createdRun.id))
            .returning()
            .then((rows) => rows[0] ?? createdRun);
        }
      }
      return createdRun;
    });

    if (run.status === "received") {
      const nextRunAt =
        input.nextRunAtOverride !== undefined
          ? input.nextRunAtOverride
          : input.trigger?.kind === "schedule" && input.trigger.cronExpression && input.trigger.timezone
            ? nextCronTickInTimeZone(input.trigger.cronExpression, input.trigger.timezone, run.triggeredAt)
            : undefined;
      if (run.coalescedIntoRunId) {
        let sourceRun: typeof routineRuns.$inferSelect | null = null;
        for (let attempt = 0; attempt < 500; attempt += 1) {
          sourceRun = await db
            .select()
            .from(routineRuns)
            .where(eq(routineRuns.id, run.coalescedIntoRunId))
            .then((rows) => rows[0] ?? null);
          if (!sourceRun || sourceRun.status !== "received") break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const sourceLinkedTaskId = sourceRun?.linkedTaskId ?? null;
        if (
          sourceLinkedTaskId &&
          sourceRun &&
          ["task_created", "coalesced", "skipped"].includes(sourceRun.status)
        ) {
          const sourceRunId = sourceRun.id;
          const status = input.routine.concurrencyPolicy === "skip_if_active" ? "skipped" : "coalesced";
          run = await db.transaction(async (tx) => {
            const txDb = tx as unknown as Db;
            if (manualRunnerUserId) {
              await touchTaskForUserInbox(txDb, {
                companyId: input.routine.companyId,
                taskId: sourceLinkedTaskId,
                userId: manualRunnerUserId,
                touchedAt: run.triggeredAt,
              });
            }
            const updated =
              (await finalizeRun(
                run.id,
                {
                  status,
                  linkedTaskId: sourceLinkedTaskId,
                  coalescedIntoRunId: sourceRunId,
                  completedAt: new Date(),
                },
                txDb,
              )) ?? run;
            await updateRoutineTouchedState(
              {
                routineId: input.routine.id,
                triggerId: input.trigger?.id ?? null,
                triggeredAt: run.triggeredAt,
                status,
                taskId: sourceLinkedTaskId,
                nextRunAt,
              },
              txDb,
            );
            return updated;
          });
        } else if (sourceRun?.status === "received") {
          const failureReason = "Concurrent routine dispatch did not reach durable task admission";
          run =
            (await finalizeRun(run.id, {
              status: "failed",
              failureReason,
              completedAt: new Date(),
            })) ?? run;
        } else {
          run =
            (await db
              .update(routineRuns)
              .set({ coalescedIntoRunId: null, updatedAt: new Date() })
              .where(eq(routineRuns.id, run.id))
              .returning()
              .then((rows) => rows[0] ?? null)) ?? run;
        }
      }
      if (run.status === "received") {
        try {
          const created = await ordinaryTasks.create({
            companyId: input.routine.companyId,
            request: description.trim() ? description : title,
            ownerAgentId: assigneeAgentId,
            creator: {
              kind: "routine",
              routineId: input.routine.id,
              routineDispatchId: run.id,
            },
            idempotencyKey: `routine-dispatch:${run.id}`,
            sourceKind: "routine_dispatch",
            title,
            projectId,
            goalId: input.routine.goalId,
            parentId: input.routine.parentTaskId,
            priority: input.routine.priority as "critical" | "high" | "medium" | "low",
            responsibleUserId: run.responsibleUserId,
            originKind: taskOriginKind,
            originId: taskOriginId,
            originRunId: run.id,
            originFingerprint: dispatchFingerprint,
            billingCode: managedTaskTemplate?.billingCode ?? null,
            correlate: async (tx, persisted) => {
              const txDb = tx as unknown as Db;
              if (manualRunnerUserId) {
                await touchTaskForUserInbox(txDb, {
                  companyId: input.routine.companyId,
                  taskId: persisted.task.id,
                  userId: manualRunnerUserId,
                  touchedAt: run.triggeredAt,
                });
              }
              run =
                (await finalizeRun(
                  run.id,
                  {
                    status: "task_created",
                    linkedTaskId: persisted.task.id,
                  },
                  txDb,
                )) ?? run;
              await updateRoutineTouchedState(
                {
                  routineId: input.routine.id,
                  triggerId: input.trigger?.id ?? null,
                  triggeredAt: run.triggeredAt,
                  status: "task_created",
                  taskId: persisted.task.id,
                  nextRunAt,
                },
                txDb,
              );
            },
          });
          if (run.linkedTaskId !== created.task.id) {
            throw new Error("Routine task admission did not persist its dispatch correlation");
          }
        } catch (error) {
          const failureReason = error instanceof Error ? error.message : String(error);
          const persistedRun = await db
            .select()
            .from(routineRuns)
            .where(eq(routineRuns.id, run.id))
            .then((rows) => rows[0] ?? null);
          if (persistedRun?.status === "task_created" && persistedRun.linkedTaskId) {
            // The task, immutable input, ref, and routine correlation committed
            // together. A post-commit dispatcher notification failure is
            // recovered by the persisted-ref reconciler and cannot roll the
            // accepted routine task back into a failed dispatch.
            run = persistedRun;
          } else {
            run =
              (await db.transaction(async (tx) => {
                const txDb = tx as unknown as Db;
                const failed = await finalizeRun(
                  run.id,
                  {
                    status: "failed",
                    failureReason,
                    completedAt: new Date(),
                  },
                  txDb,
                );
                await updateRoutineTouchedState(
                  {
                    routineId: input.routine.id,
                    triggerId: input.trigger?.id ?? null,
                    triggeredAt: run.triggeredAt,
                    status: "failed",
                    nextRunAt,
                  },
                  txDb,
                );
                return failed ?? run;
              })) ?? run;
          }
        }
      }
    }

    await recordRoutineRunSideEffects(db, input, run);

    return run;
  }

  return { dispatchRoutineRun };
}

export type RoutineHelpers4 = ReturnType<typeof buildRoutineRunDispatch>;
