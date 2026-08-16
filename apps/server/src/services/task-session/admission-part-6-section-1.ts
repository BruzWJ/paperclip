import { taskExecutionHistoryViews, taskExecutionRefs, taskSessionInputs } from "@paperclipai/db";
import * as TaskSession from "@paperclipai/shared/task-session";
import { eq } from "drizzle-orm";
import type * as admissionCore from "./admission-part-1.js";
import {
  appendAdmissionEvent,
  buildRef,
  buildView,
  reserveTaskExecutionLaneOrdinalInTransaction,
  sourceEnvelope,
} from "./admission-part-5.js";
import { directProjectionKind, TOP_LEVEL_REPLY_PROJECTION, userProjectionKind } from "./admission-part-2.js";
import { findRetry, loadResult } from "./admission-part-4.js";
import { projectionInput, resolveTaskCommentReplyProjection } from "./admission-part-3.js";
import { reserveTaskSessionEventSequence, type TaskSessionDbTransaction } from "./event-store.js";
import { publishTaskSessionEventInTx } from "./publication.js";
import { TaskSessionInvariantError } from "./store.js";

export async function appendNonDispatchSyntheticComment(
  transaction: TaskSessionDbTransaction,
  input: admissionCore.NonDispatchSyntheticComment,
  options: {
    identityDigest: string;
    ids: admissionCore.StableIdentity;
    clock: () => Date;
  },
): Promise<admissionCore.TaskSessionAdmissionResult> {
  const reply = await resolveTaskCommentReplyProjection(transaction, input, input.comment.replyToCommentId);
  const retry = await findRetry(transaction, input, options.identityDigest, TaskSession.Event.Synthetic.type);
  if (retry) return retry;
  const { seq } = await reserveTaskSessionEventSequence(transaction, input);
  const now = options.clock();
  const type = TaskSession.Event.Synthetic.type;
  const data = {
    sessionID: input.sessionId,
    messageID: options.ids.messageId,
    timestamp: now.getTime(),
    text: input.exactText,
  };
  const event = await appendAdmissionEvent(transaction, {
    envelope: sourceEnvelope(
      input,
      options.ids,
      options.identityDigest,
      now,
      {
        ownershipEpoch: input.ownershipEpoch,
        targetAgentId: input.agentId,
        adapterConfigRevisionId: input.adapterConfigRevisionId,
      },
      input.comment,
    ),
    seq,
    type,
    data,
    projection: {
      comment: projectionInput({
        phase: "direct",
        sourceKind: input.projectionKind ?? "task_update",
        sourceId: input.projectionKind === "run_progress" ? input.runId : options.ids.sourceId,
        messageId: options.ids.messageId,
        commentId: options.ids.commentId,
        body: input.comment.body,
        author: input.comment.author,
        reply,
        steeringSegment: input.comment.steeringSegment,
      }),
    },
  });
  return loadResult(transaction, event, false);
}

export async function admitQueuedUserExecutionSource(
  transaction: TaskSessionDbTransaction,
  input: admissionCore.DispatchingExecutionSourceInput,
  options: {
    ids: admissionCore.StableIdentity;
    identityDigest: string;
    contextEpochBaselineSeq: number;
    now: Date;
  },
): Promise<admissionCore.TaskSessionAdmissionResult> {
  const comment = input.comment;
  if (!comment) {
    throw new TaskSessionInvariantError(
      "User execution source reached persistence without its projected author",
    );
  }
  const reply = await resolveTaskCommentReplyProjection(transaction, input, comment.replyToCommentId);
  const { highWaterSeq, seq } = await reserveTaskSessionEventSequence(transaction, input);
  const {
    id: _eventId,
    sessionId: _eventSessionId,
    ...eventEnvelope
  } = sourceEnvelope(input, options.ids, options.identityDigest, options.now, input, comment);
  const published = await publishTaskSessionEventInTx(transaction, {
    event: {
      id: options.ids.eventId,
      sessionId: input.sessionId,
      seq,
      type: TaskSession.Event.PromptAdmitted.type,
      data: {
        sessionID: input.sessionId,
        messageID: options.ids.messageId,
        timestamp: options.now.getTime(),
        prompt: { text: input.exactText },
        delivery: "queue",
      },
    },
    envelope: eventEnvelope,
    projection: {
      inputBinding: {
        sourceRefId: options.ids.refId,
        dispositionId: options.ids.dispositionId,
      },
      comment: projectionInput({
        phase: "admitted",
        sourceKind: userProjectionKind(input.sourceKind),
        sourceId: options.ids.sourceId,
        messageId: options.ids.messageId,
        commentId: options.ids.commentId,
        body: comment.body,
        author: comment.author,
        reply,
        steeringSegment: comment.steeringSegment,
      }),
    },
  });
  const eventRow = published.event;
  const inboxRows = await transaction
    .select()
    .from(taskSessionInputs)
    .where(eq(taskSessionInputs.id, options.ids.messageId))
    .limit(1);
  if (!inboxRows[0]) {
    throw new TaskSessionInvariantError("Task Session projector failed to materialize admitted input");
  }
  const laneOrdinal = await reserveTaskExecutionLaneOrdinalInTransaction(transaction, input, options.now);
  const refRows = await transaction
    .insert(taskExecutionRefs)
    .values({
      ...buildRef(input, options.ids, "user", options.ids.messageId, laneOrdinal),
      admissionHighWaterSeq: highWaterSeq,
      admittedSeq: seq,
      promotedSeq: null,
    })
    .returning();
  if (!refRows[0]) {
    throw new TaskSessionInvariantError("Task Session admission failed to persist its execution ref");
  }
  const viewRows = await transaction
    .insert(taskExecutionHistoryViews)
    .values({
      ...buildView(input, options.ids, options.contextEpochBaselineSeq, options.ids.messageId),
      sourceHighWaterSeq: highWaterSeq,
      sourceAdmittedSeq: seq,
      sourcePromotedSeq: null,
    })
    .returning();
  if (!viewRows[0]) {
    throw new TaskSessionInvariantError("Task Session admission failed to persist its history view");
  }
  return loadResult(transaction, eventRow, false);
}

