import {
  pluginWithdrawalOperations,
  taskCreatorWithdrawalCommands,
  taskExecutionAuthorities,
  taskSessions,
  taskUpdates,
  tasks,
  type Db,
} from "@paperclipai/db";
import { and, eq, sql } from "drizzle-orm";
import { reserveTaskExecutionWorkspaceBinding } from "./execution-workspaces.js";
import { createOrdinaryTaskReassignmentCommitter } from "./ordinary-task-runtime-reassignment.js";
import {
  NONTERMINAL,
  OrdinaryTaskRuntimeRejected,
  deterministicUuid,
  exactNonBlank,
  pluginWithdrawalTaskSnapshot,
  recordedPluginWithdrawalRejection,
  recordedPluginWithdrawalTask,
  withOrdinaryWorkspaceReservationErrors,
} from "./ordinary-task-runtime-shared.js";
import { createTaskFormCommitRuntime, revokeOutgoingOwnershipEpoch } from "./runtime-task-action-port.js";
import { createTaskSessionAdmissionService } from "./task-session/admission.js";
import type {
  OrdinaryPluginWithdrawalInput,
  OrdinaryTaskRuntimeOptions,
  PluginWithdrawalCommitOutcome,
} from "./ordinary-task-runtime-shared-part-1.js";
export function createOrdinaryTaskRuntimePart6(db: Db, options: OrdinaryTaskRuntimeOptions) {
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
    async withdrawPluginTask(input: OrdinaryPluginWithdrawalInput) {
      const operationId = exactNonBlank(input.operationId, "operationId");
      const outcome: PluginWithdrawalCommitOutcome = await db.transaction(
        async (tx): Promise<PluginWithdrawalCommitOutcome> => {
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${`${input.pluginInstallationId}:${operationId}`}, 0))`,
          );
          const operation = await tx
            .select()
            .from(pluginWithdrawalOperations)
            .where(
              and(
                eq(pluginWithdrawalOperations.pluginInstallationId, input.pluginInstallationId),
                eq(pluginWithdrawalOperations.hostRpcOperationId, operationId),
              ),
            )
            .for("update")
            .then((rows) => rows[0] ?? null);
          if (
            !operation ||
            operation.companyId !== input.companyId ||
            operation.pluginKey !== input.pluginKey
          ) {
            throw new OrdinaryTaskRuntimeRejected(
              "Plugin withdrawal operation was not prepared by this installation",
              "plugin_withdrawal_not_prepared",
            );
          }
          const withdrawalCommandId = deterministicUuid("plugin-creator-withdrawal-command", operation.id);
          if (operation.state === "accepted") {
            const task = recordedPluginWithdrawalTask(operation.result);
            const command = await tx
              .select()
              .from(taskCreatorWithdrawalCommands)
              .where(eq(taskCreatorWithdrawalCommands.id, withdrawalCommandId))
              .limit(1)
              .then((rows) => rows[0] ?? null);
            if (
              !task ||
              !command ||
              command.companyId !== input.companyId ||
              command.taskId !== operation.taskId ||
              command.actorKind !== "plugin" ||
              command.actorUserId !== null ||
              command.actorPluginInstallationId !== input.pluginInstallationId ||
              command.actorPluginKey !== input.pluginKey ||
              command.pluginWithdrawalOperationId !== operation.id ||
              command.taskUpdateId !== operation.taskUpdateId ||
              command.resultingCreatorEdgeId !== null ||
              command.resultingOwnershipEpoch !== task.ownershipEpoch ||
              command.outgoingOwnershipEpoch + 1 !== command.resultingOwnershipEpoch
            ) {
              throw new OrdinaryTaskRuntimeRejected(
                "Accepted plugin withdrawal is missing its canonical command",
                "plugin_withdrawal_result_missing",
              );
            }
            return {
              kind: "accepted",
              operationId,
              task,
              escalationDispatchRefIds: [] as string[],
              cancellations: null,
              retried: true,
            };
          }
          if (operation.state === "rejected") {
            const rejection = recordedPluginWithdrawalRejection(operation.result);
            if (!rejection) {
              throw new OrdinaryTaskRuntimeRejected(
                "Rejected plugin withdrawal is missing its recorded result",
                "plugin_withdrawal_result_missing",
              );
            }
            return { kind: "rejected", ...rejection };
          }
          const task = await tx
            .select()
            .from(tasks)
            .where(and(eq(tasks.companyId, input.companyId), eq(tasks.id, operation.taskId)))
            .for("update")
            .then((rows) => rows[0] ?? null);
          if (
            !task ||
            !task.ownershipEpoch ||
            task.creatorKind !== "plugin" ||
            task.creatorPluginInstallationId !== input.pluginInstallationId ||
            task.creatorPluginKey !== input.pluginKey ||
            task.ownerKind !== "agent" ||
            !task.ownerAgentId ||
            !task.lifecycleStatus ||
            !NONTERMINAL.has(task.lifecycleStatus)
          ) {
            const now = clock();
            const rejection = {
              message: "Task is not a matching nonterminal plugin-created task",
              reason: "plugin_withdrawal_target_invalid",
            };
            await tx
              .update(pluginWithdrawalOperations)
              .set({
                state: "rejected",
                result: { kind: "rejected", ...rejection },
                completedAt: now,
                updatedAt: now,
              })
              .where(eq(pluginWithdrawalOperations.id, operation.id));
            return { kind: "rejected", ...rejection };
          }
          const session = await tx
            .select()
            .from(taskSessions)
            .where(and(eq(taskSessions.companyId, input.companyId), eq(taskSessions.taskId, task.id)))
            .for("update")
            .then((rows) => rows[0] ?? null);
          const authority = await tx
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
          if (!session || !authority) {
            throw new OrdinaryTaskRuntimeRejected(
              "Plugin withdrawal target has no current Session authority",
              "plugin_withdrawal_authority_missing",
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
              sessionId: session.id,
              ownershipEpoch: task.ownershipEpoch,
              authorityId: authority.id,
              sourceAuthorityId: input.pluginInstallationId,
              cancellationActor: { kind: "system" },
              now,
            },
          );
          const ownershipEpoch = task.ownershipEpoch + 1;
          const withdrawn = await tx
            .update(tasks)
            .set({
              boardPresentationStatus: "cancelled",
              lifecycleStatus: "cancelled",
              disposition: {
                message: operation.message,
                structuredResult: {
                  reason: "plugin_creator_withdrawal",
                  outgoingOwnershipEpoch: task.ownershipEpoch,
                },
              },
              ownershipEpoch,
              cancelledAt: now,
              completedAt: null,
              updatedAt: now,
            })
            .where(and(eq(tasks.id, task.id), eq(tasks.ownershipEpoch, task.ownershipEpoch)))
            .returning()
            .then((rows) => rows[0] ?? null);
          if (!withdrawn) {
            throw new OrdinaryTaskRuntimeRejected(
              "Ownership epoch changed during plugin withdrawal",
              "plugin_withdrawal_epoch_conflict",
            );
          }
          await withOrdinaryWorkspaceReservationErrors(() =>
            reserveTaskExecutionWorkspaceBinding(tx, {
              task: withdrawn,
              session: {
                id: session.id,
                now,
              },
            }),
          );
          const comment = await sessions.appendNonDispatchControlNotice(
            {
              companyId: input.companyId,
              taskId: task.id,
              sessionId: session.id,
              sourceKind: "plugin_withdrawal",
              immutableSourceKey: operation.id,
              sourceRecordId: operation.id,
              exactText: operation.message,
              comment: {
                author: {
                  kind: "plugin",
                  pluginInstallationId: input.pluginInstallationId,
                  pluginKey: input.pluginKey,
                },
                producingRun: null,
              },
              allowTerminal: true,
            },
            tx,
          );
          if (!comment.comment) {
            throw new OrdinaryTaskRuntimeRejected(
              "Plugin withdrawal comment was not persisted",
              "plugin_withdrawal_comment_missing",
            );
          }
          const update = await tx
            .insert(taskUpdates)
            .values({
              id: deterministicUuid("plugin-withdrawal-update", operation.id),
              companyId: input.companyId,
              taskId: task.id,
              sessionId: session.id,
              ownershipEpoch,
              form: "owner",
              sourceKind: "plugin",
              sourceAuthorityId: null,
              sourceIdentity: {
                pluginInstallationId: input.pluginInstallationId,
                pluginKey: input.pluginKey,
                withdrawalOperationId: operation.id,
              },
              runId: null,
              gatewayInvocationId: `plugin-withdrawal:${operation.id}`,
              runSequence: 0,
              message: operation.message,
              status: "cancelled",
              disposition: withdrawn.disposition,
              commentId: comment.comment.id,
              creatorEdgeId: null,
              createdAt: now,
            })
            .returning()
            .then((rows) => rows[0] ?? null);
          if (!update) {
            throw new OrdinaryTaskRuntimeRejected(
              "Plugin withdrawal update was not persisted",
              "plugin_withdrawal_update_missing",
            );
          }
          const acceptedOperation = await tx
            .update(pluginWithdrawalOperations)
            .set({
              state: "accepted",
              result: {
                kind: "accepted",
                operationId,
                taskId: task.id,
                ownershipEpoch,
                status: "cancelled",
                task: pluginWithdrawalTaskSnapshot(withdrawn),
              },
              taskUpdateId: update.id,
              mutationCommentId: comment.comment.id,
              completedAt: now,
              updatedAt: now,
            })
            .where(eq(pluginWithdrawalOperations.id, operation.id))
            .returning()
            .then((rows) => rows[0] ?? null);
          if (!acceptedOperation) {
            throw new OrdinaryTaskRuntimeRejected(
              "Plugin withdrawal operation was not accepted",
              "plugin_withdrawal_operation_missing",
            );
          }
          const command = await tx
            .insert(taskCreatorWithdrawalCommands)
            .values({
              id: withdrawalCommandId,
              companyId: input.companyId,
              taskId: task.id,
              outgoingOwnershipEpoch: task.ownershipEpoch,
              resultingOwnershipEpoch: ownershipEpoch,
              resultingCreatorEdgeId: null,
              actorKind: "plugin",
              actorUserId: null,
              actorPluginInstallationId: input.pluginInstallationId,
              actorPluginKey: input.pluginKey,
              pluginWithdrawalOperationId: operation.id,
              taskUpdateId: update.id,
              acceptedAt: now,
            })
            .returning()
            .then((rows) => rows[0] ?? null);
          if (!command) {
            throw new OrdinaryTaskRuntimeRejected(
              "Plugin withdrawal command was not persisted",
              "plugin_withdrawal_command_missing",
            );
          }
          return {
            kind: "accepted",
            operationId,
            task: withdrawn,
            escalationDispatchRefIds: revocation.escalationDispatchRefIds,
            cancellations: revocation.cancellations,
            retried: false,
          };
        },
      );
      if (outcome.kind === "rejected") {
        throw new OrdinaryTaskRuntimeRejected(outcome.message, outcome.reason);
      }
      if (outcome.cancellations) {
        await options.taskExecutionCancellation.reconcileRequestedCancellations(outcome.cancellations);
      }
      for (const refId of outcome.escalationDispatchRefIds) {
        await dispatch(refId);
      }
      return {
        operationId: outcome.operationId,
        task: outcome.task,
        retried: outcome.retried,
      };
    },
  };
}
