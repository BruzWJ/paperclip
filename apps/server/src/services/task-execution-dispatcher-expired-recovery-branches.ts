import {
  taskExecutionAttempts,
  taskExecutionPromptSegments,
  taskExecutionSessions,
  type Db,
} from "@paperclipai/db";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { resolveRuntimeToolTurn } from "./runtime-interface-compiler-db.js";
import { scheduleTaskExecutionAttemptRetryInTransaction } from "./task-execution-attempt-retry-schedule-postgres.js";
import { preserveCorrelationAfterNonProtocolClosure } from "./task-execution-correlation-retention.js";
import { settleNonProtocolPromptInTransaction } from "./task-execution-prompt-cycle-postgres.js";
import type { TaskSessionDbTransaction } from "./task-session/event-store.js";

import { releaseExpiredRunRecoveryAttempt } from "./task-execution-dispatcher-expired-recovery-release.js";
import type { PostgresTaskExecutionDispatcherRepositoryContext } from "./task-execution-dispatcher-postgres-part-6.js";
import { RunRow, exactlyOne, reject } from "./task-execution-dispatcher-postgres-part-1.js";
import {
  completeTerminalPromptInTransaction,
  loadRecoveredProtocolSettlement,
} from "./task-execution-dispatcher-postgres-part-5.js";

type ReleasedState = Extract<
  Awaited<ReturnType<typeof releaseExpiredRunRecoveryAttempt>>,
  { kind: "continue" }
>;

