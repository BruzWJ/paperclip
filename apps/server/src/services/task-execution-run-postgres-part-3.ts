import {
  taskCommentProjectionSources,
  taskComments,
  taskExecutionAttempts,
  taskExecutionCancellationIntents,
  taskExecutionLeases,
  taskExecutionPromptSegments,
  taskExecutionRunControls,
  taskSessionInputs,
  taskSessionMessages,
  type Db,
} from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  PostgresTaskExecutionSteeringRepositoryOptions,
  noPromptAttachments,
  sourceMessageText,
  terminalSteeringResult,
  type CreatePostgresTaskExecutionSteeringRepositoryResult,
} from "./task-execution-run-postgres-shared-part-1.js";
import {
  TaskExecutionRunInvariantViolation,
  lockTaskExecutionRunInTransaction,
  type PendingTaskExecutionSteeringForSource,
} from "./task-execution-run-service.js";

export function createPostgresTaskExecutionSteeringRepositoryPart3(
  db: Db,
  options: PostgresTaskExecutionSteeringRepositoryOptions = {},
) {
  const clock = options.now ?? (() => new Date());
  const idFactory = options.idFactory ?? randomUUID;
  return {
    async findPendingForSource(input) {
      const ambiguous = (reason: string): PendingTaskExecutionSteeringForSource => ({
        kind: "ambiguous",
        reason,
      });
      return db.transaction(async (transaction) => {
        const sourceRows = await transaction
          .select()
          .from(taskCommentProjectionSources)
          .where(
            and(
              eq(taskCommentProjectionSources.companyId, input.companyId),
              eq(taskCommentProjectionSources.taskId, input.taskId),
              eq(taskCommentProjectionSources.commentId, input.sourceCommentId),
            ),
          )
          .limit(2)
          .for("update");
        if (sourceRows.length !== 1) {
          return ambiguous("Persisted steering source does not resolve one canonical comment");
        }
        const source = sourceRows[0]!;
        if (
          (source.sourceKind !== "human_comment" && source.sourceKind !== "harness_delivery") ||
          source.steeringTargetRunId === null ||
          source.refId === null ||
          source.refOrdinal === null ||
          source.segmentOrdinal === null ||
          source.segmentOrdinal < 1
        ) {
          return ambiguous("Persisted source is not bound to one positive steering segment");
        }
        let run;
        try {
          run = await lockTaskExecutionRunInTransaction(transaction, {
            companyId: input.companyId,
            taskId: input.taskId,
            runId: source.steeringTargetRunId,
          });
        } catch (error) {
          if (error instanceof TaskExecutionRunInvariantViolation) {
            return ambiguous("Persisted steering source lost its canonical run envelope");
          }
          throw error;
        }
        const [segmentRows, controlRows, sourceMessageRows, sourceCommentRows] = await Promise.all([
          transaction
            .select()
            .from(taskExecutionPromptSegments)
            .where(
              and(
                eq(taskExecutionPromptSegments.runId, run.runId),
                eq(taskExecutionPromptSegments.refId, source.refId),
                eq(taskExecutionPromptSegments.refOrdinal, source.refOrdinal),
                eq(taskExecutionPromptSegments.segmentOrdinal, source.segmentOrdinal),
                eq(taskExecutionPromptSegments.sourceCommentId, input.sourceCommentId),
              ),
            )
            .limit(2)
            .for("update"),
          transaction
            .select()
            .from(taskExecutionRunControls)
            .where(eq(taskExecutionRunControls.runId, run.runId))
            .limit(2)
            .for("update"),
          transaction
            .select()
            .from(taskSessionMessages)
            .where(
              and(
                eq(taskSessionMessages.companyId, input.companyId),
                eq(taskSessionMessages.taskId, input.taskId),
                eq(taskSessionMessages.sessionId, source.sessionId),
                eq(taskSessionMessages.id, source.messageId),
              ),
            )
            .limit(2)
            .for("update"),
          transaction
            .select()
            .from(taskComments)
            .where(
              and(
                eq(taskComments.companyId, input.companyId),
                eq(taskComments.taskId, input.taskId),
                eq(taskComments.sessionId, source.sessionId),
                eq(taskComments.id, input.sourceCommentId),
              ),
            )
            .limit(2)
            .for("update"),
        ]);
        if (
          segmentRows.length !== 1 ||
          controlRows.length !== 1 ||
          sourceMessageRows.length !== 1 ||
          sourceCommentRows.length !== 1
        ) {
          return ambiguous("Persisted steering source lost its segment, control, or exact Session message");
        }
        const segment = segmentRows[0]!;
        const control = controlRows[0]!;
        const sourceMessage = sourceMessageRows[0]!;
        const sourceComment = sourceCommentRows[0]!;
        const decodedSource = sourceMessageText(sourceMessage);
        const sourceInputRows =
          segment.sourceInputId === null
            ? []
            : await transaction
                .select()
                .from(taskSessionInputs)
                .where(
                  and(
                    eq(taskSessionInputs.companyId, input.companyId),
                    eq(taskSessionInputs.taskId, input.taskId),
                    eq(taskSessionInputs.sessionId, source.sessionId),
                    eq(taskSessionInputs.id, segment.sourceInputId),
                  ),
                )
                .limit(2)
                .for("update");
        const sourceInput = sourceInputRows[0] ?? null;
        if (
          run.sessionId !== source.sessionId ||
          segment.companyId !== input.companyId ||
          segment.taskId !== input.taskId ||
          segment.sessionId !== source.sessionId ||
          segment.sourceMessageId !== sourceMessage.id ||
          source.messageId !== sourceMessage.id ||
          sourceComment.canonicalMessageId !== sourceMessage.id ||
          sourceComment.canonicalSourceKind !== source.sourceKind ||
          sourceComment.body !== decodedSource?.text ||
          !decodedSource ||
          (decodedSource.kind === "user" &&
            (source.sourceKind !== "human_comment" ||
              sourceComment.authorType !== "user" ||
              sourceComment.runId !== null ||
              segment.sourceInputId !== sourceMessage.id ||
              sourceInputRows.length !== 1 ||
              !sourceInput ||
              sourceInput.delivery !== "steer" ||
              sourceInput.promotedSeq === null ||
              !noPromptAttachments(sourceInput.prompt) ||
              sourceInput.prompt.text !== decodedSource.text)) ||
          (decodedSource.kind === "synthetic" &&
            (source.sourceKind !== "harness_delivery" ||
              sourceComment.authorType !== "agent" ||
              sourceComment.authorAgentId !== sourceMessage.agentId ||
              sourceComment.runId !== sourceMessage.runId ||
              segment.sourceInputId !== null ||
              sourceInputRows.length !== 0))
        ) {
          return ambiguous("Persisted steering source crossed its canonical Session message identity");
        }
        const rebound = Object.freeze({
          companyId: run.companyId,
          taskId: run.taskId,
          ownershipEpoch: run.ownershipEpoch,
          runId: run.runId,
          targetAgentId: run.targetAgentId,
          refId: segment.refId,
          refOrdinal: segment.refOrdinal,
          segmentOrdinal: segment.segmentOrdinal,
        });
        if (segment.protocolSettlementState !== null) {
          const terminalMessageRows =
            segment.terminalSessionMessageId === null
              ? []
              : await transaction
                  .select()
                  .from(taskSessionMessages)
                  .where(
                    and(
                      eq(taskSessionMessages.companyId, input.companyId),
                      eq(taskSessionMessages.taskId, input.taskId),
                      eq(taskSessionMessages.sessionId, source.sessionId),
                      eq(taskSessionMessages.id, segment.terminalSessionMessageId),
                    ),
                  )
                  .limit(2)
                  .for("update");
          const result =
            segment.steeringState === "protocol_settled" && terminalMessageRows.length <= 1
              ? terminalSteeringResult({
                  run,
                  segment,
                  assistant: terminalMessageRows[0] ?? null,
                })
              : null;
          return result
            ? { kind: "terminal", result }
            : ambiguous("Settled steering source lost its canonical terminal result");
        }
        if (segment.terminalSessionMessageId !== null) {
          return ambiguous("Unsettled steering source references a terminal Session message");
        }
        if (run.status !== "running") {
          return ambiguous("Steering run terminalized before its positive segment settled");
        }
        if (run.terminalFinalizationId !== null || run.finishedAt !== null) {
          return ambiguous("Persisted steering source no longer targets an active agent run");
        }
        if (segment.steeringState === "resumed") {
          return { kind: "resumed" };
        }
        if (segment.steeringState === "rebound") {
          if (
            run.currentAttemptId !== null ||
            run.currentLeaseId !== null ||
            run.cancellationIntentId !== null ||
            control.currentRefId !== segment.refId ||
            control.currentOrdinal !== segment.refOrdinal ||
            control.currentSegmentOrdinal !== segment.segmentOrdinal
          ) {
            return ambiguous("Rebound steering source crossed its resumable run control");
          }
          return { kind: "rebound", rebound };
        }
        if (
          segment.steeringState !== "requested" &&
          segment.steeringState !== "sent" &&
          segment.steeringState !== "protocol_settled"
        ) {
          return ambiguous("Persisted steering state is not recoverable");
        }
        if (segment.cancellationIntentId === null) {
          return ambiguous("Requested steering segment lost its cancellation intent");
        }
        const [intentRows, attemptRows, leaseRows] = await Promise.all([
          transaction
            .select()
            .from(taskExecutionCancellationIntents)
            .where(
              and(
                eq(taskExecutionCancellationIntents.id, segment.cancellationIntentId),
                eq(taskExecutionCancellationIntents.runId, run.runId),
              ),
            )
            .limit(2)
            .for("update"),
          transaction
            .select()
            .from(taskExecutionAttempts)
            .where(eq(taskExecutionAttempts.id, run.currentAttemptId!))
            .limit(2)
            .for("update"),
          transaction
            .select()
            .from(taskExecutionLeases)
            .where(eq(taskExecutionLeases.id, run.currentLeaseId!))
            .limit(2)
            .for("update"),
        ]);
        if (intentRows.length !== 1 || attemptRows.length !== 1 || leaseRows.length !== 1) {
          return ambiguous("Requested steering source lost its exact attempt or lease");
        }
        const intent = intentRows[0]!;
        const attempt = attemptRows[0]!;
        const lease = leaseRows[0]!;
        const interruptedSegmentOrdinal = segment.segmentOrdinal - 1;
        if (
          intent.state === "failed" ||
          intent.reasonKind !== "steering" ||
          intent.attemptId !== attempt.id ||
          intent.leaseId !== lease.id ||
          run.currentAttemptId !== attempt.id ||
          run.currentLeaseId !== lease.id ||
          run.cancellationIntentId !== intent.id ||
          attempt.companyId !== run.companyId ||
          attempt.taskId !== run.taskId ||
          attempt.sessionId !== run.sessionId ||
          attempt.runId !== run.runId ||
          attempt.runKind !== run.kind ||
          attempt.refId !== segment.refId ||
          attempt.refOrdinal !== segment.refOrdinal ||
          attempt.segmentOrdinal !== interruptedSegmentOrdinal ||
          attempt.promptKind !== (interruptedSegmentOrdinal === 0 ? "base" : "steering") ||
          lease.companyId !== run.companyId ||
          lease.taskId !== run.taskId ||
          lease.runId !== run.runId ||
          lease.attemptId !== attempt.id ||
          control.currentRefId !== segment.refId ||
          control.currentOrdinal !== segment.refOrdinal ||
          control.currentSegmentOrdinal !== interruptedSegmentOrdinal
        ) {
          return ambiguous("Requested steering source crossed its interrupted prompt identity");
        }
        return {
          kind: "requested",
          request: Object.freeze({
            companyId: run.companyId,
            taskId: run.taskId,
            ownershipEpoch: run.ownershipEpoch,
            runId: run.runId,
            targetAgentId: run.targetAgentId,
            refId: segment.refId,
            refOrdinal: segment.refOrdinal,
            interruptedSegmentOrdinal,
            segmentOrdinal: segment.segmentOrdinal,
            sourceCommentId: input.sourceCommentId,
            sourceMessageId: sourceMessage.id,
            sourceInputId: segment.sourceInputId,
            cancellationIntentId: intent.id,
            cancellation: Object.freeze({
              companyId: run.companyId,
              taskId: run.taskId,
              sessionId: run.sessionId,
              executionScopeId: run.executionScopeId,
              refId: segment.refId,
              runId: run.runId,
              attemptId: attempt.id,
              leaseGeneration: lease.leaseGeneration,
            }),
          }),
        };
      });
    },
  } satisfies Partial<CreatePostgresTaskExecutionSteeringRepositoryResult>;
}
