import { taskCreatorEdgeReceivability, taskUpdates, tasks, type Db } from "@paperclipai/db";
import { and, eq, sql } from "drizzle-orm";
import { persistActivityLog, publishCommittedActivity } from "./activity-log.js";
import { type PaperclipManagedAgentMessage } from "./paperclip-agent-message.js";
import {
  RuntimeTaskActionConflict,
  RuntimeTaskActionDenied,
  STATUSES,
  lockTaskSessionState,
  taskUpdateMessageActor,
  type AuthorizedRuntimeAction,
  type TaskRow,
} from "./runtime-task-action-port-shared-part-1.js";
import {
  authorityCompanyId,
  loadUpdateRetry,
  nextRunUpdateSequence,
  ownerGatewayInvocationId,
  ownerSourceIdentity,
  type CanonicalOwnerFormAuthority,
  type CanonicalOwnerFormUpdate,
} from "./runtime-task-action-port-shared-part-4.js";
import {
  admitCounterpartTaskUpdate,
  createTaskFormCommitRuntimeContext,
  lockReadyCompany,
} from "./runtime-task-action-port-shared-part-6.js";
import {
  assertLifecycleTransition,
  boardPresentationStatusFor,
  canonicalJson,
  deterministicUuid,
  lockOwnerUpdateRecipient,
  lockTaskMentionRecipient,
  terminalStatus,
} from "./runtime-task-action-port-shared-part-2.js";
import {
  assertTargetAdapterRevision,
  lockRuntimeToolAuthority,
} from "./runtime-task-action-port-shared-part-3.js";
import { taskUpdateActor, updateCounterpart } from "./runtime-task-action-port-shared-part-5.js";
import {
  applyTaskExecutionPolicyTransition,
  normalizeTaskExecutionPolicy,
  parseTaskExecutionState,
  taskExecutionPolicyPersistencePatch,
} from "./task-execution-policy.js";

