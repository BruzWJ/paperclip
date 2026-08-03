import {
  issueSessionAssistantSources,
  issueSessionCompletedToolSources,
  issueSessionErrorToolSources,
  issueSessionEvents,
} from "@paperclipai/db";
import {
  issueCommentAuthorTypeSchema,
  issueCommentMetadataSchema,
  issueCommentPresentationSchema,
} from "@paperclipai/shared";
import {
  decodeIssueSessionEvent,
  encodeDurableIssueSessionEventRow,
  encodeIssueSessionEvent,
  type IssueSessionEventType,
} from "@paperclipai/shared/issue-session";
import { sourceTrustMetadataSchema } from "@paperclipai/shared/validators/trust-policy";
import {
  REDACTED_EVENT_VALUE,
  redactSensitiveText,
  sanitizeRecord,
} from "../../redaction.js";
import {
  appendIssueSessionEvent,
  assertReservedIssueSessionMessageIds,
  decodeStoredIssueSessionEvent,
  makeDurableIssueSessionEvent,
  type IssueSessionDbTransaction,
} from "./event-store.js";
import {
  projectIssueSessionEventInTx,
  projectIssueSessionFinalCommentInTx,
  projectIssueSessionToolPrunedEffectInTx,
  type IssueSessionFinalCommentInput,
  type IssueSessionProjectionInput,
} from "./projector.js";
import {
  insertOrAssertIssueSessionSourceUserExecution,
  type IssueSessionSourceUserExecutionInput,
} from "./source-user-execution.js";
import {
  canonicalIssueSessionJson,
  IssueSessionLifecycleConflict,
} from "./store.js";

type EventEnvelope = Omit<
  typeof issueSessionEvents.$inferInsert,
  "id" | "sessionId" | "seq" | "type" | "data"
>;

export interface IssueSessionPublicationRedactor {
  redactText(value: string): string;
  redactValue<T>(value: T): T;
}

export interface IssueSessionDurableCandidate {
  id: string;
  sessionId: string;
  seq: number;
  type: IssueSessionEventType;
  data: unknown;
  /**
   * Event-level metadata is deliberately accepted by the runtime guard only
   * so it can fail closed with a useful lifecycle error. It is never persisted.
   */
  metadata?: Record<string, unknown>;
}

export type IssueSessionToolSourceCompanion =
  | {
      kind: "completed";
      assistantMessageId: string;
      toolId: string;
      sourceOutputText: string;
      normalizationCodecVersion: string;
      createdAt?: Date;
    }
  | {
      kind: "error";
      assistantMessageId: string;
      toolId: string;
      interrupted: boolean;
      interruptedOutputText: string | null;
      createdAt?: Date;
    };

export interface IssueSessionAssistantSourceCompanion {
  assistantMessageId: string;
  sourceTotalTokens?: number;
  sourceAssistantErrorKind?: "aborted" | "other";
  createdAt?: Date;
}

export interface IssueSessionPublicationCompanions {
  sourceUserExecution?: Omit<
    IssueSessionSourceUserExecutionInput,
    "companyId" | "issueId" | "sessionId"
  >;
  toolSource?: IssueSessionToolSourceCompanion;
  assistantSource?: IssueSessionAssistantSourceCompanion;
}

export interface PublishIssueSessionEventInput {
  event: IssueSessionDurableCandidate;
  envelope: EventEnvelope;
  projection?: Omit<IssueSessionProjectionInput, "eventId">;
  companions?: IssueSessionPublicationCompanions;
  redactor?: IssueSessionPublicationRedactor;
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
  "issueId",
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
  "compactionControl",
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
  "issue_request",
  "human_comment",
  "harness_delivery",
  "system_control",
  "run_output",
  "run_progress",
  "issue_update",
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
  "toolSource",
  "assistantSource",
]);
const SOURCE_USER_EXECUTION_KEYS = new Set([
  "messageId",
  "sourceAgentId",
  "providerId",
  "modelId",
  "variant",
  "createdAt",
]);
const SCOPED_SOURCE_USER_EXECUTION_KEYS = new Set([
  "companyId",
  "issueId",
  "sessionId",
  ...SOURCE_USER_EXECUTION_KEYS,
]);
const COMPLETED_TOOL_SOURCE_KEYS = new Set([
  "kind",
  "assistantMessageId",
  "toolId",
  "sourceOutputText",
  "normalizationCodecVersion",
  "createdAt",
]);
const ERROR_TOOL_SOURCE_KEYS = new Set([
  "kind",
  "assistantMessageId",
  "toolId",
  "interrupted",
  "interruptedOutputText",
  "createdAt",
]);
const ASSISTANT_SOURCE_KEYS = new Set([
  "assistantMessageId",
  "sourceTotalTokens",
  "sourceAssistantErrorKind",
  "createdAt",
]);
const NUMERIC_SESSION_ACCOUNTING_KEYS = new Set([
  "maxOutputTokens",
  "outputTokenMax",
  "preserve_recent_tokens",
  "sourceTotalTokens",
]);

