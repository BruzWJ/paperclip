import {
  companies,
  taskExecutionCancellationIntents,
  taskExecutionFinalizations,
  taskExecutionRefs,
  taskExecutionRuns,
  type Db,
} from "@paperclipai/db";
import { type TaskExecutionRunStatus } from "@paperclipai/shared";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  type AttachTaskExecutionRunCancellationInput,
  type AttachTaskExecutionRunFinalizationInput,
  type DetachTaskExecutionRunCancellationInput,
  type TaskExecutionRunEnvelope,
  type TaskExecutionRunListCursor,
  type TaskExecutionRunListPage,
  MAX_RUN_LIST_PAGE_SIZE,
  TaskExecutionRunInvariantViolation,
  assertDate,
  assertExactRunIdentifier,
  assertRunIdentity,
  assertPageLimit,
} from "./task-execution-run-service-part-1-section-1.js";
import { assertRunStatusFilter, projectRunEnvelope } from "./task-execution-run-service-part-2-section-1.js";
import type { TaskSessionDbTransaction } from "./task-session/event-store.js";

export async function attachTaskExecutionRunCancellationInTransaction(
  transaction: TaskSessionDbTransaction,
  input: AttachTaskExecutionRunCancellationInput,
): Promise<TaskExecutionRunEnvelope> {
  assertRunIdentity(input);
  assertExactRunIdentifier(input.expectedAttemptId, "expected attempt id");
  assertExactRunIdentifier(input.expectedLeaseId, "expected lease id");
  assertExactRunIdentifier(input.cancellationIntentId, "cancellation intent id");
  assertDate(input.at, "cancellation attachment time");
  const cancellations = await transaction
    .select({
      attemptId: taskExecutionCancellationIntents.attemptId,
      leaseId: taskExecutionCancellationIntents.leaseId,
      state: taskExecutionCancellationIntents.state,
    })
    .from(taskExecutionCancellationIntents)
    .where(
      and(
        eq(taskExecutionCancellationIntents.id, input.cancellationIntentId),
        eq(taskExecutionCancellationIntents.companyId, input.companyId),
        eq(taskExecutionCancellationIntents.taskId, input.taskId),
        eq(taskExecutionCancellationIntents.runId, input.runId),
      ),
    )
    .limit(1)
    .for("update");
  if (
    !cancellations[0] ||
    cancellations[0].attemptId !== input.expectedAttemptId ||
    cancellations[0].leaseId !== input.expectedLeaseId ||
    cancellations[0].state !== "requested"
  ) {
    throw new TaskExecutionRunInvariantViolation(
      "run cancellation attachment does not target its exact requested attempt/lease intent",
    );
  }
  const changed = await transaction
    .update(taskExecutionRuns)
    .set({
      cancellationIntentId: input.cancellationIntentId,
      updatedAt: input.at,
    })
    .where(
      and(
        eq(taskExecutionRuns.id, input.runId),
        eq(taskExecutionRuns.companyId, input.companyId),
        eq(taskExecutionRuns.taskId, input.taskId),
        eq(taskExecutionRuns.status, "running"),
        eq(taskExecutionRuns.currentAttemptId, input.expectedAttemptId),
        eq(taskExecutionRuns.currentLeaseId, input.expectedLeaseId),
        isNull(taskExecutionRuns.cancellationIntentId),
        isNull(taskExecutionRuns.terminalFinalizationId),
        isNull(taskExecutionRuns.finishedAt),
      ),
    )
    .returning();
  if (!changed[0]) {
    throw new TaskExecutionRunInvariantViolation("run cannot attach the selected cancellation intent");
  }
  return projectRunEnvelope(changed[0]);
}

export async function detachTaskExecutionRunCancellationInTransaction(
  transaction: TaskSessionDbTransaction,
  input: DetachTaskExecutionRunCancellationInput,
): Promise<TaskExecutionRunEnvelope> {
  assertRunIdentity(input);
  assertExactRunIdentifier(input.expectedCancellationIntentId, "expected cancellation intent id");
  assertDate(input.at, "cancellation detachment time");
  const cancellations = await transaction
    .select({ state: taskExecutionCancellationIntents.state })
    .from(taskExecutionCancellationIntents)
    .where(
      and(
        eq(taskExecutionCancellationIntents.id, input.expectedCancellationIntentId),
        eq(taskExecutionCancellationIntents.companyId, input.companyId),
        eq(taskExecutionCancellationIntents.taskId, input.taskId),
        eq(taskExecutionCancellationIntents.runId, input.runId),
      ),
    )
    .limit(1)
    .for("update");
  if (!cancellations[0] || cancellations[0].state !== "completed") {
    throw new TaskExecutionRunInvariantViolation(
      "run cancellation detachment requires its exact completed intent",
    );
  }
  const changed = await transaction
    .update(taskExecutionRuns)
    .set({ cancellationIntentId: null, updatedAt: input.at })
    .where(
      and(
        eq(taskExecutionRuns.id, input.runId),
        eq(taskExecutionRuns.companyId, input.companyId),
        eq(taskExecutionRuns.taskId, input.taskId),
        eq(taskExecutionRuns.status, "running"),
        eq(taskExecutionRuns.cancellationIntentId, input.expectedCancellationIntentId),
        isNull(taskExecutionRuns.terminalFinalizationId),
        isNull(taskExecutionRuns.finishedAt),
      ),
    )
    .returning();
  if (!changed[0]) {
    throw new TaskExecutionRunInvariantViolation("run cannot detach a stale cancellation intent");
  }
  return projectRunEnvelope(changed[0]);
}

