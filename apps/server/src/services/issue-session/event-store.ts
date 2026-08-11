import {
  companies,
  issueSessionEventSequences,
  issueSessionEvents,
  issueSessionMessageIdAllocators,
  issueSessionMessageIdReservations,
  issueSessions,
  issues,
  type Db,
} from "@paperclipai/db";
import {
  decodeDurableIssueSessionEventRow,
  encodeDurableIssueSessionEventRow,
  versionedIssueSessionEventType,
  type DurableEvent,
  type IssueSessionEventType,
} from "@paperclipai/shared/issue-session";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  decodeStoredIssueSessionEvent,
  IssueSessionInvariantError,
  IssueSessionLifecycleConflict,
  type DecodedIssueSessionEvent,
  type StoredIssueSessionEvent,
} from "./store.js";

export type IssueSessionDbTransaction =
  Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface IssueSessionScope {
  companyId: string;
  issueId: string;
  sessionId: string;
}

export {
  decodeStoredIssueSessionEvent,
  type DecodedIssueSessionEvent,
  type StoredIssueSessionEvent,
} from "./store.js";

export type ProjectableIssueSessionEvent = Omit<
  StoredIssueSessionEvent,
  "type"
> & {
  type: DurableEvent["type"];
  storedType: string;
  version: number;
  eventTimestamp: Date;
  event: DurableEvent;
};

