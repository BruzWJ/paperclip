import { taskSessionEvents } from "@paperclipai/db";
import {
  taskCommentAuthorTypeSchema,
  taskCommentMetadataSchema,
  taskCommentPresentationSchema,
} from "@paperclipai/shared";
import {
  encodeDurableTaskSessionEventRow,
  type TaskSessionEventType,
} from "@paperclipai/shared/task-session";
import { sourceTrustMetadataSchema } from "@paperclipai/shared/validators/trust-policy";
import {
  REDACTED_EVENT_VALUE,
  redactSensitiveText,
  sanitizeRecord,
} from "../../redaction.js";
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
  type TaskSessionProjectionInput,
} from "./projector.js";
import {
  insertOrAssertTaskSessionSourceUserExecution,
  type TaskSessionSourceUserExecutionInput,
} from "./source-user-execution.js";
import {
  canonicalTaskSessionJson,
  TaskSessionLifecycleConflict,
} from "./store.js";

type EventEnvelope = Omit<
  typeof taskSessionEvents.$inferInsert,
  "id" | "sessionId" | "seq" | "type" | "data"
>;

export interface TaskSessionPublicationRedactor {
  redactText(value: string): string;
  redactValue<T>(value: T): T;
}
export interface TaskSessionDurableCandidate {
  id: string;
  sessionId: string;
  seq: number;
  type: TaskSessionEventType;
  data: unknown;
  /**
   * Event-level metadata is deliberately accepted by the runtime guard only
   * so it can fail closed with a useful lifecycle error. It is never persisted.
   */
  metadata?: Record<string, unknown>;
}

export interface TaskSessionPublicationCompanions {
  sourceUserExecution?: Omit<
    TaskSessionSourceUserExecutionInput,
    "companyId" | "taskId" | "sessionId"
  >;
}

export interface PublishTaskSessionEventInput {
  event: TaskSessionDurableCandidate;
  envelope: EventEnvelope;
  projection?: Omit<TaskSessionProjectionInput, "eventId">;
  companions?: TaskSessionPublicationCompanions;
  redactor?: TaskSessionPublicationRedactor;
}

const PUBLICATION_INPUT_KEYS = new Set([
  "event",
  "envelope",
  "projection",
  "companions",
  "redactor",
]);
const DURABLE_CANDIDATE_KEYS = new Set([
  "id",
  "sessionId",
  "seq",
  "type",
  "data",
  "metadata",
]);
const EVENT_ENVELOPE_KEYS = new Set([
  "companyId",
  "taskId",
  "runId",
  "ownershipEpoch",
  "agentId",
  "adapterConfigRevisionId",
  "sourceKind",
  "sourceId",
  "immutableSourceKey",
  "sourceRecordId",
  "sourceIdentityDigest",
  "createdAt",
]);

const PROJECTION_KEYS = new Set([
  "inputBinding",
  "comment",
]);

const COMMENT_PROJECTION_KEYS = new Set([
  "phase",
  "sourceKind",
  "sourceId",
  "messageId",
  "steeringSegment",
  "comment",
]);

const COMMENT_KEYS = new Set([
  "id",
  "body",
  "authorType",
  "authorAgentId",
  "authorUserId",
  "authorPluginInstallationId",
  "authorPluginKey",
  "replyToCommentId",
  "replyToProjectedEventSeq",
  "threadRootCommentId",
  "threadRootProjectedEventSeq",
  "presentation",
  "metadata",
  "sourceTrust",
]);
const COMMENT_PHASES = new Set(["admitted", "promoted", "direct"]);
const COMMENT_SOURCE_KINDS = new Set([
  "task_request",
  "human_comment",
  "harness_delivery",
  "system_control",
  "run_output",
  "run_progress",
  "task_update",
  "plugin_withdrawal",
]);
const STEERING_SEGMENT_KEYS = new Set([
  "steeringTargetRunId",
  "refId",
  "refOrdinal",
  "segmentOrdinal",
]);