const COMPACTION_CONTROL_KEYS = new Set([
  "id",
  "kind",
  "disposition",
  "invalidatedAt",
  "invalidatedByRevertEventId",
  "invalidatedBoundaryMessageId",
  "invalidatedBoundarySeq",
  "historyScopeKind",
  "historyScopeId",
  "audience",
  "contextEpoch",
  "executionLineageId",
  "sourceHighWaterSeq",
  "latestFinishedAssistantMessageId",
  "sourceRunId",
  "sourceRunKind",
  "sourceRefId",
  "sourceRefOrdinal",
  "sourceSegmentOrdinal",
  "recoveryIdentityDigest",
  "compactionRequestMessageId",
  "summaryAssistantMessageId",
  "failedAssistantMessageId",
  "failedAssistantErrorKind",
  "assistantMessageId",
  "toolId",
  "prunedAt",
  "tailStartMessageId",
  "replayMessageId",
  "continuationMessageId",
  "postCheckpointAction",
  "compactionRunId",
  "compactionRunKind",
  "promptTransmissionPhase",
  "protocolSettlementState",
  "promptSettlementReferenceId",
  "accountingId",
  "costEventId",
  "settlementVersion",
  "settledAt",
  "compactionFailureKind",
  "structuralPositions",
  "settingsSnapshot",
  "modelSnapshot",
  "triggerModelSnapshot",
  "createdAt",
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
    throw new IssueSessionLifecycleConflict(`${label} must be a plain object`);
  }
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new IssueSessionLifecycleConflict(
      `${label} contains unknown durable fields`,
      { unknownFields: unknown.sort() },
    );
  }
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new IssueSessionLifecycleConflict(
      `${label} must be a non-empty string`,
    );
  }
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new IssueSessionLifecycleConflict(
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
    throw new IssueSessionLifecycleConflict(
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

function isJsonValue(value: unknown): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!isPlainObject(value)) return false;
  return Object.values(value).every(isJsonValue);
}

/**
 * Applies a literal-aware run redactor when one is available, then always
 * applies Paperclip's structural and textual secret rules recursively.
 * Dates and other non-JSON runtime values are retained for typed companions;
 * event data is separately forced through Paperclip's canonical Session codec.
 */
