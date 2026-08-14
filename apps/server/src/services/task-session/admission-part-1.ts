import {
  taskComments,
  taskExecutionHistoryViews,
  taskExecutionRefs,
  taskSessionEvents,
  taskSessionInputs,
} from "@paperclipai/db";
import type { TaskExecutionRefMode, TaskExecutionRefSourceKind } from "@paperclipai/shared";
import { createHash } from "node:crypto";
import { type TaskSessionDbTransaction } from "./event-store.js";
import {
  canonicalTaskSessionJson,
  type TaskSessionCommentAuthor,
  type TaskSessionSourceClaim,
} from "./store.js";

export interface DispatchExecutionScope {
  companyId: string;
  taskId: string;
  sessionId: string;
  ownershipEpoch: number;
  targetAgentId: string;
  taskExecutionAuthorityId: string | null;
  consultExecutionId: string | null;
  adapterConfigRevisionId: string;
  contextEpoch: number;
  mode: TaskExecutionRefMode;
  executionScopeId?: string;
  executionLineageId?: string;
  counterpartTaskId?: string | null;
  counterpartAuthorityId?: string | null;
  counterpartOwnershipEpoch?: number | null;
  consultCallerRefId?: string | null;
  consultChainToken?: string | null;
}

export interface TaskSessionSourceIdentity {
  sourceKind: TaskExecutionRefSourceKind | string;
  immutableSourceKey: string;
  sourceRecordId: string;
  exactText: string;
}

/**
 * Immutable actor provenance for one canonical execution source. The actor is
 * deliberately part of the source identity instead of being inferred from a
 * projected comment: a harness delivery may have no comment, and comment
 * attribution is not execution authority.
 */
export type TaskSessionExecutionActor =
  | {
      kind: "user/board";
      userId: string;
    }
  | {
      kind: "agent-execution";
      agentId: string;
      authorityId: string;
    }
  | {
      kind: "plugin";
      pluginInstallationId: string;
      pluginKey: string;
    }
  | {
      kind: "routine";
      routineId: string;
      routineDispatchId: string;
    }
  | {
      kind: "system";
      sourceKind: string;
      sourceId: string;
    };

export type UserOrBoardExecutionActor = Extract<TaskSessionExecutionActor, { kind: "user/board" }>;

export type AgentExecutionActor = Extract<TaskSessionExecutionActor, { kind: "agent-execution" }>;

export type PluginExecutionActor = Extract<TaskSessionExecutionActor, { kind: "plugin" }>;

export type RoutineExecutionActor = Extract<TaskSessionExecutionActor, { kind: "routine" }>;

export type SystemExecutionActor = Extract<TaskSessionExecutionActor, { kind: "system" }>;

/**
 * Closed source/actor contract for every Session source that can cause
 * provider work. Source kind and immutable actor provenance determine its
 * ordinary V2 message kind; the admission service alone recognizes the exact
 * initial-request pair and lowers its instruction member as synthetic.
 */
export type TaskSessionExecutionSource =
  | {
      sourceKind: "task_request";
      actor: TaskSessionExecutionActor;
    }
  | {
      sourceKind: "task_reassignment";
      actor: UserOrBoardExecutionActor | AgentExecutionActor | PluginExecutionActor;
    }
  | {
      sourceKind: "task_reopen" | "human_comment_mention";
      actor: UserOrBoardExecutionActor;
    }
  | {
      sourceKind: "routine_dispatch";
      actor: RoutineExecutionActor;
    }
  | {
      sourceKind: "task_update";
      actor: TaskSessionExecutionActor;
    }
  | {
      sourceKind: "consult_mention";
      actor: AgentExecutionActor;
    }
  | {
      sourceKind: "system_nudge";
      actor: SystemExecutionActor;
    }
  | {
      sourceKind: "human_comment";
      actor: UserOrBoardExecutionActor;
    };

export type TaskSessionAgentCommentAuthor = Extract<TaskSessionCommentAuthor, { kind: "agent" }>;

export type TaskSessionNonAgentCommentAuthor = Exclude<TaskSessionCommentAuthor, { kind: "agent" }>;

/**
 * Immutable provenance for a projected comment. The producing run is
 * deliberately separate from DispatchExecutionScope: a parent/creator run
 * may author a comment whose new execution ref targets a different agent.
 */
export type TaskSessionProjectedCommentSource = (
  | {
      author: TaskSessionAgentCommentAuthor;
      producingRun: {
        runId: string;
        adapterConfigRevisionId: string;
      };
    }
  | {
      author: TaskSessionNonAgentCommentAuthor;
      producingRun: null;
    }
) & {
  /** The only reply field accepted from an admission caller. */
  replyToCommentId?: string | null;
  /** Internal attribution for a response produced by positive steering. */
  steeringSegment?: {
    steeringTargetRunId: string;
    refId: string;
    refOrdinal: number;
    segmentOrdinal: number;
  } | null;
};

export type DispatchingExecutionSourceBase = DispatchExecutionScope &
  TaskSessionSourceIdentity & {
    comment: TaskSessionProjectedCommentSource | null;
    idempotencyKey: string;
  };

/**
 * Reassignment is the sole ref source with an outgoing ownership epoch. The
 * discriminated input keeps that provenance mandatory at every producer and
 * unrepresentable on every other dispatching user source.
 */
export type DispatchingExecutionSourceInput =
  | (DispatchingExecutionSourceBase &
      Extract<TaskSessionExecutionSource, { sourceKind: "task_reassignment" }> & {
        sourceKind: "task_reassignment";
        previousOwnershipEpoch: number;
      })
  | (DispatchingExecutionSourceBase &
      Exclude<
        TaskSessionExecutionSource,
        { sourceKind: "task_reassignment" } | { sourceKind: "human_comment" }
      > & {
        previousOwnershipEpoch?: never;
      });