const INPUT_BINDING_KEYS = new Set(["sourceRefId", "dispositionId"]);
const PUBLICATION_COMPANION_KEYS = new Set([
  "sourceUserExecution",
]);
const SOURCE_USER_EXECUTION_KEYS = new Set([
  "messageId",
  "sourceAgentId",
  "providerId",
  "modelId",
  "variant",
  "createdAt",
]);
const NUMERIC_SESSION_ACCOUNTING_KEYS = new Set([
  "maxOutputTokens",
  "outputTokenMax",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys<T>(
  value: T,
  allowed: ReadonlySet<string>,
  label: string,
): asserts value is T & Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new TaskSessionLifecycleConflict(`${label} must be a plain object`);
  }
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new TaskSessionLifecycleConflict(
      `${label} contains unknown durable fields`,
      { unknownFields: unknown.sort() },
    );
  }
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TaskSessionLifecycleConflict(
      `${label} must be a non-empty string`,
    );
  }
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new TaskSessionLifecycleConflict(
      `${label} must be a string`,
    );
  }
  return value;
}

function requireValidDate(value: unknown, label: string): Date {
  if (
    !(value instanceof Date) ||
    !Number.isFinite(value.getTime())
  ) {
    throw new TaskSessionLifecycleConflict(
      `${label} must be a valid timestamp`,
    );
  }
  return value;
}

function requireOptionalNonEmptyString(
  value: unknown,
  label: string,
): string | null | undefined {
  if (value === null || value === undefined) return value;
  return requireNonEmptyString(value, label);
}

/**
 * Applies a literal-aware run redactor when one is available, then always
 * applies Paperclip's structural and textual secret rules recursively.
 * Dates and other non-JSON runtime values are retained for typed companions;
 * event data is separately forced through Paperclip's canonical Session codec.
 */
export function redactTaskSessionPublicationValue<T>(
  value: T,
  redactor?: TaskSessionPublicationRedactor,
): T {
  const visit = (candidate: unknown): unknown => {
    if (typeof candidate === "string") {
      const literalText = redactor
        ? redactor.redactText(candidate)
        : candidate;
      return redactSensitiveText(literalText);
    }
    if (Array.isArray(candidate)) return candidate.map(visit);
    if (!isPlainObject(candidate)) return candidate;
    return Object.fromEntries(
      Object.entries(candidate).map(([key, entry]) => {
        const secretShapedKey =
          sanitizeRecord({ [key]: "__paperclip_probe__" })[
            key
          ] === REDACTED_EVENT_VALUE;
        if (!secretShapedKey) {
          if (
            Array.isArray(entry) &&
            /^(commandArgs|command_?args|argv)$/i.test(key)
          ) {
            return [
              key,
              visit(sanitizeRecord({ [key]: entry })[key]),
            ];
          }
          if (typeof entry === "string") {
            return [
              key,
              visit(sanitizeRecord({ value: entry }).value),
            ];
          }
          return [key, visit(entry)];
        }
        // Paperclip Session `tokens` and source token counters are accounting,
        // not credentials. Every other
        // secret-shaped value—including numeric credentials—remains redacted.
        if (
          entry === null ||
          (typeof entry === "number" &&
            NUMERIC_SESSION_ACCOUNTING_KEYS.has(key)) ||
          (key === "tokens" && isPlainObject(entry))
        ) {
          return [key, visit(entry)];
        }
        return [key, REDACTED_EVENT_VALUE];
      }),
    );
  };

  return visit(value) as T;
}

