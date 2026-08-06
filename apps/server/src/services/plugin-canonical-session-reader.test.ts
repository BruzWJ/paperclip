import {
  issueSessionEvents,
  issueSessionMessages,
  issueSessions,
  type Db,
} from "@paperclipai/db";
import {
  decodeDurableIssueSessionEventRow,
  decodeIssueSessionMessage,
  encodeIssueSessionMessage,
} from "@paperclipai/shared/issue-session";
import { describe, expect, it, vi } from "vitest";
import type { IssueSessionStore } from "./issue-session/store.js";
import { createPluginCanonicalSessionReader } from "./plugin-canonical-session-reader.js";

const companyId = "10000000-0000-4000-8000-000000000001";
const issueId = "20000000-0000-4000-8000-000000000001";
const runId = "30000000-0000-4000-8000-000000000001";
const agentId = "40000000-0000-4000-8000-000000000001";
const revisionId = "50000000-0000-4000-8000-000000000001";
const sessionId = "ses_plugin_reader";
const createdAt = new Date("2026-08-05T00:00:00.000Z");

type SessionRow = typeof issueSessions.$inferSelect;
type MessageRow = typeof issueSessionMessages.$inferSelect;
type EventRow = typeof issueSessionEvents.$inferSelect;

function sessionRow(patch: Partial<SessionRow> = {}): SessionRow {
  return {
    id: sessionId,
    companyId,
    issueId,
    parentSessionId: null,
    projectId: "project-1",
    agent: "codex",
    model: { id: "model-1", providerID: "provider-1" },
    cost: 0.25,
    tokensInput: 10,
    tokensOutput: 20,
    tokensReasoning: 3,
    tokensCacheRead: 4,
    tokensCacheWrite: 5,
    title: "Canonical Session",
    directory: "/workspace/project",
    workspaceId: "workspace-1",
    subpath: "src",
    revert: null,
    timeCreated: createdAt,
    timeUpdated: new Date(createdAt.getTime() + 1_000),
    timeArchived: null,
    projectedEventSeq: 7,
    integrityState: "ready",
    migratedAt: createdAt,
    refAdmittableAt: createdAt,
    purgeFencedAt: null,
    ...patch,
  };
}

function messageRecord() {
  const message = decodeIssueSessionMessage({
    id: "msg_plugin_reader",
    type: "user",
    text: "remember this",
    time: { created: createdAt.getTime() },
  });
  const encoded = encodeIssueSessionMessage(message) as unknown as Record<
    string,
    unknown
  >;
  const { id: _id, type: _type, ...data } = encoded;
  const row: MessageRow = {
    id: "msg_plugin_reader",
    companyId,
    issueId,
    sessionId,
    seq: 4,
    modelStateSeq: 5,
    type: "user",
    data,
    runId,
    ownershipEpoch: 2,
    agentId,
    adapterConfigRevisionId: revisionId,
    timeCreated: createdAt,
    timeUpdated: new Date(createdAt.getTime() + 500),
  };
  return { row, message };
}

function eventRecord() {
  const row: EventRow = {
    id: "evt_plugin_reader",
    companyId,
    issueId,
    sessionId,
    seq: 4,
    type: "session.next.prompted.1",
    data: {
      timestamp: createdAt.getTime(),
      sessionID: sessionId,
      messageID: "msg_plugin_reader",
      prompt: { text: "remember this" },
      delivery: "queue",
    },
    runId,
    ownershipEpoch: 2,
    agentId,
    adapterConfigRevisionId: revisionId,
    sourceKind: "human_comment",
    sourceId: "source-1",
    immutableSourceKey: "source-key-1",
    sourceRecordId: "source-record-1",
    sourceIdentityDigest: "a".repeat(64),
    createdAt,
  };
  return {
    row,
    event: decodeDurableIssueSessionEventRow({
      id: row.id,
      sessionId: row.sessionId,
      seq: row.seq,
      type: row.type,
      data: row.data,
    }),
    timestamp: createdAt,
  };
}

function fakeDb(row: SessionRow | null) {
  const transactionDb = {
    select() {
      const query = {
        from() {
          return query;
        },
        where() {
          return query;
        },
        limit() {
          return Promise.resolve(row ? [row] : []);
        },
      };
      return query;
    },
  };
  const transaction = vi.fn(
    async (operation: (tx: unknown) => Promise<unknown>) =>
      operation(transactionDb),
  );
  return { db: { transaction } as unknown as Db, transaction };
}

function fakeStore(input: {
  messages?: ReturnType<typeof messageRecord>[];
  events?: ReturnType<typeof eventRecord>[];
} = {}) {
  const pageMessages = vi.fn(async () => ({
    items: input.messages ?? [messageRecord()],
    nextCursor: "message-cursor",
  }));
  const pageEvents = vi.fn(async () => ({
    items: input.events ?? [eventRecord()],
    nextCursor: "event-cursor",
  }));
  const store = {
    pageMessages,
    pageEvents,
    pageComments: vi.fn(),
    bindReadDatabase: vi.fn(),
  };
  store.bindReadDatabase.mockReturnValue(store);
  return {
    store: store as unknown as IssueSessionStore,
    pageMessages,
    pageEvents,
    bindReadDatabase: store.bindReadDatabase,
  };
}

