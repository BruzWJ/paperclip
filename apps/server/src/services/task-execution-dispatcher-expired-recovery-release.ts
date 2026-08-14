import {
  taskConsultExecutions,
  taskExecutionAttempts,
  taskExecutionCancellationIntents,
  taskExecutionLeases,
  taskExecutionPromptCapabilities,
  taskExecutionPromptSegments,
} from "@paperclipai/db";
import { and, eq, inArray, isNull, lte, ne } from "drizzle-orm";
import { TaskConsultChainInvalid, lockAndValidateTaskConsultChain } from "./task-consult-chain-postgres.js";
import { settleNonProtocolPromptInTransaction } from "./task-execution-prompt-cycle-postgres.js";
import type { TaskSessionDbTransaction } from "./task-session/event-store.js";

import { loadExpiredRunRecoveryPrompt } from "./task-execution-dispatcher-expired-recovery-load.js";
import type { PostgresTaskExecutionDispatcherRepositoryContext } from "./task-execution-dispatcher-postgres-part-6.js";
import {
  CancellationIntentRow,
  RunRow,
  exactlyOne,
  leaseProjection,
  reject,
} from "./task-execution-dispatcher-postgres-part-1.js";

type LoadedState = Extract<Awaited<ReturnType<typeof loadExpiredRunRecoveryPrompt>>, { kind: "continue" }>;

