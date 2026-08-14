import { createHmac } from "node:crypto";

import { taskComments, taskSessionEvents, taskSessionMessages, type Db } from "@paperclipai/db";

import {
  decodeDurableTaskSessionEventRow,
  decodeTaskSessionMessage,
  encodeDurableTaskSessionEventRow,
  encodeTaskSessionEvent,
  encodeTaskSessionMessage,
  type DurableEvent,
  type TaskSessionMessage,
} from "@paperclipai/shared/task-session";

export class TaskSessionInvariantError extends Error {
  readonly code = "TaskSession.InvariantViolation";

  constructor(message: string) {
    super(message);
    this.name = "TaskSessionInvariantError";
  }
}

export const TASK_SESSION_DEFAULT_PAGE_SIZE = 100;

export const TASK_SESSION_MAX_PAGE_SIZE = 500;

export type TaskSessionReadProjection =
  "composition" | "execution-history" | "rebuild" | "run-trace" | "run-log" | "audit" | "export";

export const TASK_SESSION_READ_PROJECTIONS: ReadonlySet<string> = new Set([
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

export type StoredTaskSessionEvent = typeof taskSessionEvents.$inferSelect;

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

export interface TaskSessionCursorEnvelope {
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

export type StoredTaskSessionComment = typeof taskComments.$inferSelect;

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
    .map((key) => `${JSON.stringify(key)}:${canonicalTaskSessionJson(record[key])}`)
    .join(",")}}`;
}

export function encodeTaskSessionMessageData(message: TaskSessionMessage): Record<string, unknown> {
  const encoded = encodeTaskSessionMessage(message) as unknown as Record<string, unknown>;
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
    throw new TaskSessionLifecycleConflict("Stored Task Session message does not satisfy its shared schema", {
      messageId: row.id,
      messageType: row.type,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  const encoded = encodeTaskSessionMessage(message) as unknown as Record<string, unknown>;
  const { id, type, ...data } = encoded;
  const encodedTime = encoded.time as { created?: unknown } | undefined;
  if (
    id !== row.id ||
    type !== row.type ||
    canonicalTaskSessionJson(data) !== canonicalTaskSessionJson(row.data) ||
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
export function isSettledTaskSessionMessage(row: typeof taskSessionMessages.$inferSelect): boolean {
  const message = decodeStoredTaskSessionMessage(row);
  if (message.type === "shell") {
    return message.time.completed !== undefined;
  }
  if (message.type !== "assistant") return true;
  return (
    message.time.completed !== undefined &&
    message.content.every(
      (part) => part.type !== "tool" || (part.state.status !== "pending" && part.state.status !== "running"),
    )
  );
}

export function decodeStoredTaskSessionEvent(row: StoredTaskSessionEvent): DecodedTaskSessionEvent {
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
    canonicalTaskSessionJson(encoded.data) !== canonicalTaskSessionJson(row.data)
  ) {
    throw new TaskSessionLifecycleConflict(
      "Stored Task Session event envelope diverges from its canonical encoding",
      { eventId: row.id, eventType: row.type },
    );
  }
  const timestamp = (
    encodeTaskSessionEvent(event).data as {
      timestamp?: unknown;
    }
  ).timestamp;
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
    throw new TaskSessionLifecycleConflict("Stored Task Session event has no canonical timestamp", {
      eventId: row.id,
      eventType: row.type,
    });
  }
  return { row, event, timestamp: new Date(timestamp) };
}

export function boundedPageSize(limit: number | undefined): number {
  if (limit === undefined) return TASK_SESSION_DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > TASK_SESSION_MAX_PAGE_SIZE) {
    throw new TaskSessionInvalidCursor(
      `Task Session page size must be an integer from 1 to ${TASK_SESSION_MAX_PAGE_SIZE}`,
    );
  }
  return limit;
}

export function cursorSignature(secret: string, payload: string): Buffer {
  return createHmac("sha256", secret).update(payload, "utf8").digest();
}

export function encodeCursor(secret: string, envelope: TaskSessionCursorEnvelope): string {
  const payload = Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
  return `${payload}.${cursorSignature(secret, payload).toString("base64url")}`;
}
