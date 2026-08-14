import {
  taskExecutionAttempts,
  taskExecutionHistoryViews,
  taskExecutionLeases,
  taskExecutionRefs,
  taskExecutionRunControls,
  taskExecutionRunRefs,
  taskSessionEvents,
  taskSessionMessages,
} from "@paperclipai/db";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  type AttemptRow,
  type PostgresTaskExecutionDispatcherRepositoryOptions,
  type PromptOwnerRow,
  type RunRow,
  type SteeringPromptOwnerRow,
  exactlyOne,
  reject,
} from "./task-execution-dispatcher-postgres-part-1.js";
import { clearExactLaneClaim } from "./task-execution-dispatcher-postgres-part-2.js";
import type { LeasedTaskExecutionRef, TaskExecutionTerminal } from "./task-execution-dispatcher.js";
import type { TaskSessionDbTransaction } from "./task-session/event-store.js";
import { taskSessionMessageFromRow } from "./task-session/projector.js";

export async function releaseAttempt(
  transaction: TaskSessionDbTransaction,
  options: PostgresTaskExecutionDispatcherRepositoryOptions,
  lease: LeasedTaskExecutionRef,
  state: "settled" | "failed" | "cancelled",
  at: Date,
  detach: boolean,
): Promise<void> {
  exactlyOne(
    await transaction
      .update(taskExecutionAttempts)
      .set({ state, finishedAt: at })
      .where(
        and(
          eq(taskExecutionAttempts.id, lease.attemptId),
          eq(taskExecutionAttempts.runId, lease.runId),
          eq(taskExecutionAttempts.state, "running"),
        ),
      )
      .returning({ id: taskExecutionAttempts.id }),
    "attempt terminalization lost its exact running generation",
  );
  exactlyOne(
    await transaction
      .update(taskExecutionLeases)
      .set({ state: "released", releasedAt: at })
      .where(
        and(
          eq(taskExecutionLeases.id, lease.leaseId),
          eq(taskExecutionLeases.attemptId, lease.attemptId),
          eq(taskExecutionLeases.state, "active"),
        ),
      )
      .returning({ id: taskExecutionLeases.id }),
    "attempt terminalization lost its exact active lease",
  );
  if (detach) {
    await options.runService.detachAttempt(transaction, {
      companyId: lease.ref.companyId,
      taskId: lease.ref.taskId,
      runId: lease.runId,
      expectedAttemptId: lease.attemptId,
      expectedLeaseId: lease.leaseId,
      at,
    });
  }
}

export async function settleUnsentSuffix(
  transaction: TaskSessionDbTransaction,
  runId: string,
  afterOrdinal: number,
  at: Date,
  idFactory: () => string,
): Promise<void> {
  const suffix = await transaction
    .select({ refOrdinal: taskExecutionRunRefs.refOrdinal })
    .from(taskExecutionRunRefs)
    .where(
      and(
        eq(taskExecutionRunRefs.runId, runId),
        sql`${taskExecutionRunRefs.refOrdinal} > ${afterOrdinal}`,
        isNull(taskExecutionRunRefs.protocolSettlementState),
      ),
    )
    .orderBy(asc(taskExecutionRunRefs.refOrdinal))
    .for("update");
  for (const member of suffix) {
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
            eq(taskExecutionRunRefs.runId, runId),
            eq(taskExecutionRunRefs.refOrdinal, member.refOrdinal),
            isNull(taskExecutionRunRefs.protocolSettlementState),
          ),
        )
        .returning({ runId: taskExecutionRunRefs.runId }),
      "run suffix settlement lost an untouched member",
    );
  }
}

