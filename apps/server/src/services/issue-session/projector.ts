import {
  issueExecutionHistoryViews,
  issueExecutionRefs,
  issueExecutionSessions,
  issueCommentProjectionSources,
  issueComments,
  issueSessionEvents,
  issueSessionInputs,
  issueSessionMessages,
  issueSessions,
  issues,
} from "@paperclipai/db";
import * as IssueSession from "@paperclipai/shared/issue-session";
import type {
  IssueCommentAuthorType,
  IssueCommentMetadata,
  IssueCommentPresentation,
  SourceTrustMetadata,
} from "@paperclipai/shared";
import {
  encodeIssueSessionMessage,
  isIssueSessionEvent,
  versionedIssueSessionEventType,
} from "@paperclipai/shared/issue-session";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { DateTime } from "effect";
import {
  IssueSessionInvariantError,
  IssueSessionLifecycleConflict,
  decodeStoredIssueSessionMessage,
  encodeIssueSessionMessageData,
  isSettledIssueSessionMessage,
} from "./store.js";
import {
  revokeIssueExecutionPromptCapabilitiesForSessionInTransaction,
} from "../issue-execution-run-service.js";
import { resetIssueSessionContext } from "./context-epoch.js";
import {
  commitProjectedIssueSessionSequence,
  loadStoredIssueSessionEvent,
  projectableIssueSessionEvent,
  readProjectedIssueSessionSequence,
  type IssueSessionDbTransaction,
  type ProjectableIssueSessionEvent,
  type StoredIssueSessionEvent,
} from "./event-store.js";
import { projectIssueSessionInput } from "./input-projection.js";
import {
  applyIssueSessionMessageEvent,
  type IssueSessionMessageStore,
} from "./message-updater.js";
import { syncComment } from "../issue-references.js";

type ProjectionSourceKind =
  typeof issueCommentProjectionSources.$inferInsert.sourceKind;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}
export interface IssueSessionCommentProjectionInput {
  phase: "admitted" | "promoted" | "direct";
  sourceKind: ProjectionSourceKind;
  sourceId: string;
  messageId: string;
  steeringSegment?: {
    steeringTargetRunId: string;
    refId: string;
    refOrdinal: number;
    segmentOrdinal: number;
  } | null;
  comment: {
    id: string;
    body: string;
    authorType: IssueCommentAuthorType;
    authorAgentId: string | null;
    authorUserId: string | null;
    authorPluginInstallationId: string | null;
    authorPluginKey: string | null;
    replyToCommentId: string | null;
    replyToProjectedEventSeq: number | null;
    threadRootCommentId: string | null;
    threadRootProjectedEventSeq: number | null;
    presentation?: IssueCommentPresentation | null;
    metadata?: IssueCommentMetadata | null;
    sourceTrust?: SourceTrustMetadata | null;
  };
}

export interface IssueSessionProjectionInput {
  /**
   * The immutable event must already exist. The projector reloads the canonical
   * bytes from this row so a caller cannot project a live-only or divergent
   * object.
   */
  eventId: string;
  /**
   * Prompt admission needs the pre-reserved ref id before the ref itself is
   * inserted. The Issue Session input projector owns insertion/promotion of the inbox
   * row; this binding only supplies Paperclip's non-model-visible correlation.
   */
  inputBinding?: {
    sourceRefId: string | null;
    dispositionId: string;
  };
  /**
   * Only source contracts with a human-visible comment-of-record supply this
   * companion. It does not participate in Issue Session message/history lowering.
   */
  comment?: IssueSessionCommentProjectionInput;
}

export function assertIssueSessionRunProgressProjection(
  event: { id: string; runId: string | null; agentId: string | null },
  input: IssueSessionCommentProjectionInput,
): void {
  if (input.sourceKind !== "run_progress") return;
  if (
    input.phase !== "direct" ||
    !event.runId ||
    !event.agentId ||
    input.sourceId !== event.runId ||
    input.comment.authorType !== "agent" ||
    input.comment.authorAgentId !== event.agentId ||
    input.comment.body !== "" ||
    input.comment.presentation?.kind !== "run_progress"
  ) {
    throw new IssueSessionLifecycleConflict(
      "Run-progress projection must be the empty stable comment for its producing run",
      { eventId: event.id, runId: event.runId },
    );
  }
}

const DURABLE_SESSION_EVENT_VERSIONS = new Map<string, number>([
  ["session.next.agent.switched", 1],
  ["session.next.model.switched", 1],
  ["session.next.moved", 1],
  ["session.next.prompted", 1],
  ["session.next.prompt.admitted", 1],
  ["session.next.context.updated", 1],
  ["session.next.synthetic", 1],
  ["session.next.shell.started", 1],
  ["session.next.shell.ended", 1],
  ["session.next.step.started", 1],
  ["session.next.step.ended", 3],
  ["session.next.step.failed", 2],
  ["session.next.text.started", 1],
  ["session.next.text.ended", 1],
  ["session.next.reasoning.started", 1],
  ["session.next.reasoning.ended", 1],
  ["session.next.tool.input.started", 1],
  ["session.next.tool.input.ended", 1],
  ["session.next.tool.called", 1],
  ["session.next.tool.progress", 1],
  ["session.next.tool.success", 1],
  ["session.next.tool.failed", 1],
  ["session.next.retried", 1],
  ["session.next.revert.staged", 1],
  ["session.next.revert.cleared", 1],
  ["session.next.revert.committed", 1],
]);

export function issueSessionEventVersion(type: string): number {
  const version = DURABLE_SESSION_EVENT_VERSIONS.get(type);
  if (version === undefined) {
    throw new IssueSessionLifecycleConflict(
      "Session event type is not a durable Issue Session event",
      { eventType: type },
    );
  }
  return version;
}

