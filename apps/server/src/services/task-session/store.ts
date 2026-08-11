import { createHmac, timingSafeEqual } from "node:crypto";
import {
  taskComments,
  taskSessionEvents,
  taskSessionMessages,
  type Db,
} from "@paperclipai/db";
import {
  decodeDurableTaskSessionEventRow,
  decodeTaskSessionMessage,
  encodeDurableTaskSessionEventRow,
  encodeTaskSessionEvent,
  encodeTaskSessionMessage,
  type DurableEvent,
  type TaskSessionMessage,
} from "@paperclipai/shared/task-session";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  lte,
  lt,
  or,
} from "drizzle-orm";

export const TASK_SESSION_DEFAULT_PAGE_SIZE = 100;
export const TASK_SESSION_MAX_PAGE_SIZE = 500;

export type TaskSessionReadProjection =
  | "composition"
  | "execution-history"
  | "rebuild"
  | "run-trace"
  | "run-log"
  | "audit"
  | "export";

const TASK_SESSION_READ_PROJECTIONS: ReadonlySet<string> = new Set([
  "composition",
  "execution-history",
  "rebuild",
  "run-trace",
  "run-log",
  "audit",
  "export",
]);

export interface TaskSessionPageScope {
  companyId: string;
  taskId: string;
  sessionId: string;
  runId?: string;
  /** Exclusive lower bound for the selected row sequence. Defaults to -1. */
  afterSeq?: number;
  /** Inclusive immutable snapshot bound for this row kind. */
  highWaterSeq?: number;
  /** Messages only: keyset and delta by their latest model-visible state. */
  messageOrder?: "created" | "changed";
  direction?: "asc" | "desc";
  projection: TaskSessionReadProjection;
}

export interface TaskSessionPageRequest {
  cursor?: string | null;
  limit?: number;
}

export interface TaskSessionPage<T> {
  items: T[];
  nextCursor: string | null;
}

export type StoredTaskSessionEvent =
  typeof taskSessionEvents.$inferSelect;

export interface DecodedTaskSessionEvent {
  row: StoredTaskSessionEvent;
  event: DurableEvent;
  timestamp: Date;
}

export interface DecodedTaskSessionMessage {
  row: typeof taskSessionMessages.$inferSelect;
  message: TaskSessionMessage;
}

export interface TaskSessionStore {
  pageEvents(
    scope: TaskSessionPageScope,
    request?: TaskSessionPageRequest,
  ): Promise<TaskSessionPage<DecodedTaskSessionEvent>>;
  pageMessages(
    scope: TaskSessionPageScope,
    request?: TaskSessionPageRequest,
  ): Promise<TaskSessionPage<DecodedTaskSessionMessage>>;
  pageComments(
    scope: TaskSessionPageScope,
    request?: TaskSessionPageRequest,
  ): Promise<TaskSessionPage<StoredTaskSessionComment>>;
  /**
   * Keeps the same cursor authority while executing reads in an already-owned
   * database transaction. This is the only transaction-local Session reader.
   */
  bindReadDatabase(db: Db): TaskSessionStore;
}

interface TaskSessionCursorEnvelope {
  v: 1;
  rowKind: "event" | "message" | "comment";
  companyId: string;
  taskId: string;
  sessionId: string;
  runId: string | null;
  afterSeq: number;
  highWaterSeq: number | null;
  messageOrder: "created" | "changed" | null;
  direction: "asc" | "desc";
  projection: TaskSessionReadProjection;
  seq: number;
  id: string;
}

export class TaskSessionInvalidCursor extends Error {
  readonly code = "task_session_invalid_cursor";

  constructor(message = "Invalid or cross-scope Task Session cursor") {
    super(message);
    this.name = "TaskSessionInvalidCursor";
  }
}

export type StoredTaskSessionComment =
  typeof taskComments.$inferSelect;

