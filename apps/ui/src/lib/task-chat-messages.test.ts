import type { TaskChatMessage } from "./task-chat-messages";
import type { BoardTaskCommentGroupPage, BoardTaskRunSegmentPart } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import { flattenBoardTaskCommentGroupPages } from "./optimistic-task-comments";
import {
  buildTaskChatMessages,
  formatDurationWords,
  isCoTSegmentActive,
  stabilizeThreadMessages,
  type TaskChatComment,
} from "./task-chat-messages";

function comment(overrides: Partial<TaskChatComment> = {}): TaskChatComment {
  return {
    id: "comment-1",
    companyId: "company-1",
    taskId: "task-1",
    authorType: "user",
    authorAgentId: null,
    authorUserId: "user-1",
    body: "Comment",
    presentation: null,
    metadata: null,
    createdAt: "2026-07-31T12:00:00.000Z",
    updatedAt: "2026-07-31T12:00:00.000Z",
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
  it("preserves ordered board run-segment text, reasoning, and tool parts", () => {
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
                type: "user",
                label: "Board user",
                agentId: null,
                userId: "user-1",
                pluginKey: null,
              },
              body: "Please investigate",
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
                immediateParentDisplayReference: null,
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
    const comments = flattenBoardTaskCommentGroupPages(pages, {
      companyId: "company-1",
      taskId: "task-1",
    });

    expect(comments[1]).toMatchObject({
      boardEntryKind: "run_segment",
      boardRunSegmentParts: parts,
      boardRunSegmentStatus: "error",
    });

    const messages = buildTaskChatMessages({ comments });
    expect(messages[1]?.content).toEqual([
      { type: "text", text: "Starting the investigation." },
      { type: "reasoning", text: "I should inspect the failing check first." },
      {
        type: "tool-call",
        toolCallId: "segment-1:tool:2",
        toolName: "read_logs",
        args: {},
        argsText: "",
      },
      { type: "text", text: "The failure is isolated." },
      {
        type: "tool-call",
        toolCallId: "segment-1:tool:4",
        toolName: "run_tests",
        args: {},
        argsText: "",
      },
    ]);
    expect(messages[1]?.metadata.custom).toMatchObject({
      boardRunSegmentParts: parts,
      boardRunSegmentStatus: "error",
    });
  });

  it("uses the canonical board projection order for grouped reply and run-progress rows", () => {
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
          runId: "run-1",
          runState: "working",
          boardEntryKind: "run_segment",
          boardGroupRootId: "root",
          boardOrder: 2,
        }),
        comment({
          id: "root",
          body: "Original comment",
          boardEntryKind: "comment",
          boardGroupRootId: "root",
          boardIsRoot: true,
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
    expect(textOf(messages[1]!)).toBe("Working…");
    expect(messages[1]).toMatchObject({
      role: "assistant",
      status: { type: "running" },
      metadata: {
        custom: {
          kind: "run-progress",
          runId: "run-1",
          boardGroupRootId: "root",
        },
      },
    });
  });

  it("derives the queued and terminal labels from persisted run progress", () => {
    const queued = buildTaskChatMessages({
      comments: [
        comment({
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
      ],
    });
    const terminal = buildTaskChatMessages({
      comments: [
        comment({
          authorType: "agent",
          authorAgentId: "agent-1",
          authorUserId: null,
          body: "",
          presentation: {
            kind: "run_progress",
            tone: "neutral",
            detailsDefaultOpen: false,
          },
          runState: "terminal",
        }),
      ],
    });

    expect(textOf(queued[0]!)).toBe("Queued…");
    expect(textOf(terminal[0]!)).toBe("Run finished");
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

describe("display helpers", () => {
  it("marks only the last reasoning segment active", () => {
    expect(
      isCoTSegmentActive({
        isMessageRunning: true,
        segmentIndex: 1,
        segmentCount: 2,
      }),
    ).toBe(true);
    expect(
      isCoTSegmentActive({
        isMessageRunning: true,
        segmentIndex: 0,
        segmentCount: 2,
      }),
    ).toBe(false);
  });

  it("formats elapsed durations", () => {
    expect(formatDurationWords(59_000)).toBe("59 seconds");
    expect(formatDurationWords(60_000)).toBe("1 minute");
  });
});
