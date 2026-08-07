import { createHash } from "node:crypto";
import {
  agentAdapterConfigRevisions,
  agents,
  companies,
  executionWorkspaces,
  issueComments,
  issueConsultExecutions,
  issueExecutionAuthorities,
  issueExecutionHistoryViews,
  issueExecutionLanes,
  issueExecutionRefs,
  issueExecutionWorkspaceBindings,
  issues,
  issueSessionContextEpochs,
  issueSessionEvents,
  issueSessionInputs,
  issueSessions,
  type Db,
} from "@paperclipai/db";
import * as IssueSession from "@paperclipai/shared/issue-session";
import type {
  IssueExecutionRefMode,
  IssueExecutionRefSourceKind,
} from "@paperclipai/shared";
import {
  encodeIssueSessionEvent,
  type IssueSessionEventType,
} from "@paperclipai/shared/issue-session";
import {
  and,
  eq,
  lt,
  sql,
} from "drizzle-orm";
import { evaluateAgentInvokability } from "../agent-invokability.js";
import { readIssueExecutionRun } from "../issue-execution-run-service.js";
import type { IssueSessionCommentProjectionInput } from "./projector.js";
import {
  canonicalIssueSessionJson,
  IssueSessionInvariantError,
  IssueSessionLifecycleConflict,
  type IssueSessionCommentAuthor,
  type IssueSessionSourceClaim,
} from "./store.js";
import {
  decodeStoredIssueSessionEvent,
  reserveIssueSessionEventSequence,
  reserveIssueSessionMessageId,
  type IssueSessionDbTransaction,
} from "./event-store.js";
import {
  publishIssueSessionEventInTx,
  type PublishIssueSessionEventInput,
} from "./publication.js";
import {
  isServerAdapterImplementationAvailable,
} from "../../adapters/registry.js";

export interface DispatchExecutionScope {
  companyId: string;
  issueId: string;
  sessionId: string;
  ownershipEpoch: number;
  targetAgentId: string;
  issueExecutionAuthorityId: string | null;
  consultExecutionId: string | null;
  adapterConfigRevisionId: string;
  contextEpoch: number;
  mode: IssueExecutionRefMode;
  executionScopeId?: string;
  executionLineageId?: string;
  counterpartIssueId?: string | null;
  counterpartAuthorityId?: string | null;
  counterpartOwnershipEpoch?: number | null;
  consultCallerRefId?: string | null;
  consultChainToken?: string | null;
}