export async function commitOwnerFormUpdateImplementation(
  context: ReturnType<typeof createTaskFormCommitRuntimeContext>,
  taskId: string,
  input: CanonicalOwnerFormUpdate,
  ownerAuthority: CanonicalOwnerFormAuthority,
) {
  const { db, options, clock, sessionAdmission } = context;
  if (!input.message.trim()) {
    throw new RuntimeTaskActionConflict("Owner-form task_update requires a non-empty message");
  }
  if (input.status !== undefined && !STATUSES.has(input.status)) {
    throw new RuntimeTaskActionConflict("Owner-form task_update status is invalid");
  }
  if (
    (input.status === undefined || !terminalStatus(input.status)) &&
    Object.hasOwn(input, "structuredResult")
  ) {
    throw new RuntimeTaskActionConflict("Nonterminal owner updates cannot carry structuredResult");
  }
  if (
    input.status !== undefined &&
    terminalStatus(input.status) &&
    Object.hasOwn(input, "structuredResult") &&
    input.structuredResult === undefined
  ) {
    throw new RuntimeTaskActionConflict("structuredResult must be omitted rather than undefined");
  }
  const companyId = authorityCompanyId(ownerAuthority);
  const gatewayInvocationId = ownerGatewayInvocationId(ownerAuthority);
  const disposition =
    input.status !== undefined && terminalStatus(input.status)
      ? {
          message: input.message,
          ...(Object.hasOwn(input, "structuredResult") ? { structuredResult: input.structuredResult } : {}),
        }
      : null;

  const committed = await db.transaction(async (tx) => {
    const now = clock();
    let task: TaskRow;
    let authorizedRuntime: AuthorizedRuntimeAction | null = null;
    if (ownerAuthority.kind === "agent-execution") {
      authorizedRuntime = await lockRuntimeToolAuthority(tx, ownerAuthority.capability, "task_update", now);
      if (
        taskId !== ownerAuthority.capability.taskId ||
        !ownerAuthority.capability.taskExecutionAuthorityId ||
        !authorizedRuntime.catalog.isCurrentOwner
      ) {
        throw new RuntimeTaskActionDenied(
          "Owner-form task_update requires the current owner authority",
          "owner_authority_invalid",
        );
      }
      task = authorizedRuntime.task;
    } else {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${companyId}:${taskId}`}, 0))`);
      await lockReadyCompany(tx, companyId);
      const locked = await tx
        .select()
        .from(tasks)
        .where(and(eq(tasks.companyId, companyId), eq(tasks.id, taskId)))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!locked || !locked.ownershipEpoch) {
        throw new RuntimeTaskActionDenied("Owner-form task target does not exist", "owner_target_missing");
      }
      task = locked;
    }

    const retry = await loadUpdateRetry(tx, companyId, gatewayInvocationId);
    const source = ownerSourceIdentity(ownerAuthority);
    if (retry) {
      if (
        retry.update.form !== "owner" ||
        retry.update.taskId !== taskId ||
        retry.update.sourceKind !== source.sourceKind ||
        retry.update.sourceAuthorityId !== source.sourceAuthorityId ||
        canonicalJson(retry.update.sourceIdentity) !== canonicalJson(source.sourceIdentity) ||
        retry.update.runId !== source.runId ||
        retry.update.message !== input.message ||
        retry.update.status !== (input.status ?? null) ||
        canonicalJson(retry.update.disposition) !== canonicalJson(disposition)
      ) {
        throw new RuntimeTaskActionConflict(
          "owner task_update invocation was retried with different immutable arguments",
        );
      }
      return { ...retry, task, cancellations: null, committedActivity: null };
    }

    const previousStatus = task.lifecycleStatus;
    if (terminalStatus(previousStatus) && ownerAuthority.kind !== "board") {
      throw new RuntimeTaskActionDenied(
        "Only Board task_update may continue a terminal task",
        "owner_authority_invalid",
      );
    }
    if (terminalStatus(previousStatus) && input.status === undefined) {
      throw new RuntimeTaskActionConflict("A terminal task update must continue the task");
    }
    if (input.status !== undefined) {
      assertLifecycleTransition(task.lifecycleStatus, input.status);
    }
    const executionPolicyTransition =
      input.status === undefined
        ? null
        : applyTaskExecutionPolicyTransition({
            task,
            policy: normalizeTaskExecutionPolicy(task.executionPolicy),
            requestedStatus: boardPresentationStatusFor(input.status),
            requestedOwnerPatch: {},
            actor:
              ownerAuthority.kind === "agent-execution"
                ? { agentId: ownerAuthority.capability.targetAgentId }
                : { userId: ownerAuthority.actorUserId },
            commentBody: input.message,
          });
    const executionPolicyPatch = executionPolicyTransition
      ? taskExecutionPolicyPersistencePatch(executionPolicyTransition.patch)
      : {};
    const nextExecutionState =
      executionPolicyTransition?.patch.executionState !== undefined
        ? parseTaskExecutionState(executionPolicyTransition.patch.executionState)
        : parseTaskExecutionState(task.executionState);
    const gated = input.status === "done" && nextExecutionState?.status === "pending";
    const edge = await tx
      .select()
      .from(taskCreatorEdgeReceivability)
      .where(
        and(
          eq(taskCreatorEdgeReceivability.companyId, companyId),
          eq(taskCreatorEdgeReceivability.taskId, task.id),
          eq(taskCreatorEdgeReceivability.ownershipEpoch, task.ownershipEpoch!),
        ),
      )
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!edge) {
      throw new RuntimeTaskActionConflict("Current ownership epoch has no eager creator edge");
    }
    if (
      ownerAuthority.kind === "board" &&
      ownerAuthority.recipient === "creator" &&
      (edge.endpointKind !== "agent-execution" || !edge.endpointId)
    ) {
      throw new RuntimeTaskActionDenied(
        "Task creator is not an invokable agent execution",
        "board_status_recipient_unavailable",
      );
    }
    const runSequence = source.runId === null ? 0 : await nextRunUpdateSequence(tx, companyId, source.runId);
    const updateId = deterministicUuid("task-update", gatewayInvocationId);
    const humanSessionState =
      ownerAuthority.kind === "agent-execution" ? null : await lockTaskSessionState(tx, companyId, task.id);
    if (ownerAuthority.kind !== "agent-execution" && !humanSessionState) {
      throw new RuntimeTaskActionConflict("Human owner-form target has no canonical Session");
    }
    const sourceSessionId =
      ownerAuthority.kind === "agent-execution"
        ? ownerAuthority.capability.sessionId
        : humanSessionState!.session.id;
    const target =
      ownerAuthority.kind === "board" && ownerAuthority.recipient === "owner"
        ? await lockTaskMentionRecipient(tx, companyId, task.id)
        : await lockOwnerUpdateRecipient(tx, companyId, task.id, edge);
    if (ownerAuthority.kind === "board" && target.kind !== "agent") {
      throw new RuntimeTaskActionDenied(
        "Selected status-update recipient is not an invokable agent",
        "board_status_recipient_unavailable",
      );
    }
    if (ownerAuthority.kind === "board" && target.kind === "agent") {
      const revisionId = await assertTargetAdapterRevision(tx, companyId, target.target.agentId);
      if (revisionId !== target.target.adapterConfigRevisionId) {
        throw new RuntimeTaskActionDenied(
          "Selected status-update recipient changed runtime configuration",
          "board_status_recipient_unavailable",
        );
      }
    }
    const effectiveStatus = input.status === undefined || gated ? previousStatus : input.status;
    const crossesTerminalBoundary = terminalStatus(previousStatus) !== terminalStatus(effectiveStatus);
    const cancellations = crossesTerminalBoundary
      ? await options.taskExecutionCancellation.requestScopeCancellationsInTransaction(tx, {
          companyId,
          taskId: task.id,
          selector: {
            kind: "ownership_epoch",
            ownershipEpoch: task.ownershipEpoch!,
          },
          reason:
            effectiveStatus === "cancelled"
              ? "task_cancelled"
              : effectiveStatus === "done"
                ? "task_completed"
                : "task_reactivated",
          actor:
            ownerAuthority.kind === "agent-execution"
              ? { kind: "agent", agentId: ownerAuthority.capability.targetAgentId }
              : { kind: "user", userId: ownerAuthority.actorUserId },
          now,
          nativeContinuity: "preserve_carry",
        })
      : null;
    const updateDelivery = {
      toolName: "task_update",
      body: input.message,
      ...(input.status === undefined ? {} : { requestedStatus: input.status }),
      context: {
        task,
        from: taskUpdateMessageActor(ownerAuthority, authorizedRuntime),
        sourceRole: "task owner",
        previousStatus,
        effectiveStatus,
        ...(gated ? { pendingReview: true } : {}),
      },
    } satisfies PaperclipManagedAgentMessage<"task_update">;
    const admission = await admitCounterpartTaskUpdate(sessionAdmission, tx, {
      companyId,
      sourceKind: "task_update",
      target,
      actor: taskUpdateActor(ownerAuthority),
      comment: source.comment,
      counterpart: updateCounterpart(ownerAuthority),
      sourceAgentTarget:
        ownerAuthority.kind === "agent-execution"
          ? {
              taskId: ownerAuthority.capability.taskId,
              agentId: ownerAuthority.capability.targetAgentId,
            }
          : null,
      immutableSourceKey: gatewayInvocationId,
      sourceRecordId: updateId,
      message: { kind: "managed", delivery: updateDelivery },
    });
    if (!admission.comment) {
      throw new RuntimeTaskActionConflict("Owner update projector did not create its comment-of-record");
    }
    const updatedTask =
      input.status === undefined
        ? await tx
            .select()
            .from(tasks)
            .where(
              and(
                eq(tasks.companyId, companyId),
                eq(tasks.id, task.id),
                eq(tasks.ownershipEpoch, task.ownershipEpoch!),
                eq(tasks.lifecycleStatus, previousStatus),
              ),
            )
            .limit(1)
            .then((rows) => rows[0] ?? null)
        : await tx
            .update(tasks)
            .set({
              ...executionPolicyPatch,
              lifecycleStatus: effectiveStatus,
              boardPresentationStatus:
                executionPolicyPatch.boardPresentationStatus ?? boardPresentationStatusFor(input.status),
              disposition: gated ? null : disposition,
              completedAt: effectiveStatus === "done" ? now : null,
              cancelledAt: effectiveStatus === "cancelled" ? now : null,
              updatedAt: now,
            })
            .where(
              and(
                eq(tasks.companyId, companyId),
                eq(tasks.id, task.id),
                eq(tasks.ownershipEpoch, task.ownershipEpoch!),
                eq(tasks.lifecycleStatus, previousStatus),
              ),
            )
            .returning()
            .then((rows) => rows[0] ?? null);
    if (!updatedTask) {
      throw new RuntimeTaskActionConflict("Task lifecycle changed during owner update");
    }
    const update = await tx
      .insert(taskUpdates)
      .values({
        id: updateId,
        companyId,
        taskId: task.id,
        sessionId: sourceSessionId,
        ownershipEpoch: task.ownershipEpoch!,
        form: "owner",
        sourceKind: source.sourceKind,
        sourceAuthorityId: source.sourceAuthorityId,
        sourceIdentity: source.sourceIdentity,
        runId: source.runId,
        gatewayInvocationId,
        runSequence,
        message: input.message,
        status: input.status ?? null,
        disposition,
        commentId: admission.comment.id,
        creatorEdgeId: edge.id,
        createdAt: now,
      })
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!update) {
      throw new RuntimeTaskActionConflict("Owner update ledger row was not persisted");
    }
    const committedActivity =
      ownerAuthority.kind === "board" && input.status !== undefined
        ? await persistActivityLog(
            tx as unknown as Db,
            {
              companyId,
              actorType: "user",
              actorId: ownerAuthority.actorUserId,
              action: "task.updated",
              entityType: "task",
              entityId: task.id,
              details: {
                contract: "board-task-status-update/v1",
                identifier: task.identifier,
                status: updatedTask.boardPresentationStatus,
                lifecycleStatus: updatedTask.lifecycleStatus,
                recipient: ownerAuthority.recipient,
                commentId: admission.comment.id,
                _previous: {
                  status: task.boardPresentationStatus,
                  lifecycleStatus: previousStatus,
                },
              },
            },
            {
              id: deterministicUuid("board-task-status-update-activity", gatewayInvocationId),
              createdAt: now,
            },
          )
        : null;
    return {
      task: updatedTask,
      update,
      comment: admission.comment,
      ref: admission.ref,
      cancellations,
      committedActivity,
      retried: false as const,
    };
  });
  if (committed.committedActivity) {
    publishCommittedActivity(committed.committedActivity);
  }
  if (committed.ref) {
    await options.dispatchPersistedRef(committed.ref.id);
  }
  if (committed.cancellations) {
    void options.taskExecutionCancellation
      .reconcileRequestedCancellations(committed.cancellations)
      .catch(() => {
        // The durable cancellation-intent reconciler retries this signal.
      });
  }
  const { cancellations: _, committedActivity: _committedActivity, ...result } = committed;
  return result;
}
