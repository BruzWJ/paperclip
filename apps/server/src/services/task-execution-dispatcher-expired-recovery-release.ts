import {
  taskConsultExecutions,
  taskExecutionAttempts,
  taskExecutionCancellationIntents,
  taskExecutionLeases,
  taskExecutionPromptCapabilities,
} from "@paperclipai/db";
import { and, eq, inArray, isNull, lte } from "drizzle-orm";
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
    member,
    attempt,
    lease,
    nonProtocolPromptOwner,
    capabilities,
    capability,
    closureDecision,
    promptTransmitted,
  } = state;
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
  if (closureDecision.kind === "open") {
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
    cancellation !== null && closureDecision.kind !== "terminal"
  ) {
    const incomplete = promptTransmitted;
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
    cancellation !== null
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
        state: cancellation === null ? "expired" : "revoked",
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
            inArray(taskExecutionCancellationIntents.state, ["requested", "acknowledged"]),
            isNull(taskExecutionCancellationIntents.completedAt),
            isNull(taskExecutionCancellationIntents.failedAt),
            isNull(taskExecutionCancellationIntents.failureCode),
          ),
        )
        .returning({ id: taskExecutionCancellationIntents.id }),
      "expired cancellation could not complete its exact intent",
    );
    await options.runService.detachCancellation(transaction, {
      companyId: run.companyId,
      taskId: run.taskId,
      runId: run.runId,
      expectedCancellationIntentId: intent.id,
      at,
    });
  };
  const cancellationToComplete = cancellation;
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
    consultChainRemainsLive,
    correlationIds,
    attemptTerminalState,
    completeCancellation,
    cancellationToComplete,
    recoveredLease,
    abandonedConsult,
    revokeAbandonedConsult,
  };
}