export type TaskSessionCommentAuthor =
  | { kind: "agent"; agentId: string }
  | { kind: "user"; userId: string }
  | {
      kind: "plugin";
      pluginInstallationId: string;
      pluginKey: string;
    }
  | {
      kind: "system";
      source: "recovery" | "liveness" | "control";
    };

export interface TaskSessionSourceClaim {
  key: string;
  companyId: string;
  taskId: string;
  sessionId: string;
  sourceKind: string;
  immutableSourceKey: string;
  identityDigest: string;
  sourceId: string;
  eventId: string;
  messageId: string;
  inputId: string | null;
  refId: string | null;
  historyViewId: string | null;
  commentId: string | null;
}

export class TaskSessionLifecycleConflict extends Error {
  readonly code = "SessionInput.LifecycleConflict";
  readonly details: Readonly<Record<string, unknown>>;

  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "TaskSessionLifecycleConflict";
    this.details = Object.freeze({ ...details });
  }
}

export function canonicalTaskSessionJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalTaskSessionJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalTaskSessionJson(record[key])}`,
    )
    .join(",")}}`;
}

export function encodeTaskSessionMessageData(
  message: TaskSessionMessage,
): Record<string, unknown> {
  const encoded = encodeTaskSessionMessage(message) as unknown as Record<
    string,
    unknown
  >;
  const { id: _id, type: _type, ...data } = encoded;
  return data;
}

export function decodeStoredTaskSessionMessage(
  row: typeof taskSessionMessages.$inferSelect,
): TaskSessionMessage {
  let message: TaskSessionMessage;
  try {
    message = decodeTaskSessionMessage({
      ...row.data,
      id: row.id,
      type: row.type,
    });
  } catch (error) {
    throw new TaskSessionLifecycleConflict(
      "Stored Task Session message does not satisfy its shared schema",
      {
        messageId: row.id,
        messageType: row.type,
        reason: error instanceof Error ? error.message : String(error),
      },
    );
  }
  const encoded = encodeTaskSessionMessage(message) as unknown as Record<
    string,
    unknown
  >;
  const { id, type, ...data } = encoded;
  const encodedTime = encoded.time as
    | { created?: unknown }
    | undefined;
  if (
    id !== row.id ||
    type !== row.type ||
    canonicalTaskSessionJson(data) !==
      canonicalTaskSessionJson(row.data) ||
    encodedTime?.created !== row.timeCreated.getTime()
  ) {
    throw new TaskSessionLifecycleConflict(
      "Stored Task Session message diverges from its canonical encoding",
      { messageId: row.id, messageType: row.type },
    );
  }
  return message;
}

/**
 * Composition and maintenance may consume only complete Session aggregates.
 * Mutable in-flight assistant and shell projections are intentionally absent
 * from an immutable history view rather than reconstructed as partial turns.
 */
export function isSettledTaskSessionMessage(
  row: typeof taskSessionMessages.$inferSelect,
): boolean {
  const message = decodeStoredTaskSessionMessage(row);
  if (message.type === "shell") {
    return message.time.completed !== undefined;
  }
  if (message.type !== "assistant") return true;
  return (
    message.time.completed !== undefined &&
    message.content.every(
      (part) =>
        part.type !== "tool" ||
        (part.state.status !== "pending" &&
          part.state.status !== "running"),
    )
  );
}

