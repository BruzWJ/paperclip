import { createHmac, timingSafeEqual } from "node:crypto";
import {
  issueComments,
  issueSessionCompactionControls,
  issueSessionEvents,
  issueSessionMessages,
  type Db,
} from "@paperclipai/db";
import {
  decodeDurableIssueSessionEventRow,
  decodeIssueSessionMessage,
  encodeDurableIssueSessionEventRow,
  encodeIssueSessionEvent,
  encodeIssueSessionMessage,
  type DurableEvent,
  type IssueSessionMessage,
} from "@paperclipai/shared/issue-session";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  isNotNull,
  lt,
  or,
} from "drizzle-orm";

export const ISSUE_SESSION_DEFAULT_PAGE_SIZE = 100;
export const ISSUE_SESSION_MAX_PAGE_SIZE = 500;

export type IssueSessionReadProjection =
  | "composition"
  | "compaction"
  | "execution-history"
  | "rebuild"
  | "run-trace"
  | "run-log"
  | "audit"
  | "export";

const ISSUE_SESSION_READ_PROJECTIONS: ReadonlySet<string> = new Set([
  "composition",
  "compaction",
  "execution-history",
  "rebuild",
  "run-trace",
  "run-log",
  "audit",
  "export",
]);

export interface IssueSessionPageScope {
  companyId: string;
  issueId: string;
  sessionId: string;
  runId?: string;
  direction?: "asc" | "desc";
  projection: IssueSessionReadProjection;
}

export interface IssueSessionPageRequest {
  cursor?: string | null;
  limit?: number;
}

export interface IssueSessionPage<T> {
  items: T[];
  nextCursor: string | null;
}

export type StoredIssueSessionEvent =
  typeof issueSessionEvents.$inferSelect;

export interface DecodedIssueSessionEvent {
  row: StoredIssueSessionEvent;
  event: DurableEvent;
  timestamp: Date;
}

export interface DecodedIssueSessionMessage {
  row: typeof issueSessionMessages.$inferSelect;
  message: IssueSessionMessage;
}

export interface IssueSessionStore {
  pageEvents(
    scope: IssueSessionPageScope,
    request?: IssueSessionPageRequest,
  ): Promise<IssueSessionPage<DecodedIssueSessionEvent>>;
  pageMessages(
    scope: IssueSessionPageScope,
    request?: IssueSessionPageRequest,
  ): Promise<IssueSessionPage<DecodedIssueSessionMessage>>;
  pageCompactionControls(
    scope: IssueSessionPageScope,
    request?: IssueSessionPageRequest,
  ): Promise<IssueSessionPage<StoredIssueSessionCompactionControl>>;
  pageComments(
    scope: IssueSessionPageScope,
    request?: IssueSessionPageRequest,
  ): Promise<IssueSessionPage<StoredIssueSessionComment>>;
  /**
   * Keeps the same cursor authority while executing reads in an already-owned
   * database transaction. This is the only transaction-local Session reader.
   */
  bindReadDatabase(db: Db): IssueSessionStore;
}

interface IssueSessionCursorEnvelope {
  v: 1;
  rowKind: "event" | "message" | "comment" | "compaction-control";
  companyId: string;
  issueId: string;
  sessionId: string;
  runId: string | null;
  direction: "asc" | "desc";
  projection: IssueSessionReadProjection;
  seq: number;
  id: string;
}

export class IssueSessionInvalidCursor extends Error {
  readonly code = "issue_session_invalid_cursor";

  constructor(message = "Invalid or cross-scope Issue Session cursor") {
    super(message);
    this.name = "IssueSessionInvalidCursor";
  }
}

export type StoredIssueSessionCompactionControl =
  typeof issueSessionCompactionControls.$inferSelect;
export type StoredIssueSessionComment =
  typeof issueComments.$inferSelect;

export type IssueSessionCommentAuthor =
  | { kind: "agent"; agentId: string }
  | { kind: "user"; userId: string }
  | {
      kind: "plugin";
      pluginInstallationId: string;
      pluginKey: string;
    }
  | {
      kind: "system";
      source: "watchdog" | "recovery" | "liveness" | "control";
    };

