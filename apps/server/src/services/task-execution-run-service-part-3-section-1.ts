import {
  taskExecutionAttemptRetrySchedules,
  taskExecutionLeases,
  taskExecutionRunControls,
  taskExecutionRunRefs,
  taskExecutionRuns,
  type Db,
} from "@paperclipai/db";
import { isCanonicalUuid } from "@paperclipai/shared";
import { and, asc, desc, eq, inArray, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { TaskExecutionTargetLaneIdentity } from "./task-execution-dispatcher.js";
import {
  type TaskExecutionRunEnvelope,
  type TaskExecutionRunIdentity,
  TaskExecutionRunInvariantViolation,
  assertExactRunIdentifier,
  assertRunIdentity,
} from "./task-execution-run-service-part-1-section-1.js";
import {
  assertRunEnvelopeInvariant,
  projectRunEnvelope,
  selectExactRunRow,
} from "./task-execution-run-service-part-2-section-1.js";
import type { TaskSessionDbTransaction } from "./task-session/event-store.js";

/**
 * Resolve the complete canonical identity behind a URL/tool run selector.
 * Every subsequent read or mutation must use the returned company/task/id
 * tuple; no caller receives an arbitrary run-row query surface.
 */
export async function resolveTaskExecutionRunIdentityById(
  database: Db | TaskSessionDbTransaction,
  runId: string,
): Promise<TaskExecutionRunIdentity | null> {
  if (!isCanonicalUuid(runId)) return null;
  const rows = await database
    .select({
      companyId: taskExecutionRuns.companyId,
      taskId: taskExecutionRuns.taskId,
      runId: taskExecutionRuns.id,
    })
    .from(taskExecutionRuns)
    .where(eq(taskExecutionRuns.id, runId))
    .limit(2);
  if (rows.length > 1) {
    throw new TaskExecutionRunInvariantViolation("run selector resolved more than one canonical identity");
  }
  return rows[0] ?? null;
}

export async function lockTaskExecutionRunInTransaction(
  transaction: TaskSessionDbTransaction,
  input: TaskExecutionRunIdentity,
): Promise<TaskExecutionRunEnvelope> {
  const run = await lockTaskExecutionRunIfPresentInTransaction(transaction, input);
  if (!run) {
    throw new TaskExecutionRunInvariantViolation(
      "selected task-execution run does not exist in the exact scope",
    );
  }
  return run;
}

/** Optional exact lock for callers whose domain result distinguishes absence. */
export async function lockTaskExecutionRunIfPresentInTransaction(
  transaction: TaskSessionDbTransaction,
  input: TaskExecutionRunIdentity,
): Promise<TaskExecutionRunEnvelope | null> {
  const row = await selectExactRunRow(transaction, input, true);
  return row ? projectRunEnvelope(row) : null;
}

/**
 * Correlated terminal-finalization predicate for a source run whose exact
 * company, task, and run columns are already selected by a caller. Dispatch
 * discovery keeps one atomic SQL selection, while this service remains the
 * sole owner of the canonical run table and its terminal invariant.
 */
export function terminalFinalizedTaskExecutionRunExistsSql(
  companyId: SQLWrapper,
  taskId: SQLWrapper,
  runId: SQLWrapper,
): SQL<boolean> {
  return sql<boolean>`exists (
    select 1
    from ${taskExecutionRuns}
    where ${taskExecutionRuns.companyId} = ${companyId}
      and ${taskExecutionRuns.taskId} = ${taskId}
      and ${taskExecutionRuns.id} = ${runId}
      and ${taskExecutionRuns.terminalFinalizationId} is not null
  )`;
}

/**
 * Resolve every active run currently owning one exact execution ref. The run
 * root remains opaque to the input/admission owners; only canonical envelopes
 * cross this boundary.
 */
export async function lockActiveTaskExecutionRunsForRefInTransaction(
  transaction: TaskSessionDbTransaction,
  input: {
    readonly companyId: string;
    readonly taskId: string;
    readonly sessionId: string;
    readonly refId: string;
  },
): Promise<readonly TaskExecutionRunEnvelope[]> {
  for (const [label, value] of [
    ["company id", input.companyId],
    ["task id", input.taskId],
    ["session id", input.sessionId],
    ["execution ref id", input.refId],
  ] as const) {
    assertExactRunIdentifier(value, label);
  }
  const rows = await transaction
    .select({ run: taskExecutionRuns })
    .from(taskExecutionRunRefs)
    .innerJoin(
      taskExecutionRuns,
      and(
        eq(taskExecutionRuns.id, taskExecutionRunRefs.runId),
        eq(taskExecutionRuns.companyId, taskExecutionRunRefs.companyId),
        eq(taskExecutionRuns.taskId, taskExecutionRunRefs.taskId),
      ),
    )
    .where(
      and(
        eq(taskExecutionRunRefs.companyId, input.companyId),
        eq(taskExecutionRunRefs.taskId, input.taskId),
        eq(taskExecutionRunRefs.sessionId, input.sessionId),
        eq(taskExecutionRunRefs.refId, input.refId),
        inArray(taskExecutionRuns.status, ["queued", "running", "scheduled_retry"]),
      ),
    )
    .orderBy(asc(taskExecutionRuns.createdAt), asc(taskExecutionRuns.id))
    .limit(2)
    .for("update", { of: taskExecutionRuns });
  return Object.freeze(rows.map((row) => projectRunEnvelope(row.run)));
}

export interface LockedTaskExecutionRunRefMembership {
  readonly run: TaskExecutionRunEnvelope;
  readonly refOrdinal: number;
  readonly currentRefId: string | null;
  readonly currentOrdinal: number | null;
}

/**
 * Locks one exact run/member/control tuple without exposing the canonical run
 * table to consult-chain consumers.
 */
export async function lockTaskExecutionRunRefMembershipInTransaction(
  transaction: TaskSessionDbTransaction,
  input: TaskExecutionRunIdentity & { readonly refId: string },
): Promise<LockedTaskExecutionRunRefMembership | null> {
  assertRunIdentity(input);
  assertExactRunIdentifier(input.refId, "execution ref id");
  const rows = await transaction
    .select({
      run: taskExecutionRuns,
      refOrdinal: taskExecutionRunRefs.refOrdinal,
      currentRefId: taskExecutionRunControls.currentRefId,
      currentOrdinal: taskExecutionRunControls.currentOrdinal,
    })
    .from(taskExecutionRuns)
    .innerJoin(
      taskExecutionRunRefs,
      and(
        eq(taskExecutionRunRefs.runId, taskExecutionRuns.id),
        eq(taskExecutionRunRefs.companyId, taskExecutionRuns.companyId),
        eq(taskExecutionRunRefs.taskId, taskExecutionRuns.taskId),
      ),
    )
    .innerJoin(taskExecutionRunControls, eq(taskExecutionRunControls.runId, taskExecutionRuns.id))
    .where(
      and(
        eq(taskExecutionRuns.id, input.runId),
        eq(taskExecutionRuns.companyId, input.companyId),
        eq(taskExecutionRuns.taskId, input.taskId),
        eq(taskExecutionRunRefs.refId, input.refId),
      ),
    )
    .limit(2)
    .for("update");
  if (rows.length > 1) {
    throw new TaskExecutionRunInvariantViolation("task-execution run has ambiguous execution-ref membership");
  }
  const row = rows[0];
  if (!row) return null;
  const run = projectRunEnvelope(row.run);
  assertRunEnvelopeInvariant(run);
  return Object.freeze({
    run,
    refOrdinal: row.refOrdinal,
    currentRefId: row.currentRefId,
    currentOrdinal: row.currentOrdinal,
  });
}

/** Active run membership used to exclude refs already owned by a run. */
export async function readOccupiedTaskExecutionRefIds(
  database: Db | TaskSessionDbTransaction,
  input: {
    readonly companyId?: string;
    readonly taskId?: string;
    readonly sessionId?: string;
    readonly ownershipEpoch?: number;
    readonly targetAgentId?: string;
    readonly refIds?: readonly string[];
  },
): Promise<readonly string[]> {
  for (const [label, value] of [
    ["company id", input.companyId],
    ["task id", input.taskId],
    ["session id", input.sessionId],
    ["target agent id", input.targetAgentId],
  ] as const) {
    if (value !== undefined) assertExactRunIdentifier(value, label);
  }
  if (
    input.ownershipEpoch !== undefined &&
    (!Number.isSafeInteger(input.ownershipEpoch) || input.ownershipEpoch < 1)
  ) {
    throw new TaskExecutionRunInvariantViolation("ownership epoch must be a positive integer");
  }
  const refIds = input.refIds === undefined ? undefined : [...new Set(input.refIds)];
  if (refIds !== undefined) {
    for (const refId of refIds) {
      assertExactRunIdentifier(refId, "execution ref id");
    }
    if (refIds.length === 0) return Object.freeze([]);
  }
  const rows = await database
    .select({ refId: taskExecutionRunRefs.refId })
    .from(taskExecutionRunRefs)
    .innerJoin(
      taskExecutionRuns,
      and(
        eq(taskExecutionRuns.id, taskExecutionRunRefs.runId),
        eq(taskExecutionRuns.companyId, taskExecutionRunRefs.companyId),
        eq(taskExecutionRuns.taskId, taskExecutionRunRefs.taskId),
      ),
    )
    .where(
      and(
        input.companyId === undefined ? undefined : eq(taskExecutionRunRefs.companyId, input.companyId),
        input.taskId === undefined ? undefined : eq(taskExecutionRunRefs.taskId, input.taskId),
        input.sessionId === undefined ? undefined : eq(taskExecutionRunRefs.sessionId, input.sessionId),
        input.ownershipEpoch === undefined
          ? undefined
          : eq(taskExecutionRuns.ownershipEpoch, input.ownershipEpoch),
        input.targetAgentId === undefined
          ? undefined
          : eq(taskExecutionRuns.targetAgentId, input.targetAgentId),
        refIds === undefined ? undefined : inArray(taskExecutionRunRefs.refId, refIds),
        inArray(taskExecutionRuns.status, ["queued", "running", "scheduled_retry"]),
      ),
    );
  return Object.freeze([...new Set(rows.map((row) => row.refId))]);
}

/** Lock the one active productive/consult run for an exact target lane. */
export async function lockActiveProductiveRunForLaneInTransaction(
  transaction: TaskSessionDbTransaction,
  input: TaskExecutionTargetLaneIdentity,
): Promise<TaskExecutionRunEnvelope | null> {
  for (const [label, value] of [
    ["company id", input.companyId],
    ["task id", input.taskId],
    ["session id", input.sessionId],
    ["target agent id", input.targetAgentId],
  ] as const) {
    assertExactRunIdentifier(value, label);
  }
  if (!Number.isSafeInteger(input.ownershipEpoch) || input.ownershipEpoch < 1) {
    throw new TaskExecutionRunInvariantViolation("ownership epoch must be a positive integer");
  }
  const rows = await transaction
    .select({ run: taskExecutionRuns })
    .from(taskExecutionRuns)
    .where(
      and(
        eq(taskExecutionRuns.companyId, input.companyId),
        eq(taskExecutionRuns.taskId, input.taskId),
        eq(taskExecutionRuns.sessionId, input.sessionId),
        eq(taskExecutionRuns.ownershipEpoch, input.ownershipEpoch),
        eq(taskExecutionRuns.targetAgentId, input.targetAgentId),
        inArray(taskExecutionRuns.status, ["queued", "running", "scheduled_retry"]),
        inArray(taskExecutionRuns.kind, ["productive", "consult"]),
      ),
    )
    .orderBy(asc(taskExecutionRuns.createdAt), asc(taskExecutionRuns.id))
    .limit(2)
    .for("update", { of: taskExecutionRuns });
  if (rows.length > 1) {
    throw new TaskExecutionRunInvariantViolation(
      "target lane has more than one active productive/consult run",
    );
  }
  return rows[0] ? projectRunEnvelope(rows[0].run) : null;
}

export interface ActiveTaskExecutionRefRunAvailability {
  readonly run: TaskExecutionRunEnvelope;
  readonly leaseExpiresAt: Date | null;
  readonly retryAt: Date | null;
}

/** Resolve the one active run lifecycle currently attached to a persisted ref. */
export async function readActiveTaskExecutionRefRunAvailability(
  database: Db,
  input: { readonly refId: string },
): Promise<ActiveTaskExecutionRefRunAvailability | null> {
  assertExactRunIdentifier(input.refId, "execution ref id");
  const rows = await database
    .select({
      run: taskExecutionRuns,
      leaseExpiresAt: taskExecutionLeases.expiresAt,
      retryAt: taskExecutionAttemptRetrySchedules.retryAt,
    })
    .from(taskExecutionRunRefs)
    .innerJoin(
      taskExecutionRuns,
      and(
        eq(taskExecutionRuns.id, taskExecutionRunRefs.runId),
        eq(taskExecutionRuns.companyId, taskExecutionRunRefs.companyId),
        eq(taskExecutionRuns.taskId, taskExecutionRunRefs.taskId),
      ),
    )
    .leftJoin(taskExecutionLeases, eq(taskExecutionLeases.id, taskExecutionRuns.currentLeaseId))
    .leftJoin(
      taskExecutionAttemptRetrySchedules,
      and(
        eq(taskExecutionAttemptRetrySchedules.runId, taskExecutionRuns.id),
        eq(taskExecutionAttemptRetrySchedules.state, "scheduled"),
      ),
    )
    .where(
      and(
        eq(taskExecutionRunRefs.refId, input.refId),
        inArray(taskExecutionRuns.status, ["queued", "running", "scheduled_retry"]),
      ),
    )
    .orderBy(desc(taskExecutionRuns.createdAt))
    .limit(2);
  if (rows.length > 1) {
    throw new TaskExecutionRunInvariantViolation("execution ref belongs to multiple active run lifecycles");
  }
  const row = rows[0];
  return row
    ? {
        run: projectRunEnvelope(row.run),
        leaseExpiresAt: row.leaseExpiresAt,
        retryAt: row.retryAt,
      }
    : null;
}