export async function admitSyntheticExecutionSource(
  transaction: TaskSessionDbTransaction,
  input: admissionCore.DispatchingExecutionSourceInput,
  ids: admissionCore.StableIdentity,
  identityDigest: string,
  contextEpochBaselineSeq: number,
  clock: () => Date,
): Promise<admissionCore.TaskSessionAdmissionResult> {
  const reply = input.comment
    ? await resolveTaskCommentReplyProjection(transaction, input, input.comment.replyToCommentId)
    : TOP_LEVEL_REPLY_PROJECTION;
  const retry = await findRetry(transaction, input, identityDigest, TaskSession.Event.Synthetic.type);
  if (retry) return retry;

  const { highWaterSeq: admissionHighWaterSeq, seq } = await reserveTaskSessionEventSequence(
    transaction,
    input,
  );
  const now = clock();
  const sessionEvent = {
    id: ids.eventId,
    type: TaskSession.Event.Synthetic.type,
    data: {
      sessionID: input.sessionId,
      messageID: ids.messageId,
      timestamp: now.getTime(),
      text: input.exactText,
    },
  };
  const comment = input.comment
    ? projectionInput({
        phase: "direct",
        sourceKind: directProjectionKind(input.sourceKind),
        sourceId: ids.sourceId,
        messageId: ids.messageId,
        commentId: ids.commentId,
        body: input.comment.body,
        author: input.comment.author,
        reply,
        steeringSegment: input.comment.steeringSegment,
      })
    : undefined;
  const event = await appendAdmissionEvent(transaction, {
    envelope: sourceEnvelope(input, ids, identityDigest, now, input, input.comment),
    seq,
    type: sessionEvent.type,
    data: sessionEvent.data,
    projection: {
      comment,
    },
  });
  const laneOrdinal = await reserveTaskExecutionLaneOrdinalInTransaction(transaction, input, now);
  const refs = await transaction
    .insert(taskExecutionRefs)
    .values({
      ...buildRef(input, ids, "synthetic", null, laneOrdinal),
      admissionHighWaterSeq,
      admittedSeq: null,
      promotedSeq: null,
    })
    .returning();
  if (!refs[0]) {
    throw new TaskSessionInvariantError("Direct Session admission failed to reserve its execution ref");
  }
  const views = await transaction
    .insert(taskExecutionHistoryViews)
    .values({
      ...buildView(input, ids, contextEpochBaselineSeq, null),
      sourceHighWaterSeq: admissionHighWaterSeq,
      sourceAdmittedSeq: null,
      sourcePromotedSeq: null,
    })
    .returning();
  if (!views[0]) {
    throw new TaskSessionInvariantError("Direct Session admission failed to reserve its history view");
  }
  return loadResult(transaction, event, false);
}

export async function appendNonDispatchEvent(
  transaction: TaskSessionDbTransaction,
  input: admissionCore.NonDispatchUserComment | admissionCore.NonDispatchControlNotice,
  options: {
    user: boolean;
    identityDigest: string;
    ids: admissionCore.StableIdentity;
    clock: () => Date;
  },
): Promise<admissionCore.TaskSessionAdmissionResult> {
  const sourceComment = options.user
    ? (input as admissionCore.NonDispatchUserComment).comment
    : (input as admissionCore.NonDispatchControlNotice).comment;
  const reply = sourceComment
    ? await resolveTaskCommentReplyProjection(transaction, input, sourceComment.replyToCommentId)
    : TOP_LEVEL_REPLY_PROJECTION;
  const expectedType = options.user ? TaskSession.Event.Prompted.type : TaskSession.Event.ContextUpdated.type;
  const retry = await findRetry(transaction, input, options.identityDigest, expectedType);
  if (retry) return retry;
  const { seq } = await reserveTaskSessionEventSequence(transaction, input);
  const now = options.clock();
  const data = options.user
    ? {
        sessionID: input.sessionId,
        messageID: options.ids.messageId,
        timestamp: now.getTime(),
        prompt: { text: input.exactText },
        delivery: "queue" as const,
      }
    : {
        sessionID: input.sessionId,
        messageID: options.ids.messageId,
        timestamp: now.getTime(),
        text: input.exactText,
      };
  const comment = sourceComment;
  const projectorComment = comment
    ? projectionInput({
        phase: "direct",
        sourceKind: options.user
          ? "human_comment"
          : input.sourceKind === "plugin_withdrawal"
            ? "plugin_withdrawal"
            : input.sourceKind === "task_update"
              ? "task_update"
              : "system_control",
        sourceId: options.ids.sourceId,
        messageId: options.ids.messageId,
        commentId: options.ids.commentId,
        body: comment.body,
        author: comment.author,
        reply,
        steeringSegment: comment.steeringSegment,
      })
    : undefined;
  const envelope = sourceEnvelope(input, options.ids, options.identityDigest, now, undefined, comment);
  const event = await appendAdmissionEvent(transaction, {
    envelope,
    seq,
    type: expectedType,
    data,
    projection: {
      inputBinding: options.user
        ? { sourceRefId: null, dispositionId: options.ids.dispositionId }
        : undefined,
      comment: projectorComment,
    },
  });
  return loadResult(transaction, event, false);
}
