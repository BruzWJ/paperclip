import { encodeTaskSessionMessage, type TaskSessionMessage } from "@paperclipai/shared/task-session";
import type {
  CanonicalRunTracePart,
  CanonicalRunTraceTurn,
  ContextRetrievalCommentProjection,
} from "./context-retrieval.js";
import { redactEventPayload, redactSensitiveText } from "../redaction.js";
import { redactCurrentUserValue } from "../log-redaction.js";
import { type CommentProjectionRow, iso } from "./context-retrieval-db-task-projections.js";

export function mapContextCommentAuthor(
  row: CommentProjectionRow,
): ContextRetrievalCommentProjection["author"] {
  if (
    row.authorType === "agent" &&
    typeof row.authorAgentId === "string" &&
    row.authorAgentId.length > 0 &&
    row.authorUserId === null &&
    row.authorPluginKey === null
  ) {
    return { kind: "agent", agentId: row.authorAgentId };
  }
  if (
    row.authorType === "user" &&
    row.authorAgentId === null &&
    typeof row.authorUserId === "string" &&
    row.authorUserId.length > 0 &&
    row.authorPluginKey === null
  ) {
    return { kind: "user", userId: row.authorUserId };
  }
  if (
    row.authorType === "plugin" &&
    row.authorAgentId === null &&
    row.authorUserId === null &&
    typeof row.authorPluginKey === "string" &&
    row.authorPluginKey.length > 0
  ) {
    return { kind: "plugin", pluginKey: row.authorPluginKey };
  }
  if (
    row.authorType === "system" &&
    row.authorAgentId === null &&
    row.authorUserId === null &&
    row.authorPluginKey === null
  ) {
    return { kind: "system" };
  }
  throw new Error("Canonical task comment row has an invalid author shape");
}

export function sanitizedValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactCurrentUserValue(redactSensitiveText(value));
  }
  if (Array.isArray(value)) {
    return value.map(sanitizedValue);
  }
  if (value && typeof value === "object") {
    return redactCurrentUserValue(redactEventPayload(value as Record<string, unknown>));
  }
  return value;
}

export function wireRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function wireString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function safeModel(value: unknown): CanonicalRunTraceTurn["model"] {
  const model = wireRecord(value);
  const id = wireString(model.id);
  const providerId = wireString(model.providerID);
  if (!id || !providerId) return null;
  return {
    id,
    providerId,
    ...(wireString(model.variant) ? { variant: wireString(model.variant) } : {}),
  };
}

export function assistantParts(value: unknown): CanonicalRunTracePart[] {
  if (!Array.isArray(value)) return [];
  const result: CanonicalRunTracePart[] = [];
  for (const rawPart of value) {
    const part = wireRecord(rawPart);
    const kind = wireString(part.type);
    const id = wireString(part.id);
    if (!id) continue;
    if ((kind === "text" || kind === "reasoning") && wireString(part.text) !== null) {
      result.push({
        kind,
        id,
        text: redactSensitiveText(String(part.text)),
      });
      continue;
    }
    if (kind !== "tool") continue;
    const state = wireRecord(part.state);
    const status = wireString(state.status);
    const callId = id;
    const name = wireString(part.name);
    if (
      !name ||
      (status !== "pending" && status !== "running" && status !== "completed" && status !== "error")
    ) {
      continue;
    }
    const output =
      status === "pending"
        ? undefined
        : sanitizedValue(
            Object.fromEntries(
              ["structured", "content", "result"]
                .filter((key) => state[key] !== undefined)
                .map((key) => [key, state[key]]),
            ),
          );
    const error = wireRecord(state.error);
    result.push({
      kind: "tool",
      id,
      callId,
      name,
      state: status,
      input: sanitizedValue(state.input),
      ...(output !== undefined ? { output } : {}),
      ...(wireString(error.type) ? { errorKind: wireString(error.type) } : {}),
    });
  }
  return result;
}

/**
 * Builds the descriptor-safe run turn from a schema-validated V2 message.
 * Provider metadata, attachments/snapshots, token/cost usage, and message
 * metadata are intentionally absent from this allowlist.
 */
export function sanitizeCanonicalMessage(message: TaskSessionMessage, seq: number): CanonicalRunTraceTurn {
  const wire = encodeTaskSessionMessage(message) as unknown as Record<string, unknown>;
  const time = wireRecord(wire.time);
  const base = {
    seq,
    id: String(wire.id),
    kind: message.type,
    timestamp: iso(Number(time.created)),
  } satisfies Pick<CanonicalRunTraceTurn, "seq" | "id" | "kind" | "timestamp">;
  const completedAt = typeof time.completed === "number" ? iso(time.completed) : null;

  switch (message.type) {
    case "agent-switched":
      return {
        ...base,
        agentId: wireString(wire.agent),
      };
    case "model-switched":
      return {
        ...base,
        model: safeModel(wire.model),
      };
    case "user":
    case "synthetic":
    case "system":
      return {
        ...base,
        text: redactSensitiveText(String(wire.text ?? "")),
      };
    case "shell":
      return {
        ...base,
        ...(completedAt ? { completedAt } : {}),
        callId: wireString(wire.callID),
        command: redactSensitiveText(String(wire.command ?? "")),
        output: redactSensitiveText(String(wire.output ?? "")),
      };
    case "assistant": {
      const error = wireRecord(wire.error);
      return {
        ...base,
        ...(completedAt ? { completedAt } : {}),
        agentId: wireString(wire.agent),
        model: safeModel(wire.model),
        content: assistantParts(wire.content),
        finish: wireString(wire.finish),
        errorKind: wireString(error.type),
      };
    }
  }
}
