import {
  taskCommentProjectionSources,
  taskComments,
  taskExecutionHistoryViews,
  taskExecutionSessions,
  taskSessionInputs,
  taskSessions,
  tasks,
} from "@paperclipai/db";

import * as TaskSession from "@paperclipai/shared/task-session";

import type { TaskCommentPresentation } from "@paperclipai/shared";

import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import { TaskSessionInvariantError, TaskSessionLifecycleConflict } from "./store.js";

import { revokeTaskExecutionPromptCapabilitiesForSessionInTransaction } from "../task-execution-run-service-part-4-section-1.js";

import { resetTaskSessionContext } from "./context-epoch.js";

import {
  loadStoredTaskSessionEvent,
  projectableTaskSessionEvent,
  type StoredTaskSessionEvent,
  type TaskSessionDbTransaction,
} from "./event-store.js";

import { syncComment } from "../task-references.js";
import * as projectorCore from "./projector-part-1.js";

export type MaterializeCommentInput =
  | {
      kind: "source";
      projection: projectorCore.TaskSessionCommentProjectionInput;
    }
  | {
      kind: "terminal";
      source: typeof taskCommentProjectionSources.$inferSelect;
      comment: typeof taskComments.$inferSelect;
      terminalSessionMessageId: string;
      body: string;
      presentation: TaskCommentPresentation;
    };

