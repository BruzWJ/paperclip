import {
  taskBoardReopenCommands,
  taskCreatorEdgeReceivability,
  taskExecutionRefs,
  tasks,
} from "@paperclipai/db";
import type { TaskBoardReopenDispatch } from "@paperclipai/shared";
import { and, eq } from "drizzle-orm";
import {
  OrdinaryTaskBoardReopenInput,
  OrdinaryTaskRuntimeRejected,
  lockSystemEscalationReopenIdentity,
} from "./ordinary-task-runtime-shared.js";
import { projectPersistedTaskExecutionRef } from "./task-execution-dispatcher-postgres.js";
import type { TaskSessionDbTransaction } from "./task-session/event-store.js";

export async function replayOrdinaryTaskBoardReopen(
  tx: TaskSessionDbTransaction,
  replay: {
    input: OrdinaryTaskBoardReopenInput;
    priorCommand: typeof taskBoardReopenCommands.$inferSelect;
    actorUserId: string;
    reason: string;
    identityDigest: string;
    idempotencyKey: string;
  },
) {
  const { input, priorCommand, actorUserId, reason, identityDigest, idempotencyKey } = replay;

  if (
    priorCommand.identityDigest !== identityDigest ||
    priorCommand.taskId !== input.taskId ||
    priorCommand.actorUserId !== actorUserId ||
    priorCommand.reason !== reason
  ) {
    throw new OrdinaryTaskRuntimeRejected(
      "Board reopen idempotency key changed immutable input",
      "board_reopen_idempotency_conflict",
    );
  }
  const taskRows = await tx
    .select()
    .from(tasks)
    .where(and(eq(tasks.companyId, input.companyId), eq(tasks.id, priorCommand.taskId)))
    .limit(2)
    .for("update");
  const edgeRows = await tx
    .select()
    .from(taskCreatorEdgeReceivability)
    .where(
      and(
        eq(taskCreatorEdgeReceivability.companyId, input.companyId),
        eq(taskCreatorEdgeReceivability.taskId, priorCommand.taskId),
        eq(taskCreatorEdgeReceivability.ownershipEpoch, priorCommand.ownershipEpoch),
        eq(taskCreatorEdgeReceivability.id, priorCommand.creatorEdgeId),
      ),
    )
    .limit(2)
    .for("update");
  if (taskRows.length !== 1 || edgeRows.length !== 1 || priorCommand.continuityFenceGeneration <= 0) {
    throw new OrdinaryTaskRuntimeRejected(
      "Accepted board reopen is missing canonical records",
      "board_reopen_incomplete",
    );
  }
  const task = taskRows[0]!;
  const edge = edgeRows[0]!;
  if (priorCommand.branch === "agent_execution") {
    if (
      priorCommand.preservedOwnerKind !== "agent" ||
      !priorCommand.executionRefId ||
      priorCommand.systemEscalationIdentityId !== null
    ) {
      throw new OrdinaryTaskRuntimeRejected(
        "Accepted agent board reopen has an invalid checked branch",
        "board_reopen_incomplete",
      );
    }
    const refs = await tx
      .select()
      .from(taskExecutionRefs)
      .where(
        and(
          eq(taskExecutionRefs.companyId, input.companyId),
          eq(taskExecutionRefs.taskId, priorCommand.taskId),
          eq(taskExecutionRefs.id, priorCommand.executionRefId),
        ),
      )
      .limit(2)
      .for("update");
    const executionRef = refs[0] ?? null;
    if (
      refs.length !== 1 ||
      !executionRef ||
      executionRef.ownershipEpoch !== priorCommand.ownershipEpoch ||
      executionRef.mode !== "owner" ||
      executionRef.sourceKind !== "task_reopen" ||
      executionRef.sourceRecordId !== priorCommand.id ||
      executionRef.exactMessage !== task.request ||
      executionRef.deliveryIdempotencyKey !== `board-reopen:${input.companyId}:${idempotencyKey}` ||
      executionRef.taskExecutionAuthorityId === null
    ) {
      throw new OrdinaryTaskRuntimeRejected(
        "Accepted agent board reopen lost its exact execution ref",
        "board_reopen_incomplete",
      );
    }
    return {
      task,
      edge,
      command: priorCommand,
      dispatch: {
        kind: "agent_execution",
        executionRef: projectPersistedTaskExecutionRef(executionRef),
      } satisfies TaskBoardReopenDispatch,
      escalationDispatchRefId: null,
      cancellations: null,
      retried: true as const,
    };
  }
  if (
    priorCommand.branch !== "board_only" ||
    !["user", "board"].includes(priorCommand.preservedOwnerKind) ||
    priorCommand.executionRefId !== null ||
    !priorCommand.systemEscalationIdentityId
  ) {
    throw new OrdinaryTaskRuntimeRejected(
      "Accepted board-only reopen has an invalid checked branch",
      "board_reopen_incomplete",
    );
  }
  const escalationIdentity = await lockSystemEscalationReopenIdentity(tx, task);
  if (escalationIdentity.id !== priorCommand.systemEscalationIdentityId) {
    throw new OrdinaryTaskRuntimeRejected(
      "Accepted board-only reopen lost its exact escalation identity",
      "board_reopen_incomplete",
    );
  }
  return {
    task,
    edge,
    command: priorCommand,
    dispatch: { kind: "board_only" } satisfies TaskBoardReopenDispatch,
    escalationDispatchRefId: null,
    cancellations: null,
    retried: true as const,
  };
}
