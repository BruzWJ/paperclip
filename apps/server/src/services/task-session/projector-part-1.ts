import { taskCommentProjectionSources, taskComments, taskSessionMessages } from "@paperclipai/db";

import * as TaskSession from "@paperclipai/shared/task-session";

import type {
  SourceTrustMetadata,
  TaskCommentAuthorType,
  TaskCommentMetadata,
  TaskCommentPresentation,
} from "@paperclipai/shared";

import { and, desc, eq, sql } from "drizzle-orm";

import {
  TaskSessionInvariantError,
  TaskSessionLifecycleConflict,
  decodeStoredTaskSessionMessage,
  encodeTaskSessionMessageData,
  isSettledTaskSessionMessage,
} from "./store.js";

import { type ProjectableTaskSessionEvent, type TaskSessionDbTransaction } from "./event-store.js";

import { type TaskSessionMessageStore } from "./message-updater.js";

export type ProjectionSourceKind = typeof taskCommentProjectionSources.$inferInsert.sourceKind;

export function canonicalJson(value: unknown): string {
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

export type DurableEventRow = ProjectableTaskSessionEvent;

export type SessionMessageRow = typeof taskSessionMessages.$inferSelect;

export type SessionMessage = TaskSession.TaskSessionMessage;

export function taskSessionMessageFromRow(row: SessionMessageRow): SessionMessage {
  return decodeStoredTaskSessionMessage(row);
}

export function sessionTimestamp(value: unknown, label: string): Date {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TaskSessionLifecycleConflict(`${label} must contain a canonical millisecond timestamp`);
  }
  return new Date(value);
}

export async function findMessage(
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

export function sameMessageEnvelope(
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

export function createMessageProjectionStore(
  transaction: TaskSessionDbTransaction,
  event: DurableEventRow,
  sequence: number,
  rebuilding: boolean,
  touchedMessageIds?: Set<string>,
): TaskSessionMessageStore {
  const updateMessage = async (expectedType: "assistant" | "shell", message: SessionMessage) => {
    if (message.type !== expectedType) {
      throw new TaskSessionLifecycleConflict(
        `Task Session ${expectedType} updater received ${message.type}`,
        { messageId: message.id },
      );
    }
    const existing = await findMessage(transaction, event, message.id);
    if (!existing || existing.type !== expectedType) {
      throw new TaskSessionInvariantError(`Projected ${expectedType} message ${message.id} is missing`);
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
          (
            TaskSession.encodeTaskSessionMessage(message) as {
              time: { created: number };
            }
          ).time.created,
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
      throw new TaskSessionInvariantError(`Projected ${expectedType} message ${message.id} disappeared`);
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
          TaskSession.encodeTaskSessionMessage(message) as unknown as {
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
      if (!existing || !sameMessageEnvelope(existing, event, message, sequence)) {
        throw new TaskSessionLifecycleConflict("PostgreSQL Session message identity or sequence was reused", {
          messageId: message.id,
          sequence,
        });
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
      if (JSON.stringify(existing.data) !== JSON.stringify(encodeTaskSessionMessageData(message))) {
        throw new TaskSessionLifecycleConflict(
          "PostgreSQL Session message append changed its canonical payload",
          { messageId: message.id },
        );
      }
    },
  };
}

export function sameProjectedComment(
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
    existing.authorPluginInstallationId === (input.comment.authorPluginInstallationId ?? null) &&
    existing.authorPluginKey === (input.comment.authorPluginKey ?? null) &&
    existing.authorType === input.comment.authorType &&
    existing.replyToCommentId === input.comment.replyToCommentId &&
    existing.replyToProjectedEventSeq === input.comment.replyToProjectedEventSeq &&
    existing.threadRootCommentId === input.comment.threadRootCommentId &&
    existing.threadRootProjectedEventSeq === input.comment.threadRootProjectedEventSeq &&
    canonicalJson(existing.presentation) === canonicalJson(input.comment.presentation ?? null) &&
    canonicalJson(existing.metadata) === canonicalJson(input.comment.metadata ?? null) &&
    canonicalJson(existing.sourceTrust) === canonicalJson(input.comment.sourceTrust ?? null)
  );
}