export function decodeStoredTaskSessionEvent(
  row: StoredTaskSessionEvent,
): DecodedTaskSessionEvent {
  let event: DurableEvent;
  try {
    event = decodeDurableTaskSessionEventRow({
      id: row.id,
      sessionId: row.sessionId,
      seq: row.seq,
      type: row.type,
      data: row.data,
    });
  } catch (error) {
    throw new TaskSessionLifecycleConflict(
      "Stored Task Session event does not satisfy its versioned schema",
      {
        eventId: row.id,
        eventType: row.type,
        reason: error instanceof Error ? error.message : String(error),
      },
    );
  }
  const encoded = encodeDurableTaskSessionEventRow(event);
  if (
    encoded.id !== row.id ||
    encoded.sessionId !== row.sessionId ||
    encoded.seq !== row.seq ||
    encoded.type !== row.type ||
    canonicalTaskSessionJson(encoded.data) !==
      canonicalTaskSessionJson(row.data)
  ) {
    throw new TaskSessionLifecycleConflict(
      "Stored Task Session event envelope diverges from its canonical encoding",
      { eventId: row.id, eventType: row.type },
    );
  }
  const timestamp = (
    encodeTaskSessionEvent(event).data as { timestamp?: unknown }
  ).timestamp;
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
    throw new TaskSessionLifecycleConflict(
      "Stored Task Session event has no canonical timestamp",
      { eventId: row.id, eventType: row.type },
    );
  }
  return { row, event, timestamp: new Date(timestamp) };
}

function boundedPageSize(limit: number | undefined): number {
  if (limit === undefined) return TASK_SESSION_DEFAULT_PAGE_SIZE;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > TASK_SESSION_MAX_PAGE_SIZE
  ) {
    throw new TaskSessionInvalidCursor(
      `Task Session page size must be an integer from 1 to ${TASK_SESSION_MAX_PAGE_SIZE}`,
    );
  }
  return limit;
}

function cursorSignature(secret: string, payload: string): Buffer {
  return createHmac("sha256", secret).update(payload, "utf8").digest();
}

function encodeCursor(
  secret: string,
  envelope: TaskSessionCursorEnvelope,
): string {
  const payload = Buffer.from(
    JSON.stringify(envelope),
    "utf8",
  ).toString("base64url");
  return `${payload}.${cursorSignature(secret, payload).toString("base64url")}`;
}

function decodeCursor(
  secret: string,
  cursor: string | null | undefined,
  expected: Omit<TaskSessionCursorEnvelope, "seq" | "id">,
): { seq: number; id: string } | null {
  if (cursor === null || cursor === undefined) return null;
  if (cursor.length === 0) {
    throw new TaskSessionInvalidCursor();
  }
  const [payload, encodedSignature, extra] = cursor.split(".");
  if (!payload || !encodedSignature || extra) {
    throw new TaskSessionInvalidCursor();
  }
  const supplied = Buffer.from(encodedSignature, "base64url");
  const signature = cursorSignature(secret, payload);
  if (
    supplied.length !== signature.length ||
    !timingSafeEqual(supplied, signature)
  ) {
    throw new TaskSessionInvalidCursor();
  }
  let decoded: TaskSessionCursorEnvelope;
  try {
    decoded = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as TaskSessionCursorEnvelope;
  } catch {
    throw new TaskSessionInvalidCursor();
  }
  if (
    decoded === null ||
    typeof decoded !== "object" ||
    Array.isArray(decoded) ||
    decoded.v !== expected.v ||
    decoded.rowKind !== expected.rowKind ||
    decoded.companyId !== expected.companyId ||
    decoded.taskId !== expected.taskId ||
    decoded.sessionId !== expected.sessionId ||
    decoded.runId !== expected.runId ||
    decoded.afterSeq !== expected.afterSeq ||
    decoded.highWaterSeq !== expected.highWaterSeq ||
    decoded.messageOrder !== expected.messageOrder ||
    decoded.direction !== expected.direction ||
    decoded.projection !== expected.projection ||
    !Number.isSafeInteger(decoded.seq) ||
    decoded.seq < 0 ||
    typeof decoded.id !== "string" ||
    decoded.id.length === 0
  ) {
    throw new TaskSessionInvalidCursor();
  }
  return { seq: decoded.seq, id: decoded.id };
}

