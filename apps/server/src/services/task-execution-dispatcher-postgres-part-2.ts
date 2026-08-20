import {
  companies,
  taskExecutionLanes,
  taskExecutionLeases,
  taskExecutionRefs,
  taskExecutionRunRefs,
  taskSessions,
  tasks,
} from "@paperclipai/db";
import { and, asc, eq, sql } from "drizzle-orm";
import { contextDialDigest } from "./context-dial-resolver.js";
import { type PostgresPromptCapabilityCompiler } from "./runtime-interface-compiler-db.js";
import {
  type LaneRefIdentity,
  type LockedLaneLeaseClaim,
  type RefRow,
  type RunRow,
  exactlyOne,
  reject,
} from "./task-execution-dispatcher-postgres-part-1.js";
import type { LeasedTaskExecutionRef } from "./task-execution-dispatcher.js";
import type { TaskSessionDbTransaction } from "./task-session/event-store.js";

export async function lockLane(
  transaction: TaskSessionDbTransaction,
  ref: Pick<LaneRefIdentity, "companyId" | "taskId" | "ownershipEpoch" | "targetAgentId">,
) {
  return exactlyOne(
    await transaction
      .select()
      .from(taskExecutionLanes)
      .where(
        and(
          eq(taskExecutionLanes.companyId, ref.companyId),
          eq(taskExecutionLanes.taskId, ref.taskId),
          eq(taskExecutionLanes.ownershipEpoch, ref.ownershipEpoch),
          eq(taskExecutionLanes.targetAgentId, ref.targetAgentId),
        ),
      )
      .limit(2)
      .for("update"),
    "execution ref lost its exact lane",
  );
}

export async function lockLaneParents(
  transaction: TaskSessionDbTransaction,
  ref: Pick<LaneRefIdentity, "companyId" | "taskId"> & {
    readonly sessionId?: string;
  },
): Promise<void> {
  exactlyOne(
    await transaction
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.id, ref.companyId))
      .limit(2)
      .for("update"),
    "execution lane lost its company parent",
  );
  exactlyOne(
    await transaction
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.companyId, ref.companyId), eq(tasks.id, ref.taskId)))
      .limit(2)
      .for("update"),
    "execution lane lost its task parent",
  );
  if (ref.sessionId !== undefined) {
    exactlyOne(
      await transaction
        .select({ id: taskSessions.id })
        .from(taskSessions)
        .where(
          and(
            eq(taskSessions.companyId, ref.companyId),
            eq(taskSessions.taskId, ref.taskId),
            eq(taskSessions.id, ref.sessionId),
          ),
        )
        .limit(2)
        .for("update"),
      "execution lane lost its Session parent",
    );
  }
}

export async function lockLaneLeaseClaim(
  transaction: TaskSessionDbTransaction,
  ref: RefRow,
  options: { readonly existingRun: boolean },
): Promise<LockedLaneLeaseClaim | null> {
  await lockLaneParents(transaction, ref);
  const lane = await lockLane(transaction, ref);
  const laneHead = await transaction
    .select({
      id: taskExecutionRefs.id,
      laneOrdinal: taskExecutionRefs.laneOrdinal,
    })
    .from(taskExecutionRefs)
    .where(
      and(
        eq(taskExecutionRefs.companyId, ref.companyId),
        eq(taskExecutionRefs.taskId, ref.taskId),
        eq(taskExecutionRefs.ownershipEpoch, ref.ownershipEpoch),
        eq(taskExecutionRefs.targetAgentId, ref.targetAgentId),
        eq(taskExecutionRefs.disposition, "active"),
      ),
    )
    .orderBy(asc(taskExecutionRefs.laneOrdinal), asc(taskExecutionRefs.id))
    .limit(1)
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (!laneHead || laneHead.id !== ref.id || laneHead.laneOrdinal !== ref.laneOrdinal) {
    if (options.existingRun) {
      reject("active run no longer owns the exact execution-lane head");
    }
    return null;
  }
  if (lane.activeOrdinal === null) {
    if (lane.activeLeaseGeneration !== null || lane.activeLeaseId !== null) {
      reject("idle execution lane retains an active lease fence");
    }
    return { kind: "idle" };
  }
  if (lane.activeLeaseGeneration === null || lane.activeLeaseId === null) {
    reject("active execution lane lost its lease fence");
  }
  if (!options.existingRun) {
    return null;
  }
  if (lane.activeOrdinal !== ref.laneOrdinal) {
    reject("retry drifted from the lane's exact current ordinal");
  }
  return {
    kind: "retry",
    ordinal: lane.activeOrdinal,
    leaseGeneration: lane.activeLeaseGeneration,
    leaseId: lane.activeLeaseId,
  };
}

export async function clearExactLaneClaim(
  transaction: TaskSessionDbTransaction,
  input: {
    readonly ref: Pick<LaneRefIdentity, "companyId" | "taskId" | "ownershipEpoch" | "targetAgentId">;
    readonly laneOrdinal: number;
    readonly leaseGeneration: number;
    readonly leaseId: string;
    readonly at: Date;
  },
): Promise<void> {
  exactlyOne(
    await transaction
      .update(taskExecutionLanes)
      .set({
        activeOrdinal: null,
        activeLeaseGeneration: null,
        activeLeaseId: null,
        updatedAt: input.at,
      })
      .where(
        and(
          eq(taskExecutionLanes.companyId, input.ref.companyId),
          eq(taskExecutionLanes.taskId, input.ref.taskId),
          eq(taskExecutionLanes.ownershipEpoch, input.ref.ownershipEpoch),
          eq(taskExecutionLanes.targetAgentId, input.ref.targetAgentId),
          eq(taskExecutionLanes.activeOrdinal, input.laneOrdinal),
          eq(taskExecutionLanes.activeLeaseGeneration, input.leaseGeneration),
          eq(taskExecutionLanes.activeLeaseId, input.leaseId),
        ),
      )
      .returning({ companyId: taskExecutionLanes.companyId }),
    "execution lane lost its exact ordinal and lease claim",
  );
}

