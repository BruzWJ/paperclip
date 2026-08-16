import {
  taskExecutionAuthorities,
  taskExecutionRefs,
  taskSessionEvents,
  tasks,
  type Db,
} from "@paperclipai/db";
import { and, eq, sql } from "drizzle-orm";
import { reserveTaskExecutionWorkspaceBinding } from "./execution-workspaces.js";
import { paperclipEnvelopeHasBody } from "./paperclip-agent-message.js";
import { promptCapabilityGenerationIdentity } from "./prompt-capability-gateway.js";
import * as taskAction from "./runtime-task-action-port-shared.js";
import { createTaskSessionAdmissionService } from "./task-session/admission.js";
import type {
  CanonicalCreatorFormUpdate,
  CanonicalOwnerFormUpdate,
  PostgresRuntimeTaskActionServiceOptions,
  RuntimeTaskActionService,
} from "./runtime-task-action-port.js";

export function createPostgresRuntimeTaskActionServicePart2(
  db: Db,
  options: PostgresRuntimeTaskActionServiceOptions,
) {
  const clock = options.clock ?? (() => new Date());
  const sessionAdmission = createTaskSessionAdmissionService(db, { clock });
  const taskForms = taskAction.createTaskFormCommitRuntime(db, {
    clock,
    dispatchPersistedRef: options.dispatchPersistedRef,
    taskExecutionCancellation: options.taskExecutionCancellation,
  });

  return {
    async assign(input) {
      const committed = await db.transaction(async (tx) => {
        const now = clock();
        const authorized = await taskAction.lockRuntimeActionAuthority(
          tx,
          input.capability,
          "task_assign",
          now,
          { requireOwner: true },
        );
        if (!input.capability.taskExecutionAuthorityId) {
          throw new taskAction.RuntimeTaskActionDenied(
            "task_assign requires the caller's stable creator authority",
            "execution_authority_invalid",
          );
        }
        await tx.execute(
          sql`select ${tasks.id} from ${tasks} where ${tasks.id} = ${input.taskId} and ${tasks.companyId} = ${input.capability.companyId} for update`,
        );
        const targetTask = await tx
          .select()
          .from(tasks)
          .where(and(eq(tasks.companyId, input.capability.companyId), eq(tasks.id, input.taskId)))
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (!targetTask || !targetTask.ownershipEpoch) {
          throw new taskAction.RuntimeTaskActionDenied(
            "Target task does not exist in the caller's company",
            "target_task_missing",
          );
        }
        const targetSessionState = await taskAction.lockTaskSessionState(
          tx,
          input.capability.companyId,
          input.taskId,
        );
        if (!targetSessionState) {
          throw new taskAction.RuntimeTaskActionConflict("Target task has no canonical Session");
        }
        const { session: targetSession } = targetSessionState;
        const key = taskAction.runtimeInvocationKey(
          "assign",
          promptCapabilityGenerationIdentity(input.capability),
          input.invocationId,
        );
        const requestedOwnerId = taskAction.ownerAgentId(input.owner, input.capability.targetAgentId);
        const priorEvent = await tx
          .select()
          .from(taskSessionEvents)
          .where(
            and(
              eq(taskSessionEvents.sessionId, targetSession.id),
              eq(taskSessionEvents.sourceKind, "task_reassignment"),
              eq(taskSessionEvents.immutableSourceKey, key),
            ),
          )
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (priorEvent) {
          const priorRef = await tx
            .select()
            .from(taskExecutionRefs)
            .where(
              and(
                eq(taskExecutionRefs.sessionId, targetSession.id),
                eq(taskExecutionRefs.sourceId, priorEvent.sourceId!),
              ),
            )
            .limit(1)
            .then((rows) => rows[0] ?? null);
          if (
            priorEvent.sourceRecordId !== targetTask.id ||
            priorEvent.data === null ||
            !priorRef ||
            priorRef.targetAgentId !== requestedOwnerId ||
            !paperclipEnvelopeHasBody(
              priorRef.exactMessage,
              "[Paperclip task assignment]",
              targetTask.request,
            )
          ) {
            throw new taskAction.RuntimeTaskActionConflict(
              "task_assign invocation was retried with different immutable arguments",
            );
          }
          return {
            task: targetTask,
            authorityId: priorRef.taskExecutionAuthorityId,
            ref: priorRef,
            escalationDispatchRefIds: [] as string[],
            cancellations: null,
            retried: true,
          };
        }

        const targetAgentId = taskAction.assertAssignOwnerCatalog(authorized, input.taskId, input.owner);
        taskAction.assertTaskNonterminal(targetTask);
        if (
          targetTask.parentId !== input.capability.taskId ||
          targetTask.creatorKind !== "agent-execution" ||
          targetTask.creatorAuthorityId !== input.capability.taskExecutionAuthorityId ||
          targetTask.ownerKind !== "agent" ||
          !targetTask.ownerAgentId ||
          !targetTask.request
        ) {
          throw new taskAction.RuntimeTaskActionDenied(
            "Target is not an exact direct task of this creator execution",
            "creator_authority_mismatch",
          );
        }
        if (
          targetSession.integrityState !== "ready" ||
          targetSession.refAdmittableAt === null ||
          targetSession.timeArchived !== null ||
          targetSession.purgeFencedAt !== null
        ) {
          throw new taskAction.RuntimeTaskActionConflict("Target task Session is lifecycle-fenced");
        }
        const targetRevisionId = await taskAction.assertTargetAdapterRevision(
          tx,
          input.capability.companyId,
          targetAgentId,
        );
        const outgoingAuthority = await tx
          .select()
          .from(taskExecutionAuthorities)
          .where(
            and(
              eq(taskExecutionAuthorities.companyId, input.capability.companyId),
              eq(taskExecutionAuthorities.taskId, targetTask.id),
              eq(taskExecutionAuthorities.ownershipEpoch, targetTask.ownershipEpoch),
              eq(taskExecutionAuthorities.agentId, targetTask.ownerAgentId),
              eq(taskExecutionAuthorities.state, "current"),
            ),
          )
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!outgoingAuthority) {
          throw new taskAction.RuntimeTaskActionConflict(
            "Target task has no current outgoing owner authority",
          );
        }
        const revocation = await taskAction.revokeOutgoingOwnershipEpoch(
          tx,
          sessionAdmission,
          options.taskExecutionCancellation,
          {
            companyId: input.capability.companyId,
            taskId: targetTask.id,
            sessionId: targetSession.id,
            ownershipEpoch: targetTask.ownershipEpoch,
            authorityId: outgoingAuthority.id,
            sourceAuthorityId: input.capability.taskExecutionAuthorityId,
            triggeringRunId: input.capability.runId,
            cancellationActor: {
              kind: "agent",
              agentId: input.capability.targetAgentId,
            },
            now,
          },
        );

        const ownershipEpoch = targetTask.ownershipEpoch + 1;
        const authorityId = taskAction.deterministicUuid(
          "task-execution-authority",
          `${targetTask.id}:${ownershipEpoch}:${targetAgentId}`,
        );
        const reassigned = await tx
          .update(tasks)
          .set({
            ownerKind: "agent",
            ownerAgentId: targetAgentId,
            ownerUserId: null,
            ownerAssignmentSource: null,
            ownershipEpoch,
            updatedAt: now,
          })
          .where(
            and(
              eq(tasks.companyId, input.capability.companyId),
              eq(tasks.id, targetTask.id),
              eq(tasks.ownershipEpoch, targetTask.ownershipEpoch),
            ),
          )
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!reassigned) {
          throw new taskAction.RuntimeTaskActionConflict(
            "Target ownership epoch changed during reassignment",
          );
        }
        const workspaceReservation = await taskAction.withRuntimeWorkspaceReservationErrors(() =>
          reserveTaskExecutionWorkspaceBinding(tx, {
            task: reassigned,
            session: {
              id: targetSession.id,
              now,
            },
            provenance: {
              agentId: input.capability.targetAgentId,
              userId: null,
            },
          }),
        );
        await tx.insert(taskExecutionAuthorities).values({
          id: authorityId,
          companyId: reassigned.companyId,
          taskId: reassigned.id,
          sessionId: targetSession.id,
          ownershipEpoch,
          agentId: targetAgentId,
          auditAdapterConfigRevisionId: targetRevisionId,
          state: "current",
          createdAt: now,
        });
        const edge = await taskAction.insertCreatorEdge(tx, reassigned, now);
        const recipient = taskAction.messageAgent(authorized.companyAgents, targetAgentId);
        const admission = await taskAction.admitManagedAgentMessageInTransaction(sessionAdmission, tx, {
          companyId: reassigned.companyId,
          taskId: reassigned.id,
          sessionId: targetSession.id,
          ownershipEpoch,
          targetAgentId,
          taskExecutionAuthorityId: authorityId,
          consultExecutionId: null,
          adapterConfigRevisionId: targetRevisionId,
          contextEpoch: workspaceReservation.contextEpochGeneration,
          mode: "owner",
          counterpartTaskId: input.capability.taskId,
          counterpartAuthorityId: input.capability.taskExecutionAuthorityId,
          counterpartOwnershipEpoch: input.capability.ownershipEpoch,
          sourceKind: "task_reassignment",
          actor: taskAction.executionActorForCapability(input.capability),
          previousOwnershipEpoch: targetTask.ownershipEpoch,
          immutableSourceKey: key,
          sourceRecordId: reassigned.id,
          recipient,
          delivery: {
            toolName: "task_assign",
            body: reassigned.request!,
            context: {
              task: reassigned,
              from: taskAction.messageAgent(authorized.companyAgents, input.capability.targetAgentId),
              status: targetTask.lifecycleStatus,
            },
          },
          comment: {
            author: {
              kind: "agent",
              agentId: input.capability.targetAgentId,
            },
            producingRun: {
              runId: input.capability.runId,
              adapterConfigRevisionId: input.capability.adapterConfigIdentity,
            },
          },
          idempotencyKey: key,
        });
        if (!admission.ref) {
          throw new taskAction.RuntimeTaskActionConflict("task_assign did not reserve the new owner ref");
        }
        return {
          task: reassigned,
          authorityId,
          creatorEdgeId: edge.id,
          ref: admission.ref,
          comment: admission.comment,
          escalationDispatchRefIds: revocation.escalationDispatchRefIds,
          cancellations: revocation.cancellations,
          retried: false,
        };
      });
      if (committed.cancellations) {
        await options.taskExecutionCancellation.reconcileRequestedCancellations(committed.cancellations);
      }
      for (const refId of committed.escalationDispatchRefIds) {
        await options.dispatchPersistedRef(refId);
      }
      await options.dispatchPersistedRef(committed.ref.id);
      return committed;
    },
    async update(input) {
      const authority = {
        kind: "agent-execution" as const,
        capability: input.capability,
        invocationId: input.invocationId,
      };
      // `taskId` is deliberately a relationship selector, not a generic
      // task mutation target. The underlying creator form re-proves exact
      // parent/creator authority in the same transaction.
      if (input.taskId === undefined) {
        const ownerUpdate = {
          message: input.message,
          ...(input.status === undefined ? {} : { status: input.status }),
          ...(Object.hasOwn(input, "structuredResult") ? { structuredResult: input.structuredResult } : {}),
        } as CanonicalOwnerFormUpdate;
        return taskForms.commitOwnerFormUpdate(input.capability.taskId, ownerUpdate, authority);
      }
      const creatorUpdate = {
        message: input.message,
        ...(input.status === undefined ? {} : { status: input.status }),
      } as CanonicalCreatorFormUpdate;
      return taskForms.commitCreatorFormUpdate(input.taskId, creatorUpdate, authority);
    },
    async mentionBoard(input) {
      const key = taskAction.runtimeInvocationKey(
        "mention-board",
        promptCapabilityGenerationIdentity(input.capability),
        input.invocationId,
      );
      const committed = await db.transaction(async (tx) => {
        const now = clock();
        await taskAction.lockRuntimeActionAuthority(tx, input.capability, "mention_board", now, {
          requireOwner: false,
        });
        const admission = await taskAction.mentionBoardInTransaction(sessionAdmission, tx, {
          companyId: input.capability.companyId,
          target: {
            taskId: input.capability.taskId,
            sessionId: input.capability.sessionId,
            ownershipEpoch: input.capability.ownershipEpoch,
          },
          actor: taskAction.executionActorForCapability(input.capability),
          comment: {
            author: {
              kind: "agent",
              agentId: input.capability.targetAgentId,
            },
            producingRun: {
              runId: input.capability.runId,
              adapterConfigRevisionId: input.capability.adapterConfigIdentity,
            },
          },
          sourceKind: "mention_board",
          immutableSourceKey: key,
          sourceRecordId: taskAction.deterministicUuid("task-board-mention", key),
          message: input.message,
        });
        return input.commitMentionAction(tx, {
          accepted: true,
          id: admission.boardMention.id,
          commentId: admission.boardMention.commentId,
          retried: admission.retried,
        });
      });
      return committed;
    },
  } satisfies Partial<RuntimeTaskActionService>;
}
