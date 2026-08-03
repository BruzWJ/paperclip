import {
  issueExecutionHistoryViews,
  issueExecutionRefs,
  issueExecutionSessions,
  issueCommentProjectionSources,
  issueComments,
  issueSessionCompactionControls,
  issueSessionEvents,
  issueSessionInputs,
  issueSessionMessages,
  issueSessions,
  issues,
  type Db,
} from "@paperclipai/db";
import * as IssueSession from "@paperclipai/shared/issue-session";
import type {
  IssueCommentAuthorType,
  IssueCommentMetadata,
  IssueCommentPresentation,
  SourceTrustMetadata,
} from "@paperclipai/shared";
import {
  encodeIssueSessionEvent,
  encodeIssueSessionMessage,
  isIssueSessionEvent,
  isIssueSessionMessage,
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
  type IssueSessionStore,
} from "./store.js";
import {
  sessionCompactionEnvelope,
  sessionCompactionRunContextSchema,
} from "../issue-session-compaction-contract.js";
import {
  readIssueExecutionRun,
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
import { insertOrAssertIssueSessionSourceUserExecution } from "./source-user-execution.js";
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
  compactionControl?: Omit<
    typeof issueSessionCompactionControls.$inferInsert,
    "companyId" | "issueId" | "sessionId" | "seq"
  > & { id: string };
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

const LIVE_ONLY_SESSION_EVENT_TYPES = new Set([
  IssueSession.Event.Text.Delta.type,
  IssueSession.Event.Reasoning.Delta.type,
  IssueSession.Event.Tool.Input.Delta.type,
  IssueSession.Event.Compaction.Delta.type,
]);

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
  ["session.next.compaction.started", 1],
  ["session.next.compaction.ended", 1],
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
  if (LIVE_ONLY_SESSION_EVENT_TYPES.has(event.type as never)) {
    throw new IssueSessionLifecycleConflict(
      "Live-only Session deltas cannot enter durable persistence",
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

export function persistedIssueSessionEvent(input: {
  id: string;
  sessionId: string;
  seq: number;
  version: number;
  type: string;
  data: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}): Record<string, unknown> {
  const event = {
    id: input.id,
    type: input.type,
    ...(input.metadata === undefined
      ? {}
      : { metadata: input.metadata }),
    durable: {
      aggregateID: input.sessionId,
      seq: input.seq,
      version: input.version,
    },
    data: input.data,
  } as PersistedIssueSessionEvent;
  assertDurableIssueSessionEvent(event);
  if (event.data.sessionID !== input.sessionId) {
    throw new IssueSessionLifecycleConflict(
      "Durable Session event data changed aggregate identity",
      { eventId: input.id, sessionId: input.sessionId },
    );
  }
  return encodeIssueSessionEvent(event) as Record<string, unknown>;
}

type DurableEventRow = ProjectableIssueSessionEvent;
type SessionMessageRow = typeof issueSessionMessages.$inferSelect;
type SessionMessage = IssueSession.IssueSessionMessage;

export function persistedIssueSessionMessage(
  message: SessionMessage,
): Record<string, unknown> {
  const candidate: unknown = message;
  if (!isIssueSessionMessage(candidate)) {
    const invalid =
      typeof candidate === "object" && candidate !== null
        ? (candidate as { id?: unknown; type?: unknown })
        : {};
    throw new IssueSessionLifecycleConflict(
      `Session message ${String(invalid.id ?? "<missing>")} does not satisfy the Issue Session schema`,
      { messageId: invalid.id, messageType: invalid.type },
    );
  }
  const encoded = encodeIssueSessionMessage(candidate) as Record<
    string,
    unknown
  >;
  const { id: _id, type: _type, ...data } = encoded;
  return data;
}

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

export function durableSessionEventFromRow(
  row: DurableEventRow,
): IssueSession.DurableEvent {
  return row.event;
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

type CompactionControlProjection = Omit<
  typeof issueSessionCompactionControls.$inferInsert,
  "companyId" | "issueId" | "sessionId" | "seq"
> & { id: string };

type PersistedCompactionControl =
  typeof issueSessionCompactionControls.$inferInsert & { id: string };

function scopedCompactionControl(
  event: DurableEventRow,
  control: CompactionControlProjection,
): PersistedCompactionControl {
  return {
    ...control,
    companyId: event.companyId,
    issueId: event.issueId,
    sessionId: event.sessionId,
    seq: event.seq,
  } as PersistedCompactionControl;
}

async function loadCompactionControl(
  transaction: IssueSessionDbTransaction,
  event: DurableEventRow,
  supplied?: CompactionControlProjection,
): Promise<typeof issueSessionCompactionControls.$inferSelect> {
  if (supplied) {
    return scopedCompactionControl(
      event,
      supplied,
    ) as typeof issueSessionCompactionControls.$inferSelect;
  }
  const rows = await transaction
    .select()
    .from(issueSessionCompactionControls)
    .where(
      and(
        eq(issueSessionCompactionControls.companyId, event.companyId),
        eq(issueSessionCompactionControls.issueId, event.issueId),
        eq(issueSessionCompactionControls.sessionId, event.sessionId),
        eq(issueSessionCompactionControls.seq, event.seq),
        sql`${issueSessionCompactionControls.kind} in ('checkpoint', 'failed-compaction')`,
      ),
    )
    .limit(2);
  if (rows.length !== 1) {
    throw new IssueSessionLifecycleConflict(
      "Compaction result event has no unique sequenced control envelope",
      { eventId: event.id, sequence: event.seq },
    );
  }
  return rows[0]!;
}

function sameTimestamp(
  left: Date | null,
  right: Date | null | undefined,
): boolean {
  return (left?.getTime() ?? null) === (right?.getTime() ?? null);
}

function compactionControlDisposition(
  value: PersistedCompactionControl,
): "active" | "invalidated" {
  return value.disposition ?? "active";
}

function assertCompactionControlDisposition(
  value: PersistedCompactionControl,
): void {
  const disposition = compactionControlDisposition(value);
  const invalidatedAt = value.invalidatedAt ?? null;
  const invalidatedByRevertEventId =
    value.invalidatedByRevertEventId ?? null;
  const invalidatedBoundaryMessageId =
    value.invalidatedBoundaryMessageId ?? null;
  const invalidatedBoundarySeq = value.invalidatedBoundarySeq ?? null;
  const hasCompleteRevertProvenance =
    invalidatedAt instanceof Date &&
    Number.isFinite(invalidatedAt.getTime()) &&
    typeof invalidatedByRevertEventId === "string" &&
    invalidatedByRevertEventId.length > 0 &&
    typeof invalidatedBoundaryMessageId === "string" &&
    invalidatedBoundaryMessageId.length > 0 &&
    typeof invalidatedBoundarySeq === "number" &&
    Number.isInteger(invalidatedBoundarySeq) &&
    invalidatedBoundarySeq >= 0;
  if (
    (disposition === "active" &&
      invalidatedAt === null &&
      invalidatedByRevertEventId === null &&
      invalidatedBoundaryMessageId === null &&
      invalidatedBoundarySeq === null) ||
    (disposition === "invalidated" && hasCompleteRevertProvenance)
  ) {
    return;
  }
  throw new IssueSessionLifecycleConflict(
    "Compaction control has an invalid active/invalidation disposition envelope",
    { controlId: value.id, disposition },
  );
}

type CompactionControlReferencedMessage = {
  id: string;
  expectedType?: typeof issueSessionMessages.$inferSelect.type;
};

function compactionControlReferencedMessages(
  value: PersistedCompactionControl,
): CompactionControlReferencedMessage[] {
  const references: CompactionControlReferencedMessage[] = [];
  const add = (
    id: string | null | undefined,
    expectedType?: typeof issueSessionMessages.$inferSelect.type,
  ) => {
    if (id) references.push({ id, expectedType });
  };
  add(value.compactionRequestMessageId, "user");
  add(value.summaryAssistantMessageId, "assistant");
  add(value.failedAssistantMessageId, "assistant");
  add(value.assistantMessageId, "assistant");
  add(value.tailStartMessageId);
  // A successful checkpoint is published before its selected replay or
  // continuation. Those ids are durably reserved in the control so recovery
  // never infers intent, then the productive-history finalizer verifies the
  // exact materialized post-checkpoint row before activating the bounded
  // view. They are therefore deliberate forward references at projection
  // time, unlike every historical message above.
  return references;
}

/**
 * Controls intentionally retain historical message ids after a committed
 * revert removes those materialized rows. Validate their in-scope references
 * in the projector transaction instead of coupling their audit lifetime to
 * message-row cascading foreign keys.
 */
async function validateCompactionControlReferencedMessages(
  transaction: IssueSessionDbTransaction,
  value: PersistedCompactionControl,
): Promise<void> {
  const references = compactionControlReferencedMessages(value);
  if (references.length === 0) return;
  const ids = [...new Set(references.map((reference) => reference.id))];
  const rows = await transaction
    .select({
      id: issueSessionMessages.id,
      type: issueSessionMessages.type,
    })
    .from(issueSessionMessages)
    .where(
      and(
        eq(issueSessionMessages.companyId, value.companyId),
        eq(issueSessionMessages.issueId, value.issueId),
        eq(issueSessionMessages.sessionId, value.sessionId),
        inArray(issueSessionMessages.id, ids),
      ),
    );
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const reference of references) {
    const row = byId.get(reference.id);
    if (!row || (reference.expectedType && row.type !== reference.expectedType)) {
      throw new IssueSessionLifecycleConflict(
        "Compaction control references a missing or incompatible historical message",
        {
          controlId: value.id,
          messageId: reference.id,
          expectedType: reference.expectedType ?? null,
        },
      );
    }
  }
}

function sameCompactionControl(
  row: typeof issueSessionCompactionControls.$inferSelect,
  value: PersistedCompactionControl,
): boolean {
  return (
    row.id === value.id &&
    row.companyId === value.companyId &&
    row.issueId === value.issueId &&
    row.sessionId === value.sessionId &&
    row.seq === value.seq &&
    row.kind === value.kind &&
    row.disposition === compactionControlDisposition(value) &&
    sameTimestamp(row.invalidatedAt, value.invalidatedAt ?? null) &&
    row.invalidatedByRevertEventId ===
      (value.invalidatedByRevertEventId ?? null) &&
    row.invalidatedBoundaryMessageId ===
      (value.invalidatedBoundaryMessageId ?? null) &&
    row.invalidatedBoundarySeq ===
      (value.invalidatedBoundarySeq ?? null) &&
    row.historyScopeKind === value.historyScopeKind &&
    row.historyScopeId === value.historyScopeId &&
    row.audience === value.audience &&
    row.contextEpoch === value.contextEpoch &&
    row.executionLineageId === value.executionLineageId &&
    row.sourceHighWaterSeq === value.sourceHighWaterSeq &&
    row.latestFinishedAssistantMessageId ===
      (value.latestFinishedAssistantMessageId ?? null) &&
    row.sourceRunId === value.sourceRunId &&
    row.sourceRunKind === value.sourceRunKind &&
    row.sourceRefId === value.sourceRefId &&
    row.sourceRefOrdinal === value.sourceRefOrdinal &&
    row.sourceSegmentOrdinal === value.sourceSegmentOrdinal &&
    row.recoveryIdentityDigest === (value.recoveryIdentityDigest ?? null) &&
    row.compactionRequestMessageId ===
      (value.compactionRequestMessageId ?? null) &&
    row.summaryAssistantMessageId ===
      (value.summaryAssistantMessageId ?? null) &&
    row.failedAssistantMessageId ===
      (value.failedAssistantMessageId ?? null) &&
    row.failedAssistantErrorKind ===
      (value.failedAssistantErrorKind ?? null) &&
    row.assistantMessageId === (value.assistantMessageId ?? null) &&
    row.toolId === (value.toolId ?? null) &&
    sameTimestamp(row.prunedAt, value.prunedAt ?? null) &&
    row.tailStartMessageId === (value.tailStartMessageId ?? null) &&
    row.replayMessageId === (value.replayMessageId ?? null) &&
    row.continuationMessageId ===
      (value.continuationMessageId ?? null) &&
    row.postCheckpointAction === value.postCheckpointAction &&
    row.compactionRunId === (value.compactionRunId ?? null) &&
    row.compactionRunKind === (value.compactionRunKind ?? "compaction") &&
    row.promptTransmissionPhase ===
      (value.promptTransmissionPhase ?? null) &&
    row.protocolSettlementState ===
      (value.protocolSettlementState ?? null) &&
    row.promptSettlementReferenceId ===
      (value.promptSettlementReferenceId ?? null) &&
    row.accountingId === (value.accountingId ?? null) &&
    row.costEventId === (value.costEventId ?? null) &&
    row.settlementVersion === (value.settlementVersion ?? 0) &&
    sameTimestamp(row.settledAt, value.settledAt ?? null) &&
    row.compactionFailureKind === (value.compactionFailureKind ?? null) &&
    canonicalJson(row.structuralPositions) ===
      canonicalJson(value.structuralPositions ?? null) &&
    canonicalJson(row.settingsSnapshot) ===
      canonicalJson(value.settingsSnapshot ?? null) &&
    canonicalJson(row.modelSnapshot) ===
      canonicalJson(value.modelSnapshot ?? null) &&
    canonicalJson(row.triggerModelSnapshot) ===
      canonicalJson(value.triggerModelSnapshot ?? null) &&
    sameTimestamp(row.createdAt, value.createdAt ?? null)
  );
}

async function persistCompactionControlIdempotently(
  transaction: IssueSessionDbTransaction,
  value: PersistedCompactionControl,
): Promise<{ inserted: boolean }> {
  assertCompactionControlDisposition(value);
  await validateCompactionControlReferencedMessages(transaction, value);
  const inserted = await transaction
    .insert(issueSessionCompactionControls)
    .values(value)
    .onConflictDoNothing()
    .returning({ id: issueSessionCompactionControls.id });
  if (inserted[0]) return { inserted: true };

  const existing = await transaction
    .select()
    .from(issueSessionCompactionControls)
    .where(eq(issueSessionCompactionControls.id, value.id))
    .limit(1)
    .for("update");
  if (!existing[0] || !sameCompactionControl(existing[0], value)) {
    throw new IssueSessionLifecycleConflict(
      "Compaction control identity was reused",
      { controlId: value.id },
    );
  }
  return { inserted: false };
}

async function persistCompactionControl(
  transaction: IssueSessionDbTransaction,
  event: DurableEventRow,
  control: CompactionControlProjection,
): Promise<void> {
  const value = scopedCompactionControl(event, control);
  await persistCompactionControlIdempotently(transaction, value);
}

/**
 * Persists a scoped tool-prune effect and applies its auditable V2 projection.
 * The scalar `time.pruned` is not the lowering authorization: the matching
 * scoped control remains the sole signal used by lowering. It exists so a
 * canonical assistant round-trips its pruning timestamp and rebuilds
 * deterministically from controls plus events.
 */
export async function projectIssueSessionToolPrunedEffectInTx(
  transaction: IssueSessionDbTransaction,
  effect: PersistedCompactionControl,
  options: { rebuilding?: boolean } = {},
): Promise<void> {
  if (
    effect.kind !== "tool-pruned" ||
    !effect.companyId ||
    !effect.issueId ||
    !effect.sessionId ||
    !Number.isInteger(effect.seq) ||
    !effect.historyScopeKind ||
    !effect.historyScopeId ||
    !effect.audience ||
    !Number.isInteger(effect.contextEpoch) ||
    !effect.executionLineageId ||
    !Number.isInteger(effect.sourceHighWaterSeq) ||
    !effect.sourceRunId ||
    (effect.sourceRunKind !== "productive" &&
      effect.sourceRunKind !== "consult") ||
    !effect.sourceRefId ||
    !Number.isInteger(effect.sourceRefOrdinal) ||
    !Number.isInteger(effect.sourceSegmentOrdinal) ||
    !effect.assistantMessageId ||
    !effect.toolId ||
    !effect.prunedAt ||
    effect.compactionRequestMessageId != null ||
    effect.summaryAssistantMessageId != null ||
    effect.failedAssistantMessageId != null ||
    effect.failedAssistantErrorKind != null ||
    effect.tailStartMessageId != null ||
    effect.replayMessageId != null ||
    effect.continuationMessageId != null ||
    effect.postCheckpointAction !== "none" ||
    effect.compactionRunId != null ||
    effect.recoveryIdentityDigest != null ||
    effect.promptTransmissionPhase != null ||
    effect.protocolSettlementState != null ||
    effect.promptSettlementReferenceId != null ||
    effect.accountingId != null ||
    effect.costEventId != null ||
    (effect.settlementVersion ?? 0) !== 0 ||
    effect.settledAt != null ||
    effect.compactionFailureKind != null ||
    effect.settingsSnapshot != null ||
    effect.modelSnapshot != null ||
    effect.triggerModelSnapshot != null
  ) {
    throw new IssueSessionLifecycleConflict(
      "Tool-pruned effect has an invalid canonical control shape",
      { controlId: effect.id },
    );
  }
  if (
    compactionControlDisposition(effect) !== "active" &&
    !options.rebuilding
  ) {
    throw new IssueSessionLifecycleConflict(
      "An invalidated tool-pruned effect cannot alter a live projection",
      { controlId: effect.id },
    );
  }

  const persisted = await persistCompactionControlIdempotently(
    transaction,
    effect,
  );
  if (!persisted.inserted && !options.rebuilding) return;

  const rows = await transaction
    .select()
    .from(issueSessionMessages)
    .where(
      and(
        eq(issueSessionMessages.companyId, effect.companyId),
        eq(issueSessionMessages.issueId, effect.issueId),
        eq(issueSessionMessages.sessionId, effect.sessionId),
        eq(issueSessionMessages.id, effect.assistantMessageId),
      ),
    )
    .limit(2)
    .for("update");
  if (rows.length !== 1 || rows[0]!.type !== "assistant") {
    throw new IssueSessionLifecycleConflict(
      "Tool-pruned effect has no unique canonical assistant target",
      {
        controlId: effect.id,
        assistantMessageId: effect.assistantMessageId,
      },
    );
  }

  const assistant = issueSessionMessageFromRow(rows[0]!);
  if (assistant.type !== "assistant") {
    throw new IssueSessionInvariantError(
      `Tool-pruned target ${effect.assistantMessageId} is not an assistant`,
    );
  }
  const matches = assistant.content.flatMap((part, index) =>
    part.type === "tool" && part.id === effect.toolId ? [[part, index] as const] : [],
  );
  if (matches.length !== 1 || matches[0]![0].state.status !== "completed") {
    throw new IssueSessionLifecycleConflict(
      "Tool-pruned effect must target exactly one completed assistant tool",
      {
        controlId: effect.id,
        assistantMessageId: effect.assistantMessageId,
        toolId: effect.toolId,
      },
    );
  }

  const [target, targetIndex] = matches[0]!;
  const existingPrunedAt = target.time.pruned
    ? DateTime.toEpochMillis(target.time.pruned)
    : null;
  const effectPrunedAt = effect.prunedAt.getTime();
  const projectedPrunedAt = Math.min(
    existingPrunedAt ?? Number.POSITIVE_INFINITY,
    effectPrunedAt,
  );
  if (existingPrunedAt !== null && existingPrunedAt <= projectedPrunedAt) {
    return;
  }

  const projected = IssueSession.Message.Assistant.make({
    ...assistant,
    content: assistant.content.map((part, index) =>
      index === targetIndex
        ? {
            ...target,
            time: {
              ...target.time,
              pruned: DateTime.makeUnsafe(projectedPrunedAt),
            },
          }
        : part,
    ),
  });
  await transaction
    .update(issueSessionMessages)
    .set({
      data: encodeIssueSessionMessageData(projected),
      timeUpdated: new Date(effectPrunedAt),
    })
    .where(
      and(
        eq(issueSessionMessages.companyId, effect.companyId),
        eq(issueSessionMessages.issueId, effect.issueId),
        eq(issueSessionMessages.sessionId, effect.sessionId),
        eq(issueSessionMessages.id, effect.assistantMessageId),
      ),
    );
}

async function projectScopedCompaction(
  transaction: IssueSessionDbTransaction,
  eventRow: DurableEventRow,
  rebuilding: boolean,
  touchedMessageIds?: Set<string>,
  suppliedControl?: CompactionControlProjection,
): Promise<boolean> {
  if (
    eventRow.type !== "session.next.compaction.started" &&
    eventRow.type !== "session.next.compaction.ended"
  ) {
    return false;
  }
  const projected = await readProjectedIssueSessionSequence(
    transaction,
    eventRow.sessionId,
  );
  if (projected >= eventRow.seq) {
    throw new IssueSessionLifecycleConflict(
      "Issue Session compaction event was already projected",
      { eventId: eventRow.id, sequence: eventRow.seq },
    );
  }
  const messageStore = createMessageProjectionStore(
    transaction,
    eventRow,
    eventRow.seq,
    rebuilding,
    touchedMessageIds,
  );
  const sessionEvent = eventRow.event;
  if (!eventRow.runId || !eventRow.agentId) {
    throw new IssueSessionLifecycleConflict(
      "Compaction event is missing its maintenance run envelope",
      { eventId: eventRow.id },
    );
  }
  const run = await readIssueExecutionRun(transaction, {
    companyId: eventRow.companyId,
    issueId: eventRow.issueId,
    runId: eventRow.runId,
  });
  const promptControl = await transaction
    .select()
    .from(issueSessionCompactionControls)
    .where(
      and(
        eq(issueSessionCompactionControls.companyId, eventRow.companyId),
        eq(issueSessionCompactionControls.issueId, eventRow.issueId),
        eq(issueSessionCompactionControls.sessionId, eventRow.sessionId),
        eq(issueSessionCompactionControls.compactionRunId, eventRow.runId),
        eq(issueSessionCompactionControls.kind, "recovery-prompt"),
      ),
    )
    .limit(2)
    .then((rows) => rows.length === 1 ? rows[0]! : null);
  const sourceRun = promptControl
    ? await readIssueExecutionRun(transaction, {
        companyId: eventRow.companyId,
        issueId: eventRow.issueId,
        runId: promptControl.sourceRunId,
      })
    : null;
  const parsedContext = sessionCompactionRunContextSchema.safeParse(
    run && promptControl && sourceRun
      ? {
          version: "paperclip-recovery-compaction-run/v1",
          issueId: eventRow.issueId,
          sessionId: eventRow.sessionId,
          ownershipEpoch: run.ownershipEpoch,
          contextEpoch: promptControl.contextEpoch,
          executionLineageId: promptControl.executionLineageId,
          targetAgentId: sourceRun.targetAgentId,
          adapterConfigRevisionId: run.adapterConfigRevisionId,
          executionWorkspaceBindingId: run.executionWorkspaceBindingId,
          scope: {
            kind: promptControl.historyScopeKind,
            id: promptControl.historyScopeId,
            audience: promptControl.audience,
            sourceHighWaterSeq: promptControl.sourceHighWaterSeq,
          },
          source: {
            runId: promptControl.sourceRunId,
            runKind: promptControl.sourceRunKind,
            refId: promptControl.sourceRefId,
            refOrdinal: promptControl.sourceRefOrdinal,
            segmentOrdinal: promptControl.sourceSegmentOrdinal,
            latestFinishedAssistantMessageId:
              promptControl.latestFinishedAssistantMessageId,
          },
          settings: promptControl.settingsSnapshot,
          model: promptControl.modelSnapshot,
        }
      : null,
  );
  if (
    !run ||
    run.kind !== "compaction" ||
    run.sessionId !== eventRow.sessionId ||
    run.triggeredByRunId !== promptControl?.sourceRunId ||
    !sourceRun ||
    (sourceRun.kind !== "productive" && sourceRun.kind !== "consult") ||
    sourceRun.targetAgentId !== eventRow.agentId ||
    sourceRun.sessionId !== eventRow.sessionId ||
    !parsedContext.success
  ) {
    throw new IssueSessionLifecycleConflict(
      "Compaction event has no matching typed maintenance run",
      { eventId: eventRow.id, runId: eventRow.runId },
    );
  }
  const context = parsedContext.data;
  const data = sessionEvent.data as Record<string, unknown>;
  const messageID =
    typeof data.messageID === "string" ? data.messageID : null;
  const timestamp = eventRow.eventTimestamp.getTime();
  if (
    data.sessionID !== eventRow.sessionId ||
    !messageID ||
    !Number.isFinite(timestamp)
  ) {
    throw new IssueSessionLifecycleConflict(
      "Compaction event changed its Session or message identity",
      { eventId: eventRow.id },
    );
  }

  if (eventRow.type === "session.next.compaction.started") {
    if (suppliedControl) {
      throw new IssueSessionLifecycleConflict(
        "Compaction request event cannot carry a result control",
        { eventId: eventRow.id },
      );
    }
    const compaction = sessionCompactionEnvelope(
      context,
      run.runId,
      promptControl!.id,
    );
    await messageStore.appendMessage(IssueSession.decodeIssueSessionMessage({
      id: messageID,
      type: "user",
      text: "",
      files: [],
      agents: [],
      metadata: {
        paperclip: {
          compaction,
        },
      },
      time: { created: timestamp },
    }));
    await insertOrAssertIssueSessionSourceUserExecution(transaction, {
      companyId: eventRow.companyId,
      issueId: eventRow.issueId,
      sessionId: eventRow.sessionId,
      messageId: messageID,
      sourceAgentId: eventRow.agentId,
      providerId: "paperclip-acp",
      modelId: context.model.targetModelId,
      variant: null,
      createdAt: new Date(timestamp),
    });
    await commitProjectedIssueSessionSequence(
      transaction,
      eventRow.sessionId,
      eventRow.seq,
    );
    return true;
  }

  const control = await loadCompactionControl(
    transaction,
    eventRow,
    suppliedControl,
  );
  if (
    compactionControlDisposition(control) !== "active" &&
    !rebuilding
  ) {
    throw new IssueSessionLifecycleConflict(
      "An invalidated compaction control cannot project a live result",
      { controlId: control.id, eventId: eventRow.id },
    );
  }
  const successful = control.kind === "checkpoint";
  const projectedMessageId = successful
    ? control.summaryAssistantMessageId
    : control.failedAssistantMessageId;
  if (
    (control.kind !== "checkpoint" &&
      control.kind !== "failed-compaction") ||
    control.compactionRunId !== run.runId ||
    control.historyScopeKind !== promptControl!.historyScopeKind ||
    control.historyScopeId !== promptControl!.historyScopeId ||
    control.audience !== promptControl!.audience ||
    control.contextEpoch !== promptControl!.contextEpoch ||
    control.executionLineageId !== promptControl!.executionLineageId ||
    control.sourceHighWaterSeq !== promptControl!.sourceHighWaterSeq ||
    control.sourceRunId !== promptControl!.sourceRunId ||
    control.sourceRunKind !== promptControl!.sourceRunKind ||
    control.sourceRefId !== promptControl!.sourceRefId ||
    control.sourceRefOrdinal !== promptControl!.sourceRefOrdinal ||
    control.sourceSegmentOrdinal !== promptControl!.sourceSegmentOrdinal ||
    projectedMessageId !== messageID ||
    !control.compactionRequestMessageId ||
    (data.recent !== "")
  ) {
    throw new IssueSessionLifecycleConflict(
      "Compaction result event diverges from its sequenced control",
      { eventId: eventRow.id },
    );
  }
  const request = await findMessage(
    transaction,
    eventRow,
    control.compactionRequestMessageId,
  );
  if (request?.type !== "user") {
    throw new IssueSessionLifecycleConflict(
      "Compaction result has no canonical request marker",
      {
        eventId: eventRow.id,
        requestMessageId: control.compactionRequestMessageId,
      },
    );
  }
  const sessionRequest = issueSessionMessageFromRow(request);
  if (sessionRequest.type !== "user") {
    throw new IssueSessionInvariantError(
      `Compaction request ${request.id} is not an Issue Session user message`,
    );
  }
  const requestMetadata =
    typeof sessionRequest.metadata === "object" &&
    sessionRequest.metadata !== null
      ? (sessionRequest.metadata as Record<string, unknown>)
      : {};
  const requestPaperclip =
    typeof requestMetadata.paperclip === "object" &&
    requestMetadata.paperclip !== null
      ? (requestMetadata.paperclip as Record<string, unknown>)
      : {};
  const requestCompaction = requestPaperclip.compaction;
  if (
    typeof requestCompaction !== "object" ||
    requestCompaction === null ||
    (requestCompaction as { runID?: unknown }).runID !==
      run.runId ||
    (requestCompaction as { controlID?: unknown }).controlID !==
      promptControl!.id
  ) {
    throw new IssueSessionLifecycleConflict(
      "Compaction result request marker belongs to another run",
      {
        eventId: eventRow.id,
        requestMessageId: control.compactionRequestMessageId,
      },
    );
  }
  const updatedRequest = IssueSession.Message.User.make({
    ...sessionRequest,
    metadata: {
      ...requestMetadata,
      paperclip: {
        ...requestPaperclip,
        compaction: {
          ...(requestCompaction as Record<string, unknown>),
          tail_start_id:
            successful
              ? (control.tailStartMessageId ?? undefined)
              : undefined,
        },
      },
    },
  });
  await transaction
    .update(issueSessionMessages)
    .set({
      data: encodeIssueSessionMessageData(updatedRequest),
      modelStateSeq: eventRow.seq,
      timeUpdated: new Date(timestamp),
    })
    .where(
      eq(
        issueSessionMessages.id,
        control.compactionRequestMessageId,
      ),
    );

  const text = typeof data.text === "string" ? data.text : "";
  const content = text
    ? [
        {
          type: "text",
          id: `${messageID}:summary`,
          text,
        },
      ]
    : [];
  const model = context.model;
  const compaction = {
    ...sessionCompactionEnvelope(context, run.runId, promptControl!.id),
    role: "assistant-result" as const,
  };
  await messageStore.appendMessage(IssueSession.decodeIssueSessionMessage({
    id: messageID,
    type: "assistant",
    agent: eventRow.agentId,
    model: {
      id: model.targetModelId,
      providerID: "paperclip-acp",
    },
    time: {
      created: timestamp,
      completed: timestamp,
    },
    content,
    finish: successful ? "stop" : "error",
    ...(!successful
      ? {
          error: {
            type: "unknown" as const,
            message:
              control.failedAssistantErrorKind ??
              "Compaction failed without an error message",
          },
        }
      : {}),
    metadata: {
      paperclip: {
        parentID: control.compactionRequestMessageId,
        summary: successful,
        compaction: {
          ...compaction,
          requestMessageID: control.compactionRequestMessageId,
          status: successful ? "success" : "failed",
          tail_start_id:
            successful
              ? (control.tailStartMessageId ?? undefined)
              : undefined,
          errorKind:
            successful
              ? undefined
              : control.failedAssistantErrorKind,
          structuralPositions:
            control.structuralPositions ?? [],
        },
      },
    },
  }));
  if (suppliedControl) {
    await persistCompactionControl(
      transaction,
      eventRow,
      suppliedControl,
    );
  }
  await commitProjectedIssueSessionSequence(
    transaction,
    eventRow.sessionId,
    eventRow.seq,
  );
  return true;
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
    UPDATE issue_session_compaction_controls control
    SET disposition = 'invalidated',
        invalidated_at = ${eventRow.eventTimestamp.toISOString()},
        invalidated_by_revert_event_id = ${eventRow.id},
        invalidated_boundary_message_id = ${boundaryMessageId},
        invalidated_boundary_seq = ${boundarySeq}
    WHERE control.company_id = ${eventRow.companyId}
      AND control.issue_id = ${eventRow.issueId}
      AND control.session_id = ${eventRow.sessionId}
      AND control.disposition = 'active'
      AND (
        control.seq > ${boundarySeq}
        OR control.source_high_water_seq > ${boundarySeq}
      )
  `);
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
  if (
    (eventRow.type === "session.next.compaction.started" ||
      eventRow.type === "session.next.compaction.ended") &&
    input.comment
  ) {
    throw new IssueSessionLifecycleConflict(
      "Issue Session compaction events cannot create comments",
      { eventId: eventRow.id, eventType: eventRow.type },
    );
  }
  if (
    await projectScopedCompaction(
      transaction,
      eventRow,
      rebuilding,
      touchedMessageIds,
      input.compactionControl,
    )
  ) {
    return null;
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
  if (input.compactionControl) {
    if (
      event.type !== "session.next.compaction.ended" ||
      input.comment
    ) {
      throw new IssueSessionLifecycleConflict(
        "Issue Session compaction control requires its result event and cannot create a comment",
        { eventId: eventRow.id, eventType: event.type },
      );
    }
    await persistCompactionControl(
      transaction,
      eventRow,
      input.compactionControl,
    );
  }
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
      compactionControl: input.compactionControl,
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

export async function rebuildIssueSessionProjectionInTx(
  transaction: IssueSessionDbTransaction,
  scope: { companyId: string; issueId: string; sessionId: string },
  issueSessionStore: IssueSessionStore,
): Promise<void> {
  const readStore = issueSessionStore.bindReadDatabase(
    transaction as unknown as Db,
  );
  const controlsBySequence = new Map<
    number,
    Array<typeof issueSessionCompactionControls.$inferSelect>
  >();
  let controlCursor: string | null = null;
  do {
    const controlPage = await readStore.pageCompactionControls(
      {
        ...scope,
        direction: "asc",
        projection: "rebuild",
      },
      { cursor: controlCursor },
    );
    for (const control of controlPage.items) {
      if (control.kind === "recovery-prompt") {
        if (control.seq !== null) {
          throw new IssueSessionLifecycleConflict(
            "Recovery compaction prompt unexpectedly owns an event sequence",
            { controlId: control.id },
          );
        }
        continue;
      }
      if (control.seq === null) {
        throw new IssueSessionLifecycleConflict(
          "Compaction effect lost its event sequence",
          { controlId: control.id },
        );
      }
      const atSequence = controlsBySequence.get(control.seq) ?? [];
      atSequence.push(control);
      controlsBySequence.set(control.seq, atSequence);
    }
    controlCursor = controlPage.nextCursor;
  } while (controlCursor);
  await transaction.execute(sql`
    UPDATE issue_sessions
    SET projected_event_seq = -1
    WHERE company_id = ${scope.companyId}
      AND issue_id = ${scope.issueId}
      AND id = ${scope.sessionId}
  `);
  const touched = new Set<string>();
  let eventCursor: string | null = null;
  do {
    const eventPage = await readStore.pageEvents(
      {
        ...scope,
        direction: "asc",
        projection: "rebuild",
      },
      { cursor: eventCursor },
    );
    for (const { row: storedEvent } of eventPage.items) {
      const event = projectableIssueSessionEvent(storedEvent);
      const atSequence = controlsBySequence.get(event.seq) ?? [];
      controlsBySequence.delete(event.seq);
      const results = atSequence.filter(
        (control) =>
          control.kind === "checkpoint" ||
          control.kind === "failed-compaction",
      );
      const effects = atSequence.filter(
        (control) => control.kind === "tool-pruned",
      );
      if (
        results.length > 0 &&
        event.type !== "session.next.compaction.ended"
      ) {
        throw new IssueSessionLifecycleConflict(
          "Compaction result control is attached to a non-result event",
          { eventId: event.id, eventType: event.type, sequence: event.seq },
        );
      }
      if (
        event.type === "session.next.compaction.ended" &&
        results.length !== 1
      ) {
        throw new IssueSessionLifecycleConflict(
          "Compaction result event has no unique replay control",
          { eventId: event.id, sequence: event.seq },
        );
      }
      await projectEvent(
        transaction,
        event,
        results[0] ? { compactionControl: results[0] } : {},
        true,
        touched,
      );
      for (const effect of effects) {
        await projectIssueSessionToolPrunedEffectInTx(
          transaction,
          effect as PersistedCompactionControl,
          { rebuilding: true },
        );
      }
    }
    eventCursor = eventPage.nextCursor;
  } while (eventCursor);
  const orphan = controlsBySequence.values().next().value?.[0];
  if (orphan) {
    throw new IssueSessionLifecycleConflict(
      "Compaction control has no aggregate event to replay",
      { controlId: orphan.id, sequence: orphan.seq },
    );
  }

  let messageCursor: string | null = null;
  do {
    const messagePage = await readStore.pageMessages(
      {
        ...scope,
        direction: "asc",
        projection: "rebuild",
      },
      { cursor: messageCursor },
    );
    for (const { row } of messagePage.items) {
      if (!touched.has(row.id)) {
        await transaction
          .delete(issueSessionMessages)
          .where(eq(issueSessionMessages.id, row.id));
      }
    }
    messageCursor = messagePage.nextCursor;
  } while (messageCursor);
}