export async function finalizeExpiredRunRecoveryBranches(
  context: PostgresTaskExecutionDispatcherRepositoryContext,
  transaction: TaskSessionDbTransaction,
  run: RunRow,
  at: Date,
  state: ReleasedState,
) {
  const options = context;
  const { idFactory } = context;
  const {
    nonSteeringCancellation,
    closureDecision,
    abandonedConsult,
    nonProtocolPromptOwner,
    revokeAbandonedConsult,
    recoveredLease,
    correlationIds,
    capability,
    promptTransmitted,
    attempt,
    segment,
    member,
    pendingSteeringSegment,
    promptOwner,
    promptOwnerIsUnbound,
  } = state;
  if (nonSteeringCancellation === null && closureDecision.kind === "retry") {
    if (abandonedConsult) {
      await settleNonProtocolPromptInTransaction(transaction, nonProtocolPromptOwner, {
        state: "not_sent",
        outcome: "released_unsent",
        referenceId: idFactory(),
        at,
      });
      await revokeAbandonedConsult();
      const terminal = {
        kind: "terminal" as const,
        outcome: "failed" as const,
        reason: "worker_loss_chain_not_live",
        finalText: null,
      };
      const completed = await completeTerminalPromptInTransaction(transaction, options, {
        lease: recoveredLease,
        attempt,
        outcome: terminal.outcome,
        reason: terminal.reason,
        at,
        idFactory,
      });
      if (!completed.finalization) {
        reject("abandoned consult unexpectedly retained a batch successor");
      }
      return {
        kind: "complete" as const,
        result: { kind: "released_run", retryRun: null, terminal },
      };
    }
    await scheduleTaskExecutionAttemptRetryInTransaction(transaction, {
      id: idFactory(),
      companyId: run.companyId,
      taskId: run.taskId,
      runId: run.runId,
      predecessorAttemptId: attempt.id,
      reasonCode: closureDecision.reason,
      retryAt: closureDecision.retryAt,
      at,
    });
    return {
      kind: "complete" as const,
      result: {
        kind: "retry_same_run",
        run: await options.runService.lockRun(transaction, {
          companyId: run.companyId,
          taskId: run.taskId,
          runId: run.runId,
        }),
      },
    };
  }

  if (nonSteeringCancellation === null && closureDecision.kind === "terminal") {
    const protocol = closureDecision.protocolSettled
      ? await loadRecoveredProtocolSettlement(transaction, {
          run,
          owner: promptOwner,
          segment,
        })
      : null;
    const terminal = {
      kind: "terminal" as const,
      outcome: closureDecision.outcome,
      reason: protocol?.reason ?? closureDecision.reason,
      finalText: protocol?.finalText ?? null,
    };
    await revokeAbandonedConsult();
    const completed = await completeTerminalPromptInTransaction(transaction, options, {
      lease: recoveredLease,
      attempt,
      outcome: terminal.outcome,
      reason: terminal.reason,
      at,
      idFactory,
    });
    if (completed.finalization === null) {
      return {
        kind: "complete" as const,
        result: {
          kind: "retry_same_run",
          run: await options.runService.lockRun(transaction, {
            companyId: run.companyId,
            taskId: run.taskId,
            runId: run.runId,
          }),
        },
      };
    }
    return {
      kind: "complete" as const,
      result: {
        kind: "released_run",
        retryRun: null,
        terminal,
      },
    };
  }

  if (closureDecision.kind !== "terminal" && correlationIds.length > 0) {
    const correlations = await transaction
      .select({
        id: taskExecutionSessions.id,
        purpose: taskExecutionSessions.purpose,
        state: taskExecutionSessions.state,
      })
      .from(taskExecutionSessions)
      .where(inArray(taskExecutionSessions.id, correlationIds))
      .for("update");
    if (
      correlations.length !== correlationIds.length ||
      correlations.some((correlation) => correlation.state !== "eligible" && correlation.state !== "current")
    ) {
      reject("expired attempt lost its exact activated correlation fence");
    }
    const turn = await resolveRuntimeToolTurn(transaction as unknown as Db, {
      companyId: run.companyId,
      taskId: run.taskId,
      ownershipEpoch: run.ownershipEpoch,
      targetAgentId: run.targetAgentId,
      executionMode: run.executionMode,
      taskExecutionAuthorityId: run.taskExecutionAuthorityId,
      consultExecutionId: run.consultExecutionId,
      refId: member.ref.id,
    });
    const preserveCorrelation = preserveCorrelationAfterNonProtocolClosure({
      turn,
      carryContext: correlations.every((correlation) => correlation.purpose === "carry"),
    });
    if (!preserveCorrelation) {
      const superseded = await transaction
        .update(taskExecutionSessions)
        .set({
          state: "superseded",
          supersessionReason: promptTransmitted ? "prompt_failed_incomplete" : "lease_expired_before_prompt",
          supersededAt: at,
        })
        .where(
          and(
            inArray(taskExecutionSessions.id, correlationIds),
            inArray(taskExecutionSessions.state, ["eligible", "current"]),
          ),
        )
        .returning({ id: taskExecutionSessions.id });
      if (superseded.length !== correlationIds.length) {
        reject("expired attempt lost its exact activated correlation fence");
      }
    }
  }
  if (nonSteeringCancellation !== null) {
    await revokeAbandonedConsult();
    const cancellationReason = `${nonSteeringCancellation.reasonKind}_cancellation`;
    const completed = await completeTerminalPromptInTransaction(transaction, options, {
      lease: recoveredLease,
      attempt,
      outcome: "cancelled",
      reason: cancellationReason,
      at,
      idFactory,
    });
    if (completed.finalization === null) {
      reject("expired cancellation unexpectedly retained a batch successor");
    }
    return {
      kind: "complete" as const,
      result: {
        kind: "released_run",
        retryRun: null,
        terminal: {
          kind: "terminal",
          outcome: "cancelled",
          reason: cancellationReason,
          finalText: null,
        },
      },
    };
  }
  if (!promptTransmitted && attempt.promptKind === "steering" && segment !== null) {
    exactlyOne(
      await transaction
        .update(taskExecutionPromptSegments)
        .set({
          attemptId: null,
          capabilityConnectionId: null,
          capabilityGeneration: null,
        })
        .where(
          and(
            eq(taskExecutionPromptSegments.runId, run.runId),
            eq(taskExecutionPromptSegments.refId, member.ref.id),
            eq(taskExecutionPromptSegments.refOrdinal, member.row.refOrdinal),
            eq(taskExecutionPromptSegments.segmentOrdinal, segment.segmentOrdinal),
            isNull(taskExecutionPromptSegments.protocolSettlementState),
            promptOwnerIsUnbound
              ? and(
                  isNull(taskExecutionPromptSegments.attemptId),
                  isNull(taskExecutionPromptSegments.capabilityConnectionId),
                  isNull(taskExecutionPromptSegments.capabilityGeneration),
                )
              : and(
                  eq(taskExecutionPromptSegments.attemptId, attempt.id),
                  eq(taskExecutionPromptSegments.capabilityConnectionId, promptOwner.capabilityConnectionId!),
                  eq(taskExecutionPromptSegments.capabilityGeneration, promptOwner.capabilityGeneration!),
                ),
          ),
        )
        .returning({ runId: taskExecutionPromptSegments.runId }),
      "expired steering attempt could not clear its old prompt ownership",
    );
    const generationRows = await transaction
      .select({ generation: taskExecutionAttempts.attemptGeneration })
      .from(taskExecutionAttempts)
      .where(
        and(
          eq(taskExecutionAttempts.runId, attempt.runId),
          eq(taskExecutionAttempts.refId, attempt.refId!),
          eq(taskExecutionAttempts.refOrdinal, attempt.refOrdinal!),
          eq(taskExecutionAttempts.segmentOrdinal, attempt.segmentOrdinal!),
        ),
      )
      .orderBy(desc(taskExecutionAttempts.attemptGeneration))
      .limit(1)
      .for("update");
    exactlyOne(
      await transaction
        .insert(taskExecutionAttempts)
        .values({
          id: idFactory(),
          companyId: attempt.companyId,
          taskId: attempt.taskId,
          sessionId: attempt.sessionId,
          runId: attempt.runId,
          runKind: attempt.runKind,
          promptKind: attempt.promptKind,
          sessionOperation: attempt.sessionOperation,
          refId: attempt.refId,
          refOrdinal: attempt.refOrdinal,
          segmentOrdinal: attempt.segmentOrdinal,
          steeringSegmentOrdinal: attempt.steeringSegmentOrdinal,
          attemptGeneration: (generationRows[0]?.generation ?? 0) + 1,
          state: "pending",
          startedAt: null,
          finishedAt: null,
          createdAt: at,
        })
        .returning({ id: taskExecutionAttempts.id }),
      "expired steering attempt could not create its successor generation",
    );
    return {
      kind: "complete" as const,
      result: {
        kind: "retry_same_run",
        run: await options.runService.lockRun(transaction, {
          companyId: run.companyId,
          taskId: run.taskId,
          runId: run.runId,
        }),
      },
    };
  }
  return { ...state, kind: "continue" as const };
}
