import { createHmac, timingSafeEqual } from "node:crypto";
import {
  decodeTaskDisposition,
  decodeSystemCreatorSourceKind,
  type AgentVisibleTaskStatus,
  type AcpCostUnavailableReason,
  type BudgetCurrency,
  type TaskExecutionRunKind,
  type MoneyAmount,
  type ProviderSafeTaskCreator,
  type ProviderSafeTaskOwner,
  type ProviderSafeTaskProjection,
  type ProviderSafeRunOutputCommentReference,
  type ProviderSafeRunTrace,
  type ProviderSafeRunTracePart,
  type ProviderSafeRunTraceTurn,
  type ProviderSafeTraceValue,
} from "@paperclipai/shared";
import { redactEventPayload, redactSensitiveText } from "../redaction.js";
import { redactCurrentUserValue } from "../log-redaction.js";
import {
  resolveContextRetrievalPolicy,
  type ContextDial,
} from "./context-dial-resolver.js";

export const CONTEXT_RETRIEVAL_DEFAULT_PAGE_SIZE = 25;
export const CONTEXT_RETRIEVAL_MAX_PAGE_SIZE = 100;

/**
 * Immutable creator attribution that is safe to expose through a compiled
 * provider interface. The canonical creator record contains authority,
 * adapter-revision, callback, and other control-plane identifiers; none of
 * those are retrieval content.
 */
export type {
  ProviderSafeTaskCreator,
  ProviderSafeTaskOwner,
} from "@paperclipai/shared";

export type ProviderSafeCommentAuthor =
  | { kind: "agent"; agentId: string }
  | { kind: "user"; userId: string }
  | { kind: "plugin"; pluginKey: string }
  | { kind: "system" };

export type ContextRetrievalTaskProjection =
  ProviderSafeTaskProjection;

export interface ContextRetrievalCommentProjection {
  id: string;
  taskId: string;
  body: string;
  author: ProviderSafeCommentAuthor;
  runId: string | null;
  sequence: number;
  createdAt: string;
}

export type CanonicalRunTracePart =
  | {
      kind: "text" | "reasoning";
      id: string;
      text: string;
    }
  | {
      kind: "tool";
      id: string;
      callId: string;
      name: string;
      state: "pending" | "running" | "completed" | "error";
      input: unknown;
      output?: unknown;
      errorKind?: string | null;
    };

export interface CanonicalRunTraceTurn {
  seq: number;
  id: string;
  kind:
    | "agent-switched"
    | "model-switched"
    | "user"
    | "synthetic"
    | "system"
    | "shell"
    | "assistant";
  timestamp: string;
  completedAt?: string | null;
  agentId?: string | null;
  model?: {
    id: string;
    providerId: string;
    variant?: string | null;
  } | null;
  text?: string | null;
  callId?: string | null;
  command?: string | null;
  output?: string | null;
  content?: CanonicalRunTracePart[];
  finish?: string | null;
  errorKind?: string | null;
}

export interface CanonicalRunCommentLink {
  commentId: string;
  messageId: string;
  sourceKind:
    | "run_output"
    | "run_progress"
    | "task_update";
  projectedEventSeq: number;
}

/** Latest protocol-settled prompt accounting for one run; never a raw usage envelope. */
export interface CanonicalRunTraceAccounting {
  contextUsedTokens: number;
  contextWindowTokens: number;
  budgetCurrency: BudgetCurrency;
  cost:
    | { kind: "known"; knownDeltaAmount: MoneyAmount }
    | { kind: "unavailable"; unavailableReason: AcpCostUnavailableReason };
}

/**
 * Internal canonical trace assembled from V2 rows. It is not the provider
 * DTO: it may retain control-plane-safe board telemetry such as model switch
 * records so board-only consumers do not need to rehydrate raw Session rows.
 */
export interface CanonicalRunTrace {
  runId: string;
  runKind: TaskExecutionRunKind;
  taskId: string;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  accounting: CanonicalRunTraceAccounting | null;
  turns: CanonicalRunTraceTurn[];
  outcome: "succeeded" | "failed" | null;
  comments: CanonicalRunCommentLink[];
  nextCursor: string | null;
}

