import { createHash } from "node:crypto";
import {
  agentAdapterConfigRevisions,
  agents,
  companies,
  executionWorkspaces,
  taskComments,
  taskConsultExecutions,
  taskExecutionAuthorities,
  taskExecutionHistoryViews,
  taskExecutionLanes,
  taskExecutionRefs,
  taskExecutionWorkspaceBindings,
  tasks,
  taskSessionContextEpochs,
  taskSessionEvents,
  taskSessionInputs,
  taskSessions,
  type Db,
} from "@paperclipai/db";
import * as TaskSession from "@paperclipai/shared/task-session";
import type {
  TaskExecutionRefMode,
  TaskExecutionRefSourceKind,
} from "@paperclipai/shared";
import {
  encodeTaskSessionEvent,
  type TaskSessionEventType,
} from "@paperclipai/shared/task-session";
import {
  and,
  eq,
  lt,
  sql,
} from "drizzle-orm";
import { evaluateAgentInvokability } from "../agent-invokability.js";
import { readTaskExecutionRun } from "../task-execution-run-service.js";
import { classifyOrderedExecutionScopePair } from "../task-execution-initial-request-pair.js";
import type { TaskSessionCommentProjectionInput } from "./projector.js";
import {
  canonicalTaskSessionJson,
  TaskSessionInvariantError,
  TaskSessionLifecycleConflict,
  type TaskSessionCommentAuthor,
  type TaskSessionSourceClaim,
} from "./store.js";
import {
  decodeStoredTaskSessionEvent,
  reserveTaskSessionEventSequence,
  reserveTaskSessionMessageId,
  type TaskSessionDbTransaction,
} from "./event-store.js";
import {
  publishTaskSessionEventInTx,
  type PublishTaskSessionEventInput,
} from "./publication.js";

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

type UserOrBoardExecutionActor = Extract<
  TaskSessionExecutionActor,
  { kind: "user/board" }
>;
type AgentExecutionActor = Extract<
  TaskSessionExecutionActor,
  { kind: "agent-execution" }
>;
type PluginExecutionActor = Extract<
  TaskSessionExecutionActor,
  { kind: "plugin" }
>;
type RoutineExecutionActor = Extract<
  TaskSessionExecutionActor,
  { kind: "routine" }
>;
type SystemExecutionActor = Extract<
  TaskSessionExecutionActor,
  { kind: "system" }
>;

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
      actor:
        | UserOrBoardExecutionActor
        | AgentExecutionActor
        | PluginExecutionActor;
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

type TaskSessionAgentCommentAuthor = Extract<
  TaskSessionCommentAuthor,
  { kind: "agent" }
>;
type TaskSessionNonAgentCommentAuthor = Exclude<
  TaskSessionCommentAuthor,
  { kind: "agent" }
>;

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
    }) & {
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

type DispatchingExecutionSourceBase = DispatchExecutionScope &
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
        | { sourceKind: "task_reassignment" }
        | { sourceKind: "human_comment" }
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
  sources: readonly [
    DispatchingExecutionSourceInput,
    DispatchingExecutionSourceInput,
  ];
}

export interface NonDispatchUserComment
  extends TaskSessionSourceIdentity {
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
} & Extract<
  TaskSessionExecutionSource,
  { sourceKind: "human_comment" }
> & {
  sourceKind: "human_comment";
  comment: {
    author: Extract<TaskSessionCommentAuthor, { kind: "user" }>;
    producingRun: null;
    replyToCommentId?: string | null;
    steeringSegment?: null;
  };
};

