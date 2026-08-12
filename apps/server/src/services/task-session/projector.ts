import {
  taskExecutionHistoryViews,
  taskExecutionSessions,
  taskCommentProjectionSources,
  taskComments,
  taskSessionEvents,
  taskSessionInputs,
  taskSessionMessages,
  taskSessions,
  tasks,
} from "@paperclipai/db";
import * as TaskSession from "@paperclipai/shared/task-session";
import type {
  TaskCommentAuthorType,
  TaskCommentMetadata,
  TaskCommentPresentation,
  SourceTrustMetadata,
} from "@paperclipai/shared";
import { encodeTaskSessionMessage } from "@paperclipai/shared/task-session";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { DateTime } from "effect";
import {
  TaskSessionInvariantError,
  TaskSessionLifecycleConflict,
  decodeStoredTaskSessionMessage,
  encodeTaskSessionMessageData,
  isSettledTaskSessionMessage,
} from "./store.js";
import { revokeTaskExecutionPromptCapabilitiesForSessionInTransaction } from "../task-execution-run-service.js";
import { resetTaskSessionContext } from "./context-epoch.js";
import {
  commitProjectedTaskSessionSequence,
  loadStoredTaskSessionEvent,
  projectableTaskSessionEvent,
  readProjectedTaskSessionSequence,
  type TaskSessionDbTransaction,
  type ProjectableTaskSessionEvent,
  type StoredTaskSessionEvent,
} from "./event-store.js";
import { projectTaskSessionInput } from "./input-projection.js";
import {
  applyTaskSessionMessageEvent,
  type TaskSessionMessageStore,
} from "./message-updater.js";
import { syncComment } from "../task-references.js";

type ProjectionSourceKind =
  typeof taskCommentProjectionSources.$inferInsert.sourceKind;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}
export interface TaskSessionCommentProjectionInput {
  phase: "admitted" | "promoted" | "direct";
  sourceKind: ProjectionSourceKind;
  sourceId: string;
  messageId: string;
  steeringSegment?: {
    steeringTargetRunId: string;
    refId: string;
    refOrdinal: number;
    segmentOrdinal: number;
  } | null;
  comment: {
    id: string;
    body: string;
    authorType: TaskCommentAuthorType;
    authorAgentId: string | null;
    authorUserId: string | null;
    authorPluginInstallationId: string | null;
    authorPluginKey: string | null;
    replyToCommentId: string | null;
    replyToProjectedEventSeq: number | null;
    threadRootCommentId: string | null;
    threadRootProjectedEventSeq: number | null;
    presentation?: TaskCommentPresentation | null;
    metadata?: TaskCommentMetadata | null;
    sourceTrust?: SourceTrustMetadata | null;
  };
}

export interface TaskSessionProjectionInput {
  /**
   * The immutable event must already exist. The projector reloads the canonical
   * bytes from this row so a caller cannot project a live-only or divergent
   * object.
   */
  eventId: string;
  /**
   * Prompt admission needs the pre-reserved ref id before the ref itself is
   * inserted. The Task Session input projector owns insertion/promotion of the inbox
   * row; this binding only supplies Paperclip's non-model-visible correlation.
   */
  inputBinding?: {
    sourceRefId: string | null;
    dispositionId: string;
  };
  /**
   * Only source contracts with a human-visible comment-of-record supply this
   * companion. It does not participate in Task Session message/history lowering.
   */
  comment?: TaskSessionCommentProjectionInput;
}

export function assertTaskSessionRunProgressProjection(
  event: { id: string; runId: string | null; agentId: string | null },
  input: TaskSessionCommentProjectionInput,
): void {
  if (input.sourceKind !== "run_progress") return;
  if (
    input.phase !== "direct" ||
    !event.runId ||
    !event.agentId ||
    input.sourceId !== event.runId ||
    input.comment.authorType !== "agent" ||
    input.comment.authorAgentId !== event.agentId ||
    input.comment.body !== "" ||
    input.comment.presentation?.kind !== "run_progress"
  ) {
    throw new TaskSessionLifecycleConflict(
      "Run-progress projection must be the empty stable comment for its producing run",
      { eventId: event.id, runId: event.runId },
    );
  }
}

