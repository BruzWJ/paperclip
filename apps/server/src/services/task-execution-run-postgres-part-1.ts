import {
  taskCommentProjectionSources,
  taskComments,
  taskExecutionAttempts,
  taskExecutionCancellationIntents,
  taskExecutionLeases,
  taskExecutionPromptCapabilities,
  taskExecutionPromptSegments,
  taskExecutionRunControls,
  taskExecutionRunRefs,
  taskExecutionSessions,
  taskSessionInputs,
  taskSessionMessages,
  type Db,
} from "@paperclipai/db";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  activePromptMemberMatches,
  actorMatchesComment,
  exactlyOne,
  noPromptAttachments,
  reject,
  requestedResult,
  sourceMessageText,
  type CreatePostgresTaskExecutionSteeringRepositoryResult,
  type PostgresTaskExecutionSteeringRepositoryOptions,
} from "./task-execution-run-postgres-shared-part-1.js";
import {
  attachSteeringCancellationInTransaction,
  lockSteerableRunInTransaction,
} from "./task-execution-run-service.js";
import { promoteActiveRunSteeringInputInTransaction } from "./task-session/input.js";
export function createPostgresTaskExecutionSteeringRepositoryPart1(
  db: Db,
  options: PostgresTaskExecutionSteeringRepositoryOptions = {},
) {
  const clock = options.now ?? (() => new Date());
  const idFactory = options.idFactory ?? randomUUID;
  return {
    async requestInTransaction(transaction, input) {
      const now = clock();
      const run = await lockSteerableRunInTransaction(transaction, {
        companyId: input.companyId,
        taskId: input.taskId,
        runId: input.runId,
        ownershipEpoch: input.ownershipEpoch,
        targetAgentId: input.targetAgentId,
      });
      if (run.cancellationIntentId !== null) {
        reject("Selected run already has an active cancellation intent");
      }
      const control = exactlyOne(
        await transaction
          .select()
          .from(taskExecutionRunControls)
          .where(eq(taskExecutionRunControls.runId, run.runId))
          .limit(2)
          .for("update"),
        "Selected run has no unambiguous current prompt control",
      );
      if (
        control.currentRefId === null ||
        control.currentOrdinal === null ||
        control.currentSegmentOrdinal === null
      ) {
        reject("Selected run has no active steerable prompt");
      }
      const member = exactlyOne(
        await transaction
          .select()
          .from(taskExecutionRunRefs)
          .where(
            and(
              eq(taskExecutionRunRefs.runId, run.runId),
              eq(taskExecutionRunRefs.refId, control.currentRefId),
              eq(taskExecutionRunRefs.refOrdinal, control.currentOrdinal),
            ),
          )
          .limit(2)
          .for("update"),
        "Selected run control does not resolve one immutable member",
      );
      if (member.protocolSettlementState !== null) {
        reject("Selected run member is already settled");
      }
      const currentSegment =
        control.currentSegmentOrdinal === 0
          ? null
          : exactlyOne(
              await transaction
                .select()
                .from(taskExecutionPromptSegments)
                .where(
                  and(
                    eq(taskExecutionPromptSegments.runId, run.runId),
                    eq(taskExecutionPromptSegments.refId, control.currentRefId),
                    eq(taskExecutionPromptSegments.refOrdinal, control.currentOrdinal),
                    eq(taskExecutionPromptSegments.segmentOrdinal, control.currentSegmentOrdinal),
                  ),
                )
                .limit(2)
                .for("update"),
              "Selected run control does not resolve one current steering segment",
            );
      if (currentSegment !== null && currentSegment.protocolSettlementState !== null) {
        reject("Selected steering segment is already settled");
      }
      const attempt = exactlyOne(
        await transaction
          .select()
          .from(taskExecutionAttempts)
          .where(eq(taskExecutionAttempts.id, run.currentAttemptId!))
          .limit(2)
          .for("update"),
        "Selected run has no exact current attempt",
      );
      const lease = exactlyOne(
        await transaction
          .select()
          .from(taskExecutionLeases)
          .where(eq(taskExecutionLeases.id, run.currentLeaseId!))
          .limit(2)
          .for("update"),
        "Selected run has no exact current lease",
      );
      if (
        !activePromptMemberMatches({
          run,
          control,
          attempt,
          lease,
        }) ||
        lease.expiresAt <= now
      ) {
        reject("Selected run attempt/lease is not exactly active");
      }
      const capability = exactlyOne(
        await transaction
          .select()
          .from(taskExecutionPromptCapabilities)
          .where(
            and(
              eq(taskExecutionPromptCapabilities.companyId, run.companyId),
              eq(taskExecutionPromptCapabilities.runId, run.runId),
              eq(taskExecutionPromptCapabilities.refId, control.currentRefId),
              eq(taskExecutionPromptCapabilities.refOrdinal, control.currentOrdinal),
              eq(taskExecutionPromptCapabilities.segmentOrdinal, control.currentSegmentOrdinal),
              eq(taskExecutionPromptCapabilities.attemptId, attempt.id),
              eq(taskExecutionPromptCapabilities.leaseId, lease.id),
              eq(taskExecutionPromptCapabilities.state, "active"),
              gt(taskExecutionPromptCapabilities.expiresAt, now),
            ),
          )
          .limit(2)
          .for("update"),
        "Selected run has no unambiguous active request capability",
      );
      const expectedCapabilityConnectionId =
        currentSegment?.capabilityConnectionId ?? member.capabilityConnectionId;
      const expectedCapabilityGeneration =
        currentSegment?.capabilityGeneration ?? member.capabilityGeneration;
      if (
        expectedCapabilityConnectionId !== capability.capabilityConnectionId ||
        expectedCapabilityGeneration !== capability.capabilityGeneration ||
        capability.leaseGeneration !== lease.leaseGeneration ||
        capability.targetSessionCorrelationId === null
      ) {
        reject("Selected prompt capability generation is stale");
      }
      const correlation = exactlyOne(
        await transaction
          .select()
          .from(taskExecutionSessions)
          .where(
            and(
              eq(taskExecutionSessions.id, capability.targetSessionCorrelationId),
              eq(taskExecutionSessions.companyId, run.companyId),
              eq(taskExecutionSessions.taskId, run.taskId),
              eq(taskExecutionSessions.ownershipEpoch, run.ownershipEpoch),
              eq(taskExecutionSessions.targetAgentId, run.targetAgentId),
              eq(taskExecutionSessions.adapterConfigIdentity, run.adapterConfigRevisionId),
              eq(taskExecutionSessions.workspaceIdentity, run.executionWorkspaceBindingId),
            ),
          )
          .limit(2)
          .for("update"),
        "Selected prompt has no unambiguous protected target session",
      );
      const carryTargetIsExact =
        correlation.purpose === "carry" &&
        correlation.state === "eligible" &&
        correlation.laneKind === run.executionMode &&
        correlation.runId === null &&
        correlation.currentRefId === null &&
        correlation.currentRefOrdinal === null &&
        correlation.currentSegmentOrdinal === null &&
        correlation.authorizedContextExposureDigest === capability.effectiveContextExposureDigest;
      const activeRunTargetIsExact =
        correlation.purpose === "active_run_steering" &&
        correlation.state === "current" &&
        correlation.laneKind === null &&
        correlation.runId === run.runId &&
        correlation.currentRefId === control.currentRefId &&
        correlation.currentRefOrdinal === control.currentOrdinal &&
        correlation.currentSegmentOrdinal === control.currentSegmentOrdinal &&
        correlation.authorizedContextExposureDigest === null;
      if (!carryTargetIsExact && !activeRunTargetIsExact) {
        reject("Selected prompt protected target session crossed its exact scope");
      }
      const sourceInput =
        input.sourceInputId === null
          ? null
          : exactlyOne(
              await transaction
                .select()
                .from(taskSessionInputs)
                .where(
                  and(
                    eq(taskSessionInputs.companyId, run.companyId),
                    eq(taskSessionInputs.taskId, run.taskId),
                    eq(taskSessionInputs.sessionId, run.sessionId),
                    eq(taskSessionInputs.id, input.sourceInputId),
                  ),
                )
                .limit(2)
                .for("update"),
              "Steering source input is not in the selected task Session",
            );
      const sourceComment = exactlyOne(
        await transaction
          .select()
          .from(taskComments)
          .where(
            and(
              eq(taskComments.companyId, run.companyId),
              eq(taskComments.taskId, run.taskId),
              eq(taskComments.sessionId, run.sessionId),
              eq(taskComments.id, input.sourceCommentId),
            ),
          )
          .limit(2)
          .for("update"),
        "Steering source comment is not in the selected task Session",
      );
      const commentSource = exactlyOne(
        await transaction
          .select()
          .from(taskCommentProjectionSources)
          .where(eq(taskCommentProjectionSources.commentId, sourceComment.id))
          .limit(2)
          .for("update"),
        "Steering comment has no canonical projection source",
      );
      const expectedProjectionKind = input.actor.kind === "user" ? "human_comment" : "harness_delivery";
      if (
        (input.actor.kind === "user" &&
          (!sourceInput ||
            sourceInput.id !== input.sourceMessageId ||
            sourceInput.delivery !== "steer" ||
            sourceInput.promotedSeq !== null ||
            !noPromptAttachments(sourceInput.prompt) ||
            sourceInput.prompt.text !== input.exactMessage)) ||
        (input.actor.kind === "agent" && sourceInput !== null) ||
        sourceComment.canonicalMessageId !== input.sourceMessageId ||
        sourceComment.canonicalSourceKind !== expectedProjectionKind ||
        sourceComment.body !== input.exactMessage ||
        commentSource.sourceKind !== expectedProjectionKind ||
        commentSource.messageId !== input.sourceMessageId ||
        commentSource.steeringTargetRunId !== null ||
        commentSource.refId !== null ||
        commentSource.refOrdinal !== null ||
        commentSource.segmentOrdinal !== null ||
        !actorMatchesComment(input, sourceComment)
      ) {
        reject("Steering source comment does not preserve the exact authorized message");
      }
      if (input.actor.kind === "user") {
        await promoteActiveRunSteeringInputInTransaction(transaction, {
          companyId: run.companyId,
          taskId: run.taskId,
          sessionId: run.sessionId,
          sourceCommentId: sourceComment.id,
          sourceMessageId: input.sourceMessageId,
          sourceInputId: input.sourceInputId!,
          actorUserId: input.actor.userId,
          exactMessage: input.exactMessage,
          at: now,
        });
      }
      const sourceMessage = exactlyOne(
        await transaction
          .select()
          .from(taskSessionMessages)
          .where(
            and(
              eq(taskSessionMessages.companyId, run.companyId),
              eq(taskSessionMessages.taskId, run.taskId),
              eq(taskSessionMessages.sessionId, run.sessionId),
              eq(taskSessionMessages.id, input.sourceMessageId),
            ),
          )
          .limit(2)
          .for("update"),
        "Steering source message is not in the selected task Session",
      );
      const decodedSource = sourceMessageText(sourceMessage);
      if (
        !decodedSource ||
        decodedSource.kind !== (input.actor.kind === "user" ? "user" : "synthetic") ||
        decodedSource.text !== input.exactMessage ||
        (input.actor.kind === "user" &&
          (sourceMessage.runId !== null ||
            sourceMessage.agentId !== null ||
            sourceMessage.adapterConfigRevisionId !== null)) ||
        (input.actor.kind === "agent" &&
          (sourceMessage.runId !== sourceComment.runId ||
            sourceMessage.agentId !== input.actor.agentId ||
            sourceMessage.adapterConfigRevisionId === null))
      ) {
        reject("Steering source Session message changed kind or exact bytes");
      }
      const latestSegments = await transaction
        .select({
          segmentOrdinal: taskExecutionPromptSegments.segmentOrdinal,
        })
        .from(taskExecutionPromptSegments)
        .where(
          and(
            eq(taskExecutionPromptSegments.runId, run.runId),
            eq(taskExecutionPromptSegments.refId, control.currentRefId),
            eq(taskExecutionPromptSegments.refOrdinal, control.currentOrdinal),
          ),
        )
        .orderBy(desc(taskExecutionPromptSegments.segmentOrdinal))
        .limit(1)
        .for("update");
      const latestOrdinal = latestSegments[0]?.segmentOrdinal ?? 0;
      if (latestOrdinal !== control.currentSegmentOrdinal) {
        reject("Selected run already has a later pending steering segment");
      }
      const segmentOrdinal = latestOrdinal + 1;
      const cancellationIntentId = idFactory();
      await transaction.insert(taskExecutionCancellationIntents).values({
        id: cancellationIntentId,
        companyId: run.companyId,
        taskId: run.taskId,
        runId: run.runId,
        attemptId: attempt.id,
        leaseId: lease.id,
        reasonKind: "steering",
        actorKind: input.actor.kind,
        actorUserId: input.actor.kind === "user" ? input.actor.userId : null,
        actorAgentId: input.actor.kind === "agent" ? input.actor.agentId : null,
        state: "requested",
        requestedAt: now,
        acknowledgedAt: null,
        nativeCancellationSettledAt: null,
        completedAt: null,
        failedAt: null,
        failureCode: null,
        createdAt: now,
      });
      await transaction.insert(taskExecutionPromptSegments).values({
        companyId: run.companyId,
        taskId: run.taskId,
        sessionId: run.sessionId,
        runId: run.runId,
        refId: control.currentRefId,
        refOrdinal: control.currentOrdinal,
        segmentOrdinal,
        sourceCommentId: sourceComment.id,
        sourceRefId: null,
        sourceMessageId: sourceMessage.id,
        sourceInputId: sourceInput?.id ?? null,
        resumeSourceCorrelationId: correlation.id,
        targetSessionGeneration: null,
        attemptId: null,
        capabilityConnectionId: null,
        capabilityGeneration: null,
        cancellationIntentId,
        steeringState: "requested",
        promptTransmissionPhase: "not_transmitted",
        outcome: null,
        outcomeReferenceId: null,
        protocolSettlementState: null,
        accountingId: null,
        costEventId: null,
        settlementVersion: 0,
        settledAt: null,
        terminalSessionMessageId: null,
        resumedAt: null,
        createdAt: now,
      });
      const revoked = await transaction
        .update(taskExecutionPromptCapabilities)
        .set({
          state: "revoked",
          revocationReason: "active_run_steering",
          revokedAt: now,
        })
        .where(
          and(
            eq(taskExecutionPromptCapabilities.capabilityConnectionId, capability.capabilityConnectionId),
            eq(taskExecutionPromptCapabilities.capabilityGeneration, capability.capabilityGeneration),
            eq(taskExecutionPromptCapabilities.state, "active"),
          ),
        )
        .returning({
          capabilityConnectionId: taskExecutionPromptCapabilities.capabilityConnectionId,
        });
      if (revoked.length !== 1) {
        reject("Selected prompt capability changed during steering admission");
      }
      await attachSteeringCancellationInTransaction(transaction, {
        companyId: run.companyId,
        taskId: run.taskId,
        runId: run.runId,
        expectedAttemptId: attempt.id,
        expectedLeaseId: lease.id,
        cancellationIntentId,
        at: now,
      });
      const sourceUpdated = await transaction
        .update(taskCommentProjectionSources)
        .set({
          steeringTargetRunId: run.runId,
          refId: control.currentRefId,
          refOrdinal: control.currentOrdinal,
          segmentOrdinal,
        })
        .where(
          and(
            eq(taskCommentProjectionSources.commentId, sourceComment.id),
            sql`${taskCommentProjectionSources.steeringTargetRunId} is null`,
            sql`${taskCommentProjectionSources.refId} is null`,
            sql`${taskCommentProjectionSources.refOrdinal} is null`,
            sql`${taskCommentProjectionSources.segmentOrdinal} is null`,
          ),
        )
        .returning({
          commentId: taskCommentProjectionSources.commentId,
        });
      if (sourceUpdated.length !== 1) {
        reject("Steering comment projection changed during segment binding");
      }
      return requestedResult({
        request: input,
        run,
        control,
        segmentOrdinal,
        cancellationIntentId,
        attempt,
        lease,
      });
    },
  } satisfies Partial<CreatePostgresTaskExecutionSteeringRepositoryResult>;
}
