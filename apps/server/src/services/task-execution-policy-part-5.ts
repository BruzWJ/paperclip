import { randomUUID } from "node:crypto";

import { taskExecutionDecisions, taskUpdates, tasks, type Db } from "@paperclipai/db";

import type { TaskExecutionDecision, TaskExecutionState } from "@paperclipai/shared";

import { and, desc, eq, inArray } from "drizzle-orm";

import { conflict, unprocessable } from "../errors.js";

import { recordNamedBoardLifecycleCommandInTransaction } from "./task-board-lifecycle-command.js";
import type { TaskExecutionCancellationService } from "./task-execution-cancellation.js";
import {
  type TaskExecutionPolicyActor,
  applyTaskExecutionPolicyTransition,
} from "./task-execution-policy-part-3.js";
import * as policyControl from "./task-execution-policy-part-4.js";
import { COMPLETED_STATUS } from "./task-execution-policy-part-1.js";
import {
  normalizeTaskExecutionPolicy,
  parseTaskExecutionState,
  setTaskExecutionPolicyMonitorScheduledBy,
} from "./task-execution-policy-part-2.js";

/**
 * The board execution-policy control plane is intentionally separate from
 * generic task metadata mutation. It can configure policy and append stage
 * decisions. Final approval stops outstanding work while preserving native
 * carry, but this service never owns a task, advances its ownership epoch,
 * writes a provider message, or dispatches an execution.
 */
type TaskExecutionPolicyCancellationPort = Pick<
  TaskExecutionCancellationService,
  "requestScopeCancellationsInTransaction" | "reconcileRequestedCancellations"
>;