function assertScope(scope: TaskSessionPageScope): void {
  if (
    typeof scope.companyId !== "string" ||
    scope.companyId.length === 0 ||
    typeof scope.taskId !== "string" ||
    scope.taskId.length === 0 ||
    typeof scope.sessionId !== "string" ||
    scope.sessionId.length === 0 ||
    (scope.runId !== undefined &&
      (typeof scope.runId !== "string" || scope.runId.length === 0)) ||
    (scope.afterSeq !== undefined &&
      (!Number.isSafeInteger(scope.afterSeq) || scope.afterSeq < -1)) ||
    (scope.highWaterSeq !== undefined &&
      (!Number.isSafeInteger(scope.highWaterSeq) ||
        scope.highWaterSeq < -1)) ||
    (scope.afterSeq !== undefined &&
      scope.highWaterSeq !== undefined &&
      scope.afterSeq > scope.highWaterSeq) ||
    (scope.messageOrder !== undefined &&
      scope.messageOrder !== "created" &&
      scope.messageOrder !== "changed") ||
    (scope.direction !== undefined &&
      scope.direction !== "asc" &&
      scope.direction !== "desc") ||
    !TASK_SESSION_READ_PROJECTIONS.has(scope.projection)
  ) {
    throw new TaskSessionInvalidCursor(
      "Task Session page scope is invalid or incomplete",
    );
  }
}

function assertSequencedPage<Row extends {
  id: string;
  companyId: string;
  taskId: string;
  sessionId: string;
}>(
  rows: readonly Row[],
  base: Omit<TaskSessionCursorEnvelope, "seq" | "id">,
  after: { seq: number; id: string } | null,
  sequence: (row: Row) => number,
  runId: (row: Row) => string | null,
): void {
  let previous = after;
  for (const row of rows) {
    const seq = sequence(row);
    const scoped =
      row.companyId === base.companyId &&
      row.taskId === base.taskId &&
      row.sessionId === base.sessionId &&
      (base.runId === null || runId(row) === base.runId);
    const insideSnapshot =
      seq > base.afterSeq &&
      (base.highWaterSeq === null || seq <= base.highWaterSeq);
    const ordered =
      previous === null ||
      (base.direction === "asc"
        ? seq > previous.seq ||
          (seq === previous.seq && row.id > previous.id)
        : seq < previous.seq ||
          (seq === previous.seq && row.id < previous.id));
    if (
      !scoped ||
      !insideSnapshot ||
      !Number.isSafeInteger(seq) ||
      seq < 0 ||
      typeof row.id !== "string" ||
      row.id.length === 0 ||
      !ordered
    ) {
      throw new TaskSessionInvariantError(
        "Task Session storage returned a cross-scope or non-keyset page",
      );
    }
    previous = { seq, id: row.id };
  }
}

/**
 * The sole bounded read authority for canonical Session events, messages,
 * and projected comments. Every cursor is authenticated
 * and bound to company, task, Session, optional run, direction, row kind,
 * message creation/change ordering, exclusive delta checkpoint, inclusive
 * snapshot high-water, and a closed projection purpose.
 */
