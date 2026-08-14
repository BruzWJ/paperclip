import {
  taskCreateIdempotencyKeys,
  taskCreatorEdgeReceivability,
  taskExecutionAuthorities,
  tasks,
} from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import type { TaskSessionDbTransaction } from "./task-session/event-store.js";
import { reserveTaskExecutionWorkspaceBinding } from "./execution-workspaces.js";
import {
  type CanonicalTaskAggregateInput,
  assertAgentExecutionCreator,
  assertCanonicalTaskCreatorProvenance,
  assertCanonicalTaskIdentity,
  CanonicalTaskAggregateRejected,
  creatorEndpoint,
  deterministicUuid,
} from "./canonical-task-aggregate-part-1.js";
import { syncTask } from "./task-references.js";

/**
 * Sole production writer for a newly created task aggregate.
 *
 * Source services retain source-specific authorization, correlation and
 * initial admission, but no source may persist a partial task graph. This
 * transaction owner always commits the task, canonical Session, current
 * workspace binding, current owner authority (for agent ownership), and the
 * immutable creator edge for live work as one aggregate.
 */
export async function persistCanonicalTaskAggregateInTx(
  tx: TaskSessionDbTransaction,
  input: CanonicalTaskAggregateInput,
) {
  let task = input.task;
  if (task.ownershipEpoch < 1) {
    throw new CanonicalTaskAggregateRejected(
      "Task ownership epoch must be positive",
      "ownership_epoch_invalid",
    );
  }
  assertCanonicalTaskCreatorProvenance(task);
  await assertCanonicalTaskIdentity(tx, task);
  if (task.parentId) {
    if (task.parentId === task.id) {
      throw new CanonicalTaskAggregateRejected("A task cannot be its own parent", "parent_task_invalid");
    }
    const parent = await tx
      .select({ ownershipEpoch: tasks.ownershipEpoch })
      .from(tasks)
      .where(and(eq(tasks.companyId, task.companyId), eq(tasks.id, task.parentId)))
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!parent || parent.ownershipEpoch < 1) {
      throw new CanonicalTaskAggregateRejected(
        "Parent task is not resolvable in this company",
        "parent_task_invalid",
      );
    }
    if (
      task.parentOwnershipEpoch !== undefined &&
      task.parentOwnershipEpoch !== null &&
      task.parentOwnershipEpoch !== parent.ownershipEpoch
    ) {
      throw new CanonicalTaskAggregateRejected(
        "Parent ownership epoch changed before child creation committed",
        "parent_ownership_epoch_conflict",
      );
    }
    task = {
      ...task,
      parentOwnershipEpoch: parent.ownershipEpoch,
    };
  } else if (task.parentOwnershipEpoch != null) {
    throw new CanonicalTaskAggregateRejected(
      "A root task cannot carry parent ownership provenance",
      "parent_ownership_epoch_unexpected",
    );
  }
  const nonterminal = task.lifecycleStatus === "open" || task.lifecycleStatus === "blocked";
  if (task.ownerKind === "agent") {
    if (
      !task.ownerAgentId ||
      task.ownerUserId ||
      !input.authority ||
      input.authority.agentId !== task.ownerAgentId
    ) {
      throw new CanonicalTaskAggregateRejected(
        "Agent-owned task requires one matching current authority",
        "owner_authority_invalid",
      );
    }
  } else if (input.authority) {
    throw new CanonicalTaskAggregateRejected(
      "Non-agent-owned task cannot carry an owner authority",
      "owner_authority_unexpected",
    );
  }
  await assertAgentExecutionCreator(tx, task);

  const created = await tx
    .insert(tasks)
    .values(task)
    .returning()
    .then((rows) => rows[0] ?? null);
  if (!created) {
    throw new CanonicalTaskAggregateRejected("Task was not persisted", "task_insert_failed");
  }
  await syncTask(created.id, tx);

  const workspaceReservation = await reserveTaskExecutionWorkspaceBinding(tx, {
    task: created,
    session: input.session,
    ...input.workspaceReservation,
  });
  const persistedTask =
    created.projectWorkspaceId === workspaceReservation.projectWorkspaceId
      ? created
      : await tx
          .update(tasks)
          .set({
            projectWorkspaceId: workspaceReservation.projectWorkspaceId,
          })
          .where(and(eq(tasks.companyId, created.companyId), eq(tasks.id, created.id)))
          .returning()
          .then((rows) => rows[0] ?? null);
  if (!persistedTask) {
    throw new CanonicalTaskAggregateRejected(
      "Reserved project workspace was not projected onto the task",
      "project_workspace_projection_failed",
    );
  }
  const sessionRoot = {
    session: workspaceReservation.session,
    contextEpoch: {
      generation: workspaceReservation.contextEpochGeneration,
    },
  };
  const binding = workspaceReservation.binding;

  const authority = input.authority
    ? await tx
        .insert(taskExecutionAuthorities)
        .values({
          ...input.authority,
          companyId: created.companyId,
          taskId: created.id,
          sessionId: input.session.id,
          ownershipEpoch: created.ownershipEpoch!,
          state: "current",
          createdAt: input.authority.createdAt ?? input.session.now,
        })
        .returning()
        .then((rows) => rows[0] ?? null)
    : null;
  if (input.authority && !authority) {
    throw new CanonicalTaskAggregateRejected(
      "Task owner authority was not persisted",
      "owner_authority_missing",
    );
  }

  const creatorEdge = nonterminal
    ? await tx
        .insert(taskCreatorEdgeReceivability)
        .values({
          id: deterministicUuid(
            "creator-edge",
            `${created.companyId}:${created.id}:${created.ownershipEpoch}`,
          ),
          companyId: created.companyId,
          taskId: created.id,
          sessionId: input.session.id,
          ownershipEpoch: created.ownershipEpoch!,
          creatorKind: created.creatorKind!,
          ...creatorEndpoint(created),
          endpointTombstone: null,
          state: "receivable",
          createdAt: input.session.now,
          updatedAt: input.session.now,
        })
        .returning()
        .then((rows) => rows[0] ?? null)
    : null;
  if (nonterminal && !creatorEdge) {
    throw new CanonicalTaskAggregateRejected("Task creator edge was not persisted", "creator_edge_missing");
  }

  if (input.idempotency) {
    await tx.insert(taskCreateIdempotencyKeys).values({
      ...(input.idempotency.id ? { id: input.idempotency.id } : {}),
      companyId: created.companyId,
      idempotencyKey: input.idempotency.key,
      taskId: created.id,
      createdAt: input.session.now,
    });
  }

  return {
    task: persistedTask,
    sessionRoot,
    workspaceBinding: binding,
    authority,
    creatorEdge,
  };
}
export * from "./canonical-task-aggregate-part-1.js";