export async function releaseExpiredRunRecoveryAttempt(
  context: PostgresTaskExecutionDispatcherRepositoryContext,
  transaction: TaskSessionDbTransaction,
  run: RunRow,
  at: Date,
  state: LoadedState,
) {
  const options = context;
  const { idFactory } = context;
  const {
    cancellation,
    steeringCancellation,
    nonSteeringCancellation,
    member,
    segment,
    attempt,
    promptOwner,
    lease,
    pendingSteeringSegment,
    nonProtocolPromptOwner,
    capabilities,
    capability,
    closureDecision,
    promptTransmitted,
  } = state;
  if (steeringCancellation !== null && closureDecision.kind === "retry") {
    reject("steering cancellation cannot own a retry prompt closure");
  }
  const steeringCancellationRecovery =
    steeringCancellation === null
      ? null
      : closureDecision.kind === "open" && promptTransmitted
        ? "fail_run"
        : "continue_source";
  let consultChainRemainsLive = false;
  if (run.executionMode === "consult") {
    try {
      await lockAndValidateTaskConsultChain(transaction, {
        ref: member.ref,
        requireLiveAncestors: false,
        leafState: "active",
      });
      consultChainRemainsLive = true;
    } catch (error) {
      if (!(error instanceof TaskConsultChainInvalid)) throw error;
    }
  }
  const correlationIds = [
    ...new Set(
      capabilities
        .map((capability) => capability.targetSessionCorrelationId)
        .filter((id): id is string => id !== null),
    ),
  ];
  const capabilityAlreadyRevokedForSteering =
    capability?.state === "revoked" && capability.revocationReason === "active_run_steering";
  if (steeringCancellation !== null && !capabilityAlreadyRevokedForSteering) {
    reject("expired steering cancellation lost its revoked capability");
  }
  if (closureDecision.kind === "open" && !capabilityAlreadyRevokedForSteering) {
    const revoked = await transaction
      .update(taskExecutionPromptCapabilities)
      .set({
        state: "revoked",
        revocationReason: "lease_expired",
        revokedAt: at,
      })
      .where(
        and(
          eq(taskExecutionPromptCapabilities.runId, run.runId),
          eq(taskExecutionPromptCapabilities.attemptId, attempt.id),
          eq(taskExecutionPromptCapabilities.leaseId, lease.id),
          inArray(taskExecutionPromptCapabilities.state, ["pending_setup", "active"]),
        ),
      )
      .returning({
        capabilityConnectionId: taskExecutionPromptCapabilities.capabilityConnectionId,
      });
    if (capability !== null && revoked.length !== 1) {
      reject("expired attempt could not revoke its open prompt capability");
    }
  }
  if (
    (nonSteeringCancellation !== null && closureDecision.kind !== "terminal") ||
    (steeringCancellationRecovery === "continue_source" && closureDecision.kind === "open")
  ) {
    const incomplete = nonSteeringCancellation !== null && promptTransmitted;
    await settleNonProtocolPromptInTransaction(
      transaction,
      nonProtocolPromptOwner,
      incomplete
        ? {
            state: "incomplete",
            outcome: "ambiguous",
            referenceId: idFactory(),
            at,
          }
        : {
            state: "not_sent",
            outcome: "released_unsent",
            referenceId: idFactory(),
            at,
          },
    );
  }
  const attemptTerminalState =
    nonSteeringCancellation !== null
      ? ("cancelled" as const)
      : closureDecision.kind === "terminal"
        ? closureDecision.outcome === "succeeded"
          ? ("settled" as const)
          : closureDecision.outcome === "cancelled"
            ? ("cancelled" as const)
            : ("failed" as const)
        : ("failed" as const);
  exactlyOne(
    await transaction
      .update(taskExecutionAttempts)
      .set({ state: attemptTerminalState, finishedAt: at })
      .where(and(eq(taskExecutionAttempts.id, attempt.id), eq(taskExecutionAttempts.state, "running")))
      .returning({ id: taskExecutionAttempts.id }),
    "expired attempt lost its running generation",
  );
  exactlyOne(
    await transaction
      .update(taskExecutionLeases)
      .set({
        state: nonSteeringCancellation === null ? "expired" : "revoked",
        releasedAt: at,
      })
      .where(
        and(
          eq(taskExecutionLeases.id, lease.id),
          eq(taskExecutionLeases.attemptId, attempt.id),
          eq(taskExecutionLeases.leaseGeneration, lease.leaseGeneration),
          eq(taskExecutionLeases.state, "active"),
          lte(taskExecutionLeases.expiresAt, at),
        ),
      )
      .returning({ id: taskExecutionLeases.id }),
    "expired lease lost its exact compare-and-set fence",
  );
  const completeCancellation = async (intent: CancellationIntentRow): Promise<void> => {
    const steering = intent.reasonKind === "steering";
    exactlyOne(
      await transaction
        .update(taskExecutionCancellationIntents)
        .set({
          state: "completed",
          acknowledgedAt: intent.acknowledgedAt ?? at,
          completedAt: at,
        })
        .where(
          and(
            eq(taskExecutionCancellationIntents.id, intent.id),
            eq(taskExecutionCancellationIntents.companyId, run.companyId),
            eq(taskExecutionCancellationIntents.taskId, run.taskId),
            eq(taskExecutionCancellationIntents.runId, run.runId),
            eq(taskExecutionCancellationIntents.attemptId, attempt.id),
            eq(taskExecutionCancellationIntents.leaseId, lease.id),
            steering
              ? eq(taskExecutionCancellationIntents.reasonKind, "steering")
              : ne(taskExecutionCancellationIntents.reasonKind, "steering"),
            inArray(taskExecutionCancellationIntents.state, ["requested", "acknowledged"]),
            steering ? isNull(taskExecutionCancellationIntents.nativeCancellationSettledAt) : undefined,
            isNull(taskExecutionCancellationIntents.completedAt),
            isNull(taskExecutionCancellationIntents.failedAt),
            isNull(taskExecutionCancellationIntents.failureCode),
          ),
        )
        .returning({ id: taskExecutionCancellationIntents.id }),
      steering
        ? "expired transmitted steering orphan could not complete its request"
        : "expired cancellation could not complete its exact intent",
    );
    await options.runService.detachCancellation(transaction, {
      companyId: run.companyId,
      taskId: run.taskId,
      runId: run.runId,
      expectedCancellationIntentId: intent.id,
      at,
    });
  };
  if (steeringCancellationRecovery === "continue_source") {
    // The old prompt is now durably closed and the exact attempt/lease is
    // terminal, but the run attachment and positive segment remain owned by
    // the steering intent. The source continuation performs the sole rebind.
    return { kind: "complete" as const, result: { kind: "current", run } };
  }
  if (steeringCancellationRecovery === "fail_run") {
    if (cancellation === null || pendingSteeringSegment === null) {
      reject("expired transmitted steering orphan lost its durable request");
    }
    exactlyOne(
      await transaction
        .update(taskExecutionPromptSegments)
        .set({
          steeringState: "protocol_settled",
          outcome: "released_unsent",
          outcomeReferenceId: idFactory(),
          protocolSettlementState: "not_sent",
          settlementVersion: 1,
          settledAt: at,
        })
        .where(
          and(
            eq(taskExecutionPromptSegments.companyId, pendingSteeringSegment.companyId),
            eq(taskExecutionPromptSegments.taskId, pendingSteeringSegment.taskId),
            eq(taskExecutionPromptSegments.runId, run.runId),
            eq(taskExecutionPromptSegments.refId, member.ref.id),
            eq(taskExecutionPromptSegments.refOrdinal, member.row.refOrdinal),
            eq(taskExecutionPromptSegments.segmentOrdinal, pendingSteeringSegment.segmentOrdinal),
            eq(taskExecutionPromptSegments.cancellationIntentId, cancellation.id),
            inArray(taskExecutionPromptSegments.steeringState, ["requested", "sent"]),
            eq(taskExecutionPromptSegments.promptTransmissionPhase, "not_transmitted"),
            isNull(taskExecutionPromptSegments.attemptId),
            isNull(taskExecutionPromptSegments.capabilityConnectionId),
            isNull(taskExecutionPromptSegments.capabilityGeneration),
            isNull(taskExecutionPromptSegments.protocolSettlementState),
          ),
        )
        .returning({ runId: taskExecutionPromptSegments.runId }),
      "expired transmitted steering orphan could not release its request",
    );
  }
  const cancellationToComplete =
    nonSteeringCancellation ?? (steeringCancellationRecovery === "fail_run" ? cancellation : null);
  if (cancellationToComplete !== null) {
    await completeCancellation(cancellationToComplete);
  }
  await options.runService.detachAttempt(transaction, {
    companyId: run.companyId,
    taskId: run.taskId,
    runId: run.runId,
    expectedAttemptId: attempt.id,
    expectedLeaseId: lease.id,
    at,
  });

  const recoveredLease = leaseProjection([member.ref], run.runId, attempt, lease.id, lease.leaseGeneration);
  const abandonedConsult = run.executionMode === "consult" && !consultChainRemainsLive;
  const revokeAbandonedConsult = async () => {
    if (!abandonedConsult || member.ref.consultExecutionId === null) return;
    exactlyOne(
      await transaction
        .update(taskConsultExecutions)
        .set({
          state: "revoked",
          closeReason: "worker_loss_chain_not_live",
          closedAt: at,
        })
        .where(
          and(
            eq(taskConsultExecutions.id, member.ref.consultExecutionId),
            eq(taskConsultExecutions.state, "active"),
          ),
        )
        .returning({ id: taskConsultExecutions.id }),
      "abandoned consult recovery lost its active execution",
    );
  };
  return {
    ...state,
    kind: "continue" as const,
    steeringCancellationRecovery,
    consultChainRemainsLive,
    correlationIds,
    capabilityAlreadyRevokedForSteering,
    attemptTerminalState,
    completeCancellation,
    cancellationToComplete,
    recoveredLease,
    abandonedConsult,
    revokeAbandonedConsult,
  };
}