export function projectableIssueSessionEvent(
  row: StoredIssueSessionEvent,
): ProjectableIssueSessionEvent {
  const decoded = decodeStoredIssueSessionEvent(row);
  if (!decoded.event.durable) {
    throw new IssueSessionInvariantError(
      `Issue Session event ${row.id} has no durable envelope`,
    );
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

export async function loadStoredIssueSessionEvent(
  transaction: IssueSessionDbTransaction,
  eventId: string,
): Promise<DecodedIssueSessionEvent> {
  const rows = await transaction
    .select()
    .from(issueSessionEvents)
    .where(eq(issueSessionEvents.id, eventId))
    .limit(1);
  if (!rows[0]) {
    throw new IssueSessionInvariantError(
      `Issue Session event ${eventId} must exist before projection`,
    );
  }
  return decodeStoredIssueSessionEvent(rows[0]);
}

export async function reserveIssueSessionEventSequence(
  transaction: IssueSessionDbTransaction,
  scope: IssueSessionScope,
): Promise<{ highWaterSeq: number; seq: number }> {
  const rows = await transaction
    .update(issueSessionEventSequences)
    .set({ seq: sql`${issueSessionEventSequences.seq} + 1` })
    .where(
      and(
        eq(issueSessionEventSequences.companyId, scope.companyId),
        eq(issueSessionEventSequences.issueId, scope.issueId),
        eq(issueSessionEventSequences.sessionId, scope.sessionId),
      ),
    )
    .returning({ seq: issueSessionEventSequences.seq });
  const seq = rows[0]?.seq;
  if (seq === undefined) {
    throw new IssueSessionInvariantError(
      `Issue Session ${scope.sessionId} has no event sequence row`,
    );
  }
  return { highWaterSeq: seq - 1, seq };
}

/**
 * Reserves one canonical, monotonically ordered V2 message id for a durable
 * writer. The reservation key is immutable writer provenance, not a rendered
 * message field: retrying the same write returns the same id while every new
 * write advances the Session-owned clock exactly once.
 */
export async function reserveIssueSessionMessageId(
  transaction: IssueSessionDbTransaction,
  scope: IssueSessionScope,
  reservationKey: string,
): Promise<string> {
  if (
    !reservationKey ||
    reservationKey.trim().length === 0 ||
    reservationKey.length > 500
  ) {
    throw new IssueSessionInvariantError(
      "Issue Session message reservation key must be non-empty and at most 500 characters",
    );
  }

  // Lock the allocator before checking the reservation. That makes an
  // existing key idempotent and serializes the next ordinal for all writers
  // in one Session, independent of event sequence or wall-clock order.
  const allocator = await transaction
    .select({ lastOrdinal: issueSessionMessageIdAllocators.lastOrdinal })
    .from(issueSessionMessageIdAllocators)
    .where(
      and(
        eq(issueSessionMessageIdAllocators.companyId, scope.companyId),
        eq(issueSessionMessageIdAllocators.issueId, scope.issueId),
        eq(issueSessionMessageIdAllocators.sessionId, scope.sessionId),
      ),
    )
    .limit(1)
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (!allocator) {
    throw new IssueSessionInvariantError(
      `Issue Session ${scope.sessionId} has no message-id allocator row`,
    );
  }

  const existing = await transaction
    .select({ messageId: issueSessionMessageIdReservations.messageId })
    .from(issueSessionMessageIdReservations)
    .where(
      and(
        eq(issueSessionMessageIdReservations.companyId, scope.companyId),
        eq(issueSessionMessageIdReservations.issueId, scope.issueId),
        eq(issueSessionMessageIdReservations.sessionId, scope.sessionId),
        eq(
          issueSessionMessageIdReservations.reservationKey,
          reservationKey,
        ),
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
    throw new IssueSessionInvariantError(
      `Issue Session ${scope.sessionId} has an invalid message-id allocator ordinal`,
    );
  }
  const ordinal = allocator.lastOrdinal + 1;
  const messageId = `msg_${scope.sessionId}_${String(ordinal).padStart(19, "0")}`;
  const updated = await transaction
    .update(issueSessionMessageIdAllocators)
    .set({ lastOrdinal: ordinal, updatedAt: new Date() })
    .where(
      and(
        eq(issueSessionMessageIdAllocators.companyId, scope.companyId),
        eq(issueSessionMessageIdAllocators.issueId, scope.issueId),
        eq(issueSessionMessageIdAllocators.sessionId, scope.sessionId),
      ),
    )
    .returning({ lastOrdinal: issueSessionMessageIdAllocators.lastOrdinal });
  if (updated[0]?.lastOrdinal !== ordinal) {
    throw new IssueSessionInvariantError(
      `Issue Session ${scope.sessionId} message-id allocator did not advance`,
    );
  }

  const reservation = await transaction
    .insert(issueSessionMessageIdReservations)
    .values({
      companyId: scope.companyId,
      issueId: scope.issueId,
      sessionId: scope.sessionId,
      reservationKey,
      ordinal,
      messageId,
    })
    .returning({ messageId: issueSessionMessageIdReservations.messageId });
  if (!reservation[0]) {
    throw new IssueSessionInvariantError(
      `Issue Session ${scope.sessionId} message id was not reserved`,
    );
  }
  return reservation[0].messageId;
}

/**
 * Durable publication may name only Session-owned message identities that
 * were reserved before the event. This keeps event admission and projection
 * on the same monotonic message clock and turns a missing reservation into a
 * lifecycle error before an immutable event can be appended.
 */
export async function assertReservedIssueSessionMessageIds(
  transaction: IssueSessionDbTransaction,
  scope: IssueSessionScope,
  messageIds: readonly string[],
): Promise<void> {
  const uniqueMessageIds = [...new Set(messageIds)];
  if (uniqueMessageIds.length === 0) return;
  if (
    uniqueMessageIds.some(
      (messageId) =>
        typeof messageId !== "string" || messageId.length === 0,
    )
  ) {
    throw new IssueSessionLifecycleConflict(
      "Durable Session event has an invalid message identity",
    );
  }

  const reservations = await transaction
    .select({ messageId: issueSessionMessageIdReservations.messageId })
    .from(issueSessionMessageIdReservations)
    .where(
      and(
        eq(issueSessionMessageIdReservations.companyId, scope.companyId),
        eq(issueSessionMessageIdReservations.issueId, scope.issueId),
        eq(issueSessionMessageIdReservations.sessionId, scope.sessionId),
        inArray(
          issueSessionMessageIdReservations.messageId,
          uniqueMessageIds,
        ),
      ),
    );
  const reserved = new Set(reservations.map((row) => row.messageId));
  const missingMessageIds = uniqueMessageIds.filter(
    (messageId) => !reserved.has(messageId),
  );
  if (missingMessageIds.length > 0) {
    throw new IssueSessionLifecycleConflict(
      "Durable Session event references an unreserved message identity",
      {
        sessionId: scope.sessionId,
        messageIds: missingMessageIds,
      },
    );
  }
}

export function makeDurableIssueSessionEvent(input: {
  id: string;
  sessionId: string;
  seq: number;
  type: IssueSessionEventType;
  data: unknown;
}): DurableEvent {
  return decodeDurableIssueSessionEventRow({
    id: input.id,
    sessionId: input.sessionId,
    seq: input.seq,
    type: versionedIssueSessionEventType(input.type),
    data: input.data,
  });
}

export async function appendIssueSessionEvent(
  transaction: IssueSessionDbTransaction,
  input: {
    event: DurableEvent;
    envelope: Omit<
      typeof issueSessionEvents.$inferInsert,
      "id" | "sessionId" | "seq" | "type" | "data"
    >;
  },
): Promise<StoredIssueSessionEvent> {
  const encoded = encodeDurableIssueSessionEventRow(input.event);
  const inserted = await transaction
    .insert(issueSessionEvents)
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
    throw new IssueSessionInvariantError(
      `Issue Session event ${encoded.id} was not appended`,
    );
  }
  decodeStoredIssueSessionEvent(inserted[0]);
  return inserted[0];
}

export async function readProjectedIssueSessionSequence(
  transaction: IssueSessionDbTransaction,
  sessionId: string,
): Promise<number> {
  const rows = Array.from(
    await transaction.execute(sql<{ projectedEventSeq: number | string }>`
      SELECT projected_event_seq AS "projectedEventSeq"
      FROM issue_sessions
      WHERE id = ${sessionId}
      FOR UPDATE
    `),
  );
  if (!rows[0]) {
    throw new IssueSessionInvariantError(
      `Issue Session ${sessionId} is missing its projection checkpoint`,
    );
  }
  return Number(rows[0].projectedEventSeq);
}

/**
 * Locks the foreign-key parents and Session projection checkpoint in their
 * canonical aggregate order. Projection updates issue_sessions, whose FK
 * checks otherwise acquire parent locks after the Session row and can invert
 * issue actions that already own company/issue before waiting on Session.
 */
export async function lockIssueSessionProjectionRoot(
  transaction: IssueSessionDbTransaction,
  scope: IssueSessionScope,
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
    throw new IssueSessionInvariantError(
      `Company ${scope.companyId} is missing its Session projection root`,
    );
  }
  const issueRows = Array.from(
    await transaction.execute(sql<{ id: string }>`
      SELECT ${issues.id} AS id
      FROM ${issues}
      WHERE ${issues.companyId} = ${scope.companyId}
        AND ${issues.id} = ${scope.issueId}
      FOR NO KEY UPDATE
    `),
  );
  if (issueRows.length !== 1) {
    throw new IssueSessionInvariantError(
      `Issue ${scope.issueId} is missing its Session projection root`,
    );
  }
  return readProjectedIssueSessionSequence(transaction, scope.sessionId);
}

export async function commitProjectedIssueSessionSequence(
  transaction: IssueSessionDbTransaction,
  sessionId: string,
  sequence: number,
): Promise<void> {
  const rows = await transaction
    .update(issueSessions)
    .set({ projectedEventSeq: sequence })
    .where(
      and(
        eq(issueSessions.id, sessionId),
        eq(issueSessions.projectedEventSeq, sequence - 1),
      ),
    )
    .returning({ id: issueSessions.id });
  if (!rows[0]) {
    throw new IssueSessionLifecycleConflict(
      "Issue Session events must project in contiguous aggregate order",
      { sessionId, sequence },
    );
  }
}