export async function materializeComment(
  transaction: TaskSessionDbTransaction,
  event: projectorCore.DurableEventRow,
  materialization: MaterializeCommentInput,
): Promise<typeof taskComments.$inferSelect> {
  if (materialization.kind === "terminal") {
    const { source, comment, terminalSessionMessageId, body, presentation } = materialization;
    if (source.terminalSessionMessageId === null) {
      const bound = await transaction
        .update(taskCommentProjectionSources)
        .set({ terminalSessionMessageId })
        .where(
          and(
            eq(taskCommentProjectionSources.commentId, source.commentId),
            isNull(taskCommentProjectionSources.terminalSessionMessageId),
          ),
        )
        .returning({
          commentId: taskCommentProjectionSources.commentId,
        });
      if (!bound[0]) {
        throw new TaskSessionInvariantError(
          `Stable run-progress comment ${source.commentId} lost its terminal binding race`,
        );
      }
    }
    if (
      comment.body === body &&
      projectorCore.canonicalJson(comment.presentation) === projectorCore.canonicalJson(presentation)
    ) {
      return comment;
    }
    if (comment.body !== "" || comment.presentation?.kind !== "run_progress") {
      throw new TaskSessionLifecycleConflict(
        "Stable run-progress comment was changed before terminal settlement",
        { progressCommentId: comment.id },
      );
    }
    const updated = await transaction
      .update(taskComments)
      .set({
        body,
        presentation,
        updatedAt: event.eventTimestamp,
      })
      .where(
        and(
          eq(taskComments.companyId, event.companyId),
          eq(taskComments.taskId, event.taskId),
          eq(taskComments.sessionId, event.sessionId),
          eq(taskComments.id, comment.id),
        ),
      )
      .returning();
    if (!updated[0]) {
      throw new TaskSessionInvariantError(`Stable run-progress comment ${comment.id} disappeared`);
    }
    await syncComment(updated[0].id, transaction);
    return updated[0];
  }

  const input = materialization.projection;
  if (input.comment.id.length === 0 || input.messageId.length === 0 || input.sourceId.length === 0) {
    throw new TaskSessionLifecycleConflict("Task Session comment projection input is inconsistent", {
      eventId: event.id,
      phase: input.phase,
    });
  }
  const replyTuple = [
    input.comment.replyToCommentId,
    input.comment.replyToProjectedEventSeq,
    input.comment.threadRootCommentId,
    input.comment.threadRootProjectedEventSeq,
  ];
  if (!(replyTuple.every((value) => value === null) || replyTuple.every((value) => value !== null))) {
    throw new TaskSessionLifecycleConflict("Task Session comment projection has a partial reply tuple", {
      eventId: event.id,
      commentId: input.comment.id,
    });
  }
  if (
    input.steeringSegment != null &&
    (!input.steeringSegment.steeringTargetRunId ||
      !input.steeringSegment.refId ||
      !Number.isInteger(input.steeringSegment.refOrdinal) ||
      input.steeringSegment.refOrdinal < 0 ||
      !Number.isInteger(input.steeringSegment.segmentOrdinal) ||
      input.steeringSegment.segmentOrdinal < 1)
  ) {
    throw new TaskSessionLifecycleConflict(
      "Task Session comment projection has an invalid steering segment",
      { eventId: event.id, commentId: input.comment.id },
    );
  }
  projectorCore.assertTaskSessionRunProgressProjection(event, input);
  const inbox = await transaction
    .select()
    .from(taskSessionInputs)
    .where(and(eq(taskSessionInputs.sessionId, event.sessionId), eq(taskSessionInputs.id, input.messageId)))
    .limit(1);
  const admittedEventSeq = input.phase === "direct" ? event.seq : (inbox[0]?.admittedSeq ?? event.seq);
  const promotedEventSeq = input.phase === "admitted" ? null : event.seq;

  if (input.phase !== "admitted") {
    const message = await projectorCore.findMessage(transaction, event, input.messageId);
    if (!message) {
      throw new TaskSessionInvariantError(
        `Comment source ${input.sourceKind}/${input.sourceId} has no Task Session message`,
      );
    }
  }

  const existingRows = await transaction
    .select()
    .from(taskComments)
    .where(
      and(
        eq(taskComments.sessionId, event.sessionId),
        eq(taskComments.canonicalSourceKind, input.sourceKind),
        eq(taskComments.canonicalSourceId, input.sourceId),
      ),
    )
    .limit(1);
  let comment = existingRows[0] ?? null;
  if (!comment) {
    if (input.phase === "promoted") {
      throw new TaskSessionInvariantError(`Prompt promotion ${event.id} has no admitted comment projection`);
    }
    comment = await transaction
      .insert(taskComments)
      .values({
        ...input.comment,
        companyId: event.companyId,
        taskId: event.taskId,
        sessionId: event.sessionId,
        canonicalSourceKind: input.sourceKind,
        canonicalSourceId: input.sourceId,
        canonicalMessageId: input.messageId,
        admittedEventSeq,
        promotedEventSeq,
        projectedEventSeq: event.seq,
        runId: event.runId,
        createdAt: event.eventTimestamp,
        updatedAt: event.eventTimestamp,
      })
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!comment) {
      throw new TaskSessionInvariantError("Task Session projector failed to materialize task comment");
    }
    await transaction.insert(taskCommentProjectionSources).values({
      commentId: comment.id,
      companyId: event.companyId,
      taskId: event.taskId,
      sessionId: event.sessionId,
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      messageId: input.messageId,
      runId: event.runId,
      steeringTargetRunId: input.steeringSegment?.steeringTargetRunId ?? null,
      replyToCommentId: input.comment.replyToCommentId,
      replyToProjectedEventSeq: input.comment.replyToProjectedEventSeq,
      threadRootCommentId: input.comment.threadRootCommentId,
      threadRootProjectedEventSeq: input.comment.threadRootProjectedEventSeq,
      refId: input.steeringSegment?.refId ?? null,
      refOrdinal: input.steeringSegment?.refOrdinal ?? null,
      segmentOrdinal: input.steeringSegment?.segmentOrdinal ?? null,
      terminalSessionMessageId: null,
      admittedEventSeq,
      promotedEventSeq,
      projectedEventSeq: event.seq,
    });
  } else {
    if (!projectorCore.sameProjectedComment(comment, event, input)) {
      throw new TaskSessionLifecycleConflict("Task Session comment projection source was reused", {
        commentId: comment.id,
        sourceId: input.sourceId,
      });
    }
    const sourceRows = await transaction
      .select()
      .from(taskCommentProjectionSources)
      .where(eq(taskCommentProjectionSources.commentId, comment.id))
      .limit(2)
      .for("update");
    const source = sourceRows.length === 1 ? sourceRows[0]! : null;
    if (
      !source ||
      source.companyId !== event.companyId ||
      source.taskId !== event.taskId ||
      source.sessionId !== event.sessionId ||
      source.sourceKind !== input.sourceKind ||
      source.sourceId !== input.sourceId ||
      source.messageId !== input.messageId ||
      source.runId !== event.runId ||
      source.steeringTargetRunId !== (input.steeringSegment?.steeringTargetRunId ?? null) ||
      source.replyToCommentId !== input.comment.replyToCommentId ||
      source.replyToProjectedEventSeq !== input.comment.replyToProjectedEventSeq ||
      source.threadRootCommentId !== input.comment.threadRootCommentId ||
      source.threadRootProjectedEventSeq !== input.comment.threadRootProjectedEventSeq ||
      source.refId !== (input.steeringSegment?.refId ?? null) ||
      source.refOrdinal !== (input.steeringSegment?.refOrdinal ?? null) ||
      source.segmentOrdinal !== (input.steeringSegment?.segmentOrdinal ?? null)
    ) {
      throw new TaskSessionLifecycleConflict("Task Session comment projection companion was reused", {
        commentId: comment.id,
        sourceId: input.sourceId,
      });
    }
    if (input.phase === "promoted") {
      if (
        comment.admittedEventSeq !== admittedEventSeq ||
        (comment.promotedEventSeq !== null && comment.promotedEventSeq !== event.seq)
      ) {
        throw new TaskSessionLifecycleConflict(
          "Task Session prompt promotion cannot rewrite comment correlation",
          { commentId: comment.id },
        );
      }
      const promoted = await transaction
        .update(taskComments)
        .set({
          promotedEventSeq: event.seq,
          updatedAt: event.eventTimestamp,
        })
        .where(eq(taskComments.id, comment.id))
        .returning();
      comment = promoted[0] ?? comment;
      await transaction
        .update(taskCommentProjectionSources)
        .set({
          promotedEventSeq: event.seq,
        })
        .where(eq(taskCommentProjectionSources.commentId, comment.id));
    }
  }

  await transaction
    .update(tasks)
    .set({
      updatedAt: sql`greatest(
        ${tasks.updatedAt},
        ${event.eventTimestamp.toISOString()}::timestamptz
      )`,
    })
    .where(and(eq(tasks.companyId, event.companyId), eq(tasks.id, event.taskId)));
  await syncComment(comment.id, transaction);
  return comment;
}

