import * as TaskSession from "@paperclipai/shared/task-session";
import type { StableIdentity, SteeringComment, TaskSessionAdmissionResult } from "./admission-part-1.js";
import { findRetry, loadResult } from "./admission-part-4.js";
import { projectionInput, resolveTaskCommentReplyProjection } from "./admission-part-3.js";
import { sourceEnvelope } from "./admission-part-5.js";
import { v2MessageKindForExecutionSource } from "./admission-part-2.js";
import { reserveTaskSessionEventSequence, type TaskSessionDbTransaction } from "./event-store.js";
import { publishTaskSessionEventInTx } from "./publication.js";

export async function admitSteeringEvent(
  transaction: TaskSessionDbTransaction,
  input: SteeringComment,
  options: {
    identityDigest: string;
    ids: StableIdentity;
    clock: () => Date;
  },
): Promise<TaskSessionAdmissionResult> {
  const messageKind = v2MessageKindForExecutionSource(input);
  const expectedType =
    messageKind === "user" ? TaskSession.Event.PromptAdmitted.type : TaskSession.Event.Synthetic.type;
  const retry = await findRetry(transaction, input, options.identityDigest, expectedType);
  if (retry) return retry;
  const reply = await resolveTaskCommentReplyProjection(transaction, input, input.comment.replyToCommentId);
  const { seq } = await reserveTaskSessionEventSequence(transaction, input);
  const now = options.clock();
  const {
    id: _eventId,
    sessionId: _eventSessionId,
    ...eventEnvelope
  } = sourceEnvelope(input, options.ids, options.identityDigest, now, undefined, input.comment);
  const published = await publishTaskSessionEventInTx(transaction, {
    event: {
      id: options.ids.eventId,
      sessionId: input.sessionId,
      seq,
      type: expectedType,
      data:
        messageKind === "user"
          ? {
              sessionID: input.sessionId,
              messageID: options.ids.messageId,
              timestamp: now.getTime(),
              prompt: { text: input.exactText },
              delivery: "steer" as const,
            }
          : {
              sessionID: input.sessionId,
              messageID: options.ids.messageId,
              timestamp: now.getTime(),
              text: input.exactText,
            },
    },
    envelope: eventEnvelope,
    projection: {
      inputBinding:
        messageKind === "user"
          ? {
              sourceRefId: null,
              dispositionId: options.ids.dispositionId,
            }
          : undefined,
      comment: projectionInput({
        phase: messageKind === "user" ? "admitted" : "direct",
        sourceKind: messageKind === "user" ? "human_comment" : "harness_delivery",
        sourceId: options.ids.sourceId,
        messageId: options.ids.messageId,
        commentId: options.ids.commentId,
        body: input.exactText,
        author: input.comment.author,
        reply,
      }),
    },
  });
  return loadResult(transaction, published.event, false);
}
