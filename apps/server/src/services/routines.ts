import type { Db } from "@paperclipai/db";
import { projects, routines, routineTriggers, tasks } from "@paperclipai/db";
import type { RoutineRunSummary, RunRoutine } from "@paperclipai/shared";
import { and, asc, eq, isNotNull, lte } from "drizzle-orm";
import crypto from "node:crypto";
import { conflict, forbidden, notFound, unauthorized } from "../errors.js";
import type { SecretsRuntimeConfig } from "../secrets/types.js";
import {
  instanceSettingsService,
  isWorktreeRuntimeEnvironment,
  resolveWorktreeRunExecutionActivationState,
} from "./instance-settings.js";
import type { OrdinaryTaskRuntime } from "./ordinary-task-runtime.js";
import { buildRoutineCoreMethods } from "./routine-core-methods.js";
import type { RoutineHelpers3 } from "./routine-dispatch-helpers.js";
import { buildRoutineDispatchHelpers } from "./routine-dispatch-helpers.js";
import { Actor, MAX_CATCH_UP_RUNS } from "./routine-ownership-and-secrets.js";
import type { RoutineHelpers2 } from "./routine-query-helpers.js";
import { buildRoutineQueryHelpers } from "./routine-query-helpers.js";
import type { RoutineHelpers1 } from "./routine-repository-helpers.js";
import { buildRoutineRepositoryHelpers } from "./routine-repository-helpers.js";
import { buildRoutineRevisionMethods } from "./routine-revision-methods.js";
import type { RoutineHelpers4 } from "./routine-run-dispatch.js";
import { buildRoutineRunDispatch } from "./routine-run-dispatch.js";
import {
  isPlainRecord,
  isSubHourlyCronExpression,
  nextCronTickInTimeZone,
  normalizeWebhookTimestampMs,
} from "./routine-scheduling-and-variables.js";
import { buildRoutineTriggerMethods } from "./routine-trigger-methods.js";
import { buildRoutineUpdateMethods } from "./routine-update-methods.js";
import { secretService } from "./secrets.js";
import { createTaskSessionAdmissionService } from "./task-session/admission.js";
import { taskService } from "./tasks.js";

export type RoutineServiceScope = RoutineContext &
  RoutineHelpers1 &
  RoutineHelpers2 &
  RoutineHelpers3 &
  RoutineHelpers4;

export function createRoutineContext(
  db: Db,
  deps: {
    runtimeEnv?: Record<string, string | undefined>;
    ordinaryTasks: OrdinaryTaskRuntime;
    secretsRuntime: SecretsRuntimeConfig;
  },
) {
  const ordinaryTasks = deps.ordinaryTasks;
  const taskSvc = taskService(db);
  const secretsSvc = secretService(db, deps.secretsRuntime);
  const instanceSettings = instanceSettingsService(db);
  const runtimeEnv = deps.runtimeEnv ?? process.env;
  const canonicalSessions = createTaskSessionAdmissionService(db);
  return {
    db,
    deps,
    ordinaryTasks,
    taskSvc,
    secretsSvc,
    instanceSettings,
    runtimeEnv,
    canonicalSessions,
  };
}

export type RoutineContext = ReturnType<typeof createRoutineContext>;

