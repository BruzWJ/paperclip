import {
  taskExecutionAttempts,
  taskExecutionCancellationIntents,
  taskExecutionLeases,
  taskExecutionPromptSegments,
  taskExecutionRunRefs,
  type Db,
} from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { type RequestedTaskExecutionSteering } from "./task-execution-run-service.js";

export function createTaskExecutionSteeringSettlementInspector(db: Db) {
  async function inspectSettlement(request: RequestedTaskExecutionSteering): Promise<
    | {
        readonly kind: "pending";
      }
    | {
        readonly kind: "settled";
      }
    | {
        readonly kind: "ambiguous";
        readonly reason: string;
      }
  > {
    const [intentRows, attemptRows, leaseRows, promptRows] = await Promise.all([
      db
        .select()
        .from(taskExecutionCancellationIntents)
        .where(
          and(
            eq(taskExecutionCancellationIntents.id, request.cancellationIntentId),
            eq(taskExecutionCancellationIntents.runId, request.runId),
            eq(taskExecutionCancellationIntents.attemptId, request.cancellation.attemptId!),
          ),
        )
        .limit(2),
      db
        .select()
        .from(taskExecutionAttempts)
        .where(eq(taskExecutionAttempts.id, request.cancellation.attemptId!))
        .limit(2),
      db
        .select()
        .from(taskExecutionLeases)
        .where(
          and(
            eq(taskExecutionLeases.attemptId, request.cancellation.attemptId!),
            eq(taskExecutionLeases.leaseGeneration, request.cancellation.leaseGeneration),
          ),
        )
        .limit(2),
      request.interruptedSegmentOrdinal === 0
        ? db
            .select({
              protocolSettlementState: taskExecutionRunRefs.protocolSettlementState,
              outcome: taskExecutionRunRefs.outcome,
            })
            .from(taskExecutionRunRefs)
            .where(
              and(
                eq(taskExecutionRunRefs.runId, request.runId),
                eq(taskExecutionRunRefs.refId, request.refId),
                eq(taskExecutionRunRefs.refOrdinal, request.refOrdinal),
              ),
            )
            .limit(2)
        : db
            .select({
              protocolSettlementState: taskExecutionPromptSegments.protocolSettlementState,
              outcome: taskExecutionPromptSegments.outcome,
            })
            .from(taskExecutionPromptSegments)
            .where(
              and(
                eq(taskExecutionPromptSegments.runId, request.runId),
                eq(taskExecutionPromptSegments.refId, request.refId),
                eq(taskExecutionPromptSegments.refOrdinal, request.refOrdinal),
                eq(taskExecutionPromptSegments.segmentOrdinal, request.interruptedSegmentOrdinal),
              ),
            )
            .limit(2),
    ]);
    if (
      intentRows.length !== 1 ||
      attemptRows.length !== 1 ||
      leaseRows.length !== 1 ||
      promptRows.length !== 1
    ) {
      return {
        kind: "ambiguous",
        reason: "cancellation settlement lost a canonical prompt identity",
      };
    }
    const intent = intentRows[0]!;
    const attempt = attemptRows[0]!;
    const prompt = promptRows[0]!;
    const lease = leaseRows[0]!;
    if (intent.state === "failed") {
      return {
        kind: "ambiguous",
        reason: intent.failureCode ?? "steering cancellation failed",
      };
    }
    const nativeCancelledIncomplete =
      prompt.protocolSettlementState === "incomplete" &&
      prompt.outcome === "cancelled" &&
      intent.nativeCancellationSettledAt !== null;
    if (prompt.protocolSettlementState === "incomplete" && !nativeCancelledIncomplete) {
      return {
        kind: "ambiguous",
        reason: "old ACP prompt settled incompletely",
      };
    }
    if (
      (prompt.protocolSettlementState === "settled" ||
        prompt.protocolSettlementState === "not_sent" ||
        nativeCancelledIncomplete) &&
      ["settled", "cancelled", "failed"].includes(attempt.state) &&
      lease.state !== "active"
    ) {
      return { kind: "settled" };
    }
    return { kind: "pending" };
  }
  return inspectSettlement;
}
