import {
  companies,
  taskExecutionAttemptRetrySchedules,
  taskExecutionAttempts,
  taskExecutionRefs,
  taskExecutionRunControls,
  tasks,
} from "@paperclipai/db";
import { and, asc, desc, eq, notInArray } from "drizzle-orm";
import {
  publishAgentRunTerminalEvent,
  type AgentRunTerminalPluginEventInput,
} from "./agent-run-plugin-events.js";
import { claimTaskExecutionAttemptRetryInTransaction } from "./task-execution-attempt-retry-schedule-postgres.js";
import { createPostgresTaskExecutionDispatcherRepositoryGroup1 } from "./task-execution-dispatcher-postgres-group-1.js";
import type {
  ExistingRunLeaseResult,
  PostgresTaskExecutionDispatcherRepositoryContext,
} from "./task-execution-dispatcher-postgres-part-6.js";
import {
  AttemptRow,
  LeaseForLaneResult,
  RunRow,
  exactlyOne,
  reject,
} from "./task-execution-dispatcher-postgres-part-1.js";
import {
  assertRefDispatchable,
  consultSourceRunIsFinalized,
} from "./task-execution-dispatcher-postgres-part-3.js";
import {
  createRunForRef,
  createRunningLease,
  currentRunRefs,
  findExistingRunForLane,
} from "./task-execution-dispatcher-postgres-part-4.js";
import { lockLaneLeaseClaim } from "./task-execution-dispatcher-postgres-part-2.js";
import type { TaskExecutionTargetLaneIdentity } from "./task-execution-dispatcher.js";
import {
  activeTaskTreePauseHoldExistsSql,
  lockTaskTreeExecutionGate,
} from "./task-execution-lifecycle-gate.js";
import {
  isTaskExecutionRefDeliveryEligible,
  taskExecutionRefDeliveryEligibilitySql,
} from "./task-execution-ref-delivery.js";
import { readOccupiedTaskExecutionRefIds } from "./task-execution-run-service-part-3-section-1.js";
import { publishTaskExecutionRunState } from "./task-execution-run-wire.js";
import type { TaskSessionDbTransaction } from "./task-session/event-store.js";