export interface IssueSessionSourceClaim {
  key: string;
  companyId: string;
  issueId: string;
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

export class IssueSessionLifecycleConflict extends Error {
  readonly code = "SessionInput.LifecycleConflict";
  readonly details: Readonly<Record<string, unknown>>;

  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "IssueSessionLifecycleConflict";
    this.details = Object.freeze({ ...details });
  }
}

export function canonicalIssueSessionJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalIssueSessionJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalIssueSessionJson(record[key])}`,
    )
    .join(",")}}`;
}

export function encodeIssueSessionMessageData(
  message: IssueSessionMessage,
): Record<string, unknown> {
  const encoded = encodeIssueSessionMessage(message) as unknown as Record<
    string,
    unknown
  >;
  const { id: _id, type: _type, ...data } = encoded;
  return data;
}

export function decodeStoredIssueSessionMessage(
  row: typeof issueSessionMessages.$inferSelect,
): IssueSessionMessage {
  let message: IssueSessionMessage;
  try {
    message = decodeIssueSessionMessage({
      ...row.data,
      id: row.id,
      type: row.type,
    });
  } catch (error) {
    throw new IssueSessionLifecycleConflict(
      "Stored Issue Session message does not satisfy its shared schema",
      {
        messageId: row.id,
        messageType: row.type,
        reason: error instanceof Error ? error.message : String(error),
      },
    );
  }
  const encoded = encodeIssueSessionMessage(message) as unknown as Record<
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
    canonicalIssueSessionJson(data) !==
      canonicalIssueSessionJson(row.data) ||
    encodedTime?.created !== row.timeCreated.getTime()
  ) {
    throw new IssueSessionLifecycleConflict(
      "Stored Issue Session message diverges from its canonical encoding",
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
export function isSettledIssueSessionMessage(
  row: typeof issueSessionMessages.$inferSelect,
): boolean {
  const message = decodeStoredIssueSessionMessage(row);
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

export function decodeStoredIssueSessionEvent(
  row: StoredIssueSessionEvent,
): DecodedIssueSessionEvent {
  let event: DurableEvent;
  try {
    event = decodeDurableIssueSessionEventRow({
      id: row.id,
      sessionId: row.sessionId,
      seq: row.seq,
      type: row.type,
      data: row.data,
    });
  } catch (error) {
    throw new IssueSessionLifecycleConflict(
      "Stored Issue Session event does not satisfy its versioned schema",
      {
        eventId: row.id,
        eventType: row.type,
        reason: error instanceof Error ? error.message : String(error),
      },
    );
  }
  const encoded = encodeDurableIssueSessionEventRow(event);
  if (
    encoded.id !== row.id ||
    encoded.sessionId !== row.sessionId ||
    encoded.seq !== row.seq ||
    encoded.type !== row.type ||
    canonicalIssueSessionJson(encoded.data) !==
      canonicalIssueSessionJson(row.data)
  ) {
    throw new IssueSessionLifecycleConflict(
      "Stored Issue Session event envelope diverges from its canonical encoding",
      { eventId: row.id, eventType: row.type },
    );
  }
  const timestamp = (
    encodeIssueSessionEvent(event).data as { timestamp?: unknown }
  ).timestamp;
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
    throw new IssueSessionLifecycleConflict(
      "Stored Issue Session event has no canonical timestamp",
      { eventId: row.id, eventType: row.type },
    );
  }
  return { row, event, timestamp: new Date(timestamp) };
}

function boundedPageSize(limit: number | undefined): number {
  if (limit === undefined) return ISSUE_SESSION_DEFAULT_PAGE_SIZE;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > ISSUE_SESSION_MAX_PAGE_SIZE
  ) {
    throw new IssueSessionInvalidCursor(
      `Issue Session page size must be an integer from 1 to ${ISSUE_SESSION_MAX_PAGE_SIZE}`,
    );
  }
  return limit;
}

function cursorSignature(secret: string, payload: string): Buffer {
  return createHmac("sha256", secret).update(payload, "utf8").digest();
}

function encodeCursor(
  secret: string,
  envelope: IssueSessionCursorEnvelope,
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
  expected: Omit<IssueSessionCursorEnvelope, "seq" | "id">,
): { seq: number; id: string } | null {
  if (cursor === null || cursor === undefined) return null;
  if (cursor.length === 0) {
    throw new IssueSessionInvalidCursor();
  }
  const [payload, encodedSignature, extra] = cursor.split(".");
  if (!payload || !encodedSignature || extra) {
    throw new IssueSessionInvalidCursor();
  }
  const supplied = Buffer.from(encodedSignature, "base64url");
  const signature = cursorSignature(secret, payload);
  if (
    supplied.length !== signature.length ||
    !timingSafeEqual(supplied, signature)
  ) {
    throw new IssueSessionInvalidCursor();
  }
  let decoded: IssueSessionCursorEnvelope;
  try {
    decoded = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as IssueSessionCursorEnvelope;
  } catch {
    throw new IssueSessionInvalidCursor();
  }
  if (
    decoded === null ||
    typeof decoded !== "object" ||
    Array.isArray(decoded) ||
    decoded.v !== expected.v ||
    decoded.rowKind !== expected.rowKind ||
    decoded.companyId !== expected.companyId ||
    decoded.issueId !== expected.issueId ||
    decoded.sessionId !== expected.sessionId ||
    decoded.runId !== expected.runId ||
    decoded.direction !== expected.direction ||
    decoded.projection !== expected.projection ||
    !Number.isSafeInteger(decoded.seq) ||
    decoded.seq < 0 ||
    typeof decoded.id !== "string" ||
    decoded.id.length === 0
  ) {
    throw new IssueSessionInvalidCursor();
  }
  return { seq: decoded.seq, id: decoded.id };
}

function assertScope(scope: IssueSessionPageScope): void {
  if (
    typeof scope.companyId !== "string" ||
    scope.companyId.length === 0 ||
    typeof scope.issueId !== "string" ||
    scope.issueId.length === 0 ||
    typeof scope.sessionId !== "string" ||
    scope.sessionId.length === 0 ||
    (scope.runId !== undefined &&
      (typeof scope.runId !== "string" || scope.runId.length === 0)) ||
    (scope.direction !== undefined &&
      scope.direction !== "asc" &&
      scope.direction !== "desc") ||
    !ISSUE_SESSION_READ_PROJECTIONS.has(scope.projection)
  ) {
    throw new IssueSessionInvalidCursor(
      "Issue Session page scope is invalid or incomplete",
    );
  }
}

function assertSequencedPage<Row extends {
  id: string;
  companyId: string;
  issueId: string;
  sessionId: string;
}>(
  rows: readonly Row[],
  base: Omit<IssueSessionCursorEnvelope, "seq" | "id">,
  after: { seq: number; id: string } | null,
  sequence: (row: Row) => number,
  runId: (row: Row) => string | null,
): void {
  let previous = after;
  for (const row of rows) {
    const seq = sequence(row);
    const scoped =
      row.companyId === base.companyId &&
      row.issueId === base.issueId &&
      row.sessionId === base.sessionId &&
      (base.runId === null || runId(row) === base.runId);
    const ordered =
      previous === null ||
      (base.direction === "asc"
        ? seq > previous.seq ||
          (seq === previous.seq && row.id > previous.id)
        : seq < previous.seq ||
          (seq === previous.seq && row.id < previous.id));
    if (
      !scoped ||
      !Number.isSafeInteger(seq) ||
      seq < 0 ||
      typeof row.id !== "string" ||
      row.id.length === 0 ||
      !ordered
    ) {
      throw new IssueSessionInvariantError(
        "Issue Session storage returned a cross-scope or non-keyset page",
      );
    }
    previous = { seq, id: row.id };
  }
}

function requiredSequence(value: number | null, rowKind: string): number {
  if (value === null || !Number.isSafeInteger(value) || value < 0) {
    throw new IssueSessionLifecycleConflict(
      `${rowKind} is missing its canonical Session sequence`,
    );
  }
  return value;
}

/**
 * The sole bounded read authority for canonical Session events, messages,
 * compaction controls, and projected comments. Every cursor is authenticated
 * and bound to company, issue, Session, optional run, direction, row kind,
 * and a closed projection purpose.
 */
export function createIssueSessionStore(
  db: Db,
  options: { cursorSecret: string },
): IssueSessionStore {
  if (!options.cursorSecret) {
    throw new Error("Issue Session cursor signing secret is required");
  }

  function cursorBase(
    rowKind: IssueSessionCursorEnvelope["rowKind"],
    scope: IssueSessionPageScope,
  ): Omit<IssueSessionCursorEnvelope, "seq" | "id"> {
    assertScope(scope);
    return {
      v: 1,
      rowKind,
      companyId: scope.companyId,
      issueId: scope.issueId,
      sessionId: scope.sessionId,
      runId: scope.runId ?? null,
      direction: scope.direction ?? "asc",
      projection: scope.projection,
    };
  }

  return {
    async pageEvents(
      scope: IssueSessionPageScope,
      request: IssueSessionPageRequest = {},
    ): Promise<IssueSessionPage<DecodedIssueSessionEvent>> {
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
        .from(issueSessionEvents)
        .where(
          and(
            eq(issueSessionEvents.companyId, base.companyId),
            eq(issueSessionEvents.issueId, base.issueId),
            eq(issueSessionEvents.sessionId, base.sessionId),
            ...(base.runId
              ? [eq(issueSessionEvents.runId, base.runId)]
              : []),
            ...(after
              ? [
                  or(
                    forward
                      ? gt(issueSessionEvents.seq, after.seq)
                      : lt(issueSessionEvents.seq, after.seq),
                    and(
                      eq(issueSessionEvents.seq, after.seq),
                      forward
                        ? gt(issueSessionEvents.id, after.id)
                        : lt(issueSessionEvents.id, after.id),
                    ),
                  ),
                ]
              : []),
          ),
        )
        .orderBy(
          forward
            ? asc(issueSessionEvents.seq)
            : desc(issueSessionEvents.seq),
          forward
            ? asc(issueSessionEvents.id)
            : desc(issueSessionEvents.id),
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
        items: pageRows.map(decodeStoredIssueSessionEvent),
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
      scope: IssueSessionPageScope,
      request: IssueSessionPageRequest = {},
    ): Promise<IssueSessionPage<DecodedIssueSessionMessage>> {
      const base = cursorBase("message", scope);
      const after = decodeCursor(
        options.cursorSecret,
        request.cursor,
        base,
      );
      const limit = boundedPageSize(request.limit);
      const forward = base.direction === "asc";
      const rows = await db
        .select()
        .from(issueSessionMessages)
        .where(
          and(
            eq(issueSessionMessages.companyId, base.companyId),
            eq(issueSessionMessages.issueId, base.issueId),
            eq(issueSessionMessages.sessionId, base.sessionId),
            ...(base.runId
              ? [eq(issueSessionMessages.runId, base.runId)]
              : []),
            ...(after
              ? [
                  or(
                    forward
                      ? gt(issueSessionMessages.seq, after.seq)
                      : lt(issueSessionMessages.seq, after.seq),
                    and(
                      eq(issueSessionMessages.seq, after.seq),
                      forward
                        ? gt(issueSessionMessages.id, after.id)
                        : lt(issueSessionMessages.id, after.id),
                    ),
                  ),
                ]
              : []),
          ),
        )
        .orderBy(
          forward
            ? asc(issueSessionMessages.seq)
            : desc(issueSessionMessages.seq),
          forward
            ? asc(issueSessionMessages.id)
            : desc(issueSessionMessages.id),
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
        items: pageRows.map((row) => ({
          row,
          message: decodeStoredIssueSessionMessage(row),
        })),
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

    async pageCompactionControls(
      scope: IssueSessionPageScope,
      request: IssueSessionPageRequest = {},
    ): Promise<IssueSessionPage<StoredIssueSessionCompactionControl>> {
      const base = cursorBase("compaction-control", scope);
      const after = decodeCursor(
        options.cursorSecret,
        request.cursor,
        base,
      );
      const limit = boundedPageSize(request.limit);
      const forward = base.direction === "asc";
      const rows = await db
        .select()
        .from(issueSessionCompactionControls)
        .where(
          and(
            eq(issueSessionCompactionControls.companyId, base.companyId),
            eq(issueSessionCompactionControls.issueId, base.issueId),
            eq(issueSessionCompactionControls.sessionId, base.sessionId),
            // Recovery-prompt is a nonsequenced control-plane settlement
            // owner. This bounded Session reader pages sequenced effects.
            isNotNull(issueSessionCompactionControls.seq),
            ...(base.runId
              ? [
                  eq(
                    issueSessionCompactionControls.compactionRunId,
                    base.runId,
                  ),
                ]
              : []),
            ...(after
              ? [
                  or(
                    forward
                      ? gt(issueSessionCompactionControls.seq, after.seq)
                      : lt(issueSessionCompactionControls.seq, after.seq),
                    and(
                      eq(
                        issueSessionCompactionControls.seq,
                        after.seq,
                      ),
                      forward
                        ? gt(
                            issueSessionCompactionControls.id,
                            after.id,
                          )
                        : lt(
                            issueSessionCompactionControls.id,
                            after.id,
                          ),
                    ),
                  ),
                ]
              : []),
          ),
        )
        .orderBy(
          forward
            ? asc(issueSessionCompactionControls.seq)
            : desc(issueSessionCompactionControls.seq),
          forward
            ? asc(issueSessionCompactionControls.id)
            : desc(issueSessionCompactionControls.id),
        )
        .limit(limit + 1);
      assertSequencedPage(
        rows,
        base,
        after,
        (row) => requiredSequence(row.seq, "compaction control"),
        (row) => row.compactionRunId,
      );
      const pageRows = rows.slice(0, limit);
      const finalRow = pageRows.at(-1);
      return {
        items: pageRows,
        nextCursor:
          rows.length > limit && finalRow
            ? encodeCursor(options.cursorSecret, {
                ...base,
                seq: requiredSequence(
                  finalRow.seq,
                  "compaction control",
                ),
                id: finalRow.id,
              })
            : null,
      };
    },

    async pageComments(
      scope: IssueSessionPageScope,
      request: IssueSessionPageRequest = {},
    ): Promise<IssueSessionPage<StoredIssueSessionComment>> {
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
        .from(issueComments)
        .where(
          and(
            eq(issueComments.companyId, base.companyId),
            eq(issueComments.issueId, base.issueId),
            eq(issueComments.sessionId, base.sessionId),
            ...(base.runId
              ? [eq(issueComments.runId, base.runId)]
              : []),
            ...(after
              ? [
                  or(
                    forward
                      ? gt(
                          issueComments.projectedEventSeq,
                          after.seq,
                        )
                      : lt(
                          issueComments.projectedEventSeq,
                          after.seq,
                        ),
                    and(
                      eq(
                        issueComments.projectedEventSeq,
                        after.seq,
                      ),
                      forward
                        ? gt(issueComments.id, after.id)
                        : lt(issueComments.id, after.id),
                    ),
                  ),
                ]
              : []),
          ),
        )
        .orderBy(
          forward
            ? asc(issueComments.projectedEventSeq)
            : desc(issueComments.projectedEventSeq),
          forward ? asc(issueComments.id) : desc(issueComments.id),
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

    bindReadDatabase(readDb: Db): IssueSessionStore {
      return createIssueSessionStore(readDb, options);
    },
  };
}

export class IssueSessionInvariantError extends Error {
  readonly code = "IssueSession.InvariantViolation";

  constructor(message: string) {
    super(message);
    this.name = "IssueSessionInvariantError";
  }
}