export function buildRoutineSchedulerMethods(scope: RoutineServiceScope) {
  const {
    db,
    instanceSettings,
    runtimeEnv,
    getAutomaticRoutineDispatchEligibility,
    evaluateActivityGate,
    recordSuppressedAutomaticRun,
    finalizeRun,
    dispatchRoutineRun,
  } = scope;
  return {
    tickScheduledTriggers: async (now: Date = new Date()) => {
      const worktreeActivation = isWorktreeRuntimeEnvironment(runtimeEnv.PAPERCLIP_IN_WORKTREE)
        ? await resolveWorktreeRunExecutionActivationState({
            getGeneral: instanceSettings.getGeneral,
            runtimeEnv,
          })
        : undefined;
      const due = await db
        .select({
          trigger: routineTriggers,
          routine: routines,
          projectPausedAt: projects.pausedAt,
        })
        .from(routineTriggers)
        .innerJoin(routines, eq(routineTriggers.routineId, routines.id))
        .leftJoin(projects, eq(routines.projectId, projects.id))
        .where(
          and(
            eq(routineTriggers.kind, "schedule"),
            eq(routineTriggers.enabled, true),
            eq(routines.status, "active"),
            isNotNull(routineTriggers.nextRunAt),
            lte(routineTriggers.nextRunAt, now),
          ),
        )
        .orderBy(asc(routineTriggers.nextRunAt), asc(routineTriggers.createdAt));

      let triggered = 0;
      for (const row of due) {
        if (!row.trigger.nextRunAt || !row.trigger.cronExpression || !row.trigger.timezone) continue;

        // Suppress scheduled firings while the routine's project is paused. The tick is still
        // claimed and advanced to the next single cron tick (no backfill), so resume continues
        // at the next cron boundary instead of replaying missed firings. Routines with no
        // project are never suppressed here.
        const projectPaused = !!(row.routine.projectId && row.projectPausedAt);
        const automaticEligibility = await getAutomaticRoutineDispatchEligibility(
          row.routine,
          worktreeActivation,
        );
        const worktreeSuppressed = !automaticEligibility.eligible;

        let runCount = 1;
        let claimedNextRunAt = nextCronTickInTimeZone(row.trigger.cronExpression, row.trigger.timezone, now);

        if (
          !projectPaused &&
          !worktreeSuppressed &&
          row.routine.catchUpPolicy === "enqueue_missed_with_cap"
        ) {
          if (isSubHourlyCronExpression(row.trigger.cronExpression, row.trigger.timezone, now)) {
            claimedNextRunAt = nextCronTickInTimeZone(row.trigger.cronExpression, row.trigger.timezone, now);
          } else {
            let cursor: Date | null = row.trigger.nextRunAt;
            runCount = 0;
            while (cursor && cursor <= now && runCount < MAX_CATCH_UP_RUNS) {
              runCount += 1;
              claimedNextRunAt = nextCronTickInTimeZone(
                row.trigger.cronExpression,
                row.trigger.timezone,
                cursor,
              );
              cursor = claimedNextRunAt;
            }
          }
        }

        const claimed = await db
          .update(routineTriggers)
          .set({
            nextRunAt: claimedNextRunAt,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(routineTriggers.id, row.trigger.id),
              eq(routineTriggers.enabled, true),
              eq(routineTriggers.nextRunAt, row.trigger.nextRunAt),
            ),
          )
          .returning({ id: routineTriggers.id })
          .then((rows) => rows[0] ?? null);
        if (!claimed) continue;

        if (projectPaused || worktreeSuppressed) {
          await recordSuppressedAutomaticRun({
            routine: row.routine,
            trigger: row.trigger,
            source: "schedule",
            reason: worktreeSuppressed ? "worktree_execution_cutoff" : "paused",
            nextRunAt: claimedNextRunAt,
          });
          continue;
        }

        const activityGate =
          row.routine.activityGatePolicy === "require_external_activity"
            ? await evaluateActivityGate(row.routine, now)
            : null;
        if (activityGate && !activityGate.fire) {
          await recordSuppressedAutomaticRun({
            routine: row.routine,
            trigger: row.trigger,
            source: "schedule",
            reason: "no_external_activity",
            nextRunAt: claimedNextRunAt,
            details: {
              activityGate: {
                verdict: "quiet",
                windowStart: activityGate.windowStart?.toISOString() ?? null,
                matchedActivityId: null,
              },
            },
          });
          continue;
        }

        for (let i = 0; i < runCount; i += 1) {
          await dispatchRoutineRun({
            routine: row.routine,
            trigger: row.trigger,
            source: "schedule",
            nextRunAtOverride: claimedNextRunAt,
          });
          triggered += 1;
        }
      }

      return { triggered };
    },
    syncRunStatusForTask: async (taskId: string) => {
      const task = await db
        .select({
          id: tasks.id,
          boardPresentationStatus: tasks.boardPresentationStatus,
          originKind: tasks.originKind,
          originRunId: tasks.originRunId,
        })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .then((rows) => rows[0] ?? null);
      if (!task || task.originKind !== "routine_execution" || !task.originRunId) return null;
      if (task.boardPresentationStatus === "done") {
        return finalizeRun(task.originRunId, {
          status: "completed",
          completedAt: new Date(),
        });
      }
      if (task.boardPresentationStatus === "blocked" || task.boardPresentationStatus === "cancelled") {
        return finalizeRun(task.originRunId, {
          status: "failed",
          failureReason: `Execution task moved to ${task.boardPresentationStatus}`,
          completedAt: new Date(),
        });
      }
      return null;
    },
  };
}