export function createPostgresTaskExecutionDispatcherRepositoryGroup2(
  context: PostgresTaskExecutionDispatcherRepositoryContext,
  group1: ReturnType<typeof createPostgresTaskExecutionDispatcherRepositoryGroup1>,
) {
  const options = context;
  const { idFactory, leaseTtlMs } = context;
  const { terminalEventForExpiredRun, recoverExpiredRunInTransaction } = Object.assign({}, group1);
  async function leaseExistingRunInTransaction(
    transaction: TaskSessionDbTransaction,
    input: {
      readonly run: RunRow;
      readonly workerId: string;
      readonly at: Date;
      readonly mode: "owner" | "consult";
    },
  ): Promise<ExistingRunLeaseResult> {
    if (
      input.run.executionMode !== input.mode ||
      input.run.currentAttemptId !== null ||
      input.run.currentLeaseId !== null ||
      input.run.cancellationIntentId !== null
    )
      return { kind: "queued" };
    let pendingAttempt: AttemptRow | undefined;
    let run = input.run;
    if (run.status === "scheduled_retry") {
      const scheduleRows = await transaction
        .select()
        .from(taskExecutionAttemptRetrySchedules)
        .where(
          and(
            eq(taskExecutionAttemptRetrySchedules.runId, run.runId),
            eq(taskExecutionAttemptRetrySchedules.state, "scheduled"),
          ),
        )
        .orderBy(asc(taskExecutionAttemptRetrySchedules.retryAt))
        .limit(2)
        .for("update");
      const schedule = exactlyOne(scheduleRows, "scheduled retry lost its exact due-time owner");
      if (schedule.retryAt > input.at) {
        return { kind: "scheduled", retryAt: schedule.retryAt };
      }
      const claimed = await claimTaskExecutionAttemptRetryInTransaction(transaction, {
        companyId: run.companyId,
        taskId: run.taskId,
        runId: run.runId,
        scheduleId: schedule.id,
        at: input.at,
        successorAttemptId: idFactory(),
        revalidate: async ({ predecessor }) => {
          const ref = exactlyOne(
            await transaction
              .select()
              .from(taskExecutionRefs)
              .where(eq(taskExecutionRefs.id, predecessor.refId!))
              .limit(2),
            "retry lost its immutable ref",
          );
          if (!isTaskExecutionRefDeliveryEligible(ref, "dispatch")) {
            reject("retry ref is no longer delivery-eligible");
          }
        },
      });
      pendingAttempt = claimed.successor;
      run = await options.runService.lockRun(transaction, {
        companyId: run.companyId,
        taskId: run.taskId,
        runId: run.runId,
      });
    }
    if (!pendingAttempt) {
      const pendingRows = await transaction
        .select()
        .from(taskExecutionAttempts)
        .where(and(eq(taskExecutionAttempts.runId, run.runId), eq(taskExecutionAttempts.state, "pending")))
        .orderBy(desc(taskExecutionAttempts.attemptGeneration))
        .limit(2)
        .for("update");
      if (pendingRows.length > 1) {
        reject("retry has more than one pending successor attempt");
      }
      pendingAttempt = pendingRows[0];
    }
    if (run.status === "queued") {
      await options.runService.transitionRunStatus(transaction, {
        companyId: run.companyId,
        taskId: run.taskId,
        runId: run.runId,
        expectedStatus: "queued",
        status: "running",
        startedAt: run.startedAt ?? input.at,
        at: input.at,
      });
      run = {
        ...run,
        status: "running",
        startedAt: run.startedAt ?? input.at,
      };
    }
    if (run.status !== "running") return { kind: "queued" };
    const refs = await currentRunRefs(transaction, run.runId);
    const control = exactlyOne(
      await transaction
        .select()
        .from(taskExecutionRunControls)
        .where(eq(taskExecutionRunControls.runId, run.runId))
        .limit(2)
        .for("update"),
      "active run lost its prompt control",
    );
    const current = refs.find((ref) => ref.id === control.currentRefId);
    if (!current) {
      return { kind: "queued" };
    }
    if (!(await consultSourceRunIsFinalized(transaction, current))) {
      return { kind: "queued" };
    }
    const laneClaim = await lockLaneLeaseClaim(transaction, current, {
      existingRun: true,
    });
    if (!laneClaim) return { kind: "queued" };
    await assertRefDispatchable(transaction, current);
    const lease = await createRunningLease(
      transaction,
      {
        runService: options.runService,
        compiler: options.compiler,
        idFactory,
        leaseTtlMs,
      },
      {
        run,
        refs: [current],
        workerId: input.workerId,
        at: input.at,
        laneClaim,
        ...(pendingAttempt ? { pendingAttempt } : {}),
      },
    );
    const leasedRun = await options.runService.lockRun(transaction, {
      companyId: run.companyId,
      taskId: run.taskId,
      runId: run.runId,
    });
    if (leasedRun.currentAttemptId !== lease.attemptId || leasedRun.currentLeaseId !== lease.leaseId) {
      reject("leased attempt lost its exact canonical run projection");
    }
    return { kind: "leased", lease, run: leasedRun };
  }

  async function leaseForLane(input: {
    readonly lane: TaskExecutionTargetLaneIdentity;
    readonly workerId: string;
    readonly at: Date;
  }): Promise<LeaseForLaneResult> {
    let recoveredTerminalEvent: AgentRunTerminalPluginEventInput | null = null;
    const changedRuns = new Map<
      string,
      { readonly companyId: string; readonly taskId: string; readonly runId: string }
    >();
    const result: LeaseForLaneResult = await options.database.transaction(async (transaction) => {
      await transaction
        .select({ id: companies.id })
        .from(companies)
        .where(eq(companies.id, input.lane.companyId))
        .limit(1)
        .for("update");
      await lockTaskTreeExecutionGate(transaction, input.lane.companyId, input.lane.taskId);
      const paused = await transaction
        .select({
          active: activeTaskTreePauseHoldExistsSql(input.lane.companyId, input.lane.taskId),
        })
        .from(tasks)
        .where(and(eq(tasks.companyId, input.lane.companyId), eq(tasks.id, input.lane.taskId)))
        .limit(1)
        .then((rows) => rows[0]?.active === true);
      if (paused) return { kind: "queued" };
      let existing = await findExistingRunForLane(transaction, input.lane);
      if (existing) {
        const expiredRun = existing;
        const recovered = await recoverExpiredRunInTransaction(transaction, expiredRun, input.at);
        recoveredTerminalEvent = terminalEventForExpiredRun(expiredRun, recovered, input.at);
        if (recovered.kind !== "current") {
          changedRuns.set(expiredRun.runId, expiredRun);
          if (recovered.kind === "released_run" && recovered.retryRun) {
            changedRuns.set(recovered.retryRun.runId, recovered.retryRun);
          }
        }
        if (recovered.kind === "released_run") {
          existing = recovered.retryRun;
        } else {
          existing = recovered.run;
        }
      }
      if (existing) {
        const leased = await leaseExistingRunInTransaction(transaction, {
          run: existing,
          workerId: input.workerId,
          at: input.at,
          mode: existing.executionMode,
        });
        return leased.kind === "scheduled" ? { kind: "queued" } : leased;
      }

      const occupiedRefIds = await readOccupiedTaskExecutionRefIds(transaction, {
        companyId: input.lane.companyId,
        taskId: input.lane.taskId,
        sessionId: input.lane.sessionId,
        ownershipEpoch: input.lane.ownershipEpoch,
        targetAgentId: input.lane.targetAgentId,
      });
      const refRows = await transaction
        .select()
        .from(taskExecutionRefs)
        .where(
          and(
            eq(taskExecutionRefs.companyId, input.lane.companyId),
            eq(taskExecutionRefs.taskId, input.lane.taskId),
            eq(taskExecutionRefs.sessionId, input.lane.sessionId),
            eq(taskExecutionRefs.ownershipEpoch, input.lane.ownershipEpoch),
            eq(taskExecutionRefs.targetAgentId, input.lane.targetAgentId),
            eq(taskExecutionRefs.disposition, "active"),
            taskExecutionRefDeliveryEligibilitySql("dispatch"),
            occupiedRefIds.length === 0 ? undefined : notInArray(taskExecutionRefs.id, [...occupiedRefIds]),
          ),
        )
        .orderBy(asc(taskExecutionRefs.laneOrdinal))
        .limit(1);
      const ref = refRows[0];
      if (!ref) return { kind: "queued" };
      if (!(await consultSourceRunIsFinalized(transaction, ref))) {
        return { kind: "queued" };
      }
      const laneClaim = await lockLaneLeaseClaim(transaction, ref, {
        existingRun: false,
      });
      if (!laneClaim) return { kind: "queued" };
      const created = await createRunForRef(transaction, options, ref, input.at);
      await options.runService.transitionRunStatus(transaction, {
        companyId: created.run.companyId,
        taskId: created.run.taskId,
        runId: created.run.runId,
        expectedStatus: "queued",
        status: "running",
        startedAt: input.at,
        at: input.at,
      });
      const running = {
        ...created.run,
        status: "running" as const,
        startedAt: input.at,
      };
      const lease = await createRunningLease(
        transaction,
        {
          runService: options.runService,
          compiler: options.compiler,
          idFactory,
          leaseTtlMs,
        },
        {
          run: running,
          refs: [created.refs[0]!],
          workerId: input.workerId,
          at: input.at,
          laneClaim,
        },
      );
      const leasedRun = await options.runService.lockRun(transaction, {
        companyId: running.companyId,
        taskId: running.taskId,
        runId: running.runId,
      });
      if (leasedRun.currentAttemptId !== lease.attemptId || leasedRun.currentLeaseId !== lease.leaseId) {
        reject("new lease lost its exact canonical run projection");
      }
      return { kind: "leased", lease, run: leasedRun };
    });
    if (result.kind === "leased") {
      changedRuns.set(result.run.runId, result.run);
    }
    for (const identity of changedRuns.values()) {
      const run = await options.runService.readRun(identity);
      if (!run) reject("leased or recovered run lost its canonical envelope");
      publishTaskExecutionRunState(run);
    }
    if (recoveredTerminalEvent) {
      await publishAgentRunTerminalEvent(options.pluginDomainEvents, recoveredTerminalEvent);
    }
    return result;
  }
  return { leaseExistingRunInTransaction, leaseForLane };
}
