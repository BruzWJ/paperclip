import { taskCreatorEdgeReceivability, taskUpdates, tasks } from "@paperclipai/db";
import { and, eq, inArray, sql } from "drizzle-orm";
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
  assertTaskNonterminal,
  boardPresentationStatusFor,
  canonicalJson,
  deterministicUuid,
  lockOwnerUpdateRecipient,
  terminalStatus,
} from "./runtime-task-action-port-shared-part-2.js";
import { lockRuntimeToolAuthority } from "./runtime-task-action-port-shared-part-3.js";
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
  if (
    ownerAuthority.kind === "user-creator-withdrawal" &&
    (input.status !== "cancelled" || Object.hasOwn(input, "structuredResult"))
  ) {
    throw new RuntimeTaskActionDenied(
      "A named-user withdrawal owner may only cancel with a message",
      "user_withdrawal_cancel_only",
    );
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
      authorizedRuntime = await lockRuntimeToolAuthority(
        tx,
        ownerAuthority.capability,
        "task_update",
        now,
      );
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
      const escalationOwner =
        locked.creatorKind === "system" &&
        locked.escalatedFromAffectedTaskId !== null &&
        ((locked.ownerKind === "user" && locked.ownerUserId === ownerAuthority.actorUserId) ||
          locked.ownerKind === "board");
      const withdrawalOwner =
        locked.creatorKind === "user/board" &&
        locked.creatorUserId === ownerAuthority.actorUserId &&
        locked.ownerKind === "user" &&
        locked.ownerUserId === ownerAuthority.actorUserId &&
        locked.ownerAssignmentSource === "user_creator_withdrawal";
      if (
        (ownerAuthority.kind === "system-escalation-human" && !escalationOwner) ||
        (ownerAuthority.kind === "user-creator-withdrawal" && !withdrawalOwner)
      ) {
        throw new RuntimeTaskActionDenied(
          "Authenticated user is not the documented human owner",
          "owner_authority_invalid",
        );
      }
      // A named Board principal is already authenticated at ingress and is
      // the control-plane owner. It intentionally does not inherit either
      // narrow human-form relationship check above.
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
      return { ...retry, cancellations: null };
    }

    assertTaskNonterminal(task);
    const previousStatus = task.lifecycleStatus;
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
    const target = await lockOwnerUpdateRecipient(tx, companyId, task, edge);
    const updateDelivery = {
      toolName: "task_update",
      body: input.message,
      ...(input.status === undefined ? {} : { requestedStatus: input.status }),
      context: {
        task,
        from: taskUpdateMessageActor(ownerAuthority, authorizedRuntime),
        sourceRole: "task owner",
        previousStatus,
        effectiveStatus: input.status === undefined || gated ? previousStatus : input.status,
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
                inArray(tasks.lifecycleStatus, ["open", "blocked"]),
              ),
            )
            .limit(1)
            .then((rows) => rows[0] ?? null)
        : await tx
            .update(tasks)
            .set({
              ...executionPolicyPatch,
              lifecycleStatus: gated ? task.lifecycleStatus : input.status,
              boardPresentationStatus:
                executionPolicyPatch.boardPresentationStatus ?? boardPresentationStatusFor(input.status),
              disposition: gated ? null : disposition,
              completedAt: !gated && input.status === "done" ? now : null,
              cancelledAt: !gated && input.status === "cancelled" ? now : null,
              updatedAt: now,
            })
            .where(
              and(
                eq(tasks.companyId, companyId),
                eq(tasks.id, task.id),
                eq(tasks.ownershipEpoch, task.ownershipEpoch!),
                inArray(tasks.lifecycleStatus, ["open", "blocked"]),
              ),
            )
            .returning()
            .then((rows) => rows[0] ?? null);
    if (!updatedTask) {
      throw new RuntimeTaskActionConflict("Task lifecycle changed during owner update");
    }
    const cancellations =
      !gated && input.status === "cancelled"
        ? await options.taskExecutionCancellation.requestScopeCancellationsInTransaction(tx, {
            companyId,
            taskId: task.id,
            selector: {
              kind: "ownership_epoch",
              ownershipEpoch: task.ownershipEpoch!,
            },
            reason: "task_cancelled",
            actor:
              ownerAuthority.kind === "agent-execution"
                ? {
                    kind: "agent",
                    agentId: ownerAuthority.capability.targetAgentId,
                  }
                : {
                    kind: "user",
                    userId: ownerAuthority.actorUserId,
                  },
            now,
          })
        : null;
    return {
      task: updatedTask,
      update,
      comment: admission.comment,
      ref: admission.ref,
      gated,
      cancellations,
      retried: false as const,
    };
  });
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
  const { cancellations: _, ...result } = committed;
  return result;
}
