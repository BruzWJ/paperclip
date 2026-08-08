import { describe, expect, it } from "vitest";
import {
  paperclipEnvelopeHasBody,
  renderPaperclipManagedToolPrompt,
} from "./paperclip-agent-message.js";

const issue = {
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
  it("wraps a same-issue agent mention with issue and sender identity", () => {
    const message = "Check this exact context.\nKeep the second line.";
    const rendered = renderPaperclipManagedToolPrompt({
      toolName: "mention_agent",
      arguments: {
        agentId: owner.id,
        message,
      },
      context: {
        issue,
        from: creator,
        to: owner,
      },
    });

    expect(rendered).toBe([
      "[Paperclip agent message]",
      `To: Owner Agent (${owner.id})`,
      `Issue: PAP-123 (${issue.id})`,
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
      "[Paperclip issue assignment]",
      `@Owner Agent ${message}`,
    )).toBe(false);
    expect(paperclipEnvelopeHasBody(
      rendered,
      "[Paperclip agent message]",
      "different message",
    )).toBe(false);
  });

  it("uses one assignment envelope for create and assign", () => {
    const request = "Implement the child issue.";
    expect(renderPaperclipManagedToolPrompt({
      toolName: "issue_create",
      arguments: {
        request,
        title: issue.title,
        priority: "high",
        owner: { kind: "agent", agentId: owner.id },
      },
      context: {
        issue,
        from: creator,
        owner,
        status: "open",
      },
    })).toBe([
      "[Paperclip issue assignment]",
      "Action: Created and assigned",
      `Issue: PAP-123 (${issue.id})`,
      `From: Creator Agent (${creator.id})`,
      `Owner: Owner Agent (${owner.id})`,
      "Status: open",
      "",
      request,
    ].join("\n"));
    expect(renderPaperclipManagedToolPrompt({
      toolName: "issue_assign",
      arguments: {
        issueId: issue.id,
        owner: { kind: "agent", agentId: owner.id },
      },
      context: {
        issue,
        from: creator,
        owner,
        status: "blocked",
        request,
      },
    })).toBe([
      "[Paperclip issue assignment]",
      "Action: Reassigned",
      `Issue: PAP-123 (${issue.id})`,
      `From: Creator Agent (${creator.id})`,
      `Owner: Owner Agent (${owner.id})`,
      "Status: blocked",
      "",
      request,
    ].join("\n"));
  });

  it("identifies the updated issue, source role, and effective status", () => {
    expect(renderPaperclipManagedToolPrompt({
      toolName: "issue_update",
      arguments: {
        issueId: issue.id,
        status: "blocked",
        message: "Waiting for credentials.",
      },
      context: {
        issue,
        from: owner,
        sourceRole: "issue owner",
        previousStatus: "open",
        effectiveStatus: "blocked",
      },
    })).toBe([
      "[Paperclip issue update]",
      `Issue: PAP-123 (${issue.id})`,
      `From: issue owner, Owner Agent (${owner.id})`,
      "Status: open -> blocked",
      "",
      "Waiting for credentials.",
    ].join("\n"));
  });

  it("does not claim a gated completion already changed lifecycle", () => {
    expect(renderPaperclipManagedToolPrompt({
      toolName: "issue_update",
      arguments: {
        status: "done",
        message: "Ready for review.",
        structuredResult: { artifact: "report.json" },
      },
      context: {
        issue,
        from: owner,
        sourceRole: "issue owner",
        previousStatus: "open",
        effectiveStatus: "open",
        pendingReview: true,
      },
    })).toContain(
      "Status: open (done requested; pending execution-policy review)",
    );
  });
});
