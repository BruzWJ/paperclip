import { issueSessions, type Db } from "@paperclipai/db";
import type {
  PluginJsonValue,
  WorkerToHostMethods,
} from "@paperclipai/plugin-sdk";
import {
  encodeIssueSessionEvent,
  encodeIssueSessionMessage,
} from "@paperclipai/shared/issue-session";
import { and, eq } from "drizzle-orm";
import {
  IssueSessionInvalidCursor,
  IssueSessionInvariantError,
  type IssueSessionStore,
} from "./issue-session/store.js";

type ReadSessionInput = WorkerToHostMethods["runtime.records.readSession"][0];
type ReadSessionResult = WorkerToHostMethods["runtime.records.readSession"][1];
type SessionRow = typeof issueSessions.$inferSelect;

function iso(value: Date): string {
  return value.toISOString();
}

function canonicalPluginJson(value: unknown): PluginJsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalPluginJson);
  }
  if (typeof value === "object") {
    const result: Record<string, PluginJsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) {
        result[key] = canonicalPluginJson(item);
      }
    }
    return result;
  }
  throw new IssueSessionInvariantError(
    "Canonical Session record contains a non-JSON value",
  );
}

function assertSnapshotSequence(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new IssueSessionInvalidCursor(
      `${label} must be a non-negative safe integer`,
    );
  }
}

function assertAfterSequence(
  value: number | undefined,
  highWaterSeq: number,
  label: string,
): number {
  const resolved = value ?? -1;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < -1 ||
    resolved > highWaterSeq
  ) {
    throw new IssueSessionInvalidCursor(
      `${label} must be an integer from -1 through the Session snapshot high-water`,
    );
  }
  return resolved;
}

function sessionIdentity(row: SessionRow): ReadSessionResult["session"] {
  return {
    companyId: row.companyId,
    issueId: row.issueId,
    sessionId: row.id,
    parentSessionId: row.parentSessionId,
    projectId: row.projectId,
    createdAt: iso(row.timeCreated),
  };
}

function messageWindow(input: ReadSessionInput): {
  afterSeq: number;
  order: "created" | "changed";
} {
  const created = input.messages?.afterSeq;
  const changed = input.messages?.changedAfterSeq;
  if (created !== undefined && changed !== undefined) {
    throw new IssueSessionInvalidCursor(
      "Message afterSeq and changedAfterSeq are mutually exclusive",
    );
  }
  return changed !== undefined
    ? {
        afterSeq: assertAfterSequence(
          changed,
          input.snapshotHighWaterSeq,
          "Message changedAfterSeq",
        ),
        order: "changed",
      }
    : {
        afterSeq: assertAfterSequence(
          created,
          input.snapshotHighWaterSeq,
          "Message afterSeq",
        ),
        order: "created",
      };
}

function assertMessagePage(
  result: ReadSessionResult["messages"],
  input: {
    companyId: string;
    issueId: string;
    sessionId: string;
    afterSeq: number;
    highWaterSeq: number;
    order: "created" | "changed";
  },
): void {
  let previous: { sequence: number; id: string } | null = null;
  for (const item of result.items) {
    const sequence =
      input.order === "changed" ? item.row.modelStateSeq : item.row.seq;
    const ordered =
      previous === null ||
      sequence > previous.sequence ||
      (sequence === previous.sequence && item.row.id > previous.id);
    if (
      item.row.companyId !== input.companyId ||
      item.row.issueId !== input.issueId ||
      item.row.sessionId !== input.sessionId ||
      !Number.isSafeInteger(item.row.seq) ||
      !Number.isSafeInteger(item.row.modelStateSeq) ||
      item.row.seq < 0 ||
      item.row.modelStateSeq < item.row.seq ||
      sequence <= input.afterSeq ||
      !ordered ||
      item.row.id.length === 0 ||
      item.row.modelStateSeq > input.highWaterSeq
    ) {
      throw new IssueSessionInvariantError(
        "Canonical Session reader received a message outside its snapshot",
      );
    }
    previous = { sequence, id: item.row.id };
  }
}

function assertEventPage(
  result: ReadSessionResult["events"],
  input: {
    companyId: string;
    issueId: string;
    sessionId: string;
    afterSeq: number;
    highWaterSeq: number;
  },
): void {
  let previous: { sequence: number; id: string } | null = null;
  for (const item of result.items) {
    const ordered =
      previous === null ||
      item.row.seq > previous.sequence ||
      (item.row.seq === previous.sequence && item.row.id > previous.id);
    if (
      item.row.companyId !== input.companyId ||
      item.row.issueId !== input.issueId ||
      item.row.sessionId !== input.sessionId ||
      !Number.isSafeInteger(item.row.seq) ||
      item.row.seq <= input.afterSeq ||
      item.row.seq > input.highWaterSeq ||
      item.row.id.length === 0 ||
      !ordered
    ) {
      throw new IssueSessionInvariantError(
        "Canonical Session reader received an event outside its snapshot",
      );
    }
    previous = { sequence: item.row.seq, id: item.row.id };
  }
}

