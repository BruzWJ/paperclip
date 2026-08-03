import type { ThreadMessage } from "@assistant-ui/react";
import { describe, expect, it } from "vitest";
import {
  buildIssueChatMessages,
  formatDurationWords,
  isCoTSegmentActive,
  stabilizeThreadMessages,
  type IssueChatComment,
} from "./issue-chat-messages";

function comment(
  overrides: Partial<IssueChatComment> = {},
): IssueChatComment {
  return {
    id: "comment-1",
    companyId: "company-1",
    issueId: "issue-1",
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

function textOf(message: ThreadMessage) {
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

describe("buildIssueChatMessages", () => {
  it("uses the canonical board projection order for grouped reply and run-progress rows", () => {
    const messages = buildIssueChatMessages({
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
      timelineEvents: [],
    });

    expect(messages.map((message) => message.id)).toEqual([
      "root",
      "progress",
      "reply-1",
      "reply-2",
    ]);
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
    const queued = buildIssueChatMessages({
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
      timelineEvents: [],
    });
    const terminal = buildIssueChatMessages({
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
      timelineEvents: [],
    });

    expect(textOf(queued[0]!)).toBe("Queued…");
    expect(textOf(terminal[0]!)).toBe("Run finished");
  });
});

describe("thread message stability", () => {
  it("reuses unchanged canonical projections by identity", () => {
    const built = buildIssueChatMessages({
      comments: [comment()],
      timelineEvents: [],
    });
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
