import {
  taskExecutionAttempts,
  taskExecutionAuthorities,
  taskExecutionLeases,
  taskExecutionRefs,
  taskExecutionRunRefs,
  taskExecutionRuns,
  tasks,
  type Db,
  type TaskExecutionRunControl,
  type TaskExecutionRunRef,
} from "@paperclipai/db";
import { and, eq, gt, inArray, isNull, type SQLWrapper } from "drizzle-orm";
import {
  TaskExecutionRunInvariantViolation,
  assertExactRunIdentifier,
  type BoundedTaskExecutionRunRecords,
  type TaskExecutionRunEnvelope,
} from "./task-execution-run-service-part-1-section-1.js";
import type {
  CurrentTaskOwnerRunLinkage,
  ProductiveRunLinkage,
} from "./task-execution-run-service-part-6-section-1.js";
export function currentProductivePromptPredicate(now: Date) {
  return and(
    eq(taskExecutionRuns.kind, "productive"),
    eq(taskExecutionRuns.status, "running"),
    eq(taskExecutionAttempts.state, "running"),
    eq(taskExecutionLeases.state, "active"),
    gt(taskExecutionLeases.expiresAt, now),
    eq(taskExecutionRefs.disposition, "active"),
    isNull(taskExecutionRunRefs.protocolSettlementState),
  );
}

export const productiveRunLinkageSelection = {
  runId: taskExecutionRuns.id,
  runStatus: taskExecutionRuns.status,
  companyId: taskExecutionRuns.companyId,
  agentId: taskExecutionRefs.targetAgentId,
  refId: taskExecutionRefs.id,
  taskId: taskExecutionRefs.taskId,
  projectId: tasks.projectId,
  routineId: tasks.creatorRoutineId,
  sessionId: taskExecutionRefs.sessionId,
  ownershipEpoch: taskExecutionRefs.ownershipEpoch,
  mode: taskExecutionRefs.mode,
  sourceKind: taskExecutionRefs.sourceKind,
  sourceRecordId: taskExecutionRefs.sourceRecordId,
  adapterConfigRevisionId: taskExecutionRefs.adapterConfigRevisionId,
  taskExecutionAuthorityId: taskExecutionRefs.taskExecutionAuthorityId,
  consultExecutionId: taskExecutionRefs.consultExecutionId,
  taskExecutionPolicy: tasks.executionPolicy,
} as const;

export function currentRunAttemptJoinPredicate() {
  return and(
    eq(taskExecutionAttempts.companyId, taskExecutionRuns.companyId),
    eq(taskExecutionAttempts.taskId, taskExecutionRuns.taskId),
    eq(taskExecutionAttempts.runId, taskExecutionRuns.id),
    eq(taskExecutionAttempts.id, taskExecutionRuns.currentAttemptId),
  );
}
export function currentRunLeaseJoinPredicate() {
  return and(
    eq(taskExecutionLeases.companyId, taskExecutionRuns.companyId),
    eq(taskExecutionLeases.taskId, taskExecutionRuns.taskId),
    eq(taskExecutionLeases.runId, taskExecutionRuns.id),
    eq(taskExecutionLeases.attemptId, taskExecutionAttempts.id),
    eq(taskExecutionLeases.id, taskExecutionRuns.currentLeaseId),
  );
}

export function currentRunRefJoinPredicate(...scopePredicates: readonly SQLWrapper[]) {
  return and(
    eq(taskExecutionRefs.companyId, taskExecutionAttempts.companyId),
    eq(taskExecutionRefs.taskId, taskExecutionAttempts.taskId),
    eq(taskExecutionRefs.id, taskExecutionAttempts.refId),
    ...scopePredicates,
  );
}

export function currentRunRefMembershipJoinPredicate() {
  return and(
    eq(taskExecutionRunRefs.companyId, taskExecutionRuns.companyId),
    eq(taskExecutionRunRefs.taskId, taskExecutionRuns.taskId),
    eq(taskExecutionRunRefs.runId, taskExecutionRuns.id),
    eq(taskExecutionRunRefs.refId, taskExecutionAttempts.refId),
    eq(taskExecutionRunRefs.refOrdinal, taskExecutionAttempts.refOrdinal),
  );
}

/** Resolve one active productive run through its exact prompt and lease. */
export async function resolveProductiveRunLinkage(
  database: Db,
  input: {
    readonly runId: string;
    readonly companyId?: string | null;
    readonly agentId?: string | null;
  },
): Promise<ProductiveRunLinkage | null> {
  assertExactRunIdentifier(input.runId, "run id");
  if (input.companyId) assertExactRunIdentifier(input.companyId, "company id");
  if (input.agentId) assertExactRunIdentifier(input.agentId, "agent id");
  const predicates = [
    eq(taskExecutionRuns.id, input.runId),
    currentProductivePromptPredicate(new Date()),
    ...(input.companyId ? [eq(taskExecutionRuns.companyId, input.companyId)] : []),
    ...(input.agentId ? [eq(taskExecutionRefs.targetAgentId, input.agentId)] : []),
  ];
  return database
    .select(productiveRunLinkageSelection)
    .from(taskExecutionRuns)
    .innerJoin(taskExecutionAttempts, currentRunAttemptJoinPredicate())
    .innerJoin(taskExecutionLeases, currentRunLeaseJoinPredicate())
    .innerJoin(
      taskExecutionRefs,
      currentRunRefJoinPredicate(eq(taskExecutionRefs.targetAgentId, taskExecutionRuns.targetAgentId)),
    )
    .innerJoin(taskExecutionRunRefs, currentRunRefMembershipJoinPredicate())
    .innerJoin(
      tasks,
      and(eq(tasks.id, taskExecutionRuns.taskId), eq(tasks.companyId, taskExecutionRuns.companyId)),
    )
    .where(and(...predicates))
    .limit(1)
    .then((rows) => rows[0] ?? null) as Promise<ProductiveRunLinkage | null>;
}

