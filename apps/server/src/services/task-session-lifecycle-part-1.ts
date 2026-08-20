import {
  companies,
  companySessionLifecycleOperations,
  taskExecutionCancellationIntents,
  taskSessions,
  type Db,
} from "@paperclipai/db";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { lockTaskExecutionRunInTransaction } from "./task-execution-run-service.js";
import { TaskSessionInvariantError, TaskSessionLifecycleConflict } from "./task-session/store.js";

export type CompanySessionLifecycleTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type PostgresLifecycleOperation = typeof companySessionLifecycleOperations.$inferSelect;

export type PostgresCancellationIntent = typeof taskExecutionCancellationIntents.$inferSelect;

export const ACTIVE_ATTEMPT_STATES = ["pending", "leased", "running"] as const;

export const LIVE_CAPABILITY_STATES = ["pending_setup", "active"] as const;

export const LIVE_NATIVE_SESSION_STATES = ["eligible"] as const;

export const LIFECYCLE_SNAPSHOT_VERSION = "company-session-lifecycle/v1" as const;

export interface LifecycleAttemptSnapshot {
  readonly intentId: string;
  readonly companyId: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly leaseId: string | null;
}

export interface CompanySessionLifecycleRun {
  readonly companyId: string;
  readonly taskId: string;
  readonly runId: string;
}

export interface LifecycleGraphSnapshot extends Record<string, unknown> {
  readonly version: typeof LIFECYCLE_SNAPSHOT_VERSION;
  readonly sessionIds: readonly string[];
  readonly taskIds: readonly string[];
  readonly runs: readonly CompanySessionLifecycleRun[];
  readonly attempts: readonly LifecycleAttemptSnapshot[];
}

export interface CompanySessionLifecycleActor {
  readonly requestedByAgentId?: string | null;
  readonly requestedByUserId?: string | null;
}

export interface CompanySessionLifecycleBeginResult {
  readonly operation: PostgresLifecycleOperation;
  readonly intents: readonly PostgresCancellationIntent[];
  readonly runs: readonly CompanySessionLifecycleRun[];
  readonly created: boolean;
}

export function sessionDepth(sessionId: string, parentById: ReadonlyMap<string, string | null>): number {
  let current = sessionId;
  let depth = 0;
  const visited = new Set<string>();
  while (true) {
    if (visited.has(current)) {
      throw new TaskSessionInvariantError(`Canonical Session parent cycle includes ${current}`);
    }
    visited.add(current);
    const parent = parentById.get(current);
    if (!parent || !parentById.has(parent)) return depth;
    current = parent;
    depth += 1;
  }
}

