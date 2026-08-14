import {
  companies,
  taskSessionEventSequences,
  taskSessionEvents,
  taskSessionMessageIdAllocators,
  taskSessionMessageIdReservations,
  taskSessions,
  tasks,
  type Db,
} from "@paperclipai/db";
import {
  decodeDurableTaskSessionEventRow,
  encodeDurableTaskSessionEventRow,
  versionedTaskSessionEventType,
  type DurableEvent,
  type TaskSessionEventType,
} from "@paperclipai/shared/task-session";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  decodeStoredTaskSessionEvent,
  TaskSessionInvariantError,
  TaskSessionLifecycleConflict,
  type DecodedTaskSessionEvent,
  type StoredTaskSessionEvent,
} from "./store.js";

export type TaskSessionDbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface TaskSessionScope {
  companyId: string;
  taskId: string;
  sessionId: string;
}

export {
  decodeStoredTaskSessionEvent,
  type DecodedTaskSessionEvent,
  type StoredTaskSessionEvent,
} from "./store.js";

export type ProjectableTaskSessionEvent = Omit<StoredTaskSessionEvent, "type"> & {
  type: DurableEvent["type"];
  storedType: string;
  version: number;
  eventTimestamp: Date;
  event: DurableEvent;
};

export function projectableTaskSessionEvent(row: StoredTaskSessionEvent): ProjectableTaskSessionEvent {
  const decoded = decodeStoredTaskSessionEvent(row);
  if (!decoded.event.durable) {
    throw new TaskSessionInvariantError(`Task Session event ${row.id} has no durable envelope`);
  }
  return {
    ...row,
    type: decoded.event.type,
    storedType: row.type,
    version: decoded.event.durable.version,
    eventTimestamp: decoded.timestamp,
    event: decoded.event,
  };
}

export async function loadStoredTaskSessionEvent(
  transaction: TaskSessionDbTransaction,
  eventId: string,
): Promise<DecodedTaskSessionEvent> {
  const rows = await transaction
    .select()
    .from(taskSessionEvents)
    .where(eq(taskSessionEvents.id, eventId))
    .limit(1);
  if (!rows[0]) {
    throw new TaskSessionInvariantError(`Task Session event ${eventId} must exist before projection`);
  }
  return decodeStoredTaskSessionEvent(rows[0]);
}

export async function reserveTaskSessionEventSequence(
  transaction: TaskSessionDbTransaction,
  scope: TaskSessionScope,
): Promise<{ highWaterSeq: number; seq: number }> {
  const rows = await transaction
    .update(taskSessionEventSequences)
    .set({ seq: sql`${taskSessionEventSequences.seq} + 1` })
    .where(
      and(
        eq(taskSessionEventSequences.companyId, scope.companyId),
        eq(taskSessionEventSequences.taskId, scope.taskId),
        eq(taskSessionEventSequences.sessionId, scope.sessionId),
      ),
    )
    .returning({ seq: taskSessionEventSequences.seq });
  const seq = rows[0]?.seq;
  if (seq === undefined) {
    throw new TaskSessionInvariantError(`Task Session ${scope.sessionId} has no event sequence row`);
  }
  return { highWaterSeq: seq - 1, seq };
}

/**
 * Reserves one canonical, monotonically ordered V2 message id for a durable
 * writer. The reservation key is immutable writer provenance, not a rendered
 * message field: retrying the same write returns the same id while every new
 * write advances the Session-owned clock exactly once.
 */
