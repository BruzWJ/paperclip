import crypto from "node:crypto";
import { and, eq, inArray, not, sql } from "drizzle-orm";
import { type Db, routineRevisions, routines, routineTriggers } from "@paperclipai/db";
import {
  type Routine,
  type RoutineRevision,
  type RoutineRevisionSnapshotV1,
  isCanonicalUuid,
} from "@paperclipai/shared";
import { conflict, notFound } from "../errors.js";
import { terminalizeRoutineCreatorEdgesInTransaction } from "./system-escalation-postgres.js";
import type { TaskSessionDbTransaction } from "./task-session/event-store.js";
import {
  Actor,
  RoutineTriggerSecretRestoreMaterial,
  routineSecretMutationActor,
} from "./routine-ownership-and-secrets.js";
import { nextCronTickInTimeZone } from "./routine-scheduling-and-variables.js";
import { routineWebhookUrl } from "./routine-projections.js";
import type { RoutineServiceScope } from "./routines.js";

export function buildRoutineRevisionMethods(scope: RoutineServiceScope) {
  const {
    db,
    ordinaryTasks,
    secretsSvc,
    runtimeEnv,
    canonicalSessions,
    getRoutineById,
    appendRoutineRevision,
    assertInvokableRoutineAssigneeInTransaction,
    assertRestorableAssignee,
    createWebhookSecret,
  } = scope;
  return {
    restoreRevision: async (
      routineId: string,
      revisionId: string,
      actor: Actor,
    ): Promise<{
      routine: Routine;
      revision: RoutineRevision;
      restoredFromRevisionId: string;
      restoredFromRevisionNumber: number;
      secretMaterials: RoutineTriggerSecretRestoreMaterial[];
    }> => {
      const secretMutationActor = routineSecretMutationActor(actor);
      const existingRoutine = await getRoutineById(routineId);
      if (!existingRoutine) throw notFound("Routine not found");
      if (!isCanonicalUuid(revisionId)) {
        throw notFound("Routine revision not found");
      }
      const targetRevision = await db
        .select()
        .from(routineRevisions)
        .where(
          and(
            eq(routineRevisions.companyId, existingRoutine.companyId),
            eq(routineRevisions.routineId, existingRoutine.id),
            eq(routineRevisions.id, revisionId),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (!targetRevision) throw notFound("Routine revision not found");

      const snapshot = targetRevision.snapshot as RoutineRevisionSnapshotV1;
      const routineSnapshot = snapshot.routine;
      await assertRestorableAssignee(existingRoutine.companyId, routineSnapshot.assigneeAgentId, actor);
      if (existingRoutine.latestRevisionId === targetRevision.id) {
        throw conflict("Selected revision is already the latest revision", {
          currentRevisionId: existingRoutine.latestRevisionId,
        });
      }

      const currentTriggersBeforeRestore = await db
        .select()
        .from(routineTriggers)
        .where(
          and(
            eq(routineTriggers.companyId, existingRoutine.companyId),
            eq(routineTriggers.routineId, existingRoutine.id),
          ),
        );
      const currentTriggerIdsBeforeRestore = new Set(
        currentTriggersBeforeRestore.map((trigger) => trigger.id),
      );
      const recreatedWebhookSecrets = new Map<
        string,
        {
          publicId: string;
          secretId: string;
          secretMaterial: RoutineTriggerSecretRestoreMaterial;
        }
      >();
      try {
        for (const trigger of snapshot.triggers) {
          if (trigger.kind !== "webhook" || currentTriggerIdsBeforeRestore.has(trigger.id)) {
            continue;
          }
          const publicId = crypto.randomBytes(12).toString("hex");
          const created = await createWebhookSecret(
            existingRoutine.companyId,
            existingRoutine.id,
            trigger.id,
            actor,
          );
          recreatedWebhookSecrets.set(trigger.id, {
            publicId,
            secretId: created.secret.id,
            secretMaterial: {
              triggerId: trigger.id,
              webhookUrl: routineWebhookUrl(runtimeEnv, publicId),
              webhookSecret: created.secretValue,
            },
          });
        }
      } catch (error) {
        for (const entry of recreatedWebhookSecrets.values()) {
          await secretsSvc.remove(entry.secretId, secretMutationActor);
        }
        throw error;
      }

      let result: {
        routine: Routine;
        revision: RoutineRevision;
        restoredFromRevisionId: string;
        restoredFromRevisionNumber: number;
        secretMaterials: RoutineTriggerSecretRestoreMaterial[];
        dispatchRefIds: string[];
      };
      try {
        result = await db.transaction(async (tx) => {
          const txDb = tx as unknown as Db;
          await tx.execute(
            sql`select id from ${routines} where ${routines.id} = ${existingRoutine.id} for update`,
          );
          const locked = await txDb
            .select()
            .from(routines)
            .where(eq(routines.id, existingRoutine.id))
            .then((rows) => rows[0] ?? null);
          if (!locked) throw notFound("Routine not found");
          if (locked.latestRevisionId === targetRevision.id) {
            throw conflict("Selected revision is already the latest revision", {
              currentRevisionId: locked.latestRevisionId,
            });
          }
          await assertInvokableRoutineAssigneeInTransaction(
            tx as unknown as TaskSessionDbTransaction,
            locked.companyId,
            routineSnapshot.assigneeAgentId,
          );

          const now = new Date();
          const [restoredRoutine] = await txDb
            .update(routines)
            .set({
              projectId: routineSnapshot.projectId,
              goalId: routineSnapshot.goalId,
              parentTaskId: routineSnapshot.parentTaskId,
              title: routineSnapshot.title,
              description: routineSnapshot.description,
              assigneeAgentId: routineSnapshot.assigneeAgentId,
              priority: routineSnapshot.priority,
              status: routineSnapshot.status,
              concurrencyPolicy: routineSnapshot.concurrencyPolicy,
              catchUpPolicy: routineSnapshot.catchUpPolicy,
              variables: routineSnapshot.variables,
              env: routineSnapshot.env,
              updatedByAgentId: actor.agentId ?? null,
              updatedByUserId: actor.userId ?? null,
              updatedAt: now,
            })
            .where(eq(routines.id, locked.id))
            .returning();

          const snapshotTriggerIds = new Set(snapshot.triggers.map((trigger) => trigger.id));
          if (snapshotTriggerIds.size === 0) {
            await txDb
              .delete(routineTriggers)
              .where(
                and(
                  eq(routineTriggers.companyId, locked.companyId),
                  eq(routineTriggers.routineId, locked.id),
                ),
              );
          } else {
            await txDb.delete(routineTriggers).where(
              and(
                eq(routineTriggers.companyId, locked.companyId),
                eq(routineTriggers.routineId, locked.id),
                not(
                  inArray(
                    routineTriggers.id,
                    snapshot.triggers.map((trigger) => trigger.id),
                  ),
                ),
              ),
            );
          }

          for (const triggerSnapshot of snapshot.triggers) {
            const current = await txDb
              .select()
              .from(routineTriggers)
              .where(
                and(
                  eq(routineTriggers.companyId, locked.companyId),
                  eq(routineTriggers.id, triggerSnapshot.id),
                ),
              )
              .then((rows) => rows[0] ?? null);
            const webhookSecret = recreatedWebhookSecrets.get(triggerSnapshot.id);
            const restoredNextRunAt =
              triggerSnapshot.kind === "schedule" &&
              triggerSnapshot.enabled &&
              triggerSnapshot.cronExpression &&
              triggerSnapshot.timezone
                ? nextCronTickInTimeZone(triggerSnapshot.cronExpression, triggerSnapshot.timezone, now)
                : null;
            const baseValues = {
              companyId: locked.companyId,
              routineId: locked.id,
              kind: triggerSnapshot.kind,
              label: triggerSnapshot.label,
              enabled: triggerSnapshot.enabled,
              cronExpression: triggerSnapshot.kind === "schedule" ? triggerSnapshot.cronExpression : null,
              timezone: triggerSnapshot.kind === "schedule" ? triggerSnapshot.timezone : null,
              publicId:
                triggerSnapshot.kind === "webhook"
                  ? (current?.publicId ?? webhookSecret?.publicId ?? triggerSnapshot.publicId)
                  : null,
              secretId:
                triggerSnapshot.kind === "webhook"
                  ? (current?.secretId ?? webhookSecret?.secretId ?? null)
                  : null,
              signingMode: triggerSnapshot.kind === "webhook" ? triggerSnapshot.signingMode : null,
              replayWindowSec: triggerSnapshot.kind === "webhook" ? triggerSnapshot.replayWindowSec : null,
              nextRunAt: restoredNextRunAt,
              updatedByAgentId: actor.agentId ?? null,
              updatedByUserId: actor.userId ?? null,
              updatedAt: now,
            };
            if (current) {
              await txDb
                .update(routineTriggers)
                .set(baseValues)
                .where(eq(routineTriggers.id, triggerSnapshot.id));
            } else {
              await txDb.insert(routineTriggers).values({
                id: triggerSnapshot.id,
                ...baseValues,
                createdByAgentId: actor.agentId ?? null,
                createdByUserId: actor.userId ?? null,
                createdAt: now,
              });
            }
          }

          const appended = await appendRoutineRevision(txDb, restoredRoutine ?? locked, actor, {
            changeSummary: `Restored from revision ${targetRevision.revisionNumber}`,
            restoredFromRevisionId: targetRevision.id,
          });
          await secretsSvc.syncEnvBindingsForTarget(
            locked.companyId,
            { targetType: "routine", targetId: locked.id },
            routineSnapshot.env,
            {
              actor: secretMutationActor,
              db: tx,
            },
          );
          let dispatchRefIds: string[] = [];
          if (locked.status !== "archived" && appended.routine.status === "archived") {
            const escalations = await terminalizeRoutineCreatorEdgesInTransaction(tx, canonicalSessions, {
              companyId: locked.companyId,
              routineId: locked.id,
              sourceId: `routine-archived:${locked.id}`,
              now,
            });
            dispatchRefIds = escalations.flatMap((escalation) =>
              escalation.dispatchRefId ? [escalation.dispatchRefId] : [],
            );
          }
          return {
            routine: appended.routine,
            revision: appended.revision,
            restoredFromRevisionId: targetRevision.id,
            restoredFromRevisionNumber: targetRevision.revisionNumber,
            secretMaterials: [...recreatedWebhookSecrets.values()].map((entry) => entry.secretMaterial),
            dispatchRefIds,
          };
        });
      } catch (error) {
        for (const entry of recreatedWebhookSecrets.values()) {
          await secretsSvc.remove(entry.secretId, secretMutationActor);
        }
        throw error;
      }
      for (const refId of result.dispatchRefIds) {
        await ordinaryTasks.dispatchRef(refId);
      }

      const restoredTriggers = await db
        .select()
        .from(routineTriggers)
        .where(
          and(
            eq(routineTriggers.companyId, existingRoutine.companyId),
            eq(routineTriggers.routineId, existingRoutine.id),
          ),
        );
      const activeWebhookSecretIds = new Set(
        restoredTriggers.flatMap((trigger) =>
          trigger.kind === "webhook" && trigger.secretId ? [trigger.secretId] : [],
        ),
      );
      const obsoleteSecretIds = new Set<string>();
      for (const trigger of currentTriggersBeforeRestore) {
        if (trigger.kind === "webhook" && trigger.secretId && !activeWebhookSecretIds.has(trigger.secretId)) {
          obsoleteSecretIds.add(trigger.secretId);
        }
      }
      for (const entry of recreatedWebhookSecrets.values()) {
        if (!activeWebhookSecretIds.has(entry.secretId)) {
          obsoleteSecretIds.add(entry.secretId);
        }
      }
      for (const secretId of obsoleteSecretIds) {
        await secretsSvc.remove(secretId, secretMutationActor);
      }
      const { dispatchRefIds: _dispatchRefIds, ...restored } = result;
      return restored;
    },
  };
}
