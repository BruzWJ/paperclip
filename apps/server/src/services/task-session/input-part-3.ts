import {
  taskCommentProjectionSources,
  taskComments,
  taskExecutionHistoryViewMessages,
  taskExecutionHistoryViews,
  taskExecutionRefs,
  taskSessionEvents,
  taskSessionInputDispositions,
  taskSessionInputs,
} from "@paperclipai/db";

import * as TaskSession from "@paperclipai/shared/task-session";

import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";

import type { TaskSessionCommentProjectionInput } from "./projector.js";

import {
  decodeStoredTaskSessionEvent,
  reserveTaskSessionEventSequence,
  type TaskSessionDbTransaction,
} from "./event-store.js";

import { publishTaskSessionEventInTx } from "./publication.js";

import { TaskSessionInvariantError, TaskSessionLifecycleConflict } from "./store.js";

import { readOccupiedTaskExecutionRefIds } from "../task-execution-run-service.js";
import {
  type ActiveExecution,
  type PendingCandidate,
  type TaskSessionInputRecord,
  deterministicUuid,
  digest,
} from "./input-part-1.js";
import { candidateMatchesScope } from "./input-part-2.js";

export async function loadPendingCandidates(
  transaction: TaskSessionDbTransaction,
  active: ActiveExecution,
): Promise<PendingCandidate[]> {
  const rows = await transaction
    .select({
      inbox: taskSessionInputs,
      disposition: taskSessionInputDispositions,
      ref: taskExecutionRefs,
      view: taskExecutionHistoryViews,
    })
    .from(taskSessionInputs)
    .innerJoin(taskSessionInputDispositions, eq(taskSessionInputDispositions.inputId, taskSessionInputs.id))
    .innerJoin(taskExecutionRefs, eq(taskExecutionRefs.id, taskSessionInputDispositions.sourceRefId))
    .innerJoin(taskExecutionHistoryViews, eq(taskExecutionHistoryViews.id, taskExecutionRefs.historyViewId))
    .where(
      and(
        eq(taskSessionInputs.companyId, active.ref.companyId),
        eq(taskSessionInputs.taskId, active.ref.taskId),
        eq(taskSessionInputs.sessionId, active.ref.sessionId),
        isNull(taskSessionInputs.promotedSeq),
        eq(taskSessionInputDispositions.state, "active"),
      ),
    )
    .orderBy(asc(taskSessionInputs.admittedSeq))
    .for("update");
  const candidateRefIds = [...new Set(rows.map((row) => row.ref.id))];
  const occupiedRefIds = new Set(
    await readOccupiedTaskExecutionRefIds(transaction, {
      companyId: active.ref.companyId,
      taskId: active.ref.taskId,
      sessionId: active.ref.sessionId,
      refIds: candidateRefIds,
    }),
  );
  return rows.filter((candidate) =>
    candidateMatchesScope(active, candidate, occupiedRefIds.has(candidate.ref.id)),
  );
}

