import {
  taskExecutionHistoryViews,
  taskExecutionRefs,
  taskExecutionRunControls,
  taskExecutionRunRefs,
} from "@paperclipai/db";
import { and, asc, eq, gte, inArray, isNull } from "drizzle-orm";
import { type AgentRunTerminalPluginEventInput } from "./agent-run-plugin-events.js";
import { settleNonProtocolPromptInTransaction } from "./task-execution-prompt-cycle-postgres.js";
import type { TaskSessionDbTransaction } from "./task-session/event-store.js";

import { finalizeExpiredRunRecoveryBranches } from "./task-execution-dispatcher-expired-recovery-branches.js";
import { loadExpiredRunRecoveryPrompt } from "./task-execution-dispatcher-expired-recovery-load.js";
import { releaseExpiredRunRecoveryAttempt } from "./task-execution-dispatcher-expired-recovery-release.js";
import type {
  ExpiredRunRecovery,
  PostgresTaskExecutionDispatcherRepositoryContext,
} from "./task-execution-dispatcher-postgres-part-6.js";
import { RefRow, RunRow, exactlyOne, reject } from "./task-execution-dispatcher-postgres-part-1.js";
import { clearExactLaneClaim } from "./task-execution-dispatcher-postgres-part-2.js";
import { createRunForRef } from "./task-execution-dispatcher-postgres-part-4.js";
import { settleUnsentSuffix } from "./task-execution-dispatcher-postgres-part-5.js";