export async function attachTaskExecutionRunFinalizationInTransaction(
  transaction: TaskSessionDbTransaction,
  input: AttachTaskExecutionRunFinalizationInput,
): Promise<TaskExecutionRunEnvelope> {
  assertRunIdentity(input);
  assertExactRunIdentifier(input.finalizationId, "finalization id");
  assertDate(input.finishedAt, "run finish time");
  assertDate(input.at, "finalization attachment time");
  if (
    input.at < input.finishedAt ||
    input.terminalReasonCode.length < 1 ||
    input.terminalReasonCode.length > 200 ||
    input.terminalReasonCode !== input.terminalReasonCode.trim()
  ) {
    throw new TaskExecutionRunInvariantViolation("run terminal reason or time is invalid");
  }
  const finalizations = await transaction
    .select({
      id: taskExecutionFinalizations.id,
      finalizedAt: taskExecutionFinalizations.finalizedAt,
    })
    .from(taskExecutionFinalizations)
    .where(
      and(
        eq(taskExecutionFinalizations.id, input.finalizationId),
        eq(taskExecutionFinalizations.companyId, input.companyId),
        eq(taskExecutionFinalizations.runId, input.runId),
      ),
    )
    .limit(1)
    .for("update");
  if (!finalizations[0] || finalizations[0].finalizedAt > input.at) {
    throw new TaskExecutionRunInvariantViolation(
      "terminal run requires its exact already-persisted finalization",
    );
  }
  const changed = await transaction
    .update(taskExecutionRuns)
    .set({
      status: input.status,
      terminalFinalizationId: input.finalizationId,
      finishedAt: input.finishedAt,
      terminalClassification: input.status,
      terminalReasonCode: input.terminalReasonCode,
      updatedAt: input.at,
    })
    .where(
      and(
        eq(taskExecutionRuns.id, input.runId),
        eq(taskExecutionRuns.companyId, input.companyId),
        eq(taskExecutionRuns.taskId, input.taskId),
        eq(taskExecutionRuns.status, input.expectedStatus),
        isNull(taskExecutionRuns.currentAttemptId),
        isNull(taskExecutionRuns.currentLeaseId),
        isNull(taskExecutionRuns.cancellationIntentId),
        isNull(taskExecutionRuns.terminalFinalizationId),
        isNull(taskExecutionRuns.finishedAt),
      ),
    )
    .returning();
  if (!changed[0]) {
    throw new TaskExecutionRunInvariantViolation("run finalization lost its exact active lifecycle fence");
  }
  return projectRunEnvelope(changed[0]);
}

export function runListCursorPredicate(cursor: TaskExecutionRunListCursor) {
  if (
    cursor.createdAt.length === 0 ||
    cursor.createdAt !== cursor.createdAt.trim() ||
    !Number.isFinite(new Date(cursor.createdAt).getTime())
  ) {
    throw new TaskExecutionRunInvariantViolation("run list cursor time must be an exact valid timestamp");
  }
  assertExactRunIdentifier(cursor.runId, "run list cursor id");
  return sql`(${taskExecutionRuns.createdAt}, ${taskExecutionRuns.id}) < (${cursor.createdAt}::timestamptz, ${cursor.runId}::uuid)`;
}

export async function listTaskExecutionRunPage(
  database: Db,
  input: {
    readonly predicates: readonly ReturnType<typeof eq>[];
    readonly statuses?: readonly TaskExecutionRunStatus[];
    readonly cursor?: TaskExecutionRunListCursor | null;
    readonly limit: number;
  },
): Promise<TaskExecutionRunListPage> {
  assertPageLimit(input.limit, MAX_RUN_LIST_PAGE_SIZE, "run list limit");
  assertRunStatusFilter(input.statuses);
  const rows = await database
    .select({
      run: taskExecutionRuns,
      exactCreatedAt: sql<string>`${taskExecutionRuns.createdAt}::text`,
    })
    .from(taskExecutionRuns)
    .where(
      and(
        ...input.predicates,
        ...(input.statuses ? [inArray(taskExecutionRuns.status, [...input.statuses])] : []),
        ...(input.cursor ? [runListCursorPredicate(input.cursor)] : []),
      ),
    )
    .orderBy(desc(taskExecutionRuns.createdAt), desc(taskExecutionRuns.id))
    .limit(input.limit + 1);
  const hasMore = rows.length > input.limit;
  const selected = rows.slice(0, input.limit);
  const items = selected.map((row) => projectRunEnvelope(row.run));
  const last = hasMore ? selected[selected.length - 1] : undefined;
  return {
    items,
    nextCursor: last ? { createdAt: last.exactCreatedAt, runId: last.run.id } : null,
  };
}

