import type { TaskChatMessage } from "./task-chat-messages";
import type { BoardTaskCommentGroupPage, BoardTaskRunSegmentPart } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import { flattenBoardTaskCommentGroupPages } from "./optimistic-task-comments";
import { buildTaskChatMessages, stabilizeThreadMessages, type TaskChatComment } from "./task-chat-messages";

function comment(overrides: Partial<TaskChatComment> = {}): TaskChatComment {
  return {
    id: "comment-1",
    authorType: "user",
    authorAgentId: null,
    authorUserId: "user-1",
    body: "Comment",
    presentation: null,
    metadata: null,
    createdAt: "2026-07-31T12:00:00.000Z",
    ...overrides,
  };
}

function textOf(message: TaskChatMessage) {
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

describe("buildTaskChatMessages", () => {
  it("keeps the board-projected plugin label and renders the plugin as an incoming sender", () => {
    const pages = [
      {
        groups: [
          {
            root: {
              id: "plugin-comment",
              author: {
                type: "plugin",
                label: "Deployment automation",
                agentId: null,
                userId: null,
                pluginKey: "deployments",
              },
              body: "Deployment preview is ready.",
              presentation: null,
              metadata: null,
              sourceTrust: null,
              runState: null,
              canonicalSequence: 1,
              immediateParentDisplayReference: null,
              createdAt: new Date("2026-07-31T12:00:00.000Z"),
              updatedAt: new Date("2026-07-31T12:00:00.000Z"),
            },
            replyCount: 0,
            runSegmentCount: 0,
            entries: [],
            entriesNextCursor: null,
          },
        ],
        nextCursor: null,
      },
    ] satisfies BoardTaskCommentGroupPage[];

    const comments = flattenBoardTaskCommentGroupPages(pages);
    const messages = buildTaskChatMessages({ comments });

    expect(comments[0]).toMatchObject({ authorLabel: "Deployment automation" });
    expect(messages[0]).toMatchObject({
      role: "assistant",
      metadata: { custom: { authorName: "Deployment automation" } },
    });
  });

  it("renders ordered work and the final response as one run message", () => {
    const parts = [
      { type: "text", text: "Starting the investigation." },
      { type: "reasoning", text: "I should inspect the failing check first." },
      { type: "tool", name: "read_logs", status: "completed" },
      { type: "text", text: "The failure is isolated." },
      { type: "tool", name: "run_tests", status: "error" },
    ] satisfies BoardTaskRunSegmentPart[];
    const pages = [
      {
        groups: [
          {
            root: {
              id: "root",
              author: {
                type: "agent",
                label: "Agent",
                agentId: "agent-1",
                userId: null,
                pluginKey: null,
              },
              body: "Investigation complete.",
              presentation: { kind: "message", tone: "neutral", detailsDefaultOpen: false },
              metadata: null,
              sourceTrust: null,
              runState: "terminal",
              canonicalSequence: 1,
              immediateParentDisplayReference: null,
              createdAt: new Date("2026-07-31T12:00:00.000Z"),
              updatedAt: new Date("2026-07-31T12:00:00.000Z"),
            },
            replyCount: 0,
            runSegmentCount: 1,
            entries: [
              {
                kind: "run_segment",
                id: "segment-1",
                author: {
                  type: "agent",
                  label: "Agent",
                  agentId: "agent-1",
                  userId: null,
                  pluginKey: null,
                },
                parts,
                status: "error",
                canonicalSequence: 2,
                createdAt: new Date("2026-07-31T12:01:00.000Z"),
                updatedAt: new Date("2026-07-31T12:01:00.000Z"),
              },
            ],
            entriesNextCursor: null,
          },
        ],
        nextCursor: null,
      },
    ] satisfies BoardTaskCommentGroupPage[];
    const comments = flattenBoardTaskCommentGroupPages(pages);

    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({
      boardRunSegmentParts: parts,
    });

    const messages = buildTaskChatMessages({ comments });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: "root",
      metadata: { custom: { kind: "run", runSegmentPartCount: 5 } },
    });
    expect(messages[0]?.content).toEqual([
      { type: "text", text: "Starting the investigation." },
      { type: "reasoning", text: "I should inspect the failing check first." },
      {
        type: "tool-call",
        toolName: "read_logs",
        status: "completed",
      },
      { type: "text", text: "The failure is isolated." },
      {
        type: "tool-call",
        toolName: "run_tests",
        status: "error",
      },
      { type: "text", text: "Investigation complete." },
    ]);
  });

  it("keeps canonical board order without inventing progress copy", () => {
    const messages = buildTaskChatMessages({
      comments: [
        comment({
          id: "reply-2",
          body: "Second steering reply",
          boardEntryKind: "comment",
          boardGroupRootId: "root",
          boardOrder: 4,
        }),
        comment({
          id: "progress",
          body: "",
          authorType: "agent",
          authorAgentId: "agent-1",
          authorUserId: null,
          presentation: {
            kind: "run_progress",
            tone: "neutral",
            detailsDefaultOpen: false,
          },
          runState: "working",
          boardEntryKind: "comment",
          boardGroupRootId: "root",
          boardOrder: 2,
        }),
        comment({
          id: "root",
          body: "Original comment",
          boardEntryKind: "comment",
          boardGroupRootId: "root",
          boardOrder: 1,
        }),
        comment({
          id: "reply-1",
          body: "First steering reply",
          boardEntryKind: "comment",
          boardGroupRootId: "root",
          boardOrder: 3,
        }),
      ],
    });

    expect(messages.map((message) => message.id)).toEqual(["root", "progress", "reply-1", "reply-2"]);
    expect(textOf(messages[1]!)).toBe("");
    expect(messages[1]?.status).toEqual({ type: "running" });
    expect(messages[1]).toMatchObject({
      role: "assistant",
      metadata: {
        custom: {
          kind: "run",
          boardGroupRootId: "root",
        },
      },
    });
  });

  it("does not derive queued or working placeholder labels", () => {
    const messages = buildTaskChatMessages({
      comments: [
        comment({
          id: "queued-progress",
          authorType: "agent",
          authorAgentId: "agent-1",
          authorUserId: null,
          body: "",
          presentation: {
            kind: "run_progress",
            tone: "neutral",
            detailsDefaultOpen: false,
          },
          runState: "queued",
        }),
        comment({
          id: "working-progress",
          authorType: "agent",
          authorAgentId: "agent-1",
          authorUserId: null,
          body: "",
          presentation: {
            kind: "run_progress",
            tone: "neutral",
            detailsDefaultOpen: false,
          },
          runState: "working",
        }),
      ],
    });

    expect(messages.map(textOf)).toEqual(["", ""]);
    expect(messages.map((message) => message.status)).toEqual([
      { type: "running" },
      { type: "running" },
    ]);
    expect(messages.map((message) => message.metadata.custom.kind)).toEqual(["run", "run"]);
  });

  it("drops duplicate message ids so the runtime never sees the same id twice", () => {
    const messages = buildTaskChatMessages({
      comments: [
        comment({ id: "segment-dup", body: "Run segment", boardEntryKind: "run_segment", boardOrder: 2 }),
        comment({ id: "root-1", body: "First", boardEntryKind: "comment", boardOrder: 1 }),
        comment({ id: "segment-dup", body: "Run segment", boardEntryKind: "run_segment", boardOrder: 3 }),
      ],
    });

    expect(messages.map((message) => message.id)).toEqual(["root-1", "segment-dup"]);
  });
});

describe("thread message stability", () => {
  it("reuses unchanged canonical projections by identity", () => {
    const built = buildTaskChatMessages({ comments: [comment()] });
    const first = stabilizeThreadMessages(built, [], new Map());
    const second = stabilizeThreadMessages(built, first.messages, first.cache);

    expect(second.messages).toBe(first.messages);
    expect(second.messages[0]).toBe(first.messages[0]);
  });
});
