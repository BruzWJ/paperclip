import {
  companySecrets,
  routineRuns,
  taskInboxArchives,
  taskReadStates,
  tasks,
  type Db,
  type routineTriggers,
  type routines,
} from "@paperclipai/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import crypto from "node:crypto";
import { notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import type { RoutineContext } from "./routines.js";
import {
  Actor,
  routineSecretMutationActor,
  routineWebhookSecretConfigPath,
} from "./routine-ownership-and-secrets.js";
import type { RoutineHelpers2 } from "./routine-query-helpers.js";
import type { RoutineHelpers1 } from "./routine-repository-helpers.js";
import { visibleTaskCondition } from "./task-visibility.js";

export function buildRoutineDispatchHelpers(scope: RoutineContext & RoutineHelpers1 & RoutineHelpers2) {
  const { db, deps, secretsSvc, updateRoutineTouchedState } = scope;

  // Records an automatic firing that was claimed but intentionally not dispatched. The
  // scheduler advances its tick before calling this helper, so suppressed work is never
  // replayed after a setting or project state changes.
  async function recordSuppressedAutomaticRun(input: {
    routine: typeof routines.$inferSelect;
    trigger: typeof routineTriggers.$inferSelect;
    source: "schedule" | "webhook";
    reason: string;
    nextRunAt?: Date | null;
    details?: Record<string, unknown> | null;
  }) {
    const triggeredAt = new Date();
    let run = await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      const [createdRun] = await txDb
        .insert(routineRuns)
        .values({
          companyId: input.routine.companyId,
          routineId: input.routine.id,
          triggerId: input.trigger.id,
          source: input.source,
          status: "skipped",
          triggeredAt,
          failureReason: input.reason,
          completedAt: triggeredAt,
          linkedTaskId: null,
          routineRevisionId: input.routine.latestRevisionId,
          responsibleUserId: input.routine.responsibleUserId ?? null,
          triggerPayload: input.details ?? null,
        })
        .returning();
      await updateRoutineTouchedState(
        {
          routineId: input.routine.id,
          triggerId: input.trigger.id,
          triggeredAt,
          status:
            input.reason === "paused"
              ? "skipped_paused"
              : input.reason === "no_external_activity"
                ? "skipped_no_activity"
                : "skipped_worktree_execution_cutoff",
          nextRunAt: input.nextRunAt,
        },
        txDb,
      );
      return createdRun;
    });

    try {
      await logActivity(db, {
        companyId: input.routine.companyId,
        actorType: "system",
        actorId: input.source === "schedule" ? "routine-scheduler" : "routine-webhook",
        action: "routine.run_skipped",
        entityType: "routine_run",
        entityId: run.id,
        details: {
          routineId: input.routine.id,
          triggerId: input.trigger.id,
          source: input.source,
          status: "skipped",
          reason: input.reason,
          ...(input.details ?? {}),
        },
      });
    } catch (err) {
      logger.warn({ err, routineId: input.routine.id, runId: run.id }, "failed to log skipped routine run");
    }

    return run;
  }

  async function findLiveExecutionTask(
    routine: typeof routines.$inferSelect,
    executor: Db = db,
    dispatchFingerprint?: string | null,
    _origin?: { kind: string; id: string | null },
  ) {
    const canonicalTask = await executor
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.companyId, routine.companyId),
          eq(tasks.creatorKind, "routine"),
          eq(tasks.creatorRoutineId, routine.id),
          dispatchFingerprint ? eq(tasks.originFingerprint, dispatchFingerprint) : undefined,
          inArray(tasks.lifecycleStatus, ["open", "blocked"]),
          visibleTaskCondition(),
        ),
      )
      .orderBy(desc(tasks.updatedAt), desc(tasks.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return canonicalTask
      ? {
          ...canonicalTask,
          status: canonicalTask.boardPresentationStatus,
        }
      : null;
  }

  async function finalizeRun(
    runId: string,
    patch: Partial<typeof routineRuns.$inferInsert>,
    executor: Db = db,
  ) {
    return executor
      .update(routineRuns)
      .set({
        ...patch,
        updatedAt: new Date(),
      })
      .where(eq(routineRuns.id, runId))
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  async function createWebhookSecret(companyId: string, routineId: string, triggerId: string, actor: Actor) {
    const secretMutationActor = routineSecretMutationActor(actor);
    const secretValue = crypto.randomBytes(24).toString("hex");
    const providerId = deps.secretsRuntime.defaultProvider;
    const name = `routine-${routineId}-${crypto.randomBytes(6).toString("hex")}`;
    const secret = await secretsSvc.createBound(
      companyId,
      {
        name,
        key: name,
        provider: providerId,
        value: secretValue,
        description: `Webhook auth for routine ${routineId}`,
      },
      {
        targetType: "routine",
        targetId: routineId,
        configPath: routineWebhookSecretConfigPath(triggerId),
      },
      secretMutationActor,
    );
    return { secret, secretValue };
  }

  async function resolveTriggerSecret(trigger: typeof routineTriggers.$inferSelect, companyId: string) {
    if (!trigger.secretId) throw notFound("Routine trigger secret not found");
    const secret = await db
      .select()
      .from(companySecrets)
      .where(eq(companySecrets.id, trigger.secretId))
      .then((rows) => rows[0] ?? null);
    if (!secret || secret.companyId !== companyId) throw notFound("Routine trigger secret not found");
    const value = await secretsSvc.resolveSecretValue(companyId, trigger.secretId, "latest", {
      consumerType: "routine",
      consumerId: trigger.routineId,
      actorType: "system",
      actorId: null,
      configPath: routineWebhookSecretConfigPath(trigger.id),
    });
    return value;
  }

  async function touchTaskForUserInbox(
    executor: Db,
    input: {
      companyId: string;
      taskId: string;
      userId: string;
      touchedAt: Date;
    },
  ) {
    await executor
      .insert(taskReadStates)
      .values({
        companyId: input.companyId,
        taskId: input.taskId,
        userId: input.userId,
        lastReadAt: input.touchedAt,
        updatedAt: input.touchedAt,
      })
      .onConflictDoUpdate({
        target: [taskReadStates.companyId, taskReadStates.taskId, taskReadStates.userId],
        set: {
          lastReadAt: input.touchedAt,
          updatedAt: input.touchedAt,
        },
      });

    await executor
      .delete(taskInboxArchives)
      .where(
        and(
          eq(taskInboxArchives.companyId, input.companyId),
          eq(taskInboxArchives.taskId, input.taskId),
          eq(taskInboxArchives.userId, input.userId),
        ),
      );
  }

  return {
    recordSuppressedAutomaticRun,
    findLiveExecutionTask,
    finalizeRun,
    createWebhookSecret,
    resolveTriggerSecret,
    touchTaskForUserInbox,
  };
}

export type RoutineHelpers3 = ReturnType<typeof buildRoutineDispatchHelpers>;