export function buildRoutineRunMethods(scope: RoutineServiceScope) {
  const {
    db,
    getRoutineById,
    getTriggerById,
    assertProject,
    listRoutineRunSummaries,
    getAutomaticRoutineDispatchEligibility,
    recordSuppressedAutomaticRun,
    resolveTriggerSecret,
    dispatchRoutineRun,
  } = scope;
  return {
    runRoutine: async (id: string, input: RunRoutine, actor?: Actor) => {
      const routine = await getRoutineById(id);
      if (!routine) throw notFound("Routine not found");
      if (routine.status === "archived") throw conflict("Routine is archived");
      await assertProject(routine.companyId, input.projectId ?? null);
      const trigger = input.triggerId ? await getTriggerById(input.triggerId) : null;
      if (trigger && trigger.routineId !== routine.id) throw forbidden("Trigger does not belong to routine");
      if (trigger && !trigger.enabled) throw conflict("Routine trigger is not active");
      return dispatchRoutineRun({
        routine,
        trigger,
        source: input.source,
        payload: input.payload as Record<string, unknown> | null | undefined,
        variables: input.variables as Record<string, unknown> | null | undefined,
        projectId: input.projectId ?? null,
        assigneeAgentId: input.assigneeAgentId ?? null,
        idempotencyKey: input.idempotencyKey,
        actor,
      });
    },
    firePublicTrigger: async (
      publicId: string,
      input: {
        authorizationHeader?: string | null;
        signatureHeader?: string | null;
        timestampHeader?: string | null;
        idempotencyKey?: string | null;
        rawBody?: Buffer | null;
        payload?: Record<string, unknown> | null;
      },
    ) => {
      const trigger = await db
        .select()
        .from(routineTriggers)
        .where(and(eq(routineTriggers.publicId, publicId), eq(routineTriggers.kind, "webhook")))
        .then((rows) => rows[0] ?? null);
      if (!trigger) throw notFound("Routine trigger not found");
      const routine = await getRoutineById(trigger.routineId);
      if (!routine) throw notFound("Routine not found");
      if (!trigger.enabled || routine.status !== "active") throw conflict("Routine trigger is not active");

      if (trigger.signingMode === "none") {
        // No authentication — the publicId in the URL acts as a shared secret.
      } else if (trigger.signingMode === "github_hmac") {
        const secretValue = await resolveTriggerSecret(trigger, routine.companyId);
        const rawBody = input.rawBody ?? Buffer.from(JSON.stringify(input.payload ?? {}));
        const providedSignature = input.signatureHeader ?? "";
        if (!/^sha256=[a-f0-9]{64}$/.test(providedSignature)) throw unauthorized();
        const expectedHmac = crypto.createHmac("sha256", secretValue).update(rawBody).digest("hex");
        const signature = providedSignature.slice("sha256=".length);
        const normalizedBuf = Buffer.from(signature);
        const expectedBuf = Buffer.from(expectedHmac);
        const valid =
          normalizedBuf.length === expectedBuf.length && crypto.timingSafeEqual(normalizedBuf, expectedBuf);
        if (!valid) throw unauthorized();
      } else if (trigger.signingMode === "bearer") {
        const secretValue = await resolveTriggerSecret(trigger, routine.companyId);
        const expected = `Bearer ${secretValue}`;
        const provided = input.authorizationHeader ?? "";
        const expectedBuf = Buffer.from(expected);
        const providedBuf = Buffer.alloc(expectedBuf.length);
        providedBuf.write(provided.slice(0, expectedBuf.length));
        const valid = provided.length === expected.length && crypto.timingSafeEqual(providedBuf, expectedBuf);
        if (!valid) {
          throw unauthorized();
        }
      } else {
        const secretValue = await resolveTriggerSecret(trigger, routine.companyId);
        const rawBody = input.rawBody ?? Buffer.from(JSON.stringify(input.payload ?? {}));
        const providedSignature = input.signatureHeader ?? "";
        const providedTimestamp = input.timestampHeader ?? "";
        if (!/^[a-f0-9]{64}$/.test(providedSignature)) throw unauthorized();
        const tsMillis = normalizeWebhookTimestampMs(providedTimestamp);
        if (tsMillis == null) throw unauthorized();
        const replayWindowSec = trigger.replayWindowSec ?? 300;
        if (Math.abs(Date.now() - tsMillis) > replayWindowSec * 1000) {
          throw unauthorized();
        }
        const expectedHmac = crypto
          .createHmac("sha256", secretValue)
          .update(`${providedTimestamp}.`)
          .update(rawBody)
          .digest("hex");
        const valid =
          providedSignature.length === expectedHmac.length &&
          crypto.timingSafeEqual(Buffer.from(providedSignature), Buffer.from(expectedHmac));
        if (!valid) throw unauthorized();
      }

      const eligibility = await getAutomaticRoutineDispatchEligibility(routine);
      if (!eligibility.eligible) {
        return recordSuppressedAutomaticRun({
          routine,
          trigger,
          source: "webhook",
          reason: "worktree_execution_cutoff",
        });
      }

      return dispatchRoutineRun({
        routine,
        trigger,
        source: "webhook",
        payload: input.payload,
        variables:
          isPlainRecord(input.payload) && isPlainRecord(input.payload.variables)
            ? input.payload.variables
            : null,
        idempotencyKey: input.idempotencyKey,
      });
    },
    listRuns: async (routineId: string, limit = 50): Promise<RoutineRunSummary[]> =>
      listRoutineRunSummaries(routineId, limit),
  };
}