export async function reserveTaskSessionMessageId(
  transaction: TaskSessionDbTransaction,
  scope: TaskSessionScope,
  reservationKey: string,
): Promise<string> {
  if (!reservationKey || reservationKey.trim().length === 0 || reservationKey.length > 500) {
    throw new TaskSessionInvariantError(
      "Task Session message reservation key must be non-empty and at most 500 characters",
    );
  }

  // Lock the allocator before checking the reservation. That makes an
  // existing key idempotent and serializes the next ordinal for all writers
  // in one Session, independent of event sequence or wall-clock order.
  const allocator = await transaction
    .select({ lastOrdinal: taskSessionMessageIdAllocators.lastOrdinal })
    .from(taskSessionMessageIdAllocators)
    .where(
      and(
        eq(taskSessionMessageIdAllocators.companyId, scope.companyId),
        eq(taskSessionMessageIdAllocators.taskId, scope.taskId),
        eq(taskSessionMessageIdAllocators.sessionId, scope.sessionId),
      ),
    )
    .limit(1)
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (!allocator) {
    throw new TaskSessionInvariantError(`Task Session ${scope.sessionId} has no message-id allocator row`);
  }

  const existing = await transaction
    .select({ messageId: taskSessionMessageIdReservations.messageId })
    .from(taskSessionMessageIdReservations)
    .where(
      and(
        eq(taskSessionMessageIdReservations.companyId, scope.companyId),
        eq(taskSessionMessageIdReservations.taskId, scope.taskId),
        eq(taskSessionMessageIdReservations.sessionId, scope.sessionId),
        eq(taskSessionMessageIdReservations.reservationKey, reservationKey),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (existing) return existing.messageId;

  if (
    !Number.isSafeInteger(allocator.lastOrdinal) ||
    allocator.lastOrdinal < 0 ||
    allocator.lastOrdinal >= Number.MAX_SAFE_INTEGER
  ) {
    throw new TaskSessionInvariantError(
      `Task Session ${scope.sessionId} has an invalid message-id allocator ordinal`,
    );
  }
  const ordinal = allocator.lastOrdinal + 1;
  const messageId = `msg_${scope.sessionId}_${String(ordinal).padStart(19, "0")}`;
  const updated = await transaction
    .update(taskSessionMessageIdAllocators)
    .set({ lastOrdinal: ordinal, updatedAt: new Date() })
    .where(
      and(
        eq(taskSessionMessageIdAllocators.companyId, scope.companyId),
        eq(taskSessionMessageIdAllocators.taskId, scope.taskId),
        eq(taskSessionMessageIdAllocators.sessionId, scope.sessionId),
      ),
    )
    .returning({ lastOrdinal: taskSessionMessageIdAllocators.lastOrdinal });
  if (updated[0]?.lastOrdinal !== ordinal) {
    throw new TaskSessionInvariantError(
      `Task Session ${scope.sessionId} message-id allocator did not advance`,
    );
  }

  const reservation = await transaction
    .insert(taskSessionMessageIdReservations)
    .values({
      companyId: scope.companyId,
      taskId: scope.taskId,
      sessionId: scope.sessionId,
      reservationKey,
      ordinal,
      messageId,
    })
    .returning({ messageId: taskSessionMessageIdReservations.messageId });
  if (!reservation[0]) {
    throw new TaskSessionInvariantError(`Task Session ${scope.sessionId} message id was not reserved`);
  }
  return reservation[0].messageId;
}

/**
 * Durable publication may name only Session-owned message identities that
 * were reserved before the event. This keeps event admission and projection
 * on the same monotonic message clock and turns a missing reservation into a
 * lifecycle error before an immutable event can be appended.
 */
export async function assertReservedTaskSessionMessageIds(
  transaction: TaskSessionDbTransaction,
  scope: TaskSessionScope,
  messageIds: readonly string[],
): Promise<void> {
  const uniqueMessageIds = [...new Set(messageIds)];
  if (uniqueMessageIds.length === 0) return;
  if (uniqueMessageIds.some((messageId) => typeof messageId !== "string" || messageId.length === 0)) {
    throw new TaskSessionLifecycleConflict("Durable Session event has an invalid message identity");
  }

  const reservations = await transaction
    .select({ messageId: taskSessionMessageIdReservations.messageId })
    .from(taskSessionMessageIdReservations)
    .where(
      and(
        eq(taskSessionMessageIdReservations.companyId, scope.companyId),
        eq(taskSessionMessageIdReservations.taskId, scope.taskId),
        eq(taskSessionMessageIdReservations.sessionId, scope.sessionId),
        inArray(taskSessionMessageIdReservations.messageId, uniqueMessageIds),
      ),
    );
  const reserved = new Set(reservations.map((row) => row.messageId));
  const missingMessageIds = uniqueMessageIds.filter((messageId) => !reserved.has(messageId));
  if (missingMessageIds.length > 0) {
    throw new TaskSessionLifecycleConflict(
      "Durable Session event references an unreserved message identity",
      {
        sessionId: scope.sessionId,
        messageIds: missingMessageIds,
      },
    );
  }
}

export function makeDurableTaskSessionEvent(input: {
  id: string;
  sessionId: string;
  seq: number;
  type: TaskSessionEventType;
  data: unknown;
}): DurableEvent {
  return decodeDurableTaskSessionEventRow({
    id: input.id,
    sessionId: input.sessionId,
    seq: input.seq,
    type: versionedTaskSessionEventType(input.type),
    data: input.data,
  });
}

export async function appendTaskSessionEvent(
  transaction: TaskSessionDbTransaction,
  input: {
    event: DurableEvent;
    envelope: Omit<typeof taskSessionEvents.$inferInsert, "id" | "sessionId" | "seq" | "type" | "data">;
  },
): Promise<StoredTaskSessionEvent> {
  const encoded = encodeDurableTaskSessionEventRow(input.event);
  const inserted = await transaction
    .insert(taskSessionEvents)
    .values({
      ...input.envelope,
      id: encoded.id,
      sessionId: encoded.sessionId,
      seq: encoded.seq,
      type: encoded.type,
      data: encoded.data as Record<string, unknown>,
    })
    .returning();
  if (!inserted[0]) {
    throw new TaskSessionInvariantError(`Task Session event ${encoded.id} was not appended`);
  }
  decodeStoredTaskSessionEvent(inserted[0]);
  return inserted[0];
}

export async function readProjectedTaskSessionSequence(
  transaction: TaskSessionDbTransaction,
  sessionId: string,
): Promise<number> {
  const rows = Array.from(
    await transaction.execute(sql<{ projectedEventSeq: number | string }>`
      SELECT projected_event_seq AS "projectedEventSeq"
      FROM task_sessions
      WHERE id = ${sessionId}
      FOR UPDATE
    `),
  );
  if (!rows[0]) {
    throw new TaskSessionInvariantError(`Task Session ${sessionId} is missing its projection checkpoint`);
  }
  return Number(rows[0].projectedEventSeq);
}

/**
 * Locks the foreign-key parents and Session projection checkpoint in their
 * canonical aggregate order. Projection updates task_sessions, whose FK
 * checks otherwise acquire parent locks after the Session row and can invert
 * task actions that already own company/task before waiting on Session.
 */
export async function lockTaskSessionProjectionRoot(
  transaction: TaskSessionDbTransaction,
  scope: TaskSessionScope,
): Promise<number> {
  const companyRows = Array.from(
    await transaction.execute(sql<{ id: string }>`
      SELECT ${companies.id} AS id
      FROM ${companies}
      WHERE ${companies.id} = ${scope.companyId}
      FOR KEY SHARE
    `),
  );
  if (companyRows.length !== 1) {
    throw new TaskSessionInvariantError(`Company ${scope.companyId} is missing its Session projection root`);
  }
  const taskRows = Array.from(
    await transaction.execute(sql<{ id: string }>`
      SELECT ${tasks.id} AS id
      FROM ${tasks}
      WHERE ${tasks.companyId} = ${scope.companyId}
        AND ${tasks.id} = ${scope.taskId}
      FOR NO KEY UPDATE
    `),
  );
  if (taskRows.length !== 1) {
    throw new TaskSessionInvariantError(`Task ${scope.taskId} is missing its Session projection root`);
  }
  return readProjectedTaskSessionSequence(transaction, scope.sessionId);
}

export async function commitProjectedTaskSessionSequence(
  transaction: TaskSessionDbTransaction,
  sessionId: string,
  sequence: number,
): Promise<void> {
  const rows = await transaction
    .update(taskSessions)
    .set({ projectedEventSeq: sequence })
    .where(and(eq(taskSessions.id, sessionId), eq(taskSessions.projectedEventSeq, sequence - 1)))
    .returning({ id: taskSessions.id });
  if (!rows[0]) {
    throw new TaskSessionLifecycleConflict("Task Session events must project in contiguous aggregate order", {
      sessionId,
      sequence,
    });
  }
}
