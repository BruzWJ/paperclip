import { taskExecutionRunRefs, taskExecutionRuns, tasks, type Db } from "@paperclipai/db";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type * as runState from "./task-execution-run-service-part-9.js";
import {
  type TaskExecutionRunService,
  TaskExecutionSteeringRejected,
  exactIdentity,
  sameReboundIdentity,
  validateRequest,
} from "./task-execution-run-service-part-10.js";
import {
  TaskExecutionRunInvariantViolation,
  assertExactRunIdentifier,
} from "./task-execution-run-service-part-1-section-1.js";
import {
  assertRunEnvelopeInvariant,
  listResumedAgentSteeringLivenessActionsInTransaction,
  projectRunEnvelope,
  readTaskExecutionRun,
} from "./task-execution-run-service-part-2-section-1.js";
import {
  attachTaskExecutionRunAttemptInTransaction,
  createTaskExecutionRunInTransaction,
  transitionTaskExecutionRunStatusInTransaction,
} from "./task-execution-run-service-part-5-section-1.js";
import {
  attachTaskExecutionRunCancellationInTransaction,
  attachTaskExecutionRunFinalizationInTransaction,
  detachTaskExecutionRunCancellationInTransaction,
  listTaskExecutionRunsForActivity,
  listTaskExecutionRunsForAgent,
  listTaskExecutionRunsForTask,
  listTaskExecutionRunsForWorkTimeline,
} from "./task-execution-run-service-part-6-section-1.js";
import { detachTaskExecutionRunAttemptInTransaction } from "./task-execution-run-service-part-5-section-2.js";
import { lockTaskExecutionRunInTransaction } from "./task-execution-run-service-part-3-section-1.js";
import { readJoinedTaskExecutionRunDetail } from "./task-execution-run-service-part-8.js";
import type { TaskExecutionSteeringResultBroker } from "./task-execution-steering-results.js";
import type { TaskSessionStore } from "./task-session/store.js";

/**
 * Canonical P14 orchestration. The comment/source and requested segment commit
 * first; the worker then signals the exact in-memory attempt, waits for the
 * old prompt's unambiguous protocol settlement, rebinds the
 * positive segment, and only then schedules its ACP continuation. It never
 * creates another Paperclip run and never builds context itself.
 */
