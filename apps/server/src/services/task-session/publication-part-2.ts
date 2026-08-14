import {
  taskCommentAuthorTypeSchema,
  taskCommentMetadataSchema,
  taskCommentPresentationSchema,
} from "@paperclipai/shared";

import { sourceTrustMetadataSchema } from "@paperclipai/shared/validators/trust-policy";

import { type TaskSessionDbTransaction } from "./event-store.js";

import { type TaskSessionProjectionInput } from "./projector.js";

import { insertOrAssertTaskSessionSourceUserExecution } from "./source-user-execution.js";

import {
  type PublishTaskSessionEventInput,
  type TaskSessionPublicationCompanions,
  type TaskSessionPublicationRedactor,
  assertExactKeys,
  COMMENT_KEYS,
  COMMENT_PHASES,
  COMMENT_PROJECTION_KEYS,
  COMMENT_SOURCE_KINDS,
  INPUT_BINDING_KEYS,
  PROJECTION_KEYS,
  PUBLICATION_COMPANION_KEYS,
  redactTaskSessionPublicationValue,
  requireNonEmptyString,
  requireString,
  requireValidDate,
  SOURCE_USER_EXECUTION_KEYS,
  STEERING_SEGMENT_KEYS,
} from "./publication-part-1.js";
import { TaskSessionLifecycleConflict } from "./store.js";

export function prepareProjection(
  projection: PublishTaskSessionEventInput["projection"],
  redactor?: TaskSessionPublicationRedactor,
): Omit<TaskSessionProjectionInput, "eventId"> {
  if (projection === undefined) return {};
  assertExactKeys(projection, PROJECTION_KEYS, "Session projection companion");
  const prepared: Omit<TaskSessionProjectionInput, "eventId"> = {};

  if (projection.inputBinding !== undefined) {
    assertExactKeys(projection.inputBinding, INPUT_BINDING_KEYS, "Session input-binding companion");
    prepared.inputBinding = {
      sourceRefId:
        projection.inputBinding.sourceRefId === null
          ? null
          : requireNonEmptyString(projection.inputBinding.sourceRefId, "Session source ref id"),
      dispositionId: requireNonEmptyString(
        projection.inputBinding.dispositionId,
        "Session input disposition id",
      ),
    };
  }

  if (projection.comment !== undefined) {
    assertExactKeys(projection.comment, COMMENT_PROJECTION_KEYS, "Session comment projection companion");
    assertExactKeys(projection.comment.comment, COMMENT_KEYS, "Session projected comment");
    const comment = projection.comment.comment;
    if (!COMMENT_PHASES.has(projection.comment.phase)) {
      throw new TaskSessionLifecycleConflict("Session projected comment has an invalid publication phase");
    }
    if (!COMMENT_SOURCE_KINDS.has(projection.comment.sourceKind)) {
      throw new TaskSessionLifecycleConflict(
        "Session projected comment has an invalid canonical source kind",
      );
    }
    const authorType = taskCommentAuthorTypeSchema.parse(comment.authorType);
    const authorAgentId = comment.authorAgentId ?? null;
    const authorUserId = comment.authorUserId ?? null;
    const authorPluginInstallationId = comment.authorPluginInstallationId ?? null;
    const authorPluginKey = comment.authorPluginKey ?? null;
    if (
      (authorAgentId !== null && (typeof authorAgentId !== "string" || authorAgentId.length === 0)) ||
      (authorUserId !== null && (typeof authorUserId !== "string" || authorUserId.length === 0)) ||
      (authorPluginInstallationId !== null &&
        (typeof authorPluginInstallationId !== "string" || authorPluginInstallationId.length === 0)) ||
      (authorPluginKey !== null && (typeof authorPluginKey !== "string" || authorPluginKey.length === 0)) ||
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
      throw new TaskSessionLifecycleConflict("Session projected comment has an invalid author identity");
    }
    const body = requireString(comment.body, "Session projected comment body");
    const presentation =
      comment.presentation === undefined || comment.presentation === null
        ? comment.presentation
        : taskCommentPresentationSchema.parse(
            redactTaskSessionPublicationValue(comment.presentation, redactor),
          );
    const metadata =
      comment.metadata === undefined || comment.metadata === null
        ? comment.metadata
        : taskCommentMetadataSchema.parse(redactTaskSessionPublicationValue(comment.metadata, redactor));
    const sourceTrust =
      comment.sourceTrust === undefined || comment.sourceTrust === null
        ? comment.sourceTrust
        : sourceTrustMetadataSchema.parse(redactTaskSessionPublicationValue(comment.sourceTrust, redactor));
    const replyToCommentId = comment.replyToCommentId ?? null;
    const replyToProjectedEventSeq = comment.replyToProjectedEventSeq ?? null;
    const threadRootCommentId = comment.threadRootCommentId ?? null;
    const threadRootProjectedEventSeq = comment.threadRootProjectedEventSeq ?? null;
    const replyTuple = [
      replyToCommentId,
      replyToProjectedEventSeq,
      threadRootCommentId,
      threadRootProjectedEventSeq,
    ];
    if (!(
      replyTuple.every((value) => value === null) ||
      (typeof replyToCommentId === "string" &&
        replyToCommentId.length > 0 &&
        Number.isSafeInteger(replyToProjectedEventSeq) &&
        Number(replyToProjectedEventSeq) >= 0 &&
        typeof threadRootCommentId === "string" &&
        threadRootCommentId.length > 0 &&
        Number.isSafeInteger(threadRootProjectedEventSeq) &&
        Number(threadRootProjectedEventSeq) >= 0)
    )) {
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
          throw new TaskSessionLifecycleConflict("Session comment steering-segment companion is invalid");
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
      sourceId: requireNonEmptyString(projection.comment.sourceId, "Session projected comment source id"),
      messageId: requireNonEmptyString(projection.comment.messageId, "Session projected comment message id"),
      ...(steeringSegment === undefined ? {} : { steeringSegment }),
      comment: {
        id: requireNonEmptyString(comment.id, "Session projected comment id"),
        body: redactTaskSessionPublicationValue(body, redactor),
        authorType,
        authorAgentId,
        authorUserId,
        authorPluginInstallationId,
        authorPluginKey,
        replyToCommentId,
        replyToProjectedEventSeq: replyToProjectedEventSeq as number | null,
        threadRootCommentId,
        threadRootProjectedEventSeq: threadRootProjectedEventSeq as number | null,
        ...(presentation === undefined ? {} : { presentation }),
        ...(metadata === undefined ? {} : { metadata }),
        ...(sourceTrust === undefined ? {} : { sourceTrust }),
      },
    };
  }

  return prepared;
}

