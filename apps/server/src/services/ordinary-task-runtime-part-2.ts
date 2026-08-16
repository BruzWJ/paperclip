import {
  authUsers,
  taskBoardReopenCommands,
  taskExecutionAuthorities,
  tasks,
  type Db,
  type taskExecutionRefs,
} from "@paperclipai/db";
import type { TaskBoardReopenDispatch } from "@paperclipai/shared";
import { and, eq, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { replayOrdinaryTaskBoardReopen } from "./ordinary-task-runtime-board-reopen-replay.js";
import { createOrdinaryTaskReassignmentCommitter } from "./ordinary-task-runtime-reassignment.js";
import * as runtime from "./ordinary-task-runtime-shared.js";
import { createTaskFormCommitRuntime } from "./runtime-task-action-port.js";
import { ensureSystemEscalationInTransaction } from "./system-escalation-postgres.js";
import { projectPersistedTaskExecutionRef } from "./task-execution-dispatcher-postgres.js";
import { createTaskSessionAdmissionService } from "./task-session/admission.js";
import type {
  OrdinaryTaskBoardReopenInput,
  OrdinaryTaskRuntimeOptions,
  SystemEscalationIdentityRow,
} from "./ordinary-task-runtime-shared-part-1.js";

export function createOrdinaryTaskRuntimePart2(db: Db, options: OrdinaryTaskRuntimeOptions) {
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
    async boardReopen(input: OrdinaryTaskBoardReopenInput) {
      const actorUserId = runtime.exactNonBlank(input.actorUserId, "actorUserId");
      const reason = runtime.nonBlankPreservingBytes(input.reason, "reason");
      const idempotencyKey = runtime.exactNonBlank(input.idempotencyKey, "idempotencyKey");
      const commandId = runtime.deterministicUuid(
        "board-reopen-command",
        `${input.companyId}:${idempotencyKey}`,
      );
      const identityDigest = createHash("sha256")
        .update(
          runtime.canonicalJson({
            contract: "ordinary-board-reopen/v2",
            companyId: input.companyId,
            taskId: input.taskId,
            actorUserId,
            reason,
            idempotencyKey,
          }),
        )
        .digest("hex");
      const result = await db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`${input.companyId}:board-reopen:${idempotencyKey}`}, 0))`,
        );
        const actor = await tx
          .select({ id: authUsers.id })
          .from(authUsers)
          .where(eq(authUsers.id, actorUserId))
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (!actor) {
          throw new runtime.OrdinaryTaskRuntimeRejected(
            "Board reopen requires an authenticated named board user",
            "board_reopen_actor_invalid",
          );
        }
        const priorCommands = await tx
          .select()
          .from(taskBoardReopenCommands)
          .where(
            and(
              eq(taskBoardReopenCommands.companyId, input.companyId),
              eq(taskBoardReopenCommands.idempotencyKey, idempotencyKey),
            ),
          )
          .limit(2)
          .for("update");
        if (priorCommands.length > 1) {
          throw new runtime.OrdinaryTaskRuntimeRejected(
            "Board reopen idempotency identity is ambiguous",
            "board_reopen_incomplete",
          );
        }
        const priorCommand = priorCommands[0] ?? null;
        if (priorCommand) {
          return replayOrdinaryTaskBoardReopen(tx, {
            input,
            priorCommand,
            actorUserId,
            reason,
            identityDigest,
            idempotencyKey,
          });
        }
        const task = await tx
          .select()
          .from(tasks)
          .where(and(eq(tasks.companyId, input.companyId), eq(tasks.id, input.taskId)))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (
          !task ||
          !Number.isInteger(task.ownershipEpoch) ||
          task.ownershipEpoch <= 0 ||
          (task.lifecycleStatus !== "done" && task.lifecycleStatus !== "cancelled") ||
          !task.disposition
        ) {
          throw new runtime.OrdinaryTaskRuntimeRejected(
            "Board reopen requires a terminal task with a disposition",
            "board_reopen_target_invalid",
          );
        }
        const ownershipEpoch = task.ownershipEpoch as number;
        const priorStatus = task.lifecycleStatus as "done" | "cancelled";
        const priorDisposition = task.disposition!;
        const sessionState = await runtime.lockTaskSessionState(tx, input.companyId, task.id);
        if (!sessionState) {
          throw new runtime.OrdinaryTaskRuntimeRejected(
            "Board reopen target Session is lifecycle-fenced",
            "board_reopen_session_invalid",
          );
        }
        const checkedSessionState = sessionState!;
        if (
          checkedSessionState.session.integrityState !== "ready" ||
          checkedSessionState.session.timeArchived !== null ||
          checkedSessionState.session.purgeFencedAt !== null
        ) {
          throw new runtime.OrdinaryTaskRuntimeRejected(
            "Board reopen target Session is lifecycle-fenced",
            "board_reopen_session_invalid",
          );
        }
        const { session, contextGeneration } = checkedSessionState;
        const existingEdge = await runtime.lockReopenCreatorEdge(tx, task);
        const endpointState = await runtime.inspectCreatorEndpoint(tx, task);
        let branch: "agent_execution" | "board_only";
        let preservedOwnerKind: "agent" | "user" | "board";
        let authority: typeof taskExecutionAuthorities.$inferSelect | null = null;
        let revisionId: string | null = null;
        let ownerAgentId: string | null = null;
        let escalationIdentity: SystemEscalationIdentityRow | null = null;
        if (task.ownerKind === "agent" && task.ownerAgentId) {
          const lockedOwnerAgentId = task.ownerAgentId!;
          const resolution = await runtime.resolveOrdinaryTaskOwner(tx, input.companyId, lockedOwnerAgentId);
          const authorities = await tx
            .select()
            .from(taskExecutionAuthorities)
            .where(
              and(
                eq(taskExecutionAuthorities.companyId, input.companyId),
                eq(taskExecutionAuthorities.taskId, task.id),
                eq(taskExecutionAuthorities.ownershipEpoch, ownershipEpoch),
                eq(taskExecutionAuthorities.agentId, lockedOwnerAgentId),
                eq(taskExecutionAuthorities.state, "current"),
              ),
            )
            .limit(2)
            .for("update");
          if (authorities.length !== 1 || authorities[0]!.sessionId !== session.id) {
            throw new runtime.OrdinaryTaskRuntimeRejected(
              "Board reopen owner authority is missing",
              "board_reopen_authority_missing",
            );
          }
          branch = "agent_execution";
          preservedOwnerKind = "agent";
          authority = authorities[0]!;
          revisionId = resolution.revisionId;
          ownerAgentId = task.ownerAgentId;
        } else if (task.ownerKind === "user" && task.ownerAssignmentSource === "user_creator_withdrawal") {
          throw new runtime.OrdinaryTaskRuntimeRejected(
            "A named-user creator withdrawal cannot be reopened",
            "board_reopen_target_invalid",
          );
        } else if ((task.ownerKind === "user" && task.ownerUserId) || task.ownerKind === "board") {
          if (task.ownerAssignmentSource !== null || task.creatorKind !== "system") {
            throw new runtime.OrdinaryTaskRuntimeRejected(
              "Only a valid named-user or collective-board system escalation reopens without execution",
              "board_reopen_target_invalid",
            );
          }
          escalationIdentity = await runtime.lockSystemEscalationReopenIdentity(tx, task);
          branch = "board_only";
          preservedOwnerKind = task.ownerKind;
        } else {
          throw new runtime.OrdinaryTaskRuntimeRejected(
            "Board reopen owner is outside the two canonical branches",
            "board_reopen_target_invalid",
          );
        }
        const now = clock();
        const cancellations = await options.taskExecutionCancellation.requestScopeCancellationsInTransaction(
          tx,
          {
            companyId: input.companyId,
            taskId: task.id,
            selector: {
              kind: "ownership_epoch",
              ownershipEpoch,
            },
            reason: "board_reopen_continuity_fence",
            actor: { kind: "user", userId: actorUserId },
            now,
          },
        );
        const continuityFenceGeneration = await runtime.applyBoardReopenContinuityFence(tx, {
          companyId: input.companyId,
          taskId: task.id,
          ownershipEpoch,
          at: now,
        });
        const reopened = await tx
          .update(tasks)
          .set({
            lifecycleStatus: "open",
            disposition: null,
            completedAt: null,
            cancelledAt: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(tasks.companyId, input.companyId),
              eq(tasks.id, task.id),
              eq(tasks.ownershipEpoch, ownershipEpoch),
              eq(tasks.lifecycleStatus, priorStatus),
            ),
          )
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!reopened) {
          throw new runtime.OrdinaryTaskRuntimeRejected(
            "Task changed while reopening",
            "board_reopen_lifecycle_conflict",
          );
        }
        const edge = await runtime.ensureReopenCreatorEdge(tx, {
          task: reopened,
          sessionId: session.id,
          existing: existingEdge,
          endpointState,
          commandId,
          actorUserId,
          reason,
          now,
        });
        let executionRef: typeof taskExecutionRefs.$inferSelect | null = null;
        if (branch === "agent_execution") {
          if (!authority || !revisionId || !ownerAgentId) {
            throw new runtime.OrdinaryTaskRuntimeRejected(
              "Agent board reopen lost its locked owner authority",
              "board_reopen_authority_missing",
            );
          }
          const checkedAuthority = authority!;
          const checkedRevisionId = revisionId!;
          const checkedOwnerAgentId = ownerAgentId!;
          const sourceKey = `board-reopen:${input.companyId}:${idempotencyKey}`;
          const admission = await sessions.admitExecutionSource(
            {
              companyId: input.companyId,
              taskId: task.id,
              sessionId: session.id,
              ownershipEpoch,
              targetAgentId: checkedOwnerAgentId,
              taskExecutionAuthorityId: checkedAuthority.id,
              consultExecutionId: null,
              adapterConfigRevisionId: checkedRevisionId,
              contextEpoch: contextGeneration,
              mode: "owner",
              sourceKind: "task_reopen",
              actor: { kind: "user/board", userId: actorUserId },
              immutableSourceKey: sourceKey,
              sourceRecordId: commandId,
              exactText: task.request,
              comment: {
                author: { kind: "user", userId: actorUserId },
                producingRun: null,
                body: task.request,
              },
              idempotencyKey: sourceKey,
            },
            tx,
          );
          if (!admission.ref) {
            throw new runtime.OrdinaryTaskRuntimeRejected(
              "Board reopen did not persist an execution ref",
              "board_reopen_ref_missing",
            );
          }
          executionRef = admission.ref;
        }
        const command = await tx
          .insert(taskBoardReopenCommands)
          .values({
            id: commandId,
            companyId: input.companyId,
            taskId: task.id,
            actorUserId,
            reason,
            idempotencyKey,
            identityDigest,
            priorStatus,
            priorDisposition,
            ownershipEpoch,
            branch,
            preservedOwnerKind,
            continuityFenceGeneration,
            creatorEdgeId: edge.id,
            executionRefId: executionRef?.id ?? null,
            systemEscalationIdentityId: escalationIdentity?.id ?? null,
            createdAt: now,
          })
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!command) {
          throw new runtime.OrdinaryTaskRuntimeRejected(
            "Board reopen audit command was not persisted",
            "board_reopen_audit_missing",
          );
        }
        const escalation =
          edge.state === "terminal" && reopened.creatorKind !== "system"
            ? await ensureSystemEscalationInTransaction(
                tx,
                sessions,
                {
                  companyId: input.companyId,
                  affectedTaskId: reopened.id,
                  affectedOwnershipEpoch: reopened.ownershipEpoch,
                  terminalCreatorEdgeId: edge.id,
                  systemSource: "recovery",
                  triggeringRunId: null,
                  causalSourceId: command.id,
                },
                clock,
              )
            : null;
        if (branch === "agent_execution") {
          if (!executionRef) {
            throw new runtime.OrdinaryTaskRuntimeRejected(
              "Agent board reopen lost its checked execution ref",
              "board_reopen_ref_missing",
            );
          }
          const checkedExecutionRef = executionRef!;
          return {
            task: reopened,
            edge,
            command,
            dispatch: {
              kind: "agent_execution",
              executionRef: projectPersistedTaskExecutionRef(checkedExecutionRef),
            } satisfies TaskBoardReopenDispatch,
            escalationDispatchRefId: escalation?.dispatchRefId ?? null,
            cancellations,
            retried: false as const,
          };
        }
        return {
          task: reopened,
          edge,
          command,
          dispatch: { kind: "board_only" } satisfies TaskBoardReopenDispatch,
          escalationDispatchRefId: escalation?.dispatchRefId ?? null,
          cancellations,
          retried: false as const,
        };
      });
      if (result.cancellations) {
        void options.taskExecutionCancellation
          .reconcileRequestedCancellations(result.cancellations)
          .catch(() => {
            // The committed lifecycle fence keeps the prior refs ineligible.
          });
      }
      if (result.dispatch.kind === "agent_execution") {
        await dispatch(result.dispatch.executionRef.id);
      }
      if (result.escalationDispatchRefId) {
        await dispatch(result.escalationDispatchRefId);
      }
      const { escalationDispatchRefId: _, cancellations: __, ...publicResult } = result;
      return publicResult;
    },
  };
}
