import { randomUUID } from "node:crypto";
import { createTaskExecutionDispatcherDiscoveryMethods } from "./task-execution-dispatcher-postgres-discovery-methods.js";
import { createPostgresTaskExecutionDispatcherRepositoryGroup1 } from "./task-execution-dispatcher-postgres-group-1.js";
import { createPostgresTaskExecutionDispatcherRepositoryGroup2 } from "./task-execution-dispatcher-postgres-group-2.js";
import { createPostgresTaskExecutionDispatcherRepositoryGroup3 } from "./task-execution-dispatcher-postgres-group-3.js";
import * as dispatcherCore from "./task-execution-dispatcher-postgres-part-1.js";
import type {
  TaskExecutionDispatcherRepository,
  TaskExecutionTerminal,
  LeasedTaskExecutionRef,
  TaskExecutionRetry,
} from "./task-execution-dispatcher.js";
import type { TaskSessionDbTransaction } from "./task-session/event-store.js";

import {
  taskExecutionAttempts,
  taskExecutionCancellationIntents,
  taskExecutionLanes,
  taskExecutionRefs,
} from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { publishAgentRunTerminalEvent } from "./agent-run-plugin-events.js";
import { scheduleTaskExecutionAttemptRetryInTransaction } from "./task-execution-attempt-retry-schedule-postgres.js";
import {
  assertLeaseLaneClaim,
  lockLane,
  lockLaneParents,
} from "./task-execution-dispatcher-postgres-part-2.js";
import {
  completeTerminalPromptInTransaction,
  releaseAttempt,
} from "./task-execution-dispatcher-postgres-part-5.js";
import { readTaskExecutionLeaseBinding } from "./task-execution-run-service-part-4-section-1.js";
import { publishTaskExecutionRunState } from "./task-execution-run-wire.js";