export type PersistedIssueSessionEvent =
  IssueSession.DurableEvent & {
    id: string;
    durable: {
      aggregateID: string;
      seq: number;
      version: number;
    };
  };

export function assertDurableIssueSessionEvent(
  event: IssueSession.IssueSessionEvent,
): void {
  const eventType = event.type;
  if (
    event.metadata !== undefined &&
    Object.keys(event.metadata).length > 0
  ) {
    throw new IssueSessionLifecycleConflict(
      "Durable Session events cannot carry event-level metadata",
      { eventType: event.type },
    );
  }
  const eventId = (event as { id?: unknown }).id;
  if (
    typeof eventId !== "string" ||
    !eventId.startsWith("evt_")
  ) {
    throw new IssueSessionLifecycleConflict(
      "Durable Session event is missing its canonical event identity",
      { eventType: event.type },
    );
  }
  if (
    typeof event.data !== "object" ||
    event.data === null ||
    typeof event.data.sessionID !== "string" ||
    event.data.sessionID.length === 0
  ) {
    throw new IssueSessionLifecycleConflict(
      "Durable Session event data is malformed",
      { eventType: event.type },
    );
  }
  const expectedVersion = issueSessionEventVersion(event.type);
  const durable = (
    event as {
      durable?: {
        aggregateID?: unknown;
        seq?: unknown;
        version?: unknown;
      };
    }
  ).durable;
  if (
    durable !== undefined &&
    (durable.aggregateID !== event.data.sessionID ||
      !Number.isInteger(durable.seq) ||
      (durable.seq as number) < 1 ||
      durable.version !== expectedVersion)
  ) {
    throw new IssueSessionLifecycleConflict(
      "Durable Session event has an invalid sequence envelope",
      { eventId, eventType: event.type },
    );
  }
  if (!isIssueSessionEvent(event)) {
    throw new IssueSessionLifecycleConflict(
      "Durable Session event does not satisfy the Issue Session schema",
      { eventId, eventType },
    );
  }
}

type DurableEventRow = ProjectableIssueSessionEvent;
type SessionMessageRow = typeof issueSessionMessages.$inferSelect;
type SessionMessage = IssueSession.IssueSessionMessage;

export function issueSessionMessageFromRow(
  row: SessionMessageRow,
): SessionMessage {
  return decodeStoredIssueSessionMessage(row);
}

function sessionTimestamp(value: unknown, label: string): Date {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value)
  ) {
    throw new IssueSessionLifecycleConflict(
      `${label} must contain a canonical millisecond timestamp`,
    );
  }
  return new Date(value);
}

