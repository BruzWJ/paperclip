import { routineRuns, routines, taskCreatorEdgeReceivability, taskUpdates, tasks } from "@paperclipai/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { type PaperclipManagedAgentMessage } from "./paperclip-agent-message.js";
import { resolvePluginPermittedTaskOwnerCatalogInTransaction } from "./plugin-task-authorization.js";
import {
  RuntimeTaskActionConflict,
  RuntimeTaskActionDenied,
  STATUSES,
  lockTaskSessionState,
  taskUpdateMessageActor,
  type AuthorizedRuntimeAction,
} from "./runtime-task-action-port-shared-part-1.js";
import {
  authorityCompanyId,
  creatorEndpoint,
  creatorGatewayInvocationId,
  loadUpdateRetry,
  nextRunUpdateSequence,
  type CanonicalCreatorFormAuthority,
  type CanonicalCreatorFormUpdate,
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
  lockTaskMentionRecipient,
  terminalStatus,
} from "./runtime-task-action-port-shared-part-2.js";
import {
  creatorSourceIdentity,
  taskUpdateActor,
  updateCounterpart,
} from "./runtime-task-action-port-shared-part-5.js";
import { lockRuntimeToolAuthority } from "./runtime-task-action-port-shared-part-3.js";
import {
  applyTaskExecutionPolicyTransition,
  normalizeTaskExecutionPolicy,
  taskExecutionPolicyPersistencePatch,
} from "./task-execution-policy.js";