export interface NonDispatchControlNotice
  extends TaskSessionSourceIdentity {
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

export interface NonDispatchSyntheticComment
  extends TaskSessionSourceIdentity {
  companyId: string;
  taskId: string;
  sessionId: string;
  sourceKind: string;
  projectionKind?:
    | "task_update"
    | "harness_delivery"
    | "run_progress";
  ownershipEpoch: number;
  agentId: string;
  adapterConfigRevisionId: string;
  runId: string;
  actor?: TaskSessionExecutionActor;
  counterpartTaskId?: string | null;
  counterpartAuthorityId?: string | null;
  counterpartOwnershipEpoch?: number | null;
  comment: Extract<
    TaskSessionProjectedCommentSource,
    { author: TaskSessionAgentCommentAuthor }
  >;
}

type EventRow = typeof taskSessionEvents.$inferSelect;
type RefRow = typeof taskExecutionRefs.$inferSelect;
type InputRow = typeof taskSessionInputs.$inferSelect;
type ViewRow = typeof taskExecutionHistoryViews.$inferSelect;
type CommentRow = typeof taskComments.$inferSelect;

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

interface StableIdentity {
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

interface ValidatedDispatchScope {
  contextEpochBaselineSeq: number;
}

function canonicalJson(value: unknown): string {
  return canonicalTaskSessionJson(value);
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function deterministicUuid(namespace: string, key: string): string {
  const bytes = Buffer.from(
    createHash("sha256").update(`${namespace}\0${key}`).digest("hex").slice(0, 32),
    "hex",
  );
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function stableIdentity(
  sessionId: string,
  sourceKind: string,
  immutableSourceKey: string,
): Omit<StableIdentity, "messageId"> {
  const key = `${sessionId}\0${sourceKind}\0${immutableSourceKey}`;
  const short = digest({ key }).slice(0, 40);
  return {
    sourceId: `src_${short}`,
    eventId: `evt_${short}`,
    refId: deterministicUuid("task-ref", key),
    historyViewId: deterministicUuid("history-view", key),
    commentId: deterministicUuid("task-comment", key),
    dispositionId: deterministicUuid("input-disposition", key),
    executionScopeId: deterministicUuid("execution-scope", key),
    executionLineageId: deterministicUuid("execution-lineage", key),
  };
}

function stableIdentityForSource(input: {
  sessionId: string;
  sourceKind: string;
  immutableSourceKey: string;
}): Omit<StableIdentity, "messageId"> {
  return stableIdentity(
    input.sessionId,
    input.sourceKind,
    input.immutableSourceKey,
  );
}

async function reserveStableMessageIdentity(
  transaction: TaskSessionDbTransaction,
  input: {
    companyId: string;
    taskId: string;
    sessionId: string;
    sourceKind: string;
    immutableSourceKey: string;
  },
  ids: Omit<StableIdentity, "messageId">,
): Promise<StableIdentity> {
  const messageId = await reserveTaskSessionMessageId(
    transaction,
    {
      companyId: input.companyId,
      taskId: input.taskId,
      sessionId: input.sessionId,
    },
    `admission:${input.sourceKind}:${digest({
      sessionId: input.sessionId,
      immutableSourceKey: input.immutableSourceKey,
    })}`,
  );
  return { ...ids, messageId };
}

function assertSourceIdentity(input: {
  sourceKind: string;
  immutableSourceKey: string;
  sourceRecordId: string;
  exactText: string;
}): void {
  if (
    input.sourceKind.length === 0 ||
    input.immutableSourceKey.length === 0 ||
    input.sourceRecordId.length === 0
  ) {
    throw new TaskSessionLifecycleConflict(
      "Canonical source identity fields must be non-empty",
      { sourceKind: input.sourceKind },
    );
  }
}

function assertNever(value: never, context: string): never {
  const runtimeValue = value as unknown;
  throw new TaskSessionLifecycleConflict(
    `Unclassified ${context} reached Task Session admission`,
    {
      value:
        runtimeValue && typeof runtimeValue === "object"
          ? runtimeValue as Record<string, unknown>
          : runtimeValue,
    },
  );
}

function assertNonEmptyExecutionActorField(
  actorKind: string,
  field: string,
  value: unknown,
): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TaskSessionLifecycleConflict(
      `Execution source actor ${actorKind} requires immutable ${field}`,
      { actorKind, field },
    );
  }
}

function assertExecutionActor(
  actor: TaskSessionExecutionActor,
): void {
  if (!actor || typeof actor !== "object" || Array.isArray(actor)) {
    throw new TaskSessionLifecycleConflict(
      "Execution source requires immutable actor provenance",
    );
  }
  switch (actor.kind) {
    case "user/board":
      assertNonEmptyExecutionActorField(actor.kind, "userId", actor.userId);
      return;
    case "agent-execution":
      assertNonEmptyExecutionActorField(actor.kind, "agentId", actor.agentId);
      assertNonEmptyExecutionActorField(
        actor.kind,
        "authorityId",
        actor.authorityId,
      );
      return;
    case "plugin":
      assertNonEmptyExecutionActorField(
        actor.kind,
        "pluginInstallationId",
        actor.pluginInstallationId,
      );
      assertNonEmptyExecutionActorField(
        actor.kind,
        "pluginKey",
        actor.pluginKey,
      );
      return;
    case "routine":
      assertNonEmptyExecutionActorField(
        actor.kind,
        "routineId",
        actor.routineId,
      );
      assertNonEmptyExecutionActorField(
        actor.kind,
        "routineDispatchId",
        actor.routineDispatchId,
      );
      return;
    case "system":
      assertNonEmptyExecutionActorField(
        actor.kind,
        "sourceKind",
        actor.sourceKind,
      );
      assertNonEmptyExecutionActorField(
        actor.kind,
        "sourceId",
        actor.sourceId,
      );
      return;
    default:
      return assertNever(actor, "execution-source actor");
  }
}

function assertExecutionSourceActorPair(
  source: TaskSessionExecutionSource,
): void {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new TaskSessionLifecycleConflict(
      "Execution source must be a closed source/actor record",
    );
  }
  for (const producerOwnedKindField of [
    "eventKind",
    "messageKind",
    "delivery",
  ] as const) {
    if (Object.prototype.hasOwnProperty.call(source, producerOwnedKindField)) {
      throw new TaskSessionLifecycleConflict(
        "Execution source producers cannot override Session admission lowering",
        {
          sourceKind:
            typeof source.sourceKind === "string"
              ? source.sourceKind
              : null,
          producerOwnedKindField,
        },
      );
    }
  }
  assertExecutionActor(source.actor);
  switch (source.sourceKind) {
    case "task_update":
      return;
    case "task_request":
      return;
    case "task_reassignment":
      if (
        source.actor.kind === "user/board" ||
        source.actor.kind === "agent-execution" ||
        source.actor.kind === "plugin"
      ) {
        return;
      }
      break;
    case "task_reopen":
    case "human_comment_mention":
    case "human_comment":
      if (source.actor.kind === "user/board") return;
      break;
    case "routine_dispatch":
      if (source.actor.kind === "routine") return;
      break;
    case "consult_mention":
      if (source.actor.kind === "agent-execution") return;
      break;
    case "system_nudge":
      if (source.actor.kind === "system") return;
      break;
    default:
      return assertNever(source, "execution source");
  }
  throw new TaskSessionLifecycleConflict(
    "Execution source actor does not match its immutable source kind",
    {
      sourceKind: source.sourceKind,
      actorKind: source.actor.kind,
    },
  );
}

/**
 * Default lowering from immutable source provenance to the V2 Session kind.
 * Ordered pair admission lowers its first member separately.
 */
export function v2MessageKindForExecutionSource(
  source: TaskSessionExecutionSource,
): "user" | "synthetic" {
  assertExecutionSourceActorPair(source);
  switch (source.sourceKind) {
    case "task_reassignment":
    case "task_reopen":
    case "human_comment_mention":
    case "routine_dispatch":
    case "human_comment":
      return "user";
    case "task_request":
      return "user";
    case "task_update":
      return source.actor.kind === "user/board"
        ? "user"
        : "synthetic";
    case "consult_mention":
    case "system_nudge":
      return "synthetic";
    default:
      return assertNever(source, "execution source");
  }
}

function scopeDigest(
  input: DispatchExecutionScope & {
    readonly sourceKind: string;
    readonly previousOwnershipEpoch?: number | null;
  },
): Record<string, unknown> {
  return {
    companyId: input.companyId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    ownershipEpoch: input.ownershipEpoch,
    previousOwnershipEpoch: previousOwnershipEpochForDispatchSource(input),
    targetAgentId: input.targetAgentId,
    taskExecutionAuthorityId: input.taskExecutionAuthorityId,
    consultExecutionId: input.consultExecutionId,
    adapterConfigRevisionId: input.adapterConfigRevisionId,
    contextEpoch: input.contextEpoch,
    mode: input.mode,
    executionScopeId: input.executionScopeId ?? null,
    executionLineageId: input.executionLineageId ?? null,
    counterpartTaskId: input.counterpartTaskId ?? null,
    counterpartAuthorityId: input.counterpartAuthorityId ?? null,
    counterpartOwnershipEpoch: input.counterpartOwnershipEpoch ?? null,
    consultCallerRefId: input.consultCallerRefId ?? null,
    consultChainToken: input.consultChainToken ?? null,
  };
}

export function previousOwnershipEpochForDispatchSource(input: {
  readonly sourceKind?: string;
  readonly ownershipEpoch: number;
  readonly previousOwnershipEpoch?: number | null;
}): number | null {
  if (input.sourceKind === "task_reassignment") {
    if (
      !Number.isSafeInteger(input.previousOwnershipEpoch) ||
      input.previousOwnershipEpoch! < 1 ||
      input.previousOwnershipEpoch !== input.ownershipEpoch - 1
    ) {
      throw new TaskSessionLifecycleConflict(
        "Task reassignment must preserve the exact immediately previous ownership epoch",
        {
          ownershipEpoch: input.ownershipEpoch,
          previousOwnershipEpoch: input.previousOwnershipEpoch ?? null,
        },
      );
    }
    return input.previousOwnershipEpoch;
  }
  if (input.previousOwnershipEpoch != null) {
    throw new TaskSessionLifecycleConflict(
      "Only task reassignment may carry a previous ownership epoch",
      { sourceKind: input.sourceKind ?? null },
    );
  }
  return null;
}

function commentInsert(author: TaskSessionCommentAuthor, body: string) {
  if (author.kind === "agent") {
    return {
      body,
      authorType: "agent" as const,
      authorAgentId: author.agentId,
      authorUserId: null,
      authorPluginInstallationId: null,
      authorPluginKey: null,
    };
  }
  if (author.kind === "user") {
    return {
      body,
      authorType: "user" as const,
      authorAgentId: null,
      authorUserId: author.userId,
      authorPluginInstallationId: null,
      authorPluginKey: null,
    };
  }
  if (author.kind === "plugin") {
    return {
      body,
      authorType: "plugin" as const,
      authorAgentId: null,
      authorUserId: null,
      authorPluginInstallationId: author.pluginInstallationId,
      authorPluginKey: author.pluginKey,
    };
  }
  return {
    body,
    authorType: "system" as const,
    authorAgentId: null,
    authorUserId: null,
    authorPluginInstallationId: null,
    authorPluginKey: null,
  };
}

function userProjectionKind(
  sourceKind: string,
): TaskSessionCommentProjectionInput["sourceKind"] {
  return sourceKind === "human_comment_mention" ||
    sourceKind === "task_update"
    ? "human_comment"
    : "task_request";
}

function directProjectionKind(
  sourceKind: string,
): TaskSessionCommentProjectionInput["sourceKind"] {
  if (sourceKind === "task_update") return "task_update";
  return "harness_delivery";
}

type TaskCommentReplyProjection = Pick<
  TaskSessionCommentProjectionInput["comment"],
  | "replyToCommentId"
  | "replyToProjectedEventSeq"
  | "threadRootCommentId"
  | "threadRootProjectedEventSeq"
>;

const TOP_LEVEL_REPLY_PROJECTION: TaskCommentReplyProjection = {
  replyToCommentId: null,
  replyToProjectedEventSeq: null,
  threadRootCommentId: null,
  threadRootProjectedEventSeq: null,
};

export async function resolveTaskCommentReplyProjection(
  transaction: TaskSessionDbTransaction,
  scope: { companyId: string; taskId: string; sessionId: string },
  replyToCommentId: string | null | undefined,
): Promise<TaskCommentReplyProjection> {
  if (replyToCommentId == null) return TOP_LEVEL_REPLY_PROJECTION;
  const parents = await transaction
    .select({
      id: taskComments.id,
      projectedEventSeq: taskComments.projectedEventSeq,
      replyToCommentId: taskComments.replyToCommentId,
      replyToProjectedEventSeq: taskComments.replyToProjectedEventSeq,
      threadRootCommentId: taskComments.threadRootCommentId,
      threadRootProjectedEventSeq: taskComments.threadRootProjectedEventSeq,
    })
    .from(taskComments)
    .where(
      and(
        eq(taskComments.companyId, scope.companyId),
        eq(taskComments.taskId, scope.taskId),
        eq(taskComments.sessionId, scope.sessionId),
        eq(taskComments.id, replyToCommentId),
      ),
    )
    .limit(2)
    .for("update");
  const parent = parents.length === 1 ? parents[0]! : null;
  if (!parent) {
    throw new TaskSessionLifecycleConflict(
      "Reply parent is missing from the canonical task Session",
      { replyToCommentId },
    );
  }
  const parentIsTopLevel =
    parent.replyToCommentId === null &&
    parent.replyToProjectedEventSeq === null &&
    parent.threadRootCommentId === null &&
    parent.threadRootProjectedEventSeq === null;
  const parentIsNested =
    parent.replyToCommentId !== null &&
    parent.replyToProjectedEventSeq !== null &&
    parent.threadRootCommentId !== null &&
    parent.threadRootProjectedEventSeq !== null;
  if (!parentIsTopLevel && !parentIsNested) {
    throw new TaskSessionInvariantError(
      `Reply parent ${parent.id} has an invalid immutable thread tuple`,
    );
  }
  return {
    replyToCommentId: parent.id,
    replyToProjectedEventSeq: parent.projectedEventSeq,
    threadRootCommentId: parentIsTopLevel
      ? parent.id
      : parent.threadRootCommentId,
    threadRootProjectedEventSeq: parentIsTopLevel
      ? parent.projectedEventSeq
      : parent.threadRootProjectedEventSeq,
  };
}

function projectionInput(input: {
  phase: "admitted" | "promoted" | "direct";
  sourceKind: TaskSessionCommentProjectionInput["sourceKind"];
  sourceId: string;
  messageId: string;
  commentId: string;
  body: string;
  author: TaskSessionCommentAuthor;
  reply: TaskCommentReplyProjection;
  steeringSegment?: TaskSessionProjectedCommentSource["steeringSegment"];
}): TaskSessionCommentProjectionInput {
  return {
    phase: input.phase,
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
    messageId: input.messageId,
    ...(input.steeringSegment === undefined
      ? {}
      : { steeringSegment: input.steeringSegment }),
    comment: {
      id: input.commentId,
      ...commentInsert(input.author, input.body),
      ...input.reply,
      ...(input.sourceKind === "run_progress"
        ? {
            presentation: {
              kind: "run_progress" as const,
              tone: "neutral" as const,
              detailsDefaultOpen: false,
            },
          }
        : {}),
    },
  };
}

function assertProjectedCommentSourceShape(
  comment: TaskSessionProjectedCommentSource,
): void {
  const hasProducingRun =
    comment.producingRun !== null &&
    typeof comment.producingRun.runId === "string" &&
    comment.producingRun.runId.length > 0 &&
    typeof comment.producingRun.adapterConfigRevisionId === "string" &&
    comment.producingRun.adapterConfigRevisionId.length > 0;
  if ((comment.author.kind === "agent") !== hasProducingRun) {
    throw new TaskSessionLifecycleConflict(
      "Agent comments require their producing run and non-agent comments must be runless",
      { authorKind: comment.author.kind },
    );
  }
}

function assertExecutionSourceCommentProvenance(
  input: DispatchingExecutionSourceInput | SteeringComment,
  messageKind = v2MessageKindForExecutionSource(input),
): void {
  if (!input.comment) {
    if (messageKind === "user") {
      throw new TaskSessionLifecycleConflict(
        "User execution sources require their immutable projected author",
        { sourceKind: input.sourceKind },
      );
    }
    return;
  }
  assertProjectedCommentSourceShape(input.comment);
  const author = input.comment.author;
  const actor = input.actor;
  const matches = (() => {
    switch (actor.kind) {
      case "user/board":
        return author.kind === "user" && author.userId === actor.userId;
      case "agent-execution":
        return author.kind === "agent" && author.agentId === actor.agentId;
      case "plugin":
        return (
          author.kind === "plugin" &&
          author.pluginInstallationId === actor.pluginInstallationId &&
          author.pluginKey === actor.pluginKey
        );
      case "routine":
      case "system":
        return author.kind === "system";
      default:
        return assertNever(actor, "execution-source actor");
    }
  })();
  if (!matches) {
    throw new TaskSessionLifecycleConflict(
      "Execution source projected author does not match immutable actor provenance",
      {
        sourceKind: input.sourceKind,
        actorKind: actor.kind,
        authorKind: author.kind,
      },
    );
  }
}

function assertDispatchingExecutionSource(
  input: DispatchingExecutionSourceInput,
  messageKind = v2MessageKindForExecutionSource(input),
): "user" | "synthetic" {
  assertSourceIdentity(input);
  assertExecutionSourceCommentProvenance(input, messageKind);
  previousOwnershipEpochForDispatchSource(input);
  return messageKind;
}

type GroupedDispatchingExecutionSourceInput =
  DispatchingExecutionSourceInput &
  Required<Pick<
    DispatchExecutionScope,
    "executionScopeId" | "executionLineageId"
  >>;

/** @internal Admission lowering for an already-normalized execution batch. */
export function resolveDispatchingExecutionBatchMessageKinds(
  sources: readonly GroupedDispatchingExecutionSourceInput[],
): readonly ("user" | "synthetic")[] {
  if (sources.length !== 2) {
    throw new TaskSessionLifecycleConflict(
      "Dispatching execution-source pair must contain two ordered sources",
    );
  }
  const messageKinds = sources.map(v2MessageKindForExecutionSource);
  messageKinds[0] = "synthetic";
  sources.forEach((source, index) => {
    assertDispatchingExecutionSource(source, messageKinds[index]!);
  });
  return messageKinds;
}

type ProjectedCommentProducerScope = {
  readonly companyId: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly sourceKind?: string;
  readonly actor?: TaskSessionExecutionActor;
  readonly counterpartTaskId?: string | null;
  readonly counterpartAuthorityId?: string | null;
  readonly counterpartOwnershipEpoch?: number | null;
};

export async function isExactTaskUpdateCrossTaskProducer(
  transaction: TaskSessionDbTransaction,
  scope: ProjectedCommentProducerScope,
  comment: Exclude<TaskSessionProjectedCommentSource, { producingRun: null }>,
): Promise<boolean> {
  const counterpartTaskId = scope.counterpartTaskId ?? null;
  const counterpartAuthorityId = scope.counterpartAuthorityId ?? null;
  const counterpartOwnershipEpoch =
    scope.counterpartOwnershipEpoch ?? null;
  if (
    scope.sourceKind !== "task_update" ||
    scope.actor?.kind !== "agent-execution" ||
    counterpartTaskId === null ||
    counterpartAuthorityId === null ||
    counterpartOwnershipEpoch === null ||
    !Number.isSafeInteger(counterpartOwnershipEpoch) ||
    counterpartOwnershipEpoch < 1 ||
    counterpartTaskId === scope.taskId ||
    scope.actor.authorityId !== counterpartAuthorityId ||
    scope.actor.agentId !== comment.author.agentId
  ) {
    return false;
  }

  await assertCounterpart(transaction, scope);
  const [target, sourceTask, producer] = await Promise.all([
    transaction
      .select({
        parentId: tasks.parentId,
        parentOwnershipEpoch: tasks.parentOwnershipEpoch,
        ownershipEpoch: tasks.ownershipEpoch,
        creatorKind: tasks.creatorKind,
        creatorAuthorityId: tasks.creatorAuthorityId,
        creatorAdapterConfigRevisionId: tasks.creatorAdapterConfigRevisionId,
      })
      .from(tasks)
      .where(
        and(
          eq(tasks.companyId, scope.companyId),
          eq(tasks.id, scope.taskId),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null),
    transaction
      .select({
        parentId: tasks.parentId,
        parentOwnershipEpoch: tasks.parentOwnershipEpoch,
        ownershipEpoch: tasks.ownershipEpoch,
      })
      .from(tasks)
      .where(
        and(
          eq(tasks.companyId, scope.companyId),
          eq(tasks.id, counterpartTaskId),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null),
    readTaskExecutionRun(transaction, {
      companyId: scope.companyId,
      taskId: counterpartTaskId,
      runId: comment.producingRun.runId,
    }),
  ]);
  const parentToChild =
    target &&
    target.parentId === counterpartTaskId &&
    target.parentOwnershipEpoch === counterpartOwnershipEpoch &&
    target.creatorKind === "agent-execution" &&
    target.creatorAuthorityId === counterpartAuthorityId &&
    target.creatorAdapterConfigRevisionId ===
      comment.producingRun.adapterConfigRevisionId;
  const childToParent =
    target &&
    sourceTask &&
    sourceTask.parentId === scope.taskId &&
    sourceTask.parentOwnershipEpoch === target.ownershipEpoch &&
    sourceTask.ownershipEpoch === counterpartOwnershipEpoch;
  return Boolean(
    (parentToChild || childToParent) &&
      producer &&
      producer.kind === "productive" &&
      producer.status === "running" &&
      producer.executionMode === "owner" &&
      producer.ownershipEpoch === counterpartOwnershipEpoch &&
      producer.targetAgentId === comment.author.agentId &&
      producer.taskExecutionAuthorityId === counterpartAuthorityId &&
      producer.consultExecutionId === null &&
      producer.adapterConfigRevisionId ===
        comment.producingRun.adapterConfigRevisionId,
  );
}

async function assertProjectedCommentProducer(
  transaction: TaskSessionDbTransaction,
  scope: ProjectedCommentProducerScope,
  comment: TaskSessionProjectedCommentSource | null,
): Promise<void> {
  if (!comment || comment.producingRun === null) return;
  const producer = await readTaskExecutionRun(transaction, {
    companyId: scope.companyId,
    taskId: scope.taskId,
    runId: comment.producingRun.runId,
  });
  if (
    producer &&
    producer.sessionId === scope.sessionId &&
    producer.targetAgentId === comment.author.agentId &&
    producer.adapterConfigRevisionId ===
      comment.producingRun.adapterConfigRevisionId &&
    (producer.kind === "productive" || producer.kind === "consult")
  ) {
    return;
  }
  if (await isExactTaskUpdateCrossTaskProducer(transaction, scope, comment)) {
    return;
  }
  throw new TaskSessionLifecycleConflict(
    "Agent comment producing run, agent, and adapter revision do not match one canonical task execution",
    {
      authorAgentId: comment.author.agentId,
      producingRunId: comment.producingRun.runId,
      producingAdapterConfigRevisionId:
        comment.producingRun.adapterConfigRevisionId,
    },
  );
}

function messageIdFromEvent(event: EventRow): string | null {
  const decoded = decodeStoredTaskSessionEvent(event).event;
  const wire = encodeTaskSessionEvent(decoded);
  const messageId = (wire.data as { messageID?: unknown }).messageID;
  return typeof messageId === "string" ? messageId : null;
}

function sourceClaim(
  event: EventRow,
  ref: RefRow | null,
  inbox: InputRow | null,
  view: ViewRow | null,
  comment: CommentRow | null,
): TaskSessionSourceClaim {
  if (
    !event.sourceKind ||
    !event.sourceId ||
    !event.immutableSourceKey ||
    !event.sourceIdentityDigest
  ) {
    throw new TaskSessionInvariantError(
      `Event ${event.id} is missing its canonical source envelope`,
    );
  }
  const messageId = messageIdFromEvent(event);
  if (!messageId) {
    throw new TaskSessionInvariantError(
      `Event ${event.id} is missing its Task Session message identity`,
    );
  }
  return {
    key: `${event.sessionId}\0${event.sourceKind}\0${event.immutableSourceKey}`,
    companyId: event.companyId,
    taskId: event.taskId,
    sessionId: event.sessionId,
    sourceKind: event.sourceKind,
    immutableSourceKey: event.immutableSourceKey,
    identityDigest: event.sourceIdentityDigest,
    sourceId: event.sourceId,
    eventId: event.id,
    messageId,
    inputId: inbox?.id ?? null,
    refId: ref?.id ?? null,
    historyViewId: view?.id ?? null,
    commentId: comment?.id ?? null,
  };
}

async function loadResult(
  transaction: TaskSessionDbTransaction,
  event: EventRow,
  retried: boolean,
): Promise<TaskSessionAdmissionResult> {
  const messageId = messageIdFromEvent(event);
  const [refs, inputs, comments] = await Promise.all([
    event.sourceId
      ? transaction
          .select()
          .from(taskExecutionRefs)
          .where(
            and(
              eq(taskExecutionRefs.sessionId, event.sessionId),
              eq(taskExecutionRefs.sourceId, event.sourceId),
            ),
          )
          .limit(1)
      : Promise.resolve([]),
    messageId
      ? transaction
          .select()
          .from(taskSessionInputs)
          .where(
            and(
              eq(taskSessionInputs.sessionId, event.sessionId),
              eq(taskSessionInputs.id, messageId),
            ),
          )
          .limit(1)
      : Promise.resolve([]),
    event.sourceId
      ? transaction
          .select()
          .from(taskComments)
          .where(
            and(
              eq(taskComments.sessionId, event.sessionId),
              eq(taskComments.canonicalSourceId, event.sourceId),
            ),
          )
          .limit(1)
      : Promise.resolve([]),
  ]);
  const ref = refs[0] ?? null;
  const views = ref
    ? await transaction
        .select()
        .from(taskExecutionHistoryViews)
        .where(eq(taskExecutionHistoryViews.id, ref.historyViewId))
        .limit(1)
    : [];
  const view = views[0] ?? null;
  const inbox = inputs[0] ?? null;
  const comment = comments[0] ?? null;
  return {
    source: sourceClaim(event, ref, inbox, view, comment),
    ref,
    input: inbox,
    view,
    comment,
    event,
    eventSeq: event.seq,
    retried,
  };
}

async function findRetry(
  transaction: TaskSessionDbTransaction,
  input: {
    sessionId: string;
    sourceKind: string;
    immutableSourceKey: string;
    sourceRecordId: string;
  },
  identityDigest: string,
  expectedType: TaskSessionEventType,
): Promise<TaskSessionAdmissionResult | null> {
  const rows = await transaction
    .select()
    .from(taskSessionEvents)
    .where(
      and(
        eq(taskSessionEvents.sessionId, input.sessionId),
        eq(taskSessionEvents.sourceKind, input.sourceKind),
        eq(taskSessionEvents.immutableSourceKey, input.immutableSourceKey),
      ),
    )
    .limit(1);
  const event = rows[0];
  if (!event) return null;
  if (
    event.sourceIdentityDigest !== identityDigest ||
    event.sourceRecordId !== input.sourceRecordId ||
    decodeStoredTaskSessionEvent(event).event.type !== expectedType
  ) {
    throw new TaskSessionLifecycleConflict(
      "Canonical Session source identity was retried with different immutable bytes",
      {
        sessionId: input.sessionId,
        sourceKind: input.sourceKind,
        immutableSourceKey: input.immutableSourceKey,
      },
    );
  }
  return loadResult(transaction, event, true);
}

async function lockCanonicalScope(
  transaction: TaskSessionDbTransaction,
  input: {
    companyId: string;
    taskId: string;
    sessionId: string;
  },
): Promise<void> {
  await lockCompanyLifecycle(transaction, input.companyId);
  await transaction.execute(sql`
    SELECT id
    FROM tasks
    WHERE company_id = ${input.companyId}
      AND id = ${input.taskId}
    FOR UPDATE
  `);
  await transaction.execute(sql`
    SELECT id
    FROM task_sessions
    WHERE company_id = ${input.companyId}
      AND task_id = ${input.taskId}
      AND id = ${input.sessionId}
    FOR UPDATE
  `);
}

async function lockCompanyLifecycle(
  transaction: TaskSessionDbTransaction,
  companyId: string,
): Promise<void> {
  const rows = await transaction
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1)
    .for("update");
  if (!rows[0]) {
    throw new TaskSessionLifecycleConflict(
      "Task Session company scope does not exist",
      { companyId },
    );
  }
}

async function assertCanonicalScope(
  transaction: TaskSessionDbTransaction,
  input: {
    companyId: string;
    taskId: string;
    sessionId: string;
  },
  options: {
    allowTerminal: boolean;
    dispatching: boolean;
  },
): Promise<{
  task: typeof tasks.$inferSelect;
  session: typeof taskSessions.$inferSelect;
}> {
  await lockCanonicalScope(transaction, input);
  const [companyRows, taskRows, sessionRows] = await Promise.all([
    transaction
      .select()
      .from(companies)
      .where(eq(companies.id, input.companyId))
      .limit(1),
    transaction
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.companyId, input.companyId),
          eq(tasks.id, input.taskId),
        ),
      )
      .limit(1),
    transaction
      .select()
      .from(taskSessions)
      .where(
        and(
          eq(taskSessions.companyId, input.companyId),
          eq(taskSessions.taskId, input.taskId),
          eq(taskSessions.id, input.sessionId),
        ),
      )
      .limit(1),
  ]);
  const company = companyRows[0];
  const task = taskRows[0];
  const session = sessionRows[0];
  if (
    !company ||
    company.status !== "active" ||
    company.sessionIntegrityState !== "ready" ||
    company.hardDeleteFencedAt !== null
  ) {
    throw new TaskSessionLifecycleConflict(
      "Company is not ready for canonical Session admission",
      { companyId: input.companyId },
    );
  }
  if (!task || task.hiddenAt !== null) {
    throw new TaskSessionLifecycleConflict("Task Session scope is invalid", {
      ...input,
    });
  }
  const terminal =
    task.lifecycleStatus === "done" ||
    task.lifecycleStatus === "cancelled";
  if (
    task.lifecycleStatus === null ||
    (!options.allowTerminal &&
      !inArrayValue(task.lifecycleStatus, ["open", "blocked"])) ||
    (options.dispatching && terminal)
  ) {
    throw new TaskSessionLifecycleConflict(
      "Task lifecycle does not accept this Session source",
      {
        taskId: input.taskId,
        lifecycleStatus: task.lifecycleStatus,
      },
    );
  }
  if (
    !session ||
    session.integrityState !== "ready" ||
    session.refAdmittableAt === null ||
    session.timeArchived !== null ||
    session.purgeFencedAt !== null
  ) {
    throw new TaskSessionLifecycleConflict(
      "Canonical Session is missing, not ready, or lifecycle-fenced",
      { ...input },
    );
  }
  return { task, session };
}

