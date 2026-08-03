import {
  issueComments,
  issueSessionMessages,
  type Db,
} from "@paperclipai/db";
import {
  decodeIssueSessionMessage,
  encodeIssueSessionMessage,
} from "@paperclipai/shared/issue-session";
import { describe, expect, it } from "vitest";
import {
  ISSUE_SESSION_DEFAULT_PAGE_SIZE,
  ISSUE_SESSION_MAX_PAGE_SIZE,
  IssueSessionInvalidCursor,
  createIssueSessionStore,
  isSettledIssueSessionMessage,
  type IssueSessionPageScope,
} from "../services/issue-session/store.js";

type MessageRow = typeof issueSessionMessages.$inferSelect;
type CommentRow = typeof issueComments.$inferSelect;

const companyId = "10000000-0000-4000-8000-000000000001";
const otherCompanyId = "10000000-0000-4000-8000-000000000002";
const issueId = "20000000-0000-4000-8000-000000000001";
const otherIssueId = "20000000-0000-4000-8000-000000000002";
const runId = "30000000-0000-4000-8000-000000000001";
const otherRunId = "30000000-0000-4000-8000-000000000002";
const sessionId = "ses_store";
const otherSessionId = "ses_other";

function messageRow(seq: number): MessageRow {
  const id = `msg_${seq.toString().padStart(4, "0")}`;
  const timeCreated = new Date(1_700_000_000_000 + seq);
  const message = decodeIssueSessionMessage({
    id,
    type: "user",
    text: `message ${seq}`,
    time: { created: timeCreated.getTime() },
  });
  const encoded = encodeIssueSessionMessage(message) as unknown as Record<
    string,
    unknown
  >;
  const { id: _id, type: _type, ...data } = encoded;
  return {
    id,
    companyId,
    issueId,
    sessionId,
    seq,
    modelStateSeq: seq,
    type: "user",
    data,
    runId,
    ownershipEpoch: 1,
    agentId: null,
    adapterConfigRevisionId: null,
    timeCreated,
    timeUpdated: timeCreated,
  };
}

function commentRow(seq: number): CommentRow {
  const createdAt = new Date(1_700_000_000_000 + seq);
  return {
    id: `40000000-0000-4000-8000-${seq.toString().padStart(12, "0")}`,
    companyId,
    issueId,
    authorAgentId: null,
    authorUserId: "user-1",
    authorType: "user",
    runId,
    sessionId,
    canonicalSourceKind: "human_comment",
    canonicalSourceId: `source-${seq}`,
    canonicalMessageId: `msg_${seq.toString().padStart(4, "0")}`,
    admittedEventSeq: seq,
    promotedEventSeq: seq,
    projectedEventSeq: seq,
    body: `comment ${seq}`,
    presentation: null,
    metadata: null,
    sourceTrust: null,
    createdAt,
    updatedAt: createdAt,
  };
}

function queuedDb<Row>(pages: readonly (readonly Row[])[]) {
  let pageIndex = 0;
  let selectCount = 0;
  const limits: number[] = [];
  const db = {
    select() {
      selectCount += 1;
      const query = {
        from() {
          return query;
        },
        where() {
          return query;
        },
        orderBy() {
          return query;
        },
        limit(limit: number) {
          limits.push(limit);
          return Promise.resolve([...(pages[pageIndex++] ?? [])]);
        },
      };
      return query;
    },
  } as unknown as Db;
  return {
    db,
    limits,
    get selectCount() {
      return selectCount;
    },
  };
}

function scope(
  patch: Partial<IssueSessionPageScope> = {},
): IssueSessionPageScope {
  return {
    companyId,
    issueId,
    sessionId,
    runId,
    direction: "asc",
    projection: "run-trace",
    ...patch,
  };
}

