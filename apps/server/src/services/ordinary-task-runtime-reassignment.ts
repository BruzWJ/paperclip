import { taskExecutionAuthorities, tasks } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { reserveTaskExecutionWorkspaceBinding } from "./execution-workspaces.js";
import * as runtime from "./ordinary-task-runtime-shared.js";
import { revokeOutgoingOwnershipEpoch } from "./runtime-task-action-port.js";
import type { TaskExecutionCancellationActor } from "./task-execution-cancellation.js";
import { admitTaskExecutionInTransaction } from "./task-execution-initial-start-admission.js";
import {
  createTaskSessionAdmissionService,
  type TaskSessionExecutionActor,
  type TaskSessionProjectedCommentAttribution,
} from "./task-session/admission.js";
import type { TaskSessionDbTransaction } from "./task-session/event-store.js";

export function createOrdinaryTaskReassignmentCommitter(context: {
  options: runtime.OrdinaryTaskRuntimeOptions;
  clock: () => Date;
  sessions: ReturnType<typeof createTaskSessionAdmissionService>;
}) {
  const { options, clock, sessions } = context;
  async function commitAgentOwnerReassignmentInTransaction(
    tx: TaskSessionDbTransaction,
    input: {
      task: runtime.TaskRow;
      ownerAgentId: string;
      idempotencyKey: string;
      sourceAuthorityId: string;
      cancellationActor: TaskExecutionCancellationActor;
      comment: TaskSessionProjectedCommentAttribution;
      sourceActor: Extract<TaskSessionExecutionActor, { kind: "user/board" | "agent-execution" | "plugin" }>;
      provenanceUserId: string | null;
      ownerResolution: Awaited<ReturnType<typeof runtime.resolveOrdinaryTaskOwner>>;
    },
  ) {
    const task = input.task;
    if (
      !task.ownershipEpoch ||
      task.ownerKind !== "agent" ||
      !task.ownerAgentId ||
      !task.request ||
      !task.lifecycleStatus ||
      !runtime.NONTERMINAL.has(task.lifecycleStatus)
    ) {
      throw new runtime.OrdinaryTaskRuntimeRejected(
        "Reassignment requires a nonterminal agent-owned task",
        "reassignment_target_invalid",
      );
    }
    if (task.ownerAgentId === input.ownerAgentId) {
      throw new runtime.OrdinaryTaskRuntimeRejected(
        "Selected owner already owns this task",
        "reassignment_owner_unchanged",
      );
    }
    const sessionState = await runtime.lockTaskSessionState(tx, task.companyId, task.id);
    if (!sessionState) {
      throw new runtime.OrdinaryTaskRuntimeRejected(
        "Reassignment target Session is missing",
        "reassignment_session_missing",
      );
    }
    const { session } = sessionState;
    const outgoingAuthority = await tx
      .select()
      .from(taskExecutionAuthorities)
      .where(
        and(
          eq(taskExecutionAuthorities.companyId, task.companyId),
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
        "Outgoing owner authority is missing",
        "reassignment_authority_missing",
      );
    }
    const now = clock();
    const revocation = await revokeOutgoingOwnershipEpoch(tx, sessions, options.taskExecutionCancellation, {
      companyId: task.companyId,
      taskId: task.id,
      sessionId: session.id,
      ownershipEpoch: task.ownershipEpoch,
      authorityId: outgoingAuthority.id,
      sourceAuthorityId: input.sourceAuthorityId,
      cancellationActor: input.cancellationActor,
      now,
    });
    const ownershipEpoch = task.ownershipEpoch + 1;
    const authorityId = runtime.deterministicUuid(
      "task-execution-authority",
      `${task.id}:${ownershipEpoch}:${input.ownerAgentId}`,
    );
    const reassigned = await tx
      .update(tasks)
      .set({
        ownerKind: "agent",
        ownerAgentId: input.ownerAgentId,
        ownerUserId: null,
        ownerAssignmentSource: null,
        ownershipEpoch,
        updatedAt: now,
      })
      .where(
        and(
          eq(tasks.companyId, task.companyId),
          eq(tasks.id, task.id),
          eq(tasks.ownershipEpoch, task.ownershipEpoch),
        ),
      )
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!reassigned) {
      throw new runtime.OrdinaryTaskRuntimeRejected(
        "Ownership epoch changed during reassignment",
        "reassignment_epoch_conflict",
      );
    }
    const workspaceReservation = await runtime.withOrdinaryWorkspaceReservationErrors(() =>
      reserveTaskExecutionWorkspaceBinding(tx, {
        task: reassigned,
        session: {
          id: session.id,
          now,
        },
        provenance: {
          agentId: null,
          userId: input.provenanceUserId,
        },
      }),
    );
    await tx.insert(taskExecutionAuthorities).values({
      id: authorityId,
      companyId: task.companyId,
      taskId: task.id,
      sessionId: session.id,
      ownershipEpoch,
      agentId: input.ownerAgentId,
      auditAdapterConfigRevisionId: input.ownerResolution.revisionId,
      state: "current",
      createdAt: now,
    });
    await runtime.insertCreatorEdge(tx, reassigned, session.id, now);
    const admission = await admitTaskExecutionInTransaction({
      sessionAdmission: sessions,
      transaction: tx,
      work: {
        companyId: task.companyId,
        taskId: task.id,
        sessionId: session.id,
        ownershipEpoch,
        targetAgentId: input.ownerAgentId,
        taskExecutionAuthorityId: authorityId,
        consultExecutionId: null,
        adapterConfigRevisionId: input.ownerResolution.revisionId,
        contextEpoch: workspaceReservation.contextEpochGeneration,
        mode: "owner",
        sourceKind: "task_reassignment",
        actor: input.sourceActor,
        previousOwnershipEpoch: task.ownershipEpoch,
        immutableSourceKey: input.idempotencyKey,
        sourceRecordId: task.id,
        exactText: task.request,
        comment: { ...input.comment, body: task.request },
        idempotencyKey: input.idempotencyKey,
      },
    });
    if (!admission.ref) {
      throw new runtime.OrdinaryTaskRuntimeRejected(
        "Reassignment did not persist an owner execution ref",
        "reassignment_ref_missing",
      );
    }
    return {
      task: reassigned,
      ref: admission.ref,
      escalationDispatchRefIds: revocation.escalationDispatchRefIds,
      cancellations: revocation.cancellations,
      retried: false as const,
    };
  }
  return commitAgentOwnerReassignmentInTransaction;
}
