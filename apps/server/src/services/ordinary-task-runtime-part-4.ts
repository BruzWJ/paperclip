import { activityLog, taskExecutionRefs, tasks, type Db } from "@paperclipai/db";
import { and, eq, sql } from "drizzle-orm";
import { persistActivityLog, publishCommittedActivity } from "./activity-log.js";
import { createOrdinaryTaskReassignmentCommitter } from "./ordinary-task-runtime-reassignment.js";
import {
  NONTERMINAL,
  OrdinaryTaskRuntimeRejected,
  deterministicUuid,
  exactNonBlank,
  resolveOrdinaryTaskOwner,
} from "./ordinary-task-runtime-shared.js";
import { assertPluginPermittedTaskOwnerInTransaction } from "./plugin-task-authorization.js";
import { createTaskFormCommitRuntime } from "./runtime-task-action-port.js";
import { createTaskSessionAdmissionService } from "./task-session/admission.js";
import type {
  OrdinaryTaskBoardReassignInput,
  OrdinaryTaskReassignInput,
  OrdinaryTaskRuntimeOptions,
} from "./ordinary-task-runtime-shared-part-1.js";
export function createOrdinaryTaskRuntimePart4(db: Db, options: OrdinaryTaskRuntimeOptions) {
  const clock = options.clock ?? (() => new Date());
  const sessions = createTaskSessionAdmissionService(db, { clock });
  const taskForms = createTaskFormCommitRuntime(db, {
    clock,
    dispatchPersistedRef: options.dispatchRef,
    taskExecutionCancellation: options.taskExecutionCancellation,
  });
  async function dispatch(refId: string): Promise<void> {
    await options.dispatchRef(refId);
  }
  const commitAgentOwnerReassignmentInTransaction = createOrdinaryTaskReassignmentCommitter({
    options,
    clock,
    sessions,
  });

  return {
    async reassign(input: OrdinaryTaskReassignInput) {
      const ownerAgentId = exactNonBlank(input.ownerAgentId, "ownerAgentId");
      const idempotencyKey = exactNonBlank(input.idempotencyKey, "idempotencyKey");
      const result = await db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`${input.companyId}:${input.taskId}`}, 0))`,
        );
        const pluginOwnerResolution =
          input.creator.kind === "plugin"
            ? await assertPluginPermittedTaskOwnerInTransaction(tx, {
                companyId: input.companyId,
                pluginInstallationId: input.creator.pluginInstallationId,
                pluginKey: input.creator.pluginKey,
                operation: "tasks.update",
                ownerAgentId,
              })
            : null;
        const priorRef = await tx
          .select()
          .from(taskExecutionRefs)
          .where(
            and(
              eq(taskExecutionRefs.companyId, input.companyId),
              eq(taskExecutionRefs.sourceKind, "task_reassignment"),
              eq(taskExecutionRefs.deliveryIdempotencyKey, idempotencyKey),
            ),
          )
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (priorRef) {
          if (priorRef.taskId !== input.taskId || priorRef.targetAgentId !== ownerAgentId) {
            throw new OrdinaryTaskRuntimeRejected(
              "Reassignment idempotency key changed immutable input",
              "reassignment_idempotency_conflict",
            );
          }
          const task = await tx
            .select()
            .from(tasks)
            .where(eq(tasks.id, input.taskId))
            .then((rows) => rows[0] ?? null);
          return {
            task,
            ref: priorRef,
            escalationDispatchRefIds: [] as string[],
            cancellations: null,
            retried: true,
          };
        }
        const task = await tx
          .select()
          .from(tasks)
          .where(and(eq(tasks.companyId, input.companyId), eq(tasks.id, input.taskId)))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (
          !task ||
          !task.ownershipEpoch ||
          task.ownerKind !== "agent" ||
          !task.ownerAgentId ||
          !task.request ||
          !task.lifecycleStatus ||
          !NONTERMINAL.has(task.lifecycleStatus)
        ) {
          throw new OrdinaryTaskRuntimeRejected(
            "Reassignment requires a nonterminal agent-owned task",
            "reassignment_target_invalid",
          );
        }
        const creatorMatches =
          input.creator.kind === "user/board"
            ? task.creatorKind === "user/board" && task.creatorUserId === input.creator.userId
            : task.creatorKind === "plugin" &&
              task.creatorPluginInstallationId === input.creator.pluginInstallationId &&
              task.creatorPluginKey === input.creator.pluginKey;
        if (!creatorMatches) {
          throw new OrdinaryTaskRuntimeRejected(
            "Creator identity does not match this task",
            "creator_authority_mismatch",
          );
        }
        const ownerResolution =
          input.creator.kind === "plugin"
            ? pluginOwnerResolution!
            : await resolveOrdinaryTaskOwner(tx, input.companyId, ownerAgentId);
        return commitAgentOwnerReassignmentInTransaction(tx, {
          task,
          ownerAgentId,
          idempotencyKey,
          sourceAuthorityId:
            input.creator.kind === "plugin" ? input.creator.pluginInstallationId : input.creator.userId,
          cancellationActor:
            input.creator.kind === "user/board"
              ? {
                  kind: "user",
                  userId: input.creator.userId,
                }
              : { kind: "system" },
          comment:
            input.creator.kind === "plugin"
              ? {
                  author: {
                    kind: "plugin",
                    pluginInstallationId: input.creator.pluginInstallationId,
                    pluginKey: input.creator.pluginKey,
                  },
                  producingRun: null,
                }
              : {
                  author: {
                    kind: "user",
                    userId: input.creator.userId,
                  },
                  producingRun: null,
                },
          provenanceUserId: input.creator.kind === "user/board" ? input.creator.userId : null,
          sourceActor:
            input.creator.kind === "user/board"
              ? {
                  kind: "user/board",
                  userId: input.creator.userId,
                }
              : {
                  kind: "plugin",
                  pluginInstallationId: input.creator.pluginInstallationId,
                  pluginKey: input.creator.pluginKey,
                },
          ownerResolution,
        });
      });
      if (result.cancellations) {
        await options.taskExecutionCancellation.reconcileRequestedCancellations(result.cancellations);
      }
      for (const refId of result.escalationDispatchRefIds) {
        await dispatch(refId);
      }
      await dispatch(result.ref.id);
      return result;
    },
    async boardReassign(input: OrdinaryTaskBoardReassignInput) {
      const ownerAgentId = exactNonBlank(input.ownerAgentId, "ownerAgentId");
      const actorUserId = exactNonBlank(input.actorUserId, "actorUserId");
      const idempotencyKey = exactNonBlank(input.idempotencyKey, "idempotencyKey");
      const auditId = deterministicUuid(
        "board-task-reassignment-audit",
        `${input.companyId}:${idempotencyKey}`,
      );
      const result = await db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`${input.companyId}:board-reassign:${idempotencyKey}`}, 0))`,
        );
        const priorRef = await tx
          .select()
          .from(taskExecutionRefs)
          .where(
            and(
              eq(taskExecutionRefs.companyId, input.companyId),
              eq(taskExecutionRefs.sourceKind, "task_reassignment"),
              eq(taskExecutionRefs.deliveryIdempotencyKey, idempotencyKey),
            ),
          )
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (priorRef) {
          if (priorRef.taskId !== input.taskId || priorRef.targetAgentId !== ownerAgentId) {
            throw new OrdinaryTaskRuntimeRejected(
              "Board reassignment idempotency key changed immutable input",
              "reassignment_idempotency_conflict",
            );
          }
          const [task, audit] = await Promise.all([
            tx
              .select()
              .from(tasks)
              .where(and(eq(tasks.companyId, input.companyId), eq(tasks.id, input.taskId)))
              .then((rows) => rows[0] ?? null),
            tx
              .select()
              .from(activityLog)
              .where(eq(activityLog.id, auditId))
              .then((rows) => rows[0] ?? null),
          ]);
          if (!task || !audit || audit.actorId !== actorUserId || audit.action !== "task.board_reassigned") {
            throw new OrdinaryTaskRuntimeRejected(
              "Accepted board reassignment is missing its audit record",
              "reassignment_audit_missing",
            );
          }
          return {
            task,
            ref: priorRef,
            auditId,
            committedActivity: null,
            escalationDispatchRefIds: [] as string[],
            cancellations: null,
            retried: true as const,
          };
        }
        const task = await tx
          .select()
          .from(tasks)
          .where(and(eq(tasks.companyId, input.companyId), eq(tasks.id, input.taskId)))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!task) {
          throw new OrdinaryTaskRuntimeRejected(
            "Board reassignment target does not exist",
            "reassignment_target_invalid",
          );
        }
        const ownerResolution = await resolveOrdinaryTaskOwner(tx, input.companyId, ownerAgentId);
        const previousOwnerAgentId = task.ownerAgentId;
        const previousOwnershipEpoch = task.ownershipEpoch;
        const reassigned = await commitAgentOwnerReassignmentInTransaction(tx, {
          task,
          ownerAgentId,
          idempotencyKey,
          sourceAuthorityId: actorUserId,
          cancellationActor: {
            kind: "user",
            userId: actorUserId,
          },
          comment: {
            author: { kind: "user", userId: actorUserId },
            producingRun: null,
          },
          sourceActor: {
            kind: "user/board",
            userId: actorUserId,
          },
          provenanceUserId: actorUserId,
          ownerResolution,
        });
        const committedActivity = await persistActivityLog(
          tx as unknown as Db,
          {
            companyId: input.companyId,
            actorType: "user",
            actorId: actorUserId,
            action: "task.board_reassigned",
            entityType: "task",
            entityId: task.id,
            details: {
              contract: "board-task-reassignment/v1",
              idempotencyKey,
              previousOwnerAgentId,
              previousOwnershipEpoch,
              ownerAgentId,
              ownershipEpoch: reassigned.task.ownershipEpoch,
              executionRefId: reassigned.ref.id,
            },
          },
          { id: auditId, createdAt: clock() },
        );
        return { ...reassigned, auditId, committedActivity };
      });
      if (result.committedActivity) {
        publishCommittedActivity(result.committedActivity);
      }
      if (result.cancellations) {
        await options.taskExecutionCancellation.reconcileRequestedCancellations(result.cancellations);
      }
      for (const refId of result.escalationDispatchRefIds) {
        await dispatch(refId);
      }
      await dispatch(result.ref.id);
      const { committedActivity: _committedActivity, ...publicResult } = result;
      return publicResult;
    },
  };
}