export interface DispatchingExecutionSourceBatch {
  /**
   * Stable identity for one already-committed counterpart execution batch.
   * Every event remains an independent canonical source/ref; this key only
   * gives those refs one execution scope and lineage.
   */
  batchKey: string;
  sources: readonly [DispatchingExecutionSourceInput, DispatchingExecutionSourceInput];
}

export interface NonDispatchUserComment extends TaskSessionSourceIdentity {
  companyId: string;
  taskId: string;
  sessionId: string;
  sourceKind: string;
  delivery?: "queue";
  comment: {
    author: Extract<TaskSessionCommentAuthor, { kind: "user" }>;
    producingRun: null;
    replyToCommentId?: string | null;
    steeringSegment?: null;
  };
}

/**
 * Human-authored input admitted for one already-selected active run. It owns
 * a canonical Session inbox row and comment but deliberately creates no
 * TaskExecutionRef: the run service binds that input to one positive prompt
 * segment in the same transaction.
 */
export type SteeringComment = TaskSessionSourceIdentity & {
  companyId: string;
  taskId: string;
  sessionId: string;
} & Extract<TaskSessionExecutionSource, { sourceKind: "human_comment" }> & {
    sourceKind: "human_comment";
    comment: {
      author: Extract<TaskSessionCommentAuthor, { kind: "user" }>;
      producingRun: null;
      replyToCommentId?: string | null;
      steeringSegment?: null;
    };
  };

export interface NonDispatchControlNotice extends TaskSessionSourceIdentity {
  companyId: string;
  taskId: string;
  sessionId: string;
  sourceKind: string;
  actor?: TaskSessionExecutionActor;
  counterpartTaskId?: string | null;
  counterpartAuthorityId?: string | null;
  counterpartOwnershipEpoch?: number | null;
  comment: TaskSessionProjectedCommentSource | null;
  allowTerminal?: boolean;
}

export interface NonDispatchSyntheticComment extends TaskSessionSourceIdentity {
  companyId: string;
  taskId: string;
  sessionId: string;
  sourceKind: string;
  projectionKind?: "task_update" | "harness_delivery" | "run_progress";
  ownershipEpoch: number;
  agentId: string;
  adapterConfigRevisionId: string;
  runId: string;
  actor?: TaskSessionExecutionActor;
  counterpartTaskId?: string | null;
  counterpartAuthorityId?: string | null;
  counterpartOwnershipEpoch?: number | null;
  comment: Extract<TaskSessionProjectedCommentSource, { author: TaskSessionAgentCommentAuthor }>;
}

export type EventRow = typeof taskSessionEvents.$inferSelect;

export type RefRow = typeof taskExecutionRefs.$inferSelect;

export type InputRow = typeof taskSessionInputs.$inferSelect;

export type ViewRow = typeof taskExecutionHistoryViews.$inferSelect;

export type CommentRow = typeof taskComments.$inferSelect;

export interface TaskSessionAdmissionResult {
  source: TaskSessionSourceClaim;
  ref: RefRow | null;
  input: InputRow | null;
  view: ViewRow | null;
  comment: CommentRow | null;
  event: EventRow;
  eventSeq: number;
  retried: boolean;
}

export interface TaskSessionAdmissionHooks {
  /**
   * Source tables are heterogeneous. A producer can require its immutable
   * causal row to be locked and checked here; admission has already locked
   * company/task/Session and will fail the whole admission on rejection.
   */
  assertImmutableSource?(
    transaction: TaskSessionDbTransaction,
    input:
      | DispatchingExecutionSourceInput
      | SteeringComment
      | NonDispatchUserComment
      | NonDispatchControlNotice
      | NonDispatchSyntheticComment,
  ): Promise<void>;
}

export interface TaskSessionAdmissionService {
  admitExecutionSource(
    input: DispatchingExecutionSourceInput,
    transaction?: TaskSessionDbTransaction,
  ): Promise<TaskSessionAdmissionResult>;
  admitExecutionSourceBatch(
    input: DispatchingExecutionSourceBatch,
    transaction?: TaskSessionDbTransaction,
  ): Promise<TaskSessionAdmissionResult[]>;
  appendNonDispatchUserComment(
    input: NonDispatchUserComment,
    transaction?: TaskSessionDbTransaction,
  ): Promise<TaskSessionAdmissionResult>;
  admitSteeringComment(
    input: SteeringComment,
    transaction?: TaskSessionDbTransaction,
  ): Promise<TaskSessionAdmissionResult>;
  appendNonDispatchControlNotice(
    input: NonDispatchControlNotice,
    transaction?: TaskSessionDbTransaction,
  ): Promise<TaskSessionAdmissionResult>;
  appendNonDispatchSyntheticComment(
    input: NonDispatchSyntheticComment,
    transaction?: TaskSessionDbTransaction,
  ): Promise<TaskSessionAdmissionResult>;
}

export interface StableIdentity {
  sourceId: string;
  eventId: string;
  messageId: string;
  refId: string;
  historyViewId: string;
  commentId: string;
  dispositionId: string;
  executionScopeId: string;
  executionLineageId: string;
}

export interface ValidatedDispatchScope {
  contextEpochBaselineSeq: number;
}

export function canonicalJson(value: unknown): string {
  return canonicalTaskSessionJson(value);
}

export function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export { deterministicUuid } from "../deterministic-uuid.js";
