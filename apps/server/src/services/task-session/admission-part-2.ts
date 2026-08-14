import * as admissionCore from "./admission-part-1.js";
import { reserveTaskSessionMessageId, type TaskSessionDbTransaction } from "./event-store.js";
import type { TaskSessionCommentProjectionInput } from "./projector.js";
import { TaskSessionLifecycleConflict, type TaskSessionCommentAuthor } from "./store.js";

export function stableIdentity(
  sessionId: string,
  sourceKind: string,
  immutableSourceKey: string,
): Omit<admissionCore.StableIdentity, "messageId"> {
  const key = `${sessionId}\0${sourceKind}\0${immutableSourceKey}`;
  const short = admissionCore.digest({ key }).slice(0, 40);
  return {
    sourceId: `src_${short}`,
    eventId: `evt_${short}`,
    refId: admissionCore.deterministicUuid("task-ref", key),
    historyViewId: admissionCore.deterministicUuid("history-view", key),
    commentId: admissionCore.deterministicUuid("task-comment", key),
    dispositionId: admissionCore.deterministicUuid("input-disposition", key),
    executionScopeId: admissionCore.deterministicUuid("execution-scope", key),
    executionLineageId: admissionCore.deterministicUuid("execution-lineage", key),
  };
}

export function stableIdentityForSource(input: {
  sessionId: string;
  sourceKind: string;
  immutableSourceKey: string;
}): Omit<admissionCore.StableIdentity, "messageId"> {
  return stableIdentity(input.sessionId, input.sourceKind, input.immutableSourceKey);
}

export async function reserveStableMessageIdentity(
  transaction: TaskSessionDbTransaction,
  input: {
    companyId: string;
    taskId: string;
    sessionId: string;
    sourceKind: string;
    immutableSourceKey: string;
  },
  ids: Omit<admissionCore.StableIdentity, "messageId">,
): Promise<admissionCore.StableIdentity> {
  const messageId = await reserveTaskSessionMessageId(
    transaction,
    {
      companyId: input.companyId,
      taskId: input.taskId,
      sessionId: input.sessionId,
    },
    `admission:${input.sourceKind}:${admissionCore.digest({
      sessionId: input.sessionId,
      immutableSourceKey: input.immutableSourceKey,
    })}`,
  );
  return { ...ids, messageId };
}

export function assertSourceIdentity(input: {
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
    throw new TaskSessionLifecycleConflict("Canonical source identity fields must be non-empty", {
      sourceKind: input.sourceKind,
    });
  }
}

export function assertNever(value: never, context: string): never {
  const runtimeValue = value as unknown;
  throw new TaskSessionLifecycleConflict(`Unclassified ${context} reached Task Session admission`, {
    value:
      runtimeValue && typeof runtimeValue === "object"
        ? (runtimeValue as Record<string, unknown>)
        : runtimeValue,
  });
}

export function assertNonEmptyExecutionActorField(
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

export function assertExecutionActor(actor: admissionCore.TaskSessionExecutionActor): void {
  if (!actor || typeof actor !== "object" || Array.isArray(actor)) {
    throw new TaskSessionLifecycleConflict("Execution source requires immutable actor provenance");
  }
  switch (actor.kind) {
    case "user/board":
      assertNonEmptyExecutionActorField(actor.kind, "userId", actor.userId);
      return;
    case "agent-execution":
      assertNonEmptyExecutionActorField(actor.kind, "agentId", actor.agentId);
      assertNonEmptyExecutionActorField(actor.kind, "authorityId", actor.authorityId);
      return;
    case "plugin":
      assertNonEmptyExecutionActorField(actor.kind, "pluginInstallationId", actor.pluginInstallationId);
      assertNonEmptyExecutionActorField(actor.kind, "pluginKey", actor.pluginKey);
      return;
    case "routine":
      assertNonEmptyExecutionActorField(actor.kind, "routineId", actor.routineId);
      assertNonEmptyExecutionActorField(actor.kind, "routineDispatchId", actor.routineDispatchId);
      return;
    case "system":
      assertNonEmptyExecutionActorField(actor.kind, "sourceKind", actor.sourceKind);
      assertNonEmptyExecutionActorField(actor.kind, "sourceId", actor.sourceId);
      return;
    default:
      return assertNever(actor, "execution-source actor");
  }
}

export function assertExecutionSourceActorPair(source: admissionCore.TaskSessionExecutionSource): void {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new TaskSessionLifecycleConflict("Execution source must be a closed source/actor record");
  }
  for (const producerOwnedKindField of ["eventKind", "messageKind", "delivery"] as const) {
    if (Object.prototype.hasOwnProperty.call(source, producerOwnedKindField)) {
      throw new TaskSessionLifecycleConflict(
        "Execution source producers cannot override Session admission lowering",
        {
          sourceKind: typeof source.sourceKind === "string" ? source.sourceKind : null,
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
  throw new TaskSessionLifecycleConflict("Execution source actor does not match its immutable source kind", {
    sourceKind: source.sourceKind,
    actorKind: source.actor.kind,
  });
}

/**
 * Default lowering from immutable source provenance to the V2 Session kind.
 * Ordered pair admission lowers its first member separately.
 */
export function v2MessageKindForExecutionSource(
  source: admissionCore.TaskSessionExecutionSource,
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
      return source.actor.kind === "user/board" ? "user" : "synthetic";
    case "consult_mention":
    case "system_nudge":
      return "synthetic";
    default:
      return assertNever(source, "execution source");
  }
}

export function scopeDigest(
  input: admissionCore.DispatchExecutionScope & {
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
    throw new TaskSessionLifecycleConflict("Only task reassignment may carry a previous ownership epoch", {
      sourceKind: input.sourceKind ?? null,
    });
  }
  return null;
}

export function commentInsert(author: TaskSessionCommentAuthor, body: string) {
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

export function userProjectionKind(sourceKind: string): TaskSessionCommentProjectionInput["sourceKind"] {
  return sourceKind === "human_comment_mention" || sourceKind === "task_update"
    ? "human_comment"
    : "task_request";
}

export function directProjectionKind(sourceKind: string): TaskSessionCommentProjectionInput["sourceKind"] {
  if (sourceKind === "task_update") return "task_update";
  return "harness_delivery";
}

export type TaskCommentReplyProjection = Pick<
  TaskSessionCommentProjectionInput["comment"],
  "replyToCommentId" | "replyToProjectedEventSeq" | "threadRootCommentId" | "threadRootProjectedEventSeq"
>;

export const TOP_LEVEL_REPLY_PROJECTION: TaskCommentReplyProjection = {
  replyToCommentId: null,
  replyToProjectedEventSeq: null,
  threadRootCommentId: null,
  threadRootProjectedEventSeq: null,
};