export interface IssueSessionSourceIdentity {
  sourceKind: IssueExecutionRefSourceKind | string;
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
export type IssueSessionExecutionActor =
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
  IssueSessionExecutionActor,
  { kind: "user/board" }
>;
type AgentExecutionActor = Extract<
  IssueSessionExecutionActor,
  { kind: "agent-execution" }
>;
type PluginExecutionActor = Extract<
  IssueSessionExecutionActor,
  { kind: "plugin" }
>;
type RoutineExecutionActor = Extract<
  IssueSessionExecutionActor,
  { kind: "routine" }
>;
type SystemExecutionActor = Extract<
  IssueSessionExecutionActor,
  { kind: "system" }
>;

/**
 * Closed source/actor contract for every Session source that can cause
 * provider work. Source kind and immutable actor provenance jointly determine
 * its V2 message kind; a producer cannot select user/synthetic/system or an
 * admission branch independently.
 */
export type IssueSessionExecutionSource =
  | {
      sourceKind: "issue_request";
      actor: IssueSessionExecutionActor;
    }
  | {
      sourceKind: "issue_reassignment";
      actor:
        | UserOrBoardExecutionActor
        | AgentExecutionActor
        | PluginExecutionActor;
    }
  | {
      sourceKind: "issue_reopen" | "board_chat" | "human_comment_mention";
      actor: UserOrBoardExecutionActor;
    }
  | {
      sourceKind: "routine_dispatch";
      actor: RoutineExecutionActor;
    }
  | {
      sourceKind: "issue_update";
      actor: IssueSessionExecutionActor;
    }
  | {
      sourceKind: "consult_mention";
      actor: AgentExecutionActor;
    }
  | {
      sourceKind:
        | "system_nudge"
        | "termination_recovery"
        | "agent_liveness_followup";
      actor: SystemExecutionActor;
    }
  | {
      sourceKind: "human_active_run_steering";
      actor: UserOrBoardExecutionActor;
    }
  | {
      sourceKind: "agent_active_run_steering";
      actor: AgentExecutionActor;
    };

type IssueSessionAgentCommentAuthor = Extract<
  IssueSessionCommentAuthor,
  { kind: "agent" }
>;
type IssueSessionNonAgentCommentAuthor = Exclude<
  IssueSessionCommentAuthor,
  { kind: "agent" }
>;

/**
 * Immutable provenance for a projected comment. The producing run is
 * deliberately separate from DispatchExecutionScope: a parent/creator run
 * may author a comment whose new execution ref targets a different agent.
 */
export type IssueSessionProjectedCommentSource = (
  | {
      author: IssueSessionAgentCommentAuthor;
      producingRun: {
        runId: string;
        adapterConfigRevisionId: string;
      };
    }
  | {
      author: IssueSessionNonAgentCommentAuthor;
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
  IssueSessionSourceIdentity & {
    comment: IssueSessionProjectedCommentSource | null;
    idempotencyKey: string;
  };

/**
 * Reassignment is the sole ref source with an outgoing ownership epoch. The
 * discriminated input keeps that provenance mandatory at every producer and
 * unrepresentable on every other dispatching user source.
 */
export type DispatchingExecutionSourceInput =
  | (DispatchingExecutionSourceBase &
      Extract<IssueSessionExecutionSource, { sourceKind: "issue_reassignment" }> & {
      sourceKind: "issue_reassignment";
      previousOwnershipEpoch: number;
    })
  | (DispatchingExecutionSourceBase &
      Exclude<
        IssueSessionExecutionSource,
        | { sourceKind: "issue_reassignment" }
        | { sourceKind: "human_active_run_steering" }
        | { sourceKind: "agent_active_run_steering" }
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
  sources: readonly DispatchingExecutionSourceInput[];
}

export interface NonDispatchUserComment
  extends IssueSessionSourceIdentity {
  companyId: string;
  issueId: string;
  sessionId: string;
  sourceKind: string;
  delivery?: "queue";
  comment: {
    author: Extract<IssueSessionCommentAuthor, { kind: "user" }>;
    producingRun: null;
    replyToCommentId?: string | null;
    steeringSegment?: null;
  };
}

/**
 * Human-authored input admitted for one already-selected active run. It owns
 * a canonical Session inbox row and comment but deliberately creates no
 * IssueExecutionRef: the run service binds that input to one positive prompt
 * segment in the same transaction.
 */
export type SteeringComment = IssueSessionSourceIdentity & {
  companyId: string;
  issueId: string;
  sessionId: string;
} & (
  | (Extract<
      IssueSessionExecutionSource,
      { sourceKind: "human_active_run_steering" }
    > & {
      sourceKind: "human_active_run_steering";
      comment: {
        author: Extract<IssueSessionCommentAuthor, { kind: "user" }>;
        producingRun: null;
        replyToCommentId?: string | null;
        steeringSegment?: null;
      };
    })
  | (Extract<
      IssueSessionExecutionSource,
      { sourceKind: "agent_active_run_steering" }
    > & {
      sourceKind: "agent_active_run_steering";
      comment: {
        author: IssueSessionAgentCommentAuthor;
        producingRun: {
          runId: string;
          adapterConfigRevisionId: string;
        };
        replyToCommentId?: string | null;
        steeringSegment?: null;
      };
    })
);

export interface NonDispatchControlNotice
  extends IssueSessionSourceIdentity {
  companyId: string;
  issueId: string;
  sessionId: string;
  sourceKind: string;
  actor?: IssueSessionExecutionActor;
  counterpartIssueId?: string | null;
  counterpartAuthorityId?: string | null;
  counterpartOwnershipEpoch?: number | null;
  comment: IssueSessionProjectedCommentSource | null;
  allowTerminal?: boolean;
}

export interface NonDispatchSyntheticComment
  extends IssueSessionSourceIdentity {
  companyId: string;
  issueId: string;
  sessionId: string;
  sourceKind: string;
  projectionKind?:
    | "issue_update"
    | "harness_delivery"
    | "run_progress";
  ownershipEpoch: number;
  agentId: string;
  adapterConfigRevisionId: string;
  runId: string;
  actor?: IssueSessionExecutionActor;
  counterpartIssueId?: string | null;
  counterpartAuthorityId?: string | null;
  counterpartOwnershipEpoch?: number | null;
  comment: Extract<
    IssueSessionProjectedCommentSource,
    { author: IssueSessionAgentCommentAuthor }
  >;
}

type EventRow = typeof issueSessionEvents.$inferSelect;
type RefRow = typeof issueExecutionRefs.$inferSelect;
type InputRow = typeof issueSessionInputs.$inferSelect;
type ViewRow = typeof issueExecutionHistoryViews.$inferSelect;
type CommentRow = typeof issueComments.$inferSelect;

export interface IssueSessionAdmissionResult {
  source: IssueSessionSourceClaim;
  ref: RefRow | null;
  input: InputRow | null;
  view: ViewRow | null;
  comment: CommentRow | null;
  event: EventRow;
  eventSeq: number;
  retried: boolean;
}

export interface IssueSessionAdmissionHooks {
  /**
   * Source tables are heterogeneous. A producer can require its immutable
   * causal row to be locked and checked here; admission has already locked
   * company/issue/Session and will fail the whole admission on rejection.
   */
  assertImmutableSource?(
    transaction: IssueSessionDbTransaction,
    input:
      | DispatchingExecutionSourceInput
      | SteeringComment
      | NonDispatchUserComment
      | NonDispatchControlNotice
      | NonDispatchSyntheticComment,
  ): Promise<void>;
}

export interface IssueSessionAdmissionService {
  admitExecutionSource(
    input: DispatchingExecutionSourceInput,
    transaction?: IssueSessionDbTransaction,
  ): Promise<IssueSessionAdmissionResult>;
  admitExecutionSourceBatch(
    input: DispatchingExecutionSourceBatch,
    transaction?: IssueSessionDbTransaction,
  ): Promise<IssueSessionAdmissionResult[]>;
  appendNonDispatchUserComment(
    input: NonDispatchUserComment,
    transaction?: IssueSessionDbTransaction,
  ): Promise<IssueSessionAdmissionResult>;
  admitSteeringComment(
    input: SteeringComment,
    transaction?: IssueSessionDbTransaction,
  ): Promise<IssueSessionAdmissionResult>;
  appendNonDispatchControlNotice(
    input: NonDispatchControlNotice,
    transaction?: IssueSessionDbTransaction,
  ): Promise<IssueSessionAdmissionResult>;
  appendNonDispatchSyntheticComment(
    input: NonDispatchSyntheticComment,
    transaction?: IssueSessionDbTransaction,
  ): Promise<IssueSessionAdmissionResult>;
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
  return canonicalIssueSessionJson(value);
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
    refId: deterministicUuid("issue-ref", key),
    historyViewId: deterministicUuid("history-view", key),
    commentId: deterministicUuid("issue-comment", key),
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
  transaction: IssueSessionDbTransaction,
  input: {
    companyId: string;
    issueId: string;
    sessionId: string;
    sourceKind: string;
    immutableSourceKey: string;
  },
  ids: Omit<StableIdentity, "messageId">,
): Promise<StableIdentity> {
  const messageId = await reserveIssueSessionMessageId(
    transaction,
    {
      companyId: input.companyId,
      issueId: input.issueId,
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
    throw new IssueSessionLifecycleConflict(
      "Canonical source identity fields must be non-empty",
      { sourceKind: input.sourceKind },
    );
  }
}

function assertNever(value: never, context: string): never {
  const runtimeValue = value as unknown;
  throw new IssueSessionLifecycleConflict(
    `Unclassified ${context} reached Issue Session admission`,
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
    throw new IssueSessionLifecycleConflict(
      `Execution source actor ${actorKind} requires immutable ${field}`,
      { actorKind, field },
    );
  }
}

function assertExecutionActor(
  actor: IssueSessionExecutionActor,
): void {
  if (!actor || typeof actor !== "object" || Array.isArray(actor)) {
    throw new IssueSessionLifecycleConflict(
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
  source: IssueSessionExecutionSource,
): void {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new IssueSessionLifecycleConflict(
      "Execution source must be a closed source/actor record",
    );
  }
  for (const producerOwnedKindField of [
    "eventKind",
    "messageKind",
    "delivery",
  ] as const) {
    if (Object.prototype.hasOwnProperty.call(source, producerOwnedKindField)) {
      throw new IssueSessionLifecycleConflict(
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
    case "issue_request":
    case "issue_update":
      return;
    case "issue_reassignment":
      if (
        source.actor.kind === "user/board" ||
        source.actor.kind === "agent-execution" ||
        source.actor.kind === "plugin"
      ) {
        return;
      }
      break;
    case "issue_reopen":
    case "board_chat":
    case "human_comment_mention":
    case "human_active_run_steering":
      if (source.actor.kind === "user/board") return;
      break;
    case "routine_dispatch":
      if (source.actor.kind === "routine") return;
      break;
    case "consult_mention":
    case "agent_active_run_steering":
      if (source.actor.kind === "agent-execution") return;
      break;
    case "system_nudge":
    case "termination_recovery":
    case "agent_liveness_followup":
      if (source.actor.kind === "system") return;
      break;
    default:
      return assertNever(source, "execution source");
  }
  throw new IssueSessionLifecycleConflict(
    "Execution source actor does not match its immutable source kind",
    {
      sourceKind: source.sourceKind,
      actorKind: source.actor.kind,
    },
  );
}

/**
 * Sole lowering from immutable source provenance to the V2 Session kind used
 * for provider-bound work. `system` is intentionally absent: it belongs only
 * to explicit provider-free control notices and can never back an execution
 * ref.
 */
export function v2MessageKindForExecutionSource(
  source: IssueSessionExecutionSource,
): "user" | "synthetic" {
  assertExecutionSourceActorPair(source);
  switch (source.sourceKind) {
    case "issue_request":
    case "issue_reassignment":
    case "issue_reopen":
    case "board_chat":
    case "human_comment_mention":
    case "routine_dispatch":
    case "human_active_run_steering":
      return "user";
    case "issue_update":
      return source.actor.kind === "user/board"
        ? "user"
        : "synthetic";
    case "consult_mention":
    case "system_nudge":
    case "termination_recovery":
    case "agent_liveness_followup":
    case "agent_active_run_steering":
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
    issueId: input.issueId,
    sessionId: input.sessionId,
    ownershipEpoch: input.ownershipEpoch,
    previousOwnershipEpoch: previousOwnershipEpochForDispatchSource(input),
    targetAgentId: input.targetAgentId,
    issueExecutionAuthorityId: input.issueExecutionAuthorityId,
    consultExecutionId: input.consultExecutionId,
    adapterConfigRevisionId: input.adapterConfigRevisionId,
    contextEpoch: input.contextEpoch,
    mode: input.mode,
    executionScopeId: input.executionScopeId ?? null,
    executionLineageId: input.executionLineageId ?? null,
    counterpartIssueId: input.counterpartIssueId ?? null,
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
  if (input.sourceKind === "issue_reassignment") {
    if (
      !Number.isSafeInteger(input.previousOwnershipEpoch) ||
      input.previousOwnershipEpoch! < 1 ||
      input.previousOwnershipEpoch !== input.ownershipEpoch - 1
    ) {
      throw new IssueSessionLifecycleConflict(
        "Issue reassignment must preserve the exact immediately previous ownership epoch",
        {
          ownershipEpoch: input.ownershipEpoch,
          previousOwnershipEpoch: input.previousOwnershipEpoch ?? null,
        },
      );
    }
    return input.previousOwnershipEpoch;
  }
  if (input.previousOwnershipEpoch != null) {
    throw new IssueSessionLifecycleConflict(
      "Only issue reassignment may carry a previous ownership epoch",
      { sourceKind: input.sourceKind ?? null },
    );
  }
  return null;
}

function commentInsert(author: IssueSessionCommentAuthor, body: string) {
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
): IssueSessionCommentProjectionInput["sourceKind"] {
  return sourceKind === "board_chat" ||
    sourceKind === "human_comment_mention" ||
    sourceKind === "issue_update"
    ? "human_comment"
    : "issue_request";
}

function directProjectionKind(
  sourceKind: string,
): IssueSessionCommentProjectionInput["sourceKind"] {
  if (sourceKind === "issue_update") return "issue_update";
  return "harness_delivery";
}

type IssueCommentReplyProjection = Pick<
  IssueSessionCommentProjectionInput["comment"],
  | "replyToCommentId"
  | "replyToProjectedEventSeq"
  | "threadRootCommentId"
  | "threadRootProjectedEventSeq"
>;

const TOP_LEVEL_REPLY_PROJECTION: IssueCommentReplyProjection = {
  replyToCommentId: null,
  replyToProjectedEventSeq: null,
  threadRootCommentId: null,
  threadRootProjectedEventSeq: null,
};

export async function resolveIssueCommentReplyProjection(
  transaction: IssueSessionDbTransaction,
  scope: { companyId: string; issueId: string; sessionId: string },
  replyToCommentId: string | null | undefined,
): Promise<IssueCommentReplyProjection> {
  if (replyToCommentId == null) return TOP_LEVEL_REPLY_PROJECTION;
  const parents = await transaction
    .select({
      id: issueComments.id,
      projectedEventSeq: issueComments.projectedEventSeq,
      replyToCommentId: issueComments.replyToCommentId,
      replyToProjectedEventSeq: issueComments.replyToProjectedEventSeq,
      threadRootCommentId: issueComments.threadRootCommentId,
      threadRootProjectedEventSeq: issueComments.threadRootProjectedEventSeq,
    })
    .from(issueComments)
    .where(
      and(
        eq(issueComments.companyId, scope.companyId),
        eq(issueComments.issueId, scope.issueId),
        eq(issueComments.sessionId, scope.sessionId),
        eq(issueComments.id, replyToCommentId),
      ),
    )
    .limit(2)
    .for("update");
  const parent = parents.length === 1 ? parents[0]! : null;
  if (!parent) {
    throw new IssueSessionLifecycleConflict(
      "Reply parent is missing from the canonical issue Session",
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
    throw new IssueSessionInvariantError(
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
  sourceKind: IssueSessionCommentProjectionInput["sourceKind"];
  sourceId: string;
  messageId: string;
  commentId: string;
  body: string;
  author: IssueSessionCommentAuthor;
  reply: IssueCommentReplyProjection;
  steeringSegment?: IssueSessionProjectedCommentSource["steeringSegment"];
}): IssueSessionCommentProjectionInput {
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
  comment: IssueSessionProjectedCommentSource,
): void {
  const hasProducingRun =
    comment.producingRun !== null &&
    typeof comment.producingRun.runId === "string" &&
    comment.producingRun.runId.length > 0 &&
    typeof comment.producingRun.adapterConfigRevisionId === "string" &&
    comment.producingRun.adapterConfigRevisionId.length > 0;
  if ((comment.author.kind === "agent") !== hasProducingRun) {
    throw new IssueSessionLifecycleConflict(
      "Agent comments require their producing run and non-agent comments must be runless",
      { authorKind: comment.author.kind },
    );
  }
}

function assertExecutionSourceCommentProvenance(
  input: DispatchingExecutionSourceInput | SteeringComment,
): void {
  const messageKind = v2MessageKindForExecutionSource(input);
  if (!input.comment) {
    if (messageKind === "user") {
      throw new IssueSessionLifecycleConflict(
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
    throw new IssueSessionLifecycleConflict(
      "Execution source projected author does not match immutable actor provenance",
      {
        sourceKind: input.sourceKind,
        actorKind: actor.kind,
        authorKind: author.kind,
      },
    );
  }
}

type ProjectedCommentProducerScope = {
  readonly companyId: string;
  readonly issueId: string;
  readonly sessionId: string;
  readonly sourceKind?: string;
  readonly actor?: IssueSessionExecutionActor;
  readonly counterpartIssueId?: string | null;
  readonly counterpartAuthorityId?: string | null;
  readonly counterpartOwnershipEpoch?: number | null;
};

export async function isExactIssueUpdateCrossIssueProducer(
  transaction: IssueSessionDbTransaction,
  scope: ProjectedCommentProducerScope,
  comment: Exclude<IssueSessionProjectedCommentSource, { producingRun: null }>,
): Promise<boolean> {
  const counterpartIssueId = scope.counterpartIssueId ?? null;
  const counterpartAuthorityId = scope.counterpartAuthorityId ?? null;
  const counterpartOwnershipEpoch =
    scope.counterpartOwnershipEpoch ?? null;
  if (
    scope.sourceKind !== "issue_update" ||
    scope.actor?.kind !== "agent-execution" ||
    counterpartIssueId === null ||
    counterpartAuthorityId === null ||
    counterpartOwnershipEpoch === null ||
    !Number.isSafeInteger(counterpartOwnershipEpoch) ||
    counterpartOwnershipEpoch < 1 ||
    counterpartIssueId === scope.issueId ||
    scope.actor.authorityId !== counterpartAuthorityId ||
    scope.actor.agentId !== comment.author.agentId
  ) {
    return false;
  }

  await assertCounterpart(transaction, scope);
  const [target, sourceIssue, producer] = await Promise.all([
    transaction
      .select({
        parentId: issues.parentId,
        parentOwnershipEpoch: issues.parentOwnershipEpoch,
        ownershipEpoch: issues.ownershipEpoch,
        creatorKind: issues.creatorKind,
        creatorAuthorityId: issues.creatorAuthorityId,
        creatorAdapterConfigRevisionId: issues.creatorAdapterConfigRevisionId,
      })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, scope.companyId),
          eq(issues.id, scope.issueId),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null),
    transaction
      .select({
        parentId: issues.parentId,
        parentOwnershipEpoch: issues.parentOwnershipEpoch,
        ownershipEpoch: issues.ownershipEpoch,
      })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, scope.companyId),
          eq(issues.id, counterpartIssueId),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null),
    readIssueExecutionRun(transaction, {
      companyId: scope.companyId,
      issueId: counterpartIssueId,
      runId: comment.producingRun.runId,
    }),
  ]);
  const parentToChild =
    target &&
    target.parentId === counterpartIssueId &&
    target.parentOwnershipEpoch === counterpartOwnershipEpoch &&
    target.creatorKind === "agent-execution" &&
    target.creatorAuthorityId === counterpartAuthorityId &&
    target.creatorAdapterConfigRevisionId ===
      comment.producingRun.adapterConfigRevisionId;
  const childToParent =
    target &&
    sourceIssue &&
    sourceIssue.parentId === scope.issueId &&
    sourceIssue.parentOwnershipEpoch === target.ownershipEpoch &&
    sourceIssue.ownershipEpoch === counterpartOwnershipEpoch;
  return Boolean(
    (parentToChild || childToParent) &&
      producer &&
      producer.kind === "productive" &&
      producer.status === "running" &&
      producer.executionMode === "owner" &&
      producer.ownershipEpoch === counterpartOwnershipEpoch &&
      producer.targetAgentId === comment.author.agentId &&
      producer.issueExecutionAuthorityId === counterpartAuthorityId &&
      producer.consultExecutionId === null &&
      producer.adapterConfigRevisionId ===
        comment.producingRun.adapterConfigRevisionId,
  );
}

async function assertProjectedCommentProducer(
  transaction: IssueSessionDbTransaction,
  scope: ProjectedCommentProducerScope,
  comment: IssueSessionProjectedCommentSource | null,
): Promise<void> {
  if (!comment || comment.producingRun === null) return;
  const producer = await readIssueExecutionRun(transaction, {
    companyId: scope.companyId,
    issueId: scope.issueId,
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
  if (await isExactIssueUpdateCrossIssueProducer(transaction, scope, comment)) {
    return;
  }
  throw new IssueSessionLifecycleConflict(
    "Agent comment producing run, agent, and adapter revision do not match one canonical issue execution",
    {
      authorAgentId: comment.author.agentId,
      producingRunId: comment.producingRun.runId,
      producingAdapterConfigRevisionId:
        comment.producingRun.adapterConfigRevisionId,
    },
  );
}

function messageIdFromEvent(event: EventRow): string | null {
  const decoded = decodeStoredIssueSessionEvent(event).event;
  const wire = encodeIssueSessionEvent(decoded);
  const messageId = (wire.data as { messageID?: unknown }).messageID;
  return typeof messageId === "string" ? messageId : null;
}

function sourceClaim(
  event: EventRow,
  ref: RefRow | null,
  inbox: InputRow | null,
  view: ViewRow | null,
  comment: CommentRow | null,
): IssueSessionSourceClaim {
  if (
    !event.sourceKind ||
    !event.sourceId ||
    !event.immutableSourceKey ||
    !event.sourceIdentityDigest
  ) {
    throw new IssueSessionInvariantError(
      `Event ${event.id} is missing its canonical source envelope`,
    );
  }
  const messageId = messageIdFromEvent(event);
  if (!messageId) {
    throw new IssueSessionInvariantError(
      `Event ${event.id} is missing its Issue Session message identity`,
    );
  }
  return {
    key: `${event.sessionId}\0${event.sourceKind}\0${event.immutableSourceKey}`,
    companyId: event.companyId,
    issueId: event.issueId,
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
  transaction: IssueSessionDbTransaction,
  event: EventRow,
  retried: boolean,
): Promise<IssueSessionAdmissionResult> {
  const messageId = messageIdFromEvent(event);
  const [refs, inputs, comments] = await Promise.all([
    event.sourceId
      ? transaction
          .select()
          .from(issueExecutionRefs)
          .where(
            and(
              eq(issueExecutionRefs.sessionId, event.sessionId),
              eq(issueExecutionRefs.sourceId, event.sourceId),
            ),
          )
          .limit(1)
      : Promise.resolve([]),
    messageId
      ? transaction
          .select()
          .from(issueSessionInputs)
          .where(
            and(
              eq(issueSessionInputs.sessionId, event.sessionId),
              eq(issueSessionInputs.id, messageId),
            ),
          )
          .limit(1)
      : Promise.resolve([]),
    event.sourceId
      ? transaction
          .select()
          .from(issueComments)
          .where(
            and(
              eq(issueComments.sessionId, event.sessionId),
              eq(issueComments.canonicalSourceId, event.sourceId),
            ),
          )
          .limit(1)
      : Promise.resolve([]),
  ]);
  const ref = refs[0] ?? null;
  const views = ref
    ? await transaction
        .select()
        .from(issueExecutionHistoryViews)
        .where(eq(issueExecutionHistoryViews.id, ref.historyViewId))
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
  transaction: IssueSessionDbTransaction,
  input: {
    sessionId: string;
    sourceKind: string;
    immutableSourceKey: string;
    sourceRecordId: string;
  },
  identityDigest: string,
  expectedType: IssueSessionEventType,
): Promise<IssueSessionAdmissionResult | null> {
  const rows = await transaction
    .select()
    .from(issueSessionEvents)
    .where(
      and(
        eq(issueSessionEvents.sessionId, input.sessionId),
        eq(issueSessionEvents.sourceKind, input.sourceKind),
        eq(issueSessionEvents.immutableSourceKey, input.immutableSourceKey),
      ),
    )
    .limit(1);
  const event = rows[0];
  if (!event) return null;
  if (
    event.sourceIdentityDigest !== identityDigest ||
    event.sourceRecordId !== input.sourceRecordId ||
    decodeStoredIssueSessionEvent(event).event.type !== expectedType
  ) {
    throw new IssueSessionLifecycleConflict(
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
  transaction: IssueSessionDbTransaction,
  input: {
    companyId: string;
    issueId: string;
    sessionId: string;
  },
): Promise<void> {
  await lockCompanyLifecycle(transaction, input.companyId);
  await transaction.execute(sql`
    SELECT id
    FROM issues
    WHERE company_id = ${input.companyId}
      AND id = ${input.issueId}
    FOR UPDATE
  `);
  await transaction.execute(sql`
    SELECT id
    FROM issue_sessions
    WHERE company_id = ${input.companyId}
      AND issue_id = ${input.issueId}
      AND id = ${input.sessionId}
    FOR UPDATE
  `);
}

async function lockCompanyLifecycle(
  transaction: IssueSessionDbTransaction,
  companyId: string,
): Promise<void> {
  const rows = await transaction
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1)
    .for("update");
  if (!rows[0]) {
    throw new IssueSessionLifecycleConflict(
      "Issue Session company scope does not exist",
      { companyId },
    );
  }
}

async function assertCanonicalScope(
  transaction: IssueSessionDbTransaction,
  input: {
    companyId: string;
    issueId: string;
    sessionId: string;
  },
  options: {
    allowTerminal: boolean;
    dispatching: boolean;
  },
): Promise<{
  issue: typeof issues.$inferSelect;
  session: typeof issueSessions.$inferSelect;
}> {
  await lockCanonicalScope(transaction, input);
  const [companyRows, issueRows, sessionRows] = await Promise.all([
    transaction
      .select()
      .from(companies)
      .where(eq(companies.id, input.companyId))
      .limit(1),
    transaction
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, input.companyId),
          eq(issues.id, input.issueId),
        ),
      )
      .limit(1),
    transaction
      .select()
      .from(issueSessions)
      .where(
        and(
          eq(issueSessions.companyId, input.companyId),
          eq(issueSessions.issueId, input.issueId),
          eq(issueSessions.id, input.sessionId),
        ),
      )
      .limit(1),
  ]);
  const company = companyRows[0];
  const issue = issueRows[0];
  const session = sessionRows[0];
  if (
    !company ||
    company.status !== "active" ||
    company.sessionIntegrityState !== "ready" ||
    company.hardDeleteFencedAt !== null
  ) {
    throw new IssueSessionLifecycleConflict(
      "Company is not ready for canonical Session admission",
      { companyId: input.companyId },
    );
  }
  if (!issue || issue.hiddenAt !== null) {
    throw new IssueSessionLifecycleConflict("Issue Session scope is invalid", {
      ...input,
    });
  }
  const terminal =
    issue.lifecycleStatus === "done" ||
    issue.lifecycleStatus === "cancelled";
  if (
    issue.lifecycleStatus === null ||
    (!options.allowTerminal &&
      !inArrayValue(issue.lifecycleStatus, ["open", "blocked"])) ||
    (options.dispatching && terminal)
  ) {
    throw new IssueSessionLifecycleConflict(
      "Issue lifecycle does not accept this Session source",
      {
        issueId: input.issueId,
        lifecycleStatus: issue.lifecycleStatus,
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
    throw new IssueSessionLifecycleConflict(
      "Canonical Session is missing, not ready, or lifecycle-fenced",
      { ...input },
    );
  }
  return { issue, session };
}

function inArrayValue<T>(value: T, values: readonly T[]): boolean {
  return values.includes(value);
}

async function assertWorkspaceBinding(
  transaction: IssueSessionDbTransaction,
  input: DispatchExecutionScope,
): Promise<void> {
  const rows = await transaction
    .select({
      binding: issueExecutionWorkspaceBindings,
      workspace: executionWorkspaces,
    })
    .from(issueExecutionWorkspaceBindings)
    .innerJoin(
      executionWorkspaces,
      and(
        eq(
          executionWorkspaces.id,
          issueExecutionWorkspaceBindings.executionWorkspaceId,
        ),
        eq(
          executionWorkspaces.companyId,
          issueExecutionWorkspaceBindings.companyId,
        ),
      ),
    )
    .where(
      and(
        eq(issueExecutionWorkspaceBindings.companyId, input.companyId),
        eq(issueExecutionWorkspaceBindings.issueId, input.issueId),
        eq(issueExecutionWorkspaceBindings.sessionId, input.sessionId),
        eq(
          issueExecutionWorkspaceBindings.ownershipEpoch,
          input.ownershipEpoch,
        ),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (
    !row ||
    row.workspace.status !== "active" ||
    row.workspace.closedAt !== null ||
    !row.binding.absoluteCwd.startsWith("/")
  ) {
    throw new IssueSessionLifecycleConflict(
      "Issue execution has no current immutable workspace binding",
      {
        issueId: input.issueId,
        ownershipEpoch: input.ownershipEpoch,
      },
    );
  }
}

async function assertCounterpart(
  transaction: IssueSessionDbTransaction,
  input: Pick<
    DispatchExecutionScope,
    | "companyId"
    | "issueId"
    | "counterpartIssueId"
    | "counterpartAuthorityId"
    | "counterpartOwnershipEpoch"
  >,
): Promise<void> {
  const counterpart = [
    input.counterpartIssueId ?? null,
    input.counterpartAuthorityId ?? null,
    input.counterpartOwnershipEpoch ?? null,
  ];
  const present = counterpart.filter((value) => value !== null).length;
  if (present !== 0 && present !== 3) {
    throw new IssueSessionLifecycleConflict(
      "Counterpart authority identity must be all present or all absent",
      { issueId: input.issueId },
    );
  }
  if (present === 0) return;
  const rows = await transaction
    .select()
    .from(issueExecutionAuthorities)
    .where(
      and(
        eq(issueExecutionAuthorities.companyId, input.companyId),
        eq(issueExecutionAuthorities.issueId, input.counterpartIssueId!),
        eq(
          issueExecutionAuthorities.ownershipEpoch,
          input.counterpartOwnershipEpoch!,
        ),
        eq(issueExecutionAuthorities.id, input.counterpartAuthorityId!),
        eq(issueExecutionAuthorities.state, "current"),
      ),
    )
    .limit(1);
  if (!rows[0]) {
    throw new IssueSessionLifecycleConflict(
      "Counterpart authority is missing, revoked, or superseded",
      { counterpartAuthorityId: input.counterpartAuthorityId },
    );
  }
}

async function assertDispatchScope(
  transaction: IssueSessionDbTransaction,
  input: DispatchExecutionScope,
  executionScopeId: string,
): Promise<ValidatedDispatchScope> {
  const { issue, session } = await assertCanonicalScope(transaction, input, {
    allowTerminal: false,
    dispatching: true,
  });
  if (
    !Number.isInteger(input.ownershipEpoch) ||
    input.ownershipEpoch <= 0 ||
    issue.ownershipEpoch !== input.ownershipEpoch
  ) {
    throw new IssueSessionLifecycleConflict(
      "Issue execution epoch or Session context epoch is stale",
      {
        issueId: input.issueId,
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
      .select()
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
      .from(issueSessionContextEpochs)
      .where(
        and(
          eq(issueSessionContextEpochs.companyId, input.companyId),
          eq(issueSessionContextEpochs.issueId, input.issueId),
          eq(issueSessionContextEpochs.sessionId, input.sessionId),
          eq(issueSessionContextEpochs.generation, input.contextEpoch),
        ),
      )
      .limit(1),
  ]);
  const target = companyAgentRows.find((row) => row.id === input.targetAgentId);
  const invokability = evaluateAgentInvokability(target, companyAgentRows);
  if (!invokability.invokable) {
    throw new IssueSessionLifecycleConflict(
      "Target agent is not invokable",
      { targetAgentId: input.targetAgentId, ...invokability.details },
    );
  }
  if (
    !revisionRows[0] ||
    target?.currentAdapterConfigRevisionId !== input.adapterConfigRevisionId
  ) {
    throw new IssueSessionLifecycleConflict(
      "Target adapter configuration revision is missing or no longer current",
      {
        targetAgentId: input.targetAgentId,
        adapterConfigRevisionId: input.adapterConfigRevisionId,
      },
    );
  }
  const pinnedRevision = revisionRows[0];
  if (
    !isServerAdapterImplementationAvailable(
      pinnedRevision.adapterType,
      pinnedRevision.implementationIdentity,
    )
  ) {
    throw new IssueSessionLifecycleConflict(
      "Target adapter implementation is unavailable",
      {
        targetAgentId: input.targetAgentId,
        adapterConfigRevisionId: input.adapterConfigRevisionId,
        adapterType: pinnedRevision.adapterType,
        implementationIdentity: pinnedRevision.implementationIdentity,
      },
    );
  }
  if (!contextRows[0]) {
    throw new IssueSessionLifecycleConflict(
      "Session context epoch binding is missing",
      { sessionId: input.sessionId, contextEpoch: input.contextEpoch },
    );
  }

  if (input.mode === "owner") {
    if (
      input.issueExecutionAuthorityId === null ||
      input.consultExecutionId !== null ||
      issue.ownerKind !== "agent" ||
      issue.ownerAgentId !== input.targetAgentId ||
      input.consultCallerRefId != null ||
      input.consultChainToken != null
    ) {
      throw new IssueSessionLifecycleConflict(
        "Owner execution scope does not match the current issue owner",
        { issueId: input.issueId, targetAgentId: input.targetAgentId },
      );
    }
    const authorityRows = await transaction
      .select()
      .from(issueExecutionAuthorities)
      .where(
        and(
          eq(issueExecutionAuthorities.companyId, input.companyId),
          eq(issueExecutionAuthorities.issueId, input.issueId),
          eq(issueExecutionAuthorities.sessionId, input.sessionId),
          eq(
            issueExecutionAuthorities.ownershipEpoch,
            input.ownershipEpoch,
          ),
          eq(issueExecutionAuthorities.agentId, input.targetAgentId),
          eq(
            issueExecutionAuthorities.id,
            input.issueExecutionAuthorityId,
          ),
          eq(issueExecutionAuthorities.state, "current"),
        ),
      )
      .limit(1);
    if (!authorityRows[0]) {
      throw new IssueSessionLifecycleConflict(
        "Issue execution authority is missing, revoked, or stale",
        { issueExecutionAuthorityId: input.issueExecutionAuthorityId },
      );
    }
  } else if (input.mode === "consult") {
    if (
      input.issueExecutionAuthorityId !== null ||
      input.consultExecutionId === null ||
      input.consultCallerRefId == null ||
      input.consultChainToken == null
    ) {
      throw new IssueSessionLifecycleConflict(
        "Consult execution scope is incomplete",
        { issueId: input.issueId },
      );
    }
    const consultRows = await transaction
      .select()
      .from(issueConsultExecutions)
      .where(
        and(
          eq(issueConsultExecutions.companyId, input.companyId),
          eq(issueConsultExecutions.issueId, input.issueId),
          eq(issueConsultExecutions.sessionId, input.sessionId),
          eq(issueConsultExecutions.id, input.consultExecutionId),
          eq(
            issueConsultExecutions.ownershipEpoch,
            input.ownershipEpoch,
          ),
          eq(issueConsultExecutions.targetAgentId, input.targetAgentId),
          eq(
            issueConsultExecutions.adapterConfigRevisionId,
            input.adapterConfigRevisionId,
          ),
          eq(
            issueConsultExecutions.sourceRefId,
            input.consultCallerRefId,
          ),
          eq(issueConsultExecutions.chainToken, input.consultChainToken),
          eq(issueConsultExecutions.state, "active"),
        ),
      )
      .limit(1);
    if (!consultRows[0]) {
      throw new IssueSessionLifecycleConflict(
        "Consult execution binding is missing, closed, or stale",
        { consultExecutionId: input.consultExecutionId },
      );
    }
  } else {
    throw new IssueSessionLifecycleConflict(
      "Issue execution mode must be owner or consult",
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
    issueId: input.issueId,
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
    issueExecutionAuthorityId: input.issueExecutionAuthorityId,
    consultExecutionId: input.consultExecutionId,
    adapterConfigRevisionId: input.adapterConfigRevisionId,
    contextEpoch: input.contextEpoch,
    historyViewId: ids.historyViewId,
    inputId,
    counterpartIssueId: input.counterpartIssueId ?? null,
    counterpartAuthorityId: input.counterpartAuthorityId ?? null,
    counterpartOwnershipEpoch: input.counterpartOwnershipEpoch ?? null,
    consultCallerRefId: input.consultCallerRefId ?? null,
    consultChainToken: input.consultChainToken ?? null,
    disposition: "active" as const,
    invalidationReason: null,
  };
}

export async function reserveIssueExecutionLaneOrdinalInTransaction(
  transaction: IssueSessionDbTransaction,
  input: Pick<
    DispatchExecutionScope,
    "companyId" | "issueId" | "ownershipEpoch" | "targetAgentId"
  >,
  now: Date,
): Promise<number> {
  const rows = await transaction
    .insert(issueExecutionLanes)
    .values({
      companyId: input.companyId,
      issueId: input.issueId,
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
        issueExecutionLanes.companyId,
        issueExecutionLanes.issueId,
        issueExecutionLanes.ownershipEpoch,
        issueExecutionLanes.targetAgentId,
      ],
      set: {
        nextOrdinal: sql`${issueExecutionLanes.nextOrdinal} + 1`,
        updatedAt: now,
      },
      setWhere: lt(issueExecutionLanes.nextOrdinal, Number.MAX_SAFE_INTEGER),
    })
    .returning({ nextOrdinal: issueExecutionLanes.nextOrdinal });
  const laneOrdinal = (rows[0]?.nextOrdinal ?? 0) - 1;
  if (!Number.isSafeInteger(laneOrdinal) || laneOrdinal < 0) {
    throw new IssueSessionInvariantError(
      "Issue execution lane did not reserve one canonical FIFO ordinal",
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
    issueId: input.issueId,
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
    issueId: string;
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
  comment: IssueSessionProjectedCommentSource | null = null,
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
    issueId: input.issueId,
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
  transaction: IssueSessionDbTransaction,
  input: {
    envelope: ReturnType<typeof sourceEnvelope>;
    seq: number;
    type: IssueSessionEventType;
    data: Record<string, unknown>;
    projection?: PublishIssueSessionEventInput["projection"];
  },
): Promise<EventRow> {
  const {
    id: _eventId,
    sessionId: _sessionId,
    ...envelope
  } = input.envelope;
  const published = await publishIssueSessionEventInTx(transaction, {
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
  transaction: IssueSessionDbTransaction,
  input: NonDispatchSyntheticComment,
  options: {
    identityDigest: string;
    ids: StableIdentity;
    clock: () => Date;
  },
): Promise<IssueSessionAdmissionResult> {
  const reply = await resolveIssueCommentReplyProjection(
    transaction,
    input,
    input.comment.replyToCommentId,
  );
  const retry = await findRetry(
    transaction,
    input,
    options.identityDigest,
    IssueSession.Event.Synthetic.type,
  );
  if (retry) return retry;
  const { seq } = await reserveIssueSessionEventSequence(
    transaction,
    input,
  );
  const now = options.clock();
  const type = IssueSession.Event.Synthetic.type;
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
        sourceKind: input.projectionKind ?? "issue_update",
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
  transaction: IssueSessionDbTransaction,
  input: DispatchingExecutionSourceInput,
  options: {
    ids: StableIdentity;
    identityDigest: string;
    contextEpochBaselineSeq: number;
    now: Date;
  },
): Promise<IssueSessionAdmissionResult> {
  const comment = input.comment;
  if (!comment) {
    throw new IssueSessionInvariantError(
      "User execution source reached persistence without its projected author",
    );
  }
  const reply = await resolveIssueCommentReplyProjection(
    transaction,
    input,
    comment.replyToCommentId,
  );
  const { highWaterSeq, seq } = await reserveIssueSessionEventSequence(
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
  const published = await publishIssueSessionEventInTx(transaction, {
    event: {
      id: options.ids.eventId,
      sessionId: input.sessionId,
      seq,
      type: IssueSession.Event.PromptAdmitted.type,
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
    .from(issueSessionInputs)
    .where(eq(issueSessionInputs.id, options.ids.messageId))
    .limit(1);
  if (!inboxRows[0]) {
    throw new IssueSessionInvariantError(
      "Issue Session projector failed to materialize admitted input",
    );
  }
  const laneOrdinal = await reserveIssueExecutionLaneOrdinalInTransaction(
    transaction,
    input,
    options.now,
  );
  const refRows = await transaction
    .insert(issueExecutionRefs)
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
    throw new IssueSessionInvariantError(
      "Issue Session admission failed to persist its execution ref",
    );
  }
  const viewRows = await transaction
    .insert(issueExecutionHistoryViews)
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
    throw new IssueSessionInvariantError(
      "Issue Session admission failed to persist its history view",
    );
  }
  return loadResult(transaction, eventRow, false);
}

async function admitSyntheticExecutionSource(
  transaction: IssueSessionDbTransaction,
  input: DispatchingExecutionSourceInput,
  ids: StableIdentity,
  identityDigest: string,
  contextEpochBaselineSeq: number,
  clock: () => Date,
): Promise<IssueSessionAdmissionResult> {
  const reply = input.comment
    ? await resolveIssueCommentReplyProjection(
        transaction,
        input,
        input.comment.replyToCommentId,
      )
    : TOP_LEVEL_REPLY_PROJECTION;
  const retry = await findRetry(
    transaction,
    input,
    identityDigest,
    IssueSession.Event.Synthetic.type,
  );
  if (retry) return retry;

  const { highWaterSeq: admissionHighWaterSeq, seq } =
    await reserveIssueSessionEventSequence(transaction, input);
  const now = clock();
  const sessionEvent = {
    id: ids.eventId,
    type: IssueSession.Event.Synthetic.type,
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
  const laneOrdinal = await reserveIssueExecutionLaneOrdinalInTransaction(
    transaction,
    input,
    now,
  );
  const refs = await transaction
    .insert(issueExecutionRefs)
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
    throw new IssueSessionInvariantError(
      "Direct Session admission failed to reserve its execution ref",
    );
  }
  const views = await transaction
    .insert(issueExecutionHistoryViews)
    .values({
      ...buildView(input, ids, contextEpochBaselineSeq, null),
      sourceHighWaterSeq: admissionHighWaterSeq,
      sourceAdmittedSeq: null,
      sourcePromotedSeq: null,
    })
    .returning();
  if (!views[0]) {
    throw new IssueSessionInvariantError(
      "Direct Session admission failed to reserve its history view",
    );
  }
  return loadResult(transaction, event, false);
}

async function appendNonDispatchEvent(
  transaction: IssueSessionDbTransaction,
  input: NonDispatchUserComment | NonDispatchControlNotice,
  options: {
    user: boolean;
    identityDigest: string;
    ids: StableIdentity;
    clock: () => Date;
  },
): Promise<IssueSessionAdmissionResult> {
  const sourceComment = options.user
    ? (input as NonDispatchUserComment).comment
    : (input as NonDispatchControlNotice).comment;
  const reply = sourceComment
    ? await resolveIssueCommentReplyProjection(
        transaction,
        input,
        sourceComment.replyToCommentId,
      )
    : TOP_LEVEL_REPLY_PROJECTION;
  const expectedType = options.user
    ? IssueSession.Event.Prompted.type
    : IssueSession.Event.ContextUpdated.type;
  const retry = await findRetry(
    transaction,
    input,
    options.identityDigest,
    expectedType,
  );
  if (retry) return retry;
  const { seq } = await reserveIssueSessionEventSequence(
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
            : input.sourceKind === "issue_update"
              ? "issue_update"
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
  transaction: IssueSessionDbTransaction,
  input: SteeringComment,
  options: {
    identityDigest: string;
    ids: StableIdentity;
    clock: () => Date;
  },
): Promise<IssueSessionAdmissionResult> {
  const messageKind = v2MessageKindForExecutionSource(input);
  const expectedType = messageKind === "user"
    ? IssueSession.Event.PromptAdmitted.type
    : IssueSession.Event.Synthetic.type;
  const retry = await findRetry(
    transaction,
    input,
    options.identityDigest,
    expectedType,
  );
  if (retry) return retry;
  const reply = await resolveIssueCommentReplyProjection(
    transaction,
    input,
    input.comment.replyToCommentId,
  );
  const { seq } = await reserveIssueSessionEventSequence(
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
  const published = await publishIssueSessionEventInTx(transaction, {
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

/** Owns physical Issue Session source admission and projection. */
export function createIssueSessionAdmissionService(
  db: Db,
  options: {
    clock?: () => Date;
    hooks?: IssueSessionAdmissionHooks;
  } = {},
): IssueSessionAdmissionService {
  const clock = options.clock ?? (() => new Date());
  const hooks = options.hooks ?? {};

  function assertDispatchingExecutionSource(
    input: DispatchingExecutionSourceInput,
  ): "user" | "synthetic" {
    assertSourceIdentity(input);
    assertExecutionSourceCommentProvenance(input);
    previousOwnershipEpochForDispatchSource(input);
    return v2MessageKindForExecutionSource(input);
  }

  async function admitExecutionSourceInTx(
    transaction: IssueSessionDbTransaction,
    input: DispatchingExecutionSourceInput,
  ): Promise<IssueSessionAdmissionResult> {
    const messageKind = assertDispatchingExecutionSource(input);
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
        ? IssueSession.Event.PromptAdmitted.type
        : IssueSession.Event.Synthetic.type,
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
      input.executionScopeId ?? ids.executionScopeId,
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
      assertDispatchingExecutionSource(input);
      const operation = async (transaction: IssueSessionDbTransaction) => {
        await lockCompanyLifecycle(transaction, input.companyId);
        return admitExecutionSourceInTx(transaction, input);
      };
      return dbTransaction
        ? operation(dbTransaction)
        : db.transaction(operation);
    },

    admitExecutionSourceBatch(input, dbTransaction) {
      if (!input.batchKey.trim()) {
        throw new IssueSessionLifecycleConflict(
          "Dispatching execution-source batch key must be non-empty",
        );
      }
      if (input.sources.length === 0) {
        throw new IssueSessionLifecycleConflict(
          "Dispatching execution-source batch must contain at least one source",
        );
      }
      for (const source of input.sources) {
        assertDispatchingExecutionSource(source);
      }
      const first = input.sources[0]!;
      const targetScope = {
        companyId: first.companyId,
        issueId: first.issueId,
        sessionId: first.sessionId,
        ownershipEpoch: first.ownershipEpoch,
        targetAgentId: first.targetAgentId,
        issueExecutionAuthorityId:
          first.issueExecutionAuthorityId,
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
          issueId: source.issueId,
          sessionId: source.sessionId,
          ownershipEpoch: source.ownershipEpoch,
          targetAgentId: source.targetAgentId,
          issueExecutionAuthorityId:
            source.issueExecutionAuthorityId,
          consultExecutionId: source.consultExecutionId,
          adapterConfigRevisionId:
            source.adapterConfigRevisionId,
          contextEpoch: source.contextEpoch,
          mode: source.mode,
          consultCallerRefId: source.consultCallerRefId ?? null,
          consultChainToken: source.consultChainToken ?? null,
        });
        if (eventTargetScope !== targetScopeJson) {
          throw new IssueSessionLifecycleConflict(
            "Dispatching execution-source batch crossed counterpart execution scopes",
          );
        }
        if (
          sourceKeys.has(source.immutableSourceKey) ||
          idempotencyKeys.has(source.idempotencyKey)
        ) {
          throw new IssueSessionLifecycleConflict(
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
      const executionLineageId = deterministicUuid(
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
          throw new IssueSessionLifecycleConflict(
            "Dispatching execution-source batch changed its stable execution grouping",
          );
        }
        return {
          ...source,
          executionScopeId,
          executionLineageId,
        };
      });
      const operation = async (transaction: IssueSessionDbTransaction) => {
        await lockCompanyLifecycle(transaction, first.companyId);
        const results: IssueSessionAdmissionResult[] = [];
        for (const source of grouped) {
          results.push(
            await admitExecutionSourceInTx(
              transaction,
              source,
            ),
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
        issueId: input.issueId,
        sessionId: input.sessionId,
        sourceKind: input.sourceKind,
        immutableSourceKey: input.immutableSourceKey,
        sourceRecordId: input.sourceRecordId,
        exactText: input.exactText,
        delivery: "queue",
        comment: input.comment,
      });
      const operation = async (transaction: IssueSessionDbTransaction) => {
        await lockCompanyLifecycle(transaction, input.companyId);
        const retry = await findRetry(
          transaction,
          input,
          identityDigest,
          IssueSession.Event.Prompted.type,
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
        issueId: input.issueId,
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
      const operation = async (transaction: IssueSessionDbTransaction) => {
        await lockCompanyLifecycle(transaction, input.companyId);
        const retry = await findRetry(
          transaction,
          input,
          identityDigest,
          messageKind === "user"
            ? IssueSession.Event.PromptAdmitted.type
            : IssueSession.Event.Synthetic.type,
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
        issueId: input.issueId,
        sessionId: input.sessionId,
        sourceKind: input.sourceKind,
        immutableSourceKey: input.immutableSourceKey,
        sourceRecordId: input.sourceRecordId,
        exactText: input.exactText,
        actor: input.actor ?? null,
        counterpartIssueId: input.counterpartIssueId ?? null,
        counterpartAuthorityId: input.counterpartAuthorityId ?? null,
        counterpartOwnershipEpoch:
          input.counterpartOwnershipEpoch ?? null,
        comment: input.comment,
        allowTerminal: input.allowTerminal ?? true,
      });
      const operation = async (transaction: IssueSessionDbTransaction) => {
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
          IssueSession.Event.ContextUpdated.type,
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
        throw new IssueSessionLifecycleConflict(
          "Non-dispatch synthetic source has an invalid run binding",
        );
      }
      const stableIds = stableIdentityForSource(input);
      const identityDigest = digest({
        contract: "non-dispatch-synthetic/v1",
        companyId: input.companyId,
        issueId: input.issueId,
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
        counterpartIssueId: input.counterpartIssueId ?? null,
        counterpartAuthorityId: input.counterpartAuthorityId ?? null,
        counterpartOwnershipEpoch:
          input.counterpartOwnershipEpoch ?? null,
        projectionKind: input.projectionKind ?? "issue_update",
        comment: input.comment,
      });
      const operation = async (transaction: IssueSessionDbTransaction) => {
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
          IssueSession.Event.Synthetic.type,
        );
        if (retry) return retry;
        const ids = await reserveStableMessageIdentity(
          transaction,
          input,
          stableIds,
        );
        const { issue } = await assertCanonicalScope(transaction, input, {
          allowTerminal: false,
          dispatching: false,
        });
        if (issue.ownershipEpoch !== input.ownershipEpoch) {
          throw new IssueSessionLifecycleConflict(
            "Non-dispatch synthetic source ownership epoch is stale",
            { issueId: input.issueId },
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
