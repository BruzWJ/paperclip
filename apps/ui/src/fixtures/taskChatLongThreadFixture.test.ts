import { describe, expect, it } from "vitest";
import {
  taskChatLongThreadAgentMap,
  taskChatLongThreadComments,
  taskChatLongThreadEvents,
  taskChatLongThreadMarkdownCommentIds,
  LONG_THREAD_COMMENT_COUNT,
  LONG_THREAD_MARKDOWN_COMMENT_COUNT,
} from "./taskChatLongThreadFixture";
import { buildTaskChatMessages } from "../lib/task-chat-messages";

describe("taskChatLongThreadFixture", () => {
  it("builds a deterministic long task-thread shape", () => {
    const messages = buildTaskChatMessages({
      comments: taskChatLongThreadComments,
      timelineEvents: taskChatLongThreadEvents,
      agentMap: taskChatLongThreadAgentMap,
      currentUserId: "user-board",
    });

    expect(taskChatLongThreadComments).toHaveLength(LONG_THREAD_COMMENT_COUNT);
    expect(taskChatLongThreadMarkdownCommentIds.size).toBe(LONG_THREAD_MARKDOWN_COMMENT_COUNT);
    expect(messages.length).toBeGreaterThanOrEqual(450);
    expect(messages.filter((message) => message.role === "assistant").length).toBeGreaterThanOrEqual(
      LONG_THREAD_MARKDOWN_COMMENT_COUNT,
    );
  });

  it("keeps markdown rows markdown-heavy enough to exercise MarkdownBody", () => {
    const markdownComments = taskChatLongThreadComments.filter((comment) =>
      taskChatLongThreadMarkdownCommentIds.has(comment.id),
    );

    expect(markdownComments).toHaveLength(LONG_THREAD_MARKDOWN_COMMENT_COUNT);
    for (const comment of markdownComments.slice(0, 5)) {
      expect(comment.body).toContain("## Baseline note");
      expect(comment.body).toContain("```ts");
      expect(comment.body).toContain("| Metric | Value |");
    }
  });
});
