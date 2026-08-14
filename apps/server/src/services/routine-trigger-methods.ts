import { type Db, routineRevisions, routines, routineTriggers } from "@paperclipai/db";
import type {
  CreateRoutineTrigger,
  RoutineRevision,
  RoutineTrigger,
  RoutineTriggerSecretMaterial,
  UpdateRoutineTrigger,
} from "@paperclipai/shared";
import { and, desc, eq, sql } from "drizzle-orm";
import crypto from "node:crypto";
import { notFound, unprocessable } from "../errors.js";
import { validateCron } from "./cron.js";
import {
  Actor,
  assertTimeZone,
  MAX_ROUTINE_REVISIONS,
  routineSecretMutationActor,
} from "./routine-ownership-and-secrets.js";
import { mapRoutineRevision, routineWebhookUrl } from "./routine-projections.js";
import {
  assertScheduleCompatibleVariables,
  nextCronTickInTimeZone,
} from "./routine-scheduling-and-variables.js";
import type { RoutineServiceScope } from "./routines.js";
import { secretService } from "./secrets.js";

export function buildRoutineTriggerMethods(scope: RoutineServiceScope) {
  const {
    db,
    deps,
    secretsSvc,
    runtimeEnv,
    getRoutineById,
    getTriggerById,
    appendRoutineRevision,
    createWebhookSecret,
  } = scope;
  return {
    createTrigger: async (
      routineId: string,
      input: CreateRoutineTrigger,
      actor: Actor,
    ): Promise<{
      trigger: RoutineTrigger;
      secretMaterial: RoutineTriggerSecretMaterial | null;
      revision: RoutineRevision;
    }> => {
      const secretMutationActor = routineSecretMutationActor(actor);
      const routine = await getRoutineById(routineId);
      if (!routine) throw notFound("Routine not found");

      const triggerId = crypto.randomUUID();
      let secretMaterial: RoutineTriggerSecretMaterial | null = null;
      let secretId: string | null = null;
      let publicId: string | null = null;
      let nextRunAt: Date | null = null;

      if (input.kind === "schedule") {
        assertScheduleCompatibleVariables(routine.variables ?? []);
        const timeZone = input.timezone || "UTC";
        assertTimeZone(timeZone);
        const error = validateCron(input.cronExpression);
        if (error) throw unprocessable(error);
        nextRunAt = nextCronTickInTimeZone(input.cronExpression, timeZone, new Date());
      }

      if (input.kind === "webhook") {
        publicId = crypto.randomBytes(12).toString("hex");
        const created = await createWebhookSecret(routine.companyId, routine.id, triggerId, actor);
        secretId = created.secret.id;
        secretMaterial = {
          webhookUrl: routineWebhookUrl(runtimeEnv, publicId),
          webhookSecret: created.secretValue,
        };
      }

      try {
        const { trigger, revision } = await db.transaction(async (tx) => {
          const txDb = tx as unknown as Db;
          await tx.execute(sql`select id from ${routines} where ${routines.id} = ${routine.id} for update`);
          const [createdTrigger] = await txDb
            .insert(routineTriggers)
            .values({
              id: triggerId,
              companyId: routine.companyId,
              routineId: routine.id,
              kind: input.kind,
              label: input.label ?? null,
              enabled: input.enabled ?? true,
              cronExpression: input.kind === "schedule" ? input.cronExpression : null,
              timezone: input.kind === "schedule" ? input.timezone || "UTC" : null,
              nextRunAt,
              publicId,
              secretId,
              signingMode: input.kind === "webhook" ? input.signingMode : null,
              replayWindowSec: input.kind === "webhook" ? input.replayWindowSec : null,
              lastRotatedAt: input.kind === "webhook" ? new Date() : null,
              createdByAgentId: actor.agentId ?? null,
              createdByUserId: actor.userId ?? null,
              updatedByAgentId: actor.agentId ?? null,
              updatedByUserId: actor.userId ?? null,
            })
            .returning();
          const latestRoutine = await txDb
            .select()
            .from(routines)
            .where(eq(routines.id, routine.id))
            .then((rows) => rows[0] ?? routine);
          const appended = await appendRoutineRevision(txDb, latestRoutine, actor, {
            changeSummary: `Created ${input.kind} trigger`,
          });
          return { trigger: createdTrigger, revision: appended.revision };
        });

        return {
          trigger: trigger as RoutineTrigger,
          secretMaterial,
          revision,
        };
      } catch (error) {
        if (secretId) {
          await secretsSvc.remove(secretId, secretMutationActor);
        }
        throw error;
      }
    },
    updateTrigger: async (
      id: string,
      patch: UpdateRoutineTrigger,
      actor: Actor,
    ): Promise<{
      trigger: RoutineTrigger;
      revision: RoutineRevision;
    } | null> => {
      routineSecretMutationActor(actor);
      const existing = await getTriggerById(id);
      if (!existing) return null;

      let nextRunAt = existing.nextRunAt;
      let cronExpression = existing.cronExpression;
      let timezone = existing.timezone;

      if (existing.kind === "schedule") {
        const routine = await getRoutineById(existing.routineId);
        if (!routine) throw notFound("Routine not found");
        if (patch.cronExpression !== undefined) {
          if (patch.cronExpression == null) throw unprocessable("Scheduled triggers require cronExpression");
          const error = validateCron(patch.cronExpression);
          if (error) throw unprocessable(error);
          cronExpression = patch.cronExpression;
        }
        if (patch.timezone !== undefined) {
          if (patch.timezone == null) throw unprocessable("Scheduled triggers require timezone");
          assertTimeZone(patch.timezone);
          timezone = patch.timezone;
        }
        if (cronExpression && timezone) {
          nextRunAt = nextCronTickInTimeZone(cronExpression, timezone, new Date());
        }
        if ((patch.enabled ?? existing.enabled) === true) {
          assertScheduleCompatibleVariables(routine.variables ?? []);
        }
      }

      const result = await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        await tx.execute(
          sql`select id from ${routines} where ${routines.id} = ${existing.routineId} for update`,
        );
        const [updated] = await txDb
          .update(routineTriggers)
          .set({
            label: patch.label === undefined ? existing.label : patch.label,
            enabled: patch.enabled ?? existing.enabled,
            cronExpression,
            timezone,
            nextRunAt,
            signingMode: patch.signingMode === undefined ? existing.signingMode : patch.signingMode,
            replayWindowSec:
              patch.replayWindowSec === undefined ? existing.replayWindowSec : patch.replayWindowSec,
            updatedByAgentId: actor.agentId ?? null,
            updatedByUserId: actor.userId ?? null,
            updatedAt: new Date(),
          })
          .where(eq(routineTriggers.id, id))
          .returning();
        if (!updated) return null;
        const routine = await txDb
          .select()
          .from(routines)
          .where(eq(routines.id, existing.routineId))
          .then((rows) => rows[0] ?? null);
        if (!routine) throw notFound("Routine not found");
        const appended = await appendRoutineRevision(txDb, routine, actor, {
          changeSummary: `Updated ${existing.kind} trigger`,
        });
        return {
          trigger: updated as RoutineTrigger,
          revision: appended.revision,
        };
      });
      return result;
    },
    deleteTrigger: async (
      id: string,
      actor: Actor,
    ): Promise<{ deleted: boolean; revision: RoutineRevision | null }> => {
      const secretMutationActor = routineSecretMutationActor(actor);
      const existing = await getTriggerById(id);
      if (!existing) return { deleted: false, revision: null };
      const result = await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        await tx.execute(
          sql`select id from ${routines} where ${routines.id} = ${existing.routineId} for update`,
        );
        await txDb.delete(routineTriggers).where(eq(routineTriggers.id, id));
        const routine = await txDb
          .select()
          .from(routines)
          .where(eq(routines.id, existing.routineId))
          .then((rows) => rows[0] ?? null);
        if (!routine) throw notFound("Routine not found");
        const appended = await appendRoutineRevision(txDb, routine, actor, {
          changeSummary: `Deleted ${existing.kind} trigger`,
        });
        if (existing.secretId) {
          await secretService(txDb, deps.secretsRuntime).remove(existing.secretId, secretMutationActor);
        }
        return { deleted: true, revision: appended.revision };
      });
      return result;
    },
    rotateTriggerSecret: async (
      id: string,
      actor: Actor,
    ): Promise<{
      trigger: RoutineTrigger;
      secretMaterial: RoutineTriggerSecretMaterial;
      revision: RoutineRevision;
    }> => {
      const secretMutationActor = routineSecretMutationActor(actor);
      const existing = await getTriggerById(id);
      if (!existing) throw notFound("Routine trigger not found");
      if (existing.kind !== "webhook" || !existing.publicId || !existing.secretId) {
        throw unprocessable("Only webhook triggers can rotate secrets");
      }

      const secretValue = crypto.randomBytes(24).toString("hex");
      await secretsSvc.rotate(existing.secretId, { value: secretValue }, secretMutationActor);
      const { trigger, revision } = await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        await tx.execute(
          sql`select id from ${routines} where ${routines.id} = ${existing.routineId} for update`,
        );
        const [updated] = await txDb
          .update(routineTriggers)
          .set({
            lastRotatedAt: new Date(),
            updatedByAgentId: actor.agentId ?? null,
            updatedByUserId: actor.userId ?? null,
            updatedAt: new Date(),
          })
          .where(eq(routineTriggers.id, id))
          .returning();
        const routine = await txDb
          .select()
          .from(routines)
          .where(eq(routines.id, existing.routineId))
          .then((rows) => rows[0] ?? null);
        if (!routine) throw notFound("Routine not found");
        const appended = await appendRoutineRevision(txDb, routine, actor, {
          changeSummary: "Rotated webhook trigger secret",
        });
        return { trigger: updated, revision: appended.revision };
      });

      return {
        trigger: trigger as RoutineTrigger,
        secretMaterial: {
          webhookUrl: routineWebhookUrl(runtimeEnv, existing.publicId),
          webhookSecret: secretValue,
        },
        revision,
      };
    },
    listRevisions: async (routineId: string): Promise<RoutineRevision[]> => {
      const routine = await getRoutineById(routineId);
      if (!routine) throw notFound("Routine not found");
      const rows = await db
        .select()
        .from(routineRevisions)
        .where(
          and(eq(routineRevisions.companyId, routine.companyId), eq(routineRevisions.routineId, routine.id)),
        )
        .orderBy(desc(routineRevisions.revisionNumber), desc(routineRevisions.createdAt))
        .limit(MAX_ROUTINE_REVISIONS);
      return rows.map(mapRoutineRevision);
    },
  };
}
