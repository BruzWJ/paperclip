import { randomUUID } from "node:crypto";
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
import { and, desc, eq, gt, inArray, ne, or, sql } from "drizzle-orm";
import {
  TaskExecutionSteeringRejected,
  TaskExecutionRunInvariantViolation,
  attachSteeringCancellationInTransaction,
  clearSteeringCancellationAndAttemptInTransaction,
  lockTaskExecutionRunInTransaction,
  lockReboundSteeringRunInTransaction,
  lockSteerableRunInTransaction,
  type PendingTaskExecutionSteeringForSource,
  type TaskExecutionRunEnvelope,
  type TaskExecutionSteeringRepository,
  type RequestedTaskExecutionSteering,
  type RequestTaskExecutionSteeringInput,
  type SteerableTaskExecutionRun,
} from "./task-execution-run-service.js";
import { promoteActiveRunSteeringInputInTransaction } from "./task-session/input.js";
import { decodeStoredTaskSessionMessage } from "./task-session/store.js";

export interface PostgresTaskExecutionSteeringRepositoryOptions {
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  readonly settlementTimeoutMs?: number;
  readonly settlementPollIntervalMs?: number;
  readonly wait?: (milliseconds: number) => Promise<void>;
}

type RunControlRow = typeof taskExecutionRunControls.$inferSelect;

function reject(message: string): never {
  throw new TaskExecutionSteeringRejected(message, "invalid_request");
}

function exactlyOne<T>(rows: readonly T[], message: string): T {
  if (rows.length !== 1) reject(message);
  return rows[0]!;
}

function noPromptAttachments(prompt: unknown): prompt is {
  readonly text: string;
  readonly files?: readonly never[];
  readonly agents?: readonly never[];
} {
  if (!prompt || typeof prompt !== "object" || Array.isArray(prompt)) {
    return false;
  }
  const value = prompt as Record<string, unknown>;
  return (
    typeof value.text === "string" &&
    (value.files === undefined ||
      (Array.isArray(value.files) && value.files.length === 0)) &&
    (value.agents === undefined ||
      (Array.isArray(value.agents) && value.agents.length === 0))
  );
}

function sourceMessageText(
  row: typeof taskSessionMessages.$inferSelect,
): { readonly kind: "user" | "synthetic"; readonly text: string } | null {
  const message = decodeStoredTaskSessionMessage(row);
  if (message.type === "user") {
    if (
      (message.files !== undefined && message.files.length !== 0) ||
      (message.agents !== undefined && message.agents.length !== 0)
    ) {
      return null;
    }
    return { kind: "user", text: message.text };
  }
  return message.type === "synthetic"
    ? { kind: "synthetic", text: message.text }
    : null;
}

function terminalSteeringResult(input: {
  readonly run: Pick<
    TaskExecutionRunEnvelope,
    | "companyId"
    | "taskId"
    | "runId"
    | "targetAgentId"
    | "adapterConfigRevisionId"
  >;
  readonly segment: typeof taskExecutionPromptSegments.$inferSelect;
  readonly assistant: typeof taskSessionMessages.$inferSelect | null;
}) {
  const { run, segment } = input;
  if (
    segment.protocolSettlementState === null ||
    segment.outcome === null ||
    segment.settlementVersion < 1 ||
    segment.settledAt === null
  ) {
    return null;
  }
  let response = "";
  let terminalReason: string | null = null;
  if (segment.protocolSettlementState === "settled") {
    if (
      !input.assistant ||
      input.assistant.id !== segment.terminalSessionMessageId
    ) {
      return null;
    }
    const message = decodeStoredTaskSessionMessage(input.assistant);
    if (
      message.type !== "assistant" ||
      message.time.completed === undefined ||
      input.assistant.runId !== run.runId ||
      input.assistant.agentId !== run.targetAgentId ||
      input.assistant.adapterConfigRevisionId !== run.adapterConfigRevisionId
    ) {
      return null;
    }
    response = message.content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("");
    terminalReason = message.finish ?? null;
  } else if (segment.terminalSessionMessageId !== null || input.assistant) {
    return null;
  }
  const outcome =
    segment.outcome === "succeeded" || segment.outcome === "refused"
      ? ("succeeded" as const)
      : segment.outcome === "cancelled"
        ? ("cancelled" as const)
        : ("failed" as const);
  return Object.freeze({
    companyId: run.companyId,
    taskId: run.taskId,
    runId: run.runId,
    refId: segment.refId,
    refOrdinal: segment.refOrdinal,
    segmentOrdinal: segment.segmentOrdinal,
    outcome,
    response,
    reason:
      terminalReason ??
      (segment.protocolSettlementState === "not_sent"
        ? "Steering continuation was released before ACP transmission"
        : segment.protocolSettlementState === "incomplete"
          ? "Steering continuation ended without complete ACP settlement"
          : `Steering continuation ended with ${segment.outcome}`),
  });
}