export function redactIssueSessionPublicationValue<T>(
  value: T,
  redactor?: IssueSessionPublicationRedactor,
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
        // Paperclip Session `tokens` and its closed compaction/source token
        // counters are accounting, not credentials. Every other
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
  projection: PublishIssueSessionEventInput["projection"],
  redactor?: IssueSessionPublicationRedactor,
): Omit<IssueSessionProjectionInput, "eventId"> {
  if (projection === undefined) return {};
  assertExactKeys(projection, PROJECTION_KEYS, "Session projection companion");
  const prepared: Omit<IssueSessionProjectionInput, "eventId"> = {};

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
      throw new IssueSessionLifecycleConflict(
        "Session projected comment has an invalid publication phase",
      );
    }
    if (!COMMENT_SOURCE_KINDS.has(projection.comment.sourceKind)) {
      throw new IssueSessionLifecycleConflict(
        "Session projected comment has an invalid canonical source kind",
      );
    }
    const authorType = issueCommentAuthorTypeSchema.parse(
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
      throw new IssueSessionLifecycleConflict(
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
        : issueCommentPresentationSchema.parse(
            redactIssueSessionPublicationValue(
              comment.presentation,
              redactor,
            ),
          );
    const metadata =
      comment.metadata === undefined || comment.metadata === null
        ? comment.metadata
        : issueCommentMetadataSchema.parse(
            redactIssueSessionPublicationValue(comment.metadata, redactor),
          );
    const sourceTrust =
      comment.sourceTrust === undefined || comment.sourceTrust === null
        ? comment.sourceTrust
        : sourceTrustMetadataSchema.parse(
            redactIssueSessionPublicationValue(
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
      throw new IssueSessionLifecycleConflict(
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
          throw new IssueSessionLifecycleConflict(
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
        body: redactIssueSessionPublicationValue(body, redactor),
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

  if (projection.compactionControl !== undefined) {
    assertExactKeys(
      projection.compactionControl,
      COMPACTION_CONTROL_KEYS,
      "Session compaction-control companion",
    );
    const control = redactIssueSessionPublicationValue(
      projection.compactionControl,
      redactor,
    );
    requireNonEmptyString(control.id, "Session compaction control id");
    requireNonEmptyString(
      control.historyScopeId,
      "Session compaction history scope id",
    );
    if (
      !Number.isSafeInteger(control.contextEpoch) ||
      Number(control.contextEpoch) < 0 ||
      !Number.isSafeInteger(control.sourceHighWaterSeq) ||
      Number(control.sourceHighWaterSeq) < 0 ||
      !Number.isSafeInteger(control.sourceRefOrdinal) ||
      Number(control.sourceRefOrdinal) < 0 ||
      !Number.isSafeInteger(control.sourceSegmentOrdinal) ||
      Number(control.sourceSegmentOrdinal) < 0
    ) {
      throw new IssueSessionLifecycleConflict(
        "Session compaction recovery position is invalid",
      );
    }
    if (
      control.kind !== "checkpoint" &&
      control.kind !== "failed-compaction"
    ) {
      throw new IssueSessionLifecycleConflict(
        "An event publication can carry only a checkpoint or failed-compaction control",
      );
    }
    if (
      control.disposition !== undefined &&
      control.disposition !== "active"
    ) {
      throw new IssueSessionLifecycleConflict(
        "A newly published Session compaction control must be active",
      );
    }
    if (
      (control.invalidatedAt !== undefined &&
        control.invalidatedAt !== null) ||
      (control.invalidatedByRevertEventId !== undefined &&
        control.invalidatedByRevertEventId !== null) ||
      (control.invalidatedBoundaryMessageId !== undefined &&
        control.invalidatedBoundaryMessageId !== null) ||
      (control.invalidatedBoundarySeq !== undefined &&
        control.invalidatedBoundarySeq !== null)
    ) {
      throw new IssueSessionLifecycleConflict(
        "A newly published Session compaction control cannot carry revert invalidation provenance",
      );
    }
    if (!(
      (control.historyScopeKind === "turns-recovery" &&
        control.audience === "turns") ||
      (control.historyScopeKind === "comments-recovery" &&
        control.audience === "comments")
    )) {
      throw new IssueSessionLifecycleConflict(
        "Session compaction control crossed its recovery scope or audience",
      );
    }
    if (
      control.postCheckpointAction !== "none" &&
      control.postCheckpointAction !== "overflow-replay" &&
      control.postCheckpointAction !== "auto-continue"
    ) {
      throw new IssueSessionLifecycleConflict(
        "Session compaction control has an invalid post-checkpoint action",
      );
    }
    requireValidDate(
      control.createdAt,
      "Session compaction control creation time",
    );
    requireNonEmptyString(
      control.executionLineageId,
      "Session compaction execution lineage id",
    );
    requireNonEmptyString(control.sourceRunId, "Session compaction source run id");
    requireNonEmptyString(control.sourceRefId, "Session compaction source ref id");
    if (
      control.compactionRunKind !== "compaction" ||
      (control.sourceRunKind !== "productive" &&
        control.sourceRunKind !== "consult")
    ) {
      throw new IssueSessionLifecycleConflict(
        "Session compaction control has invalid run provenance",
      );
    }
    if (
      control.settingsSnapshot != null ||
      control.modelSnapshot != null ||
      control.triggerModelSnapshot != null ||
      control.recoveryIdentityDigest != null ||
      control.promptTransmissionPhase != null ||
      control.protocolSettlementState != null ||
      control.promptSettlementReferenceId != null ||
      control.accountingId != null ||
      control.costEventId != null ||
      Number(control.settlementVersion ?? 0) !== 0 ||
      control.settledAt != null ||
      control.compactionFailureKind != null
    ) {
      throw new IssueSessionLifecycleConflict(
        "Compaction result effects cannot duplicate prompt ownership or snapshots",
      );
    }
    if (
      control.structuralPositions !== null &&
      control.structuralPositions !== undefined &&
      (!Array.isArray(control.structuralPositions) ||
        !control.structuralPositions.every(
          (position) =>
            isPlainObject(position) && isJsonValue(position),
        ))
    ) {
      throw new IssueSessionLifecycleConflict(
        "Session compaction control has invalid structural positions",
      );
    }
    const requestId = control.compactionRequestMessageId;
    const compactionRunId = control.compactionRunId;
    if (
      typeof requestId !== "string" ||
      requestId.length === 0 ||
      typeof compactionRunId !== "string" ||
      compactionRunId.length === 0
    ) {
      throw new IssueSessionLifecycleConflict(
        "Session compaction control is missing its request or maintenance run",
      );
    }
    if (
      (control.kind === "checkpoint" &&
        (typeof control.summaryAssistantMessageId !== "string" ||
          control.summaryAssistantMessageId.length === 0 ||
          control.failedAssistantMessageId != null ||
          control.failedAssistantErrorKind != null ||
          control.assistantMessageId != null ||
          control.toolId != null ||
          control.prunedAt != null ||
          !(
            (control.postCheckpointAction === "none" &&
              control.replayMessageId == null &&
              control.continuationMessageId == null) ||
            (control.postCheckpointAction === "overflow-replay" &&
              typeof control.replayMessageId === "string" &&
              control.replayMessageId.length > 0 &&
              control.continuationMessageId == null) ||
            (control.postCheckpointAction === "auto-continue" &&
              control.replayMessageId == null &&
              typeof control.continuationMessageId === "string" &&
              control.continuationMessageId.length > 0)
          ))) ||
      (control.kind === "failed-compaction" &&
        (typeof control.failedAssistantMessageId !== "string" ||
          control.failedAssistantMessageId.length === 0 ||
          typeof control.failedAssistantErrorKind !== "string" ||
          control.failedAssistantErrorKind.length === 0 ||
          control.summaryAssistantMessageId != null ||
          control.assistantMessageId != null ||
          control.toolId != null ||
          control.prunedAt != null ||
          control.tailStartMessageId != null ||
          control.replayMessageId != null ||
          control.continuationMessageId != null ||
          control.postCheckpointAction !== "none"))
    ) {
      throw new IssueSessionLifecycleConflict(
        "Session compaction control does not match its typed result shape",
      );
    }
    for (const [label, value] of [
      ["tail start", control.tailStartMessageId],
      ["replay", control.replayMessageId],
      ["continuation", control.continuationMessageId],
    ] as const) {
      requireOptionalNonEmptyString(
        value,
        `Session compaction ${label} message id`,
      );
    }
    prepared.compactionControl =
      control as NonNullable<
        Omit<IssueSessionProjectionInput, "eventId">["compactionControl"]
      >;
  }

  return prepared;
}

function prepareCompanions(
  companions: IssueSessionPublicationCompanions | undefined,
  eventData: Record<string, unknown>,
  redactor?: IssueSessionPublicationRedactor,
): IssueSessionPublicationCompanions {
  if (companions === undefined) return {};
  assertExactKeys(
    companions,
    PUBLICATION_COMPANION_KEYS,
    "Session publication companions",
  );
  const prepared: IssueSessionPublicationCompanions = {};
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
      throw new IssueSessionLifecycleConflict(
        "Session source-user companion changed its event message identity",
        { eventMessageId, companionMessageId: source.messageId },
      );
    }
  }
  if (companions.toolSource !== undefined) {
    const source = companions.toolSource;
    if (!isPlainObject(source)) {
      throw new IssueSessionLifecycleConflict(
        "Session tool-source companion must be a plain object",
      );
    }
    if (source.kind !== "completed" && source.kind !== "error") {
      throw new IssueSessionLifecycleConflict(
        "Session tool-source companion has an unknown kind",
      );
    }
    assertExactKeys(
      source,
      source.kind === "completed"
        ? COMPLETED_TOOL_SOURCE_KEYS
        : ERROR_TOOL_SOURCE_KEYS,
      "Session tool-source companion",
    );
    const common = {
      assistantMessageId: requireNonEmptyString(
        source.assistantMessageId,
        "Session tool-source assistant message id",
      ),
      toolId: requireNonEmptyString(
        source.toolId,
        "Session tool-source tool id",
      ),
      ...(source.createdAt === undefined
        ? {}
        : {
            createdAt: requireValidDate(
              source.createdAt,
              "Session tool-source companion creation time",
            ),
          }),
    };
    if (source.kind === "completed") {
      const sourceOutputText = requireString(
        source.sourceOutputText,
        "Session tool-source output text",
      );
      prepared.toolSource = {
        kind: "completed",
        ...common,
        sourceOutputText: redactIssueSessionPublicationValue(
          sourceOutputText,
          redactor,
        ),
        normalizationCodecVersion: requireNonEmptyString(
          source.normalizationCodecVersion,
          "Session tool-source normalization codec version",
        ),
      };
    } else {
      if (typeof source.interrupted !== "boolean") {
        throw new IssueSessionLifecycleConflict(
          "Session tool error interruption flag must be boolean",
        );
      }
      const interruptedOutputText =
        source.interruptedOutputText === null
          ? null
          : requireString(
              source.interruptedOutputText,
              "Session interrupted tool output text",
            );
      if (!source.interrupted && source.interruptedOutputText !== null) {
        throw new IssueSessionLifecycleConflict(
          "A non-interrupted Session tool error cannot carry interrupted output",
        );
      }
      prepared.toolSource = {
        kind: "error",
        ...common,
        interrupted: source.interrupted,
        interruptedOutputText:
          interruptedOutputText === null
            ? null
            : redactIssueSessionPublicationValue(
                interruptedOutputText,
                redactor,
              ),
      };
    }
    const eventAssistantMessageId =
      typeof eventData.assistantMessageID === "string"
        ? eventData.assistantMessageID
        : null;
    const eventToolId =
      typeof eventData.callID === "string"
        ? eventData.callID
        : null;
    if (
      eventAssistantMessageId !== source.assistantMessageId ||
      eventToolId !== source.toolId
    ) {
      throw new IssueSessionLifecycleConflict(
        "Session tool-source companion changed its event tool identity",
        {
          eventAssistantMessageId,
          companionAssistantMessageId: source.assistantMessageId,
          eventToolId,
          companionToolId: source.toolId,
        },
      );
    }
  }
  if (companions.assistantSource !== undefined) {
    const source = companions.assistantSource;
    assertExactKeys(
      source,
      ASSISTANT_SOURCE_KEYS,
      "Session assistant-source companion",
    );
    if (
      source.sourceTotalTokens === undefined &&
      source.sourceAssistantErrorKind === undefined
    ) {
      throw new IssueSessionLifecycleConflict(
        "Session assistant-source companion is empty",
      );
    }
    if (
      source.sourceTotalTokens !== undefined &&
      (!Number.isSafeInteger(source.sourceTotalTokens) ||
        source.sourceTotalTokens < 0)
    ) {
      throw new IssueSessionLifecycleConflict(
        "Session source total tokens must be a non-negative safe integer",
      );
    }
    if (
      source.sourceAssistantErrorKind !== undefined &&
      source.sourceAssistantErrorKind !== "aborted" &&
      source.sourceAssistantErrorKind !== "other"
    ) {
      throw new IssueSessionLifecycleConflict(
        "Session assistant-source companion has an invalid error kind",
      );
    }
    const assistantMessageId = requireNonEmptyString(
      source.assistantMessageId,
      "Session assistant-source message id",
    );
    const eventAssistantMessageId =
      typeof eventData.assistantMessageID === "string"
        ? eventData.assistantMessageID
        : null;
    if (eventAssistantMessageId !== assistantMessageId) {
      throw new IssueSessionLifecycleConflict(
        "Session assistant-source companion changed its event message identity",
        {
          eventAssistantMessageId,
          companionAssistantMessageId: assistantMessageId,
        },
      );
    }
    prepared.assistantSource = {
      assistantMessageId,
      ...(source.sourceTotalTokens === undefined
        ? {}
        : { sourceTotalTokens: source.sourceTotalTokens }),
      ...(source.sourceAssistantErrorKind === undefined
        ? {}
        : {
            sourceAssistantErrorKind:
              source.sourceAssistantErrorKind,
          }),
      ...(source.createdAt === undefined
        ? {}
        : {
            createdAt: requireValidDate(
              source.createdAt,
              "Session assistant-source companion creation time",
            ),
          }),
    };
  }
  return prepared;
}

async function persistCompanions(
  transaction: IssueSessionDbTransaction,
  scope: { companyId: string; issueId: string; sessionId: string },
  companions: IssueSessionPublicationCompanions,
): Promise<void> {
  if (companions.sourceUserExecution) {
    await insertOrAssertIssueSessionSourceUserExecution(transaction, {
      ...scope,
      ...companions.sourceUserExecution,
    });
  }
  if (companions.toolSource?.kind === "completed") {
    await transaction.insert(issueSessionCompletedToolSources).values({
      ...scope,
      assistantMessageId: companions.toolSource.assistantMessageId,
      toolId: companions.toolSource.toolId,
      sourceOutputText: companions.toolSource.sourceOutputText,
      normalizationCodecVersion:
        companions.toolSource.normalizationCodecVersion,
      ...(companions.toolSource.createdAt
        ? { createdAt: companions.toolSource.createdAt }
        : {}),
    });
  }
  if (companions.toolSource?.kind === "error") {
    await transaction.insert(issueSessionErrorToolSources).values({
      ...scope,
      assistantMessageId: companions.toolSource.assistantMessageId,
      toolId: companions.toolSource.toolId,
      interrupted: companions.toolSource.interrupted,
      interruptedOutputText:
        companions.toolSource.interruptedOutputText,
      ...(companions.toolSource.createdAt
        ? { createdAt: companions.toolSource.createdAt }
        : {}),
    });
  }
  if (companions.assistantSource) {
    await transaction.insert(issueSessionAssistantSources).values({
      ...scope,
      assistantMessageId: companions.assistantSource.assistantMessageId,
      sourceTotalTokens:
        companions.assistantSource.sourceTotalTokens ?? null,
      sourceAssistantErrorKind:
        companions.assistantSource.sourceAssistantErrorKind ?? null,
      ...(companions.assistantSource.createdAt
        ? { createdAt: companions.assistantSource.createdAt }
        : {}),
    });
  }
}

/**
 * Publishes a source-user companion for an already-projected canonical user
 * message. Native overflow preparation needs this standalone form before a
 * provider attempt exists; it still uses the same closed validation entrance.
 */
export async function publishIssueSessionSourceUserExecutionInTx(
  transaction: IssueSessionDbTransaction,
  input: IssueSessionSourceUserExecutionInput,
  redactor?: IssueSessionPublicationRedactor,
): Promise<void> {
  assertExactKeys(
    input,
    SCOPED_SOURCE_USER_EXECUTION_KEYS,
    "Scoped Session source-user publication",
  );
  const scope = {
    companyId: requireNonEmptyString(
      input.companyId,
      "Session source-user company id",
    ),
    issueId: requireNonEmptyString(
      input.issueId,
      "Session source-user issue id",
    ),
    sessionId: requireNonEmptyString(
      input.sessionId,
      "Session source-user Session id",
    ),
  };
  const companions = prepareCompanions(
    {
      sourceUserExecution: {
        messageId: input.messageId,
        sourceAgentId: input.sourceAgentId,
        providerId: input.providerId,
        modelId: input.modelId,
        variant: input.variant,
        ...(input.createdAt === undefined
          ? {}
          : { createdAt: input.createdAt }),
      },
    },
    { messageID: input.messageId },
    redactor,
  );
  await persistCompanions(transaction, scope, companions);
}

/**
 * The only steady-state entrance for a durable Issue Session publication.
 * It prepares every byte before the first insert, appends the immutable event,
 * projects it, and persists typed bridge companions in the caller's single
 * PostgreSQL transaction.
 */
export async function publishIssueSessionEventInTx(
  transaction: IssueSessionDbTransaction,
  input: PublishIssueSessionEventInput,
): Promise<Awaited<ReturnType<typeof projectIssueSessionEventInTx>>> {
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
    input.envelope.issueId,
    "Durable Session event issue id",
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
    throw new IssueSessionLifecycleConflict(
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
    throw new IssueSessionLifecycleConflict(
      "Durable Session event envelope has an incomplete source identity",
    );
  }
  if (input.event.metadata !== undefined) {
    if (
      !isPlainObject(input.event.metadata) ||
      Object.keys(input.event.metadata).length > 0
    ) {
      throw new IssueSessionLifecycleConflict(
        "Durable Session events cannot carry event-level metadata",
        { eventType: input.event.type },
      );
    }
  }
  const redactedData = redactIssueSessionPublicationValue(
    input.event.data,
    input.redactor,
  );
  const event = makeDurableIssueSessionEvent({
    id: input.event.id,
    sessionId: input.event.sessionId,
    seq: input.event.seq,
    type: input.event.type,
    data: redactedData,
  });
  const encoded = encodeDurableIssueSessionEventRow(event);
  if (
    canonicalIssueSessionJson(redactedData) !==
    canonicalIssueSessionJson(encoded.data)
  ) {
    throw new IssueSessionLifecycleConflict(
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
      throw new IssueSessionLifecycleConflict(
        "Session projected comment has invalid run attribution",
      );
    }
  }
  const companions = prepareCompanions(
    input.companions,
    encoded.data as Record<string, unknown>,
    input.redactor,
  );
  const encodedData = encoded.data as Record<string, unknown>;
  const namedMessageIds = [
    encodedData.messageID,
    encodedData.assistantMessageID,
  ].filter((value): value is string => typeof value === "string");
  await assertReservedIssueSessionMessageIds(
    transaction,
    {
      companyId: input.envelope.companyId,
      issueId: input.envelope.issueId,
      sessionId: input.event.sessionId,
    },
    namedMessageIds,
  );
  const inserted = await appendIssueSessionEvent(transaction, {
    event,
    envelope: input.envelope,
  });
  const projected = await projectIssueSessionEventInTx(transaction, {
    eventId: inserted.id,
    ...projection,
  });
  await persistCompanions(
    transaction,
    {
      companyId: inserted.companyId,
      issueId: inserted.issueId,
      sessionId: inserted.sessionId,
    },
    companions,
  );
  return projected;
}

/**
 * Live Session deltas are validated and redacted here but intentionally never
 * inserted. The full-value durable end event remains the replay boundary.
 */
export function prepareIssueSessionLiveEvent(input: {
  type:
    | "session.next.text.delta"
    | "session.next.reasoning.delta"
    | "session.next.tool.input.delta"
    | "session.next.compaction.delta";
  data: unknown;
  redactor?: IssueSessionPublicationRedactor;
}): Record<string, unknown> {
  const redactedData = redactIssueSessionPublicationValue(
    input.data,
    input.redactor,
  );
  const candidate = decodeIssueSessionEvent({
    id: "evt_live_publication",
    type: input.type,
    data: redactedData,
  });
  const encoded = encodeIssueSessionEvent(candidate) as Record<
    string,
    unknown
  >;
  if (
    canonicalIssueSessionJson(redactedData) !==
    canonicalIssueSessionJson(encoded.data)
  ) {
    throw new IssueSessionLifecycleConflict(
      "Live Session event contains an unknown or non-canonical shape",
      { eventType: input.type },
    );
  }
  return encoded;
}

export async function publishIssueSessionFinalCommentInTx(
  transaction: IssueSessionDbTransaction,
  input: IssueSessionFinalCommentInput,
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
  return projectIssueSessionFinalCommentInTx(transaction, {
    eventId: input.eventId,
    progressCommentId,
  });
}

type ToolPrunedEffectInput = Parameters<
  typeof projectIssueSessionToolPrunedEffectInTx
>[1];

const TOOL_PRUNED_EFFECT_KEYS = new Set([
  "companyId",
  "issueId",
  "sessionId",
  "seq",
  ...COMPACTION_CONTROL_KEYS,
]);

export async function publishIssueSessionToolPrunedEffectInTx(
  transaction: IssueSessionDbTransaction,
  input: ToolPrunedEffectInput,
  redactor?: IssueSessionPublicationRedactor,
) {
  assertExactKeys(
    input,
    TOOL_PRUNED_EFFECT_KEYS,
    "Session tool-pruned effect",
  );
  const prepared = redactIssueSessionPublicationValue(input, redactor);
  requireNonEmptyString(prepared.id, "Session tool-pruned effect id");
  requireNonEmptyString(
    prepared.companyId,
    "Session tool-pruned company id",
  );
  requireNonEmptyString(
    prepared.issueId,
    "Session tool-pruned issue id",
  );
  requireNonEmptyString(
    prepared.sessionId,
    "Session tool-pruned Session id",
  );
  requireNonEmptyString(
    prepared.historyScopeId,
    "Session tool-pruned history scope id",
  );
  requireNonEmptyString(
    prepared.assistantMessageId,
    "Session pruned-tool assistant message id",
  );
  requireNonEmptyString(
    prepared.toolId,
    "Session pruned-tool id",
  );
  requireValidDate(
    prepared.createdAt,
    "Session tool-pruned creation time",
  );
  if (
    !Number.isSafeInteger(prepared.seq) ||
    Number(prepared.seq) < 0 ||
    !Number.isSafeInteger(prepared.contextEpoch) ||
    prepared.contextEpoch < 0 ||
    !Number.isSafeInteger(prepared.sourceHighWaterSeq) ||
    prepared.sourceHighWaterSeq < 0 ||
    !Number.isSafeInteger(prepared.sourceRefOrdinal) ||
    prepared.sourceRefOrdinal < 0 ||
    !Number.isSafeInteger(prepared.sourceSegmentOrdinal) ||
    prepared.sourceSegmentOrdinal < 0 ||
    !(prepared.prunedAt instanceof Date) ||
    !Number.isFinite(prepared.prunedAt.getTime())
  ) {
    throw new IssueSessionLifecycleConflict(
      "Session tool-pruned effect has an invalid sequence or timestamp",
    );
  }
  if (
    prepared.kind !== "tool-pruned" ||
    (prepared.disposition !== undefined &&
      prepared.disposition !== "active") ||
    (prepared.invalidatedAt !== undefined &&
      prepared.invalidatedAt !== null) ||
    (prepared.invalidatedByRevertEventId !== undefined &&
      prepared.invalidatedByRevertEventId !== null) ||
    (prepared.invalidatedBoundaryMessageId !== undefined &&
      prepared.invalidatedBoundaryMessageId !== null) ||
    (prepared.invalidatedBoundarySeq !== undefined &&
      prepared.invalidatedBoundarySeq !== null) ||
    prepared.compactionRequestMessageId != null ||
    prepared.summaryAssistantMessageId != null ||
    prepared.failedAssistantMessageId != null ||
    prepared.failedAssistantErrorKind != null ||
    prepared.tailStartMessageId != null ||
    prepared.replayMessageId != null ||
    prepared.continuationMessageId != null ||
    prepared.postCheckpointAction !== "none" ||
    prepared.compactionRunId != null ||
    (prepared.compactionRunKind !== undefined &&
      prepared.compactionRunKind !== "compaction") ||
    prepared.recoveryIdentityDigest != null ||
    prepared.promptTransmissionPhase != null ||
    prepared.protocolSettlementState != null ||
    prepared.promptSettlementReferenceId != null ||
    prepared.accountingId != null ||
    prepared.costEventId != null ||
    Number(prepared.settlementVersion ?? 0) !== 0 ||
    prepared.settledAt != null ||
    prepared.compactionFailureKind != null ||
    prepared.settingsSnapshot != null ||
    prepared.modelSnapshot != null ||
    prepared.triggerModelSnapshot != null
  ) {
    throw new IssueSessionLifecycleConflict(
      "Session tool-pruned effect does not match its typed control shape",
    );
  }
  if (
    !(
      (prepared.historyScopeKind === "turns-recovery" &&
        prepared.audience === "turns") ||
      (prepared.historyScopeKind === "comments-recovery" &&
        prepared.audience === "comments")
    )
  ) {
    throw new IssueSessionLifecycleConflict(
      "Session tool-pruned effect has an invalid scope",
    );
  }
  requireNonEmptyString(
    prepared.executionLineageId,
    "Session tool-pruned execution lineage id",
  );
  requireNonEmptyString(prepared.sourceRunId, "Session tool-pruned source run id");
  requireNonEmptyString(prepared.sourceRefId, "Session tool-pruned source ref id");
  if (
    prepared.sourceRunKind !== "productive" &&
    prepared.sourceRunKind !== "consult"
  ) {
    throw new IssueSessionLifecycleConflict(
      "Session tool-pruned effect has invalid source-run provenance",
    );
  }
  if (
    prepared.structuralPositions !== null &&
    prepared.structuralPositions !== undefined &&
    (!Array.isArray(prepared.structuralPositions) ||
      !prepared.structuralPositions.every(
        (position) =>
          isPlainObject(position) && isJsonValue(position),
      ))
  ) {
    throw new IssueSessionLifecycleConflict(
      "Session tool-pruned effect has invalid structural positions",
    );
  }
  return projectIssueSessionToolPrunedEffectInTx(
    transaction,
    prepared,
  );
}

/**
 * Canonical run-log view rendering. It contains only already-redacted Session
 * event encodings and therefore creates no second retained log.
 */
export function issueSessionEventsAsNdjson(
  rows: readonly (typeof issueSessionEvents.$inferSelect)[],
): string {
  return rows
    .map((row) => {
      const event = decodeStoredIssueSessionEvent(row).event;
      const encoded = encodeIssueSessionEvent(event);
      const timestamp = (encoded.data as { timestamp: number }).timestamp;
      return JSON.stringify({
        ts: new Date(timestamp).toISOString(),
        stream: "system",
        chunk: JSON.stringify(encoded),
        seq: row.seq,
      });
    })
    .join("\n")
    .concat(rows.length > 0 ? "\n" : "");
}