/** Resolve each task's exact current owner prompt, never an historical run. */
export async function resolveCurrentTaskOwnerRunLinkages(
  database: Db,
  input: { readonly companyId: string; readonly taskIds: readonly string[] },
): Promise<Map<string, CurrentTaskOwnerRunLinkage>> {
  assertExactRunIdentifier(input.companyId, "company id");
  const taskIds = [...new Set(input.taskIds)];
  for (const taskId of taskIds) assertExactRunIdentifier(taskId, "task id");
  if (taskIds.length === 0) return new Map();
  const rows = await database
    .select({
      ...productiveRunLinkageSelection,
      startedAt: taskExecutionRuns.startedAt,
      finishedAt: taskExecutionRuns.finishedAt,
      createdAt: taskExecutionRuns.createdAt,
    })
    .from(tasks)
    .innerJoin(
      taskExecutionRuns,
      and(
        eq(taskExecutionRuns.companyId, tasks.companyId),
        eq(taskExecutionRuns.taskId, tasks.id),
        eq(taskExecutionRuns.ownershipEpoch, tasks.ownershipEpoch),
        eq(taskExecutionRuns.targetAgentId, tasks.ownerAgentId),
        eq(taskExecutionRuns.executionMode, "owner"),
      ),
    )
    .innerJoin(taskExecutionAttempts, currentRunAttemptJoinPredicate())
    .innerJoin(taskExecutionLeases, currentRunLeaseJoinPredicate())
    .innerJoin(
      taskExecutionRefs,
      currentRunRefJoinPredicate(
        eq(taskExecutionRefs.ownershipEpoch, tasks.ownershipEpoch),
        eq(taskExecutionRefs.targetAgentId, tasks.ownerAgentId),
        eq(taskExecutionRefs.mode, "owner"),
      ),
    )
    .innerJoin(taskExecutionRunRefs, currentRunRefMembershipJoinPredicate())
    .innerJoin(
      taskExecutionAuthorities,
      and(
        eq(taskExecutionAuthorities.id, taskExecutionRefs.taskExecutionAuthorityId),
        eq(taskExecutionAuthorities.companyId, taskExecutionRefs.companyId),
        eq(taskExecutionAuthorities.taskId, taskExecutionRefs.taskId),
        eq(taskExecutionAuthorities.ownershipEpoch, taskExecutionRefs.ownershipEpoch),
        eq(taskExecutionAuthorities.agentId, taskExecutionRefs.targetAgentId),
        eq(taskExecutionAuthorities.state, "current"),
      ),
    )
    .where(
      and(
        eq(tasks.companyId, input.companyId),
        eq(tasks.ownerKind, "agent"),
        inArray(tasks.id, taskIds),
        currentProductivePromptPredicate(new Date()),
      ),
    );
  const byTaskId = new Map<string, CurrentTaskOwnerRunLinkage>();
  for (const row of rows as CurrentTaskOwnerRunLinkage[]) {
    const previous = byTaskId.get(row.taskId);
    if (!previous || row.createdAt > previous.createdAt) {
      byTaskId.set(row.taskId, row);
    }
  }
  return byTaskId;
}

export function boundedRecords<T>(rows: readonly T[], limit: number): BoundedTaskExecutionRunRecords<T> {
  return {
    items: rows.slice(0, limit),
    truncated: rows.length > limit,
  };
}

export function assertJoinedRunShape(input: {
  readonly run: TaskExecutionRunEnvelope;
  readonly controlRows: readonly TaskExecutionRunControl[];
  readonly refRows: readonly TaskExecutionRunRef[];
  readonly refsTruncated: boolean;
}): void {
  if (input.controlRows.length > 1) {
    throw new TaskExecutionRunInvariantViolation("run joined detail found duplicate singular control owners");
  }
  if (input.controlRows.length !== 1 || input.refRows.length === 0) {
    throw new TaskExecutionRunInvariantViolation(
      "productive or consult run is missing its control or non-empty ref batch",
    );
  }
  const digest = input.refRows[0]!.batchDigest;
  input.refRows.forEach((ref, index) => {
    if (ref.refOrdinal !== index || ref.batchDigest !== digest) {
      throw new TaskExecutionRunInvariantViolation(
        "run ref projection is non-contiguous or crosses batch digests",
      );
    }
  });
  if (!input.refsTruncated) {
    const uniqueRefs = new Set(input.refRows.map((ref) => ref.refId));
    if (uniqueRefs.size !== input.refRows.length) {
      throw new TaskExecutionRunInvariantViolation("run ref projection contains duplicate members");
    }
  }
}
