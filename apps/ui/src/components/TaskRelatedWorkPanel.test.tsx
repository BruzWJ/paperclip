import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TaskRelatedWorkPanel } from "./TaskRelatedWorkPanel";

vi.mock("./TaskLinkQuicklook", () => ({
  TaskLinkQuicklook: ({ children, taskId: _taskId, taskNumber, ...props }: ComponentProps<"a"> & {
    taskId: string;
    taskNumber: number | null;
  }) => <a href={`/11111111-1111-4111-8111-111111111111/tasks/${taskNumber}`} {...props}>{children}</a>,
}));

describe("TaskRelatedWorkPanel", () => {
  it("renders outbound and inbound related work with source labels", () => {
    const html = renderToStaticMarkup(
      <TaskRelatedWorkPanel
        relatedWork={{
          outbound: [
            {
              task: {
                id: "task-2",
                taskNumber: 22,
                identifier: "PAP-22",
                title: "Downstream task",
                boardPresentationStatus: "todo",
                priority: "medium",
                ownerAgentId: null,
                ownerUserId: null,
              },
              mentionCount: 2,
              sources: [
                { kind: "title", sourceRecordId: null, label: "title", matchedText: "PAP-22" },
                { kind: "document", sourceRecordId: "doc-1", label: "plan", matchedText: "/tasks/PAP-22" },
              ],
            },
          ],
          inbound: [
            {
              task: {
                id: "task-3",
                taskNumber: 33,
                identifier: "PAP-33",
                title: "Upstream task",
                boardPresentationStatus: "in_progress",
                priority: "high",
                ownerAgentId: null,
                ownerUserId: null,
              },
              mentionCount: 1,
              sources: [
                { kind: "comment", sourceRecordId: "comment-1", label: "comment", matchedText: "PAP-1" },
              ],
            },
          ],
        }}
      />,
    );

    expect(html).toContain("References");
    expect(html).toContain("Referenced by");
    expect(html).toContain("PAP-22");
    expect(html).toContain("PAP-33");
    expect(html).toContain('aria-label="Task PAP-22: Downstream task"');
    expect(html).toContain('aria-label="Task PAP-33: Upstream task"');
    expect(html).toContain("plan");
    expect(html).toContain("comment");
  });

  it("collapses duplicate source labels into a single chip with a count", () => {
    const html = renderToStaticMarkup(
      <TaskRelatedWorkPanel
        relatedWork={{
          outbound: [],
          inbound: [
            {
              task: {
                id: "task-4",
                taskNumber: 44,
                identifier: "PAP-44",
                title: "Chatty inbound",
                boardPresentationStatus: "in_progress",
                priority: "medium",
                ownerAgentId: null,
                ownerUserId: null,
              },
              mentionCount: 3,
              sources: [
                { kind: "comment", sourceRecordId: "c1", label: "comment", matchedText: "PAP-44 first" },
                { kind: "comment", sourceRecordId: "c2", label: "comment", matchedText: "PAP-44 second" },
                { kind: "comment", sourceRecordId: "c3", label: "comment", matchedText: "PAP-44 third" },
              ],
            },
          ],
        }}
      />,
    );

    const commentMatches = html.match(/>comment</g) ?? [];
    expect(commentMatches).toHaveLength(1);
    expect(html).toContain("×3");
  });
});