export function createTaskSessionStore(
  db: Db,
  options: { cursorSecret: string },
): TaskSessionStore {
  if (!options.cursorSecret) {
    throw new Error("Task Session cursor signing secret is required");
  }

  function cursorBase(
    rowKind: TaskSessionCursorEnvelope["rowKind"],
    scope: TaskSessionPageScope,
  ): Omit<TaskSessionCursorEnvelope, "seq" | "id"> {
    assertScope(scope);
    if (rowKind !== "message" && scope.messageOrder !== undefined) {
      throw new TaskSessionInvalidCursor(
        "Task Session message ordering is unavailable for this row kind",
      );
    }
    return {
      v: 1,
      rowKind,
      companyId: scope.companyId,
      taskId: scope.taskId,
      sessionId: scope.sessionId,
      runId: scope.runId ?? null,
      afterSeq: scope.afterSeq ?? -1,
      highWaterSeq: scope.highWaterSeq ?? null,
      messageOrder:
        rowKind === "message" ? scope.messageOrder ?? "created" : null,
      direction: scope.direction ?? "asc",
      projection: scope.projection,
    };
  }

  return {
    async pageEvents(
      scope: TaskSessionPageScope,
      request: TaskSessionPageRequest = {},
    ): Promise<TaskSessionPage<DecodedTaskSessionEvent>> {
      const base = cursorBase("event", scope);
      const after = decodeCursor(
        options.cursorSecret,
        request.cursor,
        base,
      );
      const limit = boundedPageSize(request.limit);
      const forward = base.direction === "asc";
      const rows = await db
        .select()
        .from(taskSessionEvents)
        .where(
          and(
            eq(taskSessionEvents.companyId, base.companyId),
            eq(taskSessionEvents.taskId, base.taskId),
            eq(taskSessionEvents.sessionId, base.sessionId),
            ...(base.runId
              ? [eq(taskSessionEvents.runId, base.runId)]
              : []),
            gt(taskSessionEvents.seq, base.afterSeq),
            ...(base.highWaterSeq !== null
              ? [lte(taskSessionEvents.seq, base.highWaterSeq)]
              : []),
            ...(after
              ? [
                  or(
                    forward
                      ? gt(taskSessionEvents.seq, after.seq)
                      : lt(taskSessionEvents.seq, after.seq),
                    and(
                      eq(taskSessionEvents.seq, after.seq),
                      forward
                        ? gt(taskSessionEvents.id, after.id)
                        : lt(taskSessionEvents.id, after.id),
                    ),
                  ),
                ]
              : []),
          ),
        )
        .orderBy(
          forward
            ? asc(taskSessionEvents.seq)
            : desc(taskSessionEvents.seq),
          forward
            ? asc(taskSessionEvents.id)
            : desc(taskSessionEvents.id),
        )
        .limit(limit + 1);
      assertSequencedPage(
        rows,
        base,
        after,
        (row) => row.seq,
        (row) => row.runId,
      );
      const pageRows = rows.slice(0, limit);
      const finalRow = pageRows.at(-1);
      return {
        items: pageRows.map(decodeStoredTaskSessionEvent),
        nextCursor:
          rows.length > limit && finalRow
            ? encodeCursor(options.cursorSecret, {
                ...base,
                seq: finalRow.seq,
                id: finalRow.id,
              })
            : null,
      };
    },

    async pageMessages(
      scope: TaskSessionPageScope,
      request: TaskSessionPageRequest = {},
    ): Promise<TaskSessionPage<DecodedTaskSessionMessage>> {
      const base = cursorBase("message", scope);
      const after = decodeCursor(
        options.cursorSecret,
        request.cursor,
        base,
      );
      const limit = boundedPageSize(request.limit);
      const forward = base.direction === "asc";
      const sequenceColumn =
        base.messageOrder === "changed"
          ? taskSessionMessages.modelStateSeq
          : taskSessionMessages.seq;
      const rows = await db
        .select()
        .from(taskSessionMessages)
        .where(
          and(
            eq(taskSessionMessages.companyId, base.companyId),
            eq(taskSessionMessages.taskId, base.taskId),
            eq(taskSessionMessages.sessionId, base.sessionId),
            ...(base.runId
              ? [eq(taskSessionMessages.runId, base.runId)]
              : []),
            gt(sequenceColumn, base.afterSeq),
            ...(base.highWaterSeq !== null
              ? [
                  lte(sequenceColumn, base.highWaterSeq),
                  lte(taskSessionMessages.modelStateSeq, base.highWaterSeq),
                ]
              : []),
            ...(after
              ? [
                  or(
                    forward
                      ? gt(sequenceColumn, after.seq)
                      : lt(sequenceColumn, after.seq),
                    and(
                      eq(sequenceColumn, after.seq),
                      forward
                        ? gt(taskSessionMessages.id, after.id)
                        : lt(taskSessionMessages.id, after.id),
                    ),
                  ),
                ]
              : []),
          ),
        )
        .orderBy(
          forward
            ? asc(sequenceColumn)
            : desc(sequenceColumn),
          forward
            ? asc(taskSessionMessages.id)
            : desc(taskSessionMessages.id),
        )
        .limit(limit + 1);
      assertSequencedPage(
        rows,
        base,
        after,
        (row) =>
          base.messageOrder === "changed" ? row.modelStateSeq : row.seq,
        (row) => row.runId,
      );
      if (
        base.highWaterSeq !== null &&
        rows.some(
          (row) =>
            !Number.isSafeInteger(row.modelStateSeq) ||
            row.modelStateSeq < row.seq ||
            row.modelStateSeq > base.highWaterSeq!,
        )
      ) {
        throw new TaskSessionInvariantError(
          "Task Session storage returned message state outside the snapshot",
        );
      }
      const pageRows = rows.slice(0, limit);
      const finalRow = pageRows.at(-1);
      return {
        items: pageRows.map((row) => ({
          row,
          message: decodeStoredTaskSessionMessage(row),
        })),
        nextCursor:
          rows.length > limit && finalRow
            ? encodeCursor(options.cursorSecret, {
                ...base,
                seq:
                  base.messageOrder === "changed"
                    ? finalRow.modelStateSeq
                    : finalRow.seq,
                id: finalRow.id,
              })
            : null,
      };
    },

    async pageComments(
      scope: TaskSessionPageScope,
      request: TaskSessionPageRequest = {},
    ): Promise<TaskSessionPage<StoredTaskSessionComment>> {
      const base = cursorBase("comment", scope);
      const after = decodeCursor(
        options.cursorSecret,
        request.cursor,
        base,
      );
      const limit = boundedPageSize(request.limit);
      const forward = base.direction === "asc";
      const rows = await db
        .select()
        .from(taskComments)
        .where(
          and(
            eq(taskComments.companyId, base.companyId),
            eq(taskComments.taskId, base.taskId),
            eq(taskComments.sessionId, base.sessionId),
            ...(base.runId
              ? [eq(taskComments.runId, base.runId)]
              : []),
            gt(taskComments.projectedEventSeq, base.afterSeq),
            ...(base.highWaterSeq !== null
              ? [
                  lte(
                    taskComments.projectedEventSeq,
                    base.highWaterSeq,
                  ),
                ]
              : []),
            ...(after
              ? [
                  or(
                    forward
                      ? gt(
                          taskComments.projectedEventSeq,
                          after.seq,
                        )
                      : lt(
                          taskComments.projectedEventSeq,
                          after.seq,
                        ),
                    and(
                      eq(
                        taskComments.projectedEventSeq,
                        after.seq,
                      ),
                      forward
                        ? gt(taskComments.id, after.id)
                        : lt(taskComments.id, after.id),
                    ),
                  ),
                ]
              : []),
          ),
        )
        .orderBy(
          forward
            ? asc(taskComments.projectedEventSeq)
            : desc(taskComments.projectedEventSeq),
          forward ? asc(taskComments.id) : desc(taskComments.id),
        )
        .limit(limit + 1);
      assertSequencedPage(
        rows,
        base,
        after,
        (row) => row.projectedEventSeq,
        (row) => row.runId,
      );
      const pageRows = rows.slice(0, limit);
      const finalRow = pageRows.at(-1);
      return {
        items: pageRows,
        nextCursor:
          rows.length > limit && finalRow
            ? encodeCursor(options.cursorSecret, {
                ...base,
                seq: finalRow.projectedEventSeq,
                id: finalRow.id,
              })
            : null,
      };
    },

    bindReadDatabase(readDb: Db): TaskSessionStore {
      return createTaskSessionStore(readDb, options);
    },
  };
}

export class TaskSessionInvariantError extends Error {
  readonly code = "TaskSession.InvariantViolation";

  constructor(message: string) {
    super(message);
    this.name = "TaskSessionInvariantError";
  }
}
