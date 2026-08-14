import { companies, taskCreatorEdgeReceivability, taskExecutionAuthorities, tasks } from "@paperclipai/db";

import { isCanonicalTaskNumber, isSystemCreatorSourceKind, MAX_TASK_NUMBER } from "@paperclipai/shared";

import { and, eq, lt, sql } from "drizzle-orm";

import type { TaskSessionDbTransaction } from "./task-session/event-store.js";

import { type ReserveTaskExecutionWorkspaceBindingInput } from "./execution-workspaces.js";

export type TaskInsert = typeof tasks.$inferInsert;

export type TaskRow = typeof tasks.$inferSelect;

export type AuthorityInsert = typeof taskExecutionAuthorities.$inferInsert;

export type CreatorEdgeInsert = typeof taskCreatorEdgeReceivability.$inferInsert;

export class CanonicalTaskAggregateRejected extends Error {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
    this.name = "CanonicalTaskAggregateRejected";
  }
}

export function canonicalTaskIdentifier(taskPrefix: string, taskNumber: number): string {
  return `${taskPrefix}-${taskNumber}`;
}

/**
 * Sole allocator for the per-company task number and its persisted display
 * identifier. The atomic increment remains safe even if a future caller does
 * not already hold the company row lock.
 */
export async function allocateCanonicalTaskIdentityInTx(
  tx: TaskSessionDbTransaction,
  companyId: string,
  now: Date,
): Promise<{ taskNumber: number; identifier: string }> {
  const allocated = await tx
    .update(companies)
    .set({
      taskCounter: sql`${companies.taskCounter} + 1`,
      updatedAt: now,
    })
    .where(and(eq(companies.id, companyId), lt(companies.taskCounter, MAX_TASK_NUMBER)))
    .returning({
      taskNumber: companies.taskCounter,
      taskPrefix: companies.taskPrefix,
    })
    .then((rows) => rows[0] ?? null);
  if (!allocated || !isCanonicalTaskNumber(allocated.taskNumber)) {
    throw new CanonicalTaskAggregateRejected(
      "Company task counter cannot allocate another canonical task number",
      "task_number_unavailable",
    );
  }
  return {
    taskNumber: allocated.taskNumber,
    identifier: canonicalTaskIdentifier(allocated.taskPrefix, allocated.taskNumber),
  };
}

export async function assertCanonicalTaskIdentity(
  tx: TaskSessionDbTransaction,
  task: TaskInsert & { companyId: string },
): Promise<void> {
  if (!isCanonicalTaskNumber(task.taskNumber)) {
    throw new CanonicalTaskAggregateRejected(
      "Task number must be a canonical positive integer",
      "task_number_invalid",
    );
  }
  const company = await tx
    .select({
      taskPrefix: companies.taskPrefix,
      taskCounter: companies.taskCounter,
    })
    .from(companies)
    .where(eq(companies.id, task.companyId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (
    !company ||
    company.taskCounter !== task.taskNumber ||
    task.identifier !== canonicalTaskIdentifier(company.taskPrefix, task.taskNumber)
  ) {
    throw new CanonicalTaskAggregateRejected(
      "Task identifier must match the company prefix and allocated task number",
      "task_identifier_invalid",
    );
  }
}

export { deterministicUuid } from "./deterministic-uuid.js";

export function isPresent(value: unknown): boolean {
  return value !== null && value !== undefined;
}

export function allAbsent(...values: unknown[]): boolean {
  return values.every((value) => !isPresent(value));
}

/**
 * Mirrors the generated tasks creator/provenance CHECK constraints before the
 * canonical aggregate attempts its sole task insert.
 */
export function assertCanonicalTaskCreatorProvenance(task: TaskInsert & { id: string }): void {
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
        allAbsent(...unrelatedCreatorFields.slice(0, 2)) && allAbsent(...unrelatedCreatorFields.slice(3));
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
        isSystemCreatorSourceKind(task.creatorSystemSourceKind) &&
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
    task.creatorKind === "system" ? validEscalationProvenance : noEscalationProvenance;
  if (!validEscalationShape) {
    throw new CanonicalTaskAggregateRejected(
      "System creator and escalation provenance must occur together",
      "escalation_provenance_invalid",
    );
  }
}

export function creatorEndpoint(
  task: TaskRow,
): Pick<CreatorEdgeInsert, "endpointKind" | "endpointId" | "endpointSnapshot"> {
  switch (task.creatorKind) {
    case "agent-execution":
      if (task.creatorAuthorityId && task.creatorAdapterConfigRevisionId) {
        return {
          endpointKind: "agent-execution",
          endpointId: task.creatorAuthorityId,
          endpointSnapshot: {
            authorityId: task.creatorAuthorityId,
            originatingAdapterConfigRevisionId: task.creatorAdapterConfigRevisionId,
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
            pluginInstallationId: task.creatorPluginInstallationId,
            pluginKey: task.creatorPluginKey,
            callbackKey: task.creatorCallbackKey,
            callbackVersion: task.creatorCallbackVersion,
          },
        };
      }
      break;
    case "routine":
      if (task.creatorRoutineId && task.creatorRoutineDispatchId) {
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
      if (task.creatorSystemSourceKind && task.creatorSystemSourceId) {
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

export async function assertAgentExecutionCreator(
  tx: TaskSessionDbTransaction,
  task: TaskInsert,
): Promise<void> {
  if (task.creatorKind !== "agent-execution") return;
  if (!task.creatorAuthorityId || !task.creatorAdapterConfigRevisionId) {
    throw new CanonicalTaskAggregateRejected(
      "Agent-execution creator identity is incomplete",
      "creator_authority_incomplete",
    );
  }
  const authority = await tx
    .select({
      id: taskExecutionAuthorities.id,
      companyId: taskExecutionAuthorities.companyId,
      auditAdapterConfigRevisionId: taskExecutionAuthorities.auditAdapterConfigRevisionId,
    })
    .from(taskExecutionAuthorities)
    .where(
      and(
        eq(taskExecutionAuthorities.companyId, task.companyId),
        eq(taskExecutionAuthorities.id, task.creatorAuthorityId),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!authority || authority.auditAdapterConfigRevisionId !== task.creatorAdapterConfigRevisionId) {
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
  workspaceReservation?: Omit<ReserveTaskExecutionWorkspaceBindingInput, "task" | "session">;
  authority:
    | (Omit<AuthorityInsert, "companyId" | "taskId" | "sessionId" | "ownershipEpoch"> & {
        id: string;
        agentId: string;
        auditAdapterConfigRevisionId: string;
      })
    | null;
  idempotency?: {
    id?: string;
    key: string;
  } | null;
}