function inArrayValue<T>(value: T, values: readonly T[]): boolean {
  return values.includes(value);
}

async function assertWorkspaceBinding(
  transaction: TaskSessionDbTransaction,
  input: DispatchExecutionScope,
): Promise<void> {
  const rows = await transaction
    .select({
      binding: taskExecutionWorkspaceBindings,
      workspace: executionWorkspaces,
    })
    .from(taskExecutionWorkspaceBindings)
    .innerJoin(
      executionWorkspaces,
      and(
        eq(
          executionWorkspaces.id,
          taskExecutionWorkspaceBindings.executionWorkspaceId,
        ),
        eq(
          executionWorkspaces.companyId,
          taskExecutionWorkspaceBindings.companyId,
        ),
      ),
    )
    .where(
      and(
        eq(taskExecutionWorkspaceBindings.companyId, input.companyId),
        eq(taskExecutionWorkspaceBindings.taskId, input.taskId),
        eq(taskExecutionWorkspaceBindings.sessionId, input.sessionId),
        eq(
          taskExecutionWorkspaceBindings.ownershipEpoch,
          input.ownershipEpoch,
        ),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (
    !row ||
    !row.binding.absoluteCwd.startsWith("/")
  ) {
    throw new TaskSessionLifecycleConflict(
      "Task execution has no current immutable workspace binding",
      {
        taskId: input.taskId,
        ownershipEpoch: input.ownershipEpoch,
      },
    );
  }
}

async function assertCounterpart(
  transaction: TaskSessionDbTransaction,
  input: Pick<
    DispatchExecutionScope,
    | "companyId"
    | "taskId"
    | "counterpartTaskId"
    | "counterpartAuthorityId"
    | "counterpartOwnershipEpoch"
  >,
): Promise<void> {
  const counterpart = [
    input.counterpartTaskId ?? null,
    input.counterpartAuthorityId ?? null,
    input.counterpartOwnershipEpoch ?? null,
  ];
  const present = counterpart.filter((value) => value !== null).length;
  if (present !== 0 && present !== 3) {
    throw new TaskSessionLifecycleConflict(
      "Counterpart authority identity must be all present or all absent",
      { taskId: input.taskId },
    );
  }
  if (present === 0) return;
  const rows = await transaction
    .select()
    .from(taskExecutionAuthorities)
    .where(
      and(
        eq(taskExecutionAuthorities.companyId, input.companyId),
        eq(taskExecutionAuthorities.taskId, input.counterpartTaskId!),
        eq(
          taskExecutionAuthorities.ownershipEpoch,
          input.counterpartOwnershipEpoch!,
        ),
        eq(taskExecutionAuthorities.id, input.counterpartAuthorityId!),
        eq(taskExecutionAuthorities.state, "current"),
      ),
    )
    .limit(1);
  if (!rows[0]) {
    throw new TaskSessionLifecycleConflict(
      "Counterpart authority is missing, revoked, or superseded",
      { counterpartAuthorityId: input.counterpartAuthorityId },
    );
  }
}

async function assertDispatchScope(
  transaction: TaskSessionDbTransaction,
  input: DispatchExecutionScope,
): Promise<ValidatedDispatchScope> {
  const { task } = await assertCanonicalScope(transaction, input, {
    allowTerminal: false,
    dispatching: true,
  });
  if (
    !Number.isInteger(input.ownershipEpoch) ||
    input.ownershipEpoch <= 0 ||
    task.ownershipEpoch !== input.ownershipEpoch
  ) {
    throw new TaskSessionLifecycleConflict(
      "Task execution epoch or Session context epoch is stale",
      {
        taskId: input.taskId,
        ownershipEpoch: input.ownershipEpoch,
        contextEpoch: input.contextEpoch,
      },
    );
  }

  const [companyAgentRows, revisionRows, contextRows] = await Promise.all([
    transaction
      .select({
        id: agents.id,
        companyId: agents.companyId,
        name: agents.name,
        reportsTo: agents.reportsTo,
        status: agents.status,
        currentAdapterConfigRevisionId: agents.currentAdapterConfigRevisionId,
      })
      .from(agents)
      .where(eq(agents.companyId, input.companyId)),
    transaction
      .select({ id: agentAdapterConfigRevisions.id })
      .from(agentAdapterConfigRevisions)
      .where(
        and(
          eq(agentAdapterConfigRevisions.companyId, input.companyId),
          eq(agentAdapterConfigRevisions.agentId, input.targetAgentId),
          eq(agentAdapterConfigRevisions.id, input.adapterConfigRevisionId),
        ),
      )
      .limit(1),
    transaction
      .select()
      .from(taskSessionContextEpochs)
      .where(
        and(
          eq(taskSessionContextEpochs.companyId, input.companyId),
          eq(taskSessionContextEpochs.taskId, input.taskId),
          eq(taskSessionContextEpochs.sessionId, input.sessionId),
          eq(taskSessionContextEpochs.generation, input.contextEpoch),
        ),
      )
      .limit(1),
  ]);
  const target = companyAgentRows.find((row) => row.id === input.targetAgentId);
  const invokability = evaluateAgentInvokability(target, companyAgentRows);
  if (!invokability.invokable) {
    throw new TaskSessionLifecycleConflict(
      "Target agent is not invokable",
      { targetAgentId: input.targetAgentId, ...invokability.details },
    );
  }
  if (
    !revisionRows[0] ||
    target?.currentAdapterConfigRevisionId !== input.adapterConfigRevisionId
  ) {
    throw new TaskSessionLifecycleConflict(
      "Target adapter configuration revision is missing or no longer current",
      {
        targetAgentId: input.targetAgentId,
        adapterConfigRevisionId: input.adapterConfigRevisionId,
      },
    );
  }
  if (!contextRows[0]) {
    throw new TaskSessionLifecycleConflict(
      "Session context epoch binding is missing",
      { sessionId: input.sessionId, contextEpoch: input.contextEpoch },
    );
  }

  if (input.mode === "owner") {
    if (
      input.taskExecutionAuthorityId === null ||
      input.consultExecutionId !== null ||
      task.ownerKind !== "agent" ||
      task.ownerAgentId !== input.targetAgentId ||
      input.consultCallerRefId != null ||
      input.consultChainToken != null
    ) {
      throw new TaskSessionLifecycleConflict(
        "Owner execution scope does not match the current task owner",
        { taskId: input.taskId, targetAgentId: input.targetAgentId },
      );
    }
    const authorityRows = await transaction
      .select()
      .from(taskExecutionAuthorities)
      .where(
        and(
          eq(taskExecutionAuthorities.companyId, input.companyId),
          eq(taskExecutionAuthorities.taskId, input.taskId),
          eq(taskExecutionAuthorities.sessionId, input.sessionId),
          eq(
            taskExecutionAuthorities.ownershipEpoch,
            input.ownershipEpoch,
          ),
          eq(taskExecutionAuthorities.agentId, input.targetAgentId),
          eq(
            taskExecutionAuthorities.id,
            input.taskExecutionAuthorityId,
          ),
          eq(taskExecutionAuthorities.state, "current"),
        ),
      )
      .limit(1);
    if (!authorityRows[0]) {
      throw new TaskSessionLifecycleConflict(
        "Task execution authority is missing, revoked, or stale",
        { taskExecutionAuthorityId: input.taskExecutionAuthorityId },
      );
    }
  } else if (input.mode === "consult") {
    if (
      input.taskExecutionAuthorityId !== null ||
      input.consultExecutionId === null ||
      input.consultCallerRefId == null ||
      input.consultChainToken == null
    ) {
      throw new TaskSessionLifecycleConflict(
        "Consult execution scope is incomplete",
        { taskId: input.taskId },
      );
    }
    const consultRows = await transaction
      .select()
      .from(taskConsultExecutions)
      .where(
        and(
          eq(taskConsultExecutions.companyId, input.companyId),
          eq(taskConsultExecutions.taskId, input.taskId),
          eq(taskConsultExecutions.sessionId, input.sessionId),
          eq(taskConsultExecutions.id, input.consultExecutionId),
          eq(
            taskConsultExecutions.ownershipEpoch,
            input.ownershipEpoch,
          ),
          eq(taskConsultExecutions.targetAgentId, input.targetAgentId),
          eq(
            taskConsultExecutions.adapterConfigRevisionId,
            input.adapterConfigRevisionId,
          ),
          eq(
            taskConsultExecutions.sourceRefId,
            input.consultCallerRefId,
          ),
          eq(taskConsultExecutions.chainToken, input.consultChainToken),
          eq(taskConsultExecutions.state, "active"),
        ),
      )
      .limit(1);
    if (!consultRows[0]) {
      throw new TaskSessionLifecycleConflict(
        "Consult execution binding is missing, closed, or stale",
        { consultExecutionId: input.consultExecutionId },
      );
    }
  } else {
    throw new TaskSessionLifecycleConflict(
      "Task execution mode must be owner or consult",
      { mode: input.mode },
    );
  }

  await Promise.all([
    assertWorkspaceBinding(transaction, input),
    assertCounterpart(transaction, input),
  ]);
  return {
    contextEpochBaselineSeq: contextRows[0].baselineSeq ?? -1,
  };
}

function buildRef(
  input: DispatchExecutionScope & {
    sourceKind: RefRow["sourceKind"];
    sourceRecordId: string;
    exactText: string;
    idempotencyKey: string;
    previousOwnershipEpoch?: number | null;
  },
  ids: StableIdentity,
  messageKind: RefRow["messageKind"],
  inputId: string | null,
  laneOrdinal: number,
) {
  return {
    id: ids.refId,
    companyId: input.companyId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    ownershipEpoch: input.ownershipEpoch,
    previousOwnershipEpoch: previousOwnershipEpochForDispatchSource(input),
    executionScopeId: input.executionScopeId ?? ids.executionScopeId,
    executionLineageId:
      input.executionLineageId ?? ids.executionLineageId,
    mode: input.mode,
    sourceKind: input.sourceKind,
    sourceId: ids.sourceId,
    sourceRecordId: input.sourceRecordId,
    messageKind,
    sourceMessageId: ids.messageId,
    exactMessage: input.exactText,
    deliveryIdempotencyKey: input.idempotencyKey,
    targetAgentId: input.targetAgentId,
    laneOrdinal,
    taskExecutionAuthorityId: input.taskExecutionAuthorityId,
    consultExecutionId: input.consultExecutionId,
    adapterConfigRevisionId: input.adapterConfigRevisionId,
    contextEpoch: input.contextEpoch,
    historyViewId: ids.historyViewId,
    inputId,
    counterpartTaskId: input.counterpartTaskId ?? null,
    counterpartAuthorityId: input.counterpartAuthorityId ?? null,
    counterpartOwnershipEpoch: input.counterpartOwnershipEpoch ?? null,
    consultCallerRefId: input.consultCallerRefId ?? null,
    consultChainToken: input.consultChainToken ?? null,
    disposition: "active" as const,
    invalidationReason: null,
  };
}

export async function reserveTaskExecutionLaneOrdinalInTransaction(
  transaction: TaskSessionDbTransaction,
  input: Pick<
    DispatchExecutionScope,
    "companyId" | "taskId" | "ownershipEpoch" | "targetAgentId"
  >,
  now: Date,
): Promise<number> {
  const rows = await transaction
    .insert(taskExecutionLanes)
    .values({
      companyId: input.companyId,
      taskId: input.taskId,
      ownershipEpoch: input.ownershipEpoch,
      targetAgentId: input.targetAgentId,
      nextOrdinal: 1,
      activeOrdinal: null,
      activeLeaseGeneration: null,
      activeLeaseId: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        taskExecutionLanes.companyId,
        taskExecutionLanes.taskId,
        taskExecutionLanes.ownershipEpoch,
        taskExecutionLanes.targetAgentId,
      ],
      set: {
        nextOrdinal: sql`${taskExecutionLanes.nextOrdinal} + 1`,
        updatedAt: now,
      },
      setWhere: lt(taskExecutionLanes.nextOrdinal, Number.MAX_SAFE_INTEGER),
    })
    .returning({ nextOrdinal: taskExecutionLanes.nextOrdinal });
  const laneOrdinal = (rows[0]?.nextOrdinal ?? 0) - 1;
  if (!Number.isSafeInteger(laneOrdinal) || laneOrdinal < 0) {
    throw new TaskSessionInvariantError(
      "Task execution lane did not reserve one canonical FIFO ordinal",
    );
  }
  return laneOrdinal;
}

function buildView(
  input: DispatchExecutionScope,
  ids: StableIdentity,
  contextEpochBaselineSeq: number,
  sourceInputId: string | null,
) {
  return {
    id: ids.historyViewId,
    companyId: input.companyId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    refId: ids.refId,
    executionLineageId:
      input.executionLineageId ?? ids.executionLineageId,
    state: "empty" as const,
    compositionDepth: "none" as const,
    contextEpoch: input.contextEpoch,
    contextEpochBaselineSeq,
    compositionPreparationId: null,
    compositionBytes: null,
    compositionHash: null,
    sourceMessageId: ids.messageId,
    sourceInputId,
    invalidationReason: null,
    invalidatedAt: null,
    finalizedAt: null,
  };
}

function sourceEnvelope(
  input: {
    companyId: string;
    taskId: string;
    sessionId: string;
    sourceKind: string;
    immutableSourceKey: string;
    sourceRecordId: string;
  },
  ids: StableIdentity,
  identityDigest: string,
  eventTimestamp: Date,
  execution?: Pick<
    DispatchExecutionScope,
    "ownershipEpoch" | "targetAgentId" | "adapterConfigRevisionId"
  >,
  comment: TaskSessionProjectedCommentSource | null = null,
) {
  const producingRun =
    comment && comment.producingRun !== null
      ? {
          runId: comment.producingRun.runId,
          agentId: comment.author.agentId,
          adapterConfigRevisionId:
            comment.producingRun.adapterConfigRevisionId,
        }
      : null;
  return {
    id: ids.eventId,
    companyId: input.companyId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    runId: producingRun?.runId ?? null,
    ownershipEpoch: execution?.ownershipEpoch ?? null,
    agentId:
      producingRun?.agentId ??
      execution?.targetAgentId ??
      null,
    adapterConfigRevisionId:
      producingRun?.adapterConfigRevisionId ??
      execution?.adapterConfigRevisionId ??
      null,
    sourceKind: input.sourceKind,
    sourceId: ids.sourceId,
    immutableSourceKey: input.immutableSourceKey,
    sourceRecordId: input.sourceRecordId,
    sourceIdentityDigest: identityDigest,
    createdAt: eventTimestamp,
  };
}

async function appendAdmissionEvent(
  transaction: TaskSessionDbTransaction,
  input: {
    envelope: ReturnType<typeof sourceEnvelope>;
    seq: number;
    type: TaskSessionEventType;
    data: Record<string, unknown>;
    projection?: PublishTaskSessionEventInput["projection"];
  },
): Promise<EventRow> {
  const {
    id: _eventId,
    sessionId: _sessionId,
    ...envelope
  } = input.envelope;
  const published = await publishTaskSessionEventInTx(transaction, {
    event: {
      id: input.envelope.id,
      sessionId: input.envelope.sessionId,
      seq: input.seq,
      type: input.type,
      data: input.data,
    },
    envelope,
    projection: input.projection,
  });
  return published.event;
}

async function appendNonDispatchSyntheticComment(
  transaction: TaskSessionDbTransaction,
  input: NonDispatchSyntheticComment,
  options: {
    identityDigest: string;
    ids: StableIdentity;
    clock: () => Date;
  },
): Promise<TaskSessionAdmissionResult> {
  const reply = await resolveTaskCommentReplyProjection(
    transaction,
    input,
    input.comment.replyToCommentId,
  );
  const retry = await findRetry(
    transaction,
    input,
    options.identityDigest,
    TaskSession.Event.Synthetic.type,
  );
  if (retry) return retry;
  const { seq } = await reserveTaskSessionEventSequence(
    transaction,
    input,
  );
  const now = options.clock();
  const type = TaskSession.Event.Synthetic.type;
  const data = {
    sessionID: input.sessionId,
    messageID: options.ids.messageId,
    timestamp: now.getTime(),
    text: input.exactText,
  };
  const event = await appendAdmissionEvent(transaction, {
    envelope: sourceEnvelope(
      input,
      options.ids,
      options.identityDigest,
      now,
      {
        ownershipEpoch: input.ownershipEpoch,
        targetAgentId: input.agentId,
        adapterConfigRevisionId: input.adapterConfigRevisionId,
      },
      input.comment,
    ),
    seq,
    type,
    data,
    projection: {
      comment: projectionInput({
        phase: "direct",
        sourceKind: input.projectionKind ?? "task_update",
        sourceId:
          input.projectionKind === "run_progress"
            ? input.runId
            : options.ids.sourceId,
        messageId: options.ids.messageId,
        commentId: options.ids.commentId,
        body: input.exactText,
        author: input.comment.author,
        reply,
        steeringSegment: input.comment.steeringSegment,
      }),
    },
  });
  return loadResult(transaction, event, false);
}

async function admitQueuedUserExecutionSource(
  transaction: TaskSessionDbTransaction,
  input: DispatchingExecutionSourceInput,
  options: {
    ids: StableIdentity;
    identityDigest: string;
    contextEpochBaselineSeq: number;
    now: Date;
  },
): Promise<TaskSessionAdmissionResult> {
  const comment = input.comment;
  if (!comment) {
    throw new TaskSessionInvariantError(
      "User execution source reached persistence without its projected author",
    );
  }
  const reply = await resolveTaskCommentReplyProjection(
    transaction,
    input,
    comment.replyToCommentId,
  );
  const { highWaterSeq, seq } = await reserveTaskSessionEventSequence(
    transaction,
    input,
  );
  const {
    id: _eventId,
    sessionId: _eventSessionId,
    ...eventEnvelope
  } = sourceEnvelope(
    input,
    options.ids,
    options.identityDigest,
    options.now,
    input,
    comment,
  );
  const published = await publishTaskSessionEventInTx(transaction, {
    event: {
      id: options.ids.eventId,
      sessionId: input.sessionId,
      seq,
      type: TaskSession.Event.PromptAdmitted.type,
      data: {
        sessionID: input.sessionId,
        messageID: options.ids.messageId,
        timestamp: options.now.getTime(),
        prompt: { text: input.exactText },
        delivery: "queue",
      },
    },
    envelope: eventEnvelope,
    projection: {
      inputBinding: {
        sourceRefId: options.ids.refId,
        dispositionId: options.ids.dispositionId,
      },
      comment: projectionInput({
        phase: "admitted",
        sourceKind: userProjectionKind(input.sourceKind),
        sourceId: options.ids.sourceId,
        messageId: options.ids.messageId,
        commentId: options.ids.commentId,
        body: input.exactText,
        author: comment.author,
        reply,
        steeringSegment: comment.steeringSegment,
      }),
    },
  });
  const eventRow = published.event;
  const inboxRows = await transaction
    .select()
    .from(taskSessionInputs)
    .where(eq(taskSessionInputs.id, options.ids.messageId))
    .limit(1);
  if (!inboxRows[0]) {
    throw new TaskSessionInvariantError(
      "Task Session projector failed to materialize admitted input",
    );
  }
  const laneOrdinal = await reserveTaskExecutionLaneOrdinalInTransaction(
    transaction,
    input,
    options.now,
  );
  const refRows = await transaction
    .insert(taskExecutionRefs)
    .values({
      ...buildRef(
        input,
        options.ids,
        "user",
        options.ids.messageId,
        laneOrdinal,
      ),
      admissionHighWaterSeq: highWaterSeq,
      admittedSeq: seq,
      promotedSeq: null,
    })
    .returning();
  if (!refRows[0]) {
    throw new TaskSessionInvariantError(
      "Task Session admission failed to persist its execution ref",
    );
  }
  const viewRows = await transaction
    .insert(taskExecutionHistoryViews)
    .values({
      ...buildView(
        input,
        options.ids,
        options.contextEpochBaselineSeq,
        options.ids.messageId,
      ),
      sourceHighWaterSeq: highWaterSeq,
      sourceAdmittedSeq: seq,
      sourcePromotedSeq: null,
    })
    .returning();
  if (!viewRows[0]) {
    throw new TaskSessionInvariantError(
      "Task Session admission failed to persist its history view",
    );
  }
  return loadResult(transaction, eventRow, false);
}

async function admitSyntheticExecutionSource(
  transaction: TaskSessionDbTransaction,
  input: DispatchingExecutionSourceInput,
  ids: StableIdentity,
  identityDigest: string,
  contextEpochBaselineSeq: number,
  clock: () => Date,
): Promise<TaskSessionAdmissionResult> {
  const reply = input.comment
    ? await resolveTaskCommentReplyProjection(
        transaction,
        input,
        input.comment.replyToCommentId,
      )
    : TOP_LEVEL_REPLY_PROJECTION;
  const retry = await findRetry(
    transaction,
    input,
    identityDigest,
    TaskSession.Event.Synthetic.type,
  );
  if (retry) return retry;

  const { highWaterSeq: admissionHighWaterSeq, seq } =
    await reserveTaskSessionEventSequence(transaction, input);
  const now = clock();
  const sessionEvent = {
    id: ids.eventId,
    type: TaskSession.Event.Synthetic.type,
    data: {
      sessionID: input.sessionId,
      messageID: ids.messageId,
      timestamp: now.getTime(),
      text: input.exactText,
    },
  };
  const comment = input.comment
    ? projectionInput({
        phase: "direct",
        sourceKind: directProjectionKind(input.sourceKind),
        sourceId: ids.sourceId,
        messageId: ids.messageId,
        commentId: ids.commentId,
        body: input.exactText,
        author: input.comment.author,
        reply,
        steeringSegment: input.comment.steeringSegment,
      })
    : undefined;
  const event = await appendAdmissionEvent(transaction, {
    envelope: sourceEnvelope(
      input,
      ids,
      identityDigest,
      now,
      input,
      input.comment,
    ),
    seq,
    type: sessionEvent.type,
    data: sessionEvent.data,
    projection: {
      comment,
    },
  });
  const laneOrdinal = await reserveTaskExecutionLaneOrdinalInTransaction(
    transaction,
    input,
    now,
  );
  const refs = await transaction
    .insert(taskExecutionRefs)
    .values({
      ...buildRef(
        input,
        ids,
        "synthetic",
        null,
        laneOrdinal,
      ),
      admissionHighWaterSeq,
      admittedSeq: null,
      promotedSeq: null,
    })
    .returning();
  if (!refs[0]) {
    throw new TaskSessionInvariantError(
      "Direct Session admission failed to reserve its execution ref",
    );
  }
  const views = await transaction
    .insert(taskExecutionHistoryViews)
    .values({
      ...buildView(input, ids, contextEpochBaselineSeq, null),
      sourceHighWaterSeq: admissionHighWaterSeq,
      sourceAdmittedSeq: null,
      sourcePromotedSeq: null,
    })
    .returning();
  if (!views[0]) {
    throw new TaskSessionInvariantError(
      "Direct Session admission failed to reserve its history view",
    );
  }
  return loadResult(transaction, event, false);
}

async function appendNonDispatchEvent(
  transaction: TaskSessionDbTransaction,
  input: NonDispatchUserComment | NonDispatchControlNotice,
  options: {
    user: boolean;
    identityDigest: string;
    ids: StableIdentity;
    clock: () => Date;
  },
): Promise<TaskSessionAdmissionResult> {
  const sourceComment = options.user
    ? (input as NonDispatchUserComment).comment
    : (input as NonDispatchControlNotice).comment;
  const reply = sourceComment
    ? await resolveTaskCommentReplyProjection(
        transaction,
        input,
        sourceComment.replyToCommentId,
      )
    : TOP_LEVEL_REPLY_PROJECTION;
  const expectedType = options.user
    ? TaskSession.Event.Prompted.type
    : TaskSession.Event.ContextUpdated.type;
  const retry = await findRetry(
    transaction,
    input,
    options.identityDigest,
    expectedType,
  );
  if (retry) return retry;
  const { seq } = await reserveTaskSessionEventSequence(
    transaction,
    input,
  );
  const now = options.clock();
  const data = options.user
    ? {
        sessionID: input.sessionId,
        messageID: options.ids.messageId,
        timestamp: now.getTime(),
        prompt: { text: input.exactText },
        delivery: "queue" as const,
      }
    : {
        sessionID: input.sessionId,
        messageID: options.ids.messageId,
        timestamp: now.getTime(),
        text: input.exactText,
      };
  const comment = sourceComment;
  const projectorComment = comment
    ? projectionInput({
        phase: "direct",
        sourceKind: options.user
          ? "human_comment"
          : input.sourceKind === "plugin_withdrawal"
            ? "plugin_withdrawal"
            : input.sourceKind === "task_update"
              ? "task_update"
            : "system_control",
        sourceId: options.ids.sourceId,
        messageId: options.ids.messageId,
        commentId: options.ids.commentId,
        body: input.exactText,
        author: comment.author,
        reply,
        steeringSegment: comment.steeringSegment,
      })
    : undefined;
  const envelope = sourceEnvelope(
    input,
    options.ids,
    options.identityDigest,
    now,
    undefined,
    comment,
  );
  const event = await appendAdmissionEvent(transaction, {
    envelope,
    seq,
    type: expectedType,
    data,
    projection: {
      inputBinding: options.user
        ? { sourceRefId: null, dispositionId: options.ids.dispositionId }
        : undefined,
      comment: projectorComment,
    },
  });
  return loadResult(transaction, event, false);
}

async function admitSteeringEvent(
  transaction: TaskSessionDbTransaction,
  input: SteeringComment,
  options: {
    identityDigest: string;
    ids: StableIdentity;
    clock: () => Date;
  },
): Promise<TaskSessionAdmissionResult> {
  const messageKind = v2MessageKindForExecutionSource(input);
  const expectedType = messageKind === "user"
    ? TaskSession.Event.PromptAdmitted.type
    : TaskSession.Event.Synthetic.type;
  const retry = await findRetry(
    transaction,
    input,
    options.identityDigest,
    expectedType,
  );
  if (retry) return retry;
  const reply = await resolveTaskCommentReplyProjection(
    transaction,
    input,
    input.comment.replyToCommentId,
  );
  const { seq } = await reserveTaskSessionEventSequence(
    transaction,
    input,
  );
  const now = options.clock();
  const {
    id: _eventId,
    sessionId: _eventSessionId,
    ...eventEnvelope
  } = sourceEnvelope(
    input,
    options.ids,
    options.identityDigest,
    now,
    undefined,
    input.comment,
  );
  const published = await publishTaskSessionEventInTx(transaction, {
    event: {
      id: options.ids.eventId,
      sessionId: input.sessionId,
      seq,
      type: expectedType,
      data: messageKind === "user"
        ? {
            sessionID: input.sessionId,
            messageID: options.ids.messageId,
            timestamp: now.getTime(),
            prompt: { text: input.exactText },
            delivery: "steer" as const,
          }
        : {
            sessionID: input.sessionId,
            messageID: options.ids.messageId,
            timestamp: now.getTime(),
            text: input.exactText,
          },
    },
    envelope: eventEnvelope,
    projection: {
      inputBinding: messageKind === "user"
        ? {
            sourceRefId: null,
            dispositionId: options.ids.dispositionId,
          }
        : undefined,
      comment: projectionInput({
        phase: messageKind === "user" ? "admitted" : "direct",
        sourceKind:
          messageKind === "user"
            ? "human_comment"
            : "harness_delivery",
        sourceId: options.ids.sourceId,
        messageId: options.ids.messageId,
        commentId: options.ids.commentId,
        body: input.exactText,
        author: input.comment.author,
        reply,
      }),
    },
  });
  return loadResult(transaction, published.event, false);
}

/** Owns physical Task Session source admission and projection. */
export function createTaskSessionAdmissionService(
  db: Db,
  options: {
    clock?: () => Date;
    hooks?: TaskSessionAdmissionHooks;
  } = {},
): TaskSessionAdmissionService {
  const clock = options.clock ?? (() => new Date());
  const hooks = options.hooks ?? {};

  async function admitExecutionSourceInTx(
    transaction: TaskSessionDbTransaction,
    input: DispatchingExecutionSourceInput,
    messageKind: "user" | "synthetic",
  ): Promise<TaskSessionAdmissionResult> {
    await assertProjectedCommentProducer(
      transaction,
      input,
      input.comment,
    );
    const stableIds = stableIdentityForSource(input);
    const identityDigest = digest({
      contract: "dispatching-execution-source/v1",
      sourceKind: input.sourceKind,
      actor: input.actor,
      immutableSourceKey: input.immutableSourceKey,
      sourceRecordId: input.sourceRecordId,
      ...scopeDigest(input),
      messageKind,
      exactText: input.exactText,
      delivery: messageKind === "user" ? "queue" : null,
      idempotencyKey: input.idempotencyKey,
      comment: input.comment,
    });
    const retry = await findRetry(
      transaction,
      input,
      identityDigest,
      messageKind === "user"
        ? TaskSession.Event.PromptAdmitted.type
        : TaskSession.Event.Synthetic.type,
    );
    if (retry) return retry;
    const ids = await reserveStableMessageIdentity(
      transaction,
      input,
      stableIds,
    );
    const validated = await assertDispatchScope(
      transaction,
      input,
    );
    await hooks.assertImmutableSource?.(transaction, input);
    return messageKind === "user"
      ? admitQueuedUserExecutionSource(transaction, input, {
          ids,
          identityDigest,
          contextEpochBaselineSeq: validated.contextEpochBaselineSeq,
          now: clock(),
        })
      : admitSyntheticExecutionSource(
          transaction,
          input,
          ids,
          identityDigest,
          validated.contextEpochBaselineSeq,
          clock,
        );
  }

  return {
    admitExecutionSource(input, dbTransaction) {
      const messageKind = assertDispatchingExecutionSource(input);
      const operation = async (transaction: TaskSessionDbTransaction) => {
        await lockCompanyLifecycle(transaction, input.companyId);
        return admitExecutionSourceInTx(transaction, input, messageKind);
      };
      return dbTransaction
        ? operation(dbTransaction)
        : db.transaction(operation);
    },

    admitExecutionSourceBatch(input, dbTransaction) {
      if (!input.batchKey.trim()) {
        throw new TaskSessionLifecycleConflict(
          "Dispatching execution-source batch key must be non-empty",
        );
      }
      const first = input.sources[0]!;
      const targetScope = {
        companyId: first.companyId,
        taskId: first.taskId,
        sessionId: first.sessionId,
        ownershipEpoch: first.ownershipEpoch,
        targetAgentId: first.targetAgentId,
        taskExecutionAuthorityId:
          first.taskExecutionAuthorityId,
        consultExecutionId: first.consultExecutionId,
        adapterConfigRevisionId:
          first.adapterConfigRevisionId,
        contextEpoch: first.contextEpoch,
        mode: first.mode,
        consultCallerRefId: first.consultCallerRefId ?? null,
        consultChainToken: first.consultChainToken ?? null,
      };
      const targetScopeJson = canonicalJson(targetScope);
      const sourceKeys = new Set<string>();
      const idempotencyKeys = new Set<string>();
      for (const source of input.sources) {
        const eventTargetScope = canonicalJson({
          companyId: source.companyId,
          taskId: source.taskId,
          sessionId: source.sessionId,
          ownershipEpoch: source.ownershipEpoch,
          targetAgentId: source.targetAgentId,
          taskExecutionAuthorityId:
            source.taskExecutionAuthorityId,
          consultExecutionId: source.consultExecutionId,
          adapterConfigRevisionId:
            source.adapterConfigRevisionId,
          contextEpoch: source.contextEpoch,
          mode: source.mode,
          consultCallerRefId: source.consultCallerRefId ?? null,
          consultChainToken: source.consultChainToken ?? null,
        });
        if (eventTargetScope !== targetScopeJson) {
          throw new TaskSessionLifecycleConflict(
            "Dispatching execution-source batch crossed counterpart execution scopes",
          );
        }
        if (
          sourceKeys.has(source.immutableSourceKey) ||
          idempotencyKeys.has(source.idempotencyKey)
        ) {
          throw new TaskSessionLifecycleConflict(
            "Dispatching execution-source batch contains duplicate source identity",
          );
        }
        sourceKeys.add(source.immutableSourceKey);
        idempotencyKeys.add(source.idempotencyKey);
      }
      const groupingKey = canonicalJson({
        contract: "dispatching-execution-source-batch/v1",
        batchKey: input.batchKey,
        targetScope,
      });
      const executionScopeId = deterministicUuid(
        "counterpart-execution-scope",
        groupingKey,
      );
      const executionLineageId = first.executionLineageId ?? deterministicUuid(
        "counterpart-execution-lineage",
        groupingKey,
      );
      const grouped = input.sources.map((source) => {
        if (
          (source.executionScopeId &&
            source.executionScopeId !== executionScopeId) ||
          (source.executionLineageId &&
            source.executionLineageId !== executionLineageId)
        ) {
          throw new TaskSessionLifecycleConflict(
            "Dispatching execution-source batch changed its stable execution grouping",
          );
        }
        return {
          ...source,
          executionScopeId,
          executionLineageId,
        };
      });
      const messageKinds = resolveDispatchingExecutionBatchMessageKinds(grouped);
      const operation = async (transaction: TaskSessionDbTransaction) => {
        await lockCompanyLifecycle(transaction, first.companyId);
        const results: TaskSessionAdmissionResult[] = [];
        for (const [index, source] of grouped.entries()) {
          results.push(
            await admitExecutionSourceInTx(
              transaction,
              source,
              messageKinds[index]!,
            ),
          );
        }
        if (classifyOrderedExecutionScopePair(
          results.flatMap((result) => result.ref ? [result.ref] : []),
        ) === null) {
          throw new TaskSessionLifecycleConflict(
            "Execution-source pair did not persist one exact ordered scope",
          );
        }
        return results;
      };
      return dbTransaction
        ? operation(dbTransaction)
        : db.transaction(operation);
    },

    appendNonDispatchUserComment(input, dbTransaction) {
      assertSourceIdentity(input);
      assertProjectedCommentSourceShape(input.comment);
      const stableIds = stableIdentityForSource(input);
      const identityDigest = digest({
        contract: "non-dispatch-user/v1",
        companyId: input.companyId,
        taskId: input.taskId,
        sessionId: input.sessionId,
        sourceKind: input.sourceKind,
        immutableSourceKey: input.immutableSourceKey,
        sourceRecordId: input.sourceRecordId,
        exactText: input.exactText,
        delivery: "queue",
        comment: input.comment,
      });
      const operation = async (transaction: TaskSessionDbTransaction) => {
        await lockCompanyLifecycle(transaction, input.companyId);
        const retry = await findRetry(
          transaction,
          input,
          identityDigest,
          TaskSession.Event.Prompted.type,
        );
        if (retry) return retry;
        const ids = await reserveStableMessageIdentity(
          transaction,
          input,
          stableIds,
        );
        await assertCanonicalScope(transaction, input, {
          allowTerminal: true,
          dispatching: false,
        });
        await hooks.assertImmutableSource?.(transaction, input);
        return appendNonDispatchEvent(transaction, input, {
          user: true,
          identityDigest,
          ids,
          clock,
        });
      };
      return dbTransaction
        ? operation(dbTransaction)
        : db.transaction(operation);
    },

    admitSteeringComment(input, dbTransaction) {
      assertSourceIdentity(input);
      assertExecutionSourceCommentProvenance(input);
      const stableIds = stableIdentityForSource(input);
      const messageKind = v2MessageKindForExecutionSource(input);
      const identityDigest = digest({
        contract: "active-run-steering/v2",
        companyId: input.companyId,
        taskId: input.taskId,
        sessionId: input.sessionId,
        sourceKind: input.sourceKind,
        actor: input.actor,
        immutableSourceKey: input.immutableSourceKey,
        sourceRecordId: input.sourceRecordId,
        exactText: input.exactText,
        messageKind,
        delivery: messageKind === "user" ? "steer" : null,
        comment: input.comment,
      });
      const operation = async (transaction: TaskSessionDbTransaction) => {
        await lockCompanyLifecycle(transaction, input.companyId);
        const retry = await findRetry(
          transaction,
          input,
          identityDigest,
          messageKind === "user"
            ? TaskSession.Event.PromptAdmitted.type
            : TaskSession.Event.Synthetic.type,
        );
        if (retry) return retry;
        const ids = await reserveStableMessageIdentity(
          transaction,
          input,
          stableIds,
        );
        await assertCanonicalScope(transaction, input, {
          allowTerminal: false,
          dispatching: false,
        });
        await assertProjectedCommentProducer(
          transaction,
          input,
          input.comment,
        );
        await hooks.assertImmutableSource?.(transaction, input);
        return admitSteeringEvent(transaction, input, {
          identityDigest,
          ids,
          clock,
        });
      };
      return dbTransaction
        ? operation(dbTransaction)
        : db.transaction(operation);
    },

    appendNonDispatchControlNotice(input, dbTransaction) {
      assertSourceIdentity(input);
      if (input.comment) {
        assertProjectedCommentSourceShape(input.comment);
      }
      const stableIds = stableIdentityForSource(input);
      const identityDigest = digest({
        contract: "non-dispatch-control/v1",
        companyId: input.companyId,
        taskId: input.taskId,
        sessionId: input.sessionId,
        sourceKind: input.sourceKind,
        immutableSourceKey: input.immutableSourceKey,
        sourceRecordId: input.sourceRecordId,
        exactText: input.exactText,
        actor: input.actor ?? null,
        counterpartTaskId: input.counterpartTaskId ?? null,
        counterpartAuthorityId: input.counterpartAuthorityId ?? null,
        counterpartOwnershipEpoch:
          input.counterpartOwnershipEpoch ?? null,
        comment: input.comment,
        allowTerminal: input.allowTerminal ?? true,
      });
      const operation = async (transaction: TaskSessionDbTransaction) => {
        await lockCompanyLifecycle(transaction, input.companyId);
        await assertProjectedCommentProducer(
          transaction,
          input,
          input.comment,
        );
        const retry = await findRetry(
          transaction,
          input,
          identityDigest,
          TaskSession.Event.ContextUpdated.type,
        );
        if (retry) return retry;
        const ids = await reserveStableMessageIdentity(
          transaction,
          input,
          stableIds,
        );
        await assertCanonicalScope(transaction, input, {
          allowTerminal: input.allowTerminal ?? true,
          dispatching: false,
        });
        await hooks.assertImmutableSource?.(transaction, input);
        return appendNonDispatchEvent(transaction, input, {
          user: false,
          identityDigest,
          ids,
          clock,
        });
      };
      return dbTransaction
        ? operation(dbTransaction)
        : db.transaction(operation);
    },

    appendNonDispatchSyntheticComment(input, dbTransaction) {
      assertSourceIdentity(input);
      assertProjectedCommentSourceShape(input.comment);
      if (
        !Number.isInteger(input.ownershipEpoch) ||
        input.ownershipEpoch < 1 ||
        !input.agentId ||
        !input.adapterConfigRevisionId ||
        !input.runId ||
        input.comment.author.agentId !== input.agentId ||
        input.comment.producingRun.runId !== input.runId ||
        input.comment.producingRun.adapterConfigRevisionId !==
          input.adapterConfigRevisionId
      ) {
        throw new TaskSessionLifecycleConflict(
          "Non-dispatch synthetic source has an invalid run binding",
        );
      }
      const stableIds = stableIdentityForSource(input);
      const identityDigest = digest({
        contract: "non-dispatch-synthetic/v1",
        companyId: input.companyId,
        taskId: input.taskId,
        sessionId: input.sessionId,
        sourceKind: input.sourceKind,
        immutableSourceKey: input.immutableSourceKey,
        sourceRecordId: input.sourceRecordId,
        exactText: input.exactText,
        ownershipEpoch: input.ownershipEpoch,
        agentId: input.agentId,
        adapterConfigRevisionId: input.adapterConfigRevisionId,
        runId: input.runId,
        actor: input.actor ?? null,
        counterpartTaskId: input.counterpartTaskId ?? null,
        counterpartAuthorityId: input.counterpartAuthorityId ?? null,
        counterpartOwnershipEpoch:
          input.counterpartOwnershipEpoch ?? null,
        projectionKind: input.projectionKind ?? "task_update",
        comment: input.comment,
      });
      const operation = async (transaction: TaskSessionDbTransaction) => {
        await lockCompanyLifecycle(transaction, input.companyId);
        await assertProjectedCommentProducer(
          transaction,
          input,
          input.comment,
        );
        const retry = await findRetry(
          transaction,
          input,
          identityDigest,
          TaskSession.Event.Synthetic.type,
        );
        if (retry) return retry;
        const ids = await reserveStableMessageIdentity(
          transaction,
          input,
          stableIds,
        );
        const { task } = await assertCanonicalScope(transaction, input, {
          allowTerminal: false,
          dispatching: false,
        });
        if (task.ownershipEpoch !== input.ownershipEpoch) {
          throw new TaskSessionLifecycleConflict(
            "Non-dispatch synthetic source ownership epoch is stale",
            { taskId: input.taskId },
          );
        }
        await hooks.assertImmutableSource?.(transaction, input);
        return appendNonDispatchSyntheticComment(transaction, input, {
          identityDigest,
          ids,
          clock,
        });
      };
      return dbTransaction
        ? operation(dbTransaction)
        : db.transaction(operation);
    },
  };
}
