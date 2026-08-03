import { createHmac, timingSafeEqual } from "node:crypto";
import {
  decodeIssueDisposition,
  decodeSystemCreatorSourceKind,
  type AgentVisibleIssueStatus,
  type AcpCostUnavailableReason,
  type BudgetCurrency,
  type IssueExecutionRunKind,
  type MoneyAmount,
  type ProviderSafeIssueCreator,
  type ProviderSafeIssueOwner,
  type ProviderSafeIssueProjection,
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
import {
  IssueSessionInvalidCursor,
  type IssueSessionReadProjection,
} from "./issue-session/store.js";

export const CONTEXT_RETRIEVAL_DEFAULT_PAGE_SIZE = 25;
export const CONTEXT_RETRIEVAL_MAX_PAGE_SIZE = 100;

/**
 * Immutable creator attribution that is safe to expose through a compiled
 * provider interface. The canonical creator record contains authority,
 * adapter-revision, callback, and other control-plane identifiers; none of
 * those are retrieval content.
 */
export type {
  ProviderSafeIssueCreator,
  ProviderSafeIssueOwner,
} from "@paperclipai/shared";

export type ProviderSafeCommentAuthor =
  | { kind: "agent"; agentId: string }
  | { kind: "user"; userId: string }
  | { kind: "plugin"; pluginKey: string }
  | { kind: "system" };

export type ContextRetrievalIssueProjection =
  ProviderSafeIssueProjection;

export interface ContextRetrievalCommentProjection {
  id: string;
  issueId: string;
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
    | "issue_update";
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
  runKind: IssueExecutionRunKind;
  issueId: string;
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

export interface RetrievalIssueFilters {
  status?: AgentVisibleIssueStatus;
  priority?: ContextRetrievalIssueProjection["priority"];
}

export interface RetrievalPageRequest {
  cursor?: string | null;
  limit?: number;
}

export interface IssueReach {
  sameCompany: boolean;
  active: boolean;
  descendant: boolean;
}

export interface ContextRetrievalRepository {
  issueReach(input: {
    companyId: string;
    activeIssueId: string;
    issueId: string;
  }): Promise<IssueReach | null>;
  listTopLevelIssues(input: {
    companyId: string;
    filters: RetrievalIssueFilters;
    after: RetrievalCursorPosition | null;
    limit: number;
  }): Promise<ContextRetrievalIssueProjection[]>;
  listDirectChildren(input: {
    companyId: string;
    issueId: string;
    after: RetrievalCursorPosition | null;
    limit: number;
  }): Promise<ContextRetrievalIssueProjection[]>;
  listIssueComments(input: {
    companyId: string;
    issueId: string;
    after: RetrievalCursorPosition | null;
    limit: number;
  }): Promise<ContextRetrievalCommentProjection[]>;
  runIssue(input: {
    companyId: string;
    runId: string;
  }): Promise<{ issueId: string } | null>;
  readCanonicalRunTrace(input: {
    companyId: string;
    runId: string;
    projection: Extract<
      IssueSessionReadProjection,
      "run-trace" | "audit" | "export"
    >;
    cursor?: string | null;
    limit?: number;
  }): Promise<CanonicalRunTrace | null>;
}

export interface ContextRetrievalScope {
  companyId: string;
  activeIssueId: string;
  dial: ContextDial;
}

export interface ContextRetrievalServiceOptions {
  cursorSecret: string;
  repository: ContextRetrievalRepository;
}

export class ContextRetrievalDenied extends Error {
  readonly code = "context_retrieval_denied";

  constructor(message = "Issue is outside the effective context tier") {
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

function issuePosition(
  issue: ContextRetrievalIssueProjection,
): RetrievalCursorPosition {
  return { sortValue: issue.updatedAt, id: issue.id };
}

function commentPosition(
  comment: ContextRetrievalCommentProjection,
): RetrievalCursorPosition {
  return { sortValue: String(comment.sequence).padStart(20, "0"), id: comment.id };
}

function assertIssueProjection(issue: ContextRetrievalIssueProjection): void {
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
  const actual = Object.keys(issue).sort();
  if (actual.join("\n") !== [...exactKeys].sort().join("\n")) {
    throw new Error(
      `Context repository returned a non-canonical issue projection: ${actual.join(", ")}`,
    );
  }
}

function assertCommentProjection(comment: ContextRetrievalCommentProjection): void {
  const exactKeys = [
    "id",
    "issueId",
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

function providerSafeCreator(value: unknown): ProviderSafeIssueCreator {
  const creator = asRecord(value, "Context issue creator");
  switch (creator.kind) {
    case "agent-execution":
      return {
        kind: "agent-execution",
        agentId: requiredString(creator.agentId, "Context issue creator.agentId"),
      };
    case "user/board":
      return {
        kind: "user/board",
        userId: nullableString(creator.userId, "Context issue creator.userId"),
      };
    case "plugin":
      return {
        kind: "plugin",
        pluginKey: requiredString(creator.pluginKey, "Context issue creator.pluginKey"),
      };
    case "routine":
      return {
        kind: "routine",
        routineId: requiredString(creator.routineId, "Context issue creator.routineId"),
      };
    case "system":
      return {
        kind: "system",
        sourceKind: decodeSystemCreatorSourceKind(creator.sourceKind),
      };
    default:
      throw new Error("Context issue creator has an unsupported kind");
  }
}

function providerSafeOwner(value: unknown): ProviderSafeIssueOwner {
  const owner = asRecord(value, "Context issue owner");
  switch (owner.kind) {
    case "agent":
      return {
        kind: "agent",
        agentId: requiredString(owner.agentId, "Context issue owner.agentId"),
      };
    case "user":
      return {
        kind: "user",
        userId: requiredString(owner.userId, "Context issue owner.userId"),
      };
    case "board":
      return { kind: "board" };
    default:
      throw new Error("Context issue owner has an unsupported kind");
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

function providerSafeIssue(
  issue: ContextRetrievalIssueProjection,
): ContextRetrievalIssueProjection {
  assertIssueProjection(issue);
  if (
    issue.status !== "open" &&
    issue.status !== "blocked" &&
    issue.status !== "done" &&
    issue.status !== "cancelled"
  ) {
    throw new Error("Context issue projection has an unsupported status");
  }
  if (
    issue.priority !== "critical" &&
    issue.priority !== "high" &&
    issue.priority !== "medium" &&
    issue.priority !== "low"
  ) {
    throw new Error("Context issue projection has an unsupported priority");
  }
  if (
    !Number.isSafeInteger(issue.directChildCount) ||
    issue.directChildCount < 0
  ) {
    throw new Error("Context issue projection has an invalid direct-child count");
  }
  return {
    id: requiredString(issue.id, "Context issue id"),
    identifier: nullableString(issue.identifier, "Context issue identifier"),
    title: nullableString(issue.title, "Context issue title"),
    request: requiredString(issue.request, "Context issue request"),
    status: issue.status,
    disposition:
      issue.disposition === null
        ? null
        : decodeIssueDisposition(issue.disposition),
    priority: issue.priority,
    creator: providerSafeCreator(issue.creator),
    owner: providerSafeOwner(issue.owner),
    parentId: nullableString(issue.parentId, "Context issue parentId"),
    directChildCount: issue.directChildCount,
    updatedAt: requiredString(issue.updatedAt, "Context issue updatedAt"),
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
    issueId: requiredString(comment.issueId, "Context comment issueId"),
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
  issueId: string,
  allowed: {
    active: boolean;
    descendant: boolean;
    company: boolean;
  },
): Promise<void> {
  const reach = await repository.issueReach({
    companyId: scope.companyId,
    activeIssueId: scope.activeIssueId,
    issueId,
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

  return {
    async listCompanyIssues(
      scope: ContextRetrievalScope,
      input: RetrievalPageRequest & { filters?: RetrievalIssueFilters } = {},
    ): Promise<RetrievalPage<ContextRetrievalIssueProjection>> {
      const policy = resolveContextRetrievalPolicy(scope.dial);
      if (!policy.listCompanyIssues) throw new ContextRetrievalDenied();
      const filters = input.filters ?? {};
      const key = scopeKey([
        "list_company_issues",
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
      const rows = await options.repository.listTopLevelIssues({
        companyId: scope.companyId,
        filters,
        after,
        limit: limit + 1,
      });
      const projected = rows.map(providerSafeIssue);
      if (projected.some((row) => row.parentId !== null)) {
        throw new Error(
          "Context repository returned a non-top-level company issue",
        );
      }
      return pageCursor(options.cursorSecret, key, projected, limit, issuePosition);
    },

    async listSubIssues(
      scope: ContextRetrievalScope,
      input: RetrievalPageRequest & { issueId?: string } = {},
    ): Promise<RetrievalPage<ContextRetrievalIssueProjection>> {
      const policy = resolveContextRetrievalPolicy(scope.dial);
      if (!policy.listSubIssues.enabled) throw new ContextRetrievalDenied();
      const issueIdProvided =
        typeof input.issueId === "string" && input.issueId.length > 0;
      const issueId = issueIdProvided ? input.issueId! : scope.activeIssueId;
      await assertReach(options.repository, scope, issueId, {
        active: issueIdProvided
          ? policy.listSubIssues.explicit.active
          : policy.listSubIssues.omittedActive,
        descendant:
          issueIdProvided && policy.listSubIssues.explicit.descendant,
        company: issueIdProvided && policy.listSubIssues.explicit.company,
      });
      const key = scopeKey(["list_sub_issues", scope.companyId, issueId]);
      const after = decodeRetrievalCursor(
        options.cursorSecret,
        input.cursor,
        key,
      );
      const limit = boundedLimit(input.limit);
      const rows = await options.repository.listDirectChildren({
        companyId: scope.companyId,
        issueId,
        after,
        limit: limit + 1,
      });
      const projected = rows.map(providerSafeIssue);
      if (projected.some((row) => row.parentId !== issueId)) {
        throw new Error("Context repository returned a non-direct child");
      }
      return pageCursor(options.cursorSecret, key, projected, limit, issuePosition);
    },

    async readIssueComments(
      scope: ContextRetrievalScope,
      input: RetrievalPageRequest & { issueId?: string } = {},
    ): Promise<RetrievalPage<ContextRetrievalCommentProjection>> {
      const policy = resolveContextRetrievalPolicy(scope.dial);
      if (!policy.comments.enabled) throw new ContextRetrievalDenied();
      const issueIdProvided =
        typeof input.issueId === "string" && input.issueId.length > 0;
      if (policy.comments.issueIdRequired && !issueIdProvided) {
        throw new ContextRetrievalDenied();
      }
      const issueId = issueIdProvided ? input.issueId! : scope.activeIssueId;
      await assertReach(options.repository, scope, issueId, {
        active: policy.comments.active,
        descendant: policy.comments.descendant,
        company: policy.comments.company,
      });
      const key = scopeKey(["read_issue_comments", scope.companyId, issueId]);
      const after = decodeRetrievalCursor(
        options.cursorSecret,
        input.cursor,
        key,
      );
      const limit = boundedLimit(input.limit);
      const rows = await options.repository.listIssueComments({
        companyId: scope.companyId,
        issueId,
        after,
        limit: limit + 1,
      });
      const projected = rows.map(providerSafeComment);
      if (projected.some((row) => row.issueId !== issueId)) {
        throw new Error("Context repository returned a cross-issue comment");
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

    async readIssueAgentRun(
      scope: ContextRetrievalScope,
      input: { runId: string; cursor?: string | null },
    ): Promise<ProviderSafeRunTrace> {
      if (!input.runId) throw new ContextRetrievalDenied();
      const policy = resolveContextRetrievalPolicy(scope.dial);
      if (!policy.runs.enabled) throw new ContextRetrievalDenied();
      const run = await options.repository.runIssue({
        companyId: scope.companyId,
        runId: input.runId,
      });
      if (!run) throw new ContextRetrievalDenied();
      await assertReach(options.repository, scope, run.issueId, {
        active: policy.runs.active,
        descendant: policy.runs.descendant,
        company: policy.runs.company,
      });
      let trace: CanonicalRunTrace | null;
      try {
        trace = await options.repository.readCanonicalRunTrace({
          companyId: scope.companyId,
          runId: input.runId,
          projection: "run-trace",
          cursor: input.cursor,
        });
      } catch (error) {
        if (error instanceof IssueSessionInvalidCursor) {
          throw new ContextRetrievalInvalidCursor(error.message);
        }
        throw error;
      }
      if (!trace || trace.issueId !== run.issueId) {
        throw new ContextRetrievalDenied();
      }
      return providerSafeRunTrace(trace);
    },
  };
}

export type ContextRetrievalService = ReturnType<
  typeof createContextRetrievalService
>;
