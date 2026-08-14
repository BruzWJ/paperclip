import {
  taskCommentProjectionSources,
  taskComments,
  taskExecutionHistoryViews,
  taskExecutionRefs,
  taskSessionEventSequences,
  taskSessionEvents,
  taskSessionInputDispositions,
  taskSessionInputs,
  type Db,
} from "@paperclipai/db";

import * as TaskSession from "@paperclipai/shared/task-session";

import { and, eq, isNull } from "drizzle-orm";

import {
  decodeStoredTaskSessionEvent,
  reserveTaskSessionEventSequence,
  type TaskSessionDbTransaction,
} from "./event-store.js";

import { publishTaskSessionEventInTx } from "./publication.js";

import { TaskSessionInvariantError, TaskSessionLifecycleConflict } from "./store.js";

import { type TaskSessionInputRecord, type TaskSessionInputService, digest } from "./input-part-1.js";
import { candidateMatchesScope, validateActiveExecution } from "./input-part-2.js";
import { exactTextOnlyPrompt, loadPendingCandidates, promoteCandidate } from "./input-part-3.js";

/**
 * Materializes one admitted human active-run steer as its canonical User
 * message before the positive segment takes a source-message FK. Unlike the
 * ordinary ref promotion path, this input deliberately has no ref/view; the
 * run repository binds its projected comment to the new segment immediately
 * after this transition in the same transaction.
 */