export async function assertLeaseLaneClaim(
  transaction: TaskSessionDbTransaction,
  lease: LeasedTaskExecutionRef,
  at: Date,
): Promise<void> {
  await lockLaneParents(transaction, lease.ref);
  const lane = await lockLane(transaction, lease.ref);
  const persistedRef = exactlyOne(
    await transaction
      .select()
      .from(taskExecutionRefs)
      .where(eq(taskExecutionRefs.id, lease.ref.id))
      .limit(2)
      .for("update"),
    "lease lost its persisted execution ref",
  );
  const member = exactlyOne(
    await transaction
      .select({ admissionOrder: taskExecutionRunRefs.admissionOrder })
      .from(taskExecutionRunRefs)
      .where(
        and(
          eq(taskExecutionRunRefs.runId, lease.runId),
          eq(taskExecutionRunRefs.refId, lease.ref.id),
          eq(taskExecutionRunRefs.refOrdinal, lease.refOrdinal),
        ),
      )
      .limit(2)
      .for("update"),
    "lease lost its exact run member",
  );
  const persistedLease = exactlyOne(
    await transaction
      .select()
      .from(taskExecutionLeases)
      .where(eq(taskExecutionLeases.id, lease.leaseId))
      .limit(2)
      .for("update"),
    "lease lost its exact persisted authority",
  );
  if (
    member.admissionOrder !== persistedRef.laneOrdinal ||
    lane.activeOrdinal !== member.admissionOrder ||
    lane.activeLeaseGeneration !== lease.leaseGeneration ||
    lane.activeLeaseId !== lease.leaseId ||
    persistedLease.attemptId !== lease.attemptId ||
    persistedLease.leaseGeneration !== lease.leaseGeneration ||
    persistedLease.state !== "active" ||
    persistedLease.expiresAt <= at
  ) {
    reject("lease no longer owns the exact lane claim");
  }
}

export async function lockRunLaneClaimIfPresent(
  transaction: TaskSessionDbTransaction,
  runId: string,
): Promise<{
  readonly ref: LaneRefIdentity;
  readonly laneOrdinal: number;
  readonly leaseGeneration: number;
  readonly leaseId: string;
} | null> {
  const rows = await transaction
    .select({
      ref: taskExecutionRefs,
      laneOrdinal: taskExecutionLanes.activeOrdinal,
      leaseGeneration: taskExecutionLanes.activeLeaseGeneration,
      leaseId: taskExecutionLanes.activeLeaseId,
    })
    .from(taskExecutionLanes)
    .innerJoin(
      taskExecutionRefs,
      and(
        eq(taskExecutionRefs.companyId, taskExecutionLanes.companyId),
        eq(taskExecutionRefs.taskId, taskExecutionLanes.taskId),
        eq(taskExecutionRefs.ownershipEpoch, taskExecutionLanes.ownershipEpoch),
        eq(taskExecutionRefs.targetAgentId, taskExecutionLanes.targetAgentId),
        sql`${taskExecutionRefs.laneOrdinal} = ${taskExecutionLanes.activeOrdinal}`,
      ),
    )
    .innerJoin(
      taskExecutionRunRefs,
      and(eq(taskExecutionRunRefs.runId, runId), eq(taskExecutionRunRefs.refId, taskExecutionRefs.id)),
    )
    .innerJoin(
      taskExecutionLeases,
      and(
        eq(taskExecutionLeases.id, taskExecutionLanes.activeLeaseId),
        eq(taskExecutionLeases.runId, taskExecutionRunRefs.runId),
      ),
    )
    .limit(2);
  if (rows.length === 0) return null;
  const claim = exactlyOne(rows, "run owns more than one active lane claim");
  if (claim.laneOrdinal === null || claim.leaseGeneration === null || claim.leaseId === null) {
    reject("active run lane claim is incomplete");
  }
  await lockLaneParents(transaction, claim.ref);
  const lane = await lockLane(transaction, claim.ref);
  if (
    lane.activeOrdinal !== claim.laneOrdinal ||
    lane.activeLeaseGeneration !== claim.leaseGeneration ||
    lane.activeLeaseId !== claim.leaseId
  ) {
    reject("run lane claim changed while acquiring its canonical lock order");
  }
  return {
    ref: claim.ref,
    laneOrdinal: claim.laneOrdinal,
    leaseGeneration: claim.leaseGeneration,
    leaseId: claim.leaseId,
  };
}

export async function compileCarryContext(
  compiler: Pick<PostgresPromptCapabilityCompiler, "resolve">,
  run: RunRow,
): Promise<{
  readonly carryContext: boolean;
  readonly exposureDigest: string;
}> {
  const compiled = await compiler.resolve({
    companyId: run.companyId,
    taskId: run.taskId,
    ownershipEpoch: run.ownershipEpoch,
    targetAgentId: run.targetAgentId,
    executionMode: run.executionMode,
    taskExecutionAuthorityId: run.taskExecutionAuthorityId,
    consultExecutionId: run.consultExecutionId,
  });
  return {
    carryContext: compiled.contextDial.carry_context,
    exposureDigest: contextDialDigest(compiled.contextDial),
  };
}