export function createPostgresTaskExecutionDispatcherRepositoryGroup1(
  context: PostgresTaskExecutionDispatcherRepositoryContext,
) {
  const options = context;
  const { idFactory } = context;
  function terminalEventForExpiredRun(
    run: RunRow,
    recovery: ExpiredRunRecovery,
    occurredAt: Date,
  ): AgentRunTerminalPluginEventInput | null {
    if (recovery.kind !== "released_run") return null;
    return {
      companyId: run.companyId,
      taskId: run.taskId,
      runId: run.runId,
      agentId: run.targetAgentId,
      outcome: recovery.terminal.outcome,
      reason: recovery.terminal.reason,
      occurredAt,
    };
  }

  async function recoverExpiredRunInTransaction(
    transaction: TaskSessionDbTransaction,
    run: RunRow,
    at: Date,
  ): Promise<ExpiredRunRecovery> {
    const loaded = await loadExpiredRunRecoveryPrompt(context, transaction, run, at);
    if (loaded.kind === "complete") return loaded.result as ExpiredRunRecovery;
    const released = await releaseExpiredRunRecoveryAttempt(context, transaction, run, at, loaded);
    const branched = await finalizeExpiredRunRecoveryBranches(context, transaction, run, at, released);
    if (branched.kind === "complete") return branched.result as ExpiredRunRecovery;
    const {
      promptTransmitted,
      attempt,
      member,
      revokeAbandonedConsult,
      nonProtocolPromptOwner,
      consultChainRemainsLive,
      control,
      lease,
    } = branched;

    let exactReleasedRetryRefs: readonly RefRow[] = Object.freeze([]);
    if (promptTransmitted) {
      await settleNonProtocolPromptInTransaction(transaction, nonProtocolPromptOwner, {
        state: "incomplete",
        outcome: "ambiguous",
        referenceId: idFactory(),
        at,
      });
      await transaction
        .update(taskExecutionRefs)
        .set({ disposition: "terminal", updatedAt: at })
        .where(and(eq(taskExecutionRefs.id, member.ref.id), eq(taskExecutionRefs.disposition, "active")));
      await transaction
        .update(taskExecutionHistoryViews)
        .set({ state: "terminal", finalizedAt: at, updatedAt: at })
        .where(
          and(
            eq(taskExecutionHistoryViews.id, member.ref.historyViewId),
            inArray(taskExecutionHistoryViews.state, ["empty", "current"]),
          ),
        );
      await settleUnsentSuffix(transaction, run.runId, member.row.refOrdinal, at, idFactory);
    } else {
      const unsettled = await transaction
        .select({
          row: taskExecutionRunRefs,
          ref: taskExecutionRefs,
        })
        .from(taskExecutionRunRefs)
        .innerJoin(taskExecutionRefs, eq(taskExecutionRefs.id, taskExecutionRunRefs.refId))
        .where(
          and(
            eq(taskExecutionRunRefs.runId, run.runId),
            gte(taskExecutionRunRefs.refOrdinal, member.row.refOrdinal),
          ),
        )
        .orderBy(asc(taskExecutionRunRefs.refOrdinal))
        .for("update");
      if (
        unsettled.length === 0 ||
        unsettled[0]!.ref.id !== member.ref.id ||
        unsettled[0]!.row.refOrdinal !== member.row.refOrdinal ||
        unsettled.some(
          (candidate, index) =>
            candidate.row.refOrdinal !== member.row.refOrdinal + index ||
            candidate.row.promptTransmissionPhase !== "not_transmitted" ||
            candidate.row.protocolSettlementState !== null,
        )
      ) {
        reject("expired pre-send run lost its exact released frontier");
      }
      for (const candidate of unsettled) {
        exactlyOne(
          await transaction
            .update(taskExecutionRunRefs)
            .set({
              outcome: "released_unsent",
              outcomeReferenceId: idFactory(),
              protocolSettlementState: "not_sent",
              settlementVersion: 1,
              settledAt: at,
            })
            .where(
              and(
                eq(taskExecutionRunRefs.runId, run.runId),
                eq(taskExecutionRunRefs.refOrdinal, candidate.row.refOrdinal),
                eq(taskExecutionRunRefs.promptTransmissionPhase, "not_transmitted"),
                isNull(taskExecutionRunRefs.protocolSettlementState),
              ),
            )
            .returning({ runId: taskExecutionRunRefs.runId }),
          "expired pre-send run could not release an untouched member",
        );
      }
      if (run.executionMode === "owner" || consultChainRemainsLive) {
        exactReleasedRetryRefs = Object.freeze(unsettled.map((candidate) => candidate.ref));
      } else {
        const refIds = unsettled.map((candidate) => candidate.ref.id);
        if (refIds.length > 0) {
          await transaction
            .update(taskExecutionRefs)
            .set({ disposition: "terminal", updatedAt: at })
            .where(and(inArray(taskExecutionRefs.id, refIds), eq(taskExecutionRefs.disposition, "active")));
          await transaction
            .update(taskExecutionHistoryViews)
            .set({ state: "terminal", finalizedAt: at, updatedAt: at })
            .where(
              and(
                inArray(taskExecutionHistoryViews.refId, refIds),
                inArray(taskExecutionHistoryViews.state, ["empty", "current"]),
              ),
            );
        }
      }
    }

    await revokeAbandonedConsult();

    exactlyOne(
      await transaction
        .update(taskExecutionRunControls)
        .set({
          currentRefId: null,
          currentOrdinal: null,
        })
        .where(
          and(
            eq(taskExecutionRunControls.runId, run.runId),
            eq(taskExecutionRunControls.currentRefId, member.ref.id),
            eq(taskExecutionRunControls.currentOrdinal, member.row.refOrdinal),
          ),
        )
        .returning({ runId: taskExecutionRunControls.runId }),
      "expired run could not clear its current prompt control",
    );
    await options.finalizer.finalizeInTransaction(transaction, {
      companyId: run.companyId,
      taskId: run.taskId,
      runId: run.runId,
      status: "failed",
      terminalReasonCode: promptTransmitted ? "worker_loss_after_prompt" : "worker_loss_before_prompt",
      finishedAt: at,
    });
    await clearExactLaneClaim(transaction, {
      ref: member.ref,
      laneOrdinal: member.row.admissionOrder,
      leaseGeneration: lease.leaseGeneration,
      leaseId: lease.id,
      at,
    });
    const retryRun =
      exactReleasedRetryRefs.length === 0
        ? null
        : (
            await createRunForRef(transaction, options, exactReleasedRetryRefs[0]!, at, {
              retryOfRunId: run.runId,
              orderedRefs: exactReleasedRetryRefs,
              sessionOperation: attempt.sessionOperation,
            })
          ).run;
    return {
      kind: "released_run",
      retryRun,
      terminal: {
        kind: "terminal",
        outcome: "failed",
        reason: promptTransmitted ? "worker_loss_after_prompt" : "worker_loss_before_prompt",
        finalText: null,
      },
    };
  }
  return { terminalEventForExpiredRun, recoverExpiredRunInTransaction };
}