async function findMessage(
  transaction: IssueSessionDbTransaction,
  row: DurableEventRow,
  messageId: string,
): Promise<SessionMessageRow | null> {
  const rows = await transaction
    .select()
    .from(issueSessionMessages)
    .where(
      and(
        eq(issueSessionMessages.companyId, row.companyId),
        eq(issueSessionMessages.issueId, row.issueId),
        eq(issueSessionMessages.sessionId, row.sessionId),
        eq(issueSessionMessages.id, messageId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

function sameMessageEnvelope(
  existing: SessionMessageRow,
  event: DurableEventRow,
  message: SessionMessage,
  sequence: number,
): boolean {
  return (
    existing.companyId === event.companyId &&
    existing.issueId === event.issueId &&
    existing.sessionId === event.sessionId &&
    existing.id === message.id &&
    existing.type === message.type &&
    existing.seq === sequence
  );
}

function createMessageProjectionStore(
  transaction: IssueSessionDbTransaction,
  event: DurableEventRow,
  sequence: number,
  rebuilding: boolean,
  touchedMessageIds?: Set<string>,
): IssueSessionMessageStore {
  const updateMessage = async (
    expectedType: "assistant" | "shell",
    message: SessionMessage,
  ) => {
    if (message.type !== expectedType) {
      throw new IssueSessionLifecycleConflict(
        `Issue Session ${expectedType} updater received ${message.type}`,
        { messageId: message.id },
      );
    }
    const existing = await findMessage(transaction, event, message.id);
    if (!existing || existing.type !== expectedType) {
      throw new IssueSessionInvariantError(
        `Projected ${expectedType} message ${message.id} is missing`,
      );
    }
    if (isSettledIssueSessionMessage(existing)) {
      throw new IssueSessionLifecycleConflict(
        `Settled ${expectedType} message ${message.id} cannot receive another model-visible update`,
        { messageId: message.id, eventId: event.id },
      );
    }
    const updated = await transaction
      .update(issueSessionMessages)
      .set({
        data: encodeIssueSessionMessageData(message),
        modelStateSeq: event.seq,
        timeCreated: sessionTimestamp(
          (encodeIssueSessionMessage(message) as { time: { created: number } })
            .time.created,
          `Session message ${message.id}`,
        ),
        timeUpdated: event.eventTimestamp,
      })
      .where(
        and(
          eq(issueSessionMessages.companyId, event.companyId),
          eq(issueSessionMessages.issueId, event.issueId),
          eq(issueSessionMessages.sessionId, event.sessionId),
          eq(issueSessionMessages.id, message.id),
          eq(issueSessionMessages.type, expectedType),
        ),
      )
      .returning({ id: issueSessionMessages.id });
    if (!updated[0]) {
      throw new IssueSessionInvariantError(
        `Projected ${expectedType} message ${message.id} disappeared`,
      );
    }
  };

  return {
    async getCurrentAssistant() {
      const rows = await transaction
        .select()
        .from(issueSessionMessages)
        .where(
          and(
            eq(issueSessionMessages.companyId, event.companyId),
            eq(issueSessionMessages.issueId, event.issueId),
            eq(issueSessionMessages.sessionId, event.sessionId),
            eq(issueSessionMessages.type, "assistant"),
            sql`${issueSessionMessages.data}->'time'->>'completed' is null`,
          ),
        )
        .orderBy(desc(issueSessionMessages.seq))
        .limit(1);
      const message = rows[0]
        ? issueSessionMessageFromRow(rows[0])
        : undefined;
      return message?.type === "assistant" ? message : undefined;
    },
    async getAssistant(messageID) {
      const row = await findMessage(transaction, event, messageID);
      if (!row || row.type !== "assistant") return undefined;
      const message = issueSessionMessageFromRow(row);
      return message.type === "assistant" ? message : undefined;
    },
    async getCurrentShell(callID) {
      const rows = await transaction
        .select()
        .from(issueSessionMessages)
        .where(
          and(
            eq(issueSessionMessages.companyId, event.companyId),
            eq(issueSessionMessages.issueId, event.issueId),
            eq(issueSessionMessages.sessionId, event.sessionId),
            eq(issueSessionMessages.type, "shell"),
            sql`${issueSessionMessages.data}->>'callID' = ${callID}`,
            sql`${issueSessionMessages.data}->'time'->>'completed' is null`,
          ),
        )
        .orderBy(desc(issueSessionMessages.seq))
        .limit(1);
      const message = rows[0]
        ? issueSessionMessageFromRow(rows[0])
        : undefined;
      return message?.type === "shell" ? message : undefined;
    },
    updateAssistant(message) {
      return updateMessage("assistant", message);
    },
    updateShell(message) {
      return updateMessage("shell", message);
    },
    async appendMessage(message) {
      touchedMessageIds?.add(message.id);
      const timestamp = sessionTimestamp(
        (
          encodeIssueSessionMessage(message) as unknown as {
            time: { created: number };
          }
        ).time.created,
        `Session message ${message.id}`,
      );
      const inserted = await transaction
        .insert(issueSessionMessages)
        .values({
          id: message.id,
          companyId: event.companyId,
          issueId: event.issueId,
          sessionId: event.sessionId,
          seq: sequence,
          modelStateSeq: sequence,
          type: message.type,
          data: encodeIssueSessionMessageData(message),
          runId: event.runId,
          ownershipEpoch: event.ownershipEpoch,
          agentId: event.agentId,
          adapterConfigRevisionId: event.adapterConfigRevisionId,
          timeCreated: timestamp,
          timeUpdated: timestamp,
        })
        .onConflictDoNothing()
        .returning();
      if (inserted[0]) return;

      const existing = await findMessage(
        transaction,
        event,
        message.id,
      );
      if (!existing || !sameMessageEnvelope(existing, event, message, sequence)) {
        throw new IssueSessionLifecycleConflict(
          "PostgreSQL Session message identity or sequence was reused",
          { messageId: message.id, sequence },
        );
      }
      if (rebuilding) {
        await transaction
          .update(issueSessionMessages)
          .set({
            data: encodeIssueSessionMessageData(message),
            modelStateSeq: sequence,
            timeCreated: timestamp,
            timeUpdated: event.eventTimestamp,
          })
          .where(eq(issueSessionMessages.id, message.id));
        return;
      }
      if (
        JSON.stringify(existing.data) !==
        JSON.stringify(encodeIssueSessionMessageData(message))
      ) {
        throw new IssueSessionLifecycleConflict(
          "PostgreSQL Session message append changed its canonical payload",
          { messageId: message.id },
        );
      }
    },
  };
}

function sameProjectedComment(
  existing: typeof issueComments.$inferSelect,
  event: DurableEventRow,
  input: IssueSessionCommentProjectionInput,
): boolean {
  return (
    existing.id === input.comment.id &&
    existing.companyId === event.companyId &&
    existing.issueId === event.issueId &&
    existing.sessionId === event.sessionId &&
    existing.canonicalSourceKind === input.sourceKind &&
    existing.canonicalSourceId === input.sourceId &&
    existing.canonicalMessageId === input.messageId &&
    existing.body === input.comment.body &&
    existing.runId === event.runId &&
    existing.authorAgentId === (input.comment.authorAgentId ?? null) &&
    existing.authorUserId === (input.comment.authorUserId ?? null) &&
    existing.authorPluginInstallationId ===
      (input.comment.authorPluginInstallationId ?? null) &&
    existing.authorPluginKey === (input.comment.authorPluginKey ?? null) &&
    existing.authorType === input.comment.authorType &&
    existing.replyToCommentId === input.comment.replyToCommentId &&
    existing.replyToProjectedEventSeq ===
      input.comment.replyToProjectedEventSeq &&
    existing.threadRootCommentId === input.comment.threadRootCommentId &&
    existing.threadRootProjectedEventSeq ===
      input.comment.threadRootProjectedEventSeq &&
    canonicalJson(existing.presentation) ===
      canonicalJson(input.comment.presentation ?? null) &&
    canonicalJson(existing.metadata) ===
      canonicalJson(input.comment.metadata ?? null) &&
    canonicalJson(existing.sourceTrust) ===
      canonicalJson(input.comment.sourceTrust ?? null)
  );
}

type MaterializeCommentInput =
  | {
      kind: "source";
      projection: IssueSessionCommentProjectionInput;
    }
  | {
      kind: "terminal";
      source: typeof issueCommentProjectionSources.$inferSelect;
      comment: typeof issueComments.$inferSelect;
      terminalSessionMessageId: string;
      body: string;
      presentation: IssueCommentPresentation;
    };

async function materializeComment(
  transaction: IssueSessionDbTransaction,
  event: DurableEventRow,
  materialization: MaterializeCommentInput,
): Promise<typeof issueComments.$inferSelect> {
  if (materialization.kind === "terminal") {
    const {
      source,
      comment,
      terminalSessionMessageId,
      body,
      presentation,
    } = materialization;
    if (source.terminalSessionMessageId === null) {
      const bound = await transaction
        .update(issueCommentProjectionSources)
        .set({ terminalSessionMessageId })
        .where(
          and(
            eq(issueCommentProjectionSources.commentId, source.commentId),
            isNull(issueCommentProjectionSources.terminalSessionMessageId),
          ),
        )
        .returning({ commentId: issueCommentProjectionSources.commentId });
      if (!bound[0]) {
        throw new IssueSessionInvariantError(
          `Stable run-progress comment ${source.commentId} lost its terminal binding race`,
        );
      }
    }
    if (
      comment.body === body &&
      canonicalJson(comment.presentation) === canonicalJson(presentation)
    ) {
      return comment;
    }
    if (
      comment.body !== "" ||
      comment.presentation?.kind !== "run_progress"
    ) {
      throw new IssueSessionLifecycleConflict(
        "Stable run-progress comment was changed before terminal settlement",
        { progressCommentId: comment.id },
      );
    }
    const updated = await transaction
      .update(issueComments)
      .set({
        body,
        presentation,
        updatedAt: event.eventTimestamp,
      })
      .where(
        and(
          eq(issueComments.companyId, event.companyId),
          eq(issueComments.issueId, event.issueId),
          eq(issueComments.sessionId, event.sessionId),
          eq(issueComments.id, comment.id),
        ),
      )
      .returning();
    if (!updated[0]) {
      throw new IssueSessionInvariantError(
        `Stable run-progress comment ${comment.id} disappeared`,
      );
    }
    await syncComment(updated[0].id, transaction);
    return updated[0];
  }

  const input = materialization.projection;
  if (
    input.comment.id.length === 0 ||
    input.messageId.length === 0 ||
    input.sourceId.length === 0
  ) {
    throw new IssueSessionLifecycleConflict(
      "Issue Session comment projection input is inconsistent",
      { eventId: event.id, phase: input.phase },
    );
  }
  const replyTuple = [
    input.comment.replyToCommentId,
    input.comment.replyToProjectedEventSeq,
    input.comment.threadRootCommentId,
    input.comment.threadRootProjectedEventSeq,
  ];
  if (
    !(
      replyTuple.every((value) => value === null) ||
      replyTuple.every((value) => value !== null)
    )
  ) {
    throw new IssueSessionLifecycleConflict(
      "Issue Session comment projection has a partial reply tuple",
      { eventId: event.id, commentId: input.comment.id },
    );
  }
  if (
    input.steeringSegment != null &&
    (!input.steeringSegment.steeringTargetRunId ||
      !input.steeringSegment.refId ||
      !Number.isInteger(input.steeringSegment.refOrdinal) ||
      input.steeringSegment.refOrdinal < 0 ||
      !Number.isInteger(input.steeringSegment.segmentOrdinal) ||
      input.steeringSegment.segmentOrdinal < 1)
  ) {
    throw new IssueSessionLifecycleConflict(
      "Issue Session comment projection has an invalid steering segment",
      { eventId: event.id, commentId: input.comment.id },
    );
  }
  assertIssueSessionRunProgressProjection(event, input);
  const inbox = await transaction
    .select()
    .from(issueSessionInputs)
    .where(
      and(
        eq(issueSessionInputs.sessionId, event.sessionId),
        eq(issueSessionInputs.id, input.messageId),
      ),
    )
    .limit(1);
  const admittedEventSeq =
    input.phase === "direct"
      ? event.seq
      : (inbox[0]?.admittedSeq ?? event.seq);
  const promotedEventSeq =
    input.phase === "admitted" ? null : event.seq;

  if (input.phase !== "admitted") {
    const message = await findMessage(transaction, event, input.messageId);
    if (!message) {
      throw new IssueSessionInvariantError(
        `Comment source ${input.sourceKind}/${input.sourceId} has no Issue Session message`,
      );
    }
  }

  const existingRows = await transaction
    .select()
    .from(issueComments)
    .where(
      and(
        eq(issueComments.sessionId, event.sessionId),
        eq(issueComments.canonicalSourceKind, input.sourceKind),
        eq(issueComments.canonicalSourceId, input.sourceId),
      ),
    )
    .limit(1);
  let comment = existingRows[0] ?? null;
  if (!comment) {
    if (input.phase === "promoted") {
      throw new IssueSessionInvariantError(
        `Prompt promotion ${event.id} has no admitted comment projection`,
      );
    }
    comment = await transaction
      .insert(issueComments)
      .values({
        ...input.comment,
        companyId: event.companyId,
        issueId: event.issueId,
        sessionId: event.sessionId,
        canonicalSourceKind: input.sourceKind,
        canonicalSourceId: input.sourceId,
        canonicalMessageId: input.messageId,
        admittedEventSeq,
        promotedEventSeq,
        projectedEventSeq: event.seq,
        runId: event.runId,
        createdAt: event.eventTimestamp,
        updatedAt: event.eventTimestamp,
      })
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!comment) {
      throw new IssueSessionInvariantError(
        "Issue Session projector failed to materialize issue comment",
      );
    }
    await transaction.insert(issueCommentProjectionSources).values({
      commentId: comment.id,
      companyId: event.companyId,
      issueId: event.issueId,
      sessionId: event.sessionId,
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      messageId: input.messageId,
      runId: event.runId,
      steeringTargetRunId:
        input.steeringSegment?.steeringTargetRunId ?? null,
      replyToCommentId: input.comment.replyToCommentId,
      replyToProjectedEventSeq: input.comment.replyToProjectedEventSeq,
      threadRootCommentId: input.comment.threadRootCommentId,
      threadRootProjectedEventSeq:
        input.comment.threadRootProjectedEventSeq,
      refId: input.steeringSegment?.refId ?? null,
      refOrdinal: input.steeringSegment?.refOrdinal ?? null,
      segmentOrdinal: input.steeringSegment?.segmentOrdinal ?? null,
      terminalSessionMessageId: null,
      admittedEventSeq,
      promotedEventSeq,
      projectedEventSeq: event.seq,
    });
  } else {
    if (!sameProjectedComment(comment, event, input)) {
      throw new IssueSessionLifecycleConflict(
        "Issue Session comment projection source was reused",
        { commentId: comment.id, sourceId: input.sourceId },
      );
    }
    const sourceRows = await transaction
      .select()
      .from(issueCommentProjectionSources)
      .where(eq(issueCommentProjectionSources.commentId, comment.id))
      .limit(2)
      .for("update");
    const source = sourceRows.length === 1 ? sourceRows[0]! : null;
    if (
      !source ||
      source.companyId !== event.companyId ||
      source.issueId !== event.issueId ||
      source.sessionId !== event.sessionId ||
      source.sourceKind !== input.sourceKind ||
      source.sourceId !== input.sourceId ||
      source.messageId !== input.messageId ||
      source.runId !== event.runId ||
      source.steeringTargetRunId !==
        (input.steeringSegment?.steeringTargetRunId ?? null) ||
      source.replyToCommentId !== input.comment.replyToCommentId ||
      source.replyToProjectedEventSeq !==
        input.comment.replyToProjectedEventSeq ||
      source.threadRootCommentId !== input.comment.threadRootCommentId ||
      source.threadRootProjectedEventSeq !==
        input.comment.threadRootProjectedEventSeq ||
      source.refId !== (input.steeringSegment?.refId ?? null) ||
      source.refOrdinal !== (input.steeringSegment?.refOrdinal ?? null) ||
      source.segmentOrdinal !==
        (input.steeringSegment?.segmentOrdinal ?? null)
    ) {
      throw new IssueSessionLifecycleConflict(
        "Issue Session comment projection companion was reused",
        { commentId: comment.id, sourceId: input.sourceId },
      );
    }
    if (input.phase === "promoted") {
      if (
        comment.admittedEventSeq !== admittedEventSeq ||
        (comment.promotedEventSeq !== null &&
          comment.promotedEventSeq !== event.seq)
      ) {
        throw new IssueSessionLifecycleConflict(
          "Issue Session prompt promotion cannot rewrite comment correlation",
          { commentId: comment.id },
        );
      }
      const promoted = await transaction
        .update(issueComments)
        .set({
          promotedEventSeq: event.seq,
          updatedAt: event.eventTimestamp,
        })
        .where(eq(issueComments.id, comment.id))
        .returning();
      comment = promoted[0] ?? comment;
      await transaction
        .update(issueCommentProjectionSources)
        .set({
          promotedEventSeq: event.seq,
        })
        .where(eq(issueCommentProjectionSources.commentId, comment.id));
    }
  }

  await transaction
    .update(issues)
    .set({
      updatedAt: sql`greatest(
        ${issues.updatedAt},
        ${event.eventTimestamp.toISOString()}::timestamptz
      )`,
    })
    .where(
      and(
        eq(issues.companyId, event.companyId),
        eq(issues.id, event.issueId),
      ),
    );
  await syncComment(comment.id, transaction);
  return comment;
}

async function loadDurableEvent(
  transaction: IssueSessionDbTransaction,
  eventId: string,
): Promise<{
  row: StoredIssueSessionEvent;
  projectable: DurableEventRow;
}> {
  const decoded = await loadStoredIssueSessionEvent(transaction, eventId);
  return {
    row: decoded.row,
    projectable: projectableIssueSessionEvent(decoded.row),
  };
}

async function projectMoved(
  transaction: IssueSessionDbTransaction,
  eventRow: DurableEventRow,
  event: Extract<
    IssueSession.DurableEvent,
    { type: "session.next.moved" }
  >,
): Promise<void> {
  const location = event.data.location;
  const sessions = await transaction
    .select()
    .from(issueSessions)
    .where(
      and(
        eq(issueSessions.companyId, eventRow.companyId),
        eq(issueSessions.issueId, eventRow.issueId),
        eq(issueSessions.id, eventRow.sessionId),
      ),
    )
    .limit(1);
  const session = sessions[0];
  if (!session) {
    throw new IssueSessionInvariantError(
      `Moved Session ${eventRow.sessionId} does not exist`,
    );
  }
  await transaction
    .update(issueSessions)
    .set({
      directory: location.directory,
      workspaceId: location.workspaceID ?? null,
      subpath:
        typeof event.data.subdirectory === "string" &&
        event.data.subdirectory.length > 0
          ? event.data.subdirectory
          : null,
      timeUpdated: eventRow.eventTimestamp,
    })
    .where(eq(issueSessions.id, eventRow.sessionId));
  const nextEpoch = await resetIssueSessionContext(transaction, {
    companyId: eventRow.companyId,
    issueId: eventRow.issueId,
    sessionId: eventRow.sessionId,
  });

  await transaction
    .update(issueExecutionHistoryViews)
    .set({
      state: "invalidated",
      invalidationReason: "session_moved",
      invalidatedAt: eventRow.eventTimestamp,
      updatedAt: eventRow.eventTimestamp,
    })
    .where(
      and(
        eq(issueExecutionHistoryViews.companyId, eventRow.companyId),
        eq(issueExecutionHistoryViews.issueId, eventRow.issueId),
        eq(issueExecutionHistoryViews.sessionId, eventRow.sessionId),
        sql`${issueExecutionHistoryViews.contextEpoch} < ${nextEpoch}`,
        sql`${issueExecutionHistoryViews.state} in ('empty', 'preparing', 'current')`,
      ),
    );
  await transaction.execute(sql`
    UPDATE issue_execution_refs ref
    SET disposition = 'invalidated',
        invalidation_reason = 'session_moved',
        updated_at = ${eventRow.eventTimestamp.toISOString()}
    WHERE ref.company_id = ${eventRow.companyId}
      AND ref.issue_id = ${eventRow.issueId}
      AND ref.session_id = ${eventRow.sessionId}
      AND ref.context_epoch < ${nextEpoch}
      AND ref.disposition = 'active'
  `);
  await transaction
    .update(issueExecutionSessions)
    .set({
      state: "superseded",
      supersessionReason: "session_moved",
      supersededAt: eventRow.eventTimestamp,
    })
    .where(
      and(
        eq(issueExecutionSessions.companyId, eventRow.companyId),
        eq(issueExecutionSessions.issueId, eventRow.issueId),
        inArray(issueExecutionSessions.state, ["eligible", "current"]),
      ),
    );
  await revokeIssueExecutionPromptCapabilitiesForSessionInTransaction(
    transaction,
    {
      companyId: eventRow.companyId,
      issueId: eventRow.issueId,
      sessionId: eventRow.sessionId,
      reason: "session_moved",
      at: eventRow.eventTimestamp,
    },
  );
}

async function truncateRevertProjection(
  transaction: IssueSessionDbTransaction,
  eventRow: DurableEventRow,
  boundaryMessageId: string,
): Promise<void> {
  const boundaries = await transaction
    .select({ seq: issueSessionMessages.seq })
    .from(issueSessionMessages)
    .where(
      and(
        eq(issueSessionMessages.companyId, eventRow.companyId),
        eq(issueSessionMessages.issueId, eventRow.issueId),
        eq(issueSessionMessages.sessionId, eventRow.sessionId),
        eq(issueSessionMessages.id, boundaryMessageId),
      ),
    )
    .limit(1);
  const boundarySeq = boundaries[0]?.seq;
  if (boundarySeq === undefined) {
    throw new IssueSessionLifecycleConflict(
      "Committed revert boundary message is missing",
      { eventId: eventRow.id, boundaryMessageId },
    );
  }

  await transaction.execute(sql`
    UPDATE issue_session_input_dispositions disposition
    SET state = 'invalidated',
        invalidation_reason = 'session_revert',
        invalidated_at = ${eventRow.eventTimestamp.toISOString()},
        invalidated_by_source_kind = 'session_revert',
        invalidated_by_source_id = ${eventRow.id}
    FROM issue_session_inputs input
    WHERE disposition.input_id = input.id
      AND input.company_id = ${eventRow.companyId}
      AND input.issue_id = ${eventRow.issueId}
      AND input.session_id = ${eventRow.sessionId}
      AND disposition.state = 'active'
      AND (
        input.admitted_seq > ${boundarySeq}
        OR input.promoted_seq > ${boundarySeq}
      )
  `);
  await transaction.execute(sql`
    UPDATE issue_execution_refs ref
    SET disposition = 'invalidated',
        invalidation_reason = 'session_revert',
        updated_at = ${eventRow.eventTimestamp.toISOString()}
    WHERE ref.company_id = ${eventRow.companyId}
      AND ref.issue_id = ${eventRow.issueId}
      AND ref.session_id = ${eventRow.sessionId}
      AND ref.disposition = 'active'
      AND (
        ref.admitted_seq > ${boundarySeq}
        OR ref.promoted_seq > ${boundarySeq}
        OR EXISTS (
          SELECT 1
          FROM issue_session_messages message
          WHERE message.company_id = ref.company_id
            AND message.issue_id = ref.issue_id
            AND message.session_id = ref.session_id
            AND message.id = ref.source_message_id
            AND message.seq > ${boundarySeq}
        )
      )
  `);
  await transaction.execute(sql`
    UPDATE issue_execution_history_views view
    SET state = 'invalidated',
        invalidation_reason = 'session_revert',
        invalidated_at = ${eventRow.eventTimestamp.toISOString()},
        updated_at = ${eventRow.eventTimestamp.toISOString()}
    WHERE view.company_id = ${eventRow.companyId}
      AND view.issue_id = ${eventRow.issueId}
      AND view.session_id = ${eventRow.sessionId}
      AND view.state IN ('empty', 'preparing', 'current')
      AND (
        view.source_admitted_seq > ${boundarySeq}
        OR view.source_promoted_seq > ${boundarySeq}
        OR EXISTS (
          SELECT 1
          FROM issue_execution_refs ref
          WHERE ref.id = view.ref_id
            AND ref.disposition = 'invalidated'
            AND ref.invalidation_reason = 'session_revert'
        )
      )
  `);
  await revokeIssueExecutionPromptCapabilitiesForSessionInTransaction(
    transaction,
    {
      companyId: eventRow.companyId,
      issueId: eventRow.issueId,
      sessionId: eventRow.sessionId,
      reason: "session_revert",
      at: eventRow.eventTimestamp,
    },
  );
  await transaction
    .update(issueExecutionSessions)
    .set({
      state: "superseded",
      supersessionReason: "session_revert",
      supersededAt: eventRow.eventTimestamp,
    })
    .where(
      and(
        eq(issueExecutionSessions.companyId, eventRow.companyId),
        eq(issueExecutionSessions.issueId, eventRow.issueId),
        inArray(issueExecutionSessions.state, ["eligible", "current"]),
      ),
    );
  await transaction.execute(sql`
    DELETE FROM issue_session_messages
    WHERE company_id = ${eventRow.companyId}
      AND issue_id = ${eventRow.issueId}
      AND session_id = ${eventRow.sessionId}
      AND seq > ${boundarySeq}
  `);
}

async function projectRevert(
  transaction: IssueSessionDbTransaction,
  eventRow: DurableEventRow,
  event: Extract<
    IssueSession.DurableEvent,
    {
      type:
        | "session.next.revert.staged"
        | "session.next.revert.cleared"
        | "session.next.revert.committed";
    }
  >,
): Promise<void> {
  const sessions = await transaction
    .select({ revert: issueSessions.revert })
    .from(issueSessions)
    .where(
      and(
        eq(issueSessions.companyId, eventRow.companyId),
        eq(issueSessions.issueId, eventRow.issueId),
        eq(issueSessions.id, eventRow.sessionId),
      ),
    )
    .limit(1);
  const session = sessions[0];
  if (!session) {
    throw new IssueSessionInvariantError(
      `Session ${eventRow.sessionId} is missing during revert projection`,
    );
  }
  if (event.type === "session.next.revert.staged") {
    if (session.revert !== null) {
      throw new IssueSessionLifecycleConflict(
        "Issue Session already has a staged revert",
        { eventId: eventRow.id, sessionId: eventRow.sessionId },
      );
    }
    await transaction
      .update(issueSessions)
      .set({
        revert: {
          ...event.data.revert,
          files: event.data.revert.files
            ? [...event.data.revert.files]
            : undefined,
        },
        timeUpdated: eventRow.eventTimestamp,
      })
      .where(eq(issueSessions.id, eventRow.sessionId));
    return;
  }
  if (!session.revert) {
    throw new IssueSessionLifecycleConflict(
      "Revert terminal event has no staged Issue Session state",
      { eventId: eventRow.id, eventType: event.type },
    );
  }
  await transaction
    .update(issueSessions)
    .set({ revert: null, timeUpdated: eventRow.eventTimestamp })
    .where(eq(issueSessions.id, eventRow.sessionId));

  if (event.type === "session.next.revert.committed") {
    const boundaryMessageId = event.data.messageID;
    if (boundaryMessageId !== session.revert.messageID) {
      throw new IssueSessionLifecycleConflict(
        "Committed revert changed its staged boundary",
        { eventId: eventRow.id, boundaryMessageId },
      );
    }
    await truncateRevertProjection(
      transaction,
      eventRow,
      boundaryMessageId,
    );
    const epoch = await resetIssueSessionContext(transaction, {
      companyId: eventRow.companyId,
      issueId: eventRow.issueId,
      sessionId: eventRow.sessionId,
    });
    await transaction
      .update(issueExecutionHistoryViews)
      .set({
        state: "invalidated",
        invalidationReason: "session_revert",
        invalidatedAt: eventRow.eventTimestamp,
        updatedAt: eventRow.eventTimestamp,
      })
      .where(
        and(
          eq(issueExecutionHistoryViews.companyId, eventRow.companyId),
          eq(issueExecutionHistoryViews.issueId, eventRow.issueId),
          eq(issueExecutionHistoryViews.sessionId, eventRow.sessionId),
          sql`${issueExecutionHistoryViews.contextEpoch} < ${epoch}`,
          sql`${issueExecutionHistoryViews.state} in ('empty', 'preparing', 'current')`,
        ),
      );
  }
}

async function projectEvent(
  transaction: IssueSessionDbTransaction,
  eventRow: DurableEventRow,
  input: Omit<IssueSessionProjectionInput, "eventId">,
  rebuilding: boolean,
  touchedMessageIds?: Set<string>,
): Promise<typeof issueComments.$inferSelect | null> {
  if (
    eventRow.type === "session.next.step.ended" &&
    input.comment
  ) {
    throw new IssueSessionLifecycleConflict(
      "Productive Step.Ended comments require terminal finalization after pending-input resolution",
      { eventId: eventRow.id },
    );
  }
  const event = eventRow.event;
  const projected = await readProjectedIssueSessionSequence(
    transaction,
    eventRow.sessionId,
  );
  if (projected >= eventRow.seq) {
    throw new IssueSessionLifecycleConflict(
      "Issue Session event was already projected",
      { eventId: eventRow.id, sequence: eventRow.seq },
    );
  }
  if (
    event.type === "session.next.prompt.admitted" ||
    event.type === "session.next.prompted"
  ) {
    await projectIssueSessionInput(transaction, {
      event,
      companyId: eventRow.companyId,
      issueId: eventRow.issueId,
      binding: input.inputBinding,
      rebuilding,
    });
  }
  await applyIssueSessionMessageEvent(
    createMessageProjectionStore(
      transaction,
      eventRow,
      eventRow.seq,
      rebuilding,
      touchedMessageIds,
    ),
    event,
  );
  if (event.type === "session.next.moved") {
    await projectMoved(transaction, eventRow, event);
  }
  if (
    event.type === "session.next.revert.staged" ||
    event.type === "session.next.revert.cleared" ||
    event.type === "session.next.revert.committed"
  ) {
    await projectRevert(transaction, eventRow, event);
  }
  await commitProjectedIssueSessionSequence(
    transaction,
    eventRow.sessionId,
    eventRow.seq,
  );
  return input.comment
    ? materializeComment(transaction, eventRow, {
        kind: "source",
        projection: input.comment,
      })
    : null;
}

/**
 * Projects one already-appended immutable event through the physical Session
 * tables. This is the sole steady-state writer of materialized messages and
 * their issue-comment projection.
 */
export async function projectIssueSessionEventInTx(
  transaction: IssueSessionDbTransaction,
  input: IssueSessionProjectionInput,
): Promise<{
  event: typeof issueSessionEvents.$inferSelect;
  comment: typeof issueComments.$inferSelect | null;
}> {
  const { row, projectable: event } = await loadDurableEvent(
    transaction,
    input.eventId,
  );
  const comment = await projectEvent(
    transaction,
    event,
    {
      inputBinding: input.inputBinding,
      comment: input.comment,
    },
    false,
  );
  return { event: row, comment };
}

export interface IssueSessionFinalCommentInput {
  eventId: string;
  progressCommentId: string;
}

/**
 * Binds the stable progress comment to its terminal Session assistant. The
 * source retains its immutable `run_progress` identity; only this dependency
 * and the human-facing projection change.
 */
export async function projectIssueSessionFinalCommentInTx(
  transaction: IssueSessionDbTransaction,
  input: IssueSessionFinalCommentInput,
): Promise<typeof issueComments.$inferSelect> {
  const { projectable: eventRow } = await loadDurableEvent(
    transaction,
    input.eventId,
  );
  const event = eventRow.event;
  if (
    event.type !== "session.next.step.ended" ||
    eventRow.runId === null ||
    eventRow.agentId === null ||
    input.progressCommentId.length === 0
  ) {
    throw new IssueSessionLifecycleConflict(
      "Final Issue Session comment must identify a completed canonical run",
      { eventId: input.eventId, runId: eventRow.runId },
    );
  }

  const projectedSeq = await readProjectedIssueSessionSequence(
    transaction,
    eventRow.sessionId,
  );
  if (projectedSeq < eventRow.seq) {
    throw new IssueSessionLifecycleConflict(
      "Final Issue Session comment requires an already-projected step settlement",
      {
        eventId: input.eventId,
        eventSeq: eventRow.seq,
        projectedSeq,
      },
    );
  }

  const [message, trailing] = await Promise.all([
    findMessage(
      transaction,
      eventRow,
      event.data.assistantMessageID,
    ),
    transaction
      .select({ id: issueSessionMessages.id })
      .from(issueSessionMessages)
      .where(
        and(
          eq(issueSessionMessages.companyId, eventRow.companyId),
          eq(issueSessionMessages.issueId, eventRow.issueId),
          eq(issueSessionMessages.sessionId, eventRow.sessionId),
          eq(issueSessionMessages.runId, eventRow.runId),
          eq(issueSessionMessages.type, "assistant"),
        ),
      )
      .orderBy(desc(issueSessionMessages.seq))
      .limit(1),
  ]);
  if (
    !message ||
    message.type !== "assistant" ||
    message.runId !== eventRow.runId ||
    trailing[0]?.id !== message.id
  ) {
    throw new IssueSessionLifecycleConflict(
      "Final Issue Session comment does not reference the trailing run assistant",
      { eventId: input.eventId, messageId: event.data.assistantMessageID },
    );
  }
  const assistant = issueSessionMessageFromRow(message);
  if (assistant.type !== "assistant") {
    throw new IssueSessionInvariantError(
      `Issue Session message ${message.id} is not an assistant`,
    );
  }
  const text = assistant.content
    .filter(
      (
        part,
      ): part is Extract<(typeof assistant.content)[number], { type: "text" }> =>
        part.type === "text",
    )
    .map((part) => part.text)
    .join("");
  if (!assistant.time.completed) {
    throw new IssueSessionLifecycleConflict(
      "Final Issue Session comment requires a settled assistant timestamp",
      { eventId: input.eventId, messageId: message.id },
    );
  }
  const completedAt = DateTime.toEpochMillis(assistant.time.completed);
  const eventCompletedAt = DateTime.toEpochMillis(event.data.timestamp);
  if (
    completedAt !== eventCompletedAt ||
    assistant.finish !== event.data.finish ||
    assistant.cost !== event.data.cost ||
    canonicalJson(assistant.tokens) !== canonicalJson(event.data.tokens) ||
    text.length === 0
  ) {
    throw new IssueSessionLifecycleConflict(
      "Final Issue Session comment diverges from its settled assistant output",
      { eventId: input.eventId, messageId: message.id },
    );
  }
  const sources = await transaction
    .select()
    .from(issueCommentProjectionSources)
    .where(
      and(
        eq(issueCommentProjectionSources.companyId, eventRow.companyId),
        eq(issueCommentProjectionSources.issueId, eventRow.issueId),
        eq(issueCommentProjectionSources.sessionId, eventRow.sessionId),
        eq(issueCommentProjectionSources.commentId, input.progressCommentId),
        eq(issueCommentProjectionSources.sourceKind, "run_progress"),
        eq(issueCommentProjectionSources.runId, eventRow.runId),
      ),
    )
    .limit(2)
    .for("update");
  const source = sources.length === 1 ? sources[0]! : null;
  if (!source) {
    throw new IssueSessionLifecycleConflict(
      "Final Issue Session comment has no unique stable run-progress source",
      { eventId: input.eventId, progressCommentId: input.progressCommentId },
    );
  }
  const comments = await transaction
    .select()
    .from(issueComments)
    .where(
      and(
        eq(issueComments.companyId, eventRow.companyId),
        eq(issueComments.issueId, eventRow.issueId),
        eq(issueComments.id, source.commentId),
      ),
    )
    .limit(2)
    .for("update");
  const comment = comments.length === 1 ? comments[0]! : null;
  if (
    !comment ||
    comment.sessionId !== eventRow.sessionId ||
    comment.runId !== eventRow.runId ||
    comment.authorType !== "agent" ||
    comment.authorAgentId !== eventRow.agentId
  ) {
    throw new IssueSessionLifecycleConflict(
      "Stable run-progress comment does not match its terminal run",
      { eventId: input.eventId, progressCommentId: input.progressCommentId },
    );
  }
  if (
    source.terminalSessionMessageId !== null &&
    source.terminalSessionMessageId !== message.id
  ) {
    throw new IssueSessionLifecycleConflict(
      "Stable run-progress comment is already bound to another terminal message",
      { progressCommentId: input.progressCommentId },
    );
  }
  const presentation: IssueCommentPresentation = {
    kind: "message",
    tone: "neutral",
    detailsDefaultOpen: false,
  };
  return materializeComment(transaction, eventRow, {
    kind: "terminal",
    source,
    comment,
    terminalSessionMessageId: message.id,
    body: text,
    presentation,
  });
}
