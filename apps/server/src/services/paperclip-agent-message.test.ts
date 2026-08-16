import { describe, expect, it } from "vitest";
import {
  paperclipEnvelopeHasBody,
  renderPaperclipCommentMention,
  renderPaperclipManagedAgentMessage,
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
    const delivery = {
      toolName: "mention_agent",
      body: message,
      context: {
        task,
        from: creator,
      },
    } as const;
    const rendered = renderPaperclipManagedAgentMessage(delivery, owner);

    expect(rendered.agentText).toBe([
      "[Paperclip agent message]",
      `To: Owner Agent (${owner.id})`,
      `Task: PAP-123 (${task.id})`,
      `From: Creator Agent (${creator.id})`,
      "",
      message,
    ].join("\n"));
    expect(paperclipEnvelopeHasBody(rendered.agentText, "[Paperclip agent message]", message)).toBe(true);
    expect(paperclipEnvelopeHasBody(rendered.agentText, "[Paperclip task assignment]", message)).toBe(
      false,
    );
    expect(
      paperclipEnvelopeHasBody(rendered.agentText, "[Paperclip agent message]", "different message"),
    ).toBe(false);
    expect(rendered.commentBody).toBe(`@Owner Agent ${message}`);
    expect(renderPaperclipCommentMention({ kind: "board" }, message)).toBe(`@board ${message}`);
  });

  it("uses one assignment envelope for create and assign", () => {
    const request = "Implement the child task.";
    expect(renderPaperclipManagedAgentMessage({
      toolName: "task_create",
      body: request,
      context: {
        task,
        from: creator,
        status: "open",
      },
    }, owner).agentText).toBe([
      "[Paperclip task assignment]",
      "Action: Created and assigned",
      `Task: PAP-123 (${task.id})`,
      `From: Creator Agent (${creator.id})`,
      `Owner: Owner Agent (${owner.id})`,
      "Status: open",
      "",
      request,
    ].join("\n"));
    expect(renderPaperclipManagedAgentMessage({
      toolName: "task_assign",
      body: request,
      context: {
        task,
        from: creator,
        status: "blocked",
      },
    }, owner).agentText).toBe([
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
    const delivery = {
      toolName: "task_update",
      body: "Waiting for credentials.",
      requestedStatus: "blocked",
      context: {
        task,
        from: owner,
        sourceRole: "task owner",
        previousStatus: "open",
        effectiveStatus: "blocked",
      },
    } as const;
    const rendered = renderPaperclipManagedAgentMessage(delivery, owner);

    expect(rendered.agentText).toBe([
      "[Paperclip task update]",
      `Task: PAP-123 (${task.id})`,
      `From: task owner, Owner Agent (${owner.id})`,
      "Status: open -> blocked",
      "",
      "Waiting for credentials.",
    ].join("\n"));
    expect(rendered.agentText).not.toContain("@Owner Agent");
    expect(rendered.commentBody).toBe("@Owner Agent Waiting for credentials.");
  });

  it("does not claim a gated completion already changed lifecycle", () => {
    expect(renderPaperclipManagedAgentMessage({
      toolName: "task_update",
      body: "Ready for review.",
      requestedStatus: "done",
      context: {
        task,
        from: owner,
        sourceRole: "task owner",
        previousStatus: "open",
        effectiveStatus: "open",
        pendingReview: true,
      },
    }, owner).agentText).toContain(
      "Status: open (done requested; pending execution-policy review)",
    );
  });
});