type DurableEventRow = ProjectableTaskSessionEvent;
type SessionMessageRow = typeof taskSessionMessages.$inferSelect;
type SessionMessage = TaskSession.TaskSessionMessage;

export function taskSessionMessageFromRow(
  row: SessionMessageRow,
): SessionMessage {
  return decodeStoredTaskSessionMessage(row);
}

function sessionTimestamp(value: unknown, label: string): Date {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TaskSessionLifecycleConflict(
      `${label} must contain a canonical millisecond timestamp`,
    );
  }
  return new Date(value);
}

async function findMessage(
  transaction: TaskSessionDbTransaction,
  row: DurableEventRow,
  messageId: string,
): Promise<SessionMessageRow | null> {
  const rows = await transaction
    .select()
    .from(taskSessionMessages)
    .where(
      and(
        eq(taskSessionMessages.companyId, row.companyId),
        eq(taskSessionMessages.taskId, row.taskId),
        eq(taskSessionMessages.sessionId, row.sessionId),
        eq(taskSessionMessages.id, messageId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

function sameMessageEnvelope(
  existing: SessionMessageRow,
  event: DurableEventRow,
  message: SessionMessage,
  sequence: number,
): boolean {
  return (
    existing.companyId === event.companyId &&
    existing.taskId === event.taskId &&
    existing.sessionId === event.sessionId &&
    existing.id === message.id &&
    existing.type === message.type &&
    existing.seq === sequence
  );
}

function createMessageProjectionStore(
  transaction: TaskSessionDbTransaction,
  event: DurableEventRow,
  sequence: number,
  rebuilding: boolean,
  touchedMessageIds?: Set<string>,
): TaskSessionMessageStore {
  const updateMessage = async (
    expectedType: "assistant" | "shell",
    message: SessionMessage,
  ) => {
    if (message.type !== expectedType) {
      throw new TaskSessionLifecycleConflict(
        `Task Session ${expectedType} updater received ${message.type}`,
        { messageId: message.id },
      );
    }
    const existing = await findMessage(transaction, event, message.id);
    if (!existing || existing.type !== expectedType) {
      throw new TaskSessionInvariantError(
        `Projected ${expectedType} message ${message.id} is missing`,
      );
    }
    if (isSettledTaskSessionMessage(existing)) {
      throw new TaskSessionLifecycleConflict(
        `Settled ${expectedType} message ${message.id} cannot receive another model-visible update`,
        { messageId: message.id, eventId: event.id },
      );
    }
    const updated = await transaction
      .update(taskSessionMessages)
      .set({
        data: encodeTaskSessionMessageData(message),
        modelStateSeq: event.seq,
        timeCreated: sessionTimestamp(
          (encodeTaskSessionMessage(message) as { time: { created: number } })
            .time.created,
          `Session message ${message.id}`,
        ),
        timeUpdated: event.eventTimestamp,
      })
      .where(
        and(
          eq(taskSessionMessages.companyId, event.companyId),
          eq(taskSessionMessages.taskId, event.taskId),
          eq(taskSessionMessages.sessionId, event.sessionId),
          eq(taskSessionMessages.id, message.id),
          eq(taskSessionMessages.type, expectedType),
        ),
      )
      .returning({ id: taskSessionMessages.id });
    if (!updated[0]) {
      throw new TaskSessionInvariantError(
        `Projected ${expectedType} message ${message.id} disappeared`,
      );
    }
  };

  return {
    async getCurrentAssistant() {
      const rows = await transaction
        .select()
        .from(taskSessionMessages)
        .where(
          and(
            eq(taskSessionMessages.companyId, event.companyId),
            eq(taskSessionMessages.taskId, event.taskId),
            eq(taskSessionMessages.sessionId, event.sessionId),
            eq(taskSessionMessages.type, "assistant"),
            sql`${taskSessionMessages.data}->'time'->>'completed' is null`,
          ),
        )
        .orderBy(desc(taskSessionMessages.seq))
        .limit(1);
      const message = rows[0] ? taskSessionMessageFromRow(rows[0]) : undefined;
      return message?.type === "assistant" ? message : undefined;
    },
    async getAssistant(messageID) {
      const row = await findMessage(transaction, event, messageID);
      if (!row || row.type !== "assistant") return undefined;
      const message = taskSessionMessageFromRow(row);
      return message.type === "assistant" ? message : undefined;
    },
    async getCurrentShell(callID) {
      const rows = await transaction
        .select()
        .from(taskSessionMessages)
        .where(
          and(
            eq(taskSessionMessages.companyId, event.companyId),
            eq(taskSessionMessages.taskId, event.taskId),
            eq(taskSessionMessages.sessionId, event.sessionId),
            eq(taskSessionMessages.type, "shell"),
            sql`${taskSessionMessages.data}->>'callID' = ${callID}`,
            sql`${taskSessionMessages.data}->'time'->>'completed' is null`,
          ),
        )
        .orderBy(desc(taskSessionMessages.seq))
        .limit(1);
      const message = rows[0] ? taskSessionMessageFromRow(rows[0]) : undefined;
      return message?.type === "shell" ? message : undefined;
    },
    updateAssistant(message) {
      return updateMessage("assistant", message);
    },
    updateShell(message) {
      return updateMessage("shell", message);
    },
    async appendMessage(message) {
      touchedMessageIds?.add(message.id);
      const timestamp = sessionTimestamp(
        (
          encodeTaskSessionMessage(message) as unknown as {
            time: { created: number };
          }
        ).time.created,
        `Session message ${message.id}`,
      );
      const inserted = await transaction
        .insert(taskSessionMessages)
        .values({
          id: message.id,
          companyId: event.companyId,
          taskId: event.taskId,
          sessionId: event.sessionId,
          seq: sequence,
          modelStateSeq: sequence,
          type: message.type,
          data: encodeTaskSessionMessageData(message),
          runId: event.runId,
          ownershipEpoch: event.ownershipEpoch,
          agentId: event.agentId,
          adapterConfigRevisionId: event.adapterConfigRevisionId,
          timeCreated: timestamp,
          timeUpdated: timestamp,
        })
        .onConflictDoNothing()
        .returning();
      if (inserted[0]) return;

      const existing = await findMessage(transaction, event, message.id);
      if (
        !existing ||
        !sameMessageEnvelope(existing, event, message, sequence)
      ) {
        throw new TaskSessionLifecycleConflict(
          "PostgreSQL Session message identity or sequence was reused",
          { messageId: message.id, sequence },
        );
      }
      if (rebuilding) {
        await transaction
          .update(taskSessionMessages)
          .set({
            data: encodeTaskSessionMessageData(message),
            modelStateSeq: sequence,
            timeCreated: timestamp,
            timeUpdated: event.eventTimestamp,
          })
          .where(eq(taskSessionMessages.id, message.id));
        return;
      }
      if (
        JSON.stringify(existing.data) !==
        JSON.stringify(encodeTaskSessionMessageData(message))
      ) {
        throw new TaskSessionLifecycleConflict(
          "PostgreSQL Session message append changed its canonical payload",
          { messageId: message.id },
        );
      }
    },
  };
}

function sameProjectedComment(
  existing: typeof taskComments.$inferSelect,
  event: DurableEventRow,
  input: TaskSessionCommentProjectionInput,
): boolean {
  return (
    existing.id === input.comment.id &&
    existing.companyId === event.companyId &&
    existing.taskId === event.taskId &&
    existing.sessionId === event.sessionId &&
    existing.canonicalSourceKind === input.sourceKind &&
    existing.canonicalSourceId === input.sourceId &&
    existing.canonicalMessageId === input.messageId &&
    existing.body === input.comment.body &&
    existing.runId === event.runId &&
    existing.authorAgentId === (input.comment.authorAgentId ?? null) &&
    existing.authorUserId === (input.comment.authorUserId ?? null) &&
    existing.authorPluginInstallationId ===
      (input.comment.authorPluginInstallationId ?? null) &&
    existing.authorPluginKey === (input.comment.authorPluginKey ?? null) &&
    existing.authorType === input.comment.authorType &&
    existing.replyToCommentId === input.comment.replyToCommentId &&
    existing.replyToProjectedEventSeq ===
      input.comment.replyToProjectedEventSeq &&
    existing.threadRootCommentId === input.comment.threadRootCommentId &&
    existing.threadRootProjectedEventSeq ===
      input.comment.threadRootProjectedEventSeq &&
    canonicalJson(existing.presentation) ===
      canonicalJson(input.comment.presentation ?? null) &&
    canonicalJson(existing.metadata) ===
      canonicalJson(input.comment.metadata ?? null) &&
    canonicalJson(existing.sourceTrust) ===
      canonicalJson(input.comment.sourceTrust ?? null)
  );
}

type MaterializeCommentInput =
  | {
      kind: "source";
      projection: TaskSessionCommentProjectionInput;
    }
  | {
      kind: "terminal";
      source: typeof taskCommentProjectionSources.$inferSelect;
      comment: typeof taskComments.$inferSelect;
      terminalSessionMessageId: string;
      body: string;
      presentation: TaskCommentPresentation;
    };

async function materializeComment(
  transaction: TaskSessionDbTransaction,
  event: DurableEventRow,
  materialization: MaterializeCommentInput,
): Promise<typeof taskComments.$inferSelect> {
  if (materialization.kind === "terminal") {
    const { source, comment, terminalSessionMessageId, body, presentation } =
      materialization;
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
        .returning({ commentId: taskCommentProjectionSources.commentId });
      if (!bound[0]) {
        throw new TaskSessionInvariantError(
          `Stable run-progress comment ${source.commentId} lost its terminal binding race`,
        );
      }
    }
    if (
      comment.body === body &&
      canonicalJson(comment.presentation) === canonicalJson(presentation)
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
      throw new TaskSessionInvariantError(
        `Stable run-progress comment ${comment.id} disappeared`,
      );
    }
    await syncComment(updated[0].id, transaction);
    return updated[0];
  }

  const input = materialization.projection;
  if (
    input.comment.id.length === 0 ||
    input.messageId.length === 0 ||
    input.sourceId.length === 0
  ) {
    throw new TaskSessionLifecycleConflict(
      "Task Session comment projection input is inconsistent",
      { eventId: event.id, phase: input.phase },
    );
  }
  const replyTuple = [
    input.comment.replyToCommentId,
    input.comment.replyToProjectedEventSeq,
    input.comment.threadRootCommentId,
    input.comment.threadRootProjectedEventSeq,
  ];
  if (!(
    replyTuple.every((value) => value === null) ||
    replyTuple.every((value) => value !== null)
  )) {
    throw new TaskSessionLifecycleConflict(
      "Task Session comment projection has a partial reply tuple",
      { eventId: event.id, commentId: input.comment.id },
    );
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
  assertTaskSessionRunProgressProjection(event, input);
  const inbox = await transaction
    .select()
    .from(taskSessionInputs)
    .where(
      and(
        eq(taskSessionInputs.sessionId, event.sessionId),
        eq(taskSessionInputs.id, input.messageId),
      ),
    )
    .limit(1);
  const admittedEventSeq =
    input.phase === "direct" ? event.seq : (inbox[0]?.admittedSeq ?? event.seq);
  const promotedEventSeq = input.phase === "admitted" ? null : event.seq;

  if (input.phase !== "admitted") {
    const message = await findMessage(transaction, event, input.messageId);
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
      throw new TaskSessionInvariantError(
        `Prompt promotion ${event.id} has no admitted comment projection`,
      );
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
      throw new TaskSessionInvariantError(
        "Task Session projector failed to materialize task comment",
      );
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
    if (!sameProjectedComment(comment, event, input)) {
      throw new TaskSessionLifecycleConflict(
        "Task Session comment projection source was reused",
        { commentId: comment.id, sourceId: input.sourceId },
      );
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
      source.steeringTargetRunId !==
        (input.steeringSegment?.steeringTargetRunId ?? null) ||
      source.replyToCommentId !== input.comment.replyToCommentId ||
      source.replyToProjectedEventSeq !==
        input.comment.replyToProjectedEventSeq ||
      source.threadRootCommentId !== input.comment.threadRootCommentId ||
      source.threadRootProjectedEventSeq !==
        input.comment.threadRootProjectedEventSeq ||
      source.refId !== (input.steeringSegment?.refId ?? null) ||
      source.refOrdinal !== (input.steeringSegment?.refOrdinal ?? null) ||
      source.segmentOrdinal !== (input.steeringSegment?.segmentOrdinal ?? null)
    ) {
      throw new TaskSessionLifecycleConflict(
        "Task Session comment projection companion was reused",
        { commentId: comment.id, sourceId: input.sourceId },
      );
    }
    if (input.phase === "promoted") {
      if (
        comment.admittedEventSeq !== admittedEventSeq ||
        (comment.promotedEventSeq !== null &&
          comment.promotedEventSeq !== event.seq)
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
    .where(
      and(eq(tasks.companyId, event.companyId), eq(tasks.id, event.taskId)),
    );
  await syncComment(comment.id, transaction);
  return comment;
}

async function loadDurableEvent(
  transaction: TaskSessionDbTransaction,
  eventId: string,
): Promise<{
  row: StoredTaskSessionEvent;
  projectable: DurableEventRow;
}> {
  const decoded = await loadStoredTaskSessionEvent(transaction, eventId);
  return {
    row: decoded.row,
    projectable: projectableTaskSessionEvent(decoded.row),
  };
}

async function projectMoved(
  transaction: TaskSessionDbTransaction,
  eventRow: DurableEventRow,
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
    throw new TaskSessionInvariantError(
      `Moved Session ${eventRow.sessionId} does not exist`,
    );
  }
  await transaction
    .update(taskSessions)
    .set({
      directory: location.directory,
      workspaceId: location.workspaceID ?? null,
      subpath:
        typeof event.data.subdirectory === "string" &&
        event.data.subdirectory.length > 0
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
  await revokeTaskExecutionPromptCapabilitiesForSessionInTransaction(
    transaction,
    {
      companyId: eventRow.companyId,
      taskId: eventRow.taskId,
      sessionId: eventRow.sessionId,
      reason: "session_moved",
      at: eventRow.eventTimestamp,
    },
  );
}

async function truncateRevertProjection(
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
    throw new TaskSessionLifecycleConflict(
      "Committed revert boundary message is missing",
      { eventId: eventRow.id, boundaryMessageId },
    );
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
  await revokeTaskExecutionPromptCapabilitiesForSessionInTransaction(
    transaction,
    {
      companyId: eventRow.companyId,
      taskId: eventRow.taskId,
      sessionId: eventRow.sessionId,
      reason: "session_revert",
      at: eventRow.eventTimestamp,
    },
  );
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
        inArray(taskExecutionSessions.state, ["eligible", "current"]),
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

async function projectRevert(
  transaction: TaskSessionDbTransaction,
  eventRow: DurableEventRow,
  event: Extract<
    TaskSession.DurableEvent,
    {
      type:
        | "session.next.revert.staged"
        | "session.next.revert.cleared"
        | "session.next.revert.committed";
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
    throw new TaskSessionInvariantError(
      `Session ${eventRow.sessionId} is missing during revert projection`,
    );
  }
  if (event.type === "session.next.revert.staged") {
    if (session.revert !== null) {
      throw new TaskSessionLifecycleConflict(
        "Task Session already has a staged revert",
        { eventId: eventRow.id, sessionId: eventRow.sessionId },
      );
    }
    await transaction
      .update(taskSessions)
      .set({
        revert: {
          ...event.data.revert,
          files: event.data.revert.files
            ? [...event.data.revert.files]
            : undefined,
        },
        timeUpdated: eventRow.eventTimestamp,
      })
      .where(eq(taskSessions.id, eventRow.sessionId));
    return;
  }
  if (!session.revert) {
    throw new TaskSessionLifecycleConflict(
      "Revert terminal event has no staged Task Session state",
      { eventId: eventRow.id, eventType: event.type },
    );
  }
  await transaction
    .update(taskSessions)
    .set({ revert: null, timeUpdated: eventRow.eventTimestamp })
    .where(eq(taskSessions.id, eventRow.sessionId));

  if (event.type === "session.next.revert.committed") {
    const boundaryMessageId = event.data.messageID;
    if (boundaryMessageId !== session.revert.messageID) {
      throw new TaskSessionLifecycleConflict(
        "Committed revert changed its staged boundary",
        { eventId: eventRow.id, boundaryMessageId },
      );
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

async function projectEvent(
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
  const projected = await readProjectedTaskSessionSequence(
    transaction,
    eventRow.sessionId,
  );
  if (projected >= eventRow.seq) {
    throw new TaskSessionLifecycleConflict(
      "Task Session event was already projected",
      { eventId: eventRow.id, sequence: eventRow.seq },
    );
  }
  if (
    event.type === "session.next.prompt.admitted" ||
    event.type === "session.next.prompted"
  ) {
    await projectTaskSessionInput(transaction, {
      event,
      companyId: eventRow.companyId,
      taskId: eventRow.taskId,
      binding: input.inputBinding,
      rebuilding,
    });
  }
  await applyTaskSessionMessageEvent(
    createMessageProjectionStore(
      transaction,
      eventRow,
      eventRow.seq,
      rebuilding,
      touchedMessageIds,
    ),
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
  await commitProjectedTaskSessionSequence(
    transaction,
    eventRow.sessionId,
    eventRow.seq,
  );
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
  const { row, projectable: event } = await loadDurableEvent(
    transaction,
    input.eventId,
  );
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

/**
 * Binds the stable progress comment to its terminal Session assistant. The
 * source retains its immutable `run_progress` identity; only this dependency
 * and the human-facing projection change.
 */
export async function projectTaskSessionFinalCommentInTx(
  transaction: TaskSessionDbTransaction,
  input: TaskSessionFinalCommentInput,
): Promise<typeof taskComments.$inferSelect> {
  const { projectable: eventRow } = await loadDurableEvent(
    transaction,
    input.eventId,
  );
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

  const projectedSeq = await readProjectedTaskSessionSequence(
    transaction,
    eventRow.sessionId,
  );
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
    throw new TaskSessionInvariantError(
      `Task Session message ${message.id} is not an assistant`,
    );
  }
  const text = assistant.content
    .filter(
      (
        part,
      ): part is Extract<
        (typeof assistant.content)[number],
        { type: "text" }
      > => part.type === "text",
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
    throw new TaskSessionLifecycleConflict(
      "Stable run-progress comment does not match its terminal run",
      { eventId: input.eventId, progressCommentId: input.progressCommentId },
    );
  }
  if (
    source.terminalSessionMessageId !== null &&
    source.terminalSessionMessageId !== message.id
  ) {
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
