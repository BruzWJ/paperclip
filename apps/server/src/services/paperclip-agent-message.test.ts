import { describe, expect, it } from "vitest";
import {
  paperclipEnvelopeHasBody,
  renderPaperclipManagedToolPrompt,
} from "./paperclip-agent-message.js";

const task = {
  id: "11111111-1111-4111-8111-111111111111",
  identifier: "PAP-123",
  title: "  Fix\ncanonical messaging  ",
};
const creator = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "Creator Agent",
};
const owner = {
  id: "33333333-3333-4333-8333-333333333333",
  name: "Owner Agent",
};

describe("Paperclip canonical agent messages", () => {
  it("wraps a same-task agent mention with task and sender identity", () => {
    const message = "Check this exact context.\nKeep the second line.";
    const rendered = renderPaperclipManagedToolPrompt({
      toolName: "mention_agent",
      arguments: {
        agentId: owner.id,
        message,
      },
      context: {
        task,
        from: creator,
        to: owner,
      },
    });

    expect(rendered).toBe([
      "[Paperclip agent message]",
      `To: Owner Agent (${owner.id})`,
      `Task: PAP-123 (${task.id})`,
      `From: Creator Agent (${creator.id})`,
      "",
      `@Owner Agent ${message}`,
    ].join("\n"));
    expect(paperclipEnvelopeHasBody(
      rendered,
      "[Paperclip agent message]",
      `@Owner Agent ${message}`,
    )).toBe(true);
    expect(paperclipEnvelopeHasBody(
      rendered,
      "[Paperclip task assignment]",
      `@Owner Agent ${message}`,
    )).toBe(false);
    expect(paperclipEnvelopeHasBody(
      rendered,
      "[Paperclip agent message]",
      "different message",
    )).toBe(false);
  });

  it("uses one assignment envelope for create and assign", () => {
    const request = "Implement the child task.";
    expect(renderPaperclipManagedToolPrompt({
      toolName: "task_create",
      arguments: {
        request,
        title: task.title,
        priority: "high",
        owner: { kind: "agent", agentId: owner.id },
      },
      context: {
        task,
        from: creator,
        owner,
        status: "open",
      },
    })).toBe([
      "[Paperclip task assignment]",
      "Action: Created and assigned",
      `Task: PAP-123 (${task.id})`,
      `From: Creator Agent (${creator.id})`,
      `Owner: Owner Agent (${owner.id})`,
      "Status: open",
      "",
      request,
    ].join("\n"));
    expect(renderPaperclipManagedToolPrompt({
      toolName: "task_assign",
      arguments: {
        taskId: task.id,
        owner: { kind: "agent", agentId: owner.id },
      },
      context: {
        task,
        from: creator,
        owner,
        status: "blocked",
        request,
      },
    })).toBe([
      "[Paperclip task assignment]",
      "Action: Reassigned",
      `Task: PAP-123 (${task.id})`,
      `From: Creator Agent (${creator.id})`,
      `Owner: Owner Agent (${owner.id})`,
      "Status: blocked",
      "",
      request,
    ].join("\n"));
  });

  it("identifies the updated task, source role, and effective status", () => {
    expect(renderPaperclipManagedToolPrompt({
      toolName: "task_update",
      arguments: {
        taskId: task.id,
        status: "blocked",
        message: "Waiting for credentials.",
      },
      context: {
        task,
        from: owner,
        sourceRole: "task owner",
        previousStatus: "open",
        effectiveStatus: "blocked",
      },
    })).toBe([
      "[Paperclip task update]",
      `Task: PAP-123 (${task.id})`,
      `From: task owner, Owner Agent (${owner.id})`,
      "Status: open -> blocked",
      "",
      "Waiting for credentials.",
    ].join("\n"));
  });

  it("does not claim a gated completion already changed lifecycle", () => {
    expect(renderPaperclipManagedToolPrompt({
      toolName: "task_update",
      arguments: {
        status: "done",
        message: "Ready for review.",
        structuredResult: { artifact: "report.json" },
      },
      context: {
        task,
        from: owner,
        sourceRole: "task owner",
        previousStatus: "open",
        effectiveStatus: "open",
        pendingReview: true,
      },
    })).toContain(
      "Status: open (done requested; pending execution-policy review)",
    );
  });
});
