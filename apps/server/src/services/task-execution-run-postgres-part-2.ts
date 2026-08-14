import {
  taskExecutionCancellationIntents,
  taskExecutionPromptSegments,
  taskExecutionRunControls,
  type Db,
} from "@paperclipai/db";
import { and, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  boundedPositiveInteger,
  exactlyOne,
  reject,
  sameRequestIdentity,
  type CreatePostgresTaskExecutionSteeringRepositoryResult,
  type PostgresTaskExecutionSteeringRepositoryOptions,
} from "./task-execution-run-postgres-shared-part-1.js";
import {
  clearSteeringCancellationAndAttemptInTransaction,
  lockReboundSteeringRunInTransaction,
  lockSteerableRunInTransaction,
} from "./task-execution-run-service.js";

import { createTaskExecutionSteeringSettlementInspector } from "./task-execution-run-postgres-settlement-inspector.js";
export function createPostgresTaskExecutionSteeringRepositoryPart2(
  db: Db,
  options: PostgresTaskExecutionSteeringRepositoryOptions = {},
) {
  const clock = options.now ?? (() => new Date());
  const idFactory = options.idFactory ?? randomUUID;
  const settlementTimeoutMs = boundedPositiveInteger(
    options.settlementTimeoutMs,
    30000,
    "steering settlement timeout",
  );
  const settlementPollIntervalMs = boundedPositiveInteger(
    options.settlementPollIntervalMs,
    25,
    "steering settlement poll interval",
  );
  const wait =
    options.wait ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const inspectSettlement = createTaskExecutionSteeringSettlementInspector(db);
  return {
    async recordCancellationSignal({ request, delivered }) {
      await db.transaction(async (transaction) => {
        const now = clock();
        const intent = exactlyOne(
          await transaction
            .select()
            .from(taskExecutionCancellationIntents)
            .where(eq(taskExecutionCancellationIntents.id, request.cancellationIntentId))
            .limit(2)
            .for("update"),
          "Steering cancellation intent disappeared",
        );
        const segment = exactlyOne(
          await transaction
            .select()
            .from(taskExecutionPromptSegments)
            .where(
              and(
                eq(taskExecutionPromptSegments.runId, request.runId),
                eq(taskExecutionPromptSegments.refId, request.refId),
                eq(taskExecutionPromptSegments.refOrdinal, request.refOrdinal),
                eq(taskExecutionPromptSegments.segmentOrdinal, request.segmentOrdinal),
              ),
            )
            .limit(2)
            .for("update"),
          "Steering segment disappeared before cancellation signal",
        );
        if (
          !sameRequestIdentity(request, {
            companyId: intent.companyId,
            taskId: intent.taskId,
            runId: intent.runId,
            refId: segment.refId,
            refOrdinal: segment.refOrdinal,
            segmentOrdinal: segment.segmentOrdinal,
            cancellationIntentId: intent.id,
          }) ||
          segment.cancellationIntentId !== intent.id
        ) {
          reject("Steering cancellation signal crossed canonical identity");
        }
        if (!delivered) return;
        if (
          (intent.state === "acknowledged" && segment.steeringState === "sent") ||
          (intent.state === "completed" && segment.steeringState === "protocol_settled")
        ) {
          return;
        }
        if (intent.state !== "requested" || segment.steeringState !== "requested") {
          reject("Steering cancellation signal was already consumed");
        }
        await transaction
          .update(taskExecutionCancellationIntents)
          .set({
            state: "acknowledged",
            acknowledgedAt: now,
          })
          .where(eq(taskExecutionCancellationIntents.id, intent.id));
        await transaction
          .update(taskExecutionPromptSegments)
          .set({ steeringState: "sent" })
          .where(
            and(
              eq(taskExecutionPromptSegments.runId, segment.runId),
              eq(taskExecutionPromptSegments.refOrdinal, segment.refOrdinal),
              eq(taskExecutionPromptSegments.refId, segment.refId),
              eq(taskExecutionPromptSegments.segmentOrdinal, segment.segmentOrdinal),
            ),
          );
      });
    },
    async awaitCancellationSettlement(request) {
      const startedAt = Date.now();
      while (Date.now() - startedAt < settlementTimeoutMs) {
        const observed = await inspectSettlement(request);
        if (observed.kind === "ambiguous") {
          return {
            kind: "ambiguous",
            cancellationIntentId: request.cancellationIntentId,
            reason: observed.reason,
          };
        }
        if (observed.kind === "settled") {
          await db.transaction(async (transaction) => {
            const now = clock();
            const intent = exactlyOne(
              await transaction
                .select()
                .from(taskExecutionCancellationIntents)
                .where(eq(taskExecutionCancellationIntents.id, request.cancellationIntentId))
                .limit(2)
                .for("update"),
              "Steering cancellation intent disappeared at settlement",
            );
            if (intent.state === "failed") {
              reject("Steering settlement changed while committing its fence");
            }
            if (intent.state !== "completed") {
              await transaction
                .update(taskExecutionCancellationIntents)
                .set({
                  state: "completed",
                  acknowledgedAt: intent.acknowledgedAt ?? now,
                  completedAt: now,
                })
                .where(eq(taskExecutionCancellationIntents.id, intent.id));
            }
            await transaction
              .update(taskExecutionPromptSegments)
              .set({ steeringState: "protocol_settled" })
              .where(
                and(
                  eq(taskExecutionPromptSegments.runId, request.runId),
                  eq(taskExecutionPromptSegments.refId, request.refId),
                  eq(taskExecutionPromptSegments.refOrdinal, request.refOrdinal),
                  eq(taskExecutionPromptSegments.segmentOrdinal, request.segmentOrdinal),
                  inArray(taskExecutionPromptSegments.steeringState, [
                    "requested",
                    "sent",
                    "protocol_settled",
                  ]),
                ),
              );
          });
          return {
            kind: "settled",
            cancellationIntentId: request.cancellationIntentId,
          };
        }
        await wait(settlementPollIntervalMs);
      }
      return {
        kind: "pending",
        cancellationIntentId: request.cancellationIntentId,
      };
    },
    async markAmbiguous({ request, reason }) {
      await db.transaction(async (transaction) => {
        const now = clock();
        const intent = await transaction
          .select()
          .from(taskExecutionCancellationIntents)
          .where(eq(taskExecutionCancellationIntents.id, request.cancellationIntentId))
          .limit(1)
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!intent || intent.state === "completed") return;
        const failureCode = reason.trim().slice(0, 200) || "steering_cancellation_ambiguous";
        await transaction
          .update(taskExecutionCancellationIntents)
          .set({
            state: "failed",
            failedAt: now,
            failureCode,
          })
          .where(eq(taskExecutionCancellationIntents.id, intent.id));
      });
    },
    async rebindAfterCancellation(request) {
      return db.transaction(async (transaction) => {
        const now = clock();
        const run = await lockSteerableRunInTransaction(transaction, {
          companyId: request.companyId,
          taskId: request.taskId,
          runId: request.runId,
          ownershipEpoch: request.ownershipEpoch,
          targetAgentId: request.targetAgentId,
        });
        const control = exactlyOne(
          await transaction
            .select()
            .from(taskExecutionRunControls)
            .where(eq(taskExecutionRunControls.runId, request.runId))
            .limit(2)
            .for("update"),
          "Steering run control disappeared before rebound",
        );
        const segment = exactlyOne(
          await transaction
            .select()
            .from(taskExecutionPromptSegments)
            .where(
              and(
                eq(taskExecutionPromptSegments.runId, request.runId),
                eq(taskExecutionPromptSegments.refId, request.refId),
                eq(taskExecutionPromptSegments.refOrdinal, request.refOrdinal),
                eq(taskExecutionPromptSegments.segmentOrdinal, request.segmentOrdinal),
              ),
            )
            .limit(2)
            .for("update"),
          "Steering segment disappeared before rebound",
        );
        const intent = exactlyOne(
          await transaction
            .select()
            .from(taskExecutionCancellationIntents)
            .where(eq(taskExecutionCancellationIntents.id, request.cancellationIntentId))
            .limit(2)
            .for("update"),
          "Steering cancellation intent disappeared before rebound",
        );
        if (
          run.companyId !== request.companyId ||
          run.taskId !== request.taskId ||
          run.ownershipEpoch !== request.ownershipEpoch ||
          run.targetAgentId !== request.targetAgentId ||
          run.status !== "running" ||
          run.cancellationIntentId !== intent.id ||
          control.currentRefId !== request.refId ||
          control.currentOrdinal !== request.refOrdinal ||
          control.currentSegmentOrdinal !== request.interruptedSegmentOrdinal ||
          intent.state !== "completed" ||
          segment.cancellationIntentId !== intent.id ||
          segment.steeringState !== "protocol_settled" ||
          segment.protocolSettlementState !== null
        ) {
          reject("Steering rebound crossed or skipped its durable fence");
        }
        await transaction
          .update(taskExecutionRunControls)
          .set({ currentSegmentOrdinal: request.segmentOrdinal })
          .where(eq(taskExecutionRunControls.runId, request.runId));
        await transaction
          .update(taskExecutionPromptSegments)
          .set({ steeringState: "rebound" })
          .where(
            and(
              eq(taskExecutionPromptSegments.runId, request.runId),
              eq(taskExecutionPromptSegments.refId, request.refId),
              eq(taskExecutionPromptSegments.refOrdinal, request.refOrdinal),
              eq(taskExecutionPromptSegments.segmentOrdinal, request.segmentOrdinal),
            ),
          );
        await clearSteeringCancellationAndAttemptInTransaction(transaction, {
          companyId: request.companyId,
          taskId: request.taskId,
          runId: request.runId,
          cancellationIntentId: request.cancellationIntentId,
          expectedAttemptId: request.cancellation.attemptId!,
          expectedLeaseId: run.currentLeaseId,
          at: now,
        });
        return Object.freeze({
          companyId: request.companyId,
          taskId: request.taskId,
          ownershipEpoch: request.ownershipEpoch,
          runId: request.runId,
          targetAgentId: request.targetAgentId,
          refId: request.refId,
          refOrdinal: request.refOrdinal,
          segmentOrdinal: request.segmentOrdinal,
        });
      });
    },
    async markResumeReady(rebound) {
      await db.transaction(async (transaction) => {
        const [run, control, segment] = await Promise.all([
          lockReboundSteeringRunInTransaction(transaction, {
            companyId: rebound.companyId,
            taskId: rebound.taskId,
            runId: rebound.runId,
            ownershipEpoch: rebound.ownershipEpoch,
            targetAgentId: rebound.targetAgentId,
          }),
          transaction
            .select()
            .from(taskExecutionRunControls)
            .where(eq(taskExecutionRunControls.runId, rebound.runId))
            .limit(1)
            .for("update")
            .then((rows) => rows[0] ?? null),
          transaction
            .select()
            .from(taskExecutionPromptSegments)
            .where(
              and(
                eq(taskExecutionPromptSegments.runId, rebound.runId),
                eq(taskExecutionPromptSegments.refId, rebound.refId),
                eq(taskExecutionPromptSegments.refOrdinal, rebound.refOrdinal),
                eq(taskExecutionPromptSegments.segmentOrdinal, rebound.segmentOrdinal),
              ),
            )
            .limit(1)
            .for("update")
            .then((rows) => rows[0] ?? null),
        ]);
        if (
          !control ||
          !segment ||
          run.companyId !== rebound.companyId ||
          run.taskId !== rebound.taskId ||
          run.ownershipEpoch !== rebound.ownershipEpoch ||
          run.targetAgentId !== rebound.targetAgentId ||
          run.status !== "running" ||
          run.currentAttemptId !== null ||
          run.currentLeaseId !== null ||
          run.cancellationIntentId !== null ||
          control.currentRefId !== rebound.refId ||
          control.currentOrdinal !== rebound.refOrdinal ||
          control.currentSegmentOrdinal !== rebound.segmentOrdinal ||
          segment.steeringState !== "rebound"
        ) {
          reject("Steering resume readiness crossed the rebound identity");
        }
        await transaction
          .update(taskExecutionPromptSegments)
          .set({ steeringState: "resumed" })
          .where(
            and(
              eq(taskExecutionPromptSegments.runId, rebound.runId),
              eq(taskExecutionPromptSegments.refId, rebound.refId),
              eq(taskExecutionPromptSegments.refOrdinal, rebound.refOrdinal),
              eq(taskExecutionPromptSegments.segmentOrdinal, rebound.segmentOrdinal),
            ),
          );
      });
    },
  } satisfies Partial<CreatePostgresTaskExecutionSteeringRepositoryResult>;
}