function activePromptMemberMatches(input: {
  readonly run: SteerableTaskExecutionRun;
  readonly control: RunControlRow;
  readonly attempt: typeof taskExecutionAttempts.$inferSelect;
  readonly lease: typeof taskExecutionLeases.$inferSelect;
}): boolean {
  const { run, control, attempt, lease } = input;
  return (
    run.currentAttemptId === attempt.id &&
    run.currentLeaseId === lease.id &&
    attempt.companyId === run.companyId &&
    attempt.taskId === run.taskId &&
    attempt.sessionId === run.sessionId &&
    attempt.runId === run.runId &&
    attempt.runKind === run.kind &&
    attempt.refId === control.currentRefId &&
    attempt.refOrdinal === control.currentOrdinal &&
    attempt.segmentOrdinal === control.currentSegmentOrdinal &&
    attempt.promptKind ===
      (control.currentSegmentOrdinal === 0 ? "base" : "steering") &&
    attempt.state === "running" &&
    lease.companyId === run.companyId &&
    lease.taskId === run.taskId &&
    lease.runId === run.runId &&
    lease.attemptId === attempt.id &&
    lease.state === "active"
  );
}

function actorMatchesComment(
  input: RequestTaskExecutionSteeringInput,
  comment: typeof taskComments.$inferSelect,
): boolean {
  return input.actor.kind === "user"
    ? comment.authorType === "user" &&
        comment.authorUserId === input.actor.userId
    : comment.authorType === "agent" &&
        comment.authorAgentId === input.actor.agentId;
}

function requestedResult(input: {
  readonly request: RequestTaskExecutionSteeringInput;
  readonly run: SteerableTaskExecutionRun;
  readonly control: RunControlRow;
  readonly segmentOrdinal: number;
  readonly cancellationIntentId: string;
  readonly attempt: typeof taskExecutionAttempts.$inferSelect;
  readonly lease: typeof taskExecutionLeases.$inferSelect;
}): RequestedTaskExecutionSteering {
  return Object.freeze({
    companyId: input.run.companyId,
    taskId: input.run.taskId,
    ownershipEpoch: input.run.ownershipEpoch,
    runId: input.run.runId,
    targetAgentId: input.run.targetAgentId,
    refId: input.control.currentRefId!,
    refOrdinal: input.control.currentOrdinal!,
    interruptedSegmentOrdinal: input.control.currentSegmentOrdinal!,
    segmentOrdinal: input.segmentOrdinal,
    sourceCommentId: input.request.sourceCommentId,
    sourceMessageId: input.request.sourceMessageId,
    sourceInputId: input.request.sourceInputId,
    cancellationIntentId: input.cancellationIntentId,
    cancellation: Object.freeze({
      companyId: input.run.companyId,
      taskId: input.run.taskId,
      sessionId: input.run.sessionId,
      executionScopeId: input.run.executionScopeId,
      refId: input.control.currentRefId!,
      runId: input.run.runId,
      attemptId: input.attempt.id,
      leaseGeneration: input.lease.leaseGeneration,
    }),
  });
}

function sameRequestIdentity(
  request: RequestedTaskExecutionSteering,
  input: {
    companyId: string;
    taskId: string;
    runId: string;
    refId: string;
    refOrdinal: number;
    segmentOrdinal: number;
    cancellationIntentId?: string | null;
  },
): boolean {
  return (
    request.companyId === input.companyId &&
    request.taskId === input.taskId &&
    request.runId === input.runId &&
    request.refId === input.refId &&
    request.refOrdinal === input.refOrdinal &&
    request.segmentOrdinal === input.segmentOrdinal &&
    (input.cancellationIntentId === undefined ||
      request.cancellationIntentId === input.cancellationIntentId)
  );
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return resolved;
}