export async function promoteActiveRunSteeringInputInTransaction(
  transaction: TaskSessionDbTransaction,
  input: {
    readonly companyId: string;
    readonly taskId: string;
    readonly sessionId: string;
    readonly sourceCommentId: string;
    readonly sourceMessageId: string;
    readonly sourceInputId: string;
    readonly actorUserId: string;
    readonly exactMessage: string;
    readonly at: Date;
  },
): Promise<TaskSessionInputRecord> {
  if (input.sourceMessageId !== input.sourceInputId || input.exactMessage.length === 0) {
    throw new TaskSessionLifecycleConflict(
      "Human active-run steering requires one exact source message/input identity",
      { sourceMessageId: input.sourceMessageId },
    );
  }
  const sourceInput = await transaction
    .select()
    .from(taskSessionInputs)
    .where(
      and(
        eq(taskSessionInputs.companyId, input.companyId),
        eq(taskSessionInputs.taskId, input.taskId),
        eq(taskSessionInputs.sessionId, input.sessionId),
        eq(taskSessionInputs.id, input.sourceInputId),
      ),
    )
    .limit(1)
    .for("update")
    .then((rows) => rows[0] ?? null);
  const disposition = await transaction
    .select()
    .from(taskSessionInputDispositions)
    .where(
      and(
        eq(taskSessionInputDispositions.companyId, input.companyId),
        eq(taskSessionInputDispositions.taskId, input.taskId),
        eq(taskSessionInputDispositions.sessionId, input.sessionId),
        eq(taskSessionInputDispositions.inputId, input.sourceInputId),
      ),
    )
    .limit(1)
    .for("update")
    .then((rows) => rows[0] ?? null);
  const projected = await transaction
    .select({
      comment: taskComments,
      source: taskCommentProjectionSources,
    })
    .from(taskComments)
    .innerJoin(taskCommentProjectionSources, eq(taskCommentProjectionSources.commentId, taskComments.id))
    .where(
      and(
        eq(taskComments.companyId, input.companyId),
        eq(taskComments.taskId, input.taskId),
        eq(taskComments.sessionId, input.sessionId),
        eq(taskComments.id, input.sourceCommentId),
      ),
    )
    .limit(1)
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (
    !sourceInput ||
    !disposition ||
    !projected ||
    sourceInput.delivery !== "steer" ||
    sourceInput.promotedSeq !== null ||
    !exactTextOnlyPrompt(sourceInput.prompt) ||
    sourceInput.prompt.text !== input.exactMessage ||
    disposition.sourceRefId !== null ||
    disposition.state !== "active" ||
    projected.comment.canonicalMessageId !== input.sourceMessageId ||
    projected.comment.canonicalSourceKind !== "human_comment" ||
    projected.comment.body !== input.exactMessage ||
    projected.comment.authorType !== "user" ||
    projected.comment.authorUserId !== input.actorUserId ||
    projected.comment.runId !== null ||
    projected.source.sourceKind !== "human_comment" ||
    projected.source.messageId !== input.sourceMessageId ||
    projected.source.admittedEventSeq !== sourceInput.admittedSeq ||
    projected.source.promotedEventSeq !== null ||
    projected.source.steeringTargetRunId !== null ||
    projected.source.refId !== null ||
    projected.source.refOrdinal !== null ||
    projected.source.segmentOrdinal !== null
  ) {
    throw new TaskSessionLifecycleConflict(
      "Human active-run steering lost its exact admitted input/comment identity",
      { sourceInputId: input.sourceInputId },
    );
  }
  const admittedRow = await transaction
    .select()
    .from(taskSessionEvents)
    .where(
      and(
        eq(taskSessionEvents.companyId, input.companyId),
        eq(taskSessionEvents.taskId, input.taskId),
        eq(taskSessionEvents.sessionId, input.sessionId),
        eq(taskSessionEvents.seq, sourceInput.admittedSeq),
      ),
    )
    .limit(1)
    .for("update")
    .then((rows) => rows[0] ?? null);
  const admitted = admittedRow ? decodeStoredTaskSessionEvent(admittedRow) : null;
  if (
    !admittedRow ||
    admittedRow.sourceKind !== "human_comment" ||
    admittedRow.sourceId !== projected.source.sourceId ||
    admittedRow.runId !== null ||
    admittedRow.agentId !== null ||
    admittedRow.adapterConfigRevisionId !== null ||
    admitted?.event.type !== TaskSession.Event.PromptAdmitted.type ||
    (admitted.event.data as { messageID?: unknown }).messageID !== input.sourceMessageId ||
    (admitted.event.data as { delivery?: unknown }).delivery !== "steer" ||
    !exactTextOnlyPrompt((admitted.event.data as { prompt?: unknown }).prompt) ||
    (admitted.event.data as { prompt: { text: string } }).prompt.text !== input.exactMessage
  ) {
    throw new TaskSessionInvariantError(
      `Admitted active-run steering input ${input.sourceInputId} lost its immutable event`,
    );
  }
  const { seq } = await reserveTaskSessionEventSequence(transaction, input);
  const eventId = `evt_${digest({
    transition: "prompted",
    sessionId: input.sessionId,
    inputId: input.sourceInputId,
  }).slice(0, 40)}`;
  await publishTaskSessionEventInTx(transaction, {
    event: {
      id: eventId,
      sessionId: input.sessionId,
      seq,
      type: TaskSession.Event.Prompted.type,
      data: {
        sessionID: input.sessionId,
        messageID: input.sourceMessageId,
        timestamp: sourceInput.timeCreated.getTime(),
        prompt: sourceInput.prompt,
        delivery: "steer",
      },
    },
    envelope: {
      companyId: input.companyId,
      taskId: input.taskId,
      runId: null,
      ownershipEpoch: null,
      agentId: null,
      adapterConfigRevisionId: null,
      sourceKind: "input_promotion",
      sourceId: admittedRow.sourceId,
      immutableSourceKey: `${admittedRow.immutableSourceKey}:prompted`,
      sourceRecordId: admittedRow.sourceRecordId,
      sourceIdentityDigest: digest({
        kind: "input_promotion",
        sourceKind: admittedRow.sourceKind,
        sourceId: admittedRow.sourceId,
        sourceInputId: input.sourceInputId,
        admittedSeq: sourceInput.admittedSeq,
      }),
      createdAt: input.at,
    },
    projection: {
      comment: {
        phase: "promoted",
        sourceKind: "human_comment",
        sourceId: projected.source.sourceId,
        messageId: input.sourceMessageId,
        comment: {
          id: projected.comment.id,
          body: projected.comment.body,
          authorAgentId: projected.comment.authorAgentId,
          authorUserId: projected.comment.authorUserId,
          authorPluginInstallationId: projected.comment.authorPluginInstallationId,
          authorPluginKey: projected.comment.authorPluginKey,
          authorType: projected.comment.authorType,
          replyToCommentId: projected.comment.replyToCommentId,
          replyToProjectedEventSeq: projected.comment.replyToProjectedEventSeq,
          threadRootCommentId: projected.comment.threadRootCommentId,
          threadRootProjectedEventSeq: projected.comment.threadRootProjectedEventSeq,
          presentation: projected.comment.presentation,
          metadata: projected.comment.metadata,
          sourceTrust: projected.comment.sourceTrust,
        },
      },
    },
  });
  const promoted = await transaction
    .select()
    .from(taskSessionInputs)
    .where(eq(taskSessionInputs.id, input.sourceInputId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!promoted || promoted.promotedSeq !== seq) {
    throw new TaskSessionInvariantError(
      `Task Session projector did not promote active-run steering input ${input.sourceInputId}`,
    );
  }
  return promoted;
}

export function createTaskSessionInputService(
  db: Db,
  options: { clock?: () => Date } = {},
): TaskSessionInputService {
  const clock = options.clock ?? (() => new Date());
  return {
    promotePreparedInput(scope) {
      return db.transaction(async (transaction) => {
        const active = await validateActiveExecution(transaction, {
          ...scope,
          activeRefId: scope.refId,
          runId: null,
        });
        if (active.ref.inputId === null || active.ref.promotedSeq !== null) {
          return false;
        }
        const rows = await transaction
          .select({
            inbox: taskSessionInputs,
            disposition: taskSessionInputDispositions,
            ref: taskExecutionRefs,
            view: taskExecutionHistoryViews,
          })
          .from(taskSessionInputs)
          .innerJoin(
            taskSessionInputDispositions,
            eq(taskSessionInputDispositions.inputId, taskSessionInputs.id),
          )
          .innerJoin(taskExecutionRefs, eq(taskExecutionRefs.id, taskSessionInputDispositions.sourceRefId))
          .innerJoin(
            taskExecutionHistoryViews,
            eq(taskExecutionHistoryViews.id, taskExecutionRefs.historyViewId),
          )
          .where(and(eq(taskSessionInputs.id, active.ref.inputId), isNull(taskSessionInputs.promotedSeq)))
          .limit(1)
          .for("update");
        const candidate = rows[0];
        if (!candidate) {
          throw new TaskSessionInvariantError(
            `Prepared Task Session input ${active.ref.inputId} disappeared before promotion`,
          );
        }
        if (!candidateMatchesScope(active, candidate, false)) {
          throw new TaskSessionLifecycleConflict(
            "Prepared Task Session input no longer matches its exact ref and history view",
            { refId: scope.refId, inputId: active.ref.inputId },
          );
        }
        await promoteCandidate(transaction, candidate, clock());
        return true;
      });
    },

    latestSequence(scope) {
      return db.transaction(async (transaction) => {
        await validateActiveExecution(transaction, scope);
        const rows = await transaction
          .select({ seq: taskSessionEventSequences.seq })
          .from(taskSessionEventSequences)
          .where(
            and(
              eq(taskSessionEventSequences.companyId, scope.companyId),
              eq(taskSessionEventSequences.taskId, scope.taskId),
              eq(taskSessionEventSequences.sessionId, scope.sessionId),
            ),
          )
          .limit(1);
        const seq = rows[0]?.seq;
        if (seq === undefined) {
          throw new TaskSessionInvariantError(`Task Session ${scope.sessionId} has no event sequence`);
        }
        return seq;
      });
    },

    hasPending(scope) {
      return db.transaction(async (transaction) => {
        const active = await validateActiveExecution(transaction, scope);
        const candidates = await loadPendingCandidates(transaction, active);
        return {
          steer: candidates.some((candidate) => candidate.inbox.delivery === "steer"),
          queue: candidates.some((candidate) => candidate.inbox.delivery === "queue"),
        };
      });
    },

    promoteSteers(scope, cutoffSeq) {
      if (!Number.isSafeInteger(cutoffSeq) || cutoffSeq < -1) {
        throw new TypeError("Task Session steer cutoff must be a safe event sequence");
      }
      return db.transaction(async (transaction) => {
        const active = await validateActiveExecution(transaction, scope);
        const sequenceRows = await transaction
          .select({ seq: taskSessionEventSequences.seq })
          .from(taskSessionEventSequences)
          .where(
            and(
              eq(taskSessionEventSequences.companyId, scope.companyId),
              eq(taskSessionEventSequences.taskId, scope.taskId),
              eq(taskSessionEventSequences.sessionId, scope.sessionId),
            ),
          )
          .limit(1);
        if (sequenceRows[0] === undefined || cutoffSeq > sequenceRows[0].seq) {
          throw new TaskSessionLifecycleConflict(
            "Task Session steer cutoff is ahead of its durable event sequence",
            { sessionId: scope.sessionId, cutoffSeq },
          );
        }
        const candidates = (await loadPendingCandidates(transaction, active)).filter(
          (candidate) => candidate.inbox.delivery === "steer" && candidate.inbox.admittedSeq <= cutoffSeq,
        );
        const promoted: TaskSessionInputRecord[] = [];
        for (const candidate of candidates) {
          promoted.push(await promoteCandidate(transaction, candidate, clock()));
        }
        return promoted;
      });
    },

    promoteNextQueued(scope) {
      return db.transaction(async (transaction) => {
        const active = await validateActiveExecution(transaction, scope);
        const candidates = await loadPendingCandidates(transaction, active);
        if (candidates.some((candidate) => candidate.inbox.delivery === "steer")) {
          return null;
        }
        const queued = candidates.find((candidate) => candidate.inbox.delivery === "queue");
        return queued ? promoteCandidate(transaction, queued, clock()) : null;
      });
    },
  };
}