export async function loadDurableEvent(
  transaction: TaskSessionDbTransaction,
  eventId: string,
): Promise<{
  row: StoredTaskSessionEvent;
  projectable: projectorCore.DurableEventRow;
}> {
  const decoded = await loadStoredTaskSessionEvent(transaction, eventId);
  return {
    row: decoded.row,
    projectable: projectableTaskSessionEvent(decoded.row),
  };
}

export async function projectMoved(
  transaction: TaskSessionDbTransaction,
  eventRow: projectorCore.DurableEventRow,
  event: Extract<TaskSession.DurableEvent, { type: "session.next.moved" }>,
): Promise<void> {
  const location = event.data.location;
  const sessions = await transaction
    .select()
    .from(taskSessions)
    .where(
      and(
        eq(taskSessions.companyId, eventRow.companyId),
        eq(taskSessions.taskId, eventRow.taskId),
        eq(taskSessions.id, eventRow.sessionId),
      ),
    )
    .limit(1);
  const session = sessions[0];
  if (!session) {
    throw new TaskSessionInvariantError(`Moved Session ${eventRow.sessionId} does not exist`);
  }
  await transaction
    .update(taskSessions)
    .set({
      directory: location.directory,
      workspaceId: location.workspaceID ?? null,
      subpath:
        typeof event.data.subdirectory === "string" && event.data.subdirectory.length > 0
          ? event.data.subdirectory
          : null,
      timeUpdated: eventRow.eventTimestamp,
    })
    .where(eq(taskSessions.id, eventRow.sessionId));
  const nextEpoch = await resetTaskSessionContext(transaction, {
    companyId: eventRow.companyId,
    taskId: eventRow.taskId,
    sessionId: eventRow.sessionId,
  });

  await transaction
    .update(taskExecutionHistoryViews)
    .set({
      state: "invalidated",
      invalidationReason: "session_moved",
      invalidatedAt: eventRow.eventTimestamp,
      updatedAt: eventRow.eventTimestamp,
    })
    .where(
      and(
        eq(taskExecutionHistoryViews.companyId, eventRow.companyId),
        eq(taskExecutionHistoryViews.taskId, eventRow.taskId),
        eq(taskExecutionHistoryViews.sessionId, eventRow.sessionId),
        sql`${taskExecutionHistoryViews.contextEpoch} < ${nextEpoch}`,
        sql`${taskExecutionHistoryViews.state} in ('empty', 'preparing', 'current')`,
      ),
    );
  await transaction.execute(sql`
    UPDATE task_execution_refs ref
    SET disposition = 'invalidated',
        invalidation_reason = 'session_moved',
        updated_at = ${eventRow.eventTimestamp.toISOString()}
    WHERE ref.company_id = ${eventRow.companyId}
      AND ref.task_id = ${eventRow.taskId}
      AND ref.session_id = ${eventRow.sessionId}
      AND ref.context_epoch < ${nextEpoch}
      AND ref.disposition = 'active'
  `);
  await transaction
    .update(taskExecutionSessions)
    .set({
      state: "superseded",
      supersessionReason: "session_moved",
      supersededAt: eventRow.eventTimestamp,
    })
    .where(
      and(
        eq(taskExecutionSessions.companyId, eventRow.companyId),
        eq(taskExecutionSessions.taskId, eventRow.taskId),
        inArray(taskExecutionSessions.state, ["eligible", "current"]),
      ),
    );
  await revokeTaskExecutionPromptCapabilitiesForSessionInTransaction(transaction, {
    companyId: eventRow.companyId,
    taskId: eventRow.taskId,
    sessionId: eventRow.sessionId,
    reason: "session_moved",
    at: eventRow.eventTimestamp,
  });
}
