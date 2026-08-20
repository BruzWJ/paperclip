import {
  taskExecutionHistoryViews,
  taskExecutionSessions,
  taskSessionMessages,
  taskSessions,
  type taskComments,
  type taskSessionEvents,
} from "@paperclipai/db";

import * as TaskSession from "@paperclipai/shared/task-session";

import { and, eq, inArray, sql } from "drizzle-orm";

import { TaskSessionInvariantError, TaskSessionLifecycleConflict } from "./store.js";

import { revokeTaskExecutionPromptCapabilitiesForSessionInTransaction } from "../task-execution-run-service-part-4-section-1.js";

import { resetTaskSessionContext } from "./context-epoch.js";

import {
  commitProjectedTaskSessionSequence,
  readProjectedTaskSessionSequence,
  type TaskSessionDbTransaction,
} from "./event-store.js";

import { projectTaskSessionInput } from "./input-projection.js";

import { applyTaskSessionMessageEvent } from "./message-updater.js";

import {
  type DurableEventRow,
  type TaskSessionProjectionInput,
  createMessageProjectionStore,
} from "./projector-part-1.js";
import { loadDurableEvent, materializeComment, projectMoved } from "./projector-part-2.js";

export async function truncateRevertProjection(
  transaction: TaskSessionDbTransaction,
  eventRow: DurableEventRow,
  boundaryMessageId: string,
): Promise<void> {
  const boundaries = await transaction
    .select({ seq: taskSessionMessages.seq })
    .from(taskSessionMessages)
    .where(
      and(
        eq(taskSessionMessages.companyId, eventRow.companyId),
        eq(taskSessionMessages.taskId, eventRow.taskId),
        eq(taskSessionMessages.sessionId, eventRow.sessionId),
        eq(taskSessionMessages.id, boundaryMessageId),
      ),
    )
    .limit(1);
  const boundarySeq = boundaries[0]?.seq;
  if (boundarySeq === undefined) {
    throw new TaskSessionLifecycleConflict("Committed revert boundary message is missing", {
      eventId: eventRow.id,
      boundaryMessageId,
    });
  }

  await transaction.execute(sql`
    UPDATE task_session_input_dispositions disposition
    SET state = 'invalidated',
        invalidation_reason = 'session_revert',
        invalidated_at = ${eventRow.eventTimestamp.toISOString()},
        invalidated_by_source_kind = 'session_revert',
        invalidated_by_source_id = ${eventRow.id}
    FROM task_session_inputs input
    WHERE disposition.input_id = input.id
      AND input.company_id = ${eventRow.companyId}
      AND input.task_id = ${eventRow.taskId}
      AND input.session_id = ${eventRow.sessionId}
      AND disposition.state = 'active'
      AND (
        input.admitted_seq > ${boundarySeq}
        OR input.promoted_seq > ${boundarySeq}
      )
  `);
  await transaction.execute(sql`
    UPDATE task_execution_refs ref
    SET disposition = 'invalidated',
        invalidation_reason = 'session_revert',
        updated_at = ${eventRow.eventTimestamp.toISOString()}
    WHERE ref.company_id = ${eventRow.companyId}
      AND ref.task_id = ${eventRow.taskId}
      AND ref.session_id = ${eventRow.sessionId}
      AND ref.disposition = 'active'
      AND (
        ref.admitted_seq > ${boundarySeq}
        OR ref.promoted_seq > ${boundarySeq}
        OR EXISTS (
          SELECT 1
          FROM task_session_messages message
          WHERE message.company_id = ref.company_id
            AND message.task_id = ref.task_id
            AND message.session_id = ref.session_id
            AND message.id = ref.source_message_id
            AND message.seq > ${boundarySeq}
        )
      )
  `);
  await transaction.execute(sql`
    UPDATE task_execution_history_views view
    SET state = 'invalidated',
        invalidation_reason = 'session_revert',
        invalidated_at = ${eventRow.eventTimestamp.toISOString()},
        updated_at = ${eventRow.eventTimestamp.toISOString()}
    WHERE view.company_id = ${eventRow.companyId}
      AND view.task_id = ${eventRow.taskId}
      AND view.session_id = ${eventRow.sessionId}
      AND view.state IN ('empty', 'preparing', 'current')
      AND (
        view.source_admitted_seq > ${boundarySeq}
        OR view.source_promoted_seq > ${boundarySeq}
        OR EXISTS (
          SELECT 1
          FROM task_execution_refs ref
          WHERE ref.id = view.ref_id
            AND ref.disposition = 'invalidated'
            AND ref.invalidation_reason = 'session_revert'
        )
      )
  `);
  await revokeTaskExecutionPromptCapabilitiesForSessionInTransaction(transaction, {
    companyId: eventRow.companyId,
    taskId: eventRow.taskId,
    sessionId: eventRow.sessionId,
    reason: "session_revert",
    at: eventRow.eventTimestamp,
  });
  await transaction
    .update(taskExecutionSessions)
    .set({
      state: "superseded",
      supersessionReason: "session_revert",
      supersededAt: eventRow.eventTimestamp,
    })
    .where(
      and(
        eq(taskExecutionSessions.companyId, eventRow.companyId),
        eq(taskExecutionSessions.taskId, eventRow.taskId),
        eq(taskExecutionSessions.state, "eligible"),
      ),
    );
  await transaction.execute(sql`
    DELETE FROM task_session_messages
    WHERE company_id = ${eventRow.companyId}
      AND task_id = ${eventRow.taskId}
      AND session_id = ${eventRow.sessionId}
      AND seq > ${boundarySeq}
  `);
}

