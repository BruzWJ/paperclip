import { taskExecutionDecisions, tasks, type Db } from "@paperclipai/db";

import { and, eq, sql } from "drizzle-orm";

import { conflict, unprocessable } from "../errors.js";
import { deterministicUuid } from "./deterministic-uuid.js";

import type { TaskExecutionPolicyActor } from "./task-execution-policy-part-3.js";

export type TaskExecutionPolicyControlResult = {
  task: typeof tasks.$inferSelect;
  decision: typeof taskExecutionDecisions.$inferSelect;
  retried: boolean;
};

export function deterministicExecutionPolicyDecisionId(input: {
  companyId: string;
  taskId: string;
  idempotencyKey: string;
}) {
  return deterministicUuid(
    "task-execution-policy-decision",
    `${input.companyId}\0${input.taskId}\0${input.idempotencyKey}`,
  );
}

export function assertUnchangedTaskOwnership(patch: Record<string, unknown>) {
  const forbiddenKeys = [
    "ownerKind",
    "ownerAgentId",
    "ownerUserId",
    "ownershipEpoch",
  ];
  const emitted = forbiddenKeys.filter((key) => Object.prototype.hasOwnProperty.call(patch, key));
  if (emitted.length > 0) {
    throw new Error(
      `Execution-policy transition attempted to mutate canonical ownership: ${emitted.join(", ")}`,
    );
  }
}

export function taskExecutionPolicyPersistencePatch(patch: Record<string, unknown>) {
  assertUnchangedTaskOwnership(patch);
  return {
    ...(typeof patch.status === "string"
      ? {
          boardPresentationStatus: patch.status as
            "backlog" | "todo" | "in_progress" | "in_review" | "done" | "blocked" | "cancelled",
        }
      : {}),
    ...(patch.executionPolicy !== undefined
      ? {
          executionPolicy:
            patch.executionPolicy === null ? null : (patch.executionPolicy as Record<string, unknown>),
        }
      : {}),
    ...(patch.executionState !== undefined
      ? {
          executionState:
            patch.executionState === null ? null : (patch.executionState as Record<string, unknown>),
        }
      : {}),
    ...(patch.monitorNextCheckAt !== undefined
      ? { monitorNextCheckAt: patch.monitorNextCheckAt as Date | null }
      : {}),
    ...(patch.monitorLastTriggeredAt !== undefined
      ? { monitorLastTriggeredAt: patch.monitorLastTriggeredAt as Date | null }
      : {}),
    ...(patch.monitorAttemptCount !== undefined
      ? { monitorAttemptCount: patch.monitorAttemptCount as number }
      : {}),
    ...(patch.monitorNotes !== undefined ? { monitorNotes: patch.monitorNotes as string | null } : {}),
    ...(patch.monitorScheduledBy !== undefined
      ? { monitorScheduledBy: patch.monitorScheduledBy as string | null }
      : {}),
  };
}

export function assertExecutionPolicyActor(actor: TaskExecutionPolicyActor) {
  const hasAgent = Boolean(actor.agentId);
  const hasUser = Boolean(actor.userId);
  if (hasAgent === hasUser) {
    throw unprocessable("An execution-policy decision requires exactly one participant identity");
  }
}

export function persistedValueEqual(left: unknown, right: unknown): boolean {
  if (left instanceof Date || right instanceof Date) {
    return left instanceof Date && right instanceof Date && left.getTime() === right.getTime();
  }
  if ((left !== null && typeof left === "object") || (right !== null && typeof right === "object")) {
    return JSON.stringify(left) === JSON.stringify(right);
  }
  return left === right;
}

export function taskPatchChangesPersistedState(
  task: typeof tasks.$inferSelect,
  patch: Record<string, unknown>,
): boolean {
  const current = task as unknown as Record<string, unknown>;
  return Object.entries(patch).some(([key, value]) => !persistedValueEqual(current[key], value));
}

export async function lockTaskForExecutionPolicy(
  tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
  companyId: string,
  taskId: string,
) {
  await tx.execute(
    sql`select ${tasks.id} from ${tasks}
        where ${tasks.companyId} = ${companyId}
          and ${tasks.id} = ${taskId}
        for update`,
  );
  const task = await tx
    .select()
    .from(tasks)
    .where(and(eq(tasks.companyId, companyId), eq(tasks.id, taskId)))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!task) {
    throw conflict("Task changed or was removed while applying its execution policy");
  }
  return task;
}