function prepareProjection(
  projection: PublishTaskSessionEventInput["projection"],
  redactor?: TaskSessionPublicationRedactor,
): Omit<TaskSessionProjectionInput, "eventId"> {
  if (projection === undefined) return {};
  assertExactKeys(projection, PROJECTION_KEYS, "Session projection companion");
  const prepared: Omit<TaskSessionProjectionInput, "eventId"> = {};

  if (projection.inputBinding !== undefined) {
    assertExactKeys(
      projection.inputBinding,
      INPUT_BINDING_KEYS,
      "Session input-binding companion",
    );
    prepared.inputBinding = {
      sourceRefId:
        projection.inputBinding.sourceRefId === null
          ? null
          : requireNonEmptyString(
              projection.inputBinding.sourceRefId,
              "Session source ref id",
            ),
      dispositionId: requireNonEmptyString(
        projection.inputBinding.dispositionId,
        "Session input disposition id",
      ),
    };
  }

  if (projection.comment !== undefined) {
    assertExactKeys(
      projection.comment,
      COMMENT_PROJECTION_KEYS,
      "Session comment projection companion",
    );
    assertExactKeys(
      projection.comment.comment,
      COMMENT_KEYS,
      "Session projected comment",
    );
    const comment = projection.comment.comment;
    if (!COMMENT_PHASES.has(projection.comment.phase)) {
      throw new TaskSessionLifecycleConflict(
        "Session projected comment has an invalid publication phase",
      );
    }
    if (!COMMENT_SOURCE_KINDS.has(projection.comment.sourceKind)) {
      throw new TaskSessionLifecycleConflict(
        "Session projected comment has an invalid canonical source kind",
      );
    }
    const authorType = taskCommentAuthorTypeSchema.parse(
      comment.authorType,
    );
    const authorAgentId = comment.authorAgentId ?? null;
    const authorUserId = comment.authorUserId ?? null;
    const authorPluginInstallationId =
      comment.authorPluginInstallationId ?? null;
    const authorPluginKey = comment.authorPluginKey ?? null;
    if (
      (authorAgentId !== null &&
        (typeof authorAgentId !== "string" ||
          authorAgentId.length === 0)) ||
      (authorUserId !== null &&
        (typeof authorUserId !== "string" ||
          authorUserId.length === 0)) ||
      (authorPluginInstallationId !== null &&
        (typeof authorPluginInstallationId !== "string" ||
          authorPluginInstallationId.length === 0)) ||
      (authorPluginKey !== null &&
        (typeof authorPluginKey !== "string" ||
          authorPluginKey.length === 0)) ||
      (authorType === "agent" &&
        (authorAgentId === null ||
          authorUserId !== null ||
          authorPluginInstallationId !== null ||
          authorPluginKey !== null)) ||
      (authorType === "user" &&
        (authorAgentId !== null ||
          authorUserId === null ||
          authorPluginInstallationId !== null ||
          authorPluginKey !== null)) ||
      (authorType === "plugin" &&
        (authorAgentId !== null ||
          authorUserId !== null ||
          authorPluginInstallationId === null ||
          authorPluginKey === null)) ||
      (authorType === "system" &&
        (authorAgentId !== null ||
          authorUserId !== null ||
          authorPluginInstallationId !== null ||
          authorPluginKey !== null))
    ) {
      throw new TaskSessionLifecycleConflict(
        "Session projected comment has an invalid author identity",
      );
    }
    const body = requireString(
      comment.body,
      "Session projected comment body",
    );
    const presentation =
      comment.presentation === undefined ||
      comment.presentation === null
        ? comment.presentation
        : taskCommentPresentationSchema.parse(
            redactTaskSessionPublicationValue(
              comment.presentation,
              redactor,
            ),
          );
    const metadata =
      comment.metadata === undefined || comment.metadata === null
        ? comment.metadata
        : taskCommentMetadataSchema.parse(
            redactTaskSessionPublicationValue(comment.metadata, redactor),
          );
    const sourceTrust =
      comment.sourceTrust === undefined || comment.sourceTrust === null
        ? comment.sourceTrust
        : sourceTrustMetadataSchema.parse(
            redactTaskSessionPublicationValue(
              comment.sourceTrust,
              redactor,
            ),
          );
    const replyToCommentId = comment.replyToCommentId ?? null;
    const replyToProjectedEventSeq =
      comment.replyToProjectedEventSeq ?? null;
    const threadRootCommentId = comment.threadRootCommentId ?? null;
    const threadRootProjectedEventSeq =
      comment.threadRootProjectedEventSeq ?? null;
    const replyTuple = [
      replyToCommentId,
      replyToProjectedEventSeq,
      threadRootCommentId,
      threadRootProjectedEventSeq,
    ];
    if (
      !(
        replyTuple.every((value) => value === null) ||
        (typeof replyToCommentId === "string" &&
          replyToCommentId.length > 0 &&
          Number.isSafeInteger(replyToProjectedEventSeq) &&
          Number(replyToProjectedEventSeq) >= 0 &&
          typeof threadRootCommentId === "string" &&
          threadRootCommentId.length > 0 &&
          Number.isSafeInteger(threadRootProjectedEventSeq) &&
          Number(threadRootProjectedEventSeq) >= 0)
      )
    ) {
      throw new TaskSessionLifecycleConflict(
        "Session projected comment has an invalid immutable reply tuple",
      );
    }
    let steeringSegment:
      | {
          steeringTargetRunId: string;
          refId: string;
          refOrdinal: number;
          segmentOrdinal: number;
        }
      | null
      | undefined;
    if (projection.comment.steeringSegment !== undefined) {
      if (projection.comment.steeringSegment === null) {
        steeringSegment = null;
      } else {
        assertExactKeys(
          projection.comment.steeringSegment,
          STEERING_SEGMENT_KEYS,
          "Session comment steering-segment companion",
        );
        const segment = projection.comment.steeringSegment;
        if (
          typeof segment.steeringTargetRunId !== "string" ||
          segment.steeringTargetRunId.length === 0 ||
          typeof segment.refId !== "string" ||
          segment.refId.length === 0 ||
          !Number.isSafeInteger(segment.refOrdinal) ||
          Number(segment.refOrdinal) < 0 ||
          !Number.isSafeInteger(segment.segmentOrdinal) ||
          Number(segment.segmentOrdinal) < 1
        ) {
          throw new TaskSessionLifecycleConflict(
            "Session comment steering-segment companion is invalid",
          );
        }
        steeringSegment = {
          steeringTargetRunId: segment.steeringTargetRunId,
          refId: segment.refId,
          refOrdinal: Number(segment.refOrdinal),
          segmentOrdinal: Number(segment.segmentOrdinal),
        };
      }
    }
    prepared.comment = {
      phase: projection.comment.phase,
      sourceKind: projection.comment.sourceKind,
      sourceId: requireNonEmptyString(
        projection.comment.sourceId,
        "Session projected comment source id",
      ),
      messageId: requireNonEmptyString(
        projection.comment.messageId,
        "Session projected comment message id",
      ),
      ...(steeringSegment === undefined ? {} : { steeringSegment }),
      comment: {
        id: requireNonEmptyString(
          comment.id,
          "Session projected comment id",
        ),
        body: redactTaskSessionPublicationValue(body, redactor),
        authorType,
        authorAgentId,
        authorUserId,
        authorPluginInstallationId,
        authorPluginKey,
        replyToCommentId,
        replyToProjectedEventSeq:
          replyToProjectedEventSeq as number | null,
        threadRootCommentId,
        threadRootProjectedEventSeq:
          threadRootProjectedEventSeq as number | null,
        ...(presentation === undefined ? {} : { presentation }),
        ...(metadata === undefined ? {} : { metadata }),
        ...(sourceTrust === undefined ? {} : { sourceTrust }),
      },
    };
  }


  return prepared;
}

