import type {
  AcpCostUnavailableReason,
  AgentVisibleTaskStatus,
  BudgetCurrency,
  MoneyAmount,
  ProviderSafeTaskProjection,
  TaskExecutionRunKind,
} from "@paperclipai/shared";
import { type ContextDial } from "./context-dial-resolver.js";

export const CONTEXT_RETRIEVAL_DEFAULT_PAGE_SIZE = 25;

export const CONTEXT_RETRIEVAL_MAX_PAGE_SIZE = 100;

export type ProviderSafeCommentAuthor =
  | { kind: "agent"; agentId: string }
  | { kind: "user"; userId: string }
  | { kind: "plugin"; pluginKey: string }
  | { kind: "system" };

export type ContextRetrievalTaskProjection = ProviderSafeTaskProjection;

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
  kind: "agent-switched" | "model-switched" | "user" | "synthetic" | "system" | "shell" | "assistant";
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
  sourceKind: "run_output" | "run_progress" | "task_update";
  projectedEventSeq: number;
}

/** Latest protocol-settled prompt accounting for one run; never a raw usage envelope. */
export interface CanonicalRunTraceAccounting {
  contextUsedTokens: number;
  contextWindowTokens: number;
  budgetCurrency: BudgetCurrency;
  cost:
    | { kind: "known"; knownDeltaAmount: MoneyAmount }
    | {
        kind: "unavailable";
        unavailableReason: AcpCostUnavailableReason;
      };
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
  taskReach(input: { companyId: string; activeTaskId: string; taskId: string }): Promise<TaskReach | null>;
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
  runTask(input: { companyId: string; runId: string }): Promise<{ taskId: string } | null>;
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

export interface RetrievalCursorEnvelope {
  v: 1;
  scope: string;
  position: RetrievalCursorPosition;
}
