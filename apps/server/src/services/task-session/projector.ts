import { taskCommentProjectionSources, taskComments, taskSessionMessages } from "@paperclipai/db";
import type { TaskCommentPresentation } from "@paperclipai/shared";
import { and, desc, eq } from "drizzle-orm";
import { DateTime } from "effect";
import { TaskSessionInvariantError, TaskSessionLifecycleConflict } from "./store.js";
import { readProjectedTaskSessionSequence, type TaskSessionDbTransaction } from "./event-store.js";
import type { TaskSessionFinalCommentInput } from "./projector-part-3.js";
import { canonicalJson, findMessage, taskSessionMessageFromRow } from "./projector-part-1.js";
import { loadDurableEvent, materializeComment } from "./projector-part-2.js";

/**
 * Binds the stable progress comment to its terminal Session assistant. The
 * source retains its immutable `run_progress` identity; only this dependency
 * and the human-facing projection change.
 */
export async function projectTaskSessionFinalCommentInTx(
  transaction: TaskSessionDbTransaction,
  input: TaskSessionFinalCommentInput,
): Promise<typeof taskComments.$inferSelect> {
  const { projectable: eventRow } = await loadDurableEvent(transaction, input.eventId);
  const event = eventRow.event;
  if (
    event.type !== "session.next.step.ended" ||
    eventRow.runId === null ||
    eventRow.agentId === null ||
    input.progressCommentId.length === 0
  ) {
    throw new TaskSessionLifecycleConflict(
      "Final Task Session comment must identify a completed canonical run",
      { eventId: input.eventId, runId: eventRow.runId },
    );
  }

  const projectedSeq = await readProjectedTaskSessionSequence(transaction, eventRow.sessionId);
  if (projectedSeq < eventRow.seq) {
    throw new TaskSessionLifecycleConflict(
      "Final Task Session comment requires an already-projected step settlement",
      {
        eventId: input.eventId,
        eventSeq: eventRow.seq,
        projectedSeq,
      },
    );
  }

  const [message, trailing] = await Promise.all([
    findMessage(transaction, eventRow, event.data.assistantMessageID),
    transaction
      .select({ id: taskSessionMessages.id })
      .from(taskSessionMessages)
      .where(
        and(
          eq(taskSessionMessages.companyId, eventRow.companyId),
          eq(taskSessionMessages.taskId, eventRow.taskId),
          eq(taskSessionMessages.sessionId, eventRow.sessionId),
          eq(taskSessionMessages.runId, eventRow.runId),
          eq(taskSessionMessages.type, "assistant"),
        ),
      )
      .orderBy(desc(taskSessionMessages.seq))
      .limit(1),
  ]);
  if (
    !message ||
    message.type !== "assistant" ||
    message.runId !== eventRow.runId ||
    trailing[0]?.id !== message.id
  ) {
    throw new TaskSessionLifecycleConflict(
      "Final Task Session comment does not reference the trailing run assistant",
      { eventId: input.eventId, messageId: event.data.assistantMessageID },
    );
  }
  const assistant = taskSessionMessageFromRow(message);
  if (assistant.type !== "assistant") {
    throw new TaskSessionInvariantError(`Task Session message ${message.id} is not an assistant`);
  }
  const text = assistant.content
    .filter(
      (part): part is Extract<(typeof assistant.content)[number], { type: "text" }> => part.type === "text",
    )
    .map((part) => part.text)
    .join("");
  if (!assistant.time.completed) {
    throw new TaskSessionLifecycleConflict(
      "Final Task Session comment requires a settled assistant timestamp",
      { eventId: input.eventId, messageId: message.id },
    );
  }
  const completedAt = DateTime.toEpochMillis(assistant.time.completed);
  const eventCompletedAt = DateTime.toEpochMillis(event.data.timestamp);
  if (
    completedAt !== eventCompletedAt ||
    assistant.finish !== event.data.finish ||
    assistant.cost !== event.data.cost ||
    canonicalJson(assistant.tokens) !== canonicalJson(event.data.tokens) ||
    text.length === 0
  ) {
    throw new TaskSessionLifecycleConflict(
      "Final Task Session comment diverges from its settled assistant output",
      { eventId: input.eventId, messageId: message.id },
    );
  }
  const sources = await transaction
    .select()
    .from(taskCommentProjectionSources)
    .where(
      and(
        eq(taskCommentProjectionSources.companyId, eventRow.companyId),
        eq(taskCommentProjectionSources.taskId, eventRow.taskId),
        eq(taskCommentProjectionSources.sessionId, eventRow.sessionId),
        eq(taskCommentProjectionSources.commentId, input.progressCommentId),
        eq(taskCommentProjectionSources.sourceKind, "run_progress"),
        eq(taskCommentProjectionSources.runId, eventRow.runId),
      ),
    )
    .limit(2)
    .for("update");
  const source = sources.length === 1 ? sources[0]! : null;
  if (!source) {
    throw new TaskSessionLifecycleConflict(
      "Final Task Session comment has no unique stable run-progress source",
      { eventId: input.eventId, progressCommentId: input.progressCommentId },
    );
  }
  const comments = await transaction
    .select()
    .from(taskComments)
    .where(
      and(
        eq(taskComments.companyId, eventRow.companyId),
        eq(taskComments.taskId, eventRow.taskId),
        eq(taskComments.id, source.commentId),
      ),
    )
    .limit(2)
    .for("update");
  const comment = comments.length === 1 ? comments[0]! : null;
  if (
    !comment ||
    comment.sessionId !== eventRow.sessionId ||
    comment.runId !== eventRow.runId ||
    comment.authorType !== "agent" ||
    comment.authorAgentId !== eventRow.agentId
  ) {
    throw new TaskSessionLifecycleConflict("Stable run-progress comment does not match its terminal run", {
      eventId: input.eventId,
      progressCommentId: input.progressCommentId,
    });
  }
  if (source.terminalSessionMessageId !== null && source.terminalSessionMessageId !== message.id) {
    throw new TaskSessionLifecycleConflict(
      "Stable run-progress comment is already bound to another terminal message",
      { progressCommentId: input.progressCommentId },
    );
  }
  const presentation: TaskCommentPresentation = {
    kind: "message",
    tone: "neutral",
    detailsDefaultOpen: false,
  };
  return materializeComment(transaction, eventRow, {
    kind: "terminal",
    source,
    comment,
    terminalSessionMessageId: message.id,
    body: text,
    presentation,
  });
}
export * from "./projector-part-1.js";
export * from "./projector-part-2.js";
export * from "./projector-part-3.js";
