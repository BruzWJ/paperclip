import {
  activityLog,
  pluginWithdrawalOperations,
  taskCreatorWithdrawalCommands,
  taskExecutionAuthorities,
  tasks,
  type Db,
} from "@paperclipai/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { persistActivityLog, publishCommittedActivity } from "./activity-log.js";
import { reserveTaskExecutionWorkspaceBinding } from "./execution-workspaces.js";
import { createOrdinaryTaskReassignmentCommitter } from "./ordinary-task-runtime-reassignment.js";
import * as runtime from "./ordinary-task-runtime-shared.js";
import { createTaskFormCommitRuntime, revokeOutgoingOwnershipEpoch } from "./runtime-task-action-port.js";
import { createTaskSessionAdmissionService } from "./task-session/admission.js";
import type {
  OrdinaryPluginWithdrawalPrepareInput,
  OrdinaryTaskRuntimeOptions,
  OrdinaryTaskUserWithdrawalSelfAssignmentInput,
} from "./ordinary-task-runtime-shared-part-1.js";
export function createOrdinaryTaskRuntimePart5(db: Db, options: OrdinaryTaskRuntimeOptions) {
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
    async userCreatorWithdrawalSelfAssign(input: OrdinaryTaskUserWithdrawalSelfAssignmentInput) {
      const actorUserId = runtime.exactNonBlank(input.actorUserId, "actorUserId");
      const idempotencyKey = runtime.exactNonBlank(input.idempotencyKey, "idempotencyKey");
      const auditId = runtime.deterministicUuid(
        "user-creator-withdrawal-self-assignment",
        `${input.companyId}:${idempotencyKey}`,
      );
      const withdrawalCommandId = runtime.deterministicUuid(
        "user-creator-withdrawal-command",
        `${input.companyId}:${idempotencyKey}`,
      );
      const committed = await db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`${input.companyId}:user-creator-withdrawal:${idempotencyKey}`}, 0))`,
        );
        const priorAudit = await tx
          .select()
          .from(activityLog)
          .where(eq(activityLog.id, auditId))
          .then((rows) => rows[0] ?? null);
        if (priorAudit) {
          if (
            priorAudit.companyId !== input.companyId ||
            priorAudit.entityId !== input.taskId ||
            priorAudit.actorId !== actorUserId ||
            priorAudit.action !== "task.user_creator_withdrawal_self_assigned"
          ) {
            throw new runtime.OrdinaryTaskRuntimeRejected(
              "Withdrawal self-assignment idempotency key changed immutable input",
              "withdrawal_self_assignment_idempotency_conflict",
            );
          }
          const [task, command] = await Promise.all([
            tx
              .select()
              .from(tasks)
              .where(and(eq(tasks.companyId, input.companyId), eq(tasks.id, input.taskId)))
              .then((rows) => rows[0] ?? null),
            tx
              .select()
              .from(taskCreatorWithdrawalCommands)
              .where(eq(taskCreatorWithdrawalCommands.id, withdrawalCommandId))
              .limit(1)
              .then((rows) => rows[0] ?? null),
          ]);
          if (
            !task ||
            !command ||
            command.companyId !== input.companyId ||
            command.taskId !== input.taskId ||
            command.actorKind !== "user" ||
            command.actorUserId !== actorUserId ||
            command.resultingCreatorEdgeId === null ||
            command.resultingOwnershipEpoch !== task.ownershipEpoch ||
            command.outgoingOwnershipEpoch + 1 !== command.resultingOwnershipEpoch
          ) {
            throw new runtime.OrdinaryTaskRuntimeRejected(
              "Accepted withdrawal self-assignment lost its canonical command",
              "withdrawal_self_assignment_incomplete",
            );
          }
          return {
            task,
            auditId,
            committedActivity: null,
            command,
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
        if (
          !task ||
          !task.ownershipEpoch ||
          !task.lifecycleStatus ||
          !runtime.NONTERMINAL.has(task.lifecycleStatus) ||
          task.creatorKind !== "user/board" ||
          task.creatorUserId !== actorUserId ||
          task.ownerKind !== "agent" ||
          !task.ownerAgentId
        ) {
          throw new runtime.OrdinaryTaskRuntimeRejected(
            "Only the exact named-user creator may self-assign a nonterminal agent-owned task for withdrawal",
            "withdrawal_self_assignment_target_invalid",
          );
        }
        const sessionState = await runtime.lockTaskSessionState(tx, input.companyId, task.id);
        if (!sessionState) {
          throw new runtime.OrdinaryTaskRuntimeRejected(
            "Withdrawal self-assignment target Session is missing",
            "withdrawal_self_assignment_session_missing",
          );
        }
        const outgoingAuthority = await tx
          .select()
          .from(taskExecutionAuthorities)
          .where(
            and(
              eq(taskExecutionAuthorities.companyId, input.companyId),
              eq(taskExecutionAuthorities.taskId, task.id),
              eq(taskExecutionAuthorities.ownershipEpoch, task.ownershipEpoch),
              eq(taskExecutionAuthorities.agentId, task.ownerAgentId),
              eq(taskExecutionAuthorities.state, "current"),
            ),
          )
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!outgoingAuthority) {
          throw new runtime.OrdinaryTaskRuntimeRejected(
            "Withdrawal self-assignment has no outgoing owner authority",
            "withdrawal_self_assignment_authority_missing",
          );
        }
        const now = clock();
        const revocation = await revokeOutgoingOwnershipEpoch(
          tx,
          sessions,
          options.taskExecutionCancellation,
          {
            companyId: input.companyId,
            taskId: task.id,
            sessionId: sessionState.session.id,
            ownershipEpoch: task.ownershipEpoch,
            authorityId: outgoingAuthority.id,
            sourceAuthorityId: actorUserId,
            cancellationActor: {
              kind: "user",
              userId: actorUserId,
            },
            now,
          },
        );
        const ownershipEpoch = task.ownershipEpoch + 1;
        const reassigned = await tx
          .update(tasks)
          .set({
            ownerKind: "user",
            ownerAgentId: null,
            ownerUserId: actorUserId,
            ownerAssignmentSource: "user_creator_withdrawal",
            ownershipEpoch,
            updatedAt: now,
          })
          .where(
            and(
              eq(tasks.companyId, input.companyId),
              eq(tasks.id, task.id),
              eq(tasks.ownershipEpoch, task.ownershipEpoch),
              inArray(tasks.lifecycleStatus, ["open", "blocked"]),
            ),
          )
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!reassigned) {
          throw new runtime.OrdinaryTaskRuntimeRejected(
            "Ownership epoch changed during withdrawal self-assignment",
            "withdrawal_self_assignment_epoch_conflict",
          );
        }
        await runtime.withOrdinaryWorkspaceReservationErrors(() =>
          reserveTaskExecutionWorkspaceBinding(tx, {
            task: reassigned,
            session: {
              id: sessionState.session.id,
              now,
            },
            provenance: {
              agentId: null,
              userId: actorUserId,
            },
          }),
        );
        const resultingEdge = await runtime.insertCreatorEdge(tx, reassigned, sessionState.session.id, now);
        const command = await tx
          .insert(taskCreatorWithdrawalCommands)
          .values({
            id: withdrawalCommandId,
            companyId: input.companyId,
            taskId: task.id,
            outgoingOwnershipEpoch: task.ownershipEpoch,
            resultingOwnershipEpoch: ownershipEpoch,
            resultingCreatorEdgeId: resultingEdge.id,
            actorKind: "user",
            actorUserId,
            actorPluginInstallationId: null,
            actorPluginKey: null,
            pluginWithdrawalOperationId: null,
            taskUpdateId: null,
            acceptedAt: now,
          })
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!command) {
          throw new runtime.OrdinaryTaskRuntimeRejected(
            "Withdrawal self-assignment command was not persisted",
            "withdrawal_self_assignment_command_missing",
          );
        }
        const committedActivity = await persistActivityLog(
          tx as unknown as Db,
          {
            companyId: input.companyId,
            actorType: "user",
            actorId: actorUserId,
            action: "task.user_creator_withdrawal_self_assigned",
            entityType: "task",
            entityId: task.id,
            details: {
              contract: "user-creator-withdrawal-self-assignment/v1",
              idempotencyKey,
              outgoingOwnerAgentId: task.ownerAgentId,
              outgoingOwnershipEpoch: task.ownershipEpoch,
              ownershipEpoch,
              ownerAssignmentSource: "user_creator_withdrawal",
            },
          },
          { id: auditId, createdAt: now },
        );
        return {
          task: reassigned,
          auditId,
          committedActivity,
          command,
          escalationDispatchRefIds: revocation.escalationDispatchRefIds,
          cancellations: revocation.cancellations,
          retried: false as const,
        };
      });
      if (committed.committedActivity) {
        publishCommittedActivity(committed.committedActivity);
      }
      if (committed.cancellations) {
        await options.taskExecutionCancellation.reconcileRequestedCancellations(committed.cancellations);
      }
      for (const refId of committed.escalationDispatchRefIds) {
        await dispatch(refId);
      }
      const { committedActivity: _committedActivity, ...publicResult } = committed;
      return publicResult;
    },
    async preparePluginWithdrawal(input: OrdinaryPluginWithdrawalPrepareInput) {
      const message = runtime.nonBlankPreservingBytes(input.message, "message");
      const operationId = runtime.exactNonBlank(input.operationId, "operationId");
      const identityDigest = createHash("sha256")
        .update(
          runtime.canonicalJson({
            companyId: input.companyId,
            taskId: input.taskId,
            message,
            operationId,
            pluginInstallationId: input.pluginInstallationId,
            pluginKey: input.pluginKey,
          }),
        )
        .digest("hex");
      const inserted = await db
        .insert(pluginWithdrawalOperations)
        .values({
          companyId: input.companyId,
          pluginInstallationId: input.pluginInstallationId,
          pluginKey: input.pluginKey,
          hostRpcOperationId: operationId,
          identityDigest,
          taskId: input.taskId,
          message,
          state: "pending",
          result: null,
          taskUpdateId: null,
          mutationCommentId: null,
        })
        .onConflictDoNothing()
        .returning()
        .then((rows) => rows[0] ?? null);
      const operation =
        inserted ??
        (await db
          .select()
          .from(pluginWithdrawalOperations)
          .where(
            and(
              eq(pluginWithdrawalOperations.pluginInstallationId, input.pluginInstallationId),
              eq(pluginWithdrawalOperations.hostRpcOperationId, operationId),
            ),
          )
          .limit(1)
          .then((rows) => rows[0] ?? null));
      if (
        !operation ||
        operation.identityDigest !== identityDigest ||
        operation.companyId !== input.companyId ||
        operation.taskId !== input.taskId ||
        operation.pluginKey !== input.pluginKey ||
        operation.message !== message
      ) {
        throw new runtime.OrdinaryTaskRuntimeRejected(
          "Plugin withdrawal operation changed immutable input",
          "plugin_withdrawal_idempotency_conflict",
        );
      }
      return { operationId };
    },
  };
}