function prepareCompanions(
  companions: TaskSessionPublicationCompanions | undefined,
  eventData: Record<string, unknown>,
): TaskSessionPublicationCompanions {
  if (companions === undefined) return {};
  assertExactKeys(
    companions,
    PUBLICATION_COMPANION_KEYS,
    "Session publication companions",
  );
  const prepared: TaskSessionPublicationCompanions = {};
  if (companions.sourceUserExecution !== undefined) {
    const source = companions.sourceUserExecution;
    assertExactKeys(
      source,
      SOURCE_USER_EXECUTION_KEYS,
      "Session source-user companion",
    );
    const createdAt =
      source.createdAt === undefined
        ? undefined
        : requireValidDate(
            source.createdAt,
            "Session source-user companion creation time",
          );
    prepared.sourceUserExecution = {
      messageId: requireNonEmptyString(
        source.messageId,
        "Session source-user message id",
      ),
      sourceAgentId: requireNonEmptyString(
        source.sourceAgentId,
        "Session source-user agent id",
      ),
      providerId: requireNonEmptyString(
        source.providerId,
        "Session source-user provider id",
      ),
      modelId: requireNonEmptyString(
        source.modelId,
        "Session source-user model id",
      ),
      variant:
        source.variant === null
          ? null
          : requireNonEmptyString(
              source.variant,
              "Session source-user variant",
            ),
      ...(createdAt === undefined ? {} : { createdAt }),
    };
    const eventMessageId =
      typeof eventData.messageID === "string"
        ? eventData.messageID
        : null;
    if (eventMessageId !== source.messageId) {
      throw new TaskSessionLifecycleConflict(
        "Session source-user companion changed its event message identity",
        { eventMessageId, companionMessageId: source.messageId },
      );
    }
  }
  return prepared;
}

