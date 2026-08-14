import { timingSafeEqual } from "node:crypto";

import { type Db, taskComments, taskSessionEvents, taskSessionMessages } from "@paperclipai/db";
import {
  type TaskSessionCursorEnvelope,
  type TaskSessionPageScope,
  cursorSignature,
  TASK_SESSION_READ_PROJECTIONS,
  TaskSessionInvalidCursor,
  TaskSessionInvariantError,
} from "./store-part-1.js";

import { and, asc, desc, eq, gt, lt, lte, or } from "drizzle-orm";
import * as storeCore from "./store-part-1.js";
export function decodeCursor(
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
  if (supplied.length !== signature.length || !timingSafeEqual(supplied, signature)) {
    throw new TaskSessionInvalidCursor();
  }
  let decoded: TaskSessionCursorEnvelope;
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as TaskSessionCursorEnvelope;
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

export function assertScope(scope: TaskSessionPageScope): void {
  if (
    typeof scope.companyId !== "string" ||
    scope.companyId.length === 0 ||
    typeof scope.taskId !== "string" ||
    scope.taskId.length === 0 ||
    typeof scope.sessionId !== "string" ||
    scope.sessionId.length === 0 ||
    (scope.runId !== undefined && (typeof scope.runId !== "string" || scope.runId.length === 0)) ||
    (scope.afterSeq !== undefined && (!Number.isSafeInteger(scope.afterSeq) || scope.afterSeq < -1)) ||
    (scope.highWaterSeq !== undefined &&
      (!Number.isSafeInteger(scope.highWaterSeq) || scope.highWaterSeq < -1)) ||
    (scope.afterSeq !== undefined &&
      scope.highWaterSeq !== undefined &&
      scope.afterSeq > scope.highWaterSeq) ||
    (scope.messageOrder !== undefined &&
      scope.messageOrder !== "created" &&
      scope.messageOrder !== "changed") ||
    (scope.direction !== undefined && scope.direction !== "asc" && scope.direction !== "desc") ||
    !TASK_SESSION_READ_PROJECTIONS.has(scope.projection)
  ) {
    throw new TaskSessionInvalidCursor("Task Session page scope is invalid or incomplete");
  }
}

export function assertSequencedPage<
  Row extends {
    id: string;
    companyId: string;
    taskId: string;
    sessionId: string;
  },
>(
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
    const insideSnapshot = seq > base.afterSeq && (base.highWaterSeq === null || seq <= base.highWaterSeq);
    const ordered =
      previous === null ||
      (base.direction === "asc"
        ? seq > previous.seq || (seq === previous.seq && row.id > previous.id)
        : seq < previous.seq || (seq === previous.seq && row.id < previous.id));
    if (
      !scoped ||
      !insideSnapshot ||
      !Number.isSafeInteger(seq) ||
      seq < 0 ||
      typeof row.id !== "string" ||
      row.id.length === 0 ||
      !ordered
    ) {
      throw new TaskSessionInvariantError("Task Session storage returned a cross-scope or non-keyset page");
    }
    previous = { seq, id: row.id };
  }
}
export { TaskSessionInvariantError };

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
): storeCore.TaskSessionStore {
  if (!options.cursorSecret) {
    throw new Error("Task Session cursor signing secret is required");
  }

  function cursorBase(
    rowKind: TaskSessionCursorEnvelope["rowKind"],
    scope: TaskSessionPageScope,
  ): Omit<TaskSessionCursorEnvelope, "seq" | "id"> {
    assertScope(scope);
    if (rowKind !== "message" && scope.messageOrder !== undefined) {
      throw new TaskSessionInvalidCursor("Task Session message ordering is unavailable for this row kind");
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
      messageOrder: rowKind === "message" ? (scope.messageOrder ?? "created") : null,
      direction: scope.direction ?? "asc",
      projection: scope.projection,
    };
  }

  return {
    async pageEvents(
      scope: TaskSessionPageScope,
      request: storeCore.TaskSessionPageRequest = {},
    ): Promise<storeCore.TaskSessionPage<storeCore.DecodedTaskSessionEvent>> {
      const base = cursorBase("event", scope);
      const after = decodeCursor(options.cursorSecret, request.cursor, base);
      const limit = storeCore.boundedPageSize(request.limit);
      const forward = base.direction === "asc";
      const rows = await db
        .select()
        .from(taskSessionEvents)
        .where(
          and(
            eq(taskSessionEvents.companyId, base.companyId),
            eq(taskSessionEvents.taskId, base.taskId),
            eq(taskSessionEvents.sessionId, base.sessionId),
            ...(base.runId ? [eq(taskSessionEvents.runId, base.runId)] : []),
            gt(taskSessionEvents.seq, base.afterSeq),
            ...(base.highWaterSeq !== null ? [lte(taskSessionEvents.seq, base.highWaterSeq)] : []),
            ...(after
              ? [
                  or(
                    forward ? gt(taskSessionEvents.seq, after.seq) : lt(taskSessionEvents.seq, after.seq),
                    and(
                      eq(taskSessionEvents.seq, after.seq),
                      forward ? gt(taskSessionEvents.id, after.id) : lt(taskSessionEvents.id, after.id),
                    ),
                  ),
                ]
              : []),
          ),
        )
        .orderBy(
          forward ? asc(taskSessionEvents.seq) : desc(taskSessionEvents.seq),
          forward ? asc(taskSessionEvents.id) : desc(taskSessionEvents.id),
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
        items: pageRows.map(storeCore.decodeStoredTaskSessionEvent),
        nextCursor:
          rows.length > limit && finalRow
            ? storeCore.encodeCursor(options.cursorSecret, {
                ...base,
                seq: finalRow.seq,
                id: finalRow.id,
              })
            : null,
      };
    },

    async pageMessages(
      scope: TaskSessionPageScope,
      request: storeCore.TaskSessionPageRequest = {},
    ): Promise<storeCore.TaskSessionPage<storeCore.DecodedTaskSessionMessage>> {
      const base = cursorBase("message", scope);
      const after = decodeCursor(options.cursorSecret, request.cursor, base);
      const limit = storeCore.boundedPageSize(request.limit);
      const forward = base.direction === "asc";
      const sequenceColumn =
        base.messageOrder === "changed" ? taskSessionMessages.modelStateSeq : taskSessionMessages.seq;
      const rows = await db
        .select()
        .from(taskSessionMessages)
        .where(
          and(
            eq(taskSessionMessages.companyId, base.companyId),
            eq(taskSessionMessages.taskId, base.taskId),
            eq(taskSessionMessages.sessionId, base.sessionId),
            ...(base.runId ? [eq(taskSessionMessages.runId, base.runId)] : []),
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
                    forward ? gt(sequenceColumn, after.seq) : lt(sequenceColumn, after.seq),
                    and(
                      eq(sequenceColumn, after.seq),
                      forward ? gt(taskSessionMessages.id, after.id) : lt(taskSessionMessages.id, after.id),
                    ),
                  ),
                ]
              : []),
          ),
        )
        .orderBy(
          forward ? asc(sequenceColumn) : desc(sequenceColumn),
          forward ? asc(taskSessionMessages.id) : desc(taskSessionMessages.id),
        )
        .limit(limit + 1);
      assertSequencedPage(
        rows,
        base,
        after,
        (row) => (base.messageOrder === "changed" ? row.modelStateSeq : row.seq),
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
          message: storeCore.decodeStoredTaskSessionMessage(row),
        })),
        nextCursor:
          rows.length > limit && finalRow
            ? storeCore.encodeCursor(options.cursorSecret, {
                ...base,
                seq: base.messageOrder === "changed" ? finalRow.modelStateSeq : finalRow.seq,
                id: finalRow.id,
              })
            : null,
      };
    },

    async pageComments(
      scope: TaskSessionPageScope,
      request: storeCore.TaskSessionPageRequest = {},
    ): Promise<storeCore.TaskSessionPage<storeCore.StoredTaskSessionComment>> {
      const base = cursorBase("comment", scope);
      const after = decodeCursor(options.cursorSecret, request.cursor, base);
      const limit = storeCore.boundedPageSize(request.limit);
      const forward = base.direction === "asc";
      const rows = await db
        .select()
        .from(taskComments)
        .where(
          and(
            eq(taskComments.companyId, base.companyId),
            eq(taskComments.taskId, base.taskId),
            eq(taskComments.sessionId, base.sessionId),
            ...(base.runId ? [eq(taskComments.runId, base.runId)] : []),
            gt(taskComments.projectedEventSeq, base.afterSeq),
            ...(base.highWaterSeq !== null ? [lte(taskComments.projectedEventSeq, base.highWaterSeq)] : []),
            ...(after
              ? [
                  or(
                    forward
                      ? gt(taskComments.projectedEventSeq, after.seq)
                      : lt(taskComments.projectedEventSeq, after.seq),
                    and(
                      eq(taskComments.projectedEventSeq, after.seq),
                      forward ? gt(taskComments.id, after.id) : lt(taskComments.id, after.id),
                    ),
                  ),
                ]
              : []),
          ),
        )
        .orderBy(
          forward ? asc(taskComments.projectedEventSeq) : desc(taskComments.projectedEventSeq),
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
            ? storeCore.encodeCursor(options.cursorSecret, {
                ...base,
                seq: finalRow.projectedEventSeq,
                id: finalRow.id,
              })
            : null,
      };
    },

    bindReadDatabase(readDb: Db): storeCore.TaskSessionStore {
      return createTaskSessionStore(readDb, options);
    },
  };
}