/**
 * Creates the generic privileged reader for Paperclip's canonical, already
 * redacted issue Session. It never reads ACPX state or provider credentials.
 */
export function createPluginCanonicalSessionReader(
  db: Db,
  issueSessionStore: IssueSessionStore,
): {
  readSession(input: ReadSessionInput): Promise<ReadSessionResult>;
} {
  return {
    async readSession(input) {
      assertSnapshotSequence(
        input.snapshotHighWaterSeq,
        "Session snapshot high-water",
      );
      const messagesWindow = messageWindow(input);
      const eventAfterSeq = assertAfterSequence(
        input.events?.afterSeq,
        input.snapshotHighWaterSeq,
        "Event afterSeq",
      );

      return db.transaction(
        async (transaction) => {
          const [row] = await transaction
            .select()
            .from(issueSessions)
            .where(
              and(
                eq(issueSessions.companyId, input.companyId),
                eq(issueSessions.id, input.sessionId),
              ),
            )
            .limit(1);
          if (!row) {
            throw new Error(
              "Canonical Session record is unavailable in the requested company",
            );
          }
          if (input.snapshotHighWaterSeq > row.projectedEventSeq) {
            throw new IssueSessionInvalidCursor(
              "Session snapshot high-water exceeds the canonical projected sequence",
            );
          }

          const store = issueSessionStore.bindReadDatabase(
            transaction as unknown as Db,
          );
          const messages = await store.pageMessages(
            {
              companyId: row.companyId,
              issueId: row.issueId,
              sessionId: row.id,
              afterSeq: messagesWindow.afterSeq,
              highWaterSeq: input.snapshotHighWaterSeq,
              messageOrder: messagesWindow.order,
              direction: "asc",
              projection: "audit",
            },
            {
              cursor: input.messages?.cursor,
              limit: input.messages?.limit,
            },
          );
          const events = await store.pageEvents(
            {
              companyId: row.companyId,
              issueId: row.issueId,
              sessionId: row.id,
              afterSeq: eventAfterSeq,
              highWaterSeq: input.snapshotHighWaterSeq,
              direction: "asc",
              projection: "audit",
            },
            {
              cursor: input.events?.cursor,
              limit: input.events?.limit,
            },
          );

          const result: ReadSessionResult = {
            session: sessionIdentity(row),
            snapshotHighWaterSeq: input.snapshotHighWaterSeq,
            messages: {
              items: messages.items.map(({ row: messageRow, message }) => ({
                row: {
                  id: messageRow.id,
                  companyId: messageRow.companyId,
                  issueId: messageRow.issueId,
                  sessionId: messageRow.sessionId,
                  seq: messageRow.seq,
                  modelStateSeq: messageRow.modelStateSeq,
                  type: messageRow.type,
                  runId: messageRow.runId,
                  ownershipEpoch: messageRow.ownershipEpoch,
                  agentId: messageRow.agentId,
                  adapterConfigRevisionId: messageRow.adapterConfigRevisionId,
                  timeCreated: iso(messageRow.timeCreated),
                  timeUpdated: iso(messageRow.timeUpdated),
                },
                message: canonicalPluginJson(
                  encodeIssueSessionMessage(message),
                ),
              })),
              nextCursor: messages.nextCursor,
            },
            events: {
              items: events.items.map(({ row: eventRow, event }) => ({
                row: {
                  id: eventRow.id,
                  companyId: eventRow.companyId,
                  issueId: eventRow.issueId,
                  sessionId: eventRow.sessionId,
                  seq: eventRow.seq,
                  versionedType: eventRow.type,
                  runId: eventRow.runId,
                  ownershipEpoch: eventRow.ownershipEpoch,
                  agentId: eventRow.agentId,
                  adapterConfigRevisionId: eventRow.adapterConfigRevisionId,
                  sourceKind: eventRow.sourceKind,
                  sourceId: eventRow.sourceId,
                  immutableSourceKey: eventRow.immutableSourceKey,
                  sourceRecordId: eventRow.sourceRecordId,
                  sourceIdentityDigest: eventRow.sourceIdentityDigest,
                  createdAt: iso(eventRow.createdAt),
                },
                event: canonicalPluginJson(encodeIssueSessionEvent(event)),
              })),
              nextCursor: events.nextCursor,
            },
          };
          assertMessagePage(result.messages, {
            companyId: row.companyId,
            issueId: row.issueId,
            sessionId: row.id,
            afterSeq: messagesWindow.afterSeq,
            highWaterSeq: input.snapshotHighWaterSeq,
            order: messagesWindow.order,
          });
          assertEventPage(result.events, {
            companyId: row.companyId,
            issueId: row.issueId,
            sessionId: row.id,
            afterSeq: eventAfterSeq,
            highWaterSeq: input.snapshotHighWaterSeq,
          });
          return result;
        },
        {
          isolationLevel: "repeatable read",
          accessMode: "read only",
        },
      );
    },
  };
}