export function createTaskExecutionDispatcherSettlementMethods(
  options: dispatcherCore.PostgresTaskExecutionDispatcherRepositoryOptions,
  context: { readonly now: () => Date; readonly idFactory: () => string } & Pick<
    ReturnType<typeof createPostgresTaskExecutionDispatcherRepositoryGroup3>,
    "terminalizeDetachedCancelledRunInTransaction" | "fenceRevokedExecutionAuthorityInTransaction"
  >,
) {
  const {
    now,
    idFactory,
    terminalizeDetachedCancelledRunInTransaction,
    fenceRevokedExecutionAuthorityInTransaction,
  } = context;
  async function publishCurrentRunState(input: { companyId: string; taskId: string; runId: string }) {
    const run = await options.runService.readRun(input);
    if (!run) dispatcherCore.reject("settled run lost its canonical envelope");
    publishTaskExecutionRunState(run);
    return run;
  }
  return {
    async assertLeaseCurrent(lease: LeasedTaskExecutionRef) {
      const [row, laneRows] = await Promise.all([
        readTaskExecutionLeaseBinding(options.database, {
          companyId: lease.ref.companyId,
          taskId: lease.ref.taskId,
          runId: lease.runId,
          attemptId: lease.attemptId,
          leaseId: lease.leaseId,
        }),
        options.database
          .select({
            activeOrdinal: taskExecutionLanes.activeOrdinal,
            activeLeaseGeneration: taskExecutionLanes.activeLeaseGeneration,
            activeLeaseId: taskExecutionLanes.activeLeaseId,
            laneOrdinal: taskExecutionRefs.laneOrdinal,
          })
          .from(taskExecutionRefs)
          .innerJoin(
            taskExecutionLanes,
            and(
              eq(taskExecutionLanes.companyId, taskExecutionRefs.companyId),
              eq(taskExecutionLanes.taskId, taskExecutionRefs.taskId),
              eq(taskExecutionLanes.ownershipEpoch, taskExecutionRefs.ownershipEpoch),
              eq(taskExecutionLanes.targetAgentId, taskExecutionRefs.targetAgentId),
            ),
          )
          .where(eq(taskExecutionRefs.id, lease.ref.id))
          .limit(2),
      ]);
      if (!row) dispatcherCore.reject("attempt lease is no longer resolvable");
      const lane = dispatcherCore.exactlyOne(laneRows, "attempt lease lost its exact execution lane");
      if (
        row.run.status !== "running" ||
        row.run.currentAttemptId !== lease.attemptId ||
        row.run.currentLeaseId !== lease.leaseId ||
        row.attemptState !== "running" ||
        row.leaseState !== "active" ||
        row.leaseGeneration !== lease.leaseGeneration ||
        row.leaseExpiresAt <= now() ||
        row.currentRefId !== lease.ref.id ||
        lane.activeOrdinal !== lane.laneOrdinal ||
        lane.activeLeaseGeneration !== lease.leaseGeneration ||
        lane.activeLeaseId !== lease.leaseId
      )
        dispatcherCore.reject("attempt lease is no longer current");
    },
    async markRetryable(input: {
      lease: LeasedTaskExecutionRef;
      reason: TaskExecutionRetry["reason"];
      retryAt: Date;
    }) {
      const at = dispatcherCore.validDate(now(), "retry settlement time");
      await options.database.transaction(async (transaction) => {
        await lockLaneParents(transaction, input.lease.ref);
        await lockLane(transaction, input.lease.ref);
        const run = await options.runService.lockRun(transaction, input.lease);
        if (run.cancellationIntentId !== null) {
          dispatcherCore.reject("a cancellation-bound attempt cannot enter retry");
        }
        await assertLeaseLaneClaim(transaction, input.lease, at);
        await releaseAttempt(transaction, options, input.lease, "failed", at, true);
        await scheduleTaskExecutionAttemptRetryInTransaction(transaction, {
          id: idFactory(),
          companyId: input.lease.ref.companyId,
          taskId: input.lease.ref.taskId,
          runId: input.lease.runId,
          predecessorAttemptId: input.lease.attemptId,
          reasonCode: input.reason,
          retryAt: dispatcherCore.validDate(input.retryAt, "retry due time"),
          at,
        });
      });
      await publishCurrentRunState(input.lease);
    },
    async markTerminal(input: {
      lease: LeasedTaskExecutionRef;
      outcome: TaskExecutionTerminal["outcome"];
      reason: string | null;
      finishedAt: Date;
    }) {
      const at = dispatcherCore.validDate(input.finishedAt, "attempt terminal time");
      const settlement = await options.database.transaction(async (transaction) => {
        await lockLaneParents(transaction, input.lease.ref);
        await lockLane(transaction, input.lease.ref);
        const run = await options.runService.lockRun(transaction, input.lease);
        await assertLeaseLaneClaim(transaction, input.lease, at);
        const cancellation = run.cancellationIntentId
          ? dispatcherCore.exactlyOne(
              await transaction
                .select()
                .from(taskExecutionCancellationIntents)
                .where(eq(taskExecutionCancellationIntents.id, run.cancellationIntentId))
                .limit(2)
                .for("update"),
              "run lost its attached cancellation intent",
            )
          : null;
        const attemptState =
          input.outcome === "succeeded"
            ? ("settled" as const)
            : input.outcome === "cancelled"
              ? ("cancelled" as const)
              : ("failed" as const);
        await releaseAttempt(transaction, options, input.lease, attemptState, at, cancellation === null);
        let completed: Awaited<ReturnType<typeof completeTerminalPromptInTransaction>>;
        if (cancellation) {
          completed = {
            finalization: null,
            laneReleased: false,
            autoCaptureRefId: null,
          };
        } else {
          const attempt = dispatcherCore.exactlyOne(
            await transaction
              .select()
              .from(taskExecutionAttempts)
              .where(eq(taskExecutionAttempts.id, input.lease.attemptId))
              .limit(2)
              .for("update"),
            "terminal attempt disappeared",
          );
          completed = await completeTerminalPromptInTransaction(transaction, options, {
            lease: input.lease,
            attempt,
            outcome: input.outcome,
            reason: input.reason,
            at,
            idFactory,
          });
        }
        return completed;
      });
      await publishCurrentRunState(input.lease);
      if (settlement.finalization) {
        await publishAgentRunTerminalEvent(options.pluginDomainEvents, {
          companyId: settlement.finalization.companyId,
          taskId: settlement.finalization.taskId,
          runId: settlement.finalization.runId,
          agentId: input.lease.ref.targetAgentId,
          outcome: settlement.finalization.status,
          reason: input.reason,
          occurredAt: settlement.finalization.finishedAt,
        });
      }
      if (settlement.autoCaptureRefId && options.dispatchRef) {
        void options.dispatchRef(settlement.autoCaptureRefId);
      }
      return {
        laneReleased: settlement.laneReleased,
      };
    },
    async terminalizeCancelledRun(input: {
      companyId: string;
      taskId: string;
      runId: string;
      reason: string;
      finishedAt: Date;
    }) {
      const terminalized = await options.database.transaction((transaction) =>
        terminalizeDetachedCancelledRunInTransaction(transaction, input),
      );
      if (!terminalized) return;
      const run = await publishCurrentRunState(input);
      await publishAgentRunTerminalEvent(options.pluginDomainEvents, {
        companyId: input.companyId,
        taskId: input.taskId,
        runId: input.runId,
        agentId: run.targetAgentId,
        outcome: "cancelled",
        reason: input.reason,
        occurredAt: input.finishedAt,
      });
    },
    terminalizeDetachedCancelledRunInTransaction,
    fenceRevokedExecutionAuthorityInTransaction,
  };
}