export async function lockCompanySessionLifecycle(
  tx: CompanySessionLifecycleTx,
  companyId: string,
): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${companyId}, 0))`);
  await tx.execute(
    sql`select ${companies.id} from ${companies}
      where ${companies.id} = ${companyId}
      for update`,
  );
}

export async function lockSessionsParentFirst(
  tx: CompanySessionLifecycleTx,
  companyId: string,
): Promise<Array<typeof taskSessions.$inferSelect>> {
  const rows = await tx.select().from(taskSessions).where(eq(taskSessions.companyId, companyId));
  const parentById = new Map(rows.map((row) => [row.id, row.parentSessionId] as const));
  rows.sort(
    (left, right) =>
      sessionDepth(left.id, parentById) - sessionDepth(right.id, parentById) ||
      left.id.localeCompare(right.id),
  );
  for (const row of rows) {
    await tx.execute(
      sql`select ${taskSessions.id} from ${taskSessions}
        where ${taskSessions.companyId} = ${companyId}
          and ${taskSessions.id} = ${row.id}
        for update`,
    );
  }
  return rows;
}

export function lifecycleActor(actor: CompanySessionLifecycleActor | undefined): {
  actorKind: "system" | "user" | "agent";
  actorUserId: string | null;
  actorAgentId: string | null;
} {
  const userId = actor?.requestedByUserId ?? null;
  const agentId = actor?.requestedByAgentId ?? null;
  if (userId && agentId) {
    throw new TaskSessionLifecycleConflict("A company lifecycle operation must have one exact actor");
  }
  return userId
    ? { actorKind: "user", actorUserId: userId, actorAgentId: null }
    : agentId
      ? { actorKind: "agent", actorUserId: null, actorAgentId: agentId }
      : { actorKind: "system", actorUserId: null, actorAgentId: null };
}

export function parseLifecycleSnapshot(operation: PostgresLifecycleOperation): LifecycleGraphSnapshot {
  const value = operation.sessionGraphSnapshot;
  if (
    !value ||
    value.version !== LIFECYCLE_SNAPSHOT_VERSION ||
    !Array.isArray(value.sessionIds) ||
    !Array.isArray(value.taskIds) ||
    !Array.isArray(value.runs) ||
    !Array.isArray(value.attempts)
  ) {
    throw new TaskSessionInvariantError(
      `Lifecycle operation ${operation.id} has a non-canonical graph snapshot`,
    );
  }
  const strings = (items: unknown[]): items is string[] =>
    items.every((item) => typeof item === "string" && item.length > 0);
  if (!strings(value.sessionIds) || !strings(value.taskIds)) {
    throw new TaskSessionInvariantError(`Lifecycle operation ${operation.id} has invalid Session identities`);
  }
  const runs: CompanySessionLifecycleRun[] = value.runs.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new TaskSessionInvariantError(`Lifecycle operation ${operation.id} has invalid run ${index}`);
    }
    const row = item as Record<string, unknown>;
    for (const key of ["companyId", "taskId", "runId"] as const) {
      if (typeof row[key] !== "string" || row[key].length === 0) {
        throw new TaskSessionInvariantError(`Lifecycle operation ${operation.id} has invalid run ${key}`);
      }
    }
    return row as unknown as CompanySessionLifecycleRun;
  });
  const attempts: LifecycleAttemptSnapshot[] = value.attempts.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new TaskSessionInvariantError(`Lifecycle operation ${operation.id} has invalid attempt ${index}`);
    }
    const row = item as Record<string, unknown>;
    for (const key of ["intentId", "companyId", "taskId", "sessionId", "runId", "attemptId"] as const) {
      if (typeof row[key] !== "string" || row[key].length === 0) {
        throw new TaskSessionInvariantError(`Lifecycle operation ${operation.id} has invalid ${key}`);
      }
    }
    if (row.leaseId !== null && typeof row.leaseId !== "string") {
      throw new TaskSessionInvariantError(`Lifecycle operation ${operation.id} has invalid leaseId`);
    }
    return row as unknown as LifecycleAttemptSnapshot;
  });
  return {
    version: LIFECYCLE_SNAPSHOT_VERSION,
    sessionIds: value.sessionIds,
    taskIds: value.taskIds,
    runs,
    attempts,
  };
}

export async function operationIntents(
  tx: CompanySessionLifecycleTx,
  operation: PostgresLifecycleOperation,
): Promise<PostgresCancellationIntent[]> {
  const ids = parseLifecycleSnapshot(operation).attempts.map((attempt) => attempt.intentId);
  if (ids.length === 0) return [];
  const rows = await tx
    .select()
    .from(taskExecutionCancellationIntents)
    .where(
      and(
        eq(taskExecutionCancellationIntents.companyId, operation.companyId),
        inArray(taskExecutionCancellationIntents.id, ids),
      ),
    )
    .orderBy(asc(taskExecutionCancellationIntents.id));
  if (rows.length !== ids.length) {
    throw new TaskSessionInvariantError(
      `Lifecycle operation ${operation.id} lost a retained cancellation intent`,
    );
  }
  return rows;
}

export async function latestLifecycleOperation(
  tx: CompanySessionLifecycleTx,
  companyId: string,
  operation: "archive" | "hard_delete",
): Promise<PostgresLifecycleOperation | null> {
  return tx
    .select()
    .from(companySessionLifecycleOperations)
    .where(
      and(
        eq(companySessionLifecycleOperations.companyId, companyId),
        eq(companySessionLifecycleOperations.operation, operation),
      ),
    )
    .orderBy(
      sql`${companySessionLifecycleOperations.generation} desc`,
      asc(companySessionLifecycleOperations.id),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

export async function refreshLifecycleOperationAfterCancellationInTx(
  tx: CompanySessionLifecycleTx,
  operation: PostgresLifecycleOperation,
  now: Date,
): Promise<PostgresLifecycleOperation> {
  if (["completed", "purge_ready", "failed"].includes(operation.status)) {
    return operation;
  }
  const intents = await operationIntents(tx, operation);
  const failed = intents.find((intent) => intent.state === "failed");
  const snapshot = parseLifecycleSnapshot(operation);
  let archivedRunsSettled = true;
  if (operation.operation === "archive") {
    for (const identity of snapshot.runs) {
      const run = await lockTaskExecutionRunInTransaction(tx, identity);
      if (["queued", "scheduled_retry", "running"].includes(run.status)) {
        archivedRunsSettled = false;
      }
    }
  }
  const drained = intents.every((intent) => intent.state === "completed") && archivedRunsSettled;
  const status = failed
    ? "failed"
    : drained
      ? operation.operation === "hard_delete"
        ? "purge_ready"
        : "completed"
      : intents.length > 0
        ? "cancelling"
        : "fenced";
  const failureReason = failed?.failureCode ?? null;
  const updated = await tx
    .update(companySessionLifecycleOperations)
    .set({
      status,
      cancellingAt: status === "cancelling" ? (operation.cancellingAt ?? now) : operation.cancellingAt,
      purgeReadyAt: status === "purge_ready" ? now : null,
      completedAt: status === "completed" ? now : null,
      failedAt: status === "failed" ? now : null,
      failureReason,
      updatedAt: now,
    })
    .where(eq(companySessionLifecycleOperations.id, operation.id))
    .returning()
    .then((rows) => rows[0]);
  if (!updated) {
    throw new TaskSessionInvariantError(
      `Lifecycle operation ${operation.id} disappeared while settling cancellation`,
    );
  }
  return updated;
}

export async function activeOperationForIntent(
  tx: CompanySessionLifecycleTx,
  intent: PostgresCancellationIntent,
): Promise<PostgresLifecycleOperation | null> {
  const operations = await tx
    .select()
    .from(companySessionLifecycleOperations)
    .where(eq(companySessionLifecycleOperations.companyId, intent.companyId))
    .orderBy(
      sql`${companySessionLifecycleOperations.generation} desc`,
      asc(companySessionLifecycleOperations.id),
    );
  for (const operation of operations) {
    if (parseLifecycleSnapshot(operation).attempts.some((attempt) => attempt.intentId === intent.id)) {
      return operation;
    }
  }
  return null;
}
