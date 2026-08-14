import { createHmac, timingSafeEqual } from "node:crypto";
import * as contextContracts from "./context-retrieval-contracts.js";

export function boundedLimit(limit: number | undefined): number {
  if (limit === undefined) return contextContracts.CONTEXT_RETRIEVAL_DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > contextContracts.CONTEXT_RETRIEVAL_MAX_PAGE_SIZE) {
    throw new contextContracts.ContextRetrievalInvalidCursor(
      `Page size must be an integer from 1 to ${contextContracts.CONTEXT_RETRIEVAL_MAX_PAGE_SIZE}`,
    );
  }
  return limit;
}

export function scopeKey(parts: readonly string[]): string {
  return parts.join("\u001f");
}

export function signature(secret: string, payload: string): Buffer {
  return createHmac("sha256", secret).update(payload, "utf8").digest();
}

export function encodeRetrievalCursor(
  secret: string,
  envelope: contextContracts.RetrievalCursorEnvelope,
): string {
  if (!secret) throw new Error("Context retrieval cursor secret is required");
  const payload = Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
  return `${payload}.${signature(secret, payload).toString("base64url")}`;
}

export function decodeRetrievalCursor(
  secret: string,
  cursor: string | null | undefined,
  expectedScope: string,
): contextContracts.RetrievalCursorPosition | null {
  if (!cursor) return null;
  const [payload, encodedSignature, extra] = cursor.split(".");
  if (!payload || !encodedSignature || extra) {
    throw new contextContracts.ContextRetrievalInvalidCursor();
  }
  let supplied: Buffer;
  try {
    supplied = Buffer.from(encodedSignature, "base64url");
    if (supplied.toString("base64url") !== encodedSignature) {
      throw new contextContracts.ContextRetrievalInvalidCursor();
    }
  } catch {
    throw new contextContracts.ContextRetrievalInvalidCursor();
  }
  const expected = signature(secret, payload);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new contextContracts.ContextRetrievalInvalidCursor();
  }

  let envelope: contextContracts.RetrievalCursorEnvelope;
  try {
    const payloadBytes = Buffer.from(payload, "base64url");
    if (payloadBytes.toString("base64url") !== payload) {
      throw new contextContracts.ContextRetrievalInvalidCursor();
    }
    envelope = JSON.parse(payloadBytes.toString("utf8")) as contextContracts.RetrievalCursorEnvelope;
  } catch {
    throw new contextContracts.ContextRetrievalInvalidCursor();
  }
  if (
    envelope.v !== 1 ||
    envelope.scope !== expectedScope ||
    !envelope.position ||
    typeof envelope.position.sortValue !== "string" ||
    typeof envelope.position.id !== "string" ||
    !envelope.position.sortValue ||
    !envelope.position.id
  ) {
    throw new contextContracts.ContextRetrievalInvalidCursor();
  }
  return envelope.position;
}

export function pageCursor<T>(
  secret: string,
  scope: string,
  rows: readonly T[],
  limit: number,
  position: (row: T) => contextContracts.RetrievalCursorPosition,
): contextContracts.RetrievalPage<T> {
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit);
  const finalItem = items.at(-1);
  return {
    items,
    nextCursor:
      hasMore && finalItem
        ? encodeRetrievalCursor(secret, {
            v: 1,
            scope,
            position: position(finalItem),
          })
        : null,
  };
}

export function taskPosition(
  task: contextContracts.ContextRetrievalTaskProjection,
): contextContracts.RetrievalCursorPosition {
  return { sortValue: task.updatedAt, id: task.id };
}

export function commentPosition(
  comment: contextContracts.ContextRetrievalCommentProjection,
): contextContracts.RetrievalCursorPosition {
  return {
    sortValue: String(comment.sequence).padStart(20, "0"),
    id: comment.id,
  };
}

export function tracePosition(
  turn: contextContracts.CanonicalRunTraceTurn,
): contextContracts.RetrievalCursorPosition {
  return {
    sortValue: String(turn.seq).padStart(20, "0"),
    id: turn.id,
  };
}

export function assertTaskProjection(task: contextContracts.ContextRetrievalTaskProjection): void {
  const exactKeys = [
    "id",
    "identifier",
    "title",
    "request",
    "status",
    "disposition",
    "priority",
    "creator",
    "owner",
    "parentId",
    "directChildCount",
    "updatedAt",
  ];
  const actual = Object.keys(task).sort();
  if (actual.join("\n") !== [...exactKeys].sort().join("\n")) {
    throw new Error(`Context repository returned a non-canonical task projection: ${actual.join(", ")}`);
  }
}

export function assertCommentProjection(comment: contextContracts.ContextRetrievalCommentProjection): void {
  const exactKeys = ["id", "taskId", "body", "author", "runId", "sequence", "createdAt"];
  const actual = Object.keys(comment).sort();
  if (actual.join("\n") !== [...exactKeys].sort().join("\n")) {
    throw new Error(`Context repository returned a non-canonical comment projection: ${actual.join(", ")}`);
  }
}
