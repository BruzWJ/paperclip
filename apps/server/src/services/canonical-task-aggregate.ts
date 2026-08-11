import { createHash } from "node:crypto";
import {
  taskCreateIdempotencyKeys,
  taskCreatorEdgeReceivability,
  taskExecutionAuthorities,
  tasks,
} from "@paperclipai/db";
import { isSystemCreatorSourceKind } from "@paperclipai/shared";
import { and, eq } from "drizzle-orm";
import type { TaskSessionDbTransaction } from "./task-session/event-store.js";
import {
  reserveTaskExecutionWorkspaceBinding,
  type ReserveTaskExecutionWorkspaceBindingInput,
} from "./execution-workspaces.js";
import { syncTask } from "./task-references.js";

type TaskInsert = typeof tasks.$inferInsert;
type TaskRow = typeof tasks.$inferSelect;
type AuthorityInsert = typeof taskExecutionAuthorities.$inferInsert;
type CreatorEdgeInsert =
  typeof taskCreatorEdgeReceivability.$inferInsert;

export class CanonicalTaskAggregateRejected extends Error {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
    this.name = "CanonicalTaskAggregateRejected";
  }
}

function deterministicUuid(namespace: string, key: string): string {
  const bytes = Buffer.from(
    createHash("sha256")
      .update(`${namespace}\0${key}`)
      .digest("hex")
      .slice(0, 32),
    "hex",
  );
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isPresent(value: unknown): boolean {
  return value !== null && value !== undefined;
}

function allAbsent(...values: unknown[]): boolean {
  return values.every((value) => !isPresent(value));
}

/**
 * Mirrors the generated tasks creator/provenance CHECK constraints before the
 * canonical aggregate attempts its sole task insert.
 */
export function assertCanonicalTaskCreatorProvenance(
  task: TaskInsert & { id: string },
): void {
  const unrelatedCreatorFields = [
    task.creatorAuthorityId,
    task.creatorAdapterConfigRevisionId,
    task.creatorUserId,
    task.creatorPluginInstallationId,
    task.creatorPluginKey,
    task.creatorCallbackKey,
    task.creatorCallbackVersion,
    task.creatorRoutineId,
    task.creatorRoutineDispatchId,
    task.creatorSystemSourceKind,
    task.creatorSystemSourceId,
  ];

  let validCreatorShape = false;
  switch (task.creatorKind) {
    case "agent-execution":
      validCreatorShape =
        isPresent(task.creatorAuthorityId) &&
        isPresent(task.creatorAdapterConfigRevisionId) &&
        allAbsent(...unrelatedCreatorFields.slice(2));
      break;
    case "user/board":
      validCreatorShape =
        allAbsent(...unrelatedCreatorFields.slice(0, 2)) &&
        allAbsent(...unrelatedCreatorFields.slice(3));
      break;
    case "plugin":
      validCreatorShape =
        allAbsent(...unrelatedCreatorFields.slice(0, 3)) &&
        isPresent(task.creatorPluginInstallationId) &&
        isPresent(task.creatorPluginKey) &&
        isPresent(task.creatorCallbackKey) &&
        isPresent(task.creatorCallbackVersion) &&
        allAbsent(...unrelatedCreatorFields.slice(7));
      break;
    case "routine":
      validCreatorShape =
        allAbsent(...unrelatedCreatorFields.slice(0, 7)) &&
        isPresent(task.creatorRoutineId) &&
        isPresent(task.creatorRoutineDispatchId) &&
        allAbsent(...unrelatedCreatorFields.slice(9));
      break;
    case "system":
      validCreatorShape =
        allAbsent(...unrelatedCreatorFields.slice(0, 9)) &&
        isSystemCreatorSourceKind(
          task.creatorSystemSourceKind,
        ) &&
        isPresent(task.creatorSystemSourceId);
      break;
  }
  if (!validCreatorShape) {
    throw new CanonicalTaskAggregateRejected(
      "Task creator fields do not match the selected creator kind",
      "creator_shape_invalid",
    );
  }

  const noEscalationProvenance = allAbsent(
    task.escalatedFromAffectedTaskId,
    task.escalatedFromTriggeringRunId,
    task.escalatedFromReason,
    task.affectedOwnershipEpoch,
  );
  const validEscalationProvenance =
    isPresent(task.escalatedFromAffectedTaskId) &&
    task.escalatedFromAffectedTaskId !== task.id &&
    isPresent(task.escalatedFromReason) &&
    typeof task.affectedOwnershipEpoch === "number" &&
    Number.isInteger(task.affectedOwnershipEpoch) &&
    task.affectedOwnershipEpoch > 0 &&
    !isPresent(task.parentId);
  const validEscalationShape =
    task.creatorKind === "system"
      ? validEscalationProvenance
      : noEscalationProvenance;
  if (!validEscalationShape) {
    throw new CanonicalTaskAggregateRejected(
      "System creator and escalation provenance must occur together",
      "escalation_provenance_invalid",
    );
  }
}

function creatorEndpoint(task: TaskRow): Pick<
  CreatorEdgeInsert,
  "endpointKind" | "endpointId" | "endpointSnapshot"
> {
  switch (task.creatorKind) {
    case "agent-execution":
      if (
        task.creatorAuthorityId &&
        task.creatorAdapterConfigRevisionId
      ) {
        return {
          endpointKind: "agent-execution",
          endpointId: task.creatorAuthorityId,
          endpointSnapshot: {
            authorityId: task.creatorAuthorityId,
            originatingAdapterConfigRevisionId:
              task.creatorAdapterConfigRevisionId,
          },
        };
      }
      break;
    case "user/board":
      if (task.creatorUserId) {
        return {
          endpointKind: "user/board",
          endpointId: task.creatorUserId,
          endpointSnapshot: {
            userId: task.creatorUserId,
            recipient: "named-user",
          },
        };
      }
      return {
        endpointKind: "user/board",
        endpointId: null,
        endpointSnapshot: { recipient: "company-board" },
      };
    case "plugin":
      if (
        task.creatorPluginInstallationId &&
        task.creatorPluginKey &&
        task.creatorCallbackKey &&
        task.creatorCallbackVersion
      ) {
        return {
          endpointKind: "plugin",
          endpointId: task.creatorPluginInstallationId,
          endpointSnapshot: {
            pluginInstallationId:
              task.creatorPluginInstallationId,
            pluginKey: task.creatorPluginKey,
            callbackKey: task.creatorCallbackKey,
            callbackVersion: task.creatorCallbackVersion,
          },
        };
      }
      break;
    case "routine":
      if (
        task.creatorRoutineId &&
        task.creatorRoutineDispatchId
      ) {
        return {
          endpointKind: "routine",
          endpointId: task.creatorRoutineId,
          endpointSnapshot: {
            routineId: task.creatorRoutineId,
            routineDispatchId: task.creatorRoutineDispatchId,
          },
        };
      }
      break;
    case "system":
      if (
        task.creatorSystemSourceKind &&
        task.creatorSystemSourceId
      ) {
        return {
          endpointKind: "system",
          endpointId: task.creatorSystemSourceId,
          endpointSnapshot: {
            sourceKind: task.creatorSystemSourceKind,
            sourceId: task.creatorSystemSourceId,
            recipient: "company-board",
          },
        };
      }
      break;
  }
  throw new CanonicalTaskAggregateRejected(
    "Task creator endpoint is incomplete",
    "creator_endpoint_incomplete",
  );
}

async function assertAgentExecutionCreator(
  tx: TaskSessionDbTransaction,
  task: TaskInsert,
): Promise<void> {
  if (task.creatorKind !== "agent-execution") return;
  if (
    !task.creatorAuthorityId ||
    !task.creatorAdapterConfigRevisionId
  ) {
    throw new CanonicalTaskAggregateRejected(
      "Agent-execution creator identity is incomplete",
      "creator_authority_incomplete",
    );
  }
  const authority = await tx
    .select({
      id: taskExecutionAuthorities.id,
      companyId: taskExecutionAuthorities.companyId,
      auditAdapterConfigRevisionId:
        taskExecutionAuthorities.auditAdapterConfigRevisionId,
    })
    .from(taskExecutionAuthorities)
    .where(
      and(
        eq(
          taskExecutionAuthorities.companyId,
          task.companyId,
        ),
        eq(
          taskExecutionAuthorities.id,
          task.creatorAuthorityId,
        ),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (
    !authority ||
    authority.auditAdapterConfigRevisionId !==
      task.creatorAdapterConfigRevisionId
  ) {
    throw new CanonicalTaskAggregateRejected(
      "Agent-execution creator authority is not resolvable in this company",
      "creator_authority_invalid",
    );
  }
}

export interface CanonicalTaskAggregateInput {
  task: TaskInsert & {
    id: string;
    companyId: string;
    ownershipEpoch: number;
  };
  session: {
    id: string;
    parentSessionId?: string | null;
    now: Date;
  };
  workspaceReservation?: Omit<
    ReserveTaskExecutionWorkspaceBindingInput,
    "task" | "session"
  >;
  authority: (Omit<
    AuthorityInsert,
    "companyId" | "taskId" | "sessionId" | "ownershipEpoch"
  > & {
    id: string;
    agentId: string;
    auditAdapterConfigRevisionId: string;
  }) | null;
  idempotency?: {
    id?: string;
    key: string;
  } | null;
}

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
  if (task.parentId) {
    if (task.parentId === task.id) {
      throw new CanonicalTaskAggregateRejected(
        "A task cannot be its own parent",
        "parent_task_invalid",
      );
    }
    const parent = await tx
      .select({ ownershipEpoch: tasks.ownershipEpoch })
      .from(tasks)
      .where(
        and(
          eq(tasks.companyId, task.companyId),
          eq(tasks.id, task.parentId),
        ),
      )
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
  const nonterminal =
    task.lifecycleStatus === "open" ||
    task.lifecycleStatus === "blocked";
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
    throw new CanonicalTaskAggregateRejected(
      "Task was not persisted",
      "task_insert_failed",
    );
  }
  await syncTask(created.id, tx);

  const workspaceReservation =
    await reserveTaskExecutionWorkspaceBinding(tx, {
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
          .where(
            and(
              eq(tasks.companyId, created.companyId),
              eq(tasks.id, created.id),
            ),
          )
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
          createdAt:
            input.authority.createdAt ?? input.session.now,
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
    throw new CanonicalTaskAggregateRejected(
      "Task creator edge was not persisted",
      "creator_edge_missing",
    );
  }

  if (input.idempotency) {
    await tx.insert(taskCreateIdempotencyKeys).values({
      ...(input.idempotency.id
        ? { id: input.idempotency.id }
        : {}),
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