export function prepareCompanions(
  companions: TaskSessionPublicationCompanions | undefined,
  eventData: Record<string, unknown>,
): TaskSessionPublicationCompanions {
  if (companions === undefined) return {};
  assertExactKeys(companions, PUBLICATION_COMPANION_KEYS, "Session publication companions");
  const prepared: TaskSessionPublicationCompanions = {};
  if (companions.sourceUserExecution !== undefined) {
    const source = companions.sourceUserExecution;
    assertExactKeys(source, SOURCE_USER_EXECUTION_KEYS, "Session source-user companion");
    const createdAt =
      source.createdAt === undefined
        ? undefined
        : requireValidDate(source.createdAt, "Session source-user companion creation time");
    prepared.sourceUserExecution = {
      messageId: requireNonEmptyString(source.messageId, "Session source-user message id"),
      sourceAgentId: requireNonEmptyString(source.sourceAgentId, "Session source-user agent id"),
      providerId: requireNonEmptyString(source.providerId, "Session source-user provider id"),
      modelId: requireNonEmptyString(source.modelId, "Session source-user model id"),
      variant:
        source.variant === null ? null : requireNonEmptyString(source.variant, "Session source-user variant"),
      ...(createdAt === undefined ? {} : { createdAt }),
    };
    const eventMessageId = typeof eventData.messageID === "string" ? eventData.messageID : null;
    if (eventMessageId !== source.messageId) {
      throw new TaskSessionLifecycleConflict(
        "Session source-user companion changed its event message identity",
        { eventMessageId, companionMessageId: source.messageId },
      );
    }
  }
  return prepared;
}

export async function persistCompanions(
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