export async function promoteCandidate(
  transaction: TaskSessionDbTransaction,
  candidate: PendingCandidate,
  now: Date,
): Promise<TaskSessionInputRecord> {
  const { inbox, ref, view } = candidate;
  const comments = await transaction
    .select({
      comment: taskComments,
      source: taskCommentProjectionSources,
    })
    .from(taskComments)
    .innerJoin(taskCommentProjectionSources, eq(taskCommentProjectionSources.commentId, taskComments.id))
    .where(
      and(
        eq(taskComments.companyId, inbox.companyId),
        eq(taskComments.taskId, inbox.taskId),
        eq(taskComments.sessionId, inbox.sessionId),
        eq(taskComments.canonicalMessageId, inbox.id),
      ),
    )
    .limit(1);
  const comment = comments[0]?.comment;
  const commentSource = comments[0]?.source;
  if (
    !comment ||
    !commentSource ||
    commentSource.sourceKind !== comment.canonicalSourceKind ||
    commentSource.sourceId !== comment.canonicalSourceId ||
    commentSource.messageId !== inbox.id
  ) {
    throw new TaskSessionInvariantError(`Admitted input ${inbox.id} has no stable projected comment`);
  }
  const admittedEvent = await transaction
    .select()
    .from(taskSessionEvents)
    .where(
      and(
        eq(taskSessionEvents.companyId, inbox.companyId),
        eq(taskSessionEvents.taskId, inbox.taskId),
        eq(taskSessionEvents.sessionId, inbox.sessionId),
        eq(taskSessionEvents.seq, inbox.admittedSeq),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
  const admitted = admittedEvent ? decodeStoredTaskSessionEvent(admittedEvent) : null;
  if (
    !admittedEvent ||
    admitted?.event.type !== TaskSession.Event.PromptAdmitted.type ||
    (admitted.event.data as { messageID?: unknown }).messageID !== inbox.id ||
    admittedEvent.sourceKind !== ref.sourceKind ||
    admittedEvent.sourceId !== ref.sourceId ||
    admittedEvent.runId !== comment.runId ||
    (comment.authorType === "agent" &&
      (admittedEvent.runId === null ||
        admittedEvent.agentId !== comment.authorAgentId ||
        admittedEvent.adapterConfigRevisionId === null)) ||
    (comment.authorType !== "agent" && admittedEvent.runId !== null)
  ) {
    throw new TaskSessionInvariantError(`Admitted input ${inbox.id} lost its immutable producer envelope`);
  }

  const { seq } = await reserveTaskSessionEventSequence(transaction, {
    companyId: inbox.companyId,
    taskId: inbox.taskId,
    sessionId: inbox.sessionId,
  });
  const eventId = `evt_${digest({
    transition: "prompted",
    sessionId: inbox.sessionId,
    inputId: inbox.id,
  }).slice(0, 40)}`;
  await publishTaskSessionEventInTx(transaction, {
    event: {
      id: eventId,
      sessionId: inbox.sessionId,
      seq,
      type: TaskSession.Event.Prompted.type,
      data: {
        sessionID: inbox.sessionId,
        messageID: inbox.id,
        timestamp: inbox.timeCreated.getTime(),
        prompt: inbox.prompt,
        delivery: inbox.delivery,
      },
    },
    envelope: {
      companyId: inbox.companyId,
      taskId: inbox.taskId,
      runId: admittedEvent.runId,
      ownershipEpoch: ref.ownershipEpoch,
      agentId: admittedEvent.agentId,
      adapterConfigRevisionId: admittedEvent.adapterConfigRevisionId,
      sourceKind: "input_promotion",
      sourceId: ref.sourceId,
      immutableSourceKey: `${ref.id}:prompted`,
      sourceRecordId: ref.id,
      sourceIdentityDigest: digest({
        kind: "input_promotion",
        refId: ref.id,
        inputId: inbox.id,
        admittedSeq: inbox.admittedSeq,
      }),
      createdAt: now,
    },
    projection: {
      comment: {
        phase: "promoted",
        sourceKind: comment.canonicalSourceKind as TaskSessionCommentProjectionInput["sourceKind"],
        sourceId: comment.canonicalSourceId,
        messageId: inbox.id,
        ...(commentSource.refId === null
          ? {}
          : {
              steeringSegment: {
                steeringTargetRunId: commentSource.steeringTargetRunId!,
                refId: commentSource.refId,
                refOrdinal: commentSource.refOrdinal!,
                segmentOrdinal: commentSource.segmentOrdinal!,
              },
            }),
        comment: {
          id: comment.id,
          body: comment.body,
          authorAgentId: comment.authorAgentId,
          authorUserId: comment.authorUserId,
          authorPluginInstallationId: comment.authorPluginInstallationId,
          authorPluginKey: comment.authorPluginKey,
          authorType: comment.authorType,
          replyToCommentId: comment.replyToCommentId,
          replyToProjectedEventSeq: comment.replyToProjectedEventSeq,
          threadRootCommentId: comment.threadRootCommentId,
          threadRootProjectedEventSeq: comment.threadRootProjectedEventSeq,
          presentation: comment.presentation,
          metadata: comment.metadata,
          sourceTrust: comment.sourceTrust,
        },
      },
    },
  });

  const [updatedRefs, updatedViews] = await Promise.all([
    transaction
      .update(taskExecutionRefs)
      .set({ promotedSeq: seq, updatedAt: now })
      .where(
        and(
          eq(taskExecutionRefs.id, ref.id),
          isNull(taskExecutionRefs.promotedSeq),
          eq(taskExecutionRefs.disposition, "active"),
        ),
      )
      .returning({ id: taskExecutionRefs.id }),
    transaction
      .update(taskExecutionHistoryViews)
      .set({ sourcePromotedSeq: seq, updatedAt: now })
      .where(
        and(
          eq(taskExecutionHistoryViews.id, view.id),
          isNull(taskExecutionHistoryViews.sourcePromotedSeq),
          inArray(taskExecutionHistoryViews.state, ["empty", "current"]),
        ),
      )
      .returning({ id: taskExecutionHistoryViews.id }),
  ]);
  if (!updatedRefs[0] || !updatedViews[0]) {
    throw new TaskSessionLifecycleConflict(
      "Task Session input promotion lost its ref or history-view lifecycle race",
      { inputId: inbox.id, refId: ref.id, historyViewId: view.id },
    );
  }

  const orderRows = Array.from(
    await transaction.execute(sql<{ lowerOrder: number | null }>`
      SELECT max(lower_order)::integer AS "lowerOrder"
      FROM task_execution_history_view_messages
      WHERE history_view_id = ${view.id}
    `),
  );
  const lowerOrder = Number(orderRows[0]?.lowerOrder ?? -1) + 1;
  await transaction
    .insert(taskExecutionHistoryViewMessages)
    .values({
      id: deterministicUuid("history-view-message", `${view.id}\0${inbox.id}`),
      companyId: inbox.companyId,
      taskId: inbox.taskId,
      sessionId: inbox.sessionId,
      historyViewId: view.id,
      messageId: inbox.id,
      lowerOrder,
      membershipKind: "source",
    })
    .onConflictDoNothing();
  const memberships = await transaction
    .select()
    .from(taskExecutionHistoryViewMessages)
    .where(
      and(
        eq(taskExecutionHistoryViewMessages.historyViewId, view.id),
        eq(taskExecutionHistoryViewMessages.messageId, inbox.id),
      ),
    )
    .limit(1);
  const membership = memberships[0];
  if (
    !membership ||
    membership.companyId !== inbox.companyId ||
    membership.taskId !== inbox.taskId ||
    membership.sessionId !== inbox.sessionId ||
    membership.lowerOrder !== lowerOrder ||
    membership.membershipKind !== "source"
  ) {
    throw new TaskSessionLifecycleConflict("Task Session source membership diverged during input promotion", {
      inputId: inbox.id,
      historyViewId: view.id,
    });
  }

  const promoted = await transaction
    .select()
    .from(taskSessionInputs)
    .where(eq(taskSessionInputs.id, inbox.id))
    .limit(1);
  if (!promoted[0] || promoted[0].promotedSeq !== seq) {
    throw new TaskSessionInvariantError(`Task Session projector did not promote input ${inbox.id}`);
  }
  return promoted[0];
}

export function exactTextOnlyPrompt(value: unknown): value is {
  readonly text: string;
  readonly files?: readonly never[];
  readonly agents?: readonly never[];
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prompt = value as Record<string, unknown>;
  return (
    typeof prompt.text === "string" &&
    (prompt.files === undefined || (Array.isArray(prompt.files) && prompt.files.length === 0)) &&
    (prompt.agents === undefined || (Array.isArray(prompt.agents) && prompt.agents.length === 0))
  );
}