export function createPostgresTaskExecutionSteeringRepository(
  db: Db,
  options: PostgresTaskExecutionSteeringRepositoryOptions = {},
): TaskExecutionSteeringRepository {
  const clock = options.now ?? (() => new Date());
  const idFactory = options.idFactory ?? randomUUID;
  const settlementTimeoutMs = boundedPositiveInteger(
    options.settlementTimeoutMs,
    30_000,
    "steering settlement timeout",
  );
  const settlementPollIntervalMs = boundedPositiveInteger(
    options.settlementPollIntervalMs,
    25,
    "steering settlement poll interval",
  );
  const wait =
    options.wait ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));

  async function inspectSettlement(
    request: RequestedTaskExecutionSteering,
  ): Promise<
    | { readonly kind: "pending" }
    | { readonly kind: "settled" }
    | { readonly kind: "ambiguous"; readonly reason: string }
  > {
    const [intentRows, attemptRows, leaseRows, promptRows] = await Promise.all([
      db
        .select()
        .from(taskExecutionCancellationIntents)
        .where(
          and(
            eq(
              taskExecutionCancellationIntents.id,
              request.cancellationIntentId,
            ),
            eq(taskExecutionCancellationIntents.runId, request.runId),
            eq(
              taskExecutionCancellationIntents.attemptId,
              request.cancellation.attemptId!,
            ),
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
            eq(
              taskExecutionLeases.leaseGeneration,
              request.cancellation.leaseGeneration,
            ),
          ),
        )
        .limit(2),
      request.interruptedSegmentOrdinal === 0
        ? db
            .select({
              protocolSettlementState:
                taskExecutionRunRefs.protocolSettlementState,
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
              protocolSettlementState:
                taskExecutionPromptSegments.protocolSettlementState,
              outcome: taskExecutionPromptSegments.outcome,
            })
            .from(taskExecutionPromptSegments)
            .where(
              and(
                eq(taskExecutionPromptSegments.runId, request.runId),
                eq(taskExecutionPromptSegments.refId, request.refId),
                eq(taskExecutionPromptSegments.refOrdinal, request.refOrdinal),
                eq(
                  taskExecutionPromptSegments.segmentOrdinal,
                  request.interruptedSegmentOrdinal,
                ),
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
    if (
      prompt.protocolSettlementState === "incomplete" &&
      !nativeCancelledIncomplete
    ) {
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
                    eq(
                      taskExecutionPromptSegments.refOrdinal,
                      control.currentOrdinal,
                    ),
                    eq(
                      taskExecutionPromptSegments.segmentOrdinal,
                      control.currentSegmentOrdinal,
                    ),
                  ),
                )
                .limit(2)
                .for("update"),
              "Selected run control does not resolve one current steering segment",
            );
      if (
        currentSegment !== null &&
        currentSegment.protocolSettlementState !== null
      ) {
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
        !activePromptMemberMatches({ run, control, attempt, lease }) ||
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
              eq(
                taskExecutionPromptCapabilities.refOrdinal,
                control.currentOrdinal,
              ),
              eq(
                taskExecutionPromptCapabilities.segmentOrdinal,
                control.currentSegmentOrdinal,
              ),
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
              eq(
                taskExecutionSessions.id,
                capability.targetSessionCorrelationId,
              ),
              eq(taskExecutionSessions.companyId, run.companyId),
              eq(taskExecutionSessions.taskId, run.taskId),
              eq(taskExecutionSessions.ownershipEpoch, run.ownershipEpoch),
              eq(taskExecutionSessions.targetAgentId, run.targetAgentId),
              eq(
                taskExecutionSessions.adapterConfigIdentity,
                run.adapterConfigRevisionId,
              ),
              eq(
                taskExecutionSessions.workspaceIdentity,
                run.executionWorkspaceBindingId,
              ),
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
        correlation.authorizedContextExposureDigest ===
          capability.effectiveContextExposureDigest;
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
        reject(
          "Selected prompt protected target session crossed its exact scope",
        );
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
      const expectedProjectionKind =
        input.actor.kind === "user" ? "human_comment" : "harness_delivery";
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
        reject(
          "Steering source comment does not preserve the exact authorized message",
        );
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
        decodedSource.kind !==
          (input.actor.kind === "user" ? "user" : "synthetic") ||
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
        .select({ segmentOrdinal: taskExecutionPromptSegments.segmentOrdinal })
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
            eq(
              taskExecutionPromptCapabilities.capabilityConnectionId,
              capability.capabilityConnectionId,
            ),
            eq(
              taskExecutionPromptCapabilities.capabilityGeneration,
              capability.capabilityGeneration,
            ),
            eq(taskExecutionPromptCapabilities.state, "active"),
          ),
        )
        .returning({
          capabilityConnectionId:
            taskExecutionPromptCapabilities.capabilityConnectionId,
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
        .returning({ commentId: taskCommentProjectionSources.commentId });
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

    async recordCancellationSignal({ request, delivered }) {
      await db.transaction(async (transaction) => {
        const now = clock();
        const intent = exactlyOne(
          await transaction
            .select()
            .from(taskExecutionCancellationIntents)
            .where(
              eq(
                taskExecutionCancellationIntents.id,
                request.cancellationIntentId,
              ),
            )
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
                eq(
                  taskExecutionPromptSegments.segmentOrdinal,
                  request.segmentOrdinal,
                ),
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
          (intent.state === "acknowledged" &&
            segment.steeringState === "sent") ||
          (intent.state === "completed" &&
            segment.steeringState === "protocol_settled")
        ) {
          return;
        }
        if (
          intent.state !== "requested" ||
          segment.steeringState !== "requested"
        ) {
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
              eq(
                taskExecutionPromptSegments.segmentOrdinal,
                segment.segmentOrdinal,
              ),
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
                .where(
                  eq(
                    taskExecutionCancellationIntents.id,
                    request.cancellationIntentId,
                  ),
                )
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
                  eq(
                    taskExecutionPromptSegments.refOrdinal,
                    request.refOrdinal,
                  ),
                  eq(
                    taskExecutionPromptSegments.segmentOrdinal,
                    request.segmentOrdinal,
                  ),
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
          .where(
            eq(
              taskExecutionCancellationIntents.id,
              request.cancellationIntentId,
            ),
          )
          .limit(1)
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!intent || intent.state === "completed") return;
        const failureCode =
          reason.trim().slice(0, 200) || "steering_cancellation_ambiguous";
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
                eq(
                  taskExecutionPromptSegments.segmentOrdinal,
                  request.segmentOrdinal,
                ),
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
            .where(
              eq(
                taskExecutionCancellationIntents.id,
                request.cancellationIntentId,
              ),
            )
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
              eq(
                taskExecutionPromptSegments.segmentOrdinal,
                request.segmentOrdinal,
              ),
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
                eq(
                  taskExecutionPromptSegments.segmentOrdinal,
                  rebound.segmentOrdinal,
                ),
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
              eq(
                taskExecutionPromptSegments.segmentOrdinal,
                rebound.segmentOrdinal,
              ),
            ),
          );
      });
    },

    async findPendingForSource(input) {
      const ambiguous = (
        reason: string,
      ): PendingTaskExecutionSteeringForSource => ({
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
          return ambiguous(
            "Persisted steering source does not resolve one canonical comment",
          );
        }
        const source = sourceRows[0]!;
        if (
          (source.sourceKind !== "human_comment" &&
            source.sourceKind !== "harness_delivery") ||
          source.steeringTargetRunId === null ||
          source.refId === null ||
          source.refOrdinal === null ||
          source.segmentOrdinal === null ||
          source.segmentOrdinal < 1
        ) {
          return ambiguous(
            "Persisted source is not bound to one positive steering segment",
          );
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
            return ambiguous(
              "Persisted steering source lost its canonical run envelope",
            );
          }
          throw error;
        }
        const [segmentRows, controlRows, sourceMessageRows, sourceCommentRows] =
          await Promise.all([
            transaction
              .select()
              .from(taskExecutionPromptSegments)
              .where(
                and(
                  eq(taskExecutionPromptSegments.runId, run.runId),
                  eq(taskExecutionPromptSegments.refId, source.refId),
                  eq(taskExecutionPromptSegments.refOrdinal, source.refOrdinal),
                  eq(
                    taskExecutionPromptSegments.segmentOrdinal,
                    source.segmentOrdinal,
                  ),
                  eq(
                    taskExecutionPromptSegments.sourceCommentId,
                    input.sourceCommentId,
                  ),
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
          return ambiguous(
            "Persisted steering source lost its segment, control, or exact Session message",
          );
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
          return ambiguous(
            "Persisted steering source crossed its canonical Session message identity",
          );
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
                      eq(
                        taskSessionMessages.id,
                        segment.terminalSessionMessageId,
                      ),
                    ),
                  )
                  .limit(2)
                  .for("update");
          const result =
            segment.steeringState === "protocol_settled" &&
            terminalMessageRows.length <= 1
              ? terminalSteeringResult({
                  run,
                  segment,
                  assistant: terminalMessageRows[0] ?? null,
                })
              : null;
          return result
            ? { kind: "terminal", result }
            : ambiguous(
                "Settled steering source lost its canonical terminal result",
              );
        }
        if (segment.terminalSessionMessageId !== null) {
          return ambiguous(
            "Unsettled steering source references a terminal Session message",
          );
        }
        if (run.status !== "running") {
          return ambiguous(
            "Steering run terminalized before its positive segment settled",
          );
        }
        if (run.terminalFinalizationId !== null || run.finishedAt !== null) {
          return ambiguous(
            "Persisted steering source no longer targets an active agent run",
          );
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
            return ambiguous(
              "Rebound steering source crossed its resumable run control",
            );
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
          return ambiguous(
            "Requested steering segment lost its cancellation intent",
          );
        }
        const [intentRows, attemptRows, leaseRows] = await Promise.all([
          transaction
            .select()
            .from(taskExecutionCancellationIntents)
            .where(
              and(
                eq(
                  taskExecutionCancellationIntents.id,
                  segment.cancellationIntentId,
                ),
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
        if (
          intentRows.length !== 1 ||
          attemptRows.length !== 1 ||
          leaseRows.length !== 1
        ) {
          return ambiguous(
            "Requested steering source lost its exact attempt or lease",
          );
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
          attempt.promptKind !==
            (interruptedSegmentOrdinal === 0 ? "base" : "steering") ||
          lease.companyId !== run.companyId ||
          lease.taskId !== run.taskId ||
          lease.runId !== run.runId ||
          lease.attemptId !== attempt.id ||
          control.currentRefId !== segment.refId ||
          control.currentOrdinal !== segment.refOrdinal ||
          control.currentSegmentOrdinal !== interruptedSegmentOrdinal
        ) {
          return ambiguous(
            "Requested steering source crossed its interrupted prompt identity",
          );
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

    async listRecoverableSources(limit) {
      const boundedLimit = Math.max(1, Math.min(1_000, Math.trunc(limit)));
      const rows = await db
        .select({
          companyId: taskCommentProjectionSources.companyId,
          taskId: taskCommentProjectionSources.taskId,
          sourceCommentId: taskCommentProjectionSources.commentId,
        })
        .from(taskCommentProjectionSources)
        .innerJoin(
          taskExecutionPromptSegments,
          and(
            eq(
              taskExecutionPromptSegments.runId,
              taskCommentProjectionSources.steeringTargetRunId,
            ),
            eq(
              taskExecutionPromptSegments.refId,
              taskCommentProjectionSources.refId,
            ),
            eq(
              taskExecutionPromptSegments.refOrdinal,
              taskCommentProjectionSources.refOrdinal,
            ),
            eq(
              taskExecutionPromptSegments.segmentOrdinal,
              taskCommentProjectionSources.segmentOrdinal,
            ),
            eq(
              taskExecutionPromptSegments.sourceCommentId,
              taskCommentProjectionSources.commentId,
            ),
          ),
        )
        .innerJoin(
          taskExecutionCancellationIntents,
          eq(
            taskExecutionCancellationIntents.id,
            taskExecutionPromptSegments.cancellationIntentId,
          ),
        )
        .innerJoin(
          taskExecutionAttempts,
          and(
            eq(
              taskExecutionAttempts.id,
              taskExecutionCancellationIntents.attemptId,
            ),
            eq(taskExecutionAttempts.runId, taskExecutionPromptSegments.runId),
          ),
        )
        .innerJoin(
          taskExecutionLeases,
          and(
            eq(
              taskExecutionLeases.id,
              taskExecutionCancellationIntents.leaseId,
            ),
            eq(taskExecutionLeases.attemptId, taskExecutionAttempts.id),
          ),
        )
        .where(
          and(
            inArray(taskCommentProjectionSources.sourceKind, [
              "human_comment",
              "harness_delivery",
            ]),
            sql`${taskExecutionPromptSegments.protocolSettlementState} is null`,
            inArray(taskExecutionPromptSegments.steeringState, [
              "requested",
              "sent",
              "protocol_settled",
              "rebound",
            ]),
            eq(taskExecutionCancellationIntents.reasonKind, "steering"),
            inArray(taskExecutionCancellationIntents.state, [
              "requested",
              "acknowledged",
              "completed",
            ]),
            or(
              eq(taskExecutionPromptSegments.steeringState, "rebound"),
              and(
                inArray(taskExecutionAttempts.state, [
                  "settled",
                  "cancelled",
                  "failed",
                ]),
                ne(taskExecutionLeases.state, "active"),
              ),
            ),
          ),
        )
        .orderBy(
          taskExecutionPromptSegments.createdAt,
          taskExecutionPromptSegments.runId,
          taskExecutionPromptSegments.segmentOrdinal,
        )
        .limit(boundedLimit);
      return Object.freeze(rows.map((row) => Object.freeze(row)));
    },
  };
}
