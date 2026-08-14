import {
  decodeSystemCreatorSourceKind,
  decodeTaskDisposition,
  type ProviderSafeRunOutputCommentReference,
  type ProviderSafeRunTrace,
  type ProviderSafeRunTracePart,
  type ProviderSafeRunTraceTurn,
  type ProviderSafeTaskCreator,
  type ProviderSafeTaskOwner,
  type ProviderSafeTraceValue,
} from "@paperclipai/shared";
import { redactEventPayload, redactSensitiveText } from "../redaction.js";
import { redactCurrentUserValue } from "../log-redaction.js";
import type {
  CanonicalRunCommentLink,
  CanonicalRunTrace,
  CanonicalRunTracePart,
  CanonicalRunTraceTurn,
  ContextRetrievalCommentProjection,
  ContextRetrievalTaskProjection,
  ProviderSafeCommentAuthor,
} from "./context-retrieval-contracts.js";
import { assertCommentProjection, assertTaskProjection } from "./context-retrieval-cursors.js";

export function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

export function providerSafeCommentBody(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Context comment body must be a string");
  }
  return value;
}

export function nullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  return requiredString(value, label);
}

export function providerSafeCreator(value: unknown): ProviderSafeTaskCreator {
  const creator = asRecord(value, "Context task creator");
  switch (creator.kind) {
    case "agent-execution":
      return {
        kind: "agent-execution",
        agentId: requiredString(creator.agentId, "Context task creator.agentId"),
      };
    case "user/board":
      return {
        kind: "user/board",
        userId: nullableString(creator.userId, "Context task creator.userId"),
      };
    case "plugin":
      return {
        kind: "plugin",
        pluginKey: requiredString(creator.pluginKey, "Context task creator.pluginKey"),
      };
    case "routine":
      return {
        kind: "routine",
        routineId: requiredString(creator.routineId, "Context task creator.routineId"),
      };
    case "system":
      return {
        kind: "system",
        sourceKind: decodeSystemCreatorSourceKind(creator.sourceKind),
      };
    default:
      throw new Error("Context task creator has an unsupported kind");
  }
}

export function providerSafeOwner(value: unknown): ProviderSafeTaskOwner {
  const owner = asRecord(value, "Context task owner");
  switch (owner.kind) {
    case "agent":
      return {
        kind: "agent",
        agentId: requiredString(owner.agentId, "Context task owner.agentId"),
      };
    case "user":
      return {
        kind: "user",
        userId: requiredString(owner.userId, "Context task owner.userId"),
      };
    case "board":
      return { kind: "board" };
    default:
      throw new Error("Context task owner has an unsupported kind");
  }
}

export function providerSafeCommentAuthor(value: unknown): ProviderSafeCommentAuthor {
  const author = asRecord(value, "Context comment author");
  const assertExactAuthorKeys = (keys: readonly string[]): void => {
    const actual = Object.keys(author).sort();
    const expected = [...keys].sort();
    if (actual.join("\n") !== expected.join("\n")) {
      throw new Error(`Context comment author has a non-canonical shape: ${actual.join(", ")}`);
    }
  };
  switch (author.kind) {
    case "agent": {
      assertExactAuthorKeys(["kind", "agentId"]);
      return {
        kind: "agent",
        agentId: requiredString(author.agentId, "Context comment author.agentId"),
      };
    }
    case "user": {
      assertExactAuthorKeys(["kind", "userId"]);
      return {
        kind: "user",
        userId: requiredString(author.userId, "Context comment author.userId"),
      };
    }
    case "plugin": {
      assertExactAuthorKeys(["kind", "pluginKey"]);
      return {
        kind: "plugin",
        pluginKey: requiredString(author.pluginKey, "Context comment author.pluginKey"),
      };
    }
    case "system": {
      assertExactAuthorKeys(["kind"]);
      return { kind: "system" };
    }
    default:
      throw new Error("Context comment author has an unsupported kind");
  }
}

export function providerSafeTask(task: ContextRetrievalTaskProjection): ContextRetrievalTaskProjection {
  assertTaskProjection(task);
  if (
    task.status !== "open" &&
    task.status !== "blocked" &&
    task.status !== "done" &&
    task.status !== "cancelled"
  ) {
    throw new Error("Context task projection has an unsupported status");
  }
  if (
    task.priority !== "critical" &&
    task.priority !== "high" &&
    task.priority !== "medium" &&
    task.priority !== "low"
  ) {
    throw new Error("Context task projection has an unsupported priority");
  }
  if (!Number.isSafeInteger(task.directChildCount) || task.directChildCount < 0) {
    throw new Error("Context task projection has an invalid direct-child count");
  }
  return {
    id: requiredString(task.id, "Context task id"),
    identifier: requiredString(task.identifier, "Context task identifier"),
    title: nullableString(task.title, "Context task title"),
    request: requiredString(task.request, "Context task request"),
    status: task.status,
    disposition: task.disposition === null ? null : decodeTaskDisposition(task.disposition),
    priority: task.priority,
    creator: providerSafeCreator(task.creator),
    owner: providerSafeOwner(task.owner),
    parentId: nullableString(task.parentId, "Context task parentId"),
    directChildCount: task.directChildCount,
    updatedAt: requiredString(task.updatedAt, "Context task updatedAt"),
  };
}