async function persistCompanions(
  transaction: TaskSessionDbTransaction,
  scope: { companyId: string; taskId: string; sessionId: string },
  companions: TaskSessionPublicationCompanions,
): Promise<void> {
  if (companions.sourceUserExecution) {
    await insertOrAssertTaskSessionSourceUserExecution(transaction, {
      ...scope,
      ...companions.sourceUserExecution,
    });
  }
}

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
  assertExactKeys(
    input,
    PUBLICATION_INPUT_KEYS,
    "Durable Session publication",
  );
  assertExactKeys(
    input.event,
    DURABLE_CANDIDATE_KEYS,
    "Durable Session event candidate",
  );
  assertExactKeys(
    input.envelope,
    EVENT_ENVELOPE_KEYS,
    "Durable Session event envelope",
  );
  requireNonEmptyString(
    input.envelope.companyId,
    "Durable Session event company id",
  );
  requireNonEmptyString(
    input.envelope.taskId,
    "Durable Session event task id",
  );
  requireValidDate(
    input.envelope.createdAt,
    "Durable Session event envelope timestamp",
  );
  for (const [label, value] of [
    ["run", input.envelope.runId],
    ["agent", input.envelope.agentId],
    [
      "adapter configuration revision",
      input.envelope.adapterConfigRevisionId,
    ],
  ] as const) {
    requireOptionalNonEmptyString(
      value,
      `Durable Session event ${label} id`,
    );
  }
  if (
    input.envelope.ownershipEpoch !== null &&
    input.envelope.ownershipEpoch !== undefined &&
    (!Number.isSafeInteger(input.envelope.ownershipEpoch) ||
      input.envelope.ownershipEpoch < 0)
  ) {
    throw new TaskSessionLifecycleConflict(
      "Durable Session event ownership epoch is invalid",
    );
  }
  const sourceIdentity = [
    input.envelope.sourceKind,
    input.envelope.sourceId,
    input.envelope.immutableSourceKey,
    input.envelope.sourceRecordId,
    input.envelope.sourceIdentityDigest,
  ];
  const hasSourceIdentity = sourceIdentity.some(
    (value) => value !== null && value !== undefined,
  );
  if (
    hasSourceIdentity &&
    (sourceIdentity.some(
      (value) => typeof value !== "string" || value.length === 0,
    ) ||
      !/^[a-f0-9]{64}$/i.test(
        input.envelope.sourceIdentityDigest ?? "",
      ))
  ) {
    throw new TaskSessionLifecycleConflict(
      "Durable Session event envelope has an incomplete source identity",
    );
  }
  if (input.event.metadata !== undefined) {
    if (
      !isPlainObject(input.event.metadata) ||
      Object.keys(input.event.metadata).length > 0
    ) {
      throw new TaskSessionLifecycleConflict(
        "Durable Session events cannot carry event-level metadata",
        { eventType: input.event.type },
      );
    }
  }
  const redactedData = redactTaskSessionPublicationValue(
    input.event.data,
    input.redactor,
  );
  const event = makeDurableTaskSessionEvent({
    id: input.event.id,
    sessionId: input.event.sessionId,
    seq: input.event.seq,
    type: input.event.type,
    data: redactedData,
  });
  const encoded = encodeDurableTaskSessionEventRow(event);
  if (
    canonicalTaskSessionJson(redactedData) !==
    canonicalTaskSessionJson(encoded.data)
  ) {
    throw new TaskSessionLifecycleConflict(
      "Durable Session event contains an unknown or non-canonical shape",
      { eventId: input.event.id, eventType: input.event.type },
    );
  }
  const projection = prepareProjection(input.projection, input.redactor);
  if (projection.comment) {
    const runId = input.envelope.runId ?? null;
    const authorAgentId =
      projection.comment.comment.authorAgentId ?? null;
    if (
      (projection.comment.comment.authorType === "agent" &&
        (runId === null ||
          input.envelope.agentId !== authorAgentId)) ||
      (projection.comment.comment.authorType !== "agent" &&
        runId !== null)
    ) {
      throw new TaskSessionLifecycleConflict(
        "Session projected comment has invalid run attribution",
      );
    }
  }
  const companions = prepareCompanions(
    input.companions,
    encoded.data as Record<string, unknown>,
  );
  const encodedData = encoded.data as Record<string, unknown>;
  const namedMessageIds = [
    encodedData.messageID,
    encodedData.assistantMessageID,
  ].filter((value): value is string => typeof value === "string");
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
  assertExactKeys(
    input,
    new Set(["eventId", "progressCommentId"]),
    "Final Session comment publication",
  );
  requireNonEmptyString(
    input.eventId,
    "Final Session comment event id",
  );
  const progressCommentId = requireNonEmptyString(
    input.progressCommentId,
    "Final Session progress comment id",
  );
  return projectTaskSessionFinalCommentInTx(transaction, {
    eventId: input.eventId,
    progressCommentId,
  });
}