export async function projectRevert(
  transaction: TaskSessionDbTransaction,
  eventRow: DurableEventRow,
  event: Extract<
    TaskSession.DurableEvent,
    {
      type: "session.next.revert.staged" | "session.next.revert.cleared" | "session.next.revert.committed";
    }
  >,
): Promise<void> {
  const sessions = await transaction
    .select({ revert: taskSessions.revert })
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
    throw new TaskSessionInvariantError(`Session ${eventRow.sessionId} is missing during revert projection`);
  }
  if (event.type === "session.next.revert.staged") {
    if (session.revert !== null) {
      throw new TaskSessionLifecycleConflict("Task Session already has a staged revert", {
        eventId: eventRow.id,
        sessionId: eventRow.sessionId,
      });
    }
    await transaction
      .update(taskSessions)
      .set({
        revert: {
          ...event.data.revert,
          files: event.data.revert.files ? [...event.data.revert.files] : undefined,
        },
        timeUpdated: eventRow.eventTimestamp,
      })
      .where(eq(taskSessions.id, eventRow.sessionId));
    return;
  }
  if (!session.revert) {
    throw new TaskSessionLifecycleConflict("Revert terminal event has no staged Task Session state", {
      eventId: eventRow.id,
      eventType: event.type,
    });
  }
  await transaction
    .update(taskSessions)
    .set({ revert: null, timeUpdated: eventRow.eventTimestamp })
    .where(eq(taskSessions.id, eventRow.sessionId));

  if (event.type === "session.next.revert.committed") {
    const boundaryMessageId = event.data.messageID;
    if (boundaryMessageId !== session.revert.messageID) {
      throw new TaskSessionLifecycleConflict("Committed revert changed its staged boundary", {
        eventId: eventRow.id,
        boundaryMessageId,
      });
    }
    await truncateRevertProjection(transaction, eventRow, boundaryMessageId);
    const epoch = await resetTaskSessionContext(transaction, {
      companyId: eventRow.companyId,
      taskId: eventRow.taskId,
      sessionId: eventRow.sessionId,
    });
    await transaction
      .update(taskExecutionHistoryViews)
      .set({
        state: "invalidated",
        invalidationReason: "session_revert",
        invalidatedAt: eventRow.eventTimestamp,
        updatedAt: eventRow.eventTimestamp,
      })
      .where(
        and(
          eq(taskExecutionHistoryViews.companyId, eventRow.companyId),
          eq(taskExecutionHistoryViews.taskId, eventRow.taskId),
          eq(taskExecutionHistoryViews.sessionId, eventRow.sessionId),
          sql`${taskExecutionHistoryViews.contextEpoch} < ${epoch}`,
          sql`${taskExecutionHistoryViews.state} in ('empty', 'preparing', 'current')`,
        ),
      );
  }
}

export async function projectEvent(
  transaction: TaskSessionDbTransaction,
  eventRow: DurableEventRow,
  input: Omit<TaskSessionProjectionInput, "eventId">,
  rebuilding: boolean,
  touchedMessageIds?: Set<string>,
): Promise<typeof taskComments.$inferSelect | null> {
  if (eventRow.type === "session.next.step.ended" && input.comment) {
    throw new TaskSessionLifecycleConflict(
      "Productive Step.Ended comments require terminal finalization after pending-input resolution",
      { eventId: eventRow.id },
    );
  }
  const event = eventRow.event;
  const projected = await readProjectedTaskSessionSequence(transaction, eventRow.sessionId);
  if (projected >= eventRow.seq) {
    throw new TaskSessionLifecycleConflict("Task Session event was already projected", {
      eventId: eventRow.id,
      sequence: eventRow.seq,
    });
  }
  if (event.type === "session.next.prompt.admitted" || event.type === "session.next.prompted") {
    await projectTaskSessionInput(transaction, {
      event,
      companyId: eventRow.companyId,
      taskId: eventRow.taskId,
      binding: input.inputBinding,
      rebuilding,
    });
  }
  await applyTaskSessionMessageEvent(
    createMessageProjectionStore(transaction, eventRow, eventRow.seq, rebuilding, touchedMessageIds),
    event,
  );
  if (event.type === "session.next.moved") {
    await projectMoved(transaction, eventRow, event);
  }
  if (
    event.type === "session.next.revert.staged" ||
    event.type === "session.next.revert.cleared" ||
    event.type === "session.next.revert.committed"
  ) {
    await projectRevert(transaction, eventRow, event);
  }
  await commitProjectedTaskSessionSequence(transaction, eventRow.sessionId, eventRow.seq);
  return input.comment
    ? materializeComment(transaction, eventRow, {
        kind: "source",
        projection: input.comment,
      })
    : null;
}

/**
 * Projects one already-appended immutable event through the physical Session
 * tables. This is the sole steady-state writer of materialized messages and
 * their task-comment projection.
 */
export async function projectTaskSessionEventInTx(
  transaction: TaskSessionDbTransaction,
  input: TaskSessionProjectionInput,
): Promise<{
  event: typeof taskSessionEvents.$inferSelect;
  comment: typeof taskComments.$inferSelect | null;
}> {
  const { row, projectable: event } = await loadDurableEvent(transaction, input.eventId);
  const comment = await projectEvent(
    transaction,
    event,
    {
      inputBinding: input.inputBinding,
      comment: input.comment,
    },
    false,
  );
  return { event: row, comment };
}

export interface TaskSessionFinalCommentInput {
  eventId: string;
  progressCommentId: string;
}