export function providerSafeComment(
  comment: ContextRetrievalCommentProjection,
): ContextRetrievalCommentProjection {
  assertCommentProjection(comment);
  if (!Number.isSafeInteger(comment.sequence) || comment.sequence < 0) {
    throw new Error("Context comment projection has an invalid sequence");
  }
  return {
    id: requiredString(comment.id, "Context comment id"),
    taskId: requiredString(comment.taskId, "Context comment taskId"),
    body: providerSafeCommentBody(comment.body),
    author: providerSafeCommentAuthor(comment.author),
    runId: nullableString(comment.runId, "Context comment runId"),
    sequence: comment.sequence,
    createdAt: requiredString(comment.createdAt, "Context comment createdAt"),
  };
}

export const PROVIDER_TRACE_FORBIDDEN_FIELD =
  /(?:^|_)(?:authority|revision|agent_id|model|provider|native|session|checkpoint|message_id|turn_id|part_id|call_id|update_id|trace_id|triggered_by_run_id|parent_run_id|lineage|accounting|usage|cost|token|credential|secret|password|auth|authorization|bearer|cookie|gateway|api_key|access_key|private_key|adapter_config|runtime_config|control_plane|execution_ref|run_interface)(?:_|$)/;

export function normalizedTraceFieldName(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toLowerCase();
}

export function providerTraceFieldIsForbidden(value: string): boolean {
  return PROVIDER_TRACE_FORBIDDEN_FIELD.test(normalizedTraceFieldName(value));
}

export function providerSafeTraceString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return redactCurrentUserValue(redactSensitiveText(value));
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function providerSafeTraceValue(value: unknown, depth = 0): ProviderSafeTraceValue | undefined {
  if (depth > 20) return undefined;
  if (value === null) return null;
  if (typeof value === "string") return providerSafeTraceString(value);
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    return value.map((entry) => providerSafeTraceValue(entry, depth + 1) ?? null);
  }
  if (!isPlainRecord(value)) return undefined;

  const redacted = redactCurrentUserValue(redactEventPayload(value) ?? {});
  const result: Record<string, ProviderSafeTraceValue> = {};
  for (const [key, entry] of Object.entries(redacted)) {
    if (providerTraceFieldIsForbidden(key)) continue;
    const projected = providerSafeTraceValue(entry, depth + 1);
    if (projected !== undefined) result[key] = projected;
  }
  return result;
}

export function providerSafeTracePart(part: CanonicalRunTracePart): ProviderSafeRunTracePart | null {
  if (part.kind === "tool") {
    if (part.state !== "completed" && part.state !== "error") return null;
    const input = providerSafeTraceValue(part.input) ?? null;
    const result: ProviderSafeRunTracePart = {
      kind: "tool",
      name: part.name,
      state: part.state,
      input,
    };
    const toolResult = providerSafeTraceValue(part.output);
    if (toolResult !== undefined) result.result = toolResult;
    const errorKind = providerSafeTraceString(part.errorKind);
    if (errorKind) result.errorKind = errorKind;
    return result;
  }
  const text = providerSafeTraceString(part.text);
  if (text === undefined) return null;
  return { kind: part.kind, text };
}

export function providerSafeTraceTurn(turn: CanonicalRunTraceTurn): ProviderSafeRunTraceTurn | null {
  if (turn.kind === "agent-switched" || turn.kind === "model-switched") {
    return null;
  }
  const result: ProviderSafeRunTraceTurn = {
    kind: turn.kind,
    timestamp: turn.timestamp,
  };
  const completedAt = providerSafeTraceString(turn.completedAt);
  if (completedAt) result.completedAt = completedAt;
  const text = providerSafeTraceString(turn.text);
  if (text !== undefined) result.text = text;
  if (turn.kind === "shell") {
    const command = providerSafeTraceString(turn.command);
    const output = providerSafeTraceString(turn.output);
    const shellTool: ProviderSafeRunTracePart = {
      kind: "tool",
      name: "shell",
      state: "completed",
      input: {
        command: command ?? "",
      },
    };
    if (output !== undefined) {
      shellTool.result = { output };
    }
    result.content = [shellTool];
  } else if (turn.content) {
    const content = turn.content
      .map(providerSafeTracePart)
      .filter((part): part is ProviderSafeRunTracePart => part !== null);
    if (content.length > 0) result.content = content;
  }
  const finish = providerSafeTraceString(turn.finish);
  if (finish) result.finish = finish;
  const errorKind = providerSafeTraceString(turn.errorKind);
  if (errorKind) result.errorKind = errorKind;
  return result;
}

export function providerSafeOutputComment(
  comment: CanonicalRunCommentLink,
): ProviderSafeRunOutputCommentReference {
  return {
    commentId: comment.commentId,
  };
}

export function providerSafeRunTrace(trace: CanonicalRunTrace): ProviderSafeRunTrace {
  return {
    runId: trace.runId,
    runKind: trace.runKind,
    status: trace.status,
    startedAt: trace.startedAt,
    finishedAt: trace.finishedAt,
    outcome: trace.outcome,
    turns: trace.turns
      .map(providerSafeTraceTurn)
      .filter((turn): turn is ProviderSafeRunTraceTurn => turn !== null),
    outputComments: trace.comments.map(providerSafeOutputComment),
    nextCursor: trace.nextCursor,
  };
}