export async function loadRecoveredProtocolSettlement(
  transaction: TaskSessionDbTransaction,
  input: {
    readonly run: RunRow;
    readonly owner: PromptOwnerRow;
    readonly segment: SteeringPromptOwnerRow | null;
  },
): Promise<{ readonly reason: string; readonly finalText: string }> {
  if (
    input.owner.protocolSettlementState !== "settled" ||
    input.owner.outcomeReferenceId === null ||
    input.owner.accountingId === null ||
    input.owner.costEventId === null
  ) {
    reject("protocol settlement recovery lost its accounting identity");
  }
  const event = exactlyOne(
    await transaction
      .select()
      .from(taskSessionEvents)
      .where(
        and(
          eq(taskSessionEvents.companyId, input.run.companyId),
          eq(taskSessionEvents.taskId, input.run.taskId),
          eq(taskSessionEvents.sessionId, input.run.sessionId),
          eq(taskSessionEvents.runId, input.run.runId),
          eq(taskSessionEvents.type, "session.next.step.ended.3"),
          eq(taskSessionEvents.sourceKind, "acp_prompt_settlement"),
          eq(taskSessionEvents.sourceId, input.owner.outcomeReferenceId),
          eq(taskSessionEvents.sourceRecordId, input.owner.accountingId),
        ),
      )
      .limit(2)
      .for("update"),
    "protocol settlement recovery lost its exact Step.Ended event",
  );
  const data = event.data as Record<string, unknown>;
  const assistantMessageId = data.assistantMessageID;
  const finish = data.finish;
  if (
    data.sessionID !== input.run.sessionId ||
    typeof assistantMessageId !== "string" ||
    assistantMessageId.length === 0 ||
    (finish !== "end_turn" &&
      finish !== "max_tokens" &&
      finish !== "max_turn_requests" &&
      finish !== "refusal" &&
      finish !== "cancelled") ||
    (finish === "refusal"
      ? input.owner.outcome !== "refused"
      : finish === "cancelled"
        ? input.owner.outcome !== "cancelled"
        : input.owner.outcome !== "succeeded") ||
    (input.segment !== null && input.segment.terminalSessionMessageId !== assistantMessageId)
  ) {
    reject("protocol settlement recovery event crossed its durable owner");
  }
  const messageRow = exactlyOne(
    await transaction
      .select()
      .from(taskSessionMessages)
      .where(
        and(
          eq(taskSessionMessages.companyId, input.run.companyId),
          eq(taskSessionMessages.taskId, input.run.taskId),
          eq(taskSessionMessages.sessionId, input.run.sessionId),
          eq(taskSessionMessages.runId, input.run.runId),
          eq(taskSessionMessages.id, assistantMessageId),
          eq(taskSessionMessages.type, "assistant"),
        ),
      )
      .limit(2)
      .for("update"),
    "protocol settlement recovery lost its terminal assistant",
  );
  const message = taskSessionMessageFromRow(messageRow);
  if (message.type !== "assistant" || message.time.completed === undefined) {
    reject("protocol settlement recovery assistant is not terminal");
  }
  return {
    reason: finish,
    finalText: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""),
  };
}

