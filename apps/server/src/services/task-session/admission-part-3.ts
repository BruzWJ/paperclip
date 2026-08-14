import { taskComments, tasks } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { readTaskExecutionRun } from "../task-execution-run-service.js";
import type {
  DispatchExecutionScope,
  DispatchingExecutionSourceInput,
  SteeringComment,
  TaskSessionExecutionActor,
  TaskSessionProjectedCommentSource,
} from "./admission-part-1.js";
import * as admissionProjection from "./admission-part-2.js";
import { assertCounterpart } from "./admission-part-4.js";
import type { TaskSessionDbTransaction } from "./event-store.js";
import type { TaskSessionCommentProjectionInput } from "./projector.js";
import {
  TaskSessionInvariantError,
  TaskSessionLifecycleConflict,
  type TaskSessionCommentAuthor,
} from "./store.js";

export { messageIdFromEvent, sourceClaim } from "./admission-part-4.js";

export async function resolveTaskCommentReplyProjection(
  transaction: TaskSessionDbTransaction,
  scope: { companyId: string; taskId: string; sessionId: string },
  replyToCommentId: string | null | undefined,
): Promise<admissionProjection.TaskCommentReplyProjection> {
  if (replyToCommentId == null) return admissionProjection.TOP_LEVEL_REPLY_PROJECTION;
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
    throw new TaskSessionLifecycleConflict("Reply parent is missing from the canonical task Session", {
      replyToCommentId,
    });
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
    throw new TaskSessionInvariantError(`Reply parent ${parent.id} has an invalid immutable thread tuple`);
  }
  return {
    replyToCommentId: parent.id,
    replyToProjectedEventSeq: parent.projectedEventSeq,
    threadRootCommentId: parentIsTopLevel ? parent.id : parent.threadRootCommentId,
    threadRootProjectedEventSeq: parentIsTopLevel
      ? parent.projectedEventSeq
      : parent.threadRootProjectedEventSeq,
  };
}

export function projectionInput(input: {
  phase: "admitted" | "promoted" | "direct";
  sourceKind: TaskSessionCommentProjectionInput["sourceKind"];
  sourceId: string;
  messageId: string;
  commentId: string;
  body: string;
  author: TaskSessionCommentAuthor;
  reply: admissionProjection.TaskCommentReplyProjection;
  steeringSegment?: TaskSessionProjectedCommentSource["steeringSegment"];
}): TaskSessionCommentProjectionInput {
  return {
    phase: input.phase,
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
    messageId: input.messageId,
    ...(input.steeringSegment === undefined ? {} : { steeringSegment: input.steeringSegment }),
    comment: {
      id: input.commentId,
      ...admissionProjection.commentInsert(input.author, input.body),
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

export function assertProjectedCommentSourceShape(comment: TaskSessionProjectedCommentSource): void {
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

export function assertExecutionSourceCommentProvenance(
  input: DispatchingExecutionSourceInput | SteeringComment,
  messageKind = admissionProjection.v2MessageKindForExecutionSource(input),
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
        return admissionProjection.assertNever(actor, "execution-source actor");
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

export function assertDispatchingExecutionSource(
  input: DispatchingExecutionSourceInput,
  messageKind = admissionProjection.v2MessageKindForExecutionSource(input),
): "user" | "synthetic" {
  admissionProjection.assertSourceIdentity(input);
  assertExecutionSourceCommentProvenance(input, messageKind);
  admissionProjection.previousOwnershipEpochForDispatchSource(input);
  return messageKind;
}

export type GroupedDispatchingExecutionSourceInput = DispatchingExecutionSourceInput &
  Required<Pick<DispatchExecutionScope, "executionScopeId" | "executionLineageId">>;

/** @internal Admission lowering for an already-normalized execution batch. */
export function resolveDispatchingExecutionBatchMessageKinds(
  sources: readonly GroupedDispatchingExecutionSourceInput[],
): readonly ("user" | "synthetic")[] {
  if (sources.length !== 2) {
    throw new TaskSessionLifecycleConflict(
      "Dispatching execution-source pair must contain two ordered sources",
    );
  }
  const messageKinds = sources.map(admissionProjection.v2MessageKindForExecutionSource);
  messageKinds[0] = "synthetic";
  sources.forEach((source, index) => {
    assertDispatchingExecutionSource(source, messageKinds[index]!);
  });
  return messageKinds;
}

export type ProjectedCommentProducerScope = {
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
  const counterpartOwnershipEpoch = scope.counterpartOwnershipEpoch ?? null;
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
      .where(and(eq(tasks.companyId, scope.companyId), eq(tasks.id, scope.taskId)))
      .limit(1)
      .then((rows) => rows[0] ?? null),
    transaction
      .select({
        parentId: tasks.parentId,
        parentOwnershipEpoch: tasks.parentOwnershipEpoch,
        ownershipEpoch: tasks.ownershipEpoch,
      })
      .from(tasks)
      .where(and(eq(tasks.companyId, scope.companyId), eq(tasks.id, counterpartTaskId)))
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
    target.creatorAdapterConfigRevisionId === comment.producingRun.adapterConfigRevisionId;
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
    producer.adapterConfigRevisionId === comment.producingRun.adapterConfigRevisionId,
  );
}

export async function assertProjectedCommentProducer(
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
    producer.adapterConfigRevisionId === comment.producingRun.adapterConfigRevisionId &&
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
      producingAdapterConfigRevisionId: comment.producingRun.adapterConfigRevisionId,
    },
  );
}