describe("plugin canonical Session reader", () => {
  it("returns exact canonical JSON and row attribution inside one pinned snapshot", async () => {
    const database = fakeDb(sessionRow());
    const sessions = fakeStore();
    const reader = createPluginCanonicalSessionReader(
      database.db,
      sessions.store,
    );

    const result = await reader.readSession({
      companyId,
      sessionId,
      snapshotHighWaterSeq: 6,
      messages: { afterSeq: 2, limit: 10 },
      events: { afterSeq: 3, limit: 20 },
    });

    expect(result).toMatchObject({
      session: {
        companyId,
        issueId,
        sessionId,
        projectId: "project-1",
      },
      snapshotHighWaterSeq: 6,
      messages: {
        nextCursor: "message-cursor",
        items: [
          {
            row: {
              id: "msg_plugin_reader",
              seq: 4,
              modelStateSeq: 5,
              runId,
              agentId,
              adapterConfigRevisionId: revisionId,
            },
            message: {
              id: "msg_plugin_reader",
              type: "user",
              text: "remember this",
            },
          },
        ],
      },
      events: {
        nextCursor: "event-cursor",
        items: [
          {
            row: {
              id: "evt_plugin_reader",
              seq: 4,
              versionedType: "session.next.prompted.1",
              runId,
              agentId,
              adapterConfigRevisionId: revisionId,
              sourceIdentityDigest: "a".repeat(64),
            },
            event: {
              id: "evt_plugin_reader",
              type: "session.next.prompted",
            },
          },
        ],
      },
    });
    expect(sessions.pageMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId,
        issueId,
        sessionId,
        afterSeq: 2,
        highWaterSeq: 6,
        messageOrder: "created",
        projection: "audit",
      }),
      { cursor: undefined, limit: 10 },
    );
    expect(sessions.pageEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        afterSeq: 3,
        highWaterSeq: 6,
      }),
      { cursor: undefined, limit: 20 },
    );
    expect(database.transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "repeatable read",
      accessMode: "read only",
    });
    expect(Object.keys(result.session).sort()).toEqual([
      "companyId",
      "createdAt",
      "issueId",
      "parentSessionId",
      "projectId",
      "sessionId",
    ]);
    expect(result.session).not.toHaveProperty("projectedEventSeq");
    expect(result.session).not.toHaveProperty("revert");
  });

  it("supports changed-message deltas ordered by modelStateSeq", async () => {
    const changed = messageRecord();
    changed.row.seq = 2;
    changed.row.modelStateSeq = 6;
    const database = fakeDb(sessionRow({ projectedEventSeq: 8 }));
    const sessions = fakeStore({ messages: [changed] });
    const reader = createPluginCanonicalSessionReader(
      database.db,
      sessions.store,
    );

    const result = await reader.readSession({
      companyId,
      sessionId,
      snapshotHighWaterSeq: 6,
      messages: { changedAfterSeq: 4, limit: 10 },
    });

    expect(result.messages.items[0]?.row).toMatchObject({
      seq: 2,
      modelStateSeq: 6,
    });
    expect(sessions.pageMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        afterSeq: 4,
        highWaterSeq: 6,
        messageOrder: "changed",
      }),
      { cursor: undefined, limit: 10 },
    );
  });

  it("rejects message state returned beyond the requested snapshot", async () => {
    const leaked = messageRecord();
    leaked.row.modelStateSeq = 7;
    const database = fakeDb(sessionRow({ projectedEventSeq: 8 }));
    const sessions = fakeStore({ messages: [leaked] });

    await expect(
      createPluginCanonicalSessionReader(
        database.db,
        sessions.store,
      ).readSession({
        companyId,
        sessionId,
        snapshotHighWaterSeq: 6,
      }),
    ).rejects.toThrow("message outside its snapshot");
  });

  it("rejects events returned outside the requested Session snapshot", async () => {
    const leaked = eventRecord();
    leaked.row.seq = 7;
    const database = fakeDb(sessionRow({ projectedEventSeq: 8 }));
    const sessions = fakeStore({ events: [leaked] });

    await expect(
      createPluginCanonicalSessionReader(
        database.db,
        sessions.store,
      ).readSession({
        companyId,
        sessionId,
        snapshotHighWaterSeq: 6,
      }),
    ).rejects.toThrow("event outside its snapshot");
  });

  it("fails closed for cross-company or future Session snapshots", async () => {
    const missing = fakeDb(null);
    const missingStore = fakeStore();
    await expect(
      createPluginCanonicalSessionReader(
        missing.db,
        missingStore.store,
      ).readSession({
        companyId: "other-company",
        sessionId,
        snapshotHighWaterSeq: 1,
      }),
    ).rejects.toThrow(
      "Canonical Session record is unavailable in the requested company",
    );
    expect(missingStore.pageMessages).not.toHaveBeenCalled();

    const database = fakeDb(sessionRow({ projectedEventSeq: 3 }));
    const sessions = fakeStore();
    await expect(
      createPluginCanonicalSessionReader(
        database.db,
        sessions.store,
      ).readSession({
        companyId,
        sessionId,
        snapshotHighWaterSeq: 4,
      }),
    ).rejects.toThrow(
      "snapshot high-water exceeds the canonical projected sequence",
    );
    expect(sessions.pageMessages).not.toHaveBeenCalled();
  });

  it("rejects invalid delta bounds before opening a database transaction", async () => {
    const database = fakeDb(sessionRow());
    const sessions = fakeStore();
    const reader = createPluginCanonicalSessionReader(
      database.db,
      sessions.store,
    );

    await expect(
      reader.readSession({
        companyId,
        sessionId,
        snapshotHighWaterSeq: 3,
        messages: { afterSeq: 4 },
      }),
    ).rejects.toThrow("Message afterSeq");
    await expect(
      reader.readSession({
        companyId,
        sessionId,
        snapshotHighWaterSeq: 3,
        messages: { afterSeq: 1, changedAfterSeq: 1 },
      }),
    ).rejects.toThrow("mutually exclusive");
    expect(database.transaction).not.toHaveBeenCalled();
  });
});