describe("Issue Session bounded read store", () => {
  it("accepts only terminal mutable Session aggregates for immutable history", () => {
    const base = messageRow(1);
    const assistant = (
      completed: boolean,
      toolStatus: "pending" | "running" | "completed" | "error",
    ): MessageRow => {
      const time = base.timeCreated.getTime();
      const message = decodeIssueSessionMessage({
        id: base.id,
        type: "assistant",
        agent: "agent-1",
        model: { providerID: "provider-1", id: "model-1" },
        content: [
          {
            type: "tool",
            id: "tool-1",
            name: "test",
            time: {
              created: time,
              ...(toolStatus === "completed" || toolStatus === "error"
                ? { completed: time + 1 }
                : {}),
            },
            state:
              toolStatus === "pending"
                ? { status: "pending", input: "" }
                : toolStatus === "running"
                  ? {
                      status: "running",
                      input: {},
                      structured: {},
                      content: [],
                    }
                  : toolStatus === "completed"
                    ? {
                        status: "completed",
                        input: {},
                        structured: {},
                        content: [],
                      }
                    : {
                        status: "error",
                        input: {},
                        structured: {},
                        content: [],
                        error: {
                          type: "unknown",
                          message: "failed",
                        },
                      },
          },
        ],
        time: {
          created: time,
          ...(completed ? { completed: time + 2 } : {}),
        },
      });
      const encoded = encodeIssueSessionMessage(
        message,
      ) as unknown as Record<string, unknown>;
      const { id: _id, type: _type, ...data } = encoded;
      return { ...base, type: "assistant", data };
    };

    expect(isSettledIssueSessionMessage(messageRow(1))).toBe(true);
    expect(
      isSettledIssueSessionMessage(assistant(false, "completed")),
    ).toBe(false);
    expect(
      isSettledIssueSessionMessage(assistant(true, "pending")),
    ).toBe(false);
    expect(
      isSettledIssueSessionMessage(assistant(true, "running")),
    ).toBe(false);
    expect(
      isSettledIssueSessionMessage(assistant(true, "completed")),
    ).toBe(true);
    expect(
      isSettledIssueSessionMessage(assistant(true, "error")),
    ).toBe(true);
  });

  it("uses the default page size and never asks storage for more than one lookahead row", async () => {
    const rows = Array.from(
      { length: ISSUE_SESSION_DEFAULT_PAGE_SIZE + 1 },
      (_, seq) => messageRow(seq),
    );
    const fixture = queuedDb([rows]);
    const store = createIssueSessionStore(fixture.db, {
      cursorSecret: "test-only-session-store-secret",
    });

    const page = await store.pageMessages(scope());

    expect(page.items).toHaveLength(ISSUE_SESSION_DEFAULT_PAGE_SIZE);
    expect(page.items[0]?.row.id).toBe("msg_0000");
    expect(page.items.at(-1)?.row.id).toBe("msg_0099");
    expect(page.nextCursor).toEqual(expect.any(String));
    expect(fixture.limits).toEqual([
      ISSUE_SESSION_DEFAULT_PAGE_SIZE + 1,
    ]);
  });

  it("traverses more than 500 rows in complete, deterministic, non-overlapping keyset pages", async () => {
    const rows = Array.from({ length: 601 }, (_, seq) => messageRow(seq));
    const fixture = queuedDb([
      rows.slice(0, ISSUE_SESSION_MAX_PAGE_SIZE + 1),
      rows.slice(ISSUE_SESSION_MAX_PAGE_SIZE),
    ]);
    const store = createIssueSessionStore(fixture.db, {
      cursorSecret: "test-only-session-store-secret",
    });

    const first = await store.pageMessages(scope(), {
      limit: ISSUE_SESSION_MAX_PAGE_SIZE,
    });
    const second = await store.pageMessages(scope(), {
      cursor: first.nextCursor,
      limit: ISSUE_SESSION_MAX_PAGE_SIZE,
    });
    const ids = [...first.items, ...second.items].map(
      ({ row }) => row.id,
    );

    expect(first.items).toHaveLength(500);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(second.items).toHaveLength(101);
    expect(second.nextCursor).toBeNull();
    expect(ids).toEqual(rows.map((row) => row.id));
    expect(new Set(ids).size).toBe(rows.length);
    expect(fixture.limits).toEqual([501, 501]);
  });

  it("supports the same complete keyset traversal in descending order", async () => {
    const rows = Array.from({ length: 601 }, (_, seq) => messageRow(seq))
      .reverse();
    const fixture = queuedDb([
      rows.slice(0, ISSUE_SESSION_MAX_PAGE_SIZE + 1),
      rows.slice(ISSUE_SESSION_MAX_PAGE_SIZE),
    ]);
    const store = createIssueSessionStore(fixture.db, {
      cursorSecret: "test-only-session-store-secret",
    });
    const descendingScope = scope({ direction: "desc" });

    const first = await store.pageMessages(descendingScope, {
      limit: ISSUE_SESSION_MAX_PAGE_SIZE,
    });
    const second = await store.pageMessages(descendingScope, {
      cursor: first.nextCursor,
      limit: ISSUE_SESSION_MAX_PAGE_SIZE,
    });

    expect([...first.items, ...second.items].map(({ row }) => row.id))
      .toEqual(rows.map((row) => row.id));
    expect(second.nextCursor).toBeNull();
  });

  it("retains one cursor authority when a read is bound to an owned transaction", async () => {
    const firstDb = queuedDb([[messageRow(0), messageRow(1)]]);
    const secondDb = queuedDb([[messageRow(1)]]);
    const store = createIssueSessionStore(firstDb.db, {
      cursorSecret: "test-only-session-store-secret",
    });
    const first = await store.pageMessages(scope(), { limit: 1 });

    const second = await store
      .bindReadDatabase(secondDb.db)
      .pageMessages(scope(), {
        cursor: first.nextCursor,
        limit: 1,
      });

    expect(second.items.map(({ row }) => row.id)).toEqual(["msg_0001"]);
    expect(second.nextCursor).toBeNull();
  });

  it("pages materialized Session comments with their own bound row kind", async () => {
    const firstDb = queuedDb([
      [commentRow(0), commentRow(1)],
      [commentRow(1)],
    ]);
    const store = createIssueSessionStore(firstDb.db, {
      cursorSecret: "test-only-session-store-secret",
    });

    const first = await store.pageComments(scope(), { limit: 1 });
    const second = await store.pageComments(scope(), {
      cursor: first.nextCursor,
      limit: 1,
    });

    expect(first.items.map((row) => row.body)).toEqual(["comment 0"]);
    expect(second.items.map((row) => row.body)).toEqual(["comment 1"]);
    expect(second.nextCursor).toBeNull();
  });

  it("rejects every out-of-contract page size before querying storage", async () => {
    const fixture = queuedDb([]);
    const store = createIssueSessionStore(fixture.db, {
      cursorSecret: "test-only-session-store-secret",
    });

    for (const limit of [0, 1.5, ISSUE_SESSION_MAX_PAGE_SIZE + 1]) {
      await expect(
        store.pageMessages(scope(), { limit }),
      ).rejects.toBeInstanceOf(IssueSessionInvalidCursor);
    }
    await expect(
      store.pageMessages(scope(), { cursor: "" }),
    ).rejects.toBeInstanceOf(IssueSessionInvalidCursor);
    expect(fixture.selectCount).toBe(0);
  });

  it("authenticates the cursor and binds company, issue, Session, run, direction, projection, and row kind", async () => {
    const fixture = queuedDb([[messageRow(0), messageRow(1)]]);
    const store = createIssueSessionStore(fixture.db, {
      cursorSecret: "test-only-session-store-secret",
    });
    const first = await store.pageMessages(scope(), { limit: 1 });
    const cursor = first.nextCursor;
    expect(cursor).toEqual(expect.any(String));

    const crossScopes: IssueSessionPageScope[] = [
      scope({ companyId: otherCompanyId }),
      scope({ issueId: otherIssueId }),
      scope({ sessionId: otherSessionId }),
      scope({ runId: otherRunId }),
      scope({ runId: undefined }),
      scope({ direction: "desc" }),
      scope({ projection: "audit" }),
    ];
    for (const crossScope of crossScopes) {
      await expect(
        store.pageMessages(crossScope, { cursor }),
      ).rejects.toBeInstanceOf(IssueSessionInvalidCursor);
    }
    await expect(
      store.pageEvents(scope(), { cursor }),
    ).rejects.toBeInstanceOf(IssueSessionInvalidCursor);
    await expect(
      store.pageCompactionControls(scope(), { cursor }),
    ).rejects.toBeInstanceOf(IssueSessionInvalidCursor);
    await expect(
      store.pageComments(scope(), { cursor }),
    ).rejects.toBeInstanceOf(IssueSessionInvalidCursor);

    const [payload] = String(cursor).split(".");
    await expect(
      store.pageMessages(scope(), {
        cursor: `${payload}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
      }),
    ).rejects.toBeInstanceOf(IssueSessionInvalidCursor);
    expect(fixture.selectCount).toBe(1);
  });

  it("rejects incomplete or non-closed runtime scopes", async () => {
    const fixture = queuedDb([]);
    const store = createIssueSessionStore(fixture.db, {
      cursorSecret: "test-only-session-store-secret",
    });

    await expect(
      store.pageMessages(
        scope({ direction: "sideways" } as Partial<IssueSessionPageScope>),
      ),
    ).rejects.toBeInstanceOf(IssueSessionInvalidCursor);
    await expect(
      store.pageMessages(
        scope({
          projection: "arbitrary",
        } as unknown as Partial<IssueSessionPageScope>),
      ),
    ).rejects.toBeInstanceOf(IssueSessionInvalidCursor);
    await expect(
      store.pageMessages(scope({ sessionId: "" })),
    ).rejects.toBeInstanceOf(IssueSessionInvalidCursor);
    expect(fixture.selectCount).toBe(0);
  });
});