export async function listTaskExecutionRunsForTask(
  database: Db,
  input: {
    readonly companyId: string;
    readonly taskId: string;
    readonly statuses?: readonly TaskExecutionRunStatus[];
    readonly cursor?: TaskExecutionRunListCursor | null;
    readonly limit: number;
  },
): Promise<TaskExecutionRunListPage> {
  assertExactRunIdentifier(input.companyId, "company id");
  assertExactRunIdentifier(input.taskId, "task id");
  return listTaskExecutionRunPage(database, {
    predicates: [
      eq(taskExecutionRuns.companyId, input.companyId),
      eq(taskExecutionRuns.taskId, input.taskId),
    ],
    statuses: input.statuses,
    cursor: input.cursor,
    limit: input.limit,
  });
}

export async function listTaskExecutionRunsForAgent(
  database: Db,
  input: {
    readonly companyId: string;
    readonly targetAgentId: string;
    readonly statuses?: readonly TaskExecutionRunStatus[];
    readonly cursor?: TaskExecutionRunListCursor | null;
    readonly limit: number;
  },
): Promise<TaskExecutionRunListPage> {
  assertExactRunIdentifier(input.companyId, "company id");
  assertExactRunIdentifier(input.targetAgentId, "target agent id");
  return listTaskExecutionRunPage(database, {
    predicates: [
      eq(taskExecutionRuns.companyId, input.companyId),
      eq(taskExecutionRuns.targetAgentId, input.targetAgentId),
    ],
    statuses: input.statuses,
    cursor: input.cursor,
    limit: input.limit,
  });
}

/** Company activity consumes the same envelope bytes as every other list. */
export async function listTaskExecutionRunsForActivity(
  database: Db,
  input: {
    readonly companyId: string;
    readonly statuses?: readonly TaskExecutionRunStatus[];
    readonly cursor?: TaskExecutionRunListCursor | null;
    readonly limit: number;
  },
): Promise<TaskExecutionRunListPage> {
  assertExactRunIdentifier(input.companyId, "company id");
  return listTaskExecutionRunPage(database, {
    predicates: [eq(taskExecutionRuns.companyId, input.companyId)],
    statuses: input.statuses,
    cursor: input.cursor,
    limit: input.limit,
  });
}

/** Work timeline is deliberately task-scoped rather than a polymorphic list. */
export async function listTaskExecutionRunsForWorkTimeline(
  database: Db,
  input: {
    readonly companyId: string;
    readonly taskId: string;
    readonly statuses?: readonly TaskExecutionRunStatus[];
    readonly cursor?: TaskExecutionRunListCursor | null;
    readonly limit: number;
  },
): Promise<TaskExecutionRunListPage> {
  return listTaskExecutionRunsForTask(database, input);
}

/** Distinct task roots currently owning an active productive owner run. */
export async function listLiveOwnerTaskIds(
  database: Db | TaskSessionDbTransaction,
  input: { readonly companyId: string },
): Promise<readonly string[]> {
  assertExactRunIdentifier(input.companyId, "company id");
  const rows = await database
    .selectDistinct({ taskId: taskExecutionRuns.taskId })
    .from(taskExecutionRuns)
    .where(
      and(
        eq(taskExecutionRuns.companyId, input.companyId),
        eq(taskExecutionRuns.kind, "productive"),
        eq(taskExecutionRuns.executionMode, "owner"),
        inArray(taskExecutionRuns.status, ["queued", "scheduled_retry", "running"]),
      ),
    );
  return Object.freeze(rows.map((row) => row.taskId));
}

export interface ProductiveRunLinkage {
  readonly runId: string;
  readonly runStatus: "running";
  readonly companyId: string;
  readonly agentId: string;
  readonly refId: string;
  readonly taskId: string;
  readonly projectId: string | null;
  readonly routineId: string | null;
  readonly sessionId: string;
  readonly ownershipEpoch: number;
  readonly mode: "owner" | "consult";
  readonly sourceKind: typeof taskExecutionRefs.$inferSelect.sourceKind;
  readonly sourceRecordId: string;
  readonly adapterConfigRevisionId: string;
  readonly taskExecutionAuthorityId: string | null;
  readonly consultExecutionId: string | null;
  readonly taskExecutionPolicy: Record<string, unknown> | null;
}

export interface CurrentTaskOwnerRunLinkage extends ProductiveRunLinkage {
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
  readonly createdAt: Date;
}

const ACTIVE_RUN_STATUSES = ["queued", "scheduled_retry", "running"] as const;

export async function countActiveTaskExecutionRuns(db: Db): Promise<number> {
  const companyRows = await db.select({ id: companies.id }).from(companies);
  let total = 0;
  for (const company of companyRows) {
    let cursor: TaskExecutionRunListCursor | null = null;
    do {
      const page = await listTaskExecutionRunsForActivity(db, {
        companyId: company.id,
        statuses: ACTIVE_RUN_STATUSES,
        cursor,
        limit: 200,
      });
      total += page.items.length;
      cursor = page.nextCursor;
    } while (cursor !== null);
  }
  return total;
}