export type ExpiredRunRecovery =
  | { readonly kind: "current"; readonly run: dispatcherCore.RunRow }
  | { readonly kind: "retry_same_run"; readonly run: dispatcherCore.RunRow }
  | {
      readonly kind: "released_run";
      readonly retryRun: dispatcherCore.RunRow | null;
      readonly terminal: TaskExecutionTerminal;
    };

export type ExistingRunLeaseResult =
  dispatcherCore.LeaseForLaneResult | { readonly kind: "scheduled"; readonly retryAt: Date };

export type PostgresTaskExecutionDispatcherRepositoryContext =
  dispatcherCore.PostgresTaskExecutionDispatcherRepositoryOptions & {
    readonly now: () => Date;
    readonly idFactory: () => string;
    readonly leaseTtlMs: number;
  };

export function createPostgresTaskExecutionDispatcherRepository(
  options: dispatcherCore.PostgresTaskExecutionDispatcherRepositoryOptions,
): TaskExecutionDispatcherRepository & {
  readonly terminalizeCancelledRun: (input: {
    readonly companyId: string;
    readonly taskId: string;
    readonly runId: string;
    readonly reason: string;
    readonly finishedAt: Date;
  }) => Promise<void>;
  readonly terminalizeDetachedCancelledRunInTransaction: (
    transaction: TaskSessionDbTransaction,
    input: {
      readonly companyId: string;
      readonly taskId: string;
      readonly runId: string;
      readonly reason: string;
      readonly finishedAt: Date;
    },
  ) => Promise<boolean>;
  readonly fenceRevokedExecutionAuthorityInTransaction: (
    transaction: TaskSessionDbTransaction,
    input: {
      readonly companyId: string;
      readonly selector: dispatcherCore.TaskExecutionAuthorityFenceSelector;
      readonly reason: string;
      readonly at: Date;
    },
  ) => Promise<dispatcherCore.FencedTaskExecutionAuthority>;
} {
  const now = options.now ?? (() => new Date());
  const idFactory = options.idFactory ?? randomUUID;
  const leaseTtlMs = options.leaseTtlMs ?? dispatcherCore.DEFAULT_LEASE_TTL_MS;
  if (!Number.isSafeInteger(leaseTtlMs) || leaseTtlMs < 1000) {
    dispatcherCore.reject("attempt lease TTL must be at least one second");
  }
  const groupContext: PostgresTaskExecutionDispatcherRepositoryContext = {
    ...options,
    now,
    idFactory,
    leaseTtlMs,
  };
  const group1 = createPostgresTaskExecutionDispatcherRepositoryGroup1(groupContext);
  const group2 = createPostgresTaskExecutionDispatcherRepositoryGroup2(groupContext, group1);
  const group3 = createPostgresTaskExecutionDispatcherRepositoryGroup3(groupContext, group1, group2);
  const { terminalEventForExpiredRun, recoverExpiredRunInTransaction } = group1;
  const { leaseForLane } = group2;
  const { terminalizeDetachedCancelledRunInTransaction, fenceRevokedExecutionAuthorityInTransaction } =
    group3;
  const repository = {
    ...createTaskExecutionDispatcherDiscoveryMethods(options, {
      terminalEventForExpiredRun,
      recoverExpiredRunInTransaction,
      leaseForLane,
    }),
    ...createTaskExecutionDispatcherSettlementMethods(options, {
      now,
      idFactory,
      terminalizeDetachedCancelledRunInTransaction,
      fenceRevokedExecutionAuthorityInTransaction,
    }),
  } satisfies TaskExecutionDispatcherRepository & {
    terminalizeCancelledRun(input: {
      companyId: string;
      taskId: string;
      runId: string;
      reason: string;
      finishedAt: Date;
    }): Promise<void>;
    terminalizeDetachedCancelledRunInTransaction(
      transaction: TaskSessionDbTransaction,
      input: {
        companyId: string;
        taskId: string;
        runId: string;
        reason: string;
        finishedAt: Date;
      },
    ): Promise<boolean>;
    fenceRevokedExecutionAuthorityInTransaction(
      transaction: TaskSessionDbTransaction,
      input: {
        companyId: string;
        selector: dispatcherCore.TaskExecutionAuthorityFenceSelector;
        reason: string;
        at: Date;
      },
    ): Promise<dispatcherCore.FencedTaskExecutionAuthority>;
  };
  return repository;
}