export type { RoutineMutationActor } from "./routine-ownership-and-secrets.js";

export { nextCronTickInTimeZone } from "./routine-scheduling-and-variables.js";

export function routineService(
  db: Db,
  deps: {
    runtimeEnv?: Record<string, string | undefined>;
    ordinaryTasks: OrdinaryTaskRuntime;
    secretsRuntime: SecretsRuntimeConfig;
  },
) {
  const context = createRoutineContext(db, deps);
  const helpers1 = buildRoutineRepositoryHelpers(context);
  const helpers2 = buildRoutineQueryHelpers({ ...context, ...helpers1 });
  const helpers3 = buildRoutineDispatchHelpers({
    ...context,
    ...helpers1,
    ...helpers2,
  });
  const helpers4 = buildRoutineRunDispatch({
    ...context,
    ...helpers1,
    ...helpers2,
    ...helpers3,
  });
  const scope = {
    ...context,
    ...helpers1,
    ...helpers2,
    ...helpers3,
    ...helpers4,
  };
  return {
    ...buildRoutineCoreMethods(scope),
    ...buildRoutineUpdateMethods(scope),
    ...buildRoutineTriggerMethods(scope),
    ...buildRoutineRevisionMethods(scope),
    ...buildRoutineRunMethods(scope),
    ...buildRoutineSchedulerMethods(scope),
  };
}