export async function commitCreatorFormUpdateImplementation(
  context: ReturnType<typeof createTaskFormCommitRuntimeContext>,
  taskId: string,
  input: string | CanonicalCreatorFormUpdate,
  creatorAuthority: CanonicalCreatorFormAuthority,
) {
  const { db, options, clock, sessionAdmission } = context;
  const updateInput: CanonicalCreatorFormUpdate = typeof input === "string" ? { message: input } : input;
  const { message } = updateInput;
  if (!message.trim()) {
    throw new RuntimeTaskActionConflict("Creator-form task_update requires a non-empty message");
  }
  if (updateInput.status !== undefined && !STATUSES.has(updateInput.status)) {
    throw new RuntimeTaskActionConflict("Creator-form task_update status is invalid");
  }
  if (Object.hasOwn(updateInput, "structuredResult")) {
    throw new RuntimeTaskActionConflict("Creator task_update cannot carry structuredResult");
  }
  if (updateInput.status !== undefined && terminalStatus(updateInput.status)) {
    throw new RuntimeTaskActionDenied(
      "Terminal done or cancelled updates require current-owner authority",
      "creator_terminal_status_forbidden",
    );
  }
  if (updateInput.status !== undefined && creatorAuthority.kind !== "agent-execution") {
    throw new RuntimeTaskActionDenied(
      "Only an exact agent execution creator may transition task lifecycle",
      "creator_lifecycle_agent_execution_required",
    );
  }
  const disposition = null;
  const companyId = authorityCompanyId(creatorAuthority);
  const gatewayInvocationId = creatorGatewayInvocationId(creatorAuthority);
  const committed = await db.transaction(async (tx) => {
    const now = clock();
    let authorizedRuntime: AuthorizedRuntimeAction | null = null;
    if (creatorAuthority.kind === "agent-execution") {
      authorizedRuntime = await lockRuntimeToolAuthority(
        tx,
        creatorAuthority.capability,
        "task_update",
        now,
      );
      if (!creatorAuthority.capability.taskExecutionAuthorityId) {
        throw new RuntimeTaskActionDenied(
          "Creator-form update requires a stable creator execution",
          "execution_authority_invalid",
        );
      }
      if (!authorizedRuntime.catalog.creatorUpdateTargets.some((candidate) => candidate.taskId === taskId)) {
        throw new RuntimeTaskActionDenied(
          "Target is no longer in the caller's creator-update catalog",
          "creator_catalog_changed",
        );
      }
    } else {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${companyId}:${taskId}`}, 0))`);
      if (creatorAuthority.kind === "plugin") {
        await resolvePluginPermittedTaskOwnerCatalogInTransaction(tx, {
          companyId,
          pluginInstallationId: creatorAuthority.pluginInstallationId,
          pluginKey: creatorAuthority.pluginKey,
          operation: "tasks.update",
        });
      } else if (creatorAuthority.kind === "routine") {
        const routine = await tx
          .select()
          .from(routines)
          .where(and(eq(routines.companyId, companyId), eq(routines.id, creatorAuthority.routineId)))
          .for("update")
          .then((rows) => rows[0] ?? null);
        const hook = await tx
          .select()
          .from(routineRuns)
          .where(
            and(
              eq(routineRuns.companyId, companyId),
              eq(routineRuns.id, creatorAuthority.routineDispatchId),
              eq(routineRuns.routineId, creatorAuthority.routineId),
            ),
          )
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!routine || routine.status !== "active" || !hook) {
          throw new RuntimeTaskActionDenied(
            "Routine creator hook is not active",
            "creator_authority_mismatch",
          );
        }
      }
      await lockReadyCompany(tx, companyId);
    }

    await tx.execute(
      sql`select ${tasks.id} from ${tasks} where ${tasks.id} = ${taskId} and ${tasks.companyId} = ${companyId} for update`,
    );
    const task = await tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.companyId, companyId), eq(tasks.id, taskId)))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!task || !task.ownershipEpoch) {
      throw new RuntimeTaskActionDenied("Creator-update target no longer exists", "target_task_missing");
    }
    const creatorMatches = (() => {
      switch (creatorAuthority.kind) {
        case "agent-execution":
          return (
            task.parentId === creatorAuthority.capability.taskId &&
            task.creatorKind === "agent-execution" &&
            task.creatorAuthorityId === creatorAuthority.capability.taskExecutionAuthorityId
          );
        case "plugin":
          return (
            task.creatorKind === "plugin" &&
            task.creatorPluginInstallationId === creatorAuthority.pluginInstallationId &&
            task.creatorPluginKey === creatorAuthority.pluginKey
          );
        case "routine":
          return (
            task.creatorKind === "routine" &&
            task.creatorRoutineId === creatorAuthority.routineId &&
            task.creatorRoutineDispatchId === creatorAuthority.routineDispatchId
          );
        case "system":
          return (
            task.creatorKind === "system" &&
            task.creatorSystemSourceKind === creatorAuthority.sourceKind &&
            task.creatorSystemSourceId === creatorAuthority.sourceId
          );
      }
    })();
    if (!creatorMatches) {
      throw new RuntimeTaskActionDenied(
        "Creator-update authority does not match the immutable target creator",
        "creator_authority_mismatch",
      );
    }
    if (creatorAuthority.kind === "routine") {
      const hook = await tx
        .select({ linkedTaskId: routineRuns.linkedTaskId })
        .from(routineRuns)
        .where(eq(routineRuns.id, creatorAuthority.routineDispatchId))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (hook?.linkedTaskId !== task.id) {
        throw new RuntimeTaskActionDenied(
          "Routine creator hook does not target this task",
          "creator_authority_mismatch",
        );
      }
    }
    const sessionState = await lockTaskSessionState(tx, companyId, task.id);
    if (!sessionState) {
      throw new RuntimeTaskActionConflict("Creator-update target has no canonical Session");
    }
    const edge = await tx
      .select()
      .from(taskCreatorEdgeReceivability)
      .where(
        and(
          eq(taskCreatorEdgeReceivability.companyId, companyId),
          eq(taskCreatorEdgeReceivability.taskId, task.id),
          eq(taskCreatorEdgeReceivability.ownershipEpoch, task.ownershipEpoch),
          eq(taskCreatorEdgeReceivability.state, "receivable"),
        ),
      )
      .for("update")
      .then((rows) => rows[0] ?? null);
    const expectedEndpoint = creatorEndpoint(task);
    if (
      !edge ||
      edge.endpointKind !== expectedEndpoint.endpointKind ||
      edge.endpointId !== expectedEndpoint.endpointId ||
      canonicalJson(edge.endpointSnapshot) !== canonicalJson(expectedEndpoint.endpointSnapshot)
    ) {
      throw new RuntimeTaskActionDenied(
        "Immutable creator edge is no longer receivable",
        "creator_edge_terminal",
      );
    }

    const source = creatorSourceIdentity(creatorAuthority);
    const retry = await loadUpdateRetry(tx, companyId, gatewayInvocationId);
    if (retry) {
      if (
        retry.update.form !== "creator" ||
        retry.update.taskId !== task.id ||
        retry.update.sourceKind !== source.sourceKind ||
        retry.update.sourceAuthorityId !== source.sourceAuthorityId ||
        canonicalJson(retry.update.sourceIdentity) !== canonicalJson(source.sourceIdentity) ||
        retry.update.runId !== source.runId ||
        retry.update.message !== message ||
        retry.update.status !== (updateInput.status ?? null) ||
        canonicalJson(retry.update.disposition) !== canonicalJson(disposition)
      ) {
        throw new RuntimeTaskActionConflict(
          "creator task_update invocation was retried with different immutable arguments",
        );
      }
      return { ...retry, task, cancellations: null };
    }

    // Idempotent retries must be recognized before checking the current
    // lifecycle state: a successful open -> blocked creator update now sees
    // the child as blocked on its exact replay.
    assertTaskNonterminal(task);
    const previousStatus = task.lifecycleStatus;
    if (updateInput.status !== undefined) {
      assertLifecycleTransition(task.lifecycleStatus, updateInput.status);
    }

    const executionPolicyTransition =
      updateInput.status === undefined
        ? null
        : (() => {
            if (creatorAuthority.kind !== "agent-execution") {
              throw new RuntimeTaskActionDenied(
                "Only an exact agent execution creator may transition task lifecycle",
                "creator_lifecycle_agent_execution_required",
              );
            }
            return applyTaskExecutionPolicyTransition({
              task,
              policy: normalizeTaskExecutionPolicy(task.executionPolicy),
              requestedStatus: boardPresentationStatusFor(updateInput.status),
              requestedOwnerPatch: {},
              actor: {
                agentId: creatorAuthority.capability.targetAgentId,
              },
              commentBody: message,
            });
          })();
    const executionPolicyPatch = executionPolicyTransition
      ? taskExecutionPolicyPersistencePatch(executionPolicyTransition.patch)
      : {};

    const target = await lockTaskMentionRecipient(tx, companyId, task.id);
    const updateId = deterministicUuid("task-update", gatewayInvocationId);
    const updateDelivery = {
      toolName: "task_update",
      body: message,
      ...(updateInput.status === undefined ? {} : { requestedStatus: updateInput.status }),
      context: {
        task,
        from: taskUpdateMessageActor(creatorAuthority, authorizedRuntime),
        sourceRole: "task creator",
        previousStatus,
        effectiveStatus: updateInput.status ?? previousStatus,
      },
    } satisfies PaperclipManagedAgentMessage<"task_update">;
    const admission = await admitCounterpartTaskUpdate(sessionAdmission, tx, {
      companyId,
      sourceKind: "task_update",
      target,
      actor: taskUpdateActor(creatorAuthority),
      comment: source.comment,
      counterpart: updateCounterpart(creatorAuthority),
      sourceAgentTarget:
        creatorAuthority.kind === "agent-execution"
          ? {
              taskId: creatorAuthority.capability.taskId,
              agentId: creatorAuthority.capability.targetAgentId,
            }
          : null,
      immutableSourceKey: gatewayInvocationId,
      sourceRecordId: updateId,
      message: { kind: "managed", delivery: updateDelivery },
    });
    if (!admission.comment) {
      throw new RuntimeTaskActionConflict("Creator update did not persist its canonical comment");
    }
    const runSequence = source.runId === null ? 0 : await nextRunUpdateSequence(tx, companyId, source.runId);
    const update = await tx
      .insert(taskUpdates)
      .values({
        id: updateId,
        companyId,
        taskId: task.id,
        sessionId: sessionState.session.id,
        ownershipEpoch: task.ownershipEpoch,
        form: "creator",
        sourceKind: source.sourceKind,
        sourceAuthorityId: source.sourceAuthorityId,
        sourceIdentity: source.sourceIdentity,
        runId: source.runId,
        gatewayInvocationId,
        runSequence,
        message,
        status: updateInput.status ?? null,
        disposition,
        commentId: admission.comment.id,
        creatorEdgeId: edge.id,
        createdAt: now,
      })
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!update) {
      throw new RuntimeTaskActionConflict("Creator update ledger row was not persisted");
    }
    const updatedTask =
      updateInput.status === undefined
        ? await tx
            .select()
            .from(tasks)
            .where(
              and(
                eq(tasks.companyId, companyId),
                eq(tasks.id, task.id),
                eq(tasks.ownershipEpoch, task.ownershipEpoch),
                inArray(tasks.lifecycleStatus, ["open", "blocked"]),
              ),
            )
            .limit(1)
            .then((rows) => rows[0] ?? null)
        : await tx
            .update(tasks)
            .set({
              ...executionPolicyPatch,
              lifecycleStatus: updateInput.status,
              boardPresentationStatus:
                executionPolicyPatch.boardPresentationStatus ??
                boardPresentationStatusFor(updateInput.status),
              disposition: null,
              completedAt: null,
              cancelledAt: null,
              updatedAt: now,
            })
            .where(
              and(
                eq(tasks.companyId, companyId),
                eq(tasks.id, task.id),
                eq(tasks.ownershipEpoch, task.ownershipEpoch),
                inArray(tasks.lifecycleStatus, ["open", "blocked"]),
              ),
            )
            .returning()
            .then((rows) => rows[0] ?? null);
    if (!updatedTask) {
      throw new RuntimeTaskActionConflict("Task lifecycle changed during creator update");
    }
    return {
      task: updatedTask,
      update,
      comment: admission.comment,
      ref: admission.ref,
      cancellations: null,
      retried: false as const,
    };
  });
  if (committed.ref) {
    await options.dispatchPersistedRef(committed.ref.id);
  }
  const { cancellations: _, ...result } = committed;
  return result;
}