export interface RetrievalPage<T> {
  items: T[];
  nextCursor: string | null;
}

export interface RetrievalTaskFilters {
  status?: AgentVisibleTaskStatus;
  priority?: ContextRetrievalTaskProjection["priority"];
}

export interface RetrievalPageRequest {
  cursor?: string | null;
  limit?: number;
}

export interface TaskReach {
  sameCompany: boolean;
  active: boolean;
  descendant: boolean;
}

export interface ContextRetrievalRepository {
  taskReach(input: {
    companyId: string;
    activeTaskId: string;
    taskId: string;
  }): Promise<TaskReach | null>;
  listTopLevelTasks(input: {
    companyId: string;
    filters: RetrievalTaskFilters;
    after: RetrievalCursorPosition | null;
    limit: number;
  }): Promise<ContextRetrievalTaskProjection[]>;
  listDirectChildren(input: {
    companyId: string;
    taskId: string;
    after: RetrievalCursorPosition | null;
    limit: number;
  }): Promise<ContextRetrievalTaskProjection[]>;
  listTaskComments(input: {
    companyId: string;
    taskId: string;
    after: RetrievalCursorPosition | null;
    limit: number;
  }): Promise<ContextRetrievalCommentProjection[]>;
  runTask(input: {
    companyId: string;
    runId: string;
  }): Promise<{ taskId: string } | null>;
  readCanonicalRunTrace(input: {
    companyId: string;
    runId: string;
    after?: RetrievalCursorPosition | null;
    limit?: number;
  }): Promise<CanonicalRunTrace | null>;
}

export interface ContextRetrievalScope {
  companyId: string;
  activeTaskId: string;
  dial: ContextDial;
}

export interface ContextRetrievalServiceOptions {
  cursorSecret: string;
  repository: ContextRetrievalRepository;
}

export class ContextRetrievalDenied extends Error {
  readonly code = "context_retrieval_denied";

  constructor(message = "Task is outside the effective context tier") {
    super(message);
    this.name = "ContextRetrievalDenied";
  }
}

export class ContextRetrievalInvalidCursor extends Error {
  readonly code = "context_retrieval_invalid_cursor";

  constructor(message = "Invalid or stale context retrieval cursor") {
    super(message);
    this.name = "ContextRetrievalInvalidCursor";
  }
}

export interface RetrievalCursorPosition {
  sortValue: string;
  id: string;
}

interface RetrievalCursorEnvelope {
  v: 1;
  scope: string;
  position: RetrievalCursorPosition;
}

function boundedLimit(limit: number | undefined): number {
  if (limit === undefined) return CONTEXT_RETRIEVAL_DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > CONTEXT_RETRIEVAL_MAX_PAGE_SIZE) {
    throw new ContextRetrievalInvalidCursor(
      `Page size must be an integer from 1 to ${CONTEXT_RETRIEVAL_MAX_PAGE_SIZE}`,
    );
  }
  return limit;
}

function scopeKey(parts: readonly string[]): string {
  return parts.join("\u001f");
}

function signature(secret: string, payload: string): Buffer {
  return createHmac("sha256", secret).update(payload, "utf8").digest();
}

export function encodeRetrievalCursor(
  secret: string,
  envelope: RetrievalCursorEnvelope,
): string {
  if (!secret) throw new Error("Context retrieval cursor secret is required");
  const payload = Buffer.from(JSON.stringify(envelope), "utf8").toString(
    "base64url",
  );
  return `${payload}.${signature(secret, payload).toString("base64url")}`;
}

export function decodeRetrievalCursor(
  secret: string,
  cursor: string | null | undefined,
  expectedScope: string,
): RetrievalCursorPosition | null {
  if (!cursor) return null;
  const [payload, encodedSignature, extra] = cursor.split(".");
  if (!payload || !encodedSignature || extra) {
    throw new ContextRetrievalInvalidCursor();
  }
  let supplied: Buffer;
  try {
    supplied = Buffer.from(encodedSignature, "base64url");
  } catch {
    throw new ContextRetrievalInvalidCursor();
  }
  const expected = signature(secret, payload);
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  ) {
    throw new ContextRetrievalInvalidCursor();
  }

  let envelope: RetrievalCursorEnvelope;
  try {
    envelope = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as RetrievalCursorEnvelope;
  } catch {
    throw new ContextRetrievalInvalidCursor();
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
    throw new ContextRetrievalInvalidCursor();
  }
  return envelope.position;
}

