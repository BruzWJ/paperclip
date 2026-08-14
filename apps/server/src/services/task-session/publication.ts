import { encodeDurableTaskSessionEventRow } from "@paperclipai/shared/task-session";
import {
  appendTaskSessionEvent,
  assertReservedTaskSessionMessageIds,
  makeDurableTaskSessionEvent,
  type TaskSessionDbTransaction,
} from "./event-store.js";
import {
  projectTaskSessionEventInTx,
  projectTaskSessionFinalCommentInTx,
  type TaskSessionFinalCommentInput,
} from "./projector.js";
import {
  type PublishTaskSessionEventInput,
  assertExactKeys,
  DURABLE_CANDIDATE_KEYS,
  EVENT_ENVELOPE_KEYS,
  isPlainObject,
  PUBLICATION_INPUT_KEYS,
  redactTaskSessionPublicationValue,
  requireNonEmptyString,
  requireOptionalNonEmptyString,
  requireValidDate,
} from "./publication-part-1.js";
import { persistCompanions, prepareCompanions, prepareProjection } from "./publication-part-2.js";
import { canonicalTaskSessionJson, TaskSessionLifecycleConflict } from "./store.js";

/**
 * The only steady-state entrance for a durable Task Session publication.
 * It prepares every byte before the first insert, appends the immutable event,
 * projects it, and persists typed bridge companions in the caller's single
 * PostgreSQL transaction.
 */
export async function publishTaskSessionEventInTx(
  transaction: TaskSessionDbTransaction,
  input: PublishTaskSessionEventInput,
): Promise<Awaited<ReturnType<typeof projectTaskSessionEventInTx>>> {
  assertExactKeys(input, PUBLICATION_INPUT_KEYS, "Durable Session publication");
  assertExactKeys(input.event, DURABLE_CANDIDATE_KEYS, "Durable Session event candidate");
  assertExactKeys(input.envelope, EVENT_ENVELOPE_KEYS, "Durable Session event envelope");
  requireNonEmptyString(input.envelope.companyId, "Durable Session event company id");
  requireNonEmptyString(input.envelope.taskId, "Durable Session event task id");
  requireValidDate(input.envelope.createdAt, "Durable Session event envelope timestamp");
  for (const [label, value] of [
    ["run", input.envelope.runId],
    ["agent", input.envelope.agentId],
    ["adapter configuration revision", input.envelope.adapterConfigRevisionId],
  ] as const) {
    requireOptionalNonEmptyString(value, `Durable Session event ${label} id`);
  }
  if (
    input.envelope.ownershipEpoch !== null &&
    input.envelope.ownershipEpoch !== undefined &&
    (!Number.isSafeInteger(input.envelope.ownershipEpoch) || input.envelope.ownershipEpoch < 0)
  ) {
    throw new TaskSessionLifecycleConflict("Durable Session event ownership epoch is invalid");
  }
  const sourceIdentity = [
    input.envelope.sourceKind,
    input.envelope.sourceId,
    input.envelope.immutableSourceKey,
    input.envelope.sourceRecordId,
    input.envelope.sourceIdentityDigest,
  ];
  const hasSourceIdentity = sourceIdentity.some((value) => value !== null && value !== undefined);
  if (
    hasSourceIdentity &&
    (sourceIdentity.some((value) => typeof value !== "string" || value.length === 0) ||
      !/^[a-f0-9]{64}$/i.test(input.envelope.sourceIdentityDigest ?? ""))
  ) {
    throw new TaskSessionLifecycleConflict(
      "Durable Session event envelope has an incomplete source identity",
    );
  }
  if (input.event.metadata !== undefined) {
    if (!isPlainObject(input.event.metadata) || Object.keys(input.event.metadata).length > 0) {
      throw new TaskSessionLifecycleConflict("Durable Session events cannot carry event-level metadata", {
        eventType: input.event.type,
      });
    }
  }
  const redactedData = redactTaskSessionPublicationValue(input.event.data, input.redactor);
  const event = makeDurableTaskSessionEvent({
    id: input.event.id,
    sessionId: input.event.sessionId,
    seq: input.event.seq,
    type: input.event.type,
    data: redactedData,
  });
  const encoded = encodeDurableTaskSessionEventRow(event);
  if (canonicalTaskSessionJson(redactedData) !== canonicalTaskSessionJson(encoded.data)) {
    throw new TaskSessionLifecycleConflict(
      "Durable Session event contains an unknown or non-canonical shape",
      { eventId: input.event.id, eventType: input.event.type },
    );
  }
  const projection = prepareProjection(input.projection, input.redactor);
  if (projection.comment) {
    const runId = input.envelope.runId ?? null;
    const authorAgentId = projection.comment.comment.authorAgentId ?? null;
    if (
      (projection.comment.comment.authorType === "agent" &&
        (runId === null || input.envelope.agentId !== authorAgentId)) ||
      (projection.comment.comment.authorType !== "agent" && runId !== null)
    ) {
      throw new TaskSessionLifecycleConflict("Session projected comment has invalid run attribution");
    }
  }
  const companions = prepareCompanions(input.companions, encoded.data as Record<string, unknown>);
  const encodedData = encoded.data as Record<string, unknown>;
  const namedMessageIds = [encodedData.messageID, encodedData.assistantMessageID].filter(
    (value): value is string => typeof value === "string",
  );
  await assertReservedTaskSessionMessageIds(
    transaction,
    {
      companyId: input.envelope.companyId,
      taskId: input.envelope.taskId,
      sessionId: input.event.sessionId,
    },
    namedMessageIds,
  );
  const inserted = await appendTaskSessionEvent(transaction, {
    event,
    envelope: input.envelope,
  });
  const projected = await projectTaskSessionEventInTx(transaction, {
    eventId: inserted.id,
    ...projection,
  });
  await persistCompanions(
    transaction,
    {
      companyId: inserted.companyId,
      taskId: inserted.taskId,
      sessionId: inserted.sessionId,
    },
    companions,
  );
  return projected;
}

export async function publishTaskSessionFinalCommentInTx(
  transaction: TaskSessionDbTransaction,
  input: TaskSessionFinalCommentInput,
) {
  assertExactKeys(input, new Set(["eventId", "progressCommentId"]), "Final Session comment publication");
  requireNonEmptyString(input.eventId, "Final Session comment event id");
  const progressCommentId = requireNonEmptyString(
    input.progressCommentId,
    "Final Session progress comment id",
  );
  return projectTaskSessionFinalCommentInTx(transaction, {
    eventId: input.eventId,
    progressCommentId,
  });
}
export * from "./publication-part-1.js";
export * from "./publication-part-2.js";