export async function completeTerminalPromptInTransaction(
  transaction: TaskSessionDbTransaction,
  options: PostgresTaskExecutionDispatcherRepositoryOptions,
  input: {
    readonly lease: LeasedTaskExecutionRef;
    readonly attempt: AttemptRow;
    readonly outcome: TaskExecutionTerminal["outcome"];
    readonly reason: string | null;
    readonly at: Date;
    readonly idFactory: () => string;
  },
): Promise<{
  readonly finalization: {
    readonly companyId: string;
    readonly taskId: string;
    readonly runId: string;
    readonly status: TaskExecutionTerminal["outcome"];
    readonly terminalReasonCode: string;
    readonly finishedAt: Date;
  } | null;
  readonly laneReleased: boolean;
  readonly autoCaptureRefId: string | null;
}> {
  if (
    input.attempt.refId !== input.lease.ref.id ||
    input.attempt.refOrdinal !== input.lease.refOrdinal ||
    input.attempt.segmentOrdinal !== input.lease.segmentOrdinal
  ) {
    reject("terminal progression crossed its exact prompt identity");
  }
  exactlyOne(
    await transaction
      .update(taskExecutionRefs)
      .set({ disposition: "terminal", updatedAt: input.at })
      .where(and(eq(taskExecutionRefs.id, input.lease.ref.id), eq(taskExecutionRefs.disposition, "active")))
      .returning({ id: taskExecutionRefs.id }),
    "terminal progression lost its active execution ref",
  );
  exactlyOne(
    await transaction
      .update(taskExecutionHistoryViews)
      .set({ state: "terminal", finalizedAt: input.at, updatedAt: input.at })
      .where(
        and(
          eq(taskExecutionHistoryViews.id, input.lease.ref.historyViewId),
          inArray(taskExecutionHistoryViews.state, ["empty", "current"]),
        ),
      )
      .returning({ id: taskExecutionHistoryViews.id }),
    "terminal progression lost its active history view",
  );
  if (input.outcome === "succeeded") {
    const next = await transaction
      .select({
        refId: taskExecutionRunRefs.refId,
        refOrdinal: taskExecutionRunRefs.refOrdinal,
      })
      .from(taskExecutionRunRefs)
      .where(
        and(
          eq(taskExecutionRunRefs.runId, input.lease.runId),
          sql`${taskExecutionRunRefs.refOrdinal} > ${input.attempt.refOrdinal!}`,
          isNull(taskExecutionRunRefs.protocolSettlementState),
        ),
      )
      .orderBy(asc(taskExecutionRunRefs.refOrdinal))
      .limit(1)
      .for("update");
    if (next[0]) {
      exactlyOne(
        await transaction
          .update(taskExecutionRunControls)
          .set({
            currentRefId: next[0].refId,
            currentOrdinal: next[0].refOrdinal,
            currentSegmentOrdinal: 0,
          })
          .where(
            and(
              eq(taskExecutionRunControls.runId, input.lease.runId),
              eq(taskExecutionRunControls.currentRefId, input.lease.ref.id),
              eq(taskExecutionRunControls.currentOrdinal, input.lease.refOrdinal),
              eq(taskExecutionRunControls.currentSegmentOrdinal, input.lease.segmentOrdinal),
            ),
          )
          .returning({ runId: taskExecutionRunControls.runId }),
        "run could not advance to its next immutable member",
      );
      await clearExactLaneClaim(transaction, {
        ref: input.lease.ref,
        laneOrdinal: input.lease.ref.laneOrdinal,
        leaseGeneration: input.lease.leaseGeneration,
        leaseId: input.lease.leaseId,
        at: input.at,
      });
      return { finalization: null, laneReleased: true, autoCaptureRefId: null };
    }
  } else {
    await settleUnsentSuffix(
      transaction,
      input.lease.runId,
      input.attempt.refOrdinal!,
      input.at,
      input.idFactory,
    );
  }
  exactlyOne(
    await transaction
      .update(taskExecutionRunControls)
      .set({
        currentRefId: null,
        currentOrdinal: null,
        currentSegmentOrdinal: null,
      })
      .where(
        and(
          eq(taskExecutionRunControls.runId, input.lease.runId),
          eq(taskExecutionRunControls.currentRefId, input.lease.ref.id),
          eq(taskExecutionRunControls.currentOrdinal, input.lease.refOrdinal),
          eq(taskExecutionRunControls.currentSegmentOrdinal, input.lease.segmentOrdinal),
        ),
      )
      .returning({ runId: taskExecutionRunControls.runId }),
    "terminal run could not clear its prompt control",
  );
  const finalization = {
    companyId: input.lease.ref.companyId,
    taskId: input.lease.ref.taskId,
    runId: input.lease.runId,
    status: input.outcome,
    terminalReasonCode: (input.reason?.trim() || input.outcome).slice(0, 200),
    finishedAt: input.at,
  } as const;
  const finalized = await options.finalizer.finalizeInTransaction(transaction, finalization);
  await clearExactLaneClaim(transaction, {
    ref: input.lease.ref,
    laneOrdinal: input.lease.ref.laneOrdinal,
    leaseGeneration: input.lease.leaseGeneration,
    leaseId: input.lease.leaseId,
    at: input.at,
  });
  return {
    finalization,
    laneReleased: true,
    autoCaptureRefId: finalized.autoCaptureRefId,
  };
}