export function createTaskExecutionRunService(options: {
  readonly database: Db;
  readonly taskSessionStore: TaskSessionStore;
  readonly repository: runState.TaskExecutionSteeringRepository;
  readonly cancellation: runState.TaskExecutionSteeringCancellationPort;
  readonly resume: runState.TaskExecutionSteeringResumePort;
  readonly steeringResults: Pick<TaskExecutionSteeringResultBroker, "rebind" | "publish">;
}): TaskExecutionRunService {
  async function continueRequestedSteering(
    request: runState.RequestedTaskExecutionSteering,
  ): Promise<runState.ReboundTaskExecutionSteering | null> {
    const continuationIdentity = {
      companyId: request.companyId,
      taskId: request.taskId,
      runId: request.runId,
      refId: request.refId,
      refOrdinal: request.refOrdinal,
      segmentOrdinal: request.segmentOrdinal,
    } as const;
    if (request.interruptedSegmentOrdinal > 0) {
      options.steeringResults.rebind(
        {
          ...continuationIdentity,
          segmentOrdinal: request.interruptedSegmentOrdinal,
        },
        continuationIdentity,
      );
    }
    // A false signal is not itself failure: the old prompt may have settled
    // naturally between the transaction and the post-commit signal.
    const delivered = options.cancellation.signalAttemptCancellation(request.cancellation);
    await options.repository.recordCancellationSignal({
      request,
      delivered,
    });
    const settlement = await options.repository.awaitCancellationSettlement(request);
    if (settlement.kind === "pending") return null;
    if (settlement.kind === "ambiguous") {
      await options.repository.markAmbiguous({
        request,
        reason: settlement.reason,
      });
      throw new TaskExecutionSteeringRejected(
        "The selected run's current prompt did not settle unambiguously",
        "cancellation_ambiguous",
      );
    }
    const rebound = await options.repository.rebindAfterCancellation(request);
    if (!sameReboundIdentity(request, rebound)) {
      await options.repository.markAmbiguous({
        request,
        reason: "steering rebound crossed the requested run segment",
      });
      throw new TaskExecutionSteeringRejected(
        "Steering rebound crossed the requested run segment",
        "rebound_identity_mismatch",
      );
    }
    await options.repository.markResumeReady(rebound);
    await options.resume.resumeSteering(rebound);
    return rebound;
  }

  function publishContinuationFailure(
    identity: {
      readonly companyId: string;
      readonly taskId: string;
      readonly runId: string;
      readonly refId: string;
      readonly refOrdinal: number;
      readonly segmentOrdinal: number;
    },
    error: unknown,
  ): void {
    options.steeringResults.publish({
      companyId: identity.companyId,
      taskId: identity.taskId,
      runId: identity.runId,
      refId: identity.refId,
      refOrdinal: identity.refOrdinal,
      segmentOrdinal: identity.segmentOrdinal,
      outcome: "failed",
      response: "",
      reason: error instanceof Error ? error.message : "Steering continuation failed",
    });
  }

  async function continueReboundForSource(
    source: runState.RecoverableTaskExecutionSteeringSource,
    rebound: runState.ReboundTaskExecutionSteering,
  ): Promise<runState.ContinuedPendingTaskExecutionSteering> {
    try {
      await options.repository.markResumeReady(rebound);
    } catch (error) {
      const latest = await options.repository.findPendingForSource(source);
      if (latest.kind === "resumed") return { kind: "already_resumed" };
      if (latest.kind === "terminal") {
        return { kind: "already_settled", result: latest.result };
      }
      throw error;
    }
    await options.resume.resumeSteering(rebound);
    return { kind: "continued_rebound", rebound };
  }

  async function readConvergedSteeringSource(
    source: runState.RecoverableTaskExecutionSteeringSource,
  ): Promise<runState.ContinuedPendingTaskExecutionSteering | null> {
    const latest = await options.repository.findPendingForSource(source);
    if (latest.kind === "resumed") return { kind: "already_resumed" };
    if (latest.kind === "terminal") {
      return { kind: "already_settled", result: latest.result };
    }
    if (latest.kind === "rebound") {
      return continueReboundForSource(source, latest.rebound);
    }
    if (latest.kind === "ambiguous") {
      throw new TaskExecutionSteeringRejected(latest.reason, "persisted_ambiguous");
    }
    return null;
  }

  const service: TaskExecutionRunService = {
    createRun(transaction, input) {
      return createTaskExecutionRunInTransaction(transaction, input);
    },

    lockRun(transaction, input) {
      return lockTaskExecutionRunInTransaction(transaction, input);
    },

    readRun(input) {
      return readTaskExecutionRun(options.database, input);
    },

    async lockActiveRunsForAgentsInTransaction(transaction, input) {
      assertExactRunIdentifier(input.companyId, "company id");
      const agentIds = [...new Set(input.agentIds)];
      for (const agentId of agentIds) {
        assertExactRunIdentifier(agentId, "target agent id");
      }
      if (agentIds.length === 0) return Object.freeze([]);
      const rows = await transaction
        .select()
        .from(taskExecutionRuns)
        .where(
          and(
            eq(taskExecutionRuns.companyId, input.companyId),
            inArray(taskExecutionRuns.targetAgentId, agentIds),
            inArray(taskExecutionRuns.status, ["queued", "running", "scheduled_retry"]),
          ),
        )
        .orderBy(asc(taskExecutionRuns.createdAt), asc(taskExecutionRuns.id))
        .for("update");
      const runs = rows.map(projectRunEnvelope);
      for (const run of runs) assertRunEnvelopeInvariant(run);
      return Object.freeze(runs);
    },

    async lockActiveRunsForScopeInTransaction(transaction, input) {
      assertExactRunIdentifier(input.companyId, "company id");
      assertExactRunIdentifier(input.taskId, "task id");
      const byEpoch = "ownershipEpoch" in input;
      if (byEpoch && (!Number.isSafeInteger(input.ownershipEpoch) || input.ownershipEpoch < 1)) {
        throw new TaskExecutionRunInvariantViolation("ownership epoch must be a positive integer");
      }
      const refIds = byEpoch ? [] : [...new Set(input.refIds)];
      for (const refId of refIds) {
        assertExactRunIdentifier(refId, "execution ref id");
      }
      if (!byEpoch && refIds.length === 0) return Object.freeze([]);
      const rows = await transaction
        .select()
        .from(taskExecutionRuns)
        .where(
          and(
            eq(taskExecutionRuns.companyId, input.companyId),
            eq(taskExecutionRuns.taskId, input.taskId),
            inArray(taskExecutionRuns.status, ["queued", "running", "scheduled_retry"]),
            byEpoch
              ? eq(taskExecutionRuns.ownershipEpoch, input.ownershipEpoch)
              : sql`exists (
                  select 1
                  from ${taskExecutionRunRefs}
                  where ${taskExecutionRunRefs.companyId} = ${taskExecutionRuns.companyId}
                    and ${taskExecutionRunRefs.taskId} = ${taskExecutionRuns.taskId}
                    and ${taskExecutionRunRefs.runId} = ${taskExecutionRuns.id}
                    and ${inArray(taskExecutionRunRefs.refId, refIds)}
                )`,
          ),
        )
        .orderBy(asc(taskExecutionRuns.createdAt), asc(taskExecutionRuns.id))
        .for("update");
      const runs = rows.map(projectRunEnvelope);
      for (const run of runs) assertRunEnvelopeInvariant(run);
      return Object.freeze(runs);
    },

    async lockActiveAgentRunsForTaskEpochInTransaction(transaction, input) {
      assertExactRunIdentifier(input.companyId, "company id");
      assertExactRunIdentifier(input.taskId, "task id");
      if (!Number.isSafeInteger(input.ownershipEpoch) || input.ownershipEpoch < 1) {
        throw new TaskExecutionRunInvariantViolation("ownership epoch must be a positive integer");
      }
      const rows = await transaction
        .select()
        .from(taskExecutionRuns)
        .where(
          and(
            eq(taskExecutionRuns.companyId, input.companyId),
            eq(taskExecutionRuns.taskId, input.taskId),
            eq(taskExecutionRuns.ownershipEpoch, input.ownershipEpoch),
            inArray(taskExecutionRuns.kind, ["productive", "consult"]),
            inArray(taskExecutionRuns.status, ["queued", "scheduled_retry", "running"]),
          ),
        )
        .orderBy(asc(taskExecutionRuns.createdAt), asc(taskExecutionRuns.id))
        .for("update");
      const runs = rows.map(projectRunEnvelope);
      for (const run of runs) assertRunEnvelopeInvariant(run);
      return Object.freeze(runs);
    },

    async lockActiveRunsForBudgetScopeInTransaction(transaction, input) {
      assertExactRunIdentifier(input.companyId, "company id");
      assertExactRunIdentifier(input.scopeId, "budget scope id");
      if (input.scopeType === "company" && input.scopeId !== input.companyId) {
        throw new TaskExecutionRunInvariantViolation("company budget scope must target its exact company");
      }
      const rows = await transaction
        .select()
        .from(taskExecutionRuns)
        .where(
          and(
            eq(taskExecutionRuns.companyId, input.companyId),
            inArray(taskExecutionRuns.status, ["queued", "running", "scheduled_retry"]),
            input.scopeType === "company"
              ? undefined
              : input.scopeType === "project"
                ? sql`exists (
                    select 1
                    from ${tasks}
                    where ${tasks.companyId} = ${taskExecutionRuns.companyId}
                      and ${tasks.id} = ${taskExecutionRuns.taskId}
                      and ${tasks.projectId} = ${input.scopeId}
                  )`
                : eq(taskExecutionRuns.targetAgentId, input.scopeId),
          ),
        )
        .orderBy(asc(taskExecutionRuns.createdAt), asc(taskExecutionRuns.id))
        .for("update");
      return Object.freeze(rows.map(projectRunEnvelope));
    },

    listResumedAgentSteeringLivenessActionsInTransaction,

    transitionRunStatus(transaction, input) {
      return transitionTaskExecutionRunStatusInTransaction(transaction, input);
    },

    attachAttempt(transaction, input) {
      return attachTaskExecutionRunAttemptInTransaction(transaction, input);
    },

    detachAttempt(transaction, input) {
      return detachTaskExecutionRunAttemptInTransaction(transaction, input);
    },

    attachCancellation(transaction, input) {
      return attachTaskExecutionRunCancellationInTransaction(transaction, input);
    },

    detachCancellation(transaction, input) {
      return detachTaskExecutionRunCancellationInTransaction(transaction, input);
    },

    attachFinalization(transaction, input) {
      return attachTaskExecutionRunFinalizationInTransaction(transaction, input);
    },

    listForTask(input) {
      return listTaskExecutionRunsForTask(options.database, input);
    },

    listForAgent(input) {
      return listTaskExecutionRunsForAgent(options.database, input);
    },

    listForActivity(input) {
      return listTaskExecutionRunsForActivity(options.database, input);
    },

    listForWorkTimeline(input) {
      return listTaskExecutionRunsForWorkTimeline(options.database, input);
    },

    readJoinedRunDetail(input) {
      return readJoinedTaskExecutionRunDetail(options.database, options.taskSessionStore, input);
    },

    async requestSteeringInTransaction(transaction, input) {
      validateRequest(input);
      return options.repository.requestInTransaction(transaction, input);
    },

    async continuePendingSteeringForSource(input) {
      exactIdentity(input.companyId, "company id");
      exactIdentity(input.taskId, "task id");
      exactIdentity(input.sourceCommentId, "source comment id");
      const pending = await options.repository.findPendingForSource(input);
      if (pending.kind === "resumed") {
        return { kind: "already_resumed" };
      }
      if (pending.kind === "terminal") {
        return { kind: "already_settled", result: pending.result };
      }
      if (pending.kind === "ambiguous") {
        throw new TaskExecutionSteeringRejected(pending.reason, "persisted_ambiguous");
      }
      if (pending.kind === "requested") {
        try {
          const rebound = await continueRequestedSteering(pending.request);
          return rebound === null ? { kind: "still_pending" } : { kind: "continued_requested", rebound };
        } catch (error) {
          let failure: unknown = error;
          if (
            error instanceof TaskExecutionRunInvariantViolation ||
            error instanceof TaskExecutionSteeringRejected
          ) {
            try {
              const converged = await readConvergedSteeringSource(input);
              if (converged !== null) return converged;
            } catch (convergenceError) {
              failure = convergenceError;
            }
          }
          publishContinuationFailure(pending.request, failure);
          throw failure;
        }
      }
      // A persisted rebound has already crossed cancellation settlement.
      // Re-run the exact lifecycle fence idempotently before
      // scheduling only that same-run segment.
      try {
        return await continueReboundForSource(input, pending.rebound);
      } catch (error) {
        publishContinuationFailure(pending.rebound, error);
        throw error;
      }
    },

    async reconcilePendingSteering(limit = 100) {
      const boundedLimit = Math.max(1, Math.min(1_000, Math.trunc(limit)));
      const sources = await options.repository.listRecoverableSources(boundedLimit);
      let continued = 0;
      let pending = 0;
      for (const source of sources) {
        const result = await service.continuePendingSteeringForSource(source);
        if (result.kind === "still_pending") pending += 1;
        else continued += 1;
      }
      return Object.freeze({
        discovered: sources.length,
        continued,
        pending,
        sourceCommentIds: Object.freeze(sources.map((source) => source.sourceCommentId)),
      });
    },
  };
  return Object.freeze(service);
}