export function taskExecutionPolicyControlService(
  db: Db,
  options: {
    clock?: () => Date;
    taskExecutionCancellation: TaskExecutionPolicyCancellationPort;
  },
) {
  const clock = options.clock ?? (() => new Date());

  return {
    async configure(input: {
      companyId: string;
      taskId: string;
      executionPolicy: unknown;
      actorUserId: string;
    }) {
      return db.transaction(async (tx) => {
        const task = await policyControl.lockTaskForExecutionPolicy(tx, input.companyId, input.taskId);
        const previousPolicy = normalizeTaskExecutionPolicy(task.executionPolicy);
        const normalizedPolicy = setTaskExecutionPolicyMonitorScheduledBy(
          normalizeTaskExecutionPolicy(input.executionPolicy),
          "board",
        );
        const monitorChanged =
          JSON.stringify(previousPolicy?.monitor ?? null) !==
          JSON.stringify(normalizedPolicy?.monitor ?? null);
        const transition = applyTaskExecutionPolicyTransition({
          task,
          policy: normalizedPolicy,
          previousPolicy,
          requestedOwnerPatch: {},
          actor: { userId: input.actorUserId },
          monitorExplicitlyUpdated: monitorChanged,
        });
        const transitionPatch = policyControl.taskExecutionPolicyPersistencePatch(transition.patch);
        const persistencePatch = {
          executionPolicy: normalizedPolicy as Record<string, unknown> | null,
          ...transitionPatch,
        };
        if (!policyControl.taskPatchChangesPersistedState(task, persistencePatch)) {
          return task;
        }
        const now = clock();
        const sourceCommandId = randomUUID();
        const updated = await tx
          .update(tasks)
          .set({
            ...persistencePatch,
            updatedAt: now,
          })
          .where(and(eq(tasks.companyId, input.companyId), eq(tasks.id, input.taskId)))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!updated) {
          throw conflict("Task changed while applying its execution policy");
        }
        await recordNamedBoardLifecycleCommandInTransaction(tx, {
          companyId: input.companyId,
          affectedTasks: [{ id: updated.id, ownershipEpoch: updated.ownershipEpoch }],
          actorUserId: input.actorUserId,
          subtype: "execution_policy_configure",
          sourceCommandId,
          idempotencyKey: `execution-policy-configure:${sourceCommandId}`,
          committedAt: now,
        });
        return updated;
      });
    },

    async decide(input: {
      companyId: string;
      taskId: string;
      outcome: TaskExecutionDecision["outcome"];
      body: string;
      reviewRequest?: TaskExecutionState["reviewRequest"] | null;
      idempotencyKey: string;
      actor: TaskExecutionPolicyActor;
    }): Promise<policyControl.TaskExecutionPolicyControlResult> {
      policyControl.assertExecutionPolicyActor(input.actor);
      const body = input.body.trim();
      const idempotencyKey = input.idempotencyKey;
      const decisionId = policyControl.deterministicExecutionPolicyDecisionId({
        companyId: input.companyId,
        taskId: input.taskId,
        idempotencyKey,
      });

      const committed = await db.transaction(async (tx) => {
        const task = await policyControl.lockTaskForExecutionPolicy(tx, input.companyId, input.taskId);
        const existingDecision = await tx
          .select()
          .from(taskExecutionDecisions)
          .where(eq(taskExecutionDecisions.id, decisionId))
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (existingDecision) {
          if (
            existingDecision.companyId !== input.companyId ||
            existingDecision.taskId !== input.taskId ||
            existingDecision.actorAgentId !== (input.actor.agentId ?? null) ||
            existingDecision.actorUserId !== (input.actor.userId ?? null) ||
            existingDecision.createdByRunId !== (input.actor.runId ?? null) ||
            existingDecision.outcome !== input.outcome ||
            existingDecision.body !== body
          ) {
            throw conflict(
              "Execution-policy decision idempotency key was retried with different immutable arguments",
            );
          }
          if (input.actor.userId) {
            await recordNamedBoardLifecycleCommandInTransaction(tx, {
              companyId: input.companyId,
              affectedTasks: [{ id: task.id, ownershipEpoch: task.ownershipEpoch }],
              actorUserId: input.actor.userId,
              subtype: "execution_policy_decision",
              sourceCommandId: existingDecision.id,
              idempotencyKey,
              committedAt: existingDecision.createdAt,
            });
          }
          return {
            task,
            decision: existingDecision,
            cancellations: null,
            retried: true,
          };
        }

        if (task.lifecycleStatus !== "open" && task.lifecycleStatus !== "blocked") {
          throw conflict("A terminal task rejects execution-policy decisions");
        }
        const policy = normalizeTaskExecutionPolicy(task.executionPolicy);
        if (!policy) {
          throw unprocessable("Task has no execution policy to decide");
        }
        const transition = applyTaskExecutionPolicyTransition({
          task,
          policy,
          requestedStatus: input.outcome === "approved" ? "done" : "in_progress",
          requestedOwnerPatch: {},
          actor: input.actor,
          commentBody: body,
          reviewRequest: input.reviewRequest,
        });
        if (!transition.decision || transition.decision.outcome !== input.outcome) {
          throw unprocessable("Only the active execution-policy participant can record this decision");
        }
        const nextStateRaw = transition.patch.executionState;
        if (!nextStateRaw || typeof nextStateRaw !== "object" || Array.isArray(nextStateRaw)) {
          throw new Error("Execution-policy decision transition is missing executionState");
        }
        const nextState = parseTaskExecutionState(nextStateRaw);
        if (!nextState) {
          throw new Error("Execution-policy decision transition produced invalid executionState");
        }
        transition.patch.executionState = {
          ...nextState,
          lastDecisionId: decisionId,
        };
        const finalApproval = input.outcome === "approved" && nextState.status === COMPLETED_STATUS;

        let terminalUpdate: typeof taskUpdates.$inferSelect | null = null;
        if (finalApproval) {
          terminalUpdate = await tx
            .select()
            .from(taskUpdates)
            .where(
              and(
                eq(taskUpdates.companyId, input.companyId),
                eq(taskUpdates.taskId, input.taskId),
                eq(taskUpdates.ownershipEpoch, task.ownershipEpoch!),
                eq(taskUpdates.form, "owner"),
                eq(taskUpdates.status, "done"),
              ),
            )
            .orderBy(desc(taskUpdates.createdAt), desc(taskUpdates.runSequence), desc(taskUpdates.id))
            .limit(1)
            .then((rows) => rows[0] ?? null);
          if (!terminalUpdate?.disposition || !terminalUpdate.runId) {
            throw unprocessable("Final approval requires a canonical current-owner done update");
          }
        }

        const insertedDecision = await tx
          .insert(taskExecutionDecisions)
          .values({
            id: decisionId,
            companyId: input.companyId,
            taskId: input.taskId,
            stageId: transition.decision.stageId,
            stageType: transition.decision.stageType,
            actorAgentId: input.actor.agentId ?? null,
            actorUserId: input.actor.userId ?? null,
            outcome: transition.decision.outcome,
            body: transition.decision.body,
            createdByRunId: input.actor.runId ?? null,
            createdAt: clock(),
            updatedAt: clock(),
          })
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!insertedDecision) {
          throw conflict("Execution-policy decision was not persisted");
        }

        const transitionPatch = policyControl.taskExecutionPolicyPersistencePatch(transition.patch);
        const now = clock();
        const updated = await tx
          .update(tasks)
          .set({
            ...transitionPatch,
            ...(finalApproval
              ? {
                  lifecycleStatus: "done" as const,
                  boardPresentationStatus: "done",
                  disposition: terminalUpdate!.disposition,
                  completedAt: now,
                  cancelledAt: null,
                }
              : {}),
            updatedAt: now,
          })
          .where(
            and(
              eq(tasks.companyId, input.companyId),
              eq(tasks.id, input.taskId),
              eq(tasks.ownershipEpoch, task.ownershipEpoch!),
              inArray(tasks.lifecycleStatus, ["open", "blocked"]),
            ),
          )
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!updated) {
          throw conflict("Task lifecycle or ownership changed during its execution-policy decision");
        }

        const cancellations = finalApproval
          ? await options.taskExecutionCancellation.requestScopeCancellationsInTransaction(tx, {
              companyId: input.companyId,
              taskId: updated.id,
              selector: {
                kind: "ownership_epoch",
                ownershipEpoch: updated.ownershipEpoch,
              },
              reason: "task_completed",
              actor: input.actor.userId
                ? { kind: "user", userId: input.actor.userId }
                : { kind: "agent", agentId: input.actor.agentId! },
              now,
              nativeContinuity: "preserve_carry",
            })
          : null;

        if (input.actor.userId) {
          await recordNamedBoardLifecycleCommandInTransaction(tx, {
            companyId: input.companyId,
            affectedTasks: [{ id: updated.id, ownershipEpoch: updated.ownershipEpoch }],
            actorUserId: input.actor.userId,
            subtype: "execution_policy_decision",
            sourceCommandId: insertedDecision.id,
            idempotencyKey,
            committedAt: insertedDecision.createdAt,
          });
        }

        return {
          task: updated,
          decision: insertedDecision,
          cancellations,
          retried: false,
        };
      });
      if (committed.cancellations) {
        void options.taskExecutionCancellation
          .reconcileRequestedCancellations(committed.cancellations)
          .catch(() => {
            // The durable cancellation-intent reconciler retries this signal.
          });
      }
      const { cancellations: _, ...result } = committed;
      return result;
    },
  };
}