function pageCursor<T>(
  secret: string,
  scope: string,
  rows: readonly T[],
  limit: number,
  position: (row: T) => RetrievalCursorPosition,
): RetrievalPage<T> {
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

function taskPosition(
  task: ContextRetrievalTaskProjection,
): RetrievalCursorPosition {
  return { sortValue: task.updatedAt, id: task.id };
}

function commentPosition(
  comment: ContextRetrievalCommentProjection,
): RetrievalCursorPosition {
  return { sortValue: String(comment.sequence).padStart(20, "0"), id: comment.id };
}

function tracePosition(
  turn: CanonicalRunTraceTurn,
): RetrievalCursorPosition {
  return {
    sortValue: String(turn.seq).padStart(20, "0"),
    id: turn.id,
  };
}

function assertTaskProjection(task: ContextRetrievalTaskProjection): void {
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
    throw new Error(
      `Context repository returned a non-canonical task projection: ${actual.join(", ")}`,
    );
  }
}

function assertCommentProjection(comment: ContextRetrievalCommentProjection): void {
  const exactKeys = [
    "id",
    "taskId",
    "body",
    "author",
    "runId",
    "sequence",
    "createdAt",
  ];
  const actual = Object.keys(comment).sort();
  if (actual.join("\n") !== [...exactKeys].sort().join("\n")) {
    throw new Error(
      `Context repository returned a non-canonical comment projection: ${actual.join(", ")}`,
    );
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function providerSafeCommentBody(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Context comment body must be a string");
  }
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  return requiredString(value, label);
}

function providerSafeCreator(value: unknown): ProviderSafeTaskCreator {
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

function providerSafeOwner(value: unknown): ProviderSafeTaskOwner {
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

function providerSafeCommentAuthor(value: unknown): ProviderSafeCommentAuthor {
  const author = asRecord(value, "Context comment author");
  const assertExactAuthorKeys = (keys: readonly string[]): void => {
    const actual = Object.keys(author).sort();
    const expected = [...keys].sort();
    if (actual.join("\n") !== expected.join("\n")) {
      throw new Error(
        `Context comment author has a non-canonical shape: ${actual.join(", ")}`,
      );
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
        pluginKey: requiredString(
          author.pluginKey,
          "Context comment author.pluginKey",
        ),
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

function providerSafeTask(
  task: ContextRetrievalTaskProjection,
): ContextRetrievalTaskProjection {
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
  if (
    !Number.isSafeInteger(task.directChildCount) ||
    task.directChildCount < 0
  ) {
    throw new Error("Context task projection has an invalid direct-child count");
  }
  return {
    id: requiredString(task.id, "Context task id"),
    identifier: nullableString(task.identifier, "Context task identifier"),
    title: nullableString(task.title, "Context task title"),
    request: requiredString(task.request, "Context task request"),
    status: task.status,
    disposition:
      task.disposition === null
        ? null
        : decodeTaskDisposition(task.disposition),
    priority: task.priority,
    creator: providerSafeCreator(task.creator),
    owner: providerSafeOwner(task.owner),
    parentId: nullableString(task.parentId, "Context task parentId"),
    directChildCount: task.directChildCount,
    updatedAt: requiredString(task.updatedAt, "Context task updatedAt"),
  };
}

function providerSafeComment(
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

const PROVIDER_TRACE_FORBIDDEN_FIELD =
  /(?:^|_)(?:authority|revision|agent_id|model|provider|native|session|checkpoint|message_id|turn_id|part_id|call_id|update_id|trace_id|triggered_by_run_id|parent_run_id|lineage|accounting|usage|cost|token|credential|secret|password|auth|authorization|bearer|cookie|gateway|api_key|access_key|private_key|adapter_config|runtime_config|control_plane|execution_ref|run_interface)(?:_|$)/;

function normalizedTraceFieldName(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toLowerCase();
}

function providerTraceFieldIsForbidden(value: string): boolean {
  return PROVIDER_TRACE_FORBIDDEN_FIELD.test(
    normalizedTraceFieldName(value),
  );
}

function providerSafeTraceString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return redactCurrentUserValue(redactSensitiveText(value));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function providerSafeTraceValue(
  value: unknown,
  depth = 0,
): ProviderSafeTraceValue | undefined {
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

function providerSafeTracePart(
  part: CanonicalRunTracePart,
): ProviderSafeRunTracePart | null {
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

function providerSafeTraceTurn(
  turn: CanonicalRunTraceTurn,
): ProviderSafeRunTraceTurn | null {
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

function providerSafeOutputComment(
  comment: CanonicalRunCommentLink,
): ProviderSafeRunOutputCommentReference {
  return {
    commentId: comment.commentId,
  };
}

function providerSafeRunTrace(trace: CanonicalRunTrace): ProviderSafeRunTrace {
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

async function assertReach(
  repository: ContextRetrievalRepository,
  scope: ContextRetrievalScope,
  taskId: string,
  allowed: {
    active: boolean;
    descendant: boolean;
    company: boolean;
  },
): Promise<void> {
  const reach = await repository.taskReach({
    companyId: scope.companyId,
    activeTaskId: scope.activeTaskId,
    taskId,
  });
  if (
    !reach?.sameCompany ||
    !(
      (allowed.active && reach.active) ||
      (allowed.descendant && reach.descendant) ||
      allowed.company
    )
  ) {
    throw new ContextRetrievalDenied();
  }
}

export function createContextRetrievalService(
  options: ContextRetrievalServiceOptions,
) {
  if (!options.cursorSecret) {
    throw new Error("Context retrieval cursor secret is required");
  }

  async function readCanonicalAgentRunTrace(input: {
    companyId: string;
    runId: string;
    cursor?: string | null;
  }): Promise<ProviderSafeRunTrace> {
    const run = await options.repository.runTask({
      companyId: input.companyId,
      runId: input.runId,
    });
    if (!run) throw new ContextRetrievalDenied();
    const key = scopeKey([
      "read_task_agent_run",
      input.companyId,
      input.runId,
    ]);
    const after = decodeRetrievalCursor(
      options.cursorSecret,
      input.cursor,
      key,
    );
    const limit = boundedLimit(undefined);
    const trace = await options.repository.readCanonicalRunTrace({
      companyId: input.companyId,
      runId: input.runId,
      after,
      limit: limit + 1,
    });
    if (!trace || trace.taskId !== run.taskId) {
      throw new ContextRetrievalDenied();
    }
    const page = pageCursor(
      options.cursorSecret,
      key,
      trace.turns,
      limit,
      tracePosition,
    );
    return providerSafeRunTrace({
      ...trace,
      turns: page.items,
      nextCursor: page.nextCursor,
    });
  }

  return {
    /**
     * Internal reuse point for a capability-scoped recovery. It intentionally
     * bypasses context-dial reach checks; its caller must prove a narrower
     * runtime authority before naming a run.
     */
    readCanonicalAgentRunTrace,

    async listCompanyTasks(
      scope: ContextRetrievalScope,
      input: RetrievalPageRequest & { filters?: RetrievalTaskFilters } = {},
    ): Promise<RetrievalPage<ContextRetrievalTaskProjection>> {
      const policy = resolveContextRetrievalPolicy(scope.dial);
      if (!policy.listCompanyTasks) throw new ContextRetrievalDenied();
      const filters = input.filters ?? {};
      const key = scopeKey([
        "list_company_tasks",
        scope.companyId,
        filters.status ?? "",
        filters.priority ?? "",
      ]);
      const after = decodeRetrievalCursor(
        options.cursorSecret,
        input.cursor,
        key,
      );
      const limit = boundedLimit(input.limit);
      const rows = await options.repository.listTopLevelTasks({
        companyId: scope.companyId,
        filters,
        after,
        limit: limit + 1,
      });
      const projected = rows.map(providerSafeTask);
      if (projected.some((row) => row.parentId !== null)) {
        throw new Error(
          "Context repository returned a non-top-level company task",
        );
      }
      return pageCursor(options.cursorSecret, key, projected, limit, taskPosition);
    },

    async listSubTasks(
      scope: ContextRetrievalScope,
      input: RetrievalPageRequest & { taskId?: string } = {},
    ): Promise<RetrievalPage<ContextRetrievalTaskProjection>> {
      const policy = resolveContextRetrievalPolicy(scope.dial);
      if (!policy.listSubTasks.enabled) throw new ContextRetrievalDenied();
      const taskIdProvided =
        typeof input.taskId === "string" && input.taskId.length > 0;
      const taskId = taskIdProvided ? input.taskId! : scope.activeTaskId;
      await assertReach(options.repository, scope, taskId, {
        active: taskIdProvided
          ? policy.listSubTasks.explicit.active
          : policy.listSubTasks.omittedActive,
        descendant:
          taskIdProvided && policy.listSubTasks.explicit.descendant,
        company: taskIdProvided && policy.listSubTasks.explicit.company,
      });
      const key = scopeKey(["list_sub_tasks", scope.companyId, taskId]);
      const after = decodeRetrievalCursor(
        options.cursorSecret,
        input.cursor,
        key,
      );
      const limit = boundedLimit(input.limit);
      const rows = await options.repository.listDirectChildren({
        companyId: scope.companyId,
        taskId,
        after,
        limit: limit + 1,
      });
      const projected = rows.map(providerSafeTask);
      if (projected.some((row) => row.parentId !== taskId)) {
        throw new Error("Context repository returned a non-direct child");
      }
      return pageCursor(options.cursorSecret, key, projected, limit, taskPosition);
    },

    async readTaskComments(
      scope: ContextRetrievalScope,
      input: RetrievalPageRequest & { taskId?: string } = {},
    ): Promise<RetrievalPage<ContextRetrievalCommentProjection>> {
      const policy = resolveContextRetrievalPolicy(scope.dial);
      if (!policy.comments.enabled) throw new ContextRetrievalDenied();
      const taskIdProvided =
        typeof input.taskId === "string" && input.taskId.length > 0;
      if (policy.comments.taskIdRequired && !taskIdProvided) {
        throw new ContextRetrievalDenied();
      }
      const taskId = taskIdProvided ? input.taskId! : scope.activeTaskId;
      await assertReach(options.repository, scope, taskId, {
        active: policy.comments.active,
        descendant: policy.comments.descendant,
        company: policy.comments.company,
      });
      const key = scopeKey(["read_task_comments", scope.companyId, taskId]);
      const after = decodeRetrievalCursor(
        options.cursorSecret,
        input.cursor,
        key,
      );
      const limit = boundedLimit(input.limit);
      const rows = await options.repository.listTaskComments({
        companyId: scope.companyId,
        taskId,
        after,
        limit: limit + 1,
      });
      const projected = rows.map(providerSafeComment);
      if (projected.some((row) => row.taskId !== taskId)) {
        throw new Error("Context repository returned a cross-task comment");
      }
      for (let index = 1; index < projected.length; index += 1) {
        if (projected[index - 1].sequence >= projected[index].sequence) {
          throw new Error(
            "Context repository returned non-chronological comments",
          );
        }
      }
      return pageCursor(
        options.cursorSecret,
        key,
        projected,
        limit,
        commentPosition,
      );
    },

    async readTaskAgentRun(
      scope: ContextRetrievalScope,
      input: { runId: string; cursor?: string | null },
    ): Promise<ProviderSafeRunTrace> {
      if (!input.runId) throw new ContextRetrievalDenied();
      const policy = resolveContextRetrievalPolicy(scope.dial);
      if (!policy.runs.enabled) throw new ContextRetrievalDenied();
      const run = await options.repository.runTask({
        companyId: scope.companyId,
        runId: input.runId,
      });
      if (!run) throw new ContextRetrievalDenied();
      await assertReach(options.repository, scope, run.taskId, {
        active: policy.runs.active,
        descendant: policy.runs.descendant,
        company: policy.runs.company,
      });
      return readCanonicalAgentRunTrace({
        companyId: scope.companyId,
        runId: input.runId,
        cursor: input.cursor,
      });
    },
  };
}

export type ContextRetrievalService = ReturnType<
  typeof createContextRetrievalService
>;
